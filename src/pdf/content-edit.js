// PDF sayfa içeriğinden yazı silme. Sayfanın içerik akışı (content stream) okunur, metin
// komutlarının (Tj, TJ, ', ") her harfinin sayfadaki yeri hesaplanır; verilen alanların içindeki
// harfler dosyadan gerçekten çıkarılır. Yazının üstünü yalnızca beyaz kutuyla örtmek, silinen
// metnin dosyada okunabilir kalmasına yol açardı (bilinen "karartma" hatası); burada yazı silinir.
// Silinen harfin yerine aynı genişlikte boşluk konur, böylece satırdaki diğer yazılar kaymaz.
// Dokunulmayan baytlar aynen korunur.
import {
  PDFName, PDFArray, PDFDict, PDFNumber, PDFRawStream, PDFRef, PDFStream,
  decodePDFRawStream, StandardFontEmbedder, StandardFonts,
} from '@cantoo/pdf-lib';

// ---- Sözcük çözümleyici ---------------------------------------------------------------------
const isWs = (b) => b === 0 || b === 9 || b === 10 || b === 12 || b === 13 || b === 32;
const isDelim = (b) => b === 40 || b === 41 || b === 60 || b === 62 || b === 91 || b === 93 || b === 123 || b === 125 || b === 47 || b === 37;

class Lexer {
  constructor(bytes) { this.b = bytes; this.i = 0; }
  skipWs() {
    const b = this.b;
    for (;;) {
      while (this.i < b.length && isWs(b[this.i])) this.i++;
      if (b[this.i] === 37) { while (this.i < b.length && b[this.i] !== 10 && b[this.i] !== 13) this.i++; continue; }
      return;
    }
  }
  /** Sıradaki öğe: { t: 'num'|'name'|'str'|'arr'|'dict'|'op', v, s, e } ya da null. */
  next() {
    this.skipWs();
    const b = this.b;
    if (this.i >= b.length) return null;
    const s = this.i;
    const c = b[s];
    if (c === 40) return { t: 'str', v: this.literal(), s, e: this.i };
    if (c === 60 && b[s + 1] === 60) { this.i += 2; this.dictBody(); return { t: 'dict', s, e: this.i }; }
    if (c === 60) return { t: 'str', v: this.hex(), s, e: this.i };
    if (c === 91) {
      this.i++;
      const items = [];
      for (;;) {
        this.skipWs();
        if (this.i >= b.length) break;
        if (b[this.i] === 93) { this.i++; break; }
        const it = this.next();
        if (!it) break;
        items.push(it);
      }
      return { t: 'arr', v: items, s, e: this.i };
    }
    if (c === 47) {
      this.i++;
      while (this.i < b.length && !isWs(b[this.i]) && !isDelim(b[this.i])) this.i++;
      return { t: 'name', v: latin(b.subarray(s + 1, this.i)), s, e: this.i };
    }
    if (c === 41 || c === 62 || c === 93 || c === 123 || c === 125) { this.i++; return this.next(); } // bozuk ayraç
    while (this.i < b.length && !isWs(b[this.i]) && !isDelim(b[this.i])) this.i++;
    const word = latin(b.subarray(s, this.i));
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { t: 'num', v: +word, s, e: this.i };
    return { t: 'op', v: word, s, e: this.i };
  }
  dictBody() {
    const b = this.b;
    let depth = 1;
    while (this.i < b.length && depth > 0) {
      const c = b[this.i];
      if (c === 40) { this.literal(); continue; }
      if (c === 60 && b[this.i + 1] === 60) { depth++; this.i += 2; continue; }
      if (c === 62 && b[this.i + 1] === 62) { depth--; this.i += 2; continue; }
      if (c === 60) { this.hex(); continue; }
      this.i++;
    }
  }
  literal() {
    const b = this.b;
    const out = [];
    let depth = 0;
    this.i++; // (
    while (this.i < b.length) {
      const c = b[this.i++];
      if (c === 92) {
        const d = b[this.i++];
        if (d === 110) out.push(10); else if (d === 114) out.push(13); else if (d === 116) out.push(9);
        else if (d === 98) out.push(8); else if (d === 102) out.push(12);
        else if (d === 13) { if (b[this.i] === 10) this.i++; } else if (d === 10) { /* satır devamı */ }
        else if (d >= 48 && d <= 55) {
          let v = d - 48;
          for (let k = 0; k < 2 && b[this.i] >= 48 && b[this.i] <= 55; k++) v = v * 8 + (b[this.i++] - 48);
          out.push(v & 255);
        } else if (d !== undefined) out.push(d);
        continue;
      }
      if (c === 40) depth++;
      else if (c === 41) { if (depth === 0) break; depth--; }
      out.push(c);
    }
    return Uint8Array.from(out);
  }
  hex() {
    const b = this.b;
    this.i++; // <
    const digits = [];
    while (this.i < b.length && b[this.i] !== 62) {
      const c = b[this.i++];
      const v = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
      if (v >= 0) digits.push(v);
    }
    this.i++; // >
    if (digits.length % 2) digits.push(0);
    const out = new Uint8Array(digits.length / 2);
    for (let k = 0; k < out.length; k++) out[k] = digits[2 * k] * 16 + digits[2 * k + 1];
    return out;
  }
  /** BI … ID <ikili veri> EI: satır içi resim atlanır. */
  skipInlineImage() {
    const b = this.b;
    // ID'ye kadar sözlük girdileri
    for (;;) {
      const t = this.next();
      if (!t || (t.t === 'op' && t.v === 'ID')) break;
    }
    this.i++; // ID'den sonraki tek boşluk
    while (this.i < b.length) {
      if (b[this.i] === 69 && b[this.i + 1] === 73 && isWs(b[this.i - 1]) && (this.i + 2 >= b.length || isWs(b[this.i + 2]))) { this.i += 2; return; }
      this.i++;
    }
  }
}

