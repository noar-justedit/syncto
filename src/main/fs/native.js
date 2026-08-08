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

// Native (local / mounted network) filesystem backend.
// Implements the abstract filesystem contract described in fs/afs.js.

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const READ_BLOCK = 4 * 1024 * 1024;   // 4 MiB — good balance for spinning disks and SSDs

function typeOf(dirent) {
  if (dirent.isSymbolicLink()) return 'symlink';
  if (dirent.isDirectory())    return 'folder';
  if (dirent.isFile())         return 'file';
  return 'other';
}

class NativeFs {
  constructor() {
    this.kind = 'native';
    this.sep  = path.sep;
  }

  // Identifies the physical device, used to cap parallel operations per drive.
  deviceKey(p) {
    if (process.platform === 'win32') {
      const m = /^([a-zA-Z]:)/.exec(p) || /^(\\\\[^\\]+\\[^\\]+)/.exec(p);
      return 'native:' + (m ? m[1].toLowerCase() : p.slice(0, 3).toLowerCase());
    }
    // /Volumes/Foo/... on macOS, /media|/mnt/... on Linux — otherwise the root.
    const m = /^(\/(?:Volumes|media|mnt|run\/media)\/[^/]+)/.exec(p);
    return 'native:' + (m ? m[1] : '/');
  }

  displayName(p) { return p; }

  async connect() { /* nothing to do */ }
  async close()   { /* nothing to do */ }

  join(...parts)  { return path.join(...parts); }
  dirname(p)      { return path.dirname(p); }
  basename(p)     { return path.basename(p); }
  isAbsolute(p)   { return path.isAbsolute(p); }

  // Turns "~/foo", "%VAR%/foo" and relative paths into an absolute path.
  resolve(p) {
    let s = String(p || '').trim();
    if (!s) return s;
    if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(1));
    return path.resolve(s);
  }

  // lstat, not access: access() follows symlinks, so a dangling link would
  // read as "absent" — and then replacing it fails with EEXIST.
  async exists(p) {
    try { await fs.promises.lstat(p); return true; } catch (_) { return false; }
  }

  // Returns null when the item does not exist — and ONLY then. A permission
  // error must throw: "unreadable" reported as "absent" is how a sync engine
  // ends up deleting the healthy side. Never follows symlinks.
  async stat(p) {
    let st;
    try { st = await fs.promises.lstat(p); }
    catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
      throw err;
    }
    return {
      type   : st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'folder' : st.isFile() ? 'file' : 'other',
      size   : st.size,
      mtime  : st.mtimeMs,
      mode   : st.mode,
      id     : (st.dev != null && st.ino != null) ? `${st.dev}:${st.ino}` : null,
    };
  }

  // [{ name, type, size, mtime, id }] — throws on unreadable directories so the
  // caller can record a proper error instead of silently syncing an empty tree.
  async readdir(p) {
    const entries = await fs.promises.readdir(p, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      const full = path.join(p, e.name);
      let st = null;
      try { st = await fs.promises.lstat(full); } catch (_) { /* vanished mid-scan */ }
      if (!st) continue;
      out.push({
        name : e.name,
        type : typeOf(e),
        size : st.size,
        mtime: st.mtimeMs,
        id   : (st.dev != null && st.ino != null) ? `${st.dev}:${st.ino}` : null,
      });
    }
    return out;
  }

  async readlink(p) { return fs.promises.readlink(p); }
  async symlink(target, p) { return fs.promises.symlink(target, p); }

  createReadStream(p, opts) {
    return fs.createReadStream(p, Object.assign({ highWaterMark: READ_BLOCK }, opts || {}));
  }

  createWriteStream(p) {
    return fs.createWriteStream(p, { highWaterMark: READ_BLOCK });
  }

  // Creates a file only if it does not exist yet — the atomic primitive the
  // directory lock is built on. Throws with code EEXIST when taken.
  async writeExclusive(p, buf) {
    await fs.promises.writeFile(p, buf, { flag: 'wx' });
  }

  async appendByte(p, byte) { await fs.promises.appendFile(p, byte); }

  async mkdir(p)  { await fs.promises.mkdir(p, { recursive: true }); }
  async unlink(p) { await fs.promises.unlink(p); }
  async rmdir(p)  { await fs.promises.rmdir(p); }

  async rename(from, to) { await fs.promises.rename(from, to); }

  // Same as rename on this backend — POSIX rename is already atomic. Exists so
  // the directory lock can demand "no delete-and-retry tricks" on any backend.
  async renameStrict(from, to) { await fs.promises.rename(from, to); }

  async setMTime(p, mtimeMs) {
    const t = new Date(mtimeMs);
    await fs.promises.utimes(p, t, t);
  }

  async chmod(p, mode) { try { await fs.promises.chmod(p, mode); } catch (_) {} }

  // Flush the OS write cache so a verification read hits the physical medium
  // instead of the page cache. Non-fatal: some network mounts refuse fsync.
  async flush(p) {
    let fh = null;
    try { fh = await fs.promises.open(p, 'r+'); await fh.sync(); }
    catch (_) {}
    finally { if (fh) { try { await fh.close(); } catch (_) {} } }
  }

  supportsTrash() { return true; }
}

module.exports = { NativeFs, READ_BLOCK };
