// Çalışma kitabı modeli: hücreler, stiller, hesaplama, geri al/yinele.
// Hücre nesneleri değiştirilemez (immutable) kabul edilir; her değişiklik yeni nesne üretir.
import {
  MAX_ROWS, MAX_COLS, ERR, evaluateFormula, adjustFormula, shiftFormula, renameSheetInFormula,
  parseRefText, refToRange, compare,
} from './formula.js';

export const DEF_W = 100;
export const DEF_H = 24;
export const key = (r, c) => r * MAX_COLS + c;
export const rowOf = (k) => Math.floor(k / MAX_COLS);
export const colOf = (k) => k % MAX_COLS;

const DEEP_LIMIT = 200;
class Deep { constructor(si, k) { this.si = si; this.k = k; } }

export function newSheet(name) {
  return { name, cells: new Map(), colW: new Map(), rowH: new Map(), merges: [], freeze: { r: 0, c: 0 }, grid: true };
}

function cloneSheet(sh) {
  return {
    ...sh,
    cells: new Map(sh.cells), colW: new Map(sh.colW), rowH: new Map(sh.rowH),
    merges: sh.merges.map((m) => ({ ...m })), freeze: { ...sh.freeze },
  };
}

export class Workbook {
  constructor(data) {
    this.sheets = [];
    this.names = {};
    this.active = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.tx = null;
    this.onChange = null;
    if (data && data.sheets) this.load(data);
    else this.sheets.push(newSheet('Sayfa1'));
    this.resetCalc();
  }

  // ---- Kalıcılık ----------------------------------------------------------------------
  load(data) {
    const styles = (data.styles || []).map((s) => Object.freeze({ ...s }));
    this.sheets = data.sheets.map((s) => {
      const sh = newSheet(String(s.name || 'Sayfa'));
      for (const [k, cell] of s.cells || []) {
        if (typeof k !== 'number' || !cell || typeof cell !== 'object') continue;
        const c = {};
        if (cell.v !== undefined) c.v = cell.v;
        if (typeof cell.f === 'string') c.f = cell.f;
        if (cell.cv !== undefined) c.cv = cell.cv;
        if (typeof cell.s === 'number' && styles[cell.s]) c.s = styles[cell.s];
        if (cell.e) c.v = ERR[cell.e] || ERR.VALUE;
        sh.cells.set(k, c);
      }
      for (const [c, w] of s.colW || []) sh.colW.set(+c, +w);
      for (const [r, hh] of s.rowH || []) sh.rowH.set(+r, +hh);
      sh.merges = (s.merges || []).map((m) => ({ r1: +m.r1, c1: +m.c1, r2: +m.r2, c2: +m.c2 }));
      sh.freeze = { r: +(s.freeze && s.freeze.r) || 0, c: +(s.freeze && s.freeze.c) || 0 };
      sh.grid = s.grid !== false;
      return sh;
    });
    if (!this.sheets.length) this.sheets.push(newSheet('Sayfa1'));
    this.names = { ...(data.names || {}) };
    this.active = Math.min(Math.max(0, data.active | 0), this.sheets.length - 1);
  }

  serialize() {
    const styleIds = new Map();
    const styles = [];
    const sid = (s) => {
      if (!s) return undefined;
      let id = styleIds.get(s);
      if (id === undefined) {
        const json = JSON.stringify(s);
        const existing = styles.findIndex((x) => x.json === json);
        id = existing >= 0 ? existing : styles.push({ json, s }) - 1;
        styleIds.set(s, id);
      }
      return id;
    };
    const errName = (v) => Object.keys(ERR).find((k) => ERR[k] === v) || 'VALUE';
    const sheets = this.sheets.map((sh) => ({
      name: sh.name,
      cells: [...sh.cells].map(([k, c]) => {
        const o = {};
        if (c.v !== undefined && c.v !== null) {
          if (c.v && typeof c.v === 'object' && 'code' in c.v) o.e = errName(c.v); else o.v = c.v;
        }
        if (c.f != null) o.f = c.f;
        if (c.cv !== undefined && !(c.cv && typeof c.cv === 'object')) o.cv = c.cv;
        const s = sid(c.s);
        if (s !== undefined) o.s = s;
        return [k, o];
      }),
      colW: [...sh.colW], rowH: [...sh.rowH], merges: sh.merges, freeze: sh.freeze, grid: sh.grid,
    }));
    return { v: 1, active: this.active, names: this.names, styles: styles.map((x) => x.s), sheets };
  }

