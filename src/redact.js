/* Removes original text and pictures from a page's content stream where the user has replaced them
   (Edit tool), so the old wording can't be copied, searched or recovered from the saved PDF.
   Works on the page's own content streams; anything it can't place stays hidden under the cover. */
'use strict';
window.PDFStudioRedact = (() => {
  const P = () => window.PDFLib;
  const WS = new Set([0, 9, 10, 12, 13, 32]);
  const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);
  const mul = (m1, m2) => [ // apply m2 first, then m1 (same as pdf.js Util.transform)
    m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5]];
  const ID = [1, 0, 0, 1, 0, 0];

  /** Splits a content stream into operations: {op, args, start, end} (byte offsets). */
  function tokenize(b) {
    const ops = []; let i = 0, n = b.length, args = [], argStart = -1;
    const skipWs = () => { for (;;) { while (i < n && WS.has(b[i])) i++; if (b[i] === 37) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; } else break; } };
    const readToken = () => { // returns a JS value for operands, or {op} for operators
      const c = b[i];
      if (c === 40) { // literal string
        let depth = 0; const s = i; const out = [];
        for (; i < n; i++) {
          const ch = b[i];
          if (ch === 92) { i++; out.push(b[i]); continue; }
          if (ch === 40) { depth++; if (depth === 1) continue; }
          if (ch === 41) { depth--; if (depth === 0) { i++; break; } }
          out.push(ch);
        }
        return { str: true, s };
      }
      if (c === 60 && b[i + 1] === 60) { // dictionary
        i += 2; const d = {}; let key = null;
        for (;;) { skipWs(); if (i >= n) break; if (b[i] === 62 && b[i + 1] === 62) { i += 2; break; } const v = readToken(); if (key == null) key = v; else { d[key] = v; key = null; } }
        return d;
      }
      if (c === 60) { while (i < n && b[i] !== 62) i++; i++; return { str: true }; } // hex string
      if (c === 91) { i++; const arr = []; for (;;) { skipWs(); if (i >= n) break; if (b[i] === 93) { i++; break; } arr.push(readToken()); } return arr; }
      if (c === 47) { const s = ++i; while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) i++; return '/' + String.fromCharCode(...b.subarray(s, i)); }
      const s = i;
      while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) i++;
      if (i === s) { i++; return null; } // stray delimiter
      const t = String.fromCharCode(...b.subarray(s, i));
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return parseFloat(t);
      if (t === 'true' || t === 'false' || t === 'null') return t;
      return { op: t };
    };
    while (i < n) {
      skipWs(); if (i >= n) break;
      const s = i;
      const tok = readToken();
      if (tok && typeof tok === 'object' && 'op' in tok) {
        const start = argStart >= 0 ? argStart : s;
        if (tok.op === 'ID') { // inline image data: skip to EI
          i++;
          while (i < n && !(WS.has(b[i - 1]) && b[i] === 69 && b[i + 1] === 73 && (i + 2 >= n || WS.has(b[i + 2]) || DELIM.has(b[i + 2])))) i++;
          i += 2;
          const prev = ops[ops.length - 1];
          if (prev && prev.op === 'BI') { prev.op = 'INLINE'; prev.end = i; } else ops.push({ op: 'INLINE', args, start, end: i });
        } else ops.push({ op: tok.op, args, start, end: i });
        args = []; argStart = -1;
      } else { if (argStart < 0) argStart = s; args.push(tok); }
    }
    return ops;
  }

  function inside(x, y, boxes, tol = 1) {
    return boxes.some(r => x >= r.x0 - tol && x <= r.x1 + tol && y >= r.y0 - tol && y <= r.y1 + tol);
  }

  /** Returns a list of [start,end) ranges to delete, and how many items were removed. */
  function findRemovals(bytes, boxes, isImageXObject) {
    const ops = tokenize(bytes);
    let ctm = ID, tm = ID, tlm = ID, leading = 0; const stack = [];
    const del = []; let removed = 0;
    const textOrigin = () => { const m = mul(ctm, tm); return [m[4], m[5]]; };
    const unitCenter = () => [ctm[0] * 0.5 + ctm[2] * 0.5 + ctm[4], ctm[1] * 0.5 + ctm[3] * 0.5 + ctm[5]];
    for (const o of ops) {
      const a = o.args;
      switch (o.op) {
        case 'q': stack.push(ctm); break;
        case 'Q': ctm = stack.pop() || ID; break;
        case 'cm': if (a.length === 6) ctm = mul(ctm, a); break;
        case 'BT': tm = tlm = ID; break;
        case 'Tm': if (a.length === 6) tm = tlm = a; break;
        case 'Td': tlm = mul(tlm, [1, 0, 0, 1, a[0] || 0, a[1] || 0]); tm = tlm; break;
        case 'TD': leading = -(a[1] || 0); tlm = mul(tlm, [1, 0, 0, 1, a[0] || 0, a[1] || 0]); tm = tlm; break;
        case 'TL': leading = a[0] || 0; break;
        case 'T*': tlm = mul(tlm, [1, 0, 0, 1, 0, -leading]); tm = tlm; break;
        case "'": case '"':
          tlm = mul(tlm, [1, 0, 0, 1, 0, -leading]); tm = tlm; // falls through to show
        case 'Tj': case 'TJ': {
          const [x, y] = textOrigin();
          if (inside(x, y, boxes)) { del.push([o.start, o.end, o.op]); removed++; }
          break;
        }
        case 'Do': {
          if (typeof a[0] === 'string' && isImageXObject(a[0].slice(1))) {
            const [x, y] = unitCenter();
            if (inside(x, y, boxes, 0)) { del.push([o.start, o.end]); removed++; }
          }
          break;
        }
        case 'INLINE': case 'BI': {
          const [x, y] = unitCenter();
          if (inside(x, y, boxes, 0)) { del.push([o.start, o.end]); removed++; }
          break;
        }
      }
    }
    return { del, removed };
  }

  /** pdfDoc/page: pdf-lib objects. boxes: [{x0,y0,x1,y1}] in PDF user space. */
  function removeCovered(pdfDoc, page, boxes) {
    const L = P(), ctx = pdfDoc.context, node = page.node;
    const contents = node.Contents();
    if (!contents || !boxes.length) return 0;
    const streams = contents instanceof L.PDFArray ? contents.asArray().map(r => ctx.lookup(r)) : [contents];
    const parts = [];
    for (const s of streams) {
      if (!(s instanceof L.PDFRawStream)) return 0; // already-built streams: leave untouched
      parts.push(L.decodePDFRawStream(s).decode());
    }
    const total = parts.reduce((t, p) => t + p.length + 1, 0), bytes = new Uint8Array(total);
    let off = 0; for (const p of parts) { bytes.set(p, off); off += p.length; bytes[off++] = 10; }
    const res = node.Resources(), xobjs = res && res.lookup(L.PDFName.of('XObject'));
    const isImage = name => {
      try { const x = xobjs && xobjs.lookup(L.PDFName.of(name)); return !!x && String(x.dict.get(L.PDFName.of('Subtype'))) === '/Image'; } catch { return false; }
    };
    const { del, removed } = findRemovals(bytes, boxes, isImage);
    if (!removed) return 0;
    const chunks = []; let pos = 0;
    for (const [s, e, op] of del) {
      chunks.push(bytes.subarray(pos, s));
      // a ' or " also moves to the next line; keep that movement
      if (op === "'" || op === '"') chunks.push(new TextEncoder().encode(' T* '));
      else chunks.push(new Uint8Array([32]));
      pos = e;
    }
    chunks.push(bytes.subarray(pos));
    const out = new Uint8Array(chunks.reduce((t, c) => t + c.length, 0));
    off = 0; for (const c of chunks) { out.set(c, off); off += c.length; }
    node.set(L.PDFName.of('Contents'), ctx.register(ctx.flateStream(out)));
    return removed;
  }
  return { removeCovered, tokenize };
})();
