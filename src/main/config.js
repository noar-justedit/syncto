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

// Two kinds of persisted state:
//   PREFERENCES  window size, last used settings, recent jobs. Lives in the
//                user data folder, never travels.
//   JOBS         a folder pair plus every setting needed to reproduce a run,
//                saved as "<name>.syncto" wherever the user wants. This is
//                the file you commit next to a project or drop on a colleague.
//                The job has no name of its own: its name IS the file name.

const fs   = require('fs');
const path = require('path');
const secrets = require('./secrets');

const JOB_EXT    = '.syncto';
const JOB_FORMAT = 'syncto-job';

// "MILOUSE" from /backups/MILOUSE.syncto (legacy .syncto.json accepted too).
function jobNameFromPath(p) {
  let base = path.basename(String(p || ''));
  base = base.replace(/\.syncto\.json$/i, '').replace(/\.syncto$/i, '').replace(/\.json$/i, '');
  return base || 'Untitled';
}

function defaultJob() {
  return {
    format : JOB_FORMAT,
    version: 1,
    name   : 'Untitled',
    pairId : null,                      // legacy — pair ids are path-derived now
    // Every pair shares the job's settings, exactly like FreeFileSync.
    pairs  : [{ left: '', right: '' }],
    compare: {
      compareVariant: 'timeSize',       // timeSize | content | size
      timeTolerance : 2,                // seconds
      timeShifts    : [],               // whole-hour shifts, e.g. [60] for DST
      symlinks      : 'exclude',        // exclude | asLink
      detectMoves   : true,             // rename instead of copy+delete (needs 1 prior run)
      includeFilter : '*',
      excludeFilter : '',
      softFilter    : {
        sizeMinUnit: 'none', sizeMin: 0,
        sizeMaxUnit: 'none', sizeMax: 0,
        timeUnit   : 'none', timeValue: 0,
      },
    },
    sync: {
      variant: 'mirror',                // twoWay | mirror | update | custom
      custom : { leftOnly: 'right', rightOnly: 'left', leftNewer: 'right', rightNewer: 'left' },
      customChange: {
        left : { create: 'right', update: 'right', delete: 'right' },
        right: { create: 'left',  update: 'left',  delete: 'left'  },
      },
      copyLevel        : 'verified',    // fast | verified | secure
      writeChecksumList: false,
      deletion         : 'recycler',    // permanent | recycler | versioning
      permanentFallback: false,
      versioning: {
        leftFolder : '', rightFolder: '',
        style      : 'timestampFolder', // replace | timestampFolder | timestampFile
        maxAgeDays : 0, countMin: 0, countMax: 0,
      },
      lockFolders    : true,            // .syncto.lock — one machine at a time
      failSafe       : true,
      preserveTimes  : true,
      copyPermissions: false,
      retryCount     : 2,
      retryDelayMs   : 5000,
      ignoreErrors   : false,
      report: {
        enabled: false, html: true, csv: false, json: false,
        folder : '',                    // empty -> Documents/syncto reports
      },
    },
    autoSync: {
      enabled: false,
      minutes: 30,                      // compare + sync with current settings
    },
  };
}

const PREFS_REVISION = 2;

function defaultPrefs() {
  return {
    revision: PREFS_REVISION,
    window: { width: 1280, height: 820 },
    lastJobPath: '',
    recent: [],
    ui: { showEqual: false },
    job: defaultJob(),
    // Named servers, in the order they appear in the connection window.
    // NOTE the shape: passwordEnc / passphraseEnc, never `password`. Secrets
    // are ciphertext from the OS credential store (see secrets.js) and no
    // readable password is ever written to this file.
    // { id, name, host, port, username, keyPath, savePassword, passwordEnc, passphraseEnc }
    servers: [],
  };
}

// The engine looks credentials up by "user@host" (see fs/afs.js parseLocation),
// which is all it needs and all it should know. The window works with named
// entries instead, because "NAS Montage" is what a person recognises.
//
// Decryption happens here, on the way to a run, and the result is held in
// memory for that run only.
function credentialMap(servers) {
  const out = {};
  for (const s of (servers || [])) {
    if (!s || !s.host || !s.username) continue;
    let privateKey = null;
    if (s.keyPath) {
      try { privateKey = fs.readFileSync(s.keyPath); } catch (_) { privateKey = null; }
    }
    out[`${s.username}@${s.host}`] = {
      username  : s.username,
      password  : secrets.decrypt(s.passwordEnc),
      privateKey,
      passphrase: secrets.decrypt(s.passphraseEnc),
    };
  }
  return out;
}

