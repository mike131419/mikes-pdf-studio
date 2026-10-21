/* Mike's PDF Studio — offline PDF viewer/editor. Uses PDF.js (rendering) and pdf-lib (writing). */
'use strict';
(() => {
const $ = (s, el = document) => el.querySelector(s);
window.addEventListener('error', e => console.error('[uncaught]', e.message, e.filename ? `${e.filename.split('/').pop()}:${e.lineno}` : ''));
window.addEventListener('unhandledrejection', e => console.error('[unhandled promise]', e.reason && (e.reason.stack || e.reason.message || e.reason)));
const diag = (...a) => console.log('[diag]', ...a);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const PDFLib = window.PDFLib;
let pdfjsLib = null;

/* ---------------------------------------------------------------- utils */
function b64ToBytes(b64) {
  const bin = atob(b64), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
let uidCounter = 1;
const newId = () => 'i' + (uidCounter++).toString(36) + Math.random().toString(36).slice(2, 6);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ROT = r => ((r % 360) + 360) % 360;
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '#000000');
  const n = m ? parseInt(m[1], 16) : 0;
  return PDFLib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
let toastTimer;
function toast(msg, isErr = false, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg; t.classList.toggle('err', isErr); t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
function status(msg) { $('#statusMsg').textContent = msg; }
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};

/* --------------------------------------------------------- PDF.js setup */
class EmbeddedDataFactory {
  constructor() {}
  async fetch({ kind, filename }) {
    const dir = kind === 'cMapUrl' ? 'cmaps/' : kind === 'standardFontDataUrl' ? 'standard_fonts/' : 'wasm/';
    const b64 = (window.__ASSETS || {})[dir + filename];
    if (!b64) throw new Error('Missing built-in data: ' + dir + filename);
    return b64ToBytes(b64);
  }
}
async function initPdfjs() {
  const dec = s => new TextDecoder().decode(b64ToBytes(s));
  const libUrl = URL.createObjectURL(new Blob([dec(window.__PDFJS_B64)], { type: 'text/javascript' }));
  const workerUrl = URL.createObjectURL(new Blob([dec(window.__WORKER_B64)], { type: 'text/javascript' }));
  window.__PDFJS_B64 = window.__WORKER_B64 = null;
  pdfjsLib = await import(libUrl);
  try { pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(workerUrl); }
  catch (e) { console.warn('Worker unavailable, running in main thread', e); pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl; }
}
function loadPdfjsDoc(bytes, password) {
  return pdfjsLib.getDocument({
    data: bytes.slice(), password,
    cMapUrl: 'cmaps/', cMapPacked: true, standardFontDataUrl: 'standard_fonts/', wasmUrl: 'wasm/',
    useWorkerFetch: false, BinaryDataFactory: EmbeddedDataFactory,
    isEvalSupported: false, enableXfa: false,
  }).promise;
}

/* ---------------------------------------------------------------- state */
const state = {
  sources: new Map(),   // id -> {id, name, bytes, doc (pdf.js), encrypted}
  pages: [],            // {key, srcId, idx, baseRot, rot, vw, vh, annots: []}
  images: new Map(),    // id -> {dataUrl, w, h}
  zoom: 1, tool: 'select',
  selPages: new Set(), anchorKey: null, currentKey: null,
  selAnnot: null,       // {key, id}
  docName: null, saveHandle: null, dirty: false,
  undo: [], redo: [],
  pendingImg: null,
  textDefaults: { font: 'sans', bold: false, italic: false },
  thumbW: 120, thumbBig: 220,
  ocrResults: new Map(), // OCR text per page+rotation (kept across undo)
};
const pageCache = new Map(); // `${srcId}:${idx}` -> Promise<PDFPageProxy>
function getPdfPage(p) {
  const k = p.srcId + ':' + p.idx;
  if (!pageCache.has(k)) pageCache.set(k, state.sources.get(p.srcId).doc.getPage(p.idx + 1));
  return pageCache.get(k);
}
const pageByKey = k => state.pages.find(p => p.key === k);
const totalRot = p => ROT(p.baseRot + p.rot);
function dispDims(p) { // size in points as displayed (rotation applied)
  const r = totalRot(p);
  return r % 180 ? { W: p.vh, H: p.vw } : { W: p.vw, H: p.vh };
}
function setDirty(d = true) {
  state.dirty = d;
  document.title = (state.docName ? state.docName + (d ? ' •' : '') + ' — ' : '') + "Mike's PDF Studio";
}

/* ----------------------------------------------------------------- undo */
const snapshot = () => JSON.stringify(state.pages);
function pushUndo(snap = snapshot()) {
  state.undo.push(snap); if (state.undo.length > 150) state.undo.shift();
  state.redo.length = 0; updateButtons();
}
function restore(snap) {
  state.pages = JSON.parse(snap);
  state.selAnnot = null;
  const keys = new Set(state.pages.map(p => p.key));
  state.selPages = new Set([...state.selPages].filter(k => keys.has(k)));
  rebuildAll(); setDirty(true); updateButtons();
}
function undo() { if (!state.undo.length) return; commitEditing(); state.redo.push(snapshot()); restore(state.undo.pop()); }
function redo() { if (!state.redo.length) return; commitEditing(); state.undo.push(snapshot()); restore(state.redo.pop()); }

/* ---------------------------------------------------------- open / merge */
async function readFile(file) {
  if (file.arrayBuffer) return new Uint8Array(await file.arrayBuffer());
  return new Uint8Array(await new Response(file).arrayBuffer());
}
async function addSource(name, bytes) {
  let doc, password;
  for (;;) {
    try { doc = await loadPdfjsDoc(bytes, password); break; }
    catch (e) {
      if (e && e.name === 'PasswordException') {
        password = prompt(`"${name}" is password-protected.${password ? ' That password was wrong.' : ''}\nEnter the password:`);
        if (password == null) return null;
      } else throw e;
    }
  }
  const id = newId();
  const src = { id, name, bytes, doc, encrypted: !!password };
  if (!password) {
    // detect owner-password (permission) encryption too
    try { const ld = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false }); src.encrypted = ld.isEncrypted; src.libDoc = ld; }
    catch { src.libDocError = true; }
  }
  state.sources.set(id, src);
  const pages = [];
  for (let i = 0; i < doc.numPages; i++) {
    const pg = await doc.getPage(i + 1);
    pageCache.set(id + ':' + i, Promise.resolve(pg));
    const [x1, y1, x2, y2] = pg.view;
    pages.push({ key: newId(), srcId: id, idx: i, baseRot: ROT(pg.rotate), rot: 0, vw: x2 - x1, vh: y2 - y1, annots: [] });
  }
  return pages;
}
async function openFiles(files, append) {
  files = [...files].filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (!files.length) { toast('Please choose PDF files.', true); return; }
  if (!append && state.pages.length && state.dirty && !confirm('You have unsaved changes. Open anyway and discard them?')) return;
  commitEditing();
  status('Opening…');
  const added = [];
  let failed = [];
  for (const f of files) {
    try {
      const pages = await addSource(f.name, await readFile(f));
      if (pages) added.push({ name: f.name, pages });
    } catch (e) { console.error(e); failed.push(f.name); }
  }
  if (failed.length) toast(`Couldn't open: ${failed.join(', ')} (file may be damaged or not a PDF)`, true, 5000);
  if (!added.length) { status('Ready'); return; }
  const newPages = added.flatMap(a => a.pages);
  if (!append || !state.pages.length) {
    state.pages = newPages; state.undo = []; state.redo = [];
    state.docName = added.length === 1 ? added[0].name : 'Merged.pdf';
    state.saveHandle = null; state.selPages.clear(); state.selAnnot = null;
    state.zoom = 0; // fit on first layout
    setDirty(added.length > 1);
    if (added.length > 1) toast(`Merged ${added.length} files into one document. Drag pages in the sidebar to reorder.`);
  } else {
    pushUndo();
    const insertAt = state.pages.length;
    state.pages.push(...newPages);
    setDirty(true);
    toast(`Added ${newPages.length} page${newPages.length > 1 ? 's' : ''} from ${added.map(a => a.name).join(', ')}`);
    state.currentKey = state.pages[insertAt].key;
  }
  rebuildAll();
  if (append) scrollToKey(state.currentKey);
  status(`${state.pages.length} pages`);
  updateButtons();
  pruneSources();
}
function pruneSources() {
  // keep sources referenced by current pages or by undo/redo history
  const used = new Set(state.pages.map(p => p.srcId));
  for (const s of [...state.undo, ...state.redo]) for (const m of s.matchAll(/"srcId":"([^"]+)"/g)) used.add(m[1]);
  for (const id of [...state.sources.keys()]) if (!used.has(id)) {
    state.sources.get(id).doc.destroy?.(); state.sources.delete(id);
    for (const k of [...pageCache.keys()]) if (k.startsWith(id + ':')) pageCache.delete(k);
  }
}

/* --------------------------------------------------------------- render */
const view = $('#view');
let renderSeq = 0;
const pageObserver = new IntersectionObserver(entries => {
  for (const e of entries) if (e.isIntersecting) renderPageCanvas(e.target);
}, { root: view, rootMargin: '600px 0px' });
const thumbObserver = new IntersectionObserver(entries => {
  for (const e of entries) if (e.isIntersecting) renderThumb(e.target);
}, { root: $('#thumbs'), rootMargin: '400px 0px' });

function fitWidthZoom() {
  const maxW = Math.max(...state.pages.map(p => dispDims(p).W), 1);
  return clamp((view.clientWidth - 80) / maxW, 0.25, 3);
}
function rebuildAll() { buildView(); buildThumbs(); updatePageNav(); }

