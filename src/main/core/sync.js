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
// over the target only once the whole file is written (and verified, at the
// secure and pro levels). A power cut therefore leaves a stray .syncto_tmp
// file — which the next comparison skips and the next sync cleans up — never a
// half-written file wearing the name of a good one.

const { OP, TEMP_EXT }   = require('./compare');
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
   *     copyLevel: 'fast'|'verified'|'secure'|'pro',
   *     proAlgo: 'xxh64'|'xxh128'|'md5'|'sha256',
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
    this.errors    = [];
    this.notes     = [];
    this.checksums = { left: [], right: [] };

    this.meter = new RateMeter();
    this.done  = { files: 0, bytes: 0, deleted: 0, folders: 0, moved: 0, errors: 0 };
    this.plan  = { files: 0, bytes: 0, deletions: 0, folders: 0, moves: 0 };
    this._lastEmit = 0;
  }

  side(which) { return which === 'left' ? this.left : this.right; }
  other(which) { return which === 'left' ? 'right' : 'left'; }

  abs(which, rel) {
    const s = this.side(which);
    return rel ? s.fs.join(s.path, ...rel.split('/')) : s.path;
  }

  emit(force, current) {
    const t = now();
    if (!force && t - this._lastEmit < 120) return;
    this._lastEmit = t;
    const remainingBytes = Math.max(0, this.plan.bytes - this.done.bytes);
    const bps = this.meter.bytesPerSec;
    this.onProgress({
      phase: 'sync',
      current: current || this.current || '',
      filesDone: this.done.files, filesTotal: this.plan.files,
      bytesDone: this.done.bytes, bytesTotal: this.plan.bytes,
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
          moves.push({ n, side: 'left',  fromRel: this.nodes[n.movePair].rel });
          break;
        case OP.MOVE_RIGHT_TO:
          moves.push({ n, side: 'right', fromRel: this.nodes[n.movePair].rel });
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
  async dispose(side, rel, isFolder) {
    const fsx  = this.side(side).fs;
    const path = this.abs(side, rel);
    const mode = this.cfg.deletion || 'recycler';

    if (mode === 'versioning') {
      const v = this.versionerFor(side);
      if (v) {
        if (isFolder) { await fsx.rmdir(path); return 'removed'; }
        await v.archive(fsx, path, rel);
        return 'versioned';
      }
      // No revision folder configured: refuse rather than delete silently.
      throw new Error('Versioning is selected but no revision folder is set for the ' + side + ' side.');
    }

    if (mode === 'recycler') {
      if (fsx.supportsTrash() && this.trashItem) {
        const ok = await this.trashItem(fsx, path);
        if (ok) return 'trashed';
      }
      // SFTP and most network shares have no trash.
      if (!this.cfg.permanentFallback) {
        throw new Error('This location has no recycle bin. Choose permanent deletion or versioning.');
      }
    }

    if (isFolder) await fsx.rmdir(path);
    else          await fsx.unlink(path);
    return 'deleted';
  }

  // ── Copy one file ────────────────────────────────────────────────────────
  async copyOne(item) {
    const { n, to, from } = item;
    const srcFs = this.side(from).fs, dstFs = this.side(to).fs;
    const src   = this.abs(from, n.rel);
    const dst   = this.abs(to,   n.rel);
    const level = this.cfg.copyLevel || 'verified';
    const algo  = algoFor(level, this.cfg.proAlgo);
    const failSafe = this.cfg.failSafe !== false;
    const tmp = failSafe ? dst + TEMP_EXT : dst;

    this.current = n.rel;
    this.emit(true);

    const srcStat = await srcFs.stat(src);
    if (!srcStat) throw new Error('Source vanished before it could be copied.');

    // Symlinks are recreated, not followed.
    if (n.type === 'symlink') {
      const target = await srcFs.readlink(src);
      if (await dstFs.exists(dst)) await this.archiveExisting(to, n.rel);
      await dstFs.symlink(target, dst);
      return { bytes: 0, hash: null, mtime: srcStat.mtime, size: 0 };
    }

    await dstFs.mkdir(dstFs.dirname(dst));

    // An existing target is put aside before being replaced, so "overwrite"
    // never means "lose the previous version" when versioning is on.
    if (!failSafe && await dstFs.exists(dst)) await this.archiveExisting(to, n.rel);

    const hasher = algo ? await createHasher(algo) : null;
    let copied;
    try {
      copied = await copyStream(srcFs, src, dstFs, tmp, hasher,
        b => { this.done.bytes += b; this.meter.add(b); this.emit(false); }, this.token);
    } catch (err) {
      try { if (failSafe) await dstFs.unlink(tmp); } catch (_) {}
      throw err;
    }

    // Level 'verified': the cheap check — did everything land?
    if (level === 'verified' || level === 'fast') {
      const st = await dstFs.stat(tmp);
      if (level === 'verified' && (!st || st.size !== srcStat.size)) {
        try { if (failSafe) await dstFs.unlink(tmp); } catch (_) {}
        throw new Error(`Size mismatch after copy (${st ? st.size : 0} vs ${srcStat.size}).`);
      }
    }

    // Levels 'secure' and 'pro': read the target back and compare fingerprints.
    if (algo) {
      await dstFs.flush(tmp);
      this.current = 'Verifying ' + n.rel;
      this.emit(true);
      const verifier = await createHasher(algo);
      const back = await hashStream(dstFs, tmp, verifier,
        b => { this.verifyBytes = (this.verifyBytes || 0) + b; this.emit(false); }, this.token);
      if (back !== copied.digest) {
        try { if (failSafe) await dstFs.unlink(tmp); } catch (_) {}
        throw new Error(`Checksum mismatch after copy (${algo}).`);
      }
    }

    if (failSafe) {
      if (await dstFs.exists(dst)) await this.archiveExisting(to, n.rel);
      await dstFs.rename(tmp, dst);
    }

    if (this.cfg.preserveTimes !== false) {
      try { await dstFs.setMTime(dst, srcStat.mtime); } catch (_) {}
    }
    if (this.cfg.copyPermissions && srcStat.mode != null) {
      try { await dstFs.chmod(dst, srcStat.mode & 0o7777); } catch (_) {}
    }

    // PRO always collects fingerprints for its sidecar — that is what the mode
    // is for. At the secure level the sidecar is opt-in via the settings.
    if (algo && (this.cfg.writeChecksumList || level === 'pro')) {
      this.checksums[to].push({ rel: n.rel, hash: copied.digest, size: srcStat.size });
    }

    // The new copy's file id feeds the database, so a later rename of this
    // very file can be recognized as a move instead of re-copied.
    let dstId = null;
    try { const st = await dstFs.stat(dst); if (st) dstId = st.id; } catch (_) {}

    return {
      bytes: copied.bytes, hash: copied.digest, algo,
      mtime: srcStat.mtime, size: srcStat.size,
      srcId: srcStat.id || null, dstId,
    };
  }

  // ── Execute one detected move ────────────────────────────────────────────
  // The data never travels: the side that still holds the file at its old path
  // renames it to the new one. If the rename fails (some network filesystems
  // refuse cross-directory renames), fall back to a LOCAL copy + delete on
  // that same side — still no transfer between left and right.
  async moveOne(item) {
    const { n, side, fromRel } = item;
    const fsx  = this.side(side).fs;
    const from = this.abs(side, fromRel);
    const to   = this.abs(side, n.rel);

    this.current = `${fromRel} → ${n.rel}`;
    this.emit(true);

    const st = await fsx.stat(from);
    if (!st) throw new Error('The file to move vanished before it could be renamed.');

    await fsx.mkdir(fsx.dirname(to));
    try {
      await fsx.rename(from, to);
    } catch (_) {
      await streamCopy(fsx, from, fsx, to);
      try { await fsx.setMTime(to, st.mtime); } catch (_) {}
      await fsx.unlink(from);
    }

    let newId = null;
    try { const st2 = await fsx.stat(to); if (st2) newId = st2.id; } catch (_) {}
    return { mtime: st.mtime, size: st.size, newId };
  }

  // Moves the file about to be replaced into the revision store / trash.
  async archiveExisting(side, rel) {
    const mode = this.cfg.deletion || 'recycler';
    if (mode === 'permanent') return;
    const fsx = this.side(side).fs;
    const p = this.abs(side, rel);
    if (!(await fsx.exists(p))) return;
    if (mode === 'versioning') {
      const v = this.versionerFor(side);
      if (v) { await v.archive(fsx, p, rel); return; }
      return;
    }
    if (mode === 'recycler' && fsx.supportsTrash() && this.trashItem) {
      await this.trashItem(fsx, p);
    }
  }

  // ── Main loop ────────────────────────────────────────────────────────────
  async run() {
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
        if (/cancelled/i.test(err.message || '')) break;
      }
      this.emit(false);
    }

    // 1. delete files
    for (const { n, side } of plan.del) {
      await this.gate();
      this.current = n.rel;
      try {
        const how = await this.withRetry(n.rel, () => this.dispose(side, n.rel, false));
        this.done.deleted++;
        this.record(n, true, { side, how, deleted: true });
        this.applied.set(n.rel, { ok: true, deleted: true });
      } catch (err) {
        this.record(n, false, { side, error: err.message || String(err) });
        if (!this.cfg.ignoreErrors && /cancelled/i.test(err.message || '')) break;
      }
      this.emit(false);
    }

    // 2. create folders
    for (const { n, side } of plan.mkdir) {
      await this.gate();
      this.current = n.rel;
      const fsx = this.side(side).fs;
      try {
        await this.withRetry(n.rel, () => fsx.mkdir(this.abs(side, n.rel)));
        const src = this.other(side);
        if (this.cfg.preserveTimes !== false && n[src].exists) {
          try { await fsx.setMTime(this.abs(side, n.rel), n[src].mtime); } catch (_) {}
        }
        this.done.folders++;
        this.record(n, true, { side });
        this.applied.set(n.rel, { ok: true, mtime: n[src].mtime || 0, size: 0 });
      } catch (err) {
        this.record(n, false, { side, error: err.message || String(err) });
      }
      this.emit(false);
    }

    // 3. copy files
    for (const item of plan.copy) {
      await this.gate();
      try {
        const res = await this.withRetry(item.n.rel, () => this.copyOne(item));
        this.done.files++;
        this.record(item.n, true, {
          side: item.to, bytes: res.bytes, hash: res.hash, algo: res.algo,
        });
        this.applied.set(item.n.rel, {
          ok: true, mtime: res.mtime, size: res.size,
          idL: item.to === 'left'  ? res.dstId : res.srcId,
          idR: item.to === 'right' ? res.dstId : res.srcId,
        });
      } catch (err) {
        this.done.files++;
        this.record(item.n, false, { side: item.to, error: err.message || String(err) });
        if (/cancelled/i.test(err.message || '')) break;
      }
      this.emit(false);
    }

    // 4. delete folders, deepest first
    for (const { n, side } of plan.rmdir) {
      if (this.token.cancelled) break;
      this.current = n.rel;
      try {
        await this.dispose(side, n.rel, true);
        this.done.deleted++;
        this.record(n, true, { side, deleted: true });
        this.applied.set(n.rel, { ok: true, deleted: true });
      } catch (err) {
        this.record(n, false, { side, error: err.message || String(err) });
      }
      this.emit(false);
    }

    // Prune stale revisions once everything else is done.
    for (const side of ['left', 'right']) {
      const v = this.versionerFor(side);
      if (v) { try { await v.prune(m => this.notes.push(m)); } catch (_) {} }
    }

    this.emit(true, 'Done');
    return {
      results  : this.results,
      applied  : this.applied,
      errors   : this.errors,
      notes    : this.notes,
      checksums: this.checksums,
      counters : this.done,
      plan     : this.plan,
      cancelled: !!this.token.cancelled,
      stamp    : this.stamp,
    };
  }
}

module.exports = { SyncRunner, RateMeter, copyStream, streamCopy };