// Up to 0.2.5, clicking the "identical" chip in the stats bar switched
// "show identical" on behind the user's back, and the next write to the
// preferences made it permanent — the switch came back ticked at every launch
// with no way to tell it had never been asked for. The cause is fixed; this
// clears the value it left behind, once.
function migratePrefs(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const from = Number(raw.revision) || 0;

  if (from < 1) {
    if (raw.ui && typeof raw.ui === 'object') raw.ui.showEqual = false;
  }

  // Up to 0.2.6 the only way to reach a server was to type an sftp:// URL, and
  // whatever credentials that produced sat under "user@host" — with the
  // password in plain text. Turn each one into a named entry so it appears in
  // the connection window, move its password into the OS credential store, and
  // delete every readable secret from this file on the way through.
  if (from < 2) {
    if (!Array.isArray(raw.servers)) raw.servers = [];
    const known = new Set(raw.servers.map(s => `${s.username}@${s.host}`));
    let n = raw.servers.length;
    for (const key of Object.keys(raw.sftp || {})) {
      const m = /^([^@]*)@(.+)$/.exec(key);
      if (!m || known.has(key)) continue;
      const c = raw.sftp[key] || {};
      const username = c.username || m[1];
      const host = m[2];
      if (!username || !host) continue;
      const enc = secrets.encrypt(c.password);
      raw.servers.push({
        id  : `srv-${++n}-${host}`,
        name: host,
        host, port: 22, username,
        keyPath      : c.keyPath || c.privateKeyPath || '',
        savePassword : !!enc,
        passwordEnc  : enc || '',
        passphraseEnc: secrets.encrypt(c.passphrase) || '',
      });
      known.add(key);
    }
    // Gone for good. If the machine has no usable credential store, the
    // password is simply not kept — asking again beats leaving it readable.
    delete raw.sftp;
  }

  // Belt and braces on every load, whatever the revision: a `password` or
  // `passphrase` key must never survive in this file, even if an older build,
  // a hand edit or a restored backup put one there.
  for (const s of (raw.servers || [])) {
    if (!s || typeof s !== 'object') continue;
    if (s.password) {
      const enc = secrets.encrypt(s.password);
      if (enc) { s.passwordEnc = enc; s.savePassword = true; }
      delete s.password;
    }
    if (s.passphrase) {
      const enc = secrets.encrypt(s.passphrase);
      if (enc) s.passphraseEnc = enc;
      delete s.passphrase;
    }
  }

  raw.revision = PREFS_REVISION;
  return raw;
}

// Writes a file the way the sync engine writes data: beside it, then rename.
// writeFileSync truncates the target the moment it opens, so an interrupted
// write left an empty or half-written file. For preferences.json that meant a
// blank application on the next launch — recent jobs, window size and the SFTP
// credentials all gone, with no message; for a .syncto it meant the user's own
// job file destroyed.
function writeFileAtomic(file, text) {
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw err;
  }
}

// Deep merge that keeps unknown keys from the file and fills in new defaults.
// A non-object `over` where the default is an object (a hand-edited job with
// "compare": null) would have replaced a whole section with null and left the
// interface throwing halfway through a redraw; keep the default instead.
function merge(base, over) {
  if (over == null || typeof over !== 'object' || Array.isArray(over)) {
    if (over === undefined) return base;
    if (base && typeof base === 'object' && !Array.isArray(base)) return base;
    if (Array.isArray(base) && !Array.isArray(over)) return base;
    return over;
  }
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k of Object.keys(over)) {
    out[k] = (base && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k]))
      ? merge(base[k], over[k])
      : over[k];
  }
  return out;
}

class Prefs {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'preferences.json');
    this.data = defaultPrefs();
  }
  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = merge(defaultPrefs(), migratePrefs(raw));
    } catch (_) { this.data = defaultPrefs(); }
    return this.data;
  }
  save(patch) {
    if (patch) this.data = merge(this.data, patch);
    // The renderer can send arbitrary patches through save-prefs. This is the
    // one gate every write passes through, so it is where the promise "no
    // readable password is ever written to disk" is actually kept — not in the
    // callers, which would only have to forget once.
    scrubSecrets(this.data);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileAtomic(this.file, JSON.stringify(this.data, null, 2));
    } catch (_) {}
    return this.data;
  }

  // ── Servers ──────────────────────────────────────────────────────────────
  // What the connection window shows. Never the secrets themselves: the window
  // gets a flag saying a password is remembered, and that is all it needs.
  listServers() {
    return (this.data.servers || []).map(s => ({
      id: s.id, name: s.name, host: s.host, port: s.port || 22,
      username: s.username, keyPath: s.keyPath || '',
      hasPassword: !!s.passwordEnc,
      savePassword: !!s.savePassword,
    }));
  }

  // Credentials for one entry, decrypted, for an immediate connection attempt.
  serverSecrets(id) {
    const s = (this.data.servers || []).find(x => x.id === id);
    if (!s) return null;
    return {
      host: s.host, port: s.port || 22, username: s.username,
      keyPath: s.keyPath || '',
      password: secrets.decrypt(s.passwordEnc),
      passphrase: secrets.decrypt(s.passphraseEnc),
    };
  }

  // conn: { id?, name, host, port, username, password, keyPath, passphrase,
  //         savePassword }
  // Returns the stored entry (without secrets) plus whether the password could
  // actually be remembered — on a machine with no usable credential store it
  // cannot, and the window says so rather than pretending.
  saveServer(conn) {
    if (!Array.isArray(this.data.servers)) this.data.servers = [];
    const list = this.data.servers;
    const key = `${conn.username}@${conn.host}`;
    let entry = list.find(s => s.id === conn.id) ||
                list.find(s => `${s.username}@${s.host}` === key && (s.port || 22) === (Number(conn.port) || 22));
    if (!entry) {
      entry = { id: `srv-${Date.now().toString(36)}-${list.length + 1}` };
      list.push(entry);
    }
    entry.name     = String(conn.name || conn.host || '').trim() || conn.host;
    entry.host     = conn.host;
    entry.port     = Number(conn.port) || 22;
    entry.username = conn.username;
    entry.keyPath  = conn.keyPath || '';

    const wants = conn.savePassword !== false;
    entry.savePassword = wants;
    if (!wants) {
      entry.passwordEnc = '';
    } else if (conn.password) {
      entry.passwordEnc = secrets.encrypt(conn.password) || '';
    }
    if (conn.passphrase) entry.passphraseEnc = secrets.encrypt(conn.passphrase) || '';

    this.save();
    return {
      server: this.listServers().find(s => s.id === entry.id),
      // False means: asked to remember, could not. The caller tells the user.
      remembered: !wants || !conn.password ? true : !!entry.passwordEnc,
      vaultAvailable: secrets.available(),
    };
  }

  removeServer(id) {
    this.data.servers = (this.data.servers || []).filter(s => s.id !== id);
    this.save();
    return this.listServers();
  }
}

