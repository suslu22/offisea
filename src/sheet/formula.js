// Formül motoru: ayrıştırıcı + değerlendirici. eval/new Function KULLANILMAZ.
// Excel ile uyumlu İngilizce fonksiyon adları saklanır; Türkçe adlar (TOPLA, EĞER...)
// girişte otomatik çevrilir. Türkçe Excel'deki ";" ayırıcı ve "," ondalık da kabul edilir.

export const MAX_ROWS = 1048576;
export const MAX_COLS = 16384;

export function colName(c) {
  let s = '';
  let n = c + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
export function colIndex(name) {
  let n = 0;
  for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
export const addr = (r, c) => colName(c) + (r + 1);
export function parseAddr(s) {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(String(s).trim());
  if (!m) return null;
  const c = colIndex(m[1]), r = +m[2] - 1;
  if (r < 0 || r >= MAX_ROWS || c < 0 || c >= MAX_COLS) return null;
  return { r, c };
}

export class FErr {
  constructor(code) { this.code = code; }
  toString() { return this.code; }
}
export const ERR = {
  DIV0: new FErr('#DIV/0!'), VALUE: new FErr('#VALUE!'), REF: new FErr('#REF!'), NAME: new FErr('#NAME?'),
  NA: new FErr('#N/A'), NUM: new FErr('#NUM!'), NULL: new FErr('#NULL!'), CIRC: new FErr('#DÖNGÜ!'),
};
const ERR_BY_CODE = Object.fromEntries(Object.values(ERR).map((e) => [e.code, e]));
export const errFromCode = (code) => ERR_BY_CODE[String(code).toUpperCase()] || new FErr(String(code));

export class Rng {
  constructor(si, r1, c1, r2, c2) {
    this.si = si;
    this.r1 = Math.min(r1, r2); this.r2 = Math.max(r1, r2);
    this.c1 = Math.min(c1, c2); this.c2 = Math.max(c1, c2);
  }
  get rows() { return this.r2 - this.r1 + 1; }
  get cols() { return this.c2 - this.c1 + 1; }
}

// ---- Belirteçleyici (tokenizer) ------------------------------------------------------
const L = 'A-Za-z_\\u00C0-\\u024F';
const RE = {
  ws: /\s+/y,
  str: /"((?:[^"]|"")*)"/y,
  err: /#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|DÖNGÜ!)/iy,
  sheet: new RegExp(`(?:'((?:[^']|'')+)'|([${L}][\\w.${L.slice(5)}]*))!`, 'y'),
  cell: /(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?::(\$?)([A-Za-z]{1,3})(\$?)(\d+))?/y,
  cols: /(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})/y,
  rows: /(\$?)(\d+):(\$?)(\d+)/y,
  num: /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y,
  name: new RegExp(`[${L}\\\\][\\w.${L.slice(5)}]*`, 'y'),
  op: /<=|>=|<>|[-+*/^&=<>%]/y,
};
const WORDCH = /[\w.(À-ɏ]/;

function at(re, src, i) {
  re.lastIndex = i;
  const m = re.exec(src);
  return m ? { m, end: re.lastIndex } : null;
}

export function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    let x;
    if ((x = at(RE.ws, src, i))) { toks.push({ t: 'WS', s: x.m[0] }); i = x.end; continue; }
    if (ch === '"') {
      x = at(RE.str, src, i);
      if (!x) throw new FErr('#NAME?');
      toks.push({ t: 'STR', v: x.m[1].replace(/""/g, '"'), s: x.m[0] }); i = x.end; continue;
    }
    if (ch === '#') {
      x = at(RE.err, src, i);
      if (x) { toks.push({ t: 'ERR', v: errFromCode(x.m[0]), s: x.m[0] }); i = x.end; continue; }
    }
    if (ch === '(') { toks.push({ t: 'LP', s: ch }); i++; continue; }
    if (ch === ')') { toks.push({ t: 'RP', s: ch }); i++; continue; }
    if (ch === ',' || ch === ';') { toks.push({ t: 'SEP', s: ch }); i++; continue; }
    // Hücre/aralık başvurusu (isteğe bağlı sayfa adıyla)
    let sheet = null, sheetSrc = '', j = i;
    const sx = at(RE.sheet, src, i);
    if (sx) { sheet = sx.m[1] != null ? sx.m[1].replace(/''/g, "'") : sx.m[2]; sheetSrc = sx.m[0]; j = sx.end; }
    const ref = readRef(src, j);
    if (ref) {
      ref.sheet = sheet;
      ref.s = sheetSrc + src.slice(j, ref.end);
      toks.push(ref);
      i = ref.end;
      continue;
    }
    if (sheet) { toks.push({ t: 'ERR', v: ERR.REF, s: src.slice(i, j) }); i = j; continue; }
    if ((x = at(RE.num, src, i))) { toks.push({ t: 'NUM', v: parseFloat(x.m[0]), s: x.m[0] }); i = x.end; continue; }
    if ((x = at(RE.name, src, i))) {
      const up = x.m[0].toUpperCase();
      const upTr = x.m[0].toLocaleUpperCase('tr');
      if (src[x.end] !== '(' && (up === 'TRUE' || upTr === 'DOĞRU')) toks.push({ t: 'BOOL', v: true, s: x.m[0] });
      else if (src[x.end] !== '(' && (up === 'FALSE' || upTr === 'YANLIŞ')) toks.push({ t: 'BOOL', v: false, s: x.m[0] });
      else toks.push({ t: 'NAME', v: x.m[0], s: x.m[0] });
      i = x.end;
      continue;
    }
    if ((x = at(RE.op, src, i))) { toks.push({ t: 'OP', v: x.m[0], s: x.m[0] }); i = x.end; continue; }
    throw new FErr('#NAME?');
  }
  return toks;
}

function readRef(src, j) {
  let x = at(RE.cell, src, j);
  if (x && !WORDCH.test(src[x.end] || '')) {
    const m = x.m;
    const r1 = +m[4] - 1, c1 = colIndex(m[2]);
    if (m[6]) {
      return { t: 'REF', kind: 'range', r1, c1, r2: +m[8] - 1, c2: colIndex(m[6]), ar1: !!m[3], ac1: !!m[1], ar2: !!m[7], ac2: !!m[5], end: x.end };
    }
    return { t: 'REF', kind: 'cell', r1, c1, ar1: !!m[3], ac1: !!m[1], end: x.end };
  }
  x = at(RE.cols, src, j);
  if (x && !WORDCH.test(src[x.end] || '')) {
    const m = x.m;
    return { t: 'REF', kind: 'cols', c1: colIndex(m[2]), c2: colIndex(m[4]), ac1: !!m[1], ac2: !!m[3], end: x.end };
  }
  x = at(RE.rows, src, j);
  if (x && !WORDCH.test(src[x.end] || '')) {
    const m = x.m;
    return { t: 'REF', kind: 'rows', r1: +m[2] - 1, r2: +m[4] - 1, ar1: !!m[1], ar2: !!m[3], end: x.end };
  }
  return null;
}