function latin(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return s;
}

// ---- Matrisler (PDF: satır vektörü × matris) -------------------------------------------------
const mul = (a, b) => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
const apply = (m, x, y) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];

// ---- Yazı tipi genişlikleri ------------------------------------------------------------------
const STD = {
  helvetica: StandardFonts.Helvetica, arial: StandardFonts.Helvetica,
  'helvetica-bold': StandardFonts.HelveticaBold, 'arial-bold': StandardFonts.HelveticaBold, 'arial,bold': StandardFonts.HelveticaBold,
  'helvetica-oblique': StandardFonts.HelveticaOblique, 'helvetica-boldoblique': StandardFonts.HelveticaBoldOblique,
  'times-roman': StandardFonts.TimesRoman, timesnewroman: StandardFonts.TimesRoman, 'times-bold': StandardFonts.TimesRomanBold,
  'times-italic': StandardFonts.TimesRomanItalic, 'times-bolditalic': StandardFonts.TimesRomanBoldItalic,
  courier: StandardFonts.Courier, 'courier-bold': StandardFonts.CourierBold, 'courier-oblique': StandardFonts.CourierOblique,
  'courier-boldoblique': StandardFonts.CourierBoldOblique, symbol: StandardFonts.Symbol, zapfdingbats: StandardFonts.ZapfDingbats,
};

function lookup(ctx, obj) { return obj instanceof PDFRef ? ctx.lookup(obj) : obj; }
const num = (ctx, o, def = 0) => { const v = lookup(ctx, o); return v instanceof PDFNumber ? v.asNumber() : def; };

