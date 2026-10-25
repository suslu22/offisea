// Belge içeriğinde arama. Her belgenin düz metni bu cihazdaki arama dizininde (IndexedDB) tutulur;
// belge değiştiyse (kayıt tarihi farklıysa) metin yeniden çıkarılır. Hiçbir şey dışarı gönderilmez.
import { loadDoc, listTextIndex, putTextIndex, deleteTextIndex } from './core/storage.js';

const MAX_CHARS = 300000;
const MAX_PDF_PAGES = 300;
// Metin çıkarma kuralları değişince sürüm artırılır; eski kayıtlar yeniden dizinlenir
const INDEX_VERSION = 1;

function htmlText(html) {
  if (typeof html !== 'string' || !html) return '';
  // Blok sonları boşluk olur; DOMParser betik çalıştırmaz, yalnızca metni çözer
  const marked = html.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/td|\/th|\/tr|\/blockquote)\b[^>]*>/gi, '$& ');
  try {
    const doc = new DOMParser().parseFromString(marked, 'text/html');
    return doc.body ? doc.body.textContent || '' : '';
  } catch { return marked.replace(/<[^>]*>/g, ' '); }
}

function collect(obj, keys, out, depth = 0) {
  if (out.n > MAX_CHARS || depth > 14 || obj == null) return;
  if (Array.isArray(obj)) { for (const x of obj) collect(x, keys, out, depth + 1); return; }
  if (typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && keys.has(k)) {
      const t = k === 'html' ? htmlText(v) : v;
      out.parts.push(t); out.n += t.length;
    } else if (v && typeof v === 'object') collect(v, keys, out, depth + 1);
  }
}

async function pdfText(data) {
  const out = [];
  if (!data || !data.bytes) return '';
  const { loadPdfJs } = await import('./pdf/pdfjs.js');
  const task = loadPdfJs(data.bytes);
  task.onPassword = () => { task.destroy(); }; // parolalı PDF'lerin yalnızca adı aranır
  let pdf;
  try { pdf = await task.promise; } catch { return ''; }
  const annots = Array.isArray(data.annots) ? data.annots : [];
  try {
    let n = 0;
    for (let i = 1; i <= Math.min(pdf.numPages, MAX_PDF_PAGES) && n < MAX_CHARS; i++) {
      const pg = await pdf.getPage(i);
      const tc = await pg.getTextContent();
      // Kullanıcının değiştirdiği ya da sildiği yazılar (düzenleme kutularının altında kalanlar) aranmaz
      const edits = annots.filter((a) => a && a.t === 'tedit' && a.p === i - 1);
      let items = tc.items;
      if (edits.length) {
        const vp = pg.getViewport({ scale: 1 });
        items = items.filter((x) => {
          if (!x.transform) return true;
          const [m0, m1, m2, m3, e, f] = vp.transform;
          const [a, b, c, d, tx, ty] = x.transform;
          const X = m0 * tx + m2 * ty + e, Y = m1 * tx + m3 * ty + f;
          const fs = Math.hypot(m0 * c + m2 * d, m1 * c + m3 * d);
          const cx = X + ((m0 * a + m2 * b) / Math.max(1e-6, Math.hypot(a, b))) * (x.width || 0) / 2;
          const cy = Y - fs * 0.3;
          return !edits.some((r) => cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h);
        });
      }
      const t = items.map((x) => (x.str || '') + (x.hasEOL ? '\n' : '')).join(' ');
      out.push(t); n += t.length;
      pg.cleanup();
    }
  } catch { /* okunabildiği kadarı */ } finally {
    Promise.resolve().then(() => pdf.loadingTask.destroy()).catch(() => {});
  }
  // Notlar, düzenlenmiş yazılar ve form değerleri de aranır
  for (const a of annots) if (a && typeof a.text === 'string') out.push(a.text);
  if (data.form && typeof data.form === 'object') for (const v of Object.values(data.form)) if (typeof v === 'string' && v !== 'Off') out.push(v);
  return out.join('\n');
}

