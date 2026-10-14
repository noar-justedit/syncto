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

// (0.9.0) Files syncto writes under a fixed name at the root of a folder: the
// database and its scratch copy, the checksum list, the recycle-bin probe.
//
// Whoever can write in a synchronized folder (a shared NAS, a drive handed
// over) could leave a symbolic link under one of these names. Opening it for
// writing follows it, and the run then overwrote a file OUTSIDE both folders
// (a project, ~/.ssh/authorized_keys…) without a word. The 0.8.8 guard
// covered the files of the comparison, not these.
//
// A link under one of our own names is never ours: it is removed (the link,
// not what it points at) before the write. Anything else that is not a file
// (a folder) is left alone and the write fails as before.

async function clearLink(fsx, p) {
  const st = await fsx.stat(p);
  if (st && st.type === 'symlink') await fsx.unlink(p);
}

module.exports = { clearLink };