function buildView() {
  $('#empty').classList.toggle('hidden', !!state.pages.length);
  const ratio = view.scrollHeight ? view.scrollTop / view.scrollHeight : 0;
  pageObserver.disconnect();
  view.innerHTML = '';
  if (!state.pages.length) { updateZoomLabel(); return; }
  if (!state.zoom) state.zoom = Math.min(fitWidthZoom(), 1);
  const z = state.zoom; renderSeq++;
  state.pages.forEach((p, i) => {
    const { W, H } = dispDims(p);
    const el = document.createElement('div');
    el.className = 'page'; el.dataset.key = p.key;
    el.style.width = W * z + 'px'; el.style.height = H * z + 'px';
    el.innerHTML = `<canvas></canvas><div class="coverlayer"></div><div class="editlayer"></div><div class="layer"></div><div class="pnum">${i + 1}</div>`;
    view.appendChild(el);
    renderAnnots(p, el);
    pageObserver.observe(el);
  });
  view.scrollTop = ratio * view.scrollHeight;
  updateZoomLabel();
}
async function renderPageCanvas(el) {
  const p = pageByKey(el.dataset.key); if (!p) return;
  const sig = `${renderSeq}|${state.zoom}|${totalRot(p)}`;
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  if (state.tool === 'edit') renderEditLayer(p, el);
  const pg = await getPdfPage(p);
  if (!el.isConnected) return;
  const dpr = window.devicePixelRatio || 1;
  const vp = pg.getViewport({ scale: state.zoom, rotation: totalRot(p) });
  let s = dpr; const maxPx = 16e6;
  if (vp.width * vp.height * s * s > maxPx) s = Math.sqrt(maxPx / (vp.width * vp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width * s); canvas.height = Math.floor(vp.height * s);
  const ctx = canvas.getContext('2d');
  try {
    await pg.render({ canvasContext: ctx, canvas, viewport: vp, transform: s !== 1 ? [s, 0, 0, s, 0, 0] : null }).promise;
  } catch (e) { if (e?.name !== 'RenderingCancelledException') console.error(e); return; }
  if (!el.isConnected || el.dataset.sig !== sig) return;
  el.querySelector('canvas').replaceWith(canvas);
}

/* ------------------------------------------------------------ thumbnails */
const organizing = () => document.body.classList.contains('organize');
const thumbW = () => organizing() ? state.thumbBig : state.thumbW;
function applyThumbSize(rebuild = true) {
  document.body.style.setProperty('--thumbw', thumbW() + 'px');
  document.body.style.setProperty('--sidew', Math.min(state.thumbW + 76, 480) + 'px');
  $('#thumbSize').value = thumbW();
  if (rebuild) { buildThumbs(); if (!organizing()) { clearTimeout(applyThumbSize.t); applyThumbSize.t = setTimeout(() => state.pages.length && buildView(), 150); } }
}
function setThumbSize(v) {
  v = clamp(Math.round(v), 70, 420);
  if (organizing()) state.thumbBig = v; else state.thumbW = Math.min(v, 300);
  store.set('pdfstudio.thumbSizes', [state.thumbW, state.thumbBig]);
  applyThumbSize();
}
function setOrganize(on) {
  if (on === organizing()) return;
  if (on && !state.pages.length) { toast('Open a PDF first.'); return; }
  commitEditing();
  document.body.classList.toggle('organize', on);
  $('#btnOrganize').classList.toggle('on', on);
  applyThumbSize();
  if (!on && state.currentKey) setTimeout(() => scrollToKey(state.currentKey), 50);
  else if (on && state.currentKey) setTimeout(() => $(`.thumb[data-key="${state.currentKey}"]`)?.scrollIntoView({ block: 'center' }), 50);
}
$('#btnOrganize').onclick = () => setOrganize(!organizing());
$('#btnOrganizeDone').onclick = () => setOrganize(false);
$('#thumbSize').addEventListener('input', e => setThumbSize(+e.target.value));
$('#thumbs').addEventListener('wheel', e => { if (e.ctrlKey) { e.preventDefault(); setThumbSize(thumbW() * (e.deltaY < 0 ? 1.12 : 1 / 1.12)); } }, { passive: false });
$('#thumbs').addEventListener('dblclick', e => {
  const t = e.target.closest('.thumb'); if (!t || !organizing()) return;
  state.currentKey = t.dataset.key; setOrganize(false);
});
function buildThumbs() {
  const box = $('#thumbs');
  thumbObserver.disconnect();
  box.innerHTML = '';
  state.pages.forEach((p, i) => {
    const { W, H } = dispDims(p);
    const s = thumbW() / Math.max(W, H * 0.77);
    const t = document.createElement('div');
    t.className = 'thumb'; t.draggable = true; t.dataset.key = p.key;
    t.classList.toggle('selected', state.selPages.has(p.key));
    t.classList.toggle('current', state.currentKey === p.key);
    t.innerHTML = `<div class="tframe"><canvas style="width:${Math.round(W * s)}px;height:${Math.round(H * s)}px"></canvas></div><div class="tnum">${i + 1}</div>`;
    box.appendChild(t);
    thumbObserver.observe(t);
  });
}
async function renderThumb(t) {
  const p = pageByKey(t.dataset.key); if (!p) return;
  const sig = `${totalRot(p)}|${JSON.stringify(p.annots)}`;
  if (t.dataset.sig === sig) return;
  t.dataset.sig = sig;
  const pg = await getPdfPage(p);
  const { W } = dispDims(p);
  const cssW = parseFloat(t.querySelector('canvas').style.width);
  const scale = cssW / W, dpr = window.devicePixelRatio || 1;
  const vp = pg.getViewport({ scale: scale * dpr, rotation: totalRot(p) });
  const c = document.createElement('canvas');
  c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  c.style.cssText = t.querySelector('canvas').style.cssText;
  const ctx = c.getContext('2d');
  try { await pg.render({ canvasContext: ctx, canvas: c, viewport: vp }).promise; } catch { return; }
  drawAnnotsOnCanvas(ctx, p, scale * dpr);
  if (t.isConnected && t.dataset.sig === sig) t.querySelector('canvas').replaceWith(c);
}
const imgEls = new Map();
function imgEl(id) {
  if (!imgEls.has(id)) { const im = new Image(); im.src = state.images.get(id).dataUrl; imgEls.set(id, im); }
  return imgEls.get(id);
}
function drawAnnotsOnCanvas(ctx, p, s) {
  for (const a of p.annots) if (a.cover) { ctx.fillStyle = a.cover.color; ctx.fillRect(a.cover.x * s, a.cover.y * s, a.cover.w * s, a.cover.h * s); }
  for (const a of p.annots) {
    if (a.type === 'rect') {
      ctx.save(); ctx.globalAlpha = a.opacity; if (a.kind === 'highlight') ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = a.color; ctx.fillRect(a.x * s, a.y * s, a.w * s, a.h * s); ctx.restore();
    } else if (a.type === 'image') {
      const im = imgEl(a.imgId); if (im.complete) ctx.drawImage(im, a.x * s, a.y * s, a.w * s, a.h * s);
    } else if (a.type === 'text') {
      ctx.fillStyle = a.color; ctx.font = cssFont(a, a.size * s); ctx.fontKerning = 'none';
      const bl = baselineOf(a), lh = lhOf(a);
      linesOf(a).forEach((ln, i) => ctx.fillText(ln, a.x * s, (a.y + a.size * (bl + lh * i)) * s));
    }
  }
}
function refreshThumb(key) {
  const t = $(`.thumb[data-key="${key}"]`); if (t) { t.dataset.sig = ''; renderThumb(t); }
}
let thumbTimer;
function refreshThumbSoon(key) { clearTimeout(thumbTimer); thumbTimer = setTimeout(() => refreshThumb(key), 250); }

/* ------------------------------------------------------- page selection */
function setSelection(keys, anchor) {
  state.selPages = new Set(keys);
  if (anchor !== undefined) state.anchorKey = anchor;
  $$('.thumb').forEach(t => t.classList.toggle('selected', state.selPages.has(t.dataset.key)));
  updateButtons();
}
function targetKeys() { // selected pages, or the current page
  if (state.selPages.size) return state.pages.filter(p => state.selPages.has(p.key)).map(p => p.key);
  return state.currentKey ? [state.currentKey] : [];
}
$('#thumbs').addEventListener('click', e => {
  const t = e.target.closest('.thumb'); if (!t) return;
  const k = t.dataset.key;
  if (e.shiftKey && state.anchorKey) {
    const a = state.pages.findIndex(p => p.key === state.anchorKey), b = state.pages.findIndex(p => p.key === k);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    setSelection(state.pages.slice(lo, hi + 1).map(p => p.key));
  } else if (e.ctrlKey || e.metaKey) {
    const s = new Set(state.selPages); s.has(k) ? s.delete(k) : s.add(k); setSelection(s, k);
  } else setSelection([k], k);
  scrollToKey(k);
});

/* drag-to-reorder */
let dragKeys = null;
$('#thumbs').addEventListener('dragstart', e => {
  const t = e.target.closest('.thumb'); if (!t) return;
  const k = t.dataset.key;
  if (!state.selPages.has(k)) setSelection([k], k);
  dragKeys = state.pages.filter(p => state.selPages.has(p.key)).map(p => p.key);
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/x-pdfstudio-pages', dragKeys.join(','));
  requestAnimationFrame(() => dragKeys?.forEach(k2 => $(`.thumb[data-key="${k2}"]`)?.classList.add('dragging')));
});
function clearDropMarks() { $$('.thumb.drop-before,.thumb.drop-after').forEach(t => t.classList.remove('drop-before', 'drop-after')); }
$('#thumbs').addEventListener('dragover', e => {
  if (!dragKeys) return;
  e.preventDefault(); e.stopPropagation();
  clearDropMarks();
  const t = e.target.closest('.thumb');
  if (t) {
    const r = t.getBoundingClientRect();
    const before = organizing() ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2;
    t.classList.add(before ? 'drop-before' : 'drop-after');
  }
  else { const last = $$('.thumb').pop(); last?.classList.add('drop-after'); }
});
$('#thumbs').addEventListener('drop', e => {
  if (!dragKeys) return;
  e.preventDefault(); e.stopPropagation();
  const mark = $('.thumb.drop-before,.thumb.drop-after');
  const before = !!mark?.classList.contains('drop-before');
  clearDropMarks();
  if (!mark) return;
  const moving = new Set(dragKeys);
  const targetKey = mark.dataset.key;
  if (moving.has(targetKey)) return;
  pushUndo();
  const movedPages = state.pages.filter(p => moving.has(p.key));
  const rest = state.pages.filter(p => !moving.has(p.key));
  let at = rest.findIndex(p => p.key === targetKey) + (before ? 0 : 1);
  rest.splice(at, 0, ...movedPages);
  state.pages = rest;
  setDirty(); rebuildAll(); scrollToKey(movedPages[0].key);
  status(`Moved ${movedPages.length} page${movedPages.length > 1 ? 's' : ''}`);
});
$('#thumbs').addEventListener('dragend', () => { dragKeys = null; clearDropMarks(); $$('.thumb.dragging').forEach(t => t.classList.remove('dragging')); });

/* ------------------------------------------------------- page commands */
function rotatePages(delta) {
  const keys = targetKeys(); if (!keys.length) return;
  commitEditing(); pushUndo();
  for (const k of keys) {
    const p = pageByKey(k), { W, H } = dispDims(p);
    for (const a of p.annots) { // keep annotations attached to the same spot of the page
      const w = a.w || 0, h = a.h || 0;
      const cx = a.x + w / 2, cy = a.y + h / 2;
      const [nx, ny] = delta > 0 ? [H - cy, cx] : [cy, W - cx];
      a.x = nx - w / 2; a.y = ny - h / 2;
      if (a.cover) { // the hidden original turns with the page
        const c = a.cover, ccx = c.x + c.w / 2, ccy = c.y + c.h / 2;
        const [mx, my] = delta > 0 ? [H - ccy, ccx] : [ccy, W - ccx];
        Object.assign(c, { x: mx - c.h / 2, y: my - c.w / 2, w: c.h, h: c.w });
      }
    }
    p.rot = ROT(p.rot + delta);
  }
  setDirty(); rebuildAll(); scrollToKey(keys[0]);
}
function deletePages() {
  const keys = targetKeys(); if (!keys.length) return;
  if (keys.length === state.pages.length) { toast("A PDF needs at least one page — you can't delete them all.", true); return; }
  commitEditing(); pushUndo();
  const idx = state.pages.findIndex(p => p.key === keys[0]);
  const del = new Set(keys);
  state.pages = state.pages.filter(p => !del.has(p.key));
  state.selPages.clear(); state.selAnnot = null;
  state.currentKey = state.pages[Math.min(idx, state.pages.length - 1)].key;
  setDirty(); rebuildAll(); scrollToKey(state.currentKey);
  toast(`Deleted ${keys.length} page${keys.length > 1 ? 's' : ''}. Press Ctrl+Z to undo.`);
}
async function extractPages() {
  const keys = targetKeys(); if (!keys.length) return;
  commitEditing();
  const pages = state.pages.filter(p => keys.includes(p.key));
  const base = (state.docName || 'Document.pdf').replace(/\.pdf$/i, '');
  const name = pages.length === 1 ? `${base} - page ${state.pages.indexOf(pages[0]) + 1}.pdf` : `${base} - ${pages.length} pages.pdf`;
  const bytes = await buildPdf(pages); if (!bytes) return;
  const ok = await writeFile(bytes, name, null);
  if (ok) toast(`Saved ${pages.length} page${pages.length > 1 ? 's' : ''} as "${ok.name}"`);
}

/* ------------------------------------------------------------- navigate */
function scrollToKey(k) {
  const el = view.querySelector(`.page[data-key="${k}"]`); if (!el) return;
  view.scrollTop = el.offsetTop - 16;
  setCurrent(k);
}
function setCurrent(k) {
  if (state.currentKey === k) return;
  state.currentKey = k;
  $$('.thumb').forEach(t => t.classList.toggle('current', t.dataset.key === k));
  const t = $(`.thumb[data-key="${k}"]`);
  if (t) { const box = $('#thumbs'), r = t.getBoundingClientRect(), br = box.getBoundingClientRect(); if (r.top < br.top || r.bottom > br.bottom) t.scrollIntoView({ block: 'nearest' }); }
  updatePageNav();
}
function updatePageNav() {
  const i = state.pages.findIndex(p => p.key === state.currentKey);
  $('#pageInput').value = state.pages.length ? (i < 0 ? 1 : i + 1) : 0;
  $('#pageCount').textContent = '/ ' + state.pages.length;
  $('#docInfo').textContent = state.docName ? `${state.docName} · ${state.pages.length} page${state.pages.length === 1 ? '' : 's'}` : '';
}
view.addEventListener('scroll', () => {
  const mid = view.scrollTop + view.clientHeight * 0.35;
  let best = null;
  for (const el of view.children) { if (el.offsetTop <= mid) best = el; else break; }
  if (best) setCurrent(best.dataset.key);
}, { passive: true });
$('#pageInput').addEventListener('change', e => {
  const n = clamp(parseInt(e.target.value, 10) || 1, 1, state.pages.length);
  if (state.pages[n - 1]) scrollToKey(state.pages[n - 1].key);
});

/* ----------------------------------------------------------------- zoom */
function setZoom(z) {
  if (!state.pages.length) return;
  state.zoom = clamp(z, 0.25, 4); buildView();
}
function updateZoomLabel() { $('#zoomLabel').textContent = Math.round((state.zoom || 1) * 100) + '%'; }
$('#btnZoomIn').onclick = () => setZoom(state.zoom * 1.2);
$('#btnZoomOut').onclick = () => setZoom(state.zoom / 1.2);
$('#zoomLabel').onclick = () => setZoom(fitWidthZoom());
view.addEventListener('wheel', e => { if (e.ctrlKey) { e.preventDefault(); setZoom(state.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)); } }, { passive: false });
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.pages.length) buildView(); }, 200); });

/* ---------------------------------------------------------- text engine */
/* Text boxes are laid out by our own code (line breaks, baseline positions), and the same layout is
   used on screen, in thumbnails and in the saved PDF, so what you see is what gets saved.
   Screen fonts Arial / Times New Roman / Courier New are metric-compatible with the PDF standard
   fonts Helvetica / Times / Courier; text containing Chinese uses the built-in CJK font. */
