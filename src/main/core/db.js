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

// The synchronization database: a snapshot of the last state in which both
// sides were known to be identical. Two way and Update need it — without a
// memory of the previous run there is no way to tell a deletion on one side
// from a creation on the other.
//
// One file per base folder, named .syncto.db, gzipped JSON. Both copies are
// written as a pair at the end of a successful run and carry the same stamp;
// if the two stamps disagree (someone restored one side from a backup, a run
// was interrupted) the database is considered unusable and the run degrades to
// by-difference decisions rather than guessing.
//
// Several folder pairs can share a base folder, so entries are keyed by a pair
// id (see pairIdFor).

const { clearLink } = require('./safewrite');
const zlib = require('zlib');
const { promisify } = require('util');
const gzip   = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const { DB_NAME } = require('./compare');

const FORMAT  = 'syncto-db';
const VERSION = 1;

// The database lives INSIDE the synchronized folder, so it is supplied by
// whatever is on the other side. A run must not be able to die of reading it:
// 16 MB is already far more than the largest real one (a 400 000-item tree
// compresses to about 6), and a file bigger than that is not a database.
const MAX_DB_BYTES  = 16 * 1024 * 1024;
const MAX_DB_INFLATED = 256 * 1024 * 1024;
// A real one expands 5 to 15 times; an image sequence on a server (no file
// ids, identical dates) nearly 50. The structure check below is what stops a
// crafted file; this only bounds the work before it.
const MAX_DB_RATIO = 100;

// More than one object or array every 20 characters: no database looks like
// that (one per ~150), a crafted file meant to exhaust memory does.
function tooDense(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 123 || c === 91) n++;
  }
  return n * 20 > text.length;
}

