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

// SFTP backend. Same contract as fs/native.js, over an ssh2 connection.
//
// Design notes:
//  - One SSH connection per remote location, reused for the whole run. SFTP is
//    request/response over a single channel, so operations are serialized by a
//    small promise queue to avoid flooding servers that cap concurrent requests.
//  - Paths are always POSIX, whatever the local platform.
//  - `id` (inode) is not available over SFTP, so move detection and hard-link
//    awareness are disabled for remote locations.
//  - Timestamps have 1-second resolution in the SFTP protocol, which is why the
//    default comparison tolerance of 2 s matters here.

const posix = require('path').posix;

let ssh2 = null;
function getSsh2() { if (!ssh2) ssh2 = require('ssh2'); return ssh2; }

const READ_BLOCK = 512 * 1024;   // SFTP throughput is bounded by the window, not the block

function normalize(p) {
  let s = String(p || '').replace(/\\/g, '/');
  if (!s.startsWith('/')) s = '/' + s;
  return posix.normalize(s).replace(/\/+$/, '') || '/';
}

class SftpFs {
  // opts: { host, port, username, password, privateKey, passphrase, root }
  constructor(opts) {
    this.kind = 'sftp';
    this.sep  = '/';
    this.opts = opts || {};
    this.conn = null;
    this.sftp = null;
    this._chain = Promise.resolve();
  }

  deviceKey() { return `sftp:${this.opts.username}@${this.opts.host}:${this.opts.port || 22}`; }
  displayName(p) { return `sftp://${this.opts.username}@${this.opts.host}${p}`; }

  join(...parts)  { return normalize(posix.join(...parts.map(x => String(x).replace(/\\/g, '/')))); }
  dirname(p)      { return posix.dirname(normalize(p)); }
  basename(p)     { return posix.basename(normalize(p)); }
  isAbsolute()    { return true; }
  resolve(p)      { return normalize(p); }

  // Serializes SFTP requests: ssh2 will happily pipeline, but many servers
  // (and most NAS boxes) drop requests past a low concurrency limit.
  _q(fn) {
    const run = this._chain.then(fn, fn);
    this._chain = run.then(() => {}, () => {});
    return run;
  }

