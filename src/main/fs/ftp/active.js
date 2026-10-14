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

// (0.9.1) From syncto 0.8.1 (proto/ftp-active.js), unchanged.

// Active-mode FTP (PORT / EPRT), which basic-ftp does not offer.
//
// In passive mode the client opens the data connection; in active mode the
// SERVER connects back to the client. Some old servers and some locked-down
// networks only allow the latter. syncto listens on a free port, tells the
// server where with PORT (IPv4) or EPRT (IPv6), and hands basic-ftp a stand-in
// data socket that becomes the real connection when the server calls in.
//
// Limits, said plainly:
//  - behind a home or venue router (NAT), the server cannot reach the client:
//    active mode then fails, which is why passive is the default everywhere;
//  - only a connection from the server's own address is accepted, so nobody
//    else on the network can slip a file in (or read one out).
//
// For FTPS the client still plays the TLS CLIENT on the data connection, even
// though the server opened the TCP side, and reuses the control connection's
// TLS session like passive mode does.

const net = require('net');
const tls = require('tls');
const { Duplex } = require('stream');

const ACCEPT_TIMEOUT_MS = 20000;

class ActiveDataSocket extends Duplex {
  constructor(server, ftp) {
    super({ allowHalfOpen: true });
    this.server = server;
    this.ftp = ftp;
    this.sock = null;
    this.queue = [];
    this.finalCb = null;
    this.timeoutMs = 0;
    this._acceptTimer = setTimeout(() => {
      if (!this.sock) this.emit('timeout');
    }, ACCEPT_TIMEOUT_MS);
    const expect = ftp.socket && ftp.socket.remoteAddress;
    server.on('connection', raw => {
      // Only the server we are talking to may connect here.
      // No known address for the server: nobody is let in.
      if (this.sock || !expect || normalizeIp(raw.remoteAddress) !== normalizeIp(expect)) { raw.destroy(); return; }
      clearTimeout(this._acceptTimer);
      try { server.close(); } catch (_) {}
      if (ftp.socket instanceof tls.TLSSocket) {
        const s = tls.connect(Object.assign({}, ftp.tlsOptions, { socket: raw, session: ftp.socket.getSession() }));
        // The same check as passive mode (guardDataTls in ftp.js): the data
        // connection must resume the checked TLS session or show the very
        // same certificate. Without the check in place, nothing gets through.
        s.once('secureConnect', () => {
          const ok = typeof ftp._synctoDataTlsOk === 'function' && ftp._synctoDataTlsOk(s);
          if (!ok) {
            s.destroy();
            this.destroy(Object.assign(new Error('The data connection showed a different certificate from the server. Refused: someone may be in the way.'), { fatal: true }));
            return;
          }
          this._attach(s);
        });
        s.once('error', e => this.destroy(e));
      } else this._attach(raw);
    });
    server.on('error', e => this.destroy(e));
  }

  _attach(s) {
    this.sock = s;
    if (this.timeoutMs) s.setTimeout(this.timeoutMs);
    s.on('timeout', () => this.emit('timeout'));
    s.on('data', d => { if (!this.push(d)) s.pause(); });
    s.on('end', () => this.push(null));
    s.on('error', e => this.destroy(e));
    s.on('close', () => { if (!this.destroyed) this.emit('close', false); });
    for (const [chunk, cb] of this.queue) s.write(chunk, cb);
    this.queue = [];
    if (this.finalCb) { const cb = this.finalCb; this.finalCb = null; s.end(cb); }
  }

  _read() { if (this.sock && this.sock.isPaused && this.sock.isPaused()) this.sock.resume(); }
  _write(chunk, _enc, cb) { if (this.sock) this.sock.write(chunk, cb); else this.queue.push([chunk, cb]); }
  _final(cb) { if (this.sock) this.sock.end(cb); else this.finalCb = cb; }
  _destroy(err, cb) {
    clearTimeout(this._acceptTimer);
    try { this.server.close(); } catch (_) {}
    if (this.sock) { try { this.sock.destroy(); } catch (_) {} }
    cb(err);
  }

  setTimeout(ms) { this.timeoutMs = ms; if (this.sock) this.sock.setTimeout(ms); return this; }
  get bytesRead() { return this.sock ? this.sock.bytesRead : 0; }
  get bytesWritten() { return this.sock ? this.sock.bytesWritten : 0; }
  get remoteAddress() { return this.sock ? this.sock.remoteAddress : ''; }
  get remotePort() { return this.sock ? this.sock.remotePort : 0; }
  get remoteFamily() { return this.sock ? this.sock.remoteFamily : ''; }
}

function normalizeIp(a) { return String(a || '').replace(/^::ffff:/, ''); }

// A basic-ftp transfer strategy: (ftp: FTPContext) → Promise<FTPResponse>.
async function enterActiveMode(ftp) {
  const ctrl = ftp.socket;
  const local = normalizeIp(ctrl && ctrl.localAddress);
  if (!local) throw new Error('Active mode: the control connection has no local address.');
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, local, resolve); });
  const port = server.address().port;
  const cmd = net.isIPv6(local)
    ? `EPRT |2|${local}|${port}|`
    : `PORT ${local.split('.').join(',')},${port >> 8},${port & 255}`;
  let res;
  try { res = await ftp.request(cmd); }
  catch (e) { server.close(); throw e; }
  ftp.dataSocket = new ActiveDataSocket(server, ftp);
  return res;
}

module.exports = { enterActiveMode, ActiveDataSocket };