const CJK = window.PDFStudioCJK;
const FONTS = {
  sans: { label: 'Sans (Arial)', css: 'Arial, "Liberation Sans", Helvetica, sans-serif', asc: 0.905, desc: 0.212, std: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'] },
  serif: { label: 'Serif (Times)', css: '"Times New Roman", "Liberation Serif", Times, serif', asc: 0.891, desc: 0.216, std: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'] },
  mono: { label: 'Mono (Courier)', css: '"Courier New", "Liberation Mono", Courier, monospace', asc: 0.833, desc: 0.300, std: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'] },
};
const CJK_FONT = { css: `"${CJK.FAMILY}", sans-serif`, asc: CJK.ASC, desc: CJK.DESC };
const PSF = window.PDFStudioFonts;
// The real font of an edited paragraph (the PDF's original font found on this PC), when it has every character typed
const realFont = a => { const r = a.fk && PSF.get(a.fk); return r && r.f.covers(a.text) ? r : null; };
const isCjk = a => !realFont(a) && CJK.needs(a.text);
const fontOf = a => realFont(a) || (isCjk(a) ? CJK_FONT : (FONTS[a.font] || FONTS.sans));
const lhOf = a => a.lh || 1.2;
function baselineOf(a) { const f = fontOf(a), lh = lhOf(a); return (lh - (f.asc + f.desc)) / 2 + f.asc; }
function cssFont(a, px) {
  const plain = isCjk(a) || !!realFont(a);
  return `${!plain && a.italic ? 'italic ' : ''}${!plain && a.bold ? 'bold ' : ''}${px}px ${fontOf(a).css}`;
}
const measureCtx = document.createElement('canvas').getContext('2d');
measureCtx.fontKerning = 'none'; // the PDF is written without kerning, so measure the same way
const CJK_CHAR = /[⺀-鿿豈-﫿＀-￯　-〿]/;
function layoutLines(a) {
  const paras = a.text.split('\n');
  if (!a.w) return paras;
  measureCtx.font = cssFont(a, 100);
  const k = a.size / 100, maxW = a.w;
  const width = s => measureCtx.measureText(s).width * k;
  const out = [];
  for (const para of paras) {
    const tokens = para.match(/[⺀-鿿豈-﫿＀-￯　-〿]|[^\s⺀-鿿豈-﫿＀-￯　-〿]+\s*|\s+/g) || [''];
    let line = '';
    for (const t of tokens) {
      const cand = line + t;
      if (line.trim() && width(cand.trimEnd()) > maxW) { out.push(line.trimEnd()); line = t.replace(/^\s+/, ''); }
      else line = cand;
      while (line.length > 1 && width(line.trimEnd()) > maxW) { // a single word wider than the box
        let i = line.length - 1;
        while (i > 1 && width(line.slice(0, i)) > maxW) i--;
        out.push(line.slice(0, i)); line = line.slice(i);
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}
function relayout(a) { if (a.type === 'text') a.lines = layoutLines(a); }
const linesOf = a => a.lines || layoutLines(a);
function styleTextBody(b, a) {
  const plain = isCjk(a) || !!realFont(a);
  Object.assign(b.style, {
    fontFamily: fontOf(a).css, fontSize: a.size * z() + 'px', lineHeight: String(lhOf(a)), color: a.color,
    fontWeight: !plain && a.bold ? 'bold' : 'normal', fontStyle: !plain && a.italic ? 'italic' : 'normal',
    width: a.w ? a.w * z() + 'px' : '',
  });
  if (plain && !CJK.loaded) CJK.load().then(() => { relayout(a); const p = state.pages.find(q => q.annots.includes(a)); if (p && !editing) renderAnnots(p); })
    .catch(e => toast('Chinese font failed to load: ' + e.message, true));
}

/* ---------------------------------------------------------- annotations */
const z = () => state.zoom;
function placeEl(el, a) {
  el.style.left = a.x * z() + 'px'; el.style.top = a.y * z() + 'px';
  if (a.type !== 'text') { el.style.width = a.w * z() + 'px'; el.style.height = a.h * z() + 'px'; }
}
const DEL_SVG = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>';
function makeAnnotEl(a) {
  const el = document.createElement('div');
  el.className = 'annot annot-' + a.type; el.dataset.id = a.id;
  if (a.type === 'image') el.innerHTML = `<img src="${state.images.get(a.imgId)?.dataUrl || ''}" alt="">`;
  else if (a.type === 'rect') { el.style.background = a.color; el.style.opacity = a.opacity; if (a.kind === 'highlight') el.classList.add('hl'); }
  else if (a.type === 'text') {
    const b = document.createElement('div'); b.className = 'tbody';
    styleTextBody(b, a);
    b.textContent = linesOf(a).join('\n');
    el.appendChild(b);
    if (a.w) el.classList.add('wrap');
  }
  el.insertAdjacentHTML('beforeend', `<button class="del" title="Delete (Del)">${DEL_SVG}</button><div class="rs" title="${a.type === 'text' ? 'Drag to change the box width' : 'Resize'}"></div>`);
  placeEl(el, a);
  if (state.selAnnot && state.selAnnot.id === a.id) el.classList.add('sel');
  return el;
}
const pageElOf = p => view.querySelector(`.page[data-key="${p.key}"]`);
function renderAnnots(p, pageEl = pageElOf(p)) {
  if (!pageEl) return;
  const layer = pageEl.querySelector('.layer'), covers = pageEl.querySelector('.coverlayer');
  layer.innerHTML = ''; covers.innerHTML = '';
  for (const a of p.annots) {
    if (a.cover) {
      const c = document.createElement('div'); c.className = 'cover';
      Object.assign(c.style, { left: a.cover.x * z() + 'px', top: a.cover.y * z() + 'px', width: a.cover.w * z() + 'px', height: a.cover.h * z() + 'px', background: a.cover.color });
      covers.appendChild(c);
    }
    layer.appendChild(makeAnnotEl(a));
  }
  if (state.tool === 'edit') renderEditLayer(p, pageEl);
}
function findAnnot(key, id) { const p = pageByKey(key); return p ? { p, a: p.annots.find(x => x.id === id) } : {}; }
function selectAnnot(key, id) {
  state.selAnnot = id ? { key, id } : null;
  $$('.annot.sel').forEach(e => e.classList.remove('sel'));
  if (id) view.querySelector(`.page[data-key="${key}"] .annot[data-id="${id}"]`)?.classList.add('sel');
  const { a } = id ? findAnnot(key, id) : {};
  if (a && a.type === 'text') showTextStyle(a);
  updateTextOpts();
}
function deleteAnnot(key, id) {
  const { p, a } = findAnnot(key, id); if (!a) return;
  pushUndo();
  const i = p.annots.indexOf(a);
  // An edited original keeps its cover, so deleting it removes that text/image from the page.
  // (Delete the leftover white box too, or press Ctrl+Z, to bring the original back.)
  if (a.cover) p.annots.splice(i, 1, { id: newId(), type: 'rect', kind: 'whiteout', ...a.cover, opacity: 1, fromBlock: a.fromBlock });
  else p.annots.splice(i, 1);
  if (state.selAnnot?.id === id) state.selAnnot = null;
  renderAnnots(p); refreshThumbSoon(key); setDirty(); updateTextOpts();
  if (a.cover) status('Removed. The white patch hides the original — delete it too (or Ctrl+Z) to bring the original back.');
}
function addAnnot(p, a, select = true) {
  p.annots.push(a);
  renderAnnots(p);
  if (select) selectAnnot(p.key, a.id);
  refreshThumbSoon(p.key); setDirty();
}

/* text editing */
let editing = null; // {key, id, before, el, fromBlockNew}
function startEditing(key, id, selectAll, opts = {}) {
  if (editing && editing.id === id) return;
  commitEditing();
  const el = view.querySelector(`.page[data-key="${key}"] .annot[data-id="${id}"]`); if (!el) return;
  const { a } = findAnnot(key, id);
  const body = el.querySelector('.tbody');
  editing = { key, id, before: opts.before || snapshot(), el, fromBlockNew: !!opts.fromBlockNew };
  el.classList.add('editing');
  body.textContent = a.text; // edit the real text (not the laid-out lines)
  try { body.contentEditable = 'plaintext-only'; } catch { body.contentEditable = 'true'; }
  if (body.contentEditable !== 'plaintext-only') body.contentEditable = 'true';
  body.focus();
  const sel = getSelection(); sel.removeAllRanges();
  let r = null;
  if (opts.caretAt && document.caretRangeFromPoint) {
    r = document.caretRangeFromPoint(opts.caretAt.x, opts.caretAt.y);
    if (r && !body.contains(r.startContainer)) r = null;
  }
  if (!r) { r = document.createRange(); r.selectNodeContents(body); if (!selectAll) r.collapse(false); }
  sel.addRange(r);
  status('Typing… click outside the box or press Esc when done.');
  const desc = el2 => el2 ? `${el2.tagName}.${el2.className || ''}#${el2.id || ''}` : 'none';
  diag('edit start', key, id, 'active=' + desc(document.activeElement), 'editable=' + body.contentEditable, 'focused=' + (document.activeElement === body));
  if (document.activeElement !== body) { body.focus(); diag('refocus ->', desc(document.activeElement)); }
}
function commitEditing() {
  if (!editing) return;
  const { key, id, before, el, fromBlockNew } = editing; editing = null;
  const { p, a } = findAnnot(key, id);
  const body = el.querySelector('.tbody');
  body.contentEditable = 'false'; el.classList.remove('editing');
  status('Ready');
  if (!a) return;
  const text = body.innerText.replace(/\r/g, '').replace(/\n$/, '');
  if (fromBlockNew && text === a.orig && !a.touched) { // opened an original paragraph but changed nothing: put it back untouched
    p.annots = p.annots.filter(x => x.id !== id);
    state.selAnnot = null; renderAnnots(p); updateTextOpts();
    return;
  }
  if (!text.trim() && !a.cover) { // empty new box -> remove
    p.annots = p.annots.filter(x => x.id !== id);
    if (a.text) pushUndo(before);
    state.selAnnot = null; renderAnnots(p); refreshThumbSoon(key); updateTextOpts();
    return;
  }
  if (text !== a.text || fromBlockNew) { pushUndo(before); a.text = text; setDirty(); refreshThumbSoon(key); }
  relayout(a);
  renderAnnots(p); selectAnnot(key, id);
}

// Safety net: while a text box is being edited, keystrokes must reach it. If focus ends up on the page
// itself (not on a toolbar control the user picked), put it back in the box.
document.addEventListener('keydown', e => {
  if (!editing) return;
  const body = editing.el.querySelector('.tbody');
  const ae = document.activeElement;
  if (ae === body || (ae && ae.closest && ae.closest('#toolbar,.modal'))) return;
  if (e.key === 'Escape' || e.ctrlKey || e.altKey || e.metaKey) return;
  diag('key while editing went to', ae ? ae.tagName + '.' + (ae.className || '') : 'none', 'editable=' + body.contentEditable, 'connected=' + body.isConnected);
  if (body.isConnected) { body.focus(); const r = document.createRange(); r.selectNodeContents(body); r.collapse(false); const s2 = getSelection(); s2.removeAllRanges(); s2.addRange(r); }
}, true);

/* pointer interaction on pages */
let drag = null;
view.addEventListener('pointerdown', e => {
  const pageEl = e.target.closest('.page'); if (!pageEl || e.button !== 0) return;
  if (e.target.closest('.ocrbar')) return; // buttons in the OCR banner
  const key = pageEl.dataset.key, p = pageByKey(key);
  const layer = pageEl.querySelector('.layer');
  const lr = pageEl.getBoundingClientRect();
  const pt = { x: (e.clientX - lr.left) / z(), y: (e.clientY - lr.top) / z() };
  const { W, H } = dispDims(p);
  setCurrent(key);
  const annotDom = e.target.closest('.annot');

  if (annotDom) {
    const id = annotDom.dataset.id, { a } = findAnnot(key, id);
    if (e.target.closest('.del')) { e.preventDefault(); commitEditing(); deleteAnnot(key, id); return; }
    if (editing && editing.id === id) return; // let the caret work
    commitEditing();
    selectAnnot(key, id);
    e.preventDefault();
    const resize = !!e.target.closest('.rs');
    drag = { mode: resize ? 'resize' : 'move', key, a, el: annotDom, start: pt, orig: { ...a }, W, H, moved: false, snap: snapshot() };
    view.setPointerCapture(e.pointerId);
    return;
  }

  // in Edit mode: clicking an original paragraph or image turns it into an editable item
  const block = e.target.closest('.eblock');
  if (block && state.tool === 'edit') {
    e.preventDefault(); commitEditing(); selectAnnot(null);
    convertBlock(p, block.dataset.id, { x: e.clientX, y: e.clientY });
    return;
  }

  // clicked empty page area
  const wasEditing = !!editing;
  commitEditing();
  selectAnnot(null);
  if (state.tool === 'text') {
    if (wasEditing) return; // first click just finishes the current box
    e.preventDefault();
    const d = state.textDefaults;
    const a = { id: newId(), type: 'text', text: '', size: +$('#fontSize').value, color: $('#textColor').value, font: d.font, bold: d.bold, italic: d.italic, fk: d.fk || null, fname: d.fname || null };
    a.x = clamp(pt.x, 0, W - 10); a.y = clamp(pt.y - a.size * 0.6, 0, H - a.size);
    p.annots.push(a);
    renderAnnots(p); selectAnnot(key, a.id);
    startEditing(key, a.id, false);
  } else if (state.tool === 'whiteout' || state.tool === 'highlight') {
    e.preventDefault();
    const box = document.createElement('div'); box.className = 'drawing'; layer.appendChild(box);
    drag = { mode: 'draw', key, layer, box, start: pt, W, H, kind: state.tool };
    view.setPointerCapture(e.pointerId);
  } else if (state.tool === 'sign' || state.tool === 'stamp') {
    e.preventDefault();
    const kind = state.tool;
    if (!state.pendingImg) { openSigModal(kind); return; }
    const im = state.images.get(state.pendingImg);
    const maxW = kind === 'stamp' ? 140 : 170, maxH = kind === 'stamp' ? 110 : 80;
    let w = Math.min(maxW, W * 0.4), h = w * im.h / im.w;
    if (h > maxH) { h = maxH; w = h * im.w / im.h; }
    pushUndo();
    const a = { id: newId(), type: 'image', kind, imgId: state.pendingImg, w, h, x: clamp(pt.x - w / 2, 0, W - w), y: clamp(pt.y - h / 2, 0, H - h) };
    addAnnot(p, a);
    setTool('select');
    status(`${kind === 'stamp' ? 'Stamp' : 'Signature'} placed. Drag to move it, drag the corner to resize.`);
  }
});
view.addEventListener('pointermove', e => {
  if (!drag) return;
  const pageEl = view.querySelector(`.page[data-key="${drag.key}"]`); if (!pageEl) return;
  const lr = pageEl.getBoundingClientRect();
  const pt = { x: clamp((e.clientX - lr.left) / z(), 0, drag.W), y: clamp((e.clientY - lr.top) / z(), 0, drag.H) };
  const dx = pt.x - drag.start.x, dy = pt.y - drag.start.y;
  if (!drag.moved && Math.hypot(dx, dy) * z() < 2) return;
  drag.moved = true;
  if (drag.mode === 'draw') {
    const x = Math.min(pt.x, drag.start.x), y = Math.min(pt.y, drag.start.y);
    Object.assign(drag.box.style, { left: x * z() + 'px', top: y * z() + 'px', width: Math.abs(dx) * z() + 'px', height: Math.abs(dy) * z() + 'px',
      background: drag.kind === 'highlight' ? 'rgba(255,230,0,.4)' : '#fff' });
    return;
  }
  const a = drag.a, o = drag.orig;
  if (drag.mode === 'move') {
    const w = a.type === 'text' ? drag.el.offsetWidth / z() : a.w, h = a.type === 'text' ? drag.el.offsetHeight / z() : a.h;
    a.x = clamp(o.x + dx, -w * 0.5, drag.W - w * 0.5); a.y = clamp(o.y + dy, -h * 0.5, drag.H - h * 0.5);
  } else if (a.type === 'text') { // change wrap width
    a.w = Math.max(a.size * 2, o.w + dx);
    const b = drag.el.querySelector('.tbody');
    b.style.width = a.w * z() + 'px'; b.textContent = layoutLines(a).join('\n');
  } else {
    let w = Math.max(8, o.w + dx), h = Math.max(6, o.h + dy);
    if (a.type === 'image' && !e.shiftKey) { const r = o.w / o.h; if (w / h > r) h = w / r; else w = h * r; }
    a.w = w; a.h = h;
  }
  placeEl(drag.el, a);
});
function endDrag() {
  if (!drag) return;
  const d = drag; drag = null;
  if (d.mode === 'draw') {
    const r = d.box.style; d.box.remove();
    if (!d.moved) return;
    const a = { id: newId(), type: 'rect', kind: d.kind, x: parseFloat(r.left) / z(), y: parseFloat(r.top) / z(), w: parseFloat(r.width) / z(), h: parseFloat(r.height) / z(),
      color: d.kind === 'highlight' ? '#ffe600' : '#ffffff', opacity: d.kind === 'highlight' ? 0.45 : 1 };
    if (a.w < 3 || a.h < 3) return;
    pushUndo(); addAnnot(pageByKey(d.key), a);
    return;
  }
  if (d.moved) {
    if (d.mode === 'move') d.a.moved = true;
    pushUndo(d.snap); setDirty(); refreshThumbSoon(d.key);
    if (d.a.type === 'text' && d.mode === 'resize') { d.a.touched = true; relayout(d.a); renderAnnots(pageByKey(d.key)); selectAnnot(d.key, d.a.id); }
  }
}
view.addEventListener('pointerup', endDrag);
view.addEventListener('pointercancel', endDrag);
view.addEventListener('dblclick', e => {
  const an = e.target.closest('.annot-text'); if (!an) return;
  startEditing(an.closest('.page').dataset.key, an.dataset.id, false, { caretAt: { x: e.clientX, y: e.clientY } });
});
view.addEventListener('input', e => {
  if (!editing || !e.target.closest('.annot')) return;
  const b = e.target.closest('.tbody'), { a } = findAnnot(editing.key, editing.id);
  if (b && a) styleTextBody(b, { ...a, text: b.innerText });
  setDirty();
});

/* --------------------------------------------------------------- tools */
function setTool(t) {
  commitEditing();
  const prev = state.tool;
  state.tool = t;
  document.body.dataset.tool = t;
  $$('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  const hints = {
    select: 'Click an item to select it; drag to move; Delete removes it.',
    edit: 'Click any text or image in the PDF to change it. Scanned pages: press “Recognize text”.',
    text: 'Click anywhere on a page to type. Double-click existing text to edit it.',
    sign: 'Click on the page where the signature should go.',
    stamp: 'Click on the page where the stamp should go.',
    whiteout: 'Drag a box over content to hide it.',
    highlight: 'Drag a box over text to highlight it.',
  };
  status(hints[t]);
  updateTextOpts();
  if (prev === 'edit' || t === 'edit') for (const p of state.pages) { const el = pageElOf(p); if (el) renderEditLayer(p, el); }
}
$$('.tool').forEach(b => b.addEventListener('click', () => {
  if (!state.pages.length) { toast('Open a PDF first.'); return; }
  if (b.dataset.tool === 'sign' || b.dataset.tool === 'stamp') { openSigModal(b.dataset.tool); return; }
  setTool(b.dataset.tool);
}));
function selectedText() {
  const a = state.selAnnot && findAnnot(state.selAnnot.key, state.selAnnot.id).a;
  return a && a.type === 'text' ? a : null;
}
function updateTextOpts() {
  $('#textOpts').classList.toggle('dim', !(state.tool === 'text' || state.tool === 'edit' || selectedText()));
}
function showTextStyle(a) {
  $('#fontSize').value = String(Math.round(a.size * 2) / 2);
  if (![...$('#fontSize').options].some(o => o.value === $('#fontSize').value)) {
    const o = document.createElement('option'); o.value = o.textContent = $('#fontSize').value; $('#fontSize').appendChild(o);
    [...$('#fontSize').options].sort((x, y) => x.value - y.value).forEach(o2 => $('#fontSize').appendChild(o2));
    $('#fontSize').value = String(Math.round(a.size * 2) / 2);
  }
  $('#textColor').value = a.color;
  const rf = a.fk && PSF.get(a.fk);
  if (rf) { ensureFamilyOption(rf.family); $('#fontFamily').value = 'fam:' + rf.family; }
  else $('#fontFamily').value = a.font || 'sans';
  $('#btnBold').classList.toggle('on', !!a.bold); $('#btnItalic').classList.toggle('on', !!a.italic);
}
function applyTextStyle(change) {
  const a = selectedText();
  if (!a) { // no text selected: change the defaults for new text
    Object.assign(state.textDefaults, change);
    $('#btnBold').classList.toggle('on', !!state.textDefaults.bold); $('#btnItalic').classList.toggle('on', !!state.textDefaults.italic);
    return;
  }
  const p = state.pages.find(q => q.annots.includes(a));
  const ed = editing && editing.id === a.id ? editing : null;
  if (ed) a.text = ed.el.querySelector('.tbody').innerText.replace(/\n$/, '');
  pushUndo(ed?.fromBlockNew ? ed.before : undefined);
  Object.assign(a, change); a.touched = true;
  relayout(a);
  editing = null; renderAnnots(p); selectAnnot(p.key, a.id); setDirty(); refreshThumbSoon(p.key);
  if (ed) startEditing(p.key, a.id, false);
}
$('#fontSize').addEventListener('change', () => applyTextStyle({ size: +$('#fontSize').value }));
$('#textColor').addEventListener('change', () => applyTextStyle({ color: $('#textColor').value }));
/* Font list: the 3 built-in PDF fonts plus every font installed on this PC */
function ensureFamilyOption(fam) {
  const sel = $('#fontFamily');
  if ([...sel.options].some(o => o.value === 'fam:' + fam)) return;
  let g = sel.querySelector('optgroup.pc');
  if (!g) { g = document.createElement('optgroup'); g.className = 'pc'; g.label = 'Fonts on this PC'; sel.appendChild(g); }
  const o = document.createElement('option'); o.value = 'fam:' + fam; o.textContent = fam; g.appendChild(o);
}
async function fillFontList() {
  if (!PSF.available) return;
  const fams = await PSF.families();
  const sel = $('#fontFamily'), cur = sel.value;
  sel.querySelector('optgroup.pc')?.remove();
  const g = document.createElement('optgroup'); g.className = 'pc'; g.label = 'Fonts on this PC';
  for (const f of fams) { const o = document.createElement('option'); o.value = 'fam:' + f; o.textContent = f; o.style.fontFamily = `"${f}"`; g.appendChild(o); }
  sel.appendChild(g); sel.value = cur;
}
// Picks the face of the chosen family (or switches bold/italic within the same family)
async function fontChange(kind) {
  const a = selectedText(), d = state.textDefaults;
  const cur = a || d, curRec = cur.fk && PSF.get(cur.fk);
  let fam = curRec ? curRec.family : null, bold = !!cur.bold, italic = !!cur.italic, std = null;
  if (kind === 'family') { const v = $('#fontFamily').value; if (v.startsWith('fam:')) fam = v.slice(4); else { fam = null; std = v; } }
  if (kind === 'bold') bold = !bold;
  if (kind === 'italic') italic = !italic;
  if (!fam) return applyTextStyle({ fk: null, fname: null, font: std || cur.font || 'sans', bold, italic });
  const rec = await PSF.resolveFamily(fam, bold, italic);
  if (!rec) { toast(`Couldn't load the font “${fam}”.`, true); return; }
  if (rec.bold !== bold || rec.italic !== italic) {
    toast(`“${fam}” has no ${bold && rec.bold !== bold ? 'bold' : 'italic'} version on this PC.`, false, 4000);
    if (kind !== 'family') { if (a) showTextStyle(a); return; }
  }
  applyTextStyle({ fk: rec.key, fname: rec.family, bold: rec.bold, italic: rec.italic });
}
$('#fontFamily').addEventListener('change', () => fontChange('family'));
$('#btnBold').addEventListener('click', () => fontChange('bold'));
$('#btnItalic').addEventListener('click', () => fontChange('italic'));
for (const id of ['#btnBold', '#btnItalic']) $(id).addEventListener('pointerdown', e => e.preventDefault()); // keep the text caret

/* ------------------------------------------------------------- Edit mode */
/* Finds the paragraphs and pictures that already exist in a page so they can be edited:
   text comes from the PDF's own text layer, or from OCR on scanned pages; pictures from the
   page's drawing instructions. Clicking one hides the original under a patch of the page's own
   background colour and puts an editable copy on top, the same way desktop PDF editors do. */
const editInfo = new Map();     // `${key}|${rot}` -> {blocks, scanned, ocr}
const editPending = new Map();  // same key -> Promise
const hiresCache = new Map();
const editKeyOf = p => p.key + '|' + totalRot(p);
function hiresRender(p) {
  const k = editKeyOf(p);
  if (!hiresCache.has(k)) {
    hiresCache.set(k, (async () => {
      const pg = await getPdfPage(p);
      const vp1 = pg.getViewport({ scale: 1, rotation: totalRot(p) });
      const scale = Math.min(3, Math.sqrt(30e6 / (vp1.width * vp1.height)));
      const vp = pg.getViewport({ scale, rotation: totalRot(p) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await pg.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
      return { canvas, ctx, scale };
    })());
    while (hiresCache.size > 4) hiresCache.delete(hiresCache.keys().next().value);
  }
  return hiresCache.get(k);
}
const toHex = c => '#' + c.map(v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
function sampleColors(h, box) {
  const s = h.scale, c = h.canvas;
  const x0 = clamp(Math.floor((box.x - 1.5) * s), 0, c.width - 2), y0 = clamp(Math.floor((box.y - 1.5) * s), 0, c.height - 2);
  const x1 = clamp(Math.ceil((box.x + box.w + 1.5) * s), x0 + 2, c.width), y1 = clamp(Math.ceil((box.y + box.h + 1.5) * s), y0 + 2, c.height);
  const w = x1 - x0, hh = y1 - y0, d = h.ctx.getImageData(x0, y0, w, hh).data;
  const R = [], G = [], B = [];
  const add = i => { R.push(d[i]); G.push(d[i + 1]); B.push(d[i + 2]); };
  for (let x = 0; x < w; x++) { add(x * 4); add(((hh - 1) * w + x) * 4); }
  for (let y = 0; y < hh; y++) { add(y * w * 4); add((y * w + w - 1) * 4); }
  const med = arr => arr.sort((p, q) => p - q)[arr.length >> 1];
  const bg = [med(R), med(G), med(B)];
  // the ink = the 5% of pixels that differ most from the background (found with a histogram)
  const diff = i => Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]);
  const hist = new Uint32Array(766), total = d.length / 4;
  for (let i = 0; i < d.length; i += 4) hist[diff(i)]++;
  let cut = 765, acc = 0;
  for (; cut > 0; cut--) { acc += hist[cut]; if (acc >= total * 0.02) break; }
  let fg = [0, 0, 0];
  if (cut > 60) {
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (diff(i) >= cut) { fg[0] += d[i]; fg[1] += d[i + 1]; fg[2] += d[i + 2]; n++; }
    fg = fg.map(v => v / Math.max(1, n)); // the 2% strongest ink pixels = the solid centre of the letters
  }
  return { bg: toHex(bg), fg: toHex(fg) };
}
function fontStyleOf(pg, fontName, style) {
  let f = null;
  try { if (pg.commonObjs.has(fontName)) f = pg.commonObjs.get(fontName); } catch {}
  const name = `${f?.name || ''} ${f?.fallbackName || ''}`;
  const fam = style?.fontFamily || '';
  const mono = !!f?.isMonospace || /courier|mono|consol/i.test(name) || fam === 'monospace';
  const serif = !mono && (!!f?.isSerifFont || (/times|serif|roman|georgia|garamond|cambria|minion|book/i.test(name) && !/sans/i.test(name)) || fam === 'serif');
  return { font: mono ? 'mono' : serif ? 'serif' : 'sans', bold: !!f?.bold || /bold|black|heavy|semibold|demi/i.test(name), italic: !!f?.italic || /italic|oblique/i.test(name),
    pdfFont: String(f?.name || '').replace(/^[A-Z]{6}\+/, '') };
}
const median = arr => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; };
function joinLines(lines) {
  return lines.reduce((acc, l) => {
    if (!acc) return l;
    const a = acc.slice(-1), b = l[0] || '';
    if (CJK_CHAR.test(a) && CJK_CHAR.test(b)) return acc + l;
    if (a === '-' && /[a-z]/.test(b) && /[a-z]-$/i.test(acc)) return acc.slice(0, -1) + l;
    return acc + ' ' + l;
  }, '');
}
/** Groups lines (sorted top to bottom) into paragraphs. Each line: {text, left, right, base, size, font, bold, italic} */
/* Table-like layouts (a label on the left, its value on the right) are rows of separate cells, not
   paragraphs: a line that has another piece of text beside it on the same row is marked as a cell. */
function markCells(lines) {
  for (const l of lines) l.cell = lines.some(m => m !== l && Math.abs(m.base - l.base) < 0.5 * Math.max(m.size, l.size)
    && (m.left > l.right + 0.5 * l.size || m.right < l.left - 0.5 * l.size));
}
function linesToBlocks(lines, prefix) {
  const paras = [];
  const xs = lines.map(l => l.left), xe = lines.map(l => l.right);
  const contentW = lines.length ? Math.max(...xe) - Math.min(...xs) : 0;
  const isShort = l => contentW > 0 && (l.right - l.left) < 0.5 * contentW;
  for (const l of lines) {
    let P = null;
    for (let i = paras.length - 1; i >= 0 && i >= paras.length - 8; i--) {
      const q = paras[i], last = q.lines[q.lines.length - 1];
      const size = Math.max(q.size, l.size), gap = l.base - last.base;
      if (Math.abs(l.size / q.size - 1) > 0.18 || l.font !== q.font || l.bold !== q.bold) continue;
      if (gap < 0.85 * size || gap > 2.0 * size) continue;
      if (q.lines.length > 1 && Math.abs(gap - q.gap) > 0.25 * size) continue;
      if (l.left < q.left - 1.5 * size || l.left > q.left + 4 * size || l.right < q.left || l.left > q.right) continue;
      if (last.right < Math.min(q.right, l.right) - 5 * size) continue; // previous line ended early: new paragraph
      if (l.cell || last.cell) continue; // rows of a table are separate cells
      // two short lines one under the other (headings, label lists) are separate items, not one wrapped paragraph
      if (isShort(last) && isShort(l) && !/[,;:\-–(&]$/.test(last.text) && /^[\p{Lu}\p{N}]/u.test(l.text)) continue;
      P = q; break;
    }
    if (!P) { paras.push({ lines: [l], left: l.left, right: l.right, size: l.size, font: l.font, bold: l.bold, italic: l.italic, pdfFont: l.pdfFont, gap: 0 }); continue; }
    if (P.lines.length === 1) P.gap = l.base - P.lines[0].base;
    P.lines.push(l); P.left = Math.min(P.left, l.left); P.right = Math.max(P.right, l.right);
  }
  return paras.map((q, i) => {
    const size = median(q.lines.map(l => l.size));
    const f = FONTS[q.font] || FONTS.sans;
    const first = q.lines[0].base, last = q.lines[q.lines.length - 1].base;
    const lh = q.lines.length > 1 ? (last - first) / (q.lines.length - 1) / size : 1.2;
    const y = Math.min(...q.lines.map(l => l.top ?? (l.base - f.asc * size)));
    const bottom = Math.max(...q.lines.map(l => l.bottom ?? (l.base + f.desc * size)));
    return { id: prefix + i, kind: 'text', text: joinLines(q.lines.map(l => l.text)), size, lh: clamp(lh, 0.9, 2.5), font: q.font, bold: q.bold, italic: q.italic,
      pdfFont: q.pdfFont || '', firstBase: first, x: q.left, y, w: q.right - q.left, h: bottom - y,
      lines: q.lines.map(l => ({ text: l.text, left: l.left, right: l.right, top: l.top ?? (l.base - f.asc * size), bottom: l.bottom ?? (l.base + f.desc * size), base: l.base })) };
  });
}
async function detectBlocks(p) {
  const pg = await getPdfPage(p);
  await hiresRender(p); // also makes the page's fonts available for style detection
  const vp = pg.getViewport({ scale: 1, rotation: totalRot(p) });
  const { W, H } = dispDims(p);
  const tc = await pg.getTextContent();
  const items = []; let chars = 0;
  for (const it of tc.items) {
    if (!it.str) continue;
    const m = pdfjsLib.Util.transform(vp.transform, it.transform);
    const size = Math.hypot(m[2], m[3]);
    if (size < 2 || Math.abs(m[1]) > 0.05 * size || m[0] <= 0) continue; // horizontal left-to-right text only
    chars += it.str.trim().length;
    items.push({ str: it.str, x: m[4], base: m[5], w: it.width, size, ...fontStyleOf(pg, it.fontName, tc.styles[it.fontName]) });
  }
  // rows by baseline, then split rows at big horizontal gaps (columns, table cells)
  items.sort((a, b) => a.base - b.base);
  const rows = [];
  for (const it of items) {
    const r = rows[rows.length - 1];
    if (r && Math.abs(it.base - r.base) < 0.3 * Math.max(r.size, it.size)) { r.items.push(it); r.size = Math.max(r.size, it.size); }
    else rows.push({ base: it.base, size: it.size, items: [it] });
  }
  const lines = [];
  for (const r of rows) {
    r.items.sort((a, b) => a.x - b.x);
    let cur = null;
    for (const it of r.items) {
      // PDF.js inserts whitespace items that can span the whole gap between two table cells: they mark a space but must not glue cells together
      if (!it.str.trim()) { if (cur && !/\s$/.test(cur.text)) cur.text += ' '; continue; }
      if (cur && it.x - cur.right > 2.2 * Math.max(cur.size, it.size)) { lines.push(cur); cur = null; }
      if (!cur) { cur = { text: it.str, left: it.x, right: it.x + it.w, base: it.base, size: it.size, font: it.font, bold: it.bold, italic: it.italic, pdfFont: it.pdfFont, longest: it.str.length }; continue; }
      if (it.x - cur.right > 0.2 * it.size && !/\s$/.test(cur.text) && !/^\s/.test(it.str)) cur.text += ' ';
      cur.text += it.str; cur.right = Math.max(cur.right, it.x + it.w); cur.size = Math.max(cur.size, it.size);
      if (it.str.length > cur.longest) Object.assign(cur, { font: it.font, bold: it.bold, italic: it.italic, pdfFont: it.pdfFont, longest: it.str.length });
    }
    if (cur) lines.push(cur);
  }
  const textLines = lines.map(l => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() })).filter(l => l.text);
  markCells(textLines);
  const blocks = linesToBlocks(textLines, 't');
  // pictures
  const ops = await pg.getOperatorList(), OPS = pdfjsLib.OPS;
  let ctm = [1, 0, 0, 1, 0, 0]; const stack = []; let n = 0;
  const paintOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageXObjectRepeat].filter(v => v != null));
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], args = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = pdfjsLib.Util.transform(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (Array.isArray(args?.[0]) && args[0].length === 6) ctm = pdfjsLib.Util.transform(ctm, args[0]); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (paintOps.has(fn)) {
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => vp.convertToViewportPoint(ctm[0] * u + ctm[2] * v + ctm[4], ctm[1] * u + ctm[3] * v + ctm[5]));
      const xs = pts.map(q => q[0]), ys = pts.map(q => q[1]);
      const x = clamp(Math.min(...xs), 0, W), y = clamp(Math.min(...ys), 0, H);
      const w = clamp(Math.max(...xs), 0, W) - x, h = clamp(Math.max(...ys), 0, H) - y;
      if (w < 10 || h < 10 || w * h > 0.6 * W * H) continue; // skip specks and full-page scans/backgrounds
      blocks.push({ id: 'i' + n++, kind: 'image', x, y, w, h });
    }
  }
  return { blocks, scanned: chars < 12, contentRight: contentRightOf(blocks, W) };
}
function contentRightOf(blocks, W) {
  const rights = blocks.filter(b => b.kind === 'text' && b.w > W * 0.3).map(b => b.x + b.w);
  return rights.length ? Math.min(Math.max(...rights), W - 18) : 0;
}
function ensureEditInfo(p) {
  const k = editKeyOf(p);
  if (editInfo.has(k) || editPending.has(k)) return;
  const pr = detectBlocks(p).then(info => {
    const prev = state.ocrResults.get(k);
    if (prev) { info.blocks = info.blocks.filter(b => b.kind !== 'text').concat(prev); info.ocr = true; info.contentRight = contentRightOf(info.blocks, dispDims(p).W); }
    editInfo.set(k, info);
  }).catch(e => { console.error(e); editInfo.set(k, { blocks: [], scanned: false, error: true }); })
    .finally(() => { editPending.delete(k); const el = pageElOf(p); if (el) renderEditLayer(p, el); });
  editPending.set(k, pr);
}
function renderEditLayer(p, el = pageElOf(p)) {
  if (!el) return;
  const L = el.querySelector('.editlayer');
  L.innerHTML = '';
  if (state.tool !== 'edit') return;
  const info = editInfo.get(editKeyOf(p));
  if (!info) {
    if (!el.dataset.sig) return; // not on screen yet: analysed when scrolled into view
    L.innerHTML = '<div class="ocrbar"><span class="spin"></span><span>Finding text and pictures…</span></div>'; ensureEditInfo(p); return;
  }
  const used = new Set(p.annots.map(a => a.fromBlock).filter(Boolean));
  for (const b of info.blocks) {
    if (used.has(b.id)) continue;
    const d = document.createElement('div');
    d.className = 'eblock ' + b.kind; d.dataset.id = b.id;
    d.title = b.kind === 'text' ? 'Click to edit this text' : 'Click to move, resize or delete this picture';
    Object.assign(d.style, { left: (b.x - 1.5) * z() + 'px', top: (b.y - 1.5) * z() + 'px', width: (b.w + 3) * z() + 'px', height: (b.h + 3) * z() + 'px' });
    L.appendChild(d);
  }
  if (ocrBusy.get(p.key)) { L.insertAdjacentHTML('beforeend', `<div class="ocrbar"><span class="spin"></span><span class="ocrmsg">${ocrBusy.get(p.key)}</span></div>`); return; }
  if (info.scanned && !info.ocr) {
    const bar = document.createElement('div'); bar.className = 'ocrbar';
    bar.innerHTML = `<span>This page is a scanned image.</span>
      <select class="ocrlang" title="Language on the page">${OCR_LANGS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>
      <button class="primary small ocrgo">Recognize text</button>
      ${state.pages.length > 1 ? '<button class="small ocrall" title="Recognize every scanned page in the document">All pages</button>' : ''}`;
    bar.querySelector('.ocrlang').value = store.get('pdfstudio.ocrLang', OCR_LANGS[0][0]);
    bar.querySelector('.ocrlang').onchange = e => store.set('pdfstudio.ocrLang', e.target.value);
    bar.querySelector('.ocrgo').onclick = () => runOcr([p]);
    const all = bar.querySelector('.ocrall'); if (all) all.onclick = () => runOcr(state.pages);
    L.appendChild(bar);
  } else if (!info.blocks.length) {
    L.insertAdjacentHTML('beforeend', '<div class="ocrbar subtle"><span>No editable text or pictures found on this page.</span></div>');
  }
}
async function convertBlock(p, blockId, caretAt) {
  const info = editInfo.get(editKeyOf(p)); const b = info?.blocks.find(x => x.id === blockId); if (!b) return;
  const h = await hiresRender(p);
  const col = sampleColors(h, b);
  if (b.kind === 'text') {
    const pad = Math.max(1, b.size * 0.15);
    // text may wrap out to the page's right text margin (like a Word paragraph), not just the original width
    let margin = Math.max(b.x + b.w, info.contentRight || 0);
    // one-line items (headings, table cells, labels) can grow to the right up to the page margin
    if ((b.lines || []).length <= 1) margin = Math.max(margin, dispDims(p).W - Math.max(36, Math.min(72, b.x)));
    const a = { id: newId(), type: 'text', text: b.text, orig: b.text, size: Math.round(b.size * 2) / 2, color: col.fg, font: b.font, bold: b.bold, italic: b.italic,
      lh: Math.round(b.lh * 100) / 100, w: margin - b.x + b.size * 0.6, fromBlock: b.id, cover: { x: b.x - pad, y: b.y - pad * 0.6, w: b.w + 2 * pad, h: b.h + pad * 1.2, color: col.bg } };
    a.x = b.x; a.base0 = b.firstBase; a.y = b.firstBase - a.size * baselineOf(a);
    relayout(a);
    const before = snapshot();
    p.annots.push(a);
    renderAnnots(p); selectAnnot(p.key, a.id);
    startEditing(p.key, a.id, false, { before, fromBlockNew: true, caretAt });
    if (PSF.available) {
      if (b.pdfFont) findOriginalFont(p, a, b.pdfFont, b, h);
      else if (/^o/.test(b.id)) matchScannedFont(p, a, b, h, { suggest: true });
    }
  } else {
    const s = h.scale, c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(b.w * s)); c.height = Math.max(1, Math.round(b.h * s));
    c.getContext('2d').drawImage(h.canvas, b.x * s, b.y * s, b.w * s, b.h * s, 0, 0, c.width, c.height);
    const imgId = registerImage(c.toDataURL('image/png'), c.width, c.height);
    pushUndo();
    addAnnot(p, { id: newId(), type: 'image', imgId, x: b.x, y: b.y, w: b.w, h: b.h, fromBlock: b.id, cover: { x: b.x - 0.5, y: b.y - 0.5, w: b.w + 1, h: b.h + 1, color: col.bg } });
    status('Picture: drag to move, drag the corner to resize, Delete to remove it.');
  }
}