  // ---- Hesaplama ----------------------------------------------------------------------
  resetCalc() {
    this.cache = this.sheets.map(() => new Map());
    this.computing = this.sheets.map(() => new Set());
    this.boundsCache = this.sheets.map(() => null);
    this.depth = 0;
  }

  invalidate(si) {
    for (const c of this.cache) c.clear();
    if (si != null) this.boundsCache[si] = null;
    else this.boundsCache = this.sheets.map(() => null);
  }

  sheetIndex(name) {
    const n = String(name).toLocaleLowerCase('tr');
    return this.sheets.findIndex((s) => s.name.toLocaleLowerCase('tr') === n);
  }

  resolveName(name) {
    const entry = Object.entries(this.names).find(([k]) => k.toLowerCase() === String(name).toLowerCase());
    if (!entry) return null;
    const tok = parseRefText(entry[1]);
    if (!tok) return null;
    return refToRange(tok, { wb: this, si: this.active });
  }

  bounds(si) {
    let b = this.boundsCache[si];
    if (b) return b;
    let maxR = -1, maxC = -1;
    const sh = this.sheets[si];
    if (sh) for (const k of sh.cells.keys()) { const r = rowOf(k), c = colOf(k); if (r > maxR) maxR = r; if (c > maxC) maxC = c; }
    b = { maxR, maxC };
    this.boundsCache[si] = b;
    return b;
  }

  getCell(si, r, c) {
    const sh = this.sheets[si];
    return sh ? sh.cells.get(key(r, c)) : undefined;
  }

  value(si, r, c) {
    const sh = this.sheets[si];
    if (!sh) return ERR.REF;
    const k = key(r, c);
    const cell = sh.cells.get(k);
    if (!cell) return null;
    if (cell.f == null) return cell.v === undefined ? null : cell.v;
    const hit = this.cache[si].get(k);
    if (hit !== undefined) return hit;
    if (this.depth === 0) return this.topEval(si, k);
    return this.evalCell(si, k, cell);
  }

  evalCell(si, k, cell) {
    const comp = this.computing[si];
    if (comp.has(k)) return ERR.CIRC;
    if (this.depth >= DEEP_LIMIT) throw new Deep(si, k);
    this.depth++;
    comp.add(k);
    let v;
    try {
      v = evaluateFormula(cell.f, { wb: this, si, r: rowOf(k), c: colOf(k) });
    } finally {
      this.depth--;
      comp.delete(k);
    }
    // Desteklenmeyen bir işlev varsa dosyadaki kayıtlı sonucu göster.
    if (v === ERR.NAME && cell.cv !== undefined) v = cell.cv;
    if (v === null || v === undefined) v = 0;
    this.cache[si].set(k, v);
    return v;
  }

  // Çok uzun bağımlılık zincirlerinde yığın taşmasını önleyen yinelemeli değerlendirme.
  topEval(si, k) {
    const stack = [[si, k]];
    let guard = 0;
    while (stack.length) {
      const [s, kk] = stack[stack.length - 1];
      if (this.cache[s].has(kk)) { stack.pop(); continue; }
      const cell = this.sheets[s].cells.get(kk);
      if (!cell || cell.f == null) { stack.pop(); continue; }
      try {
        this.depth = 0;
        this.evalCell(s, kk, cell);
        stack.pop();
      } catch (e) {
        if (!(e instanceof Deep)) throw e;
        if (stack.some(([a, b]) => a === e.si && b === e.k)) this.cache[e.si].set(e.k, ERR.CIRC);
        else stack.push([e.si, e.k]);
      } finally {
        this.depth = 0;
      }
      if (++guard > 2e6) { this.cache[si].set(k, ERR.NUM); break; }
    }
    return this.cache[si].get(k);
  }

