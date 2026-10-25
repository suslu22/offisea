// Sunum (PowerPoint) düzenleyicisi.
// Model değiştirilemez nesnelerden oluşur; geri alma yığını eski deste nesnelerine başvuru tutar.
// Metin düzenleme contenteditable ile yapılır; okunan her HTML DOMPurify'dan geçer.
import { h, tbtn, tsep, tselect, popupMenu, colorPicker, formDialog, toast, clear, icon, isMobileLayout, closeMenus } from '../core/ui.js';
import { sanitizeSlideHtml } from '../core/sanitize.js';
import { pickFile, normalizeImage } from '../core/files.js';
import { saveBlob, printElement, canPrint, isSafeUrl, openExternal } from '../core/platform.js';
import { usableFonts, previewFontOptions } from '../core/fonts.js';
import { pinchZoom } from '../core/pinch.js';
import { DEF_W, DEF_H, uid, LAYOUTS, SHAPES, newSlide, newDeck, normalizeDeck, renderSlide, renderItem, scaledSlide, htmlToText } from './model.js';

const FONTS = ['Calibri', 'Calibri Light', 'Arial', 'Segoe UI', 'Times New Roman', 'Georgia', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Courier New', 'Garamond', 'Century Gothic'];
const PT_SIZES = [8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 66, 72, 80, 88, 96];
const HANDLES = { nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0] };
const IMG_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/bmp';

const pxToPt = (px) => Math.round(px * 0.75 * 2) / 2;
const ptToPx = (pt) => Math.round((pt / 0.75) * 100) / 100;
const canText = (it) => !!it && (it.type === 'text' || (it.type === 'shape' && it.shape !== 'line'));
const isEmptyHtml = (html) => !htmlToText(html || '').trim();

function caretAt(x, y) {
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    if (p && p.offsetNode) { const r = document.createRange(); r.setStart(p.offsetNode, p.offset); r.collapse(true); return r; }
  }
  if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
  return null;
}

function selectContents(el, collapseToEnd = false) {
  const r = document.createRange();
  r.selectNodeContents(el);
  if (collapseToEnd) r.collapse(false);
  const s = document.getSelection();
  s.removeAllRanges();
  s.addRange(r);
}

// fontSize komutu yalnızca 1-7 arası değer alır; 7 ile işaretleyip gerçek piksel değerine çeviriyoruz.
function fixFontTags(container, px) {
  for (const f of container.querySelectorAll('font[size="7"]')) {
    const span = document.createElement('span');
    span.style.fontSize = px + 'px';
    if (f.getAttribute('color')) span.style.color = f.getAttribute('color');
    if (f.getAttribute('face')) span.style.fontFamily = f.getAttribute('face');
    span.append(...f.childNodes);
    f.replaceWith(span);
    for (const inner of span.querySelectorAll('[style*="font-size"]')) inner.style.fontSize = '';
  }
}

function applyFontSize(container, px) {
  document.execCommand('styleWithCSS', false, false);
  document.execCommand('fontSize', false, '7');
  document.execCommand('styleWithCSS', false, true);
  fixFontTags(container, px);
}

