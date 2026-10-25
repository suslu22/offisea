// Sunum modeli ve slayt çizimi. Koordinatlar piksel (96 dpi); varsayılan 16:9 = 960×540.
// Model değiştirilemez (immutable) kullanılır: her değişiklik yeni nesne üretir, böylece
// geri alma yığını yalnızca eski nesnelere başvuru tutar (büyük resimler kopyalanmaz).
import { sanitizeSlideHtml } from '../core/sanitize.js';
import { TRANSITION_IDS, themeById } from './themes.js';

export const DEF_W = 960;
export const DEF_H = 540;
const SVG_NS = 'http://www.w3.org/2000/svg';

let seq = 0;
export function uid() {
  seq = (seq + 1) % 1e6;
  return Date.now().toString(36) + '-' + seq.toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

export const PH_TEXT = {
  title: 'Başlık eklemek için tıklayın',
  subtitle: 'Alt başlık eklemek için tıklayın',
  body: 'Metin eklemek için tıklayın',
};

function textItem(ph, x, y, w, h, extra = {}) {
  return { id: uid(), type: 'text', ph, x, y, w, h, html: '', ...extra };
}

export const LAYOUTS = [
  { id: 'title', label: 'Başlık slaytı' },
  { id: 'content', label: 'Başlık ve içerik' },
  { id: 'two', label: 'İki içerik' },
  { id: 'section', label: 'Bölüm başlığı' },
  { id: 'titleOnly', label: 'Yalnızca başlık' },
  { id: 'blank', label: 'Boş' },
];

export function newSlide(layout = 'content', W = DEF_W, H = DEF_H) {
  const sx = W / DEF_W, sy = H / DEF_H;
  const S = (x, y, w, h) => [x * sx, y * sy, w * sx, h * sy];
  const items = [];
  const title = { fs: 40, valign: 'bottom' };
  switch (layout) {
    case 'title':
      items.push(textItem('title', ...S(80, 140, 800, 150), { fs: 54, align: 'center', valign: 'bottom' }));
      items.push(textItem('subtitle', ...S(120, 300, 720, 90), { fs: 26, align: 'center', valign: 'top', color: '#595959' }));
      break;
    case 'content':
      items.push(textItem('title', ...S(60, 30, 840, 90), title));
      items.push(textItem('body', ...S(60, 135, 840, 370), { fs: 26, valign: 'top', list: true }));
      break;
    case 'two':
      items.push(textItem('title', ...S(60, 30, 840, 90), title));
      items.push(textItem('body', ...S(60, 135, 410, 370), { fs: 24, valign: 'top', list: true }));
      items.push(textItem('body', ...S(490, 135, 410, 370), { fs: 24, valign: 'top', list: true }));
      break;
    case 'section':
      items.push(textItem('title', ...S(60, 160, 840, 140), { fs: 50, valign: 'bottom' }));
      items.push(textItem('body', ...S(60, 310, 840, 70), { fs: 24, valign: 'top', color: '#595959' }));
      break;
    case 'titleOnly':
      items.push(textItem('title', ...S(60, 30, 840, 90), title));
      break;
    default: break;
  }
  return { id: uid(), bg: '#ffffff', notes: '', items };
}

export function newDeck() {
  return { v: 1, w: DEF_W, h: DEF_H, slides: [newSlide('title')] };
}

export function normalizeDeck(d) {
  if (!d || !Array.isArray(d.slides)) return newDeck();
  const w = +d.w > 0 ? +d.w : DEF_W, h = +d.h > 0 ? +d.h : DEF_H;
  const slides = d.slides.map((s) => ({
    id: s.id || uid(),
    bg: typeof s.bg === 'string' ? s.bg : '#ffffff',
    bgImg: typeof s.bgImg === 'string' && /^data:image\//.test(s.bgImg) ? s.bgImg : undefined,
    notes: typeof s.notes === 'string' ? s.notes : '',
    transition: TRANSITION_IDS.has(s.transition) && s.transition !== 'none' ? s.transition : undefined,
    items: Array.isArray(s.items) ? s.items.filter((it) => it && typeof it === 'object').map((it) => ({ ...it, id: it.id || uid() })) : [],
  }));
  const theme = typeof d.theme === 'string' && themeById(d.theme) ? d.theme : undefined;
  return { v: 1, w, h, theme, slides: slides.length ? slides : [newSlide('title', w, h)] };
}

// ---- Şekiller ------------------------------------------------------------------------------
export const SHAPES = [
  { id: 'rect', label: 'Dikdörtgen', icon: 'rect' },
  { id: 'roundRect', label: 'Yuvarlak dikdörtgen', icon: 'roundRect' },
  { id: 'ellipse', label: 'Elips', icon: 'ellipse' },
  { id: 'triangle', label: 'Üçgen', icon: 'triangle' },
  { id: 'diamond', label: 'Eşkenar dörtgen', icon: 'diamond' },
  { id: 'rightArrow', label: 'Ok', icon: 'arrowShape' },
  { id: 'star5', label: 'Yıldız', icon: 'star' },
  { id: 'hexagon', label: 'Altıgen', icon: 'shape' },
  { id: 'line', label: 'Çizgi', icon: 'line' },
];

function shapePath(shape, w, h) {
  switch (shape) {
    case 'triangle': return `M${w / 2},0 L${w},${h} L0,${h} Z`;
    case 'rtTriangle': return `M0,0 L${w},${h} L0,${h} Z`;
    case 'diamond': return `M${w / 2},0 L${w},${h / 2} L${w / 2},${h} L0,${h / 2} Z`;
    case 'hexagon': { const k = Math.min(w / 4, h / 2); return `M${k},0 L${w - k},0 L${w},${h / 2} L${w - k},${h} L${k},${h} L0,${h / 2} Z`; }
    case 'pentagon': return `M${w / 2},0 L${w},${h * 0.38} L${w * 0.81},${h} L${w * 0.19},${h} L0,${h * 0.38} Z`;
    case 'rightArrow': { const hy = h * 0.25, hx = Math.min(w * 0.5, h * 0.6); return `M0,${hy} L${w - hx},${hy} L${w - hx},0 L${w},${h / 2} L${w - hx},${h} L${w - hx},${h - hy} L0,${h - hy} Z`; }
    case 'leftArrow': { const hy = h * 0.25, hx = Math.min(w * 0.5, h * 0.6); return `M${w},${hy} L${hx},${hy} L${hx},0 L0,${h / 2} L${hx},${h} L${hx},${h - hy} L${w},${h - hy} Z`; }
    case 'star5': {
      const pts = [];
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const r = i % 2 ? 0.4 : 1;
        pts.push(`${w / 2 + (Math.cos(a) * r * w) / 2},${h / 2 + (Math.sin(a) * r * h) / 2 + h * 0.05}`);
      }
      return 'M' + pts.join(' L') + ' Z';
    }
    case 'chevron': { const k = Math.min(w * 0.4, h * 0.5); return `M0,0 L${w - k},0 L${w},${h / 2} L${w - k},${h} L0,${h} L${k},${h / 2} Z`; }
    case 'parallelogram': { const k = Math.min(w * 0.25, h); return `M${k},0 L${w},0 L${w - k},${h} L0,${h} Z`; }
    case 'trapezoid': { const k = Math.min(w * 0.25, h); return `M${k},0 L${w - k},0 L${w},${h} L0,${h} Z`; }
    default: return null;
  }
}

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  return el;
}

