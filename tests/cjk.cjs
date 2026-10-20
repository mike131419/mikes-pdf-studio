const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', m => { if (m.type() === 'error' || m.type()==='warning') errs.push(m.type()+': '+m.text()); });
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  const t0 = Date.now();
  await page.goto('file:///home/claude/pdfstudio/desktop/index.html');
  await page.waitForFunction(() => window.__pdfstudio?.ready, null, { timeout: 30000 });
  console.log('startup ms', Date.now() - t0);
  await page.setInputFiles('#fileOpen', ['A.pdf']);
  await page.waitForFunction(() => document.querySelectorAll('.page').length === 3);
  await page.click('[data-tool=text]');
  await page.selectOption('#fontSize', '20');
  const p1 = await page.locator('.page').nth(0).boundingBox();
  await page.mouse.click(p1.x + 80, p1.y + 140);
  await page.keyboard.insertText('你好，世界！Hello 測試繁體字');
  await page.keyboard.press('Enter'); await page.keyboard.insertText('第二行：马来西亚 槟城 2026');
  await page.mouse.click(p1.x + 80, p1.y + 260); // finishes box
  await page.mouse.click(p1.x + 80, p1.y + 260);
  await page.keyboard.insertText('English only line');
  await page.keyboard.press('Escape');
  // rotated page 2 (has /Rotate 90)
  await page.locator('.page').nth(1).scrollIntoViewIfNeeded();
  const p2 = await page.locator('.page').nth(1).boundingBox();
  await page.keyboard.press('t');
  await page.mouse.click(p2.x + 300, p2.y + 200);
  await page.keyboard.insertText('旋转页面上的中文');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1500);
  await page.locator('.page').nth(0).screenshot({ path: 'cjk-screen-p1.png' });
  await page.locator('.page').nth(1).screenshot({ path: 'cjk-screen-p2.png' });
  await page.evaluate(() => { window.showSaveFilePicker = undefined; });
  const t1 = Date.now();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnSave')]);
  await dl.saveAs('cjk.pdf');
  console.log('save ms', Date.now() - t1, 'zoom', await page.evaluate(()=>window.__pdfstudio.state.zoom));
  // reopen saved file in the app (pdf.js render)
  await page.evaluate(() => { window.__pdfstudio.state.dirty = false; });
  await page.setInputFiles('#fileOpen', ['cjk.pdf']);
  await page.waitForTimeout(1500);
  await page.locator('.page').nth(0).screenshot({ path: 'cjk-reopen-p1.png' });
  console.log('ERRORS', errs.join('\n') || 'none');
  await browser.close();
})();
