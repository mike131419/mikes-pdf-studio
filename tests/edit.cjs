const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
const { execFileSync } = require('child_process'); const fs = require('fs');
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => errs.push('pageerror: ' + e.message + e.stack));
  await page.exposeFunction('__ocr', async dataUrl => {
    fs.writeFileSync('ocr-in.png', Buffer.from(dataUrl.split(',')[1], 'base64'));
    execFileSync('tesseract', ['ocr-in.png', 'ocr-out', '-l', 'eng', 'hocr'], { stdio: 'ignore' });
    return execFileSync('python3', ['hocr2json.py', 'ocr-out.hocr']).toString();
  });
  await page.goto('file:///home/claude/pdfstudio/dist/PDF%20Studio/PDF%20Studio.html');
  await page.waitForFunction(() => window.__pdfstudio?.ready);
  const save = async name => {
    await page.evaluate(() => { window.showSaveFilePicker = undefined; });
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnSaveAs')]);
    await dl.saveAs(name);
  };

  // ---------- A: Word-made PDF
  await page.setInputFiles('#fileOpen', ['quote.pdf']);
  await page.waitForFunction(() => document.querySelectorAll('.page').length === 1);
  await page.click('[data-tool=edit]');
  await page.waitForSelector('.eblock', { timeout: 20000 });
  await page.waitForTimeout(500);
  console.log('blocks', await page.evaluate(() => [...document.querySelectorAll('.eblock')].map(b => b.className + ':' + b.dataset.id).join(' ')));
  await page.locator('.page').first().screenshot({ path: 'A1-blocks.png' });
  const info = await page.evaluate(() => { const s = window.__pdfstudio.state; return null; });
  // edit the long paragraph: select all, retype
  const blocks = page.locator('.eblock.text');
  const n = await blocks.count();
  const texts = [];
  for (let i = 0; i < n; i++) texts.push(await blocks.nth(i).getAttribute('data-id'));
  // find paragraph block boxes
  const boxes = await page.evaluate(() => [...document.querySelectorAll('.eblock')].map(b => ({ id: b.dataset.id, kind: b.classList.contains('image') ? 'image' : 'text', r: b.getBoundingClientRect().toJSON() })));
  const byOrder = boxes.filter(b => b.kind === 'text').sort((a, b) => a.r.y - b.r.y);
  // block 0 heading, 1 Dear, 2 body paragraph
  const body = byOrder[2].r;
  await page.mouse.click(body.x + 40, body.y + 5);
  await page.waitForSelector('.annot-text.editing');
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText('Thank you for your enquiry. We are pleased to submit our revised quotation for the renovation works at your office in George Town, Penang. The total project cost is now RM 52,800.00 including the additional pantry works, and the work will take approximately seven weeks to complete.');
  await page.keyboard.press('Escape');
  // heading
  const hd = byOrder[0].r;
  await page.mouse.click(hd.x + hd.width - 3, hd.y + hd.height / 2);
  await page.keyboard.press('End');
  await page.keyboard.insertText(' (Revised)');
  await page.keyboard.press('Escape');
  // red line: append text
  const red = byOrder.find(b => true && b.r.y > body.y + 60 && b.r.y > byOrder[3].r.y) ; 
  const redBox = byOrder[4].r;
  await page.mouse.click(redBox.x + redBox.width - 2, redBox.y + redBox.height / 2);
  await page.keyboard.press('End'); await page.keyboard.insertText(' 有效期30天。');
  await page.keyboard.press('Escape');
  // click a block but change nothing -> must stay original
  const dear = byOrder[1].r;
  await page.mouse.click(dear.x + 10, dear.y + 5); await page.keyboard.press('Escape');
  // image: move it right
  const img = boxes.find(b => b.kind === 'image').r;
  await page.mouse.click(img.x + img.width / 2, img.y + img.height / 2);
  await page.waitForTimeout(300);
  await page.mouse.move(img.x + img.width / 2, img.y + img.height / 2); await page.mouse.down();
  await page.mouse.move(img.x + img.width / 2 + 200, img.y + img.height / 2, { steps: 6 }); await page.mouse.up();
  await page.click('[data-tool=select]');
  await page.mouse.click(5, 900);
  await page.waitForTimeout(600);
  console.log('annots', await page.evaluate(() => JSON.stringify(window.__pdfstudio.state.pages[0].annots.map(a => ({ t: a.type, font: a.font, bold: a.bold, italic: a.italic, size: a.size, color: a.color, lh: a.lh, cover: a.cover && a.cover.color, lines: a.lines && a.lines.length })))));
  await page.locator('.page').first().screenshot({ path: 'A2-edited.png' });
  await save('A-out.pdf');

  // ---------- B: scanned PDF + OCR
  await page.evaluate(() => { window.__pdfstudio.state.dirty = false; });
  await page.setInputFiles('#fileOpen', ['scanned.pdf']);
  await page.waitForTimeout(1200);
  await page.click('[data-tool=edit]');
  await page.waitForSelector('.ocrgo', { timeout: 20000 });
  await page.locator('.page').first().screenshot({ path: 'B1-banner.png' });
  await page.evaluate(() => {
    window.Tesseract = { createWorker: async (langs, oem, opts) => ({ recognize: async canvas => { opts.logger?.({ status: 'recognizing text', progress: 0.5 }); return { data: JSON.parse(await window.__ocr(canvas.toDataURL('image/png'))) }; } }) };
  });
  await page.click('.ocrgo');
  await page.waitForFunction(() => document.querySelectorAll('.eblock.text').length > 3, null, { timeout: 60000 });
  await page.waitForTimeout(300);
  await page.locator('.page').first().screenshot({ path: 'B2-ocr-blocks.png' });
  const ob = (await page.evaluate(() => [...document.querySelectorAll('.eblock.text')].map(b => b.getBoundingClientRect().toJSON()))).sort((a, b) => a.y - b.y);
  await page.mouse.click(ob[2].x + 30, ob[2].y + 4);
  await page.waitForSelector('.annot-text.editing');
  console.log('ocr text:', await page.evaluate(() => document.querySelector('.annot-text.editing .tbody').innerText));
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText('This paragraph came from a scanned page and was recognized with OCR, then edited. The total is now RM 52,800.00.');
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 900);
  await page.waitForTimeout(400);
  console.log('ocr annot', await page.evaluate(() => JSON.stringify(window.__pdfstudio.state.pages[0].annots.map(a => ({ size: a.size, color: a.color, cover: a.cover?.color })))));
  await page.locator('.page').first().screenshot({ path: 'B3-ocr-edited.png' });
  await save('B-out.pdf');

  // ---------- C: stamps
  await page.click('[data-tool=stamp]');
  await page.fill('#stText', 'PAID'); await page.fill('#stSub', 'Lim Building Services');
  await page.selectOption('#stShape', 'circle');
  await page.waitForTimeout(300);
  await page.locator('.modalcard').screenshot({ path: 'C1-stampmaker.png' });
  await page.click('#sigUse');
  const pg = await page.locator('.page').first().boundingBox();
  await page.mouse.click(pg.x + pg.width - 140, pg.y + pg.height - 200);
  await page.click('[data-tool=stamp]');
  await page.click('.tab[data-tab=image]');
  await page.setInputFiles('#fileImg', 'chop.jpg');
  await page.waitForTimeout(800);
  await page.locator('.modalcard').screenshot({ path: 'C2-chop.png' });
  await page.click('#sigUse');
  console.log('before chop', await page.evaluate(() => [window.__pdfstudio.state.tool, window.__pdfstudio.state.pendingImg, document.getElementById('sigModal').className].join('|')));
  console.log('hit', await page.evaluate(([x,y]) => document.elementFromPoint(x,y)?.className, [pg.x+150, pg.y+pg.height-200]));
  await page.mouse.click(pg.x + 150, pg.y + pg.height - 200);
  console.log('C annots', await page.evaluate(() => JSON.stringify(window.__pdfstudio.state.pages[0].annots.map(a=>[a.type,a.kind,Math.round(a.x),Math.round(a.y)]))));
  await page.click('[data-tool=sign]');
  console.log('sign tabs visible', await page.evaluate(() => [...document.querySelectorAll('.tab')].filter(t => !t.classList.contains('hidden')).map(t => t.dataset.tab).join(',')));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await page.locator('.page').first().screenshot({ path: 'C3-stamped.png' });
  await save('C-out.pdf');
  console.log('ERRORS', errs.join('\n') || 'none');
  await browser.close();
})();