// No `password` or `passphrase` key survives a write, whatever put it there.
function scrubSecrets(data) {
  if (!data || !Array.isArray(data.servers)) return;
  for (const s of data.servers) {
    if (!s || typeof s !== 'object') continue;
    if (s.password) {
      const enc = secrets.encrypt(s.password);
      if (enc) { s.passwordEnc = enc; s.savePassword = true; }
      delete s.password;
    }
    if (s.passphrase) {
      const enc = secrets.encrypt(s.passphrase);
      if (enc) s.passphraseEnc = enc;
      delete s.passphrase;
    }
  }
  delete data.sftp;
}

// A job saved before multi-pair support carried a single left/right at the
// top level; it becomes the only entry of `pairs`.
function migrateJob(raw) {
  if (raw && !Array.isArray(raw.pairs) && (raw.left || raw.right)) {
    raw.pairs = [{ left: raw.left || '', right: raw.right || '' }];
  }
  if (raw && Array.isArray(raw.pairs)) {
    raw.pairs = raw.pairs
      .filter(p => p && (typeof p.left === 'string' || typeof p.right === 'string'))
      .map(p => ({ left: p.left || '', right: p.right || '' }));
    if (!raw.pairs.length) raw.pairs = [{ left: '', right: '' }];
  }
  if (raw && raw.sync) {
    // The Pro level was removed: without this coercion algoFor('pro') returns
    // null and an old "pro" job silently degrades to a FAST copy — the exact
    // opposite of what its author chose.
    if (raw.sync.copyLevel === 'pro') raw.sync.copyLevel = 'secure';
    // Versioning has no interface. A job asking for it with no revision folder
    // configured could only ever fail; the trash is the honest equivalent.
    if (raw.sync.deletion === 'versioning') {
      const v = raw.sync.versioning || {};
      if (!v.leftFolder && !v.rightFolder) raw.sync.deletion = 'recycler';
    }
  }
  return raw;
}

function loadJob(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Not a syncto job file.');
  if (raw.format !== JOB_FORMAT) throw new Error('Not a syncto job file.');
  const job = merge(defaultJob(), migrateJob(raw));
  // A job may be hand-edited or produced by another tool. Every section the
  // interface reads unconditionally must be an object by the time it gets
  // there, or the redraw throws with the path fields already replaced and the
  // rest of the window left showing the previous job.
  for (const k of ['compare', 'sync', 'autoSync']) {
    const def = defaultJob()[k];
    if (def && (!job[k] || typeof job[k] !== 'object' || Array.isArray(job[k]))) job[k] = def;
  }
  if (job.sync && (!job.sync.versioning || typeof job.sync.versioning !== 'object')) {
    job.sync.versioning = defaultJob().sync.versioning;
  }
  if (job.sync && (!job.sync.report || typeof job.sync.report !== 'object')) {
    job.sync.report = defaultJob().sync.report;
  }
  if (!Array.isArray(job.pairs) || !job.pairs.length) job.pairs = [{ left: '', right: '' }];
  delete job.left; delete job.right;
  return job;
}

function saveJob(file, job) {
  const out = merge(defaultJob(), job);
  out.format = JOB_FORMAT;
  writeFileAtomic(file, JSON.stringify(out, null, 2));
  return out;
}

module.exports = { Prefs, defaultJob, defaultPrefs, loadJob, saveJob, merge, migrateJob,
  migratePrefs, credentialMap, jobNameFromPath, JOB_EXT, JOB_FORMAT };
