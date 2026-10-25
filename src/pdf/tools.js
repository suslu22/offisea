// PDF araçları: birleştirme, sayfa ayırma, döndürme, silme, küçültme, resimden PDF ve
// notları sayfaya işleme. Tümü cihazda çalışır (pdf-lib, saf JavaScript; eval yok).
import { PDFDocument, degrees, BlendMode } from '@cantoo/pdf-lib';
import { loadPdfJs } from './pdfjs.js';

const u8 = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));
/** Uint8Array → bağımsız ArrayBuffer (IndexedDB'de saklanan biçim). */
export const toBuffer = (u) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);

const LOAD = { updateMetadata: false };

/**
 * PDF'i düzenleme için açar. Şifreli dosyalar parolayla (ya da boş parolayla) çözülür;
 * çözülemezse sayfalar resme dönüştürülerek yeni bir PDF kurulur (`rasterized: true`).
 */
export async function openForEdit(bytes, { password } = {}) {
  try {
    return { doc: await PDFDocument.load(u8(bytes), LOAD), rasterized: false };
  } catch (e) {
    if (!(e && /encrypt/i.test(e.name + ' ' + e.message))) throw e;
  }
  for (const pw of [password, ''].filter((x) => x != null)) {
    try {
      const doc = await PDFDocument.load(u8(bytes), { ...LOAD, password: pw });
      if (!doc.isEncrypted) return { doc, rasterized: false };
    } catch { /* sıradaki yöntem */ }
  }
  const out = await rasterize(bytes, { password, dpi: 150, quality: 0.85 });
  return { doc: await PDFDocument.load(out, LOAD), rasterized: true };
}

const save = (doc) => doc.save({ useObjectStreams: true });

/** Birden çok PDF'i sırayla tek dosyada birleştirir. */
export async function mergePdfs(list, onProgress) {
  const out = await PDFDocument.create();
  let rasterized = false;
  for (let i = 0; i < list.length; i++) {
    if (onProgress) onProgress(i, list.length);
    const { doc, rasterized: r } = await openForEdit(list[i]);
    rasterized = rasterized || r;
    const pages = await out.copyPages(doc, doc.getPageIndices());
    for (const p of pages) out.addPage(p);
  }
  return { bytes: await save(out), rasterized };
}

/** Belirtilen sayfaları (0 tabanlı) yeni bir PDF olarak çıkarır. */
export async function extractPages(bytes, indices, opts) {
  const { doc } = await openForEdit(bytes, opts);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(doc, indices);
  for (const p of pages) out.addPage(p);
  return save(out);
}

/** Sayfaları saat yönünde `delta` derece (90'ın katı) döndürür. */
export async function rotatePages(bytes, indices, delta, opts) {
  const { doc } = await openForEdit(bytes, opts);
  for (const i of indices) {
    const p = doc.getPage(i);
    p.setRotation(degrees((((p.getRotation().angle + delta) % 360) + 360) % 360));
  }
  return save(doc);
}

export async function deletePages(bytes, indices, opts) {
  const { doc } = await openForEdit(bytes, opts);
  const set = [...new Set(indices)].sort((a, b) => b - a);
  if (set.length >= doc.getPageCount()) throw new Error('Tüm sayfalar silinemez.');
  for (const i of set) doc.removePage(i);
  return save(doc);
}

/** Sonuna başka PDF'lerin sayfalarını ekler. */
export async function appendPdfs(bytes, others, opts) {
  const { doc } = await openForEdit(bytes, opts);
  for (const o of others) {
    const { doc: src } = await openForEdit(o);
    const pages = await doc.copyPages(src, src.getPageIndices());
    for (const p of pages) doc.addPage(p);
  }
  return save(doc);
}

/**
 * "1-3, 5, 8-" gibi bir sayfa aralığını 0 tabanlı dizinlere çevirir. Geçersizse null.
 */
