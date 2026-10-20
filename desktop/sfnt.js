/* Small OpenType/TrueType toolkit shared by the app shell (Node) and the editor (browser):
   read font names and metrics, map characters to glyphs, pull one face out of a .ttc collection,
   subset TrueType outlines, and embed a font into a PDF (Type0 / Identity-H) so saved text uses
   exactly the same font that is shown on screen. */
'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PDFStudioSfnt = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const tagAt = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  const view = b => new DataView(b.buffer, b.byteOffset, b.byteLength);

  /** Offsets of the faces in a font file (one for .ttf/.otf, several for .ttc). */
  function faceOffsets(b) {
    if (tagAt(b, 0) === 'ttcf') {
      const dv = view(b), n = dv.getUint32(8), out = [];
      for (let i = 0; i < n; i++) out.push(dv.getUint32(12 + i * 4));
      return out;
    }
    return [0];
  }
  function tableDir(b, off = 0) {
    const dv = view(b), n = dv.getUint16(off + 4), tables = {};
    for (let i = 0; i < n; i++) {
      const o = off + 12 + i * 16;
      tables[tagAt(b, o)] = { off: dv.getUint32(o + 8), len: dv.getUint32(o + 12) };
    }
    return tables;
  }
  function decodeName(b, off, len, platform) {
    if (platform === 3 || platform === 0) {
      let s = '';
      for (let i = 0; i + 1 < len; i += 2) s += String.fromCharCode((b[off + i] << 8) | b[off + i + 1]);
      return s;
    }
    let s = ''; for (let i = 0; i < len; i++) s += String.fromCharCode(b[off + i]); return s;
  }
  /** Reads the name table: family, subfamily (style), full name, PostScript name, typographic family/style. */
  function readNames(b, tables) {
    const t = tables.name; if (!t) return {};
    const dv = view(b), count = dv.getUint16(t.off + 2), strOff = t.off + dv.getUint16(t.off + 4);
    const best = {};
    for (let i = 0; i < count; i++) {
      const r = t.off + 6 + i * 12;
      const platform = dv.getUint16(r), enc = dv.getUint16(r + 2), lang = dv.getUint16(r + 4), id = dv.getUint16(r + 6);
      if (![1, 2, 4, 6, 16, 17].includes(id)) continue;
      // prefer Windows English (US), then any Windows, then Mac Roman
      const score = platform === 3 && (enc === 1 || enc === 0 || enc === 10) ? (lang === 0x409 ? 3 : 2) : platform === 1 && enc === 0 ? 1 : 0;
      if (!score || (best[id] && best[id].score >= score)) continue;
      best[id] = { score, s: decodeName(b, strOff + dv.getUint16(r + 10), dv.getUint16(r + 8), platform) };
    }
    const g = id => best[id] ? best[id].s.replace(/\0/g, '').trim() : '';
    return { family: g(16) || g(1), style: g(17) || g(2), family1: g(1), style1: g(2), full: g(4), ps: g(6) };
  }
  function readStyle(b, tables) {
    const dv = view(b); let weight = 400, italic = false, bold = false;
    if (tables['OS/2']) {
      weight = dv.getUint16(tables['OS/2'].off + 4);
      const fs = dv.getUint16(tables['OS/2'].off + 62);
      italic = !!(fs & 1); bold = !!(fs & 32);
    }
    if (tables.head) { const ms = dv.getUint16(tables.head.off + 44); bold = bold || !!(ms & 1); italic = italic || !!(ms & 2); }
    return { weight, bold: bold || weight >= 600, italic };
  }
  /** Lightweight description of every face in a font file (for building the font list). */
  function describe(b) {
    return faceOffsets(b).map((off, index) => {
      const tables = tableDir(b, off);
      return { index, ...readNames(b, tables), ...readStyle(b, tables), cff: !!tables['CFF '] || !!tables.CFF2, glyf: !!tables.glyf };
    });
  }

  /** Builds a standalone font file from one face of a .ttc (or returns the input for single fonts). */
  function extractFace(b, index = 0) {
    const offs = faceOffsets(b);
    if (offs.length === 1 && offs[0] === 0) return b;
    const tables = tableDir(b, offs[index]), out = {};
    for (const [tag, t] of Object.entries(tables)) out[tag] = b.slice(t.off, t.off + t.len);
    return writeFont(out, view(b).getUint32(offs[index]));
  }

  function checksum(b) {
    const p = new Uint8Array((b.length + 3) & ~3); p.set(b);
    const dv = new DataView(p.buffer); let s = 0;
    for (let i = 0; i < p.length; i += 4) s = (s + dv.getUint32(i)) >>> 0;
    return s;
  }
  function writeFont(tables, version = 0x00010000) {
    const tags = Object.keys(tables).sort(), n = tags.length;
    let total = 12 + n * 16;
    const offsets = tags.map(t => { const o = total; total += (tables[t].length + 3) & ~3; return o; });
    const out = new Uint8Array(total), dv = new DataView(out.buffer);
    const es = Math.floor(Math.log2(n)), sr = 2 ** es * 16;
    dv.setUint32(0, version); dv.setUint16(4, n); dv.setUint16(6, sr); dv.setUint16(8, es); dv.setUint16(10, n * 16 - sr);
    tags.forEach((t, i) => {
      const o = 12 + i * 16;
      for (let k = 0; k < 4; k++) out[o + k] = t.charCodeAt(k);
      dv.setUint32(o + 4, checksum(tables[t])); dv.setUint32(o + 8, offsets[i]); dv.setUint32(o + 12, tables[t].length);
      out.set(tables[t], offsets[i]);
    });
    if (tables.head) {
      const headOff = offsets[tags.indexOf('head')];
      dv.setUint32(headOff + 8, 0);
      dv.setUint32(headOff + 8, (0xb1b0afba - checksum(out)) >>> 0);
    }
    return out;
  }

  /* ------------------------------------------------------------- full parse */
  function readCmap(b, t) {
    const dv = view(b), map = new Map();
    const n = dv.getUint16(t.off + 2);
    let pick = null, pickScore = -1;
    for (let i = 0; i < n; i++) {
      const r = t.off + 4 + i * 8, pid = dv.getUint16(r), eid = dv.getUint16(r + 2), sub = t.off + dv.getUint32(r + 4);
      const fmt = dv.getUint16(sub);
      const score = (pid === 3 && eid === 10 && fmt === 12) ? 5 : (pid === 0 && fmt === 12) ? 4 : (pid === 3 && eid === 1 && fmt === 4) ? 3 : (pid === 0 && fmt === 4) ? 2 : (pid === 3 && eid === 0) ? 1 : 0;
      if (score > pickScore) { pickScore = score; pick = sub; }
    }
    if (pick == null) return map;
    const fmt = dv.getUint16(pick);
    if (fmt === 4) {
      const segX2 = dv.getUint16(pick + 6), ends = pick + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
      for (let s = 0; s < segX2 / 2; s++) {
        const end = dv.getUint16(ends + s * 2), start = dv.getUint16(starts + s * 2), delta = dv.getInt16(deltas + s * 2), ro = dv.getUint16(ranges + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let g;
          if (!ro) g = (c + delta) & 0xffff;
          else { const go = ranges + s * 2 + ro + (c - start) * 2; g = dv.getUint16(go); if (g) g = (g + delta) & 0xffff; }
          if (g) map.set(c, g);
        }
      }
    } else if (fmt === 12) {
      const groups = dv.getUint32(pick + 12);
      for (let i = 0; i < groups; i++) {
        const o = pick + 16 + i * 12, s = dv.getUint32(o), e = dv.getUint32(o + 4), g = dv.getUint32(o + 8);
        for (let c = s; c <= e && c - s < 70000; c++) map.set(c, g + (c - s));
      }
    } else if (fmt === 0) {
      for (let c = 0; c < 256; c++) { const g = b[pick + 6 + c]; if (g) map.set(c, g); }
    }
    return map;
  }
  /** Full parse of a standalone font file (use extractFace first for .ttc). */
  function parse(b) {
    const tables = tableDir(b, 0), dv = view(b);
    const head = tables.head.off, hhea = tables.hhea.off;
    const upm = dv.getUint16(head + 18);
    let asc = dv.getInt16(hhea + 4), desc = -dv.getInt16(hhea + 6), gap = dv.getInt16(hhea + 8);
    let capHeight = Math.round(upm * 0.7), xHeight = Math.round(upm * 0.5);
    if (tables['OS/2']) {
      const o = tables['OS/2'].off, ver = dv.getUint16(o), fs = dv.getUint16(o + 62);
      if (fs & 128) { asc = dv.getInt16(o + 68); desc = -dv.getInt16(o + 70); gap = dv.getInt16(o + 72); }
      else { // Windows (and Chrome on Windows) use usWin metrics for line layout
        const wa = dv.getUint16(o + 74), wd = dv.getUint16(o + 76);
        if (wa && wd) { asc = wa; desc = wd; gap = 0; }
      }
      if (ver >= 2 && tables['OS/2'].len >= 90) { xHeight = dv.getInt16(o + 86) || xHeight; capHeight = dv.getInt16(o + 88) || capHeight; }
    }
    let italicAngle = 0;
    if (tables.post) italicAngle = dv.getInt32(tables.post.off + 4) / 65536;
    let cmap = null;
    const f = {
      b, dv, tables, upm, asc, desc, gap, capHeight, xHeight, italicAngle,
      bbox: [dv.getInt16(head + 36), dv.getInt16(head + 38), dv.getInt16(head + 40), dv.getInt16(head + 42)],
      longLoca: dv.getInt16(head + 50) === 1,
      numGlyphs: dv.getUint16(tables.maxp.off + 4),
      numH: dv.getUint16(hhea + 34),
      cff: !!tables['CFF '] && !tables.glyf,
      names: readNames(b, tables), style: readStyle(b, tables),
      get cmap() { return cmap || (cmap = readCmap(b, tables.cmap)); },
      glyph(cp) { return this.cmap.get(cp) || 0; },
      advance(g) { return dv.getUint16(tables.hmtx.off + Math.min(g, this.numH - 1) * 4); },
      covers(text) { for (const ch of text) { const c = ch.codePointAt(0); if (c > 31 && !this.cmap.get(c) && c !== 0xa0) return false; } return true; },
    };
    return f;
  }

  function loca(f, g) {
    const o = f.tables.loca.off;
    return f.longLoca ? [f.dv.getUint32(o + g * 4), f.dv.getUint32(o + g * 4 + 4)]
                      : [f.dv.getUint16(o + g * 2) * 2, f.dv.getUint16(o + g * 2 + 2) * 2];
  }
  /** TrueType subset that keeps glyph ids (unused glyphs emptied, composite parts kept). */
  function subsetGlyf(f, used) {
    const glyf = f.tables.glyf.off, dv = f.dv;
    const keep = new Set([0, ...used]), queue = [...keep];
    while (queue.length) {
      const g = queue.pop(); if (g >= f.numGlyphs) continue;
      const [s, e] = loca(f, g);
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
    const head = copy('head'); new DataView(head.buffer).setInt16(50, 1);
    const out = { head, hhea: copy('hhea'), maxp: copy('maxp'), hmtx: copy('hmtx'), loca: locaBytes, glyf: glyfOut };
    for (const t of ['OS/2', 'name', 'post', 'cvt ', 'fpgm', 'prep', 'cmap']) if (f.tables[t]) out[t] = copy(t);
    return writeFont(out);
  }

  /** Embeds a parsed font into a pdf-lib document. Call gids() for all text first, then finish(), then draw(). */
  function makeEmbedder(PDFLib, pdfDoc, f, label) {
    const P = PDFLib, used = new Map();
    let ref = null, missing = false;
    const qm = f.glyph(0x3f);
    function gids(text) {
      const out = [];
      for (const ch of text.replace(/\t/g, ' ')) {
        const cp = ch.codePointAt(0);
        let g = f.glyph(cp === 0xa0 ? 0x20 : cp);
        if (!g) { g = qm; missing = true; }
        out.push(g); if (!used.has(g)) used.set(g, g === qm && ch !== '?' ? '?' : ch);
      }
      return out;
    }
    function finish() {
      if (!used.size) return null;
      const ctx = pdfDoc.context, k = 1000 / f.upm;
      const tag = Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
      const base = (f.names.ps || label || 'Font').replace(/[^A-Za-z0-9\-]/g, '').slice(0, 60) || 'Font';
      const name = `${tag}+${base}`;
      let fontFile, descKey, cidSub;
      if (f.cff) {
        fontFile = ctx.register(ctx.flateStream(f.b, { Subtype: 'OpenType' }));
        descKey = 'FontFile3'; cidSub = 'CIDFontType0';
      } else {
        const bytes = subsetGlyf(f, used.keys());
        fontFile = ctx.register(ctx.flateStream(bytes, { Length1: bytes.length }));
        descKey = 'FontFile2'; cidSub = 'CIDFontType2';
      }
      let flags = 32; // nonsymbolic
      if (f.italicAngle) flags |= 64;
      if (/serif/i.test(f.names.family) && !/sans/i.test(f.names.family)) flags |= 2;
      const descriptor = ctx.register(ctx.obj({
        Type: 'FontDescriptor', FontName: name, Flags: flags,
        FontBBox: f.bbox.map(v => Math.round(v * k)), ItalicAngle: f.italicAngle,
        Ascent: Math.round(f.asc * k), Descent: -Math.round(f.desc * k), CapHeight: Math.round(f.capHeight * k),
        StemV: f.style.bold ? 140 : 80, [descKey]: fontFile,
      }));
      const sorted = [...used.keys()].sort((a, b) => a - b), W = [];
      for (const g of sorted) W.push(g, [Math.round(f.advance(g) * k)]);
      const cidObj = {
        Type: 'Font', Subtype: cidSub, BaseFont: name,
        CIDSystemInfo: { Registry: P.PDFString.of('Adobe'), Ordering: P.PDFString.of('Identity'), Supplement: 0 },
        FontDescriptor: descriptor, DW: 1000, W,
      };
      if (!f.cff) cidObj.CIDToGIDMap = 'Identity';
      const cid = ctx.register(ctx.obj(cidObj));
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
    const pageKeys = new Map();
    function draw(page, glyphIds, { x, y, size, color, rotate }) {
      let key = pageKeys.get(page);
      if (!key) { key = page.node.newFontDictionary('F', ref); pageKeys.set(page, key); }
      const hex = glyphIds.map(g => g.toString(16).padStart(4, '0')).join('');
      page.pushOperators(...P.drawText(P.PDFHexString.of(hex), { x, y, size, color, rotate, xSkew: P.degrees(0), ySkew: P.degrees(0), font: key }));
    }
    return { gids, finish, draw, get missing() { return missing; } };
  }

  /** Normalised key for comparing font names ("Arial-BoldMT", "Arial,Bold" and "Arial Bold" all match). */
  function nameKey(s) {
    return String(s || '').replace(/^[A-Z]{6}\+/, '').toLowerCase()
      .replace(/(ps)?mt$/, '').replace(/[\s,\-_]+/g, '').replace(/regular$/, '');
  }
  return { faceOffsets, tableDir, readNames, describe, extractFace, parse, subsetGlyf, writeFont, makeEmbedder, nameKey };
});
