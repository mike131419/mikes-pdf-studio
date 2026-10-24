// Photocopy-style Chinese letter: sizes, grouping (paragraph's short last line, list), mixed Chinese/Latin lines, font match
const { _electron } = require('/home/claude/.npm-global/lib/node_modules/playwright');
const { execFileSync } = require('child_process'); const fs = require('fs');
const OUT = '/tmp/claude-0/t/zh/', PDF = process.argv[2] || 'zh-scan2.pdf';
(async () => {
  fs.rmSync("/root/.config/Mike's PDF Studio/font-list.json", { force: true });
  const env = { ...process.env, PDFSTUDIO_INSTALL_FONT_DIR: '/tmp/claude-0/t/instfonts', PDFSTUDIO_GFONTS_URL: 'http://127.0.0.1:9', PDFSTUDIO_FONTSOURCE_URL: 'http://127.0.0.1:9',
    PDFSTUDIO_FONT_DIRS: '/usr/share/fonts/opentype/noto:/usr/share/fonts/truetype/wqy:/usr/share/fonts/truetype/liberation:/usr/share/fonts/truetype/dejavu' };
  const app = await _electron.launch({ executablePath: '/tmp/claude-0/ex/linux/electron', args: ['--no-sandbox', '.'], cwd: '/tmp/claude-0/ex/linux/resources/app', env });
  const page = await app.firstWindow();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (/\[diag\] look-alike/.test(m.text())) console.log('   ', m.text().slice(0, 200)); });
  await page.waitForFunction(() => window.__pdfstudio?.ready, null, { timeout: 30000 });
  await page.exposeFunction('__ocr', async (dataUrl, langs) => {
    fs.writeFileSync(OUT + 'ocr-in.png', Buffer.from(dataUrl.split(',')[1], 'base64'));
    execFileSync('tesseract', [OUT + 'ocr-in.png', OUT + 'ocr-out', '-l', langs.replace(/\+?msa/g, '').replace(/^\+/, ''), '--tessdata-dir', '/tmp/claude-0/tess', 'hocr'], { stdio: 'ignore' });
    return execFileSync('python3', [__dirname + '/hocr2json.py', OUT + 'ocr-out.hocr']).toString();
  });
  await page.evaluate(() => { window.Tesseract = { createWorker: async (l) => ({ recognize: async c => ({ data: JSON.parse(await window.__ocr(c.toDataURL('image/png'), l.join('+'))) }) }) }; });
  await page.setInputFiles('#fileOpen', [OUT + PDF]);
  await page.waitForFunction(() => document.querySelectorAll('.page').length === 1);
  await page.click('[data-tool=edit]');
  await page.waitForSelector('.ocrgo', { timeout: 20000 });
  await page.click('.ocrgo');
  await page.waitForFunction(() => [...window.__pdfstudio.editInfo.values()][0]?.ocr, null, { timeout: 180000 });
  const blocks = await page.evaluate(() => [...window.__pdfstudio.editInfo.values()][0].blocks.filter(b => b.kind === 'text').map(b => ({ id: b.id, size: +b.size.toFixed(1), n: b.lines.length, text: b.text.slice(0, 26) })));
  console.log('BLOCKS (true: body 11.3, title 16.5)'); blocks.forEach(b => console.log('  ', JSON.stringify(b)));
  const blk = async start => { const id = await page.evaluate(t => [...window.__pdfstudio.editInfo.values()][0].blocks.find(b => b.text.startsWith(t))?.id, start); return id && page.locator(`.eblock[data-id="${id}"]`).boundingBox(); };
  const edit = async (start, add) => {
    const r = await blk(start); if (!r) { console.log('  no block starting', start); return; }
    await page.mouse.click(r.x + r.width - 3, r.y + r.height - 4); await page.waitForTimeout(2500);
    await page.keyboard.press('Control+End'); await page.keyboard.type(add);
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  };
  page.on('console', m => { if (/\[diag\] cjk /.test(m.text())) console.log('   ', m.text()); });
  await edit('1、自甲方', '测试');
  await edit('7、', '测试');
  await edit('8、', '测试');
  await edit('二、', '测试');
  console.log('ANNOTS', JSON.stringify(await page.evaluate(() => window.__pdfstudio.state.pages[0].annots.filter(a => a.type === 'text').map(a => ({ t: a.text.slice(0, 14), size: a.size, f: a.fname, b: a.bold, lines: a.lines.length })))));
  await page.evaluate(() => window.__pdfstudio.setZoom(1.6)); await page.waitForTimeout(800);
  const pg = await page.locator('.page').first().boundingBox();
  await page.screenshot({ path: OUT + 'Y-zoom.png', clip: { x: pg.x, y: pg.y + 150, width: Math.min(1100, pg.width), height: 900 } });
  await page.evaluate(() => { window.__pdfstudio.state.dirty = false; });
  console.log('errors:', errs.join(' | ') || 'none');
  await app.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