function quoteSheet(name) {
  return /^[A-Za-z_À-ɏ][\w.À-ɏ]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

function refText(tok) {
  const pre = tok.sheet != null ? quoteSheet(tok.sheet) + '!' : '';
  const cell = (ac, c, ar, r) => (ac ? '$' : '') + colName(c) + (ar ? '$' : '') + (r + 1);
  if (tok.kind === 'cell') return pre + cell(tok.ac1, tok.c1, tok.ar1, tok.r1);
  if (tok.kind === 'range') return pre + cell(tok.ac1, tok.c1, tok.ar1, tok.r1) + ':' + cell(tok.ac2, tok.c2, tok.ar2, tok.r2);
  if (tok.kind === 'cols') return pre + (tok.ac1 ? '$' : '') + colName(tok.c1) + ':' + (tok.ac2 ? '$' : '') + colName(tok.c2);
  return pre + (tok.ar1 ? '$' : '') + (tok.r1 + 1) + ':' + (tok.ar2 ? '$' : '') + (tok.r2 + 1);
}

// ---- Ayrıştırıcı (Pratt) ----------------------------------------------------------
const BP = { '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5 };

export function parse(src) {
  const toks = tokenize(src).filter((t) => t.t !== 'WS');
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expect = (t) => { const x = next(); if (!x || x.t !== t) throw new FErr('#NAME?'); return x; };
  let depth = 0;
  function expr(min) {
    if (++depth > 200) throw new FErr('#NUM!');
    let left = prefix();
    for (;;) {
      const t = peek();
      if (!t || t.t !== 'OP') break;
      if (t.v === '%') { next(); left = { k: 'pct', a: left }; continue; }
      const bp = BP[t.v];
      if (bp == null || bp <= min) break;
      next();
      left = { k: 'bin', op: t.v, a: left, b: expr(bp) };
    }
    depth--;
    return left;
  }
  function prefix() {
    const t = next();
    if (!t) throw new FErr('#NAME?');
    switch (t.t) {
      case 'NUM': return { k: 'num', v: t.v };
      case 'STR': return { k: 'str', v: t.v };
      case 'BOOL': return { k: 'bool', v: t.v };
      case 'ERR': return { k: 'err', v: t.v };
      case 'REF': return { k: 'ref', tok: t };
      case 'OP':
        if (t.v === '-' || t.v === '+') return { k: 'neg', minus: t.v === '-', a: expr(6) };
        throw new FErr('#NAME?');
      case 'LP': { const e = expr(0); expect('RP'); return e; }
      case 'NAME': {
        if (peek() && peek().t === 'LP') {
          next();
          const args = [];
          if (peek() && peek().t === 'RP') { next(); return { k: 'fn', name: canonicalName(t.v), args }; }
          for (;;) {
            const q = peek();
            if (q && (q.t === 'SEP' || q.t === 'RP')) args.push({ k: 'missing' });
            else args.push(expr(0));
            const s = next();
            if (!s) throw new FErr('#NAME?');
            if (s.t === 'RP') break;
            if (s.t !== 'SEP') throw new FErr('#NAME?');
          }
          return { k: 'fn', name: canonicalName(t.v), args };
        }
        return { k: 'name', v: t.v };
      }
      default: throw new FErr('#NAME?');
    }
  }
  const ast = expr(0);
  if (p < toks.length) throw new FErr('#NAME?');
  return ast;
}

const astCache = new Map();
function cachedParse(f) {
  let a = astCache.get(f);
  if (!a) {
    try { a = parse(f); } catch (e) { a = { k: 'err', v: e instanceof FErr ? e : ERR.NAME }; }
    if (astCache.size > 20000) astCache.clear();
    astCache.set(f, a);
  }
  return a;
}

// ---- Formül metni dönüşümleri ---------------------------------------------------------
function rebuild(f, mapTok) {
  let toks;
  try { toks = tokenize(f); } catch { return f; }
  return toks.map((t, i) => mapTok(t, toks, i) ?? t.s).join('');
}

// Türkçe adları İngilizceye çevirir, ";" -> "," ve Türkçe ondalık virgülü noktaya çevirir.
export function normalizeFormula(f) {
  let src = f;
  if (/;/.test(src.replace(/"(?:[^"]|"")*"/g, ''))) {
    src = src.replace(/("(?:[^"]|"")*")|(\d),(\d)/g, (m, str, a, b) => (str ? str : `${a}.${b}`));
  }
  return rebuild(src, (t, toks, i) => {
    if (t.t === 'SEP') return ',';
    if (t.t === 'BOOL') return t.v ? 'TRUE' : 'FALSE';
    if (t.t === 'NAME') {
      const nx = toks.slice(i + 1).find((x) => x.t !== 'WS');
      if (nx && nx.t === 'LP') return canonicalName(t.v);
    }
    return null;
  });
}

// Kopyala/yapıştır ve doldurma: göreli başvuruları kaydırır.
export function shiftFormula(f, dr, dc) {
  return rebuild(f, (t) => {
    if (t.t !== 'REF') return null;
    const n = { ...t };
    const mv = (abs, v, d, max) => (abs ? v : v + d);
    if ('r1' in n) n.r1 = mv(t.ar1, t.r1, dr);
    if ('r2' in n) n.r2 = mv(t.ar2, t.r2, dr);
    if ('c1' in n) n.c1 = mv(t.ac1, t.c1, dc);
    if ('c2' in n) n.c2 = mv(t.ac2, t.c2, dc);
    for (const k of ['r1', 'r2']) if (k in n && (n[k] < 0 || n[k] >= MAX_ROWS)) return '#REF!';
    for (const k of ['c1', 'c2']) if (k in n && (n[k] < 0 || n[k] >= MAX_COLS)) return '#REF!';
    return refText(n);
  });
}

// Satır/sütun ekleme-silme sonrası başvuruları günceller.
// axis: 'row' | 'col', at: indeks, count: >0 ekleme, <0 silme.
export function adjustFormula(f, { sameSheet, sheetName, axis, at: idx, count }) {
  return rebuild(f, (t) => {
    if (t.t !== 'REF') return null;
    const targets = t.sheet == null ? sameSheet : t.sheet.toLowerCase() === sheetName.toLowerCase();
    if (!targets) return null;
    const a = axis === 'row' ? ['r1', 'r2'] : ['c1', 'c2'];
    if (!(a[0] in t)) return null;
    const n = { ...t };
    if (count > 0) {
      for (const k of a) if (k in n && n[k] >= idx) n[k] += count;
    } else {
      const del = -count, end = idx + del;
      if (n.kind === 'cell') {
        const v = n[a[0]];
        if (v >= idx && v < end) return '#REF!';
        if (v >= end) n[a[0]] = v - del;
      } else {
        let lo = n[a[0]], hi = n[a[1]];
        const nlo = lo < idx ? lo : lo >= end ? lo - del : idx;
        const nhi = hi < idx ? hi : hi >= end ? hi - del : idx - 1;
        if (nhi < nlo) return '#REF!';
        n[a[0]] = nlo; n[a[1]] = nhi;
      }
    }
    return refText(n);
  });
}

export function renameSheetInFormula(f, oldName, newName) {
  return rebuild(f, (t) => {
    if (t.t !== 'REF' || t.sheet == null || t.sheet.toLowerCase() !== oldName.toLowerCase()) return null;
    return refText({ ...t, sheet: newName });
  });
}

// Formül düzenlerken başvuruları renklendirmek/eklemek için
export function refsInFormula(f) {
  try { return tokenize(f).filter((t) => t.t === 'REF'); } catch { return []; }
}

// ---- Değer dönüşümleri ---------------------------------------------------------------
export function parseNumberText(s) {
  s = String(s).trim().replace(/ /g, '');
  if (!s) return null;
  if (/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) return +s;
  if (/^[+-]?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) return +s.replace(/\./g, '').replace(',', '.');
  if (/^[+-]?\d+,\d+$/.test(s)) return +s.replace(',', '.');
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return +s.replace(/,/g, '');
  return null;
}

export function numToText(n) {
  if (!isFinite(n)) return '#NUM!';
  if (Number.isInteger(n)) return String(n);
  return String(parseFloat(n.toPrecision(15))).replace('.', ',');
}

function toNum(v) {
  if (typeof v === 'number') return v;
  if (v == null) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof FErr) throw v;
  if (v instanceof Rng) throw ERR.VALUE;
  const n = parseNumberText(v);
  if (n == null) {
    const d = parseDateText(v);
    if (d != null) return d;
    throw ERR.VALUE;
  }
  return n;
}
function toStr(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return numToText(v);
  if (typeof v === 'boolean') return v ? 'DOĞRU' : 'YANLIŞ';
  if (v instanceof FErr) throw v;
  throw ERR.VALUE;
}
function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (v == null) return false;
  if (v instanceof FErr) throw v;
  const s = String(v).toLocaleUpperCase('tr');
  if (s === 'TRUE' || s === 'DOĞRU') return true;
  if (s === 'FALSE' || s === 'YANLIŞ') return false;
  throw ERR.VALUE;
}

