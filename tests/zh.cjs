// Chinese scanned letter: OCR (real Tesseract chi_sim via a mock of tesseract.js), paragraph grouping, size, font match, typing (incl. IME), cover
const { _electron } = require('/home/claude/.npm-global/lib/node_modules/playwright');
const { execFileSync } = require('child_process'); const fs = require('fs');
const OUT = '/tmp/claude-0/t/zh/';
(async () => {
  fs.rmSync("/root/.config/Mike's PDF Studio/font-list.json", { force: true });
  const env = { ...process.env, PDFSTUDIO_INSTALL_FONT_DIR: '/tmp/claude-0/t/instfonts', PDFSTUDIO_GFONTS_URL: 'http://127.0.0.1:9', PDFSTUDIO_FONTSOURCE_URL: 'http://127.0.0.1:9',
    PDFSTUDIO_FONT_DIRS: '/usr/share/fonts/opentype/noto:/usr/share/fonts/truetype/wqy:/usr/share/fonts/truetype/liberation:/usr/share/fonts/truetype/dejavu' };
  const app = await _electron.launch({ executablePath: '/tmp/claude-0/ex/linux/electron', args: ['--no-sandbox', '.'], cwd: '/tmp/claude-0/ex/linux/resources/app', env });
  const page = await app.firstWindow();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (/\[diag\] (look-alike|cjk)/.test(m.text())) console.log('   ', m.text()); });
  await page.waitForFunction(() => window.__pdfstudio?.ready, null, { timeout: 30000 });
  await page.exposeFunction('__ocr', async (dataUrl, langs) => {
    fs.writeFileSync(OUT + 'ocr-in.png', Buffer.from(dataUrl.split(',')[1], 'base64'));
    execFileSync('tesseract', [OUT + 'ocr-in.png', OUT + 'ocr-out', '-l', langs.replace(/\+?msa/g, '').replace(/^\+/, ''), '--tessdata-dir', '/tmp/claude-0/tess', 'hocr'], { stdio: 'ignore' });
    return execFileSync('python3', [__dirname + '/hocr2json.py', OUT + 'ocr-out.hocr']).toString();
  });
  await page.evaluate(() => { window.__cjkDebug = 0; }); await page.evaluate(() => { window.Tesseract = { createWorker: async (l, o, opts) => ({ recognize: async c => ({ data: JSON.parse(await window.__ocr(c.toDataURL('image/png'), l.join('+'))) }) }) }; });
  await page.setInputFiles('#fileOpen', [OUT + 'zh-scan.pdf']);
  await page.waitForFunction(() => document.querySelectorAll('.page').length === 1);
  await page.click('[data-tool=edit]');
  await page.waitForSelector('.ocrgo', { timeout: 20000 });
  await page.click('.ocrgo');
  await page.waitForFunction(() => [...window.__pdfstudio.editInfo.values()][0]?.ocr, null, { timeout: 120000 });
  await page.waitForTimeout(500);
  const blocks = await page.evaluate(() => [...window.__pdfstudio.editInfo.values()][0].blocks.filter(b => b.kind === 'text').map(b => ({ id: b.id, size: +b.size.toFixed(1), n: b.lines.length, x: Math.round(b.x), text: b.text.slice(0, 24) })));
  console.log('BLOCKS (true size: body 10.5, title 16.5)'); blocks.forEach(b => console.log('  ', JSON.stringify(b)));
  await page.locator('.page').first().screenshot({ path: OUT + 'Z1-blocks.png' });
  const annot = () => page.evaluate(() => window.__pdfstudio.state.pages[0].annots.filter(a => a.type === 'text').map(a => ({ text: a.text.slice(0, 30), size: a.size, fname: a.fname, lines: a.lines && a.lines.length, w: Math.round(a.w) })));
  // edit the long paragraph: keyboard typing at the end
  const blk = async start => { const id = await page.evaluate(t => [...window.__pdfstudio.editInfo.values()][0].blocks.find(b => b.text.startsWith(t)).id, start); return page.locator(`.eblock[data-id="${id}"]`).boundingBox(); };
  let r = await blk('感谢');
  await page.mouse.click(r.x + r.width - 3, r.y + r.height - 4); await page.waitForTimeout(4000);
  await page.keyboard.press('End'); await page.keyboard.type('ab');
  // IME composition (how Chinese pinyin input arrives)
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'xu', selectionStart: 2, selectionEnd: 2 });
    await page.waitForTimeout(100);
    await cdp.send('Input.imeSetComposition', { text: '续费', selectionStart: 2, selectionEnd: 2 });
    await page.waitForTimeout(100);
    await cdp.send('Input.insertText', { text: '续费' });
  } catch (e) { console.log('IME test unavailable:', e.message); }
  console.log('after typing:', JSON.stringify(await page.evaluate(() => document.querySelector('.annot-text.editing .tbody')?.innerText.slice(-12))));
  await page.keyboard.press('Escape'); await page.waitForTimeout(500);
  console.log('ANNOTS', JSON.stringify(await annot()));
  await page.locator('.page').first().screenshot({ path: OUT + 'Z2-edited.png' });
  // list item
  r = await blk('2、');
  await page.mouse.click(r.x + r.width - 3, r.y + r.height / 2); await page.waitForTimeout(3000);
  await page.keyboard.press('End'); await page.keyboard.insertText('（已完成）');
  await page.keyboard.press('Escape'); await page.waitForTimeout(500);
  console.log('ANNOTS', JSON.stringify(await annot()));
  await page.locator('.page').first().screenshot({ path: OUT + 'Z3-list.png' });
  r = await blk('系统续费');
  await page.mouse.click(r.x + r.width - 3, r.y + r.height / 2); await page.waitForTimeout(3000);
  await page.keyboard.press('End'); await page.keyboard.insertText('（第二次）'); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  console.log('TITLE', JSON.stringify((await page.evaluate(() => window.__pdfstudio.state.pages[0].annots.filter(a => a.type === 'text').map(a => ({ t: a.text, size: a.size, fname: a.fname, bold: a.bold })))).find(a => a.t.startsWith('系统'))));
  // re-edit the paragraph (single click), type more
  await page.click('[data-tool=edit]');
  let ed = await page.locator('.annot-text').first().boundingBox();
  await page.mouse.click(ed.x + ed.width / 2, ed.y + ed.height / 2); await page.waitForTimeout(400);
  console.log('re-edit editing =', await page.isVisible('.annot-text.editing'));
  await page.keyboard.press('Control+End'); await page.keyboard.insertText('再次');
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  // resize with the side handle (select tool), then move
  await page.click('[data-tool=select]');
  await page.mouse.click(ed.x + 8, ed.y + 4); await page.waitForTimeout(200);
  const rs = await page.locator('.annot-text.sel .rs').boundingBox();
  const w0 = (await annot())[0].w;
  await page.mouse.move(rs.x + 5, rs.y + 5); await page.mouse.down(); await page.mouse.move(rs.x - 100, rs.y + 5, { steps: 6 }); await page.mouse.up();
  const after = (await annot())[0];
  console.log('resize width', w0, '->', after.w, 'lines', after.lines);
  // a background font match finishing while typing in another box must not break typing
  await page.click('[data-tool=edit]');
  r = await blk('3、');
  await page.mouse.click(r.x + r.width - 3, r.y + r.height / 2); await page.waitForTimeout(150);
  await page.evaluate(() => window.__pdfstudio.renderAnnots(window.__pdfstudio.state.pages[0])); // what a font match finishing for another box does
  await page.keyboard.press('End'); await page.keyboard.type('XY');
  console.log('typing after background update:', JSON.stringify(await page.evaluate(() => document.querySelector('.annot-text.editing .tbody')?.innerText)));
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  await page.evaluate(() => window.__pdfstudio.setZoom(2)); await page.waitForTimeout(800);
  const pg = await page.locator('.page').first().boundingBox();
  await page.screenshot({ path: OUT + 'Z4-zoom.png', clip: { x: pg.x + 60, y: pg.y + 230, width: 1100, height: 520 } });
  const b64 = await page.evaluate(async () => { const u = await window.__pdfstudio.buildPdf(window.__pdfstudio.state.pages); let s = ''; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768)); return btoa(s); });
  fs.writeFileSync(OUT + 'zh-out.pdf', Buffer.from(b64, 'base64'));
  console.log('ANNOTS', JSON.stringify(await annot()));
  await page.evaluate(() => { window.__pdfstudio.state.dirty = false; });
  console.log('errors:', errs.join(' | ') || 'none');
  await app.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
