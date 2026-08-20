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

// The execution engine: takes a compared tree whose operations are already
// resolved and actually moves the data.
//
// Order of work — it matters:
//   1. delete files      frees space before anything is written
//   2. create folders     parents before children
//   3. copy files         creations and overwrites
//   4. delete folders     children before parents, and only if now empty
//
// Every copy is fail-safe: data goes to "<target>.syncto_tmp" and is renamed
// over the target only once the whole file is written and its size checked. A
// power cut therefore leaves a stray .syncto_tmp file, never a half-written
// file wearing the name of a good one.
//
// At the secure level the fingerprints gathered while writing are checked in a
// SECOND PASS, once every file has been copied — same order as ingesto: copy
// everything, then read everything back.

const { OP, TEMP_EXT, OLD_EXT, ALWAYS_SKIP, isSyncToInternal } = require('./compare');
const { createHasher, hashStream, algoFor } = require('./hash');
const { Versioner, runTimestamp, streamCopy } = require('./versioning');

const RETRY_DEFAULT_DELAY = 5000;

function now() { return Date.now(); }

// ── Rolling throughput estimate ────────────────────────────────────────────
// A plain "bytes / elapsed" average is useless on a real ingest: it hides the
// stall when a card slows down. This keeps a 5-second window instead.
class RateMeter {
  constructor(windowMs = 5000) { this.windowMs = windowMs; this.samples = []; this.total = 0; }
  add(bytes) {
    const t = now();
    this.total += bytes;
    this.samples.push({ t, bytes });
    const cut = t - this.windowMs;
    while (this.samples.length && this.samples[0].t < cut) this.samples.shift();
  }
  get bytesPerSec() {
    if (this.samples.length < 2) return 0;
    const span = (this.samples[this.samples.length - 1].t - this.samples[0].t) / 1000;
    if (span <= 0) return 0;
    let sum = 0;
    for (const s of this.samples) sum += s.bytes;
    return sum / span;
  }
}

// ── Copy one file ──────────────────────────────────────────────────────────
// Reads the source once. When a hasher is supplied the source fingerprint is
// produced by the same pass, so the secure level costs one extra read (the
// verification read of the target), not two.
function copyStream(srcFs, srcPath, dstFs, dstPath, hasher, onBytes, token) {
  return new Promise((resolve, reject) => {
    if (hasher) hasher.init();
    const rs = srcFs.createReadStream(srcPath);
    const ws = dstFs.createWriteStream(dstPath);
    let bytes = 0, settled = false;

    const fail = err => {
      if (settled) return;
      settled = true;
      try { rs.destroy(); } catch (_) {}
      try { ws.destroy(); } catch (_) {}
      reject(err);
    };

    rs.on('error', fail);
    ws.on('error', fail);
    rs.on('data', chunk => {
      if (token && token.cancelled) return fail(new Error('Cancelled'));
      bytes += chunk.length;
      if (hasher) { try { hasher.update(chunk); } catch (e) { return fail(e); } }
      if (onBytes) onBytes(chunk.length);
      if (!ws.write(chunk)) { rs.pause(); ws.once('drain', () => rs.resume()); }
    });
    rs.on('end', () => ws.end());
    ws.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve({ bytes, digest: hasher ? hasher.digest() : null });
    });
  });
}

