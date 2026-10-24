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
const { fits, diskName, tagOf, tagIn } = require('../fs/longname');
const { windowsSafe, isMacIconFile, safeNamesMode } = require('../fs/winname');
// Required lazily: lock.js takes LOCK_NAME from this file, so importing it at
// the top would be a cycle and LOCK_NAME would be undefined on one of the two
// load orders. One call per comparison, so the lookup costs nothing.
let _lockMod = null;
function lockMod() { return (_lockMod || (_lockMod = require('./lock'))); }

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
// A target parked out of the way while its replacement is renamed into place
// (SFTP has no atomic replace). Normally gone within milliseconds; a dropped
// connection can strand one, and the next run sweeps it like any leftover.
const OLD_EXT    = '.syncto_old';
const DB_NAME    = '.syncto.db';      // gzipped JSON, one per base folder
const LOCK_NAME  = '.syncto.lock';
const DEFAULT_TOLERANCE_SEC = 2;
// (0.9.3) Folder listings asked for ahead of the walk, at most (see _readdir).
const PREFETCH_MAX = 8;

const CHECKSUM_FILE = 'syncto-checksums.txt';

// Items syncto always ignores: its own scaffolding plus the usual OS litter.
// The checksum list is deliberately visible — a DIT should be able to find it —
// so it has to be excluded by name, otherwise the next mirror run would treat
// it as a stray file on the target and delete it.
const ALWAYS_SKIP = new Set([
  CHECKSUM_FILE,
  '.DS_Store', '.Spotlight-V100', '.Trashes', '.fseventsd', '.TemporaryItems',
  '.DocumentRevisions-V100',
  'Thumbs.db', 'desktop.ini', '$RECYCLE.BIN', 'System Volume Information',
]);

// The skipped names that are FOLDERS, and whose contents belong to the
// operating system rather than to anyone: Windows indexing and restore data,
// Spotlight's index, the FSEvents journal. When syncto is removing the folder
// that holds one of them, it may take it whole — the volume recreates it on
// the spot if it still wants it.
//
// This is the list that was missing. The comparison skipped these names, so a
// folder holding one of them looked empty; the removal only ever unlinked
// FILES, so it never could be. Every run reported "ENOTEMPTY: directory not
// empty" on a folder Finder showed as empty, and no run could ever clear it.
//
// ".Trashes" and "$RECYCLE.BIN" are deliberately NOT here: they hold files
// somebody deleted and may want back. A folder containing one of those is
// refused, with an explanation.
const OS_LITTER_FOLDERS = new Set([
  'System Volume Information', '.Spotlight-V100', '.fseventsd',
  '.TemporaryItems', '.DocumentRevisions-V100',
]);