export function parseRange(text, n) {
  const out = [];
  const parts = String(text).split(/[,;]\s*/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  for (const part of parts) {
    const m = /^(\d*)\s*-\s*(\d*)$/.exec(part);
    let a, b;
    if (m) { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : n; } else if (/^\d+$/.test(part)) { a = b = +part; } else return null;
    if (a < 1 || b > n || a > b) return null;
    for (let i = a; i <= b; i++) out.push(i - 1);
  }
  return out;
}

const toJpeg = (canvas, q) => new Promise((res, rej) => canvas.toBlob((b) => (b ? b.arrayBuffer().then(res, rej) : rej(new Error('Resim oluşturulamadı.'))), 'image/jpeg', q));

/**
 * Her sayfayı JPEG resme çevirip yeni bir PDF kurar (küçültme ve şifreli PDF yedeği).
 * Metin seçilemez hale gelir.
 */
export async function rasterize(bytes, { password, dpi = 110, quality = 0.7, onProgress } = {}) {
  const pdf = await loadPdfJs(bytes, { password }).promise;
  try {
    const out = await PDFDocument.create();
    for (let i = 1; i <= pdf.numPages; i++) {
      if (onProgress) onProgress(i, pdf.numPages);
      const pg = await pdf.getPage(i);
      const vp1 = pg.getViewport({ scale: 1 });
      // Çok büyük sayfalarda tuval belleği sınırlanır
      let s = dpi / 72;
      const maxPx = 5e6;
      if (vp1.width * vp1.height * s * s > maxPx) s = Math.sqrt(maxPx / (vp1.width * vp1.height));
      const vp = pg.getViewport({ scale: s });
      const c = document.createElement('canvas');
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      await pg.render({ canvas: c, viewport: vp, intent: 'print' }).promise;
      const jpg = await out.embedJpg(await toJpeg(c, quality));
      c.width = c.height = 0;
      const page = out.addPage([vp1.width, vp1.height]);
      page.drawImage(jpg, { x: 0, y: 0, width: vp1.width, height: vp1.height });
      pg.cleanup();
    }
    return await save(out);
  } finally {
    Promise.resolve().then(() => pdf.loadingTask.destroy()).catch(() => {});
  }
}

const A4 = [595.28, 841.89];

/** Resimlerden (JPEG baytları) PDF oluşturur; her resim bir A4 sayfaya sığdırılır. */
export async function imagesToPdf(images, { fit = 'a4', margin = 0 } = {}) {
  const out = await PDFDocument.create();
  out.setTitle('Taranmış belge');
  out.setProducer('Offisea');
  for (const im of images) {
    const jpg = await out.embedJpg(u8(im.bytes));
    let [pw, ph] = A4;
    if (im.w > im.h) [pw, ph] = [ph, pw];
    if (fit !== 'a4') { pw = im.w * 0.75; ph = im.h * 0.75; }
    const s = Math.min((pw - margin * 2) / im.w, (ph - margin * 2) / im.h);
    const w = im.w * s, hh = im.h * s;
    const page = out.addPage([pw, ph]);
    page.drawImage(jpg, { x: (pw - w) / 2, y: (ph - hh) / 2, width: w, height: hh });
  }
  return save(out);
}

/**
 * Not katmanlarını (her sayfa için saydam PNG) sayfaların üstüne kalıcı olarak çizer.
 * `layers`: Map<sayfaDizini, Uint8Array(PNG)>. PNG, sayfanın ekranda görünen yönündedir.
 */
export async function flattenLayers(bytes, layers, opts) {
  const { doc } = await openForEdit(bytes, opts);
  for (const [idx, png] of layers) {
    const page = doc.getPage(idx);
    const img = await doc.embedPng(u8(png));
    const box = page.getCropBox();
    const W = box.width, H = box.height, x0 = box.x, y0 = box.y;
    const rot = ((page.getRotation().angle % 360) + 360) % 360;
    // Resim, sayfa döndürülmüş gösterildiğinde dik görünecek şekilde yerleştirilir.
    // Çarpma (multiply) karışımı: vurgulayıcı alttaki yazıyı örtmez.
    const o = { blendMode: BlendMode.Multiply };
    if (rot === 90) page.drawImage(img, { ...o, x: x0 + W, y: y0, width: H, height: W, rotate: degrees(90) });
    else if (rot === 180) page.drawImage(img, { ...o, x: x0 + W, y: y0 + H, width: W, height: H, rotate: degrees(180) });
    else if (rot === 270) page.drawImage(img, { ...o, x: x0, y: y0 + H, width: H, height: W, rotate: degrees(270) });
    else page.drawImage(img, { ...o, x: x0, y: y0, width: W, height: H });
  }
  return save(doc);
}
