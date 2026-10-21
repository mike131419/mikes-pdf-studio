const { _electron } = require('/home/claude/.npm-global/lib/node_modules/playwright');
const fs = require('fs');
(async () => {
  const inst = '/tmp/claude-0/t/instfonts'; fs.rmSync(inst, { recursive: true, force: true }); fs.mkdirSync(inst);
  fs.rmSync("/root/.config/Mike's PDF Studio/font-list.json", { force: true });
  const env = { ...process.env, PDFSTUDIO_GFONTS_URL: 'http://127.0.0.1:8767', PDFSTUDIO_FONTSOURCE_URL: 'http://127.0.0.1:8767/npm', PDFSTUDIO_INSTALL_FONT_DIR: inst,
    PDFSTUDIO_FONT_DIRS: '/usr/share/fonts/truetype/liberation:/usr/share/fonts/truetype/dejavu' };
  const app = await _electron.launch({ executablePath: '/tmp/claude-0/ex/linux/electron', args: ['--no-sandbox', '.'], cwd: '/tmp/claude-0/ex/linux/resources/app', env });
  const page = await app.firstWindow();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.waitForFunction(() => window.__pdfstudio?.ready, null, { timeout: 30000 });
  await page.setInputFiles('#fileOpen', ['tbl-known.pdf']);
  await page.waitForFunction(() => document.querySelectorAll('.page').length === 1);
  await page.click('[data-tool=edit]');
  await page.waitForSelector('.eblock.text', { timeout: 20000 });
  const blk = async text => { const id = await page.evaluate(t => [...window.__pdfstudio.editInfo.values()][0].blocks.find(b => b.text === t).id, text); return page.locator(`.eblock[data-id="${id}"]`).boundingBox(); };
  const annots = () => page.evaluate(() => window.__pdfstudio.state.pages[0].annots.filter(a => a.type === 'text').map(a => ({ text: a.text, x: Math.round(a.x), y: Math.round(a.y), w: a.w && Math.round(a.w), fname: a.fname, bold: a.bold })));
  // 1) edit, finish, then single-click again and keep typing
  let r = await blk('Widget Order');
  await page.mouse.click(r.x + r.width - 2, r.y + r.height / 2); await page.waitForTimeout(2500);
  await page.keyboard.press('End'); await page.keyboard.insertText(' A');
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  await page.mouse.click(5, 880); await page.waitForTimeout(300);
  const ed = await page.locator('.annot-text').first().boundingBox();
  await page.mouse.click(ed.x + ed.width / 2, ed.y + ed.height / 2); await page.waitForTimeout(300);
  console.log('1 re-edit: editing again =', await page.isVisible('.annot-text.editing'), 'errs so far:', errs.join(' | '), 'hit:', await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e && e.className; }, [ed.x + ed.width - 3, ed.y + ed.height / 2]), 'tool:', await page.evaluate(() => window.__pdfstudio.state.tool));
  await page.keyboard.press('End'); await page.keyboard.insertText(' B'); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  console.log('  text now:', JSON.stringify((await annots())[0].text));
  // 2) resize the box with the side handle
  await page.mouse.click(ed.x + 5, ed.y + 3); await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  await page.click('[data-tool=select]');
  await page.mouse.click(ed.x + 5, ed.y + 3); await page.waitForTimeout(200);
  const rs = await page.locator('.annot-text.sel .rs').boundingBox();
  const w0 = (await annots())[0].w;
  await page.mouse.move(rs.x + 6, rs.y + 6); await page.mouse.down(); await page.mouse.move(rs.x - 120, rs.y + 6, { steps: 6 }); await page.mouse.up();
  console.log('2 resize: width', w0, '->', (await annots())[0].w);
  // 3a) drag an original (not yet edited) item: "Courier"
  await page.click('[data-tool=edit]'); await page.waitForTimeout(300);
  r = await blk('Courier');
  await page.mouse.move(r.x + 10, r.y + r.height / 2); await page.mouse.down(); await page.mouse.move(r.x + 150, r.y + r.height / 2 + 40, { steps: 10 }); await page.mouse.up();
  await page.waitForTimeout(500);
  console.log('3a drag original: ', JSON.stringify((await annots()).find(a => a.text === 'Courier')));
  // 3b) move a box while typing in it, with the move grip
  r = await blk('Confirmed');
  await page.mouse.click(r.x + r.width - 2, r.y + r.height / 2); await page.waitForTimeout(800);
  const mv = await page.locator('.annot-text.editing .mv').boundingBox();
  await page.mouse.move(mv.x + 10, mv.y + 10); await page.mouse.down(); await page.mouse.move(mv.x + 10, mv.y + 70, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(300);
  console.log('3b move while editing:', JSON.stringify((await annots()).find(a => a.text === 'Confirmed')), 'still editing =', await page.isVisible('.annot-text.editing'));
  await page.keyboard.press('Escape');
  // 4) fonts: downloaded family + companions
  await page.waitForTimeout(2500);
  console.log('4 installed fonts:', fs.readdirSync(inst).join(', '));
  // 5) signature preview + rotation
  await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 300; c.height = 100; const x = c.getContext('2d'); x.fillStyle = '#c00'; x.fillRect(0, 0, 300, 100); x.fillStyle = '#fff'; x.font = 'bold 60px sans-serif'; x.fillText('SIGN', 70, 75); window.__pdfstudio.useSignature(c.toDataURL(), 300, 100); });
  const pg = await page.locator('.page').first().boundingBox();
  await page.mouse.move(pg.x + 300, pg.y + 600, { steps: 3 }); await page.waitForTimeout(200);
  console.log('5 ghost visible:', await page.isVisible('#placeGhost'));
  await page.screenshot({ path: 'F5-ghost.png', clip: { x: pg.x + 150, y: pg.y + 520, width: 320, height: 160 } });
  await page.mouse.click(pg.x + 300, pg.y + 600); await page.waitForTimeout(300);
  console.log('  ghost hidden after placing:', !(await page.isVisible('#placeGhost')));
  const rot = await page.locator('.annot-image.sel .rot').boundingBox();
  const im = await page.locator('.annot-image.sel').boundingBox();
  const cx = im.x + im.width / 2, cy = im.y + im.height / 2;
  await page.mouse.move(rot.x + 11, rot.y + 11); await page.mouse.down();
  await page.mouse.move(cx + 80, cy, { steps: 12 }); await page.mouse.up(); // drag the top handle to the right = +90°
  const img = await page.evaluate(() => window.__pdfstudio.state.pages[0].annots.find(a => a.type === 'image'));
  console.log('  rotation:', Math.round(img.rot));
  await page.mouse.click(5, 880);
  await page.locator('.page').first().screenshot({ path: 'F5-screen.png' });
  const bytes = await page.evaluate(async () => Array.from(await window.__pdfstudio.buildPdf(window.__pdfstudio.state.pages)));
  fs.writeFileSync('F5.pdf', Buffer.from(bytes));
  console.log('errors:', errs.join('\n') || 'none');
  await page.evaluate(() => { window.__pdfstudio.state.dirty = false; }); await app.close();
})();
