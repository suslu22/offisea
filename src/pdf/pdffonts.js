// PDF'e yazı eklerken kullanılan yazı tipleri. Türkçe harfleri (ş, ğ, İ, ı …) kapsayan, uygulamayla
// gelen TrueType dosyalarıdır; PDF'e yalnızca kullanılan harfler gömülür (alt küme).
//  - sans: Liberation Sans (Arial ile aynı ölçüler)
//  - serif: Tinos (Times New Roman ile aynı ölçüler; eğik hali kaydırma ile üretilir)
import fontkit from '@cantoo/fontkit';

const FILES = {
  sans: {
    r: 'pdfjs/standard_fonts/LiberationSans-Regular.ttf', b: 'pdfjs/standard_fonts/LiberationSans-Bold.ttf',
    i: 'pdfjs/standard_fonts/LiberationSans-Italic.ttf', bi: 'pdfjs/standard_fonts/LiberationSans-BoldItalic.ttf',
  },
  serif: { r: 'pdf-fonts/Tinos-Regular.ttf', b: 'pdf-fonts/Tinos-Bold.ttf' },
};

const bytesCache = new Map();
function fetchFont(path) {
  if (!bytesCache.has(path)) {
    const p = fetch(new URL(path, document.baseURI).href).then((r) => {
      if (!r.ok) throw new Error('Yazı tipi yüklenemedi.');
      return r.arrayBuffer();
    });
    p.catch(() => bytesCache.delete(path));
    bytesCache.set(path, p);
  }
  return bytesCache.get(path);
}

/** Dosya yolu ve eğikliğin taklit edilip edilmeyeceği. */
export function fontFile(family, bold, italic) {
  const set = FILES[family] || FILES.sans;
  const key = (bold ? 'b' : '') + (italic ? 'i' : '') || 'r';
  if (set[key]) return { path: set[key], fakeItalic: false };
  return { path: bold ? set.b : set.r, fakeItalic: !!italic };
}

/** Bir PDFDocument için yazı tiplerini (her biri bir kez) gömen yardımcı. */
export function fontEmbedder(doc) {
  doc.registerFontkit(fontkit);
  const embedded = new Map();
  return async (family, bold, italic) => {
    const f = fontFile(family, bold, italic);
    if (!embedded.has(f.path)) embedded.set(f.path, fetchFont(f.path).then((b) => doc.embedFont(b, { subset: true })));
    return { font: await embedded.get(f.path), fakeItalic: f.fakeItalic };
  };
}
