// The scenario played in front of the camera. One function per shot.
module.exports = async function steps(c, { sleep }) {

  // Kill any hover tooltip left over by a synthetic click before capturing.
  const clean = () => c.eval(`document.querySelectorAll('.tooltip-float').forEach(e=>e.remove()); return 1;`);

  // ── 1. Main window — comparison done, Mirror + Verified ──────────────────
  console.log('shot 1: main');
  await c.eval(`
    const it = document.querySelector('.recent-item');
    if (it) it.click();
    return 1;`);
  await sleep(1200);
  await c.eval(`document.getElementById('btn-compare').click(); return 1;`);
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const done = await c.eval(`return !document.getElementById('btn-sync').disabled;`);
    if (done) break;
  }
  await sleep(1200);
  await c.eval(`window.scrollTo(0,0); document.getElementById('gridscroll').scrollTop = 0; return 1;`);
  await sleep(400);
  await clean();
  await c.shot('syncto-main.png');

  // ── 2. Filter panel ──────────────────────────────────────────────────────
  console.log('shot 2: filter');
  await c.eval(`document.getElementById('btn-filter').click(); return 1;`);
  await sleep(900);
  await clean();
  await c.shot('syncto-filter.png');
  await c.eval(`document.getElementById('filter-close').click(); return 1;`);
  await sleep(600);

  // ── 3. Settings panel ────────────────────────────────────────────────────
  console.log('shot 3: settings');
  await c.eval(`document.getElementById('btn-settings').click(); return 1;`);
  await sleep(900);
  await clean();
  await c.shot('syncto-settings.png');
  await c.eval(`document.getElementById('set-close').click(); return 1;`);
  await sleep(600);

  // ── 4. Auto-sync armed (confirmation dialog) ─────────────────────────────
  console.log('shot 4: autosync');
  await c.eval(`document.getElementById('auto-switch').click(); return 1;`);
  await sleep(900);
  await clean();
  await c.shot('syncto-autosync.png');
  await c.eval(`
    const cancel = document.getElementById('auto-cf-cancel');
    if (cancel) cancel.click();
    return 1;`);
  await sleep(700);

  // ── 5–7. A real SECURE run: copy phase, verify phase, summary ────────────
  console.log('shot 5-7: sync run');
  await c.eval(`document.getElementById('mode-secure').click(); return 1;`);
  await sleep(400);
  await c.eval(`document.getElementById('btn-sync').click(); return 1;`);
  await sleep(700);
  await c.eval(`
    const ok = document.getElementById('cf-ok');
    if (ok && document.getElementById('ov-confirm').classList.contains('open')) ok.click();
    return 1;`);

  let gotCopy = false, gotVerify = false;
  for (let i = 0; i < 400; i++) {
    await sleep(150);
    const t = await c.eval(`return (document.getElementById('pb-title')||{}).textContent || '';`);
    const pct = await c.eval(`return (document.getElementById('pb-pct')||{}).textContent || '';`);
    if (!gotCopy && /COPYING|SECURE/i.test(t) && !/VERIF/i.test(t) && parseInt(pct, 10) > 12) {
      gotCopy = true; await clean(); await c.shot('syncto-sync.png');
    }
    if (!gotVerify && /VERIF/i.test(t)) {
      gotVerify = true; await sleep(500); await clean(); await c.shot('syncto-verify.png');
    }
    const open = await c.eval(`return document.getElementById('ov-summary').classList.contains('open');`);
    if (open) break;
  }
  await sleep(1000);
  await clean();
  await c.shot('syncto-summary.png');
  await c.eval(`document.getElementById('sum-close').click(); return 1;`);
  await sleep(600);
  console.log('  copy shot:', gotCopy, '| verify shot:', gotVerify);

  // ── 8. Another machine holds the lock ────────────────────────────────────
  console.log('shot 8: lock');
  const { spawn, execSync } = require('child_process');
  execSync(`bash ${__dirname}/shot-dataset.sh`, { stdio: 'ignore' });
  // Held by a different user on a different machine name, so the screenshot
  // reads like a real second edit station rather than the build container.
  execSync('chmod -R 777 /Volumes', { stdio: 'ignore' });
  const holder = spawn('su', ['arnaud', '-c',
    `${process.execPath} ${__dirname}/../test/lock-holder.js /Volumes/NAS_EDIT/PROJET_TOSCANE/01_RUSHES --forever`],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(res => holder.stdout.on('data', d => { if (String(d).includes('LOCKED')) res(); }));

  await c.eval(`document.getElementById('mode-verified').click(); return 1;`);
  await c.eval(`document.getElementById('btn-compare').click(); return 1;`);
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await c.eval(`return !document.getElementById('btn-sync').disabled;`)) break;
  }
  await sleep(800);
  await c.eval(`document.getElementById('btn-sync').click(); return 1;`);
  await sleep(700);
  await c.eval(`
    const ok = document.getElementById('cf-ok');
    if (ok && document.getElementById('ov-confirm').classList.contains('open')) ok.click();
    return 1;`);
  for (let i = 0; i < 80; i++) {
    await sleep(200);
    const t = await c.eval(`return (document.getElementById('pb-title')||{}).textContent || '';`);
    if (/Waiting for another machine/i.test(t)) { await sleep(900); break; }
  }
  await clean();
  await c.shot('syncto-lock.png');
  holder.kill('SIGTERM');
  await sleep(500);
  await c.eval(`
    const b = document.getElementById('btn-abort');
    if (b) b.click();
    return 1;`);
  await sleep(1000);
};