  connect() {
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = new Promise((resolve, reject) => {
      const { Client } = getSsh2();
      const conn = new Client();
      const cfg = {
        host             : this.opts.host,
        port             : this.opts.port || 22,
        username         : this.opts.username,
        readyTimeout     : 20000,
        keepaliveInterval: 10000,
      };
      if (this.opts.password)   cfg.password   = this.opts.password;
      if (this.opts.privateKey) cfg.privateKey = this.opts.privateKey;
      if (this.opts.passphrase) cfg.passphrase = this.opts.passphrase;

      conn.on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err) return reject(err);
          this.conn = conn; this.sftp = sftp;
          resolve();
        });
      });
      conn.on('error', err => reject(err));
      conn.connect(cfg);
    });
    return this._connectPromise;
  }

  async close() {
    try { if (this.conn) this.conn.end(); } catch (_) {}
    this.conn = null; this.sftp = null; this._connectPromise = null;
  }

  _mapStat(st) {
    const isLink = typeof st.isSymbolicLink === 'function' ? st.isSymbolicLink() : false;
    const isDir  = typeof st.isDirectory    === 'function' ? st.isDirectory()    : false;
    const isFile = typeof st.isFile         === 'function' ? st.isFile()         : false;
    return {
      type : isLink ? 'symlink' : isDir ? 'folder' : isFile ? 'file' : 'other',
      size : st.size,
      mtime: (st.mtime || 0) * 1000,     // SFTP reports seconds
      mode : st.mode,
      id   : null,
    };
  }

  // Null means "does not exist" — and only that. SSH_FX_NO_SUCH_FILE is 2;
  // a permission error must surface, not masquerade as an absent file (the
  // comparison would take "absent" at its word and schedule deletions).
  async stat(p) {
    return this._q(() => new Promise((resolve, reject) => {
      this.sftp.lstat(normalize(p), (err, st) => {
        if (!err) return resolve(this._mapStat(st));
        if (err.code === 2 || /no such file/i.test(err.message || '')) return resolve(null);
        reject(err);
      });
    }));
  }

  async exists(p) { return (await this.stat(p)) !== null; }

  async readdir(p) {
    const dir = normalize(p);
    const list = await this._q(() => new Promise((resolve, reject) => {
      this.sftp.readdir(dir, (err, l) => err ? reject(err) : resolve(l));
    }));
    return list
      .filter(e => e.filename !== '.' && e.filename !== '..')
      .map(e => {
        const st = this._mapStat(e.attrs);
        return { name: e.filename, type: st.type, size: st.size, mtime: st.mtime, id: null };
      });
  }

  async readlink(p) {
    return this._q(() => new Promise((resolve, reject) => {
      this.sftp.readlink(normalize(p), (err, t) => err ? reject(err) : resolve(t));
    }));
  }

  async symlink(target, p) {
    return this._q(() => new Promise((resolve, reject) => {
      this.sftp.symlink(target, normalize(p), err => err ? reject(err) : resolve());
    }));
  }

  // Streams bypass the queue on purpose: they hold a channel for their whole
  // lifetime, and the sync engine never runs two transfers on one connection.
  createReadStream(p) {
    return this.sftp.createReadStream(normalize(p), { highWaterMark: READ_BLOCK });
  }

  createWriteStream(p) {
    return this.sftp.createWriteStream(normalize(p), { highWaterMark: READ_BLOCK });
  }

  // SSH_FXF_EXCL: the SFTP protocol has the exclusive-create flag natively.
  async writeExclusive(p, buf) {
    return this._q(() => new Promise((resolve, reject) => {
      const ws = this.sftp.createWriteStream(normalize(p), { flags: 'wx' });
      ws.on('error', err => {
        // Servers report the clash in various ways; normalize it for the caller.
        if (/exist|failure/i.test(err.message || '')) err.code = 'EEXIST';
        reject(err);
      });
      ws.on('close', resolve);
      ws.end(buf);
    }));
  }

  async appendByte(p, byte) {
    return this._q(() => new Promise((resolve, reject) => {
      const ws = this.sftp.createWriteStream(normalize(p), { flags: 'a' });
      ws.on('error', reject);
      ws.on('close', resolve);
      ws.end(Buffer.from(byte, 'utf8'));
    }));
  }

  async mkdir(p) {
    const full = normalize(p);
    const parts = full.split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur += '/' + part;
      const st = await this.stat(cur);
      if (st) continue;
      try {
        await this._q(() => new Promise((resolve, reject) => {
          this.sftp.mkdir(cur, err => err ? reject(err) : resolve());
        }));
      } catch (e) {
        if (!(await this.stat(cur))) throw e;   // lost a race, that is fine
      }
    }
  }

  async unlink(p) {
    return this._q(() => new Promise((resolve, reject) => {
      this.sftp.unlink(normalize(p), err => err ? reject(err) : resolve());
    }));
  }

  async rmdir(p) {
    return this._q(() => new Promise((resolve, reject) => {
      this.sftp.rmdir(normalize(p), err => err ? reject(err) : resolve());
    }));
  }

  _rawRename(src, dst) {
    return this._q(() => new Promise((resolve, reject) => {
      this.sftp.rename(src, dst, err => err ? reject(err) : resolve());
    }));
  }

  async rename(from, to) {
    const src = normalize(from), dst = normalize(to);
    try {
      await this._rawRename(src, dst);
    } catch (e) {
      // Most servers refuse to rename onto an existing target. The engine's
      // "tmp file → final name" rename legitimately needs to replace one, so
      // clear the target and retry — but only when the SOURCE is still there,
      // otherwise a failed rename would delete the target and nothing else.
      if ((await this.exists(src)) && (await this.exists(dst))) {
        await this.unlink(dst);
        await this._rawRename(src, dst);
      } else throw e;
    }
  }

  // Rename with NO delete-and-retry fallback. This is what makes the lock
  // takeover atomic: of two machines renaming the same abandoned lock, exactly
  // one may succeed — a fallback that deletes the target would let both win.
  async renameStrict(from, to) {
    return this._rawRename(normalize(from), normalize(to));
  }

  async setMTime(p, mtimeMs) {
    const t = Math.floor(mtimeMs / 1000);
    return this._q(() => new Promise((resolve, reject) => {
      this.sftp.utimes(normalize(p), t, t, err => err ? reject(err) : resolve());
    }));
  }

  async chmod(p, mode) {
    try {
      await this._q(() => new Promise((resolve, reject) => {
        this.sftp.chmod(normalize(p), mode, err => err ? reject(err) : resolve());
      }));
    } catch (_) {}
  }

  async flush() { /* the server owns its cache */ }
  supportsTrash() { return false; }
}

module.exports = { SftpFs, READ_BLOCK };
