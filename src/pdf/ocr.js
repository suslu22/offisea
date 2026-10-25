// Yazı tanıma (OCR): resimdeki yazıları cihazda tanır. Tesseract ayrı bir işçide (Worker) çalışır;
// fotoğraflar ve belgeler hiçbir yere gönderilmez. İşçi bir süre kullanılmazsa belleği boşaltmak
// için kapatılır.
const IDLE_MS = 60000;
let worker = null;
let seq = 0;
const pending = new Map();
let idleTimer = null;

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('ocr-worker.js', document.baseURI).href);
  worker.onmessage = (e) => {
    const m = e.data || {};
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m); else p.reject(new Error(m.error || 'Yazı tanınamadı.'));
    scheduleIdle();
  };
  worker.onerror = (e) => {
    e.preventDefault();
    const err = new Error('Yazı tanıma başlatılamadı.');
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    stopOcr();
  };
  return worker;
}

function scheduleIdle() {
  clearTimeout(idleTimer);
  if (pending.size) return;
  idleTimer = setTimeout(stopOcr, IDLE_MS);
}

function call(msg, transfer) {
  clearTimeout(idleTimer);
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ ...msg, id }, transfer || []);
  });
}

/** İşçiyi kapatır (devam eden tanımalar iptal edilir). */
export function stopOcr() {
  clearTimeout(idleTimer);
  if (worker) { worker.terminate(); worker = null; }
  for (const p of pending.values()) p.reject(new Error('İptal edildi.'));
  pending.clear();
}

const toPng = (canvas) => new Promise((res, rej) => canvas.toBlob((b) => (b ? b.arrayBuffer().then(res, rej) : rej(new Error('Resim hazırlanamadı.'))), 'image/png'));

/**
 * Tuvaldeki (ya da JPEG/PNG baytlarındaki) yazıları tanır.
 * Döner: { text, words: [{ x0, y0, x1, y1, conf, text, block, par, line }] } (piksel koordinatları).
 */
export async function recognize(source) {
  let buf;
  if (source && typeof source.getContext === 'function') buf = await toPng(grayCopy(source));
  else if (source instanceof ArrayBuffer) buf = source.slice(0);
  else if (source && source.buffer) buf = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
  else throw new Error('Tanınacak resim yok.');
  const r = await call({ type: 'recognize', image: buf }, [buf]);
  return {
    text: String(r.text || ''),
    words: (r.words || []).map((w) => ({ x0: w[0], y0: w[1], x1: w[2], y1: w[3], conf: w[4], text: w[5], block: w[6], par: w[7], line: w[8] })),
  };
}

// Gri tonlamalı kopya: PNG daha küçük olur, tanıma biraz hızlanır.
function grayCopy(src) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * Tanınan kelimeleri PDF'e eklenecek görünmez yazıya çevirir.
 * `k`: 1 resim pikseli kaç pt; `toUser(x, y)`: ekrandaki pt → PDF kullanıcı uzayı; `angle`: yazı yönü.
 */
export function layoutWords(words, k, toUser, angle = 0, minConf = 30) {
  const lines = new Map();
  for (const w of words) {
    if (!(w.conf >= minConf) || !w.text.trim()) continue;
    const key = w.block + ':' + w.par + ':' + w.line;
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key).push(w);
  }
  const out = [];
  for (const ws of lines.values()) {
    ws.sort((a, b) => a.x0 - b.x0);
    // Satırın taban çizgisi: kelime alt kenarlarının ortancası; punto: en yüksek kelime
    const bottoms = ws.map((w) => w.y1).sort((a, b) => a - b);
    const base = bottoms[Math.floor(bottoms.length / 2)];
    const hMax = Math.max(...ws.map((w) => w.y1 - w.y0));
    const size = (hMax / 0.93) * k;
    ws.forEach((w, i) => {
      const next = ws[i + 1];
      const right = next ? next.x0 : w.x1;
      out.push({ text: next ? w.text + ' ' : w.text, at: toUser(w.x0 * k, base * k), size, width: Math.max(1, right - w.x0) * k, angle });
    });
  }
  return out;
}

/** Tanınan kelimeleri satırlara ve paragraflara ayırıp düz metin üretir. */
export function wordsToText(words) {
  const out = [];
  let lastKey = '', lastPar = '';
  for (const w of words) {
    const par = w.block + ':' + w.par;
    const key = par + ':' + w.line;
    if (key !== lastKey) {
      if (out.length) out.push(par !== lastPar ? '\n\n' : '\n');
      lastKey = key; lastPar = par;
    } else out.push(' ');
    out.push(w.text);
  }
  return out.join('');
}
