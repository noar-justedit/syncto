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

// A real SFTP server, in this process, serving a real folder — with a
// configurable delay on every reply.
//
// It exists because the thing that had to be measured cannot be measured on a
// LAN: syncto's transfers were bounded by the number of requests in flight, and
// on a link with no latency that bound is invisible. Two users reported 1.5 and
// 0.3 MB/s from opposite ends of Europe; a server that answers 100 ms late
// reproduces that on a laptop, exactly, and lets the fix be proved rather than
// hoped for.
//
//   const srv = await startSftpServer({ root: '/tmp/x', latencyMs: 50 });
//   … connect to srv.port …
//   await srv.close();

const fs = require('fs');
const path = require('path');
const { Server, utils } = require('ssh2');

const { STATUS_CODE, OPEN_MODE } = require('ssh2').utils.sftp;

function startSftpServer(opts) {
  const root = opts.root;
  const latencyMs = opts.latencyMs || 0;
  // Some servers answer a READ with fewer bytes than were asked for, without
  // the file being over — NAS firmwares capping at 16 KB are common. A client
  // that reads a short reply as "end of file" truncates silently.
  const readCap = opts.readCap || 0;
  const user = opts.username || 'tester';
  const pass = opts.password || 'secret';

  // Generated per run: nothing here is a credential anyone could reuse.
  const key = utils.generateKeyPairSync('ed25519');

  // Every reply is delayed by the same amount, which is what a round trip is.
  const later = fn => (latencyMs ? setTimeout(fn, latencyMs) : setImmediate(fn));

  const handles = new Map();
  let nextHandle = 1;

  function resolve(p) {
    const clean = path.posix.normalize('/' + String(p || '')).replace(/^\/+/, '');
    return path.join(root, clean);
  }

  return new Promise((resolve_, reject) => {
    const srv = new Server({ hostKeys: [key.private] }, client => {
      client.on('authentication', ctx => {
        if (ctx.method === 'password' && ctx.username === user && ctx.password === pass) return ctx.accept();
        if (ctx.method === 'none') return ctx.reject(['password']);
        ctx.reject();
      });
      client.on('ready', () => {
        client.on('session', accept => {
          const session = accept();
          session.on('sftp', accept2 => {
            const sftp = accept2();

            const ok = (id) => later(() => sftp.status(id, STATUS_CODE.OK));
            const fail = (id, code) => later(() => sftp.status(id, code || STATUS_CODE.FAILURE));

            sftp.on('REALPATH', (id, p) => later(() => {
              sftp.name(id, [{ filename: '/', longname: '/', attrs: {} }]);
            }));

            sftp.on('STAT', onStat); sftp.on('LSTAT', onStat);
            function onStat(id, p) {
              later(() => {
                let st;
                try { st = fs.statSync(resolve(p)); }
                catch (_) { return sftp.status(id, STATUS_CODE.NO_SUCH_FILE); }
                sftp.attrs(id, {
                  mode: st.mode, uid: 0, gid: 0, size: st.size,
                  atime: st.atimeMs / 1000, mtime: st.mtimeMs / 1000,
                });
              });
            }

            sftp.on('FSTAT', (id, h) => {
              const e = handles.get(String(h));
              later(() => {
                if (!e) return sftp.status(id, STATUS_CODE.FAILURE);
                const st = fs.fstatSync(e.fd);
                sftp.attrs(id, { mode: st.mode, uid: 0, gid: 0, size: st.size,
                  atime: st.atimeMs / 1000, mtime: st.mtimeMs / 1000 });
              });
            });

            sftp.on('OPENDIR', (id, p) => later(() => {
              const dir = resolve(p);
              let names;
              try { names = fs.readdirSync(dir); }
              catch (_) { return sftp.status(id, STATUS_CODE.NO_SUCH_FILE); }
              const h = Buffer.from('d' + (nextHandle++));
              handles.set(String(h), { dir, names, i: 0 });
              sftp.handle(id, h);
            }));

            sftp.on('READDIR', (id, h) => later(() => {
              const e = handles.get(String(h));
              if (!e || !e.names) return sftp.status(id, STATUS_CODE.FAILURE);
              if (e.i >= e.names.length) return sftp.status(id, STATUS_CODE.EOF);
              const out = [];
              for (; e.i < e.names.length; e.i++) {
                const name = e.names[e.i];
                let st; try { st = fs.lstatSync(path.join(e.dir, name)); } catch (_) { continue; }
                out.push({
                  filename: name,
                  longname: `${st.isDirectory() ? 'd' : '-'}rw-r--r-- 1 u u ${st.size} x ${name}`,
                  attrs: { mode: st.mode, uid: 0, gid: 0, size: st.size,
                           atime: st.atimeMs / 1000, mtime: st.mtimeMs / 1000 },
                });
              }
              sftp.name(id, out);
            }));

            sftp.on('OPEN', (id, p, flags) => later(() => {
              const file = resolve(p);
              let mode = 'r';
              if (flags & OPEN_MODE.WRITE) {
                if (flags & OPEN_MODE.EXCL) mode = 'wx';
                else if (flags & OPEN_MODE.APPEND) mode = 'a';
                else mode = 'w';
              }
              let fd;
              try { fd = fs.openSync(file, mode); }
              catch (err) {
                return sftp.status(id, err.code === 'EEXIST' ? STATUS_CODE.FAILURE
                  : err.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE);
              }
              const h = Buffer.from('f' + (nextHandle++));
              handles.set(String(h), { fd, file });
              sftp.handle(id, h);
            }));

            sftp.on('READ', (id, h, offset, len) => later(() => {
              const e = handles.get(String(h));
              if (!e || e.fd == null) return sftp.status(id, STATUS_CODE.FAILURE);
              const buf = Buffer.alloc(len);
              let n = 0;
              const ask = readCap ? Math.min(len, readCap) : len;
              try { n = fs.readSync(e.fd, buf, 0, ask, offset); } catch (_) { n = 0; }
              if (n <= 0) return sftp.status(id, STATUS_CODE.EOF);
              sftp.data(id, buf.slice(0, n));
            }));

            sftp.on('WRITE', (id, h, offset, data) => later(() => {
              const e = handles.get(String(h));
              if (!e || e.fd == null) return sftp.status(id, STATUS_CODE.FAILURE);
              try { fs.writeSync(e.fd, data, 0, data.length, offset); }
              catch (_) { return sftp.status(id, STATUS_CODE.FAILURE); }
              sftp.status(id, STATUS_CODE.OK);
            }));

            sftp.on('CLOSE', (id, h) => {
              const e = handles.get(String(h));
              handles.delete(String(h));
              if (e && e.fd != null) { try { fs.closeSync(e.fd); } catch (_) {} }
              ok(id);
            });

            sftp.on('REMOVE', (id, p) => later(() => {
              try { fs.unlinkSync(resolve(p)); sftp.status(id, STATUS_CODE.OK); }
              catch (_) { sftp.status(id, STATUS_CODE.FAILURE); }
            }));
            sftp.on('MKDIR', (id, p) => later(() => {
              try { fs.mkdirSync(resolve(p)); sftp.status(id, STATUS_CODE.OK); }
              catch (_) { sftp.status(id, STATUS_CODE.FAILURE); }
            }));
            sftp.on('RMDIR', (id, p) => later(() => {
              try { fs.rmdirSync(resolve(p)); sftp.status(id, STATUS_CODE.OK); }
              catch (_) { sftp.status(id, STATUS_CODE.FAILURE); }
            }));
            sftp.on('RENAME', (id, from, to) => later(() => {
              try {
                if (fs.existsSync(resolve(to))) return sftp.status(id, STATUS_CODE.FAILURE);
                fs.renameSync(resolve(from), resolve(to));
                sftp.status(id, STATUS_CODE.OK);
              } catch (_) { sftp.status(id, STATUS_CODE.FAILURE); }
            }));
            sftp.on('SETSTAT', (id) => ok(id));
            sftp.on('FSETSTAT', (id) => ok(id));
          });
        });
      });
      client.on('error', () => {});
    });

    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      resolve_({
        port: srv.address().port,
        host: '127.0.0.1',
        username: user,
        password: pass,
        latencyMs,
        close: () => new Promise(r => { try { srv.close(r); } catch (_) { r(); } }),
      });
    });
  });
}

module.exports = { startSftpServer };
