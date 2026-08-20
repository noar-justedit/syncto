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

const API = window.syncto;
const $  = id => document.getElementById(id);
const ROWH = 26;

const state = {
  job    : null,
  view   : { showEqual: false, showExcluded: false, search: '', onlyCategory: '', onlyOperation: '' },
  total  : 0,
  stats  : null,
  rows   : new Map(),        // absolute row index -> row object
  busy   : null,             // 'compare' | 'sync' | null
  paused : false,
  jobPath: '',
  recent : [],               // zone 1 — last used jobs
  dirty  : false,
  speeds : [],
  version: '',
  auto   : { nextAt: 0, tick: null },   // auto-sync scheduler
  selIdx : null,                        // selected grid row (node idx)
};

// A job always carries a pairs array; old shapes are migrated on sight.
function ensurePairs(j) {
  if (!Array.isArray(j.pairs) || !j.pairs.length) {
    j.pairs = [{ left: j.left || '', right: j.right || '' }];
  }
  j.pairs = j.pairs.map(p => ({ left: p.left || '', right: p.right || '' }));
  delete j.left; delete j.right;
  return j;
}

// Pairs 2..N as stacked SOURCE/DESTINATION rows under the main fields —
// the FreeFileSync layout: every pair visible and editable at once.
function renderPairRows() {
  const j = state.job;
  const RM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
  const ARR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>';
  $('pairrows').innerHTML = j.pairs.slice(1).map((p, k) => {
    const i = k + 1;
    return `<div class="prow" data-i="${i}">
      <span class="pr-num" data-tip="Folder pair ${i + 1}">${i + 1}</span>
      <div class="pr-field">
        <input class="pr-left" value="${esc(p.left)}" placeholder="Source folder" spellcheck="false">
        <button class="br-btn pr-browse-l">Browse</button>
      </div>
      <span class="pr-gap">${ARR}</span>
      <div class="pr-field">
        <input class="pr-right" value="${esc(p.right)}" placeholder="Destination folder" spellcheck="false">
        <button class="br-btn pr-browse-r">Browse</button>
      </div>
      <button class="pr-rm" data-tip="Remove this pair">${RM}</button>
    </div>`;
  }).join('');
}

