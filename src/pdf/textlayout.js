// PDF sayfasındaki yazıları düzenlenebilir bloklara (paragraflara) ayırma, ekranda PDF'e
// yazılacak yazı tipleriyle aynı ölçülerde satır kırma ve renk örnekleme.

// Ekranda kullanılan yazı tipleri, PDF'e gömülenlerle aynı dosyalardır; böylece satırlar ekranda
// nerede kırılıyorsa kaydedilen dosyada da orada kırılır.
export const FONT_CSS = {
  sans: '"OffiseaPdfSans", Arial, "Liberation Sans", Helvetica, sans-serif',
  serif: '"OffiseaPdfSerif", "Times New Roman", Tinos, Times, serif',
};
// Yazı tiplerinin üst/alt yükseklikleri (em cinsinden; hhea tablosundan)
export const METRICS = { sans: { a: 0.905, d: 0.212 }, serif: { a: 0.891, d: 0.216 } };

const FACES = [
  ['OffiseaPdfSans', 'pdfjs/standard_fonts/LiberationSans-Regular.ttf', '400', 'normal'],
  ['OffiseaPdfSans', 'pdfjs/standard_fonts/LiberationSans-Bold.ttf', '700', 'normal'],
  ['OffiseaPdfSans', 'pdfjs/standard_fonts/LiberationSans-Italic.ttf', '400', 'italic'],
  ['OffiseaPdfSans', 'pdfjs/standard_fonts/LiberationSans-BoldItalic.ttf', '700', 'italic'],
  ['OffiseaPdfSerif', 'pdf-fonts/Tinos-Regular.ttf', '400', 'normal'],
  ['OffiseaPdfSerif', 'pdf-fonts/Tinos-Bold.ttf', '700', 'normal'],
];
let fontsReady = null;
/** Ekran yazı tiplerini yükler (bir kez). Yüklenemezse benzer ölçülü sistem yazı tipleri kullanılır. */
export function loadScreenFonts() {
  if (fontsReady) return fontsReady;
  if (typeof FontFace !== 'function' || !document.fonts) return (fontsReady = Promise.resolve(false));
  fontsReady = Promise.all(FACES.map(async ([fam, path, weight, style]) => {
    const f = new FontFace(fam, `url("${new URL(path, document.baseURI).href}")`, { weight, style });
    await f.load();
    document.fonts.add(f);
  })).then(() => true, () => false);
  return fontsReady;
}

export const fontCss = (it, px) => `${it.i ? 'italic ' : ''}${it.b ? '700 ' : ''}${px}px ${FONT_CSS[it.ff] || FONT_CSS.sans}`;