  matrix(rng, full) {
    const b = this.bounds(rng.si);
    let r2 = rng.r2, c2 = rng.c2;
    if (!full || rng.rows * rng.cols > 200000) { r2 = Math.min(r2, b.maxR); c2 = Math.min(c2, b.maxC); }
    const out = [];
    for (let r = rng.r1; r <= r2; r++) {
      const row = new Array(Math.max(0, c2 - rng.c1 + 1));
      for (let c = rng.c1, j = 0; c <= c2; c++, j++) row[j] = this.value(rng.si, r, c);
      out.push(row);
    }
    return out;
  }

  // ---- Değişiklikler ve geri alma -----------------------------------------------------
  transact(fn) {
    const own = !this.tx;
    if (own) this.tx = [];
    try { return fn(); } finally {
      if (own) {
        const tx = this.tx;
        this.tx = null;
        if (tx.length) this.pushUndo(tx);
        this.emit();
      }
    }
  }

  pushUndo(entry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }

  emit() {
    if (this.onChange) this.onChange();
  }

  setCell(si, r, c, cell) {
    if (r < 0 || c < 0 || r >= MAX_ROWS || c >= MAX_COLS) return;
    const sh = this.sheets[si];
    const k = key(r, c);
    const before = sh.cells.get(k);
    const empty = !cell || (cell.v == null && cell.f == null && !cell.s);
    const after = empty ? undefined : cell;
    if (before === after) return;
    if (after) sh.cells.set(k, after); else sh.cells.delete(k);
    this.invalidate(si);
    if (this.tx) this.tx.push({ si, k, before, after });
    else { this.pushUndo([{ si, k, before, after }]); this.emit(); }
  }

  // Yapısal işlemler: tüm kitabın anlık görüntüsü alınır (hücre nesneleri paylaşılır).
  snap() {
    return { sheets: this.sheets.map(cloneSheet), names: { ...this.names }, active: this.active };
  }

  restore(s) {
    this.sheets = s.sheets.map(cloneSheet);
    this.names = { ...s.names };
    this.active = Math.min(s.active, this.sheets.length - 1);
    this.resetCalc();
  }