// ── Formatting ─────────────────────────────────────────────────────────────
function fmtBytes(b) {
  const n = Number(b) || 0;
  if (n === 0) return '0 B';
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let i = -1, v = n;
  do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
  return v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0) + ' ' + u[i];
}
function fmtSpeed(bps) { return bps > 0 ? fmtBytes(bps) + '/s' : '—'; }
function fmtEta(sec) {
  if (sec == null || !isFinite(sec) || sec < 0) return '—';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(r).padStart(2, '0')}s`;
  return `${r}s`;
}
function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// Escapes for BOTH text content and attribute values — esc() output lands in
// value="…" and data-path="…" attributes, so an unescaped quote in a file or
// folder name would break out of the attribute and corrupt the path it carries.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Action column: Lucide arrows, colour-coded ─────────────────────────────
//   green  = added   orange = updated   red = deleted   violet = renamed
const SVG_ARR_R = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>';
const SVG_ARR_L = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>';
const SVG_X     = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
const SVG_WARN  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';

// Per operation: arrow markup + extra class on the action cell + row tint +
// which side's name gets coloured with which class.
const OP_VIEW = {
  createRight   : { arr: SVG_ARR_R, cls: 'arr-add', row: 'rowadd', nameL: 'nm-add' },
  createLeft    : { arr: SVG_ARR_L, cls: 'arr-add', row: 'rowadd', nameR: 'nm-add' },
  overwriteRight: { arr: SVG_ARR_R, cls: 'arr-upd', row: 'rowupd', nameR: 'nm-upd' },
  overwriteLeft : { arr: SVG_ARR_L, cls: 'arr-upd', row: 'rowupd', nameL: 'nm-upd' },
  deleteRight   : { arr: SVG_X, cls: 'arr-del a-del-right', row: 'rowdel', nameR: 'nm-del' },
  deleteLeft    : { arr: SVG_X, cls: 'arr-del a-del-left',  row: 'rowdel', nameL: 'nm-del' },
  moveRightTo   : { arr: SVG_ARR_R, cls: 'arr-mov', row: 'rowmov', nameL: 'nm-mov', nameR: 'nm-mov' },
  moveRightFrom : { arr: SVG_ARR_R, cls: 'arr-mov dimmed', row: 'rowmov', nameL: 'nm-mov', nameR: 'nm-mov' },
  moveLeftTo    : { arr: SVG_ARR_L, cls: 'arr-mov', row: 'rowmov', nameL: 'nm-mov', nameR: 'nm-mov' },
  moveLeftFrom  : { arr: SVG_ARR_L, cls: 'arr-mov dimmed', row: 'rowmov', nameL: 'nm-mov', nameR: 'nm-mov' },
  conflict      : { arr: SVG_WARN, cls: 'arr-cfl', row: 'rowcfl' },
  none          : { arr: '<span class="eq">=</span>', cls: '', row: '' },
  doNothing     : { arr: '<span class="eq">–</span>', cls: '', row: '' },
};

const CAT_LABEL = {
  equal: 'identical', leftOnly: 'left only', rightOnly: 'right only',
  leftNewer: 'left newer', rightNewer: 'right newer', different: 'different',
  timeInvalid: 'invalid date', conflict: 'conflict',
};

// ── Job binding ────────────────────────────────────────────────────────────
function renderFilterBtn() {
  const j = state.job;
  const active = (j.compare.includeFilter || '*').trim() !== '*' ||
                 (j.compare.excludeFilter || '').trim() !== '';
  $('btn-filter').classList.toggle('on', active);
}

function renderJobTitle() {
  const el = $('job-title');
  if (state.jobPath) el.textContent = state.job.name || 'Untitled';
  else el.innerHTML = '<span class="unsaved">Untitled — not saved yet</span>';
}

function jobToUi() {
  const j = ensurePairs(state.job);
  renderJobTitle();
  $('left-path').value  = j.pairs[0].left  || '';
  $('right-path').value = j.pairs[0].right || '';
  // Pair 1 can be removed exactly like any other — hidden only when it's the
  // job's last remaining pair, same rule that governs every other row.
  $('pair0-rm').style.display = j.pairs.length > 1 ? '' : 'none';
  renderPairRows();

  setSeg('seg-cmp', j.compare.compareVariant);
  setVariantBtn(j.sync.variant);
  setCopyModeBtn(j.sync.copyLevel);

  $('st-moves').checked  = j.compare.detectMoves !== false;
  $('st-include').value  = j.compare.includeFilter;
  $('st-exclude').value  = j.compare.excludeFilter;
  renderFilterBtn();

  // Versioning is no longer exposed: a job that carried it falls back to trash.
  $('st-deletion').value  = j.sync.deletion === 'versioning' ? 'recycler' : j.sync.deletion;
  $('st-perm-fallback').checked = !!j.sync.permanentFallback;

  $('st-cksum').checked    = !!j.sync.writeChecksumList;
  $('st-lock').checked     = j.sync.lockFolders !== false;
  $('st-failsafe').checked = j.sync.failSafe !== false;
  $('st-times').checked    = j.sync.preserveTimes !== false;
  $('st-perms').checked    = !!j.sync.copyPermissions;
  $('st-retry').value      = j.sync.retryCount;
  $('st-retry-delay').value= Math.round((j.sync.retryDelayMs || 5000) / 1000);
  $('st-ignore').checked   = !!j.sync.ignoreErrors;

  $('st-rep').checked      = !!j.sync.report.enabled;
  $('st-rep-html').checked = !!j.sync.report.html;
  $('st-rep-csv').checked  = !!j.sync.report.csv;
  $('st-rep-json').checked = !!j.sync.report.json;
  $('st-rep-folder').value = j.sync.report.folder || '';

  for (const sel of document.querySelectorAll('select.cust')) {
    sel.value = j.sync.custom[sel.dataset.k] || 'none';
  }
  $('custom-section').style.display = j.sync.variant === 'custom' ? '' : 'none';

  const auto = j.autoSync || { enabled: false, minutes: 30 };
  $('auto-min').value = auto.minutes;
  if (auto.enabled && !state.auto.tick) autoStart();
  if (!auto.enabled && state.auto.tick) autoStop();
  renderAutoBtn();
}

function uiToJob() {
  const j = ensurePairs(state.job);
  j.pairs[0].left  = $('left-path').value.trim();
  j.pairs[0].right = $('right-path').value.trim();
  for (const row of document.querySelectorAll('#pairrows .prow')) {
    const i = Number(row.dataset.i);
    if (!j.pairs[i]) continue;
    j.pairs[i].left  = row.querySelector('.pr-left').value.trim();
    j.pairs[i].right = row.querySelector('.pr-right').value.trim();
  }

  // Time tolerance (2 s), DST shifts, symlink policy and the size filter keep
  // their engine defaults — deliberately not exposed in the settings.
  j.compare.detectMoves   = $('st-moves').checked;
  j.compare.includeFilter = $('st-include').value || '*';
  j.compare.excludeFilter = $('st-exclude').value || '';

  j.sync.deletion = $('st-deletion').value;
  j.sync.permanentFallback = $('st-perm-fallback').checked;

  j.sync.writeChecksumList = $('st-cksum').checked;
  j.sync.lockFolders       = $('st-lock').checked;
  j.sync.failSafe          = $('st-failsafe').checked;
  j.sync.preserveTimes     = $('st-times').checked;
  j.sync.copyPermissions   = $('st-perms').checked;
  j.sync.retryCount        = Math.max(0, parseInt($('st-retry').value, 10) || 0);
  j.sync.retryDelayMs      = Math.max(1, parseInt($('st-retry-delay').value, 10) || 5) * 1000;
  j.sync.ignoreErrors      = $('st-ignore').checked;

  j.sync.report.enabled = $('st-rep').checked;
  j.sync.report.html    = $('st-rep-html').checked;
  j.sync.report.csv     = $('st-rep-csv').checked;
  j.sync.report.json    = $('st-rep-json').checked;
  j.sync.report.folder  = $('st-rep-folder').value.trim();

  for (const sel of document.querySelectorAll('select.cust')) j.sync.custom[sel.dataset.k] = sel.value;

  if (!j.autoSync) j.autoSync = { enabled: false, minutes: 30 };
  j.autoSync.minutes = Math.min(1440, Math.max(1, parseInt($('auto-min').value, 10) || 30));
  renderFilterBtn();
  return j;
}

function setSeg(id, value) {
  for (const b of $(id).querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === value);
}

// ── Mode buttons (ingesto design) ──────────────────────────────────────────
function setVariantBtn(v) {
  for (const b of document.querySelectorAll('#syncmodes .mbtn')) b.classList.toggle('on', b.dataset.v === v);
  $('custom-section').style.display = v === 'custom' ? '' : 'none';
}

function setCopyModeBtn(v) {
  for (const b of document.querySelectorAll('#bottom-controls .modes-row .mbtn')) {
    b.classList.toggle('on', b.dataset.v === v);
  }
}

// ── Grid ───────────────────────────────────────────────────────────────────
let fetchSeq = 0;

async function refreshGrid(resetScroll) {
  const scroll = $('gridscroll');
  if (resetScroll) scroll.scrollTop = 0;
  const res = await API.getRows(0, 1, state.view);
  state.total = res.total;
  $('gridspacer').style.height = (state.total * ROWH) + 'px';
  $('gridscroll').style.display = state.total ? '' : 'none';
  $('gridempty').style.display  = state.total ? 'none' : '';
  $('grid-empty-msg').innerHTML = state.stats
    ? 'Nothing to show here. Everything is already in sync, or the view filters are hiding it — try <b>Show identical</b>.'
    : 'Pick two folders, then press <b>Compare</b>.';
  state.rows.clear();
  await renderWindow();
}

async function renderWindow() {
  const scroll = $('gridscroll');
  const first  = Math.max(0, Math.floor(scroll.scrollTop / ROWH) - 6);
  const count  = Math.ceil(scroll.clientHeight / ROWH) + 14;
  const seq = ++fetchSeq;
  const res = await API.getRows(first, count, state.view);
  if (seq !== fetchSeq) return;
  state.total = res.total;
  $('gridspacer').style.height = (state.total * ROWH) + 'px';

  const body = $('gridbody');
  body.style.transform = `translateY(${first * ROWH}px)`;
  body.innerHTML = res.rows.map((r, i) => rowHtml(r, first + i)).join('');
  res.rows.forEach((r, i) => state.rows.set(first + i, r));
}

const ICON_FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>';
const ICON_FILE   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>';

// One pane cell: the item as it exists on that side, or blank when it does not
// exist there — the row alignment against the other pane says the rest.
function paneCell(r, side, nameCls, indent) {
  const s = side === 'left' ? r.l : r.r;
  if (!s) return `<div class="c-path${side === 'right' ? ' pane-r' : ''}"></div>`;
  const icon = r.type === 'folder' ? ICON_FOLDER : ICON_FILE;
  const dir = r.rel.includes('/') ? r.rel.slice(0, r.rel.lastIndexOf('/') + 1) : '';
  return `<div class="c-path${side === 'right' ? ' pane-r' : ''}" style="padding-left:${8 + indent}px">
    <span class="ic">${icon}</span>
    <span class="nm${nameCls ? ' ' + nameCls : ''}"><span class="dim">${esc(dir)}</span>${esc(r.name)}</span>
  </div>`;
}

const GH_ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>';

function rowHtml(r, absIndex) {
  if (r.hdr) {
    return `<div class="grow grow-hdr" data-tip="Pair ${r.pair}/${r.pairs}: ${esc(r.left)} → ${esc(r.right)}">
      <span class="gh-num">PAIR ${r.pair}</span>
      <span class="gh-path">${esc(r.left)}</span>
      <span class="gh-arrow">${GH_ARROW}</span>
      <span class="gh-path">${esc(r.right)}</span>
      <span class="gh-todo">${r.todo ? r.todo + ' to process' : 'in sync'}</span>
    </div>`;
  }
  const indent = Math.min(r.depth, 8) * 11;
  const v = OP_VIEW[r.op] || OP_VIEW.doNothing;
  let tipText = r.catMsg || CAT_LABEL[r.cat] || r.cat;
  if (r.mv) {
    tipText = r.op.endsWith('From')
      ? `detected move — will be renamed to ${r.mv}, nothing re-copied`
      : `detected move — will be renamed from ${r.mv}, nothing re-copied`;
  }
  return `<div class="grow${r.active ? '' : ' off'}${v.row ? ' ' + v.row : ''}${r.idx === state.selIdx ? ' sel' : ''}" data-i="${absIndex}" data-idx="${r.idx}" data-tip="${esc(tipText)}">
    <div class="c-chk"><input type="checkbox" ${r.active ? 'checked' : ''} data-act="toggle"></div>
    ${paneCell(r, 'left', v.nameL, indent)}
    <div class="num">${r.l && r.type !== 'folder' ? fmtBytes(r.l.size) : ''}</div>
    <div class="dt">${r.l ? fmtDate(r.l.mtime) : ''}</div>
    <div class="c-act ${v.cls}" data-act="cycle">${v.arr}</div>
    ${paneCell(r, 'right', v.nameR, indent)}
    <div class="num">${r.r && r.type !== 'folder' ? fmtBytes(r.r.size) : ''}</div>
    <div class="dt">${r.r ? fmtDate(r.r.mtime) : ''}</div>
  </div>`;
}

// Clicking the action cell walks through the three sensible directions.
const DIR_CYCLE = { right: 'left', left: 'none', none: 'right', conflict: 'right' };

$('gridbody').addEventListener('click', async e => {
  const row = e.target.closest('.grow');
  if (!row || row.dataset.idx == null) return;   // pair headers are inert
  const idx = Number(row.dataset.idx);
  const hit = e.target.closest('[data-act]');
  const act = hit ? hit.dataset.act : '';
  if (act === 'toggle') {
    const on = hit.querySelector('input') ? hit.querySelector('input').checked : e.target.checked;
    state.stats = await API.setActive([idx], on);
    afterEdit();
  } else if (act === 'cycle') {
    const r = state.rows.get(Number(row.dataset.i));
    const next = DIR_CYCLE[r ? r.dir : 'none'] || 'right';
    state.stats = await API.setDirection([idx], next);
    afterEdit();
  } else {
    // Plain click: select the row (Space then toggles its exclusion).
    state.selIdx = state.selIdx === idx ? null : idx;
    await renderWindow();
  }
});

// ── Context menu — right-click on a row, FreeFileSync style ────────────────
function closeCtx() {
  const m = document.getElementById('ctx-menu');
  if (m) m.remove();
}

// The filter suggestions for one item, most specific last — same spirit as
// FreeFileSync's submenu: by extension, by name anywhere, by exact path.
function filterVariants(r) {
  const out = [];
  if (r.type !== 'folder') {
    const dot = r.name.lastIndexOf('.');
    if (dot > 0) out.push('*' + r.name.slice(dot));   // every file with this extension, anywhere
    out.push(r.name);                                  // every item with this exact name, anywhere
    out.push('/' + r.rel);                             // this one item only
  } else {
    out.push(r.name + '/');                            // every folder with this name, anywhere
    out.push('/' + r.rel + '/');                       // this one folder only
  }
  return out;
}

async function addFilterPattern(kind, pattern) {
  uiToJob();
  const j = state.job;
  if (kind === 'exclude') {
    j.compare.excludeFilter = j.compare.excludeFilter.trim()
      ? j.compare.excludeFilter.trim() + '\n' + pattern
      : pattern;
  } else {
    // Include: a lone '*' means "everything", so the first real pattern
    // replaces it — after that, patterns accumulate.
    const cur = j.compare.includeFilter.trim();
    j.compare.includeFilter = (!cur || cur === '*') ? pattern : cur + '\n' + pattern;
  }
  jobToUi();
  renderFilterBtn();
  persist();
  await doCompare();   // re-apply the filter right away, like FFS
}

async function toggleExcludeTemp(idx) {
  state.stats = await API.toggleActive([idx]);
  afterEdit();
  await refreshOverview();
}

const CTX_OK = '<svg class="ok" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>';
const CTX_KO = '<svg class="ko" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>';
const CTX_SQ = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>';
const CTX_SQ_CHK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>';

function openCtx(x, y, r) {
  closeCtx();
  const variants = filterVariants(r);
  const sub = kind => variants.map(v =>
    `<div class="ctx-it" data-k="${kind}" data-p="${esc(v)}"><span class="lbl">${esc(v)}</span></div>`).join('');

  const m = document.createElement('div');
  m.id = 'ctx-menu';
  m.className = 'ctx';
  m.innerHTML =
    `<div class="ctx-it" data-k="temp">${r.active ? CTX_SQ : CTX_SQ_CHK}<span class="lbl">Exclude temporarily</span><span class="key">Space</span></div>` +
    `<div class="ctx-sep"></div>` +
    `<div class="ctx-it">${CTX_OK}<span class="lbl">Include via filter</span><span class="sub-arrow">▶</span><div class="ctx-sub">${sub('include')}</div></div>` +
    `<div class="ctx-it">${CTX_KO}<span class="lbl">Exclude via filter</span><span class="sub-arrow">▶</span><div class="ctx-sub">${sub('exclude')}</div></div>`;
  document.body.appendChild(m);

  // Keep it on screen.
  const rct = m.getBoundingClientRect();
  m.style.left = Math.min(x, window.innerWidth - rct.width - 8) + 'px';
  m.style.top  = Math.min(y, window.innerHeight - rct.height - 8) + 'px';

  m.addEventListener('click', async e => {
    const it = e.target.closest('.ctx-it[data-k]');
    if (!it) return;
    e.stopPropagation();
    closeCtx();
    if (it.dataset.k === 'temp') await toggleExcludeTemp(r.idx);
    else await addFilterPattern(it.dataset.k, it.dataset.p);
  });
}

$('gridbody').addEventListener('contextmenu', async e => {
  e.preventDefault();
  const row = e.target.closest('.grow');
  if (!row || row.dataset.idx == null) return;
  const idx = Number(row.dataset.idx);
  state.selIdx = idx;
  await renderWindow();
  const r = state.rows.get(Number(row.dataset.i));
  if (r) openCtx(e.clientX, e.clientY, r);
});

document.addEventListener('mousedown', e => { if (!e.target.closest('.ctx')) closeCtx(); });
window.addEventListener('blur', closeCtx);
document.addEventListener('scroll', closeCtx, true);

// Space = exclude/include the selected row temporarily, like FFS.
document.addEventListener('keydown', async e => {
  if (e.key !== ' ' || state.selIdx == null) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT')) return;
  if (document.querySelector('.ov.open')) return;
  e.preventDefault();
  await toggleExcludeTemp(state.selIdx);
});

async function afterEdit() {
  renderStats();
  await renderWindow();
  renderAutoUi();
}

$('gridscroll').addEventListener('scroll', () => { renderWindow(); });
window.addEventListener('resize', () => { renderWindow(); });

// ── Status chips ───────────────────────────────────────────────────────────
function renderStats() {
  const s = state.stats;
  const box = $('stat-chips');
  if (!s) { box.innerHTML = ''; $('status-empty').style.display = ''; return; }
  $('status-empty').style.display = 'none';

  const chip = (cls, label, value, key, kind) =>
    `<span class="stat ${cls}${isActiveFilter(key, kind) ? ' on' : ''}" data-key="${key}" data-kind="${kind}">${label} <b>${value}</b></span>`;

  const parts = [];
  if (s.createRight) parts.push(chip('g', 'create →', s.createRight, 'createRight', 'op'));
  if (s.createLeft)  parts.push(chip('g', '← create', s.createLeft,  'createLeft',  'op'));
  if (s.updateRight) parts.push(chip('b', 'update →', s.updateRight, 'overwriteRight', 'op'));
  if (s.updateLeft)  parts.push(chip('b', '← update', s.updateLeft,  'overwriteLeft',  'op'));
  if (s.deleteRight) parts.push(chip('o', 'delete →', s.deleteRight, 'deleteRight', 'op'));
  if (s.deleteLeft)  parts.push(chip('o', '← delete', s.deleteLeft,  'deleteLeft',  'op'));
  if (s.moveRight)   parts.push(chip('v', 'move →',   s.moveRight,   'moveRightTo', 'op'));
  if (s.moveLeft)    parts.push(chip('v', '← move',   s.moveLeft,    'moveLeftTo',  'op'));
  if (s.conflicts)   parts.push(chip('r', 'conflicts', s.conflicts,  'conflict',    'op'));
  parts.push(chip('', 'identical', s.equal, 'none', 'op'));
  if (s.excluded)    parts.push(chip('', 'excluded', s.excluded, '', ''));
  box.innerHTML = parts.join('');

  const data = fmtBytes(s.bytesTotal);
  $('status-note').textContent =
    `${s.filesToProcess} item${s.filesToProcess === 1 ? '' : 's'} to process · ${data} to copy · ${s.rows} compared`;
}

function isActiveFilter(key, kind) {
  return (kind === 'op' && state.view.onlyOperation === key) ||
         (kind === 'cat' && state.view.onlyCategory === key);
}

$('stat-chips').addEventListener('click', async e => {
  const chip = e.target.closest('.stat');
  if (!chip || !chip.dataset.key) return;
  const key = chip.dataset.key;
  if (chip.dataset.kind === 'op') {
    state.view.onlyOperation = state.view.onlyOperation === key ? '' : key;
    if (key === 'none' && state.view.onlyOperation) state.view.showEqual = true;
  }
  renderStats();
  await refreshGrid(true);
});

// ── Compare ────────────────────────────────────────────────────────────────
function completePairs() {
  return state.job.pairs.filter(p => p.left.trim() && p.right.trim());
}

// Anything that changes WHICH folders are on screen invalidates the plan held
// in the engine. Without this, swapping the sides or loading another job left
// SYNCHRONIZE armed on the previous comparison: the dialog showed the new
// folders, the engine replayed the old plan, and a mirror went the wrong way.
function invalidateComparison(reason) {
  state.comparedPairs = null;
  state.stats = null;
  state.selIdx = null;
  const note = $('status-note');
  if (note) note.textContent = reason || 'Folders changed — compare again.';
  if (!state.busy) setBusyUi(false);
  refreshGrid(true).catch(() => {});
  refreshOverview().catch(() => {});
}

function pairsKey(pairs) {
  return (pairs || []).map(p => `${p.left} ${p.right}`).join('');
}

// Called from onPathChanged, which every path edit, browse, swap, pair add or
// remove, and job load funnels through.
function invalidateIfPairsChanged() {
  if (!state.comparedPairs) return;
  if (pairsKey(completePairs()) === state.comparedPairs) return;
  invalidateComparison('The folders changed — compare again before synchronizing.');
}

async function doCompare() {
  if (state.busy) return;
  uiToJob();
  if (!completePairs().length) { alert('Set both folders of at least one pair first.'); return; }

  state.selIdx = null;      // the old selection indexes a tree about to vanish
  state.busy = 'compare';
  state.speeds = [];
  setBusyUi(true, 'Comparing…');
  $('pb-title').textContent = 'Comparing…';
  $('btn-pause').style.display = 'none';

  const res = await API.compare(state.job);

  state.busy = null;
  setBusyUi(false);
  $('btn-pause').style.display = '';

  if (!res.ok) { invalidateComparison('Comparison failed — compare again.'); showError('Comparison failed', res.error); return; }

  // Aborted halfway: the tree covers only the part that was scanned. Showing
  // it is fine, arming SYNCHRONIZE on it is not — the engine refuses anyway,
  // and it used to report "completed successfully" over a partial copy.
  if (res.cancelled) {
    state.stats = null;
    await refreshGrid(true);
    await refreshOverview();
    renderStats();
    setBusyUi(false);
    $('status-note').textContent = 'Comparison stopped before the end — the list below is partial. Compare again to synchronize.';
    return;
  }

  state.stats = res.stats;
  state.comparedPairs = pairsKey(completePairs());
  state.view.onlyOperation = '';
  state.view.onlyCategory  = '';
  renderStats();
  await refreshGrid(true);
  await refreshOverview();
  renderAutoUi();

  const notes = [];
  if (res.movesFound) notes.push(`${res.movesFound} move${res.movesFound > 1 ? 's' : ''} detected — will rename, not re-copy`);
  if (res.dbNote) notes.push(res.dbNote);
  if (res.errors && res.errors.length) notes.push(`${res.errors.length} folder(s) could not be read`);
  if (notes.length) $('status-note').textContent += ' · ' + notes.join(' · ');
}

// ── Synchronize ────────────────────────────────────────────────────────────
function askConfirm() {
  const s = state.stats;
  uiToJob();
  const j = state.job;
  const VAR_LBL = { twoWay: 'Two way', mirror: 'Mirror →', update: 'Update →', custom: 'Custom' };
  const CMP_LBL = { timeSize: 'time & size', content: 'content', size: 'size' };
  const LVL_LBL = { fast: 'Fast', verified: 'Verified', secure: 'Secure (xxHash64)' };
  const np = completePairs().length;
  $('cf-sub').textContent =
    `${np} pair${np > 1 ? 's' : ''} · ${VAR_LBL[j.sync.variant] || j.sync.variant} · compared by ${CMP_LBL[j.compare.compareVariant]} · ${LVL_LBL[j.sync.copyLevel]} copy`;
  const cfCells = [
    ['Create', s.createLeft + s.createRight],
    ['Update', s.updateLeft + s.updateRight],
    ['Remove', s.deleteLeft + s.deleteRight],
    ['Data', fmtBytes(s.bytesTotal)],
    ['Conflicts', s.conflicts],
    ['Excluded', s.excluded],
  ];
  if (s.moveLeft + s.moveRight) cfCells.splice(3, 0, ['Move (rename)', s.moveLeft + s.moveRight]);
  $('cf-grid').innerHTML = cfCells
    .map(([l, v]) => `<div class="srow"><div class="sr-lbl">${l}</div><div class="sr-val">${v}</div></div>`).join('');

  const warns = [];
  const removals = s.deleteLeft + s.deleteRight;
  if (removals) {
    const how = j.sync.deletion === 'permanent' ? 'deleted permanently'
              : j.sync.deletion === 'versioning' ? 'moved to the revision folder'
              : 'moved to the trash';
    warns.push(`${removals} item${removals > 1 ? 's' : ''} will be ${how}.`);
  }
  if (s.conflicts) warns.push(`${s.conflicts} conflict${s.conflicts > 1 ? 's' : ''} will be skipped — resolve them by clicking their action cell.`);
  const changed = s.createLeft + s.createRight + s.updateLeft + s.updateRight + removals;
  if (changed >= 10 && changed > 0.5 * s.rows && (removals || s.updateLeft + s.updateRight)) {
    warns.push('More than half of the compared items are about to change. Check that both folders are the ones you meant.');
  }
  $('cf-warn').style.display = warns.length ? '' : 'none';
  $('cf-warn-body').innerHTML = warns.map(w => `<div class="err-item">${esc(w)}</div>`).join('');

  $('ov-confirm').classList.add('open');
}

async function doSync() {
  $('ov-confirm').classList.remove('open');
  if (state.busy) return;
  uiToJob();
  state.busy = 'sync';
  state.paused = false;
  state.speeds = [];
  setBusyUi(true, 'Synchronizing…');
  $('pb-title').textContent = 'Synchronizing…';

  const res = await API.sync(state.job);

  state.busy = null;
  setBusyUi(false);
  if (!res.ok) { showError('Synchronization failed', res.error); return; }
  showSummary(res);
  await doCompareQuiet();
}

// Re-compare after a run so the grid reflects reality without a full re-render
// of the user's intent. Silent: no dialogs. Guarded: it must never race a run
// the user just started, and the previous selection indexes a tree that no
// longer exists.
async function doCompareQuiet() {
  if (state.busy) return;
  // It never claimed the busy flag, so COMPARE and SYNCHRONIZE were live while
  // it ran. A second compare would then close the filesystem pool underneath
  // this one and reassign its sessions — phantom I/O errors, or two trees
  // mixed into one. The buttons stay disabled until it is done.
  state.busy = 'compare';
  $('btn-compare').disabled = true;
  $('btn-sync').disabled = true;
  state.selIdx = null;
  let res;
  try {
    res = await API.compare(state.job);
  } finally {
    state.busy = null;
  }
  if (!res || !res.ok || res.cancelled) { invalidateComparison('Compare again to synchronize.'); return; }
  state.stats = res.stats;
  state.comparedPairs = pairsKey(completePairs());
  renderStats();
  setBusyUi(false);
  await refreshGrid(true);
  await refreshOverview();
  renderAutoUi();
}

// ── Progress panel ─────────────────────────────────────────────────────────
const RING_LEN = 182.2;

function setBusyUi(on, title) {
  $('bottombar').classList.toggle('open', on);
  $('btn-compare').disabled = on;
  $('btn-sync').disabled = on || (isAutoOn() ? false : (!state.stats || state.stats.filesToProcess === 0));
  $('btn-abort').style.display = on ? '' : 'none';
  if (on) {
    $('pb-pct').textContent = '0%';
    $('pb-ring').setAttribute('stroke-dashoffset', RING_LEN);
    $('pb-fill').style.width = '0%';
    $('s-files').textContent = '—'; $('s-size').textContent = '—';
    $('s-spd').textContent = '—'; $('s-eta').textContent = '—';
    $('s-del').textContent = '0'; $('s-err').textContent = '0';
    $('pb-file').textContent = '—';
    if (title) $('pb-title').textContent = title;
    state.paused = false;
    const bar = $('bottombar');
    bar.style.setProperty('--pb-color', 'var(--green)');
    bar.style.setProperty('--pb-color2', '#00ffaa');
    bar.style.setProperty('--pb-glow', 'var(--green-g)');
    $('pb-title').style.color = '';
    const lbl = $('btn-pause-lbl'), ico = $('btn-pause-ico');
    if (lbl) lbl.textContent = 'PAUSE';
    if (ico) ico.innerHTML = '<rect x="14" y="3" width="5" height="18" rx="1"/><rect x="5" y="3" width="5" height="18" rx="1"/>';
    $('btn-pause').classList.remove('go');
    drawSpark([]);
  }
}

API.onCompareProgress(p => {
  const prefix = p.pairs > 1 ? `[${p.pair}/${p.pairs}] ` : '';
  $('pb-file').textContent = prefix + (p.current || '—');
  $('s-files').textContent = String(p.scanned || 0);
  $('s-size').textContent  = p.bytes ? fmtBytes(p.bytes) + ' read' : '—';
  // A comparison has no known total, so the ring breathes instead of filling.
  const pseudo = ((p.scanned || 0) % 500) / 500;
  $('pb-ring').setAttribute('stroke-dashoffset', RING_LEN * (1 - pseudo));
  $('pb-pct').textContent = '…';
});

API.onSyncProgress(p => {
  // Waiting on another machine's lock: no throughput to show, just who and how long.
  if (p.phase === 'lock') {
    $('pb-title').textContent = 'Waiting for another machine…';
    $('pb-file').textContent  = p.current || '';
    $('pb-pct').textContent   = '…';
    return;
  }
  const pct = p.bytesTotal > 0 ? Math.min(100, (p.bytesDone / p.bytesTotal) * 100)
            : p.filesTotal > 0 ? (p.filesDone / p.filesTotal) * 100 : 0;
  $('pb-pct').textContent = Math.round(pct) + '%';
  $('pb-ring').setAttribute('stroke-dashoffset', RING_LEN * (1 - pct / 100));
  $('pb-fill').style.width = pct + '%';
  $('pb-file').textContent = (p.pairs > 1 ? `[${p.pair}/${p.pairs}] ` : '') + (p.current || '—');

  // The verification pass gets its own identity, like ingesto: blue everywhere
  // — title, ring and top bar — so a read-back is never mistaken for a stall.
  // The colour variables live on #bottombar because the top fill bar is a
  // sibling of .pb-inner and would not inherit them otherwise.
  const verifying = p.pass === 'verify';
  const bar = $('bottombar');
  bar.style.setProperty('--pb-color',  verifying ? 'var(--blue)' : 'var(--green)');
  bar.style.setProperty('--pb-color2', verifying ? '#7bc8ff' : '#00ffaa');
  bar.style.setProperty('--pb-glow',   verifying ? 'rgba(77,144,240,.45)' : 'var(--green-g)');
  $('s-files').innerHTML   = `${p.filesDone}<span class="stot"> / ${p.filesTotal}</span>`;
  $('s-size').textContent  = fmtBytes(Math.max(0, p.bytesTotal - p.bytesDone));
  $('s-spd').textContent   = fmtSpeed(p.bytesPerSec);
  $('s-eta').textContent   = fmtEta(p.etaSec);
  $('s-del').textContent   = String(p.deleted || 0);
  $('s-err').textContent   = String(p.errors || 0);
  const lvlName = { fast: 'FAST', verified: 'VERIFIED', secure: 'SECURE' }[state.job.sync.copyLevel] || '';
  const title = $('pb-title');
  // After the verification pass only folder deletions and pruning remain —
  // nothing is being copied, so the title must not claim it is.
  title.textContent = p.paused ? 'Paused'
                    : verifying ? `VERIFYING · ${lvlName}`
                    : p.pass === 'cleanup' ? 'FINISHING…'
                    : `COPYING · ${lvlName}`;
  title.style.color = p.paused ? '' : (verifying ? 'var(--blue)' : 'var(--green)');

  state.speeds.push(p.bytesPerSec || 0);
  if (state.speeds.length > 70) state.speeds.shift();
  drawSpark(state.speeds);
});

function drawSpark(values) {
  const svg = $('pb-spark');
  if (!values.length) { svg.innerHTML = ''; return; }
  const max = Math.max(...values, 1);
  const n = values.length;
  const pts = values.map((v, i) => {
    const x = n === 1 ? 100 : (i / (n - 1)) * 100;
    const y = 28 - (v / max) * 26;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  svg.innerHTML =
    `<polygon class="spark-area" points="0,28 ${pts.join(' ')} 100,28"/>` +
    `<polyline class="spark-line" points="${pts.join(' ')}"/>`;
}

// ── Summary ────────────────────────────────────────────────────────────────
const ICO_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
const ICO_ERR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5"/><path d="M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg>';
const ICO_CANCEL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>';

function showSummary(res) {
  const failed = res.errors.length;
  const stopped = !!(res.stopped || res.lockLost);
  const kind = res.cancelled ? 'cancel' : (failed || stopped) ? 'err' : 'ok';
  $('sum-ico').className = 'sum-ico ' + kind;
  $('sum-ico').innerHTML = kind === 'ok' ? ICO_OK : kind === 'err' ? ICO_ERR : ICO_CANCEL;
  $('sum-h1').textContent = res.cancelled ? 'Cancelled'
    : res.lockLost ? 'Stopped — another machine took the folder'
    : stopped ? 'Stopped at the first error'
    : failed ? `Completed with ${failed} error${failed > 1 ? 's' : ''}` : 'Completed successfully';
  $('sum-h2').textContent = `${state.job.name} · ${fmtEta(res.durationMs / 1000)}`;

  const cells = [
    ['Files copied', res.counters.files],
    ['Data copied', fmtBytes(res.counters.bytes)],
    ['Folders created', res.counters.folders],
    ['Items removed', res.counters.deleted],
    ['Errors', res.errors.length],
    ['Average speed', res.durationMs > 0 ? fmtSpeed(res.counters.bytes / (res.durationMs / 1000)) : '—'],
  ];
  // "Files copied" is now the number that really landed, so the ones that
  // failed need a line of their own instead of hiding inside it.
  if (res.counters.failed) cells.splice(1, 0, ['Files not copied', res.counters.failed]);
  if (res.counters.moved) cells.splice(2, 0, ['Files moved', res.counters.moved]);
  if (res.verified) cells.splice(2, 0, ['Files verified', res.verified]);
  $('sum-grid').innerHTML = cells
    .map(([l, v]) => `<div class="srow"><div class="sr-lbl">${l}</div><div class="sr-val">${v}</div></div>`).join('');

  $('sum-errors').style.display = failed ? '' : 'none';
  $('sum-errors-body').innerHTML = res.errors.slice(0, 60)
    .map(e => `<div class="err-item">${esc(e.rel)} — ${esc(e.message)}</div>`).join('');

  $('sum-notes').style.display = res.notes.length ? '' : 'none';
  $('sum-notes-body').innerHTML = res.notes.slice(0, 40)
    .map(n => `<div class="err-item">${esc(n)}</div>`).join('');

  const files = (res.reportFiles || []).concat(res.checksumFiles || []);
  $('sum-files').innerHTML = files
    .map(f => `<span class="file-link" data-path="${esc(f)}">${esc(f)}</span>`).join('');

  const html = (res.reportFiles || []).find(f => f.endsWith('.html'));
  $('sum-open-report').style.display = html ? '' : 'none';
  $('sum-open-report').dataset.path = html || '';

  $('ov-summary').classList.add('open');
}

$('sum-files').addEventListener('click', e => {
  const el = e.target.closest('.file-link');
  if (el) API.revealPath(el.dataset.path);
});
$('sum-open-report').addEventListener('click', () => {
  const p = $('sum-open-report').dataset.path;
  if (p) API.openPath(p);
});

function showError(title, msg) {
  $('sum-ico').className = 'sum-ico err';
  $('sum-ico').innerHTML = ICO_ERR;
  $('sum-h1').textContent = title;
  $('sum-h2').textContent = '';
  $('sum-grid').innerHTML = '';
  $('sum-errors').style.display = '';
  $('sum-errors-body').innerHTML = `<div class="err-item">${esc(msg)}</div>`;
  $('sum-notes').style.display = 'none';
  $('sum-files').innerHTML = '';
  $('sum-open-report').style.display = 'none';
  $('ov-summary').classList.add('open');
}

// ── Verify ─────────────────────────────────────────────────────────────────
const VF_LEN = 395.8;

async function doVerify() {
  const folder = await API.browseFolder('Choose a folder to verify');
  if (!folder) return;
  $('vf-title').textContent = 'Verifying…';
  $('vf-pct').textContent = '0%';
  $('vf-ring').setAttribute('stroke-dashoffset', VF_LEN);
  $('vf-line').textContent = folder;
  $('vf-grid').innerHTML = '';
  $('vf-bad').style.display = 'none';
  $('ov-verify').classList.add('open');

  const res = await API.verifyFolder(folder);
  if (!res.ok) {
    $('vf-title').textContent = 'Cannot verify';
    $('vf-line').textContent = res.error;
    return;
  }
  const clean = res.mismatched === 0 && res.missing === 0;
  $('vf-title').textContent = clean ? 'Everything matches' : 'Problems found';
  $('vf-pct').textContent = '100%';
  $('vf-ring').setAttribute('stroke-dashoffset', 0);
  $('vf-ring').style.stroke = clean ? 'var(--green)' : 'var(--red)';
  $('vf-line').textContent = `${res.total} files · ${res.algo || 'xxh64'}`;
  $('vf-grid').innerHTML = [
    ['Verified', res.verified], ['Mismatched', res.mismatched], ['Missing', res.missing],
  ].map(([l, v]) => `<div class="srow"><div class="sr-lbl">${l}</div><div class="sr-val">${v}</div></div>`).join('');

  const bad = res.results.filter(r => r.status !== 'ok');
  $('vf-bad').style.display = bad.length ? '' : 'none';
  $('vf-bad-body').innerHTML = bad.slice(0, 60)
    .map(r => `<div class="err-item">${esc(r.rel)} — ${esc(r.status)}</div>`).join('');
}

API.onVerifyProgress(p => {
  const pct = p.total ? (p.done / p.total) * 100 : 0;
  $('vf-pct').textContent = Math.round(pct) + '%';
  $('vf-ring').setAttribute('stroke-dashoffset', VF_LEN * (1 - pct / 100));
  $('vf-line').textContent = p.current || '';
});

// ── Wiring ─────────────────────────────────────────────────────────────────
function bind() {
  $('btn-compare').addEventListener('click', doCompare);
  // While auto-sync is armed the big button is the red indicator; clicking it
  // disarms. Otherwise it starts a manual synchronization (with confirmation).
  $('btn-sync').addEventListener('click', () => {
    if (isAutoOn()) {
      state.job.autoSync.enabled = false;
      autoStop();
      persist();
      return;
    }
    if (state.stats) askConfirm();
  });
  $('btn-verify').addEventListener('click', doVerify);
  $('btn-settings').addEventListener('click', () => { jobToUi(); $('ov-settings').classList.add('open'); });
  $('set-close').addEventListener('click', () => { uiToJob(); $('ov-settings').classList.remove('open'); persist(); });

  // Per-job filter modal: closing applies and re-compares if a result is shown.
  $('btn-filter').addEventListener('click', () => { jobToUi(); $('ov-filter').classList.add('open'); });
  $('filter-close').addEventListener('click', async () => {
    const before = state.job.compare.includeFilter + '\u0000' + state.job.compare.excludeFilter;
    uiToJob();
    $('ov-filter').classList.remove('open');
    renderFilterBtn();
    persist();
    const after = state.job.compare.includeFilter + '\u0000' + state.job.compare.excludeFilter;
    if (state.stats && after !== before) await doCompare();
  });

  $('cf-cancel').addEventListener('click', () => $('ov-confirm').classList.remove('open'));
  $('cf-ok').addEventListener('click', doSync);
  $('sum-close').addEventListener('click', () => $('ov-summary').classList.remove('open'));
  $('vf-close').addEventListener('click', () => { API.verifyCancel(); $('ov-verify').classList.remove('open'); });

  $('btn-abort').addEventListener('click', async () => {
    if (state.busy === 'compare') await API.compareCancel();
    if (state.busy === 'sync')    await API.syncCancel();
  });
  // Lucide "pause" / "play" glyphs swapped in place.
  const PAUSE_PATHS = '<rect x="14" y="3" width="5" height="18" rx="1"/><rect x="5" y="3" width="5" height="18" rx="1"/>';
  const PLAY_PATHS  = '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>';
  $('btn-pause').addEventListener('click', async () => {
    if (state.busy !== 'sync') return;
    state.paused = !state.paused;
    $('btn-pause-lbl').textContent = state.paused ? 'RESUME' : 'PAUSE';
    $('btn-pause-ico').innerHTML   = state.paused ? PLAY_PATHS : PAUSE_PATHS;
    $('btn-pause').classList.toggle('go', state.paused);
    if (state.paused) await API.syncPause(); else await API.syncResume();
  });

  $('left-browse').addEventListener('click',  async () => { const p = await API.browseFolder('Left folder');  if (p) { $('left-path').value = p;  onPathChanged(); } });
  $('right-browse').addEventListener('click', async () => { const p = await API.browseFolder('Right folder'); if (p) { $('right-path').value = p; onPathChanged(); } });
  $('st-rep-browse').addEventListener('click', async () => { const p = await API.browseFolder('Report folder'); if (p) $('st-rep-folder').value = p; });

  $('left-path').addEventListener('change', onPathChanged);
  $('right-path').addEventListener('change', onPathChanged);

  // One click swaps SOURCE and DESTINATION for EVERY pair of the job.
  $('swap-btn').addEventListener('click', () => {
    uiToJob();
    for (const p of state.job.pairs) { const t = p.left; p.left = p.right; p.right = t; }
    jobToUi();               // refreshes the main fields AND the rows
    onPathChanged();
  });

  // Removing pair 1 promotes pair 2 into the main fields — same splice the
  // other rows use, just at index 0. Only enabled above 1 pair (see jobToUi).
  $('pair0-rm').addEventListener('click', () => {
    uiToJob();
    state.job.pairs.splice(0, 1);
    jobToUi();
    onPathChanged();          // re-reads free space for the promoted pair, persists
  });

  // Pair rows: edit in place, browse per field, remove, add.
  $('pairrows').addEventListener('change', e => {
    if (e.target.matches('.pr-left, .pr-right')) { uiToJob(); persist(); }
  });
  $('pairrows').addEventListener('click', async e => {
    const row = e.target.closest('.prow');
    if (!row) return;
    const i = Number(row.dataset.i);
    if (e.target.closest('.pr-rm')) {
      uiToJob();
      state.job.pairs.splice(i, 1);
      renderPairRows();
      persist();
      return;
    }
    const bl = e.target.closest('.pr-browse-l'), br = e.target.closest('.pr-browse-r');
    if (bl || br) {
      const p = await API.browseFolder(bl ? 'Source folder' : 'Destination folder');
      if (!p) return;
      row.querySelector(bl ? '.pr-left' : '.pr-right').value = p;
      uiToJob();
      persist();
    }
  });
  $('ps-add').addEventListener('click', () => {
    uiToJob();
    state.job.pairs.push({ left: '', right: '' });
    renderPairRows();
    persist();
    const last = document.querySelector('#pairrows .prow:last-child .pr-left');
    if (last) last.focus();
  });

  $('seg-cmp').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    state.job.compare.compareVariant = b.dataset.v;
    setSeg('seg-cmp', b.dataset.v);
    persist();
  });

  $('syncmodes').addEventListener('click', e => {
    const b = e.target.closest('.mbtn');
    if (!b) return;
    state.job.sync.variant = b.dataset.v;
    setVariantBtn(b.dataset.v);
    persist();
  });

  document.querySelector('#bottom-controls .modes-row').addEventListener('click', e => {
    const b = e.target.closest('.mbtn');
    if (!b) return;
    state.job.sync.copyLevel = b.dataset.v;
    setCopyModeBtn(b.dataset.v);
    persist();
  });


  $('chk-equal').addEventListener('change', async e => { state.view.showEqual = e.target.checked; await refreshGrid(true); });
  $('chk-excluded').addEventListener('change', async e => { state.view.showExcluded = e.target.checked; await refreshGrid(true); });

  let searchTimer = null;
  $('search').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => { state.view.search = e.target.value; await refreshGrid(true); }, 180);
  });

  installDropZones();

  API.onMenu(async m => {
    switch (m.action) {
      case 'compare': doCompare(); break;
      case 'sync': if (state.stats) askConfirm(); break;
      case 'swap': $('swap-btn').click(); break;
      case 'invert': state.stats = await API.invertAll(); afterEdit(); break;
      case 'verify': doVerify(); break;
      case 'job-new': newJob(); break;
      case 'job-open': openJob(); break;
      case 'job-save': saveJobFile(false); break;
      case 'job-save-as': saveJobFile(true); break;
      default: break;
    }
  });

  // Zone 1 — job actions + recent list
  $('job-new').addEventListener('click', newJob);
  $('job-open-btn').addEventListener('click', openJob);
  $('job-save-btn').addEventListener('click', () => saveJobFile(false));
  $('job-saveas-btn').addEventListener('click', () => saveJobFile(true));
  $('recent-list').addEventListener('click', e => {
    const it = e.target.closest('.recent-item');
    if (it) openRecent(it.dataset.path);
  });

  // Auto-sync: the switch asks for confirmation before arming; disarming is
  // immediate (stopping an automatism should never need a dialog).
  $('auto-switch').addEventListener('change', e => {
    uiToJob();
    if (e.target.checked) {
      e.target.checked = false;              // not armed until confirmed
      const n = state.job.autoSync.minutes || 30;
      const np = completePairs().length;
      $('auto-cf-sub').textContent =
        `Every ${n} minute${n > 1 ? 's' : ''}: ${state.job.sync.variant} synchronization of ${np} pair${np > 1 ? 's' : ''}, ${state.job.sync.copyLevel} copy.`;
      $('ov-auto').classList.add('open');
    } else {
      state.job.autoSync.enabled = false;
      autoStop();
      persist();
    }
  });
  $('auto-cf-cancel').addEventListener('click', () => {
    $('ov-auto').classList.remove('open');
    renderAutoUi();
  });
  $('auto-cf-ok').addEventListener('click', () => {
    $('ov-auto').classList.remove('open');
    state.job.autoSync.enabled = true;
    autoStart();
    persist();
  });
  $('auto-min').addEventListener('change', () => {
    uiToJob();
    if (isAutoOn()) autoSchedule();
    renderAutoUi();
    persist();
  });

  $('win-min').addEventListener('click', () => API.winMinimize());
  $('win-max').addEventListener('click', () => API.winMaximize());
  $('win-close').addEventListener('click', () => API.winClose());

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      // Escape goes through each modal's own close button: several of them do
      // real work on close (settings persist, the filter modal re-compares,
      // the verify modal cancels the run) — just hiding them would skip that.
      const ESC_CLOSE = {
        'ov-settings': 'set-close',   'ov-filter' : 'filter-close',
        'ov-confirm' : 'cf-cancel',   'ov-summary': 'sum-close',
        'ov-verify'  : 'vf-close',    'ov-auto'   : 'auto-cf-cancel',
        'update-ov'  : 'upd-later',
      };
      for (const ov of document.querySelectorAll('.ov.open')) {
        const btn = ESC_CLOSE[ov.id] && document.getElementById(ESC_CLOSE[ov.id]);
        if (btn) btn.click(); else ov.classList.remove('open');
      }
    }
  });

  installTooltips();
}

async function onPathChanged() {
  uiToJob();
  invalidateIfPairsChanged();
  persist();
  for (const [inputId, labelId] of [['left-path', 'left-free'], ['right-path', 'right-free']]) {
    const p = $(inputId).value.trim();
    const lbl = $(labelId);
    if (!p || p.startsWith('sftp://')) { lbl.textContent = p.startsWith('sftp://') ? 'remote' : ''; continue; }
    const ok = await API.folderExists(p);
    if (!ok) { lbl.textContent = 'does not exist yet'; continue; }
    const d = await API.diskFree(p);
    lbl.textContent = d ? `${fmtBytes(d.free)} free of ${fmtBytes(d.total)}` : '';
  }
}

async function newJob() {
  autoStop();
  state.job = await API.jobNew();
  state.jobPath = '';
  jobToUi();
  renderRecent();
  state.stats = null; state.total = 0; state.comparedPairs = null;
  renderStats();
  await refreshGrid(true);
  await refreshOverview();
}

async function openJob() {
  const res = await API.jobOpen();
  if (!res) return;
  state.job = res.job;
  state.jobPath = res.path;
  if (res.recent) state.recent = res.recent;
  jobToUi();
  renderRecent();
  onPathChanged();
}

async function saveJobFile(as) {
  uiToJob();
  const res = await API.jobSave(state.job, as);
  if (res) {
    state.jobPath = res.path;
    if (res.name) state.job.name = res.name;   // the file name is the job name
    if (res.recent) state.recent = res.recent;
    renderJobTitle();
    renderRecent();
  }
}

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    uiToJob();
    API.savePrefs({ job: state.job, ui: { showEqual: state.view.showEqual } });
  }, 400);
}

// ── Zone 1 — recent jobs ───────────────────────────────────────────────────
const ICON_JOB = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 10v4h4"/><path d="m12 14 1.535-1.605a5 5 0 0 1 8 1.5"/><path d="M22 22v-4h-4"/><path d="m22 18-1.535 1.605a5 5 0 0 1-8-1.5"/><path d="M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v.5"/></svg>';

function renderRecent() {
  const box = $('recent-list');
  if (!state.recent.length) {
    box.innerHTML = '<div class="recent-empty">No recent jobs yet — save one and it will appear here.</div>';
    return;
  }
  box.innerHTML = state.recent.map(r =>
    `<div class="recent-item${r.path === state.jobPath ? ' cur' : ''}" data-path="${esc(r.path)}" data-tip="${esc(r.path)}">
      ${ICON_JOB}<span class="recent-name">${esc(r.name)}</span>
    </div>`).join('');
}

async function openRecent(p) {
  const res = await API.jobOpenPath(p);
  if (!res) return;
  if (res.recent) state.recent = res.recent;
  if (res.error === 'gone') { renderRecent(); return; }   // really vanished — list refreshed
  if (res.error) {
    // Damaged file, unmounted share, no permission: the entry is KEPT, because
    // dropping it silently is how you lose track of where a job lived.
    renderRecent();
    showError('Could not open that job', `${res.path}\n\n${res.message}`);
    return;
  }
  state.job = res.job;
  state.jobPath = res.path;
  jobToUi();
  renderRecent();
  onPathChanged();
}

// ── Zone 2 — overview of the compared folders ──────────────────────────────
async function refreshOverview() {
  const box = $('ov-list');
  if (!state.stats) {
    box.innerHTML = '<div class="ov-empty">Run a comparison to see the folder breakdown.</div>';
    return;
  }
  const ov = await API.getOverview();
  if (!ov || !ov.rows.length) {
    box.innerHTML = '<div class="ov-empty">Both folders are empty.</div>';
    return;
  }
  box.innerHTML = ov.rows.map(g => `
    <div class="ov-row${g.idx === state.selIdx ? ' sel' : ''}${g.active ? '' : ' off'}"
         data-idx="${g.idx}" data-name="${esc(g.name)}" data-type="${g.type}" data-active="${g.active ? 1 : 0}"
         data-tip="${g.pairLabel ? '[' + esc(g.pairLabel) + '] ' : ''}${esc(g.name)} — ${g.items} item${g.items === 1 ? '' : 's'}, ${esc(fmtBytes(g.bytes))}">
      <div class="ov-pct"><div class="bar" style="width:${g.pct}%"></div><div class="lbl">${g.pct}%</div></div>
      <div class="ov-name">${g.type === 'folder' ? ICON_FOLDER : ICON_FILE}<span>${esc(g.name)}</span></div>
      <div class="ov-items">${g.items}</div>
      <div class="ov-bytes">${esc(fmtBytes(g.bytes))}</div>
    </div>`).join('');
}

// Selection + right-click in the overview: same behaviour as the grid.
$('ov-list').addEventListener('click', async e => {
  const it = e.target.closest('.ov-row');
  if (!it) return;
  const idx = Number(it.dataset.idx);
  if (idx < 0) return;
  state.selIdx = state.selIdx === idx ? null : idx;
  await refreshOverview();
  await renderWindow();
});

$('ov-list').addEventListener('contextmenu', async e => {
  const it = e.target.closest('.ov-row');
  if (!it) return;
  e.preventDefault();
  const idx = Number(it.dataset.idx);
  if (idx < 0) return;
  state.selIdx = idx;
  await refreshOverview();
  await renderWindow();
  openCtx(e.clientX, e.clientY, {
    idx, rel: it.dataset.name, name: it.dataset.name,
    type: it.dataset.type, active: it.dataset.active === '1',
  });
});

// ── Auto-sync — compare + synchronize every N minutes ──────────────────────
// Armed only after an explicit confirmation. While armed the whole window is
// framed in red and the big SYNCHRONIZE button turns into a red AUTO-SYNC ON
// indicator (clicking it disarms). Runs are fully unattended: no dialogs, the
// summary only pops up on errors.
function isAutoOn() {
  return !!(state.job && state.job.autoSync && state.job.autoSync.enabled);
}

const SYNC_BTN_HTML = $('btn-sync') ? $('btn-sync').innerHTML : '';

function renderAutoUi() {
  const on = isAutoOn();
  const left = Math.max(0, state.auto.nextAt - Date.now());
  const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
  const count = `${m}:${String(s).padStart(2, '0')}`;

  $('auto-switch').checked = on;
  $('auto-count').textContent = on ? (state.busy ? 'running' : count) : '';
  document.body.classList.toggle('autosync', on);

  const btn = $('btn-sync');
  btn.classList.toggle('auto', on);
  if (on) {
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 10v4h4"/><path d="m12 14 1.535-1.605a5 5 0 0 1 8 1.5"/><path d="M22 22v-4h-4"/><path d="m22 18-1.535 1.605a5 5 0 0 1-8-1.5"/><path d="M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v.5"/></svg>` +
      `AUTO-SYNC ON — ${state.busy ? 'running' : count}`;
    btn.setAttribute('data-tip', 'Auto-sync is armed: syncto runs by itself. Click to disarm.');
    if (!state.busy) btn.disabled = false;
  } else {
    btn.innerHTML = SYNC_BTN_HTML;
    btn.removeAttribute('data-tip');
    btn.disabled = !!state.busy || !state.stats || state.stats.filesToProcess === 0;
  }
}
// Legacy name used by jobToUi and the tick loop.
function renderAutoBtn() { renderAutoUi(); }

