// Arayüz yardımcıları. Güvenlik notu: kullanıcı/dosya kaynaklı metinler her zaman
// textContent ile eklenir; innerHTML hiçbir yerde ham veriyle kullanılmaz.
import { ICONS } from './icons.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function icon(name, size = 20) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  for (const raw of ICONS[name] || []) {
    const p = document.createElementNS(SVG_NS, 'path');
    if (raw.startsWith('F:')) {
      p.setAttribute('d', raw.slice(2));
      p.setAttribute('fill', 'currentColor');
      p.setAttribute('stroke', 'none');
    } else {
      p.setAttribute('d', raw);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '2');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
    }
    svg.appendChild(p);
  }
  return svg;
}

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled' || k === 'hidden') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  d.cancel = () => clearTimeout(t);
  return d;
}

// ---- Bildirimler -------------------------------------------------------------
export function toast(message, { type = 'info', action = null, timeout = 3800 } = {}) {
  const host = document.getElementById('toasts');
  const el = h('div', { class: `toast toast-${type}` }, h('span', null, message));
  if (action) {
    el.append(h('button', { class: 'toast-action', onClick: () => { action.onClick(); el.remove(); } }, action.label));
  }
  host.append(el);
  if (timeout > 0) {
    setTimeout(() => el.classList.add('out'), timeout);
    setTimeout(() => el.remove(), timeout + 400);
  } else {
    // Kalıcı bildirim: kullanıcı kapatana kadar kalır.
    el.append(h('button', { class: 'toast-close', type: 'button', 'aria-label': 'Kapat', title: 'Kapat', onClick: () => el.remove() }, '×'));
  }
  return el;
}

// ---- Butonlar ----------------------------------------------------------------
// Araç çubuğu butonları odak çalmaz; böylece düzenleyicideki seçim korunur.
export function tbtn(iconName, title, onClick, { text, cls = '', id } = {}) {
  const b = h('button', { class: `tbtn ${cls}`, type: 'button', title, 'aria-label': title, id });
  if (iconName) b.append(icon(iconName));
  if (text) b.append(h('span', { class: 'tbtn-text' }, text));
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', (e) => onClick(e, b));
  return b;
}

export function tsep() {
  return h('span', { class: 'tsep', 'aria-hidden': 'true' });
}

export function tselect(options, onChange, { title, value, width, cls = '' } = {}) {
  const s = h('select', { class: `tselect ${cls}`, title, 'aria-label': title });
  if (width) s.style.width = width;
  for (const o of options) {
    const opt = typeof o === 'string' ? { value: o, label: o } : o;
    s.append(h('option', { value: opt.value }, opt.label));
  }
  if (value != null) s.value = value;
  s.addEventListener('change', () => onChange(s.value, s));
  return s;
}

// ---- Açılır menü -------------------------------------------------------------
let openMenuEl = null;
export function closeMenus() {
  if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; }
}

export function popupMenu(anchorOrPoint, items, { minWidth = 200 } = {}) {
  closeMenus();
  const menu = h('div', { class: 'popup-menu', role: 'menu' });
  menu.style.minWidth = minWidth + 'px';
  for (const it of items) {
    if (!it) continue;
    if (it.separator) { menu.append(h('div', { class: 'menu-sep' })); continue; }
    if (it.header) { menu.append(h('div', { class: 'menu-header' }, it.header)); continue; }
    const b = h('button', { class: 'menu-item', role: 'menuitem', type: 'button', disabled: !!it.disabled });
    b.append(it.icon ? icon(it.icon, 18) : h('span', { class: 'icon-spacer' }));
    b.append(h('span', { class: 'menu-label' }, it.label));
    if (it.checked) b.append(icon('check', 16));
    if (it.hint) b.append(h('span', { class: 'menu-hint' }, it.hint));
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => { closeMenus(); it.onClick && it.onClick(); });
    menu.append(b);
  }
  placePopup(menu, anchorOrPoint);
  openMenuEl = menu;
  return menu;
}

function placePopup(el, anchorOrPoint) {
  document.body.append(el);
  let x, y, below = 0;
  if (anchorOrPoint instanceof Element) {
    const r = anchorOrPoint.getBoundingClientRect();
    x = r.left; y = r.bottom + 4; below = r.top;
  } else {
    x = anchorOrPoint.x; y = anchorOrPoint.y;
  }
  const w = el.offsetWidth, hgt = el.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  if (x + w > vw - 8) x = Math.max(8, vw - w - 8);
  if (y + hgt > vh - 8) {
    const up = (below || y) - hgt - 4;
    y = up > 8 ? up : Math.max(8, vh - hgt - 8);
  }
  el.style.left = x + 'px';
  el.style.top = y + 'px';
}

document.addEventListener('pointerdown', (e) => {
  if (openMenuEl && !openMenuEl.contains(e.target)) closeMenus();
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });
window.addEventListener('resize', closeMenus);

