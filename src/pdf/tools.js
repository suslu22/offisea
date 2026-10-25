// PDF araçları: birleştirme, sayfa ayırma, döndürme, silme, küçültme, resimden PDF ve
// notları sayfaya işleme. Tümü cihazda çalışır (pdf-lib, saf JavaScript; eval yok).
import {
  PDFDocument, degrees, BlendMode, rgb, pushGraphicsState, popGraphicsState, beginText, endText,
  setFontAndSize, setTextRenderingMode, TextRenderingMode, setTextMatrix, setCharacterSqueeze, showText,
} from '@cantoo/pdf-lib';
import { loadPdfJs } from './pdfjs.js';
import { removeTextInRects, wrapPageContent } from './content-edit.js';
import { fontEmbedder } from './pdffonts.js';
import { fillForm } from './forms.js';

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

/**
 * Resimlerden (JPEG baytları) PDF oluşturur; her resim bir A4 sayfaya sığdırılır.
 * `ocr`: her resim için tanınan kelimeler (layoutWords'e uygun; verilirse görünmez yazı eklenir).
 */
export async function imagesToPdf(images, { fit = 'a4', margin = 0, ocr = null } = {}) {
  const out = await PDFDocument.create();
  out.setTitle('Taranmış belge');
  out.setProducer('Offisea');
  const getFont = ocr ? fontEmbedder(out) : null;
  const { layoutWords } = ocr ? await import('./ocr.js') : {};
  for (let n = 0; n < images.length; n++) {
    const im = images[n];
    const jpg = await out.embedJpg(u8(im.bytes));
    let [pw, ph] = A4;
    if (im.w > im.h) [pw, ph] = [ph, pw];
    if (fit !== 'a4') { pw = im.w * 0.75; ph = im.h * 0.75; }
    const s = Math.min((pw - margin * 2) / im.w, (ph - margin * 2) / im.h);
    const w = im.w * s, hh = im.h * s;
    const page = out.addPage([pw, ph]);
    const ox = (pw - w) / 2, oy = (ph - hh) / 2;
    page.drawImage(jpg, { x: ox, y: oy, width: w, height: hh });
    if (ocr && ocr[n] && ocr[n].length) {
      await addTextLayer(out, page, layoutWords(ocr[n], s, (x, y) => [ox + x, oy + hh - y], 0), getFont);
    }
  }
  return save(out);
}

/**
 * Yazı tanıma sonuçlarını sayfalara görünmez yazı olarak ekler.
 * `layers`: Map<sayfaDizini, kelimeler (kullanıcı uzayında, addTextLayer biçiminde)>.
 */
export async function addOcrLayers(bytes, layers, opts) {
  const { doc } = await openForEdit(bytes, opts);
  const getFont = fontEmbedder(doc);
  for (const [idx, words] of layers) {
    const page = doc.getPage(idx);
    wrapPageContent(page);
    await addTextLayer(doc, page, words, getFont);
  }
  return save(doc);
}

/**
 * Not katmanlarını (her sayfa için saydam PNG) sayfaların üstüne kalıcı olarak çizer.
 * `layers`: Map<sayfaDizini, Uint8Array(PNG)>. PNG, sayfanın ekranda görünen yönündedir.
 */
export async function flattenLayers(bytes, layers, opts) {
  const { doc } = await openForEdit(bytes, opts);
  for (const [idx, png] of layers) await drawLayer(doc, doc.getPage(idx), png);
  return save(doc);
}

async function drawLayer(doc, page, png) {
  {
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
}

const hexRgb = (c) => {
  const m = /^#?([0-9a-f]{6})/i.exec(c || '') || /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c || '');
  if (!m) return rgb(0, 0, 0);
  const hx = m.length === 4 ? m[1] + m[1] + m[2] + m[2] + m[3] + m[3] : m[1];
  return rgb(parseInt(hx.slice(0, 2), 16) / 255, parseInt(hx.slice(2, 4), 16) / 255, parseInt(hx.slice(4, 6), 16) / 255);
};

/**
 * Notları ve yazı düzenlemelerini PDF'e işler.
 * `plans`: Map<sayfaDizini, { removes: [{ rect: [x0,y0,x1,y1], bg, oc }], texts: [{ family, bold, italic,
 * size, color, angle, lines: [{ str, at: [x, y] }] }], png }> (koordinatlar PDF kullanıcı uzayında).
 * `form`: { alanAdı: değer } form değerleri.
 */
export async function bakeEdits(bytes, plans, opts = {}) {
  const { doc } = await openForEdit(bytes, opts);
  const getFont = fontEmbedder(doc);
  let warn = false;
  if (opts.form && Object.keys(opts.form).length) await fillForm(doc, opts.form, getFont);
  for (const [idx, plan] of plans) {
    const page = doc.getPage(idx);
    let wrapped = false;
    const ensureWrap = () => { if (!wrapped) { wrapPageContent(page); wrapped = true; } };
    if (plan.removes && plan.removes.length) {
      const res = removeTextInRects(page, plan.removes.map((r) => r.rect));
      ensureWrap();
      plan.removes.forEach((r, k) => {
        const c = res.counts[k];
        // Yazı dosyadan silinemediyse (ör. taranmış sayfa ya da desteklenmeyen yazı tipi) üstü örtülür
        if (c.visible < Math.max(1, r.oc * 0.8)) {
          if (c.visible + c.invisible < Math.max(1, r.oc * 0.8)) warn = true;
          const [x0, y0, x1, y1] = r.rect;
          page.drawRectangle({ x: x0, y: y0, width: x1 - x0, height: y1 - y0, color: hexRgb(r.bg), borderWidth: 0 });
        }
      });
    }
    for (const t of plan.texts || []) {
      const lines = t.lines.filter((l) => l.str.trim());
      if (!lines.length) continue;
      ensureWrap();
      const { font, fakeItalic } = await getFont(t.family, t.bold, t.italic);
      for (const l of lines) {
        page.drawText(l.str, {
          x: l.at[0], y: l.at[1], size: t.size, font, color: hexRgb(t.color),
          rotate: degrees(t.angle || 0), ySkew: fakeItalic ? degrees(12) : undefined,
        });
      }
    }
    if (plan.png) { ensureWrap(); await drawLayer(doc, page, plan.png); }
  }
  return { bytes: await save(doc), warn };
}

/**
 * Yazı tanıma sonucunu sayfaya görünmez yazı olarak ekler (aranabilir / seçilebilir PDF).
 * `words`: [{ text, at: [x, y] (taban çizgisi başı), size, width, angle }] (kullanıcı uzayında).
 */
export async function addTextLayer(doc, page, words, getFont) {
  const list = words.filter((w) => w.text && w.text.trim() && w.size > 1 && w.width > 0);
  if (!list.length) return;
  const { font } = await getFont('sans', false, false);
  page.setFont(font);
  const ops = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
  for (const w of list) {
    const natural = font.widthOfTextAtSize(w.text, w.size);
    if (!(natural > 0)) continue;
    const sq = Math.max(10, Math.min(500, (w.width / natural) * 100));
    const a = ((w.angle || 0) * Math.PI) / 180;
    const cos = Math.cos(a), sin = Math.sin(a);
    ops.push(
      setFontAndSize(page.fontKey, w.size),
      setCharacterSqueeze(Math.round(sq * 100) / 100),
      setTextMatrix(cos, sin, -sin, cos, w.at[0], w.at[1]),
      showText(font.encodeText(w.text)),
    );
  }
  ops.push(endText(), popGraphicsState());
  page.pushOperators(...ops);
}