/* ------------------------------------------------- keeping the original font */
// After a paragraph is opened for editing, look up its real font (installed / downloaded / free equivalent)
// and switch the editable copy to it, keeping the text sitting on the same baseline.
const fontNotices = new Set();
function applyRealFont(p, a, rec, newSize) {
  if (!p.annots.includes(a)) return;
  a.fk = rec.key; a.fname = rec.family; a.bold = rec.bold; a.italic = rec.italic;
  if (newSize) a.size = newSize;
  if (a.base0 != null && !a.moved) a.y = a.base0 - a.size * baselineOf(a);
  const ed = editing && editing.id === a.id ? editing : null;
  if (ed) { const body = ed.el.querySelector('.tbody'); styleTextBody(body, { ...a, text: body.innerText }); placeEl(ed.el, a); }
  else { relayout(a); renderAnnots(p); selectAnnot(p.key, a.id); }
  if (selectedText() === a) showTextStyle(a);
  refreshThumbSoon(p.key);
}
async function findOriginalFont(p, a, pdfName, b, h) {
  try {
    diag('font lookup', pdfName, a.bold ? 'bold' : '', a.italic ? 'italic' : '');
    const r = await PSF.resolvePdfFont(pdfName, a.bold, a.italic, msg => status(msg));
    diag('font lookup result', pdfName, r && r.rec ? `${r.how} ${r.rec.family} ${r.rec.style}` : 'none');
    status('Ready');
    const shown = r && r.display || pdfName.replace(/[,\-].*$/, '').replace(/(PS)?MT$/, '');
    if (!r || r.none) {
      // Not installed and not downloadable: pick the most similar-looking font on this PC instead of a generic one
      const best = b && h ? await matchScannedFont(p, a, b, h, { weight: r && r.weight, italic: r && r.italic, keepSize: true, suggest: true }) : null;
      if (!fontNotices.has(shown)) {
        fontNotices.add(shown);
        toast(best ? `“${shown}” isn't on this PC and couldn't be downloaded. Using the closest-looking font, ${best.rec.family}. Other close matches are at the top of the font list.`
                   : `The font “${shown}” isn't on this PC and isn't free to download, so the closest standard font is used.`, false, 8000);
      }
      return;
    }
    applyRealFont(p, a, r.rec);
    const key = shown + r.how;
    if (fontNotices.has(key)) return; fontNotices.add(key);
    if (r.how === 'downloaded') toast(`Downloaded and installed the font “${r.rec.family}”.`, false, 5000);
    else if (r.how === 'substitute') toast(`“${r.original}” isn't on this PC; using ${r.name}, which has identical letter sizes.`, false, 6000);
    else if (r.how === 'substitute-downloaded') toast(`“${r.original}” isn't free to download; installed ${r.name}, which has identical letter sizes.`, false, 6000);
  } catch (e) { console.warn('font lookup failed', e); status('Ready'); }
}

