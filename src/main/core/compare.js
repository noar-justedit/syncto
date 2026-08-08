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

// Traversal of both sides and categorization of every item.
//
// Comparison variants
//   'timeSize'  modification time + size   (fast, the sane default)
//   'content'   byte for byte              (slow, catches silent corruption)
//   'size'      size only                  (for filesystems with useless dates)
//
// Time comparison uses a tolerance (2 s by default) because FAT/exFAT store
// timestamps with 2-second resolution and SFTP with 1-second resolution — a
// file copied from an SD card to a NAS is legitimately "off by one second".
// Optional whole-hour shifts cover DST and timezone-naive filesystems.

const { PathFilter, SoftFilter } = require('./filter');

const CAT = {
  EQUAL      : 'equal',
  LEFT_ONLY  : 'leftOnly',
  RIGHT_ONLY : 'rightOnly',
  LEFT_NEWER : 'leftNewer',
  RIGHT_NEWER: 'rightNewer',
  DIFFERENT  : 'different',
  TIME_INVALID: 'timeInvalid',
  CONFLICT   : 'conflict',
};

const OP = {
  NONE          : 'none',            // both sides already identical
  CREATE_LEFT   : 'createLeft',
  CREATE_RIGHT  : 'createRight',
  DELETE_LEFT   : 'deleteLeft',
  DELETE_RIGHT  : 'deleteRight',
  OVERWRITE_LEFT: 'overwriteLeft',
  OVERWRITE_RIGHT: 'overwriteRight',
  // A detected move: the same file left one path and appeared at another, so
  // the other side renames instead of copying gigabytes and deleting the old
  // copy. FROM marks the old path, TO the new one; the two nodes are paired.
  MOVE_LEFT_FROM : 'moveLeftFrom',   // rename happens on the LEFT side
  MOVE_LEFT_TO   : 'moveLeftTo',
  MOVE_RIGHT_FROM: 'moveRightFrom',  // rename happens on the RIGHT side
  MOVE_RIGHT_TO  : 'moveRightTo',
  DO_NOTHING    : 'doNothing',       // deliberately skipped
  CONFLICT      : 'conflict',        // needs a human decision
};

const TEMP_EXT   = '.syncto_tmp';
const DB_NAME    = '.syncto.db';      // gzipped JSON, one per base folder
const LOCK_NAME  = '.syncto.lock';
const DEFAULT_TOLERANCE_SEC = 2;

const CHECKSUM_FILE = 'syncto-checksums.txt';

// Items syncto always ignores: its own scaffolding plus the usual OS litter.
// The checksum list is deliberately visible — a DIT should be able to find it —
// so it has to be excluded by name, otherwise the next mirror run would treat
// it as a stray file on the target and delete it.
const ALWAYS_SKIP = new Set([
  CHECKSUM_FILE,
  '.DS_Store', '.Spotlight-V100', '.Trashes', '.fseventsd', '.TemporaryItems',
  'Thumbs.db', 'desktop.ini', '$RECYCLE.BIN', 'System Volume Information',
]);

function isSyncToInternal(name) {
  return name === DB_NAME || name === LOCK_NAME || name.startsWith('.syncto.');
}

// ── Time helpers ───────────────────────────────────────────────────────────
function sameTime(a, b, toleranceSec, shiftMinutes) {
  const tol = (toleranceSec == null ? DEFAULT_TOLERANCE_SEC : toleranceSec) * 1000;
  const diff = Math.abs(a - b);
  if (diff <= tol) return true;
  for (const m of (shiftMinutes || [])) {
    const shift = Math.abs(m) * 60000;
    if (Math.abs(diff - shift) <= tol) return true;
  }
  return false;
}

// 'equal' | 'leftNewer' | 'rightNewer' | 'leftInvalid' | 'rightInvalid'
function compareTime(lhs, rhs, toleranceSec, shiftMinutes, now) {
  if (sameTime(lhs, rhs, toleranceSec, shiftMinutes)) return 'equal';
  const oneYearAhead = (now || Date.now()) + 365 * 86400000;
  if (lhs < 0 || lhs > oneYearAhead) return 'leftInvalid';
  if (rhs < 0 || rhs > oneYearAhead) return 'rightInvalid';
  return lhs < rhs ? 'rightNewer' : 'leftNewer';
}