function fontInfo(ctx, dict) {
  if (!(dict instanceof PDFDict)) return null;
  const sub = lookup(ctx, dict.get(PDFName.of('Subtype')));
  const subtype = sub instanceof PDFName ? sub.decodeText() : '';
  if (subtype === 'Type0') {
    const arr = lookup(ctx, dict.get(PDFName.of('DescendantFonts')));
    const desc = arr instanceof PDFArray ? lookup(ctx, arr.get(0)) : null;
    if (!(desc instanceof PDFDict)) return null;
    const enc = lookup(ctx, dict.get(PDFName.of('Encoding')));
    const encName = enc instanceof PDFName ? enc.decodeText() : '';
    // Tek baytlık ya da karışık kod alanlı CMap'ler güvenle çözülemez; bu yazı tipleri atlanır.
    if (encName && !/^Identity-[HV]$|UCS2|UTF16|^Uni/i.test(encName)) return null;
    const dw = num(ctx, desc.get(PDFName.of('DW')), 1000);
    const widths = new Map();
    const W = lookup(ctx, desc.get(PDFName.of('W')));
    if (W instanceof PDFArray) {
      for (let i = 0; i < W.size();) {
        const first = num(ctx, W.get(i), -1);
        const second = lookup(ctx, W.get(i + 1));
        if (second instanceof PDFArray) {
          for (let k = 0; k < second.size(); k++) widths.set(first + k, num(ctx, second.get(k)));
          i += 2;
        } else {
          const last = num(ctx, second, -1), w = num(ctx, W.get(i + 2));
          for (let c = first; c <= last && c - first < 65536; c++) widths.set(c, w);
          i += 3;
        }
      }
    }
    return { bytes: 2, width: (code) => (widths.has(code) ? widths.get(code) : dw) / 1000 };
  }
  // Basit yazı tipleri (Type1, TrueType, Type3): tek baytlık kodlar
  let scale = 1 / 1000;
  if (subtype === 'Type3') {
    const fm = lookup(ctx, dict.get(PDFName.of('FontMatrix')));
    scale = fm instanceof PDFArray ? num(ctx, fm.get(0), 0.001) : 0.001;
  }
  const first = num(ctx, dict.get(PDFName.of('FirstChar')), 0);
  const Wd = lookup(ctx, dict.get(PDFName.of('Widths')));
  const fd = lookup(ctx, dict.get(PDFName.of('FontDescriptor')));
  const missing = fd instanceof PDFDict ? num(ctx, fd.get(PDFName.of('MissingWidth')), 0) : 0;
  if (Wd instanceof PDFArray) {
    const ws = [];
    for (let i = 0; i < Wd.size(); i++) ws.push(num(ctx, Wd.get(i)));
    return { bytes: 1, width: (code) => (code >= first && code - first < ws.length ? ws[code - first] : missing) * scale };
  }
  // Genişlik tablosu olmayan standart 14 yazı tipi
  const base = lookup(ctx, dict.get(PDFName.of('BaseFont')));
  const key = base instanceof PDFName ? base.decodeText().replace(/^[A-Z]{6}\+/, '').toLowerCase().replace(/mt$|ps$/, '') : '';
  const std = STD[key] || STD[key.replace(/,.*$/, '')];
  if (!std) return null;
  const emb = StandardFontEmbedder.for(std);
  const names = new Map();
  for (const v of Object.values(emb.encoding.unicodeMappings)) names.set(v[0], v[1]);
  return { bytes: 1, width: (code) => { const n = names.get(code); return n ? emb.font.getWidthOfGlyph(n) / 1000 : 0.5; } };
}

// ---- İçerik akışı okuma / yazma ---------------------------------------------------------------
function streamBytes(s) {
  if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode();
  if (s && typeof s.getUnencodedContents === 'function') return s.getUnencodedContents();
  if (s instanceof PDFStream && typeof s.getContents === 'function') return s.getContents();
  return null;
}

