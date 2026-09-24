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

// A relative path inside a synchronized folder, checked before it becomes a
// real one.
//
// Everywhere in the engine, a path is built as `join(root, ...rel.split('/'))`.
// `join` normalises, so a single `..` segment anywhere in `rel` walks OUT of
// the folder the user chose — and `rel` is not always the engine's own work:
// it is assembled from names a server sends back, and it is read verbatim out
// of a `syncto-checksums.txt` that sits inside the folder being checked. Both
// are supplied by the other side.
//
// This is the one place that decides what a relative path may look like, so
// there is one rule rather than four slightly different ones.

// Windows takes both separators; a POSIX server can send a backslash inside a
// name, which is a legal character there and a separator here.
const SEPS = /[\/\\]/;

function badSegment(seg) {
  if (seg === '' || seg === '.' || seg === '..') return true;
  // A drive letter or a UNC start would turn join() into an absolute path.
  if (/^[A-Za-z]:$/.test(seg)) return true;
  return false;
}

// True when `rel` stays inside its root: no empty, `.` or `..` segment, not
// absolute, no NUL.
function isSafeRel(rel) {
  const s = String(rel == null ? '' : rel);
  if (s === '') return true;                 // the root itself
  if (s.includes('\0')) return false;
  if (s.startsWith('/') || s.startsWith('\\')) return false;
  const parts = s.split(SEPS);
  return !parts.some(badSegment);
}

// Same, as a guard. The message names the path because it lands in the run's
// error list, where the point is to be able to see WHICH entry was refused.
function assertSafeRel(rel, what) {
  if (isSafeRel(rel)) return String(rel == null ? '' : rel);
  throw new Error(`${what || 'Path'} refused — it points outside the folder: ${JSON.stringify(String(rel))}`);
}

// A name, as opposed to a path: one segment, nothing else. Used on what a
// remote server returns from readdir, and on lock file names.
function isSafeName(name) {
  const s = String(name == null ? '' : name);
  if (!s || s.includes('\0') || SEPS.test(s)) return false;
  return !badSegment(s);
}

module.exports = { isSafeRel, assertSafeRel, isSafeName };
