/*
 * syncto — Folder comparison and synchronization
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

// Directory locking — one machine at a time per synchronized folder.
//
// Ported from FreeFileSync's dir_lock, whose design has one great virtue: it
// needs no operating-system locking primitive. It works over SMB, AFP, NFS and
// SFTP alike, because it relies on only two things every filesystem provides —
// appending a byte, and renaming atomically.
//
//   1. A lock file (.syncto.lock) is created at the root of each synchronized
//      folder, holding who owns it: machine, user, process id, session id.
//
//   2. While the run lasts, a heartbeat appends ONE space byte to that file
//      every 5 seconds. The file grows; any other machine can see that through
//      a plain stat, over any network mount.
//
//   3. A machine that finds a lock polls it every 2 seconds. If the file has
//      not grown for 12 seconds (5 + 7 of margin) the owner is presumed dead
//      and the lock is abandoned.
//
//   4. Taking over an abandoned lock is NOT a delete — two waiting machines
//      would both delete it and both proceed. The lock is RENAMED to
//      "Delete.0.<name>" first: renaming is atomic, so exactly one machine
//      wins, and that machine is the one allowed to continue.
//
// Shortcut: when the lock belongs to this very machine and user, there is no
// need to wait 12 seconds — we can ask the operating system directly whether
// that process is still alive.

const os = require('os');
const { LOCK_NAME } = require('./compare');

const EMIT_LIFE_SIGN_MS   = 5000;                        // heartbeat period
const POLL_LIFE_SIGN_MS   = 2000;                        // how often a waiter looks
const DETECT_ABANDONED_MS = EMIT_LIFE_SIGN_MS + 7000;    // 12 s of silence = abandoned
const ABANDONED_LEVEL_MAX = 10;                          // guard against pathological recursion
const FORMAT  = 'syncto-lock';
const VERSION = 1;

function guid() {
  return require('crypto').randomBytes(16).toString('hex');
}

// "sync.lock" -> "Delete.0.sync.lock" -> "Delete.1.sync.lock" -> …
// Recursive abandoned locks are (almost) impossible, but filesystem bugs have
// produced them in the wild, hence the level counter and its ceiling.
function abandonedLockName(name) {
  let base = name, level = 0;
  const m = /^Delete\.(\d+)\.(.+)$/.exec(name);
  if (m) {
    level = parseInt(m[1], 10) + 1;
    base  = m[2];
    if (level >= ABANDONED_LEVEL_MAX) throw new Error('Endless recursion on the lock file.');
  }
  return `Delete.${level}.${base}`;
}

function localLockInfo() {
  return {
    format : FORMAT,
    version: VERSION,
    lockId : guid(),
    computerName: os.hostname(),
    userId : (() => { try { return os.userInfo().username; } catch (_) { return 'unknown'; } })(),
    sessionId: process.ppid || 0,
    processId: process.pid,
    since  : Date.now(),
  };
}

// 'running' | 'notRunning' | 'itsUs' | 'unknown'
function processStatus(info, local) {
  if (info.computerName !== local.computerName || info.userId !== local.userId) {
    return 'unknown';                       // another machine, or another user on this one
  }
  if (info.processId === local.processId && info.sessionId === local.sessionId) {
    return 'itsUs';                         // obscure but possible: a lock we failed to clean up
  }
  try {
    process.kill(info.processId, 0);        // signal 0: existence check only
    return 'running';
  } catch (err) {
    return err.code === 'EPERM' ? 'running' : 'notRunning';
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function readLockInfo(fsx, lockPath) {
  return new Promise(resolve => {
    const chunks = [];
    let rs;
    try { rs = fsx.createReadStream(lockPath); } catch (_) { return resolve(null); }
    rs.on('data', c => chunks.push(c));
    rs.on('error', () => resolve(null));
    rs.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      // The heartbeat appends spaces after the JSON, so parse the first line.
      try {
        const json = JSON.parse(text.split('\n')[0]);
        resolve(json && json.format === FORMAT ? json : null);
      } catch (_) { resolve(null); }
    });
  });
}

// One held lock, with its heartbeat.
class DirLock {
  constructor(fsx, lockPath, info) {
    this.fs = fsx;
    this.path = lockPath;
    this.info = info;
    this.timer = null;
    this.released = false;
  }

  _startHeartbeat() {
    const beat = async () => {
      if (this.released) return;
      // A single space. Growing the file IS the life sign — nothing else needs
      // to be readable or parsed by the other side.
      try { await this.fs.appendByte(this.path, ' '); } catch (_) { /* transient network hiccup */ }
    };
    this.timer = setInterval(beat, EMIT_LIFE_SIGN_MS);
    if (this.timer.unref) this.timer.unref();
  }

  async release() {
    if (this.released) return;
    this.released = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    try { await this.fs.unlink(this.path); } catch (_) {}
  }
}

