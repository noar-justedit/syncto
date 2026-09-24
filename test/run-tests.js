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
    ok(error && /Delete permanently/i.test(error.message) && /delete anyway/i.test(error.message),
       'and naming both settings that fix it, exactly as they read on screen');
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
    job.sync.report.enabled = false; job.sync.retryCount = 0;
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
  console.log('\n\n21. ntfy token storage (0.4.0)');
  const { Prefs } = require('../src/main/config');
  const { dir } = scratch();
  const p = new Prefs(dir);
  p.load();

  // The access token is a credential like any other: it goes through the OS
  // credential store, never into the file in the clear.
  p.saveNtfy({ enabled: true, server: 'https://ntfy.example', topic: 'syncto-abc', token: 'tk_secret_value' });
  const onDisk = fs.readFileSync(path.join(dir, 'preferences.json'), 'utf8');
  ok(!onDisk.includes('tk_secret_value'), 'the ntfy token never reaches the file in the clear');
  ok(onDisk.includes('syncto-abc'), 'while the topic is stored normally');

  const ui = p.ntfyForUi();
  ok(!('token' in ui) && !('tokenEnc' in ui), 'and the settings panel is never handed the token');
  eq(ui.topic, 'syncto-abc', 'it gets the topic');
  eq(ui.enabled, true, 'and the switch state');

  // Saving the panel again without retyping the token must not wipe it.
  p.data.ntfy.tokenEnc = 'PRETEND-CIPHERTEXT';
  p.saveNtfy({ topic: 'syncto-def' });
  eq(p.data.ntfy.tokenEnc, 'PRETEND-CIPHERTEXT', 'an untouched token box leaves the stored token alone');
  p.saveNtfy({ token: '' });
  eq(p.data.ntfy.tokenEnc, '', 'and clearing it explicitly does clear it');
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

  // And the report says what was checked, in words a client can read.
  {
    const { buildReport, toHtml } = require('../src/main/core/report');
    const rep = buildReport({
      appVersion: 't', pairName: 'j', leftPath: '/l', rightPath: '/r',
      variant: 'mirror', compareVariant: 'timeSize', copyLevel: 'secure',
      deletion: 'permanent', versioningStyle: '', filter: {},
      startedAt: 0, endedAt: 1000,
      run: { results: [], counters: { files: 3, bytes: 100, deleted: 0, folders: 0 },
             notes: [], verified: 3, errors: [] },
      stats: null, comparisonErrors: [],
    });
    eq(rep.totals.filesVerified, 3, 'the report carries the verified count');
    const html = toHtml(rep);
    ok(/read back and verified \(xxHash64\)/.test(html), 'and states it in the page');
    ok(/every file read back and compared/.test(html), 'and in the settings block');
    ok(!/size-checked/.test(html), 'with no trace of the old middle level');
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
    // The diagnostic journal reuses the same button — it is the panel people
    // are most often asked to copy.
    eq(buttons.sort(), ['st-log-text', 'sum-errors-body', 'sum-notes-body', 'vf-bad-body'],
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
    //     is. Orange since 0.8.0, not red: a folder that is not there is
    //     something to decide about, while red in the grid above means "these
    //     files will be deleted".
    ok(/\.prow input\.gone\{border-color:rgba\(242,160,61/.test(html),
       'a row whose folder is missing is drawn in orange');
    ok(/#missing-badge\{[^}]*color:var\(--orange\)/.test(html), 'and so is the badge that counts them');
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

// ══ 34. The diagnostic journal (0.6.3) ════════════════════════════════════
// syncto wrote nothing at all — no console output, no file. A user reporting
// "I press Synchronize and nothing happens" had nothing to send and there was
// nothing to read. What matters about this thing is what it must NOT do: leak
// a password, grow for ever, or take a run down with it.
function testLog() {
  console.log('\n\n34. The diagnostic journal (0.6.3)');

  const { Logger, redact, MAX_BYTES } = require('../src/main/log');

  // (a) Off by default, and silent when off.
  {
    const { dir } = scratch();
    const l = new Logger().open(dir, false);
    l.info('sync', 'this must not be written');
    eq(l.enabled, false, 'a logger opened with the setting off stays off');
    eq(l.read(), '', 'and writes nothing');
    ok(!fs.existsSync(l.path()), 'the file is not even created');
    const { defaultPrefs } = require('../src/main/config');
    eq(defaultPrefs().log, false, 'the preference itself is off out of the box');
  }

  // (b) One session, one file: it is emptied at every launch.
  {
    const { dir } = scratch();
    new Logger().open(dir, true).info('sync', 'run of yesterday');
    const again = new Logger().open(dir, true);
    eq(again.read(), '', 'the next launch starts on a clean page');
    again.info('sync', 'run of today');
    ok(/run of today/.test(again.read()), 'and records this session');
    ok(!/run of yesterday/.test(again.read()), 'with nothing left of the last one');
  }

  // (c) Turning it on mid-session also starts fresh, so what gets sent is the
  //     reproduction the user just did and not what came before.
  {
    const { dir } = scratch();
    const l = new Logger().open(dir, true);
    l.info('sync', 'before');
    l.setEnabled(false);
    l.info('sync', 'while off');
    ok(!/while off/.test(l.read()), 'nothing is written while it is off');
    l.setEnabled(true, { version: '0.6.3', platform: 'darwin', arch: 'arm64',
                         electron: '43', node: '22', userData: dir });
    ok(!/before/.test(l.read()), 'turning it back on clears what came before');
    ok(/syncto 0\.6\.3 · darwin arm64/.test(l.read()), 'and writes a fresh header');
    l.info('sync', 'after');
    ok(/after/.test(l.read()), 'then records normally');
  }

  // (d) 🔴 NEVER A PASSWORD. A folder field accepts "sftp://user:secret@host",
  //     and a log people send by email is the last place for it.
  {
    eq(redact('sftp://noar:hunter2@nas.local/vol1/RUSHES'),
       'sftp://noar@nas.local/vol1/RUSHES', 'a password in a URL is removed');
    eq(redact('failed on sftp://u:p@h/x — Permission denied'),
       'failed on sftp://u@h/x — Permission denied', 'including inside a sentence');
    eq(redact('ssh://a:b@c/d and sftp://e:f@g/h'),
       'ssh://a@c/d and sftp://e@g/h', 'every one of them');
    eq(redact('/Volumes/NAS/a:b/file.mov'), '/Volumes/NAS/a:b/file.mov',
       'an ordinary path with a colon is left alone');
    eq(redact(null), '', 'and nothing at all is not a crash');

    const { dir } = scratch();
    const l = new Logger().open(dir, true);
    l.info('sync', 'pair 1: sftp://noar:hunter2@nas/vol → /local');
    l.error('sftp', 'boom', 'sftp://noar:hunter2@nas/vol');
    ok(!/hunter2/.test(l.read()), 'nothing that reaches the file carries the password');
    ok(/noar@nas/.test(l.read()), 'while the rest of the address is still readable');
  }

  // (e) It stops at a ceiling instead of filling the disk, and says so.
  {
    const { dir } = scratch();
    const l = new Logger().open(dir, true);
    const big = 'x'.repeat(64 * 1024);
    for (let i = 0; i < Math.ceil(MAX_BYTES / (64 * 1024)) + 2; i++) l.info('t', big);
    ok(l.capped, 'it stops once the session has produced enough');
    const st = fs.statSync(l.path());
    ok(st.size < MAX_BYTES * 1.1, 'the file does not run away');
    ok(/stopped here/.test(l.read()), 'and the file says why it ends there');
  }

  // (f) A log that cannot be written must never take the run with it.
  {
    // A file where a directory is expected: mkdir under it is ENOTDIR on every
    // platform, which is the cleanest way to make opening the log fail.
    const { dir } = scratch();
    const blocked = path.join(dir, 'not-a-folder');
    fs.writeFileSync(blocked, 'x');
    const l = new Logger().open(blocked, true);
    eq(l.enabled, false, 'an unwritable profile simply disables it');
    l.info('sync', 'still fine');           // must not throw
    eq(l.read(), '', 'and reading it back is empty rather than an error');
    ok(true, 'nothing threw');
  }

  // (g) begin/end is what answers "which request never came back": a start
  //     line with no matching end line is the one that hung.
  {
    const { dir } = scratch();
    const l = new Logger().open(dir, true);
    const t = l.begin('sftp', 'stat /vol/x');
    t.end();
    const hung = l.begin('sftp', 'read /vol/huge.mov');   // deliberately never ended
    ok(/→ stat \/vol\/x/.test(l.read()), 'a request is logged when it starts');
    ok(/← stat \/vol\/x/.test(l.read()), 'and again when it comes back');
    ok(/→ read \/vol\/huge\.mov/.test(l.read()), 'the one still in flight has its start line');
    ok(!/← read \/vol\/huge\.mov/.test(l.read()), 'and no end line — which is the tell');
    l.begin('sftp', 'unlink /vol/y').fail(Object.assign(new Error('Permission denied'), { code: 'EACCES' }));
    ok(/failed: unlink \/vol\/y/.test(l.read()), 'a failure names the operation');
    ok(/EACCES/.test(l.read()), 'with the code the server gave');
    ok(hung, 'the timer object exists');
  }

  // (i) The three ways a run could sit there doing nothing while the buttons
  //     did nothing either. All reported from a real transfer to a NAS.
  {
    const sync = fs.readFileSync(path.join(__dirname, '..', 'src/main/core/sync.js'), 'utf8');
    const lock = fs.readFileSync(path.join(__dirname, '..', 'src/main/core/lock.js'), 'utf8');
    const sess = fs.readFileSync(path.join(__dirname, '..', 'src/main/core/session.js'), 'utf8');

    // PAUSE only worked BETWEEN files. On a server at 1.5 MB/s one 17 MB track
    // is eleven seconds of a button that appears dead.
    ok(/token\.paused && !held/.test(sync), 'pause is honoured during a file, not only between two');
    ok(/rs\.pause\(\);/.test(sync) && /held = false; rs\.resume\(\);/.test(sync),
       'the read is actually held and resumed');

    // readLockInfo is a RAW stream: the 45 s deadline on queued requests does
    // not cover it, and release() runs in a finally — so a read that never
    // delivered left the whole run unsettled at 100%.
    ok(/READ_LOCK_TIMEOUT_MS/.test(lock), 'reading a lock file cannot wait for ever');
    ok(/\} finally \{[\s\S]{0,600}?await locks\.release\(\);/.test(sess),
       'the locks are still released whatever happened');
    ok(/Releasing the folder locks/.test(sess), 'and the window says so instead of a silent 100%');
    ok(/cleanup: sweeping leftovers/.test(sync) && /cleanup: done/.test(sync),
       'the finishing phase leaves a trail in the log');
  }

  // (h) The wiring: a switch in the settings, and the log readable and
  //     copyable from that window rather than from a Finder window.
  {
    const html  = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/index.html'), 'utf8');
    const appjs = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/app.js'), 'utf8');
    const pre   = fs.readFileSync(path.join(__dirname, '..', 'src/main/preload.js'), 'utf8');
    const main  = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8');
    ok(html.includes('id="st-log"'), 'the settings carry the switch');
    ok(html.includes('id="st-log-text"'), 'and show the log');
    ok(/data-copy="st-log-text"/.test(html), 'with the copy button the error panels use');
    ok(/ipcMain\.handle\('log-set'/.test(main) && /ipcMain\.handle\('log-info'/.test(main),
       'main answers on both channels');
    ok(/logSet\s*:.*invoke\('log-set'/.test(pre), 'preload exposes the switch');
    ok(/log\.open\(app\.getPath\('userData'\), !!prefs\.data\.log\)/.test(main),
       'and the launch opens it according to the preference');
    ok(/setCopyBlock\('st-log-text'/.test(appjs), 'the whole log is what gets copied');
    // 🔴 The panel was filled once at launch and never again: it showed the
    //    three header lines for the rest of the session while the file on disk
    //    held the whole run, and Copy copied that stale snapshot.
    ok(/startLogWatch\(\);/.test(appjs), 'opening the settings re-reads the log');
    ok(/logWatchTimer = setInterval/.test(appjs),
       'and it keeps re-reading, so a run in progress can be watched');
    ok(/stopLogWatch\(\)/.test(appjs), 'stopped when the window closes');
    ok(/const atBottom = /.test(appjs),
       'a refresh does not yank the view back down while something is being read');
    ok(html.includes('id="st-log-save"') && /ipcMain\.handle\('log-save'/.test(main),
       'and it can be saved as a .txt to attach to a message');
    // The engine writes it, not the window: what matters is what the server
    // actually answered, not what the interface believed.
    const sftp = fs.readFileSync(path.join(__dirname, '..', 'src/main/fs/sftp.js'), 'utf8');
    ok(/log\.begin\('sftp'/.test(sftp), 'every server request is timed');
    ok(/TIMED OUT/.test(sftp), 'and a request that never answers says so');
    // A disconnection we asked for fires the same handler a dropped one does.
    // Logged at ERROR, it sent the reader of a support log hunting for a fault
    // that was never there.
    ok(/this\.closing = true;/.test(sftp) && /if \(this\.closing\) log\.info/.test(sftp),
       'a deliberate disconnection is not reported as an error');
  }
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

  // (d) During a run the progress panel takes the working area. Same elements,
  //     same ids — only the shape changes, so every line that updates them
  //     keeps working whichever form they are wearing.
  ok(/\$\('bottombar'\)\.classList\.toggle\('kiosk', !!\(on && steps\)\);/.test(appjs),
     'a run gets the big view');
  ok(/classList\.toggle\('running', !!\(on && steps\)\)/.test(appjs), 'and the window says it is running');
  ok(/#app\.running #statusbar\{display:none;\}/.test(html), 'the chips describing the old comparison go away');
  ok(/#app\.running #sidebar\{pointer-events:none;\}/.test(html),
     'and the sidebar stops taking clicks, since they would change the plan and not the run');
  ok(/#bottombar\.kiosk\{position:absolute;inset:0;/.test(html), 'the panel covers the working area');
  // Frosted rather than opaque: the comparison stays visible underneath, so
  // the run reads as something happening ON the window, not a second screen.
  const kioskCss = html.slice(html.indexOf('#bottombar.kiosk{position:absolute'), html.indexOf('#bottombar.kiosk .pb-track-top'));
  const alpha = /background:rgba\(\d+,\d+,\d+,\.(\d+)\)/.exec(kioskCss);
  ok(alpha && Number('0.' + alpha[1]) < 0.75, 'its background lets the window show through');
  ok(/backdrop-filter:blur\(\d+px\)/.test(kioskCss) && /-webkit-backdrop-filter:blur/.test(kioskCss),
     'and what shows through is blurred, on both spellings of the property');
  // Order matters: `#bottombar.open` sets a fixed height, so the kiosk rule has
  // to come after it or the panel stays a 196 px strip.
  ok(html.indexOf('#bottombar.open{height:196px;}') < html.indexOf('#bottombar.kiosk{position:absolute'),
     'and its rule comes after the one that fixes the strip height');
  // A comparison keeps the strip: the grid behind it is filling up.
  ok(/setBusyUi\(true, 'Comparing…'\)/.test(appjs) || /setBusyUi\(true, title\)/.test(appjs) ||
     /setBusyUi\(true, 'Checking the result…'\)/.test(appjs), 'a comparison is still announced in the strip');

  // (e) 🔴 The wait after a run had no name. syncto compares both folders again
  //     to confirm the result — seconds of a window answering to nothing, right
  //     after a run, which reads as a crash.
  const quiet = appjs.slice(appjs.indexOf('async function doCompareQuiet'));
  ok(/setBusyUi\(true, 'Checking the result…'\)/.test(quiet.slice(0, 1200)), 'the re-comparison shows itself');
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

  // (d) 🔴 Two copies of syncto running side by side shared one log file. It
  //     is emptied at launch, so the second to start wiped the first one's and
  //     the two then wrote into it at once.
  {
    const { Logger } = require('../src/main/log');
    const { dir } = scratch();
    const l = new Logger().open(dir, true);
    l.info('t', 'hello');
    ok(l.path().includes(String(process.pid)), 'the log file carries the process id');
    ok(/hello/.test(l.read()), 'and is written normally');

    const logs = path.join(dir, 'logs');
    const dead = path.join(logs, 'syncto-999999.log');
    fs.writeFileSync(dead, 'from a run that is over');
    new Logger().open(dir, true);
    ok(!fs.existsSync(dead), 'the log of a process that has ended is removed');
    ok(fs.existsSync(l.path()), 'and the one of a process that is running is not');

    const theirs = path.join(logs, 'notes.txt');
    fs.writeFileSync(theirs, 'not mine');
    new Logger().open(dir, true);
    ok(fs.existsSync(theirs), 'and a file that is not a syncto log is never touched');
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
    ok(/renderSteps\(p\.pass, p\.willVerify\)/.test(appjs), 'and the steps drop the pass that will not happen');
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

  // A hint that describes a safety behaviour has to describe the one in the
  // code: the abandoned-lock window moved from 12 to 60 seconds in 0.6.2 and
  // the settings panel kept telling people 12.
  {
    const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
    const { DETECT_ABANDONED_MS } = require('../src/main/core/lock');
    const m = /taken over after (\d+)&nbsp;seconds/.exec(html);
    ok(m, 'the panel says when an abandoned lock is taken over');
    eq(Number(m[1]) * 1000, DETECT_ABANDONED_MS, 'and says the number the engine actually uses');
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
    const colour = { 'arr-add': 'g', 'arr-upd': 'o', 'arr-del': 'r', 'arr-mov': 'b', 'arr-cfl': 'r' };
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
    ok(/OPENABLE\s*=\s*new Set/.test(main) && /open-path[\s\S]{0,700}OPENABLE\.has/.test(main),
       'open-path opens a document or a folder, not whatever it is handed');
    ok(/sameServer\s*\?\s*cfg\.token\s*:\s*''/.test(main),
       'and the stored ntfy token never travels to a server the window named');
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

  // (d) 🔴 The report could never say "failed verification": it read a key
  //     the payload did not carry, so it printed the green "Not one differed"
  //     over a run that had found corruption.
  {
    const { buildReport, toHtml } = require('../src/main/core/report');
    const rep = buildReport({
      pairName: 'PROJET', leftPath: '/a', rightPath: '/b', variant: 'mirror',
      compareVariant: 'timeSize', startedAt: 1, endedAt: 2, stats: {},
      run: {
        results: [{ rel: 'c1', ok: true }],
        counters: { files: 5, bytes: 10 }, verified: 3, notes: [],
        errors: [{ rel: 'c2', message: 'Checksum mismatch (xxh64).' },
                 { rel: 'c3', message: 'Checksum mismatch (xxh64).' }],
      },
    });
    eq(rep.errors.length, 2, 'the run’s errors reach the report');
    const html = toHtml(rep);
    ok(/2 files failed verification/.test(html), 'and the banner says so');
    ok(!/Not one differed/.test(html), 'instead of claiming the opposite');
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
      eq(c.dropUnproven(), 0, 'cancelling is not a failure of proof');
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
    ok(/const VARIANT_LABEL = \{ twoWay: 'Two way'/.test(app), 'the mode names live in one place');
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
    ];
    const only = (process.env.SYNCTO_ONLY || '').split(',').map(x => x.trim()).filter(Boolean);
    for (const section of SECTIONS) {
      if (only.length && !only.includes(section.name)) continue;
      await section();
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
