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

// Holds one comparison in memory and drives it through to synchronization.
// The renderer never receives the whole tree: it asks for windows of rows and
// sends back edits by index. That keeps a 200 000-file comparison responsive.

const { Comparer, CAT, OP, CHECKSUM_FILE } = require('./compare');
const { PathFilter } = require('./filter');
const { applyDirections, computeStats, operationFor, applyFolderRules,
        detectMoves, dissolveMove, usesDatabase } = require('./direction');
const { loadPairDb, savePairDb, buildSession, pairIdFor } = require('./db');
const { SyncRunner } = require('./sync');
const { FsPool, parseLocation } = require('../fs/afs');
const { buildReport, toHtml, toCsv, toJson } = require('./report');
const { formatChecksumList, parseChecksumList, createHasher, hashStream } = require('./hash');
const { acquireAll } = require('./lock');

class Session {
  constructor() {
    this.pool   = new FsPool();
    this.nodes  = [];
    this.stats  = null;
    this.errors = [];
    this.job    = null;
    this.left   = null;
    this.right  = null;
    this.db     = null;
    this.dbNote = null;
    this.byChange = false;
    this.comparedAt = 0;
  }

  async _openSides(job, credentials) {
    const l = parseLocation(job.left,  credentials);
    const r = parseLocation(job.right, credentials);
    if (!l.path || !r.path) throw new Error('Both folders must be set.');
    this.left  = await this.pool.open(l);
    this.right = await this.pool.open(r);
    this.leftPhrase  = l.phrase;
    this.rightPhrase = r.phrase;
  }

  // ── Compare ──────────────────────────────────────────────────────────────
  async compare(job, opts) {
    const { onProgress, token, credentials } = opts || {};
    this.job = job;
    await this._openSides(job, credentials);

    const cmp = Object.assign({}, job.compare);
    const comparer = new Comparer({
      left: this.left, right: this.right,
      config: cmp, token, onProgress,
    });
    const res = await comparer.run();
    this.nodes  = res.nodes;
    this.errors = res.errors;

    // The database is read for two reasons: Two way and Update decide their
    // directions with it, and move detection needs the file ids it remembers.
    // A mirror job with move detection on therefore reads (and later writes)
    // the database too, even though its directions never depend on it.
    this.db = null; this.dbNote = null;
    this.pairId = pairIdFor(job.pairId, this.left.path, this.right.path);
    this.wantMoves = cmp.detectMoves !== false;
    if (usesDatabase(job.sync.variant) || this.wantMoves) {
      const { db, reason } = await loadPairDb(this.left, this.right, this.pairId);
      this.db = db;
      // "no database yet" is only worth mentioning when directions depend on it.
      this.dbNote = usesDatabase(job.sync.variant) ? reason : null;
    }

    const applied = applyDirections(this.nodes, job.sync, cmp, this.db);
    this.byChange = applied.byChange;
    this.movesFound = this.wantMoves ? detectMoves(this.nodes, this.db) : 0;
    this.stats = computeStats(this.nodes);
    this.comparedAt = Date.now();

    return {
      count : this.nodes.length,
      stats : this.stats,
      errors: this.errors,
      byChange: this.byChange,
      dbNote: this.dbNote,
      movesFound: this.movesFound,
      pairId: this.pairId,
      left  : this.left.path,
      right : this.right.path,
    };
  }

  // ── Grid access ──────────────────────────────────────────────────────────
  // view: { showEqual, showExcluded, search, onlyCategory, onlyOperation }
  _visibleIndices(view) {
    const v = view || {};
    const needle = (v.search || '').trim().toLowerCase();
    const out = [];
    for (const n of this.nodes) {
      if (!v.showEqual && n.op === OP.NONE) continue;
      if (!v.showExcluded && !n.active) continue;
      if (v.onlyCategory && n.cat !== v.onlyCategory) continue;
      if (v.onlyOperation && n.op !== v.onlyOperation) continue;
      if (needle && !n.rel.toLowerCase().includes(needle)) continue;
      out.push(n.idx);
    }
    return out;
  }

