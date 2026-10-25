// Kamerayla belge tarama: fotoğraf çek → köşeleri ayarla → perspektif düzelt → filtre → PDF.
// Tüm işlem cihazda yapılır; fotoğraflar hiçbir yere gönderilmez. Resimler tuvalde yeniden
// kodlandığı için konum (GPS/EXIF) bilgileri PDF'e geçmez.
import { h, icon, clear, modal, toast } from '../core/ui.js';
import { LITE } from '../core/perf.js';

const MAX_SRC = LITE ? 2200 : 3000; // işlenecek fotoğrafın uzun kenarı
const MAX_OUT = LITE ? 1700 : 2200; // taranmış sayfanın uzun kenarı
const MAX_PAGES = 60;

const FILTERS = [
  { id: 'doc', label: 'Belge' },
  { id: 'color', label: 'Renkli belge' },
  { id: 'gray', label: 'Gri' },
  { id: 'orig', label: 'Orijinal' },
];

function chooseImage(capture) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    if (capture) input.setAttribute('capture', 'environment');
    input.style.display = 'none';
    let done = false;
    const finish = (f) => { if (!done) { done = true; input.remove(); resolve(f); } };
    input.addEventListener('change', () => finish(input.files && input.files[0] ? input.files[0] : null));
    input.addEventListener('cancel', () => finish(null));
    document.body.append(input);
    input.click();
  });
}

