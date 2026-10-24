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

// (0.9.1) The transfer streams of filo 0.8.1 (proto/sftp-pipe.js), itself taken from
// this file at 0.8.7: both streams can start in the middle of a file, the read
// depth follows the round trip, a reply that never comes ends the transfer.

// ── Pipelined transfer ────────────────────────────────────────────────────
// The single change that matters most on a real link.
//
// ssh2's SFTP streams issue ONE request and wait for its answer before issuing
// the next: SFTP.write() splits a large buffer and sends each piece from the
// callback of the one before it, and ReadStream._read() does the same. So the
// throughput of a transfer is not set by the bandwidth, it is set by
//
//     one chunk ÷ one round trip
//
// which is why two users measured 1.5 MB/s at 22 ms of latency and 0.3 MB/s at
// 100 ms — the same code, the same chunk, the ratio of their pings. On a LAN
// the bound is invisible, which is why it went unnoticed for so long.
//
// These two classes keep CONCURRENCY requests in flight instead of one. The
// bandwidth becomes the limit again, and the round trip stops mattering.
//
// They are deliberately NOT ssh2's fastGet/fastPut, which do pipeline: those
// take a local path and hand back a finished file, which would cost the three
// things this engine is built on — the fingerprint computed while the bytes go
// past, byte-level progress, and a pause that works inside a file.

// Safe on every server: SFTPv3 guarantees 32 KB, and asking for more from a
// server that caps lower produces short reads, which is handled but wasteful.
const XFER_CHUNK = 32 * 1024;
// 64 × 32 KB = 2 MB in flight. At 100 ms that is a 20 MB/s ceiling; beyond it
// the memory cost stops buying anything on the links this is meant for.
const XFER_CONCURRENCY = 64;
// Ceiling of the adaptive read depth, in bytes: 32 MB in flight (1024 × 32 KB
// or 128 × 254 KB), enough for ~200 MB/s at 150 ms on one connection.
const MAX_READ_BYTES = 32 * 1024 * 1024;
const MAX_READ_DEPTH = MAX_READ_BYTES / XFER_CHUNK;
const READ_STALL_MS = 60000;

const { Readable, Writable } = require('stream');
const { performance } = require('perf_hooks');

// Writes to a remote file with many requests outstanding.
//
// The trick is where the callback is called: Node hands us the next chunk as
// soon as we call cb(), so calling it when the write has been ISSUED (rather
// than acknowledged) is what fills the pipe. The count of outstanding writes is
// what we throttle on instead.
class PipelinedWriter extends Writable {
  constructor(owner, remotePath, opts) {
    const o = opts || {};
    super({ highWaterMark: Math.max(XFER_CHUNK * 4, (o.chunkSize || 0) * 2) });
    this.owner = owner;
    this.remotePath = remotePath;
    this.chunkSize = o.chunkSize || XFER_CHUNK;
    this.limit = o.concurrency || XFER_CONCURRENCY;
    this.handle = null;
    // Resuming: the bytes before `start` are already on the server.
    this.start = Math.max(0, Number(o.start) || 0);
    this.noTruncate = !!o.noTruncate;
    this.pos = this.start;
    this.inflight = 0;
    this.failure = null;
    this._resume = null;      // the cb() we are holding back
    this._drained = null;     // resolved when nothing is in flight
  }

  _open(cb) {
    if (this.handle) return cb();
    const sftp = this.owner.sftp;
    if (this.owner.dead) return cb(this.owner.dead);
    if (!sftp) return cb(new Error('The SFTP connection is not open.'));
    // 'w' truncates. A resumed upload opens the existing file for writing
    // WITHOUT truncating it ('r+'), and writes from where it stopped.
    // A segment of a file split across connections never truncates: the
    // other segments are being written into the same file at the same time.
    sftp.open(this.remotePath, this.start > 0 || this.noTruncate ? 'r+' : 'w', (err, handle) => {
      if (err) return cb(err);
      this.handle = handle;
      cb();
    });
  }

