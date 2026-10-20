// Builds the whole editor as one self-contained offline HTML file -> desktop/index.html (used by the Windows app)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = process.env.LIBS || path.join(path.dirname(fileURLToPath(import.meta.url)), 'vendor');
const pdfjs = path.join(LIB, 'pdfjs-dist');
const root = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const src = f => fs.readFileSync(path.join(root, 'src', f), 'utf8');
const b64 = f => fs.readFileSync(f).toString('base64');

const assets = {};
for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
  for (const f of fs.readdirSync(path.join(pdfjs, dir))) {
    if (/^LICENSE|quickjs/i.test(f)) continue;
    assets[`${dir}/${f}`] = b64(path.join(pdfjs, dir, f));
  }
}
const assetJs =
  `window.__ASSETS=${JSON.stringify(assets)};\n` +
  `window.__PDFJS_B64="${b64(path.join(pdfjs, 'legacy/build/pdf.min.mjs'))}";\n` +
  `window.__WORKER_B64="${Buffer.from(classicWorker()).toString('base64')}";`;
// PDF.js ships its worker as an ES module; module workers from blob: URLs fail on file:// pages,
// so convert it to a classic worker script.
function classicWorker() {
  let w = fs.readFileSync(path.join(pdfjs, 'legacy/build/pdf.worker.min.mjs'), 'utf8');
  w = w.replaceAll('import.meta.url', 'self.location.href');
  const exp = 'export{WorkerMessageHandler};';
  if (!w.trimEnd().endsWith(exp) || /\bimport\.meta\b|^import\s/m.test(w)) throw new Error('Unexpected worker format');
  return w.trimEnd().slice(0, -exp.length);
}
const cjkJs =
  `window.__CJK_MAP=${fs.readFileSync(path.join(root, 'assets/cjk-map.json'), 'utf8')};\n` +
  `window.__CJK_B64="${b64(path.join(root, 'assets/cjk.ttf'))}";\n` + src('cjk.js');
const pdflib = fs.readFileSync(path.join(LIB, 'pdf-lib/dist/pdf-lib.min.js'), 'utf8');
for (const [n, s] of [['pdf-lib', pdflib], ['app', src('app.js')], ['cjk', src('cjk.js')], ['redact', src('redact.js')]]) {
  if (/<\/script|<!--/i.test(s)) throw new Error(`${n} contains a sequence that would break inline <script>`);
}
const html = src('app.html')
  .replace('/*__CSS__*/', () => src('app.css'))
  .replace('/*__ASSETS__*/', () => assetJs)
  .replace('/*__PDFLIB__*/', () => pdflib)
  .replace('/*__CJK__*/', () => cjkJs)
  .replace('/*__REDACT__*/', () => src('redact.js'))
  .replace('/*__APP__*/', () => src('app.js'))
  .replace('/*__VERSION__*/', () => VERSION);

fs.writeFileSync(path.join(root, 'desktop', 'index.html'), html);
console.log('Built v' + VERSION, (html.length / 1e6).toFixed(1), 'MB -> desktop/index.html');