let mctx = null;
/** Metni verilen genişliğe göre satırlara böler (`it`: { text, s, ff, b, i }). */
export function wrapLines(it, width) {
  if (!mctx) mctx = document.createElement('canvas').getContext('2d');
  // Ölçüm büyük punto ile yapılır (yuvarlama hatası azalır), sonra ölçeklenir
  const k = 100 / it.s;
  mctx.font = fontCss(it, 100);
  const W = width * k;
  const meas = (t) => mctx.measureText(t).width;
  const out = [];
  for (const para of String(it.text).split('\n')) {
    const words = para.split(/(\s+)/).filter((x) => x !== '');
    if (!words.length) { out.push(''); continue; }
    let line = '';
    for (const w of words) {
      const next = line + w;
      if (!line || meas(next.trimEnd()) <= W) { line = next; continue; }
      if (/^\s+$/.test(w)) { out.push(line.trimEnd()); line = ''; continue; }
      out.push(line.trimEnd());
      line = w;
      // Tek başına sığmayan çok uzun kelime harf harf bölünür
      while (meas(line) > W && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && meas(line.slice(0, cut)) > W) cut--;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

// PDF matris çarpımı (pdf.js Util.transform ile aynı)
const tmul = (m1, m2) => [
  m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
  m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
  m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
];

function fontStyle(name, style, commonObjs) {
  let f = null;
  try { if (commonObjs && commonObjs.has(name)) f = commonObjs.get(name); } catch { f = null; }
  const fname = String((f && f.name) || '').replace(/^[A-Z]{6}\+/, '');
  const serif = style && style.fontFamily === 'serif'
    ? !/arial|helvet|sans|calibri|verdana|tahoma|roboto|segoe/i.test(fname)
    : /times|serif|roman|georgia|garamond|cambria|book|minion/i.test(fname) && !/sans/i.test(fname);
  return {
    ff: serif ? 'serif' : 'sans',
    b: !!(f && (f.bold || f.black)) || /bold|black|heavy|semibold|demi/i.test(fname),
    i: !!(f && f.italic) || /italic|oblique/i.test(fname),
  };
}

/**
 * Sayfadaki yazıları satırlara, satırları bloklara ayırır. Yalnızca yatay yazılar alınır.
 * `vp`: ölçek 1 görünüm alanı. Döner: [{ x, y, w, h, bx, by, lh, s, ff, b, i, text, oc }]
 * (ekrandaki yönde, pt cinsinden; `by` ilk satırın taban çizgisi).
 */
const KEYVAL = /^[^:]{1,40}:\s/; // "Etiket: değer" satırları (fatura, form…)
const LISTITEM = /^([•▪◦·*–-]|\d{1,3}[.)])\s/; // madde işaretli / numaralı satırlar

export function textBlocks(tc, vp, commonObjs) {
  const lines = [];
  let cur = null;
  const endLine = () => { if (cur && cur.text.trim()) lines.push(cur); cur = null; };
  for (const it of tc.items) {
    if (typeof it.str !== 'string') continue; // işaretli içerik başlangıcı/bitişi
    if (!it.str) { if (it.hasEOL) endLine(); continue; }
    const tx = tmul(vp.transform, it.transform);
    const fs = Math.hypot(tx[2], tx[3]);
    if (!(fs > 1) || Math.abs(tx[1]) > fs * 0.02 || Math.abs(tx[2]) > fs * 0.02 || tx[0] < 0) { endLine(); continue; }
    const st = tc.styles[it.fontName] || {};
    const x = tx[4], base = tx[5], w = Math.max(0, it.width * vp.scale);
    const style = fontStyle(it.fontName, st, commonObjs);
    const same = cur && Math.abs(base - cur.base) < fs * 0.3 && fs / cur.s > 0.7 && fs / cur.s < 1.4 && x > cur.x1 - fs * 0.6 && x - cur.x1 < fs * 2.5;
    if (!same) {
      endLine();
      cur = { x0: x, x1: x + w, base, s: fs, a: st.ascent > 0 ? st.ascent : 0.8, d: st.descent < 0 ? -st.descent : 0.2, text: '', n: 0, ...style };
    } else if (x - cur.x1 > fs * 0.15 && !/\s$/.test(cur.text) && !/^\s/.test(it.str)) cur.text += ' ';
    cur.text += it.str;
    cur.x1 = Math.max(cur.x1, x + w);
    cur.n += it.str.replace(/\s/g, '').length;
    if (it.hasEOL) endLine();
  }
  endLine();

  const blocks = [];
  let b = null;
  const close = () => { if (b) blocks.push(b); b = null; };
  for (const l of lines) {
    const gap = b ? l.base - b.last.base : 0;
    const ov = b ? Math.min(l.x1, b.x1) - Math.max(l.x0, b.x0) : 0;
    const fits = b && l.ff === b.ff && l.b === b.b && l.s / b.s > 0.88 && l.s / b.s < 1.14 &&
      gap > b.s * 0.6 && gap < b.s * 2 && (!b.lh || Math.abs(gap - b.lh) < b.s * 0.35) &&
      ov > Math.min(l.x1 - l.x0, b.x1 - b.x0) * 0.3;
    if (!fits) {
      close();
      b = { x0: l.x0, x1: l.x1, s: l.s, a: l.a, d: l.d, ff: l.ff, b: l.b, i: l.i, lh: 0, first: l, last: l, lines: [l] };
      continue;
    }
    if (!b.lh) b.lh = gap;
    b.x0 = Math.min(b.x0, l.x0); b.x1 = Math.max(b.x1, l.x1);
    b.last = l;
    b.lines.push(l);
  }
  close();

  return blocks.map((bl) => {
    const W = bl.x1 - bl.x0;
    // Kısa kalan satırların sonu gerçek satır sonudur (adres, liste…); diğerleri birleşir
    let text = '';
    bl.lines.forEach((l, i) => {
      const t = l.text.trim();
      if (i === 0) { text = t; return; }
      const prev = bl.lines[i - 1];
      const pt = prev.text.trim();
      // Sonraki satırın ilk kelimesi önceki satıra sığardıysa satır sonu bilinçlidir
      const first = t.split(/\s/)[0];
      const fw = ((l.x1 - l.x0) * (first.length + 1)) / Math.max(1, t.length);
      const hard = prev.x1 - bl.x0 < W * 0.8 || prev.x1 - bl.x0 + fw < W * 0.97 ||
        (KEYVAL.test(pt) && (KEYVAL.test(t) || pt.length < 60)) || LISTITEM.test(t);
      if (hard) text += '\n' + t;
      else if (/[-‐]$/.test(text) && /^[a-zçğıöşü]/.test(t)) text = text.slice(0, -1) + t;
      else text += ' ' + t;
    });
    // Yazı boyutu, satırların gerçek genişliğine göre ayarlanır: yazı tipi farklıysa ya da boyut
    // tahminiyse (OCR), yeni yazı eskisiyle aynı genişliği kaplar ve satırlar aynı yerde kırılır
    let fit = bl.s;
    try {
      if (!mctx) mctx = document.createElement('canvas').getContext('2d');
      mctx.font = fontCss(bl, 100);
      let meas = 0, real = 0;
      for (const l of bl.lines) { meas += (mctx.measureText(l.text.trim()).width * bl.s) / 100; real += l.x1 - l.x0; }
      const k = meas > 0 && real > 0 ? real / meas : 1;
      if (k < 0.96 || k > 1.04) fit = bl.s * Math.min(1.1, Math.max(0.6, k));
    } catch { /* ölçülemezse özgün boyut */ }
    const s = Math.round(fit * 10) / 10;
    const top = bl.first.base - bl.a * bl.s;
    const bottom = bl.last.base + bl.d * bl.s;
    const pad = bl.s * 0.08;
    return {
      x: bl.x0 - pad, y: top - pad, w: W + pad * 2, h: bottom - top + pad * 2,
      bx: bl.x0, by: bl.first.base, bw: W * 1.03 + s * 0.3, lh: Math.round((bl.lh || bl.s * 1.2) * 100) / 100,
      s, ff: bl.ff, b: bl.b, i: bl.i, text, oc: bl.lines.reduce((n, l) => n + l.n, 0),
    };
  });
}

const hex2 = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
/**
 * Çizilmiş sayfa tuvalinden bir alanın arka plan ve yazı rengini tahmin eder.
 * `k`: 1 pt kaç tuval pikseli.
 */
export function sampleColors(canvas, rect, k) {
  const out = { c: '#000000', bg: '#ffffff' };
  if (!canvas) return out;
  const x = Math.max(0, Math.floor(rect.x * k)), y = Math.max(0, Math.floor(rect.y * k));
  const w = Math.min(canvas.width - x, Math.ceil(rect.w * k)), hh = Math.min(canvas.height - y, Math.ceil(rect.h * k));
  if (w < 1 || hh < 1) return out;
  let d;
  try { d = canvas.getContext('2d').getImageData(x, y, w, hh).data; } catch { return out; }
  const step = Math.max(1, Math.floor(Math.sqrt((w * hh) / 40000))) * 4;
  const bins = new Map();
  for (let i = 0; i < d.length; i += step) {
    const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    const e = bins.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += d[i]; e.g += d[i + 1]; e.b += d[i + 2];
    bins.set(key, e);
  }
  const avg = (e) => [e.r / e.n, e.g / e.n, e.b / e.n];
  const sorted = [...bins.values()].sort((a, b) => b.n - a.n);
  if (!sorted.length) return out;
  const bg = avg(sorted[0]);
  out.bg = '#' + bg.map(hex2).join('');
  const far = sorted.find((e) => { const c = avg(e); return Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]) > 150; });
  if (far) {
    // Yazının en koyu/en belirgin tonları (kenar yumuşatma pikselleri hariç)
    const fc = avg(far);
    out.c = '#' + fc.map(hex2).join('');
  } else {
    const lum = bg[0] * 0.3 + bg[1] * 0.59 + bg[2] * 0.11;
    out.c = lum > 128 ? '#000000' : '#ffffff';
  }
  return out;
}
