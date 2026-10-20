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

  /** Best face of a family for the wanted bold/italic (null if the family isn't installed). */
  async function faceOf(family, bold, italic) {
    const fk = famKey(family), all = await list();
    const faces = all.filter(e => famKey(e.family) === fk || famKey(e.family1) === fk);
    if (!faces.length) return null;
    const score = e => (e.bold === !!bold ? 0 : 4) + (e.italic === !!italic ? 0 : 2) + Math.abs((e.weight || 400) - (bold ? 700 : 400)) / 1000
      + (/condensed|narrow|light|thin|black|semi|demi|medium/i.test(e.style) ? 1 : 0);
    return faces.sort((a, b) => score(a) - score(b))[0];
  }
  async function tryDownload(family, bold, italic) {
    if (!host || !host.download) return null;
    const k = `${famKey(family)}|${!!bold}|${!!italic}`;
    if (!dlTried.has(k)) dlTried.set(k, host.download(family, !!bold, !!italic).then(e => { console.log('[diag] font download', family, bold, italic, e ? 'ok ' + e.file : 'not available'); if (e) refreshList(); return e || null; }).catch(err => { console.warn('font download failed', family, err && err.message); return null; }));
    const e = await dlTried.get(k);
    return e ? (await faceOf(family, bold, italic)) || e : null;
  }
  const splitCamel = s => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');

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
    // 2) the family is installed in the right style (bold/italic)
    const famPart = clean.split(/[,\-]/)[0].replace(/(PS)?MT$/, '');
    const fams = [...new Set([famPart, splitCamel(famPart)])];
    const styleOk = x => x && !!x.bold === !!bold && !!x.italic === !!italic;
    let near = null;
    for (const fam of fams) { e = await faceOf(fam, bold, italic); if (styleOk(e)) return { rec: await load(e), how: 'installed' }; near = near || e; }
    // 3) download the same family in that style (free Google Fonts)
    onStatus && onStatus(`Downloading the font “${splitCamel(famPart)}”…`);
    for (const fam of [...new Set([splitCamel(famPart), famPart])]) {
      e = await tryDownload(fam, bold, italic);
      if (styleOk(e)) return { rec: await load(e), how: 'downloaded', name: fam };
    }
    if (near) return { rec: await load(near), how: 'installed' }; // family present, style not available
    // 4) a free font with identical letter widths
    const subs = SUBSTITUTES[famKey(famPart)] || [];
    for (const s of subs) { e = await faceOf(s, bold, italic); if (styleOk(e)) return { rec: await load(e), how: 'substitute', name: s, original: splitCamel(famPart) }; }
    for (const s of subs) { e = await tryDownload(s, bold, italic); if (e) return { rec: await load(e), how: 'substitute-downloaded', name: s, original: splitCamel(famPart) }; }
    return null;
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
  return { available: !!host, list, load, get, resolvePdfFont, resolveFamily, faceOf, families, famKey };
})();