/** Sayfanın tüm içerik akışlarını tek bayt dizisinde birleştirir (çözülemezse null). */
export function pageContentBytes(page) {
  const ctx = page.doc.context;
  const contents = lookup(ctx, page.node.get(PDFName.of('Contents')));
  const list = contents instanceof PDFArray ? contents.asArray().map((x) => lookup(ctx, x)) : contents ? [contents] : [];
  const parts = [];
  for (const s of list) {
    const b = streamBytes(s);
    if (!b) return null;
    parts.push(b, Uint8Array.of(10));
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function setPageContent(page, bytes) {
  const ctx = page.doc.context;
  const stream = ctx.flateStream(bytes);
  // Dizi olarak tutulur: pdf-lib sonradan eklenen çizimleri bu diziye ekler
  page.node.set(PDFName.of('Contents'), ctx.obj([ctx.register(stream)]));
}

const enc = new TextEncoder();
const hexOf = (u8) => '<' + Array.from(u8, (x) => x.toString(16).padStart(2, '0')).join('') + '>';
const fmt = (n) => (Math.abs(n) < 1e-6 ? '0' : String(Math.round(n * 1000) / 1000));

/**
 * Verilen alanların (kullanıcı uzayında [x0, y0, x1, y1]) içindeki yazıları sayfadan siler.
 * Döner: her alan için { visible, invisible } silinen harf sayısı ve `skipped` (çözülemeyen
 * yazı tipi ya da form nesnesi içindeki yazılar nedeniyle bazı yazılar kalmış olabilir).
 */
export function removeTextInRects(page, rects) {
  const counts = rects.map(() => ({ visible: 0, invisible: 0 }));
  const result = { counts, skipped: false };
  if (!rects.length) return result;
  const bytes = pageContentBytes(page);
  if (!bytes) { result.skipped = true; return result; }
  const ctx = page.doc.context;
  const res = page.node.Resources();
  const fontsDict = res ? lookup(ctx, res.get(PDFName.of('Font'))) : null;
  const fontCache = new Map();
  const getFont = (name) => {
    if (fontCache.has(name)) return fontCache.get(name);
    let info = null;
    try { info = fontsDict instanceof PDFDict ? fontInfo(ctx, lookup(ctx, fontsDict.get(PDFName.of(name)))) : null; } catch { info = null; }
    fontCache.set(name, info);
    return info;
  };
  const hitRect = (x, y) => {
    for (let k = 0; k < rects.length; k++) {
      const r = rects[k];
      if (x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]) return k;
    }
    return -1;
  };

  let gs = { ctm: [1, 0, 0, 1, 0, 0], font: null, fs: 0, Tc: 0, Tw: 0, Th: 1, TL: 0, Ts: 0, Tr: 0 };
  const stack = [];
  let Tm = [1, 0, 0, 1, 0, 0], Tlm = [1, 0, 0, 1, 0, 0];
  const lx = new Lexer(bytes);
  const edits = []; // { s, e, text }
  let args = [];
  let argStart = -1;

  const td = (tx, ty) => { Tlm = mul([1, 0, 0, 1, tx, ty], Tlm); Tm = Tlm.slice(); };

  /** Bir metin komutunu işler; silinecek harf varsa yeni TJ dizisi döndürür. */
  const show = (elements) => {
    const f = gs.font && getFont(gs.font);
    const fs = gs.fs, Th = gs.Th;
    const out = []; // { str: number[] } | { n }
    let removed = false;
    let cur = null;
    const pushNum = (n) => {
      cur = null;
      const last = out[out.length - 1];
      if (last && 'n' in last) last.n += n; else out.push({ n });
    };
    for (const el of elements) {
      if (el.t === 'num') {
        const tx = -(el.v / 1000) * fs * Th;
        Tm = mul([1, 0, 0, 1, tx, 0], Tm);
        pushNum(el.v);
        continue;
      }
      if (el.t !== 'str') continue;
      const s = el.v;
      if (!f) {
        // Genişliği bilinmeyen yazı tipi: bu yazıya dokunulmaz; konum hesabı da yapılamaz
        result.skipped = true;
        for (const x of s) { if (!cur) { cur = { str: [] }; out.push(cur); } cur.str.push(x); }
        continue;
      }
      for (let i = 0; i + f.bytes - 1 < s.length; i += f.bytes) {
        const code = f.bytes === 2 ? (s[i] << 8) | s[i + 1] : s[i];
        const w0 = f.width(code);
        const tx = (w0 * fs + gs.Tc + (f.bytes === 1 && code === 32 ? gs.Tw : 0)) * Th;
        const trm = mul(mul([fs * Th, 0, 0, fs, 0, gs.Ts], Tm), gs.ctm);
        const [cx, cy] = apply(trm, w0 / 2, 0.3);
        const k = code === 32 && f.bytes === 1 ? -1 : hitRect(cx, cy);
        // Boşluk karakterleri, çevresindeki harflerle birlikte silinir
        const kk = k >= 0 ? k : (code === 32 && f.bytes === 1 ? hitRect(cx, cy) : -1);
        if (kk >= 0 && fs * Th !== 0) {
          removed = true;
          if (code !== 32) { if (gs.Tr === 3 || gs.Tr === 7) counts[kk].invisible++; else counts[kk].visible++; }
          pushNum(-(tx * 1000) / (fs * Th));
        } else {
          if (!cur) { cur = { str: [] }; out.push(cur); }
          for (let b = 0; b < f.bytes; b++) cur.str.push(s[i + b]);
        }
        Tm = mul([1, 0, 0, 1, tx, 0], Tm);
      }
    }
    if (!removed) return null;
    const parts = out.map((o) => ('n' in o ? fmt(o.n) : hexOf(Uint8Array.from(o.str))));
    return '[' + parts.join(' ') + '] TJ';
  };

  for (;;) {
    const tok = lx.next();
    if (!tok) break;
    if (tok.t !== 'op') {
      if (argStart < 0) argStart = tok.s;
      args.push(tok);
      continue;
    }
    const op = tok.v;
    const a = args;
    const start = argStart >= 0 ? argStart : tok.s;
    args = []; argStart = -1;
    const n = (i) => (a[i] && a[i].t === 'num' ? a[i].v : 0);
    switch (op) {
      case 'q': stack.push({ ...gs, ctm: gs.ctm.slice() }); break;
      case 'Q': if (stack.length) gs = stack.pop(); break;
      case 'cm': if (a.length >= 6) gs.ctm = mul([n(0), n(1), n(2), n(3), n(4), n(5)], gs.ctm); break;
      case 'BT': Tm = [1, 0, 0, 1, 0, 0]; Tlm = [1, 0, 0, 1, 0, 0]; break;
      case 'Tf': if (a[0] && a[0].t === 'name') gs.font = a[0].v; gs.fs = n(1); break;
      case 'Tc': gs.Tc = n(0); break;
      case 'Tw': gs.Tw = n(0); break;
      case 'Tz': gs.Th = n(0) / 100; break;
      case 'TL': gs.TL = n(0); break;
      case 'Ts': gs.Ts = n(0); break;
      case 'Tr': gs.Tr = n(0); break;
      case 'Td': td(n(0), n(1)); break;
      case 'TD': gs.TL = -n(1); td(n(0), n(1)); break;
      case 'Tm': Tlm = [n(0), n(1), n(2), n(3), n(4), n(5)]; Tm = Tlm.slice(); break;
      case 'T*': td(0, -gs.TL); break;
      case 'Tj': { const r = a[0] ? show([a[0]]) : null; if (r) edits.push({ s: start, e: tok.e, text: r }); break; }
      case 'TJ': { const r = a[0] && a[0].t === 'arr' ? show(a[0].v) : null; if (r) edits.push({ s: start, e: tok.e, text: r }); break; }
      case "'": { td(0, -gs.TL); const r = a[0] ? show([a[0]]) : null; if (r) edits.push({ s: start, e: tok.e, text: 'T* ' + r }); break; }
      case '"': {
        gs.Tw = n(0); gs.Tc = n(1); td(0, -gs.TL);
        const r = a[2] ? show([a[2]]) : null;
        if (r) edits.push({ s: start, e: tok.e, text: `${fmt(n(0))} Tw ${fmt(n(1))} Tc T* ${r}` });
        break;
      }
      case 'BI': lx.skipInlineImage(); break;
      case 'Do': result.skipped = true; break; // form nesneleri içindeki yazılar silinmez
      default: break;
    }
  }
  if (!edits.length) return result;
  const pieces = [];
  let pos = 0;
  for (const e of edits) {
    pieces.push(bytes.subarray(pos, e.s), enc.encode(e.text));
    pos = e.e;
  }
  pieces.push(bytes.subarray(pos));
  const total = pieces.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of pieces) { out.set(p, o); o += p.length; }
  setPageContent(page, out);
  return result;
}

/**
 * Sayfanın mevcut içeriğini q … Q arasına alır. Böylece sonradan eklenen çizimler, özgün içerikte
 * kapatılmamış bir dönüşüm kalsa bile doğru yere düşer.
 */
export function wrapPageContent(page) {
  const ctx = page.doc.context;
  const start = ctx.register(ctx.flateStream(enc.encode('q\n')));
  const end = ctx.register(ctx.flateStream(enc.encode('\nQ\n')));
  page.node.normalize();
  page.node.wrapContentStreams(start, end);
}