// Describes who is blocking us, for the interface.
function describe(info) {
  if (!info) return 'another syncto run';
  return `${info.computerName} (${info.userId})`;
}

// Acquires the lock on one base folder, waiting for a live owner to finish.
// onStatus({ waiting, holder, secondsLeft }) drives the UI; token.cancelled aborts.
async function acquireOne(fsx, folderPath, opts) {
  const { onStatus, token } = opts || {};
  const lockPath = fsx.join(folderPath, LOCK_NAME);
  const local = localLockInfo();
  const payload = Buffer.from(JSON.stringify(local) + '\n', 'utf8');

  for (;;) {
    if (token && token.cancelled) throw new Error('Cancelled');

    // Fast path: create it exclusively. Whoever wins this call owns the folder.
    try {
      await fsx.writeExclusive(lockPath, payload);
      const lock = new DirLock(fsx, lockPath, local);
      lock._startHeartbeat();
      return lock;
    } catch (err) {
      if (!/exist/i.test(err.code || err.message || '')) throw err;
    }

    // Someone holds it. Find out who, and whether they are still breathing.
    const info = await readLockInfo(fsx, lockPath);
    const status = info ? processStatus(info, local) : 'unknown';

    if (status === 'notRunning' || status === 'itsUs') {
      await takeOver(fsx, lockPath, onStatus, info);
      continue;                                   // and try to create it again
    }

    // Unknown owner (another machine): watch the file for life signs.
    const alive = await watchLifeSigns(fsx, lockPath, info, onStatus, token);
    if (!alive) await takeOver(fsx, lockPath, onStatus, info);
    // Either way, loop back and attempt the exclusive create.
  }
}

// Polls the lock file. Returns true if it is still being fed, false once it has
// been silent for DETECT_ABANDONED_MS.
async function watchLifeSigns(fsx, lockPath, info, onStatus, token) {
  let last = await fsx.stat(lockPath);
  if (!last) return false;                        // vanished: free to take
  let lastChange = Date.now();
  let lastSize = last.size, lastMtime = last.mtime;

  for (;;) {
    if (token && token.cancelled) throw new Error('Cancelled');

    const silentMs = Date.now() - lastChange;
    if (onStatus) {
      onStatus({
        waiting: true,
        holder : describe(info),
        secondsLeft: Math.max(0, Math.ceil((DETECT_ABANDONED_MS - silentMs) / 1000)),
      });
    }
    if (silentMs >= DETECT_ABANDONED_MS) return false;

    await sleep(POLL_LIFE_SIGN_MS);

    const st = await fsx.stat(lockPath);
    if (!st) return false;                        // owner finished and removed it
    if (st.size !== lastSize || st.mtime !== lastMtime) {
      lastSize = st.size; lastMtime = st.mtime; lastChange = Date.now();
    }
  }
}

// Removes an abandoned lock the safe way: rename first (atomic — only one
// waiting machine can succeed), then delete the renamed file.
async function takeOver(fsx, lockPath, onStatus, info) {
  const dir  = fsx.dirname(lockPath);
  const name = fsx.basename(lockPath);
  const doomed = fsx.join(dir, abandonedLockName(name));

  if (onStatus) onStatus({ waiting: true, holder: describe(info), takingOver: true });

  try {
    await fsx.rename(lockPath, doomed);
  } catch (_) {
    // Another waiter won the rename, or the owner just released it. Either way
    // we simply retry the exclusive create.
    return;
  }
  try { await fsx.unlink(doomed); } catch (_) {}
}

// Acquires every folder of a run. Folders are deduplicated (two pairs sharing a
// source lock it once) and sorted, so two machines requesting the same set can
// never deadlock by taking them in opposite orders.
async function acquireAll(entries, opts) {
  const seen = new Map();
  for (const e of entries) {
    if (!e || !e.fs || !e.path) continue;
    const key = `${e.fs.kind}:${e.fs.deviceKey ? e.fs.deviceKey(e.path) : ''}:${e.path}`;
    if (!seen.has(key)) seen.set(key, e);
  }
  const list = [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(x => x[1]);

  const held = [];
  try {
    for (const e of list) {
      const lock = await acquireOne(e.fs, e.path, opts);
      held.push(lock);
    }
  } catch (err) {
    for (const l of held) { try { await l.release(); } catch (_) {} }
    throw err;
  }
  return {
    count: held.length,
    async release() { for (const l of held) { try { await l.release(); } catch (_) {} } },
  };
}

module.exports = {
  acquireOne, acquireAll, abandonedLockName, processStatus, localLockInfo, readLockInfo,
  EMIT_LIFE_SIGN_MS, POLL_LIFE_SIGN_MS, DETECT_ABANDONED_MS, LOCK_NAME,
};