  rows(offset, limit, view) {
    const idx = this._visibleIndices(view);
    const slice = idx.slice(offset || 0, (offset || 0) + (limit || 200));
    return {
      total: idx.length,
      rows : slice.map(i => this._row(this.nodes[i])),
    };
  }

  _row(n) {
    return {
      idx: n.idx, rel: n.rel, name: n.name, type: n.type, depth: n.depth,
      cat: n.cat, catMsg: n.catMsg, dir: n.dir, op: n.op, active: n.active,
      mv: n.movePair != null ? (this.nodes[n.movePair] ? this.nodes[n.movePair].rel : null) : null,
      l: n.left.exists  ? { size: n.left.size,  mtime: n.left.mtime  } : null,
      r: n.right.exists ? { size: n.right.size, mtime: n.right.mtime } : null,
    };
  }

  // ── Manual edits ─────────────────────────────────────────────────────────
  setDirection(indices, dir) {
    for (const i of indices) {
      const n = this.nodes[i];
      if (!n) continue;
      // Overriding one half of a move pair dissolves the pair: both rows fall
      // back to their plain copy/delete, then the requested direction applies.
      if (n.movePair != null) dissolveMove(this.nodes, n);
      n.dir = dir;
      n.op  = operationFor(n);
    }
    applyFolderRules(this.nodes);
    this.stats = computeStats(this.nodes);
    return this.stats;
  }

  // Excluding a folder excludes everything inside it — the whole subtree is
  // expanded here so the grid, the overview and the Space shortcut all agree.
  _expand(indices) {
    const out = new Set();
    for (const i of indices) {
      const n = this.nodes[i];
      if (!n) continue;
      out.add(n.idx);
      if (n.type === 'folder') {
        const prefix = n.rel + '/';
        for (const d of this.nodes) if (d.rel.startsWith(prefix)) out.add(d.idx);
      }
    }
    return [...out];
  }

  setActive(indices, active) {
    for (const i of this._expand(indices)) {
      const n = this.nodes[i];
      if (n.movePair != null) dissolveMove(this.nodes, n);
      n.active = !!active;
      n.op = operationFor(n);
    }
    applyFolderRules(this.nodes);
    this.stats = computeStats(this.nodes);
    return this.stats;
  }

  // Flip based on the clicked node's current state, applied uniformly to its
  // subtree — this is what Space and "Exclude temporarily" call.
  toggleActive(indices) {
    const first = this.nodes[indices[0]];
    if (!first) return this.stats;
    return this.setActive(indices, !first.active);
  }

  // Flips every direction, e.g. to turn a mirror right into a mirror left
  // without re-running the comparison.
  invertAll() {
    for (const n of this.nodes) {
      if (n.movePair != null) dissolveMove(this.nodes, n);
    }
    for (const n of this.nodes) {
      if (n.dir === 'left') n.dir = 'right';
      else if (n.dir === 'right') n.dir = 'left';
      n.op = operationFor(n);
    }
    applyFolderRules(this.nodes);
    this.stats = computeStats(this.nodes);
    return this.stats;
  }

  visibleIndices(view) { return this._visibleIndices(view); }

  // ── Overview — one line per top-level item, like FreeFileSync's panel ────
  // Sizes count every file underneath (the larger of the two sides, so a
  // half-copied folder is not under-reported); pct is the share of the total.
  overview() {
    const groups = new Map();   // top-level rel -> { name, type, items, bytes, idx, active }
    for (const n of this.nodes) {
      const top = n.rel.includes('/') ? n.rel.slice(0, n.rel.indexOf('/')) : n.rel;
      let g = groups.get(top);
      if (!g) {
        g = { name: top, type: n.rel === top ? n.type : 'folder', items: 0, bytes: 0, idx: -1, active: true };
        groups.set(top, g);
      }
      if (n.rel !== top) g.items++;
      else if (n.type !== 'folder') g.items = 1;
      if (n.type !== 'folder') {
        g.bytes += Math.max(n.left.exists ? n.left.size || 0 : 0,
                            n.right.exists ? n.right.size || 0 : 0);
      }
      if (n.rel === top) {
        g.idx = n.idx;
        g.active = n.active;
        if (n.type === 'folder') g.type = 'folder';
      }
    }
    const rows = [...groups.values()];
    const total = rows.reduce((s, g) => s + g.bytes, 0) || 1;
    rows.forEach(g => { g.pct = Math.round((g.bytes / total) * 100); });
    rows.sort((a, b) => b.bytes - a.bytes);
    return { rows, totalBytes: total === 1 ? 0 : total };
  }