  _issue(buf) {
    this.inflight++;
    const at = this.pos;
    this.pos += buf.length;
    this.owner.sftp.write(this.handle, buf, 0, buf.length, at, err => {
      this.inflight--;
      if (err && !this.failure) this.failure = err;
      // Whoever is waiting for room, or for the last write to land.
      if (this._resume && (this.inflight < this.limit || this.failure)) {
        const go = this._resume; this._resume = null; go(this.failure);
      }
      if (!this.inflight && this._drained) { const d = this._drained; this._drained = null; d(); }
    });
  }

  _write(chunk, _enc, cb) {
    if (this.failure) return cb(this.failure);
    this._open(err => {
      if (err) return cb(err);
      let off = 0;
      const pump = () => {
        if (this.failure) return cb(this.failure);
        while (off < chunk.length && this.inflight < this.limit) {
          const end = Math.min(off + this.chunkSize, chunk.length);
          this._issue(chunk.slice(off, end));
          off = end;
        }
        if (off >= chunk.length) return cb();
        // Full: hand the callback to the next completion instead of spinning.
        this._resume = e => (e ? cb(e) : pump());
      };
      pump();
    });
  }

  _final(cb) {
    const done = () => {
      if (this.failure) return cb(this.failure);
      // A file with no bytes never reached _write, so it was never opened —
      // and an empty source produced NO FILE AT ALL on the target, silently.
      // Open it here so that zero bytes still means a file of zero bytes.
      this._open(err => {
        if (err) return cb(err);
        this.owner.sftp.close(this.handle, e => { this.handle = null; cb(e || null); });
      });
    };
    if (!this.inflight) return done();
    this._drained = done;
  }

  _destroy(err, cb) {
    this._resume = null; this._drained = null;
    if (this.handle && this.owner.sftp) {
      try { this.owner.sftp.close(this.handle, () => {}); } catch (_) {}
      this.handle = null;
    }
    cb(err);
  }
}

// Reads a remote file with many requests outstanding, and pushes the pieces
// BACK IN ORDER — the engine hashes the stream as it goes, so a chunk arriving
// out of turn would produce a fingerprint of the right bytes in the wrong
// sequence, which is the kind of error that only shows up on the day someone
// restores from it.
class PipelinedReader extends Readable {
  constructor(owner, remotePath, opts) {
    const o = opts || {};
    super({ highWaterMark: Math.max(XFER_CHUNK * 8, (o.chunkSize || 0) * 2) });
    this.owner = owner;
    this.remotePath = remotePath;
    this.chunkSize = o.chunkSize || XFER_CHUNK;
    this.limit = o.concurrency || XFER_CONCURRENCY;
    this.handle = null;
    this.reqPos = Math.max(0, Number(o.start) || 0);   // offset of the next request (resume)
    // Optional end (exclusive): a segment stops there instead of at the end
    // of the file.
    this.end = o.end != null ? Number(o.end) : Infinity;
    this.nextSeq = 0;        // sequence number of the next request
    this.wantSeq = 0;        // sequence number the consumer is waiting for
    this.pending = new Map();// seq -> buffer, waiting its turn
    this.inflight = 0;
    this.eofSeq = Infinity;  // sequence at which the file ended
    this.failure = null;
    this.flowing = false;
    // Adaptive depth (filo 0.1.0). A fixed 64 requests is 2 MB in flight,
    // which on a 150 ms link caps one file at ~13 MB/s whatever the bandwidth.
    // FileZilla grows its read depth with the round trip; so does this: every
    // second the depth is set to twice what the measured rate × round trip
    // needs, between 64 and MAX_READ_DEPTH. On a LAN it stays at 64.
    this.adaptive = !o.concurrency;
    // Start where the last transfer on this connection ended up: the next
    // segment should not climb from 64 again.
    if (this.adaptive && owner && owner._lastDepth) this.limit = owner._lastDepth;
    // The round trip used is the SHORTEST one seen lately, not the average.
    // A reply waits behind every request issued before it: with 64 requests
    // out, the average round trip is mostly that queue, and it grows with the
    // depth itself. Sized on the average, the depth asked for twice itself
    // every second, up to 1024 requests (32 MB in flight) even on a LAN, and a
    // single connection ran 2 to 3 times slower than with 64 (measured
    // 10/10/2026: 129-218 MB/s against 450-480 on the same machine). The
    // shortest reply is the link without the queue.
    this.rtt = 0;                 // shortest round trip of the current period, ms
    this.rttPrev = 0;             // of the period before (the link may change)
    this.rttAt = Date.now();
    this.winBytes = 0;
    this.winStart = Date.now();
  }

