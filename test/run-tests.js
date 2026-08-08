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
  j.sync.report.enabled = false;
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
  ok(run.reportFiles.length === 3, 'HTML, CSV and JSON reports are written');
  ok(fs.readFileSync(run.reportFiles.find(f => f.endsWith('.html')), 'utf8').includes('syncto'),
     'the HTML report is not empty');

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

  // (k) Two names differing only by case: flagged, first one wins, no crash.
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
      eq(s.nodes.filter(n => n.rel.toLowerCase() === 'file.txt').length, 1, 'and only one row is kept');
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

  // (m) Errors are not counted twice by the multi-pair aggregation.
  {
    const { dir } = scratch();
    const mk = name => {
      const l = path.join(dir, name + 'L'), r = path.join(dir, name + 'R');
      fs.mkdirSync(l, { recursive: true }); fs.mkdirSync(r, { recursive: true });
      write(r, 'stray.txt', 'x');          // mirror wants to delete it…
      return { left: l, right: r };
    };
    const job = makeJob('', '', { sync: { deletion: 'recycler' } });   // …but no trash is available
    job.pairs = [mk('p1'), mk('p2')];
    const ms = new MultiSession();
    await ms.compare(job, { token: {} });
    const res = await ms.sync(job, { token: {}, appVersion: 'test' });   // no trashItem provided
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

  // (p) The lock layer ignores folders that do not exist yet, and syncto's
  // transient "Delete.N." takeover names are invisible to the comparison.
  {
    const fsx = new NativeFs();
    const set = await acquireAll([{ fs: fsx, path: path.join(ROOT, 'not-yet-created') }], {});
    eq(set.count, 0, 'a missing folder is not locked (the run will create it)');
    await set.release();
    ok(isSyncToInternal('Delete.0..syncto.lock'), 'a lock being taken over is internal litter');
    ok(!isSyncToInternal('Delete.0.notes'), 'but a user file named Delete.0.notes is not');
  }
}

// ══ Run ════════════════════════════════════════════════════════════════════
(async function main() {
  console.log('syncto engine tests');
  console.log('scratch: ' + ROOT);
  try {
    testFilter();
    await testCompare();
    await testMirror();
    await testUpdate();
    await testTwoWay();
    await testSecure();
    await testVersioning();
    await testFailSafe();
    await testOverrides();
    await testFolderRules();
    await testMoves();
    await testMovesTwoWayAndOff();
    await testMultiPair();
    await testLocking();
    await testReviewRegressions();
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
