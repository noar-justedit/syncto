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

// FTP / FTPS backend (0.9.1). Same contract as fs/native.js and fs/sftp.js,
// over filo's FTP engine (fs/ftp/client.js, itself on basic-ftp).
//
// What FTP is not, said once here so the rest of the code can rely on it:
//  - one command at a time per connection, so a transfer holds its connection
//    until it ends. Everything else (listings, stats, the lock's heartbeat)
//    runs on a SEPARATE control connection, otherwise a 20 GB copy would keep
//    the lock file from being refreshed and another machine would take the
//    folder. Each transfer leases a connection of its own; a copy between two
//    folders of the same server therefore uses up to three.
//  - no exclusive create and no atomic rename that refuses an existing target:
//    the lock is best effort on a plain FTP server (see writeExclusive).
//  - no symbolic links, no file ids, no permissions, no trash.
//  - the date of a file can only be set when the server offers MFMT, and a
//    listing without MLSD gives dates to the minute (timeResolutionSec).

const posix = require('path').posix;
const { Readable, Writable, PassThrough } = require('stream');
const { FtpRemote } = require('./ftp/client');
const { RemoteError } = require('./ftp/errors');

const DEFAULT_PORT = { ftp: 21, ftps: 21, 'ftps-implicit': 990 };
const SCHEME = { ftp: 'ftp', ftps: 'ftpes', 'ftps-implicit': 'ftps' };
const MAX_TRANSFER_CONNECTIONS = 4;
const STREAM_BUFFER = 1024 * 1024;

function normalize(p) {
  let s = String(p || '');
  if (!s.startsWith('/')) s = '/' + s;
  return posix.normalize(s).replace(/\/+$/, '') || '/';
}

function unsupported(what) {
  const e = new Error(`${what} is not available over FTP.`);
  e.code = 'ENOTSUP';
  return e;
}

class FtpFs {
  // opts: { protocol, host, port, username, password, transferMode }
  constructor(opts) {
    this.kind = 'ftp';
    this.sep = '/';
    this.opts = Object.assign({}, opts || {});
    this.protocol = this.opts.protocol || 'ftp';
    this.ctl = null;               // control connection: everything but file contents
    this.xfers = [];               // transfer connections: { remote, busy }
    this._connectPromise = null;
    this.closing = false;
    this._entered = new Map();     // folder → time it was last found enterable
    this._dirs = null;             // folders known to exist on this connection
  }

  get port() { return Number(this.opts.port) || DEFAULT_PORT[this.protocol] || 21; }

  deviceKey() { return `${this.protocol}:${this.opts.username}@${this.opts.host}:${this.port}`; }
  displayName(p) { return `${SCHEME[this.protocol] || 'ftp'}://${this.opts.username}@${this.opts.host}${p}`; }

  normalizeName(name) { return String(name).normalize('NFC'); }

  join(...parts)  { return normalize(posix.join(...parts.map(String))); }
  dirname(p)      { return posix.dirname(normalize(p)); }
  basename(p)     { return posix.basename(normalize(p)); }
  isAbsolute()    { return true; }
  resolve(p)      { return normalize(p); }

  // The error that killed the control connection, if any (the pool looks at it
  // to decide whether this backend can be reused).
  get dead() { return (this.ctl && this.ctl.dead) || null; }
  get hasFileIds() { return false; }
  supportsTrash() { return false; }

  // Dates in a listing are to the minute when the server has no MLSD. The
  // comparison widens its tolerance by this much (see MultiSession).
  get timeResolutionSec() { return this.ctl && this.ctl.coarseTimes ? 61 : 0; }
  get canSetMTime() { return !!(this.ctl && this.ctl.canSetMTime); }

  _remote() {
    return new FtpRemote({
      protocol: this.protocol,
      host: this.opts.host,
      port: this.port,
      user: this.opts.username,
      password: this.opts.password,
      transferMode: this.opts.transferMode === 'active' ? 'active' : 'passive',
    });
  }

  connect() {
    if (this._connectPromise) return this._connectPromise;
    const ctl = this._remote();
    this.ctl = ctl;
    this._connectPromise = ctl.connect().catch(err => {
      // Not kept: it would be replayed as a cached failure for every later
      // attempt, even once the network is back.
      this._connectPromise = null;
      this.ctl = null;
      throw err;
    });
    return this._connectPromise;
  }

  async close() {
    this.closing = true;
    const all = [this.ctl].concat(this.xfers.map(x => x.remote));
    this.xfers = [];
    this.ctl = null;
    this._connectPromise = null;
    for (const r of all) { if (r) { try { await r.close(); } catch (_) {} } }
  }