/* Scanned pages contain pictures of letters, not fonts. To keep the look, the scanned line is compared
   with the same words drawn in each likely font on this PC (shape and proportions), and the closest font,
   weight and size are used. */
const SCAN_FONTS_LATIN = ['Arial', 'Helvetica', 'Calibri', 'Aptos', 'Times New Roman', 'Cambria', 'Georgia', 'Garamond', 'Book Antiqua', 'Palatino Linotype',
  'Verdana', 'Tahoma', 'Segoe UI', 'Trebuchet MS', 'Century Gothic', 'Century Schoolbook', 'Bookman Old Style', 'Franklin Gothic Book', 'Gill Sans MT',
  'Arial Narrow', 'Candara', 'Corbel', 'Constantia', 'Courier New', 'Liberation Sans', 'Liberation Serif', 'DejaVu Sans', 'DejaVu Serif', 'Carlito', 'Caladea'];
const SCAN_FONTS_CJK = ['Microsoft YaHei', 'SimSun', 'SimHei', 'DengXian', 'Microsoft JhengHei', 'PMingLiU', 'KaiTi', 'WenQuanYi Zen Hei', 'Noto Sans CJK SC'];
function inkBox(ctx, w, h, bgLum) {
  const d = ctx.getImageData(0, 0, w, h).data, m = new Float32Array(w * h);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let i = 0; i < w * h; i++) {
    const L = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    const ink = clamp((bgLum - L) / Math.max(40, bgLum * 0.6), 0, 1);
    m[i] = ink;
    if (ink > 0.35) { const x = i % w, y = (i / w) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return { m, w, h, x0, y0, x1, y1 };
}
function sampleBox(ib, W, H) { // ink box resampled to W x H (area average)
  const out = new Float32Array(W * H), bw = ib.x1 - ib.x0 + 1, bh = ib.y1 - ib.y0 + 1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sx0 = ib.x0 + Math.floor(x * bw / W), sx1 = ib.x0 + Math.max(Math.floor((x + 1) * bw / W), Math.floor(x * bw / W) + 1);
    const sy0 = ib.y0 + Math.floor(y * bh / H), sy1 = ib.y0 + Math.max(Math.floor((y + 1) * bh / H), Math.floor(y * bh / H) + 1);
    let s = 0, c = 0;
    for (let yy = sy0; yy < sy1; yy++) for (let xx = sx0; xx < sx1; xx++) { s += ib.m[yy * ib.w + xx]; c++; }
    out[y * W + x] = c ? s / c : 0;
  }
  return out;
}
function similarity(A, B) { // correlation of two ink maps
  let ma = 0, mb = 0; const n = A.length;
  for (let i = 0; i < n; i++) { ma += A[i]; mb += B[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = A[i] - ma, y = B[i] - mb; num += x * y; da += x * x; db += y * y; }
  return num / Math.sqrt(da * db || 1);
}
// Families with a similar look to popular web/brand fonts, checked as well when looking for a look-alike
const LOOKALIKE_EXTRA = ['Century Gothic', 'Futura', 'Futura PT', 'Avenir', 'Avenir Next', 'Avenir LT Std', 'Gotham', 'Montserrat', 'Poppins', 'Raleway', 'Nunito',
  'Nunito Sans', 'Open Sans', 'Roboto', 'Lato', 'Source Sans Pro', 'Source Sans 3', 'Bahnschrift', 'Tw Cen MT', 'Segoe UI Semibold', 'Inter', 'Noto Sans'];
async function matchScannedFont(p, a, b, h, opts = {}) {
  try {
    const line = [...(b.lines || [])].sort((l1, l2) => (l2.right - l2.left) - (l1.right - l1.left))[0];
    if (!line || line.text.length < 3) return;
    const cjk = CJK.needs(line.text);
    const all = await PSF.families(), have = new Set(all.map(PSF.famKey));
    const cands = [...new Set(cjk ? SCAN_FONTS_CJK : [...SCAN_FONTS_LATIN, ...LOOKALIKE_EXTRA])].filter(f => have.has(PSF.famKey(f)));
    if (!cands.length) return null;
    status(opts.keepSize ? 'Finding the closest-looking font…' : 'Matching the scanned font…');
    // the scanned line
    const s = h.scale, pad = 2;
    const cx = Math.max(0, Math.floor((line.left - pad) * s)), cy = Math.max(0, Math.floor((line.top - pad) * s));
    const cw = Math.min(h.canvas.width - cx, Math.ceil((line.right - line.left + 2 * pad) * s)), ch = Math.min(h.canvas.height - cy, Math.ceil((line.bottom - line.top + 2 * pad) * s));
    const sc = Math.min(1, 900 / cw), crop = document.createElement('canvas');
    crop.width = Math.max(1, Math.round(cw * sc)); crop.height = Math.max(1, Math.round(ch * sc));
    const cctx = crop.getContext('2d', { willReadFrequently: true });
    cctx.drawImage(h.canvas, cx, cy, cw, ch, 0, 0, crop.width, crop.height);
    const bgL = (() => { const c = parseInt(sampleColors(h, { x: line.left, y: line.top, w: line.right - line.left, h: line.bottom - line.top }).bg.slice(1), 16); return 0.299 * (c >> 16) + 0.587 * ((c >> 8) & 255) + 0.114 * (c & 255); })();
    const scan = inkBox(cctx, crop.width, crop.height, bgL);
    if (scan.x1 < 0) { status('Ready'); return null; }
    const sw = scan.x1 - scan.x0 + 1, sh = scan.y1 - scan.y0 + 1;
    const GW = clamp(Math.round(24 * sw / sh), 24, 480), GH = 24;
    const target = sampleBox(scan, GW, GH);
    let best = null; const results = [], tried = new Set();
    const weights = [...new Set([opts.weight || 400, 400, 700])];
    const R = document.createElement('canvas'), rctx = R.getContext('2d', { willReadFrequently: true });
    for (const fam of cands) for (const w of weights) {
      const e = await PSF.faceOf(fam, w, !!opts.italic);
      if (!e || Math.abs((e.weight || (e.bold ? 700 : 400)) - w) > 100) continue;
      const ek = e.file + '#' + e.index; if (tried.has(ek)) continue; tried.add(ek);
      let rec; try { rec = await PSF.load(e); } catch { continue; }
      if (!rec.f.covers(line.text)) continue;
      const px = 64; rctx.font = `${px}px ${rec.css}`; rctx.fontKerning = 'none';
      const tw = Math.ceil(rctx.measureText(line.text).width);
      R.width = tw + 20; R.height = Math.ceil(px * 1.6);
      rctx.fillStyle = '#fff'; rctx.fillRect(0, 0, R.width, R.height);
      rctx.font = `${px}px ${rec.css}`; rctx.fontKerning = 'none'; rctx.fillStyle = '#000'; rctx.textBaseline = 'alphabetic';
      rctx.fillText(line.text, 10, Math.round(px * 1.15));
      const r = inkBox(rctx, R.width, R.height, 255);
      if (r.x1 < 0) continue;
      const rw = r.x1 - r.x0 + 1, rh = r.y1 - r.y0 + 1;
      const aspect = Math.abs(Math.log((rw / rh) / (sw / sh)));
      const score = similarity(target, sampleBox(r, GW, GH)) - 1.5 * aspect;
      const cand = { score, rec, size: px * ((sw / sc / s) / rw) };
      results.push(cand);
      if (!best || score > best.score) best = cand;
    }
    status('Ready');
    results.sort((x, y) => y.score - x.score);
    diag('look-alike fonts', results.slice(0, 5).map(r => `${r.rec.family} ${r.rec.style} ${r.score.toFixed(2)}`).join(', '));
    if (opts.suggest) showFontSuggestions(results.filter((r, i, arr) => arr.findIndex(q => q.rec.family === r.rec.family) === i).slice(0, 5).map(r => r.rec.family));
    if (best && best.score > 0.2) { applyRealFont(p, a, best.rec, opts.keepSize ? null : Math.round(best.size * 2) / 2); return best; }
    return null;
  } catch (e) { console.warn('font matching failed', e); status('Ready'); return null; }
}
/** Puts the closest-looking fonts at the top of the font list. */
function showFontSuggestions(fams) {
  const sel = $('#fontFamily'), cur = sel.value;
  sel.querySelector('optgroup.suggest')?.remove();
  if (!fams.length) return;
  const g = document.createElement('optgroup'); g.className = 'suggest'; g.label = 'Closest look-alikes';
  for (const f of fams) { const o = document.createElement('option'); o.value = 'fam:' + f; o.textContent = f; o.style.fontFamily = `"${f}"`; g.appendChild(o); }
  sel.insertBefore(g, sel.querySelector('optgroup.pc') || null);
  sel.value = cur;
}

/* -------------------------------------------------------------------- OCR */
/* Uses Tesseract (tesseract.js). The engine and language files are downloaded the first time
   (needs internet once), then cached by the browser so later use works offline. */
const OCR_LANGS = [
  ['eng+msa+chi_sim', 'English, Malay, 简体中文'],
  ['eng+msa', 'English & Malay'],
  ['eng+chi_sim', 'English & 简体中文'],
  ['eng+chi_tra', 'English & 繁體中文'],
  ['eng+msa+chi_sim+chi_tra', 'All (slower)'],
];
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const ocrBusy = new Map(); // page key -> message
let tessLoad = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!tessLoad) tessLoad = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = TESSERACT_URL; s.async = true;
    s.onload = () => window.Tesseract ? res(window.Tesseract) : rej(new Error('engine missing'));
    s.onerror = () => { tessLoad = null; rej(new Error('offline')); };
    document.head.appendChild(s);
  });
  return tessLoad;
}
const ocrWorkers = new Map();
let ocrLogTarget = null;
function ocrLogger(m) {
  if (!ocrLogTarget || !m) return;
  const pct = m.progress != null ? ` ${Math.round(m.progress * 100)}%` : '';
  const label = /recogniz/i.test(m.status) ? 'Reading text…' : /load|initializ|download/i.test(m.status) ? 'Preparing text recognition (first time downloads it)…' : m.status;
  ocrBusy.set(ocrLogTarget.key, label + pct);
  const el = pageElOf(ocrLogTarget); const msg = el?.querySelector('.ocrmsg'); if (msg) msg.textContent = label + pct;
  status(label + pct);
}
function getOcrWorker(langs) {
  if (!ocrWorkers.has(langs)) {
    const pr = (async () => {
      const T = await loadTesseract();
      try { return await T.createWorker(langs.split('+'), 1, { logger: ocrLogger }); }
      catch (e) { console.warn('OCR cache unavailable, retrying without cache', e); return await T.createWorker(langs.split('+'), 1, { logger: ocrLogger, cacheMethod: 'none' }); }
    })();
    pr.catch(() => ocrWorkers.delete(langs));
    ocrWorkers.set(langs, pr);
  }
  return ocrWorkers.get(langs);
}
const cleanOcr = s => s.replace(/\s+/g, ' ').trim()
  .replace(/([⺀-鿿豈-﫿＀-￯　-〿]) (?=[⺀-鿿豈-﫿＀-￯　-〿])/g, '$1');
