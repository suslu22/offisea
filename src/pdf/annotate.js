// PDF üzerine notlar: kalem, vurgulayıcı, metin ve imza.
// Notlar belge verisinde ayrı tutulur (sayfanın ekranda görünen yönünde, 1 birim = 1 pt);
// PDF olarak kaydedilirken saydam bir katman halinde sayfaya işlenir.
import { h, icon, tbtn, tsep, clear, modal, toast } from '../core/ui.js';
import { signaturePad } from './tools-ui.js';
import { FONT_CSS, METRICS, fontCss, wrapLines, loadScreenFonts } from './textlayout.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const TEXT_FONT = FONT_CSS.sans;
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
    else if (a.t === 'tedit' && typeof a.text === 'string') {
      out.push({
        ...base, t: 'tedit', x: num(a.x), y: num(a.y), w: Math.max(0, num(a.w)), h: Math.max(0, num(a.h)),
        bx: num(a.bx), by: num(a.by), bw: Math.max(4, num(a.bw)), lh: Math.min(400, Math.max(1, num(a.lh) || 12)),
        s: Math.min(144, Math.max(3, num(a.s) || 12)), ff: a.ff === 'serif' ? 'serif' : 'sans', b: !!a.b, i: !!a.i,
        c: safeColor(a.c, '#000000'), bg: safeColor(a.bg, '#ffffff'), text: a.text.slice(0, 20000), oc: Math.max(0, num(a.oc) | 0),
      });
    }
  }
  return out;
}

/** PDF'e yazı (vektör) olarak işlenen notlar; diğerleri resim katmanı olarak işlenir. */
export const isVectorItem = (it) => it.t === 'text' || it.t === 'tedit';

/** Düzenlenmiş yazının satırları ve taban çizgileri. */
export function teditLines(it) {
  return wrapLines(it, it.bw).map((str, k) => ({ str, x: it.bx, y: it.by + k * it.lh }));
}