function streamToBuffer(stream, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    stream.on('data', c => {
      total += c.length;
      if (limit && total > limit) {
        stream.destroy();
        reject(new Error(`it is larger than ${Math.round(limit / (1024 * 1024))} MB`));
        return;
      }
      chunks.push(c);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function readFileBuffer(fsx, p, limit) {
  const st = await fsx.stat(p);
  if (!st || st.type !== 'file') return null;
  if (limit && st.size > limit) throw new Error(`it is larger than ${Math.round(limit / (1024 * 1024))} MB`);
  return streamToBuffer(fsx.createReadStream(p), limit);
}

function writeFileBuffer(fsx, p, buf) {
  return new Promise((resolve, reject) => {
    const ws = fsx.createWriteStream(p);
    ws.on('error', reject);
    ws.on('finish', resolve);
    ws.end(buf);
  });
}

// Returns the document, or null when there is no usable database here.
// `onDamaged` is called when a file IS present but cannot be read — that is a
// very different situation from "no database yet", and reporting the two the
// same way hid a corrupted file behind a reassuring message.
// (0.9.0) `out`, when given, receives the file's fingerprint and the document,
// so the save at the end of the run can reuse it (see savePairDb). `reuse`:
// a { digest, doc } from that earlier read; when the file has not changed
// since (same bytes), the document is not decompressed and parsed again.
async function readDb(fsx, basePath, onDamaged, out, reuse) {
  const p = fsx.join(basePath, DB_NAME);
  let buf;
  try {
    buf = await readFileBuffer(fsx, p, MAX_DB_BYTES);
  } catch (err) {
    if (onDamaged) onDamaged(`${p} could not be read: ${err.message}`);
    return null;
  }
  if (!buf || !buf.length) return null;
  const digest = require('crypto').createHash('sha1').update(buf).digest('hex');
  if (reuse && reuse.doc && reuse.digest === digest) return reuse.doc;
  try {
    // Compressed data expands: a megabyte of zeros is gigabytes of nothing,
    // and this runs in the process that is holding the folder locks.
    // (0.8.8) Two more limits. The sizes alone were not enough: 250 KB of
    // gzip expanding into "{},{},{}…" made 85 million objects and killed the
    // app at every comparison. A real database expands about 8 times and holds
    // one object per ~150 characters; anything far from that is not one.
    const limit = Math.min(MAX_DB_INFLATED, Math.max(buf.length * MAX_DB_RATIO, 1024 * 1024));
    const text = (await gunzip(buf, { maxOutputLength: limit })).toString('utf8');
    if (text.length > 1024 * 1024 && tooDense(text)) throw new Error('its structure is not that of a syncto database');
    const json = JSON.parse(text);
    if (json.format !== FORMAT) {
      if (onDamaged) onDamaged(`${p} was written by another version of syncto.`);
      return null;
    }
    if (out) { out.digest = digest; out.doc = json; }
    return json;
  } catch (err) {
    if (onDamaged) onDamaged(`${p} is damaged (${err.message}): it will be rebuilt from this run.`);
    return null;
  }
}

async function writeDb(fsx, basePath, doc) {
  const buf = await gzip(Buffer.from(JSON.stringify(doc), 'utf8'));
  const target = fsx.join(basePath, DB_NAME);
  // Write beside it, then rename. createWriteStream truncates the target the
  // instant it opens, so a power cut mid-write destroyed the database — and
  // this one file holds the history of EVERY pair based in this folder, so
  // all of them silently fell back to "no database yet" on the next run.
  const tmp = target + '.syncto_tmp';
  try {
    // (0.9.0) Not through a link planted under the scratch name.
    await clearLink(fsx, tmp);
    await writeFileBuffer(fsx, tmp, buf);
    try {
      await fsx.rename(tmp, target);
    } catch (err) {
      // (0.8.6) Windows can refuse to replace a file that carries the hidden
      // attribute. Clear it and try once more; anything else is a real error.
      if (typeof fsx.setHidden !== 'function' || !['EPERM', 'EACCES'].includes(err.code)) throw err;
      await fsx.setHidden(target, false);
      await fsx.rename(tmp, target);
    }
  } catch (err) {
    try { await fsx.unlink(tmp); } catch (_) {}
    throw err;
  }
  // (0.8.6) The file just renamed into place is new, and so visible on
  // Windows: hide it again after every write. (The lock is hidden too, in
  // lock.js; syncto-checksums.txt never is: it is the proof of the read-back
  // and meant to be found.)
  if (typeof fsx.setHidden === 'function') await fsx.setHidden(target, true);
}

// The in-memory view handed to the direction engine.
class SyncDb {
  constructor(session) {
    this.session = session || null;
    this.available = !!session;
    // (0.8.8) Without a prototype: files named "constructor", "toString" or
    // "__proto__" matched the built-in properties of a plain object, were never
    // found as themselves and stayed conflicts for ever.
    // (0.9.0) Made prototype-free in place instead of copied: the copy of every
    // item took half a second at 400 000 of them. JSON.parse makes
    // "__proto__" an own key, which stays readable once the prototype is gone.
    const items = session && session.items && typeof session.items === 'object' ? session.items : null;
    this.items = items ? Object.setPrototypeOf(items, null) : Object.create(null);
  }

  // entry: { type, cmpVar, left:{mtime,size,id}, right:{mtime,size,id} }
  get(rel) {
    const e = this.items[rel];
    if (!e) return null;
    return {
      type  : e.t === 'd' ? 'folder' : e.t === 'l' ? 'symlink' : 'file',
      cmpVar: e.v || 'timeSize',
      synced: !!e.sy,
      left  : { mtime: e.lm || 0, size: e.ls || 0, id: e.li || null },
      right : { mtime: e.rm || 0, size: e.rs || 0, id: e.ri || null },
    };
  }

  get size() { return Object.keys(this.items).length; }
}

// Loads the pair's session from both sides and validates that they agree.
async function loadPairDb(left, right, pairId) {
  const damage = [];
  const note = m => damage.push(m);
  // (0.9.0) Kept for the save at the end of the run (`docs` in the result).
  const docs = { left: {}, right: {} };
  const [dl, dr] = await Promise.all([
    readDb(left.fs, left.path, note, docs.left),
    readDb(right.fs, right.path, note, docs.right),
  ]);
  const res = await judgePair(dl, dr, damage, pairId);
  res.docs = docs;
  return res;
}

async function judgePair(dl, dr, damage, pairId) {
  // A damaged file is not the same story as a fresh folder, and telling the
  // user "no database yet" about a file that is sitting right there — with a
  // gunzip error behind it — sent them looking in the wrong place.
  if (damage.length) return { db: new SyncDb(null), reason: damage.join(' · ') };
  if (!dl || !dr) return { db: new SyncDb(null), reason: 'no database yet' };

  const sl = dl.sessions && dl.sessions[pairId];
  const sr = dr.sessions && dr.sessions[pairId];
  if (!sl || !sr) return { db: new SyncDb(null), reason: 'no database yet' };
  if (sl.stamp !== sr.stamp) {
    return { db: new SyncDb(null), reason: 'the two database copies disagree: falling back to a plain comparison' };
  }
  return { db: new SyncDb(sl), reason: null };
}

// Merges the new session into whatever else those folders already store, so a
// base folder shared by several pairs keeps every session.
// (0.9.0) `docs`: what loadPairDb read. A side whose file still holds the same
// bytes is not decompressed and parsed a second time (1.4 s per side at
// 400 000 items); one that changed since (another pair of the job, another
// machine) is read again, as before.
async function savePairDb(left, right, pairId, session, docs) {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const payload = Object.assign({}, session, { stamp, updated: Date.now() });

  const merge = async (side, which) => {
    const reuse = docs && docs[which];
    const doc = (await readDb(side.fs, side.path, null, null, reuse)) || { format: FORMAT, version: VERSION, sessions: {} };
    doc.format = FORMAT; doc.version = VERSION;
    if (!doc.sessions) doc.sessions = {};
    doc.sessions[pairId] = payload;
    await writeDb(side.fs, side.path, doc);
  };
  await merge(left, 'left');
  await merge(right, 'right');
  return stamp;
}

// Builds the "last synchronous state" from the comparison result plus what the
// sync engine actually managed to do.
//   nodes    the compared tree, with .op already resolved
//   applied  Map rel -> { ok, mtime, size }   (final state of a processed item)
//   prevDb   the database used for this run, so untouched or failed rows keep
//            their previous entry instead of being forgotten
//   keepRel  optional (rel, entry) -> bool: previous entries whose rel was not
//            seen at all this run (typically: excluded by the current filter)
//            are kept when it returns true. Without it, tightening the filter
//            for one run would erase the history of everything it hid, and
//            loosening it again would turn every hidden file into a conflict.
function buildSession(nodes, applied, prevDb, cmpVariant, leftPath, rightPath, keepRel) {
  const items = Object.create(null);   // see SyncDb (0.8.8)
  const OPN = require('./compare').OP;
  const seen = keepRel && prevDb && prevDb.items ? new Set() : null;

  for (const n of nodes) {
    if (seen) seen.add(n.rel);
    const t = n.type === 'folder' ? 'd' : n.type === 'symlink' ? 'l' : 'f';
    const res = applied ? applied.get(n.rel) : null;

    // Successfully processed: both sides now hold the same content and date.
    // File ids (inodes) are recorded per side — they are what makes the next
    // run able to recognize a moved file without reading a single byte.
    if (res && res.ok) {
      if (res.deleted) continue;                       // gone from both sides
      const e = {
        t, v: cmpVariant,
        lm: res.mtimeL != null ? res.mtimeL : res.mtime, ls: res.size,
        rm: res.mtimeR != null ? res.mtimeR : res.mtime, rs: res.size,
        // "syncto made these two identical, in this run." The two recorded
        // dates can legitimately DIFFER — when the target refuses utimes (an
        // SFTP server without SETSTAT, a FAT volume) or when preserving dates
        // is off, the copy carries its own date and the database records what
        // is really on disk. Without this flag, stillInSync compared the two
        // stored dates, found them apart, and declared a conflict that no
        // later run could ever clear.
        sy: 1,
      };
      if (res.idL) e.li = res.idL;
      if (res.idR) e.ri = res.idR;
      items[n.rel] = e;
      continue;
    }

    // Already identical before the run.
    if (n.op === OPN.NONE) {
      const e = {
        t, v: cmpVariant,
        lm: n.left.mtime  || 0, ls: n.left.size  || 0,
        rm: n.right.mtime || 0, rs: n.right.size || 0,
      };
      if (n.left.id)  e.li = n.left.id;
      if (n.right.id) e.ri = n.right.id;
      items[n.rel] = e;
      continue;
    }

    // Skipped, conflicted or failed: keep the previous knowledge untouched.
    const prev = prevDb && prevDb.items ? prevDb.items[n.rel] : null;
    if (prev) items[n.rel] = prev;
  }

  // Previous entries the traversal never visited. Genuinely-deleted items are
  // dropped (their node existed and was handled above); items the current
  // filter excluded from the walk keep their history for when it returns.
  if (seen) {
    for (const rel of Object.keys(prevDb.items)) {
      if (seen.has(rel) || items[rel]) continue;
      if (keepRel(rel, prevDb.items[rel])) items[rel] = prevDb.items[rel];
    }
  }

  return { cmpVar: cmpVariant, leftPath, rightPath, items };
}

function newPairId() {
  return 'pair-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// The pair's own session as ONE side stores it. loadPairDb needs both sides to
// agree, which is right for deciding directions and useless here: the whole
// question is what the surviving side remembers about a side that is missing.
async function readSideSession(fsx, basePath, pairId) {
  let doc = null;
  try { doc = await readDb(fsx, basePath); } catch (_) { return null; }
  const sess = doc && doc.sessions && doc.sessions[pairId];
  return sess || null;
}

// The identity of a folder pair inside the database file.
//
// Derived from the two paths: same pair, same id, run after run, saved or not —
// a random id per run would silently break two-way sync, the next run never
// finding the session it just wrote. (An explicit id is only honoured for a
// single-pair job that still carries the legacy job-level one.)
//
// Changing a path therefore changes the id. Since 0.8.6 the window keeps the
// former paths of a re-pointed pair, and Session.compare reads the history
// under them when the new id has none (previousPairId in session.js).
//
// The order matters (left and right are recorded separately), which is why the
// two paths are not sorted: swapping sides deliberately starts a fresh history
// rather than reading the old one backwards.
function pairIdFor(explicit, leftPath, rightPath) {
  if (explicit) return explicit;
  const norm = p => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
  const h = require('crypto').createHash('sha1')
    .update(norm(leftPath) + ' ' + norm(rightPath))
    .digest('hex').slice(0, 16);
  return 'auto-' + h;
}

module.exports = { SyncDb, loadPairDb, savePairDb, buildSession, newPairId, pairIdFor,
  readDb, writeDb, readSideSession };