// ---- Renk seçici -------------------------------------------------------------
export const PALETTE = [
  '#000000', '#434343', '#666666', '#999999', '#cccccc', '#efefef', '#ffffff',
  '#c00000', '#ff0000', '#ff9900', '#ffc000', '#ffff00', '#92d050', '#00b050',
  '#00b0f0', '#0070c0', '#002060', '#7030a0', '#e6b8af', '#fce5cd', '#d9ead3',
  '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc', '#1f4e79', '#385723', '#833c0b',
];

export function colorPicker(anchor, onPick, { noneLabel = null } = {}) {
  closeMenus();
  const box = h('div', { class: 'popup-menu color-pop' });
  const grid = h('div', { class: 'color-grid' });
  for (const c of PALETTE) {
    const sw = h('button', { class: 'swatch', type: 'button', title: c, 'aria-label': c, style: { background: c } });
    sw.addEventListener('mousedown', (e) => e.preventDefault());
    sw.addEventListener('click', () => { closeMenus(); onPick(c); });
    grid.append(sw);
  }
  box.append(grid);
  const row = h('div', { class: 'color-row' });
  if (noneLabel) {
    const none = h('button', { class: 'menu-item small', type: 'button' }, noneLabel);
    none.addEventListener('mousedown', (e) => e.preventDefault());
    none.addEventListener('click', () => { closeMenus(); onPick(null); });
    row.append(none);
  }
  const custom = h('input', { type: 'color', title: 'Özel renk', 'aria-label': 'Özel renk', value: '#1f6feb' });
  custom.addEventListener('change', () => { closeMenus(); onPick(custom.value); });
  row.append(h('label', { class: 'custom-color' }, 'Özel: ', custom));
  box.append(row);
  placePopup(box, anchor);
  openMenuEl = box;
}

// ---- Diyaloglar --------------------------------------------------------------
export function modal({ title, body, actions = [{ label: 'Tamam', value: true, primary: true }], onOpen }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const overlay = h('div', { class: 'modal-overlay' });
    const dlg = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
    dlg.append(h('h2', { class: 'modal-title' }, title));
    if (body) dlg.append(h('div', { class: 'modal-body' }, body));
    const foot = h('div', { class: 'modal-actions' });
    const done = (v) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      if (prevFocus && prevFocus.focus) try { prevFocus.focus({ preventScroll: true }); } catch { /* yok say */ }
      resolve(v);
    };
    for (const a of actions) {
      foot.append(h('button', { class: `btn ${a.primary ? 'btn-primary' : ''} ${a.danger ? 'btn-danger' : ''}`, type: 'button', onClick: () => done(typeof a.value === 'function' ? a.value() : a.value) }, a.label));
    }
    dlg.append(foot);
    overlay.append(dlg);
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) done(null); });
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(null); }
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
        const p = actions.find((a) => a.primary);
        if (p) { e.preventDefault(); e.stopPropagation(); done(typeof p.value === 'function' ? p.value() : p.value); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay);
    const first = dlg.querySelector('input, select, textarea') || dlg.querySelector('.btn-primary');
    if (first) setTimeout(() => { first.focus(); if (first.select) first.select(); }, 30);
    if (onOpen) onOpen(dlg);
  });
}

export async function askText(title, { value = '', label = '', placeholder = '', type = 'text' } = {}) {
  const input = h('input', { class: 'input', type, value, placeholder, 'aria-label': label || title });
  const body = h('div', null, label ? h('label', { class: 'field-label' }, label) : null, input);
  const r = await modal({
    title, body,
    actions: [{ label: 'İptal', value: null }, { label: 'Tamam', primary: true, value: () => input.value }],
  });
  return r == null ? null : r;
}

export async function confirmBox(title, text, { okLabel = 'Evet', danger = false } = {}) {
  const r = await modal({
    title, body: h('p', null, text),
    actions: [{ label: 'Vazgeç', value: false }, { label: okLabel, value: true, primary: true, danger }],
  });
  return !!r;
}

export async function formDialog(title, fields, { okLabel = 'Tamam' } = {}) {
  const inputs = {};
  const body = h('div', { class: 'form-grid' });
  for (const f of fields) {
    let input;
    if (f.type === 'select') {
      input = h('select', { class: 'input' }, ...f.options.map((o) => h('option', { value: o.value }, o.label)));
      input.value = f.value;
    } else {
      input = h('input', { class: 'input', type: f.type || 'text', value: f.value ?? '', min: f.min, max: f.max, step: f.step });
    }
    inputs[f.name] = input;
    body.append(h('label', { class: 'field-label' }, f.label), input);
  }
  const r = await modal({
    title, body,
    actions: [{ label: 'İptal', value: null }, {
      label: okLabel, primary: true,
      value: () => Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value])),
    }],
  });
  return r;
}

export function isMobileLayout() {
  return window.matchMedia('(max-width: 760px)').matches;
}