  // ── Synchronize ──────────────────────────────────────────────────────────
  // opts.skipReport: MultiSession aggregates one report across pairs itself.
  async sync(job, opts) {
    const { onProgress, token, trashItem, appVersion, defaultReportFolder, skipReport } = opts || {};
    if (!this.nodes.length && !this.comparedAt) throw new Error('Run a comparison first.');

    // A folder that could not be READ during the comparison looks empty, and
    // an empty side plus a mirror is a mass deletion. FreeFileSync stops here
    // too: no synchronization on top of a broken comparison, ever.
    const fatal = this.errors.filter(e => e.fatal);
    if (fatal.length) {
      throw new Error(`The comparison could not read ${fatal.length === 1 ? 'a folder' : fatal.length + ' folders'} ` +
        `(${fatal[0].path}: ${fatal[0].message}) — synchronizing now could delete healthy files. Fix the error and compare again.`);
    }
    const startedAt = Date.now();

    const runner = new SyncRunner({
      left: this.left, right: this.right,
      nodes: this.nodes,
      config: Object.assign({}, job.sync),
      token, onProgress, trashItem,
    });
    const run = await runner.run();
    const endedAt = Date.now();

    // Checksum sidecars, one per side that actually received data. The list is
    // MERGED with what is already there: each run only re-hashes what it
    // copied, and a sidecar reduced to today's three files would silently stop
    // vouching for the thousand verified last month.
    const sidecars = [];
    const wantList = job.sync.writeChecksumList && job.sync.copyLevel === 'secure';
    if (wantList) {
      for (const side of ['left', 'right']) {
        const list = run.checksums[side];
        if (!list.length) continue;
        const algo = 'xxh64';
        const target = this[side];
        const p = target.fs.join(target.path, CHECKSUM_FILE);
        try {
          const byRel = new Map();
          try {
            const prevText = await readText(target.fs, p);
            if (prevText != null) {
              const prev = parseChecksumList(prevText);
              if (!prev.algo || prev.algo === algo) {
                for (const e of prev.entries) byRel.set(e.rel, e);
              }
            }
          } catch (_) { /* unreadable previous list: start fresh */ }
          // Entries deleted or re-copied this run must not survive from the
          // old list with a stale hash.
          for (const [rel, res] of run.applied) if (res.deleted) byRel.delete(rel);
          for (const e of list) byRel.set(e.rel, e);
          const merged = [...byRel.values()].sort((a, b) => a.rel < b.rel ? -1 : 1);
          await writeText(target.fs, p, formatChecksumList(algo, merged, { pair: job.name, side }));
          sidecars.push(p);
        } catch (err) {
          run.notes.push(`Could not write the checksum list on the ${side} side: ${err.message}`);
        }
      }
    }

    // Update the database so the next run knows what "in sync" means — needed
    // by two-way/update for their directions, and by every variant for move
    // detection (the ids recorded now are tomorrow's rename evidence).
    let dbStamp = null;
    if (usesDatabase(job.sync.variant) || this.wantMoves) {
      try {
        const pairId = this.pairId || pairIdFor(job.pairId, this.left.path, this.right.path);
        // Entries hidden by the current hard filter keep their history.
        const pf = new PathFilter(job.compare.includeFilter, job.compare.excludeFilter);
        const keepRel = (rel, e) => (e.t === 'd' ? !pf.passFolder(rel) : !pf.passFile(rel));
        const session = buildSession(
          this.nodes, run.applied, this.db,
          job.compare.compareVariant || 'timeSize',
          this.left.path, this.right.path, keepRel);
        dbStamp = await savePairDb(this.left, this.right, pairId, session);
      } catch (err) {
        run.notes.push(`Could not write the synchronization database: ${err.message}`);
      }
    }

    // Report.
    const report = buildReport({
      appVersion,
      pairName: job.name, leftPath: this.left.path, rightPath: this.right.path,
      variant: job.sync.variant, compareVariant: job.compare.compareVariant,
      copyLevel: job.sync.copyLevel,
      deletion: job.sync.deletion, versioningStyle: job.sync.versioning.style,
      filter: { include: job.compare.includeFilter, exclude: job.compare.excludeFilter },
      startedAt, endedAt, run, stats: this.stats, comparisonErrors: this.errors,
    });

    const written = [];
    const rc = job.sync.report || {};
    if (rc.enabled && !skipReport) {
      const stamp = run.stamp.replace(/[: ]/g, '_');
      const baseName = `syncto_${(job.name || 'job').replace(/[^\w.-]+/g, '_')}_${stamp}`;
      // Reports never land inside a synchronized folder by default: the next
      // mirror run would see them as strays on the target and delete them.
      const outDir = rc.folder || defaultReportFolder || null;
      const targets = [];
      if (rc.html) targets.push([baseName + '.html', toHtml(report)]);
      if (rc.csv)  targets.push([baseName + '.csv',  toCsv(report)]);
      if (rc.json) targets.push([baseName + '.json', toJson(report)]);
      for (const [name, content] of targets) {
        try {
          if (outDir) {
            const nfs = this.pool.native;
            await nfs.mkdir(outDir);
            await writeText(nfs, nfs.join(outDir, name), content);
            written.push(nfs.join(outDir, name));
          } else {
            const t = this.right;
            const p = t.fs.join(t.path, name);
            await writeText(t.fs, p, content);
            written.push(p);
          }
        } catch (err) {
          run.notes.push(`Could not write the report ${name}: ${err.message}`);
        }
      }
    }

    this.lastResults = run.results;   // MultiSession reads these for its merged report
    return {
      counters : run.counters,
      verified : run.verified || 0,
      plan     : run.plan,
      errors   : run.errors,
      notes    : run.notes,
      cancelled: run.cancelled,
      startedAt, endedAt,
      durationMs: endedAt - startedAt,
      reportFiles: written,
      checksumFiles: sidecars,
      dbStamp,
      report,
    };
  }