/** Belgenin aranabilir düz metni. */
export async function docText(kind, data) {
  if (!data) return '';
  if (kind === 'pdf') return pdfText(data);
  const out = { parts: [], n: 0 };
  if (kind === 'word') out.parts.push(htmlText(data.html));
  else if (kind === 'sheet') {
    for (const sh of Array.isArray(data.sheets) ? data.sheets : []) {
      if (sh && typeof sh.name === 'string') out.parts.push(sh.name);
      for (const e of Array.isArray(sh && sh.cells) ? sh.cells : []) {
        const c = Array.isArray(e) ? e[1] : e;
        if (!c || typeof c !== 'object') continue;
        const v = c.cv != null && typeof c.cv !== 'object' ? c.cv : c.v;
        if (typeof v === 'string' || typeof v === 'number') { const t = String(v); out.parts.push(t); out.n += t.length; }
        if (out.n > MAX_CHARS) break;
      }
    }
  } else collect(data, new Set(['html', 'notes', 'text', 'title']), out);
  return out.parts.join('\n');
}

const norm = (s) => s.toLocaleLowerCase('tr').replace(/\s+/g, ' ');

let indexCache = null; // Map<id, { u, t, low }>
async function loadIndex() {
  if (!indexCache) {
    indexCache = new Map();
    try { for (const r of await listTextIndex()) indexCache.set(r.id, { u: r.u, v: r.v, t: r.t, low: norm(r.t) }); } catch { /* dizin yok */ }
  }
  return indexCache;
}

const isStale = (r, d) => !r || r.u !== d.updated || r.v !== INDEX_VERSION;

let running = null;
/**
 * Dizini belge listesine göre günceller (eksik ya da eskimiş belgeler yeniden okunur).
 * `onProgress(done, total)`; dönen söz bitince çözülür.
 */
export function updateIndex(docs, onProgress) {
  if (running) return running;
  running = (async () => {
    const idx = await loadIndex();
    const live = new Set(docs.map((d) => d.id));
    for (const id of [...idx.keys()]) if (!live.has(id)) { idx.delete(id); deleteTextIndex(id).catch(() => {}); }
    const todo = docs.filter((d) => isStale(idx.get(d.id), d));
    for (let i = 0; i < todo.length; i++) {
      if (onProgress) onProgress(i, todo.length);
      const d = todo[i];
      let t = '';
      try {
        const full = await loadDoc(d.id);
        if (!full) continue;
        t = (await docText(full.kind, full.data)).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, MAX_CHARS);
      } catch (e) { console.warn('Dizinlenemedi', d.id, e); }
      idx.set(d.id, { u: d.updated, v: INDEX_VERSION, t, low: norm(t) });
      try { await putTextIndex({ id: d.id, u: d.updated, v: INDEX_VERSION, t }); } catch { /* yok say */ }
      // Arayüz takılmasın diye her belgeden sonra kısa bir ara verilir
      await new Promise((r) => setTimeout(r, 0));
    }
    if (onProgress) onProgress(todo.length, todo.length);
  })().finally(() => { running = null; });
  return running;
}

/** Dizinlenmesi gereken belge sayısı. */
export async function staleCount(docs) {
  const idx = await loadIndex();
  return docs.filter((d) => isStale(idx.get(d.id), d)).length;
}

/**
 * İçerikte arar. Döner: Map<id, { before, match, after }> (eşleşmenin çevresindeki metin).
 */
export async function searchContent(q) {
  const idx = await loadIndex();
  const needle = norm(q.trim());
  const out = new Map();
  if (!needle) return out;
  for (const [id, r] of idx) {
    const at = r.low.indexOf(needle);
    if (at < 0) continue;
    // Küçük harfe çevirme bazı harflerde uzunluğu değiştirebilir; parça özgün metinden yaklaşık alınır
    const flat = r.t.replace(/\s+/g, ' ');
    const pos = flat.length === r.low.length ? at : Math.max(0, flat.toLocaleLowerCase('tr').indexOf(needle));
    const start = Math.max(0, pos - 40);
    out.set(id, {
      before: (start > 0 ? '…' : '') + flat.slice(start, pos),
      match: flat.slice(pos, pos + needle.length),
      after: flat.slice(pos + needle.length, pos + needle.length + 80),
    });
  }
  return out;
}
