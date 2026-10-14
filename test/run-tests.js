/*
 * syncto — engine test suite
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
 *
 * Runs the whole engine against real folders in a temporary directory.
 * No Electron, no UI — plain `node test/run-tests.js`.
 */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { PathFilter, SoftFilter } = require('../src/main/core/filter');
const { Session, MultiSession } = require('../src/main/core/session');
const { defaultJob } = require('../src/main/config');
const { versionedRelPath, runTimestamp } = require('../src/main/core/versioning');
const { CAT, OP, LOCK_NAME } = require('../src/main/core/compare');
const { NativeFs } = require('../src/main/fs/native');
const { acquireOne, acquireAll, abandonedLockName, localLockInfo, processStatus,
        DETECT_ABANDONED_MS } = require('../src/main/core/lock');
const { spawn } = require('child_process');

let passed = 0, failed = 0;
const failures = [];

function ok(cond, label) {
  if (cond) { passed++; process.stdout.write('.'); }
  else { failed++; failures.push(label); process.stdout.write('x'); }
}
function eq(a, b, label) {
  const same = JSON.stringify(a) === JSON.stringify(b);
  if (!same) failures.push(`${label}\n      expected ${JSON.stringify(b)}\n      got      ${JSON.stringify(a)}`);
  if (same) { passed++; process.stdout.write('.'); } else { failed++; process.stdout.write('x'); }
}

// ── Scratch space ──────────────────────────────────────────────────────────
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'syncto-test-'));
let caseNo = 0;
function scratch() {
  const d = path.join(ROOT, 'case' + (++caseNo));
  fs.mkdirSync(path.join(d, 'L'), { recursive: true });
  fs.mkdirSync(path.join(d, 'R'), { recursive: true });
  return { dir: d, L: path.join(d, 'L'), R: path.join(d, 'R') };
}
function write(base, rel, content, mtime) {
  const p = path.join(base, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  if (mtime) fs.utimesSync(p, new Date(mtime), new Date(mtime));
  return p;
}
function read(base, rel) {
  try { return fs.readFileSync(path.join(base, rel), 'utf8'); } catch (_) { return null; }
}
function exists(base, rel) { return fs.existsSync(path.join(base, rel)); }
function listAll(base) {
  const out = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { out.push(r + '/'); walk(path.join(d, e.name), r); }
      else out.push(r);
    }
  })(base, '');
  return out.sort();
}

function makeJob(L, R, over) {
  const j = defaultJob();
  j.left = L; j.right = R;
  j.name = 'test';
  j.sync.deletion = 'permanent';
  j.sync.retryCount = 0;
  return deepAssign(j, over || {});
}
function deepAssign(base, over) {
  for (const k of Object.keys(over)) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && base[k] && typeof base[k] === 'object') {
      deepAssign(base[k], over[k]);
    } else base[k] = over[k];
  }
  return base;
}

async function runPair(job) {
  const s = new Session();
  const token = { cancelled: false, paused: false };
  const cmp = await s.compare(job, { token });
  const run = await s.sync(job, { token, appVersion: 'test' });
  await s.close();
  return { s, cmp, run };
}

// ══ 1. Path filter ═════════════════════════════════════════════════════════
function testFilter() {
  console.log('\n\n1. Path filter');
  const f1 = new PathFilter('*', '/*.tmp');
  ok(f1.passFile('clip.mov'), 'plain file passes');
  ok(!f1.passFile('clip.tmp'), '/*.tmp excludes a root .tmp');
  ok(f1.passFile('sub/clip.tmp'), '/*.tmp does not reach into subfolders');

  const f2 = new PathFilter('*', '/*/thumbs.db');
  ok(!f2.passFile('sub/thumbs.db'), '/*/thumbs.db excludes one level down');
  // Same rule as FreeFileSync: a leading */ also registers the bare tail, so
  // the pattern catches the file at the root too. Convenient, and it means
  // "/*/thumbs.db" behaves the way people actually expect.
  ok(!f2.passFile('thumbs.db'), '/*/thumbs.db also catches the root-level file');

  const f3 = new PathFilter('*', '/Proxies/');
  ok(!f3.passFolder('Proxies'), 'trailing slash excludes the folder');
  ok(!f3.passFile('Proxies/a.mov'), 'excluding a folder excludes its content');
  ok(f3.passFile('Masters/a.mov'), 'sibling folders are untouched');

  const f4 = new PathFilter('/A/B/*.mov', '');
  ok(f4.passFolder('A'), 'a nested include keeps the parent folders walkable');
  ok(f4.passFolder('A/B'), 'and the intermediate folder');
  ok(f4.passFile('A/B/x.mov'), 'the included file passes');
  ok(!f4.passFile('A/B/x.wav'), 'a non-matching extension is dropped');
  ok(!f4.passFile('C/x.mov'), 'an unrelated branch is dropped');

  const f5 = new PathFilter('*', '/*:');
  ok(!f5.passFile('a.txt'), 'a trailing colon means files only');
  ok(f5.passFolder('sub'), 'and leaves folders alone');

  const f6 = new PathFilter('*', 'CACHE | *.bak');
  ok(!f6.passFile('x.bak'), 'the pipe separates patterns');
  ok(!f6.passFolder('CACHE'), 'and both halves apply');

  const f7 = new PathFilter('*', '/Sub\\Deep\\');
  ok(!f7.passFolder('Sub/Deep'), 'backslashes are accepted as separators');

  const f8 = new PathFilter('*', '/MyFolder/');
  ok(!f8.passFolder('myfolder'), 'matching is case-insensitive');

  const soft = new SoftFilter({ sizeMinUnit: 'kb', sizeMin: 10 });
  ok(!soft.passes(5000, Date.now()), 'the soft filter rejects a file under the minimum');
  ok(soft.passes(50000, Date.now()), 'and accepts one above it');

  // Anchoring rule: no "/" in the pattern -> matches the NAME at any depth;
  // a leading "/" pins the pattern to the root.
  const f9 = new PathFilter('*', '*.tmp');
  ok(!f9.passFile('x.tmp'), 'a bare *.tmp excludes at the root');
  ok(!f9.passFile('a/b/c/x.tmp'), 'and at any depth');
  ok(f9.passFile('a/b/c/x.mov'), 'without touching other extensions');

  const f10 = new PathFilter('*', 'thumbs.db');
  ok(!f10.passFile('deep/er/thumbs.db'), 'a bare name excludes anywhere');

  const f11 = new PathFilter('*', 'Proxies/');
  ok(!f11.passFolder('a/b/Proxies'), 'a bare folder name excludes anywhere');
  ok(!f11.passFile('a/b/Proxies/p.mov'), 'along with its content');

  const f12 = new PathFilter('*', '/notes.txt');
  ok(!f12.passFile('notes.txt'), 'a leading slash pins to the root');
  ok(f12.passFile('sub/notes.txt'), 'and leaves deeper namesakes alone');
}

// ══ 2. Comparison categories ═══════════════════════════════════════════════
async function testCompare() {
  console.log('\n2. Comparison');
  const { L, R } = scratch();
  const t0 = Date.now() - 100000;
  write(L, 'same.txt', 'hello', t0);
  write(R, 'same.txt', 'hello', t0);
  write(L, 'leftonly.txt', 'x', t0);
  write(R, 'rightonly.txt', 'y', t0);
  write(L, 'newer.txt', 'aaaa', t0 + 60000);
  write(R, 'newer.txt', 'bbbb', t0);
  write(L, 'sub/deep.txt', 'z', t0);

  const job = makeJob(L, R);
  const s = new Session();
  const cmp = await s.compare(job, { token: {} });
  const byRel = {};
  for (const n of s.nodes) byRel[n.rel] = n;

  eq(byRel['same.txt'].cat, CAT.EQUAL, 'identical file -> equal');
  eq(byRel['leftonly.txt'].cat, CAT.LEFT_ONLY, 'left only');
  eq(byRel['rightonly.txt'].cat, CAT.RIGHT_ONLY, 'right only');
  eq(byRel['newer.txt'].cat, CAT.LEFT_NEWER, 'left newer');
  ok(!!byRel['sub'], 'the subfolder is in the tree');
  eq(byRel['sub'].cat, CAT.LEFT_ONLY, 'the subfolder is left only');
  await s.close();

  // 1-second drift must not register as a change (FAT / SFTP resolution).
  const b = scratch();
  write(b.L, 'a.txt', 'hello', t0);
  write(b.R, 'a.txt', 'hello', t0 + 1000);
  const s2 = new Session();
  await s2.compare(makeJob(b.L, b.R), { token: {} });
  eq(s2.nodes[0].cat, CAT.EQUAL, '1 s of drift stays inside the 2 s tolerance');
  await s2.close();

  // Same date, different size -> conflict, never a silent overwrite.
  const c = scratch();
  write(c.L, 'a.txt', 'hello world', t0);
  write(c.R, 'a.txt', 'hello', t0);
  const s3 = new Session();
  await s3.compare(makeJob(c.L, c.R), { token: {} });
  eq(s3.nodes[0].cat, CAT.CONFLICT, 'same date but a different size is a conflict');
  await s3.close();

  // Content comparison notices a change the timestamps hide.
  const d = scratch();
  write(d.L, 'a.txt', 'AAAAA', t0);
  write(d.R, 'a.txt', 'BBBBB', t0);
  const s4 = new Session();
  await s4.compare(makeJob(d.L, d.R, { compare: { compareVariant: 'content' } }), { token: {} });
  eq(s4.nodes[0].cat, CAT.DIFFERENT, 'content comparison catches identical dates and sizes');
  await s4.close();
}

// ══ 3. Mirror ══════════════════════════════════════════════════════════════
async function testMirror() {
  console.log('\n3. Mirror');
  const { L, R } = scratch();
  const t0 = Date.now() - 100000;
  write(L, 'keep.txt', 'keep', t0);
  write(L, 'sub/new.txt', 'new', t0);
  write(R, 'stale.txt', 'stale', t0);
  write(R, 'keep.txt', 'old', t0 - 60000);

  const { run } = await runPair(makeJob(L, R, { sync: { variant: 'mirror' } }));

  eq(read(R, 'keep.txt'), 'keep', 'mirror overwrites the older right-hand copy');
  eq(read(R, 'sub/new.txt'), 'new', 'mirror creates missing folders and files');
  ok(!exists(R, 'stale.txt'), 'mirror removes what the left side does not have');
  eq(run.errors.length, 0, 'mirror runs without errors');
  eq(listAll(L).filter(x => !x.startsWith('.syncto')), listAll(R).filter(x => !x.startsWith('.syncto')),
     'both sides end up with the same tree');

  // Dates survive the copy — this is what makes the next comparison cheap.
  const sl = fs.statSync(path.join(L, 'sub/new.txt'));
  const sr = fs.statSync(path.join(R, 'sub/new.txt'));
  ok(Math.abs(sl.mtimeMs - sr.mtimeMs) < 2000, 'the modification date is preserved');

  // A second run must have nothing left to do.
  const s = new Session();
  const cmp2 = await s.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: {} });
  eq(cmp2.stats.filesToProcess, 0, 'a second mirror run is a no-op');
  await s.close();
}

// ══ 4. Update never deletes ════════════════════════════════════════════════
async function testUpdate() {
  console.log('\n4. Update');
  const { L, R } = scratch();
  const t0 = Date.now() - 100000;
  write(L, 'new.txt', 'new', t0);
  write(R, 'extra.txt', 'extra', t0);

  await runPair(makeJob(L, R, { sync: { variant: 'update' } }));
  eq(read(R, 'new.txt'), 'new', 'update copies new files rightward');
  ok(exists(R, 'extra.txt'), 'update never removes anything on the right');
  ok(!exists(L, 'extra.txt'), 'update never copies leftward');
}

// ══ 5. Two way, with the database ══════════════════════════════════════════
async function testTwoWay() {
  console.log('\n5. Two way');
  const { L, R } = scratch();
  const t0 = Date.now() - 200000;
  write(L, 'a.txt', 'a', t0);
  write(R, 'b.txt', 'b', t0);

  // First run: no database yet, so it can only copy — that is the safe default.
  await runPair(makeJob(L, R, { sync: { variant: 'twoWay' } }));
  ok(exists(R, 'a.txt') && exists(L, 'b.txt'), 'the first two-way run copies both ways');
  ok(fs.existsSync(path.join(L, '.syncto.db')), 'a database is written on the left');
  ok(fs.existsSync(path.join(R, '.syncto.db')), 'and on the right');

  // Second run: delete on the left, add on the right. With the database, the
  // deletion must propagate instead of being undone by a copy back.
  fs.unlinkSync(path.join(L, 'b.txt'));
  write(R, 'c.txt', 'c', t0);

  const job = makeJob(L, R, { sync: { variant: 'twoWay' } });
  const s = new Session();
  await s.compare(job, { token: {} });
  const byRel = {};
  for (const n of s.nodes) byRel[n.rel] = n;
  eq(byRel['b.txt'].op, OP.DELETE_RIGHT, 'a deletion on the left propagates to the right');
  eq(byRel['c.txt'].op, OP.CREATE_LEFT, 'a creation on the right propagates to the left');
  await s.sync(job, { token: {}, appVersion: 'test' });
  await s.close();

  ok(!exists(R, 'b.txt'), 'the deleted file is gone from both sides');
  eq(read(L, 'c.txt'), 'c', 'the new file reached the other side');

  // Both sides changed since the last run -> conflict, not a coin flip.
  write(L, 'a.txt', 'left version', Date.now());
  write(R, 'a.txt', 'right version', Date.now() - 30000);
  const s2 = new Session();
  await s2.compare(makeJob(L, R, { sync: { variant: 'twoWay' } }), { token: {} });
  const conflict = s2.nodes.find(n => n.rel === 'a.txt');
  eq(conflict.op, OP.CONFLICT, 'a change on both sides is reported as a conflict');
  await s2.close();
}

// ══ 6. Secure copy, checksum list, verification ════════════════════════════
async function testSecure() {
  console.log('\n6. Secure copy and verification');
  const { L, R } = scratch();
  const t0 = Date.now() - 100000;
  write(L, 'big.bin', Buffer.alloc(1024 * 512, 7), t0);
  write(L, 'sub/small.txt', 'tiny', t0);

  const job = makeJob(L, R, {
    sync: { variant: 'mirror', copyLevel: 'secure', writeChecksumList: true,
            report: { enabled: true, html: true, csv: true, json: true, folder: path.join(ROOT, 'reports') } },
  });
  const { run } = await runPair(job);

  eq(run.errors.length, 0, 'the secure copy completes without errors');
  ok(fs.existsSync(path.join(R, 'syncto-checksums.txt')), 'a checksum list is written next to the data');
  // Reports went in 0.8.3. A job saved before still carries its report
  // settings: they are ignored, and nothing lands anywhere.
  ok(run.reportFiles === undefined, 'no report is produced any more');
  ok(!fs.existsSync(path.join(ROOT, 'reports')), 'even for a job that still asks for one');

  const list = fs.readFileSync(path.join(R, 'syncto-checksums.txt'), 'utf8');
  ok(/xxh64/.test(list), 'the list records which algorithm was used');
  ok(list.split('\n').filter(l => l && !l.startsWith('#')).length === 2, 'every copied file is listed');

  // ORDER OF PHASES — the whole point of the ingesto model: every file is
  // copied first, and only then is everything read back. No copy may start
  // after the first verification has begun.
  const o = scratch();
  for (let i = 1; i <= 4; i++) write(o.L, `clip_${i}.bin`, Buffer.alloc(300 * 1024, i), t0);
  const seq = [];
  const so = new Session();
  const jo = makeJob(o.L, o.R, { sync: { variant: 'mirror', copyLevel: 'secure' } });
  await so.compare(jo, { token: {} });
  const ro = await so.sync(jo, {
    token: {}, appVersion: 'test',
    onProgress: p => { if (p.pass && seq[seq.length - 1] !== p.pass) seq.push(p.pass); },
  });
  await so.close();
  eq(seq, ['copy', 'verify', 'cleanup'], 'copy runs to completion, then verification, then cleanup — never back to copying');
  ok(seq.indexOf('copy') < seq.indexOf('verify'), 'not a single file is copied after verification starts');
  eq(ro.verified, 4, 'every copied file was read back and checked');
  eq(ro.errors.length, 0, 'and all of them matched');

  // The checksum list lives at the root of the target. A second mirror run must
  // treat it as syncto's own file, not as a stray to be deleted.
  const s2 = new Session();
  const cmp2 = await s2.compare(job, { token: {} });
  eq(cmp2.stats.filesToProcess, 0, 'the checksum list does not make the next run dirty');
  await s2.close();
  ok(fs.existsSync(path.join(R, 'syncto-checksums.txt')), 'and it is still there afterwards');

  // Verification of an intact folder.
  const { FsPool } = require('../src/main/fs/afs');
  const { verifyFolder } = require('../src/main/core/session');
  const pool = new FsPool();
  const v1 = await verifyFolder(pool, R, { token: {} });
  eq([v1.verified, v1.mismatched, v1.missing], [2, 0, 0], 'an intact folder verifies clean');

  // Now corrupt one byte, the way a failing drive would.
  const target = path.join(R, 'sub/small.txt');
  fs.writeFileSync(target, 'tin!');
  const v2 = await verifyFolder(pool, R, { token: {} });
  eq(v2.mismatched, 1, 'a single altered byte is caught');
  await pool.closeAll();
}

// ══ 7. Versioning ══════════════════════════════════════════════════════════
async function testVersioning() {
  console.log('\n7. Versioning');
  eq(versionedRelPath('sub/clip.mov', 'timestampFolder', '2026-08-08 143012'),
     '2026-08-08 143012/sub/clip.mov', 'timestampFolder puts a dated folder on top');
  eq(versionedRelPath('sub/clip.mov', 'timestampFile', '2026-08-08 143012'),
     'sub/clip 2026-08-08 143012.mov', 'timestampFile inserts the stamp before the extension');
  eq(versionedRelPath('README', 'timestampFile', '2026-08-08 143012'),
     'README 2026-08-08 143012', 'a file with no extension still gets a stamp');
  eq(versionedRelPath('sub/clip.mov', 'replace', '2026-08-08 143012'),
     'sub/clip.mov', 'replace keeps the path as it is');
  ok(/^\d{4}-\d{2}-\d{2} \d{6}$/.test(runTimestamp()), 'the run timestamp has the documented shape');

  const { L, R, dir } = scratch();
  const rev = path.join(dir, 'revisions');
  const t0 = Date.now() - 100000;
  write(L, 'a.txt', 'new content', t0);
  write(R, 'a.txt', 'old content', t0 - 90000);
  write(R, 'gone.txt', 'about to be archived', t0);

  const { run } = await runPair(makeJob(L, R, {
    sync: { variant: 'mirror', deletion: 'versioning',
            versioning: { rightFolder: rev, leftFolder: rev, style: 'timestampFolder' } },
  }));

  eq(read(R, 'a.txt'), 'new content', 'the target is replaced');
  ok(!exists(R, 'gone.txt'), 'the extra file leaves the target');
  const stamps = fs.readdirSync(rev);
  eq(stamps.length, 1, 'one revision folder per run');
  const inRev = listAll(path.join(rev, stamps[0]));
  ok(inRev.includes('a.txt'), 'the replaced version is archived');
  ok(inRev.includes('gone.txt'), 'the removed file is archived too');
  eq(fs.readFileSync(path.join(rev, stamps[0], 'a.txt'), 'utf8'), 'old content',
     'the archived copy is the previous version, not the new one');
  eq(run.errors.length, 0, 'versioning runs without errors');
}

// ══ 8. Fail-safe copy ══════════════════════════════════════════════════════
async function testFailSafe() {
  console.log('\n8. Fail-safe copy and leftovers');
  const { L, R } = scratch();
  const t0 = Date.now() - 100000;
  write(L, 'a.txt', 'good', t0);
  // A leftover from an interrupted run must be ignored, never synchronized.
  write(R, 'orphan.txt.syncto_tmp', 'half written', t0);

  const s = new Session();
  const cmp = await s.compare(makeJob(L, R), { token: {} });
  ok(!s.nodes.some(n => n.rel.includes('syncto_tmp')), 'a stray temp file is not compared');
  await s.close();

  await runPair(makeJob(L, R, { sync: { variant: 'mirror' } }));
  eq(read(R, 'a.txt'), 'good', 'the copy lands under its real name');
  ok(!exists(R, 'a.txt.syncto_tmp'), 'no temporary file survives a successful copy');
}

// ══ 9. Manual overrides ════════════════════════════════════════════════════
async function testOverrides() {
  console.log('\n9. Manual overrides');
  const { L, R } = scratch();
  const t0 = Date.now() - 100000;
  write(L, 'a.txt', 'a', t0);
  write(L, 'b.txt', 'b', t0);

  const job = makeJob(L, R, { sync: { variant: 'mirror' } });
  const s = new Session();
  await s.compare(job, { token: {} });
  const bNode = s.nodes.find(n => n.rel === 'b.txt');
  s.setActive([bNode.idx], false);
  const stats = s.setDirection([], 'right');
  eq(stats.createRight, 1, 'deselecting a row removes it from the plan');
  await s.sync(job, { token: {}, appVersion: 'test' });
  await s.close();

  ok(exists(R, 'a.txt'), 'the selected file is copied');
  ok(!exists(R, 'b.txt'), 'the deselected file is left alone');

  // Excluding a FOLDER must exclude its whole subtree in one go.
  const c = scratch();
  write(c.L, 'keep.txt', 'k', t0);
  write(c.L, 'skip/deep/one.txt', '1', t0);
  write(c.L, 'skip/two.txt', '2', t0);
  const job2 = makeJob(c.L, c.R, { sync: { variant: 'mirror' } });
  const s2 = new Session();
  await s2.compare(job2, { token: {} });
  const folder = s2.nodes.find(n => n.rel === 'skip');
  const st = s2.toggleActive([folder.idx]);
  eq(st.createRight, 1, 'toggling a folder deactivates every descendant');
  await s2.sync(job2, { token: {}, appVersion: 'test' });
  await s2.close();
  ok(exists(c.R, 'keep.txt'), 'the rest still syncs');
  ok(!exists(c.R, 'skip'), 'the excluded folder never lands on the destination');
}

// ══ 10. Folder rules ═══════════════════════════════════════════════════════
async function testFolderRules() {
  console.log('\n10. Folder rules');
  const { L, R } = scratch();
  const t0 = Date.now() - 100000;
  write(R, 'doomed/keep.txt', 'keep', t0);
  write(R, 'doomed/also.txt', 'also', t0);

  const job = makeJob(L, R, { sync: { variant: 'mirror' } });
  const s = new Session();
  await s.compare(job, { token: {} });
  const keep = s.nodes.find(n => n.rel === 'doomed/keep.txt');
  s.setActive([keep.idx], false);          // one child survives...
  const folder = s.nodes.find(n => n.rel === 'doomed');
  eq(folder.op, OP.DO_NOTHING, '...so the folder deletion is cancelled');
  await s.sync(job, { token: {}, appVersion: 'test' });
  await s.close();

  ok(exists(R, 'doomed/keep.txt'), 'the protected file survives');
  ok(!exists(R, 'doomed/also.txt'), 'its sibling is still removed');
  ok(exists(R, 'doomed'), 'and the folder itself stays');
}

// ══ 11. Moved-file detection ═══════════════════════════════════════════════
async function testMoves() {
  console.log('\n11. Moved-file detection');
  const { L, R } = scratch();
  const t0 = Date.now() - 200000;
  write(L, 'sub/clip.mov', Buffer.alloc(256 * 1024, 3), t0);
  write(L, 'other.txt', 'x', t0);

  // Run 1 (mirror): plain copy, and the database records the file ids.
  await runPair(makeJob(L, R, { sync: { variant: 'mirror' } }));
  ok(fs.existsSync(path.join(L, '.syncto.db')), 'a mirror run writes the database when move detection is on');

  // The user reorganizes: same file, new folder, new name. Same inode.
  fs.mkdirSync(path.join(L, 'renamed'), { recursive: true });
  fs.renameSync(path.join(L, 'sub/clip.mov'), path.join(L, 'renamed/clip_v2.mov'));

  const job = makeJob(L, R, { sync: { variant: 'mirror' } });
  const s = new Session();
  const cmp = await s.compare(job, { token: {} });
  const byRel = {};
  for (const n of s.nodes) byRel[n.rel] = n;

  eq(cmp.movesFound, 1, 'the rename is detected as one move');
  eq(byRel['renamed/clip_v2.mov'].op, OP.MOVE_RIGHT_TO, 'the new path is a move target');
  eq(byRel['sub/clip.mov'].op, OP.MOVE_RIGHT_FROM, 'the old path is the move source');

  const run = await s.sync(job, { token: {}, appVersion: 'test' });
  await s.close();

  eq(run.counters.moved, 1, 'one rename executed');
  eq(run.counters.files, 0, 'and NOT a single file re-copied');
  eq(run.counters.bytes, 0, 'zero bytes transferred');
  ok(exists(R, 'renamed/clip_v2.mov'), 'the right side followed the move');
  ok(!exists(R, 'sub/clip.mov'), 'the old right-hand path is gone');
  eq(fs.statSync(path.join(R, 'renamed/clip_v2.mov')).size, 256 * 1024, 'the moved file is intact');
  eq(run.errors.length, 0, 'no errors');

  // A second compare must be clean — including the database bookkeeping.
  const s2 = new Session();
  const cmp2 = await s2.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: {} });
  eq(cmp2.stats.filesToProcess, 0, 'the pair is fully in sync after the move');
  await s2.close();
}

// ══ 12. Moves in two-way, and the off switch ═══════════════════════════════
async function testMovesTwoWayAndOff() {
  console.log('\n12. Moves: two way and opting out');
  const { L, R } = scratch();
  const t0 = Date.now() - 200000;
  write(L, 'a.bin', Buffer.alloc(64 * 1024, 9), t0);

  await runPair(makeJob(L, R, { sync: { variant: 'twoWay' } }));
  // Move on the RIGHT this time: the LEFT side must rename.
  fs.renameSync(path.join(R, 'a.bin'), path.join(R, 'a_renamed.bin'));

  const job = makeJob(L, R, { sync: { variant: 'twoWay' } });
  const s = new Session();
  const cmp = await s.compare(job, { token: {} });
  const byRel = {};
  for (const n of s.nodes) byRel[n.rel] = n;
  eq(cmp.movesFound, 1, 'a move on the right is detected too');
  eq(byRel['a_renamed.bin'].op, OP.MOVE_LEFT_TO, 'and the LEFT side is the one renaming');
  const run = await s.sync(job, { token: {}, appVersion: 'test' });
  await s.close();
  ok(exists(L, 'a_renamed.bin') && !exists(L, 'a.bin'), 'the left side followed');
  eq(run.counters.bytes, 0, 'still zero bytes transferred');

  // With the option off, the same situation is a plain copy + delete again.
  const b = scratch();
  write(b.L, 'x.bin', Buffer.alloc(1024, 1), t0);
  await runPair(makeJob(b.L, b.R, { sync: { variant: 'mirror' } }));
  fs.renameSync(path.join(b.L, 'x.bin'), path.join(b.L, 'y.bin'));
  const s3 = new Session();
  const cmp3 = await s3.compare(makeJob(b.L, b.R, {
    compare: { detectMoves: false }, sync: { variant: 'mirror' },
  }), { token: {} });
  eq(cmp3.movesFound, 0, 'detection can be switched off');
  eq(cmp3.stats.createRight, 1, 'the new name is then a plain copy');
  eq(cmp3.stats.deleteRight, 1, 'and the old one a plain deletion');
  await s3.close();
}

// ══ 13. Multi-pair jobs ════════════════════════════════════════════════════
async function testMultiPair() {
  console.log('\n13. Multi-pair jobs');
  const a = scratch(), b = scratch();
  const t0 = Date.now() - 100000;
  write(a.L, 'one.txt', 'first pair', t0);
  write(a.L, 'sub/two.txt', 'deep', t0);
  write(b.L, 'three.txt', 'second pair', t0);
  write(b.R, 'stale.txt', 'to be removed', t0);

  const job = makeJob('', '', { sync: { variant: 'mirror' } });
  delete job.left; delete job.right;
  job.pairs = [{ left: a.L, right: a.R }, { left: b.L, right: b.R }];

  const m = new MultiSession();
  const cmp = await m.compare(job, { token: {} });
  eq(cmp.pairs.length, 2, 'both pairs are compared');
  eq(cmp.stats.createRight, 4, 'stats merge across pairs (2+1 files, 1 folder)');
  eq(cmp.stats.deleteRight, 1, 'including the deletion in pair 2');

  // The merged grid: header rows appear, indices are globalized.
  const rows = m.rows(0, 50, {});
  eq(rows.rows.filter(r => r.hdr).length, 2, 'one header row per pair');
  const three = rows.rows.find(r => !r.hdr && r.name === 'three.txt');
  ok(three && three.idx >= 1000000, 'pair-2 rows carry globalized indices');

  // Editing through a global index reaches the right pair.
  const st = m.toggleActive([three.idx]);
  eq(st.createRight, 3, 'toggling via a global index lands on the right pair');
  m.toggleActive([three.idx]);

  const run = await m.sync(job, { token: {}, appVersion: 'test' });
  eq(run.pairsDone, 2, 'both pairs synchronized');
  eq(run.errors.length, 0, 'no errors');
  eq(read(a.R, 'one.txt'), 'first pair', 'pair 1 copied');
  eq(read(a.R, 'sub/two.txt'), 'deep', 'pair 1 subfolder copied');
  eq(read(b.R, 'three.txt'), 'second pair', 'pair 2 copied');
  ok(!exists(b.R, 'stale.txt'), 'pair 2 deletion executed');
  ok(!exists(a.R, 'three.txt'), 'pairs never leak into each other');
  ok(fs.existsSync(path.join(b.L, '.syncto.db')), 'each pair keeps its own database');

  // Second compare: everything in sync, headers still there.
  const cmp2 = await m.compare(job, { token: {} });
  eq(cmp2.stats.filesToProcess, 0, 'a second run is a no-op across all pairs');
  await m.close();

  // Legacy single-pair job shape still works through MultiSession.
  const c = scratch();
  write(c.L, 'x.txt', 'x', t0);
  const legacy = makeJob(c.L, c.R, { sync: { variant: 'mirror' } });
  delete legacy.pairs;
  const m2 = new MultiSession();
  const cl = await m2.compare(legacy, { token: {} });
  eq(cl.stats.createRight, 1, 'a legacy left/right job still compares');
  await m2.sync(legacy, { token: {}, appVersion: 'test' });
  eq(read(c.R, 'x.txt'), 'x', 'and synchronizes');
  await m2.close();
}

// ══ 14. Directory locking ══════════════════════════════════════════════════
async function testLocking() {
  console.log('\n14. Directory locking');

  // Abandoned-lock renaming ladder, verbatim from FreeFileSync.
  eq(abandonedLockName('.syncto.lock'), 'Delete.0..syncto.lock', 'first take-over level');
  eq(abandonedLockName('Delete.0..syncto.lock'), 'Delete.1..syncto.lock', 'levels increment');
  eq(abandonedLockName('Delete.8..syncto.lock'), 'Delete.9..syncto.lock', 'up to the ceiling');
  let threw = false;
  try { abandonedLockName('Delete.9..syncto.lock'); } catch (_) { threw = true; }
  ok(threw, 'and refuses to recurse past 10');

  // Process identification.
  const local = localLockInfo();
  eq(processStatus(local, local), 'itsUs', 'our own lock is recognized');
  eq(processStatus({ ...local, processId: 999999 }, local), 'notRunning', 'a dead pid is detected');
  eq(processStatus({ ...local, computerName: 'OtherMachine' }, local), 'unknown',
     'another machine cannot be probed locally');

  const { L } = scratch();
  const fsx = new NativeFs();

  // Acquire / release round trip.
  const lock = await acquireOne(fsx, L, {});
  ok(fs.existsSync(path.join(L, LOCK_NAME)), 'the lock file is created');
  await lock.release();
  ok(!fs.existsSync(path.join(L, LOCK_NAME)), 'and removed on release');

  // A lock left behind by a CRASHED process of this machine is taken over at
  // once — no need to wait out the 12 s heartbeat window.
  const stale = { ...localLockInfo(), processId: 999999 };
  fs.writeFileSync(path.join(L, LOCK_NAME), JSON.stringify(stale) + '\n');
  const t0 = Date.now();
  const lock2 = await acquireOne(fsx, L, {});
  const took = Date.now() - t0;
  ok(took < 2000, `a dead owner's lock is taken over immediately (${took} ms)`);
  await lock2.release();

  // The real thing: a SEPARATE process holds the lock and heartbeats.
  const holder = spawn(process.execPath, [path.join(__dirname, 'lock-holder.js'), L]);
  await new Promise(res => holder.stdout.on('data', d => { if (String(d).includes('LOCKED')) res(); }));
  ok(fs.existsSync(path.join(L, LOCK_NAME)), 'the other process holds the lock');

  // We must NOT be able to take it while it lives.
  let grabbed = false;
  const token = { cancelled: false };
  const waiting = acquireOne(fsx, L, { token, onStatus: () => {} })
    .then(l => { grabbed = true; return l; })
    .catch(() => null);
  await new Promise(r => setTimeout(r, 3000));
  ok(!grabbed, 'a live lock is respected — we wait instead of syncing over it');

  // Owner leaves cleanly -> we get in.
  holder.kill('SIGTERM');
  const got = await Promise.race([waiting, new Promise(r => setTimeout(() => r(null), 12000))]);
  ok(!!got, 'the lock is acquired once the other process releases it');
  if (got) await got.release();

  // Cancelling while waiting must not hang.
  const holder2 = spawn(process.execPath, [path.join(__dirname, 'lock-holder.js'), L]);
  await new Promise(res => holder2.stdout.on('data', d => { if (String(d).includes('LOCKED')) res(); }));
  const tok2 = { cancelled: false };
  const pending = acquireOne(fsx, L, { token: tok2, onStatus: () => {} }).then(() => 'got').catch(e => e.message);
  setTimeout(() => { tok2.cancelled = true; }, 500);
  const outcome = await Promise.race([pending, new Promise(r => setTimeout(() => r('timeout'), 8000))]);
  eq(outcome, 'Cancelled', 'cancelling while waiting returns promptly');
  holder2.kill('SIGKILL');

  // A SIGKILLed owner leaves a stale lock with a dead pid -> immediate take-over.
  await new Promise(r => setTimeout(r, 300));
  const lock3 = await acquireOne(fsx, L, {});
  ok(true, 'a killed owner leaves a lock that is reclaimed');
  await lock3.release();

  // acquireAll deduplicates folders shared by several pairs.
  const set = await acquireAll([{ fs: fsx, path: L }, { fs: fsx, path: L }], {});
  eq(set.count, 1, 'a folder used by two pairs is locked once');
  await set.release();
}

// ══ 15. Review regressions ═════════════════════════════════════════════════
// One test per bug found by the full-code review — each of these used to fail.
async function testReviewRegressions() {
  console.log('\n15. Review regressions');
  const { Comparer, isSyncToInternal } = require('../src/main/core/compare');
  const { migrateJob } = require('../src/main/config');
  const { readDb, pairIdFor } = require('../src/main/core/db');

  // (a) A name-only include mask must not prune folders — include "*.jpg" has
  // to reach files in subfolders, at any depth.
  {
    const f = new PathFilter('*.jpg', '');
    ok(f.passFolder('photos'), 'include *.jpg keeps folders walkable');
    ok(f.passFolder('photos/2026/deep'), 'at any depth');
    ok(f.passFile('photos/2026/deep/a.jpg'), 'so nested matches are reached');
    ok(!f.passFile('photos/2026/deep/a.txt'), 'while other files stay excluded');

    const { L, R } = scratch();
    write(L, 'shoot/day1/a.jpg', 'jpg', Date.now() - 100000);
    write(L, 'shoot/day1/notes.txt', 'txt', Date.now() - 100000);
    await runPair(makeJob(L, R, { compare: { includeFilter: '*.jpg' } }));
    ok(exists(R, 'shoot/day1/a.jpg'), 'e2e: the nested .jpg is synchronized');
    ok(!exists(R, 'shoot/day1/notes.txt'), 'e2e: the .txt is not');
  }

  // (b) An unreadable directory is a FATAL comparison error, and the healthy
  // side's items must not be fabricated into one-sided rows (=> deletions).
  {
    const { L, R } = scratch();
    write(L, 'boom/precious.mov', 'data');
    write(R, 'boom/precious.mov', 'data');
    const fsx = new NativeFs();
    const bad = Object.create(fsx);
    bad.readdir = p => p.endsWith('boom')
      ? Promise.reject(new Error('EACCES: permission denied'))
      : NativeFs.prototype.readdir.call(fsx, p);
    const c = new Comparer({ left: { fs: bad, path: L }, right: { fs: fsx, path: R }, config: {} });
    const res = await c.run();
    ok(res.errors.some(e => e.fatal), 'an unreadable folder is a fatal error');
    ok(!res.nodes.some(n => n.rel === 'boom/precious.mov'),
       'and nothing under it is reported one-sided');
  }

  // (c) Synchronizing on top of a fatal comparison error is refused.
  {
    const { L, R } = scratch();
    write(L, 'a.txt', 'a');
    const s = new Session();
    const job = makeJob(L, R, {});
    await s.compare(job, { token: {} });
    s.errors.push({ path: L, message: 'permission denied', fatal: true });
    let threw = null;
    try { await s.sync(job, { token: {}, appVersion: 'test' }); } catch (e) { threw = e; }
    ok(threw && /could not read/i.test(threw.message), 'sync refuses a broken comparison');
    await s.close();
  }

  // (d) stat() reports "absent" only for a genuinely absent item.
  {
    const fsx = new NativeFs();
    eq(await fsx.stat(path.join(ROOT, 'definitely-not-there')), null, 'missing item -> null');
  }

  // (e) Two way: a file identical on both sides but unknown to (or stale in)
  // the database is IN SYNC — never an unresolvable "both sides changed".
  {
    const { L, R } = scratch();
    const t0 = Date.now() - 300000;
    write(L, 'a.txt', 'a', t0);
    await runPair(makeJob(L, R, { sync: { variant: 'twoWay' } }));
    // Same file appears identically on both sides, outside syncto's back.
    write(L, 'both.txt', 'same', t0);
    write(R, 'both.txt', 'same', t0);
    const s = new Session();
    await s.compare(makeJob(L, R, { sync: { variant: 'twoWay' } }), { token: {} });
    const n = s.nodes.find(x => x.rel === 'both.txt');
    eq(n.op, OP.NONE, 'identical both sides + no db entry = in sync');
    eq(s.stats.conflicts, 0, 'no conflict is raised');
    await s.close();
  }

  // (f) Folder mtimes drift (creating files touches them) — a two-way rerun
  // must not flag folders as out of sync.
  {
    const { L, R } = scratch();
    const t0 = Date.now() - 300000;
    write(L, 'sub/a.txt', 'a', t0);
    await runPair(makeJob(L, R, { sync: { variant: 'twoWay' } }));
    fs.utimesSync(path.join(L, 'sub'), new Date(t0 - 5000000), new Date(t0 - 5000000));
    fs.utimesSync(path.join(R, 'sub'), new Date(t0 + 5000000), new Date(t0 + 5000000));
    const s = new Session();
    await s.compare(makeJob(L, R, { sync: { variant: 'twoWay' } }), { token: {} });
    eq(s.stats.conflicts, 0, 'folder mtime drift is not a conflict');
    await s.close();
  }

  // (g) Cancellation resolves cleanly: what was done is returned and the
  // database is still written — the next run must not re-discover it all.
  {
    const { L, R } = scratch();
    write(L, 'a.txt', 'a', Date.now() - 100000);
    const s = new Session();
    const job = makeJob(L, R, { sync: { variant: 'twoWay' } });
    const token = { cancelled: false, paused: false };
    await s.compare(job, { token });
    token.cancelled = true;
    const res = await s.sync(job, { token, appVersion: 'test' });
    ok(res.cancelled === true, 'a cancelled run resolves instead of rejecting');
    ok(!!res.dbStamp, 'and the database is still written');
    await s.close();
  }

  // (h) Legacy jobs: the removed Pro level maps to Secure (its closest kin),
  // never silently down to Fast; UI-less versioning falls back to the trash.
  {
    const j1 = migrateJob({ sync: { copyLevel: 'pro' } });
    eq(j1.sync.copyLevel, 'secure', "legacy copyLevel 'pro' becomes 'secure'");
    const j2 = migrateJob({ sync: { deletion: 'versioning' } });
    eq(j2.sync.deletion, 'recycler', 'versioning with no revision folder falls back to the trash');
    const j3 = migrateJob({ sync: { deletion: 'versioning', versioning: { leftFolder: '/rev' } } });
    eq(j3.sync.deletion, 'versioning', 'but a configured revision folder is honoured');
  }

  // (i) OS litter must not keep a "visually empty" folder alive.
  {
    const { L, R } = scratch();
    write(R, 'old/x.txt', 'x');
    write(R, 'old/.DS_Store', 'junk');
    fs.unlinkSync(path.join(R, 'old/x.txt'));       // only litter remains
    await runPair(makeJob(L, R, {}));               // mirror: 'old' must go
    ok(!exists(R, 'old'), 'a folder holding only .DS_Store is deleted');
  }

  // (j) Overwriting a symlink works even with permanent deletion (nothing is
  // archived, so the old link must be explicitly replaced). Skipped where the
  // OS forbids creating symlinks (Windows without developer mode).
  {
    const { L, R } = scratch();
    const t0 = Date.now();
    let canLink = true;
    try {
      fs.symlinkSync('/tmp/new-target', path.join(L, 'link'));
      fs.symlinkSync('/tmp/old-target', path.join(R, 'link'));
    } catch (_) { canLink = false; }
    if (canLink) {
      fs.lutimesSync(path.join(L, 'link'), new Date(t0), new Date(t0));
      fs.lutimesSync(path.join(R, 'link'), new Date(t0 - 600000), new Date(t0 - 600000));
      const { run } = await runPair(makeJob(L, R, { compare: { symlinks: 'asLink' } }));
      eq(run.errors.length, 0, 'symlink overwrite reports no error');
      eq(fs.readlinkSync(path.join(R, 'link')), '/tmp/new-target', 'and the link now points to the new target');
    } else {
      ok(true, 'symlink overwrite skipped (symlinks not permitted here)');
      ok(true, 'symlink overwrite skipped (symlinks not permitted here)');
    }
  }

  // (k) Two names differing only by case: flagged, no crash. (0.8.8) Neither
  //     is synchronized any more: "the first one wins" paired whichever one
  //     readdir listed first with the other side's file.
  // Only meaningful on a case-SENSITIVE filesystem — on APFS or NTFS the two
  // writes land in the same file and there is nothing to collide.
  {
    const { L, R } = scratch();
    write(L, 'File.txt', 'A');
    const caseInsensitive = fs.existsSync(path.join(L, 'FILE.TXT'));
    if (caseInsensitive) {
      ok(true, 'case collision skipped (case-insensitive filesystem)');
      ok(true, 'case collision skipped (case-insensitive filesystem)');
    } else {
      write(L, 'file.txt', 'B');
      const s = new Session();
      const cmp = await s.compare(makeJob(L, R, {}), { token: {} });
      ok(cmp.errors.some(e => /upper\/lower case/i.test(e.message)), 'case collision is reported');
      eq(s.nodes.filter(n => n.rel.toLowerCase() === 'file.txt').length, 0, 'and neither name is synchronized');
      await s.close();
    }
  }

  // (l) The checksum sidecar accumulates across runs instead of being reduced
  // to whatever the latest run copied.
  {
    const { L, R } = scratch();
    const t0 = Date.now() - 100000;
    write(L, 'a.txt', 'aaa', t0);
    const jobOpts = { sync: { copyLevel: 'secure', writeChecksumList: true } };
    await runPair(makeJob(L, R, jobOpts));
    write(L, 'b.txt', 'bbb', t0);
    await runPair(makeJob(L, R, jobOpts));
    const list = read(R, 'syncto-checksums.txt') || '';
    ok(list.includes('a.txt') && list.includes('b.txt'),
       'the sidecar keeps earlier entries when later runs add more');
  }

  // (m) Errors are not counted twice by the multi-pair aggregation. The
  //     failure has to be a per-FILE one: a configuration problem such as a
  //     missing recycle bin is now settled for the whole job before the run
  //     starts, so it never reaches the per-pair accounting.
  {
    const { dir } = scratch();
    const made = [];
    const mk = name => {
      const l = path.join(dir, name + 'L'), r = path.join(dir, name + 'R');
      fs.mkdirSync(l, { recursive: true }); fs.mkdirSync(r, { recursive: true });
      write(l, 'gone.txt', 'x');
      made.push(path.join(l, 'gone.txt'));
      return { left: l, right: r };
    };
    const job = makeJob('', '', { sync: { deletion: 'permanent', retryCount: 0 } });
    job.pairs = [mk('p1'), mk('p2')];
    const ms = new MultiSession();
    await ms.compare(job, { token: {} });
    for (const f of made) fs.rmSync(f);        // vanishes between compare and sync
    const res = await ms.sync(job, { token: {}, appVersion: 'test' });
    eq(res.counters.errors, res.errors.length, 'counters.errors equals the error list length');
    eq(res.errors.length, 2, 'one error per pair, not two');
    await ms.close();
  }

  // (n) MultiSession exposes visibleIndices with globalized indices.
  {
    const { dir } = scratch();
    const l1 = path.join(dir, 'aL'), r1 = path.join(dir, 'aR');
    const l2 = path.join(dir, 'bL'), r2 = path.join(dir, 'bR');
    for (const d of [l1, r1, l2, r2]) fs.mkdirSync(d, { recursive: true });
    write(l1, 'one.txt', '1'); write(l2, 'two.txt', '2');
    const job = makeJob('', '', {});
    job.pairs = [{ left: l1, right: r1 }, { left: l2, right: r2 }];
    const ms = new MultiSession();
    await ms.compare(job, { token: {} });
    const vis = ms.visibleIndices({ showEqual: true, showExcluded: true });
    eq(vis.length, 2, 'one visible row per pair');
    ok(vis.some(i => i >= 1000000), 'indices of the second pair are globalized');
    await ms.close();
  }

  // (o) A database entry hidden by the current filter keeps its history.
  {
    const { L, R } = scratch();
    const t0 = Date.now() - 300000;
    write(L, 'keep.txt', 'k', t0);
    write(L, 'hide.txt', 'h', t0);
    await runPair(makeJob(L, R, { sync: { variant: 'twoWay' } }));
    await runPair(makeJob(L, R, { sync: { variant: 'twoWay' }, compare: { excludeFilter: 'hide.txt' } }));
    const fsx = new NativeFs();
    const doc = await readDb(fsx, L);
    const sess = doc.sessions[pairIdFor(null, L, R)];
    ok(sess && sess.items['hide.txt'], 'the filtered-out entry survives in the database');
  }

  // (p) A folder that does not exist yet is CREATED and locked, not skipped:
  // two machines starting their first backup into the same new share both used
  // to run unprotected. syncto's transient "Delete.N." takeover names stay
  // invisible to the comparison.
  {
    const fsx = new NativeFs();
    const fresh = path.join(ROOT, 'not-yet-created');
    const set = await acquireAll([{ fs: fsx, path: fresh }], {});
    eq(set.count, 1, 'a folder that does not exist yet is created and locked');
    ok(await fsx.exists(path.join(fresh, '.syncto.lock')), 'the lock file is really there');
    await set.release();
    ok(!(await fsx.exists(path.join(fresh, '.syncto.lock'))), 'and it is gone after release');
    ok(isSyncToInternal('Delete.0..syncto.lock'), 'a lock being taken over is internal litter');
    ok(!isSyncToInternal('Delete.0.notes'), 'but a user file named Delete.0.notes is not');
  }
}

// ══ 16. Audit fixes — 0.2.5 ════════════════════════════════════════════════
// One case per data-loss or silent-failure bug found in the 0.2.4 audit.
// Each of these failed on 0.2.4.

// Compare and synchronize as two separate steps, so a test can change the
// folders in between — which is exactly what several of these bugs need.
async function stepped(job, between, opts) {
  const s = new Session();
  const token = { cancelled: false, paused: false };
  const cmp = await s.compare(job, { token });
  if (between) await between(s);
  let run = null, error = null;
  try { run = await s.sync(job, Object.assign({ token, appVersion: 'test' }, opts || {})); }
  catch (err) { error = err; }
  await s.close();
  return { s, cmp, run, error };
}

// Moves an item into <dir>/.trash — the shape SyncRunner expects of trashItem.
function makeTrash(dir) {
  const bin = path.join(dir, '.trash');
  return {
    bin,
    fn: async (fsx, abs) => {
      fs.mkdirSync(bin, { recursive: true });
      fs.renameSync(abs, path.join(bin, path.basename(abs)));
      return true;
    },
  };
}

async function testAuditFixes() {
  console.log('\n\n16. Audit fixes (0.2.5)');

  // (a) THE one. An unmounted source reads as an empty folder, and an empty
  //     folder plus a mirror is "delete everything on the other side". The
  //     comparison said so out loud — without marking it fatal.
  {
    const { L, R } = scratch();
    write(R, 'a.mov', 'keep'); write(R, 'sub/b.mov', 'keep');
    fs.rmSync(L, { recursive: true, force: true });
    const { run, error } = await stepped(makeJob(L, R, { sync: { variant: 'mirror' } }));
    ok(!run, 'a missing source folder does not run a mirror');
    ok(error && /not there/i.test(error.message), 'and says which side is missing');
    ok(exists(R, 'a.mov') && exists(R, 'sub/b.mov'), 'the healthy side is untouched');
  }

  // (b) The same guard must not block the legitimate case: a target that does
  //     not exist yet is created, not treated as a catastrophe.
  {
    const { L, R } = scratch();
    write(L, 'a.mov', 'data');
    fs.rmSync(R, { recursive: true, force: true });
    const { run, error } = await stepped(makeJob(L, R, { sync: { variant: 'mirror' } }));
    ok(!error, 'a missing target folder still synchronizes');
    ok(run && read(R, 'a.mov') === 'data', 'and the file lands in it');
  }

  // (c) Overwriting is deleting, with a copy on top. Versioning configured on
  //     one side only used to throw when DELETING and shrug when OVERWRITING,
  //     so the replaced version was destroyed with "keep every version" on.
  {
    const { dir, L, R } = scratch();
    write(L, 'a.mov', 'NEW', Date.now());
    write(R, 'a.mov', 'OLD', Date.now() - 86400000);
    const { run, error } = await stepped(makeJob(L, R, {
      sync: { variant: 'mirror', deletion: 'versioning',
              versioning: { leftFolder: path.join(dir, 'rev-left'), rightFolder: '' } },
    }));
    ok(!error, 'the run itself completes');
    eq(read(R, 'a.mov'), 'OLD', 'the version that could not be archived is NOT replaced');
    ok(run && run.errors.some(e => /revision folder/i.test(e.message)),
       'and the refusal is reported as an error');
  }

  // (d) Same rule for the recycle bin: no bin here (and no permanent
  //     fallback) means the previous version cannot be kept, so do not replace
  //     it. Since 0.3.1 this is settled BEFORE the run rather than file by
  //     file during it — see section 19.
  {
    const { L, R } = scratch();
    write(L, 'a.mov', 'NEW', Date.now());
    write(R, 'a.mov', 'OLD', Date.now() - 86400000);
    const { run, error } = await stepped(makeJob(L, R, {
      sync: { variant: 'mirror', deletion: 'recycler', permanentFallback: false },
    }));
    eq(read(R, 'a.mov'), 'OLD', 'no recycle bin: the old version stays put');
    ok(!run, 'the run does not start at all');
    ok(error && /recycle bin/i.test(error.message), 'and the reason is reported');
  }

  // (e) preserveTimes off recorded the SOURCE date as the target's, so every
  //     later run saw a change on both sides and bounced the file forever.
  {
    const { L, R } = scratch();
    write(L, 'a.mov', 'data', Date.now() - 7 * 86400000);
    const job = makeJob(L, R, { sync: { variant: 'twoWay', preserveTimes: false } });
    const first = await runPair(job);
    eq(first.run.counters.files, 1, 'first run copies the file');
    const second = await runPair(job);
    eq(second.run.counters.files, 0, 'the second run has nothing to copy');
    eq(second.cmp.stats.updateLeft + second.cmp.stats.updateRight, 0,
       'and nothing to update in either direction');
  }

  // (f) A comparison that was interrupted is not a comparison. It used to be
  //     stamped as complete, which re-armed SYNCHRONIZE on a partial plan.
  {
    const { L, R } = scratch();
    write(L, 'a.mov', 'data');
    const s = new Session();
    const token = { cancelled: true, paused: false };
    const cmp = await s.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token });
    ok(cmp.cancelled, 'a cancelled comparison says so');
    eq(s.comparedAt, 0, 'and is not stamped as compared');
    let threw = false;
    try { await s.sync(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: { cancelled: false }, appVersion: 'test' }); }
    catch (_) { threw = true; }
    ok(threw, 'synchronizing on top of it is refused');
    await s.close();
  }

  // (g) "Ignore errors" was declared, persisted, passed to the engine and read
  //     nowhere: the run always carried on. Off, it must stop at the first one.
  {
    const { L, R } = scratch();
    write(L, 'a.mov', 'one'); write(L, 'b.mov', 'two'); write(L, 'c.mov', 'three');
    const vanish = () => fs.rmSync(path.join(L, 'a.mov'));
    const stop = await stepped(makeJob(L, R, { sync: { variant: 'mirror', ignoreErrors: false } }), vanish);
    ok(stop.run && stop.run.stopped, 'with "ignore errors" off the run stops');
    eq(stop.run.counters.files, 0, 'and copies nothing after the failure');

    const { L: L2, R: R2 } = scratch();
    write(L2, 'a.mov', 'one'); write(L2, 'b.mov', 'two'); write(L2, 'c.mov', 'three');
    const go = await stepped(makeJob(L2, R2, { sync: { variant: 'mirror', ignoreErrors: true } }),
      () => fs.rmSync(path.join(L2, 'a.mov')));
    ok(!go.run.stopped, 'with it on the run carries on');
    eq(go.run.counters.files, 2, 'the two healthy files are copied');
    // (h) A failed copy is not a copy. It used to be counted as one, so the
    //     report read "Files copied: 3 · Errors: 1".
    eq(go.run.counters.failed, 1, 'and the failure is counted separately');
  }

  // (i) A database that could not be written is an ERROR, not a note: the next
  //     two-way run reads yesterday's state and resurrects deleted files.
  {
    const { L, R } = scratch();
    write(L, 'a.mov', 'data');
    fs.mkdirSync(path.join(R, '.syncto.db'));            // a directory: unwritable as a file
    const { run } = await stepped(makeJob(L, R, { sync: { variant: 'twoWay' } }));
    ok(run.errors.some(e => /database could not be written/i.test(e.message)),
       'a failed database write is reported as an error');
    ok(run.counters.errors > 0, 'and counted, so the summary cannot say "successful"');
  }

  // (j) The database is rewritten in place; a crash mid-write used to destroy
  //     the history of EVERY pair sharing that base folder. Write then rename.
  {
    const { L, R } = scratch();
    write(L, 'a.mov', 'data');
    fs.mkdirSync(path.join(R, '.syncto.db'));
    await stepped(makeJob(L, R, { sync: { variant: 'twoWay' } }));
    ok(!exists(R, '.syncto.db.syncto_tmp'), 'a failed database write leaves no temporary file');
    ok(exists(L, '.syncto.db'), 'and the side that succeeded keeps a real database');
    const { readDb } = require('../src/main/core/db');
    const doc = await readDb(new NativeFs(), L);
    ok(doc && doc.sessions, 'which is still readable');
  }

  // (k) Deleting a folder through the recycle bin took its whole contents —
  //     including the files the hard filter was hiding on purpose.
  {
    const { dir, L, R } = scratch();
    write(R, 'old/a.txt', 'go');
    write(R, 'old/keep.bak', 'excluded on purpose');
    const trash = makeTrash(dir);
    const { run } = await stepped(
      makeJob(L, R, { sync: { variant: 'mirror', deletion: 'recycler' }, compare: { excludeFilter: '*.bak' } }),
      null, { trashItem: trash.fn });
    ok(exists(R, 'old/keep.bak'), 'the excluded file survives');
    ok(run.errors.length > 0, 'and the folder removal fails loudly instead');
  }

  // (l) A .syncto_tmp left by a killed run was invisible to the comparison and
  //     removed by nothing — 180 GB could sit on a NAS for ever.
  {
    const { L, R } = scratch();
    write(L, 'a.mov', 'data');
    write(R, 'ghost.mov.syncto_tmp', 'x'.repeat(1000));
    const { run } = await stepped(makeJob(L, R, { sync: { variant: 'mirror' } }));
    ok(!exists(R, 'ghost.mov.syncto_tmp'), 'the leftover from an interrupted run is swept');
    ok(run.notes.some(n => /leftover temporary file/i.test(n)), 'and the sweep is reported');
  }

  // (m) The soft filter judged a two-sided file on the LEFT copy alone, so a
  //     file edited yesterday on the right was dropped because the left copy
  //     was old.
  {
    const { L, R } = scratch();
    const old = Date.now() - 400 * 86400000;
    write(L, 'contract.pdf', 'old', old);
    write(R, 'contract.pdf', 'edited yesterday', Date.now() - 86400000);
    const s = new Session();
    const cmp = await s.compare(
      makeJob(L, R, { sync: { variant: 'twoWay' }, compare: { softFilter: { timeUnit: 'lastDays', timeValue: 7 } } }),
      { token: { cancelled: false } });
    const node = s.nodes.find(n => n.rel === 'contract.pdf');
    ok(node && node.active, 'a recent change on either side keeps the row active');
    eq(cmp.stats.excluded, 0, 'so it is not silently counted as excluded');
    await s.close();
  }

  // (n) The plan belongs to the folders that were COMPARED. Swapping the sides
  //     and pressing SYNCHRONIZE replayed the old plan against the new labels.
  {
    const { L, R } = scratch();
    write(L, 'a.mov', 'left'); write(R, 'b.mov', 'right');
    const m = new MultiSession();
    const job = makeJob(L, R, { sync: { variant: 'mirror' } });
    job.pairs = [{ left: L, right: R }];
    await m.compare(job, { token: { cancelled: false } });
    const swapped = makeJob(R, L, { sync: { variant: 'mirror' } });
    swapped.pairs = [{ left: R, right: L }];
    let threw = false;
    try { await m.sync(swapped, { token: { cancelled: false }, appVersion: 'test' }); }
    catch (err) { threw = /changed since the last comparison/i.test(err.message); }
    ok(threw, 'synchronizing after a swap without re-comparing is refused');
    ok(exists(R, 'b.mov'), 'and nothing was deleted on the swapped side');
    await m.close();
  }

  // (o) A hostname is not an identity. Two machines cloned from one image
  //     shared "host + user", so each read the other's LIVE lock, found no
  //     such process locally, and took the folder.
  {
    const mine = localLockInfo();
    const twin = Object.assign({}, mine, { installId: 'ffffffffffffffffffffffffffffffff', processId: 999999 });
    eq(processStatus(twin, mine), 'unknown', 'a same-name machine with another install id is not us');
    const legacy = Object.assign({}, mine, { processId: 999999 });
    delete legacy.installId;
    eq(processStatus(legacy, mine), 'unknown', 'a lock from an older version is not assumed to be ours either');
    const ours = Object.assign({}, mine, { processId: 999999, sessionId: 1 });
    eq(processStatus(ours, mine), 'notRunning', 'but our own dead process still shortcuts the wait');
  }

  // (p) renameStrict must LOSE when the target exists — the lock takeover is
  //     built on it. POSIX rename overwrites silently, so both machines won.
  {
    const { dir } = scratch();
    const fsx = new NativeFs();
    const a = write(dir, 'a', 'A'), b = write(dir, 'b', 'B');
    let threw = false;
    try { await fsx.renameStrict(a, b); } catch (err) { threw = err.code === 'EEXIST'; }
    ok(threw, 'renameStrict refuses an existing target');
    eq(fs.readFileSync(b, 'utf8'), 'B', 'and leaves it untouched');
    const c = path.join(dir, 'c');
    await fsx.renameStrict(a, c);
    ok(fs.existsSync(c) && !fs.existsSync(a), 'a free target still works');
  }

  // (q) A job file may be hand-edited or produced by another tool. A null
  //     section used to blow up halfway through redrawing the window.
  {
    const { dir } = scratch();
    const p = path.join(dir, 'broken.syncto');
    fs.writeFileSync(p, JSON.stringify({ format: 'syncto-job', compare: null, sync: 'nope', pairs: [] }));
    const { loadJob } = require('../src/main/config');
    const job = loadJob(p);
    ok(job.compare && typeof job.compare === 'object', 'a null section falls back to the default');
    ok(job.sync && typeof job.sync.variant === 'string', 'so does a section of the wrong type');
    ok(Array.isArray(job.pairs) && job.pairs.length === 1, 'and an empty pair list gets one blank pair');
  }

  // (r) Each side keeps the spelling it really has on disk. Building the
  //     destination path from the source spelling is how an accented file ends
  //     up duplicated on a server that stores names byte for byte.
  {
    const { L, R } = scratch();
    const nfd = 'Café.txt', nfc = 'Café.txt';
    write(L, nfd, 'new', Date.now());
    write(R, nfc, 'old', Date.now() - 86400000);
    const s = new Session();
    await s.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: { cancelled: false } });
    const node = s.nodes[0];
    ok(s.nodes.length === 1, 'the two spellings are one item, not two');
    // Read the way the engine reads them: a side stores its own spelling only
    // when it DIFFERS from the key (0.8.0 — three copies of every path in
    // memory was 100 MB on a large job), and relOn() falls back to the key.
    const { SyncRunner } = require('../src/main/core/sync');
    const relOn = SyncRunner.prototype.relOn;
    eq(relOn(node, 'left'), nfd, 'the left path keeps the decomposed spelling');
    eq(relOn(node, 'right'), nfc, 'the right path keeps the composed one');
    eq(node.rel, nfc, 'and the key is the composed form, whichever side exists');
    eq(node.relR, null, 'the side that spells it like the key stores nothing');
    await s.close();
  }
}

// ══ 17. Interface — 0.2.6 ══════════════════════════════════════════════════
async function testOverviewAndShowEqual() {
  console.log('\n\n17. Overview and "show identical" (0.2.6)');

  // (a) Two folders already in sync: zone 2 has nothing to say. It used to
  //     list every top-level folder with a percentage bar, describing work
  //     that did not exist.
  {
    const { L, R } = scratch();
    const t = Date.now() - 86400000;
    write(L, 'Rushes/A001.mov', 'same', t); write(R, 'Rushes/A001.mov', 'same', t);
    write(L, 'Audio/mix.wav', 'same', t);   write(R, 'Audio/mix.wav', 'same', t);
    const s = new Session();
    await s.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: { cancelled: false } });
    const ov = s.overview();
    eq(ov.rows.length, 0, 'identical folders produce an empty overview');
    ok(ov.identical, 'and say so explicitly');
    eq(ov.totalBytes, 0, 'with no bytes to account for');

    // The switch opts back into the full tree, for navigation.
    const full = s.overview({ showEqual: true });
    eq(full.rows.length, 2, '"show identical" lists the folders again');
    await s.close();
  }

  // (b) One changed file: only its folder shows, and the size is the data
  //     that will really cross — not the size of everything already there.
  {
    const { L, R } = scratch();
    const t = Date.now() - 86400000;
    write(L, 'Rushes/A001.mov', 'x'.repeat(500), t);
    write(R, 'Rushes/A001.mov', 'x'.repeat(500), t);
    write(L, 'Rushes/A002.mov', 'y'.repeat(120), Date.now());
    write(L, 'Audio/mix.wav', 'same', t); write(R, 'Audio/mix.wav', 'same', t);
    const s = new Session();
    await s.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: { cancelled: false } });
    const ov = s.overview();
    eq(ov.rows.length, 1, 'only the folder with work appears');
    eq(ov.rows[0].name, 'Rushes', 'and it is the right one');
    eq(ov.rows[0].items, 1, 'counting only the item that moves');
    eq(ov.rows[0].bytes, 120, 'and only the bytes that will cross');
    await s.close();
  }

  // (c) Deletions are work too, even though they transfer nothing.
  {
    const { L, R } = scratch();
    write(R, 'Old/stale.mov', 'gone');
    const s = new Session();
    await s.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: { cancelled: false } });
    const ov = s.overview();
    eq(ov.rows.length, 1, 'a folder that will be emptied still appears');
    eq(ov.rows[0].bytes, 0, 'with no bytes, because a deletion moves nothing');
    await s.close();
  }

  // (d) Filtering on the "identical" chip must show those rows WITHOUT the
  //     window switching "show identical" on — that flag was then written to
  //     the preferences and came back ticked at every launch.
  {
    const { L, R } = scratch();
    const t = Date.now() - 86400000;
    write(L, 'same.txt', 'x', t); write(R, 'same.txt', 'x', t);
    write(L, 'new.txt', 'y', Date.now());
    const s = new Session();
    await s.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: { cancelled: false } });
    eq(s.rows(0, 50, { showEqual: false }).total, 1, 'by default only the row with work is listed');
    const onlyEqual = s.rows(0, 50, { showEqual: false, onlyOperation: 'none' });
    eq(onlyEqual.total, 1, 'filtering on "identical" reveals the identical row');
    eq(onlyEqual.rows[0].rel, 'same.txt', 'and it is the identical one');
    await s.close();
  }

  // (f) Clicking a folder in the overview scopes the grid to it. Every row
  //     the overview lists is a TOP-LEVEL entry of its own pair — with two
  //     pairs merged into one list, that was impossible to tell.
  {
    const { L, R } = scratch();
    write(L, 'Rushes/A001/clip.mov', 'a');
    write(L, 'Rushes/A002/clip.mov', 'b');
    write(L, 'Docs/notes.txt', 'c');
    const s = new Session();
    await s.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: { cancelled: false } });
    const wide = s.rows(0, 200, {}).total;
    const scoped = s.rows(0, 200, { scope: { rel: 'Rushes' } });
    ok(scoped.total < wide, 'a scope shows fewer rows than the whole tree');
    ok(scoped.rows.every(r => r.rel === 'Rushes' || r.rel.startsWith('Rushes/')),
       'and only rows inside the folder that was clicked');
    ok(scoped.rows.some(r => r.rel === 'Rushes/A001/clip.mov'),
       'including the ones nested deeper inside it');
    ok(!scoped.rows.some(r => r.rel.startsWith('Docs')), 'a sibling folder is left out');
    // A name that is a prefix of another must not drag it in.
    write(L, 'Rush/other.txt', 'd');
    const s2 = new Session();
    await s2.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: { cancelled: false } });
    const tight = s2.rows(0, 200, { scope: { rel: 'Rush' } });
    ok(tight.rows.every(r => !r.rel.startsWith('Rushes')), '"Rush" does not also match "Rushes"');
    await s.close(); await s2.close();
  }

  // (e) The preferences carry a revision, so the value the old bug stored is
  //     cleared once instead of following the user around for ever.
  {
    const { dir } = scratch();
    const { Prefs } = require('../src/main/config');
    const p = new Prefs(dir);
    fs.writeFileSync(path.join(dir, 'preferences.json'),
      JSON.stringify({ ui: { showEqual: true }, recent: [{ name: 'keep', path: '/tmp/x' }] }));
    p.load();
    eq(p.data.ui.showEqual, false, 'a pre-0.2.6 "show identical" is cleared on upgrade');
    eq(p.data.recent.length, 1, 'and the rest of the preferences survive');
    p.data.ui.showEqual = true;
    p.save();
    const again = new Prefs(dir);
    again.load();
    eq(again.data.ui.showEqual, true, 'a value set deliberately afterwards is kept');
  }
}

// ══ 18. Servers and credentials — 0.2.7 ═══════════════════════════════════
function testServers() {
  console.log('\n\n18. Servers and credentials (0.2.7)');
  const { migratePrefs, credentialMap, Prefs } = require('../src/main/config');
  const { RemoteBrowser } = require('../src/main/fs/browse');
  const { parseLocation } = require('../src/main/fs/afs');
  const secrets = require('../src/main/secrets');

  // Outside Electron there is no OS credential store, and the code must know
  // it. That is the whole point of the fallback: refuse to remember, never
  // downgrade to writing the password in the clear.
  ok(!secrets.available(), 'no credential store outside Electron, and the code knows it');
  eq(secrets.encrypt('hunter2'), null, 'so encrypt() refuses rather than returning plain text');

  // (a) A 0.2.6 preferences file carried the password in plain text under
  //     sftp["user@host"]. Upgrading turns it into a named server AND leaves
  //     nothing readable behind.
  {
    const raw = {
      ui: { showEqual: true },
      sftp: { 'arnaud@192.168.1.50': { username: 'arnaud', password: 'hunter2', passphrase: 'secret-phrase' } },
    };
    const out = migratePrefs(JSON.parse(JSON.stringify(raw)));
    const text = JSON.stringify(out);
    ok(!text.includes('hunter2'), 'the old plain-text password does not survive the migration');
    ok(!text.includes('secret-phrase'), 'nor does the passphrase');
    eq(out.sftp, undefined, 'the flat credential map is gone');
    eq(out.servers.length, 1, 'and it became one named server');
    eq(out.servers[0].username, 'arnaud', 'with the login kept');
    eq(out.servers[0].host, '192.168.1.50', 'and the host kept');
    eq(out.revision, 2, 'stamped with the preferences revision');
  }

  // (b) A `password` key must not survive a write, whoever put it there — an
  //     older build, a hand edit, a restored backup, or the renderer.
  {
    const { dir } = scratch();
    const p = new Prefs(dir);
    p.load();
    p.data.servers = [{ id: 'x', name: 'NAS', host: '10.0.0.8', port: 22,
                        username: 'dit', password: 'plain-text-leak' }];
    p.save();
    const onDisk = fs.readFileSync(path.join(dir, 'preferences.json'), 'utf8');
    ok(!onDisk.includes('plain-text-leak'), 'a password set on the object never reaches the file');
    ok(onDisk.includes('10.0.0.8'), 'while the rest of the entry is stored normally');
  }

  // (c) The engine still receives what it expects: a map keyed by user@host.
  {
    const map = credentialMap([
      { host: 'nas.local', username: 'arnaud', port: 22 },
      { host: '10.0.0.8', username: 'dit', port: 2222 },
      { host: '', username: 'nobody' },                      // incomplete: skipped
    ]);
    // A non-default port gets its own key as well: two servers on the same host
    // and login but different ports have different passwords, and the port-less
    // key can only hold one of them.
    eq(Object.keys(map).sort(),
       ['arnaud@nas.local', 'dit@10.0.0.8', 'dit@10.0.0.8:2222'],
       'keys are user@host, plus user@host:port when the port is not 22');
    eq(map['arnaud@nas.local'].password, '', 'with no password to hand over on this machine');
  }

  // (d) The URL that lands in the folder field must never carry a password —
  //     it is displayed, saved into .syncto job files, and printed in reports.
  {
    const url = RemoteBrowser.urlFor({ host: '192.168.1.50', port: 22, username: 'arnaud' }, '/srv/backup/projets');
    eq(url, 'sftp://arnaud@192.168.1.50/srv/backup/projets', 'the default port is left out');
    eq(RemoteBrowser.urlFor({ host: 'nas.local', port: 2222, username: 'dit' }, '/data'),
       'sftp://dit@nas.local:2222/data', 'a custom port is kept');

    // And the engine parses back exactly what the window produced.
    const loc = parseLocation(url, credentialMap([{ host: '192.168.1.50', username: 'arnaud' }]));
    eq(loc.kind, 'sftp', 'the engine recognises it');
    eq(loc.username, 'arnaud', 'with the right login');
    eq(loc.host, '192.168.1.50', 'the right host');
    eq(loc.port, 22, 'the right port');
    eq(loc.path, '/srv/backup/projets', 'and the right folder');
  }

  // (e) Saving a server twice is an update, not a duplicate: reconnecting to
  //     the same NAS must not grow the list every time.
  {
    const { dir } = scratch();
    const p = new Prefs(dir);
    p.load();
    p.saveServer({ name: 'NAS', host: 'nas.local', port: 22, username: 'arnaud', savePassword: false });
    p.saveServer({ name: 'NAS Montage', host: 'nas.local', port: 22, username: 'arnaud', savePassword: false });
    eq(p.listServers().length, 1, 'the same user@host:port updates its entry');
    eq(p.listServers()[0].name, 'NAS Montage', 'and takes the new name');
    p.saveServer({ name: 'Archives', host: '10.0.0.8', port: 22, username: 'dit', savePassword: false });
    eq(p.listServers().length, 2, 'a different server is a new entry');
    ok(p.listServers().every(s => !('password' in s) && !('passwordEnc' in s)),
       'and the list handed to the window carries no secret at all');
  }
}

// ══ 19. NAS regression — 0.3.1 ════════════════════════════════════════════
// Reported from a real run: mirror to a NAS, 0 files copied, "Stopped at the
// first error". Two 0.2.5 changes combined into a job that could do nothing.
async function testNasRegression() {
  console.log('\n\n19. Recycle bin on a NAS (0.3.1)');

  // A trash that refuses everything: what macOS does on most network shares,
  // while NativeFs.supportsTrash() cheerfully answers "yes" for any local path.
  const deadTrash = async () => false;
  const liveTrash = (dir) => {
    const bin = path.join(dir, '.trash');
    return async (fsx, abs) => {
      fs.mkdirSync(bin, { recursive: true });
      fs.renameSync(abs, path.join(bin, path.basename(abs) + '-' + Math.random().toString(36).slice(2)));
      return true;
    };
  };

  // (a) The whole reported failure: deletions planned on a volume with no
  //     working bin. It must be settled before the run, not discovered on the
  //     first file — and NOTHING must have been touched.
  {
    const { L, R } = scratch();
    write(L, 'keep.mov', 'data');
    write(R, 'keep.mov', 'data');
    write(R, 'stale/CACHE.DAT', 'x');
    const { run, error } = await stepped(
      makeJob(L, R, { sync: { variant: 'mirror', deletion: 'recycler', permanentFallback: false } }),
      null, { trashItem: deadTrash });
    ok(!run, 'the run refuses to start');
    ok(error && /recycle bin does not work/i.test(error.message), 'saying the bin does not work there');
    ok(error && error.message.includes(R), 'and naming the folder');
    ok(error && /Default action/.test(error.message) && /Delete permanently/.test(error.message) &&
       !/delete anyway/i.test(error.message),
       'and naming the setting that fixes it, exactly as it reads on screen — not the switch 0.8.3 removed');
    ok(exists(R, 'stale/CACHE.DAT'), 'nothing was deleted');
    ok(!exists(R, '.syncto.trash-probe'), 'and the probe left nothing behind');
  }

  // (b) The same job with a working bin runs normally — the check must not
  //     block a NAS that does have one.
  {
    const { dir, L, R } = scratch();
    write(L, 'keep.mov', 'data');
    write(R, 'stale.mov', 'x');
    const { run, error } = await stepped(
      makeJob(L, R, { sync: { variant: 'mirror', deletion: 'recycler', permanentFallback: false } }),
      null, { trashItem: liveTrash(dir) });
    ok(!error, 'a working recycle bin is not blocked');
    ok(run && run.counters.files === 1, 'and the copy happens');
    ok(!exists(R, 'stale.mov'), 'with the deletion carried out');
  }

  // (b2) 0.8.3: the fallback is the default and no longer a setting. A disk
  //      with no bin does not stop the run — the confirmation says so first,
  //      and the file is deleted for good.
  {
    const { L, R } = scratch();
    write(L, 'keep.mov', 'data');
    write(R, 'keep.mov', 'data');
    write(R, 'stale.mov', 'x');
    const job = makeJob(L, R, { sync: { variant: 'mirror', deletion: 'recycler' } });
    eq(defaultJob().sync.permanentFallback, true, 'a new job deletes anyway where there is no bin');
    const s = new Session();
    await s.compare(job, { token: {} });
    const pre = await s.preflight(job, { trashItem: deadTrash });
    ok(pre.length === 1 && pre[0].notice && pre[0].noTrash, 'the check before the run returns a notice, not a refusal');
    ok(pre[0] && pre[0].message.includes(R) && /deleted permanently/.test(pre[0].message),
       'naming the folder and what will happen there');
    await s.close();
    const { run, error } = await stepped(job, null, { trashItem: deadTrash });
    ok(!error && run, 'and the run goes ahead');
    ok(!exists(R, 'stale.mov'), 'deleting the stray file permanently');
    ok(!exists(R, '.syncto.trash-probe'), 'with no probe left behind');
  }
  {
    const { L, R } = scratch();
    write(L, 'keep.mov', 'data');
    write(R, 'stale.mov', 'x');
    const job = makeJob(L, R, { sync: { variant: 'mirror', deletion: 'recycler' } });
    const s = new Session();
    await s.compare(job, { token: {} });
    const pre = await s.preflight(job, { trashItem: async () => true });
    eq(pre.length, 0, 'a disk whose bin works gets no notice');
    await s.close();
  }

  // (c) Permanent deletion never needed a bin, so it must not be checked.
  {
    const { L, R } = scratch();
    write(L, 'keep.mov', 'data');
    write(R, 'stale.mov', 'x');
    const { run, error } = await stepped(
      makeJob(L, R, { sync: { variant: 'mirror', deletion: 'permanent' } }),
      null, { trashItem: deadTrash });
    ok(!error && run, 'permanent deletion runs without a recycle bin');
    ok(!exists(R, 'stale.mov'), 'and removes the stray file');
  }

  // (d) A job with nothing to delete or replace is not blocked either: a bin
  //     that does not work only matters when something is going to be lost.
  {
    const { L, R } = scratch();
    write(L, 'new.mov', 'data');
    const { run, error } = await stepped(
      makeJob(L, R, { sync: { variant: 'mirror', deletion: 'recycler', permanentFallback: false } }),
      null, { trashItem: deadTrash });
    ok(!error, 'a pure copy is never blocked by the recycle bin');
    ok(run && run.counters.files === 1, 'and it copies');
  }

  // (e) "Ignore errors" is on by default again. 0.2.5 made the setting real
  //     and left it off, so one unreadable file meant a run that copied
  //     nothing — the wrong trade for a backup tool.
  {
    const { L, R } = scratch();
    write(L, 'a.mov', 'one'); write(L, 'b.mov', 'two'); write(L, 'c.mov', 'three');
    const job = defaultJob();
    job.left = L; job.right = R; job.name = 'test';
    job.sync.variant = 'mirror'; job.sync.deletion = 'permanent';
    job.sync.retryCount = 0;
    eq(job.sync.ignoreErrors, true, 'a new job carries on past a failure by default');
    const res = await stepped(job, () => fs.rmSync(path.join(L, 'a.mov')));
    ok(!res.run.stopped, 'so the run is not stopped by one missing file');
    eq(res.run.counters.files, 2, 'and the healthy files are copied');
  }

  // (f) A job saved before the setting did anything carries a meaningless
  //     `false`. Loading it must not arm "stop at the first error".
  {
    const { dir } = scratch();
    const { loadJob } = require('../src/main/config');
    const p = path.join(dir, 'old.syncto');
    fs.writeFileSync(p, JSON.stringify({
      format: 'syncto-job', pairs: [{ left: '/a', right: '/b' }],
      sync: { variant: 'mirror', ignoreErrors: false },
    }));
    eq(loadJob(p).sync.ignoreErrors, true, 'an old job is not left with the dead default');

    const q = path.join(dir, 'new.syncto');
    fs.writeFileSync(q, JSON.stringify({
      format: 'syncto-job', rev: 1, pairs: [{ left: '/a', right: '/b' }],
      sync: { variant: 'mirror', ignoreErrors: false },
    }));
    eq(loadJob(q).sync.ignoreErrors, false, 'but a deliberate choice made since is kept');
  }
}


// ══ 20. After the run, and phone notifications — 0.4.0 ════════════════════
function testAfterAndNtfy() {
  console.log('\n\n20. After the run and ntfy (0.4.0)');
  const power  = require('../src/main/power');
  const notify = require('../src/main/notify');
  const { Prefs } = require('../src/main/config');

  // (a) The right command on the right system. Asserted rather than run —
  //     a test suite that puts the machine to sleep is not a test suite.
  {
    eq(power.commandFor('sleep', 'darwin').cmd, 'pmset', 'macOS sleeps with pmset');
    eq(power.commandFor('sleep', 'darwin').args, ['sleepnow'], 'and asks for it now');
    eq(power.commandFor('sleep', 'win32').cmd, 'rundll32.exe', 'Windows sleeps through powrprof');
    eq(power.commandFor('shutdown', 'win32').args, ['/s', '/t', '0'], 'and shuts down with no delay');
    // Not `shutdown -h`, which needs root: this is the Apple-menu request, so
    // an app with unsaved work can still refuse.
    ok(/System Events/.test(power.commandFor('shutdown', 'darwin').args[1]),
       'macOS shuts down through System Events, not as root');
    eq(power.commandFor('none', 'darwin'), null, 'doing nothing has no command');
    eq(power.commandFor('quit', 'darwin'), null, 'and quitting is the app is own business');
    ok(!power.ACTIONS.includes('hibernate'),
       'there is no hibernate action — macOS has no such command');
  }

  // (b) The action must NOT fire on a run whose result the user has to read.
  //     The machine would take the summary down with it.
  {
    const clean = { errors: [], counters: { errors: 0 } };
    const cases = [
      [{ errors: [{ message: 'x' }], counters: { errors: 1 } }, 'an error'],
      [{ errors: [], counters: { errors: 0 }, cancelled: true }, 'a cancellation'],
      [{ errors: [], counters: { errors: 0 }, stopped: true }, 'a stop at the first error'],
      [{ errors: [], counters: { errors: 0 }, lockLost: 'x' }, 'a lost folder lock'],
    ];
    // runWasClean lives in the renderer; the rule is asserted here on the same
    // shape the renderer receives, so a change to the result shape breaks it.
    const runWasClean = r => !r.cancelled && !r.stopped && !r.lockLost &&
      !(r.errors && r.errors.length) && !(r.counters && r.counters.errors);
    ok(runWasClean(clean), 'a clean run may trigger the action');
    for (const [res, why] of cases) ok(!runWasClean(res), why + ' blocks the action');
  }

  // (c) Title, Tags and Priority are HTTP HEADER values. One accent or emoji
  //     throws ERR_INVALID_CHAR and loses the WHOLE notification, body
  //     included — the trap ingesto was bitten by.
  {
    eq(notify.headerSafe('Sauvegarde terminée ✓'), 'Sauvegarde termine', 'the title is stripped to ASCII');
    eq(notify.tagsSafe('white_check_mark'), 'white_check_mark', 'a plain tag passes through');
    eq(notify.tagsSafe('✅,warning'), 'warning', 'an emoji tag is dropped, the rest survives');
    eq(notify.tagsSafe(',,x,,'), 'x', 'stray commas are trimmed');
  }

  // (d) The message built for a finished run.
  {
    const okRun = { counters: { files: 12, bytes: 3.4e9, deleted: 2 }, errors: [],
                    durationMs: 95000, verified: 12 };
    const m = notify.forRun(okRun, 'TNAS');
    ok(/TNAS/.test(m.title) && /done/.test(m.title), 'a clean run is titled with the job name');
    ok(/12 files/.test(m.message) && /3.40 GB/.test(m.message), 'with what was copied');
    ok(/1m 35s/.test(m.message), 'and how long it took');
    eq(m.tags, 'white_check_mark', 'tagged as a success');

    const badRun = { counters: { files: 3, bytes: 100 },
                     errors: [{ rel: 'a.mov', message: 'no recycle bin' }], durationMs: 1000 };
    const b = notify.forRun(badRun, 'TNAS');
    ok(/1 error/.test(b.title), 'a failed run says so in the title, where a phone shows it');
    ok(/a.mov/.test(b.message), 'and names the first thing that failed');
    eq(b.tags, 'warning', 'tagged as a problem');
    eq(b.priority, 4, 'and raised in priority so the phone actually rings');

    const cancelled = { counters: {}, errors: [], cancelled: true, durationMs: 0 };
    ok(/cancelled/i.test(notify.forRun(cancelled, 'X').title), 'a cancelled run is not reported as done');
  }

  // (e) An empty topic must not produce a POST to the server root.
  {
    return notify.send({ server: 'https://ntfy.sh', topic: '' }).then(r => {
      ok(!r.ok && /topic/i.test(r.error), 'no topic, no request');
      return notify.send({ server: 'ftp://nope', topic: 't' });
    }).then(r => {
      ok(!r.ok && /http/i.test(r.error), 'and the server address must be http(s)');
    });
  }
}

function testNtfySecrets() {
  console.log('\n\n21. ntfy settings (0.4.0 — token removed in 0.8.3)');
  const { Prefs } = require('../src/main/config');
  const { dir } = scratch();
  const p = new Prefs(dir);
  p.load();

  // A server, a topic, a switch. Nothing else is stored, even if asked to.
  p.saveNtfy({ enabled: true, server: 'https://ntfy.example', topic: 'syncto-abc', token: 'tk_secret_value', onlyOnProblem: true });
  const onDisk = fs.readFileSync(path.join(dir, 'preferences.json'), 'utf8');
  ok(!onDisk.includes('tk_secret_value'), 'a token handed to the settings is not written anywhere');
  ok(!/tokenEnc|onlyOnProblem/.test(onDisk), 'nor the two settings 0.8.3 removed');
  ok(onDisk.includes('syncto-abc'), 'while the topic is stored normally');

  const ui = p.ntfyForUi();
  eq(Object.keys(ui).sort(), ['enabled', 'server', 'topic'], 'the panel gets exactly: on/off, server, topic');
  eq(ui.topic, 'syncto-abc', 'it gets the topic');
  eq(ui.enabled, true, 'and the switch state');

  // What an older version stored is dropped at the next save, not kept with
  // nothing on screen to show or clear it.
  p.data.ntfy.tokenEnc = 'PRETEND-CIPHERTEXT';
  p.data.ntfy.onlyOnProblem = true;
  p.saveNtfy({ topic: 'syncto-def' });
  ok(!('tokenEnc' in p.data.ntfy) && !('onlyOnProblem' in p.data.ntfy), 'an old stored token is removed on the next save');
  p.save({ ntfy: { token: 'readable-token' } });
  ok(!fs.readFileSync(path.join(dir, 'preferences.json'), 'utf8').includes('readable-token'),
     'and no write, from any caller, can put one back');
}


// ══ 22. One copy mode — 0.5.0 ═════════════════════════════════════════════
// syncto used to offer Fast / Verified / Secure. Fast and Verified ended up
// doing exactly the same thing, so two thirds of the choice was between
// identical behaviours with different names — and a user on "Verified" never
// saw a verification phase, because there wasn't one.
async function testSingleCopyMode() {
  console.log('\n\n22. One copy mode (0.5.0)');
  const { algoFor } = require('../src/main/core/hash');
  const { migrateJob, defaultJob } = require('../src/main/config');

  eq(algoFor(), 'xxh64', 'there is one algorithm and it is always used');
  eq(algoFor('fast'), 'xxh64', 'even when an old caller still passes a level');
  eq(defaultJob().sync.copyLevel, 'secure', 'a new job is secure');

  // A job saved when the levels existed must NOT quietly run weaker than the
  // interface now claims.
  eq(migrateJob({ sync: { copyLevel: 'fast' } }).sync.copyLevel, 'secure',
     "an old 'fast' job is pinned to secure on load");
  eq(migrateJob({ sync: { copyLevel: 'verified' } }).sync.copyLevel, 'secure',
     "so is an old 'verified' job");
  eq(migrateJob({ sync: { copyLevel: 'pro' } }).sync.copyLevel, 'secure',
     "and the even older 'pro'");

  // Whatever the file asks for, every run reads back what it wrote.
  for (const asked of ['fast', 'verified', 'secure', undefined]) {
    const { L, R } = scratch();
    write(L, 'a.mov', 'x'.repeat(4096));
    const job = makeJob(L, R, { sync: { variant: 'mirror' } });
    if (asked) job.sync.copyLevel = asked;
    const { run } = await runPair(job);
    eq(run.counters.files, 1, `copyLevel=${asked}: the file is copied`);
    eq(run.verified, 1, `copyLevel=${asked}: and read back and verified`);
    // Written once, read once: the work counter has to see both, or the ring
    // freezes at 50% while the verification runs.
    eq(run.counters.workBytes, 8192, `copyLevel=${asked}: work counts the read-back too`);
  }

  // The checksum list no longer depends on a level that no longer exists.
  {
    const { L, R } = scratch();
    write(L, 'a.mov', 'data');
    const job = makeJob(L, R, { sync: { variant: 'mirror', writeChecksumList: true } });
    delete job.sync.copyLevel;
    await runPair(job);
    ok(exists(R, 'syncto-checksums.txt'), 'the checksum list is written whenever it is asked for');
  }

}


// ══ 23. Audit 0.5.1 — corrections ═════════════════════════════════════════
async function testAudit051() {
  console.log('\n\n23. Audit fixes (0.5.2)');
  const { redactLocation, parseLocation } = require('../src/main/fs/afs');
  const { Prefs, saveJob, defaultJob, migratePrefs, credentialMap } = require('../src/main/config');
  const notify = require('../src/main/notify');

  // (a) A password typed into a folder field reached preferences.json, the
  //     .syncto handed to a colleague, AND the body of the phone notification.
  {
    eq(redactLocation('sftp://arnaud:Hunter2!@nas.local/srv'), 'sftp://arnaud@nas.local/srv',
       'the password is taken out of the address');
    eq(redactLocation('/Volumes/RAID/Project'), '/Volumes/RAID/Project', 'a local path is untouched');
    eq(redactLocation('sftp://arnaud@nas.local/srv'), 'sftp://arnaud@nas.local/srv',
       'an address without one is untouched');

    const { dir } = scratch();
    const p = new Prefs(dir); p.load();
    p.data.job.pairs = [{ left: '/Volumes/CARD', right: 'sftp://arnaud:Hunter2!@nas.local/srv' }];
    p.save();
    const onDisk = fs.readFileSync(path.join(dir, 'preferences.json'), 'utf8');
    ok(!onDisk.includes('Hunter2!'), 'no password reaches preferences.json');
    eq(JSON.parse(onDisk).job.pairs[0].right, 'sftp://arnaud@nas.local/srv',
       'and the stored path keeps working without it');

    const j = defaultJob();
    j.pairs = [{ left: '/a', right: 'sftp://arnaud:Hunter2!@nas.local/srv' }];
    const jf = path.join(dir, 'shared.syncto');
    saveJob(jf, j);
    ok(!fs.readFileSync(jf, 'utf8').includes('Hunter2!'), 'nor the job file meant to be shared');
  }

  // (b) The two sides of a pair with no path made split('/').pop() return
  //     "user:secret@host" — a label that travels into errors and ntfy.
  {
    const { pairLabel } = require('../src/main/core/session');
    const label = pairLabel({ left: 'sftp://arnaud:Hunter2!@nas.local', right: '/tmp/x' });
    ok(!label.includes('Hunter2!'), 'the pair label carries no password');
    ok(label.includes('nas.local'), 'but still names the machine');
    eq(pairLabel({ left: '/Volumes/CARD/', right: '/tmp/x' }), 'CARD → x',
       'a plain pair still reads as its two folder names');
  }

  // (c) Two servers on one host but different ports had one password between
  //     them: the port-less key could only hold the last one.
  {
    const map = credentialMap([
      { host: 'nas.local', username: 'a', port: 22 },
      { host: 'nas.local', username: 'a', port: 2222 },
    ]);
    ok(map['a@nas.local:2222'], 'the non-default port gets its own entry');
    const loc = parseLocation('sftp://a@nas.local:2222/data', map);
    eq(loc.port, 2222, 'and the address on that port finds it');
  }

  // (d) Repointing a saved server at another machine must not carry the old
  //     password to it.
  {
    const { dir } = scratch();
    const p = new Prefs(dir); p.load();
    const saved = p.saveServer({ name: 'NAS', host: 'nas.local', port: 22, username: 'arnaud' });
    const id = saved.server.id;
    p.data.servers[0].passwordEnc = 'CIPHERTEXT-FOR-nas.local';
    p.saveServer({ id, name: 'Other', host: 'evil.example.com', port: 22, username: 'root' });
    eq(p.data.servers[0].passwordEnc, '', 'moving an entry to another host clears its password');
    eq(p.data.servers[0].host, 'evil.example.com', 'while the entry itself follows the edit');
  }

  // (e) A blob this account cannot read is not a remembered password.
  {
    const { dir } = scratch();
    const p = new Prefs(dir); p.load();
    p.saveServer({ name: 'NAS', host: 'nas.local', port: 22, username: 'arnaud' });
    p.data.servers[0].passwordEnc = 'not-decryptable-here';
    eq(p.listServers()[0].hasPassword, false,
       'an unreadable blob is not reported as a stored password');
  }

  // (f) A migration that has to drop credentials says so instead of losing
  //     them in silence.
  {
    const out = migratePrefs({ sftp: { 'arnaud@nas': { username: 'arnaud', password: 'p' } } });
    ok(!JSON.stringify(out).includes('"p"'), 'the plain-text password is gone');
    ok((out.migrationNotes || []).some(n => /credential store/i.test(n)),
       'and the user is told it could not be carried over');
  }

  // (g) A write that never reached the disk must not be reported as saved.
  {
    const { dir } = scratch();
    const p = new Prefs(path.join(dir, 'sub')); p.load();
    fs.writeFileSync(path.join(dir, 'sub'), 'not a directory');   // mkdir will fail
    const r = p.saveServer({ name: 'NAS', host: 'nas.local', port: 22, username: 'a', password: 'x' });
    eq(r.written, false, 'the failed write is reported');
    eq(r.remembered, false, 'and nothing claims the password was remembered');
  }

  // (h) An access token must travel intact or not at all — stripping it to
  //     ASCII produced a 401 nobody could explain.
  {
    return notify.send({ server: 'https://ntfy.sh', topic: 't', token: 'tk_éàAB12' }).then(r => {
      ok(!r.ok && /header/i.test(r.error), 'a token that cannot be a header is refused, not mangled');
    });
  }
}

async function testAudit051Engine() {
  console.log('\n\n24. Audit fixes — engine (0.5.2)');

  // (a) THE one: the lock created the missing base folder before the guard ran,
  //     so the SECOND attempt saw an empty folder instead of a missing one and
  //     planned to delete the whole backup.
  {
    const { dir, L, R } = scratch();
    write(R, 'a.mov', 'keep'); write(R, 'b.mov', 'keep');
    fs.rmSync(L, { recursive: true, force: true });
    const job = makeJob(L, R, { sync: { variant: 'mirror', deletion: 'permanent' } });

    const first = await stepped(job);
    ok(first.error && /not there/i.test(first.error.message), 'attempt 1 refuses');
    ok(!fs.existsSync(L), 'and the missing folder was NOT created by the lock');

    const second = await stepped(job);
    ok(second.error && /not there/i.test(second.error.message), 'attempt 2 refuses in the same way');
    ok(exists(R, 'a.mov') && exists(R, 'b.mov'), 'the backup is still there after both attempts');
  }

  // (b) A folder held back by a filtered file kept its checksum list: the
  //     sweep used to run before rmdir and destroyed the manifest anyway.
  {
    const { dir, L, R } = scratch();
    write(R, 'A001/clip.mov', 'x');
    write(R, 'A001/keep.bak', 'excluded');
    write(R, 'A001/syncto-checksums.txt', 'xxh64\nabc  clip.mov\n');
    const { run } = await stepped(makeJob(L, R, {
      sync: { variant: 'mirror', deletion: 'permanent' },
      compare: { excludeFilter: '*.bak' },
    }));
    ok(exists(R, 'A001/keep.bak'), 'the excluded file survives');
    ok(exists(R, 'A001/syncto-checksums.txt'),
       'and so does the checksum list, in a folder that is not going away');
    ok(run.errors.length > 0, 'the folder removal still fails loudly');
  }

  // (c) An empty folder to remove needed no recycle bin, but the preflight
  //     demanded one and refused the whole run.
  {
    const { L, R } = scratch();
    write(L, 'new.mov', 'data');
    fs.mkdirSync(path.join(R, 'stale'), { recursive: true });
    const { run, error } = await stepped(
      makeJob(L, R, { sync: { variant: 'mirror', deletion: 'recycler', permanentFallback: false } }),
      null, { trashItem: async () => false });
    ok(!error, 'a run whose only removal is a folder is not blocked');
    ok(run && run.counters.files === 1, 'and the copy happens');
  }

  // (d) Two-way went into a permanent conflict as soon as the target refused
  //     to take the source date.
  {
    const { L, R } = scratch();
    write(L, 'a.mov', 'data', Date.now() - 7 * 86400000);
    const job = makeJob(L, R, { sync: { variant: 'twoWay', preserveTimes: false } });
    await runPair(job);
    const second = await runPair(job);
    eq(second.cmp.stats.conflicts, 0, 'the second run is not a conflict');
    const third = await runPair(job);
    eq(third.cmp.stats.conflicts, 0, 'nor the third');
    eq(third.run.counters.files, 0, 'and nothing is copied back and forth');
  }

  // (e) A retry archived the target twice, and the second archive — the
  //     fragment left by the failed attempt — overwrote the good version.
  {
    const { dir, L, R } = scratch();
    const rev = path.join(dir, 'rev');
    write(L, 'a.mov', 'NEW-CONTENT', Date.now());
    write(R, 'a.mov', 'THE-ONLY-GOOD-OLD-VERSION', Date.now() - 86400000);
    const s = new Session();
    const job = makeJob(L, R, {
      sync: { variant: 'mirror', deletion: 'versioning', retryCount: 1,
              versioning: { leftFolder: '', rightFolder: rev, style: 'timestampFolder' } },
    });
    await s.compare(job, { token: { cancelled: false } });
    // Archive twice in a row, exactly as a retry would.
    const { SyncRunner } = require('../src/main/core/sync');
    const runner = new SyncRunner({ left: s.left, right: s.right, nodes: s.nodes,
                                    config: Object.assign({}, job.sync), token: { cancelled: false } });
    const node = s.nodes.find(n => n.rel === 'a.mov');
    await runner.archiveExisting('right', node);
    write(R, 'a.mov', 'TRUNCATED-FRAGMENT');          // what a failed attempt leaves
    await runner.archiveExisting('right', node);      // the retry archives again
    const found = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f); else found.push(fs.readFileSync(f, 'utf8'));
      }
    })(rev);
    ok(found.includes('THE-ONLY-GOOD-OLD-VERSION'), 'the good version is still in the revision store');
    ok(!found.includes('TRUNCATED-FRAGMENT'), 'and the retry did not bury it under its fragment');
    await s.close();
  }

  // (f) The checksum list has to name files the way the filesystem does.
  {
    const { L, R } = scratch();
    const nfd = 'Cafe\u0301.txt';
    write(L, nfd, 'data');
    const job = makeJob(L, R, { sync: { variant: 'mirror', writeChecksumList: true } });
    await runPair(job);
    const list = read(R, 'syncto-checksums.txt') || '';
    const onDisk = fs.readdirSync(R).find(n => n.normalize('NFC') === 'Café.txt');
    ok(onDisk && list.includes(onDisk),
       'the manifest names the file with the spelling the target really holds');
  }

  // (g) The heartbeat has to notice a share that stopped answering, not just
  //     one that returns errors.
  {
    const { acquireOne } = require('../src/main/core/lock');
    const { NativeFs } = require('../src/main/fs/native');
    const { dir } = scratch();
    const fsx = new NativeFs();
    let lost = null;
    const lock = await acquireOne(fsx, dir, { onLost: r => { lost = r; } });
    // A frozen mount does not fail — it never returns. Simulate exactly that.
    lock.fs = Object.assign(Object.create(Object.getPrototypeOf(fsx)), fsx, {
      appendByte: () => new Promise(() => {}),
      createReadStream: fsx.createReadStream.bind(fsx),
    });
    lock._lastBeat = Date.now() - 60000;          // 60 s of silence
    lock.timer._onTimeout();                       // one tick
    ok(lost && /not been refreshed/i.test(lost),
       'a lock that has gone quiet for a minute is reported lost');
    await lock.release();
  }

  // (h) A million rows in one pair collided with row 0 of the next pair: the
  //     grid's global index wrapped and a tick landed on another pair's file.
  {
    const { MultiSession } = require('../src/main/core/session');
    const m = new MultiSession();
    m.sessions = [{ nodes: new Array(3) }, { nodes: new Array(3) }];
    const a = m._split(1000001);
    eq(a.p, 0, 'row 1 000 001 still belongs to the first pair');
    eq(a.idx, -1, 'and is refused because that pair does not hold it');
    const b = m._split(1000000000 + 2);
    eq(b.p, 1, 'the second pair starts one billion higher');
    eq(b.idx, 2, 'and keeps its own row number');
    eq(m._split(-1).s, null, 'a negative index acts on nothing');
    eq(m._split(1.5).s, null, 'and so does a non-integer one');
    eq(m._split(1000000000 * 9).s, null, 'as does a pair that does not exist');
  }

  // (i) Windows long paths were only prefixed at the root, so a deep tree under
  //     a short root still failed at 260 characters.
  {
    const { NativeFs } = require('../src/main/fs/native');
    const nat = new NativeFs();
    const seen = [];
    nat.longPath = p => { seen.push(p); return p; };
    nat.join('base', 'a', 'b.mov');
    eq(seen.length, 1, 'every joined path goes through the long-path rule');
    ok(seen[0].endsWith('b.mov'), 'and it sees the full path, not just the root');

    const proto = Object.getPrototypeOf(nat);
    const deep = 'C:\\B\\' + 'x'.repeat(250);
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      ok(proto.longPath.call(nat, deep).startsWith('\\\\?\\'),
         'a path past 240 characters gets the prefix');
      ok(proto.longPath.call(nat, '\\\\nas\\share\\' + 'y'.repeat(250)).startsWith('\\\\?\\UNC\\'),
         'and a UNC path gets the UNC form');
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true });
    }
  }

  // (j) Two overlapping connections in the server window: the slower handshake
  //     landed last and overwrote — and leaked — the newer one.
  {
    const { RemoteBrowser } = require('../src/main/fs/browse');
    const b = new RemoteBrowser();
    let closed = 0;
    const fake = { close: async () => { closed++; } };
    b.fs = fake;
    const gen = b._gen;
    await b.close();
    eq(closed, 1, 'closing hangs up the live connection');
    ok(b._gen > gen, 'and invalidates any handshake still in flight');
    eq(b.fs, null, 'leaving nothing behind');
  }
}

// ══ 25. Folders the OS keeps something in (0.5.3) ═════════════════════════
async function testOsFolderLitter() {
  console.log('\n\n25. OS folders that blocked a removal (0.5.3)');

  // (a) THE one Noar hit: an HFS+ backup volume whose ingest folders each held
  //     a "System Volume Information" directory. The comparison skips that
  //     name, so the folder looked empty; the removal only ever unlinked
  //     FILES, so the folder could never go — every run reported
  //     "ENOTEMPTY: directory not empty" on a folder Finder showed as empty.
  {
    const { L, R } = scratch();
    write(L, 'keep.mov', 'data');
    write(R, 'keep.mov', 'data');
    write(R, 'ZZZZZZ/001_NOAR_Panasonic/System Volume Information/WPSettings.dat', 'windows');
    write(R, 'ZZZZZZ/001_NOAR_Panasonic/System Volume Information/IndexerVolumeGuid', 'guid');
    write(R, 'ZZZZZZ/002_NOAR_Panasonic/.DS_Store', 'finder');
    const { run, error } = await stepped(makeJob(L, R, { sync: { variant: 'mirror', deletion: 'permanent' } }));
    ok(!error, 'the run is not refused');
    eq(run.errors.length, 0, 'and reports no error at all');
    ok(!fs.existsSync(path.join(R, 'ZZZZZZ', '001_NOAR_Panasonic')),
       'the folder holding System Volume Information is removed');
    ok(!fs.existsSync(path.join(R, 'ZZZZZZ', '002_NOAR_Panasonic')),
       'and so is the one holding only a .DS_Store');
    ok(!fs.existsSync(path.join(R, 'ZZZZZZ')), 'the empty parent goes with them');
  }

  // (b) The volume's recycle bin is NOT bookkeeping: it holds files somebody
  //     deleted and may want back. That folder is refused — but the message
  //     has to say why, which "ENOTEMPTY" never did.
  {
    const { L, R } = scratch();
    write(R, 'A001/.Trashes/501/deleted-by-mistake.mov', 'precious');
    const { run } = await stepped(makeJob(L, R, { sync: { variant: 'mirror', deletion: 'permanent' } }));
    eq(run.errors.length, 1, 'the folder is refused');
    const msg = run.errors[0].message;
    ok(/still contains/.test(msg), 'and the message says the folder is not empty in plain words');
    ok(/\.Trashes/.test(msg), 'names what is in the way');
    ok(!/ENOTEMPTY/.test(msg), 'instead of a system error code');
    ok(fs.existsSync(path.join(R, 'A001/.Trashes/501/deleted-by-mistake.mov')),
       'and the file somebody may want back is untouched');
  }

  // (c) A file the filter hid still blocks the removal — correctly — and the
  //     message names it instead of leaving the user in front of a folder that
  //     looks empty.
  {
    const { R, L } = scratch();
    write(R, 'A001/clip.mov', 'x');
    write(R, 'A001/notes.bak', 'excluded');
    const { run } = await stepped(makeJob(L, R, {
      sync: { variant: 'mirror', deletion: 'permanent' },
      compare: { excludeFilter: '*.bak' },
    }));
    eq(run.errors.length, 1, 'one error for the folder');
    ok(/"notes\.bak"/.test(run.errors[0].message), 'and it names the file that is in the way');
    ok(fs.existsSync(path.join(R, 'A001/notes.bak')), 'which is still there, as it should be');
  }

  // (d) A symbolic link is excluded from the comparison by default, so it too
  //     could only show up as ENOTEMPTY.
  {
    const { L, R } = scratch();
    fs.mkdirSync(path.join(R, 'A001'), { recursive: true });
    try { fs.symlinkSync('/tmp', path.join(R, 'A001', 'shortcut')); }
    catch (_) { return; }                       // no symlinks on this filesystem
    const { run } = await stepped(makeJob(L, R, { sync: { variant: 'mirror', deletion: 'permanent' } }));
    eq(run.errors.length, 1, 'the folder holding a link is refused');
    ok(/"shortcut"/.test(run.errors[0].message), 'and the link is named');
  }
}

// ══ 26. The build scripts' Apple command lines (0.5.6) ════════════════════
// A static check, and the reason it exists. A draft of the signing library
// called
//     xcrun notarytool history --keychain-profile X --limit 1
// and `--limit` is not an option of `history`. notarytool rejected the command
// line before it ever reached Apple, the output was thrown away, and the build
// came out "signed but not notarized" whatever the credentials were.
//
// It got past a round of testing because those tests used a fake `xcrun` that
// answered on the subcommand alone and never looked at the flags — so they
// tested the stub, not the command. Reading the real command lines out of the
// scripts and checking them against notarytool's documented options is the
// check that catches it, and it needs no Mac to run.
//
// Options per subcommand, from notarytool(1).
function testAppleCommandLines() {
  console.log('\n\n26. Apple command lines in the build scripts (0.5.6)');

  const AUTH = ['--apple-id', '--password', '--team-id', '--key', '--key-id',
                '--issuer', '--keychain-profile', '--keychain', '-p', '-k', '-d'];
  const COMMON = ['--output-format', '--verbose', '-v'];
  const NOTARYTOOL = {
    'submit'           : [...AUTH, ...COMMON, '--wait', '--timeout', '--webhook',
                          '--no-progress', '--no-s3-acceleration'],
    // Authentication only. No --limit. No --page.
    'history'          : [...AUTH, ...COMMON],
    'info'             : [...AUTH, ...COMMON],
    'log'              : [...AUTH, ...COMMON],
    'store-credentials': ['--apple-id', '--password', '--team-id', '--key',
                          '--key-id', '--issuer', '--keychain', '--validate',
                          ...COMMON],
  };
  const STAPLER = ['staple', 'validate'];

  const files = ['scripts/notarize-lib.sh', 'scripts/build-mac.sh', 'build.sh'];
  let calls = 0;

  for (const rel of files) {
    const file = path.join(__dirname, '..', rel);
    if (!fs.existsSync(file)) continue;
    // Join backslash-continued lines so a wrapped command is read whole.
    const text = fs.readFileSync(file, 'utf8').replace(/\\\n\s*/g, ' ');

    for (const line of text.split('\n')) {
      // Skip comments — this file explains the bug in prose, and the prose
      // mentions the flag that must never appear in a command.
      if (/^\s*#/.test(line)) continue;

      let m = /xcrun\s+notarytool\s+([a-z-]+)([^\n;|&]*)/.exec(line);
      if (m) {
        calls++;
        const sub = m[1];
        const allowed = NOTARYTOOL[sub];
        ok(allowed, `notarytool "${sub}" is a real subcommand (${rel})`);
        for (const flag of (m[2].match(/(^|\s)(--?[a-z][a-z0-9-]*)/g) || [])) {
          const f = flag.trim();
          ok(allowed && allowed.includes(f),
             `notarytool ${sub} accepts ${f} (${rel})`);
        }
      }

      m = /xcrun\s+stapler\s+([a-z-]+)/.exec(line);
      if (m) {
        calls++;
        ok(STAPLER.includes(m[1]), `stapler "${m[1]}" is a real subcommand (${rel})`);
      }
    }
  }

  ok(calls >= 4, `the build scripts really do call Apple's tools (${calls} calls checked)`);

  // The specific line that was wrong, pinned so it cannot come back.
  const lib = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'notarize-lib.sh'), 'utf8');
  const commands = lib.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
  ok(!/notarytool\s+history[^\n]*--limit/.test(commands),
     'notarytool history is never given --limit again');
  ok(/store_notary_credentials[^\n]*&&\s*notary_profile_ready/.test(commands) === false,
     'a successful store-credentials is not second-guessed by another check');
}

// ══ 27. Comparison progress, and Reveal (0.5.7) ═══════════════════════════
async function testProgressAndReveal() {
  console.log('\n\n27. Comparison progress and Reveal (0.5.7)');

  // (a) A multi-pair comparison used to report each pair's own counter, which
  //     falls back to zero at every pair — the ring emptied and refilled, and
  //     nothing on screen said how far along the whole thing was. The window
  //     now gets a running total that never goes down.
  {
    const { L, R } = scratch();
    const L2 = path.join(path.dirname(L), 'L2'), R2 = path.join(path.dirname(R), 'R2');
    for (const d of [L2, R2]) fs.mkdirSync(d, { recursive: true });
    for (let i = 0; i < 6; i++) write(L,  `a${i}.mov`, 'x');
    for (let i = 0; i < 6; i++) write(L2, `b${i}.mov`, 'y');

    const job = makeJob(L, R, { sync: { variant: 'mirror' } });
    job.pairs = [{ left: L, right: R }, { left: L2, right: R2 }];

    const m = new MultiSession();
    const seen = [];
    await m.compare(job, { token: { cancelled: false }, onProgress: p => seen.push(p) });
    await m.close();

    ok(seen.length > 0, 'the comparison reports progress');
    ok(seen.every(p => p.scannedTotal != null), 'every event carries a running total');
    let worst = 0, fell = false;
    for (const p of seen) { if (p.scannedTotal < worst) fell = true; worst = Math.max(worst, p.scannedTotal); }
    ok(!fell, 'the running total never goes backwards, not even between pairs');
    ok(seen.some(p => p.pair === 2), 'the second pair is reported as pair 2');
    ok(seen.every(p => p.pairs === 2), 'and the number of pairs is on every event');
    ok(seen.every(p => p.elapsedMs != null), 'elapsed time is reported, which needs no total to be true');
    const last = seen[seen.length - 1];
    ok(last.scannedTotal >= 12, `the total covers both pairs (${last.scannedTotal})`);
  }

  // (b) The estimate that makes an honest percentage possible: how many items
  //     the pair held at the end of the last run. It has to be read BEFORE the
  //     scan, or it arrives too late to be of any use.
  {
    const { L, R } = scratch();
    for (let i = 0; i < 5; i++) write(L, `c${i}.mov`, 'data');
    const job = makeJob(L, R, { sync: { variant: 'mirror' } });

    const first = [];
    const s1 = new Session();
    await s1.compare(job, { token: { cancelled: false }, onProgress: p => first.push(p) });
    ok(first.every(p => !p.expected), 'a first comparison has nothing to estimate against');
    await s1.sync(job, { token: { cancelled: false }, appVersion: 'test' });
    await s1.close();

    const second = [];
    const s2 = new Session();
    await s2.compare(job, { token: { cancelled: false }, onProgress: p => second.push(p) });
    await s2.close();
    ok(second.length && second.every(p => p.expected > 0),
       `the next comparison knows roughly how many items to expect (${second[0] && second[0].expected})`);
  }

  // (c) Reveal: the window sends a row index and a side, and the path comes
  //     back resolved — including the spelling that side really uses.
  {
    const { L, R } = scratch();
    write(L, 'A001/clip.mov', 'data');
    const job = makeJob(L, R, { sync: { variant: 'mirror' } });
    job.pairs = [{ left: L, right: R }];
    const m = new MultiSession();
    await m.compare(job, { token: { cancelled: false } });

    const rows = m.rows(0, 50, { showEqual: true });
    const row = rows.rows.find(r => r.rel === 'A001/clip.mov');
    ok(row, 'the file is in the grid');

    const left = m.locate(row.idx, 'left');
    ok(left.ok, 'the source side resolves');
    eq(left.path, path.join(L, 'A001', 'clip.mov'), 'to the real path on disk');
    ok(fs.existsSync(left.path), 'which exists');

    // Not on the destination yet: opening the containing folder beats an error.
    const right = m.locate(row.idx, 'right');
    ok(!right.ok, 'the destination side has nothing to reveal');
    eq(right.fallback, R, 'so the containing folder is offered instead');

    eq(m.locate(999999, 'left').ok, false, 'a stale row index reveals nothing');
    await m.close();
  }

  // (d) A server has no Finder window. Say so, rather than silently doing
  //     nothing or handing a remote path to the operating system.
  {
    const { L, R } = scratch();
    write(L, 'x.mov', 'data');
    const m = new MultiSession();
    const job = makeJob(L, R, { sync: { variant: 'mirror' } });
    job.pairs = [{ left: L, right: R }];
    await m.compare(job, { token: { cancelled: false } });
    m.sessions[0].right.kind = 'sftp';           // as pool.open tags a server
    const r = m.locate(m.rows(0, 10, {}).rows[0].idx, 'right');
    eq(r.ok, false, 'a remote side is refused');
    ok(/server/i.test(r.error), 'and the message says why');
    await m.close();
  }
}

// ══ Run ════════════════════════════════════════════════════════════════════
// ══ 28. Application bundles, and the copy-the-log button (0.5.9) ═══════════
// A macOS .framework is built on symbolic links: `Resources` points at
// `Versions/Current/Resources`, `Current` points at `A`. syncto recreates
// links as links — but only as long as it BELIEVES the item is a link. On a
// type clash (a link here, a real file or folder there) the comparison files
// the row as a "file" so it can be shown and resolved in the grid, and the
// copy used to take that at face value: it read the link as a file, which is
// EISDIR on a link to a directory, and measured 26 bytes where it wrote a
// megabyte on a link to a file.
async function testBundlesAndCopyLog() {
  console.log('\n\n28. Application bundles and the copy button (0.5.9)');

  // A framework the way macOS really builds one.
  function framework(base, rel, size) {
    const f = path.join(base, rel);
    fs.mkdirSync(path.join(f, 'Versions/A/Resources'), { recursive: true });
    fs.writeFileSync(path.join(f, 'Versions/A/Bin'), Buffer.alloc(size, 7));
    fs.writeFileSync(path.join(f, 'Versions/A/Resources/Info.plist'), 'plist');
    fs.symlinkSync('A', path.join(f, 'Versions/Current'));
    fs.symlinkSync('Versions/Current/Bin', path.join(f, 'Bin'));
    fs.symlinkSync('Versions/Current/Resources', path.join(f, 'Resources'));
    return f;
  }
  // The same bundle after a tool that followed the links: the shortcuts have
  // become real files and real folders.
  function flattened(base, rel, size, fillResources) {
    const f = path.join(base, rel);
    fs.mkdirSync(path.join(f, 'Versions/A/Resources'), { recursive: true });
    fs.writeFileSync(path.join(f, 'Versions/A/Bin'), Buffer.alloc(size, 7));
    fs.writeFileSync(path.join(f, 'Versions/A/Resources/Info.plist'), 'plist');
    fs.mkdirSync(path.join(f, 'Versions/Current'), { recursive: true });
    fs.writeFileSync(path.join(f, 'Bin'), Buffer.alloc(size, 7));
    fs.mkdirSync(path.join(f, 'Resources'), { recursive: true });
    if (fillResources) fs.writeFileSync(path.join(f, 'Resources/Info.plist'), 'plist');
    return f;
  }
  function linkTarget(p) {
    try { return fs.readlinkSync(p); } catch (_) { return null; }
  }

  // (a) A clean copy of a bundle, which already worked and must keep working.
  {
    const { L, R } = scratch();
    framework(L, 'App.app/Contents/Frameworks/F.framework', 4096);
    const job = makeJob(L, R, { sync: { variant: 'mirror' }, compare: { symlinks: 'asLink' } });
    const { run } = await runPair(job);
    const f = path.join(R, 'App.app/Contents/Frameworks/F.framework');
    eq(run.errors.length, 0, 'a bundle copies to an empty target without an error');
    eq(linkTarget(path.join(f, 'Bin')), 'Versions/Current/Bin', 'the binary stays a link');
    eq(linkTarget(path.join(f, 'Resources')), 'Versions/Current/Resources', 'Resources stays a link');
    eq(linkTarget(path.join(f, 'Versions/Current')), 'A', 'Versions/Current stays a link');
  }

  // (b) The Luminar Neo case: the target already holds a flattened copy, and
  //     the user resolves the clashes in the grid by forcing left → right.
  {
    const { L, R } = scratch();
    framework(L, 'F.framework', 997472);
    flattened(R, 'F.framework', 997472, false);

    const job = makeJob(L, R, { sync: { variant: 'mirror' }, compare: { symlinks: 'asLink' } });
    const s = new Session();
    const token = { cancelled: false };
    await s.compare(job, { token });

    const clashes = s.nodes.filter(n => n.cat === 'conflict').map(n => n.rel).sort();
    eq(clashes, ['F.framework/Bin', 'F.framework/Resources', 'F.framework/Versions/Current'],
       'a link facing a real file or folder is reported as a conflict');
    // What the comparison hands the grid, and what used to be taken literally.
    ok(s.nodes.filter(n => n.cat === 'conflict').every(n => n.type === 'file'),
       'the grid still shows a clash as a single file row');

    s.setDirection(s.nodes.filter(n => n.cat === 'conflict').map(n => n.idx), 'right');
    const run = await s.sync(job, { token, appVersion: 'test' });
    await s.close();

    const msgs = run.errors.map(e => e.message).join(' | ');
    ok(!/EISDIR/.test(msgs), 'no EISDIR: a link to a directory is no longer read as a file');
    ok(!/Size mismatch/.test(msgs), 'no size mismatch: the link is not measured against its target');
    eq(run.errors.length, 0, 'the flattened bundle is repaired without an error');
    eq(linkTarget(path.join(R, 'F.framework/Bin')), 'Versions/Current/Bin',
       'the real file is replaced by the link it should have been');
    eq(linkTarget(path.join(R, 'F.framework/Resources')), 'Versions/Current/Resources',
       'the real folder is replaced by the link it should have been');
    eq(linkTarget(path.join(R, 'F.framework/Versions/Current')), 'A',
       'and the version link too');
  }

  // (c) The same, except the folder in the way still holds a real file. It is
  //     NOT wiped: deleting it goes through the ordinary deletion policy, and
  //     that policy refuses a folder with content in it — naming the content.
  {
    const { L, R } = scratch();
    framework(L, 'F.framework', 4096);
    flattened(R, 'F.framework', 4096, true);

    const job = makeJob(L, R, { sync: { variant: 'mirror' }, compare: { symlinks: 'asLink' } });
    const s = new Session();
    const token = { cancelled: false };
    await s.compare(job, { token });
    s.setDirection(s.nodes.filter(n => n.cat === 'conflict').map(n => n.idx), 'right');
    const run = await s.sync(job, { token, appVersion: 'test' });
    await s.close();

    const msg = run.errors.map(e => e.message).join(' | ');
    ok(/symbolic link/.test(msg), 'the refusal says a link is facing a real folder');
    ok(/Info\.plist/.test(msg), 'and names what is inside it');
    ok(!/EISDIR/.test(msg), 'and it is not an errno');
    ok(fs.existsSync(path.join(R, 'F.framework/Resources/Info.plist')),
       'nothing inside the folder was destroyed');
    // The other two rows have no content in the way and are repaired anyway.
    eq(linkTarget(path.join(R, 'F.framework/Bin')), 'Versions/Current/Bin',
       'one bad row does not stop the others');
  }

  // (d) A folder facing a file, no symbolic link anywhere: the same clash from
  //     the other side. It must refuse in words, not stream a directory.
  {
    const { L, R } = scratch();
    fs.mkdirSync(path.join(L, 'thing'), { recursive: true });
    write(L, 'thing/inside.txt', 'x');
    write(R, 'thing', 'I am a file');
    const job = makeJob(L, R, { sync: { variant: 'mirror' } });
    const s = new Session();
    const token = { cancelled: false };
    await s.compare(job, { token });
    s.setDirection(s.nodes.filter(n => n.cat === 'conflict').map(n => n.idx), 'right');
    const run = await s.sync(job, { token, appVersion: 'test' });
    await s.close();
    const msg = run.errors.map(e => e.message).join(' | ');
    ok(/folder/.test(msg) && !/EISDIR/.test(msg),
       'a folder facing a file is explained, not reported as an errno');
  }

  // (e) The copy button. Nothing here launches Electron — what is checked is
  //     the wiring, which is exactly what silently breaks: a button pointing
  //     at an id that does not exist copies nothing and says nothing.
  {
    const html   = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/index.html'), 'utf8');
    const appjs  = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/app.js'), 'utf8');
    const pre    = fs.readFileSync(path.join(__dirname, '..', 'src/main/preload.js'), 'utf8');
    const main   = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8');

    const buttons = [...html.matchAll(/class="err-copy" data-copy="([^"]+)"/g)].map(m => m[1]);
    // (The diagnostic journal had one too, until 0.8.3 removed the journal.)
    eq(buttons.sort(), ['sum-errors-body', 'sum-notes-body', 'vf-bad-body'],
       'every panel that has to be copied carries the button');
    for (const id of buttons) {
      ok(html.includes(`id="${id}"`), `the button for ${id} points at an element that exists`);
      ok(new RegExp(`setCopyBlock\\('${id}'`).test(appjs), `${id} is given something to copy`);
    }
    // The whole chain, end to end: renderer → preload → main → clipboard.
    ok(/API\.copyText\(/.test(appjs), 'the handler calls the exposed API');
    ok(/copyText\s*:.*invoke\('copy-text'/.test(pre), 'preload exposes it on the channel');
    ok(/ipcMain\.handle\('copy-text'/.test(main), 'and main answers on that channel');
    ok(/clipboard\.writeText/.test(main), 'through Electron clipboard');
    // navigator.clipboard is unusable from file:// under this CSP — it is not
    // a secure context — and reaching for it is the obvious wrong move.
    ok(!/navigator\.clipboard/.test(appjs), 'and never through navigator.clipboard');
    // The panels show 60 lines at most; the copy must carry the whole list.
    ok(/setCopyBlock\('sum-errors-body', res\.errors\.map/.test(appjs),
       'the copy takes every error, not the 60 that are displayed');
    // The heading holds the button, so it must not scroll away with the list.
    ok(/\.err-body\{max-height:150px;overflow-y:auto;\}/.test(html),
       'the list scrolls inside the block, not the block itself');
    ok(!/\.err-block\{[^}]*overflow-y:auto/.test(html),
       'so the title and its button stay put');
  }
}

// ══ 29. Pairs that are in sync leave the list ═════════════════════════════
// A multi-pair job emitted one heading per pair unconditionally. A backup that
// is up to date — every pair identical, the ordinary case — therefore produced
// a list of headings with nothing under them, which looks like work and, worse,
// kept the grid from ever being empty: the "nothing to do" message the window
// has for exactly this case could not be reached in a multi-pair job.
async function testInSyncPairs() {
  console.log('\n\n29. Pairs in sync leave the list');

  function pairDirs(n, extraOn) {
    const { dir } = scratch();
    const pairs = [];
    for (let p = 0; p < n; p++) {
      const L = path.join(dir, 'L' + p), R = path.join(dir, 'R' + p);
      for (let i = 0; i < 4; i++) {
        write(L, `clip${i}.mov`, 'x'.repeat(100 + i), 1700000000000);
        write(R, `clip${i}.mov`, 'x'.repeat(100 + i), 1700000000000);
      }
      if (extraOn === p) write(L, 'new/EXTRA.mov', 'yyy');
      pairs.push({ left: L, right: R });
    }
    return pairs;
  }

  // (a) Every pair identical: nothing at all in the list.
  {
    const pairs = pairDirs(3, -1);
    const job = makeJob(pairs[0].left, pairs[0].right, { sync: { variant: 'mirror' } });
    job.pairs = pairs;
    const m = new MultiSession();
    await m.compare(job, { token: { cancelled: false } });
    const view = { showEqual: false, showExcluded: false };
    const r = m.rows(0, 200, view);
    eq(r.total, 0, 'three synchronized pairs put nothing in the list');
    eq(r.pairsShown, 0, 'and no pair claims to be showing something');
    eq(r.pairs, 3, 'while the number of pairs is still reported');
    eq(r.rows.filter(x => x.hdr).length, 0, 'no heading is left behind');
    // The figures the window puts under "All pairs are in sync".
    ok(m.stats.rows > 0, 'the comparison did compare something');
    eq(m.stats.filesToProcess, 0, 'and found nothing to do');
    await m.close();
  }

  // (b) One pair out of three has work: only that one appears, heading included.
  {
    const pairs = pairDirs(3, 1);
    const job = makeJob(pairs[0].left, pairs[0].right, { sync: { variant: 'mirror' } });
    job.pairs = pairs;
    const m = new MultiSession();
    await m.compare(job, { token: { cancelled: false } });
    const r = m.rows(0, 200, { showEqual: false, showExcluded: false });
    eq(r.pairsShown, 1, 'one pair shows something');
    const hdrs = r.rows.filter(x => x.hdr);
    eq(hdrs.length, 1, 'and exactly one heading is drawn');
    eq(hdrs[0].pair, 2, 'the heading is the pair that has work, not the first one');
    ok(r.total > 1, 'its rows are there under it');
    ok(r.rows.filter(x => !x.hdr).every(x => x.rel.startsWith('new')),
       'and nothing from the two synchronized pairs');
    await m.close();
  }

  // (c) "Show identical" is the way back: every pair comes back, headings too.
  {
    const pairs = pairDirs(3, -1);
    const job = makeJob(pairs[0].left, pairs[0].right, { sync: { variant: 'mirror' } });
    job.pairs = pairs;
    const m = new MultiSession();
    await m.compare(job, { token: { cancelled: false } });
    const r = m.rows(0, 200, { showEqual: true, showExcluded: false });
    eq(r.pairsShown, 3, 'ticking "show identical" brings all three back');
    eq(r.rows.filter(x => x.hdr).length, 3, 'with their headings');
    await m.close();
  }

  // (d) A single pair reports the same shape, so the window has one code path.
  {
    const { L, R } = scratch();
    write(L, 'a.mov', 'x', 1700000000000);
    write(R, 'a.mov', 'x', 1700000000000);
    const s = new Session();
    await s.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: {} });
    const r = s.rows(0, 200, { showEqual: false, showExcluded: false });
    eq(r.total, 0, 'a single synchronized pair shows nothing');
    eq(r.pairs, 1, 'and reports one pair');
    eq(r.pairsShown, 0, 'showing nothing');
    await s.close();
  }

  // (e) The window's four empty states. Checked statically — what breaks here
  //     is a message that no longer matches the branch that reaches it.
  {
    const html  = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/index.html'), 'utf8');
    const appjs = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/app.js'), 'utf8');
    for (const id of ['ge-ico', 'ge-title', 'ge-sub', 'ge-act']) {
      ok(html.includes(`id="${id}"`), `the empty grid has its ${id}`);
    }
    ok(/All pairs are in sync/.test(appjs), 'the multi-pair wording exists');
    ok(/Everything is in sync/.test(appjs), 'and the single-pair one');
    ok(/pairs already in sync/.test(appjs),
       'pairs that dropped out are counted in the status strip');
    // display:'' would fall back to the stylesheet, which hides the button —
    // the rule sits on #ge-act itself. That mistake makes the way back out of
    // the empty state invisible.
    ok(!/ge-act[\s\S]{0,400}?style\.display = act \? '' :/.test(appjs),
       "the action button is not shown with display:''");
    ok(/#ge-act\{display:none/.test(html), 'and it is hidden by default in CSS');
  }
}

// ══ 30. Closing a job (0.5.11) ════════════════════════════════════════════
// "Close" removes a job from the JOBS list. The thing that must never happen
// is the one a right-click menu invites: deleting the file. The list is a
// convenience; the .syncto file is what the user owns, and it is often the
// only record of which two folders belong together.
function testCloseJob() {
  console.log('\n\n30. Closing a job (0.5.11)');

  const { pushRecent, removeRecent, RECENT_MAX, saveJob, loadJob } =
    require('../src/main/config');

  // (a) The list itself.
  {
    let l = [];
    l = pushRecent(l, 'A', '/jobs/a.syncto');
    l = pushRecent(l, 'B', '/jobs/b.syncto');
    eq(l.map(r => r.name), ['B', 'A'], 'the newest entry comes first');
    l = pushRecent(l, 'A again', '/jobs/a.syncto');
    eq(l.length, 2, 'reopening a job does not duplicate its entry');
    eq(l[0].name, 'A again', 'it moves back to the top under its current name');

    eq(removeRecent(l, '/jobs/a.syncto').map(r => r.name), ['B'], 'closing removes that entry');
    eq(removeRecent(l, '/jobs/nope').length, 2, 'closing an unknown path changes nothing');
    eq(removeRecent(null, '/jobs/a.syncto'), [], 'and an empty list survives it');
    // A malformed entry used to slip through the filter and reach the window,
    // where `r.path` on undefined took the whole list down.
    eq(removeRecent([null, { name: 'x' }, { name: 'B', path: '/b' }], '/a').length, 1,
       'entries with no path are dropped rather than rendered');

    let big = [];
    for (let i = 0; i < RECENT_MAX + 5; i++) big = pushRecent(big, 'J' + i, '/jobs/' + i);
    eq(big.length, RECENT_MAX, 'the list is capped');
    eq(big[0].name, 'J' + (RECENT_MAX + 4), 'and keeps the most recent end');
  }

  // (b) Closing never touches the file. Checked for real, on a real file.
  {
    const { dir } = scratch();
    const file = path.join(dir, 'MONTAGE.syncto');
    const j = defaultJob();
    j.name = 'MONTAGE';
    j.pairs = [{ left: path.join(dir, 'L'), right: path.join(dir, 'R') }];
    saveJob(file, j);

    let list = pushRecent([], 'MONTAGE', file);
    list = removeRecent(list, file);
    eq(list.length, 0, 'the entry is gone from the list');
    ok(fs.existsSync(file), 'and the job file is still there');
    const back = loadJob(file);
    eq(back.pairs.length, 1, 'still readable, with its pairs intact');
  }

  // (c) The wiring, end to end: button → renderer → preload → main.
  {
    const html  = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/index.html'), 'utf8');
    const appjs = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/app.js'), 'utf8');
    const pre   = fs.readFileSync(path.join(__dirname, '..', 'src/main/preload.js'), 'utf8');
    const main  = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8');

    ok(/id="job-close-btn"/.test(html), 'the CLOSE button is in the markup');
    ok(/repeat\(5,\s*1fr\)/.test(html), 'and the row is laid out for five buttons');
    ok(/job-close-btn'\)\.addEventListener\('click'/.test(appjs), 'it is wired');
    ok(/openJobCtx/.test(appjs) && /closest\('\.recent-item'\)/.test(appjs),
       'a right-click on a job in the list opens a menu');
    ok(/data-k="close"/.test(appjs), 'that menu offers Close');
    ok(/jobClose\s*:.*invoke\('job-close'/.test(pre), 'preload exposes the channel');
    ok(/ipcMain\.handle\('job-close'/.test(main), 'and main answers on it');
    ok(/lastJobPath = ''/.test(main),
       'closing the open job clears lastJobPath, so the next launch does not reopen it');

    // The handler must not delete anything. Read the handler's own body.
    const body = main.slice(main.indexOf("ipcMain.handle('job-close'"));
    const handler = body.slice(0, body.indexOf('});') + 3);
    ok(!/unlink|rmSync|rmdir|trash/i.test(handler), 'and it deletes nothing on disk');

    // ⌘W already belongs to role:'close' and to the Window menu. Two menu
    // items claiming one key is a coin toss.
    const menuLine = (main.match(/\{ label: 'Close job'.*\}/) || [''])[0];
    ok(!/accelerator/.test(menuLine), 'the Close job menu entry claims no accelerator');
    ok(/label: 'Close job'/.test(main), 'but it is in the File menu');
  }
}

// ══ 31. A base folder with a history that is gone (0.6.0) ═════════════════
// Reported on 0.5.11: a destination folder was renamed on the drive, and the
// next comparison proposed to copy all of it again — into the old name, beside
// the copy that already held it. Nothing refused, because the existing guard
// only fires when the OTHER side would lose files, and here nothing was going
// to be deleted. syncto does not go looking for the folder: it says the row is
// wrong, in words and in red, and the person fixes it.
async function testMissingRootWithHistory() {
  console.log('\n\n31. A base folder with a history that is gone (0.6.0)');

  const { readSideSession } = require('../src/main/core/db');
  const { NativeFs } = require('../src/main/fs/native');
  const nfs = new NativeFs();

  // A pair that has really run, so both .syncto.db files are real.
  async function synced(nFiles) {
    const { dir } = scratch();
    const L = path.join(dir, 'SOURCE'), R = path.join(dir, 'G', 'MagicCam_OLD');
    for (let i = 0; i < nFiles; i++) write(L, `A00${i % 2}/CLIP_${i}.mov`, 'x'.repeat(500 + i));
    fs.mkdirSync(path.join(dir, 'G'), { recursive: true });
    const job = makeJob(L, R, { sync: { variant: 'mirror' } });
    const s = new Session();
    await s.compare(job, { token: {} });
    await s.sync(job, { token: {}, appVersion: 'test' });
    const pairId = s.pairId;
    await s.close();
    return { dir, L, R, pairId, job: () => makeJob(L, R, { sync: { variant: 'mirror' } }) };
  }

  // (a) What the surviving side remembers is the whole basis for the refusal.
  {
    const c = await synced(6);
    ok(fs.existsSync(path.join(c.R, '.syncto.db')), 'the run left a database in the destination');
    const sess = await readSideSession(nfs, c.L, c.pairId);
    ok(!!sess, 'the source still holds this pair session');
    ok(sess.items && Object.keys(sess.items).length > 0, 'with the items it last agreed on');
    eq(await readSideSession(nfs, c.L, 'auto-somethingelse'), null,
       'and nothing for a pair id nobody stored');
    eq(await readSideSession(nfs, path.join(c.dir, 'nope'), c.pairId), null,
       'an unreadable folder answers null rather than throwing');
  }

  // (b) The reported case: renamed on the drive, job untouched.
  {
    const c = await synced(8);
    fs.renameSync(c.R, path.join(path.dirname(c.R), 'MagicCam_JUSTEDIT'));

    const s = new Session();
    const res = await s.compare(c.job(), { token: {} });
    ok(res.stats.createRight > 0, 'the comparison still plans the copy — the path really is gone');

    const warn = await s.preflight(c.job(), {});
    eq(warn.length, 1, 'but the synchronization refuses');
    const msg = (warn[0] || {}).message || '';
    ok(/was synchronized on/.test(msg), 'saying the folder had a history');
    ok(/would duplicate it/.test(msg), 'and what copying again would cost');
    ok(/point that row at the right folder/.test(msg), 'and who has to fix it');
    // Deliberately NOT a search of the drive for a lookalike.
    ok(!/MagicCam_JUSTEDIT/.test(msg), 'syncto does not go hunting for a replacement');
    await s.close();

    // Pointing the job at the new name is all it takes.
    const s2 = new Session();
    const NEW = path.join(path.dirname(c.R), 'MagicCam_JUSTEDIT');
    const r2 = await s2.compare(makeJob(c.L, NEW, { sync: { variant: 'mirror' } }), { token: {} });
    eq(r2.stats.filesToProcess, 0, 'and then there is nothing left to copy');
    eq((await s2.preflight(makeJob(c.L, NEW, { sync: { variant: 'mirror' } }), {})).length, 0,
       'and nothing left to refuse');
    await s2.close();
  }

  // (c) Deleted outright rather than renamed: same refusal, same advice.
  {
    const c = await synced(4);
    fs.rmSync(c.R, { recursive: true, force: true });
    const s = new Session();
    await s.compare(c.job(), { token: {} });
    const warn = await s.preflight(c.job(), {});
    eq(warn.length, 1, 'a folder that had a history and is gone still refuses');
    ok(/Reconnect the drive/.test((warn[0] || {}).message || ''), 'with the advice that fits');
    await s.close();
  }

  // (d) THE REGRESSION THAT WOULD HURT: a first run into a destination that has
  //     never existed must stay completely silent. Every job starts here.
  {
    const { L, R } = scratch();
    write(L, 'a.mov', 'x');
    const target = path.join(R, 'NEW_TARGET');
    const job = () => makeJob(L, target, { sync: { variant: 'mirror' } });
    const s = new Session();
    await s.compare(job(), { token: {} });
    eq((await s.preflight(job(), {})).length, 0, 'a brand-new destination does not refuse to run');
    await s.close();
  }

  // (e) The older guard still comes first: a missing SOURCE would empty the
  //     destination, and that message names the deletions.
  {
    const c = await synced(5);
    fs.rmSync(c.L, { recursive: true, force: true });
    const s = new Session();
    await s.compare(c.job(), { token: {} });
    const warn = await s.preflight(c.job(), {});
    eq(warn.length, 1, 'a missing source still refuses');
    ok(/would delete/.test((warn[0] || {}).message || ''), 'and still leads with the deletions');
    await s.close();
  }
}

// ══ 32. Opening a job whose folders moved (0.6.1) ═════════════════════════
// 0.6.0 caught this after a comparison. Opening the job is earlier and cheaper:
// the stale path can be fixed before anything is planned against it. What the
// window gets is one entry per native folder the job names that is not there.
async function testCheckJobPaths() {
  console.log('\n\n32. Opening a job whose folders moved (0.6.1)');

  const { checkJobPaths } = require('../src/main/core/session');

  // (a) Which rows are reported, and which are deliberately not.
  {
    const { dir } = scratch();
    const A = path.join(dir, 'A'), B = path.join(dir, 'B');
    fs.mkdirSync(A, { recursive: true });
    fs.mkdirSync(B, { recursive: true });
    const GONE = path.join(dir, 'NOT_THERE');

    const job = {
      pairs: [
        { left: A, right: B },                 // both there
        { left: A, right: GONE },              // the one to report
        { left: 'sftp://nas/share', right: A },// a server side is not stat'ed
        { left: A, right: '' },                // an unfinished row is not a problem
      ],
    };
    const out = await checkJobPaths(job);
    eq(out.length, 1, 'only the folder that is really missing is reported');
    eq(out[0].pairIndex, 1, 'with the row the window has to write into');
    eq(out[0].pair, 2, 'numbered for the user');
    eq(out[0].side, 'right', 'and the side');
    eq(out[0].path, GONE, 'and the path that does not resolve');
    eq(out[0].hadHistory, false, 'these two folders were never synchronized');
  }

  // (b) A folder that was renamed after a real run: the suggestion is filled in
  //     from the .syncto.db the folder took with it.
  {
    const { dir } = scratch();
    const L = path.join(dir, 'SOURCE'), R = path.join(dir, 'G', 'MagicCam_OLD');
    for (let i = 0; i < 5; i++) write(L, `CLIP_${i}.mov`, 'x'.repeat(300 + i));
    fs.mkdirSync(path.join(dir, 'G'), { recursive: true });
    for (const n of ['LUTS', '_TEMP']) fs.mkdirSync(path.join(dir, 'G', n), { recursive: true });
    const s = new Session();
    const job = makeJob(L, R, { sync: { variant: 'mirror' } });
    await s.compare(job, { token: {} });
    await s.sync(job, { token: {}, appVersion: 'test' });
    await s.close();

    const NEW = path.join(dir, 'G', 'MagicCam_JUSTEDIT');
    fs.renameSync(R, NEW);

    const out = await checkJobPaths({ pairs: [{ left: L, right: R }] });
    eq(out.length, 1, 'the renamed destination is reported');
    eq(out[0].hadHistory, true, 'the surviving side remembers this pair');
    ok(out[0].items > 0, 'and how many items it held');
    eq(out[0].candidate, undefined, 'syncto does not go looking for a replacement');
    eq(out[0].label, '', 'a single-pair job needs no "Pair 1" label');
  }

  // (c) The same job once the path is fixed: silence.
  {
    const { dir } = scratch();
    const L = path.join(dir, 'L'), R = path.join(dir, 'R');
    fs.mkdirSync(L, { recursive: true }); fs.mkdirSync(R, { recursive: true });
    eq((await checkJobPaths({ pairs: [{ left: L, right: R }] })).length, 0,
       'a job whose folders are all there reports nothing');
    eq((await checkJobPaths({ left: L, right: R })).length, 0,
       'including a job written before multi-pair');
  }

  // (d) A file where a folder should be is missing as far as a job is
  //     concerned — syncing into it would fail on the first write.
  {
    const { dir } = scratch();
    const L = path.join(dir, 'L');
    fs.mkdirSync(L, { recursive: true });
    const F = path.join(dir, 'a-file.txt');
    fs.writeFileSync(F, 'not a folder');
    const out = await checkJobPaths({ pairs: [{ left: L, right: F }] });
    eq(out.length, 1, 'a file standing where a folder is expected is reported');
  }

  // (e) The wiring: the check runs when a job is OPENED, and only marks at
  //     launch. A dialog in the face at every start, because a NAS is not
  //     mounted yet, is how a warning stops being read.
  {
    const html  = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/index.html'), 'utf8');
    const appjs = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/app.js'), 'utf8');
    const pre   = fs.readFileSync(path.join(__dirname, '..', 'src/main/preload.js'), 'utf8');
    const main  = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8');

    ok(/ipcMain\.handle\('check-job-paths'/.test(main), 'main answers on the channel');
    ok(/checkJobPaths\s*:.*invoke\('check-job-paths'/.test(pre), 'preload exposes it');
    eq((appjs.match(/await offerRelinkForJob\(\);/g) || []).length, 2,
       'both ways of opening a job check its folders');
    ok(/offerRelinkForJob\(true\);/.test(appjs), 'and the launch only marks');
    ok(html.includes('id="missing-badge"'), 'the mark is a button in the status strip');
    ok(/missing-badge'\)\.addEventListener\('click', \(\) => offerRelinkForJob\(false\)\)/.test(appjs),
       'clicking it opens the dialog');

    // (f) The mark on the row. This is what is still on screen an hour after
    //     the dialog was closed, and the path is where the problem actually
    //     is. Red again in 0.8.3 (orange in 0.8.0): a folder or a volume that
    //     is not there stops the job, and orange read as a suggestion.
    ok(/\.prow input\.gone\{border-color:rgba\(242,85,90/.test(html),
       'a row whose folder is missing is drawn in red');
    ok(/\.prow input\.gone\{border:none;box-shadow:inset 0 0 0 1px rgba\(242,85,90/.test(html),
       'in the charte block too');
    ok(/#missing-badge\{[^}]*color:var\(--red\)/.test(html), 'and so is the badge that counts them');
    ok(/#missing-badge\{border:none;background:rgba\(242,85,90/.test(html), 'on a red hollow');
    ok(!/#missing-badge\{[^}]*242,160,61/.test(html), 'with no orange left on it');
    ok(/function markMissingPaths\(list\)/.test(appjs), 'and something marks it');
    ok(/markMissingPaths\(state\.missingPaths\);/.test(appjs),
       'rebuilding the pair rows puts the red back');
    ok(/recheckPathsSoon\(\);/.test(appjs), 'editing a path re-checks it');
    ok(/state\.missingPaths = list \|\| \[\];/.test(appjs),
       'the red covers every missing folder, dismissed or not');
    ok(!/relinkFromCompare|findRenamedBase|rl-btn use/.test(appjs),
       'and nothing is left of the folder-hunting the window used to do');

    // Browse opens where the folder used to be. Without it the picker lands on
    // wherever the user last browsed, which is rarely the right drive.
    ok(/browse-folder', async \(_, title, startIn\)/.test(main), 'browse takes a starting folder');
    ok(/opts\.defaultPath = start;/.test(main), 'and uses it');
    ok(/API\.browseFolder\(`\$\{side\} — \$\{item\.label \|\| 'pair'\}`, item\.path\)/.test(appjs),
       'the dialog passes the missing path as the starting point');
  }
}

// ══ 33. Locks: network tolerance, and leftovers (0.6.2) ═══════════════════
// Two reports, one subject.
//
// The first: a synchronization between two machines on a network died every
// time with "the lock file has not been refreshed for 15 s — the folder may
// have been taken over". Nobody had taken anything over. An SMB share
// reconnecting takes longer than the twelve seconds the protocol allowed.
//
// The second: lock files left behind by runs that never finished. The protocol
// clears an abandoned lock, but only when somebody asks for that folder again —
// and if nobody does, the file sits there.
async function testLockTolerance() {
  console.log('\n\n33. Locks: network tolerance and leftovers (0.6.2)');

  const {
    checkStillOurs, findLeftoverLocks, clearStaleLock, isCorpseName,
    acquireOne, localLockInfo, DETECT_ABANDONED_MS, EMIT_LIFE_SIGN_MS, LOCK_NAME,
  } = require('../src/main/core/lock');
  const { NativeFs } = require('../src/main/fs/native');
  const nfs = new NativeFs();

  // (a) The window. A number that is right for two processes on one machine is
  //     wrong for two machines on a network.
  {
    ok(DETECT_ABANDONED_MS >= 60000,
       'a folder is given up only after a full minute of silence');
    ok(DETECT_ABANDONED_MS > 15000,
       'and 15 s of network trouble — the case reported — is ridden out');
    ok(DETECT_ABANDONED_MS > EMIT_LIFE_SIGN_MS * 4,
       'which is several heartbeats, not one missed beat');
  }

  // (b) THE BUG. A read that fails proves nothing, and was being read as "the
  //     lock file disappeared" — one unreadable instant ended the run.
  {
    const { dir } = scratch();
    const p = path.join(dir, LOCK_NAME);
    const mine = localLockInfo();
    fs.writeFileSync(p, JSON.stringify(mine) + '\n');

    eq(await checkStillOurs(nfs, p, mine.lockId), 'ours', 'our own lock reads as ours');
    eq(await checkStillOurs(nfs, p, 'someone-elses-id'), 'taken',
       'a lock carrying another id reads as taken');
    eq(await checkStillOurs(nfs, path.join(dir, 'no-such-lock'), mine.lockId), 'gone',
       'a file that is really absent reads as gone');

    // A share that does not answer: stat throws rather than returning null.
    const flaky = Object.assign(Object.create(Object.getPrototypeOf(nfs)), nfs, {
      stat: async () => { const e = new Error('ETIMEDOUT'); e.code = 'ETIMEDOUT'; throw e; },
    });
    eq(await checkStillOurs(flaky, p, mine.lockId), 'unknown',
       'a share that does not answer is unknown, NOT gone');

    // There, but unreadable this instant: the old code called this "gone".
    const unreadable = Object.assign(Object.create(Object.getPrototypeOf(nfs)), nfs, {
      createReadStream: () => { throw new Error('EIO'); },
    });
    eq(await checkStillOurs(unreadable, p, mine.lockId), 'unknown',
       'a lock that cannot be read this instant is unknown, NOT gone');
  }

  // (c) A held lock rides out a share that stops answering, and still gives up
  //     the instant somebody really takes it.
  {
    const { dir } = scratch();
    let failing = false;
    const flaky = Object.assign(Object.create(Object.getPrototypeOf(nfs)), nfs, {
      stat: async (...a) => {
        if (failing) { const e = new Error('ETIMEDOUT'); e.code = 'ETIMEDOUT'; throw e; }
        return NativeFs.prototype.stat.apply(nfs, a);
      },
      appendByte: async (...a) => {
        if (failing) { const e = new Error('ETIMEDOUT'); e.code = 'ETIMEDOUT'; throw e; }
        return NativeFs.prototype.appendByte.apply(nfs, a);
      },
    });

    // Same logic, played at speed: 200 ms beats and a 2 s window instead of
    // 5 s and a minute. The real numbers are asserted in (a).
    const FAST = { beatMs: 200, detectMs: 2000 };
    let lostReason = null;
    const lock = await acquireOne(flaky, dir, { onLost: r => { lostReason = r; }, timing: FAST });
    ok(!!lock, 'the lock is taken');

    // Three heartbeats' worth of a share that answers nothing.
    failing = true;
    await new Promise(r => setTimeout(r, FAST.beatMs * 4));
    eq(lostReason, null, 'several beats of silence do not end the run');
    ok(lock.hiccups >= 1, 'but it is counted, for the run summary');
    failing = false;
    await new Promise(r => setTimeout(r, FAST.beatMs * 3));
    eq(lostReason, null, 'and the run carries on once the share comes back');
    ok(lock.worstGapMs >= FAST.beatMs, 'the longest gap is remembered');

    // The exact shape of the reported failure: the share answers a stat but
    // the read comes back empty. That used to read as "the lock file
    // disappeared" and ended the run on the spot.
    let readBroken = false;
    const halfDead = Object.assign(Object.create(Object.getPrototypeOf(nfs)), nfs, {
      createReadStream: (...a) => {
        if (readBroken) throw new Error('EIO');
        return NativeFs.prototype.createReadStream.apply(nfs, a);
      },
    });
    let lost2 = null;
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    const lock2 = await acquireOne(halfDead, sub, { onLost: r => { lost2 = r; }, timing: FAST });
    readBroken = true;
    await new Promise(r => setTimeout(r, FAST.beatMs * 4));
    eq(lost2, null, 'a share whose reads fail does not end the run either');
    readBroken = false;
    await lock2.release();

    // Now somebody really takes the folder: that IS proof, and it stops at once.
    fs.writeFileSync(path.join(dir, LOCK_NAME),
      JSON.stringify(Object.assign(localLockInfo(), { computerName: 'OTHER-MAC' })) + '\n');
    await new Promise(r => setTimeout(r, FAST.beatMs * 3));
    ok(!!lostReason, 'a genuine takeover still ends the run immediately');
    ok(/taken over/.test(lostReason || ''), 'and says who took it');
    await lock.release();
  }

  // (d) Finding what a dead run left behind. The comparison already lists the
  //     root of every base folder, so this reads no extra bytes.
  {
    const join = (d, n) => path.join(d, n);
    const now = 1_700_000_000_000;
    const entries = [
      { name: LOCK_NAME,                    mtime: now - 90_000 },
      { name: `Delete.0.${LOCK_NAME}`,      mtime: now - 90_000 },
      { name: `Delete.3.${LOCK_NAME}`,      mtime: now - 1_000  },
      { name: '.syncto.db',                 mtime: now },
      { name: 'CLIP_0001.mov',              mtime: now },
      { name: 'Delete.0.something-else.txt',mtime: now - 90_000 },
    ];
    const found = findLeftoverLocks(entries, '/vol/BACKUP', join, now);
    eq(found.map(f => f.name).sort(),
       [`Delete.0.${LOCK_NAME}`, `Delete.3.${LOCK_NAME}`, LOCK_NAME].sort(),
       'the lock and its corpses are found, and nothing else');
    eq(found.filter(f => f.stale).length, 2,
       'the one touched a second ago is not called stale');
    eq(found.find(f => f.name === LOCK_NAME).kind, 'lock', 'a lock is a lock');
    eq(found.find(f => f.name === `Delete.0.${LOCK_NAME}`).kind, 'corpse',
       'and a renamed one is a corpse');
    ok(isCorpseName(`Delete.7.${LOCK_NAME}`), 'corpse names are recognised');
    ok(!isCorpseName('Delete.0.holiday.mov'), 'and a user file called Delete.0 is not one');
    eq(findLeftoverLocks(null, '/x', join, now), [], 'an empty listing finds nothing');
  }

  // (e) Clearing one. A lock that is being fed is left exactly where it is —
  //     an mtime that merely looks old is not a licence to delete.
  {
    const { dir } = scratch();
    const lockPath = path.join(dir, LOCK_NAME);
    const old = Date.now() - DETECT_ABANDONED_MS - 60_000;

    // A corpse: already declared abandoned by whoever renamed it.
    const corpse = path.join(dir, `Delete.0.${LOCK_NAME}`);
    fs.writeFileSync(corpse, 'x');
    fs.utimesSync(corpse, new Date(old), new Date(old));
    eq(await clearStaleLock(nfs, { path: corpse, kind: 'corpse' }, {}), 'removed',
       'an old corpse is removed');
    ok(!fs.existsSync(corpse), 'and it really is gone');

    const fresh = path.join(dir, `Delete.1.${LOCK_NAME}`);
    fs.writeFileSync(fresh, 'x');
    eq(await clearStaleLock(nfs, { path: fresh, kind: 'corpse' }, {}), 'alive',
       'a corpse from this very second is left alone — a takeover is in flight');
    ok(fs.existsSync(fresh), 'so the file is still there');

    // A lock from a process on this machine that no longer exists.
    const dead = Object.assign(localLockInfo(), { processId: 999_999, sessionId: 999_998 });
    fs.writeFileSync(lockPath, JSON.stringify(dead) + '\n');
    eq(await clearStaleLock(nfs, { path: lockPath, kind: 'lock' }, {}), 'removed',
       'a lock left by a dead process on this machine is removed');
    ok(!fs.existsSync(lockPath), 'and the folder is free again');

    // A lock this very process holds is not a leftover.
    const live = await acquireOne(nfs, dir, {});
    eq(await clearStaleLock(nfs, { path: lockPath, kind: 'lock' }, {}), 'alive',
       'a lock that is genuinely held is never removed');
    ok(fs.existsSync(lockPath), 'it is still there');
    await live.release();
    eq(await clearStaleLock(nfs, { path: lockPath, kind: 'lock' }, {}), 'gone',
       'and once released there is nothing left to clear');
  }

  // (f) A comparison reports them, and reports nothing when there is nothing.
  {
    const { L, R } = scratch();
    write(L, 'a.mov', 'x');
    const clean = new Session();
    const r0 = await clean.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: {} });
    eq(r0.staleLocks.length, 0, 'a healthy folder reports no leftover lock');
    await clean.close();

    const old = Date.now() - DETECT_ABANDONED_MS - 60_000;
    for (const base of [L, R]) {
      const p = path.join(base, LOCK_NAME);
      fs.writeFileSync(p, JSON.stringify(localLockInfo()) + '\n');
      fs.utimesSync(p, new Date(old), new Date(old));
    }
    const s = new Session();
    const res = await s.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: {} });
    eq(res.staleLocks.length, 2, 'a leftover lock on each side is reported');
    eq(res.staleLocks.filter(l => l.kind === 'lock').length, 2, 'as locks');
    ok(res.staleLocks.every(l => l.folder && l.path), 'each naming its folder and file');
    // And it stays invisible to the plan: reported, never synchronized.
    eq(res.stats.filesToProcess, 1, 'the lock files are not copied anywhere');
    await s.close();
  }

  // (f2) The wrapper the window actually calls. Tested separately from
  //      clearStaleLock because it is where the plumbing lives — it opens the
  //      folder through the pool, and a folder is a LOCATION there, not a
  //      string. Getting that wrong reported "could not be removed" on every
  //      file while they all sat there untouched.
  {
    const { clearStaleLocks } = require('../src/main/core/session');
    const { dir } = scratch();
    const lockPath = path.join(dir, LOCK_NAME);
    const corpse   = path.join(dir, `Delete.0.${LOCK_NAME}`);
    const old = Date.now() - DETECT_ABANDONED_MS - 90_000;
    for (const f of [lockPath, corpse]) {
      fs.writeFileSync(f, JSON.stringify(localLockInfo()) + '\n');
      fs.utimesSync(f, new Date(old), new Date(old));
    }
    // The job is what says which folders may be touched: since 0.8.0 the
    // wrapper opens the pairs' own locations instead of re-parsing the string
    // the window sent back, so a lock is only ever cleared in a folder this
    // job synchronizes — on the side it belongs to.
    const job = makeJob(dir, path.join(dir, 'elsewhere'));
    const res = await clearStaleLocks(job, [
      { folder: dir, name: LOCK_NAME, path: lockPath, kind: 'lock' },
      { folder: dir, name: `Delete.0.${LOCK_NAME}`, path: corpse, kind: 'corpse' },
    ], {});
    eq(res.length, 2, 'every item comes back with a verdict');
    ok(res.every(r => r.status !== 'failed'), 'and none of them failed');
    ok(res.every(r => !r.error), 'with no error carried back');
    eq(fs.readdirSync(dir).filter(n => n.includes('.syncto.lock')), [],
       'the folder really is clean afterwards');

    // And what the window may NOT ask for. A folder this job does not name,
    // and a name that is not a lock file, are both refused — the second is
    // how a remote server used to get a local file of its choosing deleted.
    const outside = scratch().dir;
    const decoy = path.join(outside, 'thesis.docx');
    fs.writeFileSync(decoy, 'the only copy');
    const refused = await clearStaleLocks(job, [
      { folder: outside, name: LOCK_NAME, path: path.join(outside, LOCK_NAME), kind: 'lock' },
      { folder: dir, name: `Delete.0..syncto.lock/../../thesis.docx`, path: decoy, kind: 'corpse' },
    ], {});
    eq(refused.map(r => r.status).join(','), 'failed,failed', 'a folder outside the job, and a name that is not a lock, are refused');
    ok(fs.existsSync(decoy), 'and the file the name pointed at is still there');
  }

  // (g) The window's side: reported, and cleared only on purpose.
  {
    const html  = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/index.html'), 'utf8');
    const appjs = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/app.js'), 'utf8');
    const pre   = fs.readFileSync(path.join(__dirname, '..', 'src/main/preload.js'), 'utf8');
    const main  = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8');
    ok(html.includes('id="lock-badge"'), 'the status strip can say so');
    ok(/noteStaleLocks\(res\.staleLocks \|\| \[\]\)/.test(appjs), 'a comparison fills it');
    ok(/lock-badge'\)\.addEventListener\('click', clearStaleLocksNow\)/.test(appjs),
       'and clearing is a click, never automatic');
    ok(/clearLocks\s*:.*invoke\('clear-locks'/.test(pre), 'preload exposes the channel');
    ok(/ipcMain\.handle\('clear-locks'/.test(main), 'and main answers on it');
    // Nothing in the comparison path may delete a lock on the way past.
    const cmp = fs.readFileSync(path.join(__dirname, '..', 'src/main/core/compare.js'), 'utf8');
    ok(!/unlink[\s\S]{0,80}LOCK_NAME/.test(cmp), 'the comparison never removes one itself');
  }
}

// ══ 34. The diagnostic journal — removed in 0.8.3 ════════════════════════
// It came in 0.6.3 and went in 0.8.3 at Noar's request. What is checked now
// is that it is gone for good: no module, no channel, no setting, and no file
// left behind in the user's profile by an older version.
function testLog() {
  console.log('\n\n34. The diagnostic journal is gone (0.8.3)');
  const src = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  ok(!fs.existsSync(path.join(__dirname, '..', 'src/main/log.js')), 'the module is gone');
  const all = ['src/main/main.js', 'src/main/preload.js', 'src/main/core/session.js', 'src/main/core/sync.js',
               'src/main/core/lock.js', 'src/main/fs/sftp.js'].map(src).join('\n');
  ok(!/require\(['"][./]*log['"]\)/.test(all), 'nothing requires it');
  ok(!/\blog\.(info|warn|error|debug|begin)\(/.test(all), 'and nothing calls it');
  ok(!/'log-(info|set|clear|reveal|save)'/.test(all), 'no channel is left open for it');
  ok(!/id="st-log/.test(src('src/renderer/index.html')), 'the settings no longer show it');
  const { defaultPrefs } = require('../src/main/config');
  ok(!('log' in defaultPrefs()), 'nor is there a preference for it');
  ok(/rmSync\(path\.join\(app\.getPath\('userData'\), 'logs'\)/.test(src('src/main/main.js')),
     'what an older version wrote in the profile is removed at launch');
}

// ══ 35. SFTP transfers, against a real server (0.6.5) ═════════════════════
// Two users measured 1.5 MB/s at 22 ms of latency and 0.3 MB/s at 100 ms —
// the same code, the same chunk, the ratio of their pings. ssh2's SFTP streams
// issue ONE request and wait for its answer: SFTP.write() sends each piece of
// a large buffer from the callback of the piece before it, and ReadStream does
// the same. Throughput was therefore one chunk ÷ one round trip, which is
// invisible on a LAN and ruinous on a real link.
//
// This section runs against a real SFTP server, in this process, serving a real
// folder with a delay on every reply — because a bound that only shows up under
// latency cannot be tested without latency.
async function testSftpTransfer() {
  console.log('\n\n35. SFTP transfers against a real server (0.6.5)');

  const { startSftpServer } = require('./sftp-server');
  const { SftpFs } = require('../src/main/fs/sftp');
  const { XFER_CHUNK, XFER_CONCURRENCY } = require('../src/main/fs/sftp-pipe');
  const { NativeFs } = require('../src/main/fs/native');
  const { copyStream } = require('../src/main/core/sync');
  const { createHasher, hashStream } = require('../src/main/core/hash');
  const crypto = require('crypto');
  const nfs = new NativeFs();
  const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

  // 8 ms per reply: enough for the difference to be unmistakable, small enough
  // that the suite stays under a second here.
  const LATENCY = 8;
  const { dir } = scratch();
  const remote = path.join(dir, 'server');
  fs.mkdirSync(remote, { recursive: true });
  const srv = await startSftpServer({ root: remote, latencyMs: LATENCY });
  const sftp = new SftpFs({
    host: srv.host, port: srv.port, username: srv.username, password: srv.password,
  });

  try {
    await sftp.connect();
    ok(true, 'the test server accepts a connection');

    // Content that is different everywhere: a block delivered out of order, or
    // one delivered twice, changes the hash. All-zeroes would hide both.
    const SIZE = 2 * 1024 * 1024;
    const buf = Buffer.alloc(SIZE);
    for (let i = 0; i < SIZE; i += 4) buf.writeUInt32LE(i >>> 2, i);
    const src = path.join(dir, 'clip.braw');
    fs.writeFileSync(src, buf);

    // (a) Upload: the bytes that arrive are the bytes that left.
    {
      const hasher = await createHasher('xxh64');
      let seen = 0;
      const res = await copyStream(nfs, src, sftp, '/clip.braw', hasher, b => { seen += b; }, {});
      eq(res.bytes, SIZE, 'every byte was sent');
      eq(seen, SIZE, 'and every byte was reported to the progress meter');
      eq(fs.statSync(path.join(remote, 'clip.braw')).size, SIZE, 'the file on the server is the right size');
      eq(sha(path.join(remote, 'clip.braw')), sha(src), 'and byte-for-byte the same');

      // The fingerprint is computed WHILE the bytes go past. With many requests
      // in flight the pieces come back out of order, so this is the assertion
      // that the reorder buffer is doing its job — a hash of the right bytes in
      // the wrong sequence is the kind of error that surfaces on restore day.
      const again = await hashStream(nfs, src, await createHasher('xxh64'), null, {});
      eq(res.digest, again, 'the fingerprint taken in flight matches a plain re-read');
    }

    // (b) Download: same, the other way.
    {
      const back = path.join(dir, 'back.braw');
      const res = await copyStream(sftp, '/clip.braw', nfs, back, null, null, {});
      eq(res.bytes, SIZE, 'every byte came back');
      eq(sha(back), sha(src), 'and the downloaded file is identical');
    }

    // (c) A file smaller than one chunk, and an empty one: the edges of the
    //     reorder logic, where an off-by-one shows up.
    {
      for (const [name, size] of [['tiny.bin', 17], ['empty.bin', 0], ['exact.bin', XFER_CHUNK]]) {
        const p = path.join(dir, name);
        fs.writeFileSync(p, Buffer.alloc(size, 0xab));
        await copyStream(nfs, p, sftp, '/' + name, null, null, {});
        eq(fs.statSync(path.join(remote, name)).size, size, `${name} (${size} B) uploads whole`);
        const rt = path.join(dir, 'rt-' + name);
        await copyStream(sftp, '/' + name, nfs, rt, null, null, {});
        eq(sha(rt), sha(p), `${name} comes back identical`);
      }
    }

    // (d) 🔴 THE POINT. Against ssh2's own stream, which issues one request at
    //     a time, on the very same connection and the very same file.
    {
      const t0 = Date.now();
      await new Promise((res, rej) => {
        const rs = fs.createReadStream(src);
        const ws = sftp.sftp.createWriteStream('/serial.bin');
        rs.on('error', rej); ws.on('error', rej); ws.on('close', res);
        rs.pipe(ws);
      });
      const serialMs = Date.now() - t0;

      const t1 = Date.now();
      await copyStream(nfs, src, sftp, '/pipelined.bin', null, null, {});
      const pipelinedMs = Date.now() - t1;

      eq(sha(path.join(remote, 'serial.bin')), sha(path.join(remote, 'pipelined.bin')),
         'both paths produce the same file');
      ok(pipelinedMs * 3 < serialMs,
         `pipelining is at least three times faster (${serialMs} ms → ${pipelinedMs} ms at ${LATENCY} ms of latency)`);
      ok(XFER_CONCURRENCY > 1, 'because more than one request is in flight');
    }

    // (e) Cancelling reaches a transfer in progress, and does not leave the
    //     promise hanging — the whole reason a stuck run could not be stopped.
    {
      const big = path.join(dir, 'big.bin');
      fs.writeFileSync(big, Buffer.alloc(24 * 1024 * 1024, 5));
      const token = { cancelled: false, paused: false };
      setTimeout(() => { token.cancelled = true; }, 120);
      let msg = null;
      const t0 = Date.now();
      try { await copyStream(nfs, big, sftp, '/cancelled.bin', null, null, token); }
      catch (err) { msg = err.message; }
      const ms = Date.now() - t0;
      eq(msg, 'Cancelled', 'the copy rejects rather than finishing');
      ok(ms < 5000, `and it stops promptly (${ms} ms)`);
    }

    // (f) Pause holds the transfer INSIDE a file, and lets it finish after.
    //     The drain handler used to resume unconditionally, so a paused
    //     transfer restarted itself the moment the writer emptied — 29 MB went
    //     through a "pause" in the run that caught it.
    {
      const big = path.join(dir, 'big.bin');
      const token = { cancelled: false, paused: false };
      let got = 0, atMark = 0;
      setTimeout(() => { token.paused = true; }, 150);
      setTimeout(() => { atMark = got; }, 400);
      setTimeout(() => { token.paused = false; }, 900);
      const res = await copyStream(nfs, big, sftp, '/paused.bin', null, b => { got += b; }, token);
      ok(atMark > 0, 'the transfer had started before the pause');
      eq(got, res.bytes, 'and finished after it');
      eq(fs.statSync(path.join(remote, 'paused.bin')).size, 24 * 1024 * 1024,
         'with the whole file on the server');
    }
  } finally {
    try { await sftp.close(); } catch (_) {}
    try { await srv.close(); } catch (_) {}
  }
}


// ══ 36. Unfolding a folder in the overview (0.6.7) ═════════════════════════
// The panel listed the top level and nothing else, so the only way to see what
// was inside a folder was to click it and read the grid. It now unfolds, one
// level per click, and a level that is not open is never even built — a folded
// panel costs exactly what the flat one did.
async function testOverviewTree() {
  console.log('\n\n36. Unfolding a folder in the overview (0.6.7)');

  const build = async () => {
    const { L, R } = scratch();
    const t = Date.now() - 86400000;
    // Day 1 carries the work, and it is two levels deep.
    write(L, 'Rushes/DAY1/A001.mov', 'x'.repeat(900), Date.now());
    write(L, 'Rushes/DAY1/CARD_B/B001.mov', 'y'.repeat(300), Date.now());
    write(L, 'Rushes/DAY2/C001.mov', 'z'.repeat(100), Date.now());
    // Audio is identical on both sides: nothing to do anywhere under it.
    write(L, 'Audio/mix.wav', 'same', t); write(R, 'Audio/mix.wav', 'same', t);
    const s = new Session();
    await s.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: { cancelled: false } });
    return s;
  };

  // (a) Folded, the panel is exactly what it was: one row per top-level entry.
  {
    const s = await build();
    const ov = s.overview();
    eq(ov.rows.length, 1, 'folded, only the top level is listed');
    eq(ov.rows[0].name, 'Rushes', 'and it is the folder carrying the work');
    eq(ov.rows[0].items, 7, 'totalling everything underneath it — files and folders alike');
    eq(ov.rows[0].bytes, 1300, 'and all the bytes that will cross');
    ok(ov.rows[0].kids, 'it says it can be unfolded');
    ok(!ov.rows[0].open, 'and that it is not');
    await s.close();
  }

  // (b) 🔴 THE POINT. Unfolding shows the DIRECT contents — one level, not the
  //     whole subtree. A panel that dumped every descendant at the first click
  //     would be the grid again, in a narrower column.
  {
    const s = await build();
    const ov = s.overview({}, ['Rushes']);
    const names = ov.rows.map(r => r.rel);
    eq(names.join(' | '), 'Rushes | Rushes/DAY1 | Rushes/DAY2',
       'the children arrive under their parent, biggest first');
    ok(!names.includes('Rushes/DAY1/CARD_B'),
       'and a grandchild stays hidden until its own parent is opened');
    eq(ov.rows[1].depth, 1, 'a child is one level in');
    ok(ov.rows[0].open, 'the folder is marked open');

    // The parent's own figures do not move when it is unfolded: it still
    // totals its whole subtree, so the number you were reading stays put.
    const folded = (await (async () => { const s2 = await build(); const o = s2.overview(); await s2.close(); return o; })()).rows[0];
    eq(ov.rows[0].items, folded.items, 'the parent still counts its whole subtree');
    eq(ov.rows[0].bytes, folded.bytes, 'and still shows all of its bytes');
    await s.close();
  }

  // (c) Two levels open at once, and the grandchild appears in its place.
  {
    const s = await build();
    const ov = s.overview({}, ['Rushes', 'Rushes/DAY1']);
    eq(ov.rows.map(r => r.rel).join(' | '),
       'Rushes | Rushes/DAY1 | Rushes/DAY1/A001.mov | Rushes/DAY1/CARD_B | Rushes/DAY2',
       'each open level inserts its own contents in place');
    eq(ov.rows[2].type, 'file', 'files show as files');
    eq(ov.rows[3].depth, 2, 'and a grandchild is two levels in');
    await s.close();
  }

  // (d) The percentage is a share of the RUN, not of the level. Adding the
  //     children into the total would shrink every bar as you unfold — the
  //     panel would appear to change its mind about what is big.
  {
    const s = await build();
    const folded = s.overview();
    const open   = s.overview({}, ['Rushes']);
    eq(open.rows[0].pct, folded.rows[0].pct, 'the parent bar does not move when it opens');
    eq(open.rows[0].pct, 100, 'the only top-level row is the whole run');
    ok(open.rows[1].pct < open.rows[0].pct, 'and a child is a slice of it');
    eq(open.totalBytes, folded.totalBytes, 'the total is unchanged');
    await s.close();
  }

  // (e) A folder with nothing to do offers no arrow: unfolding it would open
  //     an empty level, which is worse than no arrow at all. Ticking "show
  //     identical" is what puts it back.
  {
    const s = await build();
    const all = s.overview({ showEqual: true });
    const audio = all.rows.find(r => r.name === 'Audio');
    ok(audio, 'with "show identical" the untouched folder is listed');
    ok(audio.kids, 'and it can be unfolded, because now there is something inside');
    const opened = s.overview({ showEqual: true }, ['Audio']);
    eq(opened.rows.filter(r => r.rel.startsWith('Audio/')).length, 1,
       'unfolding it lists the identical file');
    // Without the switch it is not in the list at all, so there is nothing to
    // unfold: asking anyway must not invent a row.
    const none = s.overview({}, ['Audio']);
    eq(none.rows.filter(r => r.rel.startsWith('Audio')).length, 0,
       'and opening a folder with no work produces nothing');
    await s.close();
  }

  // (f) Several pairs: what is open in pair 1 must not open the same name in
  //     pair 2, and the tree order has to survive the merge — children stay
  //     under their own parent instead of being re-sorted into the pile.
  {
    const a = scratch(), b = scratch();
    write(a.L, 'Rushes/DAY1/A001.mov', 'x'.repeat(900), Date.now());
    write(a.L, 'Rushes/DAY2/C001.mov', 'z'.repeat(100), Date.now());
    write(b.L, 'Rushes/DAY1/B001.mov', 'y'.repeat(400), Date.now());
    const job = makeJob('', '', { sync: { variant: 'mirror' } });
    delete job.left; delete job.right;
    job.pairs = [{ left: a.L, right: a.R }, { left: b.L, right: b.R }];
    const m = new MultiSession();
    await m.compare(job, { token: {} });

    const ov = m.overview({}, [{ p: 0, rel: 'Rushes' }]);
    const shape = ov.rows.map(r => r.pair + ':' + r.rel).join(' | ');
    eq(shape, '1:Rushes | 1:Rushes/DAY1 | 1:Rushes/DAY2 | 2:Rushes',
       'only the pair that was opened unfolds, and each pair keeps its block');
    ok(ov.rows[3].kids, 'the same folder in the other pair is still closed');
    ok(ov.rows[0].first && !ov.rows[1].first,
       'the pair heading is still on the first row of each pair');
    // A child of pair 1 is smaller than the root of pair 2; a global sort by
    // size would have moved it out of its parent's block.
    ok(ov.rows[2].bytes < ov.rows[3].bytes,
       'a small child stays under its parent even next to a bigger root');
    await m.close();
  }

  // (g) The window: the arrow is its own click target, and the row scopes on
  //     the FULL path — inside an unfolded folder, the last segment alone
  //     would point the grid, and the exclusion patterns, at the wrong level.
  {
    const html  = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/index.html'), 'utf8');
    const appjs = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/app.js'), 'utf8');
    ok(/getOverview\(state\.view,\s*open,/.test(appjs), 'the window sends the open folders to the engine');
    ok(/data-rel="\$\{esc\(g\.rel\)\}"/.test(appjs), 'every row carries its full path');
    ok(/setScope\([\s\S]{0,80}?it\.dataset\.rel, label\)/.test(appjs), 'and the grid is scoped on that path');
    ok(!/setScope\([\s\S]{0,80}?it\.dataset\.name/.test(appjs), 'never on the last segment alone');
    ok(/rel: it\.dataset\.rel/.test(appjs), 'right-click builds its pattern from the full path too');
    ok(/e\.target\.closest\('\.ov-twist'\)/.test(appjs), 'the arrow is handled before the row');
    ok(/state\.ovOpen\.clear\(\)/.test(appjs), 'a new comparison starts folded');
    ok(/\.ov-twist\.open\{transform:rotate\(90deg\)\}/.test(html.replace(/;\}/g, '}')),
       'and the arrow turns when the folder is open');
  }
}


// ══ 37. Ordering and batch selection in the overview (0.6.8) ══════════════
// Two requests on the same panel: order it by name or by count, not only by
// size, and pick several folders at once to untick them in one go.
async function testOverviewSortAndBatch() {
  console.log('\n\n37. Ordering and batch selection in the overview (0.6.8)');

  const build = async () => {
    const { L, R } = scratch();
    // Sizes, counts and names deliberately disagree, so each ordering produces
    // a different list — a test where two columns agree proves nothing.
    write(L, 'ZULU/big.mov', 'x'.repeat(5000), Date.now());
    write(L, 'ZULU/small.mov', 'x'.repeat(10), Date.now());
    write(L, 'A010/one.mov', 'y'.repeat(400), Date.now());
    write(L, 'A002/a.mov', 'z'.repeat(100), Date.now());
    write(L, 'A002/b.mov', 'z'.repeat(100), Date.now());
    write(L, 'A002/c.mov', 'z'.repeat(100), Date.now());
    const s = new Session();
    await s.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: { cancelled: false } });
    return s;
  };
  const names = ov => ov.rows.map(r => r.name).join(' ');

  // (a) The default has not moved: biggest first.
  {
    const s = await build();
    eq(names(s.overview()), 'ZULU A010 A002', 'by default the heaviest folder is still first');
    await s.close();
  }

  // (b) By name, both ways — and A002 before A010, which a plain string sort
  //     gets right by luck here and wrong as soon as a clip is numbered 2 and
  //     another 10.
  {
    const s = await build();
    eq(names(s.overview({}, [], { key: 'name', dir: 'asc' })), 'A002 A010 ZULU', 'by name, A→Z');
    eq(names(s.overview({}, [], { key: 'name', dir: 'desc' })), 'ZULU A010 A002', 'and Z→A');
    await s.close();
  }

  // (c) By number of items, which is a different order again.
  {
    const s = await build();
    eq(names(s.overview({}, [], { key: 'items', dir: 'desc' })), 'A002 ZULU A010',
       'by count, the folder with the most items leads');
    eq(names(s.overview({}, [], { key: 'items', dir: 'asc' })), 'A010 ZULU A002', 'and the other way round');
    await s.close();
  }

  // (d) 🔴 Natural order on names: A2 before A10.
  {
    const { L, R } = scratch();
    for (const n of ['A10', 'A2', 'A1']) write(L, n + '/clip.mov', 'x', Date.now());
    const s = new Session();
    await s.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: { cancelled: false } });
    eq(names(s.overview({}, [], { key: 'name', dir: 'asc' })), 'A1 A2 A10',
       'numbered names sort like numbers, not like text');
    await s.close();
  }

  // (e) The order applies INSIDE an unfolded folder too, and the children stay
  //     under their own parent.
  {
    const { L, R } = scratch();
    write(L, 'DAY1/B_small.mov', 'x'.repeat(10), Date.now());
    write(L, 'DAY1/A_big.mov', 'x'.repeat(9000), Date.now());
    write(L, 'DAY2/zzz.mov', 'x'.repeat(500), Date.now());
    const s = new Session();
    await s.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: { cancelled: false } });
    eq(names(s.overview({}, ['DAY1'], { key: 'name', dir: 'asc' })), 'DAY1 A_big.mov B_small.mov DAY2',
       'a level orders by the same column as the rest');
    eq(names(s.overview({}, ['DAY1'], { key: 'bytes', dir: 'desc' })), 'DAY1 A_big.mov B_small.mov DAY2',
       'and by size the heavy clip leads its own level');
    await s.close();
  }

  // (f) Equal values must not shuffle between two refreshes: the name settles
  //     it, whichever direction the column is sorted in.
  {
    const { L, R } = scratch();
    for (const n of ['CARD_C', 'CARD_A', 'CARD_B']) write(L, n + '/clip.mov', 'x'.repeat(100), Date.now());
    const s = new Session();
    await s.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: { cancelled: false } });
    eq(names(s.overview({}, [], { key: 'bytes', dir: 'desc' })), 'CARD_A CARD_B CARD_C',
       'three folders of the same size keep a stable, alphabetical order');
    eq(names(s.overview({}, [], { key: 'bytes', dir: 'asc' })), 'CARD_A CARD_B CARD_C',
       'and the tie-break does not flip with the column');
    await s.close();
  }

  // (g) Unticking a batch really reaches the engine: setActive takes a list,
  //     and excluding a folder excludes everything under it.
  {
    const { L, R } = scratch();
    write(L, 'A/1.mov', 'x', Date.now());
    write(L, 'B/1.mov', 'x', Date.now());
    write(L, 'C/1.mov', 'x', Date.now());
    const s = new Session();
    await s.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: { cancelled: false } });
    const ov = s.overview();
    const two = ov.rows.filter(r => r.name === 'A' || r.name === 'B').map(r => r.idx);
    eq(two.length, 2, 'two folders picked');
    const st = s.setActive(two, false);
    eq(s.overview().rows.length, 1, 'the panel is left with the one still ticked');
    eq(s.overview().rows[0].name, 'C', 'and it is the right one');
    ok(st.excluded >= 4, 'everything under the two folders went with them');
    // And back on: a batch must be reversible in one gesture too.
    s.setActive(two, true);
    eq(s.overview().rows.length, 3, 'ticking them again brings all three back');
    await s.close();
  }

  // (h) Unticking a folder takes its work away, so its row would leave a panel
  //     that only lists work — taking the tick box you would use to put it
  //     back with it. "Show excluded" keeps those rows.
  {
    const { L, R } = scratch();
    write(L, 'A/1.mov', 'x'.repeat(100), Date.now());
    write(L, 'B/1.mov', 'x'.repeat(100), Date.now());
    const s = new Session();
    await s.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: { cancelled: false } });
    const a = s.overview().rows.find(r => r.name === 'A');
    s.setActive([a.idx], false);
    eq(s.overview().rows.map(r => r.name).join(' '), 'B',
       'by default an excluded folder leaves the panel, as it always did');
    const withX = s.overview({ showExcluded: true });
    eq(withX.rows.map(r => r.name).join(' '), 'B A', 'with "show excluded" it is still there');
    eq(withX.rows.find(r => r.name === 'A').active, false, 'shown unticked');
    eq(withX.rows.find(r => r.name === 'A').bytes, 0, 'and counting nothing, because nothing will move');
    await s.close();
  }

  // (i) 🔴 The filter submenu listed patterns and nothing else, so the two
  //     lines for a folder — `KADAZ/` and `/260628/KADAZ/` — read as the same
  //     thing twice. Nothing said that a leading slash is what anchors a
  //     pattern to this one place. Each entry now leads with a sentence.
  {
    const appjs = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/app.js'), 'utf8');
    // Pull the real function out of the renderer and run it: a wording check
    // that reads the source is a check on the comment, not on the menu.
    const src = appjs.slice(appjs.indexOf('function filterVariants(r) {'));
    const body = src.slice(0, src.indexOf('\n}') + 2);
    const filterVariants = eval('(' + body.replace('function filterVariants', 'function') + ')');

    const folder = filterVariants({ type: 'folder', name: 'KADAZ', rel: '260628/KADAZ' });
    eq(folder.length, 2, 'a folder offers two patterns');
    eq(folder[0].p, 'KADAZ/', 'the loose one is the bare name');
    eq(folder[0].lbl, 'Every folder with this name', 'and it says so in words');
    ok(/anywhere/.test(folder[0].sub), 'stating how far it reaches');
    eq(folder[1].p, '/260628/KADAZ/', 'the anchored one carries the whole path');
    eq(folder[1].lbl, 'This folder only', 'and says it applies to this one only');
    ok(/exact path/.test(folder[1].sub), 'naming what makes it different');
    ok(folder.every(v => /contents/.test(v.sub)), 'both say that the contents go with it');

    const file = filterVariants({ type: 'file', name: 'A001.mov', rel: 'DAY1/A001.mov' });
    eq(file.map(v => v.p).join(' '), '*.mov A001.mov /DAY1/A001.mov', 'a file offers three, widest first');
    eq(file[0].lbl, 'All .mov files', 'by extension');
    eq(file[2].lbl, 'This file only', 'and the last one is the safest');
    ok(file.every(v => v.lbl && v.sub), 'every entry has a sentence and a reach');

    // The pattern itself stays visible: it is what lands in the filter box.
    ok(/<code>\$\{esc\(v\.p\)\}<\/code>/.test(appjs), 'the pattern is still shown under the sentence');
    ok(/data-p="\$\{esc\(v\.p\)\}"/.test(appjs), 'and it is the pattern that is applied');
    ok(/Keep — add to the include filter/.test(appjs) && /Skip — add to the exclude filter/.test(appjs),
       'the two parents say which way the rule goes');
    // Three-line entries are tall: near the bottom of the screen the submenu
    // used to run off, hiding "this one only" — the safest suggestion.
    ok(/function placeSub\(sub\)/.test(appjs), 'the submenu is placed rather than left to fall off');
    ok(/sub\.parentElement\.addEventListener\('mouseenter', \(\) => placeSub\(sub\)\)/.test(appjs),
       'measured each time it opens');
  }

  // (j) The window: the header sorts, the tick box works on the selection,
  //     and a Shift range is measured in the order rows are DRAWN — sorting
  //     by name and shift-clicking must select what is between them on
  //     screen, not what would have been between them by size.
  {
    const html  = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/index.html'), 'utf8');
    const appjs = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/app.js'), 'utf8');
    for (const k of ['name', 'items', 'bytes']) {
      ok(html.includes(`data-sort="${k}"`), `the ${k} column title is a sort control`);
    }
    ok(/getOverview\(state\.view,\s*open,\s*state\.ovSort\)/.test(appjs), 'the window sends its ordering to the engine');
    ok(/state\.ovOrder = ov\.rows\.map/.test(appjs), 'it remembers the order rows were drawn in');
    ok(/state\.ovOrder\.slice\(Math\.min\(a, b\), Math\.max\(a, b\) \+ 1\)/.test(appjs),
       'and a Shift range is taken from that order');
    ok(/e\.shiftKey/.test(appjs) && /e\.metaKey \|\| e\.ctrlKey/.test(appjs), 'Shift and Cmd/Ctrl are both handled');
    ok(/ovIndicesFor\(key\)/.test(appjs), 'a tick box acts on the whole selection when the row is in it');
    ok(/API\.setActive\(idxs, on\)/.test(appjs), 'through one call, not one per folder');
    ok(/if \(state\.ovSel\.size\) \{ clearOvSel\(\); refreshOverview\(\); \}/.test(appjs),
       'working in the grid drops the batch, so Space cannot act on a selection you left behind');
    ok(/ovSort : \{ key: 'bytes', dir: 'desc' \}/.test(appjs), 'and the panel still opens sorted by size');
    // A grid cell that overflows prints over its neighbour: "Share" was wider
    // than the 36 px column it named and landed on top of "Folder".
    ok(/#ov-head > div\{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;\}/.test(html),
       'a header title too wide for its column is clipped, never drawn over the next one');
    ok(!/<div>Share<\/div>/.test(html), 'and the narrow first column is not titled with a word that cannot fit');
  }
}


// ══ 38. Getting out of a narrowed view, and what a run looks like (0.7.1) ══
// Five things Noar hit in a row on the 0.7.0, four of them about a window that
// stops answering: a grid left empty with no way back, an unreachable
// scrollbar, a run whose figures sat in a strip at the bottom, and a wait after
// the run with nothing on screen at all.
function testNarrowedViewAndRunUi() {
  console.log('\n\n38. Getting out of a narrowed view, and what a run looks like (0.7.1)');

  const html  = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/index.html'), 'utf8');
  const appjs = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/app.js'), 'utf8');

  // (a) 🔴 Unticking the folder the grid is scoped to empties the grid: the
  //     rows are still there, they just stopped being work. The window used to
  //     sit on that emptiness until you found the "Show everything" button.
  ok(/async function dropScopeIfEmpty\(\)/.test(appjs), 'an empty scope is dropped rather than left');
  ok(/const res = await API\.getRows\(0, 1, state\.view\);[\s\S]{0,80}if \(res && res\.total > 0\) return false;/.test(appjs),
     'and the window asks the engine rather than guessing');
  // Both ways of unticking have to do it: the tick box and Space.
  const boxPath = appjs.slice(appjs.indexOf('const box = e.target.closest'), appjs.indexOf('// Shift extends from the last row'));
  ok(/await dropScopeIfEmpty\(\)/.test(boxPath), 'the tick box refreshes the view it just emptied');
  const togglePath = appjs.slice(appjs.indexOf('async function toggleExcludeTemp'));
  ok(/await dropScopeIfEmpty\(\)/.test(togglePath.slice(0, 400)), 'and so does Space, and the context menu');

  // (b) The empty space of the overview is the way back to everything — and it
  //     says so, but only while there is something to go back from.
  ok(/async function showEverything\(\)/.test(appjs), 'there is one way back, not two implementations');
  ok(/if \(!it\) \{[\s\S]{0,260}if \(viewIsNarrowed\(\)\) await showEverything\(\);/.test(appjs),
     'clicking the empty part of the panel takes it');
  ok(/if \(k === 'clear'\) \{\s*\n\s*await showEverything\(\);/.test(appjs),
     'and the button in the middle of the empty grid calls the same thing');
  ok(/const back = viewIsNarrowed\(\)/.test(appjs) && /ov-reset/.test(appjs),
     'the panel says it, rather than hiding a target');
  ok(/#ov-list\.can-reset\{cursor:pointer;\}/.test(html.replace(/\s+/g, '').replace(/#ov-list\.can-reset\{cursor:pointer;\}/, '#ov-list.can-reset{cursor:pointer;}')) ||
     /can-reset\{cursor:pointer/.test(html), 'and the pointer changes over it');

  // (c) Scrollbars you can catch: 5 px of a colour one step off the background
  //     is not a control. One rule for every panel, with a floor on the thumb
  //     so a list of ten thousand rows still gives you something to hold.
  ok(!/::-webkit-scrollbar\{width:5px;\}/.test(html), 'no 5 px scrollbar is left anywhere');
  ok(/::-webkit-scrollbar\{width:13px;height:13px;\}/.test(html), 'they are wide enough to grab');
  ok(/min-height:40px/.test(html), 'and the thumb cannot shrink to nothing on a long list');
  ok(/-webkit-scrollbar-thumb:hover/.test(html), 'with a hover state, like any other control');

  // (d) During a run the progress panel stays a strip at the bottom (0.8.3 —
  //     it covered the window, frosted, from 0.7.1 to 0.8.2). Same elements,
  //     same ids; the list above stays in view and empties as files land.
  ok(/\$\('bottombar'\)\.classList\.toggle\('run', !!\(on && steps\)\);/.test(appjs),
     'a run wears the strip with its passes');
  ok(!/kiosk/.test(appjs) && !/kiosk/.test(html), 'the full-window form is gone');
  ok(!/#bottombar\{[^}]*backdrop-filter/.test(html), 'and the run panel is not frosted any more');
  ok(/classList\.toggle\('running', !!\(on && steps\)\)/.test(appjs), 'and the window says it is running');
  ok(/#app\.running #statusbar\{display:none;\}/.test(html), 'the chips describing the old comparison go away');
  ok(/#app\.running #sidebar\{pointer-events:none;\}/.test(html),
     'and the sidebar stops taking clicks, since they would change the plan and not the run');
  ok(/#app\.running #syncmodes,#app\.running #pairwrap/.test(html) && /#app\.running #gridbody\{pointer-events:none;\}/.test(html),
     'nor do the modes, the folders or the rows, now that they are in view');
  ok(/#bottombar\.open\.run\{height:auto;\}/.test(html) &&
     html.indexOf('#bottombar.open{height:196px;}') < html.indexOf('#bottombar.open.run{height:auto;}'),
     'the run strip is as tall as what it holds, after the rule that fixes the strip height');
  ok(/if \(state\.busy === 'sync'\) refreshRunGrid\(\);/.test(appjs), 'the list is asked for again while the run goes');
  // A comparison keeps the strip: the grid behind it is filling up.
  // (0.8.8) Through startCompareUi, which every comparison now shares.
  ok(/startCompareUi\('COMPARING'\)/.test(appjs) && /function startCompareUi\(title\) \{\s*setBusyUi\(true, title\);/.test(appjs),
     'a comparison is still announced in the strip');

  // (e) 🔴 The wait after a run had no name. syncto compares both folders again
  //     to confirm the result — seconds of a window answering to nothing, right
  //     after a run, which reads as a crash.
  const quiet = appjs.slice(appjs.indexOf('async function doCompareQuiet'));
  ok(/startCompareUi\('CHECKING'\)/.test(quiet.slice(0, 1200)), 'the re-comparison shows itself');
  ok(/setRecheck\('busy'/.test(appjs), 'and the summary card says what is still happening');
  ok(/Compared again: both folders now match/.test(appjs), 'then what it found');
  ok(/still need attention/.test(appjs), 'including when something is left');
  ok(/setRecheck\(null\);/.test(appjs), 'a line from the previous run never describes this one');
  ok(/finally \{\s*\n\s*state\.busy = null;[\s\S]{0,140}setBusyUi\(false\);/.test(appjs),
     'and the strip closes even if that comparison fails');
}


// ══ 39. What the run panel is allowed to claim (0.7.2) ════════════════════
// Two figures that were not what their labels said, and two files two copies
// of syncto would have fought over.
async function testRunFiguresAndLogPerProcess() {
  console.log('\n\n39. What the run panel is allowed to claim (0.7.2)');

  // (a) 🔴 "Data remaining" counted the read-back pass too, so it read about
  //     twice the size of the folder the overview had just listed: 563 GB
  //     against 285 GB on screen. The ring is right to count both passes; the
  //     tile is not, and the tile is the one people compare with the listing.
  {
    const { L, R } = scratch();
    const SIZE = 4096;
    for (const n of ['a.mov', 'b.mov', 'c.mov']) write(L, n, 'x'.repeat(SIZE), Date.now());
    const total = SIZE * 3;

    const s = new Session();
    const token = { cancelled: false, paused: false };
    const job = makeJob(L, R, { sync: { variant: 'mirror' } });
    await s.compare(job, { token });
    const seen = [];
    await s.sync(job, { token, appVersion: 'test', onProgress: p => seen.push(p) });
    await s.close();

    const copies = seen.filter(p => p.pass === 'copy');
    const checks = seen.filter(p => p.pass === 'verify');
    ok(copies.length && checks.length, 'the run went through both passes');
    eq(copies[copies.length - 1].passBytesTotal, total,
       'while copying, the tile counts the bytes of the copy — the size of the folder');
    eq(checks[checks.length - 1].passBytesTotal, total,
       'while reading back, it counts the bytes being read back');
    eq(copies[0].bytesTotal, total * 2,
       'the ring still counts both passes, because both take time');
    const last = seen[seen.length - 1];
    eq(last.passBytesTotal - last.passBytesDone, 0, 'the run ends with nothing left to copy');
    ok(copies.every(p => p.passBytesDone <= total), 'and the tile never counts past the folder');
  }

  // (b) The window says which pass the figure belongs to, rather than one word
  //     that is wrong half the time.
  {
    const appjs = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/app.js'), 'utf8');
    ok(/passBytesTotal \|\| 0\) - \(p\.passBytesDone \|\| 0\)/.test(appjs), 'the tile reads the pass figures');
    ok(/'Left to verify' : 'Left to copy'/.test(appjs), 'and its label follows the pass');
    ok(!/'Data remaining'/.test(appjs), 'the word that covered both is gone');
  }

  // (c) 🔴 Two copies of syncto, two jobs, two NAS: both load the preferences
  //     at launch and both write the whole file back, so the second to save
  //     erased what the first had changed — a server password added in one
  //     window, gone the moment the other saved its job.
  {
    const { Prefs } = require('../src/main/config');
    const { dir } = scratch();
    const A = new Prefs(dir); A.load();
    const B = new Prefs(dir); B.load();

    A.save({ servers: [{ id: 's1', name: 'NAS', host: 'nas.local', username: 'noar' }] });
    B.save({ job: { name: 'Pair 2' } });

    const onDisk = new Prefs(dir); onDisk.load();
    eq((onDisk.data.servers || []).length, 1, "the other window's server survives a save");
    eq(onDisk.data.job.name, 'Pair 2', 'and the job that was just saved is there too');

    A.save({ ui: { showEqual: true } });
    const again = new Prefs(dir); again.load();
    eq(again.data.job.name, 'Pair 2', 'a later save does not roll the other one back');
    eq(again.data.ui.showEqual, true, 'while its own change lands');

    // What a window changed itself still wins over the file: this is a merge,
    // not a surrender.
    B.save({ ui: { showEqual: false } });
    const lastRead = new Prefs(dir); lastRead.load();
    eq(lastRead.data.ui.showEqual, false, 'the most recent explicit change is the one kept');
  }

  // (e) The menu entry that starts a second copy, and the reason it spawns the
  //     executable itself: on macOS the system launcher would just bring the
  //     running copy to the front, which is the behaviour being worked around.
  {
    const mainjs = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8');
    ok(/label: 'New syncto window'/.test(mainjs), 'the File menu can start another copy');
    ok(/spawn\(process\.execPath/.test(mainjs), 'by running the executable directly');
    ok(/detached: true/.test(mainjs) && /child\.unref\(\)/.test(mainjs),
       'and letting it live on its own, so closing this window never takes it down');
    ok(/app\.isPackaged \? \[\] : \[app\.getAppPath\(\)\]/.test(mainjs),
       'which also works from a checkout, where the executable is electron itself');
  }
}


// ══ 40. Why FileZilla was faster, and what was done about it (0.7.2) ══════
// A user measured syncto against FileZilla over SFTP and FileZilla won by a
// long way. Three causes, all measured against a real server with injected
// latency: syncto asked the server ten questions per file, copied one file at
// a time on one connection, and read every byte back.
async function testSftpSpeed() {
  console.log('\n\n40. SFTP speed: chatter, lanes, and the read-back (0.7.2)');

  const { startSftpServer } = require('./sftp-server');
  const { SftpFs } = require('../src/main/fs/sftp');

  // (a) 🔴 A folder confirmed once is not confirmed again. mkdir used to walk
  //     the whole path stat'ing every segment, for EVERY file.
  {
    const { dir } = scratch();
    const remote = path.join(dir, 'server');
    fs.mkdirSync(remote, { recursive: true });
    const srv = await startSftpServer({ root: remote });
    const sftp = new SftpFs({ host: srv.host, port: srv.port, username: srv.username, password: srv.password });
    await sftp.connect();

    let stats = 0;
    const realQ = sftp._q.bind(sftp);
    sftp._q = (label, fn) => { if (/^stat /.test(label)) stats++; return realQ(label, fn); };

    const deep = '/volume1/PROJET/01_RUSHES/DAY1';
    await sftp.mkdir(deep);
    ok(stats >= 4, `the first time, every level is checked (${stats} stats)`);

    stats = 0;
    for (let i = 0; i < 10; i++) await sftp.mkdir(deep);
    eq(stats, 0, 'the next ten files ask nothing at all');

    await sftp.rmdir(deep);
    stats = 0;
    await sftp.mkdir(deep);
    ok(stats > 0, 'a folder that was removed is checked again');
    ok(await sftp.exists(deep), 'and recreated');

    await sftp.close();
    await srv.close();
  }

  // (b) The engine asks for less per file. Counted on a real run, through the
  //     real code path, because this is a claim about round trips.
  {
    const { dir } = scratch();
    const remote = path.join(dir, 'server');
    const deep = 'volume1/PROJET/01_RUSHES/DAY1';
    fs.mkdirSync(path.join(remote, deep), { recursive: true });
    const L = path.join(dir, 'src', deep);
    fs.mkdirSync(L, { recursive: true });
    for (let i = 0; i < 6; i++) write(L, `clip${i}.mov`, 'x'.repeat(4096), Date.now());

    const srv = await startSftpServer({ root: remote });
    const tally = new Map();
    const origQ = SftpFs.prototype._q;
    SftpFs.prototype._q = function (label, fn) {
      const k = String(label).split(' ')[0];
      tally.set(k, (tally.get(k) || 0) + 1);
      return origQ.call(this, label, fn);
    };
    try {
      const job = makeJob(L, `sftp://${srv.username}:${srv.password}@${srv.host}:${srv.port}/${deep}`,
        { sync: { variant: 'mirror', lockFolders: false, transferLanes: 1 } });
      const s = new Session();
      const token = { cancelled: false, paused: false };
      await s.compare(job, { token });
      tally.clear();
      const run = await s.sync(job, { token, appVersion: 'test' });
      await s.close();
      eq(run.counters.files, 6, 'the six files were copied');
      const total = [...tally.values()].reduce((a, b) => a + b, 0);
      // It was 10.2 requests per file before this release, 8.1 of them stats.
      ok(total / 6 <= 6, `a copied file costs at most six requests (${(total / 6).toFixed(1)})`);
      ok((tally.get('stat') || 0) / 6 <= 3.5,
         `of which at most three and a half stats (${((tally.get('stat') || 0) / 6).toFixed(1)})`);
    } finally {
      SftpFs.prototype._q = origQ;
      await srv.close();
    }
  }

  // (c) 🔴 Lanes: several files at once, each on its own connection. One
  //     connection cannot beat the SSH window (2 MB, a constant inside ssh2)
  //     divided by the round trip, so this is the only way past it.
  {
    const { dir } = scratch();
    const remote = path.join(dir, 'server');
    fs.mkdirSync(remote, { recursive: true });
    const L = path.join(dir, 'src');
    fs.mkdirSync(L, { recursive: true });
    for (let i = 0; i < 12; i++) write(L, `clip${i}.mov`, 'x'.repeat(256 * 1024), Date.now());
    const srv = await startSftpServer({ root: remote, latencyMs: 12 });
    const addr = `sftp://${srv.username}:${srv.password}@${srv.host}:${srv.port}/`;

    const run = async lanes => {
      fs.rmSync(remote, { recursive: true, force: true });
      fs.mkdirSync(remote, { recursive: true });
      const job = makeJob(L, addr, { sync: { variant: 'mirror', lockFolders: false, transferLanes: lanes } });
      const s = new Session();
      const token = { cancelled: false, paused: false };
      await s.compare(job, { token });
      const t0 = Date.now();
      const res = await s.sync(job, { token, appVersion: 'test' });
      const ms = Date.now() - t0;
      await s.close();
      eq(res.counters.files, 12, `${lanes} lane(s): every file arrived`);
      eq(res.errors.length, 0, `${lanes} lane(s): without an error`);
      for (let i = 0; i < 12; i++) {
        eq(fs.statSync(path.join(remote, `clip${i}.mov`)).size, 256 * 1024, `${lanes} lane(s): clip${i} is whole`);
      }
      return ms;
    };

    const one = await run(1);
    const four = await run(4);
    ok(four < one, `four lanes beat one (${one} ms → ${four} ms at 12 ms of latency)`);
    await srv.close();
  }

  // (d) 🔴 Cancelling a run with four files in flight — exactly where a cancel
  //     can leave a promise hanging, or a half-written file wearing a final
  //     name.
  {
    const { dir } = scratch();
    const remote = path.join(dir, 'server');
    fs.mkdirSync(remote, { recursive: true });
    const L = path.join(dir, 'src');
    fs.mkdirSync(L, { recursive: true });
    for (let i = 0; i < 16; i++) write(L, `clip${i}.mov`, 'x'.repeat(512 * 1024), Date.now());
    const srv = await startSftpServer({ root: remote, latencyMs: 5 });
    const job = makeJob(L, `sftp://${srv.username}:${srv.password}@${srv.host}:${srv.port}/`,
      { sync: { variant: 'mirror', lockFolders: false, transferLanes: 4 } });
    const s = new Session();
    const token = { cancelled: false, paused: false };
    await s.compare(job, { token });
    setTimeout(() => { token.cancelled = true; }, 250);
    const t0 = Date.now();
    const res = await s.sync(job, { token, appVersion: 'test' });
    const ms = Date.now() - t0;
    await s.close();
    ok(res.cancelled, 'the run reports itself cancelled');
    ok(ms < 20000, `and settles promptly (${ms} ms) rather than hanging on four workers`);
    const left = fs.readdirSync(remote);
    eq(left.filter(f => f.endsWith('.syncto_tmp')).length, 0,
       'no half-written file is left behind under its temporary name');
    for (const f of left) {
      if (f.startsWith('.syncto')) continue;          // the database, not a copy
      eq(fs.statSync(path.join(remote, f)).size, 512 * 1024,
         `${f} carries its final name only because it is whole`);
    }
    await srv.close();
  }

  // (e) The read-back can be turned off FOR A SERVER, and for nothing else.
  {
    const { L, R } = scratch();
    write(L, 'a.mov', 'x'.repeat(4096), Date.now());
    const s = new Session();
    const token = { cancelled: false, paused: false };
    const job = makeJob(L, R, { sync: { variant: 'mirror', verifyRemote: false } });
    await s.compare(job, { token });
    const res = await s.sync(job, { token, appVersion: 'test' });
    await s.close();
    eq(res.verified, 1, 'a local copy is verified whatever the server setting says');
  }

  // (f) On a server, off means off: nothing is read back, and the ring stops
  //     promising a second pass.
  {
    const { dir } = scratch();
    const remote = path.join(dir, 'server');
    fs.mkdirSync(remote, { recursive: true });
    const L = path.join(dir, 'src');
    fs.mkdirSync(L, { recursive: true });
    write(L, 'a.mov', 'x'.repeat(8192), Date.now());
    const srv = await startSftpServer({ root: remote });
    const addr = `sftp://${srv.username}:${srv.password}@${srv.host}:${srv.port}/`;

    const go = async (verifyRemote) => {
      fs.rmSync(remote, { recursive: true, force: true });
      fs.mkdirSync(remote, { recursive: true });
      const job = makeJob(L, addr, { sync: { variant: 'mirror', lockFolders: false, verifyRemote } });
      const s = new Session();
      const token = { cancelled: false, paused: false };
      await s.compare(job, { token });
      const seen = [];
      const res = await s.sync(job, { token, appVersion: 'test', onProgress: p => seen.push(p) });
      await s.close();
      return { res, seen };
    };

    const off = await go(false);
    eq(off.res.counters.files, 1, 'the file is copied');
    eq(off.res.verified, 0, 'and nothing is read back');
    eq(fs.readFileSync(path.join(remote, 'a.mov'), 'utf8').length, 8192, 'the file on the server is whole');
    ok(off.seen.every(p => p.pass !== 'verify'), 'there is no verification pass at all');
    ok(off.seen.every(p => p.willVerify === false), 'and the run says so, so the window drops the step');
    eq(off.seen[0].bytesTotal, 8192, 'the ring counts one pass, not two');

    const on = await go(true);
    eq(on.res.verified, 1, 'with it on, the file is read back');
    eq(on.seen[0].bytesTotal, 8192 * 2, 'and the ring counts both passes again');
    await srv.close();
  }

  // (g) The window and the settings, wired.
  {
    const html  = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/index.html'), 'utf8');
    const appjs = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/app.js'), 'utf8');
    const { defaultJob } = require('../src/main/config');
    eq(defaultJob().sync.verifyRemote, true, 'the read-back is on out of the box');
    eq(defaultJob().sync.transferLanes, 4, 'and four files at a time on a server');
    ok(/id="st-verify-remote"/.test(html) && /id="st-lanes"/.test(html), 'both settings are in the window');
    ok(/j\.sync\.verifyRemote\s*=\s*\$\('st-verify-remote'\)\.checked/.test(appjs), 'the switch reaches the job');
    ok(/j\.sync\.transferLanes\s*=\s*Number\(\$\('st-lanes'\)\.value\)/.test(appjs), 'and so does the count');
    ok(/copied — not read back/.test(appjs), 'a run with no read-back says so on the summary card');
    // (0.8.8) Through the remembered flag: not every event carries it.
    ok(/if \(p\.willVerify != null\) state\.lastWillVerify = p\.willVerify;/.test(appjs) &&
       /renderSteps\(p\.pass, state\.lastWillVerify\)/.test(appjs), 'and the steps drop the pass that will not happen');
  }
}


// ══ 41. The bridge must carry every argument the handler reads (0.7.3) ════
// "After the synchronization: shut down" did nothing, on macOS and on Windows
// alike, and the reason was neither of them: the preload forwarded ONE
// argument to a handler that refuses to act unless the SECOND one is exactly
// true. So every request was turned down as "the run did not finish cleanly",
// on every platform, for ever.
//
// This section reads the two files and compares them, channel by channel.
function testIpcArity() {
  console.log('\n\n41. The bridge carries every argument (0.7.3)');

  const root = path.join(__dirname, '..');
  const preload = fs.readFileSync(path.join(root, 'src/main/preload.js'), 'utf8');
  const mainjs  = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');

  // What the window sends: ipcRenderer.invoke('channel', a, b, …)
  const sent = new Map();
  for (const m of preload.matchAll(/ipcRenderer\.invoke\(\s*'([^']+)'\s*([^)]*)\)/g)) {
    const rest = m[2].trim();
    const args = rest ? rest.replace(/^,/, '').split(',').filter(s => s.trim()).length : 0;
    sent.set(m[1], args);
  }
  ok(sent.size > 20, `the bridge exposes ${sent.size} channels`);

  // What the main process reads: ipcMain.handle('channel', (_, x, y) => …)
  const read = new Map();
  for (const m of mainjs.matchAll(/ipcMain\.handle\(\s*'([^']+)'\s*,\s*(?:async\s*)?\(([^)]*)\)/g)) {
    const params = m[2].split(',').map(s => s.trim()).filter(Boolean);
    read.set(m[1], Math.max(0, params.length - 1));   // the event is not an argument
  }
  ok(read.size > 20, `the main process answers ${read.size} of them`);

  // Every channel the window calls must exist, and must be given everything
  // the handler looks at. A handler reading more than it is sent gets
  // `undefined` — and `undefined` passes no test that expects a value.
  const missing = [...sent.keys()].filter(c => !read.has(c));
  eq(missing.join(', '), '', 'every channel the window calls is answered');

  const short = [];
  for (const [channel, given] of sent) {
    const wanted = read.get(channel);
    if (wanted != null && given < wanted) short.push(`${channel}: sends ${given}, reads ${wanted}`);
  }
  eq(short.join(' | '), '', 'and none is called with fewer arguments than it reads');

  // The one that was broken, named, so a future edit cannot quietly undo it.
  eq(sent.get('after-sync'), 2, 'after-sync carries the action AND whether the run was clean');
  ok(/afterSync\s*:\s*\(action, clean\)/.test(preload), 'the bridge names both');
  ok(/API\.afterSync\(afterState\.action, afterState\.clean === true\)/
     .test(fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8')),
     'and the window still sends both');

  // macOS refuses an Apple event from a signed app that has not asked for the
  // right. Shutting down goes through System Events, so without these two the
  // machine stays on and the log says nothing a person can act on.
  {
    const ent = fs.readFileSync(path.join(root, 'build-resources/entitlements.mac.plist'), 'utf8');
    const yml = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
    ok(/com\.apple\.security\.automation\.apple-events/.test(ent),
       'the signed app is allowed to send Apple events');
    ok(/NSAppleEventsUsageDescription/.test(yml),
       'and says why, which is what the permission prompt shows');
    const { commandFor } = require('../src/main/power');
    ok(/System Events/.test(commandFor('shutdown', 'darwin').args.join(' ')),
       'because that is how the Mac is asked to shut down');
  }

  // The buttons of a card stay in view while its content scrolls. The settings
  // panel is two screens tall, and the only way out of it used to be at the
  // bottom of that scroll.
  {
    const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
    ok(/\.mcard > \.m-btns\{position:sticky;bottom:-24px;/.test(html),
       'a card keeps its buttons on screen');
    // The card pads itself by 24 px; a sticky bar that does not cancel that
    // padding floats above the edge with a strip of scrolling content under it.
    ok(/margin:20px -24px -24px;/.test(html), 'flush with the bottom of the card, not floating above it');
    // Under the charte (0.7.4) the bar is told from the scrolling content by
    // being OPAQUE, on the card's own surface — no line.
    const last = html.lastIndexOf('.mcard > .m-btns{');
    ok(/^\.mcard > \.m-btns\{background:var\(--card\);border-top:none;/.test(html.slice(last)),
       'opaque, on the card surface, so the content is seen to pass behind it');
  }

  // The settings carry labels and nothing else (0.8.3). A description that
  // has to be kept in step with the code — the abandoned-lock window moved
  // from 12 to 60 s in 0.6.2 and the panel kept saying 12 — is gone with them.
  {
    const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
    const a = html.indexOf('<div class="ov" id="ov-settings">');
    const panel = html.slice(a, html.indexOf('<div class="set-section" id="custom-section"', a));
    ok(!/set-hint|m-sub/.test(panel), 'no paragraph of explanation in the settings');
    const descs = [...panel.matchAll(/<span class="set-desc">([^<]+)</g)].map(m => m[1]);
    eq(descs.length, 14, 'one short line beside each control');   // (0.8.9) + Windows-safe names
    ok(descs.every(d => d.length <= 48), 'short enough to fit beside it');
    ok(/\.set-desc\{[^}]*white-space:nowrap;/.test(html), 'and it never wraps to a second line');
    eq([...panel.matchAll(/set-sec-title">([^<]+)</g)].map(m => m[1]),
       ['Main', 'S-FTP', 'Deletion', 'Notifications'], 'four sections, in this order');
    eq([...panel.matchAll(/<option value="(\d+)"/g)].map(m => Number(m[1])), [1,2,3,4,5,6,7,8,9,10],
       'up to ten transfers at a time, like FileZilla');
    ok(!/st-perm-fallback|st-after|st-rep|st-log|st-ntfy-token|st-ntfy-problem/.test(html),
       'and the switches that were removed are gone from the page');
    ok(!/ntfy-steps|ntfy-sub/.test(panel), 'the QR code has no text around it');
    ok(/<div class="ntfy-grid">\s*<div class="ntfy-fields">[\s\S]*st-ntfy-server[\s\S]*st-ntfy-topic[\s\S]*<\/div>\s*<div class="ntfy-qr">/.test(panel),
       'and sits to the right of the server and topic fields');
  }

  // And when it is refused anyway, the message names the setting to change.
  {
    const power = fs.readFileSync(path.join(root, 'src/main/power.js'), 'utf8');
    ok(/Privacy & Security › Automation/.test(power),
       'a refusal points at the panel that fixes it, not at an error number');
  }
}


// ══ 42. The charte UI (0.7.4) ════════════════════════════════════════════
// syncto now wears the visual language shared by Noar's applications
// (charte-ui-noar.md). A redesign breaks nothing a test would notice, and can
// quietly come undone: these are the promises the charte makes that a later
// edit could take back without anyone seeing it on the first screen.
function testCharte() {
  console.log('\n\n42. The charte UI (0.7.4)');
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
  const app  = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
  const css  = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const at   = css.indexOf('CHARTE UI');
  ok(at > 0, 'the charte is one block laid over the stylesheet');
  const block = css.slice(at);

  // Last, or the rules it overrides win back by coming later.
  ok(css.indexOf('#bottombar.kiosk{') < at && css.indexOf('.mcard > .m-btns{position:sticky') < at,
     'and it comes after every rule it overrides');

  // The accent is syncto's own and marks the brand only.
  // syncto's identity colour, validated 21.09.2026: the cyan of its icon. Not
  // ingesto's violet, and not the magenta first tried, which is presto's.
  ok(/--accent:#2cc4ea;/.test(block), "the accent is syncto's cyan, not ingesto's violet nor presto's magenta");
  {
    const svg = fs.readFileSync(path.join(root, 'build-resources/icon.svg'), 'utf8');
    ok(/stroke="#2cc4ea"/.test(svg), 'and it is the colour of the icon');
    // The loop, not a folder: projecto and renamo already draw one.
    ok(!/linearGradient|folder/i.test(svg.replace(/<!--[\s\S]*?-->/g, '')), 'which is no longer a folder');
    ok(!/#ff0062|#5936d8/i.test(svg.replace(/<!--[\s\S]*?-->/g, '')), 'which no longer carries the old violet or magenta');
  }
  const accentUses = block.split('\n').filter(l => /var\(--accent\)/.test(l));
  eq(accentUses.map(l => l.trim().split('{')[0]).join(' | '), '.t-logo > span',
     'and the charte block uses it on the logo and nowhere else');
  ok(/--accent-d:rgba\(255,255,255,\.06\);\s*--accent-g:rgba\(255,255,255,\.18\);/.test(block),
     'a rule still asking for the old accent tint gets grey, never magenta');

  // Four state colours. Violet is folded into blue.
  ok(/--violet:var\(--blue\);\s*--violet-d:var\(--blue-d\);/.test(block),
     'violet is gone: a detected move is blue');

  // The chips under the grid speak the grid's colour code. They did not: an
  // update was orange in the grid and blue in its chip, a deletion red and orange.
  {
    const grid = {};
    for (const m of app.matchAll(/^\s*(\w+)\s*:\s*\{[^}]*cls: '(arr-\w+)/gm)) grid[m[1]] = m[2];
    // (0.8.8) Conflicts are orange in the grid now (red is for deletions).
    const colour = { 'arr-add': 'g', 'arr-upd': 'o', 'arr-del': 'r', 'arr-mov': 'b', 'arr-cfl': 'o' };
    const wrong = [];
    for (const m of app.matchAll(/chip\('(\w?)', '[^']*', s\.\w+,\s*'(\w+)'/g)) {
      const want = colour[grid[m[2]]];
      if (want && want !== m[1]) wrong.push(`${m[2]}: chip ${m[1] || '-'}, grid ${want}`);
    }
    ok(Object.keys(grid).length >= 10, 'the grid colour table is read');
    eq(wrong.join(' | '), '', 'every chip has the colour of its arrow in the grid');
  }

  // No structural line: the old border tokens are transparent.
  ok(/--border:transparent;\s*--border2:transparent;/.test(block),
     'grouping is carried by the background: the border tokens are transparent');
  // Read the charte's OWN rule for each container, not any rule that happens
  // to mention it: "#toolbar .tbtn{border:none}" says nothing about #toolbar.
  for (const sel of ['#toolbar{', '#statusbar{', '#pairwrap{', '.mcard{', '.sb-hd{']) {
    const rule = (block.match(new RegExp('(?:^|[\\s,}])' + sel.replace(/[.#{]/g, c => '\\' + c) + '[^}]*', 'm')) || [''])[0];
    ok(/border(-bottom|-top)?:none/.test(rule), `${sel.slice(0, -1)} carries no line`);
  }

  // The modes: grey, the chosen one on a surface with a green tick.
  ok(/\.mbtn\.on,#var-twoWay\.on,#var-mirror\.on,#var-update\.on,#var-custom\.on\{\s*background:var\(--ins\);border:none;box-shadow:none;\}/.test(block),
     'the chosen mode sits on a hollow, no coloured frame');
  ok(/stroke='%2335c98b'/.test(block), 'with a green tick');

  // (0.8.1) Each mode's icon says what the mode does to the files, in the
  // charte's own colours — so the colour carries a meaning rather than a mood.
  {
    const modeColour = id => {
      const m = new RegExp(`#var-${id} \\.mico\\{color:var\\(--(\\w+)\\)`).exec(block);
      return m ? m[1] : null;
    };
    eq(modeColour('twoWay'), 'blue',   '2 WAYS is blue: neutral, nothing is removed');
    eq(modeColour('mirror'), 'orange', 'MIRROR is orange: it removes, which is a decision');
    eq(modeColour('update'), 'green',  'UPDATE is green: it adds and updates, never removes');
    eq(modeColour('custom'), 'text2',  'CUSTOM is grey: it is whatever the settings make it');
    ok(!/#var-\w+ \.mico\{color:var\(--red\)/.test(block),
       'and no mode is red: red is kept for the rows that will be deleted');
    ok(block.lastIndexOf('#var-mirror .mico{color:var(--orange)') > block.lastIndexOf('.mbtn.on .mico{'),
       'the chosen mode keeps its colour instead of turning white');
  }

  // Every button that is only an icon says what it is to a screen reader.
  {
    const bare = [];
    for (const m of html.matchAll(/<button\b([^>]*)>\s*<svg(?:(?!<\/?button)[\s\S])*?<\/svg>\s*<\/button>/g))
      if (!/aria-label=/.test(m[1])) bare.push((/id="([^"]+)"/.exec(m[1]) || [, m[1].slice(0, 40)])[1]);
    for (const m of app.matchAll(/<button\b([^>]*)>\$\{ICON_\w+\}<\/button>/g))
      if (!/aria-label=/.test(m[1])) bare.push((/class="([^"]+)"/.exec(m[1]) || [, '?'])[1]);
    eq(bare.join(', '), '', 'every icon-only button carries an aria-label');
  }

  // Escape closes every window, through its own safe button.
  {
    const ids = [...html.matchAll(/class="ov" id="([\w-]+)"/g)].map(m => m[1]);
    const esc = app.slice(app.indexOf('const ESC_CLOSE'), app.indexOf('};', app.indexOf('const ESC_CLOSE')));
    ok(ids.length >= 9, `the page has ${ids.length} windows`);
    eq(ids.filter(id => !esc.includes(`'${id}'`)).join(', '), '', 'Escape knows every one of them');
  }

  // The documented exception: the resize handles stay, and are invisible
  // until the pointer is on them.
  ok(/id="split-sb"/.test(html) && /id="split-jobs"/.test(html), 'the resize handles are still there');
  ok(/\.split-v\{width:12px;padding:0 5px;background-color:transparent;\}/.test(block),
     'drawn as the 12 px gap itself, with no line at rest');
}


// ══ 43. Security hardening (0.8.0) ═══════════════════════════════════════
// An audit of 0.7.4 found four ways the OTHER side of a synchronization — a
// server, or anything answering in its place — could reach past the folders
// the user chose. These are the guards, tested the way they will be attacked.
async function testSecurity() {
  console.log('\n\n43. What the other side is allowed to do (0.8.0)');
  const root = path.join(__dirname, '..');
  const { isSafeRel, isSafeName, assertSafeRel } = require('../src/main/core/relpath');
  const { startSftpServer } = require('./sftp-server');
  const { SftpFs, setHostKeyPolicy, fingerprintOf } = require('../src/main/fs/sftp');

  // (a) What a relative path may look like.
  {
    for (const bad of ['../x', 'a/../../b', '/etc/passwd', '\\\\windows', 'a\\\\..\\\\..\\\\b', 'C:/x', 'a//b', 'a/./b', 'a\u0000b'])
      ok(!isSafeRel(bad), `refused: ${JSON.stringify(bad)}`);
    for (const good of ['', 'A001_C001.mov', 'DAY1/CARD_A/clip.mov', 'a b/c.d', 'é/ü.mov'])
      ok(isSafeRel(good), `allowed: ${JSON.stringify(good)}`);
    ok(!isSafeName('a/b') && !isSafeName('..') && isSafeName('clip.mov'), 'a name is one segment');
    let threw = false;
    try { assertSafeRel('../../etc/passwd', 'This item'); } catch (e) { threw = /points outside the folder/.test(e.message); }
    ok(threw, 'and the guard says why it refused');
  }

  // (b) 🔴 The engine builds every path through abs(). A name the other side
  //     chose used to be joined onto the root, and join() resolves '..'.
  {
    const { SyncRunner } = require('../src/main/core/sync');
    const r = Object.create(SyncRunner.prototype);
    r.left  = { fs: new NativeFs(), path: '/tmp/left' };
    r.right = { fs: new NativeFs(), path: '/tmp/right' };
    r.side = function (w) { return w === 'left' ? this.left : this.right; };
    eq(r.abs('right', 'DAY1/clip.mov'), path.join('/tmp/right', 'DAY1', 'clip.mov'), 'an ordinary path is joined');
    let threw = false;
    try { r.abs('right', '../../../../tmp/pwned.txt'); } catch (_) { threw = true; }
    ok(threw, 'one that climbs out is refused before anything is opened');
  }

  // (c) 🔴 A remote name that is really a path never reaches the comparison.
  {
    const fake = Object.create(SftpFs.prototype);
    fake._q = (label, fn) => Promise.resolve().then(fn);
    fake.sftp = { readdir: (_d, cb) => cb(null, [
      { filename: 'A001_C001.mov', attrs: { mode: 0o100644, size: 12, mtime: 1 } },
      { filename: '../../../../Users/victim/Library/LaunchAgents/evil.plist', attrs: { mode: 0o100644, size: 3, mtime: 1 } },
      { filename: 'sub\\\\..\\\\..\\\\evil.exe', attrs: { mode: 0o100644, size: 3, mtime: 1 } },
      { filename: '.', attrs: { mode: 0o040755 } },
    ]) };
    const list = await fake.readdir('/export');
    eq(list.map(e => e.name).join(','), 'A001_C001.mov', 'only the name that is a name survives');
  }

  // (d) 🔴 A checksum list is a file inside the folder, so it is data.
  {
    const { dir } = scratch();
    const nfs = new NativeFs();
    fs.writeFileSync(path.join(dir, 'clip.mov'), 'x');
    fs.writeFileSync(path.join(dir, 'syncto-checksums.txt'),
      '# syncto checksum list\n# algorithm: xxh64\n' +
      '9a0a1b2c3d4e5f60  ../../../../etc/hosts\n' +
      '9a0a1b2c3d4e5f60  clip.mov\n');
    const { verifyFolder } = require('../src/main/core/session');
    const { FsPool } = require('../src/main/fs/afs');
    const pool = new FsPool();
    const res = await verifyFolder(pool, dir, { token: {} });
    await pool.closeAll();
    const escaped = res.results.find(r => /etc\/hosts/.test(r.rel));
    ok(escaped && escaped.status === 'error' && /outside the folder/.test(escaped.error || ''),
       'an entry that points outside is refused, not hashed');
  }

  // (e) 🔴 Who is answering on that address. First connection remembers the
  //     key; a different key stops the handshake BEFORE the password is sent.
  {
    const { dir } = scratch();
    const remote = path.join(dir, 'server');
    fs.mkdirSync(remote, { recursive: true });
    const srv = await startSftpServer({ root: remote });
    const seen = [];
    setHostKeyPolicy({ known: () => null, remember: (h, p, fp) => seen.push(fp) });
    const one = new SftpFs({ host: srv.host, port: srv.port, username: srv.username, password: srv.password });
    await one.connect();
    await one.close();
    eq(seen.length, 1, 'the first connection writes the identity down');
    ok(/^SHA256:[A-Za-z0-9+/]{20,}$/.test(seen[0]), `and it is a fingerprint (${seen[0].slice(0, 20)}…)`);

    setHostKeyPolicy({ known: () => 'SHA256:somethingelsethatisnotthiskey', remember: () => {} });
    const two = new SftpFs({ host: srv.host, port: srv.port, username: srv.username, password: srv.password });
    let err = null;
    try { await two.connect(); } catch (e) { err = e; }
    try { await two.close(); } catch (_) {}
    ok(err, 'a server whose key changed is refused');
    ok(err && err.hostKeyChanged && /identity of .* has changed/.test(err.message),
       'and the message says so, with both fingerprints');

    // The same key again: nothing to report, the connection just works.
    setHostKeyPolicy({ known: () => seen[0], remember: () => {} });
    const three = new SftpFs({ host: srv.host, port: srv.port, username: srv.username, password: srv.password });
    await three.connect();
    ok(true, 'the key it already knows is accepted in silence');
    await three.close();
    setHostKeyPolicy(null);
    await srv.close();
  }

  // (f) Forgetting a server forgets its identity: the one deliberate way to
  //     accept a key that really did change.
  {
    const { Prefs } = require('../src/main/config');
    const { dir } = scratch();
    const prefs = new Prefs(dir);
    prefs.load();
    const saved = prefs.saveServer({ name: 'NAS', host: 'nas.local', port: 22, username: 'noar', savePassword: false });
    prefs.rememberHostKey('nas.local', 22, 'SHA256:abc');
    eq(prefs.knownHostKey('nas.local', 22), 'SHA256:abc', 'an identity is remembered per host and port');
    eq(prefs.knownHostKey('nas.local', 2222), null, 'another port is another machine');
    prefs.removeServer(saved.server.id);
    eq(prefs.knownHostKey('nas.local', 22), null, 'forgetting the server forgets the key');
    ok(!/password/i.test(JSON.stringify(prefs.data.knownHosts || {})), 'a fingerprint is not a secret, and no secret is near it');
  }

  // (g) 🔴 The database sits inside the synchronized folder, so its size is
  //     not ours to trust.
  {
    const { dir } = scratch();
    const nfs = new NativeFs();
    const notes = [];
    fs.writeFileSync(path.join(dir, '.syncto.db'), Buffer.alloc(17 * 1024 * 1024, 0x41));
    const db = await require('../src/main/core/db').readDb(nfs, dir, m => notes.push(m));
    eq(db, null, 'a file too large to be a database is not read');
    ok(notes.some(n => /larger than/.test(n)), 'and it is reported as damaged, not as absent');
  }

  // (h) The window may name a lock to clear. It may not name anything else.
  {
    const { isLockFileName, LOCK_NAME } = require('../src/main/core/lock');
    ok(isLockFileName(LOCK_NAME), 'a lock file');
    ok(isLockFileName(`Delete.0.${LOCK_NAME}`) && isLockFileName(`Delete.1.Delete.0.${LOCK_NAME}`), 'and its corpses, nested');
    for (const bad of [`Delete.0.${LOCK_NAME}/../../thesis.docx`, `Delete.0.${LOCK_NAME}.mov`, 'notes.txt', '', `x${LOCK_NAME}`])
      ok(!isLockFileName(bad), `not ${JSON.stringify(bad)}`);
  }

  // (i) The main process, read as a document: the three channels the audit
  //     said were wider than they need to be.
  {
    const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
    ok(/sandbox: true/.test(main), 'the renderer runs inside the OS sandbox');
    // (0.8.8) Narrower still: the channel is gone (nothing used it).
    ok(!/ipcMain\.handle\('open-path'/.test(main),
       'no channel opens whatever it is handed');
    // The ntfy token went in 0.8.3: there is nothing stored left to leak.
    ok(!/token\s*:\s*cfg\.token/.test(main) && !/Authorization/.test(main),
       'and no stored ntfy token travels anywhere, since none is kept');
    const ent = fs.readFileSync(path.join(root, 'build-resources/entitlements.mac.plist'), 'utf8');
    ok(!/<key>com\.apple\.security\.cs\.disable-library-validation<\/key>/.test(ent),
       'the signed app no longer accepts unsigned libraries');
  }
}


// ══ 44. What the audit of 0.7.4 found in the engine (0.8.0) ══════════════
// Seven defects, each reproduced before it was fixed. They share one shape:
// the run went on and REPORTED success while something it promised had not
// happened.
async function testAuditFixes080() {
  console.log('\n\n44. The engine defects the audit found (0.8.0)');
  const { startSftpServer } = require('./sftp-server');
  const { SftpFs } = require('../src/main/fs/sftp');
  const { createHasher, hashStream } = require('../src/main/core/hash');
  const nfs = new NativeFs();

  // (a) 🔴 Fail-safe off + a link where the file goes = writing THROUGH it.
  //     The master the link pointed at — outside both folders — was
  //     overwritten, and the run said only "Size mismatch after copy".
  {
    const { dir, L, R } = scratch();
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    const master = path.join(outside, 'MASTER.mov');
    fs.writeFileSync(master, 'THE ONLY MASTER — 30 minutes of rushes');
    write(L, 'A001_C001.mov', 'new proxy, much shorter');
    fs.symlinkSync(master, path.join(R, 'A001_C001.mov'));

    const job = makeJob(L, R, { sync: { variant: 'mirror', failSafe: false, deletion: 'permanent' } });
    const { run } = await runPair(job);
    eq(fs.readFileSync(master, 'utf8'), 'THE ONLY MASTER — 30 minutes of rushes',
       'the file the link pointed at is untouched');
    eq(fs.readFileSync(path.join(R, 'A001_C001.mov'), 'utf8'), 'new proxy, much shorter',
       'and the copy landed where it was meant to');
    ok(!fs.lstatSync(path.join(R, 'A001_C001.mov')).isSymbolicLink(), 'the link itself is gone');
    eq(run.errors.length, 0, 'with no error to explain away');
  }

  // (b) 🔴 A root that vanishes between the comparison and Synchronize. It
  //     was re-created — on the startup disk, under the mount point — and the
  //     run copied into it and reported success.
  {
    const { dir, L } = scratch();
    const mount = path.join(dir, 'Volumes', 'RAID', 'Project');
    fs.mkdirSync(mount, { recursive: true });
    write(L, 'A001_C001.mov', 'clip one');
    write(L, 'A001_C002.mov', 'clip two');
    const job = makeJob(L, mount, { sync: { variant: 'mirror' } });
    const s = new Session();
    const token = { cancelled: false, paused: false };
    await s.compare(job, { token });
    // The cable goes.
    fs.rmSync(path.join(dir, 'Volumes'), { recursive: true, force: true });
    let err = null;
    try { await s.sync(job, { token, appVersion: 'test' }); } catch (e) { err = e; }
    await s.close();
    ok(err && /no longer there/i.test(err.message), 'the run refuses');
    ok(!fs.existsSync(mount), 'and nothing was re-created on the disk underneath');
  }

  // (c) 🔴 One checksum mismatch used to end the whole read-back pass — and
  //     every file already copied was written into the database as
  //     synchronized, so no later run ever looked at them again.
  {
    const { dir, L, R } = scratch();
    for (let i = 1; i <= 6; i++) write(L, `A001_C00${i}.mov`, `clip ${i} `.repeat(64));
    const job = makeJob(L, R, { sync: { variant: 'mirror', ignoreErrors: false, retryCount: 0 } });

    // Corrupt exactly one file the moment it has been copied, so its read-back
    // fails while the five others are perfectly good.
    const { SyncRunner } = require('../src/main/core/sync');
    const realCopy = SyncRunner.prototype.copyOne;
    SyncRunner.prototype.copyOne = async function (item, lane) {
      const res = await realCopy.call(this, item, lane);
      if (item.n.rel === 'A001_C003.mov') fs.writeFileSync(path.join(R, item.n.rel), 'corrupted');
      return res;
    };
    let run;
    try { ({ run } = await runPair(job)); } finally { SyncRunner.prototype.copyOne = realCopy; }

    eq(run.verified, 5, 'the five good files are read back');
    eq(run.errors.length, 1, 'and the corrupt one is the only error');
    const db = await require('../src/main/core/db').readDb(nfs, R, () => {});
    const names = Object.values(db.sessions || {}).flatMap(x => Object.keys(x.items || {}));
    ok(!names.includes('A001_C003.mov'), 'the file that failed is not recorded as synchronized');
    eq(names.filter(n => /A001_C00/.test(n)).length, 5, 'and the five proven ones are');
  }

  // (e) 🔴 A server that caps its READs. A short reply is not the end of the
  //     file — reading it as one left a hole in every chunk, ended the stream
  //     cleanly, and turned good files into "checksum mismatch" for ever.
  {
    const { dir } = scratch();
    const remote = path.join(dir, 'server');
    fs.mkdirSync(remote, { recursive: true });
    // A non-repeating pattern: zeros would hide both a hole and a swap.
    const big = Buffer.alloc(160 * 1024);
    for (let i = 0; i < big.length; i += 4) big.writeUInt32BE(i, i);
    fs.writeFileSync(path.join(remote, 'A001_C001.mov'), big);

    const srv = await startSftpServer({ root: remote, readCap: 16 * 1024 });
    const sftp = new SftpFs({ host: srv.host, port: srv.port, username: srv.username, password: srv.password });
    await sftp.connect();
    const chunks = [];
    await new Promise((res, rej) => {
      const rs = sftp.createReadStream('/A001_C001.mov');
      rs.on('data', c => chunks.push(c));
      rs.on('error', rej);
      rs.on('end', res);
    });
    const got = Buffer.concat(chunks);
    eq(got.length, big.length, 'every byte arrives from a server that caps its reads');
    ok(got.equals(big), 'in the right order, with no hole');
    await sftp.close();
    await srv.close();
  }

  // (f) 🔴 PAUSE during the read-back. The copy pass has honoured it inside a
  //     file since 0.6.4; the verification never did.
  {
    const { dir } = scratch();
    const big = path.join(dir, 'big.mov');
    fs.writeFileSync(big, Buffer.alloc(48 * 1024 * 1024, 7));
    const token = { cancelled: false, paused: false };
    let bytes = 0, atPause = 0, pressedOnce = false;
    const hasher = await createHasher('xxh64');
    const p = hashStream(nfs, big, hasher, b => {
      bytes += b;
      // Once. Re-arming it here would pause the stream again the instant it
      // was released, which looks exactly like a hang.
      if (!pressedOnce && bytes > 2 * 1024 * 1024) { pressedOnce = true; token.paused = true; atPause = bytes; }
    }, token);
    await new Promise(r => setTimeout(r, 400));
    const afterHold = bytes;
    // The slack is generous on purpose: the point is that the stream STOPS,
    // not how many buffered chunks were already in flight when it did. A
    // threshold tight enough to measure that would fail on a loaded machine,
    // and a test that fails at random is worse than no test.
    ok(afterHold - atPause < 16 * 1024 * 1024, `the read really stops (${afterHold - atPause} B went past the pause)`);
    ok(afterHold < 48 * 1024 * 1024, 'and the file is not finished behind the paused label');
    token.paused = false;
    await p;
    eq(bytes, 48 * 1024 * 1024, 'releasing it reads the rest');
  }

  // (g) 🔴 Cancelling "Verify folder" accused an intact file of a mismatch.
  {
    const { dir } = scratch();
    const folder = path.join(dir, 'RUSHES');
    fs.mkdirSync(folder, { recursive: true });
    for (let i = 1; i <= 3; i++) fs.writeFileSync(path.join(folder, `c${i}.mov`), Buffer.alloc(24 * 1024 * 1024, i));
    const { FsPool } = require('../src/main/fs/afs');
    const { verifyFolder } = require('../src/main/core/session');
    const pool = new FsPool();
    // Write the list the way syncto does, then check it while cancelling.
    const { formatChecksumList } = require('../src/main/core/hash');
    const entries = [];
    for (let i = 1; i <= 3; i++) {
      const h = await createHasher('xxh64');
      entries.push({ rel: `c${i}.mov`, hash: await hashStream(nfs, path.join(folder, `c${i}.mov`), h, null, {}), size: 3 * 1024 * 1024 });
    }
    fs.writeFileSync(path.join(folder, 'syncto-checksums.txt'), formatChecksumList('xxh64', entries, {}));
    const token = { cancelled: false };
    const res = await (async () => {
      const running = verifyFolder(pool, folder, { token, onProgress: () => {} });
      // Inside the first file, not between two: that is where the exception
      // was being read as a verdict on the file.
      setTimeout(() => { token.cancelled = true; }, 5);
      return running;
    })();
    await pool.closeAll();
    ok(res.verified < 3, `the check really was interrupted (${res.verified} of 3 done)`);
    eq(res.mismatched, 0, 'a cancelled check accuses nobody');
    ok(!res.results.some(r => r.status === 'error'), 'and leaves no red row behind');

    // And the same rule in the run itself: a file copied but not read back is
    // kept OUT of the database, so the next run looks at it again.
    {
      const { SyncRunner } = require('../src/main/core/sync');
      const r = Object.create(SyncRunner.prototype);
      r.token = { cancelled: false };
      r.notes = [];
      r.applied = new Map([['c1.mov', { ok: true }], ['c2.mov', { ok: true }]]);
      r.toVerify = [{ rel: 'c1.mov', ok: true }, { rel: 'c2.mov', ok: false }];
      eq(r.dropUnproven(), 1, 'the unproven file is counted');
      ok(r.applied.has('c1.mov') && !r.applied.has('c2.mov'), 'and only it is dropped from the database');
      ok(/not read back/.test(r.notes[0] || ''), 'with a note saying why');
      const c = Object.create(SyncRunner.prototype);
      c.token = { cancelled: true }; c.notes = []; c.applied = new Map([['c1.mov', { ok: true }]]);
      c.toVerify = [{ rel: 'c1.mov', ok: false }];
      // (0.8.8) Cancelled before the read-back: still unproven, still out.
      eq(c.dropUnproven(), 1, 'a cancelled run does not record unverified copies either');
      ok(!c.applied.has('c1.mov'), 'the copy is left out of the database');
    }
  }

  // (h) The checksum list is keyed by the side's own spelling of a name, so a
  //     deleted accented file used to keep its line on macOS.
  {
    const { L, R } = scratch();
    write(L, 'Café.mov', 'x');          // decomposed, the way a Mac writes it
    const job = makeJob(L, R, { sync: { variant: 'mirror', writeChecksumList: true } });
    await runPair(job);
    fs.rmSync(path.join(L, 'Café.mov'));
    await runPair(job);
    const list = fs.readFileSync(path.join(R, 'syncto-checksums.txt'), 'utf8');
    ok(!/Caf/.test(list), 'a deleted file leaves no line behind, whatever its spelling');
  }
}


// ══ 45. The cost of the things people wait for (0.8.0) ═══════════════════
// Measured before and after on a 10 440-item tree: the scan 606 → 238 ms
// locally and 1 874 → 191 ms with 1 ms of latency on every call (which is
// what a NAS mount is), 200 scroll fetches 165 → 8 ms, the heap 22 → 17 MB.
// Timings do not belong in a test suite — these are the structural facts the
// gains rest on, so they cannot quietly come back.
async function testPerformance() {
  console.log('\n\n45. What makes the waiting shorter (0.8.0)');
  const { NativeFs, SCAN_LANES } = require('../src/main/fs/native');
  const { applyFolderRules } = require('../src/main/core/direction');

  // (a) The scan asks about several entries at once, and keeps the order the
  //     directory gave. Order matters: the comparison reports the FIRST of two
  //     names that differ only by case.
  {
    const { dir } = scratch();
    const folder = path.join(dir, 'CARD_A');
    fs.mkdirSync(folder, { recursive: true });
    const names = [];
    for (let i = 0; i < 40; i++) { names.push(`A${String(i).padStart(3, '0')}.MXF`); fs.writeFileSync(path.join(folder, names[names.length - 1]), 'x'); }

    const realLstat = fs.promises.lstat;
    let live = 0, peak = 0;
    fs.promises.lstat = async (...a) => {
      live++; peak = Math.max(peak, live);
      try { await new Promise(r => setTimeout(r, 2)); return await realLstat(...a); }
      finally { live--; }
    };
    let list;
    try { list = await new NativeFs().readdir(folder); }
    finally { fs.promises.lstat = realLstat; }

    ok(peak > 1, `several entries are in flight at once (${peak} at the peak)`);
    ok(peak <= SCAN_LANES, `and no more than ${SCAN_LANES}`);
    eq(list.length, 40, 'every entry comes back');
    eq(list.map(e => e.name).join(','), fs.readdirSync(folder).join(','),
       'in the order the directory gave them');
  }

  // (b) A folder is created once, not once per file in it.
  {
    const { dir } = scratch();
    const nfs = new NativeFs();
    const deep = path.join(dir, 'DEST', 'DAY1', 'CARD_A');
    const realMkdir = fs.promises.mkdir;
    let calls = 0;
    fs.promises.mkdir = (...a) => { calls++; return realMkdir(...a); };
    try {
      for (let i = 0; i < 25; i++) await nfs.mkdir(deep);
      eq(calls, 1, 'twenty-five files in one folder ask for it once');
      await nfs.rmdir(deep);
      await nfs.mkdir(deep);
      eq(calls, 2, 'and a folder that was removed is created again');
    } finally { fs.promises.mkdir = realMkdir; }
  }

  // (c) Scrolling does not walk the tree again. The window asks for sixty rows
  //     at a time, sixty to a hundred and twenty times a second.
  {
    const { L, R } = scratch();
    for (let i = 0; i < 200; i++) write(L, `DAY1/A${i}.mov`, 'x');
    const s = new Session();
    await s.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: {} });

    let built = 0;
    const real = Object.getPrototypeOf(s)._computeVisible;
    Object.getPrototypeOf(s)._computeVisible = function (...a) { built++; return real.apply(this, a); };
    try {
      const view = { showEqual: true };
      for (let i = 0; i < 50; i++) s.rows(i, 60, view);
      eq(built, 1, 'fifty scroll fetches walk the tree once');
      s.rows(0, 60, { showEqual: true, search: 'A1' });
      eq(built, 2, 'a change of view builds it again');
      s.setActive([3], false);
      s.rows(0, 60, view);
      eq(built, 3, 'and so does editing a row');
    } finally { Object.getPrototypeOf(s)._computeVisible = real; }
    await s.close();
  }

  // (d) Who is whose child does not change between two comparisons.
  {
    const nodes = [
      { idx: 0, parent: -1, type: 'folder', rel: 'A', op: 'none', left: {}, right: {} },
      { idx: 1, parent: 0, type: 'file', rel: 'A/x', op: 'none', left: {}, right: {} },
    ];
    applyFolderRules(nodes);
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 2000; i++) applyFolderRules(nodes);
    ok(process.memoryUsage().heapUsed - before < 12 * 1024 * 1024,
       'two thousand passes do not rebuild the map each time');
  }

  // (e) The run reports itself on a clock, not once per file. Forced events
  //     were two per file whatever the rate, and the window rebuilt its step
  //     chips and its sparkline on every one.
  {
    const { L, R } = scratch();
    for (let i = 0; i < 120; i++) write(L, `A${i}.mov`, 'x');
    const s = new Session();
    const token = { cancelled: false, paused: false };
    const job = makeJob(L, R, { sync: { variant: 'mirror' } });
    await s.compare(job, { token });
    let events = 0;
    await s.sync(job, { token, appVersion: 'test', onProgress: p => { if (p.phase === 'sync') events++; } });
    await s.close();
    ok(events < 120, `120 files produced ${events} progress events, not one or two each`);
    ok(events > 0, 'and the window still hears about the run');
  }

  // (f) Three copies of every path is 100 MB on a large job, and two of them
  //     are the same string.
  {
    const { L, R } = scratch();
    write(L, 'DAY1/A001.mov', 'x');
    const s = new Session();
    await s.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: {} });
    const n = s.nodes.find(x => x.rel === 'DAY1/A001.mov');
    eq(n.relL, null, 'a side that spells a name like the key stores nothing');
    eq(n.relR, null, 'on either side');
    await s.close();
  }

  // (g) The window's own share, read as a document.
  {
    const app = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/app.js'), 'utf8');
    ok(/scrollFrame = requestAnimationFrame/.test(app), 'one row fetch per frame, not one per scroll event');
    ok(/state\.rows\.clear\(\);\s*\n\s*res\.rows\.forEach/.test(app), 'and the row map holds the window, not the whole comparison');
    ok(/if \(shape !== stepsShape\)/.test(app), 'the step chips are built once per run');
    ok(/lastSpeedAt/.test(app), 'and the throughput line is sampled on a clock');
  }
}


// ══ 46. What the window says it does (0.8.0) ═════════════════════════════
// The audit's interface findings. They are all the same defect wearing
// different clothes: the screen stating something the engine does not do.
function testWindowTruth() {
  console.log('\n\n46. What the window says it does (0.8.0)');
  const root = path.join(__dirname, '..');
  const app  = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');

  // (a) 🔴 The unattended run is the one that must reach the phone.
  {
    const auto = app.slice(app.indexOf('async function autoRun()'), app.indexOf('function notifyRunFailed'));
    ok(/notifyRunFailed\(res\.error\)/.test(auto),
       'a failed auto-sync sends the notification the settings promise');
  }

  // (b) 🔴 "verified copy" was printed whatever the folders and whatever the
  //     setting, and the summary said the opposite two hours later. The real
  //     function is lifted out and run, rather than its source being read.
  {
    const src = app.slice(app.indexOf('function verificationPhrase()'));
    const body = src.slice(0, src.indexOf('\n}\n') + 3);
    // The function reads `state` and `completePairs` from the module it lives
    // in; here they are these two, which eval() closes over.
    let state = null;
    let pairs = [];
    const completePairs = () => pairs;
    const isServerAddress = v => /^\s*(?:sftp|ftpes|ftps|ftp):\/\//i.test(String(v == null ? '' : v));
    // eslint-disable-next-line no-eval
    const phrase = eval(`(${body.replace('function verificationPhrase()', 'function ()')})`);
    const call = (ps, verifyRemote) => {
      pairs = ps;
      state = { job: { sync: { verifyRemote } } };
      return phrase();
    };
    const local = [{ left: '/a', right: '/b' }];
    const remote = [{ left: '/a', right: 'sftp://nas/export' }];
    const bothRemote = [{ left: 'sftp://nas/a', right: 'sftp://nas/b' }];
    eq(call(local, false), 'verified copy (xxHash64)', 'two local folders: verified, whatever the server setting says');
    eq(call(remote, true), 'verified copy (xxHash64)', 'a server with the read-back on: verified');
    ok(/NOT read back/.test(call(remote, false)), 'a server with it off: the window says so BEFORE the run');
    ok(/NOT read back/.test(call(bothRemote, false)), 'and on both sides too');
    ok(state !== null, 'the phrase was built from a job, not from a guess');
  }

  // (c) The auto-sync card said "twoWay", a word the interface never shows.
  {
    // (0.8.8) Spelt as on the buttons.
    ok(/const VARIANT_LABEL = \{ twoWay: '2 WAYS'/.test(app), 'the mode names live in one place');
    const card = app.slice(app.indexOf("$('auto-cf-sub').textContent"), app.indexOf("$('ov-auto').classList.add('open')"));
    ok(/VARIANT_LABEL\[state\.job\.sync\.variant\]/.test(card), 'and the auto-sync card uses them');
    ok(/verificationPhrase\(\)/.test(card), 'with the same honest phrase about the read-back');
  }

  // (d) 🔴 The filter help described a rule the engine does not apply. The
  //     engine is asked here, not the text.
  {
    const f = new PathFilter('*', 'Proxies/Low');
    ok(!f.passFile('Proxies/Low/x.mov'), 'a pattern with a slash excludes it at the top of the pair');
    ok(f.passFile('Rushes/A001/Proxies/Low/x.mov'),
       'and NOT deeper down — which is what the window now says');
    const g = new PathFilter('*', '*/Proxies/Low');
    ok(!g.passFile('Rushes/Proxies/Low/x.mov'), 'reaching deeper takes a leading */');
    ok(/A <code>\/<\/code> anywhere in it/.test(html), 'and the help says exactly that');
    ok(!/Starts with <code>\/<\/code><\/b> → it matches one exact path/.test(html), 'the old wording is gone');
  }

  // (e) Escape closes the context menu, the one floating surface it missed.
  {
    const esc = app.slice(app.indexOf("document.addEventListener('keydown'"), app.indexOf("bindServerDialog()"));
    ok(/if \(e\.key === 'Escape'\) closeCtx\(\);/.test(esc), 'Escape closes the right-click menu');
  }

  // (f) A chip that looks clickable does something.
  {
    ok(/chip\('', 'excluded', s\.excluded, 'excluded', 'view'\)/.test(app), 'the excluded count carries a key');
    ok(/kind === 'view' && key === 'excluded'/.test(app), 'the handler knows what to do with it');
    ok(/kind === 'view' && key === 'excluded' && !!state\.view\.showExcluded/.test(app),
       'and it lights up while those rows are showing');
  }

  // (g) SOURCE and DESTINATION are grey labels; no state colour is spent on
  //     naming a side. An inline style is also out of the charte's reach.
  {
    ok(!/srv-sub'\)\.innerHTML = `This becomes the <span style="color:var\(--/.test(app),
       'the server window no longer paints the side blue or green');
  }

  // (h) Classes nothing emits any more.
  for (const dead of ['.bf{', '.bn{', '.bs{', '.stat.v{', '.mdesc{'])
    ok(!html.includes(dead), `${dead.slice(0, -1)} is gone`);

  // (i) The pause button is not offered while nothing can be paused.
  {
    const at = app.indexOf('async function doCompareQuiet()');
    const quiet = app.slice(at, app.indexOf('\nasync function ', at + 10));
    ok(/btn-pause'\)\.style\.display = 'none'/.test(quiet), 'the re-comparison hides Pause');
    ok(/btn-pause'\)\.style\.display = ''/.test(quiet), 'and gives it back afterwards');
  }
}


// ══ 47. Linux: AppImage and .deb (0.8.2) ═════════════════════════════════
// Built on a Linux machine by scripts/build-linux.sh, on ingesto's model. The
// packages themselves were built, installed and launched in a container when
// this section was written; what can regress quietly is checked here.
function testLinux() {
  console.log('\n\n47. Linux packages (0.8.2)');
  const root = path.join(__dirname, '..');
  const yml = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const linux = yml.slice(yml.indexOf('\nlinux:'), yml.indexOf('\ndeb:'));
  const deb = yml.slice(yml.indexOf('\ndeb:'));

  ok(/target: AppImage/.test(linux) && /target: deb/.test(linux), 'both an AppImage and a .deb are built');
  ok(/icon: build-resources\/icons/.test(linux) && fs.existsSync(path.join(root, 'build-resources/icons/512x512.png')),
     'from the icon set the SVG produces');
  ok(/libsecret-1-0/.test(deb), 'the .deb pulls in the keyring library');
  ok(pkg.desktopName === 'syncto.desktop' && /syncDesktopName: true/.test(linux),
     'the running window and its launcher share one name');

  // The script, as a person will run it.
  {
    const sh = fs.readFileSync(path.join(root, 'scripts/build-linux.sh'), 'utf8');
    ok(/id -u\)" = "0"/.test(sh), 'the Linux build refuses to run as root');
    ok(/node_ok\(\)/.test(sh) && /20\.19/.test(sh), 'and checks the Node version before anything');
    ok(!/npm test/.test(sh), 'it does not run the test suite: tests are run by hand before a release, like the Mac and Windows builds');
    ok(/dpkg-deb -f dist\/\*\.deb Depends \| grep -q libsecret-1-0/.test(sh),
       'and checks the dependency in the .deb it produced, not in the config');
    ok(pkg.scripts['build:linux'] === 'bash scripts/build-linux.sh', 'npm run build:linux goes through it');
  }

  // 🔴 With no keyring, Electron on Linux answers "available" and encrypts with
  //    a key written in its own source code. That is a password in clear by
  //    another name, and syncto's rule is that a password never is.
  {
    const electronPath = require.resolve('electron');
    const secretsPath = require.resolve('../src/main/secrets');
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    const saved = require.cache[electronPath];
    const load = backend => {
      delete require.cache[secretsPath];
      require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: {
        safeStorage: {
          isEncryptionAvailable: () => true,
          getSelectedStorageBackend: () => backend,
          encryptString: s => Buffer.from('enc:' + s),
          decryptString: b => String(b).slice(4),
        },
      } };
      return require('../src/main/secrets');
    };
    try {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const weak = load('basic_text');
      ok(!weak.available(), 'Electron’s plain-text fallback is not accepted as a store');
      eq(weak.encrypt('secret'), null, 'so nothing is encrypted with it');
      ok(!load('unknown').available(), 'nor is an unknown backend');
      ok(load('gnome_libsecret').available(), 'GNOME Keyring is');
      ok(load('kwallet5').available(), 'and so is KWallet');
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      ok(load('basic_text').available(), 'the check is Linux-only: the Keychain has no such fallback');
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
      if (saved) require.cache[electronPath] = saved; else delete require.cache[electronPath];
      delete require.cache[secretsPath];
    }
  }
}

// ══ 48. Noar's list for 0.8.3 ═════════════════════════════════════════════
async function testRequest083() {
  console.log('\n\n48. Offline volumes, the run in the window, the simpler settings (0.8.3)');
  const root = path.join(__dirname, '..');
  const html  = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
  const appjs = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
  const { volumeRoot, offlineVolume } = require('../src/main/core/volume');

  // (a) Which drive a path lives on, on every platform.
  eq(volumeRoot('/Volumes/NAS_EDIT/PROJET/01', 'darwin'), '/Volumes/NAS_EDIT', 'a Mac volume');
  eq(volumeRoot('E:\\RUSHES', 'win32'), 'E:\\', 'a Windows drive letter');
  eq(volumeRoot('\\\\nas\\edit\\PROJET', 'win32'), '\\\\nas\\edit\\', 'a Windows share');
  eq(volumeRoot('/media/noar/SSD/x', 'linux'), '/media/noar/SSD', 'a Linux removable drive');
  eq(volumeRoot('/run/media/noar/SSD/x', 'linux'), '/run/media/noar/SSD', 'the other place Linux puts them');
  eq(volumeRoot('/Users/noar/Movies', 'darwin'), null, 'a folder on the startup disk is on no volume');
  eq(volumeRoot('sftp://nas/vol', 'darwin'), null, 'nor is a server');
  const statOf = map => q => map[q] || null;
  eq(offlineVolume('/Volumes/NAS/x', { platform: 'darwin', stat: statOf({}) }),
     { root: '/Volumes/NAS', name: 'NAS' }, 'a Mac volume that is not there is offline');
  eq(offlineVolume('/Volumes/NAS/x', { platform: 'darwin', stat: statOf({ '/': { dev: 1 }, '/Volumes/NAS': { dev: 2 } }) }),
     null, 'one that is mounted is not');
  eq(offlineVolume('/Volumes/NAS/x', { platform: 'darwin', stat: statOf({ '/': { dev: 1 }, '/Volumes/NAS': { dev: 1 } }) }),
     { root: '/Volumes/NAS', name: 'NAS' }, 'an empty folder left in /Volumes, on the startup disk, is not a mounted drive');
  eq(offlineVolume('F:\\x', { platform: 'win32', stat: statOf({}) }), { root: 'F:\\', name: 'F:' }, 'a drive letter with nothing behind it');

  // (b) Comparing against a drive that is not mounted: refused, named, before
  //     anything is scanned. A missing folder on a MOUNTED drive still compares.
  {
    const { L } = scratch();
    write(L, 'a.mov', 'x');
    const gone = `/Volumes/syncto-test-absent-${process.pid}/PROJET/01_RUSHES`;
    const job = makeJob('', '', { sync: { variant: 'mirror' } });
    delete job.left; delete job.right;
    job.pairs = [{ left: L, right: gone }];
    const m = new MultiSession();
    let err = null;
    try { await m.compare(job, { token: {} }); } catch (e) { err = e; }
    ok(err && err.offline && err.offline.length === 1, 'the comparison refuses');
    ok(err && new RegExp(`syncto-test-absent-${process.pid} is not mounted`).test(err.message), 'naming the volume');
    ok(err && /It holds the destination\./.test(err.message) && /Connect it, then compare again/.test(err.message),
       'what it holds, and what to do');
    eq(m.comparedAt, 0, 'and leaves nothing to synchronize');
    await m.close();

    const { R } = scratch();
    job.pairs = [{ left: L, right: path.join(R, 'new-folder') }];
    const m2 = new MultiSession();
    const cmp = await m2.compare(job, { token: {} });
    ok(cmp && cmp.stats.createRight >= 1, 'a folder missing on a mounted drive is still a folder to create');
    await m2.close();
  }
  {
    const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
    ok(/offline: err\.offline \|\| null/.test(main), 'the channel carries which volumes');
    ok(/res\.offline\.length > 1 \? 'Volumes not mounted' : 'Volume not mounted'/.test(appjs), 'and the window says it in its title');
    ok(/allOffline \? `\$\{vols\.join\(', '\)\} not mounted`/.test(appjs), 'the badge names the drive instead of counting folders');
  }

  // (c) The run empties the list as it goes.
  {
    const { L, R } = scratch();
    for (let i = 0; i < 6; i++) write(L, `clip_${i}.mov`, 'x'.repeat(2048));
    const job = makeJob(L, R, { sync: { variant: 'mirror' } });
    const s = new Session();
    const token = { cancelled: false, paused: false };
    await s.compare(job, { token });
    const before = s.rows(0, 100, {}).total;
    const seen = [];
    await s.sync(job, { token, onProgress: () => seen.push(s.rows(0, 100, {}).total) });
    eq(before, 6, 'six rows to process before the run');
    eq(seen[0], 6, 'all six still listed when the run starts');
    ok(seen.some(n => n < 6), 'fewer while it is still running (before the read-back is over)');
    eq(s.rows(0, 100, {}).total, 0, 'and none once everything has landed');
    await s.close();
  }
  {
    const { L, R } = scratch();
    write(L, 'ok.mov', 'x');
    write(L, 'bad.mov', 'y');
    const job = makeJob(L, R, { sync: { variant: 'mirror' } });
    const s = new Session();
    const token = { cancelled: false };
    await s.compare(job, { token });
    fs.rmSync(path.join(L, 'bad.mov'));
    await s.sync(job, { token });
    eq(s.rows(0, 100, {}).rows.map(r => r.rel), ['bad.mov'], 'a row that failed stays in the list');
    await s.close();
  }

  // (d) The window.
  ok(/#var-twoWay\.on\{box-shadow:inset 0 0 0 1\.5px var\(--blue\);\}/.test(html) &&
     /#var-mirror\.on\{box-shadow:inset 0 0 0 1\.5px var\(--orange\);\}/.test(html) &&
     /#var-update\.on\{box-shadow:inset 0 0 0 1\.5px var\(--green\);\}/.test(html) &&
     /#var-custom\.on\{box-shadow:inset 0 0 0 1\.5px var\(--text3\);\}/.test(html),
     'the chosen mode is outlined in its own colour');
  const modes = html.slice(html.indexOf('<div class="modes-row">'), html.indexOf('<!-- ── Folder pairs'));
  ok(/class="modes-sep"[\s\S]*id="btn-verify"/.test(modes), 'VERIFY sits on the modes line, after a separator');
  const tbar = html.slice(html.indexOf('<div id="titlebar">'), html.indexOf('<div id="main">'));
  ok(!/btn-verify/.test(tbar) && /id="btn-after"/.test(tbar) && /id="after-menu"/.test(tbar),
     'and the title bar has the end-of-run menu where it used to be');
  eq([...tbar.matchAll(/class="ctx-it" data-v="(\w+)"/g)].map(m => m[1]), ['none', 'quit', 'sleep', 'shutdown'],
     'Do nothing, Quit, Sleep, Shut down');
  ok(/state\.job\.sync\.afterSync = it\.dataset\.v;/.test(appjs) &&
     /const action = \(state\.job\.sync && state\.job\.sync\.afterSync\) \|\| 'none';/.test(appjs),
     'the choice goes into the job, and is read when the run ends — so it can change during the copy');
  ok(!/#app\.running[^{]*#titlebar/.test(html), 'and the title bar stays live during a run');
  ok(/\.recent-item\.cur\{background:rgba\(53,201,139,\.12\);\}/.test(html) &&
     /\.recent-item\.cur \.recent-name\{color:var\(--green\);\}/.test(html), 'the job that is open is green in the list');

  // (d2) A run you cannot miss: one word for the whole run, a big ring and
  //      title in the colour of the pass, an outline that breathes — and all
  //      of it still and grey the moment the run is paused.
  // (0.8.7) Noar's choice changed: the title now names the pass.
  {
    const rt = appjs.slice(appjs.indexOf('function runTitle('), appjs.indexOf('}', appjs.indexOf('function runTitle(')) + 1);
    const runTitle = new Function('return ' + rt)();
    eq([runTitle('copy', false), runTitle('verify', false), runTitle('cleanup', false), runTitle('verify', true)],
       ['SYNCHRONIZING', 'VERIFYING', 'FINISHING', 'PAUSED'],
       'the title names the pass: SYNCHRONIZING, VERIFYING, FINISHING, or PAUSED');
    ok(/const paused = !!\(p\.paused \|\| state\.paused\);\s*title\.textContent = runTitle\(p\.pass, paused\);/.test(appjs) &&
       /\$\('pb-title'\)\.textContent = runTitle\(state\.runPass, state\.paused\);/.test(appjs),
       'during the run and when resuming from a pause');
  }
  ok(/\$\('bottombar'\)\.classList\.toggle\('paused', state\.paused\);/.test(appjs),
     'pausing is shown at once, without waiting for the engine');
  ok(/#bottombar\.live\{box-shadow:inset 0 0 0 2px var\(--pb-color/.test(html) && /animation:runglow/.test(html),
     'the strip is outlined in the colour of the pass, and breathes');
  ok(/#bottombar\.live \.pb-pct-ring\{width:116px;height:116px;\}/.test(html) &&
     /#bottombar\.live \.ring-txt\{font-size:30px;/.test(html) && /#bottombar\.live \.pb-title\{font-size:30px;/.test(html),
     'the ring, the percentage and the title are big');
  ok(/#bottombar\.live\.paused,#bottombar\.live\.paused \.pb-title::before,#bottombar\.live\.paused \.pb-fill::after\{animation:none;\}/.test(html),
     'and everything stops moving when paused');
  ok(/prefers-reduced-motion:reduce\)\{\s*#bottombar\.live,/.test(html), 'or when the system asks for less motion');

  // (d3) A comparison wears the same strip, in the blue of its button.
  ok(/classList\.toggle\('live', !!on\)/.test(appjs) && /classList\.toggle\('cmp', !!\(on && !steps\)\)/.test(appjs),
     'the strip is live for a comparison as for a run');
  ok(/startCompareUi\('COMPARING'\)/.test(appjs) && /startCompareUi\('CHECKING'\)/.test(appjs),
     'COMPARING, and CHECKING for the look after a run');
  ok(/'--pb-color',  cmp \? 'var\(--blue\)' : 'var\(--green\)'/.test(appjs), 'blue for a comparison, green for a run');
  ok(/#bottombar\.live\{box-shadow:inset 0 0 0 2px var\(--pb-color/.test(html) && /#bottombar\.open\.live\{height:auto;\}/.test(html),
     'one set of rules for both');

  // (d6) The overview on the left empties with the list during a run, and
  //      the comparison shows its percentage plainly (no "≈").
  {
    const { L, R } = scratch();
    write(L, 'A/one.mov', 'x'.repeat(3000)); write(L, 'B/two.mov', 'y'.repeat(3000));
    const job = makeJob(L, R, { sync: { variant: 'mirror' } });
    const s = new Session();
    await s.compare(job, { token: {} });
    const names = () => s.overview({}, [], null).rows.map(r => r.name).filter(Boolean);
    ok(names().includes('A') && names().includes('B'), 'both folders are listed before the run');
    await s.sync(job, { token: { cancelled: false } });
    eq(names().filter(n => n === 'A' || n === 'B'), [], 'and neither once everything has landed');
    await s.close();
    ok(/if \(t - runOvAt >= 1000\) \{ runOvAt = t; await refreshOverview\(\); \}/.test(appjs), 'the window asks for it again while the run goes');
    ok(!/'≈' \+/.test(appjs), 'the comparison percentage carries no ≈');
  }

  // (d7) 🔴 Dates on a NAS. Over SMB the Mac sends part of a file after the
  //      copy has "finished" — when the verification flushes it — and the
  //      server stamps the file with that moment, after syncto had set the
  //      date. Every file ended up dated "today" and the next Mirror wanted to
  //      copy them all again. Simulated here: the flush touches the file.
  {
    const { NativeFs } = require('../src/main/fs/native');
    const P = NativeFs.prototype, orig = P.flush;
    P.flush = async function (p) { const r = await orig.call(this, p); const now = new Date(); fs.utimesSync(p, now, now); return r; };
    try {
      const { L, R } = scratch();
      const old = Date.parse('2026-08-13T15:40:00Z');
      write(L, 'DCIM/DJI_0020.MP4', 'x'.repeat(5000), old);
      write(L, 'DCIM/DJI_0352.MP4', 'y'.repeat(5000), old);
      const job = makeJob(L, R, { sync: { variant: 'mirror', preserveTimes: true } });
      const s = new Session();
      await s.compare(job, { token: {} });
      const run = await s.sync(job, { token: { cancelled: false } });
      await s.close();
      const got = fs.statSync(path.join(R, 'DCIM/DJI_0020.MP4')).mtimeMs;
      ok(Math.abs(got - old) < 1500, 'the file on the destination keeps the source date, whatever the flush did');
      ok(!run.notes.some(n => /could not/i.test(n)), 'with nothing to report');
      const again = new Session();
      const cmp = await again.compare(job, { token: {} });
      eq(cmp.stats.filesToProcess, 0, 'so the next Mirror has nothing to copy again');
      await again.close();
    } finally { P.flush = orig; }
  }

  // (d7b) The order that keeps the date on a NAS (0.8.5): the file is flushed
  //       BEFORE its date is set, never after — and only once.
  {
    const { NativeFs } = require('../src/main/fs/native');
    const P = NativeFs.prototype, of = P.flush, om = P.setMTime;
    const log = [];
    P.flush = async function (p) { log.push('flush ' + path.basename(p)); return of.call(this, p); };
    P.setMTime = async function (p, m) { log.push('date ' + path.basename(p)); return om.call(this, p, m); };
    try {
      const { L, R } = scratch();
      write(L, 'clip.mov', 'x'.repeat(4000), Date.parse('2026-08-13T15:40:00Z'));
      const job = makeJob(L, R, { sync: { variant: 'mirror' } });
      const s = new Session();
      await s.compare(job, { token: {} });
      await s.sync(job, { token: { cancelled: false } });
      await s.close();
      const f = log.findIndex(l => /^flush clip\.mov/.test(l)), d = log.indexOf('date clip.mov');
      ok(f >= 0 && d > f, `flushed before the date is set (${log.filter(l => /clip/.test(l)).join(' → ')})`);
      eq(log.filter(l => /^flush clip/.test(l)).length, 1, 'and flushed once, not a second time at the read-back');
    } finally { P.flush = of; P.setMTime = om; }
  }

  // (d9) "Correct dates only" (0.8.4): identical content, only the date moves.
  {
    const old = Date.parse('2026-08-13T15:40:00Z'), today = Date.parse('2026-09-30T11:00:00Z');
    const setup = () => {
      const { L, R } = scratch();
      write(L, 'same.mp4', 'x'.repeat(8000), old);  write(R, 'same.mp4', 'x'.repeat(8000), today);
      write(L, 'diff.mp4', 'y'.repeat(8000), old);  write(R, 'diff.mp4', 'z'.repeat(8000), today);
      return { L, R };
    };
    const run = async (L, R, on) => {
      const job = makeJob(L, R, { sync: { variant: 'mirror', fixDatesOnly: on } });
      const s = new Session();
      await s.compare(job, { token: {} });
      const res = await s.sync(job, { token: { cancelled: false } });
      await s.close();
      return res;
    };
    eq(defaultJob().sync.fixDatesOnly, false, 'off by default');
    {
      const { L, R } = setup();
      const inoBefore = fs.statSync(path.join(R, 'same.mp4')).ino;
      const res = await run(L, R, true);
      const st = fs.statSync(path.join(R, 'same.mp4'));
      ok(Math.abs(st.mtimeMs - old) < 1500, 'the identical file gets the source date back');
      eq(st.ino, inoBefore, 'without being rewritten — it is the same file on disk');
      eq(read(R, 'diff.mp4'), 'y'.repeat(8000), 'a file whose content differs is copied as usual');
      eq(res.counters.files, 1, 'one file copied');
      eq(res.counters.dated, 1, 'one date corrected');
      ok(res.notes.some(n => /identical, byte for byte — only the date was corrected/.test(n)), 'and the summary says so');
      const again = new Session();
      const cmp = await again.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: {} });
      eq(cmp.stats.filesToProcess, 0, 'the next Mirror has nothing left to do');
      await again.close();
    }
    {
      const { L, R } = setup();
      const inoBefore = fs.statSync(path.join(R, 'same.mp4')).ino;
      await run(L, R, false);
      ok(fs.statSync(path.join(R, 'same.mp4')).ino !== inoBefore, 'switched off, the file is copied again, as before');
    }
  }

  // (d10) Locks left behind by a force-quit (0.8.5).
  {
    const { NativeFs } = require('../src/main/fs/native');
    const { acquireOne, LOCK_NAME } = require('../src/main/core/lock');
    const nfs = new NativeFs();
    // (a) A NAS where hard links are refused with ENOTSUP, as macOS says on SMB.
    const origLink = fs.promises.link;
    fs.promises.link = async () => { const e = new Error("ENOTSUP: operation not supported on socket, link"); e.code = 'ENOTSUP'; throw e; };
    try {
      const { dir } = scratch();
      const from = path.join(dir, 'a'), to = path.join(dir, 'b');
      fs.writeFileSync(from, 'x');
      await nfs.renameStrict(from, to);
      ok(fs.existsSync(to) && !fs.existsSync(from), 'a share without hard links falls back to a plain rename');
      fs.writeFileSync(from, 'y');
      let e = null; try { await nfs.renameStrict(from, to); } catch (err) { e = err; }
      ok(e && e.code === 'EEXIST', 'and still refuses to overwrite a target that is there');
    } finally { fs.promises.link = origLink; }
    // (b) A lock nobody has touched for ten minutes, from another machine: taken
    //     at once, not after a minute of watching.
    {
      const { L } = scratch();
      const lp = path.join(L, LOCK_NAME);
      fs.writeFileSync(lp, JSON.stringify({ format: 1, installId: 'someone-else', computerName: 'OTHER', userId: 'x', processId: 1, since: 0 }) + '\n');
      const old = new Date(Date.now() - 10 * 60 * 1000); fs.utimesSync(lp, old, old);
      const t = Date.now();
      const lock = await acquireOne(nfs, L, {});
      ok(Date.now() - t < 5000, `a lock silent for ten minutes is taken over at once (${Date.now() - t} ms)`);
      await lock.release();
    }
  }

  // (d8) The Size and Date columns can be resized, and the date fits by default.
  ok(/var\(--szL,76px\) var\(--dtL,136px\)/.test(html) && /var\(--szR,76px\) var\(--dtR,136px\)/.test(html),
     'a date column wide enough for "2026-08-13 15:40", on both sides');
  eq([...html.matchAll(/data-col="(\w+)"/g)].map(m => m[1]), ['szL', 'dtL', 'szR', 'dtR'], 'four headings carry a grip');
  ok(/grip\.className = 'col-grip'/.test(appjs) && /API\.savePrefs\(\{ ui: \{ cols \} \}\)/.test(appjs), 'dragged, and remembered');

  // (e) What older job files and preferences carry.
  {
    const { dir } = scratch();
    const file = path.join(dir, 'old.syncto');
    fs.writeFileSync(file, JSON.stringify({ format: require('../src/main/config').JOB_FORMAT || 'syncto-job',
      name: 'old', pairs: [{ left: '/a', right: '/b' }],
      sync: { transferLanes: 16, permanentFallback: false, report: { enabled: true, html: true } } }));
    let job = null;
    try { job = require('../src/main/config').loadJob(file); } catch (_) {}
    if (job) {
      eq(job.sync.transferLanes, 10, 'more than ten transfers is brought back to ten');
      eq(job.sync.permanentFallback, true, 'no trash means delete anyway, whatever the file said');
      ok(!('report' in job.sync), 'and report settings are dropped');
    }
    ok(job, 'an older job file still loads');
  }
  ok(/Math\.min\(10, Number\(this\.cfg\.transferLanes\)/.test(fs.readFileSync(path.join(root, 'src/main/core/sync.js'), 'utf8')),
     'the engine allows up to ten lanes');

  // (d11) The Overview (0.8.5): a click selects, a double-click opens, a
  //       lasso takes several folders at once.
  {
    const appjs = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
    const html  = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
    const click = appjs.slice(appjs.indexOf("if (lassoJustEnded) { lassoJustEnded = false; return; }"),
                              appjs.indexOf('async function openOvRow(it)'));
    ok(click.length > 0, 'the row click is guarded against the release of a lasso');
    ok(/if \(e\.detail >= 2\) \{ await openOvRow\(it\); return; \}/.test(click),
       'a double-click opens the folder');
    const plain = click.slice(click.indexOf('e.detail >= 2'));
    ok(/state\.ovSel = new Set\(\[key\]\)/.test(plain), 'a single click selects the folder alone');
    ok(!/setScope\(/.test(plain) && !/ovOpen/.test(plain), 'and neither scopes the grid nor unfolds it');
    const open = appjs.slice(appjs.indexOf('async function openOvRow(it)'), appjs.indexOf('let lassoJustEnded'));
    ok(/ovOpen/.test(open) && /setScope\(/.test(open), 'opening unfolds it and scopes the grid on it');
    ok(/\$\('ov-list'\)\.addEventListener\('mousedown'/.test(appjs), 'the lasso starts on the Overview list');
    ok(/< 5\) return;/.test(appjs), 'only after the mouse has moved, so a click stays a click');
    ok(/add: e\.metaKey \|\| e\.ctrlKey/.test(appjs), 'Cmd/Ctrl adds the lasso to the selection');
    ok(/list\.scrollTop -= 12/.test(appjs) && /list\.scrollTop \+= 12/.test(appjs), 'the list scrolls near its edges');
    ok(/\.ov-lasso\{/.test(html), 'the lasso is drawn');
    ok(/body\.lassoing \.tooltip-float\{display:none/.test(html) &&
       /classList\.contains\('lassoing'\)\) return;/.test(appjs), 'and no tooltip covers it');
  }

  // (d12) A re-pointed pair keeps its history (0.8.6). The history is filed
  //       under an id made from the two paths, so a renamed drive — or a folder
  //       picked again in the relink window — used to start from nothing: in
  //       2 WAYS, a clip deleted on one side came back from the other.
  {
    const { readSideSession, pairIdFor } = require('../src/main/core/db');
    const { NativeFs } = require('../src/main/fs/native');
    const nfs = new NativeFs();
    const twoWay = (L, R, was) => {
      const j = makeJob(L, R, { sync: { variant: 'twoWay' } });
      if (was) j.pairWas = was;
      return j;
    };
    async function syncedTwoWay() {
      const { dir, L, R } = scratch();
      write(L, 'A001/CLIP_1.mov', 'x'.repeat(900));
      write(L, 'A001/CLIP_2.mov', 'y'.repeat(700));
      await runPair(twoWay(L, R));
      return { dir, L, R };
    }
    async function planFor(job, rel) {
      const s = new Session();
      const cmp = await s.compare(job, { token: {} });
      const n = s.nodes.find(x => x.rel === rel);
      return { s, cmp, op: n ? n.op : null };
    }

    // The reported case: the destination folder was renamed, and a clip
    // deleted on the source since the last run.
    const c = await syncedTwoWay();
    const R2 = path.join(c.dir, 'R_renamed');
    fs.renameSync(c.R, R2);
    fs.unlinkSync(path.join(c.L, 'A001/CLIP_1.mov'));

    const before = await planFor(twoWay(c.L, R2), 'A001/CLIP_1.mov');
    await before.s.close();
    eq(before.op, OP.CREATE_LEFT, 'without the former paths, the deleted clip would be copied back (the old behaviour)');

    const after = await planFor(twoWay(c.L, R2, { left: c.L, right: c.R }), 'A001/CLIP_1.mov');
    eq(after.op, OP.DELETE_RIGHT, 'with them, the deletion is carried to the renamed folder');
    ok(after.cmp.historyCarried, 'the comparison says the history was carried over');
    eq(after.cmp.dbNote, null, 'and does not claim there is no database');
    await after.s.sync(twoWay(c.L, R2, { left: c.L, right: c.R }), { token: {}, appVersion: 'test' });
    const newId = after.s.pairId;
    await after.s.close();
    ok(!exists(R2, 'A001/CLIP_1.mov'), 'the run deletes it there');
    ok(!!(await readSideSession(nfs, c.L, newId)) && !!(await readSideSession(nfs, R2, newId)),
       'the history is now written under the new paths, on both sides');
    ok(!!(await readSideSession(nfs, c.L, pairIdFor(null, c.L, c.R))),
       'and the old session is left in place (another job may still use those paths)');
    const again = await planFor(twoWay(c.L, R2), 'A001/CLIP_2.mov');
    await again.s.close();
    eq(again.cmp.dbNote, null, 'the next run finds its history without the former paths');
    ok(!again.cmp.historyCarried, 'under its own id');

    // A swap is not a re-point: the history of A → B is never read as B → A.
    {
      const d = await syncedTwoWay();
      const sw = await planFor(twoWay(d.R, d.L, { left: d.L, right: d.R }), 'A001/CLIP_1.mov');
      await sw.s.close();
      ok(!sw.cmp.historyCarried, 'former paths that now sit on the other side are ignored');
    }

    // Pointing at a DIFFERENT folder (a copied job sent to another drive):
    // nothing on that side, so a fresh start — and the original pair keeps
    // its own history untouched.
    {
      const d = await syncedTwoWay();
      const R3 = path.join(d.dir, 'OTHER_DRIVE');
      fs.mkdirSync(R3);
      const other = await planFor(twoWay(d.L, R3, { left: d.L, right: d.R }), 'A001/CLIP_1.mov');
      ok(!other.cmp.historyCarried, 'a different folder holds no copy of the history: nothing carried');
      eq(other.op, OP.CREATE_RIGHT, 'and it is filled like any new destination');
      await other.s.sync(twoWay(d.L, R3, { left: d.L, right: d.R }), { token: {}, appVersion: 'test' });
      await other.s.close();
      const orig = await planFor(twoWay(d.L, d.R), 'A001/CLIP_1.mov');
      await orig.s.close();
      eq(orig.cmp.dbNote, null, 'the original pair still finds its own history');
    }

    // Through MultiSession, the path every run of the window takes.
    {
      const d = await syncedTwoWay();
      const R2m = path.join(d.dir, 'R_moved');
      fs.renameSync(d.R, R2m);
      fs.unlinkSync(path.join(d.L, 'A001/CLIP_2.mov'));
      const job = twoWay('', '');
      job.pairs = [{ left: d.L, right: R2m, was: { left: d.L, right: d.R } }];
      const m = new MultiSession();
      const cmp = await m.compare(job, { token: {} });
      eq(cmp.stats.deleteRight, 1, 'each pair hands its former paths to the engine');
      const res = await m.sync(job, { token: {}, appVersion: 'test' });
      await m.close();
      eq(res.dbSaved, [{ left: d.L, right: R2m }], 'and the run says which pairs now have their history under the new paths');
    }

    // The job file keeps them, cleaned.
    {
      const cfg = require('../src/main/config');
      const { dir } = scratch();
      const file = path.join(dir, 'moved.syncto');
      fs.writeFileSync(file, JSON.stringify({ format: cfg.JOB_FORMAT, name: 'moved', pairs: [
        { left: '/Volumes/RAID 1/P', right: '/b', was: { left: '/Volumes/RAID/P', right: '/b' } },
        { left: '/c', right: '/d', was: { left: '', right: '/d' } },
        { left: '/e', right: '/f', was: 'nonsense' },
      ] }));
      const job = cfg.loadJob(file);
      eq(job.pairs[0].was, { left: '/Volumes/RAID/P', right: '/b' }, 'a job file keeps the former paths of a pair');
      ok(!('was' in job.pairs[1]) && !('was' in job.pairs[2]), 'and drops anything incomplete or malformed');
      const out = cfg.saveJob(path.join(dir, 'out.syncto'),
        Object.assign({}, job, { pairs: [{ left: 'sftp://noar@nas/vol', right: '/b',
          was: { left: 'sftp://noar:s3cret@nas/old', right: '/b' } }] }));
      ok(!/s3cret/.test(JSON.stringify(out)) && !/s3cret/.test(fs.readFileSync(path.join(dir, 'out.syncto'), 'utf8')),
         'no password travels in the former paths either');
    }

    // The window: every way a folder changes goes through setPairPath, a swap
    // swaps the former paths too, and a finished run clears them.
    {
      const app = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
      const ens = app.slice(app.indexOf('function ensurePairs(j)'), app.indexOf('function setPairPath('));
      ok(/out\.was = \{ left: p\.was\.left, right: p\.was\.right \}/.test(ens), 'ensurePairs keeps the former paths');
      const set = app.slice(app.indexOf('function setPairPath('), app.indexOf('function swapPair('));
      ok(/if \(!pair\.was && pair\.left\.trim\(\) && pair\.right\.trim\(\)\)/.test(set),
         'the former paths are taken at the first edit only, from a complete pair');
      const ui = app.slice(app.indexOf('function uiToJob()'), app.indexOf('j.compare.detectMoves', app.indexOf('function uiToJob()')));
      ok(/setPairPath\(j\.pairs\[i\], 'left'/.test(ui) && /setPairPath\(j\.pairs\[i\], 'right'/.test(ui),
         'typing and browsing go through it');
      const rel = app.slice(app.indexOf('async function applyRelink()'), app.indexOf('function dismissRelink()'));
      ok(/setPairPath\(pairs\[e\.pairIndex\]/.test(rel), 'so does the relink window');
      const sw = app.slice(app.indexOf('function swapPair('), app.indexOf('function dropCarriedPaths('));
      ok(/p\.was = \{ left: p\.was\.right, right: p\.was\.left \}/.test(sw), 'a swap swaps the former paths');
      ok(/swapPair\(state\.job\.pairs\[i\]\)/.test(app) && /for \(const p of state\.job\.pairs\) swapPair\(p\);/.test(app),
         'for one row and for all of them');
      ok((app.match(/dropCarriedPaths\(res\);/g) || []).length === 2, 'both the manual run and auto-sync clear them afterwards');
    }
  }

  // (d14) scripts/push_github.command: GitHub becomes exactly this folder,
  //       only for a new version, with version.json held back until its
  //       Release exists. Run for real against a local repository.
  {
    const cp = require('child_process');
    const script = path.join(root, 'scripts/push_github.command');
    const src = fs.readFileSync(script, 'utf8');
    ok((fs.statSync(script).mode & 0o111) !== 0, 'the push script is executable');
    ok(!/--force|push\s+-f\b|\+main/.test(src), 'it never forces a push');
    ok(/push origin HEAD:main/.test(src), 'it pushes to main');
    ok(fs.existsSync(path.join(root, 'build_mac.command')) && fs.existsSync(path.join(root, 'build_windows.command')),
       'the build launchers are build_mac.command and build_windows.command');
    for (const f of ['build_mac.command', 'build_windows.command']) {
      const t = fs.readFileSync(path.join(root, f), 'utf8');
      ok(/^cd "\$\(dirname "\$0"\)"$/m.test(t) && /bash scripts\/build-/.test(t), `${f} runs its script from the project folder`);
      ok((fs.statSync(path.join(root, f)).mode & 0o111) !== 0, `${f} is executable`);
    }
    const has = c => { try { cp.execSync(`command -v ${c}`, { stdio: 'ignore' }); return true; } catch (_) { return false; } };
    if (!has('git')) {
      console.log('\n  (push script not run: git missing here)');
    } else {
      const { dir } = scratch();
      const git = (cwd, args) => cp.execFileSync('git', args, { cwd, encoding: 'utf8',
        env: Object.assign({}, process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }) });
      // What GitHub holds: 1.0.0, with a file the new version no longer has.
      const seed = path.join(dir, 'seed');
      fs.mkdirSync(path.join(seed, 'scripts'), { recursive: true });
      const pkg = v => JSON.stringify({ name: 'demo', version: v, repository: { url: 'https://github.com/someone/demo.git' } });
      fs.writeFileSync(path.join(seed, 'package.json'), pkg('1.0.0'));
      fs.writeFileSync(path.join(seed, 'version.json'), JSON.stringify({ version: '1.0.0' }));
      fs.writeFileSync(path.join(seed, 'old.txt'), 'gone in 1.1.0');
      git(seed, ['init', '-q', '-b', 'main']); git(seed, ['add', '-A']); git(seed, ['commit', '-q', '-m', 'seed']);
      const bare = path.join(dir, 'remote.git');
      git(dir, ['clone', '-q', '--bare', seed, bare]);
      // The unzipped folder: 1.1.0, old.txt removed, a script without its +x.
      const zip = path.join(dir, 'demo');
      fs.mkdirSync(path.join(zip, 'scripts'), { recursive: true });
      fs.copyFileSync(script, path.join(zip, 'scripts/push_github.command'));
      fs.writeFileSync(path.join(zip, 'package.json'), pkg('1.1.0'));
      fs.writeFileSync(path.join(zip, 'version.json'), JSON.stringify({ version: '1.1.0' }));
      fs.writeFileSync(path.join(zip, 'new.sh'), 'echo hi');
      fs.chmodSync(path.join(zip, 'new.sh'), 0o644);
      const push = (release, answer) => {
        try {
          return cp.execFileSync('bash', [path.join(zip, 'scripts/push_github.command')], { input: answer + '\n', encoding: 'utf8',
            env: Object.assign({}, process.env, { PUSH_GITHUB_REMOTE: bare, PUSH_GITHUB_RELEASE: release, TMPDIR: dir }) });
        } catch (e) { return 'EXIT ' + e.status + ' ' + (e.stdout || ''); }
      };
      const remote = f => { try { return git(bare, ['show', 'main:' + f]); } catch (_) { return null; } };

      let out = push('no', 'n');
      eq(JSON.parse(remote('package.json')).version, '1.0.0', '"n" sends nothing');
      out = push('no', 'y');
      ok(/Sent: demo 1\.1\.0/.test(out), 'a "y" sends the new version');
      eq(remote('old.txt'), null, 'a file removed from the folder is removed from GitHub');
      ok(/100755 blob \S+\tnew\.sh/.test(git(bare, ['ls-tree', 'main'])), 'scripts arrive executable');
      eq(JSON.parse(remote('version.json')).version, '1.0.0', 'version.json waits while the Release does not exist');
      out = push('no', 'y');
      ok(/already on GitHub/.test(out), 'running again before the Release sends nothing');
      out = push('yes', 'y');
      eq(JSON.parse(remote('version.json')).version, '1.1.0', 'once the Release exists, version.json goes');
      out = push('yes', 'y');
      ok(/^EXIT 1/.test(out) && /not higher than 1\.1\.0/.test(out), 'the same version is never sent twice');
      fs.writeFileSync(path.join(zip, 'version.json'), JSON.stringify({ version: '1.2.0' }));
      out = push('yes', 'y');
      ok(/^EXIT 1/.test(out) && /package\.json says 1\.1\.0/.test(out), 'version.json and package.json must agree');
    }
  }

  // (d15) .syncto.db and .syncto.lock are hidden on Windows (0.8.6). The dot
  //       hides them on macOS and Linux only; Windows wants the attribute, set
  //       after every write of the database because each one puts a new file
  //       in place.
  {
    const { writeDb, readDb } = require('../src/main/core/db');
    const { NativeFs } = require('../src/main/fs/native');
    const winFs = (calls, opts) => {
      const n = new NativeFs();
      n._platform = 'win32';
      n._attrib = async args => { calls.push(args.join(' ')); if (opts && opts.fail) throw new Error('attrib missing'); };
      return n;
    };
    const doc = { format: 'syncto-db', version: 1, sessions: {} };

    {
      const { L } = scratch();
      const calls = [];
      await writeDb(winFs(calls), L, doc);
      eq(calls, ['+h ' + path.join(L, '.syncto.db')], 'on Windows the database is hidden right after it is written');
      await writeDb(winFs(calls), L, doc);
      eq(calls.length, 2, 'and again at every write, since each one puts a new file in place');
    }
    {
      const { L } = scratch();
      const calls = [];
      await writeDb(new NativeFs(), L, doc);
      const n = new NativeFs(); n._attrib = async a => calls.push(a);
      await writeDb(n, L, doc);
      eq(calls, [], 'nothing is run on macOS or Linux, where the dot already hides it');
    }
    {
      const { L } = scratch();
      const calls = [];
      await writeDb(winFs(calls, { fail: true }), L, doc);
      ok(!!(await readDb(new NativeFs(), L)), 'a failed attrib leaves the database visible, never unwritten');
    }
    {
      // Windows refusing to replace a hidden file: the attribute is cleared,
      // the rename retried once, the new file hidden again.
      const { L } = scratch();
      const calls = [];
      const n = winFs(calls);
      let refused = false;
      const rename = n.rename.bind(n);
      n.rename = async (a, b) => {
        if (!refused) { refused = true; const e = new Error('EPERM: operation not permitted'); e.code = 'EPERM'; throw e; }
        return rename(a, b);
      };
      await writeDb(n, L, doc);
      const db = path.join(L, '.syncto.db');
      eq(calls, ['-h ' + db, '+h ' + db], 'a refused replacement unhides, retries, and hides again');
      ok(!!(await readDb(new NativeFs(), L)), 'and the database is written');
      ok(!fs.existsSync(db + '.syncto_tmp'), 'without leaving the temporary file behind');
    }
    {
      const n = new NativeFs(); n._platform = 'win32';
      const seen = [];
      n._attrib = async a => seen.push(a[1]);
      await n.setHidden('\\\\?\\D:\\RUSHES\\.syncto.db', true);
      await n.setHidden('\\\\?\\UNC\\nas\\edit\\.syncto.db', true);
      eq(seen, ['D:\\RUSHES\\.syncto.db', '\\\\nas\\edit\\.syncto.db'], 'attrib gets the path without the long-path prefix');
    }
    // The lock too (Noar, 05/10/2026), without ever leaving it behind.
    {
      const { acquireOne } = require('../src/main/core/lock');
      const { L } = scratch();
      const calls = [];
      let finish = null;
      const n = winFs(calls);
      // A slow attrib: it only answers when the test says so.
      n._attrib = args => new Promise(r => { calls.push(args.join(' ')); finish = r; });
      const lock = await acquireOne(n, L, {});
      const lp = path.join(L, '.syncto.lock');
      eq(calls, ['+h ' + lp], 'on Windows the lock is hidden as soon as it is created');
      let released = false;
      const rel = lock.release().then(() => { released = true; });
      await new Promise(r => setTimeout(r, 50));
      ok(!released && fs.existsSync(lp), 'releasing waits for attrib before deleting the file');
      finish();
      await rel;
      ok(!fs.existsSync(lp), 'then deletes it: no lock left behind');
    }
    {
      const { acquireOne } = require('../src/main/core/lock');
      const { L } = scratch();
      const n = winFs([], { fail: true });
      const lock = await acquireOne(n, L, {});
      ok(!!lock, 'a failed attrib never stops a run from taking its lock');
      await lock.release();
    }
    const srcOf = f => fs.readFileSync(path.join(root, f), 'utf8');
    ok(!/setHidden/.test(srcOf('src/main/core/sync.js')), 'the checksum list stays visible');
    ok(/windowsHide: true/.test(srcOf('src/main/fs/native.js')), 'attrib runs without flashing a console window');
  }

  // (d16) Two rings during a run (0.8.7): the inner one is the pass going on,
  //       from 0 to 100 %, the outer one the whole run.
  {
    const app = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
    const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
    const len = r => Math.round(2 * Math.PI * r * 10) / 10;
    ok(/r="27"[^>]*id="pb-ring"[^>]*stroke-dasharray="169\.6"/.test(html) && /const RING_LEN = 169\.6;/.test(app) && len(27) === 169.6,
       'the inner ring and its length agree');
    ok(/r="33\.5"[^>]*id="pb-ring-all"[^>]*stroke-dasharray="210\.5"/.test(html) && /const RING_ALL_LEN = 210\.5;/.test(app) && len(33.5) === 210.5,
       'and so do the outer ring and its length');
    const prog = app.slice(app.indexOf('API.onSyncProgress('), app.indexOf("$('pb-fill').style.width = pct + '%';"));
    ok(/const passPct = p\.pass === 'cleanup' \? 100[\s\S]{0,120}p\.passBytesTotal > 0/.test(prog) && /\$\('pb-ring'\)\.setAttribute\('stroke-dashoffset', RING_LEN \* \(1 - passPct \/ 100\)\)/.test(prog),
       'the inner ring and the big figure follow the pass');
    ok(/\$\('pb-ring-all'\)\.setAttribute\('stroke-dashoffset', RING_ALL_LEN \* \(1 - pct \/ 100\)\)/.test(prog) &&
       /'TOTAL ' \+ Math\.round\(pct\) \+ '%'/.test(prog), 'the outer ring and "TOTAL" follow the whole run');
    ok(/#bottombar:not\(\.run\) \.ring-all,#bottombar:not\(\.run\) \.ring-all-track,#bottombar:not\(\.run\) \.ring-sub\{display:none;\}/.test(html),
       'a comparison shows one ring only');
  }

  // (d13) hash.js no longer describes three copy levels (0.8.6).
  {
    const h = fs.readFileSync(path.join(root, 'src/main/core/hash.js'), 'utf8');
    const head = h.slice(0, h.indexOf('let _hw'));
    ok(!/fast\s+copy only/.test(head) && !/verified\s+compares the size/.test(head),
       'the header comment describes the one copy mode');
  }
}



// ══ 51. Windows-safe names (0.8.9) ══════════════════════════════════════════
// Asked by Noar (13/10/2026): folders from a Mac whose names Windows refuses
// (":" shown as a box on the PC, "?", trailing dots…) renamed during the
// synchronization, on the destination only or on both sides. Run alone:
//   SYNCTO_ONLY=testSafeNames089 node test/run-tests.js
async function testSafeNames089() {
  console.log('\n\n51. Windows-safe names (0.8.9)');
  const wn = require('../src/main/fs/winname');
  const { loadJob, JOB_FORMAT } = require('../src/main/config');
  const files = base => listAll(base).filter(f => !f.endsWith('/') && !f.includes('.syncto.') && !f.endsWith('syncto-checksums.txt'));
  const job = (L, R, variant, safeNames) => makeJob(L, R, { sync: { variant, safeNames } });

  // (w1) The cleaning itself.
  eq(wn.windowsSafe('Industry: Digital'), 'Industry_ Digital', '":" becomes "_"');
  eq(wn.windowsSafe('Industry Digital'), 'Industry_ Digital', 'and so does the box a Mac writes for it on a share');
  eq(wn.windowsSafe('a<b>c"d|e?f*g'), 'a_b_c_d_e_f_g', '< > " | ? * become "_"');
  eq(wn.windowsSafe('Report. '), 'Report', 'a trailing dot or space is dropped');
  eq(wn.windowsSafe('Report\uf029'), 'Report', 'and so is the trailing dot a Mac wrote on a share (U+F029)');
  eq([wn.windowsSafe('CON.txt'), wn.windowsSafe('nul'), wn.windowsSafe('com1.mov'), wn.windowsSafe('CONSOLE.txt')],
     ['CON_.txt', 'nul_', 'com1_.mov', 'CONSOLE.txt'], 'device names get "_", longer names do not');
  eq(wn.windowsSafe("Clip (v2), final & co's #1.mov"), "Clip (v2), final & co's #1.mov",
     'parentheses, commas, &, apostrophes and # are legal on Windows and kept');
  ok(wn.isMacIconFile('Icon\r') && wn.isMacIconFile('Icon') && !wn.isMacIconFile('Icon'), 'the Mac custom-icon file is recognised');
  {
    const j = defaultJob(); j.sync.safeNames = 'sideways'; j.format = JOB_FORMAT;
    const f = path.join(scratch().dir, 'odd.syncto');
    fs.writeFileSync(f, JSON.stringify(j));
    eq(loadJob(f).sync.safeNames, 'off', 'an unknown value in a job file means off');
    eq(wn.safeNamesMode({ safeNames: 'sideways' }), 'off', 'and the engine reads it as off too');
    eq(defaultJob().sync.safeNames, 'off', 'off by default');
  }

  // (w2) Destination only, MIRROR: new items arrive cleaned, the source is
  //      not touched, the Mac icon file stays home, next run has nothing to do.
  {
    const { L, R } = scratch();
    write(L, 'Forum: Day 1/clip?.mov', 'clip');
    write(L, 'Forum: Day 1/Icon\r', '');
    const r1 = await runPair(job(L, R, 'mirror', 'destination'));
    eq(r1.run.errors.length, 0, 'no error');
    eq(files(R), ['Forum_ Day 1/clip_.mov'], 'the destination gets the cleaned names, and no icon file');
    eq(files(L).sort(), ['Forum: Day 1/Icon\r', 'Forum: Day 1/clip?.mov'], 'the source keeps its names');
    const r2 = await runPair(job(L, R, 'mirror', 'destination'));
    ok(r2.s.nodes.every(n => n.op === OP.NONE) && !r2.s.nodes.some(n => n.fixL || n.fixR), 'next run: paired, nothing to do');
    write(L, 'Forum: Day 1/clip?.mov', 'clip v2', Date.now() + 5000);
    await runPair(job(L, R, 'mirror', 'destination'));
    eq(read(R, 'Forum_ Day 1/clip_.mov'), 'clip v2', 'an edit at the source updates the cleaned copy');
  }

  // (w3) Destination only, names already bad at the destination: renamed in
  //      place (no copy), said in the notes, source untouched.
  {
    const { L, R } = scratch();
    const t = Date.now() - 3600e3;
    write(L, 'Forum: Day 1/clip?.mov', 'clip', t);
    write(R, 'Forum: Day 1/clip?.mov', 'clip', t);
    const r = await runPair(job(L, R, 'mirror', 'destination'));
    eq([r.cmp.stats ? r.cmp.stats.renameRight : r.s.stats.renameRight, (r.cmp.stats || r.s.stats).renameLeft], [2, 0],
       'the comparison plans two renames, on the destination only');
    eq(files(R), ['Forum_ Day 1/clip_.mov'], 'renamed in place');
    eq(read(R, 'Forum_ Day 1/clip_.mov'), 'clip', 'same file, not a copy');
    eq(r.run.notes.filter(m => /^Renamed for Windows in the right folder/.test(m)).length, 2, 'each rename is reported');
    eq(files(L), ['Forum: Day 1/clip?.mov'], 'the source is not touched');
  }

  // (w4) Both sides, 2 WAYS: originals renamed too, then synchronized.
  {
    const { L, R } = scratch();
    write(L, 'a:b.txt', 'from the Mac');
    write(R, 'c|d.txt', 'from the PC');
    const r = await runPair(job(L, R, 'twoWay', 'both'));
    eq(r.run.errors.length, 0, 'no error');
    eq([files(L), files(R)], [['a_b.txt', 'c_d.txt'], ['a_b.txt', 'c_d.txt']], 'both sides end with the same clean names');
  }

  // (w5) Two names that meet once cleaned: neither is synchronized.
  {
    const { L, R } = scratch();
    write(L, 'a:b.txt', '1'); write(L, 'a_b.txt', '2'); write(L, 'ok.txt', '3');
    const r = await runPair(job(L, R, 'mirror', 'destination'));
    ok(r.cmp.errors.some(e => /become the same name for Windows \("a_b\.txt"\)/.test(e.message)), 'the clash is reported');
    eq(files(R), ['ok.txt'], 'neither of the two is copied, the rest is');
  }

  // (w6) A rename that cannot be done stops the run before anything else.
  {
    const { L, R } = scratch();
    const t = Date.now() - 3600e3;
    write(L, 'x:y.txt', 'xy', t); write(R, 'x:y.txt', 'xy', t); write(L, 'new.txt', 'n');
    const s = new Session(); const token = { cancelled: false };
    const j = job(L, R, 'mirror', 'destination');
    await s.compare(j, { token });
    write(R, 'x_y.txt', 'appeared meanwhile');
    const run = await s.sync(j, { token, appVersion: 'test' });
    await s.close();
    ok(run.errors.some(e => /Could not rename "x:y\.txt" for Windows: "x_y\.txt" already exists there/.test(e.message)), 'the refusal is reported');
    ok(!exists(R, 'new.txt'), 'and nothing after it was done');
    eq(read(R, 'x_y.txt'), 'appeared meanwhile', 'the file in the way is not overwritten');
  }

  // (w8) Destination only in 2 WAYS: an edit of the cleaned copy goes back
  //      to the original under its own name; a deletion follows next run.
  {
    const { L, R } = scratch();
    write(L, 'Shoot: day 2/take?.mov', 'v1', Date.now() - 7200e3);
    await runPair(job(L, R, 'twoWay', 'destination'));
    write(R, 'Shoot_ day 2/take_.mov', 'graded on the PC', Date.now());
    await runPair(job(L, R, 'twoWay', 'destination'));
    eq(read(L, 'Shoot: day 2/take?.mov'), 'graded on the PC', 'the edit reaches the original');
    eq(files(L), ['Shoot: day 2/take?.mov'], 'without a second file on the Mac');
    fs.unlinkSync(path.join(R, 'Shoot_ day 2/take_.mov'));
    await runPair(job(L, R, 'twoWay', 'destination'));
    ok(!exists(L, 'Shoot: day 2/take?.mov'), 'a deletion on the PC side follows (history kept under the clean name)');
  }

  // (w7) Off (the default): names and the icon file go through as before.
  {
    const { L, R } = scratch();
    write(L, 'a:b.txt', '1'); write(L, 'Icon\r', '');
    await runPair(job(L, R, 'mirror', 'off'));
    eq(files(R).sort(), ['Icon\r', 'a:b.txt'], 'nothing renamed, nothing left out');
  }
}

// ══ 50. Names too long for a destination (0.8.8) ═══════════════════════════
// Reported on Windows: a 246-character file name failed with "ENOENT: no such
// file or directory": ".syncto_tmp" took it to 257, past the 255 every
// filesystem allows for one name. Run alone:
//   SYNCTO_ONLY=testLongNames088 node test/run-tests.js
async function testLongNames088() {
  console.log('\n\n50. Names too long for a destination (0.8.8)');
  const ln = require('../src/main/fs/longname');
  const { NativeFs } = require('../src/main/fs/native');
  const nfs = new NativeFs();
  const runAs = async (L, R, variant, over) => {
    const j = makeJob(L, R, Object.assign({ sync: { variant } }, over || {}));
    return runPair(j);
  };
  const files = base => listAll(base).filter(f => !f.endsWith('/') && !f.includes('.syncto.') && !f.endsWith('syncto-checksums.txt'));

  // (n1) The reported case, with the real limit: a 246-character name (with
  //      the U+F022 a Mac puts on a share for ":") in a 110-character folder.
  {
    const seg = 'TP4_BLOCK4_D1_1400_Forum 18 - Smart Infrastructure for the Future Energy Industry Digitalisation & Innovation';
    const name = seg + seg + '_ABDULLAH AL MALKI_V1.pptx';
    eq(name.length, 246, 'the name of the report: 246 characters');
    ok(!ln.fits(name + '.syncto_tmp'), 'and with ".syncto_tmp" it no longer fits');
    const { L, R } = scratch();
    write(L, `D1/${seg}/${name}`, 'deck');
    const { run } = await runAs(L, R, 'mirror');
    eq(run.errors.length, 0, 'the copy no longer fails');
    eq(read(R, `D1/${seg}/${name}`), 'deck', 'and the file keeps its full name: it fits');
    ok(!run.notes.some(m => /Name too long/.test(m)), 'nothing renamed, nothing to say');
    ok(!files(R).some(f => f.endsWith('.syncto_tmp')), 'no temporary file left behind');
  }

  // (n2) Scratch names: unchanged when short, shortened when near a limit.
  {
    eq(ln.scratchPath(nfs, '/a/b/clip.mov', '.syncto_tmp'), '/a/b/clip.mov.syncto_tmp', 'a short name keeps "<name>.syncto_tmp"');
    const t = nfs.basename(ln.scratchPath(nfs, '/a/b/' + 'x'.repeat(240) + '.mov', '.syncto_tmp'));
    ok(t.endsWith('.mov.syncto_tmp') && ln.fits(t, ln.SCRATCH_MAX), 'a long one gets a short scratch name (fits 143)');
    const { L, R } = scratch();
    write(R, 'y'.repeat(120) + '~0123abcd.mov.syncto_tmp', 'half');
    write(L, 'a.txt', 'a');
    const { s: ses } = await runAs(L, R, 'mirror');
    eq((ses.leftovers || []).map(x => path.basename(x.path)), ['y'.repeat(120) + '~0123abcd.mov.syncto_tmp'],
       'a short scratch name left by a power cut is still found as a leftover');
    ok(!files(R).some(f => f.endsWith('.syncto_tmp')), 'and swept by the run');
  }

  // (n3) Shortening: same result every time, extension kept, cut on whole
  //      characters, within 255 bytes AND 255 UTF-16 units, no trailing space.
  {
    const arabic = 'تقرير الحفل النهائي '.repeat(14) + 'v2.mp4';
    ok(!ln.fits(arabic), 'an Arabic name of ' + arabic.length + ' characters is over 255 bytes');
    const s1 = ln.shorten(arabic), s2 = ln.shorten(arabic);
    eq(s1, s2, 'the same name always gives the same short name');
    ok(ln.fits(s1) && s1.endsWith('.mp4') && /~[0-9a-f]{8}\.mp4$/.test(s1), 'it fits, keeps ".mp4", ends with ~tag');
    ok(arabic.startsWith(s1.replace(/~[0-9a-f]{8}\.mp4$/, '')), 'and starts like the original');
    const emoji = '🎬'.repeat(140) + '.mov';
    const s3 = ln.shorten(emoji);
    ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(s3) && ln.fits(s3), 'no emoji cut in half');
    ok(!/[ .]~/.test(ln.shorten('a b '.repeat(80) + '.txt')), 'no space or dot left just before the tag');
    ok(ln.shorten('x'.repeat(300) + '.mov') !== ln.shorten('x'.repeat(301) + '.mov'), 'two different names, two short names');
  }

  // (n4) A timestamped revision of a long name stays within the limit, with
  //      its date whole.
  {
    const rel = 'sub/' + 'r'.repeat(250) + '.mov';
    const out = versionedRelPath(rel, 'timestampFile', '2026-10-11 101500').split('/').pop();
    ok(ln.fits(out) && / 2026-10-11 101500\.mov$/.test(out), 'the revision name fits and ends with its date');
    eq(versionedRelPath('sub/clip.mov', 'timestampFile', '2026-10-11 101500'), 'sub/clip 2026-10-11 101500.mov', 'a short name is unchanged');
  }

  // (n5) A name that fits nowhere: saved under a short name, said once, and
  //      paired with its original at every run after. The limit is lowered for
  //      the test: an ext4 disk cannot hold a name over 255 bytes at the source.
  const saved = ln.limits.name;
  ln.limits.name = 60;
  try {
    const dirName = 'Folder with a name far too long for the destination ' + 'd'.repeat(20);
    const fileName = 'Interview of the speaker, full length, colour graded ' + 'f'.repeat(20) + '.mov';
    const rel = dirName + '/' + fileName;
    const sDir = ln.shorten(dirName), sFile = ln.shorten(fileName);
    const { L, R } = scratch();
    write(L, rel, 'v1', Date.now() - 3600e3);

    let r = await runAs(L, R, 'mirror');
    eq(r.run.errors.length, 0, 'the copy goes through');
    eq(read(R, sDir + '/' + sFile), 'v1', 'under the short folder and file names');
    eq(files(R).length, 1, 'and nothing else');
    eq(r.run.notes.filter(m => /^Name too long for the right folder/.test(m)).length, 2,
       'the folder and the file are each reported once');
    ok(r.run.notes.some(m => m.includes(`"${fileName}" was saved there as "${sFile}"`)), 'naming both names');

    r = await runAs(L, R, 'mirror');
    ok(r.cmp.nodes ? r.cmp.nodes.every(n => n.op === OP.NONE) : r.s.nodes.every(n => n.op === OP.NONE),
       'next comparison: paired, nothing to do (no copy, no deletion)');
    ok(!r.run.notes.some(m => /Name too long/.test(m)), 'and nothing said again');

    write(L, rel, 'v2 longer', Date.now());
    r = await runAs(L, R, 'mirror');
    eq(read(R, sDir + '/' + sFile), 'v2 longer', 'an edit at the source updates the short-named copy');
    eq(files(R).length, 1, 'no second file');

    write(R, sDir + '/' + sFile, 'edited on the backup', Date.now() + 5000);
    r = await runAs(L, R, 'twoWay');
    eq(read(L, rel), 'edited on the backup', '2 WAYS: an edit of the short-named copy goes back to the original');
    eq(files(L).length, 1, 'under its long name, not as a new file');

    fs.unlinkSync(path.join(L, rel));
    r = await runAs(L, R, 'mirror');
    ok(!exists(R, sDir + '/' + sFile), 'MIRROR: deleting the original deletes its short-named copy');
  } finally {
    ln.limits.name = saved;
  }
}

// ══ 49. The 0.8.8 review: data loss, wrong decisions, security, interface ═══
// Each block reproduces a defect found by the code review of 09/10/2026 and
// checks the fix. Run alone: SYNCTO_ONLY=testReview088 node test/run-tests.js
async function testReview088() {
  console.log('\n\n49. Review fixes: engine, security, interface (0.8.8)');
  const root = path.join(__dirname, '..');
  const { NativeFs } = require('../src/main/fs/native');
  const dbMod = require('../src/main/core/db');
  const DAY = 86400000;
  const twoPairJob = (pairs, variant) => {
    const j = defaultJob(); j.name = 't'; j.pairs = pairs;
    j.sync.variant = variant; j.sync.deletion = 'permanent'; j.sync.retryCount = 0;
    return j;
  };
  async function runWith(job, syncOpts) {
    const s = new Session(); const token = { cancelled: false, paused: false };
    const cmp = await s.compare(job, { token });
    const run = await s.sync(job, Object.assign({ token, appVersion: 'test' }, syncOpts || {}));
    await s.close();
    return { s, cmp, run };
  }
  async function multiRun(job) {
    const m = new MultiSession(); const token = { cancelled: false, paused: false };
    const cmp = await m.compare(job, { token });
    const plans = m.sessions.map(s => s.nodes.map(n => n.rel + ':' + n.op));
    const res = await m.sync(job, { token });
    await m.close();
    return { cmp, plans, res };
  }

  // (e1) One lstat that fails with anything but "not found" during the scan
  //      used to drop the file from the listing — and MIRROR deleted the
  //      backup copy, 2 WAYS propagated a "deletion". Now: asked again, then
  //      the folder is reported unreadable and the run is blocked.
  for (const variant of ['mirror', 'twoWay']) {
    const { L, R } = scratch();
    write(L, 'clip.mov', 'precious', Date.now() - DAY);
    const job = makeJob(L, R, { sync: { variant } });
    await runPair(job);
    const orig = fs.promises.lstat;
    fs.promises.lstat = async p => {
      if (String(p) === path.join(L, 'clip.mov')) { const e = new Error('EIO: i/o error, lstat'); e.code = 'EIO'; throw e; }
      return orig(p);
    };
    let blocked = false;
    try {
      const s = new Session();
      const cmp = await s.compare(job, { token: {} });
      blocked = cmp.errors.some(e => e.fatal && /could not be read/.test(e.message));
      try { await s.sync(job, { token: {}, appVersion: 'test' }); } catch (_) { /* refused */ }
      await s.close();
    } finally { fs.promises.lstat = orig; }
    ok(blocked, `${variant}: a file that cannot be read makes its folder unreadable, which blocks the run`);
    eq(read(R, 'clip.mov'), 'precious', `${variant}: and the copy on the other side is not deleted`);
  }
  {
    // A single hiccup is ridden out: asked once more, it answers.
    const { L, R } = scratch();
    write(L, 'clip.mov', 'precious', Date.now() - DAY);
    const job = makeJob(L, R, { sync: { variant: 'mirror' } });
    await runPair(job);
    const orig = fs.promises.lstat; let hit = 0;
    fs.promises.lstat = async p => {
      if (String(p) === path.join(L, 'clip.mov') && !hit++) { const e = new Error('EIO'); e.code = 'EIO'; throw e; }
      return orig(p);
    };
    let r;
    try { r = await runPair(job); } finally { fs.promises.lstat = orig; }
    eq(r.cmp.errors.length, 0, 'a single failed lstat is asked again and the run goes on');
    eq(read(R, 'clip.mov'), 'precious', 'with nothing deleted');
  }

  // (e2) Two pairs sharing a base folder (L↔R1, L↔R2): an edit on R1 and a
  //      deletion on R2 ended with the edit lost on all three sides. Nothing
  //      is replaced or deleted any more if it is not the file the comparison
  //      saw.
  {
    const { dir, L } = scratch();
    const R1 = path.join(dir, 'R1'), R2 = path.join(dir, 'R2');
    fs.mkdirSync(R1); fs.mkdirSync(R2);
    write(L, 'x.txt', 'original', Date.now() - DAY);
    const job = twoPairJob([{ left: L, right: R1 }, { left: L, right: R2 }], 'twoWay');
    await multiRun(job); await multiRun(job);
    write(R1, 'x.txt', 'EDITED ON R1');
    fs.unlinkSync(path.join(R2, 'x.txt'));
    const a = await multiRun(job);
    eq(read(L, 'x.txt'), 'EDITED ON R1', 'pair 2 does not delete what pair 1 has just written');
    ok(a.res.errors.some(e => /changed since the comparison/.test(e.message)), 'it says the file changed since the comparison');
    await multiRun(job);
    eq(read(R1, 'x.txt'), 'EDITED ON R1', 'and the edit survives the next run');
  }
  {
    // Same rule on one pair: a file edited after Compare is not overwritten.
    const { L, R } = scratch();
    write(L, 'a.txt', 'new from L');
    write(R, 'a.txt', 'old', Date.now() - DAY);
    const job = makeJob(L, R, { sync: { variant: 'mirror' } });
    const s = new Session();
    await s.compare(job, { token: {} });
    write(R, 'a.txt', 'edited on R after the comparison');
    const run = await s.sync(job, { token: {}, appVersion: 'test' });
    await s.close();
    eq(read(R, 'a.txt'), 'edited on R after the comparison', 'a target edited after Compare is not overwritten');
    ok(run.errors.some(e => /changed since the comparison/.test(e.message)), 'and the row is reported');
  }

  // (e3) "Move to the trash": a file the trash refuses (a long Windows path)
  //      was deleted, or replaced, for good with nothing said.
  {
    const { L, R } = scratch();
    write(R, 'b.txt', 'b'); write(L, 'o.txt', 'NEW'); write(R, 'o.txt', 'OLD', Date.now() - DAY);
    const job = makeJob(L, R, { sync: { variant: 'mirror', deletion: 'recycler', retryCount: 1, retryDelayMs: 1 } });
    const trashItem = async (fsx, p) => {
      if (/trash-probe/.test(p)) { await fsx.unlink(p); return true; }
      return false;
    };
    const s = new Session();
    await s.compare(job, { token: {} });
    const run = await s.sync(job, { token: {}, trashItem, appVersion: 'test' });
    await s.close();
    eq(read(R, 'b.txt'), 'b', 'a file the trash refuses is left in place');
    eq(read(R, 'o.txt'), 'OLD', 'and a version the trash refuses is not replaced, even on the retry');
    ok(run.errors.some(e => /refused this item/.test(e.message)) &&
       run.errors.some(e => /refused the version about to be replaced/.test(e.message)), 'both are reported as errors');
  }

  // (e4) A file id reused by a new file (ext4 inodes, FAT/exFAT slots) was
  //      taken for a move: the destination kept the OLD content under the
  //      new name, and the run said it succeeded.
  {
    const { L, R } = scratch();
    write(L, 'a.bin', 'AAAAAAAAAA', Date.now() - DAY);
    const job = makeJob(L, R, { sync: { variant: 'mirror' } });
    await runPair(job);
    const s0 = new Session(); await s0.compare(job, { token: {} });
    const idA = s0.nodes.find(n => n.rel === 'a.bin').left.id; await s0.close();
    fs.unlinkSync(path.join(L, 'a.bin'));
    write(L, 'b.bin', 'BBBBBBBBBB');
    // The reuse itself is up to the filesystem: forced here through the id.
    const s = new Session();
    const orig = NativeFs.prototype.readdir;
    NativeFs.prototype.readdir = async function (p) {
      const list = await orig.call(this, p);
      for (const e of list) if (e && e.name === 'b.bin' && p === L) e.id = idA;
      return list;
    };
    let cmp;
    try { cmp = await s.compare(job, { token: {} }); } finally { NativeFs.prototype.readdir = orig; }
    eq(cmp.movesFound || 0, 0, 'a reused id with a new date is not a move');
    await s.sync(job, { token: {}, appVersion: 'test' }); await s.close();
    eq(read(R, 'b.bin'), 'BBBBBBBBBB', 'the destination gets the new content');
  }
  {
    // A real rename is still recognised (the date travels with the file).
    const { L, R } = scratch();
    write(L, 'a.bin', 'AAAAAAAAAA', Date.now() - DAY);
    const job = makeJob(L, R, { sync: { variant: 'mirror' } });
    await runPair(job);
    fs.renameSync(path.join(L, 'a.bin'), path.join(L, 'renamed.bin'));
    const r = await runPair(job);
    eq(r.cmp.movesFound, 1, 'a real rename is still a move');
    eq(read(R, 'renamed.bin'), 'AAAAAAAAAA', 'and is renamed on the other side');
  }

  // (e5) Comparison by content, 2 WAYS: a copy gone bad (same size, same
  //      date) was found different and then ignored at every run.
  {
    const { L, R } = scratch();
    write(L, 'clip.mov', 'GOOD DATA 0123456789', Date.now() - DAY);
    const job = makeJob(L, R, { sync: { variant: 'twoWay' }, compare: { compareVariant: 'content' } });
    await runPair(job);
    const p = path.join(R, 'clip.mov'); const st = fs.statSync(p);
    fs.writeFileSync(p, 'GOOD DATA 01234X6789'); fs.utimesSync(p, st.atime, st.mtime);
    const s = new Session(); const cmp = await s.compare(job, { token: {} }); await s.close();
    eq(cmp.stats.conflicts, 1, 'a content difference nobody made is a conflict');
    ok(/damaged/.test(s.nodes.find(n => n.rel === 'clip.mov').dirMsg || s.nodes.find(n => n.rel === 'clip.mov').catMsg || JSON.stringify(s.nodes.find(n => n.rel === 'clip.mov'))),
       'saying one of the copies may be damaged');
  }

  // (e6) Two names differing only by case (Linux, SFTP): MIRROR overwrote the
  //      backup of a.txt with the content of A.txt.
  {
    const { L, R } = scratch();
    write(L, 'a.txt', 'lowercase original');
    const ci = fs.existsSync(path.join(L, 'A.TXT'));
    if (ci) { ok(true, 'case collision skipped (case-insensitive filesystem)'); ok(true, 'skipped'); }
    else {
      const job = makeJob(L, R, { sync: { variant: 'mirror' } });
      await runPair(job);
      write(L, 'A.txt', 'UPPERCASE different file');
      const r = await runPair(job);
      eq(read(R, 'a.txt'), 'lowercase original', 'the backup of a.txt is not overwritten by A.txt');
      ok(r.cmp.errors.some(e => /neither is synchronized/.test(e.message)), 'the clash is reported, neither name synchronized');
    }
  }

  // (e7) A checksum list written with another algorithm was emptied by a run
  //      that only deleted something on the OTHER side.
  {
    const { L, R } = scratch();
    write(L, 'clip.mov', 'data', Date.now() - DAY);
    const list = '# syncto checksum list\n# algorithm: xxh128\n0123456789abcdef0123456789abcdef  clip.mov\n';
    write(L, 'syncto-checksums.txt', list);
    write(R, 'clip.mov', 'data', Date.now() - DAY);
    write(R, 'stray.txt', 'x');
    const job = makeJob(L, R, { sync: { variant: 'mirror', writeChecksumList: true } });
    await runPair(job);
    eq(read(L, 'syncto-checksums.txt'), list, 'the source list is left untouched');
  }

  // (e8) The same folder named two ways in one job (symlink, other spelling):
  //      the second lock took over the first, and the run stopped itself.
  {
    const { acquireAll } = require('../src/main/core/lock');
    const { dir, L } = scratch();
    fs.symlinkSync(L, path.join(dir, 'Lalias'));
    const nfs = new NativeFs(); let lost = null;
    const locks = await acquireAll([{ fs: nfs, path: L }, { fs: nfs, path: path.join(dir, 'Lalias') }],
      { onLost: r => { lost = r; }, timing: { beatMs: 100, detectMs: 60000 } });
    await new Promise(r => setTimeout(r, 400));
    eq(lost, null, 'a folder this run already holds is shared, not taken over');
    eq(locks.lost(), null, 'and no lock is lost');
    await locks.release();
    ok(!fs.existsSync(path.join(L, '.syncto.lock')), 'and the lock is released at the end');
  }

  // (e9) History carry-over (0.8.6): only when neither folder has a session
  //      under the new paths.
  {
    const { dir, L: A, R: B } = scratch();
    const C = path.join(dir, 'C');
    const T = Date.now() - DAY;
    write(A, 'K.txt', 'keep me', T); write(A, 'other.txt', 'o', T);
    const job = twoPairJob([{ left: A, right: B }], 'twoWay');
    await multiRun(job);
    fs.renameSync(B, C);
    fs.unlinkSync(path.join(A, 'K.txt'));
    job.pairs = [{ left: A, right: C, was: { left: A, right: B } }];
    await multiRun(job);
    const nfs = new NativeFs();
    const doc = await dbMod.readDb(nfs, C);
    delete doc.sessions[dbMod.pairIdFor(null, A, C)];
    await dbMod.writeDb(nfs, C, doc);
    write(C, 'K.txt', 'keep me', T);
    await multiRun(job);
    eq(read(C, 'K.txt'), 'keep me', 'a restored file is not deleted on the strength of an old session');
  }

  // (e10) Cancelled before the read-back: the copies are not recorded as
  //       synchronized.
  {
    const { L, R } = scratch();
    write(L, 'a.mov', Buffer.alloc(1 << 20, 3)); write(L, 'b.mov', Buffer.alloc(1 << 20, 4));
    const job = makeJob(L, R, { sync: { variant: 'twoWay' } });
    const s = new Session(); const token = { cancelled: false, paused: false };
    await s.compare(job, { token });
    const r = await s.sync(job, { token, appVersion: 'test', onProgress: p => { if (p.pass === 'verify') token.cancelled = true; } });
    await s.close();
    const d = await dbMod.readDb(new NativeFs(), L);
    const sess = d && Object.values(d.sessions)[0];
    ok(r.cancelled, 'the run was cancelled during the read-back');
    ok(!sess || !Object.values(sess.items).some(e => e.sy), 'no unverified copy is recorded as synchronized');
  }

  // (e11) Progress: never past 100 %, ends at 100 %, never backwards.
  {
    // Correct dates only, contents different: compared then copied.
    const { L, R } = scratch();
    write(L, 'a.bin', Buffer.alloc(2 << 20, 1), Date.now());
    write(R, 'a.bin', Buffer.alloc(2 << 20, 2), Date.now() - DAY);
    const job = makeJob(L, R, { sync: { variant: 'mirror', fixDatesOnly: true } });
    let max = 0, maxPass = 0;
    await runWith(job, { onProgress: p => {
      if (p.phase !== 'sync' || !p.bytesTotal) return;
      max = Math.max(max, p.bytesDone / p.bytesTotal);
      if (p.passBytesTotal) maxPass = Math.max(maxPass, p.passBytesDone / p.passBytesTotal);
    } });
    ok(max <= 1.0001 && maxPass <= 1.0001, 'Correct dates only does not count a file twice');
  }
  {
    // A retried copy takes its first attempt back.
    const { L, R } = scratch();
    write(L, 'a.mov', Buffer.alloc(4 << 20, 3));
    const job = makeJob(L, R, { sync: { variant: 'mirror', retryCount: 2, retryDelayMs: 1 } });
    const orig = NativeFs.prototype.rename; let n = 0;
    NativeFs.prototype.rename = async function (a, b) {
      if (a.endsWith('.syncto_tmp') && n++ < 2) { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; }
      return orig.call(this, a, b);
    };
    let max = 0, last = null;
    try {
      const s = new Session(); const token = { cancelled: false };
      await s.compare(job, { token });
      await s.sync(job, { token, appVersion: 'test', onProgress: p => {
        if (p.phase !== 'sync' || !p.bytesTotal) return;
        max = Math.max(max, p.bytesDone / p.bytesTotal); last = p;
      } });
      await s.close();
    } finally { NativeFs.prototype.rename = orig; }
    ok(max <= 1.0001, 'retries do not push the ring past 100 %');
    ok(last && Math.abs(last.bytesDone - last.bytesTotal) < 1, 'and it ends at 100 %');
  }
  {
    // Read-back off (a server): the TOTAL ring used to stop at 50 %.
    const { L, R } = scratch();
    write(L, 'a.bin', Buffer.alloc(1 << 20, 7));
    const job = twoPairJob([{ left: L, right: R }], 'mirror'); job.sync.verifyRemote = false;
    const m = new MultiSession(); const token = { cancelled: false };
    await m.compare(job, { token });
    m.sessions[0].right.kind = 'sftp';
    let last = null, prev = 0, backwards = false;
    await m.sync(job, { token, onProgress: p => {
      if (p.phase !== 'sync' || !p.bytesTotal) return;
      const f = p.bytesDone / p.bytesTotal; if (f + 1e-9 < prev) backwards = true; prev = f; last = p;
    } });
    await m.close();
    ok(last && Math.abs(last.bytesDone - last.bytesTotal) < 1, 'without read-back the whole-run ring still ends at 100 %');
    ok(!backwards, 'and never goes backwards');
  }
  {
    // A run that only deletes moves too.
    const { L, R } = scratch();
    write(R, 'x.txt', 'x'); write(R, 'y.txt', 'y');
    const job = makeJob(L, R, { sync: { variant: 'mirror' } });
    let last = null;
    await runWith(job, { onProgress: p => { if (p.phase === 'sync' && p.itemsTotal) last = p; } });
    ok(last && last.itemsTotal === 2 && last.itemsDone === 2, 'a run that only deletes counts its items');
    const app = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
    ok(/p\.itemsTotal > 0 \? \(p\.itemsDone \/ p\.itemsTotal\) \* 100/.test(app), 'and the ring follows them when there are no bytes');
  }

  // (e12) A checksum list below the root belongs to a nested or overlapping
  //       job: tried as a user file during this review, an outer MIRROR then
  //       deleted it at every other run. It stays out of the comparison.
  {
    const { L, R } = scratch();
    write(R, 'sub/syncto-checksums.txt', 'abc  a.mov\n'); write(R, 'sub/a.mov', 'v'); write(L, 'sub/a.mov', 'v');
    fs.utimesSync(path.join(R, 'sub/a.mov'), fs.statSync(path.join(L, 'sub/a.mov')).atime, fs.statSync(path.join(L, 'sub/a.mov')).mtime);
    await runPair(makeJob(L, R, { sync: { variant: 'mirror' } }));
    ok(exists(R, 'sub/syncto-checksums.txt'), 'an outer MIRROR leaves the nested job\'s checksum list alone');
  }

  // ── Security ───────────────────────────────────────────────────────────────
  // (s1) A Windows network path in a job is not touched when the job opens:
  //      Windows would connect and present the user's login to that host.
  {
    const { isUncPath } = require('../src/main/core/volume');
    ok(isUncPath('\\\\attacker\\x', 'win32') && isUncPath('//host/share', 'win32') &&
       isUncPath('\\\\?\\UNC\\h\\s', 'win32'), 'network paths are recognised on Windows');
    ok(!isUncPath('\\\\?\\C:\\x', 'win32') && !isUncPath('C:\\x', 'win32') && !isUncPath('\\\\attacker\\x', 'darwin'),
       'a long local path is not one, nor anything on a Mac');
    const { checkJobPaths } = require('../src/main/core/session');
    const orig = fs.promises.lstat; let touched = 0;
    fs.promises.lstat = async p => { if (/attacker/.test(String(p))) touched++; return orig(p); };
    let res;
    try { res = await checkJobPaths({ pairs: [{ left: '\\\\attacker\\share\\x', right: '/tmp' }] }, { platform: 'win32' }); }
    finally { fs.promises.lstat = orig; }
    eq(touched, 0, 'opening a job does not look at a network path');
    eq(res, [], 'and reports nothing about it');
    const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
    ok(/'folder-exists', async \(_, p\) => \{\s*if \(isUncPath\(p\)\) return true;/.test(main) &&
       /'disk-free', async \(_, p\) => \{\s*if \(isUncPath\(p\)\) return null;/.test(main),
       'nor does the red light of a path field, nor the free-space readout');
  }

  // (s2) A password saved for nas:22 is not sent to nas:2222.
  {
    const { parseLocation } = require('../src/main/fs/afs');
    const creds = { 'admin@nas.local': { password: 'pw22' } };
    eq(parseLocation('sftp://admin@nas.local:2222/x', creds).password, '', 'not to another port of the same host');
    eq(parseLocation('sftp://admin@nas.local/x', creds).password, 'pw22', 'still to port 22');
    eq(parseLocation('sftp://admin@nas.local:2222/x', { 'admin@nas.local:2222': { password: 'pw2222' } }).password, 'pw2222',
       'and to the port it was saved for');
  }

  // (s3) A crafted .syncto.db no longer exhausts memory.
  {
    const zlib = require('zlib');
    const { dir } = scratch();
    const body = '{"format":"syncto-db","sessions":{"x":{"items":[' + '{},'.repeat(20e6) + '{}]}}}';
    fs.writeFileSync(path.join(dir, '.syncto.db'), zlib.gzipSync(body, { level: 9 }));
    let damaged = '';
    const r = await dbMod.readDb(new NativeFs(), dir, m => { damaged = m; });
    eq(r, null, 'a file that expands far more than a database is refused');
    ok(/damaged/.test(damaged), 'and reported as damaged');
    let noise = '';
    for (let i = 0; i < 160000; i++) noise += '{"a":"' + Math.random().toString(36).slice(2, 8) + '"},';
    fs.writeFileSync(path.join(dir, '.syncto.db'), zlib.gzipSync('{"format":"syncto-db","sessions":{"x":{"items":[' + noise + '{}]}}}'));
    damaged = '';
    const r2 = await dbMod.readDb(new NativeFs(), dir, m => { damaged = m; });
    ok(r2 === null && /structure/.test(damaged), 'so is one made of far more objects than a database holds');
    const big = {}; for (let i = 0; i < 20000; i++) big['A001/C' + i + '.MXF'] = { t: 'f', v: 'timeSize', lm: 1e12 + i, ls: 1e6 + i, rm: 1e12 + i, rs: 1e6 + i, sy: 1 };
    await dbMod.writeDb(new NativeFs(), dir, { format: 'syncto-db', version: 1, sessions: { x: { items: big } } });
    const r3 = await dbMod.readDb(new NativeFs(), dir);
    eq(r3 && Object.keys(r3.sessions.x.items).length, 20000, 'a real database still reads');
  }

  // (s4) A symbolic link planted in the destination: nothing is written
  //      through it, outside the chosen folder.
  {
    const { dir, L, R } = scratch();
    const OUT = path.join(dir, 'OUTSIDE'); fs.mkdirSync(OUT);
    write(L, 'sub/pwned.txt', 'x');
    fs.symlinkSync(OUT, path.join(R, 'sub'));
    const r = await runPair(makeJob(L, R, { sync: { variant: 'mirror' } }));
    eq(fs.readdirSync(OUT), [], 'nothing lands outside the destination');
    ok(r.run.errors.some(e => /is a link on this side/.test(e.message)), 'and the link is reported');
  }

  // (s5) Environment variables are not expanded in a server address.
  {
    const { parseLocation } = require('../src/main/fs/afs');
    process.env.SYNCTO_TEST_SECRET = 'leaked';
    eq(parseLocation('sftp://u@%SYNCTO_TEST_SECRET%.example.org/%SYNCTO_TEST_SECRET%').host,
       '%SYNCTO_TEST_SECRET%.example.org', 'not in the host');
    ok(!/leaked/.test(parseLocation('sftp://u@h/%SYNCTO_TEST_SECRET%').path), 'nor in the remote path');
    eq(parseLocation('/tmp/%SYNCTO_TEST_SECRET%').path, '/tmp/leaked', 'local paths keep them');
    delete process.env.SYNCTO_TEST_SECRET;
  }

  // (s6) "Reveal" shows, never opens; the open-path channel is gone.
  {
    const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
    const pre  = fs.readFileSync(path.join(root, 'src/main/preload.js'), 'utf8');
    ok(!/'open-path'/.test(pre) && !/ipcMain\.handle\('open-path'/.test(main), 'no channel opens a path any more');
    ok(/if \(r\.fallback\) \{ shell\.showItemInFolder\(r\.fallback\);/.test(main), 'reveal falls back to showing the folder');
  }

  // (s8) Files named like built-in properties synchronize in 2 WAYS.
  {
    const { L, R } = scratch();
    const names = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty'];
    write(L, 'seed.txt', 'a database exists before these names appear');
    const job = makeJob(L, R, { sync: { variant: 'twoWay' } });
    await runPair(job);
    for (const n of names) write(L, n, n);
    const s = new Session(); const cmp = await s.compare(job, { token: {} }); await s.close();
    eq(cmp.stats.conflicts, 0, 'no conflict for constructor, __proto__ and friends');
    await runPair(job);
    ok(names.every(n => exists(R, n)), 'and they are all copied');
    const s2 = new Session(); const cmp2 = await s2.compare(job, { token: {} }); await s2.close();
    eq(cmp2.stats.filesToProcess + cmp2.stats.conflicts, 0, 'and stay in sync at the next run');
  }

  // (s9) A checksum list is read up to a sane size.
  {
    const { readText } = require('../src/main/core/session');
    const fake = { stat: async () => ({ type: 'file', size: 4 * 1024 * 1024 * 1024 }), createReadStream: () => { throw new Error('read'); } };
    let err = null;
    try { await readText(fake, '/x/syncto-checksums.txt'); } catch (e) { err = e; }
    ok(err && /larger than/.test(err.message), 'a 4 GB "checksum list" is not read');
  }

  // ── Second pass (verification of the fixes above) ──────────────────────────
  // (v1) A move does not go through a link planted in the destination either.
  for (const variant of ['mirror', 'twoWay']) {
    const { dir, L, R } = scratch();
    const OUT = path.join(dir, 'outside'); fs.mkdirSync(OUT);
    write(L, 'old/clip.mov', Buffer.alloc(8192, 7), Date.now() - DAY);
    const job = makeJob(L, R, { sync: { variant } });
    await runPair(job);
    fs.symlinkSync(OUT, path.join(R, 'newdir'));
    fs.mkdirSync(path.join(L, 'newdir'));
    fs.renameSync(path.join(L, 'old/clip.mov'), path.join(L, 'newdir/clip.mov'));
    await runPair(job);
    eq(fs.readdirSync(OUT), [], `${variant}: a moved file is not renamed into a link's target`);
    ok(exists(R, 'old/clip.mov'), `${variant}: the backup copy stays where it was`);
  }

  // (v2) Nested or overlapping pairs: a target another pair has just written,
  //      identical to the source, is done — not "a file appeared".
  {
    const { L, R } = scratch();
    const T = Date.now() - DAY;
    write(L, 'top.txt', 'top', T); write(L, 'sub/a.mov', 'aaaa', T); write(L, 'sub/b.mov', 'bbbb', T);
    const job = twoPairJob([{ left: path.join(L, 'sub'), right: path.join(R, 'sub') }, { left: L, right: R }], 'mirror');
    const a = await multiRun(job);
    eq(a.res.errors.map(e => e.message), [], 'no error when the overlap has already written the file');
    ok(a.res.notes.some(n => /already at the destination/.test(n)), 'it is said in a note');
    eq(read(R, 'sub/a.mov'), 'aaaa', 'and the file is there');
  }

  // (v3) A FAT drive read across a daylight-saving change: the same file, one
  //      hour apart, is not "changed since the comparison".
  {
    const { L, R } = scratch();
    write(L, 'a.txt', 'new from L');
    write(R, 'a.txt', 'old', Date.now() - DAY);
    const job = makeJob(L, R, { sync: { variant: 'mirror' } });
    const s = new Session();
    await s.compare(job, { token: {} });
    const p = path.join(R, 'a.txt'); const st = fs.statSync(p);
    fs.utimesSync(p, st.atime, new Date(st.mtimeMs + 3600000));
    const run = await s.sync(job, { token: {}, appVersion: 'test' });
    await s.close();
    eq(read(R, 'a.txt'), 'new from L', 'a one-hour shift is the same file: it is replaced as planned');
    eq(run.errors.length, 0, 'without error');
  }

  // (v4) Two lanes asking at once share one trash probe.
  {
    const { SyncRunner } = require('../src/main/core/sync');
    const { dir } = scratch();
    const nfs = new NativeFs(); let probes = 0;
    const fake = Object.create(SyncRunner.prototype);
    fake.side = () => ({ fs: nfs, path: dir });
    fake.trashItem = async (f, p) => { probes++; await new Promise(r => setTimeout(r, 5)); try { fs.unlinkSync(p); return true; } catch (_) { return false; } };
    const r = await Promise.all([fake.trashWorks('left'), fake.trashWorks('left')]);
    eq(r, [true, true], 'both get the same answer');
    eq(probes, 1, 'from a single probe');
  }

  // (v5) An unreadable item blocks only when it matters.
  {
    const { L, R } = scratch();
    write(L, 'clip.mov', 'precious', Date.now() - DAY); write(L, '.DS_Store', 'x'); write(L, 'scratch.tmp', 't');
    const job = makeJob(L, R, { sync: { variant: 'mirror' }, compare: { excludeFilter: '*.tmp' } });
    await runPair(job);
    const orig = fs.promises.lstat;
    fs.promises.lstat = async p => {
      if (/(\.DS_Store|scratch\.tmp)$/.test(String(p))) { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; }
      return orig(p);
    };
    let cmp;
    try { const s = new Session(); cmp = await s.compare(job, { token: {} }); await s.close(); }
    finally { fs.promises.lstat = orig; }
    eq(cmp.errors.filter(e => e.fatal).length, 0, 'an unreadable .DS_Store or filtered file does not block the run');
  }

  // (v6) A pair that fails as a whole still lets the TOTAL ring end at 100 %.
  {
    const { dir, L, R } = scratch();
    write(L, 'a.bin', Buffer.alloc(1 << 20, 1));
    const L2 = path.join(dir, 'L2'), R2 = path.join(dir, 'R2'); fs.mkdirSync(L2); fs.mkdirSync(R2);
    write(L2, 'b.bin', Buffer.alloc(1 << 20, 2));
    const job = twoPairJob([{ left: L, right: R }, { left: L2, right: R2 }], 'mirror');
    const m = new MultiSession(); const token = { cancelled: false };
    await m.compare(job, { token });
    const s2 = m.sessions[1]; const orig = s2.sync.bind(s2);
    s2.sync = async () => { throw new Error('the server went away'); };
    let last = null;
    await m.sync(job, { token, onProgress: p => { if (p.phase === 'sync' && p.bytesTotal) last = p; } });
    s2.sync = orig; await m.close();
    ok(last && Math.abs(last.bytesDone - last.bytesTotal) < 1, 'the total ends at 100 % even when a pair failed');
  }

  // (v7) A real database that compresses very well (an image sequence on a
  //      server: no file ids, identical dates) still loads.
  {
    const { dir } = scratch();
    const items = {};
    for (let i = 0; i < 60000; i++) items['SEQ/frame_' + String(i).padStart(7, '0') + '.exr'] = { t: 'f', v: 'timeSize', lm: 1.7e12, ls: 52428800, rm: 1.7e12, rs: 52428800, sy: 1 };
    await dbMod.writeDb(new NativeFs(), dir, { format: 'syncto-db', version: 1, sessions: { x: { items } } });
    const r = await dbMod.readDb(new NativeFs(), dir);
    eq(r && Object.keys(r.sessions.x.items).length, 60000, 'an image-sequence database is not mistaken for a crafted one');
  }

  // ── Interface ──────────────────────────────────────────────────────────────
  {
    const app  = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
    const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
    const fnBody = name => { const i = app.indexOf(name); return i < 0 ? '' : app.slice(i, app.indexOf('\n}\n', i)); };
    const prog = app.slice(app.indexOf('API.onSyncProgress('), app.indexOf('// ── The passes of a run'));

    // (u1) The last event of a run (locks being released) carries no figures:
    //      it no longer resets the strip to 0 %, "undefined / undefined".
    ok(/if \(p\.bytesTotal == null && p\.itemsTotal == null && p\.filesTotal == null\) \{[\s\S]{0,400}return;\s*\}/.test(prog),
       'a status-only event updates the line and the title, nothing else');
    ok(/renderSteps\(p\.pass, state\.lastWillVerify\)/.test(prog) && /if \(p\.willVerify != null\) state\.lastWillVerify = p\.willVerify;/.test(prog),
       'and does not bring back a "Verify" step on a run without read-back');
    ok(/p\.pass === 'cleanup' \? 100/.test(prog), 'the pass ring is full during the final tidy-up');

    // (u2) Auto-sync shares the start of a run with the manual path.
    const runUi = fnBody('function startRunUi(');
    ok(/setStatLabels\('Files', 'Left to copy', 'Speed', 'Total ETA'\)/.test(runUi) &&
       /s-del-box/.test(runUi) && /classList\.remove\('spin'\)/.test(runUi), 'one start for every run: labels, Removed tile, no spinning ring');
    const auto = fnBody('async function autoRun(');
    ok(/startRunUi\(/.test(auto) && /startCompareUi\(/.test(auto), 'auto-sync uses it, and the shared comparison start too');
    ok(/startRunUi\(/.test(fnBody('async function doSync(')), 'and so does the manual run');

    // (u3) Nothing changes the job or starts something during a run.
    ok(/if \(state\.busy && m\.action !== 'job-save' && m\.action !== 'job-save-as'\) return;/.test(app),
       'the menu and its shortcuts are inert during a run, Save excepted');
    ok(/case 'sync': if \(state\.stats && !\$\('btn-sync'\)\.disabled\) askConfirm\(\)/.test(app), 'F9 does what the button can do, no more');
    for (const f of ['function swapAllPairs(', 'async function newJob(', 'async function openJob(', 'async function openRecent('])
      ok(/if \(state\.busy\) return;/.test(fnBody(f).slice(0, 200)), `${f.replace(/^(async )?function /, '').replace('(', '')} refuses during a run`);
    ok(/if \(e\.key !== ' '\) return;\s*if \(state\.busy\) return;/.test(app), 'Space too');

    // (u4) A comparison always starts from 0 %.
    const cmpUi = fnBody('function startCompareUi(');
    ok(/resetCompareProgress\(\)/.test(cmpUi), 'every comparison resets its progress (CHECKING started at 99 %)');
    ok(/startCompareUi\('CHECKING'\)/.test(fnBody('async function doCompareQuiet(')), 'the check after a run included');

    // (u5) PAUSED is not undone by a late event.
    ok(/const paused = !!\(p\.paused \|\| state\.paused\);/.test(prog), 'the pause button is the authority on PAUSED');

    // (u6) An error card does not keep the previous "Compared again" line.
    ok(/setRecheck\(null\)/.test(fnBody('function showError(')), 'showError clears it');

    // (u7) The confirmation does not say "trash" and "no trash" for the same items.
    ok(/except in the folders below, which have none/.test(app), 'the trash line is corrected when a folder has none');

    // (u8) Charter: disabled buttons look disabled, conflicts are orange,
    //      ERRORS is red only when there is one, the top bar uses charter colours.
    ok(/\.m-btn:disabled,\.m-btn:disabled:hover\{opacity:\.42;/.test(html), 'a disabled button is dimmed');
    ok(/\.arr-cfl\{color:var\(--orange\);\}/.test(html) && /chip\('o', 'conflicts'/.test(app), 'conflicts are orange, in the grid and in their chip');
    ok(/\.sval\.serr\.zero\{color:var\(--text\);\}/.test(html) && /classList\.toggle\('zero', !p\.errors\)/.test(prog), 'ERRORS is red only above zero');
    ok(!/#00ffaa|#7bc8ff/.test(app), 'no off-charter colour in the run strip');
    ok(/prefers-reduced-motion:reduce\)\{\s*\.ring-fill\.spin\{animation:none;\}\s*\.tbtn\.stop\{animation:none;\}/.test(html),
       '"reduce motion" stops the spinning ring and CANCEL\'s glow');

    // (u9) Counts: separators, and short forms in the narrow Overview column.
    const fc = new Function(fnBody('function fmtCount(') + '\n}\nreturn fmtCount;')();
    eq([fc(12345), fc(123456), fc(1234567), fc(123456, true)], ['12,345', '123k', '1.2M', '123,456'], 'counts read 12,345 / 123k / 1.2M');
    ok(/<div class="ov-items" data-tip="\$\{g\.items\.toLocaleString\('en-US'\)\} items">\$\{fmtCount\(g\.items\)\}<\/div>/.test(app),
       'the Overview shows the short form, the exact count on hover');

    // (u10) Escape leaves the Filter window without applying.
    ok(/'ov-filter'  : cancelFilter,/.test(app) && /if \(typeof ESC_CLOSE\[ov\.id\] === 'function'\) \{ ESC_CLOSE\[ov\.id\]\(\); continue; \}/.test(app) &&
       !/'ov-filter' : 'filter-close'/.test(app) && /\$\('ov-filter'\)\.classList\.remove\('open'\);/.test(fnBody('function cancelFilter(')),
       'Escape in Filter restores the patterns and closes, no comparison, wherever the focus is');

    // (u11) The verify ring starts in its own colour.
    ok(/\$\('vf-ring'\)\.style\.stroke = '';/.test(fnBody('async function doVerify(')), 'not the previous result\'s');

    // (u12) Waiting for a lock: one word, in capitals.
    const rt = new Function('return ' + fnBody('function runTitle(') + '\n}')();
    eq(rt('lock', false), 'WAITING', 'the lock wait says WAITING');
    ok(/state\.runPass = 'lock';/.test(prog), 'and pausing then resuming keeps saying it');

    // (u13) Mode names as on the buttons; the server port keeps its width;
    //       short windows keep the strip whole.
    ok(/twoWay: '2 WAYS', mirror: 'MIRROR', update: 'UPDATE', custom: 'CUSTOM'/.test(app), 'mode names as on the buttons');
    ok(/\.set-row \.srv-row2 input\.portx\{flex:0 0 82px;width:82px;\}/.test(html), 'the port field is narrow again');
    ok(/@media \(max-height:760px\)\{\s*#app\.running #toolbar\{display:none;\}/.test(html), 'a short window gives the locked toolbar\'s room to the run');
  }

  // (a1) While auto-sync is armed, the end-of-run action never fires (asked
  //      by Noar on 11/10/2026): skipped, said, auto-sync left on. Checked
  //      by running afterRun itself with the DOM and the API stubbed.
  {
    const appSrc = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8').replace(/\u0000/g, '');
    const at = appSrc.indexOf('async function afterRun(');
    const src = appSrc.slice(at, appSrc.indexOf('\n}\n', at));
    const make = (auto, afterSync) => {
      const calls = [], els = {};
      const $ = id => (els[id] = els[id] || { textContent: '' });
      const state = { job: { name: 'j', sync: { afterSync }, autoSync: { enabled: auto } } };
      const f = new Function('state', '$', 'API', 'isAutoOn', 'runWasClean', 'startAfterCountdown', 'autoStop', 'renderAutoUi', 'persist',
        src.replace(/^async function afterRun\(/, 'return async function(') + '\n}');
      const run = f(state, $, { ntfyRun: () => Promise.resolve({ ok: true }) },
        () => state.job.autoSync.enabled, () => true,
        a => calls.push('countdown:' + a), () => calls.push('autoStop'), () => {}, () => calls.push('persist'));
      return { run, calls, els, state };
    };
    let t = make(true, 'shutdown');
    await t.run({ errors: [], counters: {} });
    eq(t.calls, [], 'auto-sync on: no countdown, auto-sync not stopped');
    ok(t.state.job.autoSync.enabled === true, 'auto-sync stays armed');
    ok(/Shut down.*was skipped: auto-sync is on\./.test(t.els['status-note'].textContent), 'the status line says why');
    t = make(false, 'shutdown');
    await t.run({ errors: [], counters: {} });
    eq(t.calls, ['countdown:shutdown'], 'auto-sync off: the countdown starts as before');
  }

  // ── Electron 44 (0.8.8) ──────────────────────────────────────────────────
  {
    const root = path.join(__dirname, '..');
    const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
    const yml  = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
    const pkg  = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const major = parseInt(String(pkg.devDependencies.electron).replace(/^[^0-9]*/, ''), 10);

    // (x1) Since Electron 44, clipboard.writeText returns a promise: not
    //      awaited, a refusal escapes the try and the window says "copied".
    ok(/ipcMain\.handle\('copy-text', async \(/.test(main) && /await clipboard\.writeText\(s\)/.test(main),
       'the copy waits for the clipboard and reports a refusal');

    // (x2) The Mac floor follows Electron: 44 needs macOS 13. A lower
    //      minimumSystemVersion lets an older Mac install an app that cannot start.
    const minMac = (yml.match(/minimumSystemVersion:\s*"(\d+)/) || [])[1];
    ok(major >= 44, 'Electron 44 or later');
    eq(minMac, major >= 44 ? '13' : minMac, 'the .dmg asks for macOS 13, as Electron 44 does');
  }
}


// ══ 52. Audit of 13/10/2026 ═════════════════════════════════════════════════
// A full review of 0.8.9 (engine, security, window, speed). Every defect it
// confirmed and Noar asked to fix (lots A to D) has its check here. Run alone:
//   SYNCTO_ONLY=testAudit1013 node test/run-tests.js
async function testAudit1013() {
  console.log('\n\n52. Audit of 13/10/2026 (0.9.0)');
  const root = path.join(__dirname, '..');
  const app  = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8').replace(/\u0000/g, '');
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
  const files = base => listAll(base).filter(f => !f.endsWith('/') && !f.includes('.syncto.') && !f.endsWith('syncto-checksums.txt'));
  const fnBody = name => {
    const i = app.indexOf(name);
    if (i < 0) return '';
    const open = app.indexOf('{', i);
    let depth = 0;
    for (let k = open; k < app.length; k++) {
      if (app[k] === '{') depth++;
      else if (app[k] === '}' && --depth === 0) return app.slice(i, k + 1);
    }
    return app.slice(i);
  };

  // ── Lot A: data loss and security ─────────────────────────────────────────

  // (a1) VERIFY sits in the modes row without being a mode: clicking it set
  //      the mode to undefined, read as MIRROR by the engine and the job file.
  {
    const h = app.slice(app.indexOf("$('syncmodes').addEventListener('click'"));
    ok(/if \(!b \|\| !b\.dataset\.v \|\| state\.busy\) return;/.test(h.slice(0, 600)),
       'a button of the modes row without a mode (VERIFY) leaves the mode alone');
    ok(/<button class="mbtn" id="btn-verify"(?![^>]*data-v)/.test(html), 'and VERIFY indeed has none');
  }

  // (a2) Changing the mode or a comparison setting after a comparison: the
  //      engine refuses the old plan, the window drops it.
  {
    const { planKeyOf } = require('../src/main/core/session');
    const { L, R } = scratch();
    write(L, 'a.txt', 'a'); write(R, 'old.txt', 'old');
    const job = makeJob(L, R, { sync: { variant: 'mirror' } });
    job.pairs = [{ left: L, right: R }];
    const m = new MultiSession();
    await m.compare(job, { token: {} });
    const upd = JSON.parse(JSON.stringify(job)); upd.sync.variant = 'update';
    let err = null;
    try { await m.sync(upd, { token: {} }); } catch (e) { err = e; }
    ok(err && /mode or a comparison setting changed/.test(err.message), 'MIRROR compared, UPDATE asked: the engine refuses');
    ok(exists(R, 'old.txt'), 'and nothing was deleted');
    const filt = JSON.parse(JSON.stringify(job)); filt.compare.excludeFilter = '*.txt';
    ok(planKeyOf(filt) !== planKeyOf(job), 'a filter change is a plan change');
    const deletion = JSON.parse(JSON.stringify(job)); deletion.sync.deletion = 'recycler'; deletion.sync.retryCount = 5;
    eq(planKeyOf(deletion), planKeyOf(job), 'how deletions are done or retried is not');
    const shuffled = JSON.parse(JSON.stringify(job));
    shuffled.compare = Object.fromEntries(Object.entries(job.compare).reverse());
    eq(planKeyOf(shuffled), planKeyOf(job), 'the order of the keys does not matter');
    const run = await m.sync(job, { token: {} });
    eq(run.errors.length, 0, 'the same settings run');
    ok(!exists(R, 'old.txt'), 'and run the plan that was shown');
    await m.close();

    ok(fnBody('function planKeyOf(job)').replace(/\s+/g, ' ') ===
       fs.readFileSync(path.join(root, 'src/main/core/session.js'), 'utf8').slice(
         fs.readFileSync(path.join(root, 'src/main/core/session.js'), 'utf8').indexOf('function planKeyOf(job)')).replace(/\s+/g, ' ')
         .slice(0, fnBody('function planKeyOf(job)').replace(/\s+/g, ' ').length),
       'the window and the engine use the same list of settings');
    const cmp = fnBody('async function doCompare()');
    ok(cmp.indexOf('const comparedPlan  = planKeyOf(state.job);') < cmp.indexOf('API.compare(state.job)') &&
       cmp.indexOf('const comparedPairs = pairsKey(completePairs());') < cmp.indexOf('API.compare(state.job)') &&
       cmp.indexOf('API.compare(state.job)') > 0 &&
       /state\.comparedPlan  = comparedPlan;/.test(cmp),
       'the window records what was compared BEFORE the comparison, not after');
    ok(/invalidateIfPlanChanged\(\);\s*persist\(\);\s*\}\);\s*\$\('syncmodes'\)/.test(app) &&
       /setVariantBtn\(b\.dataset\.v\);\s*invalidateIfPlanChanged\(\);/.test(app),
       'a click on a mode or a comparison method drops a plan made with the other');
    ok(/\$\('ov-settings'\)\.addEventListener\('change'/.test(app) && /PLAN_INPUTS\.includes\(t\.id\) \|\| t\.matches\('select\.cust'\)/.test(app),
       'so does a change of move detection, date repair, filters or custom directions');
    ok(/function askConfirm\(\) \{\s*uiToJob\(\);[\s\S]{0,120}if \(invalidateIfPlanChanged\(\)\) return;/.test(app),
       'and the confirmation checks once more');
  }

  // (a3) During a comparison or a run, the controls that shape the plan are
  //      out of reach of the keyboard too (inert), not only of the mouse.
  {
    const busy = fnBody('function setBusyUi(on, title, steps)');
    ok(/lockPlan\(!!on, !!\(on && steps\)\);/.test(busy), 'every busy state locks the plan');
    const lock = fnBody('function lockPlan(on, run)');
    ok(/el\.inert = !!on/.test(lock) && /sb\.inert = !!run/.test(lock) && /el\.disabled = !!on/.test(lock),
       'modes, folders, method, filter and auto-sync are inert, the jobs list during a run, the plan settings disabled');
    eq(app.match(/const PLAN_REGIONS = \[([^\]]*)\]/)[1].split(',').map(s => s.trim().replace(/'/g, '')),
       ['syncmodes', 'pairwrap', 'pair-add-row', 'seg-cmp', 'btn-filter'], 'the regions locked');
    for (const id of app.match(/const PLAN_INPUTS  = \[([^\]]*)\]/)[1].split(',').map(s => s.trim().replace(/'/g, ''))) {
      ok(html.includes(`id="${id}"`), `the plan setting ${id} exists`);
    }
  }

  // (a4) Windows-safe names: a filter written with the real name still applies.
  for (const mode of ['destination', 'both']) {
    const { L, R } = scratch();
    write(L, 'Keep/ok.txt', 'ok');
    write(R, 'Archive: old/precious.txt', 'precious');
    write(L, 'Forum: Day 1/draft?.txt', 'draft');
    const r = await runPair(makeJob(L, R, { sync: { variant: 'mirror', safeNames: mode },
      compare: { excludeFilter: '/Archive: old/\ndraft?.txt' } }));
    eq(r.run.errors.length, 0, `${mode}: no error`);
    ok(exists(R, 'Archive: old/precious.txt'), `${mode}: an exclusion written with the real name protects the folder from MIRROR`);
    ok(!exists(R, 'Forum_ Day 1/draft_.txt'), `${mode}: and a file excluded by its real name is not copied`);
    ok(exists(R, 'Keep/ok.txt'), `${mode}: the rest is synchronized`);
  }
  {
    const { L, R } = scratch();
    write(R, 'Archive: old/precious.txt', 'precious');
    await runPair(makeJob(L, R, { sync: { variant: 'mirror', safeNames: 'destination' }, compare: { excludeFilter: '/Archive_ old/' } }));
    ok(exists(R, 'Archive: old/precious.txt'), 'the cleaned spelling still works');
    const { PathFilter } = require('../src/main/core/filter');
    const pf = new PathFilter('/Only: this/', '');
    ok(pf.passFolderAny(['Only_ this', 'Only: this']) && !pf.passFolderAny(['Other', 'Other']),
       'an include written with the real name includes too');
  }

  // (a5) A symbolic link planted under a name syncto writes is never written
  //      through: the file it points at, outside the folders, is untouched.
  if (process.platform !== 'win32') {
    const { dir, L, R } = scratch();
    write(L, 'a.txt', 'hello');
    write(L, 'clip.mov', 'clip');
    const victims = ['db', 'list', 'scratch', 'probe'].map(k => { const p = path.join(dir, 'victim-' + k); fs.writeFileSync(p, 'ORIGINAL'); return p; });
    fs.symlinkSync(victims[0], path.join(R, '.syncto.db.syncto_tmp'));
    fs.symlinkSync(victims[1], path.join(R, 'syncto-checksums.txt'));
    fs.symlinkSync(victims[2], path.join(R, 'clip.mov.syncto_tmp'));
    fs.symlinkSync(victims[3], path.join(R, '.syncto.trash-probe'));
    const job = makeJob(L, R, { sync: { variant: 'mirror', writeChecksumList: true, deletion: 'recycler' } });
    const s = new Session(); const token = { cancelled: false, paused: false };
    const trashItem = async (fsx, p) => { try { fs.unlinkSync(p); return true; } catch (_) { return false; } };
    await s.compare(job, { token });
    await s.preflight(job, { trashItem });
    const run = await s.sync(job, { token, appVersion: 'test', trashItem });
    await s.close();
    eq(victims.map(v => fs.readFileSync(v, 'utf8')), ['ORIGINAL', 'ORIGINAL', 'ORIGINAL', 'ORIGINAL'],
       'the database, the checksum list, a copy and the trash probe never write through a planted link');
    eq(read(R, 'clip.mov'), 'clip', 'the files are copied all the same');
    ok(fs.lstatSync(path.join(R, 'syncto-checksums.txt')).isFile() && fs.lstatSync(path.join(R, '.syncto.db')).isFile(),
       'and the list and the database are real files in the folder');
    ok(run.notes.some(m => /link found under syncto's temporary names/.test(m)), 'the removed link is mentioned');
    // And the native layer itself refuses to open a link for writing.
    const { NativeFs } = require('../src/main/fs/native');
    const lp = path.join(dir, 'link-out');
    fs.symlinkSync(victims[0], lp);
    const e = await new Promise(res => { const ws = new NativeFs().createWriteStream(lp); ws.on('error', res); ws.on('finish', () => res(null)); ws.end('x'); });
    ok(e && e.code === 'ELOOP' && fs.readFileSync(victims[0], 'utf8') === 'ORIGINAL', 'opening a link for writing fails (O_NOFOLLOW)');
  }

  // (a6) A detected move does not overwrite a file that appeared at its new
  //      name since the comparison.
  {
    const { L, R } = scratch();
    write(L, 'P.txt', 'big clip');
    const job = makeJob(L, R, { sync: { variant: 'mirror' } });
    await runPair(job);
    fs.renameSync(path.join(L, 'P.txt'), path.join(L, 'Q.txt'));
    const s = new Session(); const token = { cancelled: false, paused: false };
    await s.compare(job, { token });
    ok(s.nodes.some(n => n.op === OP.MOVE_RIGHT_TO), 'the rename is detected as a move');
    write(R, 'Q.txt', "somebody else's work");
    const run = await s.sync(job, { token, appVersion: 'test' });
    await s.close();
    eq(read(R, 'Q.txt'), "somebody else's work", 'the file that appeared is not overwritten');
    ok(run.errors.some(e => /appeared at the new name since the comparison/.test(e.message)), 'and the move is reported, not done');
  }

  // (a7) A lock whose date looks old only because the NAS clock is behind is
  //      watched, not taken over at once.
  {
    const { acquireOne, folderNow } = require('../src/main/core/lock');
    const { NativeFs } = require('../src/main/fs/native');
    const SKEW = 3 * 60 * 1000;
    class Behind extends NativeFs {   // a disk whose clock runs 3 minutes behind
      async stat(p) { const st = await super.stat(p); if (st && st.mtime) st.mtime -= SKEW; return st; }
    }
    const nfs = new Behind();
    const { L } = scratch();
    const lp = path.join(L, LOCK_NAME);
    fs.writeFileSync(lp, JSON.stringify({ format: 'syncto-lock', version: 1, lockId: 'f'.repeat(32), installId: '0'.repeat(32),
      computerName: 'OTHER-MAC', userId: 'someone', sessionId: 1, processId: 99999, since: Date.now() }) + '\n');
    const now = await folderNow(nfs, L);
    ok(now && Math.abs(Date.now() - SKEW - now) < 5000, "the disk's own time is read from a probe file");
    ok(!fs.readdirSync(L).some(n => n.startsWith('.syncto.clock-')), 'which is removed');
    const hb = setInterval(() => { try { fs.appendFileSync(lp, ' '); } catch (_) {} }, 500);
    const token = { cancelled: false };
    setTimeout(() => { token.cancelled = true; }, 3000);
    let res;
    try { res = await acquireOne(nfs, L, { token, onStatus: () => {} }); } catch (e) { res = e.message; }
    clearInterval(hb);
    eq(res, 'Cancelled', 'a live lock looking three minutes old (NAS clock behind) is waited for, not taken');
    const old = new Date(Date.now() - 10 * 60 * 1000); fs.utimesSync(lp, old, old);
    const t = Date.now();
    const lock = await acquireOne(nfs, L, {});
    ok(Date.now() - t < 5000, 'one silent for ten minutes by that same clock is still taken at once');
    await lock.release();
  }

  // (a8) Environment variables are not expanded in a network path.
  {
    const { expandMacros } = require('../src/main/fs/afs');
    process.env.SYNCTO_TEST_SECRET = 'tok123';
    process.env.SYNCTO_TEST_SERVER = '\\\\dc1';
    eq(expandMacros('\\\\evil.example\\x\\%SYNCTO_TEST_SECRET%'), '\\\\evil.example\\x\\%SYNCTO_TEST_SECRET%', 'not in \\\\host\\share');
    eq(expandMacros('//evil.example/x/%SYNCTO_TEST_SECRET%'), '//evil.example/x/%SYNCTO_TEST_SECRET%', 'nor in //host/share');
    eq(expandMacros('%SYNCTO_TEST_SERVER%\\share'), '%SYNCTO_TEST_SERVER%\\share', 'nor in a path that would become one');
    eq(expandMacros('/Volumes/%SYNCTO_TEST_SECRET%/x'), '/Volumes/tok123/x', 'a local path still gets them');
    ok(/^\\\\evil\\\d{4}-\d\d-\d\d$/.test(expandMacros('\\\\evil\\%date%')), 'and the date macros work everywhere');
    delete process.env.SYNCTO_TEST_SECRET; delete process.env.SYNCTO_TEST_SERVER;
  }

  // (a9) A password in an address with spaces before it is redacted too.
  {
    const { redactLocation } = require('../src/main/fs/afs');
    eq(redactLocation(' sftp://alice:S3cret@nas.local/backup'), ' sftp://alice@nas.local/backup', 'leading space');
    eq(redactLocation('\tsftp://alice:S3cret@nas.local/backup'), '\tsftp://alice@nas.local/backup', 'leading tab');
    const cfg = fs.readFileSync(path.join(root, 'src/main/config.js'), 'utf8');
    ok(/\/\^\\s\*\(sftp\|ftpes\|ftps\|ftp\):/.test(cfg), 'and the password is moved to the credential store in that case too');
  }
  // ── Lot B: Windows-safe and long names ────────────────────────────────────
  {
    const ln = require('../src/main/fs/longname');
    const saved = ln.limits.name;
    ln.limits.name = 60;
    try {
      // (b1) 2 WAYS: deleting a long-named original deletes its short copy,
      //      instead of bringing it back under the short name.
      {
        const { L, R } = scratch();
        const long = 'Interview of the speaker, full length, colour graded ' + 'f'.repeat(20) + '.mov';
        const short = ln.shorten(long);
        const t = Date.now() - 3600e3;
        write(L, long, 'v1', t); write(L, 'other.txt', 'o', t);
        const job = makeJob(L, R, { sync: { variant: 'twoWay' } });
        await runPair(job);
        ok(exists(R, short), 'the copy is written under the short name');
        await runPair(job);
        fs.unlinkSync(path.join(L, long));
        const r = await runPair(job);
        eq(r.run.errors.length, 0, 'no error');
        ok(!exists(L, short) && !exists(R, short) && !exists(L, long), 'the deletion reaches the short copy, nothing comes back');
        eq(files(R), ['other.txt'], 'the rest stays');
      }
      // (b2) A long name that moves to another folder is a move again.
      {
        const { L, R } = scratch();
        const long = 'Interview of the speaker, full length, colour graded ' + 'g'.repeat(20) + '.mov';
        const t = Date.now() - 3600e3;
        write(L, 'D1/' + long, 'clip', t);
        const job = makeJob(L, R, { sync: { variant: 'mirror' } });
        await runPair(job);
        fs.mkdirSync(path.join(L, 'D2'));
        fs.renameSync(path.join(L, 'D1', long), path.join(L, 'D2', long));
        const r = await runPair(job);
        eq(r.run.counters.moved, 1, 'renamed at the destination, not copied again');
        ok(exists(R, 'D2/' + ln.shorten(long)), 'under its short name');
      }
      // (b3) Destination only, 2 WAYS: a name both long and refused by Windows,
      //      created on the destination, is paired with its copy at the
      //      source at every later run.
      {
        const { L, R } = scratch();
        const name = 'Session: keynote, full length, colour graded ' + 'k'.repeat(20) + '.mov';
        write(R, name, 'v1', Date.now() - 3600e3);
        const job = makeJob(L, R, { sync: { variant: 'twoWay', safeNames: 'destination' } });
        await runPair(job);
        const r = await runPair(job);
        eq([files(L).length, files(R).length], [1, 1], 'one copy on each side');
        ok(r.s.nodes.every(n => n.op === OP.NONE), 'paired: nothing to do at the next run');
        ok(/^Session: /.test(files(L)[0]) && /^Session_ /.test(files(R)[0]), 'the source keeps its spelling, the destination is cleaned');
      }
    } finally { ln.limits.name = saved; }
  }

  // (b4) Two pairs writing to the same destination: the second finds the
  //      rename already done by the first and carries on.
  {
    const { dir } = scratch();
    const L1 = path.join(dir, 'L1'), L2 = path.join(dir, 'L2'), C = path.join(dir, 'C');
    const t = Date.now() - 3600e3;
    write(L1, 'x:y.txt', 'xy', t); write(L2, 'x:y.txt', 'xy', t); write(C, 'x:y.txt', 'xy', t);
    write(L2, 'new from pair 2.txt', 'n', t);
    const job = makeJob('', '', { sync: { variant: 'update', safeNames: 'destination' } });
    job.pairs = [{ left: L1, right: C }, { left: L2, right: C }];
    const ms = new MultiSession();
    await ms.compare(job, { token: {} });
    const run = await ms.sync(job, { token: {} });
    await ms.close();
    eq(run.errors.length, 0, 'no error');
    ok(exists(C, 'new from pair 2.txt') && exists(C, 'x_y.txt'), 'pair 2 ran');
    eq(run.counters.renamed, 2, 'the run counts its renames (one done, one found done)');
    eq(run.notes.filter(m => /Renamed for Windows/.test(m)).length, 1, 'and reports the one it did');
  }

  // (b5) Unticked rows, rows the soft filter leaves out, conflicts and rows
  //      set to "do nothing" are not renamed.
  {
    const { L, R } = scratch();
    const t = Date.now() - 3600e3;
    write(L, 'Big: clip.mov', 'x'.repeat(5000), t); write(R, 'Big: clip.mov', 'x'.repeat(5000), t);
    write(L, 'Unticked: me.txt', 'u'.repeat(20000), t); write(R, 'Unticked: me.txt', 'u'.repeat(20000), t);
    write(L, 'Clash: x', 'file', t); write(R, 'Clash: x/inside.txt', 'f', t);
    write(L, 'Kept: me.txt', 'k'.repeat(20000), t); write(R, 'Kept: me.txt', 'k'.repeat(20000), t);
    const job = makeJob(L, R, { sync: { variant: 'mirror', safeNames: 'both' },
      compare: { softFilter: { sizeMinUnit: 'kb', sizeMin: 10 } } });
    const s = new Session(); const token = { cancelled: false, paused: false };
    await s.compare(job, { token });
    s.setActive([s.nodes.find(n => n.rel === 'Unticked_ me.txt').idx], false);
    eq([s.stats.renameLeft, s.stats.renameRight], [1, 1], 'only the row that takes part is counted, on each side');
    const rows = s.rows(0, 50, {}).rows;
    ok(rows.some(r => r.rel === 'Kept_ me.txt' && r.fx && r.fx.l === 'Kept: me.txt' && r.fx.r === 'Kept: me.txt'),
       'and listed in the grid with the names it replaces, although nothing is copied');
    ok(s.rows(0, 50, { onlyOperation: 'rename' }).rows.every(r => r.fx), 'the rename chip lists exactly those');
    await s.sync(job, { token, appVersion: 'test' });
    await s.close();
    eq(files(L).sort(), ['Big: clip.mov', 'Clash: x', 'Kept_ me.txt', 'Unticked: me.txt'], 'the source: only the row that takes part is renamed');
    eq(files(R).sort(), ['Big: clip.mov', 'Clash: x/inside.txt', 'Kept_ me.txt', 'Unticked: me.txt'], 'the destination: same');
  }
  // A folder left out keeps its name even when a file inside is renamed? No:
  // a folder is renamed when something inside takes part in the run.
  {
    const { L, R } = scratch();
    const t = Date.now() - 3600e3;
    write(L, 'Day: 1/new.txt', 'n', t);
    write(R, 'Day: 1/old.txt', 'o', t); write(L, 'Day: 1/old.txt', 'o', t);
    const r = await runPair(makeJob(L, R, { sync: { variant: 'mirror', safeNames: 'destination' } }));
    eq(r.run.errors.length, 0, 'no error');
    eq(files(R).sort(), ['Day_ 1/new.txt', 'Day_ 1/old.txt'], 'the folder holding work is renamed, its contents follow');
  }

  // (b6) The window: a run stopped by a failed rename says so, notes cut
  //      short say so, renames are counted.
  {
    ok(/res\.stopReason === 'rename' \? 'Stopped — a name could not be changed for Windows'/.test(app), 'the headline names a stop on a rename');
    ok(/const notes = res\.notes\.filter\(isStop\)\.concat/.test(app), 'why it stopped comes first in the notes');
    ok(/more\(notes\.length, 40\)/.test(app) && /more\(res\.errors\.length, 60\)/.test(app), 'a list cut short says how much is missing');
    ok(/\['Renamed for Windows', fmtCount\(res\.counters\.renamed, true\)\]/.test(app), 'the summary counts the renames');
    ok(/chip\('b', 'Windows names', ren, 'rename', 'op'\)/.test(app), 'a chip counts them before the run');
    ok(/if \(c\.renamed\) bits\.push/.test(app), 'and the auto-sync line after it');
    ok(/to change for Windows, nothing to copy or delete/.test(fnBody('function renderEmptyState(res)')) &&
       /to change for Windows, nothing to copy\./.test(app), 'an empty list or overview with renames left does not say "in sync"');
    const { L, R } = scratch();
    write(L, 'a.txt', 'a'); write(L, 'b.txt', 'b');
    const job = makeJob(L, R, { sync: { variant: 'mirror', ignoreErrors: false } });
    job.pairs = [{ left: L, right: R }, { left: L, right: path.join(R, 'second') }];
    const ms = new MultiSession();
    await ms.compare(job, { token: {} });
    fs.unlinkSync(path.join(L, 'a.txt'));     // vanishes between the comparison and the run
    const run = await ms.sync(job, { token: {} });
    await ms.close();
    ok(run.stopped && run.stopReason === 'error', 'a pair that stopped makes the whole run "stopped"');
    ok(!exists(R, 'second/b.txt'), 'and with "Continue on error" off the next pair is not started');
  }

  // ── Lot C: the window, and what it is told ────────────────────────────────
  {
    // (c1) Many pairs scroll inside their card.
    ok(/#pairwrap\{max-height:28vh;overflow-y:auto;min-height:0;\}/.test(html), 'the pairs scroll, the buttons below stay in the window');
    // (c2) The scroll bars of the Errors and Notes panels are drawn.
    ok(!/scrollbar-track-track|scrollbar-thumb-thumb|:hover-thumb:hover/.test(html), 'no mangled scroll-bar selector left');
    ok(/\.err-body::-webkit-scrollbar-thumb\{background:#454956/.test(html), 'the panels get the same thumb as every list');
    // (c3) A failed call does not freeze the window; auto-sync stops on CANCEL.
    ok(!/await API\.(compare|sync)\(state\.job\)/.test(app), 'every comparison and run goes through ipc()');
    ok(/async function ipc\(promise\) \{\s*try \{ return await promise; \}\s*catch \(err\) \{ return \{ ok: false/.test(app), 'which turns a failed call into a failure');
    const auto = fnBody('async function autoRun()');
    ok(/if \(cmp\.cancelled\) \{[\s\S]{0,300}comparison cancelled — nothing synchronized/.test(auto) &&
       auto.indexOf('if (cmp.cancelled)') < auto.indexOf("state.busy = 'sync';"), 'auto-sync ends its cycle when its comparison is cancelled');
    ok(/state\.comparedPlan  = comparedPlan;/.test(auto), 'and records what it compared, like a manual comparison');
    const quiet = fnBody('async function doCompareQuiet()');
    ok(/if \(res && res\.cancelled\) \{[\s\S]{0,200}setRecheck\(null\);/.test(quiet), 'stopping the check after a run is not reported as a failure');
    // (c4) Tooltips go when their row is redrawn.
    const tips = fnBody('function installTooltips()');
    ok(/!owner\.isConnected/.test(tips) && /addEventListener\('scroll', drop, true\)/.test(tips), 'a tooltip does not outlive its row');
    // (c5) Thousands separators everywhere.
    ok(/<b>\$\{fmtCount\(value, true\)\}<\/b>/.test(app), 'in the chips');
    ok(/fmtCount\(r\.todo, true\) \+ ' to process'/.test(app), 'in the pair headers');
    ok(/\$\{fmtCount\(p\.filesDone, true\)\}<span class="stot"> \/ \$\{fmtCount\(p\.filesTotal, true\)\}/.test(app), 'in the run tiles');
    eq((app.match(/<div class="sr-val">\$\{v\}<\/div>/g) || []).length, 0, 'in the confirmation, summary and verify grids');
    ok(!/\.toLocaleString\(\)/.test(app.replace(/new Date\(\)\.toLocaleString\(\)/g, '')), 'always in one format, whatever the system language');
    // (c6) Right-to-left names do not reverse "A → B".
    ok(/function bidiLabel\(s\)[\s\S]{0,160}\\u2068' \+ x \+ '\\u2069/.test(app) &&
       (app.match(/bidiLabel\(/g) || []).length >= 5, 'each side of a pair label is isolated');
    // (c7) Words: Source / Destination, and the setting's own name.
    ok(/leftOnly: 'source only', rightOnly: 'destination only'/.test(app), 'the row tooltips say source and destination');
    ok(/"Continue on error" is off/.test(fs.readFileSync(path.join(root, 'src/main/core/sync.js'), 'utf8')), 'the stop note names the setting');
    ok(/\['Windows names', renames\]/.test(app), 'the confirmation tile no longer reads like "Move (rename)"');
    // (c8) Shortcuts in the tooltips, as Windows writes them.
    ok(/replace\(\/⇧⌘\/g, 'Ctrl\+Shift\+'\)\.replace\(\/⌘\/g, 'Ctrl\+'\)/.test(app), '⌘ becomes Ctrl+ off a Mac');
    // (c9) The charter.
    ok(/\.srv-status\.busy\{background:var\(--blue-d\)/.test(html), 'connecting is blue');
    ok(/\.ctx-it \.ko\.skip\{color:var\(--text2\);\}/.test(html) && /const CTX_KO = '<svg class="ko skip"/.test(app), 'excluding is not red');
    ok(!/\.ov-pct \.bar\{[^}]*53,201,139/.test(html), 'a share of size is not green');
    ok(/#ov-auto \.err-item,#sum-errors-body \.err-item,#sum-notes-body \.err-item,#footer \.fc#footer-auto\{font-family:var\(--font\);\}/.test(html),
       'sentences in the text font');
    // (c10) A window that opens takes the focus.
    ok(/installOverlayFocus\(\);/.test(app) && /new MutationObserver/.test(fnBody('function installOverlayFocus()')), 'focus goes into an overlay and stays there');
    // (c11) The lock countdown is shown while leftovers are checked.
    ok(/API\.onLockProgress\(st =>/.test(fnBody('async function clearStaleLocksNow()')), 'the lock badge counts down');
    ok(!/takeMigrationNotes/.test(fs.readFileSync(path.join(root, 'src/main/preload.js'), 'utf8')), 'the bridge has no call without a handler');
    // (c12) Dead rules gone, the short-window block not repeated.
    ok(!/\.rl-more\{|\.rl-btn\.use\{|\.sum-verify\.plain|\n\.chk\{/.test(html), 'unused styles removed');
    const first = html.slice(html.indexOf('@media (max-height:760px){'), html.indexOf('}\n', html.indexOf('@media (max-height:760px){') + 30));
    ok(!/pb-pct-ring|ring-txt|pb-title/.test(first.slice(0, first.indexOf('.pb-stats'))), 'the first short-window block no longer sets what the second overrides');
  }

  // (c13) The checksum list follows a rename for Windows, and names with a
  //       line break are escaped.
  {
    const { verifyFolder } = require('../src/main/core/session');
    const { FsPool } = require('../src/main/fs/afs');
    const { L, R } = scratch();
    const t = Date.now() - 3600e3;
    write(L, 'Forum: Day 1/clip?.mov', 'clip', t);
    const job = makeJob(L, R, { sync: { variant: 'mirror', writeChecksumList: true } });
    await runPair(job);
    ok(/  Forum: Day 1\/clip\?\.mov/.test(read(R, 'syncto-checksums.txt')), 'the list names the file');
    job.sync.safeNames = 'destination';
    await runPair(job);
    const list = read(R, 'syncto-checksums.txt');
    ok(/  Forum_ Day 1\/clip_\.mov/.test(list) && !/Forum: Day 1/.test(list), 'after the rename, under its new name only');
    const pool = new FsPool();
    const v = await verifyFolder(pool, R, { token: {} });
    await pool.closeAll();
    eq([v.missing, v.mismatched], [0, 0], 'and Verify Folder finds it intact');
    const { formatChecksumList, parseChecksumList } = require('../src/main/core/hash');
    const entries = [{ hash: 'ab', rel: 'd/Icon\r' }, { hash: 'cd', rel: 'a\\b' }, { hash: 'ef', rel: 'two\nlines' }, { hash: '01', rel: 'plain.txt' }];
    const txt = formatChecksumList('xxh64', entries, {});
    ok(txt.includes('\\ab  d/Icon\\r') && txt.includes('01  plain.txt'), 'a name with a line break is escaped as md5sum does');
    eq(parseChecksumList(txt).entries, entries, 'and read back exactly');
  }

  // (c14) A temporary file left inside a folder renamed in the same run is
  //       swept in that run.
  {
    const { L, R } = scratch();
    const t = Date.now() - 3600e3;
    write(L, 'Day: 1/a.mov', 'a', t); write(R, 'Day: 1/a.mov', 'a', t);
    write(R, 'Day: 1/b.mov.syncto_tmp', 'half a copy');
    await runPair(makeJob(L, R, { sync: { variant: 'mirror', safeNames: 'destination' } }));
    eq(listAll(R).filter(f => !f.includes('.syncto.')), ['Day_ 1/', 'Day_ 1/a.mov'], 'no leftover under the new name');
  }

  // ── Lot D: speed, without touching how files are read or written ──────────
  {
    const sync = fs.readFileSync(path.join(root, 'src/main/core/sync.js'), 'utf8');
    // (d1) One fingerprint engine per lane and pass.
    eq((sync.match(/await createHasher\(/g) || []).length, 1, 'a fingerprint engine is created in one place only');
    ok(/await this\._hasher\('copy', lane, algo\)/.test(sync) && /await this\._hasher\('verify', lane, item\.algo\)/.test(sync),
       'the copy and the read-back reuse theirs, per lane');
    ok(/hasher\.init\(\)/.test(fs.readFileSync(path.join(root, 'src/main/core/hash.js'), 'utf8')), 'which is reset at every file');
    // (d7) No write-only list of results.
    ok(!/this\.results/.test(sync), 'the run no longer keeps every result in memory');
  }
  // (d2) Unticking folders walks their contents only, with the same result.
  {
    const { L, R } = scratch();
    for (const d of ['A', 'A/x', 'B', 'AB']) write(L, d + '/f.txt', d);
    write(L, 'A/x/y/g.txt', 'g');
    const s = new Session();
    await s.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: {} });
    const a = s.nodes.find(n => n.rel === 'A');
    const got = s._expand([a.idx]).sort((x, y) => x - y);
    const want = s.nodes.filter(n => n.rel === 'A' || n.rel.startsWith('A/')).map(n => n.idx).sort((x, y) => x - y);
    eq(got, want, 'a folder and exactly what it holds ("AB" is not inside "A")');
    ok(s.nodes.every((n, i) => n.idx === i) && s.nodes.every(n => n.parent == null || n.parent < 0 || s.nodes[n.parent].depth === n.depth - 1),
       'the order this relies on: every row at its own index, parents first');
    await s.close();
  }
  // (d3) The grid is served a window, identical to the old full list's slice.
  {
    const { dir } = scratch();
    const L1 = path.join(dir, 'L1'), L2 = path.join(dir, 'L2'), R1 = path.join(dir, 'R1'), R2 = path.join(dir, 'R2');
    for (let i = 0; i < 30; i++) { write(L1, `a${i}.txt`, 'a'); write(L2, `b${i}.txt`, 'b'); }
    const job = makeJob('', '', { sync: { variant: 'mirror' } });
    job.pairs = [{ left: L1, right: R1 }, { left: L2, right: R2 }];
    const ms = new MultiSession();
    await ms.compare(job, { token: {} });
    const full = ms.rows(0, 1000, {});
    const key = r => r.hdr ? 'H' + r.pair : String(r.idx);
    let same = true;
    for (const [o, l] of [[0, 5], [29, 4], [31, 3], [60, 10], [62, 50]]) {
      const w = ms.rows(o, l, {});
      if (JSON.stringify(w.rows.map(key)) !== JSON.stringify(full.rows.slice(o, o + l).map(key)) || w.total !== full.total) same = false;
    }
    ok(same && full.total === 62, 'any window, across pair headings, is the same rows as before');
    await ms.close();
  }
  // (d4) During a run the list is filtered, not rebuilt.
  {
    const { L, R } = scratch();
    for (let i = 0; i < 5; i++) write(L, `f${i}.txt`, 'x');
    const s = new Session();
    await s.compare(makeJob(L, R, { sync: { variant: 'mirror' } }), { token: {} });
    const before = s.rows(0, 50, {}).total;
    s.nodes[1].doneInRun = true; s._landed();
    eq([before, s.rows(0, 50, {}).total], [5, 4], 'a row that landed leaves the list');
    ok(/onRowDone: \(\) => this\._landed\(\)/.test(fs.readFileSync(path.join(root, 'src/main/core/session.js'), 'utf8')), 'which is how a run reports it');
    await s.close();
  }
  // (d5) The database read at the comparison is reused when saving, unless
  //      the file changed in between; and it is not copied item by item.
  {
    const { loadPairDb, savePairDb } = require('../src/main/core/db');
    const { NativeFs } = require('../src/main/fs/native');
    const { L, R } = scratch();
    const side = p => ({ fs: new NativeFs(), path: p });
    await savePairDb(side(L), side(R), 'p1', { items: { 'a.txt': { t: 'f', lm: 1, ls: 1, rm: 1, rs: 1 } } });
    const loaded = await loadPairDb(side(L), side(R), 'p1');
    ok(loaded.db.available && loaded.docs.left.doc && loaded.docs.left.digest, 'the documents read are kept');
    ok(Object.getPrototypeOf(loaded.db.items) === null, 'the items are prototype-free without a copy');
    // Another pair of the job writes in the same folders meanwhile.
    await savePairDb(side(L), side(R), 'p2', { items: { 'b.txt': { t: 'f' } } });
    await savePairDb(side(L), side(R), 'p1', { items: { 'a.txt': { t: 'f' } } }, loaded.docs);
    const after = await loadPairDb(side(L), side(R), 'p2');
    ok(after.db.available && after.db.items['b.txt'], "a file changed since is read again: the other pair's history survives");
    const again = await loadPairDb(side(L), side(R), 'p1');
    let parsed = 0;
    const orig = JSON.parse;
    JSON.parse = (...a) => { parsed++; return orig(...a); };
    try { await savePairDb(side(L), side(R), 'p1', { items: {} }, again.docs); } finally { JSON.parse = orig; }
    eq(parsed, 0, 'an unchanged file is not parsed a second time');
  }
  // (d6) Move detection with nothing new on either side returns at once.
  {
    const { detectMoves } = require('../src/main/core/direction');
    const items = Object.create(null);
    for (let i = 0; i < 1000; i++) items['f' + i] = { t: 'f', li: 'L' + i, ri: 'R' + i };
    const nodes = [{ rel: 'x', type: 'file', active: true, left: { exists: true, id: 'L1' }, right: { exists: true, id: 'R1' } }];
    eq(detectMoves(nodes, { available: true, items }), 0, 'no candidate, no move');
  }
}


// ══ 53. FTP and FTPS, and filo's engine for SFTP (0.9.1) ═══════════════════
// filo's transfer engine replaces syncto's SFTP layer (adaptive read depth, a
// receive window that follows it, checksums computed by the server) and brings
// FTP, FTPS explicit and FTPS implicit. Everything below talks to real servers
// in this process (test/ftp-server.js, test/sftp-server.js): real sockets, real
// passive data connections, a real certificate when openssl is there.
// Run alone: SYNCTO_ONLY=testFtpEngine091 node test/run-tests.js
async function testFtpEngine091() {
  console.log('\n\n53. FTP, FTPS and filo\'s engine (0.9.1)');
  const { startFtpServer, makeCert } = require('./ftp-server');
  const { FtpFs } = require('../src/main/fs/ftp');
  const { FsPool, parseLocation, redactLocation, expandMacros, isServerAddress, poolKey } = require('../src/main/fs/afs');
  const { setCertPolicy } = require('../src/main/fs/ftp/client');
  const { credentialMap, Prefs } = require('../src/main/config');
  const { Readable } = require('stream');
  const crypto = require('crypto');
  const root = path.join(__dirname, '..');
  const app  = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8').replace(/\u0000/g, '');
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
  const files = base => listAll(base).filter(f => !f.endsWith('/'));
  const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const mkServerDir = () => { const { dir } = scratch(); const r = path.join(dir, 'server'); fs.mkdirSync(r, { recursive: true }); return { dir, r }; };
  const url = (srv, p, scheme) => `${scheme || 'ftp'}://${srv.user}:${srv.pass}@${srv.host}:${srv.port}${p || '/'}`;
  const connect = async (srv, extra) => {
    const f = new FtpFs(Object.assign({ protocol: 'ftp', host: srv.host, port: srv.port, username: srv.user, password: srv.pass }, extra || {}));
    await f.connect();
    return f;
  };

  // ── a. Addresses ──────────────────────────────────────────────────────────
  {
    const a = parseLocation('ftp://bob@host/x');
    eq([a.kind, a.protocol, a.port], ['ftp', 'ftp', 21], 'ftp:// is plain FTP on 21');
    const b = parseLocation('ftpes://bob@host/x');
    eq([b.kind, b.protocol, b.port], ['ftp', 'ftps', 21], 'ftpes:// is explicit TLS on 21');
    const c = parseLocation('ftps://bob@host:2121/x');
    eq([c.kind, c.protocol, c.port, c.path], ['ftp', 'ftps-implicit', 2121, '/x'], 'ftps:// is implicit TLS, the port is kept');
    eq(parseLocation('sftp://bob@host').port, 22, 'sftp:// is still 22');
    eq(parseLocation('FTP://bob@host').kind, 'ftp', 'the scheme is case-insensitive');

    eq(redactLocation('ftp://bob:pw@h/x'), 'ftp://bob@h/x', 'a password in an ftp:// address is taken out');
    eq(redactLocation('  ftpes://bob:pw@h/x'), '  ftpes://bob@h/x', 'also with leading spaces, and in ftpes://');
    eq(redactLocation('ftps://bob:pw@h/x'), 'ftps://bob@h/x', 'and in ftps://');
    eq(redactLocation('/Volumes/a:b@c'), '/Volumes/a:b@c', 'a plain path is left alone');

    ok(isServerAddress('ftp://h/x') && isServerAddress(' ftps://h') && isServerAddress('sftp://h') && !isServerAddress('/ftp://x'),
       'an address on a server is told from a path');
    // Environment variables are not expanded in a server address (0.8.8): same for FTP.
    process.env.SYNCTO_TEST_SECRET = 'leak';
    eq(expandMacros('ftp://bob@%SYNCTO_TEST_SECRET%.example/%SYNCTO_TEST_SECRET%'),
       'ftp://bob@%SYNCTO_TEST_SECRET%.example/%SYNCTO_TEST_SECRET%', 'no environment variable in an ftp:// address');
    delete process.env.SYNCTO_TEST_SECRET;

    // Credentials: an SSH password is never offered to an FTP server.
    const creds = { 'bob@host': { password: 'ssh-secret' }, 'ftp:bob@host:21': { password: 'ftp-secret', transferMode: 'active' } };
    eq(parseLocation('ftp://bob@host/', creds).password, 'ftp-secret', 'an FTP address finds the FTP entry');
    eq(parseLocation('ftp://bob@host/', creds).transferMode, 'active', 'with its data mode');
    eq(parseLocation('ftp://bob@other/', creds).password, '', 'and nothing for another host');
    eq(parseLocation('ftp://bob@host/', { 'bob@host': { password: 'ssh-secret' } }).password, '', 'the SSH password is not used for FTP');
    eq(parseLocation('sftp://bob@host/', creds).password, 'ssh-secret', 'SFTP keeps its own entry');
    ok(poolKey(parseLocation('ftp://b@h/')) !== poolKey(parseLocation('ftpes://b@h/')), 'FTP and FTPS to one host are two connections');
  }

  // ── b. The backend, through the contract the engine uses ──────────────────
  {
    const { r } = mkServerDir();
    fs.mkdirSync(path.join(r, 'dir'));
    fs.writeFileSync(path.join(r, 'dir', 'a.txt'), 'hello');
    const big = Buffer.alloc(3 * 1024 * 1024 + 123);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + (i >> 8)) & 255;
    fs.writeFileSync(path.join(r, 'big.bin'), big);
    const srv = await startFtpServer({ root: r, hash: true });
    const f = await connect(srv);
    try {
      eq(f.kind, 'ftp', 'the backend says it is a server');
      eq(await f.realpath('.'), '/', 'the login folder is read');
      const list = (await f.readdir('/')).map(e => [e.name, e.type]).sort();
      eq(list, [['big.bin', 'file'], ['dir', 'folder']], 'a folder is listed with the types');
      const st = await f.stat('/dir/a.txt');
      eq([st.type, st.size], ['file', 5], 'stat of a file');
      eq((await f.stat('/dir')).type, 'folder', 'stat of a folder');
      eq(await f.stat('/nope'), null, 'a missing file is null');
      eq(await f.stat('/nope/deeper/file'), null, 'and so is one under a missing folder');
      eq((await f.stat('/')).type, 'folder', 'the root is a folder');

      // Reading: every byte, in order; then from an offset.
      const chunks = [];
      for await (const c of f.createReadStream('/big.bin')) chunks.push(c);
      ok(Buffer.concat(chunks).equals(big), 'a 3 MB file is read byte for byte');
      const part = [];
      for await (const c of f.createReadStream('/big.bin', 1000)) part.push(c);
      ok(Buffer.concat(part).equals(big.subarray(1000)), 'and from an offset (resume)');
      const none = [];
      for await (const c of f.createReadStream('/dir/a.txt')) none.push(c);
      eq(Buffer.concat(none).toString(), 'hello', 'a small file');

      // Writing: through the stream the copy loop uses; finish means "stored".
      const ws = f.createWriteStream('/dir/new.dat');
      await new Promise((res, rej) => {
        ws.on('finish', res); ws.on('error', rej);
        for (let i = 0; i < big.length; i += 65536) ws.write(big.subarray(i, i + 65536));
        ws.end();
      });
      ok(fs.readFileSync(path.join(r, 'dir', 'new.dat')).equals(big), 'a 3 MB file is written byte for byte');
      eq(fs.statSync(path.join(r, 'dir', 'new.dat')).size, big.length, 'and the server holds all of it when the stream says finished');
      const e0 = f.createWriteStream('/dir/empty.dat');
      await new Promise((res, rej) => { e0.on('finish', res); e0.on('error', rej); e0.end(); });
      eq(fs.statSync(path.join(r, 'dir', 'empty.dat')).size, 0, 'an empty file');

      // A refused write is an error, not a silent success.
      const bad = f.createWriteStream('/no/such/folder/x.dat');
      const err = await new Promise(res => { bad.on('error', res); bad.on('finish', () => res(null)); bad.end(Buffer.alloc(10)); });
      ok(err && err.message, 'a write into a folder that is not there fails');

      // A read that fails midway is an error, never a stream that ends short.
      let ended = false, errored = null;
      const rs = f.createReadStream('/big.bin');
      rs.on('error', e => { errored = e; });
      rs.on('end', () => { ended = true; });
      rs.once('data', () => { f.xfers.forEach(x => { try { x.remote.client.close(); } catch (_) {} }); });
      rs.resume();
      await new Promise(res => setTimeout(res, 600));
      ok(errored && !ended, 'a connection cut while reading ends the stream with an error, not an early end');

      await f.mkdir('/x/y/z');
      ok(fs.existsSync(path.join(r, 'x', 'y', 'z')), 'mkdir makes every level');
      await f.mkdir('/x/y/z');
      ok(true, 'and is happy when it already exists');

      // Replacing a file: rename over an existing name.
      fs.writeFileSync(path.join(r, 'old.txt'), 'old');
      fs.writeFileSync(path.join(r, 'new.tmp'), 'newer');
      await f.rename('/new.tmp', '/old.txt');
      eq(fs.readFileSync(path.join(r, 'old.txt'), 'utf8'), 'newer', 'rename replaces an existing file');

      const when = Date.UTC(2024, 0, 2, 3, 4, 5);
      await f.setMTime('/old.txt', when);
      eq((await f.stat('/old.txt')).mtime, when, 'the date of a file is set (MFMT) and read back to the second');

      // Locks: exclusive create refuses an existing file; append adds a byte.
      await f.writeExclusive('/lockfile', '{"a":1}');
      let code = null;
      try { await f.writeExclusive('/lockfile', 'x'); } catch (e) { code = e.code; }
      eq(code, 'EEXIST', 'an exclusive create on an existing file says EEXIST');
      await f.appendByte('/lockfile', ' ');
      eq(fs.readFileSync(path.join(r, 'lockfile'), 'utf8'), '{"a":1} ', 'a byte is appended');
      let code2 = null;
      try { await f.renameStrict('/old.txt', '/lockfile'); } catch (e) { code2 = e.code; }
      eq(code2, 'EEXIST', 'renameStrict refuses an existing target');

      // The server's checksum.
      eq(await f.hashAlgos(), ['sha256', 'sha1', 'md5'], 'the checksums the server offers');
      eq(await f.serverHash('/big.bin', 'sha256', big.length), sha(path.join(r, 'big.bin')), 'the server checksum is the right one');

      // Links and permissions do not exist here, and say so.
      let nl = null;
      try { await f.readlink('/x'); } catch (e) { nl = e.code; }
      eq(nl, 'ENOTSUP', 'a link cannot be read');

      // The control connection stays free while a transfer runs: this is what
      // keeps a folder's lock alive during a copy that lasts minutes.
      const slow = f.createWriteStream('/slow.dat');
      let wrote = 0;
      const writing = new Promise((res, rej) => {
        slow.on('finish', res); slow.on('error', rej);
        const tick = () => {
          if (wrote >= 8) return slow.end();
          slow.write(Buffer.alloc(1024, 1)); wrote++;
          setTimeout(tick, 60);
        };
        tick();
      });
      await new Promise(res => setTimeout(res, 120));
      const t0 = Date.now();
      await f.appendByte('/lockfile', ' ');
      await f.stat('/lockfile');
      ok(Date.now() - t0 < 300 && wrote < 8, 'a stat and an append are answered while an upload is still running');
      await writing;
      eq(fs.statSync(path.join(r, 'slow.dat')).size, 8 * 1024, 'and the upload completes');
    } finally { await f.close(); await srv.close(); }
  }

  // ── c. A plain unreadable folder is an error, not an absence ──────────────
  {
    const { r } = mkServerDir();
    fs.mkdirSync(path.join(r, 'locked'));
    fs.writeFileSync(path.join(r, 'locked', 'secret.txt'), 'x');
    const srv = await startFtpServer({ root: r, noEnter: ['/locked'] });
    const f = await connect(srv);
    try {
      // A root that does not exist is an absence; the engine then creates it.
      eq(await f.stat('/missing/child.txt'), null, 'an absent folder: its children are absent');
      // A folder the account cannot enter makes everything under it look absent
      // to the server. That must be an error: "absent" would let a mirror copy
      // over, or delete, files that are in fact there.
      let msg = '';
      try { await f.stat('/locked/secret.txt'); } catch (e) { msg = e.message; }
      ok(/cannot be entered/.test(msg), `a folder that cannot be entered is an error, not an absence (${msg})`);
    } finally { await f.close(); await srv.close(); }
  }

  // ── d. A whole run, local → FTP and back ──────────────────────────────────
  {
    const { dir, r } = mkServerDir();
    const L = path.join(dir, 'src');
    const t0 = Math.floor((Date.now() - 86400000 * 3) / 1000) * 1000;   // FTP dates are whole seconds
    write(L, 'a.txt', 'alpha', t0);
    write(L, 'sub/b.txt', 'bravo bravo', t0 + 5000);
    write(L, 'sub/deep/c.bin', Buffer.alloc(300000, 7), t0 + 9000);
    write(L, 'empty.txt', '', t0);
    const srv = await startFtpServer({ root: r, hash: true });
    try {
      const job = makeJob(L, url(srv, '/backup'), { sync: { variant: 'mirror', lockFolders: false } });
      const { cmp, run } = await runPair(job);
      eq(run.counters.files, 4, 'four files were copied to the FTP server');
      eq(run.counters.errors || 0, 0, 'without an error');
      eq(files(r).filter(f2 => !/\.syncto\.db$/.test(f2)), ['backup/a.txt', 'backup/empty.txt', 'backup/sub/b.txt', 'backup/sub/deep/c.bin'], 'the tree is on the server');
      eq(read(path.join(r, 'backup'), 'sub/b.txt'), 'bravo bravo', 'with the right content');
      eq(fs.statSync(path.join(r, 'backup', 'sub/b.txt')).mtimeMs, t0 + 5000, 'and the right date (MFMT)');
      ok(!srv.log.some(l => /^RETR .*\.syncto_tmp/.test(l)) && !srv.log.some(l => /^RETR /.test(l)),
         'nothing was read back: the server computed the checksum itself');
      ok(srv.log.some(l => /^HASH /.test(l)), 'the checksum was asked of the server');
      ok((run.notes || []).some(n => /checked by the server/.test(n)), 'and the run says so');
      ok(!files(r).some(f2 => /syncto_tmp|syncto_old/.test(f2)), 'no scratch file is left on the server');

      // Nothing to do the second time.
      const again = await runPair(job);
      eq(again.cmp.stats ? again.cmp.stats.toCopy || 0 : 0, 0, 'a second comparison finds nothing to copy');
      eq(again.run.counters.files, 0, 'and a second run copies nothing');

      // One file changes: only it moves.
      write(L, 'a.txt', 'alpha changed!', Date.now());
      const third = await runPair(job);
      eq(third.run.counters.files, 1, 'one changed file, one copy');
      eq(read(path.join(r, 'backup'), 'a.txt'), 'alpha changed!', 'and it arrived');

      // And back down: a fresh folder from the server.
      const D = path.join(dir, 'down');
      fs.mkdirSync(D);
      const back = await runPair(makeJob(url(srv, '/backup'), D, { sync: { variant: 'mirror', lockFolders: false } }));
      eq(back.run.counters.files, 4, 'four files came down');
      eq(read(D, 'sub/deep/c.bin') === null, false, 'the deep file is there');
      eq(fs.statSync(path.join(D, 'sub/b.txt')).mtimeMs, t0 + 5000, 'with the date the server holds');
    } finally { await srv.close(); }
  }

  // ── e. Without a server checksum the file is read back ────────────────────
  {
    const { dir, r } = mkServerDir();
    const L = path.join(dir, 'src');
    write(L, 'x.bin', Buffer.alloc(200000, 3), Date.now() - 1e7);
    const srv = await startFtpServer({ root: r, hash: false });
    try {
      const { run } = await runPair(makeJob(L, url(srv, '/'), { sync: { variant: 'mirror', lockFolders: false } }));
      eq(run.counters.files, 1, 'the file was copied');
      ok(srv.log.some(l => /^RETR /.test(l)), 'a server with no HASH command: the file is read back over the link');
      ok(!srv.log.some(l => /^HASH /.test(l)), 'and no HASH was tried');
      eq(run.counters.errors || 0, 0, 'without an error');
    } finally { await srv.close(); }

    // A corrupted copy is caught either way: the server says something else.
    const { dir: d2, r: r2 } = mkServerDir();
    const L2 = path.join(d2, 'src');
    write(L2, 'y.bin', Buffer.alloc(100000, 5), Date.now() - 1e7);
    const srv2 = await startFtpServer({ root: r2, hash: true });
    const realStor = fs.createWriteStream;
    try {
      // The server stores a different byte: its checksum differs from ours.
      fs.createWriteStream = function (p, o2) {
        const w = realStor.call(fs, p, o2);
        const origWrite = w.write.bind(w);
        w.write = (chunk, ...a) => { if (Buffer.isBuffer(chunk) && chunk.length > 10) { chunk = Buffer.from(chunk); chunk[5] ^= 0xff; } return origWrite(chunk, ...a); };
        return w;
      };
      const { run } = await runPair(makeJob(L2, url(srv2, '/'), { sync: { variant: 'mirror', lockFolders: false } }));
      ok((run.counters.errors || 0) >= 1, 'bytes altered on the way: the server checksum does not match, and the run reports it');
    } finally { fs.createWriteStream = realStor; await srv2.close(); }
  }

  // ── f. Dates: no MFMT, and listings to the minute ─────────────────────────
  {
    const { dir, r } = mkServerDir();
    const L = path.join(dir, 'src');
    const t0 = Date.now() - 86400000 * 2;
    write(L, 'one.txt', 'one', t0);
    write(L, 'two.txt', 'two', t0 + 4000);
    const srv = await startFtpServer({ root: r, mlsd: false, mfmt: false, hash: false });
    try {
      const job = makeJob(L, url(srv, '/'), { sync: { variant: 'mirror', lockFolders: false } });
      const first = await runPair(job);
      eq(first.run.counters.files, 2, 'a server with no MLSD and no MFMT still receives the files');
      ok((first.run.notes || []).concat((first.run.errors || []).map(e => e.message || '')).some(n => /modification date|MFMT|preserve the date/i.test(n)),
         'and the run says the dates could not be kept');
      const f = await connect(srv);
      const listed = await f.readdir('/');
      ok(listed.every(e => e.mtime > 0), 'a LIST listing gives usable dates');
      eq(f.timeResolutionSec > 2, true, 'and the comparison knows they are only good to the minute');
      await f.close();
      // The second run must not copy again just because the dates differ.
      const second = await runPair(job);
      eq(second.run.counters.files, 0, 'with the dates not kept, a second run copies nothing (the history says nothing changed)');
    } finally { await srv.close(); }
  }

  // ── g. Locks on an FTP folder, and several connections ────────────────────
  {
    const { dir, r } = mkServerDir();
    const L = path.join(dir, 'src');
    for (let i = 0; i < 6; i++) write(L, `clip${i}.mov`, Buffer.alloc(50000 + i, i), Date.now() - 1e7);
    const srv = await startFtpServer({ root: r, hash: true });
    try {
      const job = makeJob(L, url(srv, '/locked'), { sync: { variant: 'mirror', lockFolders: true, transferLanes: 3 } });
      const { run } = await runPair(job);
      eq(run.counters.files, 6, 'six files copied on three lanes while the folder was locked');
      ok(!files(r).some(f2 => /\.syncto_lock/.test(f2)), 'the lock is gone at the end');
      ok(srv.state.maxOpen <= 12, `connections stayed reasonable (${srv.state.maxOpen})`);
    } finally { await srv.close(); }

    // Two folders of the SAME server: the read and the write go on different connections.
    const { dir: d3, r: r3 } = mkServerDir();
    fs.mkdirSync(path.join(r3, 'from')); fs.mkdirSync(path.join(r3, 'to'));
    fs.writeFileSync(path.join(r3, 'from', 'm.bin'), Buffer.alloc(400000, 9));
    const srv3 = await startFtpServer({ root: r3, hash: true });
    try {
      const job = makeJob(url(srv3, '/from'), url(srv3, '/to'), { sync: { variant: 'mirror', lockFolders: false } });
      const { run } = await runPair(job);
      eq(run.counters.files, 1, 'a copy from one folder of a server to another folder of the same server');
      eq(fs.statSync(path.join(r3, 'to', 'm.bin')).size, 400000, 'arrived whole');
    } finally { await srv3.close(); }
  }

  // ── h. Logins ─────────────────────────────────────────────────────────────
  {
    const { r } = mkServerDir();
    const srv = await startFtpServer({ root: r });
    try {
      const bad = new FtpFs({ protocol: 'ftp', host: srv.host, port: srv.port, username: srv.user, password: 'wrong' });
      let msg = '';
      try { await bad.connect(); } catch (e) { msg = e.message; }
      ok(/refused the login/i.test(msg), `a wrong password is said plainly (${msg})`);
      await bad.close();
      const none = new FtpFs({ protocol: 'ftp', host: '127.0.0.1', port: 1, username: 'u', password: 'p' });
      let m2 = '';
      try { await none.connect(); } catch (e) { m2 = e.message; }
      ok(/refused the connection|did not answer/i.test(m2), `nothing listening: ${m2}`);
      // The pool does not cache a failed attempt.
      const pool = new FsPool();
      let failed1 = false;
      try { await pool.open(parseLocation(`ftp://u:wrong@${srv.host}:${srv.port}/`)); } catch (_) { failed1 = true; }
      ok(failed1, 'the pool reports the failure');
      const good = await pool.open(parseLocation(`ftp://${srv.user}:${srv.pass}@${srv.host}:${srv.port}/`));
      eq(good.kind, 'ftp', 'and the next attempt, with the right password, connects');
      await pool.closeAll();
    } finally { await srv.close(); }
  }

  // ── i. FTPS, explicit and implicit ────────────────────────────────────────
  {
    const { dir } = mkServerDir();
    const certDir = path.join(dir, 'cert'); fs.mkdirSync(certDir);
    const cert = makeCert(certDir);
    if (!cert) {
      process.stdout.write(' (FTPS skipped: no openssl)');
    } else {
      const pins = new Map();
      setCertPolicy({ known: (h, p) => pins.get(`${h}:${p}`) || null, remember: (h, p, fp) => pins.set(`${h}:${p}`, fp) });
      try {
        for (const [protocol, implicit] of [['ftps', false], ['ftps-implicit', true]]) {
          const { r } = mkServerDir();
          fs.writeFileSync(path.join(r, 'hello.txt'), 'secret hello');
          const srv = await startFtpServer({ root: r, tls: cert, implicit, hash: true });
          const f = await connect(srv, { protocol });
          try {
            ok(pins.get(`${srv.host}:${srv.port}`) === srv.fingerprint, `${protocol}: a self-signed certificate is pinned the first time`);
            const got = [];
            for await (const c of f.createReadStream('/hello.txt')) got.push(c);
            eq(Buffer.concat(got).toString(), 'secret hello', `${protocol}: a file is read over the encrypted data connection`);
            const ws = f.createWriteStream('/up.txt');
            await new Promise((res, rej) => { ws.on('finish', res); ws.on('error', rej); ws.end('uploaded'); });
            eq(read(r, 'up.txt'), 'uploaded', `${protocol}: and written`);
            eq((await f.readdir('/')).length, 2, `${protocol}: and listed`);
          } finally { await f.close(); }
          // Same server again: the pinned certificate matches.
          const f2 = await connect(srv, { protocol });
          ok(true, `${protocol}: a second connection to the same certificate is accepted`);
          await f2.close();
          await srv.close();

          // Another certificate on the same address: refused before the login.
          const other = makeCert(path.join(dir, 'cert'));
          const srv2 = await startFtpServer({ root: r, tls: other, implicit, port: srv.port });
          pins.set(`${srv2.host}:${srv2.port}`, srv.fingerprint);
          const f3 = new FtpFs({ protocol, host: srv2.host, port: srv2.port, username: srv2.user, password: srv2.pass });
          let m3 = '';
          try { await f3.connect(); } catch (e) { m3 = e.message; }
          ok(/certificate of .* has changed/i.test(m3), `${protocol}: a different certificate is refused (${m3.split('\n')[0]})`);
          ok(!srv2.log.some(l => /^(USER|PASS)/.test(l)), `${protocol}: and nothing was sent`);
          await f3.close();
          await srv2.close();
          pins.clear();
        }
      } finally { setCertPolicy(null); }
    }
  }

  // ── j. Saved servers and passwords ────────────────────────────────────────
  {
    const { dir } = scratch();
    const prefs = new Prefs(path.join(dir, 'prefs'));
    prefs.load();
    const saved = prefs.saveServer({ name: 'Old NAS', host: 'nas.local', protocol: 'ftps', port: 21, username: 'bob', password: 'ftp-pw', transferMode: 'active', savePassword: true });
    eq(saved.server.protocol, 'ftps', 'a saved server keeps its protocol');
    eq(saved.server.transferMode, 'active', 'and its data mode');
    const map = credentialMap(prefs.data.servers);
    eq(Object.keys(map), ['ftp:bob@nas.local:21'], 'an FTP entry is keyed with its protocol and port');
    eq(map['ftp:bob@nas.local:21'].transferMode, 'active', 'with the data mode');
    // Typing a password into a folder field: moved out of the path.
    const data = { servers: [], job: { pairs: [{ left: '/Users/x/a', right: 'ftpes://carl:topsecret@host.example/backup' }] } };
    prefs.save({ job: data.job });
    const onDisk = fs.readFileSync(prefs.file, 'utf8');
    ok(!onDisk.includes('topsecret'), 'a password typed in an ftpes:// address is not written to the preferences');
    ok(/ftpes:\/\/carl@host\.example\/backup/.test(onDisk), 'the address is kept without it');
    const entry = prefs.data.servers.find(s => s.username === 'carl');
    ok(entry && entry.protocol === 'ftps' && entry.port === 21, 'and a server entry is made for it with the right protocol and port');
    // Forgetting a server forgets its certificate.
    prefs.rememberCert('nas.local', 21, 'SHA256:AA');
    eq(prefs.knownCert('nas.local', 21), 'SHA256:AA', 'a certificate is remembered');
    prefs.removeServer(saved.server.id);
    eq(prefs.knownCert('nas.local', 21), null, 'and forgotten with its server');
  }

  // ── k. The window ─────────────────────────────────────────────────────────
  {
    ok(/<select id="srv-proto"/.test(html) && /value="ftps-implicit"/.test(html) && /value="ftp">FTP, not encrypted/.test(html),
       'the server window offers the four protocols');
    ok(/id="srv-moderow"/.test(html) && /id="srv-mode"/.test(html), 'and the data mode for FTP');
    ok(/const SERVER_ADDRESS = \/\^\\s\*\(\?:sftp\|ftpes\|ftps\|ftp\):\\\/\\\/\/i/.test(app), 'the window recognizes the four address forms');
    ok(!/startsWith\('sftp:\/\/'\)/.test(app), 'no check for sftp:// alone is left in the window');
    ok(/SRV_DEFAULT_PORT = \{ sftp: 22, ftps: 21, 'ftps-implicit': 990, ftp: 21 \}/.test(app), 'the port follows the protocol');
    ok(/protocol: \$\('srv-proto'\)\.value/.test(app), 'the protocol is sent with the connection');
    ok(/Plain FTP sends the password and every file in clear/.test(app), 'plain FTP says what it means');
  }

  // ── l. SFTP got filo's engine, and kept its behaviour ─────────────────────
  {
    const pipe = require('../src/main/fs/sftp-pipe');
    ok(typeof pipe.MAX_READ_DEPTH === 'number' && pipe.MAX_READ_DEPTH >= 512, 'the read depth can grow with the round trip');
    const { SftpFs } = require('../src/main/fs/sftp');
    for (const m of ['_installWindow', '_wantWindow', '_topUp', '_chunk', 'hashAlgos', 'serverHash', '_exec']) {
      ok(typeof SftpFs.prototype[m] === 'function', `SftpFs has ${m}`);
    }
    // An account that cannot run commands: no server checksum, the file is read back.
    const { startSftpServer } = require('./sftp-server');
    const { dir } = scratch();
    const remote = path.join(dir, 'server'); fs.mkdirSync(remote, { recursive: true });
    const L = path.join(dir, 'src');
    write(L, 'k.bin', Buffer.alloc(150000, 4), Date.now() - 1e7);
    const srv = await startSftpServer({ root: remote });
    try {
      const job = makeJob(L, `sftp://${srv.username}:${srv.password}@${srv.host}:${srv.port}/`, { sync: { variant: 'mirror', lockFolders: false } });
      const { run } = await runPair(job);
      eq(run.counters.files, 1, 'SFTP still copies');
      eq(run.counters.errors || 0, 0, 'and verifies by reading back when the server runs no commands');
    } finally { await srv.close(); }
  }
}


(async function main() {
  console.log('syncto engine tests');
  console.log('scratch: ' + ROOT);
  try {
    // One entry per section, so a single one can be run on its own:
    //   SYNCTO_ONLY=testCharte,testSecurity node test/run-tests.js
    // Checking a guard by breaking the code on purpose used to mean a full
    // four-minute suite per mutation; this makes it seconds.
    const SECTIONS = [
  testFilter,
  testCompare,
  testMirror,
  testUpdate,
  testTwoWay,
  testSecure,
  testVersioning,
  testFailSafe,
  testOverrides,
  testFolderRules,
  testMoves,
  testMovesTwoWayAndOff,
  testMultiPair,
  testLocking,
  testReviewRegressions,
  testAuditFixes,
  testOverviewAndShowEqual,
  testServers,
  testNasRegression,
  testAfterAndNtfy,
  testNtfySecrets,
  testSingleCopyMode,
  testAudit051,
  testAudit051Engine,
  testOsFolderLitter,
  testAppleCommandLines,
  testProgressAndReveal,
  testBundlesAndCopyLog,
  testInSyncPairs,
  testCloseJob,
  testMissingRootWithHistory,
  testCheckJobPaths,
  testLockTolerance,
  testLog,
  testSftpTransfer,
  testOverviewTree,
  testOverviewSortAndBatch,
  testNarrowedViewAndRunUi,
  testRunFiguresAndLogPerProcess,
  testSftpSpeed,
  testIpcArity,
  testCharte,
  testSecurity,
  testAuditFixes080,
  testPerformance,
  testWindowTruth,
  testLinux,
      testRequest083,
      testReview088,
      testLongNames088,
      testSafeNames089,
      testAudit1013,
      testFtpEngine091,
    ];
    const only = (process.env.SYNCTO_ONLY || '').split(',').map(x => x.trim()).filter(Boolean);
    // Each section on its own: an exception used to end the whole suite, so
    // one crash in section 35 printed "837 passed, 1 failed" and silently
    // skipped the eleven sections after it. Now the crash is named, and the
    // rest still runs.
    for (const section of SECTIONS) {
      if (only.length && !only.includes(section.name)) continue;
      try { await section(); }
      catch (err) {
        failed++;
        failures.push(`UNCAUGHT in ${section.name}: ` + (err.stack || err.message));
      }
    }
  } catch (err) {
    failed++;
    failures.push('UNCAUGHT: ' + (err.stack || err.message));
  }

  console.log('\n');
  if (failures.length) {
    console.log('Failures:');
    for (const f of failures) console.log('  - ' + f);
    console.log('');
  }
  console.log(`${passed} passed, ${failed} failed`);
  if (!process.env.KEEP_SCRATCH) fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