// ---- Tarih yardımcıları (Excel seri sayısı) -----------------------------------------
const EPOCH = Date.UTC(1899, 11, 30);
export function dateToSerial(y, m, d) { return (Date.UTC(y, m - 1, d) - EPOCH) / 86400000; }
export function serialToDate(s) {
  const dt = new Date(EPOCH + Math.floor(s) * 86400000);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), wd: dt.getUTCDay() };
}
export function nowSerial() {
  const n = new Date();
  return dateToSerial(n.getFullYear(), n.getMonth() + 1, n.getDate()) + (n.getHours() * 3600 + n.getMinutes() * 60 + n.getSeconds()) / 86400;
}
export function parseDateText(s) {
  s = String(s).trim();
  let m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  let y, mo, d, hh = 0, mi = 0, ss = 0;
  if (m) { d = +m[1]; mo = +m[2]; y = +m[3]; hh = +(m[4] || 0); mi = +(m[5] || 0); ss = +(m[6] || 0); }
  else if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s))) {
    y = +m[1]; mo = +m[2]; d = +m[3]; hh = +(m[4] || 0); mi = +(m[5] || 0); ss = +(m[6] || 0);
  } else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59 || ss > 59) return null;
  return dateToSerial(y, mo, d) + (hh * 3600 + mi * 60 + ss) / 86400;
}
export function parseTimeText(s) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(s).trim());
  if (!m || +m[1] > 23 || +m[2] > 59 || +(m[3] || 0) > 59) return null;
  return (+m[1] * 3600 + +m[2] * 60 + +(m[3] || 0)) / 86400;
}

