// Yazı tipi yardımcıları.
//  - Uygulamayla gelen yazı tipleri (fonts.css) her cihazda gerçekten farklı görünür.
//  - Diğerleri (Verdana, Tahoma…) yalnızca cihazda kuruluysa listede gösterilir; telefonda bunlar
//    yoksa hepsi aynı sistem yazı tipiyle görüneceği için listeyi kalabalıklaştırmaz.

export const BUNDLED_FONTS = new Set(['Calibri', 'Calibri Light', 'Carlito', 'Arial', 'Times New Roman', 'Courier New', 'Georgia', 'Garamond']);

let ctx = null;
const cache = new Map();
const BASES = ['monospace', 'sans-serif', 'serif'];
const SAMPLE = 'mmmmmmmmmmlliWQ@#ğşİ';

function width(font) {
  ctx.font = font;
  return ctx.measureText(SAMPLE).width;
}

/** Yazı tipi cihazda kurulu mu? (Takma ad olarak genel yazı tipine yönlendirilenler "yok" sayılır.) */
export function systemHasFont(name) {
  if (cache.has(name)) return cache.get(name);
  let ok = true;
  try {
    if (!ctx) ctx = document.createElement('canvas').getContext('2d');
    const fam = `"${String(name).replace(/["\\]/g, '')}"`;
    // Her temel yazı tipinden farklı ölçülüyorsa gerçekten kurulu bir yazı tipidir.
    for (const b of BASES) {
      if (Math.abs(width(`72px ${fam}, ${b}`) - width(`72px ${b}`)) < 0.5) { ok = false; break; }
    }
  } catch { ok = true; }
  cache.set(name, ok);
  return ok;
}

/** Listeden bu cihazda farklı görünecek yazı tiplerini döndürür. */
export function usableFonts(list) {
  return list.filter((f) => BUNDLED_FONTS.has(f) || systemHasFont(f));
}

/** Seçim kutusundaki her yazı tipi adını kendi yazı tipiyle gösterir (desteklenen yerlerde). */
export function previewFontOptions(select) {
  for (const o of select.options) if (o.value) o.style.fontFamily = `"${o.value.replace(/["\\]/g, '')}", sans-serif`;
}

const loading = new Set();
/**
 * Tuvale (canvas) çizilen yazı tipleri tarayıcı tarafından kendiliğinden yüklenmez. Gerekirse yükler ve
 * yüklenince onLoad çağrılır (yeniden çizim için). font: CSS "font" kısaltması, ör. 'bold 14px Arial'.
 */
export function ensureCanvasFont(font, onLoad) {
  if (!document.fonts || loading.has(font)) return;
  // Türkçe harfler ayrı bir alt kümede (latin-ext); ikisi birden yüklensin.
  const text = 'aÇçĞğİıŞş';
  try { if (document.fonts.check(font, text)) return; } catch { return; }
  loading.add(font);
  document.fonts.load(font, text).then((faces) => { if (faces && faces.length) onLoad(); }).catch(() => {});
}