  _retune() {
    if (!this.adaptive) return;
    const now = Date.now();
    const el = now - this.winStart;
    if (el < 1000) return;
    const rate = this.winBytes / (el / 1000);          // bytes per second
    this.winBytes = 0; this.winStart = now;
    const base = Math.min(this.rtt || Infinity, this.rttPrev || Infinity);
    if (now - this.rttAt > 10000) { this.rttPrev = this.rtt; this.rtt = 0; this.rttAt = now; }
    if (base === Infinity) return;
    const need = Math.ceil((rate * (base / 1000) * 2) / this.chunkSize);
    // Grow by doubling at most (a jump to 1024 on one optimistic sample would
    // flood a fragile server), shrink straight to what is needed.
    const cap = Math.max(XFER_CONCURRENCY, Math.floor(MAX_READ_BYTES / this.chunkSize));
    const next = Math.max(XFER_CONCURRENCY, Math.min(cap, need, this.limit * 2));
    if (need >= this.limit * 0.8 || next < this.limit) this.limit = next;
    if (this.owner) this.owner._lastDepth = this.limit;
    if (this.owner && this.owner._wantWindow) this.owner._wantWindow(this.limit * this.chunkSize * 2);
  }

  _open(cb) {
    if (this.handle) return cb();
    const sftp = this.owner.sftp;
    if (this.owner.dead) return cb(this.owner.dead);
    if (!sftp) return cb(new Error('The SFTP connection is not open.'));
    // The receive window covers what is in flight, twice over, from the
    // first request: ssh2's fixed 2 MB held 64 × 254 KB back (measured on a
    // DS920+: 150 → 260 MB/s with the window and the larger requests).
    if (this.owner && this.owner._wantWindow) this.owner._wantWindow(this.limit * this.chunkSize * 2);
    sftp.open(this.remotePath, 'r', (err, handle) => {
      if (err) return cb(err);
      this.handle = handle;
      this._watch();
      cb();
    });
  }

  // A reply that never comes would hang the transfer for good: the
  // connection's keepalives still answer, so nothing else notices. One minute
  // with requests out and no reply at all ends it as a network error (retried).
  _watch() {
    this.lastReply = Date.now();
    if (this._watchTimer) return;
    this._watchTimer = setInterval(() => {
      if (this.inflight > 0 && Date.now() - this.lastReply > READ_STALL_MS) {
        this._unwatch();
        this.destroy(Object.assign(new Error('The server stopped answering.'), { network: true }));
      }
    }, 5000);
    if (this._watchTimer.unref) this._watchTimer.unref();
  }
  _unwatch() { if (this._watchTimer) { clearInterval(this._watchTimer); this._watchTimer = null; } }

  _issue() {
    const seq = this.nextSeq++;
    const at = this.reqPos;
    const size = Math.min(this.chunkSize, this.end - at);
    this.reqPos += size;
    this.inflight++;
    // The request that reaches the end of the range is the last one.
    if (this.reqPos >= this.end) this.eofSeq = Math.min(this.eofSeq, seq + 1);
    this._readChunk(seq, at, Buffer.allocUnsafe(size), 0);
  }