// Files Windows holds open at the root of a system drive; reading their
// attributes can fail with EBUSY while they are in use.
const SYSTEM_LOCKED = new Set(['pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'dumpstack.log', 'dumpstack.log.tmp']);

function isSyncToInternal(name) {
  if (name === DB_NAME || name === LOCK_NAME || name.startsWith('.syncto.')) return true;
  // A lock being taken over is renamed "Delete.N.<name>" for an instant; if a
  // comparison runs at that exact moment it must not see it as a user file.
  return /^Delete\.\d+\./.test(name) && name.includes('.syncto.');
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
// Returns true, false, or NULL when the token was cancelled mid-file. Null is
// not "different": returning false there marked byte-identical files for
// overwrite, and the run that followed re-copied them for nothing.
async function equalContent(fsL, pl, fsR, pr, onBytes, token) {
  const a = fsL.createReadStream(pl);
  const b = fsR.createReadStream(pr);
  let bufA = Buffer.alloc(0), bufB = Buffer.alloc(0);
  let endA = false, endB = false, equal = true, done = false, cancelled = false;

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
      if (token && token.cancelled) { cancelled = true; break; }
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
  return cancelled ? null : equal;
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
    this.leftovers = [];      // stray .syncto_tmp files from an interrupted run
    this.locks = [];          // lock files a run that never finished left behind
    this.stats  = { scanned: 0, comparedBytes: 0 };
    this.symlinks = this.cfg.symlinks || 'exclude';   // exclude | asLink
    // (0.8.9) Windows-safe names: off | destination (right side) | both.
    this.safe = safeNamesMode(this.cfg);
    // How many items these two folders held at the end of the last run, read
    // from the database before the scan started. Zero on a first comparison.
    //
    // Walking a tree has no total you can know in advance — you find out how
    // big it is by finishing — so this is the only honest source of a
    // percentage, and it is an ESTIMATE: the tree has changed since, which is
    // the whole reason for comparing. The interface says "about".
    this.expected = Math.max(0, ctx.expected || 0);
    this.startedAt = Date.now();
    // (0.9.0) Names too long for a destination that the last run knew, by
    // the short name they have there: "<folder>\0<short key>" -> long name.
    // A long original deleted at the source left its short copy unpaired: it
    // looked new, and 2 WAYS copied it back under the short name.
    this.shortIndex = null;
    for (const rel of ctx.knownRels || []) {
      const cut = rel.lastIndexOf('/');
      const leaf = rel.slice(cut + 1);
      if (fits(leaf)) continue;
      if (!this.shortIndex) this.shortIndex = new Map();
      this.shortIndex.set((cut < 0 ? '' : rel.slice(0, cut)) + '\u0000' + tagOf(leaf), leaf);
    }
  }

  _emit(current) {
    this.onProgress({
      phase  : 'compare',
      scanned: this.stats.scanned,
      bytes  : this.stats.comparedBytes,
      expected: this.expected,
      elapsedMs: Date.now() - this.startedAt,
      current,
    });
  }

  // Per-side spelling of a name that only exists on the other side. A Mac
  // stores "é" decomposed (NFD), a Linux server or a Windows share composed
  // (NFC); reusing the source spelling to build the destination path makes the
  // target create a SECOND file next to the one already there.
  _spell(side, name) {
    const fsx = (side === 'left' ? this.left : this.right).fs;
    return fsx.normalizeName ? fsx.normalizeName(name) : name;
  }

  async run() {
    const lRoot = await this.left.fs.stat(this.left.path);
    const rRoot = await this.right.fs.stat(this.right.path);
    if (!lRoot && !rRoot) throw new Error('Neither folder exists.');
    // `missingRoot` is what tells sync() this side is empty because it is gone,
    // not because it is genuinely empty. A missing base folder plus a mirror is
    // a mass deletion of the healthy side — see Session.sync().
    if (!lRoot) this.errors.push({ path: this.left.path,  message: 'Left folder not found: it will be created.',  missingRoot: 'left'  });
    if (!rRoot) this.errors.push({ path: this.right.path, message: 'Right folder not found: it will be created.', missingRoot: 'right' });

    // One event before anything is walked, and one after. Without the first,
    // nothing reaches the window until the 200th item — on a slow share or a
    // deep tree that is a long stare at an empty progress panel. Without the
    // last, the final count the window was shown is whatever the 200-item
    // boundary happened to land on, and the running total across pairs starts
    // the next pair from a stale number.
    this._emit('');
    this._pre = new Map();
    try {
      await this._walk({ c: '', l: '', r: '', lt: '', rt: '' }, -1, 0, !!lRoot, !!rRoot);
    } finally { this._pre = null; }
    this._emit('');
    return {
      nodes: this.nodes, errors: this.errors, stats: this.stats,
      leftovers: this.leftovers,
      locks: this.locks,
      cancelled: !!this.token.cancelled,
    };
  }

  // (0.9.3) The listing of a folder, read ahead. The walk is depth first and
  // one folder at a time, so on a NAS every folder cost one full round trip
  // before the next one was even asked for. While a folder is being walked, the
  // listings of its next sub-folders are already on their way (at most
  // PREFETCH_MAX at once, held until their turn). What is walked, in which
  // order, and what an unreadable folder does are unchanged: a read-ahead
  // that failed raises its error only when its folder is reached, in _list.
  _readdir(side, base, dir) {
    const key = side + '\u0000' + dir;
    const ahead = this._pre && this._pre.get(key);
    if (ahead) { this._pre.delete(key); return ahead; }
    return base.fs.readdir(dir);
  }

  _aheadKey(side, relDir) {
    const base = side === 'left' ? this.left : this.right;
    return side + '\u0000' + (relDir ? base.fs.join(base.path, ...relDir.split('/')) : base.path);
  }

  _prefetch(side, relDir) {
    if (!this._pre || this._pre.size >= PREFETCH_MAX || this.token.cancelled) return false;
    const base = side === 'left' ? this.left : this.right;
    const dir  = relDir ? base.fs.join(base.path, ...relDir.split('/')) : base.path;
    const key = side + '\u0000' + dir;
    if (this._pre.has(key)) return true;
    let p;
    try { p = Promise.resolve(base.fs.readdir(dir)); } catch (_) { return true; }
    p.catch(() => {});        // the error belongs to the walk, not to the read-ahead
    this._pre.set(key, p);
    return true;
  }

  // Returns a Map, or null when the directory could not be read. Null is NOT
  // an empty folder: treating an unreadable side as empty would make every
  // file on the healthy side look one-sided — and a mirror would delete them.
  async _list(side, relDir, exists) {
    if (!exists) return new Map();
    const base = side === 'left' ? this.left : this.right;
    const dir  = relDir ? base.fs.join(base.path, ...relDir.split('/')) : base.path;
    try {
      const list = await this._readdir(side, base, dir);
      // Lock files live at the ROOT of a base folder and nowhere else. The
      // listing is already in hand, so noticing a leftover costs nothing — and
      // the walk hides these names from the user, which is exactly why nobody
      // ever found out one had been left behind by a run that never finished.
      if (!relDir) {
        this.locks.push(...lockMod()
          .findLeftoverLocks(list, base.path, (d, n) => base.fs.join(d, n))
          .map(x => Object.assign(x, { side })));
      }
      const map = new Map();
      // (0.8.8) Keys that two names share on this side (see below).
      map.collided = new Set();
      for (const e of list) {
        // syncto-checksums.txt stays out at every depth: below the root it is
        // the proof list of a nested or overlapping job, which that job
        // rewrites — treated as a user file, an outer MIRROR deleted it at
        // every other run (tried and reverted during the 0.8.8 review).
        if (ALWAYS_SKIP.has(e.name) || isSyncToInternal(e.name)) continue;
        // (0.8.9) A Mac's custom-icon file ("Icon" + carriage return): with
        // Windows-safe names on, it is neither copied, renamed nor deleted.
        if (this.safe !== 'off' && isMacIconFile(e.name)) continue;
        if (e.name.endsWith(TEMP_EXT) || e.name.endsWith(OLD_EXT)) {
          // Leftover from a run that was killed or lost power. It is invisible
          // to the comparison — which is right — but nothing ever removed it
          // either, so an interrupted 180 GB copy sat on the NAS for ever and
          // the space vanished with no explanation anywhere in the app.
          this.leftovers.push({ side, path: base.fs.join(dir, e.name), size: e.size || 0, type: e.type });
          continue;
        }
        if (e.type === 'symlink' && this.symlinks === 'exclude') continue;
        if (e.type === 'other') continue;
        // (0.8.8) An item the filesystem refused to describe. Ignored when
        // nothing would have been done with it anyway (filtered out, or one of
        // the system files Windows keeps locked at a drive's root); otherwise
        // the whole folder is unreadable, which blocks the run — dropping it
        // made it look absent, and MIRROR deleted the other side's copy.
        if (e.unreadable) {
          const relC = (relDir ? relDir.normalize('NFC') + '/' : '') + e.name.normalize('NFC');
          // (0.9.0) Both spellings, as in _walk.
          const rels = this.safe === 'off' ? [relC] : [relC, relC.split('/').map(windowsSafe).join('/')];
          const filtered = e.type === 'folder' ? !this.filter.passFolderAny(rels) : !this.filter.passFileAny(rels);
          if (filtered || SYSTEM_LOCKED.has(e.name.toLowerCase())) continue;
          throw Object.assign(new Error(`"${e.name}" could not be read (${e.unreadable})`), { code: e.unreadable });
        }
        // Case-insensitive key so a Mac and a Windows share agree on identity,
        // while the original spelling is preserved for display and for I/O.
        const key = this._key(e.name);
        if (map.has(key) || map.collided.has(key)) {
          // Two items differing only by case cannot both exist on the other
          // side of a case-insensitive filesystem. (0.8.8) Neither of them is
          // synchronized any more: keeping "the first" paired whichever one
          // readdir listed first with the other side's file, and a MIRROR
          // then overwrote the backup of a.txt with the content of A.txt.
          const other = map.has(key) ? map.get(key).name : '';
          // (0.8.9) With Windows-safe names, two names can also meet once
          // cleaned ("a:b" and "a_b").
          const byCase = !other || other.normalize('NFC').toLowerCase() === e.name.normalize('NFC').toLowerCase();
          this.errors.push({
            path: base.fs.join(dir, e.name),
            message: !byCase
              ? `"${e.name}" and "${other}" become the same name for Windows ("${windowsSafe(e.name.normalize('NFC'))}"): neither is synchronized. Rename one of them.`
              : other
              ? `"${e.name}" and "${other}" differ only by upper/lower case: neither is synchronized. Rename one of them.`
              : `"${e.name}" differs only by upper/lower case from another name here: not synchronized.`,
          });
          map.delete(key);
          map.collided.add(key);
          continue;
        }
        map.set(key, e);
      }
      return map;
    } catch (err) {
      this.errors.push({ path: dir, message: err.message || String(err), fatal: true });
      return null;
    }
  }

  // (0.8.8) `from` holds a name too long for a destination and `to` has no
  // item by that name, but has its shortened form: they are the same item.
  // `to` is re-keyed under the long name, `short` remembers which side has
  // the short one.
  _pairShortened(from, to, toSide, short) {
    for (const [key, e] of from) {
      // (0.9.0) The name as it is on the destination's disk: cleaned only on a
      // side that cleans. "Session: <long>" from the right lands on a left
      // that keeps its names as shorten("Session: …"), not shorten("Session_ …"),
      // and the two were never paired again.
      const base = this._cleans(toSide) ? this._clean(e.name) : e.name.normalize('NFC');
      if (to.has(key) || fits(base)) continue;
      // Found by its tag, taken from the item's identity (see shorten()).
      if (!to.byTag) {
        to.byTag = new Map();
        for (const [k, x] of to) { const t = tagIn(x.name); if (t) to.byTag.set(t, k); }
      }
      const sk = to.byTag.get(tagOf(this._clean(e.name)));
      if (!sk || sk === key || from.has(sk) || (to.collided && to.collided.has(sk))) continue;
      const hit = to.get(sk);
      if (!hit) continue;
      to.delete(sk);
      to.set(key, hit);
      short.set(key, toSide);
    }
  }

  // (0.8.9) The name an item is known by: cleaned for Windows when the option
  // is on (NFC either way), so "a:b" and "a_b" are the same item.
  _clean(name) {
    const n = String(name).normalize('NFC');
    return this.safe === 'off' ? n : windowsSafe(n);
  }
  _key(name) { return this._clean(name).toLowerCase(); }
  // (0.9.0) Every name a filter may have been written with: the item's
  // identity and, with Windows-safe names on, each side's name on disk.
  _spellings(child) {
    if (this.safe === 'off') return [child.c];
    return [child.c, child.l.normalize('NFC'), child.r.normalize('NFC')];
  }
  _cleans(side) { return this.safe === 'both' || (this.safe === 'destination' && side === 'right'); }
  // The name an existing item will have on `side` once the run has renamed it.
  _after(side, diskName) {
    if (!this._cleans(side)) return diskName;
    const c = windowsSafe(diskName);
    return c === diskName ? diskName : c;
  }

  // `rels` carries three views of the current directory: `c` the canonical one
  // (NFC, side-independent — it keys the database and the grid), `l` and `r`
  // the spelling each side really has on disk.
  async _walk(rels, parentIdx, depth, lExists, rExists) {
    if (this.token.cancelled) return;
    const [L, R] = await Promise.all([
      this._list('left',  rels.l, lExists),
      this._list('right', rels.r, rExists),
    ]);
    // One side unreadable: comparing would fabricate one-sided items and turn
    // an I/O error into deletions. The whole directory is left out instead;
    // the fatal error recorded by _list blocks the synchronization.
    if (!L || !R) return;

    // (0.8.8) A name that clashes by case on either side is left out on both:
    // nothing is copied over it, and nothing on the other side is deleted.
    const clash = new Set([...(L.collided || []), ...(R.collided || [])]);
    // (0.8.8) A name too long for a destination was written there under a
    // shortened name; pair the two again so neither looks orphaned.
    const short = new Map();
    this._pairShortened(L, R, 'right', short);
    this._pairShortened(R, L, 'left', short);
    // (0.9.0) A short copy whose long original is gone: still the same item,
    // known by the long name the last run recorded.
    const longName = new Map();
    if (this.shortIndex) {
      for (const [M, other, side] of [[L, R, 'left'], [R, L, 'right']]) {
        const moves = [];
        for (const [key] of M) {
          if (other.has(key) || short.has(key)) continue;
          const t = tagIn(M.get(key).name);
          const hit = t && this.shortIndex.get((rels.c || '') + '\u0000' + t);
          if (!hit) continue;
          const longKey = this._key(hit);
          if (longKey === key || L.has(longKey) || R.has(longKey)) continue;
          moves.push([key, longKey, hit]);
        }
        for (const [key, longKey, hit] of moves) {
          M.set(longKey, M.get(key)); M.delete(key);
          short.set(longKey, side); longName.set(longKey, hit);
        }
      }
    }
    const keys = new Set([...L.keys(), ...R.keys()].filter(k => !clash.has(k)));
    const sorted = [...keys].sort();

    // (0.9.3) The sub-folders this loop will probably walk: their listings are
    // asked for ahead of time (see _readdir). A folder a filter then skips was
    // listed for nothing, which costs one read and changes no result.
    const ahead = [];
    const aheadOf = new Map();       // item key -> the read-ahead keys it owns
    for (const key of sorted) {
      const l = L.get(key), r = R.get(key);
      if (!l && !r) continue;
      if ((l || r).type !== 'folder' || (l && r && l.type !== r.type)) continue;
      const own = [];
      if (l) { const rel = rels.l ? rels.l + '/' + l.name : l.name; ahead.push(['left', rel]);  own.push(this._aheadKey('left', rel)); }
      if (r) { const rel = rels.r ? rels.r + '/' + r.name : r.name; ahead.push(['right', rel]); own.push(this._aheadKey('right', rel)); }
      aheadOf.set(key, own);
    }
    let aheadAt = 0;
    const readAhead = () => { while (aheadAt < ahead.length && this._prefetch(ahead[aheadAt][0], ahead[aheadAt][1])) aheadAt++; };
    // A read-ahead for a folder that was not walked (a filter, a clash) would
    // hold its slot for ever: it is dropped once its turn has passed.
    let passed = null;
    const dropPassed = () => { if (passed && this._pre) for (const k of passed) this._pre.delete(k); passed = null; };

    for (const key of sorted) {
      dropPassed();
      passed = aheadOf.get(key) || null;
      if (this.token.cancelled) return;
      readAhead();
      const l = L.get(key) || null;
      const r = R.get(key) || null;
      // The long name is the item's identity, whichever side holds the short one.
      // (0.9.0) Measured as the name will be on the missing side's disk.
      const missing = !l ? 'left' : !r ? 'right' : null;
      const onMissing = missing && (this._cleans(missing) ? this._clean((l || r).name) : (l || r).name.normalize('NFC'));
      const shortOn = short.get(key) || (missing && !fits(onMissing) ? missing : null);
      const orig  = longName.get(key) || (shortOn === 'left' ? r : (l || r)).name.normalize('NFC');
      const name  = this._clean(orig);
      const rel   = rels.c ? rels.c + '/' + name : name;
      // (0.8.9) Two spellings per side: the one on disk now (to read it during
      // the comparison) and the one it will have after this run's renames
      // (what the synchronization works on). They differ only for a name
      // cleaned for Windows; a side that is not cleaned keeps its names.
      const lAfter = l ? this._after('left', l.name)
                       : this._spell('left', diskName(this._cleans('left') ? name : orig, name));
      const rAfter = r ? this._after('right', r.name)
                       : this._spell('right', diskName(this._cleans('right') ? name : orig, name));
      const lName = l ? l.name : lAfter;
      const rName = r ? r.name : rAfter;
      const child = {
        c: rel,
        l: rels.l ? rels.l + '/' + lName : lName,
        r: rels.r ? rels.r + '/' + rName : rName,
        lt: rels.lt ? rels.lt + '/' + lAfter : lAfter,
        rt: rels.rt ? rels.rt + '/' + rAfter : rAfter,
      };
      this._fix = { left: l && lAfter !== l.name ? l.name : null, right: r && rAfter !== r.name ? r.name : null };

      const kind = (l || r).type;
      this._shortOn = shortOn;
      // A folder on one side and a file on the other: not comparable.
      const typeClash = l && r && l.type !== r.type;

      if (kind === 'folder' && !typeClash) {
        if (!this.filter.passFolderAny(this._spellings(child))) continue;
        const idx = this.nodes.length;
        this.nodes.push(this._makeNode(idx, child, name, 'folder', parentIdx, depth, l, r, null));
        this.stats.scanned++;
        if (this.nodes.length % 200 === 0) this._emit(rel);
        await this._walk(child, idx, depth + 1, !!l, !!r);
        continue;
      }

      if (!this.filter.passFileAny(this._spellings(child))) continue;
      const node = this._makeNode(this.nodes.length, child, name,
        typeClash ? 'file' : kind, parentIdx, depth, l, r, typeClash);
      if (!typeClash && l && r && kind !== 'symlink') await this._categorizeFile(node, child, l, r);
      else if (!typeClash && l && r && kind === 'symlink') await this._categorizeSymlink(node, child, l, r);
      this.nodes.push(node);
      this.stats.scanned++;
      if (this.nodes.length % 200 === 0) this._emit(rel);
    }
    dropPassed();
  }

  _makeNode(idx, rels, name, type, parentIdx, depth, l, r, typeClash) {
    const rel = rels.c;
    const node = {
      idx, rel,
      // Only when a side really spells it differently. Outside an NFC/NFD
      // disagreement these are the same string as `rel`, and relOn() already
      // falls back to `rel` when they are null — so storing them was three
      // copies of every path in memory: 288 MB instead of 191 at 400 000 rows.
      relL: rels.lt === rel ? null : rels.lt,
      relR: rels.rt === rel ? null : rels.rt,
      name, type, parent: parentIdx, depth,
      // (0.8.8) The side where this item has (or will get) a shortened name.
      short: this._shortOn || null,
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
    // Either side passing is enough: judging a two-sided item on the left copy
    // alone silently dropped a file edited yesterday on the right because the
    // left copy was a year old.
    if (type !== 'folder') {
      const ok = (l && this.soft.passes(l.size, l.mtime)) ||
                 (r && this.soft.passes(r.size, r.mtime));
      if (!ok) node.active = false;
    }
    // (0.8.9) The name this item has on disk now, on a side where the run
    // will rename it for Windows. Only set when there is a rename to do.
    if (this._fix && this._fix.left)  node.fixL = this._fix.left;
    if (this._fix && this._fix.right) node.fixR = this._fix.right;
    return node;
  }

  async _categorizeFile(node, rels, l, r) {
    const rel = rels.c;
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
      const pl = this.left.fs.join(this.left.path, ...rels.l.split('/'));
      const pr = this.right.fs.join(this.right.path, ...rels.r.split('/'));
      try {
        this._emit(rel);
        const same = await equalContent(
          this.left.fs, pl, this.right.fs, pr,
          n => { this.stats.comparedBytes += n; }, this.token);
        // Cancelled mid-file: leave the node on its harmless default (equal,
        // no operation). The run is flagged cancelled, so nothing will be
        // synchronized from this half-built tree anyway.
        if (same === null) return;
        node.cat = same ? CAT.EQUAL : CAT.DIFFERENT;
      } catch (err) {
        node.cat = CAT.CONFLICT;
        node.catMsg = err.message || String(err);
        this.errors.push({ path: pl, message: node.catMsg });
      }
      return;
    }

    // timeSize
    // (0.9.4) A date read from a plain FTP listing (no MLSD) is only good to
    // the minute, or to the day for a file over six months old, and the
    // server's time zone was measured once (a summer date and a winter date
    // cannot both be right). When such a date is all that separates two files
    // of the same size, the exact one is asked (MDTM). Before, a whole old
    // archive was copied again at every run.
    if ((l.approx || r.approx) && l.size === r.size && compareTime(l.mtime, r.mtime, tol, shifts) !== 'equal') {
      const d = Math.abs(l.mtime - r.mtime);
      if (l.approx === 'day' || r.approx === 'day' || Math.abs(d - 3600000) <= 61000) {
        for (const [e, sideName, base, relSide] of [[l, 'left', this.left, rels.l], [r, 'right', this.right, rels.r]]) {
          if (!e.approx) continue;
          try {
            const st = await base.fs.stat(base.fs.join(base.path, ...relSide.split('/')));
            if (st && st.mtime) { e.mtime = st.mtime; node[sideName].mtime = st.mtime; delete e.approx; }
          } catch (_) { /* the listing's date stands */ }
        }
      }
    }
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

  async _categorizeSymlink(node, rels, l, r) {
    const variant = this.cfg.compareVariant || 'timeSize';
    if (variant === 'timeSize') {
      const res = compareTime(l.mtime, r.mtime, this.cfg.timeTolerance, this.cfg.timeShifts);
      if (res === 'equal') { node.cat = CAT.EQUAL; return; }
      // A symlink has no content of its own but its target, and a recreated
      // link always carries today's date — on a filesystem without lutimes
      // (SFTP) the dates can never match. Ask what the links point at before
      // declaring one newer, or the pair is re-copied every single run.
      try {
        const a = await this.left.fs.readlink(this.left.fs.join(this.left.path, ...rels.l.split('/')));
        const b = await this.right.fs.readlink(this.right.fs.join(this.right.path, ...rels.r.split('/')));
        if (a === b) { node.cat = CAT.EQUAL; return; }
      } catch (_) { /* fall through to the date verdict */ }
      node.cat = res === 'leftNewer' ? CAT.LEFT_NEWER
               : res === 'rightNewer' ? CAT.RIGHT_NEWER
               : CAT.TIME_INVALID;
      return;
    }
    try {
      const a = await this.left.fs.readlink(this.left.fs.join(this.left.path, ...rels.l.split('/')));
      const b = await this.right.fs.readlink(this.right.fs.join(this.right.path, ...rels.r.split('/')));
      node.cat = (a === b) ? CAT.EQUAL : CAT.DIFFERENT;
    } catch (err) {
      node.cat = CAT.CONFLICT;
      node.catMsg = err.message || String(err);
    }
  }
}

module.exports = {
  Comparer, CAT, OP, compareTime, sameTime, equalContent,
  TEMP_EXT, OLD_EXT, DB_NAME, LOCK_NAME, CHECKSUM_FILE, ALWAYS_SKIP, OS_LITTER_FOLDERS,
  isSyncToInternal,
  DEFAULT_TOLERANCE_SEC,
};