function blocksFromOcr(data, scale, p) {
  const lines = [];
  const paras = data.paragraphs?.length ? data.paragraphs : (data.blocks || []).flatMap(b => b.paragraphs || []);
  const { W } = dispDims(p);
  paras.forEach((para, pi) => {
    for (const l of para.lines || []) {
      const text = cleanOcr(l.text || '');
      if (!text || (l.confidence ?? 100) < 40 || !/[\p{L}\p{N}]/u.test(text)) continue;
      const bb = l.bbox, ra = l.rowAttributes || {};
      // Tesseract's row height (x-height + ascenders + descenders) is about 87% of the font size
      const size = (ra.row_height ? ra.row_height * 1.15 : (bb.y1 - bb.y0) * 0.9) / scale;
      if (size < 3 || size > 200) continue;
      const bl = l.baseline && l.baseline.has_baseline !== false ? l.baseline : null;
      const base = bl ? bl.y0 / scale + (bl.y1 - bl.y0) / scale * ((bb.x0 - bl.x0) / Math.max(1, bl.x1 - bl.x0)) : bb.y1 / scale - size * 0.2;
      lines.push({ text, left: bb.x0 / scale, right: bb.x1 / scale, base, size, top: bb.y0 / scale, bottom: bb.y1 / scale, font: 'sans', bold: false, italic: false, para: pi });
    }
  });
  // keep Tesseract's own paragraphs, but split any that our layout rules see as separate
  const out = [];
  const groups = [...new Set(lines.map(l => l.para))];
  for (const g of groups) out.push(...linesToBlocks(lines.filter(l => l.para === g).sort((a, b) => a.base - b.base), `o${g}_`));
  return out.filter(b => b.x < W);
}
async function runOcr(pages) {
  const langs = store.get('pdfstudio.ocrLang', OCR_LANGS[0][0]);
  const todo = [];
  for (const p of pages) {
    const k = editKeyOf(p);
    if (!editInfo.has(k)) { ensureEditInfo(p); await editPending.get(k); }
    const info = editInfo.get(k);
    if (info?.scanned && !info.ocr && !ocrBusy.has(p.key)) todo.push(p);
  }
  if (!todo.length) { toast('No scanned pages left to recognize.'); return; }
  for (const p of todo) { ocrBusy.set(p.key, 'Waiting…'); renderEditLayer(p); }
  let done = 0;
  try {
    for (const p of todo) {
      ocrLogTarget = p; ocrBusy.set(p.key, 'Starting…'); renderEditLayer(p);
      const worker = await getOcrWorker(langs);
      const h = await hiresRender(p);
      ocrBusy.set(p.key, 'Reading text…'); renderEditLayer(p);
      const { data } = await worker.recognize(h.canvas);
      const blocks = blocksFromOcr(data, h.scale, p);
      const k = editKeyOf(p);
      state.ocrResults.set(k, blocks);
      const info = editInfo.get(k);
      info.blocks = info.blocks.filter(b => b.kind !== 'text').concat(blocks); info.ocr = true; info.contentRight = contentRightOf(info.blocks, dispDims(p).W);
      ocrBusy.delete(p.key); renderEditLayer(p); done++;
    }
    toast(done === 1 ? 'Text recognized. Click any paragraph to edit it.' : `Recognized text on ${done} pages. Click any paragraph to edit it.`);
    status('Ready');
  } catch (e) {
    console.error(e);
    for (const p of todo) { ocrBusy.delete(p.key); renderEditLayer(p); }
    const offline = /offline|fetch|network|load/i.test(String(e?.message || e));
    toast(offline ? 'Text recognition needs an internet connection the first time, to download its engine. Connect and try again.'
                  : 'Text recognition failed: ' + (e?.message || e), true, 8000);
    status('Ready');
  } finally { ocrLogTarget = null; }
}

/* ------------------------------------------------- signatures & stamps */
const sigModal = $('#sigModal');
const pad = $('#sigPad');
let padCtx, padHasInk = false, sigTab = 'draw', typedFont = 0, uploaded = null, sigMode = 'sign';
const SIG_FONTS = ['"Segoe Script"', '"Ink Free"', '"Lucida Handwriting"', '"Brush Script MT"'];
const MODES = {
  sign: { title: 'Add a signature', key: 'pdfstudio.sigs', tabs: ['draw', 'type', 'image'], saved: 'Your saved signatures', use: 'Place signature',
          imgHint: 'Choose a photo or scan of your signature (PNG or JPG)' },
  stamp: { title: 'Add a stamp', key: 'pdfstudio.stamps', tabs: ['create', 'image'], saved: 'Your saved stamps', use: 'Place stamp',
          imgHint: 'Choose a photo or scan of your company stamp / chop (PNG or JPG). Its colours are kept.' },
};
function openSigModal(mode = 'sign') {
  if (!state.pages.length) { toast('Open a PDF first.'); return; }
  commitEditing();
  if (mode !== sigMode) { uploaded = null; $('#imgPreview').hidden = true; $('#imgDropText').hidden = false; }
  sigMode = mode;
  const M = MODES[mode];
  $('#sigTitle').textContent = M.title; $('#savedLabel').textContent = M.saved; $('#sigUse').textContent = M.use;
  $('#imgDropText').textContent = M.imgHint;
  $$('.tab', sigModal).forEach(b => b.classList.toggle('hidden', !M.tabs.includes(b.dataset.tab)));
  sigModal.classList.remove('hidden');
  renderSavedSigs();
  if (!M.tabs.includes(sigTab)) sigTab = M.tabs[0];
  switchTab(store.get(M.key, []).length ? sigTab : M.tabs[0]);
}
function closeSigModal() { sigModal.classList.add('hidden'); document.activeElement?.blur?.(); }
$$('[data-close]', sigModal).forEach(b => b.onclick = closeSigModal);
sigModal.addEventListener('pointerdown', e => { if (e.target === sigModal) closeSigModal(); });
function switchTab(t) {
  sigTab = t;
  if (t === 'create') requestAnimationFrame(renderStampPreview);
  $$('.tab', sigModal).forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  $$('.tabpane', sigModal).forEach(p => p.classList.toggle('hidden', p.dataset.pane !== t));
  if (t === 'draw') requestAnimationFrame(setupPad);
  if (t === 'type') { renderTypeFonts(); $('#typeName').focus(); }
}
$$('.tab', sigModal).forEach(b => b.onclick = () => switchTab(b.dataset.tab));