// ── Byte-for-byte comparison ───────────────────────────────────────────────
async function equalContent(fsL, pl, fsR, pr, onBytes, token) {
  const a = fsL.createReadStream(pl);
  const b = fsR.createReadStream(pr);
  let bufA = Buffer.alloc(0), bufB = Buffer.alloc(0);
  let endA = false, endB = false, equal = true, done = false;

  const pull = (stream, which) => new Promise((resolve, reject) => {
    const onData = chunk => { stream.pause(); cleanup(); resolve(chunk); };
    const onEnd  = () => { cleanup(); resolve(null); };
    const onErr  = e => { cleanup(); reject(e); };
    const cleanup = () => {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onErr);
    };
    stream.on('data', onData); stream.on('end', onEnd); stream.on('error', onErr);
    stream.resume();
  });

  try {
    while (!done) {
      if (token && token.cancelled) { equal = false; break; }
      if (!endA && bufA.length === 0) {
        const c = await pull(a, 'a');
        if (c == null) endA = true; else bufA = c;
      }
      if (!endB && bufB.length === 0) {
        const c = await pull(b, 'b');
        if (c == null) endB = true; else bufB = c;
      }
      if (endA && endB) break;
      if (endA !== endB) { equal = false; break; }
      const n = Math.min(bufA.length, bufB.length);
      if (Buffer.compare(bufA.subarray(0, n), bufB.subarray(0, n)) !== 0) { equal = false; break; }
      if (onBytes) onBytes(n);
      bufA = bufA.subarray(n);
      bufB = bufB.subarray(n);
    }
  } finally {
    try { a.destroy(); } catch (_) {}
    try { b.destroy(); } catch (_) {}
  }
  return equal;
}

// ── Tree building ──────────────────────────────────────────────────────────
// One node per item, flat, parents before children (depth-first pre-order) so
// the grid can render it directly and folder rules can look at direct children.
class Comparer {
  // ctx: { left:{fs,path}, right:{fs,path}, config, token, onProgress }
  constructor(ctx) {
    this.left   = ctx.left;
    this.right  = ctx.right;
    this.cfg    = ctx.config || {};
    this.token  = ctx.token || { cancelled: false };
    this.onProgress = ctx.onProgress || (() => {});
    this.filter = new PathFilter(this.cfg.includeFilter, this.cfg.excludeFilter);
    this.soft   = new SoftFilter(this.cfg.softFilter);
    this.nodes  = [];
    this.errors = [];
    this.stats  = { scanned: 0, comparedBytes: 0 };
    this.symlinks = this.cfg.symlinks || 'exclude';   // exclude | asLink | follow
  }

  _emit(current) {
    this.onProgress({
      phase  : 'compare',
      scanned: this.stats.scanned,
      bytes  : this.stats.comparedBytes,
      current,
    });
  }

  async run() {
    const lRoot = await this.left.fs.stat(this.left.path);
    const rRoot = await this.right.fs.stat(this.right.path);
    if (!lRoot && !rRoot) throw new Error('Neither folder exists.');
    if (!lRoot) this.errors.push({ path: this.left.path,  message: 'Left folder not found — it will be created.' });
    if (!rRoot) this.errors.push({ path: this.right.path, message: 'Right folder not found — it will be created.' });

    await this._walk('', -1, 0, !!lRoot, !!rRoot);
    return { nodes: this.nodes, errors: this.errors, stats: this.stats };
  }

  async _list(side, relDir, exists) {
    if (!exists) return new Map();
    const base = side === 'left' ? this.left : this.right;
    const dir  = relDir ? base.fs.join(base.path, ...relDir.split('/')) : base.path;
    try {
      const list = await base.fs.readdir(dir);
      const map = new Map();
      for (const e of list) {
        if (ALWAYS_SKIP.has(e.name) || isSyncToInternal(e.name)) continue;
        if (e.name.endsWith(TEMP_EXT)) continue;   // leftover from an aborted run
        if (e.type === 'symlink' && this.symlinks === 'exclude') continue;
        if (e.type === 'other') continue;
        // Case-insensitive key so a Mac and a Windows share agree on identity,
        // while the original spelling is preserved for display and for I/O.
        map.set(e.name.normalize('NFC').toLowerCase(), e);
      }
      return map;
    } catch (err) {
      this.errors.push({ path: dir, message: err.message || String(err) });
      return new Map();
    }
  }

  async _walk(relDir, parentIdx, depth, lExists, rExists) {
    if (this.token.cancelled) return;
    const [L, R] = await Promise.all([
      this._list('left',  relDir, lExists),
      this._list('right', relDir, rExists),
    ]);

    const keys = new Set([...L.keys(), ...R.keys()]);
    const sorted = [...keys].sort();

    for (const key of sorted) {
      if (this.token.cancelled) return;
      const l = L.get(key) || null;
      const r = R.get(key) || null;
      const name = (l || r).name;
      const rel  = relDir ? relDir + '/' + name : name;

      const kind = (l || r).type;
      // A folder on one side and a file on the other: not comparable.
      const typeClash = l && r && l.type !== r.type;

      if (kind === 'folder' && !typeClash) {
        if (!this.filter.passFolder(rel)) continue;
        const idx = this.nodes.length;
        this.nodes.push(this._makeNode(idx, rel, name, 'folder', parentIdx, depth, l, r, null));
        this.stats.scanned++;
        if (this.nodes.length % 200 === 0) this._emit(rel);
        await this._walk(rel, idx, depth + 1, !!l, !!r);
        continue;
      }

      if (!this.filter.passFile(rel)) continue;
      const node = this._makeNode(this.nodes.length, rel, name,
        typeClash ? 'file' : kind, parentIdx, depth, l, r, typeClash);
      if (!typeClash && l && r && kind !== 'symlink') await this._categorizeFile(node, rel, l, r);
      else if (!typeClash && l && r && kind === 'symlink') await this._categorizeSymlink(node, rel, l, r);
      this.nodes.push(node);
      this.stats.scanned++;
      if (this.nodes.length % 200 === 0) this._emit(rel);
    }
  }

