const { _electron } = require('/home/claude/.npm-global/lib/node_modules/playwright');
const fs = require('fs');
(async () => {
  const [doc, dirs] = [process.argv[2], process.argv[3]];
  const inst = '/tmp/claude-0/t/instfonts'; fs.rmSync(inst, { recursive: true, force: true }); fs.mkdirSync(inst);
  fs.rmSync("/root/.config/Mike's PDF Studio/font-list.json", { force: true });
  const env = { ...process.env, PDFSTUDIO_GFONTS_URL: process.env.GF || 'http://127.0.0.1:8765', PDFSTUDIO_FONTSOURCE_URL: process.env.FSRC || 'http://127.0.0.1:8765/npm', PDFSTUDIO_INSTALL_FONT_DIR: inst, PDFSTUDIO_FONT_DIRS: dirs };
  const app = await _electron.launch({ executablePath: '/tmp/claude-0/ex/linux/electron', args: ['--no-sandbox', '.'], cwd: '/tmp/claude-0/ex/linux/resources/app', env });
  const page = await app.firstWindow();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.waitForFunction(() => window.__pdfstudio?.ready, null, { timeout: 30000 });
  await page.setInputFiles('#fileOpen', [doc]);
  await page.waitForFunction(() => document.querySelectorAll('.page').length === 1);
  await page.click('[data-tool=edit]');
  await page.waitForSelector('.eblock.text', { timeout: 20000 });
  const blocks = await page.evaluate(() => { const [k, v] = [...window.__pdfstudio.editInfo.entries()][0]; return v.blocks.filter(b => b.kind === 'text').map(b => b.text); });
  console.log('paragraphs found:', blocks.length); blocks.forEach(t => console.log('   |', t));
  // edit the value "Widget Order"
  const id = await page.evaluate(() => [...window.__pdfstudio.editInfo.values()][0].blocks.find(b => b.text === 'Widget Order').id);
  const r = await page.locator(`.eblock[data-id="${id}"]`).boundingBox();
  await page.mouse.click(r.x + r.width - 2, r.y + r.height / 2);
  await page.waitForTimeout(3000);
  await page.keyboard.press('End'); await page.keyboard.insertText(' Plus');
  await page.keyboard.press('Escape'); await page.waitForTimeout(500);
  const a = await page.evaluate(() => window.__pdfstudio.state.pages[0].annots.map(a => ({ text: a.text, fname: a.fname, fk: a.fk && a.fk.split('/').pop(), size: a.size, color: a.color, bold: a.bold })));
  console.log('edited:', JSON.stringify(a));
  console.log('suggestions:', await page.evaluate(() => [...document.querySelectorAll('#fontFamily optgroup.suggest option')].map(o => o.textContent).join(', ') || '(none)'));
  console.log('toast:', await page.textContent('#toast'));
  // re-select the edited box: the font panel should be visible and stay
  const ann = await page.locator('.annot-text').first().boundingBox();
  await page.mouse.click(ann.x + 5, ann.y + 3); await page.waitForTimeout(6000);
  console.log('panel:', (await page.textContent('#fontPanel')).replace(/\s+/g, ' ').trim(), '| visible:', await page.isVisible('#fontPanel'));
  await page.screenshot({ path: doc.replace('.pdf', '-panel.png') });
  console.log('installed:', fs.readdirSync(inst).join(', ') || '(none)');
  await page.locator('.page').first().screenshot({ path: doc.replace('.pdf', '-edited.png'), clip: { x: 0, y: 150, width: 600, height: 420 } });
  console.log('errors', errs.join('\n') || 'none');
  await page.evaluate(() => { window.__pdfstudio.state.dirty = false; }); await app.close();
})();