function setupPad() {
  const r = pad.getBoundingClientRect(); if (!r.width) return;
  const dpr = window.devicePixelRatio || 1;
  if (pad.width === Math.round(r.width * dpr) && padCtx) return;
  pad.width = Math.round(r.width * dpr); pad.height = Math.round(r.height * dpr);
  padCtx = pad.getContext('2d'); padCtx.scale(dpr, dpr);
  padCtx.lineCap = padCtx.lineJoin = 'round';
  padHasInk = false;
}
let stroke = null;
pad.addEventListener('pointerdown', e => {
  setupPad(); pad.setPointerCapture(e.pointerId);
  const r = pad.getBoundingClientRect();
  stroke = [{ x: e.clientX - r.left, y: e.clientY - r.top, p: e.pressure || 0.5 }];
  padCtx.fillStyle = $('#inkColor').value;
  padCtx.beginPath(); padCtx.arc(stroke[0].x, stroke[0].y, +$('#inkWidth').value / 2, 0, Math.PI * 2); padCtx.fill();
  padHasInk = true;
});
pad.addEventListener('pointermove', e => {
  if (!stroke) return;
  const r = pad.getBoundingClientRect();
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of evs) {
    const pt = { x: ev.clientX - r.left, y: ev.clientY - r.top, p: ev.pressure || 0.5 };
    const prev = stroke[stroke.length - 1];
    const base = +$('#inkWidth').value;
    padCtx.strokeStyle = $('#inkColor').value;
    padCtx.lineWidth = ev.pointerType === 'pen' ? base * (0.4 + pt.p * 1.2) : base;
    padCtx.beginPath();
    if (stroke.length > 1) {
      const pp = stroke[stroke.length - 2];
      padCtx.moveTo((pp.x + prev.x) / 2, (pp.y + prev.y) / 2);
      padCtx.quadraticCurveTo(prev.x, prev.y, (prev.x + pt.x) / 2, (prev.y + pt.y) / 2);
    } else { padCtx.moveTo(prev.x, prev.y); padCtx.lineTo(pt.x, pt.y); }
    padCtx.stroke();
    stroke.push(pt);
  }
});
pad.addEventListener('pointerup', () => stroke = null);
$('#padClear').onclick = () => { padCtx?.clearRect(0, 0, pad.width, pad.height); padHasInk = false; };

function renderTypeFonts() {
  const name = $('#typeName').value || 'Your Name';
  const box = $('#typeFonts');
  box.innerHTML = '';
  SIG_FONTS.forEach((f, i) => {
    const d = document.createElement('div');
    d.className = 'fontopt' + (i === typedFont ? ' active' : '');
    d.style.fontFamily = f + ', cursive'; d.textContent = name;
    d.onclick = () => { typedFont = i; renderTypeFonts(); };
    box.appendChild(d);
  });
}
$('#typeName').addEventListener('input', renderTypeFonts);
$('#typeName').addEventListener('keydown', e => { if (e.key === 'Enter') $('#sigUse').click(); });

$('#imgChoose').onclick = () => $('#fileImg').click();
$('#fileImg').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  const url = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(f); });
  uploaded = url;
  $('#imgDropText').hidden = true;
  updateImgPreview();
};
let previewSeq = 0;
async function updateImgPreview() {
  if (!uploaded) return;
  const seq = ++previewSeq;
  const c = await processUploadedImage();
  if (seq !== previewSeq || !c) return;
  const im = $('#imgPreview'); im.src = c.toDataURL('image/png'); im.hidden = false;
  $('#bgStrengthRow').classList.toggle('hidden', !$('#imgRemoveBg').checked);
}
$('#imgRemoveBg').addEventListener('change', updateImgPreview);
$('#bgStrength').addEventListener('input', () => { clearTimeout(updateImgPreview.t); updateImgPreview.t = setTimeout(updateImgPreview, 60); });

/* Removes the paper background from a photo/scan of a signature.
   The paper colour is measured locally (so grey/beige paper and shadows from a phone photo work),
   then each pixel's transparency comes from how much darker it is than the paper around it. */
function removeBackground(c, strength, keepColor = false) {
  const w = c.width, h = c.height, ctx = c.getContext('2d');
  const id = ctx.getImageData(0, 0, w, h), d = id.data, n = w * h;
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  // 1) paper brightness on a coarse grid: a high percentile per cell (ink is always the darker minority)
  const cell = Math.max(8, Math.round(Math.max(w, h) / 24));
  const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell), grid = new Float32Array(gw * gh);
  const hist = new Uint32Array(256);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    hist.fill(0); let cnt = 0;
    for (let y = gy * cell; y < Math.min(h, (gy + 1) * cell); y++) for (let x = gx * cell; x < Math.min(w, (gx + 1) * cell); x++) { hist[L[y * w + x] | 0]++; cnt++; }
    let acc = 0, v = 255; const target = cnt * 0.15;
    for (let k = 255; k >= 0; k--) { acc += hist[k]; if (acc >= target) { v = k; break; } }
    grid[gy * gw + gx] = v;
  }
  // smooth the grid (take the brighter of neighbours, then average) so cells full of ink still see the paper
  const g2 = new Float32Array(grid.length);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    let m = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = gy + dy, xx = gx + dx; if (yy >= 0 && yy < gh && xx >= 0 && xx < gw) m = Math.max(m, grid[yy * gw + xx]); }
    g2[gy * gw + gx] = m;
  }
  const bgAt = (x, y) => { // bilinear interpolation of the paper brightness
    const fx = clamp(x / cell - 0.5, 0, gw - 1), fy = clamp(y / cell - 0.5, 0, gh - 1);
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(gw - 1, x0 + 1), y1 = Math.min(gh - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
    return (g2[y0 * gw + x0] * (1 - tx) + g2[y0 * gw + x1] * tx) * (1 - ty) + (g2[y1 * gw + x0] * (1 - tx) + g2[y1 * gw + x1] * tx) * ty;
  };
  // 2) alpha from relative darkness; strength 0..100 moves the cut-off
  const lo = 0.30 - strength * 0.0025, hi = lo + 0.18;
  const alpha = new Uint8Array(n);
  // stamps: coloured ink (e.g. a red chop) can be nearly as bright as the paper, so colourfulness counts too
  const sat = i => (Math.max(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) - Math.min(d[i * 4], d[i * 4 + 1], d[i * 4 + 2])) / 255;
  let paperSat = 0;
  if (keepColor) { const ss = []; for (let i = 0; i < n; i += 7) ss.push(sat(i)); paperSat = median(ss); }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, bg = Math.max(bgAt(x, y), 40);
    let dk = (bg - L[i]) / bg;
    if (keepColor) dk = Math.max(dk, (sat(i) - paperSat - 0.08) * 1.4);
    const t = clamp((dk - lo) / (hi - lo), 0, 1);
    alpha[i] = Math.round(255 * t * t * (3 - 2 * t));
  }
  // 3) drop tiny specks (paper grain, dust) but keep real dots
  const minArea = Math.max(6, Math.round(n * 0.00004));
  const seen = new Uint8Array(n), stack = [];
  for (let i = 0; i < n; i++) {
    if (seen[i] || alpha[i] < 100) continue;
    const comp = []; stack.push(i); seen[i] = 1;
    while (stack.length) {
      const j = stack.pop(); comp.push(j);
      const x = j % w, y = (j / w) | 0;
      for (const k of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1])
        if (k >= 0 && !seen[k] && alpha[k] >= 100) { seen[k] = 1; stack.push(k); }
      if (comp.length > minArea) { while (stack.length) { const q = stack.pop(); comp.push(q); } break; } // big enough: keep
    }
    if (comp.length <= minArea) for (const j of comp) alpha[j] = 0;
  }
  // 4) write out. Signatures: deepen grey photo ink to pen ink. Stamps: keep the colour, just a touch richer.
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (keepColor) {
      const m = (d[o] + d[o + 1] + d[o + 2]) / 3;
      for (let k = 0; k < 3; k++) d[o + k] = clamp(m + (d[o + k] - m) * 1.25 - 12, 0, 255);
    } else { d[o] = d[o] * 0.75; d[o + 1] = d[o + 1] * 0.75; d[o + 2] = d[o + 2] * 0.75; }
    d[o + 3] = Math.min(d[o + 3], alpha[i]);
  }
  ctx.putImageData(id, 0, 0);
  return c;
}
async function processUploadedImage() {
  const im = await loadImage(uploaded);
  const s = Math.min(1, 1600 / Math.max(im.width, im.height));
  const c = document.createElement('canvas'); c.width = Math.round(im.width * s); c.height = Math.round(im.height * s);
  c.getContext('2d', { willReadFrequently: true }).drawImage(im, 0, 0, c.width, c.height);
  if (!$('#imgRemoveBg').checked) return c;
  removeBackground(c, +$('#bgStrength').value, sigMode === 'stamp');
  return trimCanvas(c, 4) || c;
}

function trimCanvas(c, pad2 = 6) {
  const ctx = c.getContext('2d'), { width: w, height: h } = c;
  const d = ctx.getImageData(0, 0, w, h).data;
  let x1 = w, y1 = h, x2 = -1, y2 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 8) {
    if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y;
  }
  if (x2 < 0) return null;
  x1 = Math.max(0, x1 - pad2); y1 = Math.max(0, y1 - pad2); x2 = Math.min(w - 1, x2 + pad2); y2 = Math.min(h - 1, y2 + pad2);
  const out = document.createElement('canvas');
  out.width = x2 - x1 + 1; out.height = y2 - y1 + 1;
  out.getContext('2d').drawImage(c, x1, y1, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}
function loadImage(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; }); }
async function buildSignatureCanvas() {
  if (sigTab === 'create') {
    if (!$('#stText').value.trim()) { toast('Type the stamp text first.', true); return null; }
    return makeStamp();
  }
  if (sigTab === 'draw') {
    if (!padHasInk) { toast('Draw your signature in the box first.', true); return null; }
    return trimCanvas(pad);
  }
  if (sigTab === 'type') {
    const name = $('#typeName').value.trim();
    if (!name) { toast('Type your name first.', true); return null; }
    const c = document.createElement('canvas'); c.width = 1400; c.height = 300;
    const ctx = c.getContext('2d');
    ctx.font = `120px ${SIG_FONTS[typedFont]}, cursive`; ctx.fillStyle = $('#inkColor').value || '#111';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(name).width;
    if (tw > 1340) { ctx.font = `${Math.floor(120 * 1340 / tw)}px ${SIG_FONTS[typedFont]}, cursive`; }
    ctx.fillText(name, 30, 150);
    return trimCanvas(c);
  }
  if (!uploaded) { toast('Choose an image first.', true); return null; }
  return processUploadedImage();
}
function registerImage(dataUrl, w, h) {
  for (const [id, im] of state.images) if (im.dataUrl === dataUrl) return id;
  const id = newId(); state.images.set(id, { dataUrl, w, h }); return id;
}
function useSignature(dataUrl, w, h) {
  state.pendingImg = registerImage(dataUrl, w, h);
  closeSigModal();
  setTool(sigMode);
}

