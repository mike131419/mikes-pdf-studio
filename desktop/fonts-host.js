// Font service for the app shell (main process): lists the fonts installed on this PC, reads a font's
// bytes, and downloads + installs free fonts from Google Fonts when a PDF uses one this PC doesn't have.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const Sfnt = require('./sfnt.js');

const FONT_EXT = /\.(ttf|otf|ttc)$/i;

function fontDirs(app) {
  if (process.env.PDFSTUDIO_FONT_DIRS) return process.env.PDFSTUDIO_FONT_DIRS.split(path.delimiter);
  const dirs = [];
  if (process.platform === 'win32') {
    dirs.push(path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'));
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'));
  } else if (process.platform === 'darwin') {
    dirs.push('/System/Library/Fonts', '/Library/Fonts', path.join(app.getPath('home'), 'Library/Fonts'));
  } else {
    dirs.push('/usr/share/fonts', '/usr/local/share/fonts', path.join(app.getPath('home'), '.local/share/fonts'));
  }
  return dirs;
}
function installDir(app) {
  if (process.env.PDFSTUDIO_INSTALL_FONT_DIR) return process.env.PDFSTUDIO_INSTALL_FONT_DIR;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts');
  return path.join(app.getPath('userData'), 'fonts');
}
function walk(dir, out, depth = 0) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 4) walk(p, out, depth + 1);
    else if (e.isFile() && FONT_EXT.test(e.name)) out.push(p);
  }
}

function createFontService(app) {
  const cacheFile = path.join(app.getPath('userData'), 'font-list.json');
  let list = null, listing = null;
  const allowed = new Set();

  async function scan() {
    let cache = {};
    try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
    const files = [];
    for (const d of [...fontDirs(app), installDir(app)]) walk(d, files);
    const fresh = {}, out = [];
    let n = 0;
    for (const file of [...new Set(files)]) {
      let st; try { st = fs.statSync(file); } catch { continue; }
      const sig = `${st.size}:${st.mtimeMs}`;
      let faces = cache[file] && cache[file].sig === sig ? cache[file].faces : null;
      if (!faces) {
        try { faces = Sfnt.describe(new Uint8Array(fs.readFileSync(file))); } catch { faces = []; }
        if (++n % 20 === 0) await new Promise(r => setImmediate(r)); // stay responsive
      }
      fresh[file] = { sig, faces };
      for (const f of faces) if (f.family) out.push({ ...f, file });
    }
    try { fs.writeFileSync(cacheFile, JSON.stringify(fresh)); } catch {}
    for (const f of out) allowed.add(f.file);
    return out;
  }
  function getList(refresh) {
    if (refresh) { list = null; listing = null; }
    if (list) return Promise.resolve(list);
    if (!listing) listing = scan().then(l => (list = l)).catch(e => { listing = null; throw e; });
    return listing;
  }

  async function read(file, index) {
    await getList();
    if (!allowed.has(file)) throw new Error('Not a known font file');
    const b = new Uint8Array(fs.readFileSync(file));
    return Sfnt.extractFace(b, index | 0);
  }

  /* ---- Google Fonts download ---- */
  const GF = process.env.PDFSTUDIO_GFONTS_URL || 'https://fonts.googleapis.com';
  // An old-browser user agent makes Google Fonts serve plain TrueType files (needed for PDF embedding).
  const UAS = ['Mozilla/4.0 (compatible; MSIE 8.0; Windows NT 6.1)', 'Wget/1.21', 'curl/8.0'];
  async function fetchBuf(net, url, ua) {
    const r = await net.fetch(url, { headers: ua ? { 'User-Agent': ua } : {} });
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    return Buffer.from(await r.arrayBuffer());
  }
  async function download(net, family, weight, italic) {
    family = String(family || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9 ]{0,60}$/.test(family)) throw new Error('Unusual font name');
    const wght = typeof weight === 'number' ? Math.min(900, Math.max(100, Math.round(weight / 100) * 100)) : (weight ? 700 : 400), ital = italic ? 1 : 0;
    const q = `${GF}/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:ital,wght@${ital},${wght}`;
    let css = null, lastErr;
    for (const ua of UAS) {
      try {
        css = (await fetchBuf(net, q, ua)).toString('utf8');
        if (/format\('(truetype|opentype)'\)|\.ttf\)|\.otf\)/.test(css)) break;
      } catch (e) { lastErr = e; if (e.status === 400 || e.status === 404) return null; }
    }
    if (!css) { if (lastErr) throw lastErr; return null; }
    const urls = [...css.matchAll(/url\(([^)]+?\.(?:ttf|otf))\)/g)].map(m => m[1].replace(/['"]/g, ''));
    if (!urls.length) return null;
    // the latin subset is listed last; prefer a URL without a subset comment when there are several
    const blocks = css.split('@font-face').filter(b => /url\(/.test(b));
    const pickBlock = blocks.find(b => /\/\*\s*latin\s*\*\//.test(b)) || blocks[blocks.length - 1] || '';
    const url = (pickBlock.match(/url\(([^)]+?\.(?:ttf|otf))\)/) || [])[1] || urls[urls.length - 1];
    const data = await fetchBuf(net, url.replace(/['"]/g, ''));
    let faces;
    try { faces = Sfnt.describe(new Uint8Array(data)); } catch { throw new Error('Downloaded file is not a font'); }
    const face = faces[0];
    const WN = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: '', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };
    const style = (WN[wght] || '') + (italic ? 'Italic' : '') || 'Regular';
    const fileName = `${family.replace(/\s+/g, '')}-${style}${/\.otf/i.test(url) ? '.otf' : '.ttf'}`;
    const dir = installDir(app);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, fileName);
    fs.writeFileSync(file, data);
    await register(file, `${face.full || family + ' ' + style}`);
    await getList(true);
    const entry = (await getList()).find(f => f.file === file);
    return entry || null;
  }
  function register(file, fullName) {
    // Per-user font install on Windows: no administrator rights needed. Other apps see it after they restart.
    if (process.platform !== 'win32' || process.env.PDFSTUDIO_INSTALL_FONT_DIR) return Promise.resolve();
    return new Promise(res => execFile('reg', ['add', 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
      '/v', `${fullName} (TrueType)`, '/t', 'REG_SZ', '/d', file, '/f'], { windowsHide: true }, () => res()));
  }

  getList().catch(() => {}); // start scanning in the background
  return { getList, read, download };
}
module.exports = { createFontService };
