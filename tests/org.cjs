const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto('file:///home/claude/pdfstudio/desktop/index.html');
  await page.waitForFunction(() => window.__pdfstudio?.ready);
  await page.setInputFiles('#fileOpen', ['A.pdf', 'B.pdf', 'quote.pdf']);
  await page.waitForFunction(() => document.querySelectorAll('.page').length === 6);
  // bigger sidebar previews
  await page.fill('#thumbSize', '200'); await page.dispatchEvent('#thumbSize', 'input');
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'O1-sidebar-big.png' });
  // organize mode
  await page.click('#btnOrganize'); await page.waitForTimeout(800);
  await page.screenshot({ path: 'O2-organize.png' });
  const order = () => page.evaluate(() => window.__pdfstudio.state.pages.map(p => p.idx + ':' + p.vw).join(' '));
  console.log('before', await order());
  // drag last page (quote) before the first, by mouse (HTML5 DnD)
  const t = page.locator('.thumb');
  const last = await t.nth(5).boundingBox(), first = await t.nth(0).boundingBox();
  await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2); await page.mouse.down();
  await page.mouse.move(first.x + 20, first.y + first.height / 2, { steps: 12 });
  await page.mouse.up(); await page.waitForTimeout(500);
  console.log('after ', await order());
  // zoom with ctrl+wheel
  const box = await page.locator('#thumbs').boundingBox();
  await page.mouse.move(box.x + 300, box.y + 300); await page.keyboard.down('Control'); await page.mouse.wheel(0, 300); await page.keyboard.up('Control');
  await page.waitForTimeout(600);
  console.log('size after ctrl+wheel', await page.inputValue('#thumbSize'));
  await page.screenshot({ path: 'O3-organize-smaller.png' });
  await t.nth(3).dblclick(); await page.waitForTimeout(600);
  console.log('organize off:', !(await page.evaluate(() => document.body.classList.contains('organize'))), 'current page', await page.inputValue('#pageInput'));
  console.log('errors', errs.join('\n') || 'none');
  await browser.close();
})();