/** Metin notunun satırları (taban çizgileriyle). */
export function textLines(it) {
  return it.text.split('\n').map((str, k) => ({ str, x: it.x, y: it.y + it.s * 0.85 + k * it.s * 1.2 }));
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
  if (it.t === 'tedit') {
    const m = METRICS[it.ff] || METRICS.sans;
    const n = Math.max(1, teditLines(it).length);
    const x0 = Math.min(it.x, it.bx), y0 = Math.min(it.y, it.by - it.s * m.a);
    const x1 = Math.max(it.x + it.w, it.bx + it.bw), y1 = Math.max(it.y + it.h, it.by + (n - 1) * it.lh + it.s * m.d);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
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
  } else if (it.t === 'tedit') {
    // Özgün yazının üstü arka plan rengiyle örtülür, yeni yazı aynı yere yazılır
    el = svgEl('g', {});
    el.append(svgEl('rect', { x: it.x, y: it.y, width: it.w, height: it.h, fill: it.bg }));
    const t = svgEl('text', { 'font-size': it.s, fill: it.c, 'font-family': FONT_CSS[it.ff], 'font-weight': it.b ? 700 : 400, 'font-style': it.i ? 'italic' : 'normal', style: 'white-space:pre' });
    for (const l of teditLines(it)) {
      const ts = svgEl('tspan', { x: l.x, y: l.y });
      ts.textContent = l.str;
      t.append(ts);
    }
    el.append(t);
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
  if (items.some(isVectorItem)) await loadScreenFonts();
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
    } else if (it.t === 'tedit') {
      ctx.fillStyle = it.bg;
      ctx.fillRect(it.x, it.y, it.w, it.h);
      ctx.fillStyle = it.c; ctx.font = fontCss(it, it.s); ctx.textBaseline = 'alphabetic';
      for (const l of teditLines(it)) ctx.fillText(l.str, l.x, l.y);
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
export function createAnnotator({ pages, pagesEl, getSize, currentPage, initial, onChange, readOnlyReason, getBlocks, colorsAt }) {
  let items = initial;
  let tool = null; // null | 'pen' | 'hl' | 'text' | 'erase' | 'tedit'
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
    const list = items.filter((x) => x.p === p.num - 1 && !(editor && editor.orig && editor.orig.id === x.id));
    if (!list.length && !p.annotSvg && tool !== 'tedit') return;
    const svg = layerFor(p);
    while (svg.firstChild) svg.firstChild.remove();
    for (const it of list) svg.append(itemSvg(it));
    if (tool === 'tedit') {
      // Düzenlenebilir yazı blokları kesik çizgiyle gösterilir
      const bl = blockCache.get(p.num);
      if (!Array.isArray(bl)) { if (p.renderedScale) blocksFor(p).then(() => { if (tool === 'tedit') drawPage(p); }); } else {
        const edited = list.filter((x) => x.t === 'tedit');
        for (const b of bl) {
          if (edited.some((e) => overlaps(e, b))) continue;
          svg.append(svgEl('rect', { x: b.x, y: b.y, width: b.w, height: b.h, class: 'ann-block' }));
        }
      }
    }
    if (list.some(isVectorItem) && !fontsAsked) {
      fontsAsked = true;
      loadScreenFonts().then((ok) => { if (ok) refreshAll(); });
    }
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
    const isEdit = it.t === 'tedit';
    const delTitle = isEdit ? 'Özgün yazıya dön' : 'Sil';
    const del = h('button', { class: 'ann-sel-del', type: 'button', title: delTitle, 'aria-label': isEdit ? delTitle : 'Notu sil' }, icon(isEdit ? 'restore' : 'trash', 15));
    del.addEventListener('pointerdown', (e) => e.stopPropagation());
    del.addEventListener('click', (e) => { e.stopPropagation(); commit(items.filter((x) => x.id !== it.id)); select(null); });
    if (isEdit) {
      // Düzenlenmiş yazı yerinden oynatılmaz; yeniden düzenlenebilir ya da özgün haline döndürülebilir
      selBox.classList.add('ann-sel-fixed');
      const edit = h('button', { class: 'ann-sel-edit', type: 'button', title: 'Düzenle', 'aria-label': 'Yazıyı düzenle' }, icon('textbox', 15));
      edit.addEventListener('pointerdown', (e) => e.stopPropagation());
      edit.addEventListener('click', (e) => { e.stopPropagation(); const cur = byId(it.id); setTool('tedit'); if (cur) openEditor(p, cur, cur); });
      selBox.append(del, edit);
      selBox.addEventListener('pointerdown', (e) => e.stopPropagation());
      p.el.append(selBox);
      positionSel();
      return;
    }
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
  let downPt = null;
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
    if (tool === 'text' || tool === 'tedit') { downPt = [e.clientX, e.clientY]; return; } // dokunup bırakınca eklenir (onUp)
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
    if (tool === 'tedit' && e.type === 'pointerup' && !active) {
      if (e.target.closest('.ted-wrap') || e.target.closest('.ann-sel')) return;
      if (!downPt || Math.hypot(e.clientX - downPt[0], e.clientY - downPt[1]) > 10) return; // kaydırma/seçme
      const p = pageOf(e.target);
      const wasOpen = !!editor;
      if (editor) closeEditor(true);
      if (!p) return;
      const [x, y] = local(p, e);
      await openEditorAt(p, x, y, wasOpen);
      return;
    }
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

  // ---- Yazı düzenleme (PDF'teki mevcut yazıları değiştirme / silme) --------------------------------
  const blockCache = new Map();
  let editor = null; // { p, d (taslak), orig, start, el, ta }
  let fontsAsked = false;
  const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  function blocksFor(p) {
    if (!blockCache.has(p.num)) {
      const pr = Promise.resolve(getBlocks ? getBlocks(p) : []).catch(() => []);
      blockCache.set(p.num, pr);
      pr.then((bl) => blockCache.set(p.num, bl));
    }
    const v = blockCache.get(p.num);
    return v instanceof Promise ? v : Promise.resolve(v);
  }
  async function openEditorAt(p, x, y, quiet) {
    const pi = p.num - 1;
    const hit = (b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
    const ex = items.find((it) => it.t === 'tedit' && it.p === pi && hit(bbox(it)));
    if (ex) { openEditor(p, ex, ex); return; }
    const bl = (await blocksFor(p)).filter((b) => hit(b) && !items.some((it) => it.t === 'tedit' && it.p === pi && overlaps(it, b)));
    if (!bl.length) {
      if (!quiet) toast('Burada düzenlenebilir yazı yok. Yeni yazı eklemek için “Metin” aracını kullanın.', { timeout: 4000 });
      return;
    }
    const b = bl.sort((u, v) => u.w * u.h - v.w * v.h)[0];
    const col = colorsAt ? colorsAt(p, b) : { c: '#000000', bg: '#ffffff' };
    openEditor(p, { id: uid(), p: pi, t: 'tedit', ...b, c: col.c, bg: col.bg }, null);
  }
  const STYLE_KEYS = ['text', 's', 'ff', 'b', 'i', 'c', 'lh'];
  async function openEditor(p, item, orig) {
    if (editor) closeEditor(true);
    select(null);
    const d = { ...item };
    const wrap = h('div', { class: 'ted-wrap' });
    const cover = h('div', { class: 'ted-cover' });
    const ta = h('textarea', { class: 'ted-input', spellcheck: 'false', 'aria-label': 'Yazıyı düzenle' });
    ta.value = d.text;
    wrap.append(cover, ta);
    p.el.append(wrap);
    editor = { p, d, orig, start: { ...item }, el: wrap, ta };
    const px = (v) => `calc(var(--total-scale-factor) * ${Math.round(v * 100) / 100}px)`;
    const apply = () => {
      const m = METRICS[d.ff] || METRICS.sans;
      Object.assign(cover.style, { left: px(d.x), top: px(d.y), width: px(d.w), height: px(d.h), background: d.bg });
      const top = d.by - (d.lh - d.s * (m.a + m.d)) / 2 - d.s * m.a;
      d.text = ta.value.replace(/\r/g, '');
      const n = Math.max(1, wrapLines(d, d.bw).length);
      Object.assign(ta.style, {
        left: px(d.bx), top: px(top), width: px(d.bw), height: px(n * d.lh + 1),
        fontSize: px(d.s), lineHeight: px(d.lh), fontFamily: FONT_CSS[d.ff], fontWeight: d.b ? '700' : '400',
        fontStyle: d.i ? 'italic' : 'normal', color: d.c, background: d.bg,
      });
    };
    editor.apply = apply;
    await loadScreenFonts();
    if (editor && editor.ta === ta) apply();
    ta.addEventListener('input', apply);
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); closeEditor(false); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); closeEditor(true); }
    });
    for (const ev of ['pointerdown', 'pointerup']) wrap.addEventListener(ev, (e) => e.stopPropagation());
    drawPage(p);
    drawOpts();
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }
  function closeEditor(save) {
    const ed = editor;
    if (!ed) return;
    editor = null;
    ed.el.remove();
    if (save) {
      ed.d.text = ed.ta.value.replace(/\r/g, '').replace(/\s+$/, '');
      const changed = STYLE_KEYS.some((k) => ed.d[k] !== ed.start[k]);
      if (changed) {
        const next = { ...ed.d };
        commit(ed.orig ? items.map((x) => (x.id === ed.orig.id ? next : x)) : [...items, next]);
      } else drawPage(ed.p);
    } else drawPage(ed.p);
    drawOpts();
  }
  function editorOpts() {
    const d = editor.d;
    const keep = (el) => { el.addEventListener('mousedown', (e) => { if (el.tagName !== 'SELECT') e.preventDefault(); }); return el; };
    const refocus = () => editor && editor.ta.focus({ preventScroll: true });
    const sizes = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72];
    const cur = Math.round(d.s * 10) / 10;
    if (!sizes.includes(cur)) sizes.push(cur);
    sizes.sort((a, b) => a - b);
    const size = tselectEl(sizes.map((n) => ({ value: String(n), label: String(n).replace('.', ',') + ' pt' })), String(cur), 'Yazı boyutu', (v) => {
      const ns = +v;
      d.lh = Math.round(d.lh * (ns / d.s) * 100) / 100;
      d.s = ns;
      editor.apply(); refocus();
    });
    const fam = tselectEl([{ value: 'sans', label: 'Yalın (Arial)' }, { value: 'serif', label: 'Tırnaklı (Times)' }], d.ff, 'Yazı tipi', (v) => { d.ff = v; editor.apply(); refocus(); });
    const toggle = (key, text, title, cls) => {
      const b = keep(h('button', { class: `tbtn ${cls}${d[key] ? ' on' : ''}`, type: 'button', title, 'aria-label': title, 'aria-pressed': d[key] ? 'true' : 'false' }, h('span', { class: 'tbtn-text' }, text)));
      b.addEventListener('click', () => { d[key] = !d[key]; b.classList.toggle('on', d[key]); b.setAttribute('aria-pressed', d[key] ? 'true' : 'false'); editor.apply(); refocus(); });
      return b;
    };
    opts.append(fam, size, toggle('b', 'K', 'Kalın', 'tb-bold'), toggle('i', 'İ', 'İtalik', 'tb-italic'));
    const cols = [...new Set([editor.start.c, ...PEN_COLORS])];
    for (const c of cols) {
      const b = keep(h('button', { class: 'swatch' + (c === d.c ? ' on' : ''), type: 'button', title: 'Yazı rengi', 'aria-label': 'Yazı rengi', style: { background: c } }));
      b.addEventListener('click', () => { d.c = c; opts.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('on', x === b)); editor.apply(); refocus(); });
      opts.append(b);
    }
    opts.append(
      keep(tbtn('trash', 'Bu yazıyı sil', () => { editor.ta.value = ''; closeEditor(true); }, { text: 'Sil', cls: 'tb-wide' })),
      keep(tbtn('close', 'Vazgeç (Esc)', () => closeEditor(false))),
      keep(tbtn('check', 'Tamam (Ctrl+Enter)', () => closeEditor(true), { text: 'Tamam', cls: 'tb-wide' })),
    );
    // Dar ekranlarda çubuk kaydırılır ki "Tamam" görünsün
    requestAnimationFrame(() => {
      const last = opts.lastElementChild;
      if (!last || !bar.isConnected) return;
      const over = last.getBoundingClientRect().right - bar.getBoundingClientRect().right;
      if (over > 0) bar.scrollLeft += over + 8;
    });
  }
  function tselectEl(options, value, title, onChange) {
    const s = h('select', { class: 'tselect', title, 'aria-label': title });
    for (const o of options) s.append(h('option', { value: o.value }, o.label));
    s.value = value;
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }

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
    mk('tedit', 'font', 'Yazıyı düzenle'),
    mk('pen', 'pen', 'Kalem'), mk('hl', 'highlight', 'Vurgula'), mk('text', 'textbox', 'Metin'),
    tbtn('signature', 'İmza', addSignature, { text: 'İmza', cls: 'tb-wide' }),
    mk('erase', 'eraser', 'Silgi'),
    tsep(), opts, tsep(), undoBtn, redoBtn,
    h('div', { class: 'top-spacer' }),
    tbtn('check', 'Bitti', () => toggleBar(false), { text: 'Bitti', cls: 'tb-wide tb-accent' }),
  );

  function drawOpts() {
    clear(opts);
    if (tool === 'tedit') {
      if (editor) editorOpts();
      else { opts.append(h('span', { class: 'annot-hint' }, 'Değiştirmek ya da silmek istediğiniz yazıya dokunun.')); bar.scrollLeft = 0; }
      return;
    }
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
    if (editor && t !== 'tedit') closeEditor(true);
    const was = tool;
    tool = t;
    cancelActive();
    if (t) select(null);
    for (const [id, b] of Object.entries(toolBtns)) b.classList.toggle('on', id === t);
    pagesEl.classList.toggle('annot-drawing', t === 'pen' || t === 'hl');
    pagesEl.classList.toggle('annot-tool', !!t);
    pagesEl.classList.toggle('annot-tedit', t === 'tedit');
    if (was === 'tedit' || t === 'tedit') for (const p of pages) if (p.renderedScale || p.annotSvg) drawPage(p);
    if (t === 'tedit') loadScreenFonts();
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
      if (editor) { closeEditor(true); return true; }
      if (tool) { setTool(null); return true; }
      if (selected) { select(null); return true; }
      if (!bar.hidden) { toggleBar(false); return true; }
      return false;
    },
    /** Açık düzenleme kutusunu kaydedip kapatır (kaydetmeden önce). */
    flush() { if (editor) closeEditor(true); },
    destroy() {
      pagesEl.removeEventListener('pointerdown', onDown);
      pagesEl.removeEventListener('pointermove', onMove);
      pagesEl.removeEventListener('pointerup', onUp);
      pagesEl.removeEventListener('pointercancel', onUp);
    },
  };
}
