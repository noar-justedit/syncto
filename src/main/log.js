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

// The diagnostic journal.
//
// syncto used to write nothing at all — no console output, no file. A user
// three countries away reporting "I press Synchronize and nothing happens" had
// nothing to send, and there was nothing to read. This exists so that sentence
// can be answered with a file.
//
// Three rules it follows:
//
//   1. OFF BY DEFAULT, one switch in the settings. Nothing is written until
//      somebody asks for it — a log nobody reads is disk wear and one more
//      place for a path to leak.
//
//   2. ONE SESSION, ONE FILE. It is emptied at every launch. What is wanted is
//      "turn it on, reproduce the problem, send it" — not an archive to dig
//      through, and not a file that grows for a year.
//
//   3. WRITTEN SYNCHRONOUSLY. A buffered log loses precisely the last few
//      lines — the ones describing the thing that went wrong. appendFileSync
//      costs a few microseconds per line and never loses the end of the story.
//
//   4. NEVER LOGS A SECRET. Everything that can carry one goes through
//      redact() first: "sftp://user:hunter2@nas/vol" is a legal path the user
//      may have typed into the folder field, and a log people send by email is
//      the last place for it.

const fs = require('fs');
const path = require('path');

// A ceiling, not a rotation: the file belongs to one session, and a session
// that produces eight megabytes of log has already said what it had to say.
const MAX_BYTES = 8 * 1024 * 1024;
// What the settings window shows and copies. Reading a whole session into the
// window would be the tail anyway, and this is the tail.
const VIEW_BYTES = 400 * 1024;

// "sftp://user:secret@host/path" → "sftp://user@host/path". Also catches the
// same shape inside a longer sentence, which is where error messages put it.
function redact(text) {
  return String(text == null ? '' : text)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@]*@/gi, '$1@');
}

function stamp() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

class Logger {
  constructor() {
    this.dir = null;
    this.file = null;
    this.enabled = false;
    this.bytes = 0;
    this.capped = false;
  }

  // Called once the app knows where its profile lives. `on` is the setting.
  // The file is TRUNCATED here: one session, one log.
  open(userDataDir, on) {
    try {
      this.dir = path.join(userDataDir, 'logs');
      this.file = path.join(this.dir, 'syncto.log');
      if (!on) { this.enabled = false; return this; }
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, '');      // a new session starts on a clean page
      this.enabled = true;
      this.bytes = 0;
      this.capped = false;
    } catch (_) {
      // A profile we cannot write to is not a reason to refuse to run.
      this.enabled = false;
    }
    return this;
  }

  // Turning it on mid-session starts a fresh file, so what the user sends is
  // the reproduction they just did and nothing else.
  setEnabled(on, header) {
    if (!!on === this.enabled) return this.enabled;
    if (on) {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(this.file, '');
        this.enabled = true; this.bytes = 0; this.capped = false;
        if (header) this.header(header);
      } catch (_) { this.enabled = false; }
    } else {
      this.info('log', 'logging turned off');
      this.enabled = false;
    }
    return this.enabled;
  }

  folder() { return this.dir; }
  path()   { return this.file; }

  // The tail, for the settings window. Returns '' when logging is off or the
  // file is not there — never throws at the caller.
  read() {
    try {
      const st = fs.statSync(this.file);
      const start = Math.max(0, st.size - VIEW_BYTES);
      const fd = fs.openSync(this.file, 'r');
      try {
        const buf = Buffer.alloc(st.size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        const text = buf.toString('utf8');
        return start > 0 ? `… (earlier lines dropped)\n${text}` : text;
      } finally { fs.closeSync(fd); }
    } catch (_) { return ''; }
  }

  clear() {
    try { fs.writeFileSync(this.file, ''); this.bytes = 0; this.capped = false; return true; }
    catch (_) { return false; }
  }

  _write(level, tag, msg, extra) {
    if (!this.enabled || this.capped) return;
    let line = `${stamp()}  ${level.padEnd(5)} ${String(tag).padEnd(8)} ${redact(msg)}`;
    if (extra !== undefined && extra !== null) {
      let tail;
      try { tail = typeof extra === 'string' ? extra : JSON.stringify(extra); }
      catch (_) { tail = String(extra); }
      line += `  ${redact(tail)}`;
    }
    line += '\n';
    try {
      fs.appendFileSync(this.file, line);
      this.bytes += Buffer.byteLength(line);
      if (this.bytes >= MAX_BYTES) {
        this.capped = true;
        fs.appendFileSync(this.file,
          `${stamp()}  WARN  log      stopped here — this session passed ${
            Math.round(MAX_BYTES / 1024 / 1024)} MB\n`);
      }
    } catch (_) {
      // Losing the log must never take the run with it, and a disk that is
      // full would otherwise produce one failure per line for ever.
      this.enabled = false;
    }
  }

  info (tag, msg, extra) { this._write('INFO',  tag, msg, extra); }
  warn (tag, msg, extra) { this._write('WARN',  tag, msg, extra); }
  error(tag, msg, extra) { this._write('ERROR', tag, msg, extra); }
  debug(tag, msg, extra) { this._write('DEBUG', tag, msg, extra); }

  // An operation worth a line at both ends, with how long it took. This is
  // what answers the two questions a slow or stuck run raises: which request
  // never came back — a start line with no end line — and where the time went.
  //
  //   const t = log.begin('sftp', 'stat /vol/x');
  //   … ; t.end();  or  t.fail(err)
  begin(tag, what) {
    if (!this.enabled) return NOOP_TIMER;
    const t0 = Date.now();
    this._write('DEBUG', tag, `\u2192 ${what}`);
    const self = this;
    return {
      end(note) {
        const ms = Date.now() - t0;
        self._write('DEBUG', tag, `\u2190 ${what}`, `${ms} ms${note ? ' \u00b7 ' + note : ''}`);
        return ms;
      },
      fail(err) {
        const ms = Date.now() - t0;
        self._write('ERROR', tag, `failed: ${what}`,
          `${ms} ms \u00b7 ${(err && (err.code ? err.code + ' ' : '')) || ''}${(err && err.message) || err}`);
        return ms;
      },
    };
  }

  // The header every log starts with. Without it, a file someone sends is
  // impossible to place: which version, which machine, which platform.
  header(info) {
    if (!this.enabled) return;
    this._write('INFO', 'start', '\u2500'.repeat(60));
    this._write('INFO', 'start', `syncto ${info.version} \u00b7 ${info.platform} ${info.arch} \u00b7 Electron ${info.electron} \u00b7 Node ${info.node}`);
    this._write('INFO', 'start', `profile ${info.userData}`);
  }
}

const NOOP_TIMER = { end() { return 0; }, fail() { return 0; } };

// One instance for the whole main process. The renderer never writes to it
// directly — everything worth recording happens on this side.
const log = new Logger();

module.exports = { log, Logger, redact, MAX_BYTES, VIEW_BYTES };