async function loadImage(file) {
  if (!/^image\//.test(file.type || 'image/')) throw new Error('Seçilen dosya bir resim değil.');
  if (file.size > 60 * 1024 * 1024) throw new Error('Fotoğraf çok büyük.');
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      bmp = img;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
  const w0 = bmp.width || bmp.naturalWidth, h0 = bmp.height || bmp.naturalHeight;
  if (!w0 || !h0) throw new Error('Fotoğraf okunamadı.');
  const s = Math.min(1, MAX_SRC / Math.max(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.round(w0 * s); c.height = Math.round(h0 * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  if (bmp.close) bmp.close();
  return c;
}

// ---- Kağıt kenarlarını bulma (basit, hızlı tahmin) ------------------------------------------------
function detectCorners(src) {
  const W = 220;
  const s = W / src.width;
  const w = W, hh = Math.max(1, Math.round(src.height * s));
  const c = document.createElement('canvas');
  c.width = w; c.height = hh;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, w, hh);
  const d = ctx.getImageData(0, 0, w, hh).data;
  const g = new Uint8Array(w * hh);
  const hist = new Uint32Array(256);
  for (let i = 0; i < w * hh; i++) {
    const v = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8;
    g[i] = v; hist[v]++;
  }
  // Otsu eşiği: kağıt genellikle zeminden açık renklidir
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  const total = w * hh;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  // Ortaya en yakın açık bölgenin bağlı bileşeni
  const mask = new Uint8Array(w * hh);
  for (let i = 0; i < w * hh; i++) mask[i] = g[i] > thr ? 1 : 0;
  let seed = -1;
  const cx = w >> 1, cy = hh >> 1;
  for (let r = 0; r < Math.max(w, hh) / 2 && seed < 0; r += 2) {
    for (let a = 0; a < 16 && seed < 0; a++) {
      const x = Math.round(cx + r * Math.cos((a * Math.PI) / 8)), y = Math.round(cy + r * Math.sin((a * Math.PI) / 8));
      if (x >= 0 && y >= 0 && x < w && y < hh && mask[y * w + x]) seed = y * w + x;
    }
  }
  if (seed < 0) return null;
  const stack = [seed];
  mask[seed] = 2;
  let count = 0;
  let tl = [cx, cy, Infinity], tr = [cx, cy, -Infinity], br = [cx, cy, -Infinity], bl = [cx, cy, Infinity];
  while (stack.length) {
    const i = stack.pop();
    const x = i % w, y = (i / w) | 0;
    count++;
    if (x + y < tl[2]) tl = [x, y, x + y];
    if (x + y > br[2]) br = [x, y, x + y];
    if (x - y > tr[2]) tr = [x, y, x - y];
    if (x - y < bl[2]) bl = [x, y, x - y];
    if (x > 0 && mask[i - 1] === 1) { mask[i - 1] = 2; stack.push(i - 1); }
    if (x < w - 1 && mask[i + 1] === 1) { mask[i + 1] = 2; stack.push(i + 1); }
    if (y > 0 && mask[i - w] === 1) { mask[i - w] = 2; stack.push(i - w); }
    if (y < hh - 1 && mask[i + w] === 1) { mask[i + w] = 2; stack.push(i + w); }
  }
  const frac = count / total;
  if (frac < 0.15 || frac > 0.97) return null;
  const pts = [tl, tr, br, bl].map(([x, y]) => [x / s, y / s]);
  if (quadArea(pts) < src.width * src.height * 0.12) return null;
  return pts;
}

function quadArea(p) {
  let a = 0;
  for (let i = 0; i < 4; i++) { const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % 4]; a += x1 * y2 - x2 * y1; }
  return Math.abs(a) / 2;
}

const defaultCorners = (c) => {
  const mx = c.width * 0.06, my = c.height * 0.06;
  return [[mx, my], [c.width - mx, my], [c.width - mx, c.height - my], [mx, c.height - my]];
};

// ---- Perspektif düzeltme ---------------------------------------------------------------------
/** Hedef dikdörtgen (0,0)-(W,H) → kaynak dörtgen eşlemesi için 3×3 matris. */
function homography(W, H, q) {
  const srcPts = [[0, 0], [W, 0], [W, H], [0, H]];
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = srcPts[i], [u, v] = q[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  // Gauss eleme
  for (let c = 0; c < 8; c++) {
    let piv = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
    if (Math.abs(A[c][c]) < 1e-12) return null;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const m = b.map((v, i) => v / A[i][i]);
  return [m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], 1];
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function warp(src, q) {
  // Kâğıt kenarındaki gölge/arka plan şeridi görünmesin diye köşeler merkeze doğru çok az çekilir
  const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
  q = q.map(([x, y]) => [x + (cx - x) * 0.012, y + (cy - y) * 0.012]);
  let W =Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
  let H = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  const s = Math.min(1, MAX_OUT / Math.max(W, H));
  W = Math.max(16, Math.round(W * s)); H = Math.max(16, Math.round(H * s));
  const M = homography(W, H, q);
  if (!M) throw new Error('Köşeler geçersiz.');
  const sw = src.width, sh = src.height;
  const sd = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, sw, sh).data;
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const octx = out.getContext('2d');
  const od = octx.createImageData(W, H);
  const o = od.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const den = M[6] * x + M[7] * y + 1;
      let u = (M[0] * x + M[1] * y + M[2]) / den;
      let v = (M[3] * x + M[4] * y + M[5]) / den;
      if (u < 0) u = 0; else if (u > sw - 1.001) u = sw - 1.001;
      if (v < 0) v = 0; else if (v > sh - 1.001) v = sh - 1.001;
      const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      const k = (y * W + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const top = sd[i00 + ch] + (sd[i10 + ch] - sd[i00 + ch]) * fx;
        const bot = sd[i01 + ch] + (sd[i11 + ch] - sd[i01 + ch]) * fx;
        o[k + ch] = top + (bot - top) * fy;
      }
      o[k + 3] = 255;
    }
  }
  octx.putImageData(od, 0, 0);
  return out;
}

// ---- Filtreler ---------------------------------------------------------------------------------
/** Yerel arka plan parlaklığı (kutu bulanıklığı, integral görüntü ile). */
function localMean(gray, w, hh, r) {
  const I = new Float64Array((w + 1) * (hh + 1));
  for (let y = 0; y < hh; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += gray[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; }
  }
  const out = new Float32Array(w * hh);
  for (let y = 0; y < hh; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(hh, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const s = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
      out[y * w + x] = s / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

function applyFilter(canvas, id) {
  const out = document.createElement('canvas');
  out.width = canvas.width; out.height = canvas.height;
  const ctx = out.getContext('2d');
  ctx.drawImage(canvas, 0, 0);
  if (id === 'orig') return out;
  const w = out.width, hh = out.height;
  const img = ctx.getImageData(0, 0, w, hh);
  const d = img.data;
  const gray = new Float32Array(w * hh);
  for (let i = 0; i < w * hh; i++) gray[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
  if (id === 'gray') {
    for (let i = 0; i < w * hh; i++) {
      const v = Math.max(0, Math.min(255, (gray[i] - 128) * 1.25 + 140));
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
    }
  } else {
    // Gölgeleri ve sarımsı ışığı gidermek için her pikseli yerel arka plana böl.
    // Arka plan, bellek için 4 kat küçültülmüş görüntüde hesaplanır.
    const F = 4, sw = Math.ceil(w / F), sh = Math.ceil(hh / F);
    const small = new Float32Array(sw * sh), cnt = new Uint16Array(sw * sh);
    for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) { const j = ((y / F) | 0) * sw + ((x / F) | 0); small[j] += gray[y * w + x]; cnt[j]++; }
    for (let j = 0; j < small.length; j++) small[j] /= cnt[j] || 1;
    const mean = localMean(small, sw, sh, Math.max(3, Math.round(Math.max(sw, sh) / 28)));
    for (let i = 0; i < w * hh; i++) {
      const x = i % w, y = (i / w) | 0;
      const bg = Math.max(30, mean[((y / F) | 0) * sw + ((x / F) | 0)] * 1.04);
      if (id === 'doc') {
        const ratio = gray[i] / bg;
        const v = 255 * Math.max(0, Math.min(1, (ratio - 0.55) / 0.33));
        d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
      } else {
        for (let ch = 0; ch < 3; ch++) {
          const v = (d[i * 4 + ch] / bg) * 255;
          d[i * 4 + ch] = Math.max(0, Math.min(255, (v - 255) * 1.35 + 255));
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

const toJpeg = (c, q = 0.85) => new Promise((res, rej) => c.toBlob((b) => (b ? b.arrayBuffer().then(res, rej) : rej(new Error('Resim oluşturulamadı.'))), 'image/jpeg', q));

// ---- Arayüz ------------------------------------------------------------------------------------
/**
 * Tarama penceresini açar. Sonuç: { bytes: ArrayBuffer (PDF), pages } ya da iptalde null.
 */
export async function scanDocument() {
  const pages = []; // { canvas (filtrelenmiş), w, h }
  let src = null, corners = null, filter = 'doc', rotation = 0;
  let resolveFinal;
  const body = h('div', { class: 'scan' });
  const stage = h('div', { class: 'scan-stage' });
  const footer = h('div', { class: 'scan-foot' });
  const strip = h('div', { class: 'scan-strip' });
  body.append(stage, strip, footer);

  const pick = async (capture) => {
    const f = await chooseImage(capture);
    if (!f) return;
    const t = toast('Fotoğraf hazırlanıyor…', { timeout: 30000 });
    try {
      src = await loadImage(f);
      corners = detectCorners(src) || defaultCorners(src);
      rotation = 0;
      showCrop();
    } catch (err) {
      toast(err.message || 'Fotoğraf açılamadı.', { type: 'error' });
    } finally { t.remove(); }
  };

  function drawStrip() {
    clear(strip);
    strip.hidden = !pages.length;
    pages.forEach((pg, i) => {
      const th = h('div', { class: 'scan-thumb' });
      const img = h('img', { src: pg.thumb, alt: `Sayfa ${i + 1}` });
      const del = h('button', { class: 'scan-thumb-del', type: 'button', title: 'Sayfayı çıkar', 'aria-label': `Sayfa ${i + 1}'i çıkar` }, icon('close', 14));
      del.addEventListener('click', () => { pages.splice(i, 1); drawStrip(); if (!src) showStart(); });
      th.append(img, h('span', { class: 'scan-thumb-num' }, String(i + 1)), del);
      strip.append(th);
    });
  }

  function showStart() {
    clear(stage); clear(footer);
    src = null;
    const cam = h('button', { class: 'scan-big', type: 'button' }, icon('camera', 34), h('span', null, pages.length ? 'Sonraki sayfayı çek' : 'Fotoğraf çek'));
    const gal = h('button', { class: 'scan-big scan-big-alt', type: 'button' }, icon('image', 34), h('span', null, 'Galeriden seç'));
    cam.addEventListener('click', () => pick(true));
    gal.addEventListener('click', () => pick(false));
    stage.append(h('div', { class: 'scan-start' },
      h('p', { class: 'muted' }, pages.length ? `${pages.length} sayfa tarandı. Başka sayfa ekleyebilir ya da PDF’i oluşturabilirsiniz.` : 'Belgeyi düz bir zemine koyup tamamı görünecek şekilde fotoğrafını çekin. Kenarları sonra ayarlayabilirsiniz.'),
      h('div', { class: 'scan-start-btns' }, cam, gal)));
    const cancel = h('button', { class: 'btn', type: 'button' }, 'İptal');
    cancel.addEventListener('click', () => resolveFinal(null));
    footer.append(cancel);
    if (pages.length) {
      const fin = h('button', { class: 'btn btn-primary', type: 'button' }, `PDF oluştur (${pages.length} sayfa)`);
      fin.addEventListener('click', finish);
      footer.append(fin);
    }
  }

  function showCrop() {
    clear(stage); clear(footer);
    const cv = h('canvas', { class: 'scan-canvas' });
    const wrap = h('div', { class: 'scan-crop' }, cv);
    const handles = corners.map((_, i) => h('div', { class: 'scan-handle', dataset: { i: String(i) }, role: 'slider', 'aria-label': `Köşe ${i + 1}` }));
    wrap.append(...handles);
    stage.append(wrap, h('p', { class: 'scan-tip muted' }, 'Köşeleri belgenin köşelerine sürükleyin.'));
    let scale = 1;
    const fit = () => {
      const maxW = Math.max(200, stage.clientWidth - 8);
      const maxH = Math.max(200, Math.min(window.innerHeight * 0.55, 620));
      scale = Math.min(maxW / src.width, maxH / src.height);
      cv.width = Math.round(src.width * scale); cv.height = Math.round(src.height * scale);
      cv.style.width = cv.width + 'px'; cv.style.height = cv.height + 'px';
      wrap.style.width = cv.width + 'px'; wrap.style.height = cv.height + 'px';
      redraw();
    };
    const redraw = () => {
      const ctx = cv.getContext('2d');
      ctx.drawImage(src, 0, 0, cv.width, cv.height);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      ctx.rect(0, 0, cv.width, cv.height);
      ctx.moveTo(corners[0][0] * scale, corners[0][1] * scale);
      for (let i = 3; i >= 0; i--) ctx.lineTo(corners[i][0] * scale, corners[i][1] * scale);
      ctx.closePath();
      ctx.fill('evenodd');
      ctx.strokeStyle = '#38bde3'; ctx.lineWidth = 2.5;
      ctx.beginPath();
      corners.forEach(([x, y], i) => (i ? ctx.lineTo(x * scale, y * scale) : ctx.moveTo(x * scale, y * scale)));
      ctx.closePath(); ctx.stroke();
      handles.forEach((hd, i) => { hd.style.left = corners[i][0] * scale + 'px'; hd.style.top = corners[i][1] * scale + 'px'; });
    };
    handles.forEach((hd, i) => {
      hd.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        try { hd.setPointerCapture(e.pointerId); } catch { /* yok say */ }
        hd.classList.add('drag');
        const move = (ev) => {
          const r = cv.getBoundingClientRect();
          corners[i] = [Math.max(0, Math.min(src.width, (ev.clientX - r.left) / scale)), Math.max(0, Math.min(src.height, (ev.clientY - r.top) / scale))];
          redraw();
        };
        const up = () => { hd.classList.remove('drag'); hd.removeEventListener('pointermove', move); };
        hd.addEventListener('pointermove', move);
        hd.addEventListener('pointerup', up, { once: true });
        hd.addEventListener('pointercancel', up, { once: true });
      });
    });
    requestAnimationFrame(fit);

    const back = h('button', { class: 'btn', type: 'button' }, 'Yeniden çek');
    back.addEventListener('click', showStart);
    const full = h('button', { class: 'btn', type: 'button', title: 'Tüm fotoğrafı kullan' }, 'Tümü');
    full.addEventListener('click', () => { corners = [[0, 0], [src.width, 0], [src.width, src.height], [0, src.height]]; redraw(); });
    const next = h('button', { class: 'btn btn-primary', type: 'button' }, 'İleri');
    next.addEventListener('click', () => {
      if (quadArea(corners) < 400) { toast('Köşeler çok yakın.', { type: 'error' }); return; }
      showFilter();
    });
    footer.append(back, full, next);
  }

  function showFilter() {
    clear(stage); clear(footer);
    let warped;
    try { warped = warp(src, corners); } catch (err) { toast(err.message, { type: 'error' }); showCrop(); return; }
    const preview = h('canvas', { class: 'scan-preview' });
    const chips = h('div', { class: 'scan-filters', role: 'radiogroup', 'aria-label': 'Filtre' });
    let current = null;
    const render = () => {
      let c = applyFilter(warped, filter);
      if (rotation) {
        const r = document.createElement('canvas');
        const q = rotation % 180 !== 0;
        r.width = q ? c.height : c.width; r.height = q ? c.width : c.height;
        const ctx = r.getContext('2d');
        ctx.translate(r.width / 2, r.height / 2);
        ctx.rotate((rotation * Math.PI) / 180);
        ctx.drawImage(c, -c.width / 2, -c.height / 2);
        c = r;
      }
      current = c;
      const maxW = Math.max(200, stage.clientWidth - 8), maxH = Math.min(window.innerHeight * 0.55, 620);
      const s = Math.min(maxW / c.width, maxH / c.height, 1);
      preview.width = Math.round(c.width * s); preview.height = Math.round(c.height * s);
      preview.getContext('2d').drawImage(c, 0, 0, preview.width, preview.height);
    };
    for (const f of FILTERS) {
      const b = h('button', { class: 'folder-chip' + (f.id === filter ? ' on' : ''), type: 'button', role: 'radio', 'aria-checked': f.id === filter ? 'true' : 'false' }, f.label);
      b.addEventListener('click', () => {
        filter = f.id;
        chips.querySelectorAll('.folder-chip').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b ? 'true' : 'false'); });
        render();
      });
      chips.append(b);
    }
    const rot = h('button', { class: 'folder-chip', type: 'button', title: 'Döndür' }, icon('rotate', 16), h('span', null, 'Döndür'));
    rot.addEventListener('click', () => { rotation = (rotation + 90) % 360; render(); });
    chips.append(rot);
    stage.append(h('div', { class: 'scan-preview-wrap' }, preview), chips);
    requestAnimationFrame(render);

    const back = h('button', { class: 'btn', type: 'button' }, 'Kenarlar');
    back.addEventListener('click', showCrop);
    const add = h('button', { class: 'btn btn-primary', type: 'button' }, pages.length ? 'Sayfayı ekle' : 'Bu sayfayı kullan');
    add.addEventListener('click', () => {
      if (pages.length >= MAX_PAGES) { toast(`En fazla ${MAX_PAGES} sayfa taranabilir.`, { type: 'error' }); return; }
      const t = document.createElement('canvas');
      const ts = 120 / Math.max(current.width, current.height);
      t.width = Math.round(current.width * ts); t.height = Math.round(current.height * ts);
      t.getContext('2d').drawImage(current, 0, 0, t.width, t.height);
      pages.push({ canvas: current, w: current.width, h: current.height, thumb: t.toDataURL('image/jpeg', 0.7) });
      src.width = src.height = 0; // belleği bırak
      src = null;
      drawStrip();
      showStart();
    });
    footer.append(back, add);
  }

  async function finish() {
    if (!pages.length) return;
    const t = toast('PDF oluşturuluyor…', { timeout: 60000 });
    try {
      const images = [];
      for (const pg of pages) images.push({ bytes: await toJpeg(pg.canvas, filter === 'doc' ? 0.8 : 0.85), w: pg.w, h: pg.h });
      const { imagesToPdf, toBuffer } = await import('./tools.js');
      const u8 = await imagesToPdf(images);
      resolveFinal({ bytes: toBuffer(u8), pages: pages.length });
    } catch (err) {
      console.error(err);
      toast('PDF oluşturulamadı: ' + (err.message || err), { type: 'error' });
    } finally { t.remove(); }
  }

  showStart();
  drawStrip();
  return new Promise((resolve) => {
    let closeModal = null;
    resolveFinal = (v) => { resolve(v); if (closeModal) closeModal(); };
    modal({
      title: 'Belge tara',
      body,
      actions: [],
      onOpen: (dlg) => {
        dlg.classList.add('modal-scan');
        const x = h('button', { class: 'tbtn modal-x', type: 'button', title: 'Kapat', 'aria-label': 'Kapat' }, icon('close'));
        dlg.prepend(x);
        x.addEventListener('click', () => resolveFinal(null));
      },
      persistent: true,
      onClose: (close) => { closeModal = () => close(null); },
    }).then(() => resolve(null)); // geri tuşu / dışarı dokunma: iptal
  });
}