export async function mountSlides(root, data, app) {
  root.classList.add('editor', 'editor-slides');
  let deck = normalizeDeck(data && data.slides ? data : newDeck());
  let cur = 0;
  let sel = new Set();
  let editing = null; // { id, el, kind: 'text'|'table', startDeck, cells }
  const undoStack = [], redoStack = [];
  let clip = null, clipText = '';
  let zoomMode = 'fit', scale = 1;
  let slideEl = null, selLayer = null;
  const elMap = new Map();
  let lastFontPx = 32;
  let lastTap = { id: null, t: 0 };
  let show = null; // slayt gösterisi durumu
  let notesStart = null;
  let showNotes = !isMobileLayout();

  // ---- DOM ----------------------------------------------------------------------------------
  const toolbar = h('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Sunum araçları' });
  const thumbs = h('div', { class: 'slide-thumbs', role: 'listbox', 'aria-label': 'Slaytlar', tabindex: '0' });
  const stageHost = h('div', { class: 'stage-host' });
  const stageWrap = h('div', { class: 'stage-wrap', tabindex: '0', 'aria-label': 'Slayt düzenleme alanı' }, stageHost);
  const notes = h('textarea', { class: 'slide-notes', placeholder: 'Konuşmacı notlarını eklemek için tıklayın', 'aria-label': 'Konuşmacı notları', rows: '3', spellcheck: 'true' });
  const mainCol = h('div', { class: 'slides-main' }, stageWrap, notes);
  const body = h('div', { class: 'slides-body' }, thumbs, mainCol);
  const status = h('div', { class: 'statusbar' });
  root.append(toolbar, body, status);
  notes.hidden = !showNotes;

  // ---- Model yardımcıları -------------------------------------------------------------------
  const curSlide = () => deck.slides[cur];
  const item = (id) => curSlide().items.find((it) => it.id === id) || null;
  const selectedItems = () => curSlide().items.filter((it) => sel.has(it.id));

  function withSlide(slide, d = deck, index = cur) {
    const slides = d.slides.slice();
    slides[index] = slide;
    return { ...d, slides };
  }

  function commit(next, { push = true } = {}) {
    if (next === deck) return;
    if (push) {
      undoStack.push(deck);
      if (undoStack.length > 300) undoStack.shift();
      redoStack.length = 0;
    }
    deck = next;
    app.markDirty();
  }

  function updateItems(ids, fn, { render = true } = {}) {
    const slide = curSlide();
    let changed = false;
    const items = slide.items.map((it) => {
      if (!ids.has(it.id)) return it;
      const n = fn(it);
      if (n !== it) changed = true;
      return n;
    });
    if (!changed) return;
    commit(withSlide({ ...slide, items }));
    if (render) refresh();
  }

  function setItems(items) {
    commit(withSlide({ ...curSlide(), items }));
  }

  function refresh() {
    renderStage();
    renderThumbs();
    updateToolbar();
    updateStatus();
  }

  // ---- Sahne çizimi -------------------------------------------------------------------------
  function renderStage() {
    const slide = curSlide();
    clear(stageHost);
    elMap.clear();
    slideEl = renderSlide(slide, deck, { editor: true });
    slideEl.classList.add('slide-stage');
    for (const el of slideEl.children) if (el.dataset.id) elMap.set(el.dataset.id, el);
    for (const it of slide.items) if (it.lock && elMap.get(it.id)) elMap.get(it.id).classList.add('locked');
    selLayer = h('div', { class: 'sel-layer' });
    slideEl.append(selLayer);
    stageHost.append(slideEl);
    for (const id of [...sel]) if (!item(id)) sel.delete(id);
    applyScale();
    renderSel();
    if (document.activeElement !== notes) notes.value = slide.notes || '';
  }

  function applyScale() {
    if (!slideEl) return;
    if (zoomMode === 'fit') {
      const pad = isMobileLayout() ? 10 : 28;
      const aw = Math.max(40, stageWrap.clientWidth - pad * 2);
      const ah = Math.max(40, stageWrap.clientHeight - pad * 2);
      scale = Math.max(0.05, Math.min(aw / deck.w, ah / deck.h));
    } else scale = zoomMode;
    stageHost.style.width = deck.w * scale + 'px';
    stageHost.style.height = deck.h * scale + 'px';
    slideEl.style.transform = `scale(${scale})`;
    slideEl.style.transformOrigin = '0 0';
    selLayer.style.setProperty('--inv', String(1 / scale));
  }

  function placeBox(box, it) {
    box.style.left = it.x + 'px';
    box.style.top = it.y + 'px';
    box.style.width = Math.max(1, it.w) + 'px';
    box.style.height = Math.max(1, it.h) + 'px';
    box.style.transform = it.rot ? `rotate(${it.rot}deg)` : '';
  }

  function renderSel(override = null) {
    if (!selLayer) return;
    for (const b of selLayer.querySelectorAll('.sel-box')) b.remove();
    const items = override || selectedItems();
    for (const it of items) {
      const box = h('div', { class: 'sel-box' + (editing && editing.id === it.id ? ' editing' : '') + (it.type === 'shape' && it.shape === 'line' ? ' is-line' : '') });
      placeBox(box, it);
      if (items.length === 1 && !editing) {
        for (const k of Object.keys(HANDLES)) box.append(h('div', { class: 'handle h-' + k, dataset: { h: k } }));
        box.append(h('div', { class: 'rot-handle', dataset: { h: 'rot' }, title: 'Döndür' }));
      }
      selLayer.append(box);
    }
  }

  function setGuides(gx, gy) {
    for (const g of selLayer.querySelectorAll('.guide')) g.remove();
    if (gx != null) selLayer.append(h('div', { class: 'guide guide-v', style: { left: gx + 'px' } }));
    if (gy != null) selLayer.append(h('div', { class: 'guide guide-h', style: { top: gy + 'px' } }));
  }

  // ---- Küçük resimler -----------------------------------------------------------------------
  let thumbCache = new WeakMap();
  let thumbKey = '';
  function renderThumbs() {
    const tw = isMobileLayout() ? 104 : 164;
    const k = `${tw}:${deck.w}:${deck.h}`;
    if (k !== thumbKey) { thumbCache = new WeakMap(); thumbKey = k; }
    const keepScroll = [thumbs.scrollLeft, thumbs.scrollTop];
    clear(thumbs);
    deck.slides.forEach((s, i) => {
      let sc = thumbCache.get(s);
      if (!sc) { sc = scaledSlide(s, deck, tw); thumbCache.set(s, sc); }
      const t = h('div', {
        class: 'thumb' + (i === cur ? ' active' : ''), role: 'option', 'aria-selected': i === cur ? 'true' : 'false',
        'aria-label': `Slayt ${i + 1}`, dataset: { i: String(i) },
      }, h('span', { class: 'thumb-num' }, String(i + 1)), sc);
      if (s.notes) t.title = 'Notları var';
      thumbs.append(t);
    });
    const add = h('button', { class: 'thumb-add', type: 'button', title: 'Yeni slayt', 'aria-label': 'Yeni slayt' }, icon('plus'));
    add.addEventListener('click', (e) => layoutMenu(e.currentTarget));
    thumbs.append(add);
    thumbs.scrollLeft = keepScroll[0];
    thumbs.scrollTop = keepScroll[1];
    const act = thumbs.children[cur];
    if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  let thumbTimer = 0;
  function scheduleThumbs() {
    clearTimeout(thumbTimer);
    thumbTimer = setTimeout(renderThumbs, 450);
  }

  function goto(i) {
    if (editing) endEdit();
    i = Math.max(0, Math.min(deck.slides.length - 1, i));
    if (i === cur && slideEl) return;
    cur = i;
    sel = new Set();
    refresh();
  }

  // Küçük resim etkileşimleri: tıklama, sağ tık, fare ile sürükleyerek sıralama
  let thumbDrag = null;
  thumbs.addEventListener('pointerdown', (e) => {
    const t = e.target.closest('.thumb');
    if (!t) return;
    const i = +t.dataset.i;
    if (e.button === 2) return;
    if (e.pointerType === 'mouse') {
      thumbDrag = { i, x: e.clientX, y: e.clientY, active: false, to: i, id: e.pointerId };
    }
  });
  thumbs.addEventListener('pointermove', (e) => {
    if (!thumbDrag || thumbDrag.id !== e.pointerId) return;
    if (!thumbDrag.active && Math.hypot(e.clientX - thumbDrag.x, e.clientY - thumbDrag.y) > 8) {
      thumbDrag.active = true;
      thumbs.setPointerCapture(e.pointerId);
      thumbs.classList.add('reordering');
    }
    if (!thumbDrag.active) return;
    const list = Array.from(thumbs.querySelectorAll('.thumb'));
    const vertical = getComputedStyle(thumbs).flexDirection.startsWith('column');
    let to = list.length;
    for (let k = 0; k < list.length; k++) {
      const r = list[k].getBoundingClientRect();
      const mid = vertical ? r.top + r.height / 2 : r.left + r.width / 2;
      if ((vertical ? e.clientY : e.clientX) < mid) { to = k; break; }
    }
    thumbDrag.to = to;
    list.forEach((el, k) => {
      el.classList.toggle('drop-before', k === to);
      el.classList.toggle('drop-after', to === list.length && k === list.length - 1);
    });
  });
  const endThumbDrag = (e) => {
    if (!thumbDrag || thumbDrag.id !== e.pointerId) return;
    const d = thumbDrag;
    thumbDrag = null;
    thumbs.classList.remove('reordering');
    if (!d.active) { goto(d.i); return; }
    let to = d.to;
    if (to > d.i) to -= 1;
    if (to !== d.i) moveSlide(d.i, to);
    else renderThumbs();
  };
  thumbs.addEventListener('pointerup', endThumbDrag);
  thumbs.addEventListener('pointercancel', (e) => { if (thumbDrag && thumbDrag.id === e.pointerId) { thumbDrag = null; thumbs.classList.remove('reordering'); renderThumbs(); } });
  thumbs.addEventListener('click', (e) => {
    const t = e.target.closest('.thumb');
    if (t && !thumbDrag) goto(+t.dataset.i);
  });
  thumbs.addEventListener('contextmenu', (e) => {
    const t = e.target.closest('.thumb');
    if (!t) return;
    e.preventDefault();
    goto(+t.dataset.i);
    slideMenu({ x: e.clientX, y: e.clientY });
  });
  thumbs.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    let handled = true;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'PageDown') goto(cur + 1);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'PageUp') goto(cur - 1);
    else if (e.key === 'Home') goto(0);
    else if (e.key === 'End') goto(deck.slides.length - 1);
    else if (e.key === 'Delete' || e.key === 'Backspace') deleteSlide();
    else if (mod && e.key.toLowerCase() === 'd') duplicateSlide();
    else if (e.key === 'Enter') stageWrap.focus({ preventScroll: true });
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); thumbs.focus({ preventScroll: true }); }
  });

  // ---- Slayt işlemleri ----------------------------------------------------------------------
  function addSlide(layout) {
    if (editing) endEdit();
    const s = newSlide(layout, deck.w, deck.h);
    const base = curSlide();
    if (base && base.bg && base.bg !== '#ffffff') s.bg = base.bg;
    if (base && base.bgImg) s.bgImg = base.bgImg;
    const slides = deck.slides.slice();
    slides.splice(cur + 1, 0, s);
    commit({ ...deck, slides });
    cur += 1;
    sel = new Set();
    refresh();
  }

  function duplicateSlide() {
    if (editing) endEdit();
    const s = curSlide();
    const copy = { ...s, id: uid(), items: s.items.map((it) => ({ ...it, id: uid() })) };
    const slides = deck.slides.slice();
    slides.splice(cur + 1, 0, copy);
    commit({ ...deck, slides });
    cur += 1;
    sel = new Set();
    refresh();
  }

  function deleteSlide() {
    if (editing) endEdit();
    if (deck.slides.length <= 1) {
      commit(withSlide(newSlide('blank', deck.w, deck.h)));
      sel = new Set();
      refresh();
      return;
    }
    const slides = deck.slides.slice();
    slides.splice(cur, 1);
    commit({ ...deck, slides });
    cur = Math.min(cur, slides.length - 1);
    sel = new Set();
    refresh();
    toast('Slayt silindi.', { action: { label: 'Geri al', onClick: undo } });
  }

  function moveSlide(from, to) {
    if (to < 0 || to >= deck.slides.length || from === to) return;
    const slides = deck.slides.slice();
    const [s] = slides.splice(from, 1);
    slides.splice(to, 0, s);
    commit({ ...deck, slides });
    cur = to;
    sel = new Set();
    refresh();
  }

  function layoutMenu(anchor) {
    popupMenu(anchor, [
      { header: 'Yeni slayt düzeni' },
      ...LAYOUTS.map((l) => ({ label: l.label, icon: 'layout', onClick: () => addSlide(l.id) })),
    ]);
  }

  function slideMenu(at) {
    popupMenu(at, [
      { label: 'Yeni slayt', icon: 'plus', onClick: () => addSlide('content') },
      { label: 'Slaytı çoğalt', icon: 'duplicate', hint: 'Ctrl+D', onClick: duplicateSlide },
      { label: 'Slaytı sil', icon: 'trash', onClick: deleteSlide },
      { separator: true },
      { label: 'Yukarı taşı', icon: 'arrowUp', disabled: cur === 0, onClick: () => moveSlide(cur, cur - 1) },
      { label: 'Aşağı taşı', icon: 'arrowDown', disabled: cur === deck.slides.length - 1, onClick: () => moveSlide(cur, cur + 1) },
      { separator: true },
      { label: 'Arka plan rengi…', icon: 'fill', onClick: () => pickBg(at) },
      { label: 'Arka plan resmi…', icon: 'image', onClick: pickBgImage },
      curSlide().bgImg ? { label: 'Arka plan resmini kaldır', icon: 'close', onClick: () => setBg({ bgImg: undefined }) } : null,
      { label: 'Arka planı tüm slaytlara uygula', icon: 'check', onClick: bgToAll },
      { separator: true },
      { label: 'Bu slayttan başlat', icon: 'play', hint: 'Shift+F5', onClick: () => startShow(cur) },
    ]);
  }

  function setBg(patch) {
    if (editing) endEdit();
    commit(withSlide({ ...curSlide(), ...patch }));
    refresh();
  }

  function pickBg(anchor) {
    colorPicker(anchor, (c) => setBg({ bg: c || '#ffffff' }), { noneLabel: 'Beyaz (varsayılan)' });
  }

  async function pickBgImage() {
    const f = await pickFile(IMG_ACCEPT);
    if (!f) return;
    try {
      const { dataUrl } = await normalizeImage(f, 2400);
      setBg({ bgImg: dataUrl });
    } catch (err) { toast(err.message || 'Resim eklenemedi.', { type: 'error' }); }
  }

  function bgToAll() {
    const s = curSlide();
    commit({ ...deck, slides: deck.slides.map((x) => ({ ...x, bg: s.bg, bgImg: s.bgImg })) });
    refresh();
    toast('Arka plan tüm slaytlara uygulandı.', { type: 'success' });
  }

  async function slideSize() {
    const r = await formDialog('Slayt boyutu', [{
      name: 'size', label: 'Boyut', type: 'select', value: deck.w / deck.h > 1.5 ? '16:9' : '4:3',
      options: [{ value: '16:9', label: 'Geniş ekran (16:9)' }, { value: '4:3', label: 'Standart (4:3)' }, { value: '16:10', label: '16:10' }],
    }]);
    if (!r) return;
    const [nw, nh] = r.size === '4:3' ? [960, 720] : r.size === '16:10' ? [960, 600] : [DEF_W, DEF_H];
    if (nw === deck.w && nh === deck.h) return;
    if (editing) endEdit();
    const k = Math.min(nw / deck.w, nh / deck.h);
    const ox = (nw - deck.w * k) / 2, oy = (nh - deck.h * k) / 2;
    const slides = deck.slides.map((s) => ({
      ...s,
      items: s.items.map((it) => ({ ...it, x: it.x * k + ox, y: it.y * k + oy, w: it.w * k, h: it.h * k })),
    }));
    commit({ ...deck, w: nw, h: nh, slides });
    refresh();
  }

  // ---- Öğe ekleme ---------------------------------------------------------------------------
  function addItems(items, { edit = false } = {}) {
    if (editing) endEdit();
    setItems([...curSlide().items, ...items]);
    sel = new Set(items.map((i) => i.id));
    refresh();
    if (edit && items.length === 1) startEdit(items[0].id);
    else stageWrap.focus({ preventScroll: true });
  }

  function insertTextBox() {
    const w = Math.min(480, deck.w * 0.6), hh = 56;
    addItems([{ id: uid(), type: 'text', x: (deck.w - w) / 2, y: (deck.h - hh) / 2, w, h: hh, fs: 24, html: '', autoH: true }], { edit: true });
  }

  function insertShape(shape) {
    const isLine = shape === 'line';
    const w = isLine ? 240 : 200, hh = isLine ? 1 : shape === 'rightArrow' ? 100 : 150;
    const it = { id: uid(), type: 'shape', shape, x: (deck.w - w) / 2, y: (deck.h - hh) / 2, w, h: hh, html: '' };
    if (isLine) Object.assign(it, { stroke: '#4472c4', strokeW: 3 });
    else Object.assign(it, { fill: '#4472c4', stroke: '#2f528f', strokeW: 1 });
    addItems([it]);
  }

  async function insertImageFile(file) {
    try {
      const { dataUrl, width, height } = await normalizeImage(file, 2400);
      const k = Math.min(1, (deck.w * 0.7) / width, (deck.h * 0.7) / height);
      const w = width * k, hh = height * k;
      addItems([{ id: uid(), type: 'image', x: (deck.w - w) / 2, y: (deck.h - hh) / 2, w, h: hh, src: dataUrl }]);
    } catch (err) { toast(err.message || 'Resim eklenemedi.', { type: 'error' }); }
  }

  async function insertImage() {
    const f = await pickFile(IMG_ACCEPT);
    if (f) insertImageFile(f);
  }

  async function insertTable() {
    const r = await formDialog('Tablo ekle', [
      { name: 'rows', label: 'Satır sayısı', type: 'number', value: 3, min: 1, max: 30 },
      { name: 'cols', label: 'Sütun sayısı', type: 'number', value: 3, min: 1, max: 15 },
    ], { okLabel: 'Ekle' });
    if (!r) return;
    const rows = Math.max(1, Math.min(30, parseInt(r.rows, 10) || 3));
    const cols = Math.max(1, Math.min(15, parseInt(r.cols, 10) || 3));
    const w = Math.min(deck.w - 80, cols * 170);
    const hh = Math.min(deck.h - 80, rows * 42);
    addItems([{
      id: uid(), type: 'table', x: (deck.w - w) / 2, y: (deck.h - hh) / 2, w, h: hh, fs: 18, header: true, banded: true,
      rows: Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ html: '' }))),
      colW: Array.from({ length: cols }, () => w / cols),
    }]);
  }

  function shapeMenu(anchor) {
    popupMenu(anchor, [{ header: 'Şekil ekle' }, ...SHAPES.map((s) => ({ label: s.label, icon: s.icon, onClick: () => insertShape(s.id) }))]);
  }

  function insertMenu(anchor) {
    popupMenu(anchor, [
      { label: 'Metin kutusu', icon: 'textbox', onClick: insertTextBox },
      { label: 'Resim…', icon: 'image', onClick: insertImage },
      { label: 'Tablo…', icon: 'table', onClick: insertTable },
      { separator: true },
      { header: 'Şekiller' },
      ...SHAPES.map((s) => ({ label: s.label, icon: s.icon, onClick: () => insertShape(s.id) })),
    ]);
  }

  // ---- Seçili öğeler üzerinde işlemler --------------------------------------------------------
  function deleteSelected() {
    if (!sel.size) return;
    setItems(curSlide().items.filter((it) => !sel.has(it.id)));
    sel = new Set();
    refresh();
  }

  function duplicateSelected() {
    const its = selectedItems();
    if (!its.length) return;
    const copies = its.map((it) => ({ ...it, id: uid(), x: it.x + 20, y: it.y + 20, lock: undefined }));
    addItems(copies);
  }

  function copySelected() {
    const its = selectedItems();
    if (!its.length) return false;
    clip = its.map((it) => ({ ...it }));
    clipText = its.map((it) => (it.type === 'table' ? it.rows.map((r) => r.map((c) => htmlToText(c.html)).join('\t')).join('\n') : htmlToText(it.html || ''))).filter(Boolean).join('\n') || '[Offisea slayt nesneleri]';
    return true;
  }

  function pasteItems() {
    if (!clip) return;
    const existing = new Set(curSlide().items.map((i) => i.id));
    const shift = clip.some((c) => existing.has(c.id)) ? 20 : 0;
    const copies = clip.map((it) => ({ ...it, id: uid(), x: it.x + shift, y: it.y + shift, lock: undefined }));
    clip = copies.map((c) => ({ ...c })); // art arda yapıştırmalar kaysın
    addItems(copies);
  }

  function arrange(mode) {
    const items = curSlide().items.slice();
    const isSel = (it) => sel.has(it.id);
    let out;
    if (mode === 'front') out = [...items.filter((i) => !isSel(i)), ...items.filter(isSel)];
    else if (mode === 'back') out = [...items.filter(isSel), ...items.filter((i) => !isSel(i))];
    else if (mode === 'forward') {
      out = items;
      for (let i = out.length - 2; i >= 0; i--) if (isSel(out[i]) && !isSel(out[i + 1])) [out[i], out[i + 1]] = [out[i + 1], out[i]];
    } else {
      out = items;
      for (let i = 1; i < out.length; i++) if (isSel(out[i]) && !isSel(out[i - 1])) [out[i], out[i - 1]] = [out[i - 1], out[i]];
    }
    setItems(out);
    refresh();
  }

  function alignSel(mode) {
    const its = selectedItems();
    if (!its.length) return;
    let bx = 0, by = 0, bw = deck.w, bh = deck.h;
    if (its.length > 1) {
      bx = Math.min(...its.map((i) => i.x)); by = Math.min(...its.map((i) => i.y));
      bw = Math.max(...its.map((i) => i.x + i.w)) - bx; bh = Math.max(...its.map((i) => i.y + i.h)) - by;
    }
    updateItems(sel, (it) => {
      const n = { ...it };
      if (mode === 'left') n.x = bx;
      else if (mode === 'hcenter') n.x = bx + (bw - it.w) / 2;
      else if (mode === 'right') n.x = bx + bw - it.w;
      else if (mode === 'top') n.y = by;
      else if (mode === 'vmiddle') n.y = by + (bh - it.h) / 2;
      else if (mode === 'bottom') n.y = by + bh - it.h;
      return n;
    });
  }

  function arrangeMenu(anchor) {
    const none = !sel.size;
    popupMenu(anchor, [
      { label: 'En öne getir', icon: 'front', disabled: none, onClick: () => arrange('front') },
      { label: 'Öne getir', icon: 'front', disabled: none, onClick: () => arrange('forward') },
      { label: 'Geriye gönder', icon: 'backward', disabled: none, onClick: () => arrange('backward') },
      { label: 'En arkaya gönder', icon: 'backward', disabled: none, onClick: () => arrange('back') },
      { separator: true },
      { header: sel.size > 1 ? 'Birbirine göre hizala' : 'Slayta göre hizala' },
      { label: 'Sola hizala', icon: 'alignLeft', disabled: none, onClick: () => alignSel('left') },
      { label: 'Yatay ortala', icon: 'alignCenter', disabled: none, onClick: () => alignSel('hcenter') },
      { label: 'Sağa hizala', icon: 'alignRight', disabled: none, onClick: () => alignSel('right') },
      { label: 'Üste hizala', icon: 'valignTop', disabled: none, onClick: () => alignSel('top') },
      { label: 'Dikey ortala', icon: 'valignMiddle', disabled: none, onClick: () => alignSel('vmiddle') },
      { label: 'Alta hizala', icon: 'valignBottom', disabled: none, onClick: () => alignSel('bottom') },
      { separator: true },
      { label: 'Sağa 90° döndür', icon: 'redo', disabled: none, onClick: () => updateItems(sel, (it) => ({ ...it, rot: (((it.rot || 0) + 90) % 360) })) },
      { label: 'Yatay çevir', icon: 'duplicate', disabled: none, onClick: () => updateItems(sel, (it) => ({ ...it, flipH: !it.flipH })) },
      { label: 'Dikey çevir', icon: 'duplicate', disabled: none, onClick: () => updateItems(sel, (it) => ({ ...it, flipV: !it.flipV })) },
      { label: 'Döndürmeyi sıfırla', icon: 'undo', disabled: none, onClick: () => updateItems(sel, (it) => ({ ...it, rot: 0, flipH: false, flipV: false })) },
      { separator: true },
      { label: 'Saydamlık…', icon: 'palette', disabled: none, onClick: opacityDialog },
    ]);
  }

  async function opacityDialog() {
    const first = selectedItems()[0];
    if (!first) return;
    const r = await formDialog('Saydamlık', [{
      name: 'o', label: 'Görünürlük', type: 'select', value: String(Math.round((first.opacity ?? 1) * 100)),
      options: [100, 90, 75, 60, 50, 40, 25, 10].map((v) => ({ value: String(v), label: '%' + v })),
    }]);
    if (!r) return;
    const o = Math.max(0.05, Math.min(1, +r.o / 100));
    updateItems(sel, (it) => ({ ...it, opacity: o >= 1 ? undefined : o }));
  }

  // ---- Tablo işlemleri ----------------------------------------------------------------------
  function tableOp(op) {
    const its = selectedItems().filter((i) => i.type === 'table');
    if (!its.length) return;
    let at = null;
    if (editing && editing.kind === 'table') {
      const s = document.getSelection();
      const td = s && s.anchorNode && (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement).closest('td');
      const m = td && editing.cells.find((c) => c[0] === td);
      if (m) at = { r: m[1], c: m[2] };
      endEdit();
    }
    updateItems(new Set(its.map((i) => i.id)), (t) => {
      const rows = t.rows.map((r) => r.map((c) => ({ ...c })));
      const nCols = rows[0] ? rows[0].length : 1;
      const r = at ? at.r : rows.length - 1;
      const c = at ? at.c : nCols - 1;
      let colW = Array.isArray(t.colW) && t.colW.length === nCols ? t.colW.slice() : Array.from({ length: nCols }, () => t.w / nCols);
      let hgt = t.h;
      const rowH = t.h / Math.max(1, rows.length);
      // Birleştirilmiş hücreler satır/sütun ekleyip silerken bozulmasın diye çözülür.
      for (const row of rows) for (const cell of row) { delete cell.hidden; delete cell.colSpan; delete cell.rowSpan; }
      if (op === 'rowBelow') { rows.splice(r + 1, 0, Array.from({ length: nCols }, () => ({ html: '' }))); hgt += rowH; }
      else if (op === 'rowAbove') { rows.splice(r, 0, Array.from({ length: nCols }, () => ({ html: '' }))); hgt += rowH; }
      else if (op === 'colRight' || op === 'colLeft') {
        if (nCols >= 30) return t;
        const at2 = op === 'colRight' ? c + 1 : c;
        for (const row of rows) row.splice(at2, 0, { html: '' });
        const wNew = t.w / nCols;
        colW.splice(at2, 0, wNew);
        const total = colW.reduce((a, b) => a + b, 0);
        colW = colW.map((w) => (w / total) * t.w);
      } else if (op === 'delRow') {
        if (rows.length <= 1) return t;
        rows.splice(r, 1); hgt = Math.max(20, hgt - rowH);
      } else if (op === 'delCol') {
        if (nCols <= 1) return t;
        for (const row of rows) row.splice(c, 1);
        colW.splice(c, 1);
        const total = colW.reduce((a, b) => a + b, 0);
        colW = colW.map((w) => (w / total) * t.w);
      }
      return { ...t, rows, colW, h: hgt };
    });
  }

  // ---- Metin düzenleme ----------------------------------------------------------------------
  function startEdit(id, pt = null) {
    const it = item(id);
    if (!it || it.lock) return;
    const el = elMap.get(id);
    if (!el) return;
    document.execCommand('defaultParagraphSeparator', false, 'p');
    if (it.type === 'table') {
      const tds = Array.from(el.querySelectorAll('td'));
      const cells = [];
      let k = 0;
      it.rows.forEach((row, ri) => row.forEach((cell, ci) => { if (cell && !cell.hidden && tds[k]) { cells.push([tds[k], ri, ci]); k++; } }));
      for (const [td] of cells) { td.contentEditable = 'true'; td.spellcheck = true; }
      editing = { id, el: el.querySelector('table'), kind: 'table', startDeck: deck, cells };
      el.classList.add('is-editing');
      sel = new Set([id]);
      renderSel();
      const hit = pt && pt.clientX != null ? document.elementFromPoint(pt.clientX, pt.clientY) : null;
      const hitTd = hit && hit.closest && hit.closest('td');
      const target = (hitTd && el.contains(hitTd) ? hitTd : null) || (cells[0] && cells[0][0]);
      if (target) { target.focus({ preventScroll: true }); placeCaret(target, pt); }
      updateToolbar();
      return;
    }
    if (!canText(it)) return;
    const content = el.querySelector('.text-content');
    if (!content) return;
    content.classList.remove('is-empty');
    delete content.dataset.ph;
    content.contentEditable = 'true';
    content.spellcheck = true;
    editing = { id, el: content, kind: 'text', startDeck: deck };
    el.classList.add('is-editing');
    sel = new Set([id]);
    renderSel();
    content.focus({ preventScroll: true });
    if (!content.textContent.trim() && !content.querySelector('li')) {
      clear(content);
      const p = document.createElement('p');
      p.append(document.createElement('br'));
      content.append(p);
      const r = document.createRange();
      r.setStart(p, 0);
      r.collapse(true);
      const s = document.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    } else placeCaret(content, pt);
    updateToolbar();
  }

  function placeCaret(container, pt) {
    let r = pt && pt.clientX != null ? caretAt(pt.clientX, pt.clientY) : null;
    if (r && !container.contains(r.startContainer)) r = null;
    if (r) {
      const s = document.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    } else selectContents(container, !!pt);
  }

  function readEditHtml() {
    const it = item(editing.id);
    if (!it) return null;
    if (editing.kind === 'table') {
      const rows = it.rows.map((r) => r.slice());
      let changed = false;
      for (const [td, ri, ci] of editing.cells) {
        fixFontTags(td, lastFontPx);
        const html = sanitizeSlideHtml(td.innerHTML);
        if ((rows[ri][ci].html || '') !== html) { rows[ri][ci] = { ...rows[ri][ci], html }; changed = true; }
      }
      return changed ? { ...it, rows } : it;
    }
    fixFontTags(editing.el, lastFontPx);
    let html = sanitizeSlideHtml(editing.el.innerHTML);
    if (isEmptyHtml(html) && !/<(li|img)/i.test(html)) html = '';
    let next = it;
    if ((it.html || '') !== html) next = { ...next, html };
    const list = editing.el.classList.contains('as-list');
    if (!!it.list !== list) next = { ...next, list };
    // Kendiliğinden büyüyen metin kutuları
    if (it.type === 'text' && (it.autoH || !it.ph)) {
      const box = elMap.get(it.id);
      if (box) {
        const need = Math.ceil(box.scrollHeight);
        if (need > it.h + 1) { next = { ...next, h: need }; box.style.height = need + 'px'; }
      }
    }
    return next;
  }

  function syncEdit() {
    if (!editing) return;
    const next = readEditHtml();
    const it = item(editing.id);
    if (!next || next === it) return;
    const slide = curSlide();
    commit(withSlide({ ...slide, items: slide.items.map((x) => (x.id === it.id ? next : x)) }), { push: false });
    renderSel();
    scheduleThumbs();
  }

  let syncTimer = 0;
  function onEditInput() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncEdit, 250);
  }

  function endEdit() {
    if (!editing) return;
    clearTimeout(syncTimer);
    syncEdit();
    const { startDeck, id } = editing;
    if (editing.kind === 'table') for (const [td] of editing.cells) td.contentEditable = 'false';
    else editing.el.contentEditable = 'false';
    editing = null;
    const it = item(id);
    // Boş bırakılan yeni metin kutusu kaldırılır (PowerPoint davranışı)
    if (it && it.type === 'text' && !it.ph && isEmptyHtml(it.html)) {
      const slide = curSlide();
      deck = withSlide({ ...slide, items: slide.items.filter((x) => x.id !== id) });
      sel.delete(id);
    }
    if (deck !== startDeck) { undoStack.push(startDeck); redoStack.length = 0; app.markDirty(); }
    const s = document.getSelection();
    if (s) s.removeAllRanges();
    renderStage();
    renderThumbs();
    updateToolbar();
  }

  stageWrap.addEventListener('input', (e) => { if (editing && editing.el.contains(e.target)) onEditInput(); });

  stageWrap.addEventListener('paste', (e) => {
    if (!editing) return;
    e.preventDefault();
    e.stopPropagation();
    const cd = e.clipboardData;
    if (!cd) return;
    const imgItem = Array.from(cd.items || []).find((i) => i.kind === 'file' && /^image\//.test(i.type));
    if (imgItem && !cd.getData('text/plain')) { const f = imgItem.getAsFile(); endEdit(); if (f) insertImageFile(f); return; }
    const html = cd.getData('text/html');
    if (html) document.execCommand('insertHTML', false, sanitizeSlideHtml(html));
    else document.execCommand('insertText', false, cd.getData('text/plain') || '');
    onEditInput();
  });

  stageWrap.addEventListener('dragover', (e) => { if (editing) e.preventDefault(); });
  stageWrap.addEventListener('drop', (e) => {
    // Düzenleme sırasında sürüklenen zengin içerik doğrudan eklenmez.
    if (!editing) return;
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) return; // dosyalar uygulama kabuğunda işlenir
    e.preventDefault();
    const text = e.dataTransfer ? e.dataTransfer.getData('text/plain') : '';
    if (text) { document.execCommand('insertText', false, text); onEditInput(); }
  });

  // Bağlantılar düzenleyicide gezinmez; Ctrl+tıklama ile güvenli şekilde dışarıda açılır.
  stageWrap.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    if ((e.ctrlKey || e.metaKey) && isSafeUrl(a.getAttribute('href') || '')) openExternal(a.getAttribute('href'));
  });

  // ---- Fare / dokunma ile seçme, taşıma, boyutlandırma ---------------------------------------
  function toSlide(e) {
    const r = slideEl.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  }

  let longPress = 0;
  let cancelTrack = null; // süren sürükleme (taşıma, boyutlandırma, seçim kutusu) varsa iptal eder
  const touches = new Set();
  const dropTouch = (e) => touches.delete(e.pointerId);
  stageWrap.addEventListener('pointerup', dropTouch, true);
  stageWrap.addEventListener('pointercancel', dropTouch, true);
  stageWrap.addEventListener('pointerdown', (e) => {
    if (show || !slideEl) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.pointerType === 'touch') {
      touches.add(e.pointerId);
      // İkinci parmak: iki parmakla yakınlaştırma başlıyor; tek parmakla başlayan işi bırak.
      if (touches.size > 1) { clearTimeout(longPress); longPress = 0; if (cancelTrack) cancelTrack(); return; }
    }
    const t = e.target;
    if (editing) {
      if (editing.el.contains(t)) return; // metin içinde imleç ve seçim serbest
      endEdit();
    }
    e.preventDefault();
    stageWrap.focus({ preventScroll: true });
    closeMenus();
    clearTimeout(longPress);
    if (e.pointerType === 'touch') {
      longPress = setTimeout(() => { longPress = -1; openContextMenu({ x: e.clientX, y: e.clientY }, t); }, 550);
    }
    const handle = t.closest && t.closest('[data-h]');
    if (handle && selLayer.contains(handle)) { startHandleDrag(e, handle.dataset.h); return; }
    const itEl = t.closest && t.closest('.slide-item');
    if (itEl && slideEl.contains(itEl) && !itEl.classList.contains('locked') && item(itEl.dataset.id)) {
      const id = itEl.dataset.id;
      const now = Date.now();
      const isDouble = lastTap.id === id && now - lastTap.t < 420;
      lastTap = { id, t: now };
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        if (sel.has(id)) sel.delete(id); else sel.add(id);
        renderSel();
        updateToolbar();
        return;
      }
      const wasSelected = sel.has(id) && sel.size === 1;
      if (!sel.has(id)) { sel = new Set([id]); renderSel(); updateToolbar(); }
      startMove(e, { id, wasSelected, isDouble });
      return;
    }
    if (!e.shiftKey) { sel = new Set(); renderSel(); updateToolbar(); }
    if (e.pointerType === 'touch' && zoomMode !== 'fit') { startPan(e); return; }
    startMarquee(e);
  });

  // Yakınlaştırılmışken boş alanda tek parmakla kaydırma
  function startPan(e) {
    const sx = e.clientX, sy = e.clientY, l0 = stageWrap.scrollLeft, t0 = stageWrap.scrollTop;
    trackPointer(e, (ev) => {
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 6) clearTimeout(longPress);
      stageWrap.scrollLeft = l0 - (ev.clientX - sx);
      stageWrap.scrollTop = t0 - (ev.clientY - sy);
    }, () => {});
  }

  stageWrap.addEventListener('contextmenu', (e) => {
    if (editing && editing.el.contains(e.target)) return; // metin içinde tarayıcı menüsü (yazım denetimi)
    e.preventDefault();
    if (longPress === -1) return;
    const itEl = e.target.closest('.slide-item');
    if (itEl && !itEl.classList.contains('locked') && !sel.has(itEl.dataset.id)) { sel = new Set([itEl.dataset.id]); renderSel(); updateToolbar(); }
    openContextMenu({ x: e.clientX, y: e.clientY }, e.target);
  });

  function trackPointer(e, onMove, onUp) {
    const pid = e.pointerId;
    try { stageWrap.setPointerCapture(pid); } catch { /* yok say */ }
    const mv = (ev) => { if (ev.pointerId === pid) onMove(ev); };
    const up = (ev) => {
      if (ev.pointerId !== pid) return;
      cancelTrack = null;
      stageWrap.removeEventListener('pointermove', mv);
      stageWrap.removeEventListener('pointerup', up);
      stageWrap.removeEventListener('pointercancel', up);
      clearTimeout(longPress);
      if (longPress === -1) { longPress = 0; onUp(ev, true); return; }
      onUp(ev, ev.type === 'pointercancel');
    };
    stageWrap.addEventListener('pointermove', mv);
    stageWrap.addEventListener('pointerup', up);
    stageWrap.addEventListener('pointercancel', up);
    cancelTrack = () => up({ pointerId: pid, type: 'pointercancel', clientX: e.clientX, clientY: e.clientY });
  }

  function snapTargets() {
    const xs = [0, deck.w / 2, deck.w], ys = [0, deck.h / 2, deck.h];
    for (const it of curSlide().items) {
      if (sel.has(it.id)) continue;
      xs.push(it.x, it.x + it.w / 2, it.x + it.w);
      ys.push(it.y, it.y + it.h / 2, it.y + it.h);
    }
    return { xs, ys };
  }

  function snapDelta(boxes, dx, dy, targets, off) {
    const thr = 6 / scale;
    const bx = Math.min(...boxes.map((b) => b.x)) + dx, by = Math.min(...boxes.map((b) => b.y)) + dy;
    const bw = Math.max(...boxes.map((b) => b.x + b.w)) + dx - bx, bh = Math.max(...boxes.map((b) => b.y + b.h)) + dy - by;
    let gx = null, gy = null, bestX = thr, bestY = thr, adjX = 0, adjY = 0;
    if (!off) {
      for (const p of [bx, bx + bw / 2, bx + bw]) for (const t of targets.xs) { const d = Math.abs(p - t); if (d < bestX) { bestX = d; adjX = t - p; gx = t; } }
      for (const p of [by, by + bh / 2, by + bh]) for (const t of targets.ys) { const d = Math.abs(p - t); if (d < bestY) { bestY = d; adjY = t - p; gy = t; } }
    }
    return { dx: dx + adjX, dy: dy + adjY, gx, gy };
  }

  function startMove(e, { id, wasSelected, isDouble }) {
    const start = toSlide(e);
    const sx = e.clientX, sy = e.clientY;
    const orig = selectedItems().map((it) => ({ ...it }));
    const targets = snapTargets();
    let moved = false, last = null;
    trackPointer(e, (ev) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < (ev.pointerType === 'touch' ? 8 : 3)) return;
      if (!moved) { moved = true; clearTimeout(longPress); }
      const p = toSlide(ev);
      const s = snapDelta(orig, p.x - start.x, p.y - start.y, targets, ev.altKey);
      last = orig.map((o) => ({ ...o, x: Math.round((o.x + s.dx) * 10) / 10, y: Math.round((o.y + s.dy) * 10) / 10 }));
      for (const n of last) { const el = elMap.get(n.id); if (el) { el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; } }
      renderSel(last);
      setGuides(s.gx, s.gy);
    }, (ev, cancelled) => {
      setGuides(null, null);
      if (cancelled) { renderStage(); return; }
      if (moved && last) {
        const map = new Map(last.map((n) => [n.id, n]));
        updateItems(new Set(map.keys()), (it) => ({ ...it, x: map.get(it.id).x, y: map.get(it.id).y }));
        return;
      }
      const it = item(id);
      if ((wasSelected || isDouble) && it && (canText(it) || it.type === 'table')) startEdit(id, ev);
    });
  }

  function startHandleDrag(e, hk) {
    const its = selectedItems();
    if (its.length !== 1) return;
    const o = { ...its[0] };
    const start = toSlide(e);
    const cx0 = o.x + o.w / 2, cy0 = o.y + o.h / 2;
    const rad = ((o.rot || 0) * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const isLine = o.type === 'shape' && o.shape === 'line';
    const min = isLine ? 0 : 8;
    let next = null;
    trackPointer(e, (ev) => {
      clearTimeout(longPress);
      const p = toSlide(ev);
      if (hk === 'rot') {
        let ang = (Math.atan2(p.y - cy0, p.x - cx0) * 180) / Math.PI + 90;
        if (ev.shiftKey) ang = Math.round(ang / 15) * 15;
        else { const r90 = Math.round(ang / 90) * 90; if (Math.abs(ang - r90) < 4) ang = r90; }
        ang = ((Math.round(ang * 10) / 10) % 360 + 360) % 360;
        next = { ...o, rot: ang };
      } else {
        const [dx, dy] = HANDLES[hk];
        const gx = p.x - start.x, gy = p.y - start.y;
        const lx = gx * cos + gy * sin, ly = -gx * sin + gy * cos;
        let w = o.w + dx * lx, hh = o.h + dy * ly;
        const keep = dx && dy && (o.type === 'image' || ev.shiftKey) && o.w > 0 && o.h > 0;
        if (keep) {
          const ratio = o.w / o.h;
          if (Math.abs(w / o.w) > Math.abs(hh / o.h)) hh = w / ratio; else w = hh * ratio;
        }
        w = Math.max(min, w); hh = Math.max(min, hh);
        if (!isLine && !keep && !ev.altKey && !rad) {
          // kenarları slayt kenarlarına ve ortasına yasla
          const thr = 6 / scale;
          if (dx === 1) { const e2 = o.x + w; for (const t of [deck.w, deck.w / 2]) if (Math.abs(e2 - t) < thr) w = t - o.x; }
          if (dx === -1) { const x1 = o.x + o.w - w; for (const t of [0, deck.w / 2]) if (Math.abs(x1 - t) < thr) w = o.x + o.w - t; }
          if (dy === 1) { const e2 = o.y + hh; for (const t of [deck.h, deck.h / 2]) if (Math.abs(e2 - t) < thr) hh = t - o.y; }
          if (dy === -1) { const y1 = o.y + o.h - hh; for (const t of [0, deck.h / 2]) if (Math.abs(y1 - t) < thr) hh = o.y + o.h - t; }
        }
        const sx = (dx * (w - o.w)) / 2, sy = (dy * (hh - o.h)) / 2;
        const cx = cx0 + sx * cos - sy * sin, cy = cy0 + sx * sin + sy * cos;
        next = { ...o, x: Math.round((cx - w / 2) * 10) / 10, y: Math.round((cy - hh / 2) * 10) / 10, w: Math.round(w * 10) / 10, h: Math.round(hh * 10) / 10 };
        if (o.type === 'table' && Array.isArray(o.colW)) {
          const total = o.colW.reduce((a, b) => a + b, 0) || 1;
          next.colW = o.colW.map((c) => (c / total) * next.w);
        }
      }
      const old = elMap.get(o.id);
      const nu = renderItem(next, { editor: true });
      if (old) old.replaceWith(nu);
      elMap.set(o.id, nu);
      renderSel([next]);
    }, (ev, cancelled) => {
      if (cancelled || !next) { renderStage(); return; }
      const fin = next;
      updateItems(new Set([o.id]), () => fin);
    });
  }

  function startMarquee(e) {
    const start = toSlide(e);
    const box = h('div', { class: 'marquee' });
    let rect = null;
    trackPointer(e, (ev) => {
      const p = toSlide(ev);
      rect = { x: Math.min(p.x, start.x), y: Math.min(p.y, start.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
      if (rect.w * scale < 4 && rect.h * scale < 4) return;
      clearTimeout(longPress);
      if (!box.parentNode) selLayer.append(box);
      placeBox(box, rect);
    }, () => {
      box.remove();
      if (!rect || (rect.w * scale < 4 && rect.h * scale < 4)) return;
      for (const it of curSlide().items) {
        if (it.lock) continue;
        if (it.x < rect.x + rect.w && it.x + it.w > rect.x && it.y < rect.y + rect.h && it.y + it.h > rect.y) sel.add(it.id);
      }
      renderSel();
      updateToolbar();
    });
  }

  function openContextMenu(at, target) {
    const its = selectedItems();
    const lockedHere = curSlide().items.some((i) => i.lock);
    const table = its.length === 1 && its[0].type === 'table';
    const items = [];
    if (its.length) {
      items.push(
        { label: 'Kes', icon: 'cut', hint: 'Ctrl+X', onClick: () => { if (copySelected()) deleteSelected(); } },
        { label: 'Kopyala', icon: 'copy', hint: 'Ctrl+C', onClick: copySelected },
      );
    }
    items.push({ label: 'Yapıştır', icon: 'paste', hint: 'Ctrl+V', disabled: !clip, onClick: pasteItems });
    if (its.length) {
      items.push(
        { label: 'Çoğalt', icon: 'duplicate', hint: 'Ctrl+D', onClick: duplicateSelected },
        { label: 'Sil', icon: 'trash', hint: 'Del', onClick: deleteSelected },
      );
      if (its.length === 1 && (canText(its[0]) || table)) items.push({ label: 'Metni düzenle', icon: 'textbox', hint: 'F2', onClick: () => startEdit(its[0].id) });
      items.push({ separator: true },
        { label: 'En öne getir', icon: 'front', onClick: () => arrange('front') },
        { label: 'En arkaya gönder', icon: 'backward', onClick: () => arrange('back') },
        { label: 'Düzenle ve hizala…', icon: 'layout', onClick: () => arrangeMenu(at) });
    }
    if (table) {
      items.push({ separator: true }, { header: 'Tablo' },
        { label: 'Alta satır ekle', icon: 'rowAdd', onClick: () => tableOp('rowBelow') },
        { label: 'Üste satır ekle', icon: 'rowAdd', onClick: () => tableOp('rowAbove') },
        { label: 'Sağa sütun ekle', icon: 'colAdd', onClick: () => tableOp('colRight') },
        { label: 'Sola sütun ekle', icon: 'colAdd', onClick: () => tableOp('colLeft') },
        { label: 'Satırı sil', icon: 'trash', onClick: () => tableOp('delRow') },
        { label: 'Sütunu sil', icon: 'trash', onClick: () => tableOp('delCol') },
        { label: 'Başlık satırı', checked: !!its[0].header, icon: 'table', onClick: () => updateItems(sel, (t) => ({ ...t, header: !t.header })) },
        { label: 'Bantlı satırlar', checked: !!its[0].banded, icon: 'table', onClick: () => updateItems(sel, (t) => ({ ...t, banded: !t.banded })) });
    }
    if (!its.length) {
      items.push({ separator: true },
        { label: 'Metin kutusu ekle', icon: 'textbox', onClick: insertTextBox },
        { label: 'Resim ekle…', icon: 'image', onClick: insertImage },
        { label: 'Arka plan rengi…', icon: 'fill', onClick: () => pickBg(at) },
        { label: 'Arka plan resmi…', icon: 'image', onClick: pickBgImage });
      if (lockedHere) items.push({ label: 'Şablon öğelerinin kilidini aç', icon: 'shield', onClick: unlockDecor });
    }
    void target;
    popupMenu(at, items);
  }

  function unlockDecor() {
    setItems(curSlide().items.map((it) => (it.lock ? { ...it, lock: undefined } : it)));
    refresh();
    toast('Şablon öğeleri artık seçilebilir.');
  }

  // ---- Biçimlendirme --------------------------------------------------------------------------
  function editTarget() {
    if (!editing) return null;
    const s = document.getSelection();
    if (!s || !s.rangeCount) return editing.el;
    const n = s.anchorNode;
    if (n && editing.el.contains(n)) return editing.el;
    return editing.el;
  }

  // Seçim yoksa: düzenleme modunda imleçteki metne, değilse seçili kutuların tüm metnine uygular.
  function restoreEditRange() {
    if (!editing) return;
    const r = editing.range;
    if (!r || !editing.el.contains(r.startContainer)) { if (editing.kind === 'text') editing.el.focus({ preventScroll: true }); return; }
    const n = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
    const host = editing.kind === 'text' ? editing.el : n.closest('td');
    if (host) host.focus({ preventScroll: true });
    const s = document.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }

  function applyText(fn, patch = null) {
    if (editing) {
      restoreEditRange();
      const tgt = editTarget();
      document.execCommand('styleWithCSS', false, true);
      fn(tgt);
      if (patch && editing.kind === 'text') {
        const it = item(editing.id);
        const p = patch(it);
        if (p && p !== it) {
          const slide = curSlide();
          commit(withSlide({ ...slide, items: slide.items.map((x) => (x.id === it.id ? p : x)) }), { push: false });
          if (p.align) editing.el.style.textAlign = p.align;
        }
      }
      onEditInput();
      updateToolbar();
      return;
    }
    const ids = [...sel].filter((id) => { const it = item(id); return canText(it) || (it && it.type === 'table'); });
    if (!ids.length) { toast('Önce bir metin kutusu, şekil veya tablo seçin.'); return; }
    const results = new Map();
    for (const id of ids) {
      const it = item(id);
      const el = elMap.get(id);
      if (!el) continue;
      if (it.type === 'table') {
        const tbl = el.querySelector('table');
        el.contentEditable = 'true';
        el.focus({ preventScroll: true });
        selectContents(tbl);
        document.execCommand('styleWithCSS', false, true);
        fn(el);
        const tds = Array.from(el.querySelectorAll('td'));
        const rows = it.rows.map((r) => r.slice());
        let k = 0;
        rows.forEach((row, ri) => row.forEach((cell, ci) => { if (cell && !cell.hidden && tds[k]) { rows[ri][ci] = { ...cell, html: sanitizeSlideHtml(tds[k].innerHTML) }; k++; } }));
        el.contentEditable = 'false';
        results.set(id, { rows });
        continue;
      }
      const content = el.querySelector('.text-content');
      if (!content || isEmptyHtml(it.html)) { results.set(id, {}); continue; }
      content.contentEditable = 'true';
      content.focus({ preventScroll: true });
      selectContents(content);
      document.execCommand('styleWithCSS', false, true);
      fn(content);
      results.set(id, { html: sanitizeSlideHtml(content.innerHTML) });
      content.contentEditable = 'false';
    }
    const s = document.getSelection();
    if (s) s.removeAllRanges();
    updateItems(new Set(ids), (it) => {
      const r = results.get(it.id) || {};
      let n = { ...it, ...r };
      if (patch && (it.type !== 'table' ? isEmptyHtml(it.html) || patch.always : patch.table)) n = patch(n) || n;
      return n;
    });
    stageWrap.focus({ preventScroll: true });
  }

  const cmd = (name, val = null) => () => document.execCommand(name, false, val);

  function toggleStyle(name, prop) {
    const p = (it) => ({ ...it, [prop]: !it[prop] });
    applyText(cmd(name), p);
  }

  function setFont(name) {
    const p = (it) => ({ ...it, font: name });
    p.table = true;
    applyText(cmd('fontName', name), p);
  }

  function setSizePt(pt) {
    const px = ptToPx(pt);
    lastFontPx = px;
    const p = (it) => ({ ...it, fs: px });
    p.table = true;
    applyText((container) => applyFontSize(container, px), p);
  }

  function growFont(dir) {
    const now = currentSizePt();
    let i = PT_SIZES.findIndex((s) => s >= now);
    if (i < 0) i = PT_SIZES.length - 1;
    const nextPt = dir > 0 ? PT_SIZES[Math.min(PT_SIZES.length - 1, PT_SIZES[i] > now ? i : i + 1)] : PT_SIZES[Math.max(0, i - 1)];
    setSizePt(nextPt);
  }

  function setColor(c) {
    const color = c || '#000000';
    const p = (it) => ({ ...it, color });
    p.table = false;
    applyText(cmd('foreColor', color), p);
  }

  function setHighlight(c) {
    applyText(cmd('hiliteColor', c || 'transparent'));
  }

  function setAlign(a) {
    const command = { left: 'justifyLeft', center: 'justifyCenter', right: 'justifyRight', justify: 'justifyFull' }[a];
    const p = (it) => ({ ...it, align: a });
    p.always = true;
    applyText(cmd(command), p);
  }

  function toggleList(kind) {
    const its = editing ? [item(editing.id)] : selectedItems();
    const asList = its.length && its.every((it) => it && it.list);
    if (asList && kind === 'ul') {
      // Yer tutucu madde işaretli liste: sınıfı kapat
      if (editing) { editing.el.classList.remove('as-list'); onEditInput(); updateToolbar(); return; }
      updateItems(sel, (it) => ({ ...it, list: false }));
      return;
    }
    applyText(cmd(kind === 'ol' ? 'insertOrderedList' : 'insertUnorderedList'));
  }

  function setVAlign(v) {
    const ids = editing ? new Set([editing.id]) : new Set([...sel].filter((id) => canText(item(id))));
    if (!ids.size) return;
    if (editing) {
      const it = item(editing.id);
      const slide = curSlide();
      commit(withSlide({ ...slide, items: slide.items.map((x) => (x.id === it.id ? { ...x, valign: v } : x)) }), { push: false });
      const box = elMap.get(it.id);
      if (box) { const target = box.classList.contains('item-text') ? box : box.querySelector('.item-text'); if (target) { target.classList.remove('va-top', 'va-middle', 'va-bottom'); target.classList.add('va-' + v); } }
      updateToolbar();
      return;
    }
    updateItems(ids, (it) => ({ ...it, valign: v }));
  }

  function setShapeProp(prop, value) {
    if (editing) endEdit();
    const ids = new Set([...sel].filter((id) => { const it = item(id); return it && it.type !== 'image'; }));
    if (!ids.size) { toast('Önce bir şekil veya metin kutusu seçin.'); return; }
    updateItems(ids, (it) => {
      if (it.type === 'table') return prop === 'stroke' ? { ...it, border: value || '#8eaadb' } : it;
      const n = { ...it, [prop]: value };
      if (prop === 'stroke' && value && value !== 'none' && !it.strokeW) n.strokeW = 1;
      return n;
    });
  }

  function outlineMenu(anchor) {
    popupMenu(anchor, [
      { label: 'Çizgi rengi…', icon: 'palette', onClick: () => colorPicker(anchor, (c) => setShapeProp('stroke', c || 'none'), { noneLabel: 'Çizgi yok' }) },
      { header: 'Kalınlık' },
      ...[0, 1, 2, 3, 4.5, 6, 9].map((w) => ({ label: w ? `${w} px` : 'Yok', onClick: () => { setShapeProp('strokeW', w); if (!w) setShapeProp('stroke', 'none'); } })),
      { separator: true },
      { label: 'Kesikli çizgi', icon: 'minus', checked: selectedItems().some((i) => i.dash), onClick: () => { const on = !selectedItems().some((i) => i.dash); setShapeProp('dash', on); } },
      { label: 'Ok ucu (çizgiler)', icon: 'arrowShape', checked: selectedItems().some((i) => i.arrowEnd), onClick: () => { const on = !selectedItems().some((i) => i.arrowEnd); setShapeProp('arrowEnd', on); } },
    ]);
  }

  // ---- Araç çubuğu ---------------------------------------------------------------------------
  const fontSel = tselect(usableFonts(FONTS).map((f) => ({ value: f, label: f })), (v) => setFont(v), { title: 'Yazı tipi', width: '132px' });
  previewFontOptions(fontSel);
  const sizeSel = tselect(PT_SIZES.map((s) => ({ value: String(s), label: String(s) })), (v) => setSizePt(+v), { title: 'Yazı boyutu (punto)', width: '64px' });
  const zoomSel = tselect([
    { value: 'fit', label: 'Sığdır' }, { value: '0.5', label: '%50' }, { value: '0.75', label: '%75' },
    { value: '1', label: '%100' }, { value: '1.5', label: '%150' }, { value: '2', label: '%200' },
  ], (v) => { if (v !== 'custom') setZoomMode(v === 'fit' ? 'fit' : +v); }, { title: 'Yakınlaştırma', width: '84px', value: 'fit' });
  function setZoomMode(z) {
    zoomMode = z;
    stageWrap.classList.toggle('zoomed', zoomMode !== 'fit');
    applyScale();
    renderSel();
    updateStatus();
    const v = String(z);
    if ([...zoomSel.options].some((o) => o.value === v && v !== 'custom')) zoomSel.value = v;
    else {
      let opt = zoomSel.querySelector('option[value="custom"]');
      if (!opt) { opt = h('option', { value: 'custom' }); zoomSel.append(opt); }
      opt.textContent = `%${Math.round(scale * 100)}`;
      zoomSel.value = 'custom';
    }
  }
  // İki parmakla (telefon) veya Ctrl + tekerlekle yakınlaştırma. Sığdır ölçeğinin altına inince "Sığdır"a döner.
  pinchZoom(stageWrap, {
    content: () => stageHost,
    getZoom: () => scale,
    setZoom: (z) => {
      const keep = zoomMode;
      zoomMode = 'fit'; applyScale();
      const fit = scale;
      zoomMode = keep;
      setZoomMode(z <= fit * 1.03 ? 'fit' : Math.round(z * 100) / 100);
    },
    min: 0.1, max: 4,
    onStart: () => { clearTimeout(longPress); longPress = 0; if (cancelTrack) cancelTrack(); },
  });

  const btn = {};
  const undoBtn = tbtn('undo', 'Geri al (Ctrl+Z)', () => undo());
  const redoBtn = tbtn('redo', 'Yinele (Ctrl+Y)', () => redo());
  btn.b = tbtn(null, 'Kalın (Ctrl+B)', () => toggleStyle('bold', 'bold'), { text: 'K', cls: 'tb-bold' });
  btn.i = tbtn(null, 'İtalik (Ctrl+I)', () => toggleStyle('italic', 'italic'), { text: 'T', cls: 'tb-italic' });
  btn.u = tbtn(null, 'Altı çizili (Ctrl+U)', () => applyText(cmd('underline')), { text: 'A', cls: 'tb-underline' });
  btn.s = tbtn(null, 'Üstü çizili', () => applyText(cmd('strikeThrough')), { text: 'Ü', cls: 'tb-strike' });
  btn.al = tbtn('alignLeft', 'Sola hizala', () => setAlign('left'));
  btn.ac = tbtn('alignCenter', 'Ortala', () => setAlign('center'));
  btn.ar = tbtn('alignRight', 'Sağa hizala', () => setAlign('right'));
  btn.aj = tbtn('justify', 'İki yana yasla', () => setAlign('justify'));
  btn.ul = tbtn('listBullet', 'Madde işaretleri', () => toggleList('ul'));
  btn.ol = tbtn('listNumber', 'Numaralandırma', () => toggleList('ol'));

  toolbar.append(
    undoBtn, redoBtn, tsep(),
    tbtn('slide', 'Yeni slayt', (e, b) => layoutMenu(b), { text: 'Yeni slayt', cls: 'tb-wide' }),
    tbtn('plus', 'Ekle', (e, b) => insertMenu(b), { text: 'Ekle', cls: 'tb-wide' }),
    tbtn('textbox', 'Metin kutusu ekle', insertTextBox),
    tbtn('image', 'Resim ekle', insertImage),
    tbtn('shape', 'Şekil ekle', (e, b) => shapeMenu(b)),
    tbtn('table', 'Tablo ekle', insertTable),
    tsep(),
    fontSel, sizeSel,
    tbtn('zoomIn', 'Yazıyı büyüt', () => growFont(1)),
    tbtn('zoomOut', 'Yazıyı küçült', () => growFont(-1)),
    btn.b, btn.i, btn.u, btn.s,
    tbtn('textColor', 'Yazı rengi', (e, b) => colorPicker(b, setColor, { noneLabel: 'Otomatik (siyah)' })),
    tbtn('highlight', 'Vurgu rengi', (e, b) => colorPicker(b, setHighlight, { noneLabel: 'Vurgu yok' })),
    tsep(),
    btn.al, btn.ac, btn.ar, btn.aj, btn.ul, btn.ol,
    tbtn('valignMiddle', 'Dikey hizalama', (e, b) => popupMenu(b, [
      { label: 'Üst', icon: 'valignTop', onClick: () => setVAlign('top') },
      { label: 'Orta', icon: 'valignMiddle', onClick: () => setVAlign('middle') },
      { label: 'Alt', icon: 'valignBottom', onClick: () => setVAlign('bottom') },
    ])),
    tsep(),
    tbtn('fill', 'Dolgu rengi', (e, b) => colorPicker(b, (c) => setShapeProp('fill', c || 'none'), { noneLabel: 'Dolgu yok' })),
    tbtn('border', 'Çizgi / kenarlık', (e, b) => outlineMenu(b)),
    tbtn('front', 'Düzenle ve hizala', (e, b) => arrangeMenu(b)),
    tbtn('trash', 'Seçileni sil (Del)', () => { if (editing) return; deleteSelected(); }),
    tsep(),
    tbtn('palette', 'Tasarım: arka plan ve slayt boyutu', (e, b) => popupMenu(b, [
      { label: 'Arka plan rengi…', icon: 'fill', onClick: () => pickBg(b) },
      { label: 'Arka plan resmi…', icon: 'image', onClick: pickBgImage },
      curSlide().bgImg ? { label: 'Arka plan resmini kaldır', icon: 'close', onClick: () => setBg({ bgImg: undefined }) } : null,
      { label: 'Arka planı tüm slaytlara uygula', icon: 'check', onClick: bgToAll },
      { separator: true },
      { label: 'Slayt boyutu…', icon: 'slide', onClick: slideSize },
    ]), { text: 'Tasarım', cls: 'tb-wide' }),
    tbtn('notes', 'Konuşmacı notlarını göster/gizle', () => { showNotes = !showNotes; notes.hidden = !showNotes; applyScale(); renderSel(); }),
    zoomSel,
    tbtn('play', 'Slayt gösterisi (F5)', () => startShow(0), { text: 'Sun', cls: 'tb-wide tb-accent' }),
  );

  function currentSizePt() {
    const el = styleSource();
    if (!el) { const it = selectedItems()[0]; return pxToPt((it && it.fs) || 24); }
    return pxToPt(parseFloat(getComputedStyle(el).fontSize) || 24);
  }

  function styleSource() {
    if (editing) {
      const s = document.getSelection();
      if (s && s.rangeCount && editing.el.contains(s.anchorNode)) return s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement;
      return editing.el;
    }
    const it = selectedItems().find((i) => canText(i) || i.type === 'table');
    if (!it) return null;
    const el = elMap.get(it.id);
    if (!el) return null;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) if (n.textContent.trim()) return n.parentElement;
    return el.querySelector('.text-content') || el;
  }

  function updateToolbar() {
    undoBtn.disabled = !undoStack.length && !editing;
    redoBtn.disabled = !redoStack.length;
    const src = styleSource();
    if (src) {
      const cs = getComputedStyle(src);
      const fam = (cs.fontFamily || '').split(',')[0].replace(/["']/g, '').trim();
      if (fam) {
        if (![...fontSel.options].some((o) => o.value === fam)) fontSel.append(h('option', { value: fam }, fam));
        fontSel.value = fam;
      }
      const pt = pxToPt(parseFloat(cs.fontSize) || 24);
      if (![...sizeSel.options].some((o) => o.value === String(pt))) sizeSel.append(h('option', { value: String(pt) }, String(pt)));
      sizeSel.value = String(pt);
      const bold = editing ? document.queryCommandState('bold') : (+cs.fontWeight >= 600 || cs.fontWeight === 'bold');
      const ital = editing ? document.queryCommandState('italic') : cs.fontStyle === 'italic';
      btn.b.classList.toggle('active', !!bold);
      btn.i.classList.toggle('active', !!ital);
      btn.u.classList.toggle('active', editing ? document.queryCommandState('underline') : false);
      const al = cs.textAlign;
      btn.al.classList.toggle('active', al === 'left' || al === 'start');
      btn.ac.classList.toggle('active', al === 'center');
      btn.ar.classList.toggle('active', al === 'right' || al === 'end');
      btn.aj.classList.toggle('active', al === 'justify');
    } else {
      for (const k of ['b', 'i', 'u', 'al', 'ac', 'ar', 'aj']) btn[k].classList.remove('active');
    }
  }

  const onSelChange = () => {
    if (!editing) return;
    const s = document.getSelection();
    if (s && s.rangeCount && s.anchorNode && editing.el.contains(s.anchorNode)) {
      editing.range = s.getRangeAt(0).cloneRange();
      updateToolbar();
    }
  };
  document.addEventListener('selectionchange', onSelChange);

  function updateStatus() {
    const z = Math.round(scale * 100);
    status.textContent = `Slayt ${cur + 1} / ${deck.slides.length}  ·  Yakınlaştırma %${z}`;
  }

  // ---- Notlar --------------------------------------------------------------------------------
  notes.addEventListener('focus', () => { if (editing) endEdit(); notesStart = deck; });
  notes.addEventListener('input', () => {
    const s = curSlide();
    commit(withSlide({ ...s, notes: notes.value.slice(0, 100000) }), { push: false });
  });
  notes.addEventListener('blur', () => {
    if (notesStart && notesStart !== deck) { undoStack.push(notesStart); redoStack.length = 0; renderThumbs(); }
    notesStart = null;
  });

  // ---- Geri al / yinele ----------------------------------------------------------------------
  function undo() {
    if (editing) endEdit();
    if (!undoStack.length) return;
    redoStack.push(deck);
    deck = undoStack.pop();
    cur = Math.min(cur, deck.slides.length - 1);
    app.markDirty();
    refresh();
  }
  function redo() {
    if (editing) endEdit();
    if (!redoStack.length) return;
    undoStack.push(deck);
    deck = redoStack.pop();
    cur = Math.min(cur, deck.slides.length - 1);
    app.markDirty();
    refresh();
  }

  // ---- Klavye ve pano -------------------------------------------------------------------------
  const inField = (t) => t && (t === notes || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName));

  function onKey(e) {
    if (show) return;
    if (inField(e.target)) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (k === 'F5') { e.preventDefault(); startShow(e.shiftKey ? cur : 0); return; }
    if (editing) {
      if (k === 'Escape') { e.preventDefault(); const id = editing.id; endEdit(); sel = new Set(item(id) ? [id] : []); renderSel(); stageWrap.focus({ preventScroll: true }); return; }
      if (editing.kind === 'table' && k === 'Tab') {
        e.preventDefault();
        const s = document.getSelection();
        const td = s.anchorNode && (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement).closest('td');
        const list = editing.cells.map((c) => c[0]);
        let i = list.indexOf(td) + (e.shiftKey ? -1 : 1);
        if (i >= list.length && !e.shiftKey) { tableOp('rowBelow'); return; }
        i = Math.max(0, Math.min(list.length - 1, i));
        list[i].focus({ preventScroll: true });
        selectContents(list[i], true);
        return;
      }
      if (mod && (k === '+' || k === '=' || k === ']')) { e.preventDefault(); growFont(1); return; }
      if (mod && (k === '-' || k === '[')) { e.preventDefault(); growFont(-1); return; }
      if (mod && k.toLowerCase() === 'l') { e.preventDefault(); setAlign('left'); return; }
      if (mod && k.toLowerCase() === 'e') { e.preventDefault(); setAlign('center'); return; }
      if (mod && k.toLowerCase() === 'r') { e.preventDefault(); setAlign('right'); return; }
      // Ctrl+B/I/U ve yazma işlemlerini tarayıcı yapar; input olayı ile kaydedilir.
      if (mod && ['b', 'i', 'u'].includes(k.toLowerCase())) setTimeout(() => { onEditInput(); updateToolbar(); }, 0);
      return;
    }
    let handled = true;
    const step = e.shiftKey ? 10 : 1;
    if (mod && k.toLowerCase() === 'z' && !e.shiftKey) undo();
    else if (mod && (k.toLowerCase() === 'y' || (k.toLowerCase() === 'z' && e.shiftKey))) redo();
    else if (mod && k.toLowerCase() === 'a') { sel = new Set(curSlide().items.filter((i) => !i.lock).map((i) => i.id)); renderSel(); updateToolbar(); }
    else if (mod && k.toLowerCase() === 'd') duplicateSelected();
    else if (mod && k.toLowerCase() === 'm') addSlide('content');
    else if (mod && k.toLowerCase() === 'p' && canPrint()) doPrint();
    else if (mod && k.toLowerCase() === 'b') toggleStyle('bold', 'bold');
    else if (mod && k.toLowerCase() === 'i') toggleStyle('italic', 'italic');
    else if (mod && k.toLowerCase() === 'u') applyText(cmd('underline'));
    else if (mod) handled = false;
    else if (k === 'Delete' || k === 'Backspace') { if (sel.size) deleteSelected(); else handled = false; }
    else if (k.startsWith('Arrow')) {
      if (sel.size) {
        const dx = k === 'ArrowLeft' ? -step : k === 'ArrowRight' ? step : 0;
        const dy = k === 'ArrowUp' ? -step : k === 'ArrowDown' ? step : 0;
        updateItems(sel, (it) => ({ ...it, x: it.x + dx, y: it.y + dy }));
      } else if (k === 'ArrowLeft' || k === 'ArrowUp') goto(cur - 1);
      else goto(cur + 1);
    } else if (k === 'PageDown') goto(cur + 1);
    else if (k === 'PageUp') goto(cur - 1);
    else if (k === 'Home' && !sel.size) goto(0);
    else if (k === 'End' && !sel.size) goto(deck.slides.length - 1);
    else if ((k === 'Enter' || k === 'F2') && sel.size === 1) { const id = [...sel][0]; const it = item(id); if (it && (canText(it) || it.type === 'table')) startEdit(id); }
    else if (k === 'Escape') { sel = new Set(); renderSel(); updateToolbar(); }
    else if (k === 'Tab') {
      const its = curSlide().items.filter((i) => !i.lock);
      if (its.length) {
        const idx = sel.size === 1 ? its.findIndex((i) => sel.has(i.id)) : -1;
        const n = its[(idx + (e.shiftKey ? its.length - 1 : 1)) % its.length];
        sel = new Set([n.id]); renderSel(); updateToolbar();
      } else handled = false;
    } else handled = false;
    if (handled) e.preventDefault();
  }
  root.addEventListener('keydown', onKey);

  const activeInStage = () => {
    const a = document.activeElement;
    return !editing && !show && (a === stageWrap || thumbs.contains(a) || stageWrap.contains(a));
  };
  const onCopy = (e) => {
    if (!activeInStage() || !sel.size) return;
    if (!copySelected()) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', clipText);
  };
  const onCut = (e) => {
    if (!activeInStage() || !sel.size) return;
    if (!copySelected()) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', clipText);
    deleteSelected();
  };
  const onPaste = (e) => {
    if (!activeInStage()) return;
    const cd = e.clipboardData;
    if (!cd) return;
    const text = cd.getData('text/plain');
    const imgItem = Array.from(cd.items || []).find((i) => i.kind === 'file' && /^image\//.test(i.type));
    if (imgItem) { e.preventDefault(); const f = imgItem.getAsFile(); if (f) insertImageFile(f); return; }
    if (clip && (!text || text === clipText)) { e.preventDefault(); pasteItems(); return; }
    if (text && text.trim()) {
      e.preventDefault();
      const box = document.createElement('div');
      for (const line of text.replace(/\r\n?/g, '\n').split('\n').slice(0, 500)) {
        const p = document.createElement('p');
        if (line) p.textContent = line; else p.append(document.createElement('br'));
        box.append(p);
      }
      const w = Math.min(deck.w * 0.7, 600);
      addItems([{ id: uid(), type: 'text', x: (deck.w - w) / 2, y: deck.h * 0.3, w, h: 60, fs: 20, html: box.innerHTML, autoH: true }]);
      // yüksekliği içeriğe göre ayarla
      const it = selectedItems()[0];
      const el = it && elMap.get(it.id);
      if (el && el.scrollHeight > it.h) updateItems(new Set([it.id]), (x) => ({ ...x, h: Math.min(deck.h, el.scrollHeight) }));
    }
  };
  document.addEventListener('copy', onCopy);
  document.addEventListener('cut', onCut);
  document.addEventListener('paste', onPaste);

  // ---- Slayt gösterisi -----------------------------------------------------------------------
  let expectPop = false;
  function startShow(from) {
    if (editing) endEdit();
    closeMenus();
    let i = Math.max(0, Math.min(deck.slides.length - 1, from));
    const ov = h('div', { class: 'slideshow', tabindex: '0', role: 'dialog', 'aria-label': 'Slayt gösterisi' });
    const holder = h('div', { class: 'show-holder' });
    const counter = h('div', { class: 'show-counter' });
    const closeBtn = h('button', { class: 'show-close', type: 'button', 'aria-label': 'Gösteriyi kapat', title: 'Kapat (Esc)' }, icon('close'));
    ov.append(holder, counter, closeBtn);
    document.body.append(ov);
    const n = deck.slides.length;
    const draw = () => {
      clear(holder);
      if (i >= n) {
        holder.append(h('div', { class: 'show-end' }, 'Slayt gösterisinin sonu. Çıkmak için tıklayın.'));
        counter.textContent = '';
        return;
      }
      const s = Math.min(window.innerWidth / deck.w, window.innerHeight / deck.h);
      holder.append(scaledSlide(deck.slides[i], deck, deck.w * s));
      counter.textContent = `${i + 1} / ${n}`;
    };
    const next = () => { if (i < n) { i++; draw(); } else close(); };
    const prev = () => { if (i > 0) { i--; draw(); } };
    const onK = (e) => {
      const k = e.key;
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n', 'N'].includes(k)) next();
      else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p', 'P'].includes(k)) prev();
      else if (k === 'Home') { i = 0; draw(); }
      else if (k === 'End') { i = n - 1; draw(); }
      else if (k === 'Escape') close();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    let touch = null;
    ov.addEventListener('pointerdown', (e) => { touch = { x: e.clientX, y: e.clientY, t: Date.now() }; });
    ov.addEventListener('pointerup', (e) => {
      if (!touch) return;
      const dx = e.clientX - touch.x, dy = e.clientY - touch.y;
      touch = null;
      if (e.target.closest('.show-close')) return;
      const a = e.target.closest('a');
      if (a) { const href = a.getAttribute('href') || ''; if (isSafeUrl(href)) openExternal(href); return; }
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) { if (dx < 0) next(); else prev(); return; }
      if (e.pointerType === 'mouse' && e.button === 2) return;
      if (e.clientX < window.innerWidth * 0.25) prev(); else next();
    });
    ov.addEventListener('click', (e) => { if (e.target.closest('a')) e.preventDefault(); });
    ov.addEventListener('contextmenu', (e) => { e.preventDefault(); prev(); });
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); close(); });
    const onResize = () => draw();
    const onFs = () => { if (!document.fullscreenElement && show && show.wasFull) close(); };
    document.addEventListener('keydown', onK, true);
    window.addEventListener('resize', onResize);
    document.addEventListener('fullscreenchange', onFs);
    show = { teardown: null, wasFull: false };
    show.teardown = () => {
      document.removeEventListener('keydown', onK, true);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('fullscreenchange', onFs);
      ov.remove();
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
      show = null;
      stageWrap.focus({ preventScroll: true });
    };
    function close() {
      if (!show) return;
      const pushed = show.pushed;
      show.teardown();
      if (pushed) { expectPop = true; history.back(); }
    }
    try { history.pushState({ ...(history.state || {}), slideshow: true }, ''); show.pushed = true; } catch { /* yok say */ }
    if (ov.requestFullscreen) ov.requestFullscreen().then(() => { if (show) show.wasFull = true; }).catch(() => {});
    draw();
    ov.focus({ preventScroll: true });
  }

  // Android geri tuşu / tarayıcı geri: önce gösteriyi kapat.
  function handleBack() {
    if (show) { const t = show.teardown; show.pushed = false; t(); return true; }
    if (expectPop) { expectPop = false; return true; }
    return false;
  }

  // ---- Dışa aktarma ve yazdırma ---------------------------------------------------------------
  async function exportPptxFile(title) {
    if (editing) endEdit();
    try {
      const { exportPptx } = await import('./pptx-export.js');
      const blob = await exportPptx(deck, title);
      return saveBlob(blob, `${title}.pptx`);
    } catch (err) {
      console.error(err);
      toast('PowerPoint dosyası oluşturulamadı: ' + (err.message || err), { type: 'error' });
      return false;
    }
  }

  function doPrint() {
    if (editing) endEdit();
    printElement(() => {
      const wrap = h('div', { class: 'print-slides' });
      for (const s of deck.slides) {
        const page = h('div', { class: 'print-slide', style: { width: deck.w + 'px', height: deck.h + 'px' } });
        page.append(renderSlide(s, deck));
        wrap.append(page);
      }
      return wrap;
    }, { pageCss: `@page { size: ${deck.w}px ${deck.h}px; margin: 0; }` });
  }

  function outlineText() {
    return deck.slides.map((s, i) => {
      const lines = [`Slayt ${i + 1}`];
      for (const it of s.items) {
        if (it.type === 'table') lines.push(it.rows.map((r) => r.map((c) => htmlToText(c.html).trim()).join('\t')).join('\n'));
        else if (it.html) { const t = htmlToText(it.html).trim(); if (t) lines.push(t); }
      }
      if (s.notes) lines.push('Notlar: ' + s.notes);
      return lines.join('\n');
    }).join('\n\n');
  }

  async function insertFromPptx() {
    const f = await pickFile('.pptx,.pptm,.ppsx,.potx');
    if (!f) return;
    try {
      const { importPptx } = await import('./pptx-import.js');
      const buf = await f.arrayBuffer();
      const other = await importPptx(buf);
      const k = Math.min(deck.w / other.w, deck.h / other.h);
      const ox = (deck.w - other.w * k) / 2, oy = (deck.h - other.h * k) / 2;
      const add = other.slides.map((s) => ({ ...s, id: uid(), items: s.items.map((it) => ({ ...it, id: uid(), x: it.x * k + ox, y: it.y * k + oy, w: it.w * k, h: it.h * k })) }));
      const slides = deck.slides.slice();
      slides.splice(cur + 1, 0, ...add);
      commit({ ...deck, slides });
      cur += 1;
      sel = new Set();
      refresh();
      toast(`${add.length} slayt eklendi.`, { type: 'success' });
    } catch (err) { toast(err.message || 'Slaytlar eklenemedi.', { type: 'error' }); }
  }

  // ---- Başlangıç ------------------------------------------------------------------------------
  const ro = new ResizeObserver(() => {
    applyScale();
    renderSel();
    updateStatus();
    const tw = isMobileLayout() ? 104 : 164;
    if (!thumbKey.startsWith(tw + ':')) renderThumbs();
  });
  ro.observe(stageWrap);
  refresh();
  setTimeout(() => stageWrap.focus({ preventScroll: true }), 50);

  return {
    serialize: () => { if (editing) syncEdit(); return deck; },
    primaryExport: { label: 'PowerPoint (.pptx) olarak indir', run: (title) => exportPptxFile(title) },
    fileMenu: (title) => [
      { label: 'PowerPoint sunusu (.pptx)', icon: 'download', onClick: () => exportPptxFile(title()) },
      canPrint() ? { label: 'PDF olarak kaydet / Yazdır', icon: 'print', hint: 'Ctrl+P', onClick: doPrint } : null,
      { label: 'Ana hat metni (.txt)', icon: 'download', onClick: () => saveBlob(new Blob([outlineText()], { type: 'text/plain;charset=utf-8' }), `${title()}.txt`) },
      { separator: true },
      { label: 'Başka bir sunudan slayt ekle…', icon: 'upload', onClick: insertFromPptx },
      { label: 'Slayt gösterisini başlat', icon: 'play', hint: 'F5', onClick: () => startShow(0) },
    ],
    canAcceptImage: true,
    insertImageFile,
    flush: () => { if (editing) syncEdit(); },
    handleBack,
    destroy() {
      if (show) show.teardown();
      clearTimeout(thumbTimer);
      clearTimeout(syncTimer);
      ro.disconnect();
      document.removeEventListener('selectionchange', onSelChange);
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCut);
      document.removeEventListener('paste', onPaste);
      root.removeEventListener('keydown', onKey);
      clear(root);
      root.classList.remove('editor', 'editor-slides');
    },
  };
}

export function newSlidesData() {
  return newDeck();
}