/* stamp maker */
const STAMP_COLORS = { red: '#c4161c', blue: '#1d3fae', green: '#167a3a', black: '#222222' };
function stampDate() {
  const v = $('#stDateVal').value; const d = v ? new Date(v + 'T12:00:00') : new Date();
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
}
function makeStamp() {
  const text = $('#stText').value.trim().toUpperCase(), sub = $('#stSub').value.trim();
  const date = $('#stDate').checked ? stampDate() : '';
  const shape = $('#stShape').value, color = STAMP_COLORS[$('#stColor').value] || STAMP_COLORS.red;
  const FF = '"Arial Black", "Arial Bold", Arial, "Liberation Sans", sans-serif';
  const m = document.createElement('canvas').getContext('2d');
  const fit = (str, size, maxW, weight = '900') => { m.font = `${weight} ${size}px ${FF}`; const w = m.measureText(str).width; return w > maxW ? Math.floor(size * maxW / w) : size; };
  const c = document.createElement('canvas'), ctx = c.getContext('2d');
  if (shape === 'circle') {
    const D = 640; c.width = c.height = D;
    ctx.strokeStyle = ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 16; ctx.beginPath(); ctx.arc(D / 2, D / 2, D / 2 - 12, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(D / 2, D / 2, D / 2 - 44, 0, Math.PI * 2); ctx.stroke();
    if (sub) { // company name around the top of the ring
      const r = D / 2 - 92, size = 44; ctx.font = `bold ${size}px ${FF}`;
      const chars = [...sub.toUpperCase()], total = ctx.measureText(sub.toUpperCase()).width;
      const span = Math.min(Math.PI * 1.25, total / r * 1.08);
      let ang = -Math.PI / 2 - span / 2;
      for (const ch of chars) {
        const cw = ctx.measureText(ch).width / total * span;
        ctx.save(); ctx.translate(D / 2 + r * Math.cos(ang + cw / 2), D / 2 + r * Math.sin(ang + cw / 2)); ctx.rotate(ang + cw / 2 + Math.PI / 2);
        ctx.fillText(ch, 0, 0); ctx.restore(); ang += cw;
      }
    }
    const size = fit(text, 96, D * 0.66);
    ctx.font = `900 ${size}px ${FF}`; ctx.fillText(text, D / 2, D / 2 + (sub ? 20 : 0));
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(D * 0.2, D / 2 + (sub ? 20 : 0) - size * 0.7); ctx.lineTo(D * 0.8, D / 2 + (sub ? 20 : 0) - size * 0.7); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(D * 0.2, D / 2 + (sub ? 20 : 0) + size * 0.7); ctx.lineTo(D * 0.8, D / 2 + (sub ? 20 : 0) + size * 0.7); ctx.stroke();
    if (date) { ctx.font = `bold ${fit(date, 46, D * 0.5, 'bold')}px ${FF}`; ctx.fillText(date, D / 2, D / 2 + (sub ? 20 : 0) + size * 0.7 + 52); }
  } else {
    const size = fit(text, 130, 1500);
    m.font = `900 ${size}px ${FF}`; const tw = m.measureText(text).width;
    m.font = `bold 52px ${FF}`; const sw = Math.max(sub ? m.measureText(sub).width : 0, date ? m.measureText(date).width : 0);
    const W = Math.max(tw, sw) + 140, H = 60 + size * 1.05 + (sub ? 70 : 0) + (date ? 70 : 0) + 40;
    c.width = W; c.height = H;
    ctx.strokeStyle = ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    const box = (inset, lw, rad) => { ctx.lineWidth = lw; ctx.beginPath(); ctx.roundRect(inset, inset, W - 2 * inset, H - 2 * inset, rad); ctx.stroke(); };
    const rad = shape === 'rounded' ? 46 : 4;
    box(10, 14, rad); box(32, 4, Math.max(2, rad - 20));
    let y = 50 + size * 0.86;
    ctx.font = `900 ${size}px ${FF}`; ctx.fillText(text, W / 2, y);
    ctx.font = `bold 52px ${FF}`;
    if (sub) { y += 74; ctx.fillText(sub, W / 2, y); }
    if (date) { y += 74; ctx.fillText(date, W / 2, y); }
  }
  // a slightly worn, inked look
  const id = ctx.getImageData(0, 0, c.width, c.height), d = id.data;
  for (let i = 3; i < d.length; i += 4) if (d[i]) d[i] = Math.round(d[i] * (0.82 + Math.random() * 0.18));
  ctx.putImageData(id, 0, 0);
  return trimCanvas(c, 4) || c;
}
function renderStampPreview() { if (sigTab === 'create' && $('#stText').value.trim()) $('#stPreview').src = makeStamp().toDataURL('image/png'); }
['#stText', '#stSub', '#stDate', '#stDateVal', '#stShape', '#stColor'].forEach(id => $(id).addEventListener('input', () => { clearTimeout(renderStampPreview.t); renderStampPreview.t = setTimeout(renderStampPreview, 80); }));
$('#stDateVal').value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
$('#sigUse').onclick = async () => {
  const btn = $('#sigUse'); if (btn.disabled) return;
  btn.disabled = true;
  let c; try { c = await buildSignatureCanvas(); } finally { btn.disabled = false; }
  if (!c) return;
  const dataUrl = c.toDataURL('image/png');
  if ($('#sigRemember').checked) {
    const key = MODES[sigMode].key, sigs = store.get(key, []);
    if (!sigs.some(s => s.dataUrl === dataUrl)) {
      sigs.unshift({ dataUrl, w: c.width, h: c.height });
      if (!store.set(key, sigs.slice(0, 8))) toast("Couldn't remember it for next time (storage full). Remove an old one first.", true);
    }
  }
  useSignature(dataUrl, c.width, c.height);
};
function renderSavedSigs() {
  const key = MODES[sigMode].key, sigs = store.get(key, []);
  $('#savedSigsWrap').classList.toggle('hidden', !sigs.length);
  const box = $('#savedSigs'); box.innerHTML = '';
  sigs.forEach((s, i) => {
    const d = document.createElement('div'); d.className = 'savedsig'; d.title = 'Use this one';
    d.innerHTML = `<img src="${s.dataUrl}" alt="Saved"><button class="x" title="Forget this one">${DEL_SVG}</button>`;
    d.onclick = ev => {
      if (ev.target.closest('.x')) { ev.stopPropagation(); const all = store.get(key, []); all.splice(i, 1); store.set(key, all); renderSavedSigs(); return; }
      useSignature(s.dataUrl, s.w, s.h);
    };
    box.appendChild(d);
  });
}

/* ------------------------------------------------------------------ save */
async function buildPdf(pageList) {
  const { PDFDocument, degrees, StandardFonts, BlendMode } = PDFLib;
  const enc = pageList.map(p => state.sources.get(p.srcId)).filter(s => s.encrypted || s.libDocError);
  if (enc.length) {
    toast(`"${enc[0].name}" is protected or damaged, so it can't be re-saved. Remove its pages or use an unprotected copy.`, true, 7000);
    return null;
  }
  status('Building PDF…');
  try {
    const out = await PDFDocument.create();
    const stdFonts = new Map();
    const fontFor = async a => {
      const name = (FONTS[a.font] || FONTS.sans).std[(a.bold ? 1 : 0) + (a.italic ? 2 : 0)];
      if (!stdFonts.has(name)) stdFonts.set(name, await out.embedFont(StandardFonts[name]));
      return stdFonts.get(name);
    };
    // Chinese text: collect every character first so the embedded font contains only what's used
    let cjkEmb = null; const cjkLines = new Map();
    const realEmb = new Map(), realLines = new Map(); // edited text in its original font
    for (const p of pageList) for (const a of p.annots) if (a.type === 'text') {
      const rf = realFont(a);
      if (!rf && CJK.needs(a.text)) { await CJK.load(); if (!cjkEmb) cjkEmb = CJK.embedder(out); }
      if (a.w) relayout(a); // fonts are certainly loaded now
      if (rf) {
        if (!realEmb.has(rf.key)) realEmb.set(rf.key, window.PDFStudioSfnt.makeEmbedder(PDFLib, out, rf.f, rf.ps));
        const emb = realEmb.get(rf.key);
        realLines.set(a, { emb, lines: linesOf(a).map(l => emb.gids(l)) });
      } else if (CJK.needs(a.text)) cjkLines.set(a, linesOf(a).map(l => cjkEmb.gids(l)));
    }
    cjkEmb?.finish();
    for (const emb of realEmb.values()) emb.finish();
    const embedded = new Map();
    let replaced = false;
    const safe = (str, font) => [...str].map(ch => { try { font.encodeText(ch); return ch; } catch { replaced = true; return '?'; } }).join('');
    for (const p of pageList) {
      const src = state.sources.get(p.srcId);
      const [cp] = await out.copyPages(src.libDoc, [p.idx]);
      out.addPage(cp);
      const r = totalRot(p);
      cp.setRotation(degrees(r));
      if (!p.annots.length) continue;
      const vp = (await getPdfPage(p)).getViewport({ scale: 1, rotation: r });
      const toPdf = (x, y) => vp.convertToPdfPoint(x, y);
      // take the replaced originals out of the page itself (not just cover them)
      const coverBoxes = p.annots.filter(a => a.fromBlock && (a.cover || a.type === 'rect')).map(a => {
        const c = a.cover || a;
        const pts = [toPdf(c.x, c.y), toPdf(c.x + c.w, c.y + c.h), toPdf(c.x, c.y + c.h), toPdf(c.x + c.w, c.y)];
        return { x0: Math.min(...pts.map(q => q[0])), y0: Math.min(...pts.map(q => q[1])), x1: Math.max(...pts.map(q => q[0])), y1: Math.max(...pts.map(q => q[1])) };
      });
      if (coverBoxes.length) {
        try { window.PDFStudioRedact.removeCovered(out, cp, coverBoxes); }
        catch (e) { console.warn('Could not remove original content; it stays hidden under the cover', e); }
      }
      for (const a of p.annots) if (a.cover) { // patches hiding edited originals go underneath everything
        const c = a.cover, [x, y] = toPdf(c.x, c.y + c.h);
        cp.drawRectangle({ x, y, width: c.w, height: c.h, rotate: degrees(r), color: hexToRgb(c.color), borderWidth: 0 });
      }
      for (const a of p.annots) {
        if (a.type === 'rect') {
          const [x, y] = toPdf(a.x, a.y + a.h);
          cp.drawRectangle({ x, y, width: a.w, height: a.h, rotate: degrees(r), color: hexToRgb(a.color), opacity: a.opacity, borderWidth: 0,
            blendMode: a.kind === 'highlight' ? BlendMode.Multiply : undefined });
        } else if (a.type === 'image') {
          let img = embedded.get(a.imgId);
          if (!img) { img = await out.embedPng(state.images.get(a.imgId).dataUrl); embedded.set(a.imgId, img); }
          const [x, y] = toPdf(a.x, a.y + a.h);
          cp.drawImage(img, { x, y, width: a.w, height: a.h, rotate: degrees(r) });
        } else if (a.type === 'text') {
          const bl = baselineOf(a), lh = lhOf(a), glyphLines = cjkLines.get(a), real = realLines.get(a);
          const font = glyphLines || real ? null : await fontFor(a);
          linesOf(a).forEach((line, i) => {
            if (!line) return;
            const [x, y] = toPdf(a.x, a.y + a.size * (bl + lh * i));
            const opts = { x, y, size: a.size, color: hexToRgb(a.color), rotate: degrees(r) };
            if (real) real.emb.draw(cp, real.lines[i], opts);
            else if (glyphLines) cjkEmb.draw(cp, glyphLines[i], opts);
            else cp.drawText(safe(line, font), { ...opts, font });
          });
        }
      }
    }
    out.setProducer("Mike's PDF Studio"); out.setCreator("Mike's PDF Studio");
    const bytes = await out.save();
    if (replaced || cjkEmb?.missing) toast('A few characters (such as emoji or very rare symbols) aren\'t in the built-in fonts and were saved as "?".', true, 7000);
    status('Ready');
    return bytes;
  } catch (e) {
    console.error(e); status('Ready');
    toast('Saving failed: ' + (e.message || e), true, 7000);
    return null;
  }
}
async function writeFile(bytes, suggestedName, handle) {
  try {
    if (!handle && window.showSaveFilePicker) {
      handle = await window.showSaveFilePicker({ suggestedName, types: [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }] });
    }
    if (handle) {
      const w = await handle.createWritable(); await w.write(bytes); await w.close();
      return { handle, name: handle.name };
    }
  } catch (e) {
    if (e.name === 'AbortError') return null;
    console.warn('Save picker failed, falling back to download', e);
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: suggestedName });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return { handle: null, name: suggestedName };
}
async function save(asNew) {
  if (!state.pages.length) return;
  commitEditing();
  const bytes = await buildPdf(state.pages); if (!bytes) return;
  const base = (state.docName || 'Document.pdf').replace(/\.pdf$/i, '');
  const suggested = state.saveHandle ? state.docName : `${base} (edited).pdf`;
  const res = await writeFile(bytes, suggested, asNew ? null : state.saveHandle);
  if (!res) return;
  if (res.handle) { state.saveHandle = res.handle; state.docName = res.name; }
  setDirty(false); updatePageNav();
  toast(res.handle ? `Saved "${res.name}"` : `Downloaded "${res.name}" to your Downloads folder`);
}

/* ------------------------------------------------------------- toolbar */
$('#btnOpen').onclick = $('#btnOpenBig').onclick = () => $('#fileOpen').click();
$('#btnAdd').onclick = () => state.pages.length ? $('#fileAdd').click() : $('#fileOpen').click();
$('#fileOpen').onchange = e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) openFiles(f, false); };
$('#fileAdd').onchange = e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) openFiles(f, true); };
$('#btnSave').onclick = () => save(false);
$('#btnSaveAs').onclick = () => save(true);
$('#btnUndo').onclick = undo;
$('#btnRedo').onclick = redo;
$('#btnRotL').onclick = () => rotatePages(-90);
$('#btnRotR').onclick = () => rotatePages(90);
$('#btnDelPages').onclick = deletePages;
$('#btnExtract').onclick = extractPages;
function updateButtons() {
  const has = !!state.pages.length;
  ['#btnSave', '#btnSaveAs', '#btnRotL', '#btnRotR', '#btnDelPages', '#btnExtract', '#btnZoomIn', '#btnZoomOut'].forEach(s => $(s).disabled = !has);
  $('#btnUndo').disabled = !state.undo.length; $('#btnRedo').disabled = !state.redo.length;
  const n = state.selPages.size;
  $('#btnExtract').title = n > 1 ? `Save the ${n} selected pages as a new PDF (split)` : 'Save selected page(s) as a new PDF (split)';
}

/* -------------------------------------------------------------- keyboard */
document.addEventListener('keydown', e => {
  const typing = editing || !!document.activeElement?.matches?.('input[type=text],input:not([type]),textarea,select');
  const ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (!sigModal.classList.contains('hidden')) { if (e.key === 'Escape') closeSigModal(); return; }
  if (ctrl && k === 's') { e.preventDefault(); save(e.shiftKey); return; }
  if (ctrl && k === 'o') { e.preventDefault(); $('#fileOpen').click(); return; }
  if (editing) { if (e.key === 'Escape') { e.preventDefault(); commitEditing(); } return; }
  if (typing) return;
  if (ctrl && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (ctrl && k === 'y') { e.preventDefault(); redo(); return; }
  if (ctrl && (k === '=' || k === '+')) { e.preventDefault(); setZoom(state.zoom * 1.2); return; }
  if (ctrl && k === '-') { e.preventDefault(); setZoom(state.zoom / 1.2); return; }
  if (ctrl && k === '0') { e.preventDefault(); setZoom(fitWidthZoom()); return; }
  if (ctrl && k === 'a' && document.activeElement?.closest?.('#sidebar')) { e.preventDefault(); setSelection(state.pages.map(p => p.key)); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (state.selAnnot) { e.preventDefault(); deleteAnnot(state.selAnnot.key, state.selAnnot.id); }
    else if (state.selPages.size) { e.preventDefault(); deletePages(); }
    return;
  }
  if (e.key === 'Escape') { if (organizing()) { setOrganize(false); return; } selectAnnot(null); setSelection([]); setTool('select'); return; }
  if (state.selAnnot && e.key.startsWith('Arrow')) {
    e.preventDefault();
    const { p, a } = findAnnot(state.selAnnot.key, state.selAnnot.id);
    const step = e.shiftKey ? 10 : 1;
    pushUndo();
    if (e.key === 'ArrowLeft') a.x -= step; if (e.key === 'ArrowRight') a.x += step;
    if (e.key === 'ArrowUp') a.y -= step; if (e.key === 'ArrowDown') a.y += step;
    renderAnnots(p); selectAnnot(p.key, a.id); setDirty(); refreshThumbSoon(p.key);
    return;
  }
  if (!ctrl && !e.altKey && state.pages.length) {
    if (k === 'o') { setOrganize(!organizing()); return; }
    const map = { v: 'select', e: 'edit', t: 'text', w: 'whiteout', h: 'highlight' };
    if (map[k]) setTool(map[k]);
    if (k === 's') openSigModal('sign');
    if (k === 'k') openSigModal('stamp');
    if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      const i = state.pages.findIndex(p => p.key === state.currentKey) + (e.key === 'PageDown' ? 1 : -1);
      if (state.pages[i]) scrollToKey(state.pages[i].key);
    }
  }
});
$('#sidebar').tabIndex = -1;

/* ------------------------------------------------------- drag files in */
let dragDepth = 0;
const isFileDrag = e => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', e => { if (isFileDrag(e)) { dragDepth++; document.body.classList.add('dragover'); } });
window.addEventListener('dragleave', e => { if (isFileDrag(e) && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragover'); } });
window.addEventListener('dragover', e => { if (isFileDrag(e)) e.preventDefault(); });
window.addEventListener('drop', e => {
  if (!isFileDrag(e)) return;
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragover');
  const files = [...e.dataTransfer.files];
  if (files.length) openFiles(files, e.shiftKey && state.pages.length > 0);
});
window.addEventListener('beforeunload', e => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });

/* ------------------------------------------------------------------ init */
(async () => {
  document.body.dataset.tool = 'select';
  { const sz = store.get('pdfstudio.thumbSizes', null); if (Array.isArray(sz)) { state.thumbW = clamp(+sz[0] || 120, 70, 300); state.thumbBig = clamp(+sz[1] || 220, 70, 420); } }
  applyThumbSize(false);
  updateButtons(); updateTextOpts(); setDirty(false);
  status('Loading…');
  try { await initPdfjs(); status('Ready — open a PDF or drag one onto the window.'); setTimeout(() => CJK.load().catch(console.error), 500); }
  catch (e) { console.error(e); status('Error'); toast('PDF engine failed to start: ' + e.message, true, 10000); }
  // Files handed over by Windows ("Open with", double-clicking a PDF) when running as the installed app
  setTimeout(() => fillFontList().catch(console.error), 1500);
  if (window.pdfStudioHost) window.pdfStudioHost.onOpenFiles(list => {
    const files = list.map(f => new File([f.data], f.name, { type: 'application/pdf' }));
    openFiles(files, false);
  });
  window.__pdfstudio = { editInfo, state, openFiles, buildPdf, save, setTool, rotatePages, deletePages, setZoom, undo, redo, useSignature, addAnnot, pageByKey, ready: !!pdfjsLib };
})();
})();