  async close() { await this.pool.closeAll(); }
}

// ═══════════════════════════════════════════════════════════════════════════
// MultiSession — several folder pairs, one job, one merged view.
//
// Each pair keeps its own Session (its own tree, database, checksum sidecars).
// This layer runs them in sequence and presents ONE grid, ONE set of stats,
// ONE overview and ONE report to the outside world.
//
// Row addressing: a global index encodes (pair, node) as p*PAIR_BASE + idx, so
// the renderer keeps sending plain integers and never learns about pairs.
// The grid also receives synthetic header rows (one per pair) so the merged
// list stays readable.
// ═══════════════════════════════════════════════════════════════════════════

const PAIR_BASE = 1_000_000;   // up to a million items per pair

function mergeStats(list) {
  const out = {
    rows: 0, createLeft: 0, createRight: 0, updateLeft: 0, updateRight: 0,
    deleteLeft: 0, deleteRight: 0, moveLeft: 0, moveRight: 0,
    conflicts: 0, equal: 0, excluded: 0, doNothing: 0,
    bytesLeft: 0, bytesRight: 0, bytesTotal: 0, filesToProcess: 0,
    conflictList: [], catCounts: {},
  };
  for (const s of list) {
    if (!s) continue;
    for (const k of Object.keys(out)) {
      if (typeof out[k] === 'number') out[k] += s[k] || 0;
    }
    out.conflictList.push(...(s.conflictList || []).slice(0, 5));
    for (const c of Object.keys(s.catCounts || {})) {
      out.catCounts[c] = (out.catCounts[c] || 0) + s.catCounts[c];
    }
  }
  return out;
}

