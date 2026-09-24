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
  // scope: { p, rel, label } — set by clicking a folder in the overview, so
  // the grid shows that folder and everything under it, and nothing else.
  view   : { showEqual: false, showExcluded: false, search: '', onlyCategory: '', onlyOperation: '', scope: null },
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
  pairInfo: null,
  missingPaths: [],
  auto   : { nextAt: 0, tick: null },   // auto-sync scheduler
  selIdx : null,                        // selected grid row (node idx)
  // Folders unfolded in the overview, as `${pairIndex}:${rel}`. Kept in the
  // window, not in the job: it is a way of looking at one comparison, and a
  // new comparison starts folded.
  ovOpen : new Set(),
  // How zone 2 is ordered, and what is selected in it. Also window-only: the
  // job file describes two folders, not a way of looking at them.
  ovSort : { key: 'bytes', dir: 'desc' },
  ovSel  : new Set(),      // keys of the selected rows
  ovAnchor: null,          // where a Shift range starts
  ovOrder: [],             // the keys in the order they are drawn
  ovByKey: new Map(),      // key -> the row the engine sent
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

// Lucide "server". Same glyph in the two main fields and in every pair row.
const ICON_SERVER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6 6h.01"/><path d="M6 18h.01"/></svg>';

// Pairs 2..N as stacked SOURCE/DESTINATION rows under the main fields —
// the FreeFileSync layout: every pair visible and editable at once.
// Every pair, drawn the same way — pair 1 included. It used to live in its own
// markup up in the header, with the only swap button and free-space readouts
// nobody asked for, so no column lined up with the pairs below it.
//
// Pair 1's two inputs still carry the ids the rest of the window knows them by
// (left-path / right-path, left-server / right-server), so drag-and-drop, the
// keyboard shortcuts and the server dialog keep working unchanged.
const ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';
const ICON_SWAP  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/></svg>';

// Lights (or unlights) the server button that belongs to one folder field.
function lightServerButton(input) {
  const field = input.closest('.pr-field');
  const btn = field && field.querySelector('.srv-btn');
  if (btn) btn.classList.toggle('on', input.value.trim().startsWith('sftp://'));
}

function renderPairRows() {
  const j = ensurePairs(state.job);
  const only = j.pairs.length === 1;
  $('pairrows').innerHTML = j.pairs.map((p, i) => {
    const id = n => i === 0 ? ` id="${n}"` : '';
    const on = v => v.startsWith('sftp://') ? ' on' : '';
    return `<div class="prow" data-i="${i}">
      <button class="pr-rm" data-tip="${only ? 'A job needs at least one pair' : 'Remove this pair'}"
              aria-label="Remove pair ${i + 1}"${only ? ' disabled' : ''}>${ICON_TRASH}</button>
      <span class="pr-num" data-tip="Folder pair ${i + 1}">${i + 1}</span>
      <div class="pr-field">
        <input class="pr-left"${id('left-path')} value="${esc(p.left)}" placeholder="Source folder" spellcheck="false">
        <button class="br-btn pr-browse-l">Browse</button>
        <button class="srv-btn pr-server-l${on(p.left)}"${id('left-server')} data-tip="Connect to a server (SFTP)" aria-label="Connect to a server">${ICON_SERVER}</button>
      </div>
      <button class="pr-swap" data-tip="Swap this pair's source and destination" aria-label="Swap pair ${i + 1}">${ICON_SWAP}</button>
      <div class="pr-field">
        <input class="pr-right"${id('right-path')} value="${esc(p.right)}" placeholder="Destination folder" spellcheck="false">
        <button class="br-btn pr-browse-r">Browse</button>
        <button class="srv-btn pr-server-r${on(p.right)}"${id('right-server')} data-tip="Connect to a server (SFTP)" aria-label="Connect to a server">${ICON_SERVER}</button>
      </div>
    </div>`;
  }).join('');
  // The rows were just rebuilt, so the red went with them.
  markMissingPaths(state.missingPaths);
}

// Marks the rows whose folder is not there. This is what stays on screen after
// the dialog has been closed — a warning you dismissed is a warning you no
// longer have, and the path is where the problem actually is.
function markMissingPaths(list) {
  document.querySelectorAll('#pairrows .prow input').forEach(i => {
    i.classList.remove('gone');
    i.removeAttribute('data-tip');
  });
  for (const e of list || []) {
    const row = document.querySelector(`#pairrows .prow[data-i="${e.pairIndex}"]`);
    if (!row) continue;
    const inp = row.querySelector(e.side === 'left' ? '.pr-left' : '.pr-right');
    if (!inp) continue;
    inp.classList.add('gone');
    inp.dataset.tip = 'This folder is not there — Browse to point this row somewhere else';
  }
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
//   green  = added   orange = updated   red = deleted   blue = renamed (moved)
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
  renderJobActions();
  const el = $('job-title');
  if (state.jobPath) el.textContent = state.job.name || 'Untitled';
  else el.innerHTML = '<span class="unsaved">Untitled — not saved yet</span>';
}

