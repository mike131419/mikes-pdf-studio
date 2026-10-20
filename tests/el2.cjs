const { _electron } = require('/home/claude/.npm-global/lib/node_modules/playwright');
(async () => {
  const app = await _electron.launch({ executablePath: '/tmp/claude-0/ex/linux/electron', args: ['--no-sandbox', '.', '/tmp/claude-0/t/quote.pdf'], cwd: '/tmp/claude-0/ex/linux/resources/app' });
  const page = await app.firstWindow();
  const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => m.type() === 'error' && errs.push(m.text()));
  await page.waitForFunction(() => document.querySelectorAll('.page').length === 1, null, { timeout: 30000 });
  console.log('opened from command line:', await page.evaluate(() => window.__pdfstudio.state.docName), '| title:', await page.title(), '| version:', await page.textContent('#appVersion'));
  console.log('userData', await app.evaluate(({ app }) => app.getPath('userData')));
  // second launch with another file -> goes to the same window
  const { spawn } = require('child_process');
  const p2 = spawn('/tmp/claude-0/ex/linux/electron', ['--no-sandbox', '.', '/tmp/claude-0/t/A.pdf'], { cwd: '/tmp/claude-0/ex/linux/resources/app', env: process.env });
  await page.waitForFunction(() => document.querySelectorAll('.page').length === 3, null, { timeout: 30000 });
  console.log('second file opened in same window:', await page.evaluate(() => window.__pdfstudio.state.docName));
  await page.screenshot({ path: 'el2.png' });
  console.log('errors', errs.join('\n') || 'none');
  await app.close(); p2.kill();
})();
