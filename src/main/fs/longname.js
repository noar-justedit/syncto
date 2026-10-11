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

// (0.8.8) Names too long for a filesystem.
//
// Every common filesystem caps ONE name (not the whole path) at 255: UTF-16
// units on NTFS and HFS+, bytes on ext4, btrfs and so on a Synology share,
// UTF-8 bytes on APFS. A name that fits on the source can therefore be
// refused at the destination, and any suffix syncto adds (".syncto_tmp" while
// a copy is written, a date on a timestamped revision) can push a legal name
// over the edge. Windows reports that as a misleading ENOENT ("no such file or
// directory"), Linux and macOS as ENAMETOOLONG.
//
// Two answers:
//  - syncto's own scratch names (".syncto_tmp", ".syncto_old") are shortened
//    whenever they would come near a limit, so they never fail a copy whose
//    final name fits;
//  - a final name that fits nowhere safely is written under a shortened name,
//    "<beginning of the name>~<8 hex>.<ext>", and the run says so. The 8 hex
//    are taken from the full name, so the shortened name is the same at every
//    run: the comparison pairs it with its long original instead of seeing one
//    file missing and another one too many.

const crypto = require('crypto');

// A name is safe everywhere when it holds in 255 UTF-16 units AND in 255
// UTF-8 bytes. `limits.name` is only changed by the test suite (an ext4 disk
// cannot hold the over-long names the real cases are about).
const limits = { name: 255 };

// Room kept for scratch names. 143 is the smallest limit met in practice
// (encrypted shared folders on a Synology): a temporary name that fits there
// fits everywhere.
const SCRATCH_MAX = 143;

function fits(name, limit) {
  const max = limit == null ? limits.name : limit;
  const s = String(name);
  return s.length <= max && Buffer.byteLength(s, 'utf8') <= max;
}

function tagOf(name) {
  return crypto.createHash('sha1').update(String(name).normalize('NFC'), 'utf8').digest('hex').slice(0, 8);
}

// An extension worth keeping: short, no space (so "Forum 18. Smart…" is not one).
function splitExt(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0) return [name, ''];
  const ext = name.slice(i);
  if (ext.length > 16 || /\s/.test(ext)) return [name, ''];
  return [name.slice(0, i), ext];
}

// "<as much of the beginning as fits>~<tag>.<ext>". Cut on whole characters
// (never half an emoji), without a trailing space or dot, which Windows drops
// silently and would make the name differ from what was asked for.
function shorten(name, limit) {
  const max = limit == null ? limits.name : limit;
  const nfc = String(name).normalize('NFC');
  const [stem, ext] = splitExt(nfc);
  const tail = '~' + tagOf(nfc) + ext;
  const cps = Array.from(stem);
  let lo = 0, hi = cps.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (fits(cps.slice(0, mid).join('') + tail, max)) lo = mid; else hi = mid - 1;
  }
  return cps.slice(0, lo).join('').replace(/[\s.]+$/, '') + tail;
}

// The name to create at a destination for `name`: itself when it fits
// everywhere, its shortened form otherwise.
function diskName(name) {
  return fits(name) ? name : shorten(name);
}

// "<path><ext>" for a scratch file, with a shortened base name when the
// suffix would bring it near a filesystem's limit.
function scratchPath(fsx, p, ext) {
  const base = fsx.basename(p);
  if (fits(base + ext, SCRATCH_MAX)) return p + ext;
  return fsx.join(fsx.dirname(p), shorten(base, SCRATCH_MAX - ext.length) + ext);
}

module.exports = { limits, SCRATCH_MAX, fits, shorten, diskName, scratchPath, tagOf };