class SyncRunner {
  /*
   * ctx = {
   *   left:  { fs, path },
   *   right: { fs, path },
   *   nodes,                        // categorized, with .op resolved
   *   config: {
   *     copyLevel: 'fast'|'verified'|'secure',
   *     writeChecksumList: bool,
   *     deletion: 'permanent'|'recycler'|'versioning',
   *     versioning: { leftFolder, rightFolder, style, maxAgeDays, countMin, countMax },
   *     failSafe: bool,             // temp file then rename (default true)
   *     preserveTimes: bool,
   *     retryCount, retryDelayMs,
   *     ignoreErrors: bool,
   *   },
   *   token: { cancelled, paused },
   *   onProgress(fn),
   *   trashItem(fsx, absPath) -> Promise<bool>
   * }
   */
  constructor(ctx) {
    Object.assign(this, ctx);
    this.cfg = ctx.config || {};
    this.token = ctx.token || { cancelled: false, paused: false };
    this.onProgress = ctx.onProgress || (() => {});
    this.stamp = runTimestamp();

    this.results   = [];
    this.applied   = new Map();
    this.toVerify  = [];     // filled by the copy pass, drained by the verify pass
    this.errors    = [];
    this.notes     = [];
    this.checksums = { left: [], right: [] };

    this.meter = new RateMeter();
    this.done  = { files: 0, bytes: 0, deleted: 0, folders: 0, moved: 0, errors: 0 };
    this.plan  = { files: 0, bytes: 0, deletions: 0, folders: 0, moves: 0 };

    // At the secure level every byte written is also read back, so the real
    // work is twice the data. Counting only the writes made the ring freeze
    // during verification — the pass was invisible.
    const lvl = (this.cfg.copyLevel || 'verified');
    this.verifyFactor = lvl === 'secure' ? 2 : 1;
    this.done.workBytes = 0;      // written + read back
    this.plan.workBytes = 0;
    this.phase = 'copy';          // 'copy' | 'verify' | 'cleanup' — drives the colours
    this._lastEmit = 0;
  }

  side(which) { return which === 'left' ? this.left : this.right; }
  other(which) { return which === 'left' ? 'right' : 'left'; }

  abs(which, rel) {
    const s = this.side(which);
    return rel ? s.fs.join(s.path, ...rel.split('/')) : s.path;
  }

  // A node's path on ONE side, in that side's own spelling. `rel` is the
  // canonical NFC form used as a key everywhere; relL/relR are what the two
  // filesystems really hold. Building a destination path from the source
  // spelling is how an accented file ends up duplicated on a Linux server.
  relOn(node, side) {
    const r = side === 'left' ? node.relL : node.relR;
    return r == null ? node.rel : r;
  }

  absNode(node, side) { return this.abs(side, this.relOn(node, side)); }


  emit(force, current) {
    const t = now();
    if (!force && t - this._lastEmit < 120) return;
    this._lastEmit = t;
    const remainingBytes = Math.max(0, this.plan.workBytes - this.done.workBytes);
    const bps = this.meter.bytesPerSec;
    this.onProgress({
      phase: 'sync',
      pass : this.phase,                       // 'copy' | 'verify' | 'cleanup'
      current: current || this.current || '',
      // Attempted, not succeeded: the ring has to reach the end of the plan
      // even when some files failed, while `done.files` stays the honest
      // count of files that really landed.
      filesDone: this.done.files + (this.done.failed || 0), filesTotal: this.plan.files,
      bytesDone: this.done.workBytes, bytesTotal: this.plan.workBytes,
      copiedBytes: this.done.bytes,
      deleted: this.done.deleted, deletionsTotal: this.plan.deletions,
      foldersDone: this.done.folders, foldersTotal: this.plan.folders,
      moved: this.done.moved, movesTotal: this.plan.moves,
      errors: this.done.errors,
      bytesPerSec: bps,
      etaSec: bps > 0 ? remainingBytes / bps : null,
      paused: !!this.token.paused,
    });
  }

  async gate() {
    while (this.token.paused && !this.token.cancelled) {
      this.emit(true);
      await new Promise(r => setTimeout(r, 200));
    }
    if (this.token.cancelled) throw new Error('Cancelled');
  }

  record(node, ok, extra) {
    const r = Object.assign({ rel: node.rel, op: node.op, type: node.type, ok }, extra || {});
    this.results.push(r);
    if (!ok) { this.done.errors++; this.errors.push({ rel: node.rel, message: r.error }); }
    return r;
  }

