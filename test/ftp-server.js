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

// A small but real FTP / FTPS server for the tests (0.9.1), in this process,
// on a folder of the disk. Real sockets, a real control connection and real
// passive data connections: what the engine talks to is the protocol, not a
// stand-in. Options let a test play the servers that are hard to be kind to:
//
//   mlsd       false → no MLSD / MLST, listings come as LIST text (dates to the minute)
//   mfmt       false → the server cannot set a file's date
//   hash       false → no HASH command; true → HASH SHA-256 / SHA-1 / MD5
//   strictRename  true → RNTO refuses an existing target (IIS style)
//   latencyMs  every answer waits this long
//   tls        { key, cert } → AUTH TLS (explicit) is offered
//   implicit   true → TLS from the first byte (needs tls)
//   maxConnections  the N+1th connection is refused with 421
//   noEnter    ['/locked'] → CWD into it, and anything below it, is refused (550) though the folder exists
//   port       a fixed port instead of a free one
//
// `log` receives every command ("RETR /a.txt"), so a test can say what did and
// did not happen ("the file was not read back").

const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

function pad(n, w = 2) { return String(n).padStart(w, '0'); }
function mlTime(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}
function parseMl(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(s);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : 0;
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "Oct 08 12:30" for a recent file, "Jan 05  2025" for an old one: what LIST prints.
function listTime(ms) {
  const d = new Date(ms);
  const old = Date.now() - ms > 180 * 86400000;
  return old ? `${MON[d.getUTCMonth()]} ${pad(d.getUTCDate(), 2)}  ${d.getUTCFullYear()}`
             : `${MON[d.getUTCMonth()]} ${pad(d.getUTCDate(), 2)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// A self-signed certificate for the FTPS tests, made with the openssl of the
// machine. null when there is none (then the FTPS tests say they are skipped).
function makeCert(dir) {
  try {
    const key = path.join(dir, 'k.pem'), cert = path.join(dir, 'c.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
      '-days', '2', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  } catch (_) { return null; }
}

function startFtpServer(opts) {
  const o = Object.assign({ user: 'u', pass: 'p', mlsd: true, mfmt: true, hash: false }, opts || {});
  const root = path.resolve(o.root);
  const log = [];
  const state = { connections: 0, open: 0, maxOpen: 0, log };

  // A path as the client sends it, mapped inside the root and nowhere else.
  const real = (cwd, p) => {
    const v = path.posix.normalize(p.startsWith('/') ? p : path.posix.join(cwd, p));
    const full = path.join(root, v);
    if (full !== root && !full.startsWith(root + path.sep)) return null;
    return { virt: v, full };
  };

  const onConnection = (sock0) => {
    state.connections++;
    if (o.maxConnections && state.open >= o.maxConnections) {
      sock0.end('421 Too many connections.\r\n');
      return;
    }
    state.open++; state.maxOpen = Math.max(state.maxOpen, state.open);
    let sock = sock0;
    let cwd = '/', authed = false, user = '', rnfr = null, restAt = 0, secure = !!o.implicit, prot = 'C';
    let pasv = null;                       // { server, socket, waiters }
    let buf = '';
    const send = (line) => { try { sock.write(line + '\r\n'); } catch (_) {} };
    const reply = (line) => (o.latencyMs ? setTimeout(() => send(line), o.latencyMs) : send(line));
    sock0.on('close', () => { state.open--; if (pasv) { try { pasv.server.close(); } catch (_) {} } });
    sock0.on('error', () => {});
    reply('220 test ftp server');

    const dataSocket = () => new Promise((resolve, reject) => {
      if (!pasv) return reject(new Error('no data connection'));
      if (pasv.socket) return resolve(pasv.socket);
      pasv.waiters.push(resolve);
      setTimeout(() => reject(new Error('data connection timed out')), 8000);
    });
    const closeData = () => { if (pasv) { try { pasv.server.close(); } catch (_) {} pasv = null; } };

    const openPasv = async (kind) => {
      closeData();
      const p = { socket: null, waiters: [] };
      const srv = net.createServer(s => {
        const ready = sock instanceof tls.TLSSocket && prot === 'P'
          ? new tls.TLSSocket(s, { isServer: true, secureContext: ctx, session: undefined })
          : s;
        ready.on('error', () => {});
        p.socket = ready;
        for (const w of p.waiters) w(ready);
        p.waiters = [];
        try { srv.close(); } catch (_) {}
      });
      p.server = srv;
      await new Promise(r => srv.listen(0, '127.0.0.1', r));
      pasv = p;
      const port = srv.address().port;
      return kind === 'EPSV' ? `229 Entering Extended Passive Mode (|||${port}|)`
        : `227 Entering Passive Mode (127,0,0,1,${port >> 8},${port & 255})`;
    };

    const barred = (v) => (o.noEnter || []).some(d => v === d || v.startsWith(d + '/'));
    const statOf = (full) => { try { return fs.statSync(full); } catch (_) { return null; } };
    const mlLine = (name, st) =>
      `type=${st.isDirectory() ? 'dir' : 'file'};size=${st.size};modify=${mlTime(st.mtimeMs)};perm=${st.isDirectory() ? 'cdeflmp' : 'rwadf'}; ${name}`;
    const listLine = (name, st) =>
      `${st.isDirectory() ? 'd' : '-'}rw-r--r-- 1 u g ${String(st.size).padStart(10)} ${listTime(st.mtimeMs)} ${name}`;

    const handle = async (line) => {
      const sp = line.indexOf(' ');
      const cmd = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
      const arg = sp < 0 ? '' : line.slice(sp + 1);
      log.push(cmd === 'PASS' ? 'PASS ***' : line);
      if (cmd === 'USER') { user = arg; return reply('331 password please'); }
      if (cmd === 'PASS') {
        if (user === o.user && arg === o.pass) { authed = true; return reply('230 ok'); }
        return reply('530 Login incorrect.');
      }
      if (cmd === 'AUTH') {
        if (!o.tls || o.implicit) return reply('502 no TLS');
        send('234 go ahead');
        sock = new tls.TLSSocket(sock0, { isServer: true, secureContext: ctx });
        sock.on('error', () => {});
        sock.on('data', onData);
        secure = true;
        return;
      }
      if (cmd === 'PBSZ') return reply('200 ok');
      if (cmd === 'PROT') { prot = arg.toUpperCase() === 'P' ? 'P' : 'C'; return reply('200 ok'); }
      if (cmd === 'OPTS') return reply('200 ok');
      if (cmd === 'FEAT') {
        const f = ['UTF8', 'SIZE', 'MDTM', 'REST STREAM', 'EPSV'];
        if (o.mlsd) f.push('MLST type*;size*;modify*;');
        if (o.mfmt) f.push('MFMT');
        if (o.hash) f.push('HASH SHA-256*;SHA-1;MD5');
        return reply('211-Features:\r\n ' + f.join('\r\n ') + '\r\n211 End');
      }
      if (cmd === 'SYST') return reply('215 UNIX Type: L8');
      if (cmd === 'NOOP') return reply('200 ok');
      if (cmd === 'QUIT') { reply('221 bye'); return setTimeout(() => { try { sock.end(); } catch (_) {} }, 20); }
      if (!authed) return reply('530 Please log in.');
      if (cmd === 'TYPE') return reply('200 ok');
      if (cmd === 'PWD') return reply(`257 "${cwd}"`);
      if (cmd === 'CWD' || cmd === 'CDUP') {
        const r = real(cwd, cmd === 'CDUP' ? '..' : arg);
        const st = r && statOf(r.full);
        if (st && st.isDirectory() && !barred(r.virt)) { cwd = r.virt; return reply('250 ok'); }
        return reply('550 No such directory.');
      }
      if (cmd === 'EPSV' || cmd === 'PASV') return reply(await openPasv(cmd));
      if (cmd === 'MLST') {
        if (!o.mlsd) return reply('500 unknown');
        const r = real(cwd, arg || '.');
        const st = r && statOf(r.full);
        if (!st || (barred(r.virt) && r.virt !== (o.noEnter || []).find(d => d === r.virt))) return reply('550 not found');
        return reply(`250-Listing ${arg}\r\n ${mlLine(path.posix.basename(r.virt) || '/', st)}\r\n250 End`);
      }
      if (cmd === 'SIZE') {
        const r = real(cwd, arg); const st = r && statOf(r.full);
        if (!st || st.isDirectory()) return reply('550 Could not get file size.');
        return reply(`213 ${st.size}`);
      }
      if (cmd === 'MDTM') {
        const r = real(cwd, arg); const st = r && statOf(r.full);
        if (!st) return reply('550 not found');
        return reply(`213 ${mlTime(st.mtimeMs)}`);
      }
      if (cmd === 'MFMT') {
        if (!o.mfmt) return reply('500 unknown');
        const [t, ...rest] = arg.split(' ');
        const r = real(cwd, rest.join(' ')); const st = r && statOf(r.full);
        if (!st) return reply('550 not found');
        const ms = parseMl(t);
        fs.utimesSync(r.full, ms / 1000, ms / 1000);
        return reply(`213 Modify=${t}; ${rest.join(' ')}`);
      }
      if (cmd === 'HASH') {
        if (!o.hash) return reply('500 unknown');
        const r = real(cwd, arg); const st = r && statOf(r.full);
        if (!st || st.isDirectory()) return reply('550 not a file');
        const h = crypto.createHash('sha256').update(fs.readFileSync(r.full)).digest('hex');
        return reply(`213 SHA-256 0-${st.size} ${h} ${arg}`);
      }
      if (cmd === 'MLSD' || cmd === 'LIST' || cmd === 'NLST') {
        if (cmd === 'MLSD' && !o.mlsd) return reply('500 unknown');
        const a = arg.startsWith('-') ? '' : arg;
        const r = real(cwd, a || '.');
        const st = r && statOf(r.full);
        if (!st || !st.isDirectory()) { closeData(); return reply('550 no such directory'); }
        let ds;
        try { ds = await dataSocket(); } catch (_) { return reply('425 no data connection'); }
        send('150 here it comes');
        const names = fs.readdirSync(r.full);
        const lines = [];
        for (const n of names) {
          const s2 = statOf(path.join(r.full, n));
          if (!s2) continue;
          lines.push(cmd === 'MLSD' ? mlLine(n, s2) : cmd === 'NLST' ? n : listLine(n, s2));
        }
        ds.end(lines.join('\r\n') + (lines.length ? '\r\n' : ''));
        closeData();
        return reply('226 done');
      }
      if (cmd === 'RETR') {
        const r = real(cwd, arg); const st = r && statOf(r.full);
        if (!st || st.isDirectory()) { closeData(); return reply('550 not a file'); }
        const at = restAt; restAt = 0;
        let ds;
        try { ds = await dataSocket(); } catch (_) { return reply('425 no data connection'); }
        send('150 sending');
        const rs = fs.createReadStream(r.full, { start: at });
        rs.pipe(ds);
        ds.once('close', () => closeData());
        rs.once('end', () => reply('226 done'));
        return;
      }
      if (cmd === 'REST') { restAt = Number(arg) || 0; return reply('350 ok'); }
      if (cmd === 'STOR' || cmd === 'APPE') {
        const r = real(cwd, arg);
        if (!r || o.readOnly) { closeData(); return reply('550 Permission denied.'); }
        const dirSt = statOf(path.dirname(r.full));
        if (!dirSt || !dirSt.isDirectory()) { closeData(); return reply('550 no such directory'); }
        let ds;
        try { ds = await dataSocket(); } catch (_) { return reply('425 no data connection'); }
        send('150 go on');
        const ws = fs.createWriteStream(r.full, { flags: cmd === 'APPE' ? 'a' : 'w' });
        let failed = false;
        ws.on('error', () => { failed = true; reply('552 write failed'); });
        ds.pipe(ws);
        ws.once('close', () => { closeData(); if (!failed) reply('226 done'); });
        return;
      }
      if (cmd === 'DELE') {
        const r = real(cwd, arg); const st = r && statOf(r.full);
        if (!st || st.isDirectory()) return reply('550 not a file');
        try { fs.unlinkSync(r.full); } catch (e) { return reply('550 ' + e.code); }
        return reply('250 deleted');
      }
      if (cmd === 'MKD') {
        const r = real(cwd, arg);
        if (!r) return reply('550 no');
        try { fs.mkdirSync(r.full); } catch (e) { return reply('550 ' + e.code); }
        return reply(`257 "${r.virt}" created`);
      }
      if (cmd === 'RMD') {
        const r = real(cwd, arg);
        if (!r) return reply('550 no');
        try { fs.rmdirSync(r.full); } catch (e) { return reply('550 ' + e.code); }
        return reply('250 removed');
      }
      if (cmd === 'RNFR') {
        const r = real(cwd, arg);
        if (!r || !statOf(r.full)) return reply('550 not found');
        rnfr = r.full; return reply('350 ready');
      }
      if (cmd === 'RNTO') {
        const r = real(cwd, arg);
        if (!r || !rnfr) return reply('503 RNFR first');
        if (o.strictRename && statOf(r.full)) { rnfr = null; return reply('550 target exists'); }
        try { fs.renameSync(rnfr, r.full); } catch (e) { rnfr = null; return reply('550 ' + e.code); }
        rnfr = null; return reply('250 renamed');
      }
      return reply('502 not implemented');
    };

    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (line) handle(line).catch(e => reply('451 ' + (e && e.message)));
      }
    };
    sock.on('data', onData);
  };

  const ctx = o.tls ? tls.createSecureContext({ key: o.tls.key, cert: o.tls.cert }) : null;
  const server = o.implicit && o.tls
    ? tls.createServer({ key: o.tls.key, cert: o.tls.cert }, s => { s.on('error', () => {}); onConnection(s); })
    : net.createServer(onConnection);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port || 0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port, host: '127.0.0.1', user: o.user, pass: o.pass, root, state, log,
        fingerprint: o.tls ? 'SHA256:' + new crypto.X509Certificate(o.tls.cert).fingerprint256 : null,
        close() { return new Promise(r => { server.close(() => r()); setTimeout(r, 500); }); },
      });
    });
  });
}

module.exports = { startFtpServer, makeCert };