  structural(fn) {
    const before = this.snap();
    const res = fn();
    this.resetCalc();
    this.pushUndo({ snap: true, before, after: this.snap() });
    this.emit();
    return res;
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  undo() {
    const e = this.undoStack.pop();
    if (!e) return false;
    this.applyEntry(e, true);
    this.redoStack.push(e);
    this.emit();
    return e;
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return false;
    this.applyEntry(e, false);
    this.undoStack.push(e);
    this.emit();
    return e;
  }

  applyEntry(e, back) {
    if (e.snap) { this.restore(back ? e.before : e.after); return; }
    const list = back ? [...e].reverse() : e;
    for (const op of list) {
      const sh = this.sheets[op.si];
      if (!sh) continue;
      const v = back ? op.before : op.after;
      if (v) sh.cells.set(op.k, v); else sh.cells.delete(op.k);
    }
    this.invalidate();
  }

  // ---- Satır / sütun işlemleri ---------------------------------------------------------
  shiftAxis(si, axis, at, count) {
    this.structural(() => {
      const sh = this.sheets[si];
      const isRow = axis === 'row';
      const moved = new Map();
      const del = count < 0 ? -count : 0;
      for (const [k, cell] of sh.cells) {
        let r = rowOf(k), c = colOf(k);
        const p = isRow ? r : c;
        if (count < 0 && p >= at && p < at + del) continue;
        if (p >= at) { if (isRow) r += count; else c += count; }
        if (r < 0 || c < 0 || r >= MAX_ROWS || c >= MAX_COLS) continue;
        moved.set(key(r, c), cell);
      }
      sh.cells = moved;
      // Formülleri tüm sayfalarda güncelle.
      this.sheets.forEach((other, oi) => {
        for (const [k, cell] of other.cells) {
          if (cell.f == null) continue;
          const nf = adjustFormula(cell.f, { sameSheet: oi === si, sheetName: sh.name, axis, at, count });
          if (nf !== cell.f) other.cells.set(k, { ...cell, f: nf, cv: undefined });
        }
      });
      const sizes = isRow ? sh.rowH : sh.colW;
      const ns = new Map();
      for (const [p, v] of sizes) {
        if (count < 0 && p >= at && p < at + del) continue;
        ns.set(p >= at ? p + count : p, v);
      }
      if (isRow) sh.rowH = ns; else sh.colW = ns;
      const a1 = isRow ? 'r1' : 'c1', a2 = isRow ? 'r2' : 'c2';
      sh.merges = sh.merges.map((m) => {
        const n = { ...m };
        if (count > 0) {
          if (n[a1] >= at) n[a1] += count;
          if (n[a2] >= at) n[a2] += count;
        } else {
          const end = at + del;
          const f = (v) => (v < at ? v : v >= end ? v - del : at);
          n[a1] = f(n[a1]);
          n[a2] = m[a2] >= end ? m[a2] - del : m[a2] < at ? m[a2] : at - 1;
          if (n[a2] < n[a1]) return null;
        }
        return n;
      }).filter((m) => m && (m.r2 > m.r1 || m.c2 > m.c1));
      for (const [nm, ref] of Object.entries(this.names)) {
        const tok = parseRefText(ref);
        if (!tok) continue;
        const target = tok.sheet == null ? this.sheets[this.active].name : tok.sheet;
        if (target.toLowerCase() !== sh.name.toLowerCase()) continue;
        this.names[nm] = adjustFormula(String(ref).replace(/^=/, ''), { sameSheet: false, sheetName: sh.name, axis, at, count });
      }
    });
  }

  insertRows(si, at, n = 1) { this.shiftAxis(si, 'row', at, n); }
  deleteRows(si, at, n = 1) { this.shiftAxis(si, 'row', at, -n); }
  insertCols(si, at, n = 1) { this.shiftAxis(si, 'col', at, n); }
  deleteCols(si, at, n = 1) { this.shiftAxis(si, 'col', at, -n); }

  sortRange(si, rng, col, asc = true, header = false) {
    this.structural(() => {
      const sh = this.sheets[si];
      const r1 = rng.r1 + (header ? 1 : 0);
      const rows = [];
      for (let r = r1; r <= rng.r2; r++) {
        const cells = [];
        for (let c = rng.c1; c <= rng.c2; c++) cells.push(sh.cells.get(key(r, c)));
        rows.push({ r, cells, v: this.value(si, r, col) });
      }
      rows.sort((a, b) => {
        const ea = a.v == null || a.v === '', eb = b.v == null || b.v === '';
        if (ea || eb) return ea === eb ? a.r - b.r : ea ? 1 : -1; // boşlar her zaman sonda
        const d = compare(a.v, b.v);
        return d === 0 ? a.r - b.r : asc ? d : -d;
      });
      rows.forEach((row, i) => {
        const nr = r1 + i;
        row.cells.forEach((cell, j) => {
          const k = key(nr, rng.c1 + j);
          if (!cell) { sh.cells.delete(k); return; }
          sh.cells.set(k, cell.f != null ? { ...cell, f: shiftFormula(cell.f, nr - row.r, 0), cv: undefined } : cell);
        });
      });
    });
  }

  setSize(si, axis, idx, size) {
    this.structural(() => {
      const m = axis === 'row' ? this.sheets[si].rowH : this.sheets[si].colW;
      const list = Array.isArray(idx) ? idx : [idx];
      for (const i of list) {
        if (size == null) m.delete(i); else m.set(i, Math.max(0, Math.round(size)));
      }
    });
  }

  setMerge(si, rng, on) {
    this.structural(() => {
      const sh = this.sheets[si];
      sh.merges = sh.merges.filter((m) => m.r2 < rng.r1 || m.r1 > rng.r2 || m.c2 < rng.c1 || m.c1 > rng.c2);
      if (on && (rng.r2 > rng.r1 || rng.c2 > rng.c1)) {
        // Birleştirmede yalnızca sol üst hücrenin içeriği kalır (Excel gibi).
        for (let r = rng.r1; r <= rng.r2; r++) for (let c = rng.c1; c <= rng.c2; c++) {
          if (r === rng.r1 && c === rng.c1) continue;
          const k = key(r, c);
          const cell = sh.cells.get(k);
          if (cell) { if (cell.s) sh.cells.set(k, { s: cell.s }); else sh.cells.delete(k); }
        }
        sh.merges.push({ r1: rng.r1, c1: rng.c1, r2: rng.r2, c2: rng.c2 });
      }
    });
  }

  setFreeze(si, r, c) {
    this.structural(() => { this.sheets[si].freeze = { r: Math.max(0, r), c: Math.max(0, c) }; });
  }

  // ---- Sayfa işlemleri ------------------------------------------------------------------
  uniqueName(base) {
    let n = base, i = 2;
    while (this.sheetIndex(n) >= 0) n = `${base} (${i++})`;
    return n;
  }

  addSheet(name, at = this.sheets.length) {
    return this.structural(() => {
      this.sheets.splice(at, 0, newSheet(this.uniqueName(name || `Sayfa${this.sheets.length + 1}`)));
      this.active = at;
      return at;
    });
  }

  duplicateSheet(i) {
    return this.structural(() => {
      const copy = cloneSheet(this.sheets[i]);
      copy.name = this.uniqueName(this.sheets[i].name);
      this.sheets.splice(i + 1, 0, copy);
      this.active = i + 1;
      return i + 1;
    });
  }

  deleteSheet(i) {
    if (this.sheets.length <= 1) return false;
    this.structural(() => {
      const name = this.sheets[i].name;
      this.sheets.splice(i, 1);
      this.active = Math.min(this.active, this.sheets.length - 1);
      // Silinen sayfaya başvuran formüller #REF! olur.
      const re = new RegExp(`(?:'${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "''")}'|\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})![$A-Za-z0-9:]+`, 'gi');
      for (const sh of this.sheets) for (const [k, cell] of sh.cells) {
        if (cell.f != null && re.test(cell.f)) { re.lastIndex = 0; sh.cells.set(k, { ...cell, f: cell.f.replace(re, '#REF!'), cv: undefined }); }
        re.lastIndex = 0;
      }
    });
    return true;
  }

  renameSheet(i, name) {
    name = String(name).replace(/[\\/?*[\]:]/g, '').trim().slice(0, 31);
    if (!name) return 'Sayfa adı boş olamaz.';
    const ex = this.sheetIndex(name);
    if (ex >= 0 && ex !== i) return 'Bu adda bir sayfa zaten var.';
    this.structural(() => {
      const old = this.sheets[i].name;
      this.sheets[i].name = name;
      for (const sh of this.sheets) for (const [k, cell] of sh.cells) {
        if (cell.f == null) continue;
        const nf = renameSheetInFormula(cell.f, old, name);
        if (nf !== cell.f) sh.cells.set(k, { ...cell, f: nf });
      }
    });
    return null;
  }

  moveSheet(i, d) {
    const j = i + d;
    if (j < 0 || j >= this.sheets.length) return;
    this.structural(() => {
      const [s] = this.sheets.splice(i, 1);
      this.sheets.splice(j, 0, s);
      this.active = j;
    });
  }

  mergeAt(si, r, c) {
    for (const m of this.sheets[si].merges) if (r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2) return m;
    return null;
  }
}
