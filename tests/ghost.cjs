const { _electron } = require('/home/claude/.npm-global/lib/node_modules/playwright');
(async () => {
  const app = await _electron.launch({ executablePath: '/tmp/claude-0/ex/linux/electron', args: ['--no-sandbox', '.'], cwd: '/tmp/claude-0/ex/linux/resources/app', env: { ...process.env, PDFSTUDIO_FONT_DIRS: '/nonexistent' } });
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.__pdfstudio?.ready, null, { timeout: 30000 });
  await page.setInputFiles('#fileOpen', ['tbl-known.pdf']);
  await page.waitForFunction(() => document.querySelectorAll('.page').length === 1);
  await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 300; c.height = 100; const x = c.getContext('2d'); x.fillStyle = '#c00'; x.fillRect(0, 0, 300, 100); window.__pdfstudio.useSignature(c.toDataURL(), 300, 100); });
  const pg = await page.locator('.page').first().boundingBox();
  await page.mouse.move(pg.x + 300, pg.y + 400, { steps: 4 }); await page.waitForTimeout(400);
  console.log(await page.evaluate(() => { const g = document.getElementById('placeGhost'); const r = g.getBoundingClientRect(); return JSON.stringify({ disp: g.style.display, r, complete: g.complete, nw: g.naturalWidth, src: g.src.slice(0, 30), op: getComputedStyle(g).opacity, z: getComputedStyle(g).zIndex }); }));
  await page.screenshot({ path: 'ghost-full.png' });
  await app.close();
})();
