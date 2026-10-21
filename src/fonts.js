/* Font manager for edited text: finds the PDF's original font on this PC (or downloads and installs a free
   copy from Google Fonts), loads it for display and gives the parsed font to the PDF writer, so edited text
   keeps exactly the same typeface. Works only inside the installed app (it needs the PC's font folder). */
'use strict';
window.PDFStudioFonts = (() => {
  const S = window.PDFStudioSfnt;
  const host = window.pdfStudioHost && window.pdfStudioHost.fonts;
  let listP = null, n = 0;
  const loaded = new Map(), loading = new Map(), dlTried = new Map();

  // Free fonts with the same letter widths as common commercial fonts (used only when the original isn't installed)
  const SUBSTITUTES = {
    calibri: ['Carlito'], cambria: ['Caladea'], arial: ['Arimo', 'Liberation Sans'], helvetica: ['Arial', 'Arimo', 'Liberation Sans'],
    helveticaneue: ['Arial', 'Arimo'], timesnewroman: ['Tinos', 'Liberation Serif'], times: ['Times New Roman', 'Tinos'],
    couriernew: ['Cousine', 'Liberation Mono'], courier: ['Courier New', 'Cousine'], georgia: ['Gelasio'],
    arialnarrow: ['Liberation Sans Narrow', 'Arimo'], symbol: [], zapfdingbats: [],
  };

  function list() {
    if (!listP) listP = host ? host.list().then(l => Array.isArray(l) ? l : []).catch(() => []) : Promise.resolve([]);
    return listP;
  }
  function refreshList() { listP = null; return list(); }
  const keyOf = e => e.file + '#' + e.index;
  const famKey = s => String(s || '').toLowerCase().replace(/[\s\-_,]+/g, '');

  async function load(entry) {
    const key = keyOf(entry);
    if (loaded.has(key)) return loaded.get(key);
    if (!loading.has(key)) loading.set(key, (async () => {
      const bytes = new Uint8Array(await host.read(entry.file, entry.index));
      const f = S.parse(bytes);
      const css = `PSF${++n}`;
      const face = new FontFace(css, bytes.slice().buffer);
      await face.load(); document.fonts.add(face);
      const rec = { key, f, css: `"${css}"`, asc: f.asc / f.upm, desc: f.desc / f.upm, family: entry.family, style: entry.style,
        bold: !!entry.bold, italic: !!entry.italic, label: entry.full || `${entry.family} ${entry.style}`, ps: entry.ps };
      loaded.set(key, rec);
      return rec;
    })().finally(() => loading.delete(key)));
    return loading.get(key);
  }
  const get = key => (key && loaded.get(key)) || null;

  // Weight from a style word ("SemiBold" -> 600). bold=true/false is treated as 700/400.
  const WEIGHTS = [['extralight', 200], ['ultralight', 200], ['semibold', 600], ['demibold', 600], ['extrabold', 800], ['ultrabold', 800],
    ['hairline', 100], ['thin', 100], ['light', 300], ['regular', 400], ['normal', 400], ['book', 400], ['roman', 400], ['medium', 500],
    ['bold', 700], ['black', 900], ['heavy', 900]];
  const wantW = w => typeof w === 'number' ? w : (w ? 700 : 400);
  /** Best face of a family for the wanted weight (or bold flag) and italic (null if the family isn't installed). */
  async function faceOf(family, weight, italic) {
    const fk = famKey(family), all = await list(), W = wantW(weight);
    const faces = all.filter(e => famKey(e.family) === fk || famKey(e.family1) === fk);
    if (!faces.length) return null;
    const score = e => Math.abs((e.weight || (e.bold ? 700 : 400)) - W) / 100 + (!!e.italic === !!italic ? 0 : 3)
      + (/condensed|narrow|expanded|wide/i.test(e.style) ? 2 : 0);
    return faces.sort((a, b) => score(a) - score(b))[0];
  }
  const styleOk = (x, weight, italic) => x && Math.abs((x.weight || (x.bold ? 700 : 400)) - wantW(weight)) <= 100 && !!x.italic === !!italic;
  async function tryDownload(family, weight, italic) {
    if (!host || !host.download) return null;
    const W = wantW(weight), k = `${famKey(family)}|${W}|${!!italic}`;
    if (!dlTried.has(k)) dlTried.set(k, host.download(family, W, !!italic).then(e => { console.log('[diag] font download', family, W, italic ? 'italic' : '', e ? 'ok ' + e.file : 'not available'); if (e) refreshList(); return e || null; }).catch(err => { console.warn('font download failed', family, err && err.message); return null; }));
    const e = await dlTried.get(k);
    return e ? (await faceOf(family, W, italic)) || e : null;
  }
  const splitCamel = s => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');

  /** Splits a PDF font name into family, weight and italic: "MontserratThin-SemiBold" -> Montserrat / 600. */
  function parseName(clean, bold, italic) {
    const parts = clean.split(/[,\-]/);
    let fam = parts[0].replace(/(PS)?MT$/, '');
    const styleTxt = parts.slice(1).join('').toLowerCase();
    let weight = null;
    for (const [w, v] of WEIGHTS) if (styleTxt.includes(w)) { weight = v; break; }
    let it = /italic|oblique/.test(styleTxt) || !!italic;
    // weight / italic words stuck on the family name ("OpenSansLight", "MontserratThin", "ArialItalic")
    let base = fam, famWeight = null, changed = true;
    while (changed) {
      changed = false;
      const m = /(Italic|Oblique|It)$/.exec(base);
      if (m && base.length > m[0].length + 2) { base = base.slice(0, -m[0].length); it = true; changed = true; continue; }
      for (const [w, v] of WEIGHTS) {
        if (w === 'roman' || w === 'book' || w === 'normal') continue; // part of real names (Times New Roman, Bookman…)
        const re = new RegExp(w.replace(/^(.)/, c => `[${c.toUpperCase()}${c}]`).replace(/(bold|light|black)$/, x => `[${x[0].toUpperCase()}${x[0]}]${x.slice(1)}`) + '$');
        const mm = re.exec(base);
        if (mm && base.length > mm[0].length + 2) { base = base.slice(0, -mm[0].length); famWeight = famWeight ?? v; changed = true; break; }
      }
    }
    // The style part (after "-") is the face actually used; a weight word in the family name is only a fallback.
    if (weight == null) weight = styleTxt ? 400 : (famWeight ?? (bold ? 700 : 400));
    if (bold && weight < 600 && !styleTxt) weight = 700;
    const fams = [...new Set([fam, splitCamel(fam), base, splitCamel(base)].filter(x => x && x.length > 1))];
    return { fams, display: splitCamel(base), weight, italic: it };
  }

  /**
   * Finds the font a PDF used. `pdfName` is the PDF's font name (e.g. "ABCDEF+Calibri-Bold", "Arial,Bold", "TimesNewRomanPSMT").
   * Returns { rec, how } where how = 'installed' | 'downloaded' | 'substitute' | 'substitute-downloaded', or null.
   */
  async function resolvePdfFont(pdfName, bold, italic, onStatus) {
    if (!host) return null;
    const clean = String(pdfName || '').replace(/^[A-Z]{6}\+/, '');
    if (!clean) return null;
    const all = await list(), k = S.nameKey(clean);
    // 1) exactly this face is installed
    let e = all.find(x => S.nameKey(x.ps) === k) || all.find(x => S.nameKey(x.full) === k);
    if (e) return { rec: await load(e), how: 'installed' };
    const P = parseName(clean, bold, italic);
    // 2) the family is installed in the right weight/style
    let near = null;
    for (const fam of P.fams) { e = await faceOf(fam, P.weight, P.italic); if (styleOk(e, P.weight, P.italic)) return { rec: await load(e), how: 'installed' }; near = near || e; }
    // 3) download the family in that weight (free Google Fonts)
    onStatus && onStatus(`Downloading the font “${P.display}”…`);
    for (const fam of [...P.fams].reverse()) {
      e = await tryDownload(fam, P.weight, P.italic);
      if (styleOk(e, P.weight, P.italic)) return { rec: await load(e), how: 'downloaded', name: fam };
      if (e && !near) near = e;
    }
    if (near) return { rec: await load(near), how: 'installed' }; // family present, exact weight not available
    // 4) a free font with identical letter widths
    const subs = SUBSTITUTES[famKey(P.fams[P.fams.length - 1])] || SUBSTITUTES[famKey(P.fams[0])] || [];
    for (const s of subs) { e = await faceOf(s, P.weight, P.italic); if (styleOk(e, P.weight, P.italic)) return { rec: await load(e), how: 'substitute', name: s, original: P.display }; }
    for (const s of subs) { e = await tryDownload(s, P.weight, P.italic); if (e) return { rec: await load(e), how: 'substitute-downloaded', name: s, original: P.display }; }
    return { none: true, display: P.display, weight: P.weight, italic: P.italic };
  }
  /** A family chosen by the user from the font list. */
  async function resolveFamily(family, bold, italic) {
    const e = await faceOf(family, bold, italic);
    return e ? load(e) : null;
  }
  async function families() {
    const all = await list(), seen = new Map();
    for (const e of all) if (e.family && !seen.has(famKey(e.family))) seen.set(famKey(e.family), e.family);
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }
  function refresh() { dlTried.clear(); return refreshList(); }
  return { available: !!host, list, load, get, resolvePdfFont, resolveFamily, faceOf, families, famKey, parseName, tryDownload, refresh };
})();
