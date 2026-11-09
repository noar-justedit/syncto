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

'use strict';

// Remote control: a small HTTP server so Bitfocus Companion (or anything that
// speaks HTTP) can start a saved job, stop it and follow it. Off by default.
//
// What it can do is deliberately narrow:
//  - run a job that was saved in syncto (by its id), never paths it is sent;
//  - stop, pause, resume what is running;
//  - read the state, the progress and the last result.
// Every request carries the key shown in Settings ("Authorization: Bearer
// <key>" or "X-Syncto-Key: <key>"). A web page cannot send that header to
// another address without a CORS answer, which this server never gives, so a
// page open in a browser cannot drive syncto either.
//
// The server knows nothing of Electron: main.js hands it functions, and the
// tests run it on its own.

const http = require('http');
const crypto = require('crypto');

const DEFAULT_PORT = 7531;
const MAX_URL = 2048;

function newKey() { return crypto.randomBytes(18).toString('base64url'); }

// The id a job is known by from outside: short, stable, derived from its file.
function jobId(file) { return crypto.createHash('sha1').update(String(file)).digest('hex').slice(0, 10); }

function sameKey(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

// api = {
//   key(),                 the current key
//   status(),              { state, ... } as sent to the client
//   jobs(),                [{ id, name, file }]
//   run(file, action),     Promise<{ ok, error? }>   action: 'compare' | 'sync'
//   stop(), pause(), resume(),
// }
// opts = { port, lan, onError }
function createRemoteServer(api, opts) {
  const o = opts || {};
  const listeners = new Set();     // the open event streams

  const reply = (res, code, body) => {
    const data = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
  };

  const handle = async (req, res) => {
    if (!req.url || req.url.length > MAX_URL) return reply(res, 414, { ok: false, error: 'Request too long.' });
    const given = (req.headers['x-syncto-key'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')).trim();
    if (!sameKey(given, api.key())) return reply(res, 401, { ok: false, error: 'Wrong or missing key (Settings › Remote control in syncto).' });
    const url = new URL(req.url, 'http://syncto');
    const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
    if (parts[0] !== 'api') return reply(res, 404, { ok: false, error: 'Unknown address.' });
    const route = parts.slice(1);

    if (req.method === 'GET' && route.length === 1 && route[0] === 'status') return reply(res, 200, Object.assign({ ok: true }, api.status()));
    if (req.method === 'GET' && route.length === 1 && route[0] === 'jobs') {
      return reply(res, 200, { ok: true, jobs: api.jobs().map(j => ({ id: j.id, name: j.name })) });
    }
    if (req.method === 'GET' && route.length === 1 && route[0] === 'events') {
      // Server-sent events: the state at once, then every change.
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(api.status())}\n\n`);
      listeners.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => { clearInterval(ping); listeners.delete(res); });
      return;
    }
    if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'Use POST to act, GET to read.' });
    // Nothing is read from the body: everything a request needs is in its address.
    req.resume();
    if (route.length === 3 && route[0] === 'jobs' && (route[2] === 'compare' || route[2] === 'sync')) {
      const job = api.jobs().find(j => j.id === route[1]);
      if (!job) return reply(res, 404, { ok: false, error: 'No such job. Save the job in syncto, then ask for the list again.' });
      const r = await api.run(job.file, route[2]);
      return reply(res, r && r.ok ? 202 : 409, r && r.ok ? { ok: true, started: route[2], job: job.name } : { ok: false, error: (r && r.error) || 'Refused.' });
    }
    if (route.length === 1 && ['stop', 'pause', 'resume'].includes(route[0])) {
      const r = await api[route[0]]();
      return reply(res, r && r.ok ? 200 : 409, r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || 'Nothing is running.' });
    }
    return reply(res, 404, { ok: false, error: 'Unknown address.' });
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => { try { reply(res, 500, { ok: false, error: err.message || String(err) }); } catch (_) {} });
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;

  return {
    server,
    // Listens on this machine only, or on the local network as well.
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(Number.isInteger(o.port) ? o.port : DEFAULT_PORT, o.lan ? '0.0.0.0' : '127.0.0.1', () => {
          server.removeListener('error', reject);
          if (o.onError) server.on('error', o.onError);
          resolve(server.address().port);
        });
      });
    },
    // Sends the state to every open event stream.
    broadcast(status) {
      const line = `data: ${JSON.stringify(status)}\n\n`;
      for (const res of listeners) { try { res.write(line); } catch (_) {} }
    },
    close() {
      for (const res of listeners) { try { res.end(); } catch (_) {} }
      listeners.clear();
      return new Promise(resolve => server.close(() => resolve()));
    },
  };
}

module.exports = { createRemoteServer, newKey, jobId, DEFAULT_PORT };