function jobToUi() {
  const j = ensurePairs(state.job);
  renderJobTitle();
  renderPairRows();

  setSeg('seg-cmp', j.compare.compareVariant);
  setVariantBtn(j.sync.variant);

  $('st-moves').checked  = j.compare.detectMoves !== false;
  $('st-include').value  = j.compare.includeFilter;
  $('st-exclude').value  = j.compare.excludeFilter;
  renderFilterBtn();

  // Versioning is no longer exposed: a job that carried it falls back to trash.
  $('st-lanes').value = String(j.sync.transferLanes || 4);
  $('st-verify-remote').checked = j.sync.verifyRemote !== false;
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
  $('st-after').value     = j.sync.afterSync || 'none';

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

  j.sync.transferLanes = Number($('st-lanes').value) || 1;
  j.sync.verifyRemote  = $('st-verify-remote').checked;
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
  j.sync.afterSync         = $('st-after').value;

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

// ── Grid ───────────────────────────────────────────────────────────────────
let fetchSeq = 0;

// ── The empty grid ─────────────────────────────────────────────────────────
// Four different situations end with no rows on screen, and they used to share
// one sentence that hedged between them. The important one is the ordinary
// state of a backup that is kept up to date — every pair already in sync —
// which is a RESULT and now says so, with the figures, instead of reading like
// a filter problem. It used to be unreachable in a multi-pair job anyway: each
// pair left a heading behind, so the grid was never empty and five
// synchronized pairs looked like five rows of work.
const ICO_EMPTY_FOLDER =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v.5"/>'
  + '<path d="M12 10v4h4"/><path d="m12 14 1.535-1.605a5 5 0 0 1 8 1.5"/><path d="M22 22v-4h-4"/>'
  + '<path d="m22 18-1.535 1.605a5 5 0 0 1-8-1.5"/></svg>';
const ICO_IN_SYNC =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
  + '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>';
const ICO_FILTER =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M3 4h18l-7 8v6l-4 2v-8Z"/></svg>';

function renderEmptyState(res) {
  const box = $('gridempty'), s = state.stats;
  const set = (cls, ico, title, sub, act) => {
    box.className = cls;
    $('ge-ico').innerHTML = ico;
    $('ge-title').textContent = title || '';
    $('ge-sub').innerHTML = sub;
    const b = $('ge-act');
    // '' would fall back to the stylesheet, which hides it — the rule is on
    // #ge-act itself, not on a parent.
    b.style.display = act ? 'inline-block' : 'none';
    if (act) { b.textContent = act.label; b.dataset.act = act.key; }
  };
  const n = v => v.toLocaleString();

  // (1) Nothing has been compared yet.
  if (!s) {
    set('', ICO_EMPTY_FOLDER, '', 'Pick two folders, then press <b>Compare</b>.');
    return;
  }

  const pairs = (res && res.pairs) || 1;
  const scoped = !!(state.view.scope);
  const filtered = !!(state.view.onlyOperation || state.view.onlyCategory ||
                      (state.view.search || '').trim() || scoped);
  const todo = s.filesToProcess + (s.conflicts || 0);

  // (2) There IS work, and the view is hiding all of it. Say which view.
  if (todo > 0 && filtered) {
    set('', ICO_FILTER, '',
      `${n(todo)} item${todo > 1 ? 's' : ''} need attention, but none of them match what this view shows.`,
      { label: 'Show everything', key: 'clear' });
    return;
  }

  // (3) The comparison found nothing at all — both sides empty, or the hard
  //     filter removed everything before the comparison even ran.
  if (!s.rows) {
    set('', ICO_EMPTY_FOLDER, '',
      scoped ? 'That folder is empty.'
             : 'Nothing was compared. The folders are empty, or the filter excludes everything in them.');
    return;
  }

  // (4) The one that matters: everything is already identical.
  const bits = [];
  if (pairs > 1) bits.push(`${pairs} pairs`);
  bits.push(`${n(s.rows)} item${s.rows > 1 ? 's' : ''} compared`);
  if (s.excluded) bits.push(`${n(s.excluded)} excluded by the filter`);
  set('ok', ICO_IN_SYNC,
    pairs > 1 ? 'All pairs are in sync' : 'Everything is in sync',
    `${bits.join(' · ')}<br>Nothing to copy, nothing to delete.`,
    { label: 'Show the identical files', key: 'equal' });
}

// Everything, again: no folder scope, no chip, no search. One function,
// because the button in the middle of an empty grid and the empty space in the
// overview are the same request asked from two places.
function viewIsNarrowed() {
  return !!(state.view.scope || state.view.onlyOperation || state.view.onlyCategory ||
            (state.view.search || '').trim());
}

async function showEverything() {
  state.view.onlyOperation = '';
  state.view.onlyCategory  = '';
  state.view.search = '';
  state.view.scope = null;
  const sf = $('search'); if (sf) sf.value = '';
  clearOvSel();
  renderScopeBar();
  renderStats();
  await refreshGrid(true);
  await refreshOverview();
}

// Excluding the folder the grid is looking at empties the grid: the rows are
// still there, they just stopped being work. The window used to sit on that
// emptiness until you found the "Show everything" button. If a scope has
// nothing left to show, it has done its job — it goes.
async function dropScopeIfEmpty() {
  if (!state.view.scope) return false;
  const res = await API.getRows(0, 1, state.view);
  if (res && res.total > 0) return false;
  state.view.scope = null;
  renderScopeBar();
  renderStats();
  await refreshGrid(true);
  return true;
}

$('ge-act').addEventListener('click', async () => {
  const k = $('ge-act').dataset.act;
  if (k === 'clear') {
    await showEverything();
    return;
  } else if (k === 'equal') {
    state.view.showEqual = true;
    const sw = $('chk-equal'); if (sw) sw.checked = true;
    persist();
  }
  renderStats();
  await refreshGrid(true);
  await refreshOverview();
});

async function refreshGrid(resetScroll) {
  const scroll = $('gridscroll');
  if (resetScroll) scroll.scrollTop = 0;
  const res = await API.getRows(0, 1, state.view);
  state.total = res.total;
  $('gridspacer').style.height = (state.total * ROWH) + 'px';
  $('gridscroll').style.display = state.total ? '' : 'none';
  $('gridempty').style.display  = state.total ? 'none' : '';
  // How many pairs actually put something on screen. Pairs that are entirely
  // in sync no longer leave a heading behind, so without this line they would
  // simply vanish and leave the reader counting.
  state.pairInfo = { pairs: res.pairs || 1, shown: res.pairsShown || 0 };
  if (!state.total) renderEmptyState(res);
  renderStats();
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
  // Only what is on screen (plus the margin above and below). This map used
  // to keep every row ever fetched: scrolling the length of a 400 000-row
  // comparison held all of them until the next comparison cleared it.
  state.rows.clear();
  res.rows.forEach((r, i) => state.rows.set(first + i, r));
}

const ICON_FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>';
// Lucide "chevron-right", rotated by CSS when the folder is open.
const ICON_CHEV   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
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
  // Working in the grid ends the batch: a highlighted selection in zone 2 that
  // Space would still act on, while you are looking elsewhere, is a trap.
  if (state.ovSel.size) { clearOvSel(); refreshOverview(); }
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

// A submenu opens where its parent line is, which is fine until the parent is
// near the bottom of the screen: three-line entries run off the edge and the
// last suggestion — "this one only", the safest of them — is the one you cannot
// read. Measured and pulled back when it opens, and flipped to the other side
// when there is no room on the right.
function placeSub(sub) {
  sub.style.top = '-6px';
  sub.style.left = ''; sub.style.right = ''; sub.style.marginLeft = ''; sub.style.marginRight = '';
  // A hidden element has no size: show it to measure, then hand it back to the
  // stylesheet, which keeps it open while the parent is hovered.
  sub.style.display = 'block';
  const r = sub.getBoundingClientRect();
  let top = -6;
  const over = r.bottom - (window.innerHeight - 8);
  if (over > 0) top -= over;
  if (r.top + (top + 6) < 8) top = 8 - r.top - 6;
  sub.style.top = top + 'px';
  if (r.right > window.innerWidth - 8) {
    sub.style.left = 'auto'; sub.style.right = '100%';
    sub.style.marginLeft = '0'; sub.style.marginRight = '2px';
  }
  sub.style.display = '';
}

// The filter suggestions for one item, most specific last — same spirit as
// FreeFileSync's submenu: by extension, by name anywhere, by exact path.
// The three shapes a pattern can take, and — the part that was missing — what
// each one does said in words. A leading slash anchors the pattern to the top
// of the pair; without it, the name matches at any depth. Nothing on screen
// said so, so "KADAZ/" and "/260628/KADAZ/" read as the same line twice.
function filterVariants(r) {
  const out = [];
  if (r.type !== 'folder') {
    const dot = r.name.lastIndexOf('.');
    if (dot > 0) {
      const ext = r.name.slice(dot);
      out.push({ p: '*' + ext, lbl: `All ${ext} files`, sub: 'anywhere in this job' });
    }
    out.push({ p: r.name, lbl: 'Every file with this name', sub: 'anywhere in this job' });
    out.push({ p: '/' + r.rel, lbl: 'This file only', sub: 'at this exact path' });
  } else {
    out.push({ p: r.name + '/', lbl: 'Every folder with this name', sub: 'anywhere in this job, with its contents' });
    out.push({ p: '/' + r.rel + '/', lbl: 'This folder only', sub: 'at this exact path, with its contents' });
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
  state.stats = await API.toggleActive(Array.isArray(idx) ? idx : [idx]);
  afterEdit();
  await dropScopeIfEmpty();
  await refreshOverview();
}

const CTX_REVEAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="m9 13 3 3 3-3"/></svg>';
const CTX_OK = '<svg class="ok" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>';
const CTX_KO = '<svg class="ko" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>';
const CTX_SQ = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>';
const CTX_SQ_CHK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>';

// "Reveal in Finder" on a Mac, "Show in Explorer" on Windows — the name people
// already know from their own file manager.
const REVEAL_VERB = API.platform === 'darwin' ? 'Reveal in Finder'
                  : API.platform === 'win32'  ? 'Show in Explorer'
                  : 'Open containing folder';

async function revealNode(idx, side) {
  const res = await API.revealNode(idx, side);
  if (res && !res.ok) $('status-note').textContent = res.error;
  else if (res && res.note) $('status-note').textContent = res.note;
}

function openCtx(x, y, r) {
  closeCtx();
  const variants = filterVariants(r);
  // The pattern is still shown — it is what lands in the filter, and people
  // check it — but underneath the sentence, not instead of it.
  const sub = kind => variants.map(v =>
    `<div class="ctx-it pat-it" data-k="${kind}" data-p="${esc(v.p)}">
       <span class="lbl"><b>${esc(v.lbl)}</b><i>${esc(v.sub)}</i><code>${esc(v.p)}</code></span>
     </div>`).join('');

  // A row is two places on disk, not one, so there are two entries. A side the
  // item is not on is greyed rather than hidden: a menu whose shape changes
  // from row to row is harder to use than one where the missing half is
  // visible and inert. `undefined` means "we were not told" (the overview
  // builds a lighter row) — offer it and let the main process answer.
  const off = v => v === null ? ' off' : '';
  const reveal =
    `<div class="ctx-it${off(r.l)}" data-k="rv-left">${CTX_REVEAL}<span class="lbl">${REVEAL_VERB} — source</span></div>` +
    `<div class="ctx-it${off(r.r)}" data-k="rv-right">${CTX_REVEAL}<span class="lbl">${REVEAL_VERB} — destination</span></div>` +
    `<div class="ctx-sep"></div>`;

  const m = document.createElement('div');
  m.id = 'ctx-menu';
  m.className = 'ctx';
  m.innerHTML = reveal +
    `<div class="ctx-it" data-k="temp">${r.active ? CTX_SQ : CTX_SQ_CHK}<span class="lbl">Exclude temporarily</span><span class="key">Space</span></div>` +
    `<div class="ctx-sep"></div>` +
    `<div class="ctx-it">${CTX_OK}<span class="lbl">Keep — add to the include filter</span><span class="sub-arrow">▶</span><div class="ctx-sub"><div class="ctx-head">Keep, from now on…</div>${sub('include')}</div></div>` +
    `<div class="ctx-it">${CTX_KO}<span class="lbl">Skip — add to the exclude filter</span><span class="sub-arrow">▶</span><div class="ctx-sub"><div class="ctx-head">Skip, from now on…</div>${sub('exclude')}</div></div>`;
  document.body.appendChild(m);

  // Keep it on screen.
  const rct = m.getBoundingClientRect();
  m.style.left = Math.min(x, window.innerWidth - rct.width - 8) + 'px';
  m.style.top  = Math.min(y, window.innerHeight - rct.height - 8) + 'px';
  for (const sub of m.querySelectorAll('.ctx-sub')) {
    sub.parentElement.addEventListener('mouseenter', () => placeSub(sub));
  }

  m.addEventListener('click', async e => {
    const it = e.target.closest('.ctx-it[data-k]');
    if (!it) return;
    e.stopPropagation();
    closeCtx();
    if (it.classList.contains('off')) return;
    if (it.dataset.k === 'rv-left')       await revealNode(r.idx, 'left');
    else if (it.dataset.k === 'rv-right') await revealNode(r.idx, 'right');
    else if (it.dataset.k === 'temp')     await toggleExcludeTemp(r.batch && r.batch.length > 1 ? r.batch : r.idx);
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

// Right-click on a folder field — the SOURCE and DESTINATION boxes, and the
// extra pairs below them. Same reflex as the grid: "show me that folder".
function openPathCtx(x, y, folder) {
  closeCtx();
  if (!folder) return;
  const remote = /^sftp:\/\//i.test(folder);
  const m = document.createElement('div');
  m.id = 'ctx-menu';
  m.className = 'ctx';
  m.innerHTML =
    `<div class="ctx-it${remote ? ' off' : ''}" data-k="rv">${CTX_REVEAL}<span class="lbl">${REVEAL_VERB}</span></div>`;
  document.body.appendChild(m);
  const rct = m.getBoundingClientRect();
  m.style.left = Math.min(x, window.innerWidth - rct.width - 8) + 'px';
  m.style.top  = Math.min(y, window.innerHeight - rct.height - 8) + 'px';
  m.addEventListener('click', async e => {
    const it = e.target.closest('.ctx-it[data-k]');
    if (!it || it.classList.contains('off')) return;
    e.stopPropagation();
    closeCtx();
    await API.revealPath(folder);
  });
}

document.addEventListener('contextmenu', e => {
  const f = e.target.closest('#left-path, #right-path, .pr-left, .pr-right');
  if (!f) return;
  e.preventDefault();
  openPathCtx(e.clientX, e.clientY, (f.value || '').trim());
});

document.addEventListener('mousedown', e => { if (!e.target.closest('.ctx')) closeCtx(); });
window.addEventListener('blur', closeCtx);
document.addEventListener('scroll', closeCtx, true);

// Space = exclude/include what is selected, like FFS. A selection made in the
// overview wins, because it is the one you can see highlighted.
document.addEventListener('keydown', async e => {
  if (e.key !== ' ') return;
  const picked = state.ovSel.size ? [...state.ovSel].map(k => state.ovByKey.get(k))
                                      .filter(g => g && g.idx >= 0).map(g => g.idx) : [];
  if (!picked.length && state.selIdx == null) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT')) return;
  if (document.querySelector('.ov.open')) return;
  e.preventDefault();
  await toggleExcludeTemp(picked.length ? picked : state.selIdx);
});

async function afterEdit() {
  renderStats();
  await renderWindow();
  renderAutoUi();
}

// One fetch per frame, not one per scroll event. A trackpad fling fires this
// sixty to a hundred and twenty times a second, and every fetch made the main
// process walk the whole tree; the answers that arrived out of order were then
// thrown away by the sequence guard — work done twice over to be discarded.
let scrollFrame = 0;
$('gridscroll').addEventListener('scroll', () => {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => { scrollFrame = 0; renderWindow(); });
});
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
  if (s.updateRight) parts.push(chip('o', 'update →', s.updateRight, 'overwriteRight', 'op'));
  if (s.updateLeft)  parts.push(chip('o', '← update', s.updateLeft,  'overwriteLeft',  'op'));
  if (s.deleteRight) parts.push(chip('r', 'delete →', s.deleteRight, 'deleteRight', 'op'));
  if (s.deleteLeft)  parts.push(chip('r', '← delete', s.deleteLeft,  'deleteLeft',  'op'));
  if (s.moveRight)   parts.push(chip('b', 'move →',   s.moveRight,   'moveRightTo', 'op'));
  if (s.moveLeft)    parts.push(chip('b', '← move',   s.moveLeft,    'moveLeftTo',  'op'));
  if (s.conflicts)   parts.push(chip('r', 'conflicts', s.conflicts,  'conflict',    'op'));
  parts.push(chip('', 'identical', s.equal, 'none', 'op'));
  // It looked like every other chip — pointer, hover — and did nothing at
  // all. Clicking it now shows the excluded rows, which is what a person is
  // asking for by clicking a count of them.
  if (s.excluded)    parts.push(chip('', 'excluded', s.excluded, 'excluded', 'view'));
  box.innerHTML = parts.join('');

  const data = fmtBytes(s.bytesTotal);
  const bits = [
    `${s.filesToProcess} item${s.filesToProcess === 1 ? '' : 's'} to process`,
    `${data} to copy`,
    `${s.rows} compared`,
  ];
  // Said in words rather than as empty rows in the grid.
  const pi = state.pairInfo;
  // Not when the list is empty: the panel in the middle of the window already
  // says it in full, and repeating it in the strip reads like a second, weaker
  // answer to the same question.
  if (state.total && pi && pi.pairs > 1 && pi.shown < pi.pairs) {
    const quiet = pi.pairs - pi.shown;
    bits.push(`${quiet} of ${pi.pairs} pairs already in sync`);
  }
  $('status-note').textContent = bits.join(' · ');
}

function isActiveFilter(key, kind) {
  return (kind === 'op' && state.view.onlyOperation === key) ||
         (kind === 'cat' && state.view.onlyCategory === key) ||
         (kind === 'view' && key === 'excluded' && !!state.view.showExcluded);
}

$('stat-chips').addEventListener('click', async e => {
  const chip = e.target.closest('.stat');
  if (!chip || !chip.dataset.key) return;
  const key = chip.dataset.key;
  // The excluded count is a view switch, not an operation filter: it turns
  // the excluded rows on, and it lights up while they are showing.
  if (chip.dataset.kind === 'view' && key === 'excluded') {
    state.view.showExcluded = !state.view.showExcluded;
    const box = $('chk-excluded');
    if (box) box.checked = state.view.showExcluded;
  }
  if (chip.dataset.kind === 'op') {
    state.view.onlyOperation = state.view.onlyOperation === key ? '' : key;
    // Deliberately NOT touching state.view.showEqual here. Filtering on the
    // "identical" chip already tells the engine to include those rows; forcing
    // the switch on instead left it ticked, saved it to the preferences on the
    // next write, and it came back ticked at every launch afterwards.
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
  // The scope names a folder of a tree that is about to be replaced.
  state.view.scope = null;
  renderScopeBar();
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
  state.view.scope = null;  // and so does the scope
  state.ovOpen.clear();     // and so do the folders unfolded in the overview
  clearOvSel();             // and the selection made inside it
  renderScopeBar();
  state.busy = 'compare';
  state.speeds = [];
  setBusyUi(true, 'Comparing…');
  $('pb-title').textContent = 'Comparing…';
  $('btn-pause').style.display = 'none';
  resetCompareProgress();

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

  // A folder the job names that is not there: the rows are already red, and the
  // run will refuse. Checked again here because a drive can be reorganised
  // between opening a job and comparing it.
  await offerRelinkForJob(true);

  // Lock files nobody cleared. The comparison found them for free — it lists
  // the root of every base folder anyway.
  noteStaleLocks(res.staleLocks || []);
}

// ── A folder the job names that is not there ───────────────────────────────
// Raised when a saved job is OPENED, which is the moment a stale path can still
// be fixed for the price of one dialog — before a comparison plans a full copy
// against it and before a run refuses. Raised again after a comparison, because
// a drive can be reorganised between the two.
//
// Every entry is a decision. Where the engine can name the folder that carries
// this pair's database under a new name it says so, and one click takes it;
// otherwise Browse opens where the folder used to be. Nothing is ever applied
// on its own — repointing a mirror at a folder nobody confirmed is how the
// wrong folder gets emptied.
let relinkEntries = [];
// Paths the user has already waved away in this session. Without this, every
// comparison against a drive that is simply not connected reopens the dialog.
const relinkDismissed = new Set();

function relinkKey(e) { return `${e.pairIndex} ${e.side} ${e.path}`; }

async function offerRelinkForJob(quiet) {
  try {
    uiToJob();
    showRelink(await API.checkJobPaths(state.job), quiet);
  } catch (_) { /* checking folders must never stop a job from opening */ }
}

// Same check, without the dialog: run while the user edits a path, so the red
// appears the moment a folder stops resolving and clears the moment it does.
let pathCheckTimer = null;
function recheckPathsSoon() {
  clearTimeout(pathCheckTimer);
  pathCheckTimer = setTimeout(async () => {
    try {
      uiToJob();
      const list = await API.checkJobPaths(state.job);
      state.missingPaths = list;
      markMissingPaths(list);
      renderMissingBadge(list.filter(e => !relinkDismissed.has(relinkKey(e))).length);
    } catch (_) {}
  }, 500);
}

function showRelink(list, quiet) {
  // The red on the rows shows EVERY missing folder, including the ones already
  // waved away. Dismissing only silences the dialog.
  state.missingPaths = list || [];
  markMissingPaths(state.missingPaths);
  const fresh = (list || []).filter(e => !relinkDismissed.has(relinkKey(e)));
  relinkEntries = fresh.map(e => Object.assign({}, e, { chosen: null }));
  renderMissingBadge(relinkEntries.length);
  // At launch the window only marks it. A NAS that is not mounted yet is the
  // normal state of a morning, and a dialog in the face at every start is how
  // a warning stops being read.
  if (!relinkEntries.length || quiet) return;

  const n = relinkEntries.length;
  const named = state.job && state.job.name ? `"${state.job.name}"` : 'this job';
  $('rl-title').textContent = n > 1
    ? `${n} folders this job uses are missing`
    : 'A folder this job uses is missing';
  $('rl-sub').innerHTML =
    `${esc(named)} points at ${n > 1 ? 'folders that are' : 'a folder that is'} not there. ` +
    `Point ${n > 1 ? 'them' : 'it'} at the right place now, or open the job as it is and fix it later — ` +
    `comparing against a missing folder plans a copy of everything into it.`;
  renderRelinkList();
  $('ov-relink').classList.add('open');
}

function renderRelinkList() {
  $('rl-list').innerHTML = relinkEntries.map((e, i) => {
    const where = e.side === 'left' ? 'Source' : 'Destination';
    const tag = [e.label, where].filter(Boolean).join(' · ');
    if (e.chosen) {
      return `<div class="rl-row done" data-i="${i}">
        <div class="rl-hd"><span class="rl-tag">${esc(tag)}</span><span class="rl-state">will be used</span></div>
        <div class="rl-path ok">${esc(e.chosen)}</div>
        <div class="rl-acts"><button class="rl-btn" data-a="undo">Undo</button>
        <button class="rl-btn" data-a="browse">Choose another…</button></div>
      </div>`;
    }
    const hist = e.hadHistory
      ? `<div class="rl-note">Synchronized ${e.lastRun ? 'on ' + esc(new Date(e.lastRun).toLocaleDateString()) : 'before'}` +
        `${e.items ? `, holding ${e.items.toLocaleString()} items` : ''}.</div>`
      : '';
    return `<div class="rl-row" data-i="${i}">
      <div class="rl-hd"><span class="rl-tag">${esc(tag)}</span><span class="rl-state">missing</span></div>
      <div class="rl-path gone">${esc(e.path)}</div>
      ${hist}
      <div class="rl-acts"><button class="rl-btn" data-a="browse">Browse…</button></div>
    </div>`;
  }).join('');
  $('rl-apply').disabled = !relinkEntries.some(e => e.chosen);
}

$('rl-list').addEventListener('click', async e => {
  const btn = e.target.closest('.rl-btn[data-a]');
  if (!btn) return;
  const row = btn.closest('.rl-row');
  const item = relinkEntries[Number(row.dataset.i)];
  if (!item) return;
  if (btn.dataset.a === 'undo') item.chosen = null;
  if (btn.dataset.a === 'browse') {
    const side = item.side === 'left' ? 'Source folder' : 'Destination folder';
    // Opens where the folder used to be: in the renamed case the parent is
    // still there, with the folder under its new name sitting in it.
    const p = await API.browseFolder(`${side} — ${item.label || 'pair'}`, item.path);
    if (!p) return;
    item.chosen = p;
  }
  renderRelinkList();
});

// Writes the confirmed paths into the job — those rows, those sides, nothing
// else — and drops any comparison that was made against the old ones.
async function applyRelink() {
  const done = relinkEntries.filter(e => e.chosen);
  $('ov-relink').classList.remove('open');
  if (!done.length) return;
  uiToJob();
  const pairs = ensurePairs(state.job).pairs;
  for (const e of done) {
    if (!pairs[e.pairIndex]) continue;
    pairs[e.pairIndex][e.side === 'left' ? 'left' : 'right'] = e.chosen;
  }
  jobToUi();
  persist();
  invalidateComparison('Folders changed — compare again.');
  renderMissingBadge(relinkEntries.length - done.length);
  relinkEntries = [];
  recheckPathsSoon();
  $('status-note').textContent = done.length > 1
    ? `${done.length} folders repointed. Compare again.`
    : `${done[0].side === 'left' ? 'Source' : 'Destination'} of pair ${done[0].pair} now points at ${done[0].chosen}.`;
}

function dismissRelink() {
  for (const e of relinkEntries) relinkDismissed.add(relinkKey(e));
  $('ov-relink').classList.remove('open');
  renderMissingBadge(relinkEntries.length);
  relinkEntries = [];
}

// Waved away, or found at startup: the dialog is gone but the problem is not.
// A line in the status strip keeps it one click away instead of silent.
function renderMissingBadge(n) {
  const el = $('missing-badge');
  if (!el) return;
  el.style.display = n > 0 ? '' : 'none';
  el.textContent = n > 0 ? `${n} folder${n > 1 ? 's' : ''} missing — fix` : '';
}

// ── The diagnostic journal ─────────────────────────────────────────────────
// Shown inside the settings so it can be read and copied without going near a
// Finder window — the point is that somebody can send it in two clicks. The
// Copy button is the one the error panels use, so what lands on the clipboard
// is the whole tail, not the part that happens to be scrolled into view.
function showLog(text, keepScroll) {
  $('st-log-box').style.display = $('st-log').checked ? '' : 'none';
  const body = $('st-log-text');
  if (body.textContent === (text || '')) return;      // nothing new to draw
  // Scrolled up to read something? A refresh every 1.5 s that yanks the view
  // back to the bottom makes the panel unreadable while a run is going.
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
  body.textContent = text || '';
  if (!keepScroll || atBottom) body.scrollTop = body.scrollHeight;
  setCopyBlock('st-log-text', String(text || '').split('\n'));
}

// While the settings are open the log is re-read on a timer, so a run that is
// happening RIGHT NOW can be watched line by line. Stopped when the window
// closes: there is no point reading a file nobody is looking at.
let logWatchTimer = null;

function startLogWatch() {
  refreshLogUi();
  clearInterval(logWatchTimer);
  logWatchTimer = setInterval(() => {
    if (!$('ov-settings').classList.contains('open')) return stopLogWatch();
    if (!$('st-log').checked) return;
    refreshLogUi(true);
  }, 1500);
}

function stopLogWatch() { clearInterval(logWatchTimer); logWatchTimer = null; }

async function refreshLogUi(keepScroll) {
  try {
    const li = await API.logInfo();
    if (!li) return;
    $('st-log').checked = !!li.enabled;
    $('st-log-path').textContent = li.file || '';
    showLog(li.text, keepScroll);
  } catch (_) { /* the journal must never stop the window from opening */ }
}

// ── Lock files a previous run left behind ──────────────────────────────────
// syncto locks each folder it writes to and clears the lock when it finishes.
// A run that never finished — a crash, a cable pulled, a NAS that went to
// sleep — leaves the file there. The next run clears it by itself, but only if
// there IS a next run on that folder, so one can sit on a share for months.
//
// The comparison already lists the root of every base folder, so noticing one
// costs nothing. Removing one does not: it is the single thing standing between
// two machines writing the same files, so it is never done on the way past.
let staleLocks = [];

function renderLockBadge() {
  const el = $('lock-badge');
  if (!el) return;
  const n = staleLocks.length;
  el.style.display = n > 0 ? '' : 'none';
  el.disabled = false;
  el.textContent = n > 0
    ? `${n} leftover lock${n > 1 ? 's' : ''} — clear`
    : '';
}

function noteStaleLocks(list) {
  staleLocks = list || [];
  renderLockBadge();
}

async function clearStaleLocksNow() {
  if (!staleLocks.length) return;
  const el = $('lock-badge');
  el.disabled = true;
  el.textContent = 'Checking…';
  // Checking can take a full minute per lock: the file is watched for life
  // signs before anything is removed, exactly as a waiting run would.
  const res = await API.clearLocks(state.job, staleLocks);
  if (!res || !res.ok) {
    renderLockBadge();
    showError('Could not clear the lock files', (res && res.error) || 'Unknown error');
    return;
  }
  const by = k => res.results.filter(r => r.status === k).length;
  const removed = by('removed'), alive = by('alive'), failed = by('failed');
  staleLocks = staleLocks.filter((_, i) =>
    res.results[i] && res.results[i].status === 'failed');
  renderLockBadge();
  const bits = [];
  if (removed) bits.push(`${removed} leftover lock${removed > 1 ? 's' : ''} removed`);
  if (alive)   bits.push(`${alive} still in use — left alone`);
  if (failed)  bits.push(`${failed} could not be removed`);
  $('status-note').textContent = bits.join(' · ') || 'Nothing to clear.';
}

// ── Synchronize ────────────────────────────────────────────────────────────
// Anything that would make the run refuse is checked here, while the settings
// are still one click away. A NAS with no working recycle bin used to be
// discovered file by file, mid-run, after the run had already given up.
async function checkBeforeSync() {
  let res;
  try { res = await API.preflight(state.job); }
  catch (_) { return true; }          // the engine refuses again if need be
  if (!res.ok || !res.warnings.length) return true;

  $('cf-block').style.display = '';
  $('cf-block-body').innerHTML = res.warnings
    .map(w => `<div class="err-item">${w.label ? '[' + esc(w.label) + '] ' : ''}${esc(w.message)}</div>`)
    .join('');
  $('cf-ok').disabled = true;
  $('btn-cf-settings').style.display = '';
  return false;
}

// The names the buttons show. At module scope because two windows say them:
// the confirmation, and the auto-sync card — which used to print the internal
// key ("twoWay") because the map was local to the other one.
const VARIANT_LABEL = { twoWay: 'Two way', mirror: 'Mirror →', update: 'Update →', custom: 'Custom' };

// What the run will really do about proof, for THESE folders. The read-back
// can be turned off for servers, so promising "verified copy" whatever the
// pairs are is a promise the summary then takes back two hours later.
function verificationPhrase() {
  const servers = completePairs().some(p => /^sftp:/i.test(p.left) || /^sftp:/i.test(p.right));
  const off = state.job.sync.verifyRemote === false;
  if (!servers) return 'verified copy (xxHash64)';
  if (!off) return 'verified copy (xxHash64)';
  const bothRemote = completePairs().every(p => /^sftp:/i.test(p.left) && /^sftp:/i.test(p.right));
  return bothRemote ? 'copied, NOT read back (server)'
                    : 'verified on disk, NOT read back on the server';
}

function askConfirm() {
  const s = state.stats;
  uiToJob();
  const j = state.job;
  const CMP_LBL = { timeSize: 'time & size', content: 'content', size: 'size' };

  const np = completePairs().length;
  $('cf-sub').textContent =
    `${np} pair${np > 1 ? 's' : ''} · ${VARIANT_LABEL[j.sync.variant] || j.sync.variant} · compared by ${CMP_LBL[j.compare.compareVariant]} · ${verificationPhrase()}`;
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

  // Reset from a previous pass before the check runs again.
  $('cf-block').style.display = 'none';
  $('btn-cf-settings').style.display = 'none';
  // Disabled until the preflight answers. It runs a real probe against the
  // destination — slow on a NAS or over SFTP — and the button used to be live
  // for that whole round trip, so a quick click started a run the check was
  // about to refuse.
  $('cf-ok').disabled = true;
  $('ov-confirm').classList.add('open');
  checkBeforeSync().then(okToRun => { if (okToRun) $('cf-ok').disabled = false; });
}

async function doSync() {
  $('ov-confirm').classList.remove('open');
  if (state.busy) return;
  uiToJob();
  state.busy = 'sync';
  state.paused = false;
  state.speeds = [];
  setBusyUi(true, 'Synchronizing…', true);
  $('pb-title').textContent = 'Synchronizing…';
  $('pb-ring').classList.remove('spin');
  setStatLabels('Files', 'Left to copy', 'Speed', 'ETA');
  { const del = $('s-del-box'); if (del) del.style.display = ''; }

  const res = await API.sync(state.job);

  state.busy = null;
  setBusyUi(false);
  if (!res.ok) {
    // The phone still has to ring. A run that FAILED is the one the person
    // away from the screen most needs to hear about, and this path used to
    // return before the notification was ever sent.
    notifyRunFailed(res.error);
    showError('Synchronization failed', res.error);
    return;
  }
  showSummary(res);
  setRecheck('busy', 'Comparing both folders again to confirm the result…');
  await doCompareQuiet();
  // Last, so the countdown is drawn over the summary.
  await afterRun(res);
}

// Re-compare after a run so the grid reflects reality without a full re-render
// of the user's intent. Silent: no dialogs. Guarded: it must never race a run
// the user just started, and the previous selection indexes a tree that no
// longer exists.
// The line on the summary card that says the folders are being compared again.
function setRecheck(stateName, text) {
  const box = $('sum-recheck');
  if (!box) return;
  if (!stateName) { box.style.display = 'none'; return; }
  box.style.display = '';
  box.className = 'sum-recheck ' + stateName;
  $('sum-recheck-txt').textContent = text;
}

async function doCompareQuiet() {
  if (state.busy) return;
  // It never claimed the busy flag, so COMPARE and SYNCHRONIZE were live while
  // it ran. A second compare would then close the filesystem pool underneath
  // this one and reassign its sessions — phantom I/O errors, or two trees
  // mixed into one. The buttons stay disabled until it is done.
  state.busy = 'compare';
  $('btn-compare').disabled = true;
  $('btn-sync').disabled = true;
  // Nothing here can be paused, so the button must not sit there offering to.
  $('btn-pause').style.display = 'none';
  state.selIdx = null;
  // It used to run with nothing on screen at all: a few seconds — minutes on a
  // big tree — of a window that answers to nothing, right after a run, which
  // reads as a crash. It is a comparison, so it says so, in the strip.
  setBusyUi(true, 'Checking the result…');
  $('pb-ring').classList.add('spin');
  $('pb-pct').textContent = '';
  setStatLabels('Items scanned', 'Data read', 'Scan rate', 'Elapsed');
  { const del = $('s-del-box'); if (del) del.style.display = 'none'; }
  let res;
  try {
    res = await API.compare(state.job);
  } finally {
    state.busy = null;
    $('pb-ring').classList.remove('spin');
    $('btn-pause').style.display = '';
    setBusyUi(false);
  }
  if (!res || !res.ok || res.cancelled) {
    invalidateComparison('Compare again to synchronize.');
    setRecheck('ko', 'The folders could not be compared again — press Compare when you are ready.');
    return;
  }
  state.stats = res.stats;
  state.comparedPairs = pairsKey(completePairs());
  renderStats();
  await refreshGrid(true);
  await refreshOverview();
  renderAutoUi();
  const left = res.stats.filesToProcess + (res.stats.conflicts || 0);
  setRecheck(left ? 'ko' : 'ok', left
    ? `Compared again: ${left} item${left > 1 ? 's' : ''} still need attention.`
    : 'Compared again: both folders now match.');
}

// ── Progress panel ─────────────────────────────────────────────────────────
const RING_LEN = 182.2;

function setBusyUi(on, title, steps) {
  $('bottombar').classList.toggle('open', on);
  // A RUN — the thing with passes — gets the whole working area and hides the
  // chips describing a comparison that is no longer what is happening. A
  // comparison keeps the strip at the bottom: the grid behind it is filling up
  // and that is worth watching.
  $('bottombar').classList.toggle('kiosk', !!(on && steps));
  document.getElementById('app').classList.toggle('running', !!(on && steps));
  // Only a synchronization has passes. A comparison is one sweep, and drawing
  // a "Verify" step beside it would promise something that is not happening.
  $('pb-steps').style.display = (on && steps) ? '' : 'none';
  if (on && steps) renderSteps('copy');
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
    flowPair = -1;
    { const fl = $('pb-flow'); if (fl) { fl.className = 'pb-flow'; } }
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

// ── Comparison progress ────────────────────────────────────────────────────
// Walking a tree has no total you can know in advance — you find out how big it
// is by finishing. The old code dealt with that by filling the ring over every
// 500 items scanned and starting again, which on a large multi-pair job fills,
// empties and refills for minutes on end. That is not "unknown", it is a
// progress bar that lies, and it tells you less than nothing.
//
// Two honest answers instead:
//
//   • The database remembers how many items these folders held last time. For
//     a backup that runs regularly that is a good estimate, so show a real
//     percentage and call it approximate. Capped at 99 % — the run is not over
//     until it says it is.
//   • No database yet (first comparison of this pair): no percentage at all.
//     The ring spins, and the count of items scanned goes in the middle where
//     the percentage would be. A number that only ever grows.
//
// Across pairs the figures are running totals, and the ring's own progress is
// (finished pairs + fraction of the current one) / pairs. Nothing goes
// backwards, at a pair boundary or anywhere else.
let cmpMaxFrac = 0;

// The four tiles are the same boxes in both phases, so they have to say what
// they are actually showing. During a copy: files done, data left, speed, ETA.
// During a comparison there IS no data left and no ETA — there is a count of
// what has been looked at, how long it has been going, and how fast. Leaving
// the copy labels up made people read "ETA 4s" as four seconds to the end.
function setStatLabels(files, size, spd, eta) {
  const put = (id, t) => { const e = $(id); if (e) e.textContent = t; };
  put('s-files-lbl', files); put('s-size-lbl', size);
  put('s-spd-lbl', spd);     put('s-eta-lbl', eta);
}

function resetCompareProgress() {
  cmpMaxFrac = 0;
  $('pb-ring').classList.remove('spin');
  setStatLabels('Items scanned', 'Data read', 'Scan rate', 'Elapsed');
  // Nothing is removed by a comparison. A tile reading "Removed 0" for two
  // minutes invites the reader to wonder what it is counting down to.
  const del = $('s-del-box'); if (del) del.style.display = 'none';
}

API.onCompareProgress(p => {
  const pairs = Math.max(1, p.pairs || 1);
  const done  = p.pairIndex || 0;
  const label = p.pairs > 1 ? `Pair ${p.pair}/${p.pairs} · ` : '';
  $('pb-file').textContent = label + (p.current || '—');

  const scanned = p.scannedTotal != null ? p.scannedTotal : (p.scanned || 0);
  $('s-files').textContent = String(scanned);
  const bytes = p.bytesTotal != null ? p.bytesTotal : (p.bytes || 0);
  $('s-size').textContent = bytes ? fmtBytes(bytes) + ' read' : '—';

  // Elapsed time, and how fast the scan is going. Neither needs a total to be
  // true, and together they answer "is this thing moving?".
  const ms = p.elapsedMs || 0;
  $('s-eta').textContent = ms >= 1000 ? fmtEta(Math.round(ms / 1000)) : '—';
  // Computed from milliseconds, not from whole seconds: a scan that reaches
  // 22 000 items in the first second showed a blank rate, which is the moment
  // someone is most likely to be wondering whether anything is happening.
  $('s-spd').textContent = ms >= 400
    ? Math.round(scanned / (ms / 1000)).toLocaleString() + ' items/s'
    : '—';

  const ring = $('pb-ring');
  if (p.expected > 0) {
    ring.classList.remove('spin');
    const inPair = Math.min((p.scanned || 0) / p.expected, 0.99);
    const frac = Math.min((done + inPair) / pairs, 0.99);
    cmpMaxFrac = Math.max(cmpMaxFrac, frac);      // never let it fall back
    ring.setAttribute('stroke-dashoffset', RING_LEN * (1 - cmpMaxFrac));
    $('pb-pct').textContent = '≈' + Math.round(cmpMaxFrac * 100) + '%';
  } else {
    // Honest about not knowing: a spinning arc, and the real count in the
    // middle instead of a percentage that would be made up.
    ring.classList.add('spin');
    ring.setAttribute('stroke-dashoffset', RING_LEN * 0.75);
    $('pb-pct').textContent = scanned >= 1000
      ? (scanned / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
      : String(scanned);
  }
});

// The last segment of a path — a folder field can hold a whole URL, and what
// identifies a side on screen is its folder, not its address.
function tailName(p) {
  const s = String(p || '').replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return (i >= 0 ? s.slice(i + 1) : s) || s || '—';
}

// The direction of travel, drawn from what the engine is doing right now.
// `way` is the side being written to (or read back from), so in a two-way run
// the chevrons turn round between two files — which is exactly the thing no
// counter on this screen can tell you.
let flowPair = -1;
function renderFlow(p) {
  const box = $('pb-flow');
  if (!box) return;
  const pairs = (state.job && state.job.pairs) || [];
  const pair = pairs[(p.pair || 1) - 1] || pairs[0];
  if (pair && flowPair !== (p.pair || 1)) {
    flowPair = p.pair || 1;
    $('pf-left-name').textContent  = tailName(pair.left);
    $('pf-right-name').textContent = tailName(pair.right);
    $('pf-left').dataset.tip  = pair.left || '';
    $('pf-right').dataset.tip = pair.right || '';
  }
  const verifying = p.pass === 'verify';
  box.style.setProperty('--flow-color', verifying ? 'var(--blue)' : 'var(--green)');
  box.style.setProperty('--flow-dim',   verifying ? 'var(--blue-d)' : 'var(--green-d)');
  // Nothing is moving during the tail of a run, so the lane empties rather
  // than animating over it. A PAUSE keeps the direction — it is still the way
  // the files are going — and freezes the chevrons where they are.
  const way = p.pass === 'cleanup' ? '' : p.way;
  box.className = 'pb-flow' + (way === 'right' ? ' to-right' : way === 'left' ? ' to-left' : '')
                + (p.paused ? ' paused' : '');
}

API.onSyncProgress(p => {
  // Waiting on another machine's lock: no throughput to show, just who and how long.
  if (p.phase === 'lock') {
    renderFlow(Object.assign({}, p, { way: '' }));
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
  // With several files in flight, naming one of them and nothing else would
  // read as a single slow file. Say how many are going at once.
  $('pb-file').textContent = (p.pairs > 1 ? `[${p.pair}/${p.pairs}] ` : '') + (p.current || '—')
    + (p.inFlight > 1 ? `   + ${p.inFlight - 1} more at the same time` : '');

  // The verification pass gets its own identity, like ingesto: blue everywhere
  // — title, ring, top bar and the step chips — so a read-back is never
  // mistaken for a stall. The colour variables live on #bottombar because the
  // top fill bar is a sibling of .pb-inner and would not inherit them otherwise.
  const verifying = p.pass === 'verify';
  const bar = $('bottombar');
  bar.style.setProperty('--pb-color',  verifying ? 'var(--blue)' : 'var(--green)');
  bar.style.setProperty('--pb-color2', verifying ? '#7bc8ff' : '#00ffaa');
  bar.style.setProperty('--pb-glow',   verifying ? 'rgba(77,144,240,.45)' : 'var(--green-g)');
  renderSteps(p.pass, p.willVerify);
  renderFlow(p);
  $('s-files').innerHTML   = `${p.filesDone}<span class="stot"> / ${p.filesTotal}</span>`;
  // The bytes of the pass that is running, not of the whole run: the ring
  // counts the copy and the read-back together, so this tile used to read
  // twice the size of the folder the overview had just listed.
  $('s-size').textContent  = fmtBytes(Math.max(0, (p.passBytesTotal || 0) - (p.passBytesDone || 0)));
  $('s-size-lbl').textContent = verifying ? 'Left to verify' : 'Left to copy';
  $('s-spd').textContent   = fmtSpeed(p.bytesPerSec);
  $('s-eta').textContent   = fmtEta(p.etaSec);
  $('s-del').textContent   = String(p.deleted || 0);
  $('s-err').textContent   = String(p.errors || 0);
  const title = $('pb-title');
  // After the verification pass only folder deletions and pruning remain —
  // nothing is being copied, so the title must not claim it is.
  title.textContent = p.paused ? 'Paused'
                    : verifying ? 'VERIFYING · xxHash64'
                    : p.pass === 'cleanup' ? 'FINISHING…'
                    : 'COPYING';
  title.style.color = p.paused ? '' : (verifying ? 'var(--blue)' : 'var(--green)');

  // Sampled about twice a second. Pushed per event it held the last quarter
  // of a second at a high file rate — a line of noise rather than a trend —
  // and redrew two SVG shapes each time.
  const nowMs = Date.now();
  if (nowMs - (state.lastSpeedAt || 0) >= 500) {
    state.lastSpeedAt = nowMs;
    state.speeds.push(p.bytesPerSec || 0);
    if (state.speeds.length > 70) state.speeds.shift();
    drawSpark(state.speeds);
  }
});

// ── The passes of a run, drawn as steps ────────────────────────────────────
// Announced before they happen. A verification pass that only appears once it
// starts looks like the copy has stalled — which is exactly what people
// reported. Shown from the moment SYNCHRONIZE is pressed, with the pass that
// is running lit in its own colour.
//
// The list depends on the copy level, because it is not the same run: only
// SECURE reads everything back. Claiming a verification step at a level that
// does not perform one would be worse than showing none.
const ICO_STEP_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

// Always the same three: syncto has one copy mode, and every run reads back
// what it wrote. Announcing the verification before it starts is the point —
// a pass that appears out of nowhere looks like the copy has stalled.
const RUN_STEPS = [
  { key: 'copy',    cls: 'copy',   label: 'Copy' },
  { key: 'verify',  cls: 'verify', label: 'Verify · xxHash64' },
  { key: 'cleanup', cls: 'tail',   label: 'Finish' },
];

// pass: 'copy' | 'verify' | 'cleanup' | null (nothing running yet)
// verifying: false when the read-back is off for this run — the step is then
// dropped rather than drawn and never reached.
// Built once per run, then only the classes change. Rewriting the innerHTML
// on every progress event meant parsing HTML and recalculating style several
// times a second, for three chips that do not move.
let stepsShape = '';
function renderSteps(pass, verifying) {
  const box = $('pb-steps');
  if (!box) return;
  const steps = verifying === false ? RUN_STEPS.filter(s => s.key !== 'verify') : RUN_STEPS;
  const shape = steps.map(s => s.key).join(',');
  if (shape !== stepsShape) {
    stepsShape = shape;
    box.innerHTML = steps.map((s, i) =>
      (i ? '<span class="pb-step-sep"></span>' : '') +
      `<span class="pb-step ${s.cls}" data-step="${s.key}"><span class="mark"></span>${esc(s.label)}</span>`
    ).join('');
  }
  const at = steps.findIndex(s => s.key === pass);
  steps.forEach((s, i) => {
    const el = box.querySelector(`[data-step="${s.key}"]`);
    if (!el) return;
    const state_ = at < 0 ? '' : i < at ? 'done' : i === at ? 'on' : '';
    if (el.dataset.state === state_) return;
    el.dataset.state = state_;
    el.classList.toggle('done', state_ === 'done');
    el.classList.toggle('on',   state_ === 'on');
    el.querySelector('.mark').innerHTML = state_ === 'done' ? ICO_STEP_OK : '<span class="dot"></span>';
  });
}

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

// The one line people look for after a two-hour backup: what was actually
// checked. Written per level, because the three levels do genuinely different
// amounts of work and claiming otherwise would be the same fault as a
// verification that reads the RAM cache.
function renderVerifyLine(res) {
  const box = $('sum-verify');
  const copied = (res.counters && res.counters.files) || 0;
  const verified = res.verified || 0;

  if (!copied && !verified) { box.style.display = 'none'; return; }
  box.style.display = '';

  const ICO_SHIELD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>';
  const ICO_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
  const ICO_WARN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';

  const verifyFailures = (res.errors || []).filter(e => /checksum mismatch/i.test(e.message || '')).length;
  let kind, ico, head, sub;

  if (verifyFailures) {
    kind = 'bad'; ico = ICO_X;
    head = `${verifyFailures} file${verifyFailures > 1 ? 's' : ''} failed verification`;
    sub = 'They were read back and did not match what was written. They are listed below, left '
        + 'out of the checksum list, and will be looked at again on the next run.';
  } else if (verified) {
    kind = 'good'; ico = ICO_SHIELD;
    head = `${verified} file${verified > 1 ? 's' : ''} read back and verified`;
    sub = 'Every file was copied, then read from its final location and compared with the '
        + 'xxHash64 fingerprint taken while writing. Not one differed.';
  } else if (copied) {
    // Files were copied and nothing read them back: the read-back is off for
    // servers in the settings. This line is the one people trust after a long
    // backup, so it has to say plainly that there is no proof this time.
    kind = 'warn'; ico = ICO_WARN;
    head = `${copied} file${copied > 1 ? 's' : ''} copied — not read back`;
    sub = 'Reading files back is turned off for servers in the settings, so these copies were '
        + 'checked for their size only, like any ordinary transfer. Turn it back on for a run '
        + 'you need proof of.';
  } else {
    kind = 'good'; ico = ICO_SHIELD;
    head = 'Nothing needed copying';
    sub = 'Both sides already matched, so there was nothing to verify.';
  }

  box.className = 'sum-verify ' + kind;
  $('sum-verify-ico').innerHTML = ico;
  $('sum-verify-h').textContent = head;
  $('sum-verify-sub').textContent = sub;
}

function showSummary(res) {
  // A line left over from the previous run would describe the wrong one.
  setRecheck(null);
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

  renderVerifyLine(res);

  $('sum-errors').style.display = failed ? '' : 'none';
  $('sum-errors-body').innerHTML = res.errors.slice(0, 60)
    .map(e => `<div class="err-item">${esc(e.rel)} — ${esc(e.message)}</div>`).join('');
  setCopyBlock('sum-errors-body', res.errors.map(e => `${e.rel} — ${e.message}`),
    copyHeader(`${res.errors.length} error${res.errors.length > 1 ? 's' : ''}`));

  $('sum-notes').style.display = res.notes.length ? '' : 'none';
  $('sum-notes-body').innerHTML = res.notes.slice(0, 40)
    .map(n => `<div class="err-item">${esc(n)}</div>`).join('');
  setCopyBlock('sum-notes-body', res.notes.slice(), copyHeader(`${res.notes.length} notes`));

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

// ── Copyable error / note blocks ───────────────────────────────────────────
// The panels show at most 60 lines; what gets copied is the WHOLE list. A log
// you cannot select is a log you cannot send to anyone, and these boxes are
// exactly the ones people need to forward.
const ICON_COPY  = '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="14" height="14" rx="2"/>'
  + '<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>';
const copyBuf = Object.create(null);

// `lines` is the full list, not the truncated one that is on screen.
function setCopyBlock(bodyId, lines, header) {
  const body = (header ? [header, ''] : []).concat(lines);
  copyBuf[bodyId] = body.join('\n');
  const btn = document.querySelector(`.err-copy[data-copy="${bodyId}"]`);
  if (btn) { btn.classList.remove('done'); btn.innerHTML = ICON_COPY + '<span>Copy</span>'; }
}

function copyHeader(what) {
  const v = state.version ? ' ' + state.version : '';
  const name = (state.job && state.job.name) ? ' · ' + state.job.name : '';
  return `syncto${v}${name} · ${what} · ${new Date().toLocaleString()}`;
}

document.addEventListener('click', async e => {
  const btn = e.target.closest('.err-copy');
  if (!btn) return;
  const text = copyBuf[btn.dataset.copy];
  if (!text) return;
  const ok = await API.copyText(text);
  btn.innerHTML = (ok ? ICON_CHECK : ICON_COPY) + `<span>${ok ? 'Copied' : 'Failed'}</span>`;
  btn.classList.toggle('done', !!ok);
  clearTimeout(btn._t);
  btn._t = setTimeout(() => {
    btn.classList.remove('done');
    btn.innerHTML = ICON_COPY + '<span>Copy</span>';
  }, 1600);
});

function showError(title, msg) {
  // Not left over from the last successful run: a green "150 files verified"
  // shield under a red error card certifies something unrelated.
  { const v = $('sum-verify'); if (v) v.style.display = 'none'; }
  $('sum-ico').className = 'sum-ico err';
  $('sum-ico').innerHTML = ICO_ERR;
  $('sum-h1').textContent = title;
  $('sum-h2').textContent = '';
  $('sum-grid').innerHTML = '';
  $('sum-errors').style.display = '';
  $('sum-errors-body').innerHTML = `<div class="err-item">${esc(msg)}</div>`;
  setCopyBlock('sum-errors-body', [msg], copyHeader(title));
  $('sum-notes').style.display = 'none';
  $('sum-files').innerHTML = '';
  $('sum-open-report').style.display = 'none';
  $('ov-summary').classList.add('open');
}

// ── Verify ─────────────────────────────────────────────────────────────────
const VF_LEN = 395.8;

// The menu entry stays clickable while a verification runs; without this the
// second click reset the panel of the run still in progress.
let vfBusy = false;

async function doVerify() {
  if (vfBusy) { $('ov-verify').classList.add('open'); return; }
  const folder = await API.browseFolder('Choose a folder to verify');
  if (!folder) return;
  vfBusy = true;
  $('vf-title').textContent = 'Verifying…';
  $('vf-pct').textContent = '0%';
  $('vf-ring').setAttribute('stroke-dashoffset', VF_LEN);
  $('vf-line').textContent = folder;
  $('vf-grid').innerHTML = '';
  $('vf-bad').style.display = 'none';
  $('ov-verify').classList.add('open');

  let res;
  try { res = await API.verifyFolder(folder); }
  finally { vfBusy = false; }
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
  setCopyBlock('vf-bad-body', bad.map(r => `${r.rel} — ${r.status}`),
    copyHeader(`verify · ${bad.length} problem${bad.length > 1 ? 's' : ''}`));
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
  $('btn-settings').addEventListener('click', () => {
    jobToUi(); $('ov-settings').classList.add('open');
    // The log is read from disk HERE, not once at launch. It was loaded at
    // startup and never again, so the panel showed the three header lines for
    // the rest of the session — and the Copy button copied that, while the
    // real log on disk had the whole run in it.
    startLogWatch();
  });
  $('set-close').addEventListener('click', () => { uiToJob(); $('ov-settings').classList.remove('open'); persist(); stopLogWatch(); });

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

  $('scope-clear').addEventListener('click', async () => {
    state.view.scope = null;
    renderScopeBar();
    await refreshGrid(true);
    await refreshOverview();
  });

  $('rl-apply').addEventListener('click', applyRelink);
  $('rl-ignore').addEventListener('click', dismissRelink);
  $('missing-badge').addEventListener('click', () => offerRelinkForJob(false));
  $('lock-badge').addEventListener('click', clearStaleLocksNow);
  $('cf-cancel').addEventListener('click', () => $('ov-confirm').classList.remove('open'));
  $('btn-cf-settings').addEventListener('click', () => {
    $('ov-confirm').classList.remove('open');
    $('btn-settings').click();
  });
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


  $('st-rep-browse').addEventListener('click', async () => { const p = await API.browseFolder('Report folder'); if (p) $('st-rep-folder').value = p; });

  // Diagnostics. The journal is written by the engine, not the window: what
  // matters is what the filesystem and the server actually answered, not what
  // the interface believed at the time.
  $('st-log').addEventListener('change', async e => {
    const res = await API.logSet(e.target.checked);
    e.target.checked = !!(res && res.enabled);
    showLog(res && res.text);
  });
  $('st-log-refresh').addEventListener('click', async () => {
    const li = await API.logInfo();
    showLog(li && li.text);
  });
  $('st-log-clear').addEventListener('click', async () => showLog(await API.logClear()));
  $('st-log-save').addEventListener('click', async () => {
    const b = $('st-log-save');
    const res = await API.logSave();
    if (res && res.canceled) return;
    // Said on the button itself: a save dialog that closes with no sign of
    // what happened leaves people clicking it again.
    b.textContent = res && res.ok ? 'SAVED' : 'FAILED';
    b.classList.toggle('done', !!(res && res.ok));
    if (res && res.path) $('st-log-path').textContent = res.path;
    setTimeout(() => { b.textContent = 'SAVE .TXT'; b.classList.remove('done'); }, 1800);
  });
  $('st-log-path').addEventListener('click', () => API.logReveal());



  // One click swaps SOURCE and DESTINATION for EVERY pair of the job.

  // Pair rows: edit in place, browse per field, remove, add.
  $('pairrows').addEventListener('change', e => {
    if (!e.target.matches('.pr-left, .pr-right')) return;
    // The server button doubles as that field's status light. Updated in place
    // rather than by redrawing the rows, because redrawing while someone is
    // tabbing between fields takes the focus away from them.
    lightServerButton(e.target);
    // onPathChanged, not just persist: editing a pair changes WHICH folders
    // the job covers, and the plan in memory belongs to the old set.
    onPathChanged();
  });
  $('pairrows').addEventListener('click', async e => {
    const row = e.target.closest('.prow');
    if (!row) return;
    const i = Number(row.dataset.i);
    if (e.target.closest('.pr-rm')) {
      // The last remaining pair's button is disabled, so this cannot empty a
      // job down to nothing.
      if (state.job.pairs.length <= 1) return;
      uiToJob();
      state.job.pairs.splice(i, 1);
      jobToUi();
      onPathChanged();
      return;
    }
    if (e.target.closest('.pr-swap')) {
      uiToJob();
      const p = state.job.pairs[i];
      if (p) { const t = p.left; p.left = p.right; p.right = t; }
      jobToUi();
      onPathChanged();
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
    // jobToUi so the ✕ on pair 1 reappears: with only renderPairRows it stayed
    // hidden, and pair 1 could not be removed until the job was reloaded.
    jobToUi();
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


  $('chk-equal').addEventListener('change', async e => {
    state.view.showEqual = e.target.checked;
    await refreshGrid(true);
    await refreshOverview();     // zone 2 follows the same switch now
    persist();
  });
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
      case 'swap': swapAllPairs(); break;
      case 'invert': state.stats = await API.invertAll(); afterEdit(); break;
      case 'verify': doVerify(); break;
      case 'job-new': newJob(); break;
      case 'job-open': openJob(); break;
      case 'job-save': saveJobFile(false); break;
      case 'job-save-as': saveJobFile(true); break;
      case 'job-close': closeJob(); break;
      default: break;
    }
  });

  // Zone 1 — job actions + recent list
  $('job-new').addEventListener('click', newJob);
  $('job-open-btn').addEventListener('click', openJob);
  $('job-save-btn').addEventListener('click', () => saveJobFile(false));
  $('job-saveas-btn').addEventListener('click', () => saveJobFile(true));
  $('job-close-btn').addEventListener('click', () => closeJob());
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
        `Every ${n} minute${n > 1 ? 's' : ''}: ${VARIANT_LABEL[state.job.sync.variant] || state.job.sync.variant} ` +
        `synchronization of ${np} pair${np > 1 ? 's' : ''} · ${verificationPhrase()}.`;
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
    // The one floating surface a keyboard could open and not close.
    if (e.key === 'Escape') closeCtx();
    if (e.key === 'Escape') {
      // Escape goes through each modal's own close button: several of them do
      // real work on close (settings persist, the filter modal re-compares,
      // the verify modal cancels the run) — just hiding them would skip that.
      const ESC_CLOSE = {
        'ov-settings': 'set-close',   'ov-filter' : 'filter-close',
        'ov-confirm' : 'cf-cancel',   'ov-summary': 'sum-close',
        'ov-relink'  : 'rl-ignore',
        'ov-verify'  : 'vf-close',    'ov-auto'   : 'auto-cf-cancel',
        'update-ov'  : 'upd-later',
        // Closing this one drops the SSH connection — hiding the window and
        // leaving the session open would hold a slot on the server for nothing.
        'ov-server'  : 'srv-cancel',
        // Escape is the safe direction here: it calls off the shutdown.
        'ov-after'   : 'after-cancel',
      };
      for (const ov of document.querySelectorAll('.ov.open')) {
        const btn = ESC_CLOSE[ov.id] && document.getElementById(ESC_CLOSE[ov.id]);
        if (btn) btn.click(); else ov.classList.remove('open');
      }
    }
  });

  bindServerDialog();
  bindAfterAndNtfy();
  installTooltips();
}

// A pair changed. Nothing here reads the disk any more: the free-space line
// under each field was the only reason to, and a folder pair is a source and a
// destination — the disk figures belonged to the machine, not to the job, and
// they were what stopped every pair from lining up.
async function onPathChanged() {
  uiToJob();
  invalidateIfPairsChanged();
  persist();
  // Debounced: the red follows what is typed, without a stat per keystroke.
  recheckPathsSoon();
}

// ⌘T — swaps every pair at once. Each row also has its own swap button, which
// swaps that row only.
function swapAllPairs() {
  uiToJob();
  for (const p of state.job.pairs) { const t = p.left; p.left = p.right; p.right = t; }
  jobToUi();
  onPathChanged();
}

async function newJob() {
  autoStop();
  relinkEntries = []; state.missingPaths = []; renderMissingBadge(0);
  noteStaleLocks([]);
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
  // Opening a saved job is the moment to find out that one of the folders it
  // names is not there any more — while it costs one dialog, rather than after
  // a comparison has planned a full copy into it.
  await offerRelinkForJob();
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

// ── Closing a job ──────────────────────────────────────────────────────────
// "Close" means: take this job out of the JOBS list, and — if it is the one
// currently open — go back to an untitled job. It never deletes the file. The
// status strip says so afterwards, with the path, because a job disappearing
// from a list is exactly the moment someone wonders whether they just lost it.
async function closeJob(p) {
  const target = p || state.jobPath;
  if (!target) return;
  const name = (state.recent.find(r => r.path === target) || {}).name ||
               (state.jobPath === target ? state.job.name : '') || 'That job';
  const res = await API.jobClose(target);
  if (res && res.recent) state.recent = res.recent;

  if (res && res.closedCurrent) {
    autoStop();
    state.job = await API.jobNew();
    state.jobPath = '';
    jobToUi();
    state.stats = null; state.total = 0; state.comparedPairs = null;
    renderStats();
    await refreshGrid(true);
    await refreshOverview();
    // The preferences hold a copy of the open job; without this the blank one
    // is only written on the next edit, and a crash in between reopens the job
    // that was just closed.
    persist();
  }
  renderRecent();
  renderJobActions();
  $('status-note').textContent = `${name} closed — the file is still on disk: ${target}`;
}

// CLOSE is only meaningful while a job file is open. NEW is what clears an
// untitled one, and saying so in the tooltip is cheaper than a dialog.
function renderJobActions() {
  const b = $('job-close-btn');
  if (!b) return;
  b.disabled = !state.jobPath;
  b.dataset.tip = state.jobPath
    ? 'Close this job — the file stays on disk'
    : 'Nothing to close — no job file is open';
}

const CTX_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>';
const CTX_CLOSE = '<svg class="ko" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

function openJobCtx(x, y, jobPath) {
  closeCtx();
  if (!jobPath) return;
  const m = document.createElement('div');
  m.id = 'ctx-menu';
  m.className = 'ctx';
  m.innerHTML =
    `<div class="ctx-it" data-k="open">${CTX_OPEN}<span class="lbl">Open</span></div>` +
    `<div class="ctx-it" data-k="rv">${CTX_REVEAL}<span class="lbl">${REVEAL_VERB}</span></div>` +
    `<div class="ctx-sep"></div>` +
    `<div class="ctx-it" data-k="close">${CTX_CLOSE}<span class="lbl">Close</span></div>`;
  document.body.appendChild(m);
  const rct = m.getBoundingClientRect();
  m.style.left = Math.min(x, window.innerWidth - rct.width - 8) + 'px';
  m.style.top  = Math.min(y, window.innerHeight - rct.height - 8) + 'px';
  m.addEventListener('click', async e => {
    const it = e.target.closest('.ctx-it[data-k]');
    if (!it || it.classList.contains('off')) return;
    e.stopPropagation();
    closeCtx();
    if (it.dataset.k === 'open')  return openRecent(jobPath);
    if (it.dataset.k === 'rv')    return API.revealPath(jobPath);
    if (it.dataset.k === 'close') return closeJob(jobPath);
  });
}

document.addEventListener('contextmenu', e => {
  const it = e.target.closest('.recent-item');
  if (!it) return;
  e.preventDefault();
  e.stopPropagation();
  openJobCtx(e.clientX, e.clientY, it.dataset.path);
});

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
  await offerRelinkForJob();
}

// ── Zone 2 — overview of the compared folders ──────────────────────────────
async function refreshOverview() {
  const box = $('ov-list');
  if (!state.stats) {
    box.innerHTML = '<div class="ov-empty">Run a comparison to see the folder breakdown.</div>';
    return;
  }
  // The engine only expands a level it is told is open, so a folded panel
  // costs exactly what it did before.
  const open = [...state.ovOpen].map(k => {
    const i = k.indexOf(':');
    return { p: Number(k.slice(0, i)), rel: k.slice(i + 1) };
  });
  const ov = await API.getOverview(state.view, open, state.ovSort);
  if (!ov || !ov.rows.length) {
    const nothing = state.stats.rows > 0;
    box.innerHTML = nothing
      ? '<div class="ov-empty">Nothing to do — both sides already match.<br>Tick “Show identical” to list the folders anyway.</div>'
      : '<div class="ov-empty">Both folders are empty.</div>';
    return;
  }
  // Every row here is a TOP-LEVEL entry of its pair. With several pairs those
  // lists used to be merged and sorted by size together, so a root folder of
  // pair 2 landed between two root folders of pair 1 with nothing on screen
  // saying so — which reads as an arbitrary mix of roots and sub-folders.
  // Each pair now gets its own heading.
  const multi = ov.pairs > 1;
  // Drawn order and a lookup by key: a Shift range is "everything between
  // these two ON SCREEN", which only the drawn order knows.
  state.ovOrder = ov.rows.map(g => g.pairIdx + ':' + g.rel);
  state.ovByKey = new Map(ov.rows.map(g => [g.pairIdx + ':' + g.rel, g]));
  for (const k of [...state.ovSel]) if (!state.ovByKey.has(k)) state.ovSel.delete(k);
  // Said only when there is something to go back from, so it is never noise.
  const back = viewIsNarrowed()
    ? '<div class="ov-reset">Click the empty space below to <b>show everything</b> again.</div>'
    : '';
  box.classList.toggle('can-reset', viewIsNarrowed());
  box.innerHTML = ov.rows.map(g => {
    const head = (multi && g.first)
      ? `<div class="ov-pairhead"><span class="n">${g.pair}</span>${esc(g.pairLabel)}</div>`
      : '';
    const scoped = state.view.scope && state.view.scope.p === g.pairIdx &&
                   state.view.scope.rel === g.rel;
    // The arrow is a real target of its own: it unfolds without moving the
    // grid. An empty slot keeps every name on the same left edge.
    const twist = g.kids
      ? `<span class="ov-twist${g.open ? ' open' : ''}">${ICON_CHEV}</span>`
      : '<span class="ov-twist none"></span>';
    const key = g.pairIdx + ':' + g.rel;
    return head + `
    <div class="ov-row${g.idx === state.selIdx ? ' sel' : ''}${g.active ? '' : ' off'}${scoped ? ' scoped' : ''}${state.ovSel.has(key) ? ' picked' : ''}"
         data-idx="${g.idx}" data-name="${esc(g.name)}" data-rel="${esc(g.rel)}" data-type="${g.type}"
         data-pair="${g.pairIdx}" data-active="${g.active ? 1 : 0}" data-kids="${g.kids ? 1 : 0}"
         data-tip="${g.pairLabel ? '[' + esc(g.pairLabel) + '] ' : ''}${esc(g.rel)} — ${g.items} item${g.items === 1 ? '' : 's'}, ${esc(fmtBytes(g.bytes))}.${g.kids ? ' Click to open it here and show it in the grid.' : ' Click to show it in the grid.'}">
      <div class="ov-chk"><input type="checkbox" ${g.active ? 'checked' : ''} data-act="toggle"></div>
      <div class="ov-pct"><div class="bar" style="width:${g.pct}%"></div><div class="lbl">${g.pct}%</div></div>
      <div class="ov-name" style="padding-left:${g.depth * 11}px">${twist}${g.type === 'folder' ? ICON_FOLDER : ICON_FILE}<span>${esc(g.name)}</span></div>
      <div class="ov-items">${g.items}</div>
      <div class="ov-bytes">${esc(fmtBytes(g.bytes))}</div>
    </div>`;
  // The hint sits at the END of the list, next to the empty space it is
  // talking about, not above the rows where it would push them down.
  }).join('') + back;
}

// What a gesture on ONE row applies to: the whole selection when that row is
// part of it, the row alone otherwise. Rows with no node of their own (never
// seen in practice) are dropped rather than sent to the engine as -1.
function ovIndicesFor(key) {
  const keys = state.ovSel.has(key) && state.ovSel.size > 1 ? [...state.ovSel] : [key];
  return keys.map(k => state.ovByKey.get(k))
             .filter(g => g && g.idx >= 0)
             .map(g => g.idx);
}

function clearOvSel() {
  state.ovSel.clear();
  state.ovAnchor = null;
}

// Clicking a column title orders the panel by it, at every level of the tree.
// First click on a name reads A→Z; first click on a number puts the biggest
// first, which is what a size column is usually asked for.
function renderOvHead() {
  const s = state.ovSort;
  for (const cell of document.querySelectorAll('#ov-head [data-sort]')) {
    const on = cell.dataset.sort === s.key;
    cell.classList.toggle('on', on);
    cell.dataset.dir = on ? s.dir : '';
  }
}

$('ov-head').addEventListener('click', async e => {
  const cell = e.target.closest('[data-sort]');
  if (!cell) return;
  const k = cell.dataset.sort;
  const s = state.ovSort;
  state.ovSort = s.key === k
    ? { key: k, dir: s.dir === 'asc' ? 'desc' : 'asc' }
    : { key: k, dir: k === 'name' ? 'asc' : 'desc' };
  renderOvHead();
  await refreshOverview();
});

// The bar above the grid that says what it is currently showing, and how to
// get back to everything.
function renderScopeBar() {
  const bar = $('scope-bar');
  const sc = state.view.scope;
  if (!sc || !sc.rel) { bar.style.display = 'none'; return; }
  bar.style.display = '';
  $('scope-name').textContent = sc.rel;
  $('scope-pair').textContent = sc.label || '';
  $('scope-pair').style.display = sc.label ? '' : 'none';
}

async function setScope(pairIdx, rel, label) {
  const sc = state.view.scope;
  const same = sc && sc.p === pairIdx && sc.rel === rel;
  state.view.scope = same ? null : { p: pairIdx, rel, label };
  renderScopeBar();
  await refreshGrid(true);
  await refreshOverview();
}

// Selection + right-click in the overview: same behaviour as the grid.
// Clicking a folder in the overview shows THAT folder in the grid — the
// panel is a navigator, not just a legend. Clicking it again shows everything.
//
// It also unfolds, so one click answers "what is in there?" in both places at
// once: the folder opens in the panel and the grid narrows to it. The arrow
// alone unfolds WITHOUT touching the grid, for reading down a tree while the
// grid stays where it is.
$('ov-list').addEventListener('click', async e => {
  const it = e.target.closest('.ov-row');
  // Nothing under the pointer: the empty part of the panel is the way back to
  // the whole run.
  if (!it) {
    if (viewIsNarrowed()) await showEverything();
    return;
  }
  const key = it.dataset.pair + ':' + it.dataset.rel;
  const kids = it.dataset.kids === '1';

  // The tick box. Inside a selection it applies to the WHOLE selection — that
  // is the batch this panel was missing: ten camera folders out of a run used
  // to be ten trips through the grid.
  const box = e.target.closest('[data-act="toggle"]');
  if (box) {
    const on = !!box.checked;
    const idxs = ovIndicesFor(key);
    if (!idxs.length) return;
    state.stats = await API.setActive(idxs, on);
    afterEdit();
    await dropScopeIfEmpty();
    await refreshOverview();
    return;
  }

  // Shift extends from the last row clicked, Cmd/Ctrl adds or removes one.
  // Neither moves the grid: picking a batch is not the same gesture as asking
  // to look at a folder.
  if (e.shiftKey && state.ovAnchor && state.ovByKey.has(state.ovAnchor)) {
    const a = state.ovOrder.indexOf(state.ovAnchor);
    const b = state.ovOrder.indexOf(key);
    if (a >= 0 && b >= 0) {
      state.ovSel = new Set(state.ovOrder.slice(Math.min(a, b), Math.max(a, b) + 1));
      await refreshOverview();
    }
    return;
  }
  if (e.metaKey || e.ctrlKey) {
    if (state.ovSel.has(key)) state.ovSel.delete(key); else state.ovSel.add(key);
    state.ovAnchor = key;
    await refreshOverview();
    return;
  }

  if (e.target.closest('.ov-twist')) {
    if (!kids) return;
    if (state.ovOpen.has(key)) state.ovOpen.delete(key); else state.ovOpen.add(key);
    await refreshOverview();
    return;
  }

  const idx = Number(it.dataset.idx);
  if (idx >= 0) state.selIdx = idx;
  // A plain click restarts the selection on this row — the anchor a Shift
  // range will measure from.
  state.ovSel = new Set([key]);
  state.ovAnchor = key;
  const pairIdx = Number(it.dataset.pair);
  const label = it.dataset.tip.startsWith('[') ? it.dataset.tip.slice(1, it.dataset.tip.indexOf(']')) : '';
  // `scoped` is what setScope is about to toggle off, so the folder folds on
  // the same click that puts the grid back to everything.
  if (kids) {
    if (it.classList.contains('scoped')) state.ovOpen.delete(key);
    else state.ovOpen.add(key);
  }
  await setScope(Number.isNaN(pairIdx) ? 0 : pairIdx, it.dataset.rel, label);
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
  const key = it.dataset.pair + ':' + it.dataset.rel;
  if (!state.ovSel.has(key)) { state.ovSel = new Set([key]); state.ovAnchor = key; }
  await refreshOverview();
  openCtx(e.clientX, e.clientY, {
    // rel is the path from the root of the pair — inside an unfolded folder
    // the name alone would build an exclusion pattern for the wrong level.
    idx, rel: it.dataset.rel, name: it.dataset.name,
    type: it.dataset.type, active: it.dataset.active === '1',
    // Right-clicking inside a selection excludes the whole selection.
    batch: ovIndicesFor(key),
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
  setBusyUi(true, 'Auto-sync — synchronizing…', true);
  const res = await API.sync(state.job);
  state.busy = null;
  setBusyUi(false);
  if (!res.ok) {
    $('footer-auto').textContent = `auto-sync ${stamp()}: failed — ${res.error}`;
    // A run that failed is the one a person away from the screen most needs
    // to hear about — and auto-sync is unattended by definition. The manual
    // path has sent this since 0.4.0; this one returned before it.
    notifyRunFailed(res.error);
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
  await afterRun(res);
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

// A run that failed before producing a result still has to reach the phone.
function notifyRunFailed(message) {
  API.ntfyRun({
    counters: {}, errors: [{ rel: '', message: String(message || 'The run failed.') }],
    durationMs: 0,
  }, state.job.name).catch(() => {});
}

// ── After the run ──────────────────────────────────────────────────────────
// A machine that shuts itself down takes the summary with it, so the action
// only fires on a run with nothing to read: no errors, not cancelled, lock
// never lost. And even then, thirty seconds with a Cancel button in the way.
const AFTER_SECONDS = 30;
const afterState = { timer: null, left: 0, action: 'none' };

function runWasClean(res) {
  return !res.cancelled && !res.stopped && !res.lockLost &&
         !(res.errors && res.errors.length) &&
         !(res.counters && res.counters.errors);
}

function stopCountdown() {
  if (afterState.timer) { clearInterval(afterState.timer); afterState.timer = null; }
  $('ov-after').classList.remove('open');
}

async function fireAfterAction() {
  stopCountdown();
  const res = await API.afterSync(afterState.action, afterState.clean === true);
  if (res && !res.ok && res.error) showError('The machine did not respond', res.error);
}

function startAfterCountdown(action) {
  const WHAT = {
    quit    : ['syncto will quit',       'The synchronization finished with no errors.'],
    sleep   : ['This machine will sleep', 'The synchronization finished with no errors.'],
    shutdown: ['This machine will shut down', 'The synchronization finished with no errors.'],
  };
  const w = WHAT[action];
  if (!w) return;
  afterState.action = action;
  afterState.clean = true;      // only ever reached from a clean run
  afterState.left = AFTER_SECONDS;
  $('after-what').textContent = w[0];
  $('after-sub').textContent  = w[1];
  $('after-count').textContent = String(afterState.left);
  $('ov-after').classList.add('open');
  afterState.timer = setInterval(() => {
    afterState.left--;
    $('after-count').textContent = String(Math.max(0, afterState.left));
    if (afterState.left <= 0) fireAfterAction();
  }, 1000);
}

// Called once a run is over, before anything else can grab attention.
async function afterRun(res) {
  // The notification goes out whatever happened — that is the point of being
  // told on a phone. It never blocks and never fails the run, but a failure to
  // SEND is worth a line: someone who relies on it for overnight backups
  // otherwise reads silence as success.
  API.ntfyRun(res, state.job.name).then(r => {
    if (r && !r.ok && !r.skipped) {
      $('status-note').textContent = `The phone notification could not be sent: ${r.error}`;
    }
  }).catch(() => {});

  const action = (state.job.sync && state.job.sync.afterSync) || 'none';
  if (action === 'none') return;
  if (!runWasClean(res)) {
    $('status-note').textContent =
      `“${action === 'quit' ? 'Quit syncto' : action === 'sleep' ? 'Sleep' : 'Shut down'}” was skipped: ` +
      `the run did not finish cleanly.`;
    return;
  }
  // Auto-sync and shutting down cannot both be true. The machine wins — and
  // the switch has to follow, or the window keeps its red frame and its
  // "AUTO-SYNC ON" button over a scheduler that will never fire again.
  if (isAutoOn()) {
    state.job.autoSync.enabled = false;
    autoStop();
    renderAutoUi();
    persist();
  }
  startAfterCountdown(action);
}

// ntfy settings live in the preferences, not in the job: a phone belongs to a
// person and a machine, not to a folder pair shared inside a .syncto file.
async function loadNtfyUi() {
  const n = await API.ntfyGet();
  $('st-ntfy-en').checked      = n.enabled;
  $('st-ntfy-server').value    = n.server;
  $('st-ntfy-topic').value     = n.topic;
  $('st-ntfy-problem').checked = n.onlyOnProblem;
  // The token itself never comes back here. Only whether one is stored.
  $('st-ntfy-token').value = '';
  $('st-ntfy-token').placeholder = n.hasToken
    ? 'stored — type a new one to replace it'
    : 'only for a server that needs one';
}

function ntfyPatchFromUi(includeToken) {
  const p = {
    enabled: $('st-ntfy-en').checked,
    server : $('st-ntfy-server').value.trim(),
    topic  : $('st-ntfy-topic').value.trim(),
    onlyOnProblem: $('st-ntfy-problem').checked,
  };
  // An empty box means "leave what is stored alone", not "erase it" — the
  // panel never held the token in the first place.
  const t = $('st-ntfy-token').value;
  if (includeToken && t) p.token = t;
  return p;
}

function bindAfterAndNtfy() {
  $('after-cancel').addEventListener('click', () => {
    stopCountdown();
    $('status-note').textContent = 'Cancelled — the machine was left alone.';
  });
  $('after-now').addEventListener('click', fireAfterAction);

  for (const id of ['st-ntfy-en', 'st-ntfy-server', 'st-ntfy-topic', 'st-ntfy-problem']) {
    $(id).addEventListener('change', () => API.ntfySave(ntfyPatchFromUi(false)));
  }
  $('st-ntfy-token').addEventListener('change', () => {
    if ($('st-ntfy-token').value) API.ntfySave(ntfyPatchFromUi(true));
  });

  $('ntfy-site').addEventListener('click', () => API.openExternal('https://ntfy.sh/'));

  $('st-ntfy-test').addEventListener('click', async () => {
    const res = $('st-ntfy-res');
    const topic = $('st-ntfy-topic').value.trim();
    if (!topic) { res.textContent = 'Enter a topic first.'; res.style.color = 'var(--orange)'; return; }
    res.textContent = 'Sending…'; res.style.color = 'var(--text3)';
    await API.ntfySave(ntfyPatchFromUi(true));
    const r = await API.ntfyTest(ntfyPatchFromUi(true));
    if (r && r.ok) { res.textContent = '✓ Sent — check your phone.'; res.style.color = 'var(--green)'; }
    else { res.textContent = '✗ ' + ((r && r.error) || 'Failed'); res.style.color = 'var(--red)'; }
  });
}

// ── Connect to a server ────────────────────────────────────────────────────
// Replaces "type an sftp:// URL from memory into a field that otherwise wants
// a local path". Two steps in one window: who and where, then which folder.
//
// The password is never held here longer than the moment it is typed. A
// remembered one is decrypted in the main process, used, and dropped — it
// never crosses into this window at all.
const srv = {
  target: null,      // { kind:'main'|'pair', side:'left'|'right', index }
  cwd   : '/',
  picked: '/',
  conn  : null,      // what we actually connected with (no password kept)
  savedId: null,
};

const SRV_ICONS = {
  idle: '<path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  busy: '<g class="spin" style="transform-box:fill-box"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></g>',
  good: '<path d="M20 6 9 17l-5-5"/>',
  bad : '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
};

function srvStatus(kind, text) {
  const box = $('srv-status');
  box.className = 'srv-status ' + kind;
  box.querySelector('svg').innerHTML = SRV_ICONS[kind];
  $('srv-status-txt').textContent = text;
}

function srvShowStep(n) {
  $('srv-step1').style.display = n === 1 ? '' : 'none';
  $('srv-step2').style.display = n === 2 ? '' : 'none';
}

async function openServerDialog(target) {
  srv.target = target;
  srv.savedId = null;
  srv.conn = null;
  const side = target.side === 'left' ? 'source' : 'destination';
  // Plain text: SOURCE and DESTINATION are grey labels everywhere else since
  // the charte (green means "read back and verified", and in a two-way job
  // neither side is a source). An inline style was also out of the charte
  // block's reach.
  $('srv-sub').innerHTML = `This becomes the <b>${side}</b>` +
    (target.kind === 'pair' ? ` of pair ${target.index + 1}` : '') + '.';
  $('srv-title').textContent = 'Connect to a server';
  srvShowStep(1);
  srvStatus('idle', 'Not connected');
  $('srv-pass').value = '';
  $('ov-server').classList.add('open');

  const res = await API.serverListSaved();
  const list = res.servers || [];
  const box = $('srv-saved');
  box.innerHTML = list.map(s => `
    <div class="srow" data-id="${esc(s.id)}" data-tip="${esc(s.username)}@${esc(s.host)}:${s.port}">
      ${ICON_SERVER}
      <span class="s-name">${esc(s.name)}</span>
      <span class="host">${esc(s.username)}@${esc(s.host)}</span>
      <button class="s-forget" data-forget="${esc(s.id)}" data-tip="Forget this server" aria-label="Forget">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>
    </div>`).join('');
  $('srv-div').style.display = list.length ? '' : 'none';

  // Said once, plainly: if the machine has no usable credential store, syncto
  // will not write the password down anywhere as a consolation prize.
  const note = $('srv-vaultnote');
  if (res.vaultAvailable) {
    note.style.display = 'none';
  } else {
    note.style.display = '';
    note.textContent = 'This machine has no usable credential store, so the password cannot be ' +
      'remembered safely — syncto will ask for it each time rather than write it to a file.';
    $('srv-remember').checked = false;
  }
  setTimeout(() => $('srv-host').focus(), 60);
}

function srvFormConn() {
  return {
    savedId : srv.savedId,
    // See srvForgetSaved: once the address or the login has been edited, this
    // is no longer that saved entry.
    host    : $('srv-host').value.trim(),
    port    : Number($('srv-port').value) || 22,
    username: $('srv-user').value.trim(),
    password: $('srv-pass').value,
    keyPath : $('srv-key').value.trim(),
    name    : $('srv-name').value.trim(),
    savePassword: $('srv-remember').checked,
  };
}

async function srvConnect() {
  // Enter pressed twice while the connection is slow used to open two SSH
  // sessions: only the second was remembered, and the first stayed open on the
  // server until syncto quit.
  if (srv.connecting) return;
  const conn = srvFormConn();
  if (!conn.host)     { srvStatus('bad', 'Enter the address of the server.'); $('srv-host').focus(); return; }
  if (!conn.username) { srvStatus('bad', 'Enter the login to use.'); $('srv-user').focus(); return; }

  srv.connecting = true;
  $('srv-connect').disabled = true;
  srvStatus('busy', `Connecting to ${conn.host}…`);
  let res;
  try { res = await API.serverConnect(conn); }
  finally { srv.connecting = false; $('srv-connect').disabled = false; }

  if (!res.ok) {
    if (res.needsPassword) {
      srvStatus('bad', 'This server has no remembered password — type it here.');
      $('srv-pass').focus();
      return;
    }
    srvStatus('bad', res.error);
    return;
  }

  // Only now is the entry worth keeping: it is a server that actually answers.
  srv.conn = { host: conn.host, port: conn.port, username: conn.username };
  if (conn.savePassword || conn.keyPath || srv.savedId) {
    const saved = await API.serverSave(conn);
    if (saved.ok && saved.server) srv.savedId = saved.server.id;
    if (saved.ok && !saved.remembered) {
      // Do not let this pass silently: the user ticked "remember" and it
      // did not happen, and they will find out at the worst moment otherwise.
      $('srv-status2-txt').textContent =
        `Connected to ${res.banner} — the password could NOT be stored on this machine.`;
    }
  }

  $('srv-title').textContent = 'Choose a folder';
  $('srv-status2-txt').textContent = `Connected — ${res.banner}`;
  srvShowStep(2);
  srv.cwd = res.start || '/';
  srv.picked = srv.cwd;
  await srvDraw();
}

function srvCrumbs() {
  const c = $('srv-crumbs');
  c.innerHTML = '';
  const parts = srv.cwd.split('/').filter(Boolean);
  const add = (label, path, isCur) => {
    if (isCur) {
      const s = document.createElement('span');
      s.className = 'cur'; s.textContent = label;
      c.appendChild(s);
    } else {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', async () => { srv.cwd = path; srv.picked = path; await srvDraw(); });
      c.appendChild(b);
    }
  };
  add('/', '/', parts.length === 0);
  let acc = '';
  parts.forEach((p, i) => {
    acc = acc ? acc + '/' + p : '/' + p;
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'sep'; sep.textContent = '/';
      c.appendChild(sep);
    }
    add(p, acc, i === parts.length - 1);
  });
}

const ICON_FOLDER_SM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';
const ICON_UP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>';

async function srvDraw() {
  const tree = $('srv-tree');
  tree.innerHTML = '<div class="tnode" style="cursor:default"><span style="color:var(--text3)">Reading…</span></div>';
  srvCrumbs();

  const res = await API.serverList(srv.cwd);
  tree.innerHTML = '';
  if (!res.ok) {
    const e = document.createElement('div');
    e.className = 'tnode';
    e.style.cursor = 'default';
    e.innerHTML = `<span style="color:var(--red)">${esc(res.error)}</span>`;
    tree.appendChild(e);
    $('srv-picked').innerHTML = '';
    return;
  }

  if (res.parent !== null) {
    const up = document.createElement('button');
    up.className = 'tnode up';
    up.innerHTML = ICON_UP + '<span>..</span>';
    up.addEventListener('click', async () => { srv.cwd = res.parent; srv.picked = res.parent; await srvDraw(); });
    tree.appendChild(up);
  }

  if (!res.folders.length) {
    const e = document.createElement('div');
    e.className = 'tnode';
    e.style.cursor = 'default';
    e.innerHTML = '<span style="color:var(--text3)">No sub-folder here</span>';
    tree.appendChild(e);
  }

  for (const f of res.folders) {
    const n = document.createElement('button');
    n.className = 'tnode' + (f.path === srv.picked ? ' sel' : '');
    n.setAttribute('role', 'option');
    n.setAttribute('aria-selected', f.path === srv.picked ? 'true' : 'false');
    n.innerHTML = ICON_FOLDER_SM + '<span></span>';
    n.lastChild.textContent = f.name;         // never innerHTML for a remote name
    // One click selects, a second one goes in — the habit every file dialog has.
    n.addEventListener('click', async () => {
      if (srv.picked === f.path) { srv.cwd = f.path; srv.picked = f.path; await srvDraw(); }
      else { srv.picked = f.path; await srvDraw(); }
    });
    n.addEventListener('dblclick', async () => { srv.cwd = f.path; srv.picked = f.path; await srvDraw(); });
    tree.appendChild(n);
  }

  $('srv-picked').innerHTML = 'Selected: <b></b>';
  $('srv-picked').querySelector('b').textContent = srv.picked;
}

async function srvUseFolder() {
  const url = await API.serverUrl(srv.conn, srv.picked);
  const t = srv.target;
  uiToJob();                       // keep whatever else was typed in the rows
  state.job.pairs[t.index][t.side] = url;
  renderPairRows();
  closeServerDialog();
  onPathChanged();
}

async function closeServerDialog() {
  $('ov-server').classList.remove('open');
  $('srv-pass').value = '';
  await API.serverDisconnect();
}

function bindServerDialog() {

  // Editing the address, the port or the login means this is a different
  // server. Without dropping savedId, the main process reconnected to the
  // SAVED entry while the window built the URL from the typed fields — you
  // browsed one machine and wrote the address of another into the job.
  for (const id of ['srv-host', 'srv-port', 'srv-user']) {
    $(id).addEventListener('input', () => { srv.savedId = null; });
  }

  $('srv-cancel').addEventListener('click', closeServerDialog);
  $('srv-back').addEventListener('click', () => { srvShowStep(1); $('srv-title').textContent = 'Connect to a server'; });
  $('srv-connect').addEventListener('click', srvConnect);
  $('srv-use').addEventListener('click', srvUseFolder);
  $('srv-refresh').addEventListener('click', srvDraw);

  $('srv-key-browse').addEventListener('click', async () => {
    const p = await API.browseKey();
    if (p) $('srv-key').value = p;
  });

  // The default port follows nothing but SFTP here, so it is only ever a hint.
  $('srv-host').addEventListener('keydown', e => { if (e.key === 'Enter') srvConnect(); });
  $('srv-user').addEventListener('keydown', e => { if (e.key === 'Enter') srvConnect(); });
  $('srv-pass').addEventListener('keydown', e => { if (e.key === 'Enter') srvConnect(); });

  $('srv-saved').addEventListener('click', async e => {
    const forget = e.target.closest('[data-forget]');
    if (forget) {
      e.stopPropagation();
      await API.serverForget(forget.dataset.forget);
      await openServerDialog(srv.target);
      return;
    }
    const row = e.target.closest('.srow');
    if (!row) return;
    const res = await API.serverListSaved();
    const s = (res.servers || []).find(x => x.id === row.dataset.id);
    if (!s) return;
    srv.savedId = s.id;
    $('srv-host').value = s.host;
    $('srv-port').value = s.port;
    $('srv-user').value = s.username;
    $('srv-key').value  = s.keyPath || '';
    $('srv-name').value = s.name;
    $('srv-pass').value = '';
    $('srv-remember').checked = !!s.savePassword;
    srvStatus('idle', s.hasPassword || s.keyPath
      ? 'Ready — press Connect'
      : 'Type the password, then press Connect');
    srvConnect();
  });

  // Electron has no window.prompt, so the name is typed in place — which is
  // better anyway: the folder being created stays visible above the field.
  $('srv-newfolder').addEventListener('click', () => {
    const tools = $('srv-tools-new');
    const on = tools.style.display !== 'none';
    tools.style.display = on ? 'none' : '';
    if (!on) { $('srv-newname').value = ''; $('srv-newname').focus(); }
  });
  const createFolder = async () => {
    const name = $('srv-newname').value.trim();
    if (!name) return;
    const res = await API.serverMkdir(srv.cwd, name);
    if (!res.ok) { showError('Could not create the folder', res.error); return; }
    $('srv-tools-new').style.display = 'none';
    srv.picked = res.path;
    await srvDraw();
  };
  $('srv-newok').addEventListener('click', createFolder);
  $('srv-newname').addEventListener('keydown', e => {
    if (e.key === 'Enter') createFolder();
    if (e.key === 'Escape') { e.stopPropagation(); $('srv-tools-new').style.display = 'none'; }
  });

  // Pair rows are rebuilt constantly, so the handler lives on the container.
  $('pairrows').addEventListener('click', e => {
    const row = e.target.closest('.prow');
    if (!row) return;
    const i = Number(row.dataset.i);
    if (e.target.closest('.pr-server-l')) { uiToJob(); openServerDialog({ kind: 'pair', side: 'left',  index: i }); }
    if (e.target.closest('.pr-server-r')) { uiToJob(); openServerDialog({ kind: 'pair', side: 'right', index: i }); }
  });
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
  await loadNtfyUi();
  onPathChanged();
  await refreshLogUi();
  // Marked, not raised: see showRelink.
  offerRelinkForJob(true);
  document.title = `syncto ${state.version}`;
  $('footer-ver').textContent = 'v' + state.version;
  $('footer-gh').addEventListener('click', () => API.openExternal('https://github.com/noar-justedit/syncto'));
})();
