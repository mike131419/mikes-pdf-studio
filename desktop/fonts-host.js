// Font service for the app shell (main process): lists the fonts installed on this PC, reads a font's
// bytes, and downloads + installs free fonts from Google Fonts when a PDF uses one this PC doesn't have.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const zlib = require('zlib');
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

function createFontService(app, log = () => {}) {
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

  /* ---- Free font download ----
     1) Google Fonts CSS APIs, asking for plain TrueType files (old-browser user agents)
     2) Fontsource on jsDelivr (the same Google Fonts, as static WOFF files per weight), converted to TrueType here */
  const GF = process.env.PDFSTUDIO_GFONTS_URL || 'https://fonts.googleapis.com';
  const FSRC = process.env.PDFSTUDIO_FONTSOURCE_URL || 'https://cdn.jsdelivr.net/npm';
  const UAS = ['Mozilla/4.0 (compatible; MSIE 8.0; Windows NT 6.1)', 'Wget/1.21', 'curl/8.0', ''];
  const WN = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: '', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };
  async function fetchBuf(net, url, ua) {
    const r = await net.fetch(url, { headers: ua ? { 'User-Agent': ua } : {} });
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    return Buffer.from(await r.arrayBuffer());
  }
  /** WOFF 1.0 -> TrueType/OpenType (tables are zlib-compressed one by one). */
  function woffToSfnt(buf) {
    if (buf.toString('latin1', 0, 4) !== 'wOFF') return null;
    const flavor = buf.readUInt32BE(4), n = buf.readUInt16BE(12), tables = {};
    for (let i = 0; i < n; i++) {
      const o = 44 + i * 20, tag = buf.toString('latin1', o, o + 4);
      const off = buf.readUInt32BE(o + 4), comp = buf.readUInt32BE(o + 8), orig = buf.readUInt32BE(o + 12);
      const raw = buf.subarray(off, off + comp);
      tables[tag] = new Uint8Array(comp < orig ? zlib.inflateSync(raw) : raw);
    }
    return Buffer.from(Sfnt.writeFont(tables, flavor));
  }
  const isFont = b => b && b.length > 12 && [0x00010000, 0x4f54544f, 0x74727565].includes(b.readUInt32BE(0));
  async function fromGoogleCss(net, family, wght, ital, notes) {
    const fam = encodeURIComponent(family).replace(/%20/g, '+');
    const queries = [`${GF}/css2?family=${fam}:ital,wght@${ital},${wght}`, `${GF}/css?family=${fam}:${wght}${ital ? 'italic' : ''}`];
    for (const q of queries) for (const ua of UAS) {
      let css;
      try { css = (await fetchBuf(net, q, ua)).toString('utf8'); }
      catch (e) { notes.push(`${q.includes('css2') ? 'css2' : 'css'} ${e.message}`); if (e.status === 400 || e.status === 404) break; continue; }
      const blocks = css.split('@font-face').filter(b => /url\(/.test(b));
      const pick = blocks.find(b => /\/\*\s*latin\s*\*\//.test(b) && /\.(ttf|otf)\)/.test(b)) || blocks.reverse().find(b => /\.(ttf|otf)\)/.test(b));
      const m = pick && pick.match(/url\(([^)]+?\.(?:ttf|otf))\)/);
      if (!m) { notes.push(`${q.includes('css2') ? 'css2' : 'css'} ua#${UAS.indexOf(ua)}: no TrueType (${(css.match(/format\('([^']+)'\)/) || [])[1] || 'none'})`); continue; }
      const data = await fetchBuf(net, m[1].replace(/['"]/g, ''));
      if (isFont(data)) return { data, ext: /\.otf/i.test(m[1]) ? '.otf' : '.ttf', src: 'google' };
    }
    return null;
  }
  async function fromFontsource(net, family, wght, ital, notes) {
    const slug = family.toLowerCase().replace(/\s+/g, '-');
    const url = `${FSRC}/@fontsource/${slug}@5/files/${slug}-latin-${wght}-${ital ? 'italic' : 'normal'}.woff`;
    try {
      const data = woffToSfnt(await fetchBuf(net, url));
      if (isFont(data)) return { data, ext: '.ttf', src: 'fontsource' };
      notes.push('fontsource: not a WOFF file');
    } catch (e) { notes.push(`fontsource ${e.message}`); }
    return null;
  }
  async function download(net, family, weight, italic) {
    family = String(family || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9 ]{0,60}$/.test(family)) throw new Error('Unusual font name');
    const wght = typeof weight === 'number' ? Math.min(900, Math.max(100, Math.round(weight / 100) * 100)) : (weight ? 700 : 400), ital = italic ? 1 : 0;
    const notes = [];
    const got = (await fromGoogleCss(net, family, wght, ital, notes).catch(e => { notes.push('google ' + e.message); return null; }))
      || (await fromFontsource(net, family, wght, ital, notes));
    log(`font download ${family} ${wght}${ital ? 'i' : ''}: ${got ? 'ok from ' + got.src : 'not found'} ${notes.length ? '(' + notes.join('; ') + ')' : ''}`);
    if (!got) return null;
    let faces;
    try { faces = Sfnt.describe(new Uint8Array(got.data)); } catch { throw new Error('Downloaded file is not a font'); }
    const face = faces[0];
    const style = (WN[wght] || '') + (italic ? 'Italic' : '') || 'Regular';
    const fileName = `${family.replace(/\s+/g, '')}-${style}${got.ext}`;
    const dir = installDir(app);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, fileName);
    fs.writeFileSync(file, got.data);
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