// ---- Karşılaştırma ve ölçütler --------------------------------------------------------
const rank = (v) => (typeof v === 'number' ? 1 : typeof v === 'string' ? 2 : typeof v === 'boolean' ? 3 : 0);
export function compare(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0;
  if (b == null) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0;
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (typeof a === 'string') return a.localeCompare(b, 'tr', { sensitivity: 'accent' });
  if (typeof a === 'boolean') return a === b ? 0 : a ? 1 : -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function wildcardRe(pat) {
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i];
    if (ch === '~' && i + 1 < pat.length) { re += pat[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
    if (ch === '*') re += '[\\s\\S]*';
    else if (ch === '?') re += '[\\s\\S]';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}

export function makeCriteria(crit) {
  if (crit instanceof FErr) throw crit;
  if (typeof crit === 'number' || typeof crit === 'boolean') return (v) => v === crit || (typeof v === 'string' && parseNumberText(v) === crit);
  if (crit == null) return (v) => v == null || v === '';
  const m = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(String(crit));
  const op = m[1] || '=';
  const rhs = m[2];
  const rnum = parseNumberText(rhs) ?? parseDateText(rhs);
  if (op === '=' || op === '<>') {
    let test;
    if (rhs === '') test = (v) => v == null || v === '';
    else if (rnum != null) test = (v) => v === rnum || (typeof v === 'string' && parseNumberText(v) === rnum);
    else if (/[*?~]/.test(rhs)) { const re = wildcardRe(rhs); test = (v) => typeof v === 'string' && re.test(v); }
    else { const up = rhs.toLocaleLowerCase('tr'); test = (v) => (typeof v === 'string' && v.toLocaleLowerCase('tr') === up) || (typeof v === 'boolean' && toStr(v).toLocaleLowerCase('tr') === up); }
    return op === '=' ? test : (v) => !test(v);
  }
  const cmp = { '<': (c) => c < 0, '>': (c) => c > 0, '<=': (c) => c <= 0, '>=': (c) => c >= 0 }[op];
  if (rnum != null) return (v) => typeof v === 'number' && cmp(compare(v, rnum));
  return (v) => typeof v === 'string' && cmp(compare(v, rhs));
}

// ---- Değerlendirici ------------------------------------------------------------------
// ctx: { wb, si, r, c }  wb: { value(si,r,c), sheetIndex(name), matrix(rng), bounds(si) }
// Adlandırılmış aralık metnini ("Sayfa1!$A$1:$B$4") başvuru belirtecine çevirir.
export function parseRefText(text) {
  try {
    const t = tokenize(String(text).replace(/^=/, '')).filter((x) => x.t !== 'WS');
    return t.length === 1 && t[0].t === 'REF' ? t[0] : null;
  } catch { return null; }
}
export function refToRange(tok, ctx) { return resolveRef(tok, ctx); }

function resolveRef(tok, ctx) {
  const si = tok.sheet == null ? ctx.si : ctx.wb.sheetIndex(tok.sheet);
  if (si < 0) throw ERR.REF;
  switch (tok.kind) {
    case 'cell': return new Rng(si, tok.r1, tok.c1, tok.r1, tok.c1);
    case 'range': return new Rng(si, tok.r1, tok.c1, tok.r2, tok.c2);
    case 'cols': return new Rng(si, 0, tok.c1, MAX_ROWS - 1, tok.c2);
    default: return new Rng(si, tok.r1, 0, tok.r2, MAX_COLS - 1);
  }
}

function scalar(v, ctx) {
  if (v instanceof Rng) {
    if (v.rows === 1 && v.cols === 1) return ctx.wb.value(v.si, v.r1, v.c1);
    // Örtük kesişim (implicit intersection)
    if (v.cols === 1 && ctx.r >= v.r1 && ctx.r <= v.r2) return ctx.wb.value(v.si, ctx.r, v.c1);
    if (v.rows === 1 && ctx.c >= v.c1 && ctx.c <= v.c2) return ctx.wb.value(v.si, v.r1, ctx.c);
    throw ERR.VALUE;
  }
  return v;
}

function ev(node, ctx) {
  switch (node.k) {
    case 'num': case 'str': case 'bool': return node.v;
    case 'err': throw node.v;
    case 'missing': return null;
    case 'ref': return resolveRef(node.tok, ctx);
    case 'name': {
      const r = ctx.wb.resolveName ? ctx.wb.resolveName(node.v) : null;
      if (r) return r;
      throw ERR.NAME;
    }
    case 'neg': { const v = toNum(scalar(ev(node.a, ctx), ctx)); return node.minus ? -v : v; }
    case 'pct': return toNum(scalar(ev(node.a, ctx), ctx)) / 100;
    case 'bin': {
      const a = scalar(ev(node.a, ctx), ctx);
      const b = scalar(ev(node.b, ctx), ctx);
      if (a instanceof FErr) throw a;
      if (b instanceof FErr) throw b;
      switch (node.op) {
        case '+': return toNum(a) + toNum(b);
        case '-': return toNum(a) - toNum(b);
        case '*': return toNum(a) * toNum(b);
        case '/': { const d = toNum(b); if (d === 0) throw ERR.DIV0; return toNum(a) / d; }
        case '^': { const r = Math.pow(toNum(a), toNum(b)); if (!isFinite(r) || isNaN(r)) throw ERR.NUM; return r; }
        case '&': return toStr(a) + toStr(b);
        case '=': return compare(a, b) === 0;
        case '<>': return compare(a, b) !== 0;
        case '<': return compare(a, b) < 0;
        case '>': return compare(a, b) > 0;
        case '<=': return compare(a, b) <= 0;
        case '>=': return compare(a, b) >= 0;
        default: throw ERR.VALUE;
      }
    }
    case 'fn': {
      const def = FN[node.name];
      if (!def) throw ERR.NAME;
      if (def.lazy) return def.fn(node.args, ctx);
      const args = node.args.map((a) => ev(a, ctx));
      return def.fn(args, ctx);
    }
    default: throw ERR.VALUE;
  }
}

export function evaluateFormula(f, ctx) {
  const ast = cachedParse(f);
  try {
    const v = ev(ast, ctx);
    const s = scalar(v, ctx);
    if (typeof s === 'number' && !isFinite(s)) return ERR.NUM;
    return s;
  } catch (e) {
    if (e instanceof FErr) return e;
    if (e instanceof RangeError) return ERR.NUM; // çok derin özyineleme
    throw e;
  }
}

export function isValidFormula(f) {
  try { parse(f); return true; } catch { return false; }
}

// ---- Fonksiyon yardımcıları -----------------------------------------------------------
function* vals(arg, ctx) {
  if (arg instanceof Rng) {
    for (const row of ctx.wb.matrix(arg)) for (const v of row) yield { v, ref: true };
  } else yield { v: arg, ref: false };
}

function nums(args, ctx) {
  const out = [];
  for (const a of args) {
    for (const { v, ref } of vals(a, ctx)) {
      if (v instanceof FErr) throw v;
      if (ref) { if (typeof v === 'number') out.push(v); }
      else if (v != null) out.push(toNum(v));
    }
  }
  return out;
}

const matrixOf = (a, ctx) => (a instanceof Rng ? ctx.wb.matrix(a, true) : [[a]]);
const arg = (args, i, ctx, def) => (args[i] === undefined || args[i] === null ? def : scalar(args[i], ctx));
const numArg = (args, i, ctx, def) => { const v = arg(args, i, ctx, def); if (v === undefined) throw ERR.VALUE; return toNum(v); };
const strArg = (args, i, ctx, def) => { const v = arg(args, i, ctx, def); if (v === undefined) throw ERR.VALUE; return toStr(v); };
const need = (args, min, max = min) => { if (args.length < min || args.length > max) throw ERR.VALUE; };

function round(n, d) {
  const f = Math.pow(10, d);
  const x = Math.abs(n) * f;
  const r = Math.round(x + 1e-9 * Math.max(1, x));
  return Math.sign(n) * r / f;
}

function lookupExact(list, key) {
  if (typeof key === 'string' && /[*?~]/.test(key)) {
    const re = wildcardRe(key);
    return list.findIndex((v) => typeof v === 'string' && re.test(v));
  }
  return list.findIndex((v) => v != null && compare(v, key) === 0 && rank(v) === rank(key));
}
function lookupApprox(list, key) {
  let best = -1;
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (v == null || rank(v) !== rank(key)) continue;
    if (compare(v, key) <= 0) best = i; else break;
  }
  return best;
}

function ifsCollect(args, ctx, start) {
  const pairs = [];
  for (let i = start; i + 1 < args.length; i += 2) {
    if (!(args[i] instanceof Rng)) throw ERR.VALUE;
    pairs.push({ m: ctx.wb.matrix(args[i], true), test: makeCriteria(scalar(args[i + 1], ctx)) });
  }
  return pairs;
}
function ifsMatch(pairs, r, c) {
  return pairs.every((p) => p.test(p.m[r] ? p.m[r][c] : null));
}

const sum = (a) => a.reduce((x, y) => x + y, 0);
const mean = (a) => { if (!a.length) throw ERR.DIV0; return sum(a) / a.length; };
const variance = (a, sample) => {
  if (a.length < (sample ? 2 : 1)) throw ERR.DIV0;
  const m = sum(a) / a.length;
  return sum(a.map((x) => (x - m) ** 2)) / (a.length - (sample ? 1 : 0));
};

// ---- Fonksiyonlar --------------------------------------------------------------------
const FN = {};
const def = (name, fn, lazy = false) => { FN[name] = { fn, lazy }; };

// Matematik
def('SUM', (a, c) => sum(nums(a, c)));
def('AVERAGE', (a, c) => mean(nums(a, c)));
def('MIN', (a, c) => { const n = nums(a, c); return n.length ? Math.min(...n) : 0; });
def('MAX', (a, c) => { const n = nums(a, c); return n.length ? Math.max(...n) : 0; });
def('PRODUCT', (a, c) => { const n = nums(a, c); return n.length ? n.reduce((x, y) => x * y, 1) : 0; });
def('COUNT', (a, c) => { let k = 0; for (const x of a) for (const { v, ref } of vals(x, c)) { if (typeof v === 'number' || (!ref && v != null && parseNumberText(v) != null)) k++; } return k; });
def('COUNTA', (a, c) => { let k = 0; for (const x of a) for (const { v } of vals(x, c)) if (v != null && v !== '') k++; return k; });
def('COUNTBLANK', (a, c) => { need(a, 1); if (!(a[0] instanceof Rng)) throw ERR.VALUE; const r = a[0]; let k = 0; const m = c.wb.matrix(r, true); for (const row of m) for (const v of row) if (v == null || v === '') k++; return k; });
def('ROUND', (a, c) => { need(a, 1, 2); return round(numArg(a, 0, c), numArg(a, 1, c, 0)); });
def('ROUNDUP', (a, c) => { need(a, 1, 2); const n = numArg(a, 0, c), f = 10 ** numArg(a, 1, c, 0); return Math.sign(n) * Math.ceil(Math.abs(n) * f - 1e-9) / f; });
def('ROUNDDOWN', (a, c) => { need(a, 1, 2); const n = numArg(a, 0, c), f = 10 ** numArg(a, 1, c, 0); return Math.sign(n) * Math.floor(Math.abs(n) * f + 1e-9) / f; });
def('TRUNC', (a, c) => { need(a, 1, 2); const n = numArg(a, 0, c), f = 10 ** numArg(a, 1, c, 0); return Math.trunc(n * f) / f; });
def('INT', (a, c) => { need(a, 1); return Math.floor(numArg(a, 0, c)); });
def('ABS', (a, c) => { need(a, 1); return Math.abs(numArg(a, 0, c)); });
def('SIGN', (a, c) => { need(a, 1); return Math.sign(numArg(a, 0, c)); });
def('SQRT', (a, c) => { need(a, 1); const n = numArg(a, 0, c); if (n < 0) throw ERR.NUM; return Math.sqrt(n); });
def('POWER', (a, c) => { need(a, 2); return Math.pow(numArg(a, 0, c), numArg(a, 1, c)); });
def('EXP', (a, c) => { need(a, 1); return Math.exp(numArg(a, 0, c)); });
def('LN', (a, c) => { need(a, 1); const n = numArg(a, 0, c); if (n <= 0) throw ERR.NUM; return Math.log(n); });
def('LOG10', (a, c) => { need(a, 1); const n = numArg(a, 0, c); if (n <= 0) throw ERR.NUM; return Math.log10(n); });
def('LOG', (a, c) => { need(a, 1, 2); const n = numArg(a, 0, c), b = numArg(a, 1, c, 10); if (n <= 0 || b <= 0 || b === 1) throw ERR.NUM; return Math.log(n) / Math.log(b); });
def('MOD', (a, c) => { need(a, 2); const n = numArg(a, 0, c), d = numArg(a, 1, c); if (d === 0) throw ERR.DIV0; return n - d * Math.floor(n / d); });
def('PI', () => Math.PI);
def('RAND', () => Math.random());
def('RANDBETWEEN', (a, c) => { need(a, 2); const lo = Math.ceil(numArg(a, 0, c)), hi = Math.floor(numArg(a, 1, c)); if (hi < lo) throw ERR.NUM; return lo + Math.floor(Math.random() * (hi - lo + 1)); });
def('CEILING', (a, c) => { need(a, 1, 2); const n = numArg(a, 0, c), s = numArg(a, 1, c, 1); if (s === 0) return 0; return Math.ceil(n / s - 1e-12) * s; });
def('FLOOR', (a, c) => { need(a, 1, 2); const n = numArg(a, 0, c), s = numArg(a, 1, c, 1); if (s === 0) throw ERR.DIV0; return Math.floor(n / s + 1e-12) * s; });
def('EVEN', (a, c) => { const n = numArg(a, 0, c); const r = Math.ceil(Math.abs(n) / 2) * 2; return n < 0 ? -r : r; });
def('ODD', (a, c) => { const n = numArg(a, 0, c); let r = Math.ceil(Math.abs(n)); if (r % 2 === 0) r += 1; return n < 0 ? -r : r; });
def('SUMPRODUCT', (a, c) => {
  const ms = a.map((x) => matrixOf(x, c));
  const R = ms[0].length, C = ms[0][0] ? ms[0][0].length : 0;
  if (ms.some((m) => m.length !== R || (m[0] || []).length !== C)) throw ERR.VALUE;
  let s = 0;
  for (let i = 0; i < R; i++) for (let j = 0; j < C; j++) {
    let p = 1;
    for (const m of ms) { const v = m[i][j]; if (v instanceof FErr) throw v; p *= typeof v === 'number' ? v : 0; }
    s += p;
  }
  return s;
});
def('SUMSQ', (a, c) => sum(nums(a, c).map((x) => x * x)));
def('MEDIAN', (a, c) => { const n = nums(a, c).sort((x, y) => x - y); if (!n.length) throw ERR.NUM; const m = n.length >> 1; return n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2; });
def('MODE', (a, c) => { const n = nums(a, c); const cnt = new Map(); let best = null, bc = 1; for (const x of n) { const k = (cnt.get(x) || 0) + 1; cnt.set(x, k); if (k > bc) { bc = k; best = x; } } if (best == null) throw ERR.NA; return best; });
def('STDEV', (a, c) => Math.sqrt(variance(nums(a, c), true)));
def('STDEV.S', (a, c) => Math.sqrt(variance(nums(a, c), true)));
def('STDEVP', (a, c) => Math.sqrt(variance(nums(a, c), false)));
def('STDEV.P', (a, c) => Math.sqrt(variance(nums(a, c), false)));
def('VAR', (a, c) => variance(nums(a, c), true));
def('VAR.S', (a, c) => variance(nums(a, c), true));
def('VARP', (a, c) => variance(nums(a, c), false));
def('LARGE', (a, c) => { need(a, 2); const n = nums([a[0]], c).sort((x, y) => y - x); const k = numArg(a, 1, c); if (k < 1 || k > n.length) throw ERR.NUM; return n[Math.ceil(k) - 1]; });
def('SMALL', (a, c) => { need(a, 2); const n = nums([a[0]], c).sort((x, y) => x - y); const k = numArg(a, 1, c); if (k < 1 || k > n.length) throw ERR.NUM; return n[Math.ceil(k) - 1]; });
def('RANK', (a, c) => { need(a, 2, 3); const x = numArg(a, 0, c); const n = nums([a[1]], c); const asc = numArg(a, 2, c, 0) !== 0; if (!n.includes(x)) throw ERR.NA; return 1 + n.filter((v) => (asc ? v < x : v > x)).length; });
FN['RANK.EQ'] = FN.RANK;

// Koşullu toplamalar
def('SUMIF', (a, c) => {
  need(a, 2, 3);
  if (!(a[0] instanceof Rng)) throw ERR.VALUE;
  const test = makeCriteria(scalar(a[1], c));
  const crit = c.wb.matrix(a[0], true);
  const sumR = a[2] instanceof Rng ? c.wb.matrix(new Rng(a[2].si, a[2].r1, a[2].c1, a[2].r1 + a[0].rows - 1, a[2].c1 + a[0].cols - 1), true) : crit;
  let s = 0;
  crit.forEach((row, i) => row.forEach((v, j) => { if (test(v)) { const x = sumR[i] && sumR[i][j]; if (typeof x === 'number') s += x; } }));
  return s;
});
def('AVERAGEIF', (a, c) => {
  need(a, 2, 3);
  if (!(a[0] instanceof Rng)) throw ERR.VALUE;
  const test = makeCriteria(scalar(a[1], c));
  const crit = c.wb.matrix(a[0], true);
  const sumR = a[2] instanceof Rng ? c.wb.matrix(new Rng(a[2].si, a[2].r1, a[2].c1, a[2].r1 + a[0].rows - 1, a[2].c1 + a[0].cols - 1), true) : crit;
  const n = [];
  crit.forEach((row, i) => row.forEach((v, j) => { if (test(v)) { const x = sumR[i] && sumR[i][j]; if (typeof x === 'number') n.push(x); } }));
  return mean(n);
});
def('COUNTIF', (a, c) => {
  need(a, 2);
  if (!(a[0] instanceof Rng)) throw ERR.VALUE;
  const test = makeCriteria(scalar(a[1], c));
  let k = 0;
  for (const row of c.wb.matrix(a[0], true)) for (const v of row) if (test(v)) k++;
  return k;
});
function ifsAgg(a, c, start, valuesRng, onMatch) {
  const pairs = ifsCollect(a, c, start);
  const ref = valuesRng || (a[start] instanceof Rng ? a[start] : null);
  if (!ref) throw ERR.VALUE;
  const vm = valuesRng ? c.wb.matrix(valuesRng, true) : null;
  for (let i = 0; i < ref.rows; i++) for (let j = 0; j < ref.cols; j++) {
    if (ifsMatch(pairs, i, j)) onMatch(vm ? (vm[i] ? vm[i][j] : null) : null);
  }
}
def('SUMIFS', (a, c) => { if (!(a[0] instanceof Rng)) throw ERR.VALUE; let s = 0; ifsAgg(a, c, 1, a[0], (v) => { if (typeof v === 'number') s += v; }); return s; });
def('AVERAGEIFS', (a, c) => { if (!(a[0] instanceof Rng)) throw ERR.VALUE; const n = []; ifsAgg(a, c, 1, a[0], (v) => { if (typeof v === 'number') n.push(v); }); return mean(n); });
def('MAXIFS', (a, c) => { if (!(a[0] instanceof Rng)) throw ERR.VALUE; const n = []; ifsAgg(a, c, 1, a[0], (v) => { if (typeof v === 'number') n.push(v); }); return n.length ? Math.max(...n) : 0; });
def('MINIFS', (a, c) => { if (!(a[0] instanceof Rng)) throw ERR.VALUE; const n = []; ifsAgg(a, c, 1, a[0], (v) => { if (typeof v === 'number') n.push(v); }); return n.length ? Math.min(...n) : 0; });
def('COUNTIFS', (a, c) => { let k = 0; ifsAgg(a, c, 0, null, () => { k++; }); return k; });

// Mantıksal
def('IF', (args, c) => {
  if (args.length < 1 || args.length > 3) throw ERR.VALUE;
  const cond = toBool(scalar(ev(args[0], c), c));
  if (cond) return args.length > 1 ? (args[1].k === 'missing' ? 0 : ev(args[1], c)) : true;
  return args.length > 2 ? (args[2].k === 'missing' ? 0 : ev(args[2], c)) : false;
}, true);
def('IFS', (args, c) => {
  for (let i = 0; i + 1 < args.length; i += 2) if (toBool(scalar(ev(args[i], c), c))) return ev(args[i + 1], c);
  throw ERR.NA;
}, true);
def('IFERROR', (args, c) => {
  need(args, 2);
  try { const v = scalar(ev(args[0], c), c); if (v instanceof FErr) throw v; return v; } catch (e) { if (e instanceof FErr) return ev(args[1], c); throw e; }
}, true);
def('IFNA', (args, c) => {
  need(args, 2);
  try { return scalar(ev(args[0], c), c); } catch (e) { if (e === ERR.NA) return ev(args[1], c); throw e; }
}, true);
def('SWITCH', (args, c) => {
  if (args.length < 3) throw ERR.VALUE;
  const v = scalar(ev(args[0], c), c);
  let i = 1;
  for (; i + 1 < args.length; i += 2) if (compare(v, scalar(ev(args[i], c), c)) === 0) return ev(args[i + 1], c);
  if (i < args.length) return ev(args[i], c);
  throw ERR.NA;
}, true);
const boolsOf = (a, c) => { const out = []; for (const x of a) for (const { v, ref } of vals(x, c)) { if (v instanceof FErr) throw v; if (ref && (v == null || typeof v === 'string')) continue; out.push(toBool(v)); } if (!out.length) throw ERR.VALUE; return out; };
def('AND', (a, c) => boolsOf(a, c).every(Boolean));
def('OR', (a, c) => boolsOf(a, c).some(Boolean));
def('XOR', (a, c) => boolsOf(a, c).filter(Boolean).length % 2 === 1);
def('NOT', (a, c) => { need(a, 1); return !toBool(arg(a, 0, c)); });
def('TRUE', () => true);
def('FALSE', () => false);

// Arama / başvuru
def('VLOOKUP', (a, c) => {
  need(a, 3, 4);
  const key = arg(a, 0, c);
  const m = matrixOf(a[1], c);
  const col = Math.floor(numArg(a, 2, c));
  const approx = a.length > 3 ? toBool(arg(a, 3, c, true)) : true;
  if (col < 1 || (m[0] && col > m[0].length)) throw ERR.REF;
  const first = m.map((row) => row[0]);
  const i = approx ? lookupApprox(first, key) : lookupExact(first, key);
  if (i < 0) throw ERR.NA;
  return m[i][col - 1];
});
def('HLOOKUP', (a, c) => {
  need(a, 3, 4);
  const key = arg(a, 0, c);
  const m = matrixOf(a[1], c);
  const row = Math.floor(numArg(a, 2, c));
  const approx = a.length > 3 ? toBool(arg(a, 3, c, true)) : true;
  if (row < 1 || row > m.length) throw ERR.REF;
  const first = m[0] || [];
  const i = approx ? lookupApprox(first, key) : lookupExact(first, key);
  if (i < 0) throw ERR.NA;
  return m[row - 1][i];
});
def('MATCH', (a, c) => {
  need(a, 2, 3);
  const key = arg(a, 0, c);
  const m = matrixOf(a[1], c);
  const list = m.length === 1 ? m[0] : m.map((r) => r[0]);
  const type = numArg(a, 2, c, 1);
  let i;
  if (type === 0) i = lookupExact(list, key);
  else if (type > 0) i = lookupApprox(list, key);
  else { i = -1; for (let k = 0; k < list.length; k++) { if (list[k] != null && compare(list[k], key) >= 0) i = k; else break; } }
  if (i < 0) throw ERR.NA;
  return i + 1;
});
def('INDEX', (a, c) => {
  need(a, 2, 3);
  const m = matrixOf(a[0], c);
  let r = Math.floor(numArg(a, 1, c, 0)), col = Math.floor(numArg(a, 2, c, 0));
  if (m.length === 1 && a.length === 2) { col = r; r = 1; }
  if (r < 0 || col < 0 || r > m.length || (m[0] && col > m[0].length)) throw ERR.REF;
  return m[Math.max(1, r) - 1][Math.max(1, col) - 1];
});
def('XLOOKUP', (a, c) => {
  need(a, 3, 5);
  const key = arg(a, 0, c);
  const lm = matrixOf(a[1], c);
  const rm = matrixOf(a[2], c);
  const vertical = lm.length > 1 || (lm[0] || []).length === 1;
  const list = vertical ? lm.map((r) => r[0]) : lm[0];
  const i = lookupExact(list, key);
  if (i < 0) { if (a.length > 3 && a[3] != null) return scalar(a[3], c); throw ERR.NA; }
  return vertical ? (rm[i] || [])[0] : (rm[0] || [])[i];
});
def('CHOOSE', (args, c) => {
  if (args.length < 2) throw ERR.VALUE;
  const i = Math.floor(toNum(scalar(ev(args[0], c), c)));
  if (i < 1 || i >= args.length) throw ERR.VALUE;
  return ev(args[i], c);
}, true);
def('ROW', (a, c) => (a.length && a[0] instanceof Rng ? a[0].r1 + 1 : c.r + 1));
def('COLUMN', (a, c) => (a.length && a[0] instanceof Rng ? a[0].c1 + 1 : c.c + 1));
def('ROWS', (a) => { if (!(a[0] instanceof Rng)) return 1; return a[0].rows; });
def('COLUMNS', (a) => { if (!(a[0] instanceof Rng)) return 1; return a[0].cols; });

// Metin
def('LEN', (a, c) => { need(a, 1); return strArg(a, 0, c).length; });
def('LEFT', (a, c) => { need(a, 1, 2); const n = numArg(a, 1, c, 1); if (n < 0) throw ERR.VALUE; return strArg(a, 0, c).slice(0, n); });
def('RIGHT', (a, c) => { need(a, 1, 2); const s = strArg(a, 0, c); const n = numArg(a, 1, c, 1); if (n < 0) throw ERR.VALUE; return n === 0 ? '' : s.slice(-n); });
def('MID', (a, c) => { need(a, 3); const st = numArg(a, 1, c), n = numArg(a, 2, c); if (st < 1 || n < 0) throw ERR.VALUE; return strArg(a, 0, c).substr(st - 1, n); });
def('UPPER', (a, c) => { need(a, 1); return strArg(a, 0, c).toLocaleUpperCase('tr'); });
def('LOWER', (a, c) => { need(a, 1); return strArg(a, 0, c).toLocaleLowerCase('tr'); });
def('PROPER', (a, c) => { need(a, 1); return strArg(a, 0, c).toLocaleLowerCase('tr').replace(/(^|[^\p{L}])(\p{L})/gu, (m, p, l) => p + l.toLocaleUpperCase('tr')); });
def('TRIM', (a, c) => { need(a, 1); return strArg(a, 0, c).replace(/ +/g, ' ').trim(); });
def('CONCATENATE', (a, c) => a.map((x) => toStr(scalar(x, c))).join(''));
def('CONCAT', (a, c) => { let s = ''; for (const x of a) for (const { v } of vals(x, c)) s += toStr(v); return s; });
def('TEXTJOIN', (a, c) => {
  if (a.length < 3) throw ERR.VALUE;
  const sep = strArg(a, 0, c), skip = toBool(arg(a, 1, c));
  const parts = [];
  for (const x of a.slice(2)) for (const { v } of vals(x, c)) { const s = toStr(v); if (!(skip && s === '')) parts.push(s); }
  return parts.join(sep);
});
def('SUBSTITUTE', (a, c) => {
  need(a, 3, 4);
  const s = strArg(a, 0, c), old = strArg(a, 1, c), neu = strArg(a, 2, c);
  if (!old) return s;
  if (a.length < 4) return s.split(old).join(neu);
  const n = numArg(a, 3, c);
  let idx = -1;
  for (let k = 0; k < n; k++) { idx = s.indexOf(old, idx + 1); if (idx < 0) return s; }
  return s.slice(0, idx) + neu + s.slice(idx + old.length);
});
def('REPLACE', (a, c) => { need(a, 4); const s = strArg(a, 0, c), st = numArg(a, 1, c), n = numArg(a, 2, c); return s.slice(0, st - 1) + strArg(a, 3, c) + s.slice(st - 1 + n); });
def('FIND', (a, c) => { need(a, 2, 3); const i = strArg(a, 1, c).indexOf(strArg(a, 0, c), numArg(a, 2, c, 1) - 1); if (i < 0) throw ERR.VALUE; return i + 1; });
def('SEARCH', (a, c) => {
  need(a, 2, 3);
  const re = wildcardRe(strArg(a, 0, c));
  const hay = strArg(a, 1, c);
  for (let i = numArg(a, 2, c, 1) - 1; i < hay.length; i++) {
    for (let j = i; j <= hay.length; j++) if (re.test(hay.slice(i, j))) return i + 1;
  }
  throw ERR.VALUE;
});
def('REPT', (a, c) => { need(a, 2); const n = numArg(a, 1, c); if (n < 0 || n > 32767) throw ERR.VALUE; const s = strArg(a, 0, c); if (s.length * n > 32767) throw ERR.VALUE; return s.repeat(n); });
def('EXACT', (a, c) => { need(a, 2); return strArg(a, 0, c) === strArg(a, 1, c); });
def('CHAR', (a, c) => { need(a, 1); const n = numArg(a, 0, c); if (n < 1 || n > 255) throw ERR.VALUE; return new TextDecoder('windows-1254').decode(new Uint8Array([n])); });
def('CODE', (a, c) => { need(a, 1); const s = strArg(a, 0, c); if (!s) throw ERR.VALUE; return s.charCodeAt(0); });
def('VALUE', (a, c) => { need(a, 1); const v = arg(a, 0, c); if (typeof v === 'number') return v; return toNum(String(v ?? '')); });
def('N', (a, c) => { const v = arg(a, 0, c); return typeof v === 'number' ? v : typeof v === 'boolean' ? +v : 0; });
def('T', (a, c) => { const v = arg(a, 0, c); return typeof v === 'string' ? v : ''; });
def('TEXT', (a, c) => {
  need(a, 2);
  const v = arg(a, 0, c);
  const fmt = strArg(a, 1, c);
  const n = typeof v === 'number' ? v : parseNumberText(v);
  if (n == null) return toStr(v);
  return formatNumber(n, fmt);
});

// Tarih
def('TODAY', () => Math.floor(nowSerial()));
def('NOW', () => nowSerial());
def('DATE', (a, c) => { need(a, 3); let y = Math.floor(numArg(a, 0, c)); if (y < 1900) y += 1900; return dateToSerial(y, Math.floor(numArg(a, 1, c)), Math.floor(numArg(a, 2, c))); });
def('TIME', (a, c) => { need(a, 3); return ((numArg(a, 0, c) * 3600 + numArg(a, 1, c) * 60 + numArg(a, 2, c)) / 86400) % 1; });
def('YEAR', (a, c) => serialToDate(numArg(a, 0, c)).y);
def('MONTH', (a, c) => serialToDate(numArg(a, 0, c)).m);
def('DAY', (a, c) => serialToDate(numArg(a, 0, c)).d);
def('HOUR', (a, c) => Math.floor(((numArg(a, 0, c) % 1) * 24) + 1e-9));
def('MINUTE', (a, c) => Math.floor((((numArg(a, 0, c) % 1) * 1440) + 1e-9) % 60));
def('SECOND', (a, c) => Math.round(((numArg(a, 0, c) % 1) * 86400)) % 60);
def('WEEKDAY', (a, c) => {
  const wd = serialToDate(numArg(a, 0, c)).wd;
  const t = numArg(a, 1, c, 1);
  if (t === 2) return wd === 0 ? 7 : wd;
  if (t === 3) return wd === 0 ? 6 : wd - 1;
  return wd + 1;
});
def('EDATE', (a, c) => { const d = serialToDate(numArg(a, 0, c)); const m = d.m - 1 + Math.trunc(numArg(a, 1, c)); const y = d.y + Math.floor(m / 12); const mm = ((m % 12) + 12) % 12; const last = new Date(Date.UTC(y, mm + 1, 0)).getUTCDate(); return dateToSerial(y, mm + 1, Math.min(d.d, last)); });
def('EOMONTH', (a, c) => { const d = serialToDate(numArg(a, 0, c)); const m = d.m - 1 + Math.trunc(numArg(a, 1, c)); const y = d.y + Math.floor(m / 12); const mm = ((m % 12) + 12) % 12; return dateToSerial(y, mm + 2, 0); });
def('DAYS', (a, c) => { need(a, 2); return Math.floor(numArg(a, 0, c)) - Math.floor(numArg(a, 1, c)); });
def('DATEDIF', (a, c) => {
  need(a, 3);
  const s = numArg(a, 0, c), e = numArg(a, 1, c), unit = strArg(a, 2, c).toUpperCase();
  if (e < s) throw ERR.NUM;
  const A = serialToDate(s), B = serialToDate(e);
  let months = (B.y - A.y) * 12 + (B.m - A.m);
  if (B.d < A.d) months--;
  if (unit === 'D') return Math.floor(e) - Math.floor(s);
  if (unit === 'M') return months;
  if (unit === 'Y') return Math.floor(months / 12);
  if (unit === 'YM') return months % 12;
  if (unit === 'MD') return B.d >= A.d ? B.d - A.d : B.d + new Date(Date.UTC(B.y, B.m - 1, 0)).getUTCDate() - A.d;
  throw ERR.NUM;
});
def('NETWORKDAYS', (a, c) => {
  need(a, 2, 3);
  let s = Math.floor(numArg(a, 0, c)), e = Math.floor(numArg(a, 1, c));
  const sign = e < s ? -1 : 1;
  if (sign < 0) [s, e] = [e, s];
  const hol = a[2] ? new Set(nums([a[2]], c).map(Math.floor)) : new Set();
  let k = 0;
  for (let d = s; d <= e && k < 100000; d++) { const wd = serialToDate(d).wd; if (wd !== 0 && wd !== 6 && !hol.has(d)) k++; }
  return k * sign;
});

// Bilgi
def('ISBLANK', (a, c) => { const v = arg(a, 0, c); return v == null; });
def('ISNUMBER', (a, c) => { try { return typeof arg(a, 0, c) === 'number'; } catch (e) { if (e instanceof FErr) return false; throw e; } });
def('ISTEXT', (a, c) => { try { return typeof arg(a, 0, c) === 'string'; } catch (e) { if (e instanceof FErr) return false; throw e; } });
def('ISLOGICAL', (a, c) => { try { return typeof arg(a, 0, c) === 'boolean'; } catch (e) { if (e instanceof FErr) return false; throw e; } });
def('ISERROR', (args, c) => { try { return scalar(ev(args[0], c), c) instanceof FErr; } catch (e) { if (e instanceof FErr) return true; throw e; } }, true);
def('ISERR', (args, c) => { try { const v = scalar(ev(args[0], c), c); return v instanceof FErr && v !== ERR.NA; } catch (e) { if (e instanceof FErr) return e !== ERR.NA; throw e; } }, true);
def('ISNA', (args, c) => { try { return scalar(ev(args[0], c), c) === ERR.NA; } catch (e) { if (e instanceof FErr) return e === ERR.NA; throw e; } }, true);
def('ISEVEN', (a, c) => Math.floor(Math.abs(numArg(a, 0, c))) % 2 === 0);
def('ISODD', (a, c) => Math.floor(Math.abs(numArg(a, 0, c))) % 2 === 1);
def('NA', () => { throw ERR.NA; });

// Finans
def('PMT', (a, c) => { need(a, 3, 5); const r = numArg(a, 0, c), n = numArg(a, 1, c), pv = numArg(a, 2, c), fv = numArg(a, 3, c, 0), t = numArg(a, 4, c, 0); if (n === 0) throw ERR.NUM; if (r === 0) return -(pv + fv) / n; const f = Math.pow(1 + r, n); return -(r * (pv * f + fv)) / ((1 + r * t) * (f - 1)); });
def('FV', (a, c) => { need(a, 3, 5); const r = numArg(a, 0, c), n = numArg(a, 1, c), pmt = numArg(a, 2, c), pv = numArg(a, 3, c, 0), t = numArg(a, 4, c, 0); if (r === 0) return -(pv + pmt * n); const f = Math.pow(1 + r, n); return -(pv * f + pmt * (1 + r * t) * (f - 1) / r); });
def('PV', (a, c) => { need(a, 3, 5); const r = numArg(a, 0, c), n = numArg(a, 1, c), pmt = numArg(a, 2, c), fv = numArg(a, 3, c, 0), t = numArg(a, 4, c, 0); if (r === 0) return -(fv + pmt * n); const f = Math.pow(1 + r, n); return -(fv + pmt * (1 + r * t) * (f - 1) / r) / f; });
def('NPV', (a, c) => { const r = numArg(a, 0, c); const n = nums(a.slice(1), c); return n.reduce((s, v, i) => s + v / Math.pow(1 + r, i + 1), 0); });

// ---- Türkçe adlar ----------------------------------------------------------------------
const TR = {
  TOPLA: 'SUM', ORTALAMA: 'AVERAGE', 'MİN': 'MIN', MAK: 'MAX', 'ÇARPIM': 'PRODUCT', 'BAĞ_DEĞ_SAY': 'COUNT',
  'BAĞ_DEĞ_DOLU_SAY': 'COUNTA', 'BOŞLUKSAY': 'COUNTBLANK', YUVARLA: 'ROUND', YUKARIYUVARLA: 'ROUNDUP',
  'AŞAĞIYUVARLA': 'ROUNDDOWN', NSAT: 'TRUNC', TAMSAYI: 'INT', MUTLAK: 'ABS', 'İŞARET': 'SIGN', 'KAREKÖK': 'SQRT',
  KUVVET: 'POWER', 'ÜS': 'EXP', 'S_SAYI_ÜRET': 'RAND', RASTGELEARADA: 'RANDBETWEEN', TAVANAYUVARLA: 'CEILING',
  TABANAYUVARLA: 'FLOOR', 'ÇİFT': 'EVEN', TEK: 'ODD', 'TOPLA.ÇARPIM': 'SUMPRODUCT', TOPKARE: 'SUMSQ', ORTANCA: 'MEDIAN',
  'ENÇOK_OLAN': 'MODE', STDSAPMA: 'STDEV', 'STDSAPMA.S': 'STDEV.S', STDSAPMAS: 'STDEVP', 'STDSAPMA.P': 'STDEV.P',
  'VAR.S': 'VAR.S', VARS: 'VARP', 'BÜYÜK': 'LARGE', 'KÜÇÜK': 'SMALL', 'RANK.EŞİT': 'RANK.EQ',
  ETOPLA: 'SUMIF', 'EĞERORTALAMA': 'AVERAGEIF', 'EĞERSAY': 'COUNTIF', 'ÇOKETOPLA': 'SUMIFS', 'ÇOKEĞERORTALAMA': 'AVERAGEIFS',
  'ÇOKEĞERSAY': 'COUNTIFS', 'ÇOKEĞERMAK': 'MAXIFS', 'ÇOKEĞERMİN': 'MINIFS',
  'EĞER': 'IF', 'ÇOKEĞER': 'IFS', 'EĞERHATA': 'IFERROR', 'EĞERYOKSA': 'IFNA', 'İLKEŞLEŞEN': 'SWITCH', VE: 'AND', YADA: 'OR',
  'ÖZELVEYA': 'XOR', 'DEĞİL': 'NOT', 'DOĞRU': 'TRUE', 'YANLIŞ': 'FALSE',
  'DÜŞEYARA': 'VLOOKUP', 'YATAYARA': 'HLOOKUP', 'KAÇINCI': 'MATCH', 'İNDİS': 'INDEX', 'ÇAPRAZARA': 'XLOOKUP',
  ELEMAN: 'CHOOSE', SATIR: 'ROW', 'SÜTUN': 'COLUMN', SATIRSAY: 'ROWS', 'SÜTUNSAY': 'COLUMNS',
  UZUNLUK: 'LEN', SOLDAN: 'LEFT', 'SAĞDAN': 'RIGHT', 'PARÇAAL': 'MID', 'BÜYÜKHARF': 'UPPER', 'KÜÇÜKHARF': 'LOWER',
  'YAZIM.DÜZENİ': 'PROPER', KIRP: 'TRIM', 'BİRLEŞTİR': 'CONCATENATE', 'ARALIKBİRLEŞTİR': 'CONCAT', 'METİNBİRLEŞTİR': 'TEXTJOIN',
  YERINEKOY: 'SUBSTITUTE', 'YERİNEKOY': 'SUBSTITUTE', 'DEĞİŞTİR': 'REPLACE', BUL: 'FIND', MBUL: 'SEARCH', 'YİNELE': 'REPT',
  'ÖZDEŞ': 'EXACT', DAMGA: 'CHAR', KOD: 'CODE', 'SAYIYAÇEVİR': 'VALUE', 'METNEÇEVİR': 'TEXT',
  'BUGÜN': 'TODAY', 'ŞİMDİ': 'NOW', 'TARİH': 'DATE', ZAMAN: 'TIME', YIL: 'YEAR', AY: 'MONTH', 'GÜN': 'DAY', SAAT: 'HOUR',
  'DAKİKA': 'MINUTE', 'SANİYE': 'SECOND', 'HAFTANINGÜNÜ': 'WEEKDAY', 'SERİTARİH': 'EDATE', 'SERİAY': 'EOMONTH',
  'GÜNSAY': 'DAYS', 'ETARİHLİ': 'DATEDIF', 'TAMİŞGÜNÜ': 'NETWORKDAYS',
  'EBOŞSA': 'ISBLANK', 'ESAYIYSA': 'ISNUMBER', 'EMETİNSE': 'ISTEXT', 'EMANTIKSALSA': 'ISLOGICAL', 'EHATALIYSA': 'ISERROR',
  EHATAYSA: 'ISERR', EYOKSA: 'ISNA', 'ÇİFTMİ': 'ISEVEN', 'TEKMİ': 'ISODD', YOKSAY: 'NA',
  'DEVRESEL_ÖDEME': 'PMT', GD: 'FV', BD: 'PV', NBD: 'NPV',
};

export function canonicalName(name) {
  const up = name.toUpperCase();
  if (FN[up]) return up;
  const tr = name.toLocaleUpperCase('tr');
  if (TR[tr]) return TR[tr];
  if (TR[up]) return TR[up];
  if (up.startsWith('_XLFN.')) return canonicalName(name.slice(6));
  return up;
}

export const FUNCTION_LIST = [
  { cat: 'Sık kullanılan', items: [['SUM', 'TOPLA', 'Toplam'], ['AVERAGE', 'ORTALAMA', 'Ortalama'], ['COUNT', 'BAĞ_DEĞ_SAY', 'Sayıları say'], ['MAX', 'MAK', 'En büyük'], ['MIN', 'MİN', 'En küçük'], ['IF', 'EĞER', 'Koşul']] },
  { cat: 'Arama', items: [['VLOOKUP', 'DÜŞEYARA', 'Dikey arama'], ['XLOOKUP', 'ÇAPRAZARA', 'Esnek arama'], ['INDEX', 'İNDİS', 'Konumdaki değer'], ['MATCH', 'KAÇINCI', 'Konumu bul']] },
  { cat: 'Koşullu', items: [['SUMIF', 'ETOPLA', 'Koşullu toplam'], ['COUNTIF', 'EĞERSAY', 'Koşullu sayım'], ['AVERAGEIF', 'EĞERORTALAMA', 'Koşullu ortalama'], ['IFERROR', 'EĞERHATA', 'Hata yerine değer']] },
  { cat: 'Metin', items: [['CONCAT', 'ARALIKBİRLEŞTİR', 'Metinleri birleştir'], ['LEFT', 'SOLDAN', 'Soldan karakter'], ['UPPER', 'BÜYÜKHARF', 'Büyük harf'], ['TRIM', 'KIRP', 'Boşlukları temizle']] },
  { cat: 'Tarih ve matematik', items: [['TODAY', 'BUGÜN', 'Bugünün tarihi'], ['DATEDIF', 'ETARİHLİ', 'Tarih farkı'], ['ROUND', 'YUVARLA', 'Yuvarla'], ['PMT', 'DEVRESEL_ÖDEME', 'Kredi taksiti']] },
];

// ---- Sayı biçimlendirme -----------------------------------------------------------------
let SSF = null;
export function setSSF(ssf) { SSF = ssf; }

function swapSeparators(s) {
  return s.replace(/[.,]/g, (ch) => (ch === '.' ? ',' : '.'));
}

export function generalNumber(v) {
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e11 || a < 1e-9) return v.toExponential(5).replace(/\.?0+e/, 'E').replace('e', 'E').replace('.', ',');
  return parseFloat(v.toPrecision(11)).toLocaleString('tr-TR', { useGrouping: false, maximumFractionDigits: 10 });
}

