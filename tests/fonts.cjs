const { _electron } = require('/home/claude/.npm-global/lib/node_modules/playwright');
const fs = require('fs'); const { execFileSync } = require('child_process');
const mode = process.argv[2];
(async () => {
  const inst = '/tmp/claude-0/t/instfonts'; fs.rmSync(inst, { recursive: true, force: true }); fs.mkdirSync(inst);
  const ud = '/tmp/claude-0/t/ud-' + mode; fs.rmSync(ud, { recursive: true, force: true });
  const env = { ...process.env, PDFSTUDIO_GFONTS_URL: 'http://127.0.0.1:8765', PDFSTUDIO_INSTALL_FONT_DIR: inst,
    PDFSTUDIO_FONT_DIRS: mode === 'text' ? '/usr/share/fonts/truetype/liberation' : '/usr/share/fonts/truetype/liberation:/usr/share/fonts/truetype/crosextra:/usr/share/fonts/truetype/dejavu' };
  const app = await _electron.launch({ executablePath: '/tmp/claude-0/ex/linux/electron', args: ['--no-sandbox', '.', '--user-data-dir=' + ud], cwd: '/tmp/claude-0/ex/linux/resources/app', env });
  console.log('launched'); const page = await app.firstWindow(); console.log('window');
  const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && errs.push(m.text()));
  await page.exposeFunction('__ocr', async dataUrl => {
    fs.writeFileSync('ocr-in.png', Buffer.from(dataUrl.split(',')[1], 'base64'));
    execFileSync('tesseract', ['ocr-in.png', 'ocr-out', '-l', 'eng', 'hocr'], { stdio: 'ignore' });
    return execFileSync('python3', ['hocr2json.py', 'ocr-out.hocr']).toString();
  });
  await page.waitForFunction(() => window.__pdfstudio?.ready, null, { timeout: 30000 });
  console.log('ready');
  await page.setInputFiles('#fileOpen', [mode === 'text' ? 'quote.pdf' : 'scanned.pdf']);
  await page.waitForFunction(() => document.querySelectorAll('.page').length === 1);
  await page.click('[data-tool=edit]');
  if (mode === 'scan') {
    await page.waitForSelector('.ocrgo', { timeout: 20000 });
    await page.evaluate(() => { window.Tesseract = { createWorker: async () => ({ recognize: async c => ({ data: JSON.parse(await window.__ocr(c.toDataURL('image/png'))) }) }) }; });
    await page.click('.ocrgo');
    await page.waitForFunction(() => document.querySelectorAll('.eblock.text').length > 3, null, { timeout: 60000 });
  } else await page.waitForSelector('.eblock.text', { timeout: 20000 });
  console.log('blocks found'); const boxes = (await page.evaluate(() => [...document.querySelectorAll('.eblock.text')].map(b => b.getBoundingClientRect().toJSON()))).sort((a, b) => a.y - b.y);
  const edits = [[2, ' Extra words added to test the original font.'], [4, ' Still the same font here.'], [0, ' (Revised)']];
  for (const [i, add] of edits) {
    const b = boxes[i]; if (!b) continue;
    await page.mouse.click(b.x + b.width - 3, b.y + b.height - 4);
    await page.waitForSelector('.annot-text.editing');
    await page.waitForTimeout(2500); console.log('edited block', i);
    await page.keyboard.press('Control+End'); await page.keyboard.insertText(add);
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  }
  await page.mouse.click(5, 900); await page.waitForTimeout(800);
  const info = await page.evaluate(() => window.__pdfstudio.state.pages[0].annots.map(a => ({ text: a.text.slice(0, 30), fk: a.fk && a.fk.split('/').pop(), fname: a.fname, bold: a.bold, size: a.size })));
  console.log(JSON.stringify(info, null, 1));
  console.log('installed fonts dir:', fs.readdirSync(inst));
  const opts = await page.evaluate(() => document.querySelectorAll('#fontFamily optgroup.pc option').length);
  console.log('PC fonts in picker:', opts);
  await page.locator('.page').first().screenshot({ path: `F-${mode}-screen.png` });
  const bytes = await page.evaluate(async () => Array.from(await window.__pdfstudio.buildPdf(window.__pdfstudio.state.pages)));
  fs.writeFileSync(`F-${mode}.pdf`, Buffer.from(bytes));
  console.log('errors:', errs.filter(e => !/willReadFrequently|fake worker/.test(e)).join('\n') || 'none');
  await page.evaluate(() => { window.__pdfstudio.state.dirty = false; }); await app.close();
})();
