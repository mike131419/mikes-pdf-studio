const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', m => { if (m.type() === 'error' || m.type()==='warning') errs.push(m.type()+': '+m.text()); });
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  await page.goto('file:///home/claude/pdfstudio/desktop/index.html');
  await page.waitForFunction(() => window.__pdfstudio?.ready, null, { timeout: 30000 });
  await page.screenshot({ path: '0-empty.png' });
  await page.setInputFiles('#fileOpen', ['A.pdf', 'B.pdf']);
  await page.waitForFunction(() => document.querySelectorAll('.page').length === 5);
  await page.waitForTimeout(800);
  await page.screenshot({ path: '1-opened.png' });
  // rotate page 1 right
  await page.click('.thumb >> nth=0'); await page.click('#btnRotR');
  // text on page 1
  await page.click('[data-tool=text]');
  const p1 = await page.locator('.page').nth(0).boundingBox();
  await page.mouse.click(p1.x + 60, p1.y + 60);
  await page.keyboard.type('Hello World');
  await page.keyboard.press('Enter'); await page.keyboard.type('Second line');
  await page.keyboard.press('Escape');
  // signature on page 2 (has /Rotate 90)
  await page.click('[data-tool=sign]');
  const pad = await page.locator('#sigPad').boundingBox();
  await page.mouse.move(pad.x + 60, pad.y + 120); await page.mouse.down();
  for (let i = 0; i < 40; i++) await page.mouse.move(pad.x + 60 + i * 10, pad.y + 120 + Math.sin(i / 3) * 30);
  await page.mouse.up();
  await page.click('#sigUse');
  await page.locator('.page').nth(1).scrollIntoViewIfNeeded();
  const p2 = await page.locator('.page').nth(1).boundingBox();
  await page.mouse.click(p2.x + p2.width * 0.7, p2.y + p2.height * 0.8);
  // whiteout over the marker rect label on page 2: drag
  await page.keyboard.press('w');
  await page.mouse.move(p2.x + 20, p2.y + 20); await page.mouse.down(); await page.mouse.move(p2.x + 150, p2.y + 90, {steps:5}); await page.mouse.up();
  // highlight on page 4
  await page.locator('.page').nth(3).scrollIntoViewIfNeeded();
  const p4 = await page.locator('.page').nth(3).boundingBox();
  await page.keyboard.press('h');
  await page.mouse.move(p4.x + 40, p4.y + 50); await page.mouse.down(); await page.mouse.move(p4.x + 420, p4.y + 100, {steps:5}); await page.mouse.up();
  await page.keyboard.press('v');
  await page.waitForTimeout(800);
  await page.screenshot({ path: '2-edited.png' });
  // reorder: drag thumb 5 before thumb 1
  await page.locator('.thumb').nth(4).dragTo(page.locator('.thumb').nth(0), { targetPosition: { x: 50, y: 5 } });
  await page.waitForTimeout(500);
  const order = await page.evaluate(() => [...document.querySelectorAll('.thumb')].map(t => window.__pdfstudio.pageByKey(t.dataset.key)).map(p => p.srcId.slice(0,4) + ':' + p.idx));
  console.log('order', order);
  await page.screenshot({ path: '3-reordered.png' });
  // save
  await page.evaluate(() => { delete window.showSaveFilePicker; window.showSaveFilePicker = undefined; });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnSave')]);
  await dl.saveAs('out.pdf');
  console.log('saved', dl.suggestedFilename());
  // undo works
  await page.keyboard.press('Control+z'); 
  console.log('pages after undo', await page.locator('.page').count());
  console.log('ERRORS', errs.join('\n') || 'none');
  await browser.close();
})();
