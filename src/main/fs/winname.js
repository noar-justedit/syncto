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

// (0.8.9) Windows-safe names.
//
// A Mac accepts in a name what Windows refuses: < > " | ? * and ":" (the
// Finder shows a ":" typed in a name as "/", and stores it as ":"), control
// characters, a trailing space or dot, and the device names CON, NUL, COM1…
// Written to an SMB share, the Mac does not refuse them either: it swaps each
// one for a private character (U+F001 to U+F029) that Windows displays as a
// box or an odd symbol. That is the "⍰" seen on a PC in "Industry⍰ Digital".
//
// Parentheses, commas, apostrophes, & and accents are legal on Windows and
// are left alone on purpose.
//
// With the option on, syncto writes "_" in place of each refused character,
// drops a trailing space or dot, and adds "_" after a device name ("CON.txt"
// becomes "CON_.txt"). The cleaned name is the item's identity, so the
// comparison pairs "a:b" on one side with "a_b" on the other at every run.

// What the Mac's SMB client writes for characters Windows refuses: control
// characters 0x01-0x1F become U+F001-U+F01F, then " * : < > ? \ | become
// U+F020-U+F027, and U+F028 / U+F029 stand for a trailing space / dot.
const MAC_SMB_PRIVATE = /[\uF001-\uF029]/g;
// eslint-disable-next-line no-control-regex
const REFUSED = /[<>:"/\\|?*\u0000-\u001F]/g;
const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

function windowsSafe(name) {
  // U+F028 / U+F029 are a trailing space / dot as the Mac wrote them: dropped
  // like the real ones, not turned into "_".
  let s = String(name).replace(/[\uF028\uF029]+$/, '').replace(MAC_SMB_PRIVATE, '_').replace(REFUSED, '_');
  s = s.replace(/[ .]+$/, '');
  if (!s) s = '_';
  const dot = s.indexOf('.');
  const base = dot < 0 ? s : s.slice(0, dot);
  if (DEVICE.test(base.trim())) s = base + '_' + (dot < 0 ? '' : s.slice(dot));
  return s;
}

function needsCleaning(name) { return windowsSafe(name) !== String(name); }

// The file a custom folder icon lives in on a Mac: "Icon" + carriage return,
// or, written through SMB, "Icon" + U+F00D. Its data is empty (the picture is
// in its resource fork, which syncto does not copy), so on Windows it is only
// ever a file named "Icon" and a strange symbol. With the option on it is
// left out, neither copied, renamed nor deleted.
function isMacIconFile(name) {
  return name === 'Icon\r' || name === 'Icon';
}

// The option, read from a job. "destination": the right side only (new items
// and existing ones); "both": both sides, the source included.
function safeNamesMode(cfg) {
  const v = cfg && cfg.safeNames;
  return v === 'destination' || v === 'both' ? v : 'off';
}

module.exports = { windowsSafe, needsCleaning, isMacIconFile, safeNamesMode };
