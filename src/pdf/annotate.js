// PDF üzerine notlar: kalem, vurgulayıcı, metin ve imza.
// Notlar belge verisinde ayrı tutulur (sayfanın ekranda görünen yönünde, 1 birim = 1 pt);
// PDF olarak kaydedilirken saydam bir katman halinde sayfaya işlenir.
import { h, icon, tbtn, tsep, clear, modal, toast } from '../core/ui.js';
import { signaturePad } from './tools-ui.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const TEXT_FONT = 'Arial, "Liberation Sans", Helvetica, sans-serif';
const PEN_COLORS = ['#111111', '#1a3fa8', '#b3261e', '#1e7a3a'];
const HL_COLORS = ['#ffe94d', '#7cf27c', '#ff9ad5', '#7fd8ff'];
const WIDTHS = [{ v: 1.2, label: 'İnce' }, { v: 2.4, label: 'Orta' }, { v: 4.5, label: 'Kalın' }];
const MAX_ITEMS = 5000;

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const r1 = (n) => Math.round(n * 10) / 10;
const safeColor = (c, def) => (typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : def);

/** Saklanan notları doğrular (bozuk ya da beklenmeyen veriler atılır). */
export function cleanAnnots(list, pageCount) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list.slice(0, MAX_ITEMS)) {
    if (!a || typeof a !== 'object' || !(a.p >= 0 && a.p < pageCount)) continue;
    const base = { id: String(a.id || uid()).slice(0, 40), p: a.p | 0 };
    const num = (v) => (Number.isFinite(+v) ? +v : 0);
    if (a.t === 'ink' && Array.isArray(a.pts) && a.pts.length >= 2) out.push({ ...base, t: 'ink', pts: a.pts.slice(0, 20000).map(num), c: safeColor(a.c, '#111111'), w: Math.min(20, Math.max(0.3, num(a.w) || 2)) });
    else if (a.t === 'hl') out.push({ ...base, t: 'hl', x: num(a.x), y: num(a.y), w: num(a.w), h: num(a.h), c: safeColor(a.c, '#ffe94d') });
    else if (a.t === 'text' && typeof a.text === 'string') out.push({ ...base, t: 'text', x: num(a.x), y: num(a.y), s: Math.min(144, Math.max(4, num(a.s) || 14)), c: safeColor(a.c, '#111111'), text: a.text.slice(0, 5000) });
    else if (a.t === 'img' && typeof a.src === 'string' && /^data:image\/png;base64,[a-z0-9+/=]+$/i.test(a.src) && a.src.length < 3e6) out.push({ ...base, t: 'img', x: num(a.x), y: num(a.y), w: num(a.w), h: num(a.h), src: a.src });
  }
  return out;
}

let measureCtx = null;
function textBox(it) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = `${it.s}px ${TEXT_FONT}`;
  const lines = it.text.split('\n');
  const w = Math.max(...lines.map((l) => measureCtx.measureText(l).width), it.s * 0.5);
  return { x: it.x, y: it.y, w, h: lines.length * it.s * 1.2 };
}

export function bbox(it) {
  if (it.t === 'ink') {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < it.pts.length; i += 2) {
      const x = it.pts[i], y = it.pts[i + 1];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const m = it.w / 2;
    return { x: x0 - m, y: y0 - m, w: x1 - x0 + it.w, h: y1 - y0 + it.w };
  }
  if (it.t === 'text') return textBox(it);
  return { x: it.x, y: it.y, w: it.w, h: it.h };
}