  // ── Transfer connections ────────────────────────────────────────────────
  async _lease() {
    if (this.closing) throw new Error('The FTP connection was closed.');
    if (this.dead) throw this.dead;
    this.xfers = this.xfers.filter(x => x.busy || x.remote.alive);
    let x = this.xfers.find(c => !c.busy);
    if (x) { x.busy = true; return x; }
    if (this.xfers.length >= MAX_TRANSFER_CONNECTIONS) {
      throw new RemoteError('Too many transfers at once on this FTP server.', { network: false });
    }
    const remote = this._remote();
    x = { remote, busy: true };
    this.xfers.push(x);
    try { await remote.connect(); }
    catch (err) {
      this.xfers = this.xfers.filter(c => c !== x);
      throw err;
    }
    return x;
  }

  // A connection that carried a transfer which did not end cleanly is closed:
  // its data channel is in an unknown state.
  _release(x, bad) {
    if (!x) return;
    x.busy = false;
    if (bad || !x.remote.alive) {
      this.xfers = this.xfers.filter(c => c !== x);
      try { x.remote.close(); } catch (_) {}
    }
  }

  // ── Metadata ────────────────────────────────────────────────────────────
  _map(e) {
    return {
      // A link cannot be followed or recreated over FTP: reported as "other",
      // which the comparison leaves alone.
      type : e.type === 'symlink' ? 'other' : e.type,
      size : Number(e.size) || 0,
      mtime: Number(e.mtime) || 0,
      mode : null,
      id   : null,
    };
  }

  async _canEnter(dir) {
    const t = this._entered.get(dir);
    if (t && Date.now() - t < 20000) return true;
    const ok = await this.ctl.canEnter(dir);
    if (ok) this._entered.set(dir, Date.now());
    return ok;
  }

  // Null means "does not exist" — and only that. An FTP server answers 550 to
  // "no such file" and to "you may not look", so a null is double-checked: the
  // folder around it must be enterable, otherwise the answer is an error and
  // the comparison cannot take an unreadable file for an absent one.
  async stat(p) {
    const full = normalize(p);
    if (full === '/') return { type: 'folder', size: 0, mtime: 0, mode: null, id: null };
    const st = await this.ctl.stat(full);
    if (st) return this._map(st);
    const dir = posix.dirname(full);
    if (!(await this._canEnter(dir))) {
      // The folder around it is not enterable. Either it is not there (then
      // neither is this, and that is a plain "absent"), or it is there and
      // this account may not look inside: an error, never an absence.
      if (await this.ctl.stat(dir)) {
        throw new RemoteError(`The folder ${dir} cannot be entered with this account.`, { fatal: true });
      }
    }
    return null;
  }

  async exists(p) { return (await this.stat(p)) !== null; }

  async readdir(p) {
    const list = await this.ctl.list(normalize(p));
    return list.map(e => {
      const m = this._map(e);
      return { name: e.name, type: m.type, size: m.size, mtime: m.mtime, id: null };
    });
  }

  async realpath(p) {
    if (p == null || p === '.') return this.ctl.home();
    return normalize(p);
  }

  async readlink() { throw unsupported('Reading a link'); }
  async symlink() { throw unsupported('Creating a link'); }

  _remember(dir) {
    if (!this._dirs) this._dirs = new Set();
    if (this._dirs.size > 20000) this._dirs.clear();
    this._dirs.add(dir);
  }

  _forget(dir) {
    this._entered.clear();
    if (!this._dirs) return;
    const pre = String(dir) + '/';
    for (const k of this._dirs) if (k === dir || k.startsWith(pre)) this._dirs.delete(k);
  }