function autoSchedule() {
  state.auto.nextAt = Date.now() + (state.job.autoSync.minutes || 30) * 60000;
}

function autoStart() {
  autoSchedule();
  if (state.auto.tick) clearInterval(state.auto.tick);
  state.auto.tick = setInterval(async () => {
    renderAutoBtn();
    const j = state.job;
    if (!j || !j.autoSync || !j.autoSync.enabled) return;
    if (Date.now() < state.auto.nextAt) return;
    if (state.busy) { state.auto.nextAt = Date.now() + 30000; return; }   // busy: try again shortly
    await autoRun();
    autoSchedule();
  }, 1000);
  renderAutoBtn();
}

function autoStop() {
  if (state.auto.tick) clearInterval(state.auto.tick);
  state.auto.tick = null;
  state.auto.nextAt = 0;
  $('footer-auto').textContent = '';
  renderAutoBtn();
}

async function autoRun() {
  uiToJob();
  if (!completePairs().length) return;
  state.selIdx = null;
  const stamp = () => {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  state.busy = 'compare';
  setBusyUi(true, 'Auto-sync — comparing…');
  $('btn-pause').style.display = 'none';
  const cmp = await API.compare(state.job);
  $('btn-pause').style.display = '';
  if (!cmp.ok) {
    state.busy = null; setBusyUi(false);
    $('footer-auto').textContent = `auto-sync ${stamp()}: comparison failed — ${cmp.error}`;
    return;
  }
  state.stats = cmp.stats;
  renderStats(); await refreshGrid(true); await refreshOverview();

  // Unattended run + unreadable folder = the one combination that must never
  // proceed: an unreadable side looks empty, and nobody is watching. The
  // engine refuses too (fatal errors block sync); this spares the attempt.
  if (cmp.errors && cmp.errors.length) {
    state.busy = null; setBusyUi(false);
    $('footer-auto').textContent =
      `auto-sync ${stamp()}: ${cmp.errors.length} folder error(s) during comparison — synchronization skipped`;
    return;
  }

  if (cmp.stats.filesToProcess === 0) {
    state.busy = null; setBusyUi(false);
    $('footer-auto').textContent = `auto-sync ${stamp()}: already in sync`;
    return;
  }

  state.busy = 'sync';
  setBusyUi(true, 'Auto-sync — synchronizing…');
  const res = await API.sync(state.job);
  state.busy = null;
  setBusyUi(false);
  if (!res.ok) {
    $('footer-auto').textContent = `auto-sync ${stamp()}: failed — ${res.error}`;
    return;
  }
  const c = res.counters;
  const bits = [];
  if (c.files)  bits.push(`${c.files} copied`);
  if (c.moved)  bits.push(`${c.moved} moved`);
  if (c.deleted)bits.push(`${c.deleted} removed`);
  $('footer-auto').textContent =
    `auto-sync ${stamp()}: ${bits.length ? bits.join(', ') : 'done'}${res.errors.length ? ` — ${res.errors.length} ERROR(S)` : ''}`;
  if (res.errors.length) showSummary(res);   // errors deserve a face
  await doCompareQuiet();
}

// ── Resizable panels ───────────────────────────────────────────────────────
// Three grips: sidebar width, Jobs/Overview split, and the source/destination
// pane ratio in the grid (drag the arrow column header). All persisted.
function installSplitters(ui) {
  const sidebar = $('sidebar');
  const jobs    = $('sb-jobs');
  const wrap    = $('gridwrap');

  if (ui.sidebarW) sidebar.style.width = ui.sidebarW + 'px';
  if (ui.jobsH)    jobs.style.height   = ui.jobsH + 'px';
  if (ui.paneL) {
    wrap.style.setProperty('--fL', ui.paneL + 'fr');
    wrap.style.setProperty('--fR', (1 - ui.paneL) + 'fr');
  }

  const drag = (el, axis, onMove, onEnd) => {
    el.addEventListener('mousedown', e => {
      e.preventDefault();
      el.classList.add('drag');
      document.body.classList.add(axis === 'x' ? 'dragging-col' : 'dragging-row');
      const move = ev => onMove(ev);
      const up = () => {
        el.classList.remove('drag');
        document.body.classList.remove('dragging-col', 'dragging-row');
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        onEnd();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  };

  drag($('split-sb'), 'x',
    ev => { sidebar.style.width = Math.min(480, Math.max(180, ev.clientX)) + 'px'; },
    () => API.savePrefs({ ui: { sidebarW: parseInt(sidebar.style.width, 10) } }));

  drag($('split-jobs'), 'y',
    ev => {
      const top = sidebar.getBoundingClientRect().top;
      jobs.style.height = Math.min(sidebar.clientHeight - 140, Math.max(120, ev.clientY - top)) + 'px';
    },
    () => API.savePrefs({ ui: { jobsH: parseInt(jobs.style.height, 10) } }));

  // Grid pane ratio: drag the ⇄ header cell sideways.
  const gripe = document.querySelector('#gridhead .c-act');
  gripe.style.cursor = 'col-resize';
  gripe.setAttribute('data-tip', 'Drag sideways to resize the two panes');
  drag(gripe, 'x',
    ev => {
      const r = wrap.getBoundingClientRect();
      const ratio = Math.min(.75, Math.max(.25, (ev.clientX - r.left) / r.width));
      wrap.style.setProperty('--fL', ratio + 'fr');
      wrap.style.setProperty('--fR', (1 - ratio) + 'fr');
      wrap.dataset.ratio = ratio.toFixed(3);
    },
    () => API.savePrefs({ ui: { paneL: Number(wrap.dataset.ratio) || 0.5 } }));
}

// ── Drop zones — drag a volume or folder anywhere in the window ────────────
// As soon as something draggable from the Finder/Explorer enters the window,
// two big halves appear: left = source, right = destination. Dropping a file
// instead of a folder assigns its parent folder.
function installDropZones() {
  const ov = $('drop-ov');
  let depth = 0;

  const close = () => { depth = 0; ov.classList.remove('open');
    $('drop-src').classList.remove('over'); $('drop-dst').classList.remove('over'); };

  window.addEventListener('dragenter', e => {
    const types = e.dataTransfer ? Array.from(e.dataTransfer.types || []) : [];
    if (!types.includes('Files')) return;
    depth++;
    ov.classList.add('open');
  });
  window.addEventListener('dragleave', () => { if (--depth <= 0) close(); });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => { e.preventDefault(); close(); });

  const assign = async (half, inputId, e) => {
    e.preventDefault(); e.stopPropagation();
    const f = e.dataTransfer.files[0];
    close();
    if (!f) return;
    let p = API.getPathForFile(f);
    if (!p) return;
    // A dropped FILE means "use the folder it lives in".
    if (!(await API.folderExists(p))) {
      const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
      if (cut > 0) p = p.slice(0, cut);
    }
    $(inputId).value = p;
    onPathChanged();
  };

  for (const [halfId, inputId] of [['drop-src', 'left-path'], ['drop-dst', 'right-path']]) {
    const half = $(halfId);
    half.addEventListener('dragover', e => { e.preventDefault(); half.classList.add('over'); });
    half.addEventListener('dragleave', () => half.classList.remove('over'));
    half.addEventListener('drop', e => assign(half, inputId, e));
  }
}

// ── Update notice — same behaviour as ingesto ──────────────────────────────
// Small dismissible overlay; dismissing remembers the version so the same one
// never nags twice.
function showUpdateNotice({ version, url }) {
  if (version === state.updateDismissedVersion) return;
  if (document.getElementById('update-ov')) return;
  const ov = document.createElement('div');
  ov.id = 'update-ov';
  ov.className = 'ov open';
  ov.innerHTML =
    `<div class="mcard sm">` +
    `<div class="m-h1" style="display:flex;align-items:center;gap:9px">` +
    `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="var(--green)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>` +
    `New version available</div>` +
    `<div class="m-sub">syncto v${esc(version)} is available. You're on v${esc(state.version || '')}.</div>` +
    `<div class="m-btns">` +
    `<button class="m-btn" id="upd-later">Later</button>` +
    `<button class="m-btn primary" id="upd-go">Get it</button></div>` +
    `</div>`;
  document.body.appendChild(ov);
  const dismiss = () => {
    state.updateDismissedVersion = version;
    API.savePrefs({ updateDismissedVersion: version });
    ov.remove();
  };
  ov.querySelector('#upd-later').onclick = dismiss;
  ov.querySelector('#upd-go').onclick = () => { API.openExternal(url); dismiss(); };
  ov.onclick = e => { if (e.target === ov) dismiss(); };
}

// ── Tooltips ───────────────────────────────────────────────────────────────
function installTooltips() {
  let tip = null;
  document.addEventListener('mouseover', e => {
    const el = e.target.closest('[data-tip]');
    if (!el) return;
    if (tip) tip.remove();
    tip = document.createElement('div');
    tip.className = 'tooltip-float';
    tip.textContent = el.dataset.tip;
    document.body.appendChild(tip);
    const r = el.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    let x = r.left + r.width / 2 - tr.width / 2;
    x = Math.max(6, Math.min(x, window.innerWidth - tr.width - 6));
    let y = r.bottom + 7;
    if (y + tr.height > window.innerHeight - 6) y = r.top - tr.height - 7;
    tip.style.left = x + 'px';
    tip.style.top  = y + 'px';
  });
  document.addEventListener('mouseout', e => {
    if (!e.target.closest('[data-tip]')) return;
    if (tip) { tip.remove(); tip = null; }
  });
  document.addEventListener('mousedown', () => { if (tip) { tip.remove(); tip = null; } });
}

// ── Boot ───────────────────────────────────────────────────────────────────
(async function boot() {
  if (API.platform !== 'darwin') document.body.classList.add('win');
  state.version = await API.getVersion();
  const prefs = await API.loadPrefs();
  state.job = prefs.job;
  ensurePairs(state.job);
  // Auto-sync never survives a restart: it must be re-armed (and re-confirmed)
  // by a human every session.
  if (state.job.autoSync) state.job.autoSync.enabled = false;
  state.updateDismissedVersion = prefs.updateDismissedVersion || '';
  state.recent = prefs.recent || [];
  // The settings restored above came from a job FILE. Remembering which one
  // keeps the title honest and makes Ctrl+S save in place; without it every
  // restart showed "not saved yet" and the next save asked for a name again —
  // the short road to overwriting a different job.
  state.jobPath = prefs.lastJobPath || '';
  API.onUpdateAvailable(showUpdateNotice);
  state.view.showEqual = !!(prefs.ui && prefs.ui.showEqual);
  $('chk-equal').checked = state.view.showEqual;
  jobToUi();
  bind();
  installSplitters(prefs.ui || {});
  renderRecent();
  onPathChanged();
  document.title = `syncto ${state.version}`;
  $('footer-ver').textContent = 'v' + state.version;
  $('footer-gh').addEventListener('click', () => API.openExternal('https://github.com/noar-justedit/syncto'));
})();
