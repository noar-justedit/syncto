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

// Is the DRIVE behind a path there at all?
//
// A folder that is missing on a mounted drive is a folder to create. A folder
// missing because its drive is not mounted is nothing of the kind: comparing
// against it plans a copy of everything, and that plan is wrong. This module
// tells the two apart, from the shape of the path and one stat of its volume
// root — no scan, no network.
'use strict';

const fs = require('fs');
const path = require('path');

// The folder a path's volume is mounted on, or null when the path does not
// live under a known mount location (a folder on the startup disk).
function volumeRoot(p, platform) {
  const plat = platform || process.platform;
  const s = String(p || '');
  if (!s || /^sftp:\/\//i.test(s)) return null;
  if (plat === 'win32') {
    const unc = s.match(/^(\\\\[^\\\/]+[\\\/][^\\\/]+)/);
    if (unc) return unc[1] + '\\';
    const drv = s.match(/^([A-Za-z]:)/);
    return drv ? drv[1].toUpperCase() + '\\' : null;
  }
  const parts = s.split('/');          // ['', 'Volumes', 'NAS', ...]
  if (parts[1] === 'Volumes' && parts[2]) return '/Volumes/' + parts[2];
  if (plat === 'linux') {
    if (parts[1] === 'media' && parts[2] && parts[3]) return `/media/${parts[2]}/${parts[3]}`;
    if (parts[1] === 'run' && parts[2] === 'media' && parts[3] && parts[4]) return `/run/media/${parts[3]}/${parts[4]}`;
    if (parts[1] === 'mnt' && parts[2]) return '/mnt/' + parts[2];
  }
  return null;
}

// The volume a missing path needs, when that volume is not mounted:
// { root, name }. null when the path is on a mounted volume (or on no volume
// syncto can name), in which case a missing folder is just a missing folder.
function offlineVolume(p, opts) {
  const o = opts || {};
  const plat = o.platform || process.platform;
  const stat = o.stat || (q => { try { return fs.statSync(q); } catch (_) { return null; } });
  const root = volumeRoot(p, plat);
  if (!root) return null;
  const name = plat === 'win32' ? root.replace(/\\$/, '') : path.posix.basename(root);
  const st = stat(root);
  if (!st) return { root, name };
  // macOS leaves an empty folder behind in /Volumes now and then. Same device
  // as the startup disk means nothing is mounted on it: writing there fills the
  // system disk, not the drive the job was made for.
  if (plat === 'darwin' && root.startsWith('/Volumes/')) {
    const sys = stat('/');
    if (sys && st.dev === sys.dev) return { root, name };
  }
  return null;
}

module.exports = { volumeRoot, offlineVolume };
