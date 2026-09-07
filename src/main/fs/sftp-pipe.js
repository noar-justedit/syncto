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

const { Readable, Writable } = require('stream');

// Writes to a remote file with many requests outstanding.
//
// The trick is where the callback is called: Node hands us the next chunk as
// soon as we call cb(), so calling it when the write has been ISSUED (rather
// than acknowledged) is what fills the pipe. The count of outstanding writes is
// what we throttle on instead.
class PipelinedWriter extends Writable {
  constructor(owner, remotePath, opts) {
    const o = opts || {};
    super({ highWaterMark: XFER_CHUNK * 4 });
    this.owner = owner;
    this.remotePath = remotePath;
    this.chunkSize = o.chunkSize || XFER_CHUNK;
    this.limit = o.concurrency || XFER_CONCURRENCY;
    this.handle = null;
    this.pos = 0;
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
    sftp.open(this.remotePath, 'w', (err, handle) => {
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
    super({ highWaterMark: XFER_CHUNK * 8 });
    this.owner = owner;
    this.remotePath = remotePath;
    this.chunkSize = o.chunkSize || XFER_CHUNK;
    this.limit = o.concurrency || XFER_CONCURRENCY;
    this.handle = null;
    this.reqPos = 0;         // offset of the next request to issue
    this.nextSeq = 0;        // sequence number of the next request
    this.wantSeq = 0;        // sequence number the consumer is waiting for
    this.pending = new Map();// seq -> buffer, waiting its turn
    this.inflight = 0;
    this.eofSeq = Infinity;  // sequence at which the file ended
    this.failure = null;
    this.flowing = false;
  }

  _open(cb) {
    if (this.handle) return cb();
    const sftp = this.owner.sftp;
    if (this.owner.dead) return cb(this.owner.dead);
    if (!sftp) return cb(new Error('The SFTP connection is not open.'));
    sftp.open(this.remotePath, 'r', (err, handle) => {
      if (err) return cb(err);
      this.handle = handle;
      cb();
    });
  }

  _issue() {
    const seq = this.nextSeq++;
    const at = this.reqPos;
    this.reqPos += this.chunkSize;
    this.inflight++;
    const buf = Buffer.allocUnsafe(this.chunkSize);
    this.owner.sftp.read(this.handle, buf, 0, this.chunkSize, at, (err, read) => {
      this.inflight--;
      if (err) {
        // EOF is reported as an error by ssh2; anything else is real.
        if (/EOF/i.test(err.message || '') || err.code === 1) this.eofSeq = Math.min(this.eofSeq, seq);
        else if (!this.failure) this.failure = err;
      } else if (!read) {
        this.eofSeq = Math.min(this.eofSeq, seq);
      } else {
        // A short read means the server capped this one; the file is not over.
        this.pending.set(seq, buf.slice(0, read));
        if (read < this.chunkSize) this.eofSeq = Math.min(this.eofSeq, seq + 1);
      }
      this._flush();
    });
  }

  _flush() {
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
    }
    if (this.wantSeq >= this.eofSeq && !this.inflight) {
      this._closeHandle();
      return this.push(null);
    }
    if (this.flowing) this._fill();
  }

  _fill() {
    while (this.inflight < this.limit && this.nextSeq < this.eofSeq && !this.failure) this._issue();
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
    this.pending.clear();
    this._closeHandle();
    cb(err);
  }
}

module.exports = { PipelinedReader, PipelinedWriter, XFER_CHUNK, XFER_CONCURRENCY };
