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
const fsNode = require('fs');
const nodePath = require('path');
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

// A hostname is not an identity. Two Windows machines deployed from the same
// image are both "WIN-DIT01\admin"; so are two Macs left on their factory
// name. That was enough for one to read the other's live lock, find no such
// process id locally, call it dead and take the folder — two machines writing
// the same files at the same time.
//
// This id is generated once per installation and kept next to the preferences.
// If it cannot be stored, a per-process id is used instead: the fast path for
// our own stale locks is lost, but the slow path — watch for 12 s of silence —
// is always correct, which is the direction to fail in.
let INSTALL_ID = null;
function installId() {
  if (INSTALL_ID) return INSTALL_ID;
  try {
    const dir = nodePath.join(os.homedir(), '.syncto');
    const file = nodePath.join(dir, 'install-id');
    try {
      const v = fsNode.readFileSync(file, 'utf8').trim();
      if (/^[0-9a-f]{32}$/.test(v)) return (INSTALL_ID = v);
    } catch (_) { /* not created yet */ }
    fsNode.mkdirSync(dir, { recursive: true });
    const v = guid();
    fsNode.writeFileSync(file, v + '\n', { mode: 0o600 });
    return (INSTALL_ID = v);
  } catch (_) {
    return (INSTALL_ID = guid());
  }
}

function localLockInfo() {
  return {
    format : FORMAT,
    version: VERSION,
    lockId : guid(),
    installId: installId(),
    computerName: os.hostname(),
    userId : (() => { try { return os.userInfo().username; } catch (_) { return 'unknown'; } })(),
    sessionId: process.ppid || 0,
    processId: process.pid,
    since  : Date.now(),
  };
}

