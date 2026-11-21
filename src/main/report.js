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

// The report of one run, exported as a PDF from the summary card: what the
// run did and nothing else (not what was already on the destination). A
// record of a day's transfers on a shoot, for instance.
//
// The page is plain HTML printed by Chromium (Electron's printToPDF): no
// library, the same result on macOS, Windows and Linux. Kept as light as a PDF
// can be: one font in one weight (each weight or slant is one more font
// embedded), no colour, no image, no background, one rule under each heading.

const MODES = { mirror: 'MIRROR', twoWay: '2 WAYS', update: 'UPDATE', custom: 'CUSTOM' };
const SIDE = { left: 'source', right: 'destination' };
const CHECK = {
  read: 'Verified',
  server: 'Verified by the server',
  failed: 'FAILED',
  '': 'Not read back',
};
const HOW = { trashed: 'to the trash', versioned: 'kept as a revision', deleted: 'deleted', removed: 'deleted' };

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function fmtBytes(b) {
  const n = Number(b) || 0;
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let i = -1, v = n;
  do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
  return v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0) + ' ' + u[i];
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m) return `${m} min ${String(r).padStart(2, '0')} s`;
  return `${r} s`;
}

function fmtWhen(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// How the run ended, in the words of the summary card.
function outcome(res) {
  const errors = (res.errors || []).length;
  if (res.cancelled) return 'Stopped before the end';
  if (res.lockLost) return 'Stopped: another machine took the folder';
  if (res.stopped) return 'Stopped at the first error';
  if (errors) return `Completed with ${errors} error${errors > 1 ? 's' : ''}`;
  return 'Completed successfully';
}

// What the report needs from a finished run, kept by main.js until the next
// one. `res` is MultiSession.sync()'s result, `report.pairs` included.
function reportData(job, res, version) {
  return {
    version: version || '',
    job: (job && job.name) || 'Untitled',
    mode: (job && job.sync && MODES[job.sync.variant]) || '',
    copyOnly: !!(res.copy),
    startedAt: res.startedAt, endedAt: res.endedAt, durationMs: res.durationMs,
    outcome: outcome(res),
    counters: res.counters || {},
    verified: res.verified || 0,
    notReadBack: res.notReadBack || 0,
    errors: (res.errors || []).map(e => ({ rel: e.rel, message: e.message })),
    pairs: (res.report && res.report.pairs) || [],
  };
}

// The suggested file name: "syncto report - Rushes - 2026-11-21 18-30.pdf".
function reportFileName(data) {
  const when = fmtWhen(data.endedAt || Date.now()).slice(0, 16).replace(':', '-');
  const job = String(data.job || 'Untitled').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'Untitled';
  return `syncto report - ${job} - ${when}.pdf`;
}

function reportHtml(d) {
  const c = d.counters;
  const multi = d.pairs.length > 1;
  const row = (l, v) => `<tr><th>${esc(l)}</th><td>${esc(v)}</td></tr>`;
  const summary = [
    row('Job', d.job + (d.mode ? ` (${d.copyOnly ? 'copy from the COMPARE panels' : d.mode})` : '')),
    row('Started', fmtWhen(d.startedAt)),
    row('Ended', fmtWhen(d.endedAt)),
    row('Duration', fmtDuration(d.durationMs)),
    row('Result', d.outcome),
    row('Files copied', `${c.files || 0} (${fmtBytes(c.bytes || 0)})`),
    row('Files verified', String(d.verified)),
  ];
  if (d.notReadBack) summary.push(row('Copied, not read back', String(d.notReadBack)));
  if (c.deleted) summary.push(row('Items removed', String(c.deleted)));
  if (c.moved) summary.push(row('Files moved', String(c.moved)));
  if (d.errors.length) summary.push(row('Errors', String(d.errors.length)));
  if (!multi && d.pairs[0]) {
    summary.splice(1, 0, row('Source', d.pairs[0].left), row('Destination', d.pairs[0].right));
  }

  const pairs = d.pairs.map((p, i) => {
    const parts = [];
    if (multi) parts.push(`<h2>Pair ${i + 1}: ${esc(p.left)} → ${esc(p.right)}</h2>`);
    const tag = side => (side === 'left' ? ' (to the source)' : '');
    if (p.copied.length) {
      const bytes = p.copied.reduce((t, e) => t + (e.size || 0), 0);
      parts.push(`<h3>Copied: ${p.copied.length} file${p.copied.length > 1 ? 's' : ''}, ${esc(fmtBytes(bytes))}</h3>`,
        '<table class="list"><thead><tr><th>File</th><th class="r">Size</th><th>Check</th><th>XXH64</th></tr></thead><tbody>',
        p.copied.map(e => `<tr><td>${esc(e.rel)}${e.replaced ? ' (replaced)' : ''}${tag(e.side)}</td>` +
          `<td class="r">${esc(fmtBytes(e.size))}</td><td>${esc(CHECK[e.check] || CHECK[''])}</td><td>${esc(e.hash || '')}</td></tr>`).join(''),
        '</tbody></table>');
    }
    if (p.moved.length) {
      parts.push(`<h3>Moved: ${p.moved.length}</h3><table class="list"><tbody>`,
        p.moved.map(m => `<tr><td>${esc(m.from)} → ${esc(m.rel)}${tag(m.side)}</td></tr>`).join(''), '</tbody></table>');
    }
    if (p.deleted.length) {
      parts.push(`<h3>Removed: ${p.deleted.length}</h3><table class="list"><tbody>`,
        p.deleted.map(x => `<tr><td>${esc(x.rel)}${x.folder ? '/' : ''} (${esc(SIDE[x.side])}, ${esc(HOW[x.how] || x.how)})</td></tr>`).join(''),
        '</tbody></table>');
    }
    if (!p.copied.length && !p.moved.length && !p.deleted.length) parts.push('<p>Nothing to do: both sides already matched.</p>');
    return parts.join('');
  }).join('');

  const errors = d.errors.length
    ? `<h2>Errors</h2><table class="list"><tbody>${d.errors.map(e => `<tr><td>${esc(e.rel)}: ${esc(e.message)}</td></tr>`).join('')}</tbody></table>`
    : '';

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(reportFileName(d))}</title><style>
*{margin:0;padding:0;font-weight:normal;font-style:normal}
body{font:8.5pt/1.4 Helvetica,Arial,sans-serif;color:#000}
h1{font-size:14pt;margin-bottom:8pt}
h2{font-size:11pt;margin:12pt 0 4pt}
h3{font-size:9.5pt;margin:10pt 0 3pt}
p{margin:4pt 0}
table{border-collapse:collapse;width:100%}
.sum th{text-align:left;width:32mm;padding:0;vertical-align:top}
.sum td{padding:0;word-break:break-all}
.list th{text-align:left;border-bottom:.5pt solid #000;padding:0 8pt 1pt 0}
.list td{padding:0 8pt 0 0;vertical-align:top;word-break:break-all}
.list .r{text-align:right;white-space:nowrap}
.list td:nth-child(3),.list td:nth-child(4){white-space:nowrap}
.list td:last-child,.list th:last-child{padding-right:0}
</style></head><body>
<h1>syncto report</h1>
<table class="sum"><tbody>${summary.join('')}</tbody></table>
${pairs}${errors}
</body></html>`;
}

// Prints the page to a PDF file with a hidden window that runs no script.
async function writeReportPdf(html, file, BrowserWindow, version) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmp = path.join(os.tmpdir(), `syncto-report-${process.pid}-${Date.now()}.html`);
  fs.writeFileSync(tmp, html);
  const w = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true } });
  try {
    await w.loadFile(tmp);
    const pdf = await w.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: false,
      margins: { top: 0.5, bottom: 0.6, left: 0.5, right: 0.5 },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="font:7pt Helvetica,Arial,sans-serif;width:100%;padding:0 0.5in;display:flex;justify-content:space-between">` +
        `<span>syncto ${esc(version || '')}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
    });
    fs.writeFileSync(file, pdf);
    return pdf.length;
  } finally {
    w.destroy();
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

module.exports = { reportData, reportHtml, reportFileName, writeReportPdf, outcome };