  // Every level is looked at once and remembered, as on SFTP: a folder we just
  // wrote four hundred files into is not looked for again for each file.
  async mkdir(p) {
    const full = normalize(p);
    if (this._dirs && this._dirs.has(full)) return;
    const parts = full.split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur += '/' + part;
      if (this._dirs && this._dirs.has(cur)) continue;
      const st = await this.ctl.stat(cur);
      if (st) {
        if (st.type !== 'folder') throw Object.assign(new Error(`${cur} exists and is not a folder.`), { code: 'ENOTDIR' });
        this._remember(cur);
        continue;
      }
      try {
        await this.ctl.mkdir(cur);
      } catch (e) {
        if (!(await this.ctl.stat(cur))) throw e;     // lost a race, that is fine
      }
      this._remember(cur);
    }
  }

  async unlink(p) { return this.ctl.unlink(normalize(p)); }

  async rmdir(p) {
    this._forget(normalize(p));
    return this.ctl.rmdir(normalize(p));
  }

  // Replacing a file: most servers (every Unix one) rename onto an existing
  // name and replace it; some (IIS, Windows servers) refuse. In that case the
  // old file is moved aside first and put back if the rename does not go
  // through, so a dropped connection never leaves the name empty.
  async rename(from, to) {
    const src = normalize(from), dst = normalize(to);
    this._forget(src);
    try {
      await this.ctl.rename(src, dst);
      return;
    } catch (e) {
      if (!(await this.exists(src)) || !(await this.exists(dst))) throw e;
    }
    const parked = dst + '.syncto_old';
    try { await this.unlink(parked); } catch (_) {}
    await this.ctl.rename(dst, parked);
    try {
      await this.ctl.rename(src, dst);
    } catch (err) {
      try { await this.ctl.rename(parked, dst); } catch (_) {}
      throw err;
    }
    try { await this.unlink(parked); } catch (_) {}
  }

  // FTP has no rename that is guaranteed to refuse an existing target; this is
  // a check followed by a rename. Two machines taking over the same abandoned
  // lock in the same instant could both succeed: the lock of a folder on a
  // plain FTP server is best effort (README, "Servers").
  async renameStrict(from, to) {
    const dst = normalize(to);
    if (await this.exists(dst)) throw Object.assign(new Error(`${dst} already exists.`), { code: 'EEXIST' });
    return this.ctl.rename(normalize(from), dst);
  }

  async setMTime(p, mtimeMs) {
    if (!this.ctl.canSetMTime) {
      throw new Error('This FTP server cannot set the modification date of a file (no MFMT).');
    }
    return this.ctl.setMTime(normalize(p), mtimeMs);
  }

  async chmod() { /* permissions are not carried over FTP */ }
  async flush() { /* the server owns its cache */ }

  // ── Small writes, on the control connection ─────────────────────────────
  // An exclusive create does not exist in FTP: the file is looked for, then
  // written. The window between the two is one round trip.
  async writeExclusive(p, buf) {
    const full = normalize(p);
    if (await this.exists(full)) throw Object.assign(new Error(`${full} already exists.`), { code: 'EEXIST' });
    await this.ctl.upload(Readable.from([Buffer.from(buf)]), full, 0);
  }

  async appendByte(p, byte) {
    await this.ctl.upload(Readable.from([Buffer.from(byte, 'utf8')]), normalize(p), 1);
  }

  // ── Checksums computed by the server ────────────────────────────────────
  hashAlgos() { return this.ctl.hashAlgos(); }
  serverHash(p, algo, size) { return this.ctl.serverHash(normalize(p), algo, size); }

  // ── Streams ─────────────────────────────────────────────────────────────
  // basic-ftp drives the data connection itself: it wants a destination to
  // fill or a source to drain. These adapt that to the Readable / Writable the
  // copy loop works with — and make sure that a transfer which FAILED is an
  // error on the stream, never a stream that quietly ends short (basic-ftp
  // ends the destination in a `finally`, success or not, so the end is never
  // passed on by itself).
  createReadStream(p, start) {
    if (this.closing) throw new Error('The FTP connection was closed.');
    if (this.dead) throw this.dead;
    const full = normalize(p);
    let waiting = null;           // the write callback held back by a full buffer
    let lease = null, finished = false;
    const out = new Readable({
      highWaterMark: STREAM_BUFFER,
      read() { if (waiting) { const cb = waiting; waiting = null; cb(); } },
      destroy(err, cb) {
        if (!finished && lease) { try { lease.remote.abort(); } catch (_) {} }
        cb(err);
      },
    });
    const sink = new Writable({
      highWaterMark: STREAM_BUFFER,
      write(chunk, _enc, cb) { if (out.push(chunk)) cb(); else waiting = cb; },
      final(cb) { cb(); },
    });
    (async () => {
      try {
        lease = await this._lease();
        if (out.destroyed) return this._release(lease, true);
        await lease.remote.download(full, sink, Math.max(0, Number(start) || 0));
        finished = true;
        this._release(lease, false);
        out.push(null);
      } catch (err) {
        finished = true;
        this._release(lease, true);
        if (!out.destroyed) out.destroy(RemoteError.from(err, this.protocol));
      }
    })();
    return out;
  }

  createWriteStream(p, start) {
    if (this.closing) throw new Error('The FTP connection was closed.');
    if (this.dead) throw this.dead;
    const full = normalize(p);
    const offset = Math.max(0, Number(start) || 0);
    const source = new PassThrough({ highWaterMark: STREAM_BUFFER });
    let lease = null, done = false;
    const upload = (async () => {
      lease = await this._lease();
      if (ws.destroyed) { this._release(lease, true); return; }
      await lease.remote.upload(source, full, offset);
    })();
    const finish = bad => { if (done) return; done = true; this._release(lease, bad); };
    const ws = new Writable({
      highWaterMark: STREAM_BUFFER,
      write(chunk, _enc, cb) {
        if (source.write(chunk)) return cb();
        source.once('drain', cb);
      },
      final(cb) {
        source.end();
        upload.then(() => { finish(false); cb(); }, err => { finish(true); cb(RemoteError.from(err, 'ftp')); });
      },
      destroy(err, cb) {
        if (!done) {
          try { if (lease) lease.remote.abort(); } catch (_) {}
          finish(true);
        }
        try { source.destroy(); } catch (_) {}
        cb(err);
      },
    });
    // A refusal that comes before the end (permission, quota) reaches the
    // writer at once instead of waiting for a drain that will never come.
    upload.catch(err => { if (!ws.destroyed && !done) ws.destroy(RemoteError.from(err, 'ftp')); });
    return ws;
  }
}

module.exports = { FtpFs, DEFAULT_PORT, SCHEME };