// 'running' | 'notRunning' | 'itsUs' | 'unknown'
function processStatus(info, local) {
  // No install id (a lock written by 0.2.4 or earlier) means we cannot prove
  // the lock is ours, so we must not shortcut: 'unknown' waits for silence.
  if (!info.installId || !local.installId || info.installId !== local.installId) return 'unknown';
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
//
// The heartbeat is not just a keep-alive, it is a re-check. If the share goes
// away for longer than the abandonment window, another machine legitimately
// takes the folder — and the old owner has to find out. It used to swallow
// every append failure and keep going: the ousted owner carried on writing
// (its blind `appendByte` in "a" mode even fed the NEW owner's lock file), and
// its release() then deleted a lock it no longer held, freeing the folder for
// a third machine while the second was still running.
class DirLock {
  // onLost(reason) fires when this lock is no longer ours. The run must stop.
  constructor(fsx, lockPath, info, onLost) {
    this.fs = fsx;
    this.path = lockPath;
    this.info = info;
    this.onLost = onLost || null;
    this.timer = null;
    this.released = false;
    this.lost = null;
    this._misses = 0;
  }

  _fail(reason) {
    if (this.lost || this.released) return;
    this.lost = reason;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.onLost) { try { this.onLost(reason); } catch (_) {} }
  }

  _startHeartbeat() {
    const beat = () => {
      if (this.released || this.lost || this._beating) return;
      this._beating = (async () => {
        // Still ours? A stat is not enough — the file may have been taken over
        // and recreated by someone else, at a similar size.
        const cur = await readLockInfo(this.fs, this.path);
        if (!cur || cur.lockId !== this.info.lockId) {
          throw new Error(cur
            ? `the folder was taken over by ${describe(cur)}`
            : 'the lock file disappeared');
        }
        // A single space. Growing the file IS the life sign — nothing else
        // needs to be readable or parsed by the other side.
        await this.fs.appendByte(this.path, ' ');
        this._misses = 0;
      })()
        .catch(err => {
          // A hiccup is normal; silence for longer than the abandonment window
          // is not, because by then another machine is entitled to the folder.
          if (/taken over|disappeared/.test(err.message || '')) return this._fail(err.message);
          this._misses++;
          if (this._misses * EMIT_LIFE_SIGN_MS >= DETECT_ABANDONED_MS) {
            this._fail(`the lock file could not be refreshed for ${
              Math.round(this._misses * EMIT_LIFE_SIGN_MS / 1000)} s (${err.message})`);
          }
        })
        .finally(() => { this._beating = null; });
    };
    this.timer = setInterval(beat, EMIT_LIFE_SIGN_MS);
    if (this.timer.unref) this.timer.unref();
  }

  async release() {
    if (this.released) return;
    this.released = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    // The in-flight append has to finish first: one landing AFTER the unlink
    // would recreate the file and block other machines for 12 seconds.
    if (this._beating) { try { await this._beating; } catch (_) {} }
    if (this.lost) return;              // not ours any more — deleting it would evict its owner
    try {
      const cur = await readLockInfo(this.fs, this.path);
      if (cur && cur.lockId !== this.info.lockId) return;
      await this.fs.unlink(this.path);
    } catch (_) {}
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
  const { onStatus, token, onLost } = opts || {};
  const lockPath = fsx.join(folderPath, LOCK_NAME);
  const local = localLockInfo();
  const payload = Buffer.from(JSON.stringify(local) + '\n', 'utf8');
  let ghostTries = 0;   // create fails "exists" but no lock file is there
  let takeoverTries = 0;

  for (;;) {
    if (token && token.cancelled) throw new Error('Cancelled');

    // Fast path: create it exclusively. Whoever wins this call owns the folder.
    let createErr;
    try {
      await fsx.writeExclusive(lockPath, payload);
      const lock = new DirLock(fsx, lockPath, local, onLost);
      lock._startHeartbeat();
      return lock;
    } catch (err) {
      if (!/exist/i.test(err.code || err.message || '')) throw err;
      createErr = err;
    }

    // Someone holds it. Find out who, and whether they are still breathing.
    const info = await readLockInfo(fsx, lockPath);

    // SFTPv3 has no specific "already exists" status: an exclusive create that
    // clashes AND a genuine failure both come back as "Failure". If the file
    // is not actually there, this was a real error, not a taken lock — retry a
    // few times with a pause (never a hot loop), then give up honestly.
    if (!info) {
      let st = null;
      try { st = await fsx.stat(lockPath); } catch (_) {}
      if (!st) {
        if (++ghostTries >= 5) throw createErr;
        await sleep(POLL_LIFE_SIGN_MS);
        continue;
      }
    }
    ghostTries = 0;
    const status = info ? processStatus(info, local) : 'unknown';

    if (status === 'notRunning' || status === 'itsUs') {
      await takeOver(fsx, lockPath, onStatus, info, ++takeoverTries);
      continue;                                   // and try to create it again
    }

    // Unknown owner (another machine): watch the file for life signs.
    const alive = await watchLifeSigns(fsx, lockPath, info, onStatus, token);
    if (alive) { takeoverTries = 0; continue; }
    await takeOver(fsx, lockPath, onStatus, info, ++takeoverTries);
    // Loop back and attempt the exclusive create.
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
async function takeOver(fsx, lockPath, onStatus, info, attempt) {
  const dir  = fsx.dirname(lockPath);
  const name = fsx.basename(lockPath);

  if (onStatus) onStatus({ waiting: true, holder: describe(info), takingOver: true });

  // The old code always renamed to "Delete.0.<name>" and deleted it on a
  // best-effort basis. A crash between the two left that file behind — and
  // SFTPv3's rename refuses an existing target, so every later takeover failed
  // for ever, silently, and the window sat on "Waiting for…" until someone
  // deleted the file by hand on the server. Try several slots, and clear a
  // stale corpse before reusing its name.
  let lastErr = null;
  for (let level = 0; level < ABANDONED_LEVEL_MAX; level++) {
    const doomed = fsx.join(dir, `Delete.${level}.${name}`);
    try {
      // renameStrict: no delete-and-retry fallback. Renaming is the whole point —
      // of two machines waiting on the same abandoned lock, exactly one may win.
      await (fsx.renameStrict ? fsx.renameStrict(lockPath, doomed) : fsx.rename(lockPath, doomed));
      try { await fsx.unlink(doomed); } catch (_) {}
      return;
    } catch (err) {
      lastErr = err;
      // Is the lock still there at all? If not, another waiter won the rename
      // or the owner released it — nothing to do but retry the create.
      let st = null;
      try { st = await fsx.stat(lockPath); } catch (_) { return; }
      if (!st) return;
      // The target is occupied by a corpse from an interrupted takeover.
      try { await fsx.unlink(doomed); } catch (_) { continue; }
    }
  }

  // Never loop for ever in silence: after enough rounds, say what is wrong and
  // where, so the user can act instead of watching a spinner.
  if (attempt >= 3) {
    throw new Error(`The lock file at ${lockPath} is abandoned but cannot be cleared` +
      (lastErr ? ` (${lastErr.message})` : '') +
      '. Delete it manually, then run the comparison again.');
  }
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
      // stat() returns null for "absent" and throws for everything else. The
      // old catch-all treated a permission error or a network hiccup as
      // "absent" and ran the whole synchronization on that folder WITHOUT a
      // lock, silently. Let the real error through.
      const st = await e.fs.stat(e.path);
      if (!st) {
        // Genuinely not there yet. Create it now rather than skipping the lock:
        // two machines starting their first backup into the same new NAS folder
        // both used to proceed unprotected, and only the second run was safe.
        try { await e.fs.mkdir(e.path); }
        catch (err) {
          throw new Error(`Cannot create ${e.path} to lock it: ${err.message}`);
        }
      }
      const lock = await acquireOne(e.fs, e.path, opts);
      held.push(lock);
    }
  } catch (err) {
    for (const l of held) { try { await l.release(); } catch (_) {} }
    throw err;
  }
  return {
    count: held.length,
    // Non-null as soon as ANY of the folders stopped being ours mid-run.
    lost() {
      const l = held.find(x => x.lost);
      return l ? `${l.path}: ${l.lost}` : null;
    },
    async release() { for (const l of held) { try { await l.release(); } catch (_) {} } },
  };
}

module.exports = {
  acquireOne, acquireAll, abandonedLockName, processStatus, localLockInfo, readLockInfo,
  EMIT_LIFE_SIGN_MS, POLL_LIFE_SIGN_MS, DETECT_ABANDONED_MS, LOCK_NAME,
};