function pairLabel(p) {
  const base = s => String(s || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || s;
  return `${base(p.left)} → ${base(p.right)}`;
}

class MultiSession {
  constructor() {
    this.sessions = [];       // one Session per pair
    this.pairs = [];
    this.stats = null;
    this.comparedAt = 0;
  }

  _pairsOf(job) {
    const pairs = (Array.isArray(job.pairs) && job.pairs.length)
      ? job.pairs
      : [{ left: job.left || '', right: job.right || '' }];
    return pairs.filter(p => (p.left || '').trim() && (p.right || '').trim());
  }

  _split(gidx) {
    const p = Math.floor(gidx / PAIR_BASE);
    return { s: this.sessions[p], idx: gidx % PAIR_BASE, p };
  }

  async compare(job, opts) {
    const { onProgress, token, credentials } = opts || {};
    await this.close();
    // A failed or cancelled comparison must not leave yesterday's comparedAt
    // standing — sync() would happily run against half-compared sessions.
    this.comparedAt = 0;
    this.stats = null;
    this.pairs = this._pairsOf(job);
    if (!this.pairs.length) throw new Error('Set at least one folder pair.');
    this.sessions = this.pairs.map(() => new Session());
    const multi = this.pairs.length > 1;

    const perPair = [];
    const errors = [];
    let movesFound = 0, dbNote = null;
    for (let i = 0; i < this.pairs.length; i++) {
      if (token && token.cancelled) break;
      const pairJob = Object.assign({}, job, {
        left: this.pairs[i].left, right: this.pairs[i].right,
        // A job-level pairId predates multi-pair: shared by every pair, it
        // would make them overwrite each other's session in a shared base
        // folder. Path-derived ids are unambiguous — use them.
        pairId: multi ? null : job.pairId,
      });
      const res = await this.sessions[i].compare(pairJob, {
        token, credentials,
        onProgress: p => onProgress && onProgress(Object.assign({}, p, {
          pair: i + 1, pairs: this.pairs.length, pairLabel: pairLabel(this.pairs[i]),
        })),
      });
      perPair.push(res);
      movesFound += res.movesFound || 0;
      if (res.dbNote && !dbNote) dbNote = res.dbNote;
      errors.push(...res.errors.map(e => Object.assign({}, e, { pair: i + 1 })));
    }

    this.stats = mergeStats(this.sessions.map(s => s.stats));
    this.comparedAt = Date.now();
    return {
      count: this.sessions.reduce((n, s) => n + s.nodes.length, 0),
      stats: this.stats,
      errors,
      movesFound,
      dbNote,
      pairs: this.pairs.map((p, i) => ({ ...p, label: pairLabel(p), stats: perPair[i] && perPair[i].stats })),
      left : this.pairs[0].left,
      right: this.pairs[0].right,
    };
  }

  // One header pseudo-row per pair (only when there are several), followed by
  // that pair's visible rows carrying globalized indices.
  rows(offset, limit, view) {
    const multi = this.sessions.length > 1;
    const all = [];
    for (let p = 0; p < this.sessions.length; p++) {
      const s = this.sessions[p];
      const vis = s._visibleIndices(view);
      if (multi) all.push({ hdr: true, p });
      for (const i of vis) all.push({ p, i });
    }
    const slice = all.slice(offset || 0, (offset || 0) + (limit || 200));
    return {
      total: all.length,
      rows: slice.map(e => {
        if (e.hdr) {
          const pr = this.pairs[e.p];
          const st = this.sessions[e.p].stats || {};
          return {
            hdr: true, idx: -1,
            pair: e.p + 1, pairs: this.pairs.length,
            left: pr.left, right: pr.right, label: pairLabel(pr),
            todo: st.filesToProcess || 0,
          };
        }
        const r = this.sessions[e.p]._row(this.sessions[e.p].nodes[e.i]);
        r.idx = e.p * PAIR_BASE + r.idx;
        if (r.mv != null) r.mv = r.mv;   // rel string, display only
        return r;
      }),
    };
  }

  _apply(indices, fn) {
    const bySession = new Map();
    for (const g of indices) {
      const { s, idx } = this._split(g);
      if (!s) continue;
      if (!bySession.has(s)) bySession.set(s, []);
      bySession.get(s).push(idx);
    }
    for (const [s, list] of bySession) fn(s, list);
    this.stats = mergeStats(this.sessions.map(s => s.stats));
    return this.stats;
  }

  setDirection(indices, dir) { return this._apply(indices, (s, l) => s.setDirection(l, dir)); }
  setActive(indices, act)    { return this._apply(indices, (s, l) => s.setActive(l, act)); }
  toggleActive(indices)      { return this._apply(indices, (s, l) => s.toggleActive(l)); }

  invertAll() {
    for (const s of this.sessions) s.invertAll();
    this.stats = mergeStats(this.sessions.map(s => s.stats));
    return this.stats;
  }

  // Global indices, in the same order as rows() (headers excluded — these are
  // selectable data rows only).
  visibleIndices(view) {
    const out = [];
    for (let p = 0; p < this.sessions.length; p++) {
      for (const i of this.sessions[p]._visibleIndices(view)) out.push(p * PAIR_BASE + i);
    }
    return out;
  }

  overview() {
    const rows = [];
    let total = 0;
    for (let p = 0; p < this.sessions.length; p++) {
      const ov = this.sessions[p].overview();
      for (const g of ov.rows) {
        g.idx = g.idx >= 0 ? p * PAIR_BASE + g.idx : -1;
        g.pair = p + 1;
        g.pairLabel = pairLabel(this.pairs[p]);
        rows.push(g);
      }
      total += ov.totalBytes;
    }
    rows.forEach(g => { g.pct = total > 0 ? Math.round((g.bytes / (total || 1)) * 100) : 0; });
    rows.sort((a, b) => b.bytes - a.bytes);
    return { rows, totalBytes: total, pairs: this.sessions.length };
  }

  async sync(job, opts) {
    const { onProgress, token, trashItem, appVersion, defaultReportFolder } = opts || {};
    if (!this.comparedAt) throw new Error('Run a comparison first.');
    const startedAt = Date.now();
    const multi = this.sessions.length > 1;

    // Lock every folder this run will write to, before touching anything.
    // Another machine synchronizing the same folders waits (or we wait for it).
    let locks = null;
    if (job.sync.lockFolders !== false) {
      const folders = [];
      for (const s of this.sessions) { folders.push(s.left, s.right); }
      locks = await acquireAll(folders, {
        token,
        onStatus: st => onProgress && onProgress({
          phase: 'lock', current: st.takingOver
            ? `Taking over an abandoned lock from ${st.holder}…`
            : `Waiting for ${st.holder}${st.secondsLeft != null ? ` — ${st.secondsLeft}s` : ''}`,
          waiting: true, holder: st.holder, secondsLeft: st.secondsLeft,
        }),
      });
    }
    try {

    // Grand totals first, so the progress ring covers the whole job.
    const lvl = job.sync.copyLevel || 'verified';
    const verifyFactor = lvl === 'secure' ? 2 : 1;
    let bytesTotal = 0, filesTotal = 0;
    for (const s of this.sessions) {
      const st = s.stats || {};
      bytesTotal += (st.bytesTotal || 0) * verifyFactor;   // written + read back
      filesTotal += st.filesToProcess || 0;
    }

    const perPair = [];
    let doneBytes = 0, doneFiles = 0, cancelled = false;
    const counters = { files: 0, bytes: 0, deleted: 0, folders: 0, moved: 0, errors: 0 };
    let verified = 0;
    const allErrors = [], allNotes = [], reportFiles = [], checksumFiles = [];

    for (let p = 0; p < this.sessions.length; p++) {
      if (token && token.cancelled) { cancelled = true; break; }
      const pr = this.pairs[p];
      const pairJob = Object.assign({}, job, {
        left: pr.left, right: pr.right,
        pairId: multi ? null : job.pairId,   // same rule as compare()
      });
      let res;
      try {
        res = await this.sessions[p].sync(pairJob, {
          token, trashItem, appVersion, defaultReportFolder,
          skipReport: multi,             // one merged report at the end instead
          onProgress: prog => onProgress && onProgress(Object.assign({}, prog, {
            pair: p + 1, pairs: this.pairs.length, pairLabel: pairLabel(pr),
            bytesDone: doneBytes + (prog.bytesDone || 0),
            bytesTotal,
            filesDone: doneFiles + (prog.filesDone || 0),
            filesTotal,
          })),
        });
      } catch (err) {
        // One pair failing must not throw away what the pairs BEFORE it just
        // did — their copies are on disk and belong in the report. Record the
        // failure and move on to the next pair, like FreeFileSync.
        if (/cancelled/i.test(err.message || '')) { cancelled = true; break; }
        counters.errors++;
        allErrors.push({ rel: multi ? `[${pairLabel(pr)}]` : '', message: err.message || String(err) });
        continue;
      }
      perPair.push(res);
      // The progress offset counts WORK bytes (a secure copy reads everything
      // back: 2× the data), same unit as bytesTotal above — mixing in plain
      // copied bytes made the ring jump backwards between pairs.
      doneBytes += res.counters.workBytes != null ? res.counters.workBytes : (res.counters.bytes || 0);
      doneFiles += (res.counters.files || 0) + (res.counters.moved || 0) + (res.counters.deleted || 0);
      // res.counters.errors already counts this pair's errors — adding
      // res.errors.length again would double every one of them.
      for (const k of Object.keys(counters)) counters[k] += res.counters[k] || 0;
      verified += res.verified || 0;
      allErrors.push(...res.errors.map(e => Object.assign({}, e, {
        rel: multi ? `[${pairLabel(pr)}] ${e.rel}` : e.rel,
      })));
      allNotes.push(...res.notes.map(n => multi ? `[${pairLabel(pr)}] ${n}` : n));
      reportFiles.push(...(res.reportFiles || []));
      checksumFiles.push(...(res.checksumFiles || []));
      cancelled = cancelled || res.cancelled;
    }
    const endedAt = Date.now();

    // Merged report (multi-pair only — a single pair already wrote its own).
    if (multi && job.sync.report && job.sync.report.enabled && perPair.length) {
      const mergedRun = {
        results: [], counters, plan: { bytes: bytesTotal },
        notes: allNotes, cancelled,
      };
      // Rebuild raw results with pair-prefixed paths for the report writer.
      for (let p = 0; p < perPair.length; p++) {
        const lbl = pairLabel(this.pairs[p]);
        for (const r of (this.sessions[p].lastResults || [])) {
          mergedRun.results.push(Object.assign({}, r, { rel: `[${lbl}] ${r.rel}` }));
        }
      }
      const report = buildReport({
        appVersion,
        pairName: job.name,
        leftPath : this.pairs.map(x => x.left).join('  ·  '),
        rightPath: this.pairs.map(x => x.right).join('  ·  '),
        variant: job.sync.variant, compareVariant: job.compare.compareVariant,
        copyLevel: job.sync.copyLevel,
        deletion: job.sync.deletion, versioningStyle: '',
        filter: { include: job.compare.includeFilter, exclude: job.compare.excludeFilter },
        startedAt, endedAt, run: mergedRun,
        stats: this.stats, comparisonErrors: [],
      });
      const stamp = new Date(startedAt).toISOString().slice(0, 16).replace(/[:T]/g, '_');
      const baseName = `syncto_${(job.name || 'job').replace(/[^\w.-]+/g, '_')}_${stamp}`;
      const outDir = job.sync.report.folder || defaultReportFolder || null;
      if (outDir) {
        const nfs = this.sessions[0].pool.native;
        try {
          await nfs.mkdir(outDir);
          const targets = [];
          if (job.sync.report.html) targets.push([baseName + '.html', toHtml(report)]);
          if (job.sync.report.csv)  targets.push([baseName + '.csv',  toCsv(report)]);
          if (job.sync.report.json) targets.push([baseName + '.json', toJson(report)]);
          for (const [name, content] of targets) {
            await writeText(nfs, nfs.join(outDir, name), content);
            reportFiles.push(nfs.join(outDir, name));
          }
        } catch (err) {
          allNotes.push(`Could not write the merged report: ${err.message}`);
        }
      }
    }

    return {
      counters,
      verified,
      errors: allErrors,
      notes : allNotes,
      cancelled,
      startedAt, endedAt,
      durationMs: endedAt - startedAt,
      reportFiles, checksumFiles,
      locked: locks ? locks.count : 0,
      pairsDone: perPair.length, pairsTotal: this.pairs.length,
    };
    } finally {
      if (locks) await locks.release();
    }
  }

  async close() {
    for (const s of this.sessions) { try { await s.close(); } catch (_) {} }
    this.sessions = [];
  }
}

// ── Verification of an existing folder ─────────────────────────────────────
// Reads back a syncto-checksums.txt sidecar and re-hashes every file it lists.
async function verifyFolder(pool, phrase, opts) {
  const { onProgress, token, credentials } = opts || {};
  const loc = parseLocation(phrase, credentials);
  const { fs: fsx, path: root } = await pool.open(loc);

  const listPath = fsx.join(root, CHECKSUM_FILE);
  const text = await readText(fsx, listPath);
  if (text == null) throw new Error(`No ${CHECKSUM_FILE} found in this folder.`);

  const { algo, entries } = parseChecksumList(text);
  if (!entries.length) throw new Error('The checksum list is empty.');

  const results = [];
  let done = 0, okCount = 0, badCount = 0, missingCount = 0;
  for (const e of entries) {
    if (token && token.cancelled) break;
    const p = fsx.join(root, ...e.rel.split('/'));
    const st = await fsx.stat(p);
    if (!st) { missingCount++; results.push({ rel: e.rel, status: 'missing' }); done++; continue; }
    try {
      const hasher = await createHasher(algo || 'xxh64');
      const got = await hashStream(fsx, p, hasher, null, token);
      if (got === e.hash) { okCount++; results.push({ rel: e.rel, status: 'ok' }); }
      else { badCount++; results.push({ rel: e.rel, status: 'mismatch', expected: e.hash, got }); }
    } catch (err) {
      badCount++; results.push({ rel: e.rel, status: 'error', error: err.message });
    }
    done++;
    if (onProgress && done % 5 === 0) {
      onProgress({ done, total: entries.length, current: e.rel, verified: okCount, mismatched: badCount, missing: missingCount });
    }
  }
  if (onProgress) onProgress({ done, total: entries.length, current: '', verified: okCount, mismatched: badCount, missing: missingCount });
  // Field names deliberately avoid "ok": the IPC layer wraps this in { ok: true }.
  return { algo, total: entries.length, verified: okCount, mismatched: badCount, missing: missingCount, results };
}

// ── Small text helpers that work on any backend ────────────────────────────
function writeText(fsx, p, content) {
  return new Promise((resolve, reject) => {
    const ws = fsx.createWriteStream(p);
    ws.on('error', reject);
    ws.on('finish', resolve);
    ws.end(Buffer.from(content, 'utf8'));
  });
}

async function readText(fsx, p) {
  const st = await fsx.stat(p);
  if (!st || st.type !== 'file') return null;
  return new Promise((resolve, reject) => {
    const chunks = [];
    const rs = fsx.createReadStream(p);
    rs.on('data', c => chunks.push(c));
    rs.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    rs.on('error', reject);
  });
}

module.exports = { Session, MultiSession, verifyFolder, CHECKSUM_FILE, writeText, readText };
