// PDF araçlarının diyalogları: dosya sıralama, imza çizme.
import { h, icon, clear, modal } from '../core/ui.js';
import { getPref, setPref } from '../core/storage.js';

const fmtSize = (b) => (b < 1024 * 1024 ? Math.max(1, Math.round(b / 1024)) + ' KB' : (b / 1024 / 1024).toFixed(1).replace('.', ',') + ' MB');

/** Birleştirilecek dosyaların sırasını kullanıcıya düzenletir. İptalde null. */
export async function orderFilesDialog(files) {
  const order = [...files];
  const list = h('div', { class: 'order-list', role: 'list' });
  const draw = () => {
    clear(list);
    order.forEach((f, i) => {
      const up = h('button', { class: 'tbtn', type: 'button', title: 'Yukarı taşı', 'aria-label': 'Yukarı taşı', disabled: i === 0 ? true : null }, icon('arrowUp', 18));
      const down = h('button', { class: 'tbtn', type: 'button', title: 'Aşağı taşı', 'aria-label': 'Aşağı taşı', disabled: i === order.length - 1 ? true : null }, icon('arrowDown', 18));
      const del = h('button', { class: 'tbtn', type: 'button', title: 'Listeden çıkar', 'aria-label': 'Listeden çıkar', disabled: order.length <= 2 ? true : null }, icon('close', 18));
      up.addEventListener('click', () => { [order[i - 1], order[i]] = [order[i], order[i - 1]]; draw(); });
      down.addEventListener('click', () => { [order[i + 1], order[i]] = [order[i], order[i + 1]]; draw(); });
      del.addEventListener('click', () => { order.splice(i, 1); draw(); });
      list.append(h('div', { class: 'order-item', role: 'listitem' },
        h('span', { class: 'order-num' }, String(i + 1)),
        h('span', { class: 'order-name' }, f.name, h('small', null, fmtSize(f.size))),
        up, down, del));
    });
  };
  draw();
  const r = await modal({
    title: 'PDF dosyalarını birleştir',
    body: h('div', null, h('p', { class: 'muted' }, 'Dosyalar bu sırayla tek bir PDF’te birleştirilecek.'), list),
    actions: [{ label: 'İptal', value: null }, { label: 'Birleştir', primary: true, value: () => order }],
  });
  return r && r.length ? r : null;
}

const SIG_PREF = 'savedSignature';
const INK = ['#111111', '#1a3fa8', '#b3261e'];

/**
 * İmza çizdirir. Sonuç: { src: PNG dataURL, w, h } (kırpılmış, saydam arka plan) ya da null.
 * İstenirse imza yalnızca bu cihazda saklanır.
 */
export async function signaturePad() {
  const saved = getPref(SIG_PREF, null);
  const W = 560, H = 220;
  const canvas = h('canvas', { class: 'sig-canvas', width: String(W * 2), height: String(H * 2), 'aria-label': 'İmza alanı' });
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  let color = INK[0];
  let strokes = 0;
  let drawing = null;
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
  };
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch { /* işaretçi bulunamadı */ }
    drawing = { id: e.pointerId, last: pos(e), lastW: 2.6 };
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(drawing.last[0], drawing.last[1], 1.3, 0, Math.PI * 2); ctx.fill();
    strokes++;
    hint.hidden = true;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing || e.pointerId !== drawing.id) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evs.length ? evs : [e]) {
      const p = pos(ev);
      const d = Math.hypot(p[0] - drawing.last[0], p[1] - drawing.last[1]);
      // Hızlı çizgiler biraz incelir: kalem hissi
      const w = Math.max(1.4, Math.min(3.4, 3.6 - d * 0.12));
      const lw = drawing.lastW * 0.6 + w * 0.4;
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.beginPath(); ctx.moveTo(drawing.last[0], drawing.last[1]); ctx.lineTo(p[0], p[1]); ctx.stroke();
      drawing.last = p; drawing.lastW = lw;
    }
  });
  const end = (e) => { if (drawing && e.pointerId === drawing.id) drawing = null; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  const hint = h('div', { class: 'sig-hint' }, 'Parmağınızla ya da fareyle buraya imzanızı atın');
  const clearBtn = h('button', { class: 'btn', type: 'button' }, 'Temizle');
  clearBtn.addEventListener('click', () => { ctx.clearRect(0, 0, W, H); strokes = 0; hint.hidden = false; });
  const swatches = h('div', { class: 'sig-colors' });
  for (const c of INK) {
    const b = h('button', { class: 'swatch' + (c === color ? ' on' : ''), type: 'button', title: 'Mürekkep rengi', 'aria-label': 'Mürekkep rengi', style: { background: c } });
    b.addEventListener('click', () => { color = c; swatches.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('on', x === b)); });
    swatches.append(b);
  }
  const remember = h('input', { type: 'checkbox', id: 'sig-remember' });
  remember.checked = !!saved || getPref('rememberSignature', true);
  const body = h('div', { class: 'sig-body' },
    h('div', { class: 'sig-wrap' }, canvas, hint, h('div', { class: 'sig-line' })),
    h('div', { class: 'sig-tools' }, swatches, clearBtn),
    h('label', { class: 'check-row' }, remember, h('span', null, 'İmzayı bu cihazda hatırla')));
  let useSaved = false;
  let dlgEl = null;
  if (saved && saved.src) {
    const savedBtn = h('button', { class: 'sig-saved', type: 'button', title: 'Kayıtlı imzayı kullan' }, h('img', { src: saved.src, alt: 'Kayıtlı imza' }), h('span', null, 'Kayıtlı imzayı kullan'));
    body.prepend(savedBtn);
    savedBtn.addEventListener('click', () => { useSaved = true; if (dlgEl) dlgEl.querySelector('.btn-primary').click(); });
  }
  const r = await modal({
    title: 'İmza ekle',
    body,
    actions: [{ label: 'İptal', value: null }, { label: 'İmzayı ekle', primary: true, value: () => true }],
    onOpen: (d) => { dlgEl = d; },
  });
  if (!r) return null;
  if (useSaved && saved) return saved;
  if (!strokes) return null;
  const out = trimCanvas(canvas);
  if (!out) return null;
  setPref('rememberSignature', remember.checked);
  setPref(SIG_PREF, remember.checked ? out : null);
  return out;
}

/** Tuvalin boş kenarlarını kırpar, PNG dataURL döndürür. */
function trimCanvas(c) {
  const { width: w, height: hh } = c;
  const d = c.getContext('2d').getImageData(0, 0, w, hh).data;
  let x0 = w, y0 = hh, x1 = -1, y1 = -1;
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  if (x1 < 0) return null;
  const pad = 6;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(hh - 1, y1 + pad);
  const o = document.createElement('canvas');
  o.width = x1 - x0 + 1; o.height = y1 - y0 + 1;
  o.getContext('2d').drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height);
  return { src: o.toDataURL('image/png'), w: o.width, h: o.height };
}