  _makeNode(idx, rel, name, type, parentIdx, depth, l, r, typeClash) {
    const node = {
      idx, rel, name, type, parent: parentIdx, depth,
      left : l ? { exists: true, size: l.size, mtime: l.mtime, id: l.id } : { exists: false },
      right: r ? { exists: true, size: r.size, mtime: r.mtime, id: r.id } : { exists: false },
      cat  : CAT.EQUAL,
      catMsg: '',
      dir  : 'none',
      op   : OP.NONE,
      active: true,
      dbChangeL: 'noChange',
      dbChangeR: 'noChange',
      movePair: null,       // idx of the paired node when part of a detected move
      preMoveOp: null,      // what the op was before pairing, to undo cleanly
    };
    if (typeClash) {
      node.cat = CAT.CONFLICT;
      node.catMsg = 'One side is a file, the other a folder.';
    } else if (l && !r) {
      node.cat = CAT.LEFT_ONLY;
    } else if (!l && r) {
      node.cat = CAT.RIGHT_ONLY;
    } else if (type === 'folder') {
      node.cat = CAT.EQUAL;
    }
    // Soft filter marks rows inactive without removing them from the view.
    if (type !== 'folder') {
      const size  = l ? l.size  : (r ? r.size  : 0);
      const mtime = l ? l.mtime : (r ? r.mtime : 0);
      if (!this.soft.passes(size, mtime)) node.active = false;
    }
    return node;
  }

  async _categorizeFile(node, rel, l, r) {
    const variant = this.cfg.compareVariant || 'timeSize';
    const tol     = this.cfg.timeTolerance;
    const shifts  = this.cfg.timeShifts || [];

    if (variant === 'size') {
      node.cat = (l.size === r.size) ? CAT.EQUAL : CAT.DIFFERENT;
      return;
    }

    if (variant === 'content') {
      if (l.size !== r.size) { node.cat = CAT.DIFFERENT; return; }
      if (!node.active) {                       // excluded by the soft filter
        node.cat = CAT.CONFLICT;
        node.catMsg = 'Content comparison was skipped for an excluded file.';
        return;
      }
      const pl = this.left.fs.join(this.left.path, ...rel.split('/'));
      const pr = this.right.fs.join(this.right.path, ...rel.split('/'));
      try {
        this._emit(rel);
        const same = await equalContent(
          this.left.fs, pl, this.right.fs, pr,
          n => { this.stats.comparedBytes += n; }, this.token);
        node.cat = same ? CAT.EQUAL : CAT.DIFFERENT;
      } catch (err) {
        node.cat = CAT.CONFLICT;
        node.catMsg = err.message || String(err);
        this.errors.push({ path: pl, message: node.catMsg });
      }
      return;
    }

    // timeSize
    const res = compareTime(l.mtime, r.mtime, tol, shifts);
    if (res === 'equal') {
      if (l.size === r.size) node.cat = CAT.EQUAL;
      else { node.cat = CAT.CONFLICT; node.catMsg = 'Same date but a different size.'; }
    } else if (res === 'leftInvalid' || res === 'rightInvalid') {
      node.cat = CAT.TIME_INVALID;
      node.catMsg = 'Invalid modification date.';
    } else {
      node.cat = res === 'leftNewer' ? CAT.LEFT_NEWER : CAT.RIGHT_NEWER;
    }
  }

  async _categorizeSymlink(node, rel, l, r) {
    const variant = this.cfg.compareVariant || 'timeSize';
    if (variant === 'timeSize') {
      const res = compareTime(l.mtime, r.mtime, this.cfg.timeTolerance, this.cfg.timeShifts);
      node.cat = res === 'equal' ? CAT.EQUAL
               : res === 'leftNewer' ? CAT.LEFT_NEWER
               : res === 'rightNewer' ? CAT.RIGHT_NEWER
               : CAT.TIME_INVALID;
      return;
    }
    try {
      const a = await this.left.fs.readlink(this.left.fs.join(this.left.path, ...rel.split('/')));
      const b = await this.right.fs.readlink(this.right.fs.join(this.right.path, ...rel.split('/')));
      node.cat = (a === b) ? CAT.EQUAL : CAT.DIFFERENT;
    } catch (err) {
      node.cat = CAT.CONFLICT;
      node.catMsg = err.message || String(err);
    }
  }
}

module.exports = {
  Comparer, CAT, OP, compareTime, sameTime, equalContent,
  TEMP_EXT, DB_NAME, LOCK_NAME, CHECKSUM_FILE, ALWAYS_SKIP, isSyncToInternal,
  DEFAULT_TOLERANCE_SEC,
};