const inkPath = (pts) => {
  if (pts.length === 2) return `M${pts[0]} ${pts[1]}l0.01 0`;
  let d = `M${pts[0]} ${pts[1]}`;
  for (let i = 2; i < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`;
  return d;
};

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  return el;
}

function itemSvg(it) {
  let el;
  if (it.t === 'ink') {
    el = svgEl('path', { d: inkPath(it.pts), fill: 'none', stroke: it.c, 'stroke-width': it.w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  } else if (it.t === 'hl') {
    el = svgEl('rect', { x: it.x, y: it.y, width: Math.max(0, it.w), height: Math.max(0, it.h), fill: it.c, 'fill-opacity': 0.45, class: 'ann-hl' });
  } else if (it.t === 'text') {
    el = svgEl('text', { 'font-size': it.s, fill: it.c, 'font-family': TEXT_FONT });
    it.text.split('\n').forEach((line, i) => {
      const ts = svgEl('tspan', { x: it.x, y: it.y + it.s * 0.85 + i * it.s * 1.2 });
      ts.textContent = line || ' ';
      el.append(ts);
    });
  } else if (it.t === 'img') {
    el = svgEl('image', { x: it.x, y: it.y, width: it.w, height: it.h, preserveAspectRatio: 'none', href: it.src });
  }
  const g = svgEl('g', { class: 'ann-item', 'data-id': it.id });
  g.append(el);
  // Dokunması kolay olsun diye görünmez bir tıklama alanı
  const b = bbox(it);
  g.append(svgEl('rect', { x: b.x - 3, y: b.y - 3, width: b.w + 6, height: b.h + 6, fill: 'transparent', class: 'ann-hit' }));
  return g;
}

/** Notları verilen tuval bağlamına çizer (ölçek: 1 pt kaç piksel). */
export async function drawItems(ctx, items, scale = 1) {
  ctx.save();
  ctx.scale(scale, scale);
  for (const it of items) {
    ctx.save();
    if (it.t === 'ink') {
      ctx.strokeStyle = it.c; ctx.lineWidth = it.w; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(it.pts[0], it.pts[1]);
      if (it.pts.length === 2) ctx.lineTo(it.pts[0] + 0.01, it.pts[1]);
      for (let i = 2; i < it.pts.length; i += 2) ctx.lineTo(it.pts[i], it.pts[i + 1]);
      ctx.stroke();
    } else if (it.t === 'hl') {
      ctx.globalAlpha = 0.45; ctx.fillStyle = it.c;
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillRect(it.x, it.y, it.w, it.h);
    } else if (it.t === 'text') {
      ctx.fillStyle = it.c; ctx.font = `${it.s}px ${TEXT_FONT}`; ctx.textBaseline = 'alphabetic';
      it.text.split('\n').forEach((line, i) => ctx.fillText(line, it.x, it.y + it.s * 0.85 + i * it.s * 1.2));
    } else if (it.t === 'img') {
      const img = new Image();
      img.src = it.src;
      await img.decode().catch(() => {});
      if (img.naturalWidth) ctx.drawImage(img, it.x, it.y, it.w, it.h);
    }
    ctx.restore();
  }
  ctx.restore();
}

/** Notları saydam bir PNG'ye çizer (PDF'e işlemek için). */
export async function renderLayerPng(items, W, H) {
  let s = 3;
  const maxPx = 14e6;
  if (W * H * s * s > maxPx) s = Math.sqrt(maxPx / (W * H));
  const c = document.createElement('canvas');
  c.width = Math.ceil(W * s); c.height = Math.ceil(H * s);
  await drawItems(c.getContext('2d'), items, s);
  const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
  c.width = c.height = 0;
  return new Uint8Array(await blob.arrayBuffer());
}

async function textDialog(init = {}) {
  const ta = h('textarea', { class: 'input ann-textarea', rows: '4', placeholder: 'Eklenecek metin', 'aria-label': 'Metin' });
  ta.value = init.text || '';
  const size = h('select', { class: 'input', 'aria-label': 'Yazı boyutu' }, ...[8, 10, 12, 14, 16, 18, 24, 32, 48].map((n) => h('option', { value: String(n) }, n + ' pt')));
  size.value = String(init.s || 14);
  if (!size.value) size.value = '14';
  let color = init.c || PEN_COLORS[0];
  const sw = h('div', { class: 'sig-colors' });
  for (const c of PEN_COLORS) {
    const b = h('button', { class: 'swatch' + (c === color ? ' on' : ''), type: 'button', title: 'Yazı rengi', 'aria-label': 'Yazı rengi', style: { background: c } });
    b.addEventListener('click', () => { color = c; sw.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('on', x === b)); });
    sw.append(b);
  }
  const r = await modal({
    title: init.text ? 'Metni düzenle' : 'Metin ekle',
    body: h('div', { class: 'form-grid' }, h('label', { class: 'field-label' }, 'Metin'), ta, h('label', { class: 'field-label' }, 'Boyut'), size, h('label', { class: 'field-label' }, 'Renk'), sw),
    actions: [{ label: 'İptal', value: null }, { label: init.text ? 'Kaydet' : 'Ekle', primary: true, value: () => ({ text: ta.value.replace(/\r/g, '').trimEnd(), s: +size.value, c: color }) }],
  });
  return r && r.text.trim() ? r : null;
}

/**
 * Görüntüleyiciye not araçlarını ekler.
 * pages: [{ el, num, vp1 }], getSize(p) → { width, height } (pt, ekrandaki yön).
 */
export function createAnnotator({ pages, pagesEl, getSize, currentPage, initial, onChange, readOnlyReason }) {
  let items = initial;
  let tool = null; // null | 'pen' | 'hl' | 'text' | 'erase'
  let penColor = PEN_COLORS[0], hlColor = HL_COLORS[0], penW = WIDTHS[1].v;
  let selected = null;
  const undo = [], redo = [];
  const byId = (id) => items.find((x) => x.id === id);

  const commit = (next) => {
    undo.push(items);
    if (undo.length > 60) undo.shift();
    redo.length = 0;
    items = next;
    onChange(items);
    refreshAll();
    updateBar();
  };

  // ---- Çizim ----------------------------------------------------------------------------------
  function layerFor(p) {
    if (!p.annotSvg) {
      p.annotSvg = document.createElementNS(SVG_NS, 'svg');
      p.annotSvg.classList.add('pdf-annot');
      p.el.append(p.annotSvg);
    }
    const { width, height } = getSize(p);
    p.annotSvg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    p.annotSvg.setAttribute('preserveAspectRatio', 'none');
    return p.annotSvg;
  }
  function drawPage(p) {
    const list = items.filter((x) => x.p === p.num - 1);
    if (!list.length && !p.annotSvg) return;
    const svg = layerFor(p);
    while (svg.firstChild) svg.firstChild.remove();
    for (const it of list) svg.append(itemSvg(it));
    const sel = selected && byId(selected);
    if (sel && sel.p === p.num - 1) {
      if (selBox && selBox.dataset.id === sel.id) positionSel(); else drawSelection();
    }
  }
  function refreshAll() {
    for (const p of pages) if (p.annotSvg || items.some((x) => x.p === p.num - 1)) drawPage(p);
    if (selected && !byId(selected)) select(null);
    else drawSelection();
  }

  // ---- Seçim (taşıma, boyutlandırma, silme) -----------------------------------------------------
  let selBox = null;
  function select(id) {
    selected = id;
    drawSelection();
  }
  function positionSel() {
    const it = selected && byId(selected);
    if (!it || !selBox) return;
    const { width, height } = getSize(pages[it.p]);
    const b = bbox(it);
    Object.assign(selBox.style, { left: (b.x / width) * 100 + '%', top: (b.y / height) * 100 + '%', width: (b.w / width) * 100 + '%', height: (b.h / height) * 100 + '%' });
  }
  function drawSelection() {
    if (selBox) { selBox.remove(); selBox = null; }
    const it = selected && byId(selected);
    if (!it) return;
    const p = pages[it.p];
    const { width, height } = getSize(p);
    selBox = h('div', { class: 'ann-sel', dataset: { id: it.id } });
    const del = h('button', { class: 'ann-sel-del', type: 'button', title: 'Sil', 'aria-label': 'Notu sil' }, icon('trash', 15));
    del.addEventListener('pointerdown', (e) => e.stopPropagation());
    del.addEventListener('click', (e) => { e.stopPropagation(); commit(items.filter((x) => x.id !== it.id)); select(null); });
    const grip = h('div', { class: 'ann-sel-grip', title: 'Boyutlandır' });
    selBox.append(del, grip);
    if (it.t === 'text') {
      const edit = h('button', { class: 'ann-sel-edit', type: 'button', title: 'Düzenle', 'aria-label': 'Metni düzenle' }, icon('textbox', 15));
      edit.addEventListener('pointerdown', (e) => e.stopPropagation());
      edit.addEventListener('click', async (e) => {
        e.stopPropagation();
        const r = await textDialog(it);
        if (r) commit(items.map((x) => (x.id === it.id ? { ...x, ...r } : x)));
      });
      selBox.append(edit);
    }
    p.el.append(selBox);
    positionSel();
    // Sürükleyerek taşıma / köşeden boyutlandırma
    selBox.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const resize = e.target === grip;
      const rect = p.el.getBoundingClientRect();
      const k = width / rect.width;
      const sx = e.clientX, sy = e.clientY;
      const orig = byId(selected);
      const ob = bbox(orig);
      let moved = false, next = orig;
      try { selBox.setPointerCapture(e.pointerId); } catch { /* yok say */ }
      const move = (ev) => {
        const dx = (ev.clientX - sx) * k, dy = (ev.clientY - sy) * k;
        if (!moved && Math.hypot(dx, dy) < 2) return;
        moved = true;
        next = resize ? resized(orig, ob, dx, dy) : translated(orig, dx, dy, width, height);
        items = items.map((x) => (x.id === orig.id ? next : x));
        drawPage(p);
      };
      const up = () => {
        selBox && selBox.removeEventListener('pointermove', move);
        if (moved) {
          items = items.map((x) => (x.id === orig.id ? orig : x)); // geri alma için asıl hali
          commit(items.map((x) => (x.id === orig.id ? next : x)));
        }
      };
      selBox.addEventListener('pointermove', move);
      selBox.addEventListener('pointerup', up, { once: true });
      selBox.addEventListener('pointercancel', up, { once: true });
    });
  }
  function translated(it, dx, dy, W, H) {
    const b = bbox(it);
    dx = Math.max(-b.x, Math.min(W - b.x - b.w, dx));
    dy = Math.max(-b.y, Math.min(H - b.y - b.h, dy));
    if (it.t === 'ink') return { ...it, pts: it.pts.map((v, i) => r1(v + (i % 2 ? dy : dx))) };
    return { ...it, x: r1(it.x + dx), y: r1(it.y + dy) };
  }
  function resized(it, b, dx, dy) {
    if (it.t === 'img' || it.t === 'text' || it.t === 'ink') {
      const f = Math.max(0.15, (b.w + dx) / b.w);
      if (it.t === 'img') return { ...it, w: r1(it.w * f), h: r1(it.h * f) };
      if (it.t === 'text') return { ...it, s: Math.max(4, Math.min(144, r1(it.s * f))) };
      return { ...it, pts: it.pts.map((v, i) => r1((i % 2 ? b.y : b.x) + (v - (i % 2 ? b.y : b.x)) * f)), w: it.w };
    }
    return { ...it, w: r1(Math.max(4, it.w + dx)), h: r1(Math.max(4, it.h + dy)) };
  }

  // ---- İşaretçi olayları --------------------------------------------------------------------
  const pageOf = (target) => {
    const el = target && target.closest ? target.closest('.pdf-page') : null;
    return el ? pages[+el.dataset.num - 1] : null;
  };
  const local = (p, e) => {
    const r = p.el.getBoundingClientRect();
    const { width, height } = getSize(p);
    return [Math.max(0, Math.min(width, ((e.clientX - r.left) / r.width) * width)), Math.max(0, Math.min(height, ((e.clientY - r.top) / r.height) * height))];
  };

  let active = null; // devam eden çizim
  const touches = new Set();
  function cancelActive() {
    if (!active) return;
    if (active.el) active.el.remove();
    active = null;
  }
  const onDown = (e) => {
    if (e.pointerType === 'touch') touches.add(e.pointerId);
    if (touches.size > 1) { cancelActive(); return; } // iki parmak: yakınlaştırma
    if (e.button > 0) return;
    const p = pageOf(e.target);
    if (!tool) {
      // Araç seçili değilken: notlara dokununca seçilir
      const g = e.target.closest && e.target.closest('.ann-item');
      if (!g) { if (selected && !e.target.closest('.ann-sel')) select(null); return; }
      select(g.dataset.id);
      return;
    }
    if (!p) return;
    const [x, y] = local(p, e);
    if (tool === 'erase') {
      const g = e.target.closest && e.target.closest('.ann-item');
      if (g) commit(items.filter((it) => it.id !== g.dataset.id));
      return;
    }
    if (tool === 'text') return; // dokunup bırakınca eklenir (onUp)
    e.preventDefault();
    const svg = layerFor(p);
    if (tool === 'pen') {
      const el = svgEl('path', { d: inkPath([r1(x), r1(y)]), fill: 'none', stroke: penColor, 'stroke-width': penW, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
      svg.append(el);
      active = { id: e.pointerId, p, el, pts: [r1(x), r1(y)] };
    } else if (tool === 'hl') {
      const el = svgEl('rect', { x, y, width: 0, height: 0, fill: hlColor, 'fill-opacity': 0.45, class: 'ann-hl' });
      svg.append(el);
      active = { id: e.pointerId, p, el, x0: x, y0: y, x, y };
    }
    try { pagesEl.setPointerCapture(e.pointerId); } catch { /* yok say */ }
  };
  const onMove = (e) => {
    if (!active || e.pointerId !== active.id) return;
    e.preventDefault();
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ev of evs.length ? evs : [e]) {
      const [x, y] = local(active.p, ev);
      if (tool === 'pen') {
        const n = active.pts.length;
        if (Math.hypot(x - active.pts[n - 2], y - active.pts[n - 1]) < 0.6) continue;
        active.pts.push(r1(x), r1(y));
      } else { active.x = x; active.y = y; }
    }
    if (tool === 'pen') active.el.setAttribute('d', inkPath(active.pts));
    else {
      const x0 = Math.min(active.x0, active.x), y0 = Math.min(active.y0, active.y);
      active.el.setAttribute('x', x0); active.el.setAttribute('y', y0);
      active.el.setAttribute('width', Math.abs(active.x - active.x0)); active.el.setAttribute('height', Math.abs(active.y - active.y0));
    }
  };
  const onUp = async (e) => {
    touches.delete(e.pointerId);
    if (tool === 'text' && e.type === 'pointerup' && !active) {
      const p = pageOf(e.target);
      if (!p || e.target.closest('.ann-sel')) return;
      const [x, y] = local(p, e);
      const r = await textDialog({ s: 14, c: penColor });
      if (!r) return;
      const it = { id: uid(), p: p.num - 1, t: 'text', x: r1(x), y: r1(Math.max(0, y - r.s * 0.6)), ...r };
      commit([...items, it]);
      setTool(null);
      select(it.id);
      return;
    }
    if (!active || e.pointerId !== active.id) return;
    const a = active;
    active = null;
    a.el.remove();
    if (e.type === 'pointercancel') return;
    if (tool === 'pen') {
      commit([...items, { id: uid(), p: a.p.num - 1, t: 'ink', pts: a.pts, c: penColor, w: penW }]);
    } else if (tool === 'hl') {
      const w = Math.abs(a.x - a.x0), hh = Math.abs(a.y - a.y0);
      if (w < 3 || hh < 3) return;
      commit([...items, { id: uid(), p: a.p.num - 1, t: 'hl', x: r1(Math.min(a.x0, a.x)), y: r1(Math.min(a.y0, a.y)), w: r1(w), h: r1(hh), c: hlColor }]);
    }
  };
  pagesEl.addEventListener('pointerdown', onDown);
  pagesEl.addEventListener('pointermove', onMove);
  pagesEl.addEventListener('pointerup', onUp);
  pagesEl.addEventListener('pointercancel', onUp);

  // ---- İmza ---------------------------------------------------------------------------------
  async function addSignature() {
    if (readOnlyReason()) { toast(readOnlyReason(), { type: 'error' }); return; }
    setTool(null);
    const sig = await signaturePad();
    if (!sig) return;
    const p = pages[currentPage() - 1];
    const { width, height } = getSize(p);
    const w = Math.min(180, width * 0.4);
    const hh = (w * sig.h) / sig.w;
    // Görünen alanın ortasına yerleştir; kullanıcı sürükleyip taşıyabilir
    const r = p.el.getBoundingClientRect();
    const midY = ((window.innerHeight / 2 - r.top) / r.height) * height;
    const y = Math.max(0, Math.min(height - hh, midY - hh / 2));
    const it = { id: uid(), p: p.num - 1, t: 'img', x: r1((width - w) / 2), y: r1(y), w: r1(w), h: r1(hh), src: sig.src };
    commit([...items, it]);
    select(it.id);
    toast('İmza eklendi. Sürükleyerek taşıyabilir, köşesinden boyutlandırabilirsiniz.', { timeout: 4500 });
  }

  // ---- Araç çubuğu --------------------------------------------------------------------------
  const bar = h('div', { class: 'annot-bar', role: 'toolbar', 'aria-label': 'Not araçları', hidden: true });
  const toolBtns = {};
  const mk = (id, ic, title) => {
    const b = tbtn(ic, title, () => setTool(tool === id ? null : id), { text: title, cls: 'tb-wide ann-tool' });
    toolBtns[id] = b;
    return b;
  };
  const opts = h('div', { class: 'annot-opts' });
  const undoBtn = tbtn('undo', 'Geri al', () => { if (!undo.length) return; redo.push(items); items = undo.pop(); onChange(items); refreshAll(); updateBar(); });
  const redoBtn = tbtn('redo', 'Yinele', () => { if (!redo.length) return; undo.push(items); items = redo.pop(); onChange(items); refreshAll(); updateBar(); });
  bar.append(
    mk('pen', 'pen', 'Kalem'), mk('hl', 'highlight', 'Vurgula'), mk('text', 'textbox', 'Metin'),
    tbtn('signature', 'İmza', addSignature, { text: 'İmza', cls: 'tb-wide' }),
    mk('erase', 'eraser', 'Silgi'),
    tsep(), opts, tsep(), undoBtn, redoBtn,
    h('div', { class: 'top-spacer' }),
    tbtn('check', 'Bitti', () => toggleBar(false), { text: 'Bitti', cls: 'tb-wide tb-accent' }),
  );

  function drawOpts() {
    clear(opts);
    const colors = tool === 'hl' ? HL_COLORS : PEN_COLORS;
    const cur = tool === 'hl' ? hlColor : penColor;
    if (tool === 'pen' || tool === 'hl' || tool === 'text') {
      for (const c of colors) {
        const b = h('button', { class: 'swatch' + (c === cur ? ' on' : ''), type: 'button', title: 'Renk', 'aria-label': 'Renk', style: { background: c } });
        b.addEventListener('mousedown', (e) => e.preventDefault());
        b.addEventListener('click', () => { if (tool === 'hl') hlColor = c; else penColor = c; drawOpts(); });
        opts.append(b);
      }
    }
    if (tool === 'pen') {
      for (const w of WIDTHS) {
        const b = h('button', { class: 'pen-w' + (w.v === penW ? ' on' : ''), type: 'button', title: w.label, 'aria-label': `Kalınlık: ${w.label}` }, h('span', { style: { height: Math.max(2, w.v * 1.3) + 'px' } }));
        b.addEventListener('click', () => { penW = w.v; drawOpts(); });
        opts.append(b);
      }
    }
    if (!tool) opts.append(h('span', { class: 'annot-hint' }, items.length ? 'Bir notu taşımak için üzerine dokunun.' : 'Bir araç seçin.'));
    if (tool === 'text') opts.append(h('span', { class: 'annot-hint' }, 'Metnin konacağı yere dokunun.'));
    if (tool === 'erase') opts.append(h('span', { class: 'annot-hint' }, 'Silinecek nota dokunun.'));
  }
  function updateBar() {
    undoBtn.disabled = !undo.length;
    redoBtn.disabled = !redo.length;
  }
  function setTool(t) {
    if (t && readOnlyReason()) { toast(readOnlyReason(), { type: 'error' }); return; }
    tool = t;
    cancelActive();
    if (t) select(null);
    for (const [id, b] of Object.entries(toolBtns)) b.classList.toggle('on', id === t);
    pagesEl.classList.toggle('annot-drawing', t === 'pen' || t === 'hl');
    pagesEl.classList.toggle('annot-tool', !!t);
    drawOpts();
  }
  function toggleBar(on) {
    bar.hidden = !on;
    if (!on) { setTool(null); select(null); } else drawOpts();
  }
  updateBar();
  drawOpts();

  return {
    bar,
    toggleBar,
    isOpen: () => !bar.hidden,
    drawPage,
    refreshAll,
    items: () => items,
    reset(next) { items = next; undo.length = 0; redo.length = 0; refreshAll(); updateBar(); },
    /** Geri tuşu: önce araç, sonra seçim, sonra çubuk kapanır. */
    back() {
      if (tool) { setTool(null); return true; }
      if (selected) { select(null); return true; }
      if (!bar.hidden) { toggleBar(false); return true; }
      return false;
    },
    destroy() {
      pagesEl.removeEventListener('pointerdown', onDown);
      pagesEl.removeEventListener('pointermove', onMove);
      pagesEl.removeEventListener('pointerup', onUp);
      pagesEl.removeEventListener('pointercancel', onUp);
    },
  };
}