  // 🔴 One request, one reply — but a reply may be SHORTER than what was asked
  // for without the file being over: plenty of servers cap a single read (some
  // NAS firmwares at 16 KB). Treating that as the end of the file left a hole
  // at every chunk and ended the stream cleanly, with no error: the copy was
  // caught by the size check, the read-back was not, so perfectly good files
  // came back as "checksum mismatch" on every run. The rest of the chunk is
  // asked for instead, and only a real EOF ends it.
  _readChunk(seq, at, buf, got) {
    const want = buf.length - got;
    const t0 = performance.now();
    this.owner.sftp.read(this.handle, buf, got, want, at + got, (err, read) => {
      if (this.destroyed) return;                // stopped: late replies are dropped
      this.lastReply = Date.now();
      const dt = performance.now() - t0;
      if (!this.rtt || dt < this.rtt) this.rtt = dt;
      if (read) this.winBytes += read;
      if (err) {
        this.inflight--;
        // EOF is reported as an error by ssh2; anything else is real.
        if (/EOF/i.test(err.message || '') || err.code === 1) {
          if (got) { this.pending.set(seq, buf.slice(0, got)); this.eofSeq = Math.min(this.eofSeq, seq + 1); }
          else this.eofSeq = Math.min(this.eofSeq, seq);
        } else if (!this.failure) this.failure = err;
        return this._flush();
      }
      if (!read) {
        this.inflight--;
        if (got) { this.pending.set(seq, buf.slice(0, got)); this.eofSeq = Math.min(this.eofSeq, seq + 1); }
        else this.eofSeq = Math.min(this.eofSeq, seq);
        return this._flush();
      }
      got += read;
      if (got < buf.length) return this._readChunk(seq, at, buf, got);
      this.inflight--;
      this.pending.set(seq, buf);
      this._flush();
    });
  }

  _flush() {
    if (this.destroyed) return;
    if (this.failure) {
      const e = this.failure; this.failure = null;
      this._closeHandle();
      return this.destroy(e);
    }
    // Deliver everything that is now contiguous.
    while (this.pending.has(this.wantSeq)) {
      const buf = this.pending.get(this.wantSeq);
      this.pending.delete(this.wantSeq);
      this.wantSeq++;
      if (!this.push(buf)) this.flowing = false;
      // (0.9.4) The consumer may destroy the stream from inside push() (a
      // cancelled copy does): the handle is gone then, and going on issued a
      // read on nothing, which killed the whole SFTP connection.
      if (this.destroyed) return;
    }
    if (this.wantSeq >= this.eofSeq && !this.inflight) {
      this._unwatch();
      this._closeHandle();
      return this.push(null);
    }
    if (this.flowing) this._fill();
  }

  _fill() {
    this._retune();
    // Never further ahead of the consumer than twice the depth: a server that
    // holds back one reply and answers all the later ones cannot make the
    // waiting pieces fill the memory.
    while (!this.destroyed && this.handle && this.inflight < this.limit && this.nextSeq - this.wantSeq < this.limit * 2 && this.nextSeq < this.eofSeq && this.reqPos < this.end && !this.failure) this._issue();
  }

  _read() {
    this.flowing = true;
    if (!this.handle) {
      return this._open(err => {
        if (err) return this.destroy(err);
        this._fill();
      });
    }
    this._flush();
  }

  _closeHandle() {
    if (this.handle && this.owner.sftp) {
      try { this.owner.sftp.close(this.handle, () => {}); } catch (_) {}
    }
    this.handle = null;
  }

  _destroy(err, cb) {
    this._unwatch();
    this.pending.clear();
    this._closeHandle();
    cb(err);
  }
}

module.exports = { PipelinedReader, PipelinedWriter, XFER_CHUNK, XFER_CONCURRENCY, MAX_READ_DEPTH };