const safeColor = (c, def = 'none') => (typeof c === 'string' && /^(#[0-9a-f]{3,8}|none|transparent|rgba?\([\d\s.,%]+\))$/i.test(c) ? c : def);

function shapeSvg(it) {
  const w = Math.max(1, it.w), h = Math.max(1, it.h);
  const sw = it.strokeW != null ? +it.strokeW : it.shape === 'line' ? 2 : 0;
  const pad = sw / 2 + 1;
  const svg = svgEl('svg', { width: w + pad * 2, height: h + pad * 2, viewBox: `${-pad} ${-pad} ${w + pad * 2} ${h + pad * 2}`, class: 'shape-svg' });
  svg.style.left = -pad + 'px';
  svg.style.top = -pad + 'px';
  const fill = safeColor(it.fill, it.shape === 'line' ? 'none' : '#4472c4');
  const stroke = safeColor(it.stroke, it.shape === 'line' ? '#4472c4' : 'none');
  const common = { fill, stroke: sw > 0 ? stroke : 'none', 'stroke-width': sw > 0 ? sw : null };
  if (it.dash) common['stroke-dasharray'] = `${sw * 3} ${sw * 2}`;
  let el;
  if (it.shape === 'line') {
    const [x1, y1, x2, y2] = [it.flipH ? w : 0, it.flipV ? h : 0, it.flipH ? 0 : w, it.flipV ? 0 : h];
    el = svgEl('line', { x1, y1, x2, y2, stroke, 'stroke-width': Math.max(1, sw), 'stroke-linecap': 'round' });
    if (it.arrowEnd) {
      const ang = Math.atan2(y2 - y1, x2 - x1), L = Math.max(8, sw * 4);
      const p1 = [x2 - L * Math.cos(ang - 0.45), y2 - L * Math.sin(ang - 0.45)];
      const p2 = [x2 - L * Math.cos(ang + 0.45), y2 - L * Math.sin(ang + 0.45)];
      svg.append(svgEl('path', { d: `M${p1} L${x2},${y2} L${p2} Z`, fill: stroke }));
    }
  } else if (it.shape === 'ellipse') el = svgEl('ellipse', { cx: w / 2, cy: h / 2, rx: w / 2, ry: h / 2, ...common });
  else if (it.shape === 'roundRect') el = svgEl('rect', { x: 0, y: 0, width: w, height: h, rx: Math.min(w, h) * 0.16, ...common });
  else {
    const d = shapePath(it.shape, w, h);
    el = d ? svgEl('path', { d, ...common }) : svgEl('rect', { x: 0, y: 0, width: w, height: h, ...common });
  }
  svg.prepend(el);
  return svg;
}

// ---- Çizim ---------------------------------------------------------------------------------
export function textHtml(html) {
  return sanitizeSlideHtml(html || '');
}

function applyTextBox(box, it, { editor }) {
  box.classList.add('item-text', 'va-' + (it.valign || 'top'));
  const pad = it.pad || [7, 10, 7, 10];
  box.style.padding = pad.map((p) => p + 'px').join(' ');
  const content = document.createElement('div');
  content.className = 'text-content' + (it.list ? ' as-list' : '');
  const st = content.style;
  st.fontSize = (it.fs || 24) + 'px';
  if (it.color) st.color = safeColor(it.color, '#000');
  if (it.font) st.fontFamily = `"${String(it.font).replace(/["\\;{}<>]/g, '')}", Calibri, Arial, sans-serif`;
  if (it.bold) st.fontWeight = 'bold';
  if (it.italic) st.fontStyle = 'italic';
  if (it.align) st.textAlign = it.align;
  if (it.lh) st.lineHeight = String(it.lh);
  content.innerHTML = textHtml(it.html); // DOMPurify ile temizlenmiş içerik
  if (editor && it.ph && !content.textContent.trim() && !content.querySelector('img')) {
    content.classList.add('is-empty');
    content.dataset.ph = PH_TEXT[it.ph] || PH_TEXT.body;
  }
  box.append(content);
  return content;
}

function tableEl(it) {
  const t = document.createElement('table');
  t.className = 'slide-table';
  const cols = (it.rows[0] || []).length;
  const colW = Array.isArray(it.colW) && it.colW.length === cols ? it.colW : null;
  if (colW) {
    const cg = document.createElement('colgroup');
    const total = colW.reduce((a, b) => a + b, 0) || 1;
    for (const w of colW) { const c = document.createElement('col'); c.style.width = (w / total) * 100 + '%'; cg.append(c); }
    t.append(cg);
  }
  t.style.fontSize = (it.fs || 16) + 'px';
  const border = safeColor(it.border, '#8eaadb');
  it.rows.forEach((row, ri) => {
    const tr = document.createElement('tr');
    row.forEach((cell) => {
      if (!cell || cell.hidden) return;
      const td = document.createElement('td');
      if (cell.colSpan > 1) td.colSpan = cell.colSpan;
      if (cell.rowSpan > 1) td.rowSpan = cell.rowSpan;
      td.style.borderColor = border;
      const fill = cell.fill || (it.header && ri === 0 ? '#4472c4' : it.banded && ri % 2 === 0 ? '#d9e2f3' : null);
      if (fill) td.style.background = safeColor(fill, 'transparent');
      if (it.header && ri === 0 && !cell.color) { td.style.color = '#ffffff'; td.style.fontWeight = 'bold'; }
      if (cell.color) td.style.color = safeColor(cell.color, '#000');
      td.innerHTML = textHtml(cell.html); // temizlenmiş
      tr.append(td);
    });
    t.append(tr);
  });
  return t;
}

export function renderItem(it, opts = {}) {
  const el = document.createElement('div');
  el.className = 'slide-item item-' + it.type;
  el.dataset.id = it.id;
  const st = el.style;
  st.left = it.x + 'px';
  st.top = it.y + 'px';
  st.width = Math.max(1, it.w) + 'px';
  st.height = Math.max(1, it.h) + 'px';
  const tf = [];
  if (it.rot) tf.push(`rotate(${+it.rot}deg)`);
  if (it.type !== 'shape' && it.flipH) tf.push('scaleX(-1)');
  if (it.type !== 'shape' && it.flipV) tf.push('scaleY(-1)');
  if (tf.length) st.transform = tf.join(' ');
  if (it.opacity != null && it.opacity < 1) st.opacity = String(Math.max(0, it.opacity));

  if (it.type === 'image') {
    const img = document.createElement('img');
    if (typeof it.src === 'string' && /^data:image\/(png|jpe?g|gif|webp|bmp|svg\+xml);base64,/i.test(it.src)) img.src = it.src;
    img.alt = it.alt || '';
    img.draggable = false;
    img.decoding = 'async'; // büyük resimler arayüzü dondurmadan çözülür
    if (it.crop) {
      // crop: kırpma oranları {l,t,r,b} (0..1)
      const c = it.crop;
      const sw = 1 - (c.l || 0) - (c.r || 0), sh = 1 - (c.t || 0) - (c.b || 0);
      img.style.position = 'absolute';
      img.style.width = (100 / Math.max(0.01, sw)) + '%';
      img.style.height = (100 / Math.max(0.01, sh)) + '%';
      img.style.left = -(c.l || 0) / Math.max(0.01, sw) * 100 + '%';
      img.style.top = -(c.t || 0) / Math.max(0.01, sh) * 100 + '%';
      el.style.overflow = 'hidden';
    }
    el.append(img);
  } else if (it.type === 'shape') {
    el.append(shapeSvg(it));
    if (it.shape !== 'line') {
      const box = document.createElement('div');
      applyTextBox(box, { valign: 'middle', align: 'center', color: '#ffffff', fs: 20, ...it, ph: null }, opts);
      el.append(box);
    }
  } else if (it.type === 'table') {
    el.append(tableEl(it));
  } else {
    if (it.fill && it.fill !== 'none') st.background = safeColor(it.fill, 'transparent');
    if (it.stroke && it.strokeW) st.outline = `${+it.strokeW}px solid ${safeColor(it.stroke, '#000')}`;
    applyTextBox(el, it, opts);
  }
  return el;
}

export function renderSlide(slide, deck, opts = {}) {
  const el = document.createElement('div');
  el.className = 'slide-render';
  el.style.width = deck.w + 'px';
  el.style.height = deck.h + 'px';
  el.style.background = safeColor(slide.bg, '#ffffff');
  if (slide.bgImg && /^data:image\//.test(slide.bgImg)) {
    const bg = document.createElement('img');
    bg.className = 'slide-bg-img';
    bg.src = slide.bgImg;
    bg.alt = '';
    bg.draggable = false;
    bg.decoding = 'async';
    el.append(bg);
  }
  for (const it of slide.items) el.append(renderItem(it, opts));
  return el;
}

// Ölçeklenmiş slayt kutusu (küçük resimler, sunum modu, yazdırma)
export function scaledSlide(slide, deck, width, opts) {
  const s = width / deck.w;
  const box = document.createElement('div');
  box.className = 'slide-scaled';
  box.style.width = width + 'px';
  box.style.height = deck.h * s + 'px';
  const inner = renderSlide(slide, deck, opts);
  inner.style.transform = `scale(${s})`;
  inner.style.transformOrigin = '0 0';
  box.append(inner);
  return box;
}

// HTML metnini düz metne çevirir (notlar, dışa aktarma)
export function htmlToText(html) {
  const d = document.createElement('div');
  d.innerHTML = textHtml(html);
  return d.innerText || d.textContent || '';
}