  // Runs `fn`, retrying transient failures the configured number of times.
  async withRetry(label, fn) {
    const max = Math.max(0, Number(this.cfg.retryCount) || 0);
    const delay = Number(this.cfg.retryDelayMs) || RETRY_DEFAULT_DELAY;
    let lastErr = null;
    for (let attempt = 0; attempt <= max; attempt++) {
      if (this.token.cancelled) throw new Error('Cancelled');
      try { return await fn(); }
      catch (err) {
        lastErr = err;
        if (/cancelled/i.test(err.message || '')) throw err;
        if (attempt < max) {
          this.notes.push(`Retrying ${label} (${attempt + 1}/${max}): ${err.message}`);
          this.emit(true, `Retrying ${label}…`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    throw lastErr;
  }

  // ── Planning ─────────────────────────────────────────────────────────────
  buildPlan() {
    const del = [], mkdir = [], copy = [], rmdir = [], moves = [];
    for (const n of this.nodes) {
      switch (n.op) {
        case OP.DELETE_LEFT:  (n.type === 'folder' ? rmdir : del).push({ n, side: 'left'  }); break;
        case OP.DELETE_RIGHT: (n.type === 'folder' ? rmdir : del).push({ n, side: 'right' }); break;
        case OP.CREATE_LEFT:
        case OP.OVERWRITE_LEFT:
          if (n.type === 'folder') mkdir.push({ n, side: 'left' });
          else copy.push({ n, to: 'left', from: 'right' });
          break;
        case OP.CREATE_RIGHT:
        case OP.OVERWRITE_RIGHT:
          if (n.type === 'folder') mkdir.push({ n, side: 'right' });
          else copy.push({ n, to: 'right', from: 'left' });
          break;
        // One entry per pair, anchored on the TO node; its FROM mate is
        // resolved here so the executor never has to look it up.
        case OP.MOVE_LEFT_TO:
          moves.push({ n, side: 'left',  fromNode: this.nodes[n.movePair], fromRel: this.nodes[n.movePair].rel });
          break;
        case OP.MOVE_RIGHT_TO:
          moves.push({ n, side: 'right', fromNode: this.nodes[n.movePair], fromRel: this.nodes[n.movePair].rel });
          break;
        default: break;
      }
    }
    del.sort((a, b) => b.n.depth - a.n.depth);
    rmdir.sort((a, b) => b.n.depth - a.n.depth);
    mkdir.sort((a, b) => a.n.depth - b.n.depth);

    this.plan.files     = copy.length;
    this.plan.deletions = del.length + rmdir.length;
    this.plan.folders   = mkdir.length;
    this.plan.moves     = moves.length;
    this.plan.bytes     = copy.reduce((s, c) => s + (c.n[c.from].size || 0), 0);
    this.plan.workBytes = this.plan.bytes * this.verifyFactor;
    return { del, mkdir, copy, rmdir, moves };
  }

  // ── Versioners ───────────────────────────────────────────────────────────
  versionerFor(side) {
    if (this.cfg.deletion !== 'versioning') return null;
    if (!this._vers) this._vers = {};
    if (this._vers[side] !== undefined) return this._vers[side];
    const v = this.cfg.versioning || {};
    const root = side === 'left' ? v.leftFolder : v.rightFolder;
    if (!root) { this._vers[side] = null; return null; }
    this._vers[side] = new Versioner({
      fs: this.side(side).fs, root,
      style: v.style, stamp: this.stamp,
      maxAgeDays: v.maxAgeDays, countMin: v.countMin, countMax: v.countMax,
    });
    return this._vers[side];
  }

  // Removes an item according to the configured deletion policy.
  async dispose(side, node, isFolder) {
    const fsx  = this.side(side).fs;
    const rel  = node.rel;
    const path = this.absNode(node, side);
    const mode = this.cfg.deletion || 'recycler';

    if (mode === 'versioning') {
      const v = this.versionerFor(side);
      if (v) {
        if (isFolder) { await this.rmdirClean(fsx, path); return 'removed'; }
        await v.archive(fsx, path, rel);
        return 'versioned';
      }
      // No revision folder configured: refuse rather than delete silently.
      throw new Error('Versioning is selected but no revision folder is set for the ' + side + ' side.');
    }

    if (mode === 'recycler') {
      // A folder still holding items the hard filter hid must NOT go to the
      // trash whole — the user excluded those files precisely so syncto would
      // not touch them. rmdirClean sweeps only OS litter and lets rmdir fail
      // loudly on anything else, which is the guard the trash path skipped.
      if (isFolder) {
        await this.rmdirClean(fsx, path);
        return 'removed';
      }
      if (fsx.supportsTrash() && this.trashItem) {
        const ok = await this.trashItem(fsx, path);
        if (ok) return 'trashed';
      }
      // SFTP and most network shares have no trash.
      if (!this.cfg.permanentFallback) {
        throw new Error('This location has no recycle bin. Choose permanent deletion or versioning.');
      }
    }

    if (isFolder) await this.rmdirClean(fsx, path);
    else          await fsx.unlink(path);
    return 'deleted';
  }

  // rmdir refuses a non-empty folder — correct, except that the comparison
  // deliberately ignored OS litter (.DS_Store, Thumbs.db…) and syncto's own
  // leftovers, so a folder that LOOKED empty can still contain them. Sweep
  // exactly those before removing; anything else still makes rmdir fail loudly.
  async rmdirClean(fsx, path) {
    try {
      const entries = await fsx.readdir(path);
      for (const e of entries) {
        if (e.type === 'file' &&
            (ALWAYS_SKIP.has(e.name) || isSyncToInternal(e.name) ||
             e.name.endsWith(TEMP_EXT) || e.name.endsWith(OLD_EXT))) {
          try { await fsx.unlink(fsx.join(path, e.name)); } catch (_) {}
        }
      }
    } catch (_) { /* let rmdir report the real problem */ }
    await fsx.rmdir(path);
  }

  // ── Copy one file ────────────────────────────────────────────────────────
  async copyOne(item) {
    const { n, to, from } = item;
    const srcFs = this.side(from).fs, dstFs = this.side(to).fs;
    const src   = this.absNode(n, from);
    const dst   = this.absNode(n, to);
    const level = this.cfg.copyLevel || 'verified';
    const algo  = algoFor(level);
    const failSafe = this.cfg.failSafe !== false;
    const tmp = failSafe ? dst + TEMP_EXT : dst;

    this.current = n.rel;
    this.emit(true);

    const srcStat = await srcFs.stat(src);
    if (!srcStat) throw new Error('Source vanished before it could be copied.');

    // Symlinks are recreated, not followed.
    if (n.type === 'symlink') {
      const target = await srcFs.readlink(src);
      if (await dstFs.exists(dst)) {
        await this.archiveExisting(to, n);
        // Permanent mode archives nothing, and a full trash can fail silently:
        // the old link may still be there, and symlink() refuses to replace.
        if (await dstFs.exists(dst)) await dstFs.unlink(dst);
      }
      await dstFs.symlink(target, dst);
      // The recreated link carries today's date. Without lutimes the target
      // would look newer at every run and be recreated forever — and under
      // versioning, archived forever. Record what the link REALLY has now.
      let linkMtime = srcStat.mtime;
      if (dstFs.setLinkMTime) {
        try { await dstFs.setLinkMTime(dst, srcStat.mtime); }
        catch (_) { linkMtime = null; }
      } else {
        linkMtime = null;
      }
      if (linkMtime == null) {
        const st = await dstFs.stat(dst);
        linkMtime = st ? st.mtime : srcStat.mtime;
      }
      return {
        bytes: 0, hash: null, mtime: srcStat.mtime, size: 0,
        dstMtime: linkMtime, srcId: srcStat.id || null, dstId: null,
      };
    }

    await dstFs.mkdir(dstFs.dirname(dst));

    // An existing target is put aside before being replaced, so "overwrite"
    // never means "lose the previous version" when versioning is on.
    if (!failSafe && await dstFs.exists(dst)) await this.archiveExisting(to, n);

    const hasher = algo ? await createHasher(algo) : null;
    let copied;
    try {
      this.phase = 'copy';
      copied = await copyStream(srcFs, src, dstFs, tmp, hasher,
        b => {
          this.done.bytes += b; this.done.workBytes += b;
          this.meter.add(b); this.emit(false);
        }, this.token);
    } catch (err) {
      try { if (failSafe) await dstFs.unlink(tmp); } catch (_) {}
      throw err;
    }

    // Cheap guard, before the rename: did everything land? A truncated copy
    // therefore never takes the target's name, whatever the level.
    //
    // This now runs at the fast level too. One stat against a whole file copy
    // costs nothing, and over SFTP it is the only thing that catches a full
    // disk: ssh2 emits 'finish' before the server has acknowledged the CLOSE,
    // and a quota error arrives in that acknowledgement — after the copy has
    // been declared a success. Without this, a truncated file was renamed
    // straight over the good copy it was meant to replace.
    {
      const st = await dstFs.stat(tmp);
      if (!st || st.size !== srcStat.size) {
        try { if (failSafe) await dstFs.unlink(tmp); } catch (_) {}
        throw new Error(`Size mismatch after copy (${st ? st.size : 0} vs ${srcStat.size}).`);
      }
    }

    if (failSafe) {
      // Archive BEFORE the rename, and let a refusal abort the copy: the
      // temporary file is cleaned up and the target keeps its old content.
      if (await dstFs.exists(dst)) {
        try {
          await this.archiveExisting(to, n);
        } catch (err) {
          try { await dstFs.unlink(tmp); } catch (_) {}
          throw err;
        }
      }
      await dstFs.rename(tmp, dst);
    }

    let mtimeKept = false;
    if (this.cfg.preserveTimes !== false) {
      try { await dstFs.setMTime(dst, srcStat.mtime); mtimeKept = true; }
      catch (err) {
        this.notes.push(`Could not preserve the date of ${n.rel}: ${err.message}`);
      }
    }
    if (this.cfg.copyPermissions && srcStat.mode != null) {
      try { await dstFs.chmod(dst, srcStat.mode & 0o7777); } catch (_) {}
    }

    // At the secure level the fingerprint computed while writing is kept for the
    // verification pass, which happens once every file has been copied.
    if (algo) {
      this.toVerify.push({
        rel: n.rel, side: to, path: dst,
        digest: copied.digest, size: srcStat.size, algo,
      });
    }

    // The new copy's file id feeds the database, so a later rename of this
    // very file can be recognized as a move instead of re-copied. The same
    // stat also yields the target's REAL mtime: if preserving the date failed,
    // the database must record what is actually on disk — recording the wish
    // instead would make the next run see a spurious change and copy again.
    let dstId = null, dstMtime = srcStat.mtime;
    try {
      const st = await dstFs.stat(dst);
      // `mtimeKept` is false both when preserving the date FAILED and when it
      // was never attempted (preserveTimes off). Either way the copy carries
      // its own date, and that is what the database has to record. The extra
      // `preserveTimes !== false` test made the "off" case store the source's
      // date instead — a two-way job then saw a change on both sides at every
      // run and bounced the file back and forth for ever.
      if (st) { dstId = st.id; if (!mtimeKept) dstMtime = st.mtime; }
    } catch (_) {}

    return {
      bytes: copied.bytes, hash: copied.digest, algo,
      mtime: srcStat.mtime, size: srcStat.size, dstMtime,
      srcId: srcStat.id || null, dstId,
    };
  }

  // ── Execute one detected move ────────────────────────────────────────────
  // The data never travels: the side that still holds the file at its old path
  // renames it to the new one. If the rename fails (some network filesystems
  // refuse cross-directory renames), fall back to a LOCAL copy + delete on
  // that same side — still no transfer between left and right.
  async moveOne(item) {
    const { n, side, fromNode, fromRel } = item;
    const fsx  = this.side(side).fs;
    const from = fromNode ? this.absNode(fromNode, side) : this.abs(side, fromRel);
    const to   = this.absNode(n, side);

    this.current = `${fromRel} → ${n.rel}`;
    this.emit(true);

    const st = await fsx.stat(from);
    if (!st) throw new Error('The file to move vanished before it could be renamed.');

    await fsx.mkdir(fsx.dirname(to));
    try {
      await fsx.rename(from, to);
    } catch (_) {
      // Same fail-safe rule as any copy: never write the final name directly.
      // A power cut mid-copy must leave a stray .syncto_tmp, not a truncated
      // file wearing a good file's name.
      const tmp = to + TEMP_EXT;
      try {
        await streamCopy(fsx, from, fsx, tmp);
        await fsx.rename(tmp, to);
      } catch (err) {
        try { await fsx.unlink(tmp); } catch (_) {}
        throw err;
      }
      try { await fsx.setMTime(to, st.mtime); } catch (_) {}
      await fsx.unlink(from);
    }

    let newId = null;
    try { const st2 = await fsx.stat(to); if (st2) newId = st2.id; } catch (_) {}
    return { mtime: st.mtime, size: st.size, newId };
  }

  // Moves the file about to be replaced into the revision store / trash.
  //
  // This throws on exactly the cases dispose() throws on. It used to `return`
  // instead — so "keep every version" with a revision folder set on one side
  // only, or a trash that refused the item, destroyed the replaced version in
  // silence while the DELETE path for the same configuration shouted. An
  // overwrite is a deletion with a copy on top; it gets the same guarantees.
  async archiveExisting(side, node) {
    const mode = this.cfg.deletion || 'recycler';
    if (mode === 'permanent') return;
    const fsx = this.side(side).fs;
    const p = this.absNode(node, side);
    if (!(await fsx.exists(p))) return;

    if (mode === 'versioning') {
      const v = this.versionerFor(side);
      if (!v) {
        throw new Error('Versioning is selected but no revision folder is set for the ' + side +
          ' side — the file about to be replaced would be lost.');
      }
      await v.archive(fsx, p, node.rel);
      return;
    }

    if (fsx.supportsTrash() && this.trashItem) {
      const ok = await this.trashItem(fsx, p);
      if (ok) return;
    }
    // No trash here (SFTP, most network shares), or the trash refused it.
    if (!this.cfg.permanentFallback) {
      throw new Error('This location has no recycle bin, so the version about to be replaced ' +
        'cannot be kept. Choose permanent deletion or versioning.');
    }
  }

  // ── Main loop ────────────────────────────────────────────────────────────
  // Cancellation must not reject: everything already done is real — files were
  // copied, files were deleted — and the caller still has to write the
  // database and the report from `applied`, or the NEXT run mistakes every
  // completed two-way copy for a fresh change. So run() always resolves; the
  // `cancelled` flag says why it stopped early.
  async run() {
    try { await this._run(); }
    catch (err) {
      if (!/cancelled/i.test(err.message || '')) throw err;
    }
    this.emit(true, this.token.cancelled ? 'Cancelled' : (this.stopped ? 'Stopped' : 'Done'));
    return {
      results  : this.results,
      applied  : this.applied,
      errors   : this.errors,
      notes    : this.notes,
      checksums: this.checksums,
      verified : this.toVerify.filter(v => v.ok).length,
      counters : this.done,
      plan     : this.plan,
      cancelled: !!this.token.cancelled,
      stopped  : !!this.stopped,
      stamp    : this.stamp,
    };
  }

  // Called from every phase after a failure. Returns true when the run must
  // stop here. Stopping is graceful, exactly like cancelling: the database and
  // the report are still written from what really happened.
  halt(err) {
    if (/cancelled/i.test((err && err.message) || '')) return true;
    if (this.cfg.ignoreErrors) return false;
    if (!this.stopped) {
      this.stopped = true;
      this.notes.push('Stopped at the first error because "ignore errors" is off. ' +
        'Nothing after this point was attempted.');
    }
    return true;
  }

  async _run() {
    const plan = this.buildPlan();
    this.emit(true, 'Preparing…');

    // 0. execute detected moves — before anything else, so nothing they touch
    //    is deleted or re-copied by the later phases
    for (const item of plan.moves) {
      await this.gate();
      try {
        const res = await this.withRetry(item.n.rel, () => this.moveOne(item));
        this.done.moved++;
        // The side that didn't rename already had the file at the new path,
        // so its id comes straight from the comparison.
        this.record(item.n, true, { side: item.side, moved: true, from: item.fromRel });
        this.applied.set(item.n.rel, {
          ok: true, mtime: res.mtime, size: res.size,
          idL: item.side === 'left'  ? res.newId : (item.n.left.id  || null),
          idR: item.side === 'right' ? res.newId : (item.n.right.id || null),
        });
        this.applied.set(item.fromRel, { ok: true, deleted: true });
      } catch (err) {
        this.record(item.n, false, { side: item.side, error: err.message || String(err) });
        if (this.halt(err)) break;
      }
      this.emit(false);
    }

    // 1. delete files
    if (!this.stopped) for (const { n, side } of plan.del) {
      await this.gate();
      this.current = n.rel;
      try {
        const how = await this.withRetry(n.rel, () => this.dispose(side, n, false));
        this.done.deleted++;
        this.record(n, true, { side, how, deleted: true });
        this.applied.set(n.rel, { ok: true, deleted: true });
      } catch (err) {
        this.record(n, false, { side, error: err.message || String(err) });
        // Cancellation stops the loop unconditionally — "ignore errors" means
        // "keep going past failures", never "keep deleting after a cancel".
        if (this.halt(err)) break;
      }
      this.emit(false);
    }

    // 2. create folders
    if (!this.stopped) for (const { n, side } of plan.mkdir) {
      await this.gate();
      this.current = n.rel;
      const fsx = this.side(side).fs;
      try {
        await this.withRetry(n.rel, () => fsx.mkdir(this.absNode(n, side)));
        const src = this.other(side);
        if (this.cfg.preserveTimes !== false && n[src].exists) {
          try { await fsx.setMTime(this.absNode(n, side), n[src].mtime); } catch (_) {}
        }
        this.done.folders++;
        this.record(n, true, { side });
        this.applied.set(n.rel, { ok: true, mtime: n[src].mtime || 0, size: 0 });
      } catch (err) {
        this.record(n, false, { side, error: err.message || String(err) });
        if (this.halt(err)) break;
      }
      this.emit(false);
    }

    // 3. copy files
    if (!this.stopped) for (const item of plan.copy) {
      await this.gate();
      try {
        const res = await this.withRetry(item.n.rel, () => this.copyOne(item));
        this.done.files++;
        this.record(item.n, true, {
          side: item.to, bytes: res.bytes, hash: res.hash, algo: res.algo,
        });
        this.applied.set(item.n.rel, {
          ok: true, mtime: res.mtime, size: res.size,
          mtimeL: item.to === 'left'  ? res.dstMtime : res.mtime,
          mtimeR: item.to === 'right' ? res.dstMtime : res.mtime,
          idL: item.to === 'left'  ? res.dstId : res.srcId,
          idR: item.to === 'right' ? res.dstId : res.srcId,
        });
      } catch (err) {
        // NOT done.files++ — that counter is what the report calls "files
        // copied" and what the progress ring advances on. Counting failures
        // there produced reports reading "Files copied: 10 / Errors: 3" with
        // the number of files that actually landed appearing nowhere.
        this.done.failed = (this.done.failed || 0) + 1;
        this.record(item.n, false, { side: item.to, error: err.message || String(err) });
        if (this.halt(err)) break;
      }
      this.emit(false);
    }

    // 4. verify — one pass over everything that was copied, exactly like
    //    ingesto: copy first, then read the whole lot back. The fingerprint of
    //    each source was captured while writing; here we re-read the file from
    //    its final location and compare.
    if (this.toVerify.length && !this.token.cancelled) {
      this.phase = 'verify';
      this.current = '';
      this.emit(true, 'Verifying…');
      for (const item of this.toVerify) {
        await this.gate();
        this.current = item.rel;
        this.emit(true);
        const fsx = this.side(item.side).fs;
        try {
          const flushed = await fsx.flush(item.path);
          if (flushed === false && !this._flushWarned) {
            this._flushWarned = true;
            this.notes.push('The write cache could not be flushed on this volume, so the ' +
              'verification read may have been served from memory rather than from the medium.');
          }
          const verifier = await createHasher(item.algo);
          const back = await hashStream(fsx, item.path, verifier,
            b => { this.done.workBytes += b; this.meter.add(b); this.emit(false); }, this.token);
          if (back !== item.digest) throw new Error(`Checksum mismatch (${item.algo}).`);
          item.ok = true;
          if (this.cfg.writeChecksumList) {
            this.checksums[item.side].push({ rel: item.rel, hash: item.digest, size: item.size });
          }
        } catch (err) {
          if (/cancelled/i.test(err.message || '')) break;
          item.ok = false;
          this.done.errors++;
          this.errors.push({ rel: item.rel, message: err.message || String(err) });
          // The file already carries its final name, so the database must NOT
          // record it as synchronized — the next run has to look at it again.
          this.applied.delete(item.rel);
          const res = this.results.find(r => r.rel === item.rel && r.ok);
          if (res) { res.ok = false; res.error = err.message || String(err); }
          if (this.halt(err)) break;
        }
        this.emit(false);
      }
      // Not back to 'copy': what follows writes nothing, and the interface
      // must not flash green again as if a new file were being transferred.
      this.phase = 'cleanup';
    }

    // 5. delete folders, deepest first
    if (!this.stopped) for (const { n, side } of plan.rmdir) {
      if (this.token.cancelled) break;
      this.current = n.rel;
      try {
        await this.dispose(side, n, true);
        this.done.deleted++;
        this.record(n, true, { side, deleted: true });
        this.applied.set(n.rel, { ok: true, deleted: true });
      } catch (err) {
        this.record(n, false, { side, error: err.message || String(err) });
        if (this.halt(err)) break;
      }
      this.emit(false);
    }

    // 6. sweep the .syncto_tmp files a previous run left behind. They are
    //    half-written copies, never user data, and the comparison hides them —
    //    so nothing else would ever remove them. We hold the lock on both
    //    folders here, so no other machine is writing them right now.
    await this.sweepLeftovers();

    // Prune stale revisions once everything else is done.
    for (const side of ['left', 'right']) {
      const v = this.versionerFor(side);
      if (v) { try { await v.prune(m => this.notes.push(m)); } catch (_) {} }
    }
  }

  async sweepLeftovers() {
    const list = this.leftovers || [];
    if (!list.length || this.token.cancelled) return;
    let n = 0, bytes = 0;
    for (const item of list) {
      const fsx = this.side(item.side).fs;
      try { await fsx.unlink(item.path); n++; bytes += item.size || 0; }
      catch (_) { /* gone already, or not ours to remove */ }
    }
    if (n) {
      this.notes.push(`Removed ${n} leftover temporary file${n > 1 ? 's' : ''} ` +
        `(${(bytes / 1e9).toFixed(2)} GB) from an interrupted run.`);
    }
  }
}

module.exports = { SyncRunner, RateMeter, copyStream, streamCopy };
