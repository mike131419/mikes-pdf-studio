/* Chinese (CJK) text support: loads the built-in WenQuanYi Zen Hei font for on-screen display,
   and embeds a per-document subset of it into saved PDFs (Type0 / CIDFontType2, Identity-H). */
'use strict';
window.PDFStudioCJK = (() => {
  const FAMILY = 'PDFStudioCJK';
  const WINANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
  const meta = window.__CJK_MAP;
  // Baseline position (in font-size units) for CSS line-height 1.2
  const BASELINE = (1.2 - (meta.asc + meta.desc) / meta.upm) / 2 + meta.asc / meta.upm;
  let bytes = null, gidMap = null, font = null, ready = null;

  /** True when the text has characters the standard Helvetica font can't encode. */
  function needs(text) {
    for (const ch of text) {
      const c = ch.codePointAt(0);
      if (c === 10 || c === 13 || c === 9) continue;
      if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff)) continue;
      if (WINANSI_EXTRA.includes(ch)) continue;
      return true;
    }
    return false;
  }
  function decode(b64) {
    const bin = atob(b64), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function load() {
    if (ready) return ready;
    ready = (async () => {
      bytes = decode(window.__CJK_B64); window.__CJK_B64 = null;
      gidMap = new Map();
      for (const [cp, g, n] of meta.ranges) for (let i = 0; i < n; i++) gidMap.set(cp + i, g + i);
      font = parse(bytes);
      const face = new FontFace(FAMILY, bytes.slice().buffer);
      await face.load();
      document.fonts.add(face);
    })();
    return ready;
  }

  /* ---------------------------------------------------- tiny TrueType reader */
  function parse(b) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const n = dv.getUint16(4), tables = {};
    for (let i = 0; i < n; i++) {
      const o = 12 + i * 16;
      const tag = String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
      tables[tag] = { off: dv.getUint32(o + 8), len: dv.getUint32(o + 12) };
    }
    const head = tables.head.off;
    return {
      b, dv, tables,
      upm: dv.getUint16(head + 18),
      bbox: [dv.getInt16(head + 36), dv.getInt16(head + 38), dv.getInt16(head + 40), dv.getInt16(head + 42)],
      longLoca: dv.getInt16(head + 50) === 1,
      numGlyphs: dv.getUint16(tables.maxp.off + 4),
      numH: dv.getUint16(tables.hhea.off + 34),
    };
  }
  function loca(f, g) {
    const o = f.tables.loca.off;
    return f.longLoca ? [f.dv.getUint32(o + g * 4), f.dv.getUint32(o + g * 4 + 4)]
                      : [f.dv.getUint16(o + g * 2) * 2, f.dv.getUint16(o + g * 2 + 2) * 2];
  }
  function advance(f, g) { return f.dv.getUint16(f.tables.hmtx.off + Math.min(g, f.numH - 1) * 4); }

  /** Rebuilds the font keeping glyph ids but emptying every glyph not in `used` (composites included). */
  function subset(f, used) {
    const glyf = f.tables.glyf.off, dv = f.dv;
    const keep = new Set([0, ...used]), queue = [...keep];
    while (queue.length) { // pull in components of composite glyphs
      const g = queue.pop(), [s, e] = loca(f, g);
      if (e - s < 10 || dv.getInt16(glyf + s) >= 0) continue;
      let p = glyf + s + 10, flags;
      do {
        flags = dv.getUint16(p); const comp = dv.getUint16(p + 2); p += 4;
        p += flags & 1 ? 4 : 2;
        p += flags & 8 ? 2 : flags & 0x40 ? 4 : flags & 0x80 ? 8 : 0;
        if (!keep.has(comp)) { keep.add(comp); queue.push(comp); }
      } while (flags & 0x20);
    }
    const parts = [], locaOut = new Uint32Array(f.numGlyphs + 1);
    let size = 0;
    for (let g = 0; g < f.numGlyphs; g++) {
      locaOut[g] = size;
      if (!keep.has(g)) continue;
      const [s, e] = loca(f, g);
      if (e > s) { const len = (e - s + 3) & ~3; const chunk = new Uint8Array(len); chunk.set(f.b.subarray(glyf + s, glyf + e)); parts.push(chunk); size += len; }
    }
    locaOut[f.numGlyphs] = size;
    const glyfOut = new Uint8Array(size); let off = 0;
    for (const c of parts) { glyfOut.set(c, off); off += c.length; }
    const locaBytes = new Uint8Array(locaOut.length * 4), ldv = new DataView(locaBytes.buffer);
    locaOut.forEach((v, i) => ldv.setUint32(i * 4, v));
    const copy = tag => f.b.slice(f.tables[tag].off, f.tables[tag].off + f.tables[tag].len);
    const head = copy('head'); const hdv = new DataView(head.buffer);
    hdv.setUint32(8, 0); hdv.setInt16(50, 1); // checkSumAdjustment, indexToLocFormat = long
    const out = { head, hhea: copy('hhea'), maxp: copy('maxp'), hmtx: copy('hmtx'), loca: locaBytes, glyf: glyfOut };
    for (const t of ['OS/2', 'name', 'post']) if (f.tables[t]) out[t] = copy(t);
    return writeFont(out);
  }
  function checksum(b) {
    const p = new Uint8Array((b.length + 3) & ~3); p.set(b);
    const dv = new DataView(p.buffer); let s = 0;
    for (let i = 0; i < p.length; i += 4) s = (s + dv.getUint32(i)) >>> 0;
    return s;
  }
  function writeFont(tables) {
    const tags = Object.keys(tables).sort(), n = tags.length;
    let total = 12 + n * 16;
    const offsets = tags.map(t => { const o = total; total += (tables[t].length + 3) & ~3; return o; });
    const out = new Uint8Array(total), dv = new DataView(out.buffer);
    const es = Math.floor(Math.log2(n)), sr = 2 ** es * 16;
    dv.setUint32(0, 0x00010000); dv.setUint16(4, n); dv.setUint16(6, sr); dv.setUint16(8, es); dv.setUint16(10, n * 16 - sr);
    tags.forEach((t, i) => {
      const o = 12 + i * 16;
      for (let k = 0; k < 4; k++) out[o + k] = t.charCodeAt(k);
      dv.setUint32(o + 4, checksum(tables[t])); dv.setUint32(o + 8, offsets[i]); dv.setUint32(o + 12, tables[t].length);
      out.set(tables[t], offsets[i]);
    });
    const headOff = offsets[tags.indexOf('head')];
    dv.setUint32(headOff + 8, (0xb1b0afba - checksum(out)) >>> 0);
    return out;
  }

  /* ------------------------------------------------------------ PDF output */
  /** Creates an embedder for one output document. Call gids() for every text first, then finish(). */
  function embedder(pdfDoc) {
    const P = window.PDFLib, used = new Map(); // gid -> unicode string
    let ref = null, missing = false;
    const fallback = gidMap.get(0x3f);
    function gids(text) {
      const out = [];
      for (const ch of text.replace(/\t/g, ' ')) {
        let g = gidMap.get(ch.codePointAt(0));
        if (g == null) { g = fallback; missing = true; }
        out.push(g); if (!used.has(g)) used.set(g, g === fallback ? '?' : ch);
      }
      return out;
    }
    function finish() {
      if (!used.size) return null;
      const ctx = pdfDoc.context, k = 1000 / font.upm;
      const tag = Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
      const name = `${tag}+WenQuanYiZenHei`;
      const fontBytes = subset(font, used.keys());
      const fontFile = ctx.register(ctx.flateStream(fontBytes, { Length1: fontBytes.length }));
      const descriptor = ctx.register(ctx.obj({
        Type: 'FontDescriptor', FontName: name, Flags: 4,
        FontBBox: font.bbox.map(v => Math.round(v * k)), ItalicAngle: 0,
        Ascent: Math.round(meta.asc * k), Descent: -Math.round(meta.desc * k), CapHeight: 730, StemV: 80, FontFile2: fontFile,
      }));
      const sorted = [...used.keys()].sort((a, b) => a - b);
      const W = [];
      for (const g of sorted) W.push(g, [Math.round(advance(font, g) * k)]);
      const cid = ctx.register(ctx.obj({
        Type: 'Font', Subtype: 'CIDFontType2', BaseFont: name,
        CIDSystemInfo: { Registry: P.PDFString.of('Adobe'), Ordering: P.PDFString.of('Identity'), Supplement: 0 },
        FontDescriptor: descriptor, DW: 1000, W, CIDToGIDMap: 'Identity',
      }));
      const hex4 = n => n.toString(16).padStart(4, '0').toUpperCase();
      const u16 = s => [...s].map(c => { const cp = c.codePointAt(0); if (cp < 0x10000) return hex4(cp); const v = cp - 0x10000; return hex4(0xd800 + (v >> 10)) + hex4(0xdc00 + (v & 0x3ff)); }).join('');
      let body = '';
      for (let i = 0; i < sorted.length; i += 100) {
        const chunk = sorted.slice(i, i + 100);
        body += `${chunk.length} beginbfchar\n${chunk.map(g => `<${hex4(g)}> <${u16(used.get(g))}>`).join('\n')}\nendbfchar\n`;
      }
      const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${body}endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`;
      const toUnicode = ctx.register(ctx.flateStream(new TextEncoder().encode(cmap)));
      ref = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: name, Encoding: 'Identity-H', DescendantFonts: [cid], ToUnicode: toUnicode }));
      return ref;
    }
    /** Draws one line of already-converted glyph ids on a page. */
    const pageKeys = new Map();
    function draw(page, glyphIds, { x, y, size, color, rotate }) {
      let key = pageKeys.get(page);
      if (!key) { key = page.node.newFontDictionary('CJK', ref); pageKeys.set(page, key); }
      const hex = glyphIds.map(g => g.toString(16).padStart(4, '0')).join('');
      page.pushOperators(...P.drawText(P.PDFHexString.of(hex), { x, y, size, color, rotate, xSkew: P.degrees(0), ySkew: P.degrees(0), font: key }));
    }
    return { gids, finish, draw, get missing() { return missing; } };
  }

  return { FAMILY, BASELINE, ASC: meta.asc / meta.upm, DESC: meta.desc / meta.upm, needs, load, embedder, get loaded() { return !!font; } };
})();
