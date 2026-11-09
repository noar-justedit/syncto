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

// (0.9.1) From filo 0.8.1 (core/errors.js), with the messages of syncto's window.

// One error type for every protocol, carrying the two answers the queue needs:
//   network — the connection broke: reconnect and resume, it may work next time;
//   fatal   — retrying cannot help (wrong password, no permission, no space).
// And a message a person can act on. "ECONNREFUSED" or "530" says nothing to
// someone delivering rushes at midnight; "the server refused the password"
// does.

const NET_CODES = new Set([
  'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'ENOTCONN', 'EHOSTUNREACH',
  'ENETUNREACH', 'ENETDOWN', 'EAI_AGAIN', 'ESOCKETTIMEDOUT', 'ERR_STREAM_PREMATURE_CLOSE',
]);

class RemoteError extends Error {
  constructor(message, extra) {
    super(message);
    Object.assign(this, extra || {});
  }

  static from(err, protocol) {
    if (err instanceof RemoteError) return err;
    const raw = String((err && err.message) || err || 'Unknown error');
    const code = err && err.code;
    // A file error on THIS computer (Node fs: it carries syscall and path).
    // Never retried, and never worded as if the server had refused.
    if (err && err.syscall && err.path && typeof code === 'string') {
      const where = `"${err.path}"`;
      const msg = code === 'EPERM' || code === 'EACCES' ? `syncto is not allowed to write to ${where} on this computer.`
        : code === 'ENOSPC' ? `This computer's disk is full (${where}).`
        : code === 'ENOENT' ? `${where} does not exist on this computer.`
        : code === 'EROFS' ? `${where} is on a read-only disk.`
        : code === 'EBUSY' ? `${where} is in use by another application.`
        : raw;
      return new RemoteError(msg, { code, raw, fatal: true, local: true, noSpace: code === 'ENOSPC' });
    }
    const out = new RemoteError(friendly(raw, code, protocol), { code, raw });
    if (err && err.network) out.network = true;
    if (err && err.aborted) out.aborted = true;
    if (NET_CODES.has(code) || /timed? ?out|closed|socket hang up|connection (lost|reset)|not open|ECONNRESET|EPIPE|premature close/i.test(raw)) out.network = true;
    // FTP replies: 4xx is "try again later", 5xx is final. 421 closes the
    // connection; 425/426 are data connections that failed.
    if (typeof code === 'number') {
      if (code >= 400 && code < 500) out.network = true;
      if (code >= 500) out.fatal = true;
    }
    if (code === 'ENOTFOUND' || code === 'ECONNREFUSED') { out.fatal = true; out.network = false; }
    if (/authentication|login|530\b|password/i.test(raw) && !out.network) out.fatal = true;
    if (/ENOSPC|no space|quota|552\b/i.test(raw)) { out.fatal = true; out.network = false; out.noSpace = true; }
    if (/EACCES|EPERM|permission denied|access denied|550\b|553\b/i.test(raw)) { out.fatal = true; out.network = false; }
    return out;
  }
}

function friendly(raw, code, protocol) {
  const s = String(raw);
  if (code === 'ENOTFOUND' || /getaddrinfo ENOTFOUND/.test(s)) return 'This server name does not exist (check the address).';
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/.test(s)) return 'The server refused the connection: nothing is listening on that port, or the protocol is wrong.';
  if (code === 'ETIMEDOUT' || /ETIMEDOUT|Timed out while waiting for handshake/i.test(s)) return 'The server did not answer in time.';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'The server cannot be reached from this network.';
  if (/All configured authentication methods failed/i.test(s)) return 'The server refused the login: wrong user name, password or key.';
  if (/^530\b|Login incorrect|not logged in/i.test(s)) return 'The server refused the login: wrong user name or password.';
  if (/Cannot parse privateKey|Encrypted private (OpenSSH )?key detected/i.test(s)) return 'The private key cannot be read: wrong passphrase, or not a key file.';
  if (/wrong version number|unknown protocol|EPROTO/i.test(s)) return 'The secure handshake failed: the server does not speak TLS on this port (check FTPS explicit / implicit).';
  if (/self[- ]signed|unable to verify|certificate/i.test(s)) return 'The server\'s certificate could not be verified.';
  if (/no such file|ENOENT|^550 .*(No such|not found|not exist)/i.test(s)) return 'This item no longer exists on the server.';
  if (/EACCES|EPERM|permission denied|^550\b|^553\b/i.test(s)) return 'Permission denied: this account may not do that here.';
  if (/ENOSPC|^552\b|quota/i.test(s)) return 'Not enough space (disk full or quota reached).';
  if (/ECONNRESET|socket hang up|premature close/i.test(s)) return 'The connection was cut.';
  if (/handshake/i.test(s) && protocol === 'sftp') return 'The SSH handshake failed: is this really an SFTP server?';
  return s.replace(/^Error:\s*/, '');
}

module.exports = { RemoteError, friendly };