export function formatNumber(v, fmt) {
  if (!fmt || fmt === 'General' || !SSF) return generalNumber(v);
  try {
    const out = SSF.format(fmt, v);
    return SSF.is_date(fmt) ? out : swapSeparators(out);
  } catch {
    return generalNumber(v);
  }
}

export function formatValue(v, fmt) {
  if (v == null) return '';
  if (v instanceof FErr) return v.code;
  if (typeof v === 'boolean') return v ? 'DOĞRU' : 'YANLIŞ';
  if (typeof v === 'number') return formatNumber(v, fmt);
  return String(v);
}

// Kullanıcı girdisini hücre içeriğine çevirir.
export function parseInput(text) {
  const s = String(text);
  if (s === '') return { v: null };
  if (s[0] === '=' && s.length > 1) return { f: normalizeFormula(s.slice(1)) };
  if (s[0] === "'") return { v: s.slice(1) };
  const up = s.trim().toLocaleUpperCase('tr');
  if (up === 'DOĞRU' || up === 'TRUE') return { v: true };
  if (up === 'YANLIŞ' || up === 'FALSE') return { v: false };
  const n = parseNumberText(s);
  if (n != null) return { v: n };
  let m = /^([+-]?[\d.,]+)\s*%$/.exec(s.trim());
  if (m && parseNumberText(m[1]) != null) return { v: parseNumberText(m[1]) / 100, z: '0%' };
  m = /^(?:₺\s*([+-]?[\d.,]+)|([+-]?[\d.,]+)\s*(?:₺|TL))$/i.exec(s.trim());
  if (m && parseNumberText(m[1] || m[2]) != null) return { v: parseNumberText(m[1] || m[2]), z: '#,##0.00 "₺"' };
  const d = parseDateText(s);
  if (d != null) return { v: d, z: d % 1 ? 'dd.mm.yyyy hh:mm' : 'dd.mm.yyyy' };
  const t = parseTimeText(s);
  if (t != null) return { v: t, z: 'hh:mm' };
  return { v: s };
}
