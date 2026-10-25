// Tablo (Excel) düzenleyicisi: canvas tabanlı sanal ızgara.
import { h, tbtn, tsep, tselect, popupMenu, colorPicker, askText, confirmBox, toast, clear, icon, modal } from '../core/ui.js';
import { saveBlob, printElement, canPrint } from '../core/platform.js';
import { canvasDpr } from '../core/perf.js';
import { usableFonts, previewFontOptions, ensureCanvasFont } from '../core/fonts.js';
import { pinchZoom } from '../core/pinch.js';
import { Workbook, key, rowOf, colOf, DEF_W, DEF_H } from './model.js';
import {
  MAX_ROWS, MAX_COLS, colName, addr, parseAddr, parseInput, formatValue, FErr, shiftFormula,
  FUNCTION_LIST, numToText, refsInFormula, parseNumberText,
} from './formula.js';
import { exportXlsx, exportOds, exportCsv, sheetToTable, applyCellCss } from './xlsx-io.js';

const HDR_W = 46;
const HDR_H = 24;
const FONT = 'Calibri, Carlito, "Segoe UI", Arial, sans-serif';
const FONTS = ['Calibri', 'Arial', 'Times New Roman', 'Courier New', 'Verdana', 'Tahoma', 'Georgia', 'Segoe UI'];
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36];
const NUM_FORMATS = [
  { value: 'General', label: 'Genel' },
  { value: '#,##0.00', label: 'Sayı (1.234,50)' },
  { value: '#,##0', label: 'Tam sayı (1.234)' },
  { value: '#,##0.00 "₺"', label: 'Para (₺)' },
  { value: '0%', label: 'Yüzde (%)' },
  { value: '0.00%', label: 'Yüzde (%0,00)' },
  { value: 'dd.mm.yyyy', label: 'Tarih (31.12.2025)' },
  { value: 'd mmmm yyyy', label: 'Uzun tarih' },
  { value: 'hh:mm', label: 'Saat (14:30)' },
  { value: 'dd.mm.yyyy hh:mm', label: 'Tarih ve saat' },
  { value: '0.00E+00', label: 'Bilimsel' },
  { value: '@', label: 'Metin' },
];
const ERR_COLOR = '#c00000';

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// Tema renkleri her çizimde yeniden hesaplanmaz (getComputedStyle pahalıdır); yalnızca tema değişince.
let themeCache = null, themeKey = '';
function gridTheme() {
  const k = document.documentElement.dataset.theme || '';
  if (themeCache && k === themeKey) return themeCache;
  themeKey = k;
  themeCache = {
    bg: '#ffffff', grid: '#e1e3e6', hdr: cssVar('--sheet-hdr', '#f3f4f6'), hdrText: cssVar('--sheet-hdr-text', '#444'),
    hdrSel: cssVar('--sheet-hdr-sel', '#d3e3fd'), sel: cssVar('--accent', '#1f6feb'), text: '#000000',
    line: cssVar('--sheet-line', '#c7cad1'),
  };
  return themeCache;
}

export async function mountSheet(root, data, app) {
  root.classList.add('editor', 'editor-sheet');
  const wb = new Workbook(data && data.sheets ? data : null);
  let si = wb.active;
  const sheet = () => wb.sheets[si];

  // Seçim: aktif hücre + aralık
  let sel = { r: 0, c: 0, r1: 0, c1: 0, r2: 0, c2: 0 };
  let editing = null; // { r, c, input, fromBar }
  let clip = null; // dahili pano
  let scrollX = 0, scrollY = 0;
  let extentR = 200, extentC = 40;
  let dpr = canvasDpr();
  let width = 0, height = 0; // mantıksal (yakınlaştırma öncesi) boyut
  let zoom = 1; // görünüm yakınlaştırması; ızgara mantıksal piksellerle çizilir, ekranda zoom ile ölçeklenir

  // ---- DOM ------------------------------------------------------------------------------
  const toolbar = h('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Tablo araçları' });
  const nameBox = h('input', { class: 'namebox', 'aria-label': 'Hücre adresi', spellcheck: 'false' });
  const fxBtn = h('button', { class: 'fx-btn', type: 'button', title: 'İşlev ekle', 'aria-label': 'İşlev ekle' }, icon('fx', 18));
  const barInput = h('textarea', { class: 'formula-input', rows: '1', spellcheck: 'false', 'aria-label': 'Formül çubuğu' });
  const fbar = h('div', { class: 'formula-bar' }, nameBox, fxBtn, barInput);
  const canvas = h('canvas', { class: 'grid-canvas', 'aria-hidden': 'true' });
  const spacer = h('div', { class: 'grid-spacer' });
  const scroller = h('div', { class: 'grid-scroller', tabindex: '0', role: 'grid', 'aria-label': 'Tablo ızgarası' }, spacer);
  const cellEditor = h('textarea', { class: 'cell-editor', spellcheck: 'false', hidden: true, 'aria-label': 'Hücre düzenleyici' });
  const acBox = h('div', { class: 'popup-menu ac-box', hidden: true });
  // Masaüstünde klavye odağı gizli bir metin alanında tutulur; böylece IME, ölü tuşlar ve
  // doğrudan metin girişi de hücre düzenlemeyi başlatır. Dokunmatikte klavye açılmasın diye ızgara odaklanır.
  const keySink = h('textarea', { class: 'key-sink', tabindex: '-1', 'aria-label': 'Hücreye yaz', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const gridWrap = h('div', { class: 'grid-wrap' }, canvas, scroller, cellEditor, keySink);
  const tabs = h('div', { class: 'sheet-tabs', role: 'tablist' });
  const statusSum = h('span', { class: 'sheet-stat' });
  const touchHandle = h('div', { class: 'sel-handle', hidden: true, 'aria-hidden': 'true' });
  gridWrap.append(touchHandle);
  const bottom = h('div', { class: 'sheet-bottom' }, tabs, statusSum);
  root.append(toolbar, fbar, gridWrap, bottom);
  document.body.append(acBox);
  const ctx = canvas.getContext('2d');

  // ---- Boyut hesapları -----------------------------------------------------------------
  let sizeCache = null;
  function buildSizeCache() {
    const sh = sheet();
    const mk = (m, def) => {
      const keys = [...m.keys()].sort((a, b) => a - b);
      const pre = [0];
      for (const k of keys) pre.push(pre[pre.length - 1] + (m.get(k) - def));
      return { keys, pre, def, m };
    };
    sizeCache = { col: mk(sh.colW, DEF_W), row: mk(sh.rowH, DEF_H) };
  }
  function lowerBound(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; } return lo; }
  const posOf = (sc, i) => i * sc.def + sc.pre[lowerBound(sc.keys, i)];
  const sizeOf = (sc, i) => (sc.m.has(i) ? sc.m.get(i) : sc.def);
  function indexAt(sc, p, max) {
    let lo = 0, hi = max;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (posOf(sc, mid) <= p) lo = mid; else hi = mid - 1; }
    return lo;
  }
  const colX = (c) => posOf(sizeCache.col, c);
  const rowY = (r) => posOf(sizeCache.row, r);
  const colW = (c) => sizeOf(sizeCache.col, c);
  const rowH = (r) => sizeOf(sizeCache.row, r);

  // Dondurulmuş bölmeleri hesaba katarak ekran koordinatları
  const frz = () => sheet().freeze;
  const frozenW = () => colX(frz().c);
  const frozenH = () => rowY(frz().r);
  function screenX(c) { const f = frz().c; return HDR_W + (c < f ? colX(c) : colX(c) - scrollX); }
  function screenY(r) { const f = frz().r; return HDR_H + (r < f ? rowY(r) : rowY(r) - scrollY); }
  function colAtX(x) {
    const f = frz().c, fw = frozenW();
    const gx = x - HDR_W;
    if (gx < fw) return indexAt(sizeCache.col, gx, Math.max(0, f - 1));
    return indexAt(sizeCache.col, gx + scrollX, MAX_COLS - 1);
  }
  function rowAtY(y) {
    const f = frz().r, fh = frozenH();
    const gy = y - HDR_H;
    if (gy < fh) return indexAt(sizeCache.row, gy, Math.max(0, f - 1));
    return indexAt(sizeCache.row, gy + scrollY, MAX_ROWS - 1);
  }

  function updateExtent() {
    const b = wb.bounds(si);
    const visR = rowAtY(height) + 50, visC = colAtX(width) + 10;
    extentR = Math.min(MAX_ROWS, Math.max(200, b.maxR + 100, visR, sel.r2 + 50));
    extentC = Math.min(MAX_COLS, Math.max(40, b.maxC + 20, visC, sel.c2 + 10));
    const totalW = HDR_W + colX(extentC);
    const totalH = HDR_H + rowY(extentR);
    spacer.style.width = Math.min(totalW * zoom, 30000000) + 'px';
    spacer.style.height = Math.min(totalH * zoom, 30000000) + 'px';
  }

  function resize() {
    const r = gridWrap.getBoundingClientRect();
    const cw = Math.max(1, Math.floor(r.width)), ch = Math.max(1, Math.floor(r.height));
    width = cw / zoom;
    height = ch / zoom;
    dpr = canvasDpr();
    canvas.width = Math.floor(cw * dpr);
    canvas.height = Math.floor(ch * dpr);
    canvas.style.width = cw + 'px';
    canvas.style.height = ch + 'px';
    updateExtent();
    draw();
  }

  // ---- Çizim ---------------------------------------------------------------------------
  let rafPending = false;
  function draw() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; paint(); });
  }

  const mergeIndex = () => {
    const m = new Map();
    for (const mg of sheet().merges) m.set(key(mg.r1, mg.c1), mg);
    return m;
  };

  function paint() {
    const theme = gridTheme();
    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, 0, 0);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, width, height);
    const sh = sheet();
    const fr = sh.freeze.r, fc = sh.freeze.c;
    const fw = frozenW(), fh = frozenH();
    const firstR = rowAtY(HDR_H + fh), lastR = rowAtY(height);
    const firstC = colAtX(HDR_W + fw), lastC = colAtX(width);
    const regions = [
      { r1: firstR, r2: lastR, c1: firstC, c2: lastC, x: HDR_W + fw, y: HDR_H + fh },
    ];
    if (fr) regions.push({ r1: 0, r2: fr - 1, c1: firstC, c2: lastC, x: HDR_W + fw, y: HDR_H });
    if (fc) regions.push({ r1: firstR, r2: lastR, c1: 0, c2: fc - 1, x: HDR_W, y: HDR_H + fh });
    if (fr && fc) regions.push({ r1: 0, r2: fr - 1, c1: 0, c2: fc - 1, x: HDR_W, y: HDR_H });
    const merges = mergeIndex();
    for (const rg of regions) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(rg.x, rg.y, width - rg.x, height - rg.y);
      ctx.clip();
      paintCells(rg, theme, merges);
      ctx.restore();
    }
    paintSelection(theme);
    paintHeaders(theme, firstR, lastR, firstC, lastC);
    if (fr || fc) {
      ctx.strokeStyle = '#9aa0a6';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (fr) { ctx.moveTo(0, HDR_H + fh + 0.5); ctx.lineTo(width, HDR_H + fh + 0.5); }
      if (fc) { ctx.moveTo(HDR_W + fw + 0.5, 0); ctx.lineTo(HDR_W + fw + 0.5, height); }
      ctx.stroke();
    }
    positionHandle();
  }

  function fontOf(s) {
    const size = (s && s.fs ? s.fs : 11) * (96 / 72);
    const fam = s && s.ff ? `"${String(s.ff).replace(/["\\]/g, '')}", ${FONT}` : FONT;
    return `${s && s.i ? 'italic ' : ''}${s && s.b ? 'bold ' : ''}${size.toFixed(1)}px ${fam}`;
  }

  function cellDisplay(r, c, cell) {
    const v = cell.f != null ? wb.value(si, r, c) : cell.v;
    const z = cell.s && cell.s.z;
    let text = formatValue(v, z);
    if (typeof v === 'number' && z === '@') text = numToText(v);
    return { v, text };
  }

  function paintCells(rg, theme, merges) {
    const sh = sheet();
    // Dolgu ve metin
    const texts = [];
    for (let r = rg.r1; r <= rg.r2; r++) {
      const hgt = rowH(r);
      if (hgt === 0) continue;
      const y = screenY(r);
      for (let c = rg.c1; c <= rg.c2; c++) {
        const w = colW(c);
        if (w === 0) continue;
        const k = key(r, c);
        const cell = sh.cells.get(k);
        const m = merges.get(k);
        if (!cell && !m) continue;
        if (!m && isCoveredFast(r, c)) continue;
        const x = screenX(c);
        let cw = w, ch = hgt;
        if (m) { cw = colX(m.c2 + 1) - colX(m.c1); ch = rowY(m.r2 + 1) - rowY(m.r1); }
        const s = cell && cell.s;
        if (s && s.bg) { ctx.fillStyle = s.bg; ctx.fillRect(x, y, cw, ch); }
        else if (m) { ctx.fillStyle = theme.bg; ctx.fillRect(x, y, cw, ch); }
        if (cell && (cell.v != null || cell.f != null)) texts.push({ r, c, x, y, cw, ch, cell, merged: !!m });
      }
    }
    // Izgara çizgileri
    if (sh.grid !== false) {
      ctx.strokeStyle = theme.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let c = rg.c1; c <= rg.c2 + 1; c++) {
        const x = Math.round(screenX(c)) - 0.5;
        ctx.moveTo(x, rg.y); ctx.lineTo(x, height);
      }
      for (let r = rg.r1; r <= rg.r2 + 1; r++) {
        const y = Math.round(screenY(r)) - 0.5;
        ctx.moveTo(rg.x, y); ctx.lineTo(width, y);
      }
      ctx.stroke();
      // Birleştirilmiş hücrelerin iç çizgilerini kapat
      for (const m of sh.merges) {
        if (m.r2 < rg.r1 || m.r1 > rg.r2 || m.c2 < rg.c1 || m.c1 > rg.c2) continue;
        const k = key(m.r1, m.c1);
        const cell = sh.cells.get(k);
        ctx.fillStyle = (cell && cell.s && cell.s.bg) || theme.bg;
        ctx.fillRect(screenX(m.c1), screenY(m.r1), colX(m.c2 + 1) - colX(m.c1) - 1, rowY(m.r2 + 1) - rowY(m.r1) - 1);
      }
    }
    // Metinler
    ctx.textBaseline = 'middle';
    for (const t of texts) {
      const { text, v } = cellDisplay(t.r, t.c, t.cell);
      if (text === '') continue;
      const s = t.cell.s || {};
      ctx.font = fontOf(s);
      ensureCanvasFont(ctx.font, draw);
      ctx.fillStyle = v instanceof FErr ? ERR_COLOR : s.fc || theme.text;
      let align = s.ha || (typeof v === 'number' ? 'right' : typeof v === 'boolean' || v instanceof FErr ? 'center' : 'left');
      const pad = 4;
      let clipW = t.cw;
      // Taşan metin: sağdaki boş hücrelere uzat
      if (!s.wr && align === 'left' && !t.merged && typeof v === 'string') {
        let c = t.c + 1;
        const need = ctx.measureText(text).width + pad * 2;
        while (clipW < need && c < t.c + 30 && !sheet().cells.has(key(t.r, c)) && !isCoveredFast(t.r, c)) { clipW += colW(c); c++; }
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(t.x, t.y, clipW - 1, t.ch - 1);
      ctx.clip();
      const lineH = (s.fs || 11) * (96 / 72) * 1.2;
      let lines = [text];
      if (s.wr) lines = wrapText(text, t.cw - pad * 2);
      else if (text.includes('\n')) lines = text.split('\n');
      if (typeof v === 'number' && !s.wr && align !== 'left' && ctx.measureText(text).width > t.cw - pad * 2) lines = ['#'.repeat(Math.max(1, Math.floor((t.cw - pad * 2) / ctx.measureText('#').width)))];
      const blockH = lines.length * lineH;
      let y0;
      if (s.va === 'top') y0 = t.y + 2 + lineH / 2;
      else if (s.va === 'middle') y0 = t.y + t.ch / 2 - blockH / 2 + lineH / 2;
      else y0 = t.y + t.ch - blockH + lineH / 2 - 2;
      ctx.textAlign = align;
      const xx = align === 'left' ? t.x + pad : align === 'right' ? t.x + t.cw - pad : t.x + t.cw / 2;
      lines.forEach((ln, i) => {
        const yy = y0 + i * lineH;
        ctx.fillText(ln, xx, yy);
        if (s.u || s.st) {
          const w = ctx.measureText(ln).width;
          const lx = align === 'left' ? xx : align === 'right' ? xx - w : xx - w / 2;
          ctx.fillRect(lx, s.u ? yy + lineH * 0.35 : yy, w, 1);
        }
      });
      ctx.restore();
    }
    // Kenarlıklar
    for (let r = rg.r1; r <= rg.r2; r++) {
      for (let c = rg.c1; c <= rg.c2; c++) {
        const cell = sh.cells.get(key(r, c));
        const s = cell && cell.s;
        if (!s || !(s.bt || s.bb || s.bl || s.br)) continue;
        const m = merges.get(key(r, c));
        const x = Math.round(screenX(c)) - 0.5, y = Math.round(screenY(r)) - 0.5;
        const w = m ? colX(m.c2 + 1) - colX(m.c1) : colW(c);
        const hh = m ? rowY(m.r2 + 1) - rowY(m.r1) : rowH(r);
        const line = (col, x1, y1, x2, y2) => { ctx.strokeStyle = col === true ? '#000' : col; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };
        if (s.bt) line(s.bt, x, y, x + w, y);
        if (s.bb) line(s.bb, x, y + hh, x + w, y + hh);
        if (s.bl) line(s.bl, x, y, x, y + hh);
        if (s.br) line(s.br, x + w, y, x + w, y + hh);
      }
    }
  }

  let coveredSet = null;
  function rebuildCovered() {
    coveredSet = new Set();
    for (const m of sheet().merges) {
      const area = (m.r2 - m.r1 + 1) * (m.c2 - m.c1 + 1);
      if (area > 100000) continue;
      for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) if (r !== m.r1 || c !== m.c1) coveredSet.add(key(r, c));
    }
  }
  const isCoveredFast = (r, c) => coveredSet.has(key(r, c));

  function wrapText(text, maxW) {
    const out = [];
    for (const para of text.split('\n')) {
      let line = '';
      for (const word of para.split(/(\s+)/)) {
        const t = line + word;
        if (ctx.measureText(t).width > maxW && line.trim()) { out.push(line.trimEnd()); line = word.trimStart(); }
        else line = t;
      }
      out.push(line);
    }
    return out;
  }

  function rangeRect(r1, c1, r2, c2) {
    const x1 = screenX(c1), y1 = screenY(r1);
    const x2 = screenX(c2 + 1), y2 = screenY(r2 + 1);
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  function paintSelection(theme) {
    const { r1, c1, r2, c2 } = sel;
    ctx.save();
    ctx.beginPath();
    ctx.rect(HDR_W, HDR_H, width - HDR_W, height - HDR_H);
    ctx.clip();
    const R = rangeRect(r1, c1, r2, c2);
    if (r1 !== r2 || c1 !== c2) {
      ctx.fillStyle = 'rgba(31,111,235,0.10)';
      ctx.fillRect(R.x, R.y, R.w, R.h);
      const m = wb.mergeAt(si, sel.r, sel.c);
      const A = m ? rangeRect(m.r1, m.c1, m.r2, m.c2) : rangeRect(sel.r, sel.c, sel.r, sel.c);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(A.x + 1, A.y + 1, A.w - 2, A.h - 2);
      const cell = sheet().cells.get(key(sel.r, sel.c));
      if (cell) {
        // aktif hücreyi yeniden çiz (beyaz kutunun üstüne)
        ctx.save();
        ctx.beginPath(); ctx.rect(A.x, A.y, A.w, A.h); ctx.clip();
        paintCells({ r1: sel.r, r2: sel.r, c1: sel.c, c2: sel.c, x: A.x, y: A.y }, theme, mergeIndex());
        ctx.restore();
      }
    }
    ctx.strokeStyle = theme.sel;
    ctx.lineWidth = 2;
    ctx.strokeRect(R.x + 0.5, R.y + 0.5, R.w - 1, R.h - 1);
    // doldurma tutamacı
    if (!editing) {
      ctx.fillStyle = theme.sel;
      ctx.fillRect(R.x + R.w - 4, R.y + R.h - 4, 7, 7);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
      ctx.strokeRect(R.x + R.w - 4.5, R.y + R.h - 4.5, 8, 8);
    }
    if (copyMarquee) {
      const M = rangeRect(copyMarquee.r1, copyMarquee.c1, copyMarquee.r2, copyMarquee.c2);
      ctx.setLineDash([5, 3]);
      ctx.strokeStyle = theme.sel; ctx.lineWidth = 1.5;
      ctx.strokeRect(M.x + 1, M.y + 1, M.w - 2, M.h - 2);
      ctx.setLineDash([]);
    }
    if (fillPreview) {
      const F = rangeRect(fillPreview.r1, fillPreview.c1, fillPreview.r2, fillPreview.c2);
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = '#666'; ctx.lineWidth = 1;
      ctx.strokeRect(F.x + 0.5, F.y + 0.5, F.w - 1, F.h - 1);
      ctx.setLineDash([]);
    }
    if (editing && editing.refHighlights) {
      editing.refHighlights.forEach((rr, i) => {
        const colr = ['#1f6feb', '#c2185b', '#2e7d32', '#ef6c00', '#6a1b9a', '#00838f'][i % 6];
        const X = rangeRect(rr.r1, rr.c1, rr.r2, rr.c2);
        ctx.strokeStyle = colr; ctx.lineWidth = 1.5;
        ctx.strokeRect(X.x + 1, X.y + 1, X.w - 2, X.h - 2);
      });
    }
    ctx.restore();
  }

  function paintHeaders(theme, firstR, lastR, firstC, lastC) {
    const sh = sheet();
    ctx.font = `12px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // sütun başlıkları
    ctx.fillStyle = theme.hdr;
    ctx.fillRect(0, 0, width, HDR_H);
    ctx.fillRect(0, 0, HDR_W, height);
    const cols = [];
    for (let c = 0; c < sh.freeze.c; c++) cols.push(c);
    for (let c = firstC; c <= lastC; c++) cols.push(c);
    const rows = [];
    for (let r = 0; r < sh.freeze.r; r++) rows.push(r);
    for (let r = firstR; r <= lastR; r++) rows.push(r);
    ctx.save();
    ctx.beginPath(); ctx.rect(HDR_W, 0, width - HDR_W, HDR_H); ctx.clip();
    for (const c of cols) {
      const w = colW(c);
      if (!w) continue;
      const x = screenX(c);
      const inSel = c >= sel.c1 && c <= sel.c2;
      if (inSel) { ctx.fillStyle = theme.hdrSel; ctx.fillRect(x, 0, w, HDR_H); }
      ctx.fillStyle = inSel ? theme.sel : theme.hdrText;
      ctx.fillText(colName(c), x + w / 2, HDR_H / 2 + 1);
      ctx.fillStyle = theme.line;
      ctx.fillRect(Math.round(x + w) - 1, 0, 1, HDR_H);
    }
    ctx.restore();
    ctx.save();
    ctx.beginPath(); ctx.rect(0, HDR_H, HDR_W, height - HDR_H); ctx.clip();
    for (const r of rows) {
      const hh = rowH(r);
      if (!hh) continue;
      const y = screenY(r);
      const inSel = r >= sel.r1 && r <= sel.r2;
      if (inSel) { ctx.fillStyle = theme.hdrSel; ctx.fillRect(0, y, HDR_W, hh); }
      ctx.fillStyle = inSel ? theme.sel : theme.hdrText;
      ctx.fillText(String(r + 1), HDR_W / 2, y + hh / 2 + 1);
      ctx.fillStyle = theme.line;
      ctx.fillRect(0, Math.round(y + hh) - 1, HDR_W, 1);
    }
    ctx.restore();
    ctx.fillStyle = theme.line;
    ctx.fillRect(0, HDR_H - 1, width, 1);
    ctx.fillRect(HDR_W - 1, 0, 1, height);
    // köşe (tümünü seç)
    ctx.fillStyle = theme.hdr;
    ctx.fillRect(0, 0, HDR_W - 1, HDR_H - 1);
    ctx.fillStyle = theme.line;
    ctx.beginPath(); ctx.moveTo(HDR_W - 6, HDR_H - 6); ctx.lineTo(HDR_W - 6, 8); ctx.lineTo(HDR_W - 20, HDR_H - 6); ctx.fill();
  }

  // ---- Seçim ---------------------------------------------------------------------------
  function expandForMerges(s) {
    let { r1, c1, r2, c2 } = s;
    let changed = true, guard = 0;
    while (changed && guard++ < 20) {
      changed = false;
      for (const m of sheet().merges) {
        if (m.r2 < r1 || m.r1 > r2 || m.c2 < c1 || m.c1 > c2) continue;
        if (m.r1 < r1) { r1 = m.r1; changed = true; }
        if (m.c1 < c1) { c1 = m.c1; changed = true; }
        if (m.r2 > r2) { r2 = m.r2; changed = true; }
        if (m.c2 > c2) { c2 = m.c2; changed = true; }
      }
    }
    return { ...s, r1, c1, r2, c2 };
  }

  function select(r, c, extend = false) {
    r = Math.max(0, Math.min(MAX_ROWS - 1, r));
    c = Math.max(0, Math.min(MAX_COLS - 1, c));
    if (extend) {
      sel = expandForMerges({ r: sel.r, c: sel.c, r1: Math.min(sel.r, r), c1: Math.min(sel.c, c), r2: Math.max(sel.r, r), c2: Math.max(sel.c, c) });
    } else {
      const m = wb.mergeAt(si, r, c);
      if (m) { r = m.r1; c = m.c1; sel = { r, c, r1: m.r1, c1: m.c1, r2: m.r2, c2: m.c2 }; }
      else sel = { r, c, r1: r, c1: c, r2: r, c2: c };
    }
    afterSelect(extend ? { r, c } : null);
  }

  function setRange(r1, c1, r2, c2, ar = r1, ac = c1) {
    sel = expandForMerges({ r: ar, c: ac, r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2) });
    afterSelect();
  }

  function afterSelect(focusCell) {
    updateExtent();
    scrollIntoView(focusCell ? focusCell.r : sel.r, focusCell ? focusCell.c : sel.c);
    syncBar();
    updateToolbarState();
    updateStatus();
    draw();
  }

  function scrollIntoView(r, c) {
    const f = frz();
    const fw = frozenW(), fh = frozenH();
    if (c >= f.c) {
      const x = colX(c), w = colW(c);
      const viewW = width - HDR_W - fw;
      if (x - scrollX < fw) scroller.scrollLeft = Math.max(0, x - fw) * zoom;
      else if (x + w - scrollX > fw + viewW) scroller.scrollLeft = (x + w - viewW - fw + 2) * zoom;
    }
    if (r >= f.r) {
      const y = rowY(r), hh = rowH(r);
      const viewH = height - HDR_H - fh;
      if (y - scrollY < fh) scroller.scrollTop = Math.max(0, y - fh) * zoom;
      else if (y + hh - scrollY > fh + viewH) scroller.scrollTop = (y + hh - viewH - fh + 2) * zoom;
    }
    scrollX = scroller.scrollLeft / zoom; scrollY = scroller.scrollTop / zoom;
  }

  function syncBar() {
    const multi = sel.r1 !== sel.r2 || sel.c1 !== sel.c2;
    nameBox.value = multi ? `${addr(sel.r1, sel.c1)}:${addr(sel.r2, sel.c2)}` : addr(sel.r, sel.c);
    if (!editing) barInput.value = rawText(sel.r, sel.c);
  }

  function rawText(r, c) {
    const cell = sheet().cells.get(key(r, c));
    if (!cell) return '';
    if (cell.f != null) return '=' + displayFormula(cell.f);
    const v = cell.v;
    if (v == null) return '';
    if (typeof v === 'number') {
      const z = cell.s && cell.s.z;
      if (z && /[dmyhs]/i.test(z.replace(/"[^"]*"/g, '')) && !/^[#0.,% ]+$/.test(z)) return formatValue(v, z.includes('h') ? (z.includes('d') ? 'dd.mm.yyyy hh:mm' : 'hh:mm') : 'dd.mm.yyyy');
      if (z && z.includes('%')) return numToText(v * 100) + '%';
      return numToText(v);
    }
    if (typeof v === 'boolean') return v ? 'DOĞRU' : 'YANLIŞ';
    if (v instanceof FErr) return v.code;
    const s = String(v);
    if (s[0] === '=' || (parseNumberText(s) != null && !(cell.s && cell.s.z === '@'))) return "'" + s;
    return s;
  }

  // Formüller içeride İngilizce + virgülle saklanır; kullanıcıya da aynı (Excel uyumlu) gösterilir.
  const displayFormula = (f) => f;

  // ---- Düzenleme -------------------------------------------------------------------------
  function startEdit(initial = null, fromBar = false) {
    if (editing) return;
    const { r, c } = sel;
    const m = wb.mergeAt(si, r, c);
    const R = m ? rangeRect(m.r1, m.c1, m.r2, m.c2) : rangeRect(r, c, r, c);
    const cell = sheet().cells.get(key(r, c));
    const s = (cell && cell.s) || {};
    editing = { r, c, fromBar, original: rawText(r, c) };
    const text = initial != null ? initial : editing.original;
    cellEditor.hidden = fromBar;
    cellEditor.value = text;
    barInput.value = text;
    Object.assign(cellEditor.style, {
      zoom: String(zoom),
      left: Math.max(HDR_W, R.x) + 'px', top: Math.max(HDR_H, R.y) + 'px',
      minWidth: Math.max(40, R.w) + 'px', minHeight: Math.max(20, R.h) + 'px',
      font: fontOf(s), color: s.fc || '#000', background: s.bg || '#fff',
      textAlign: s.ha || 'left',
    });
    autoSizeEditor();
    if (!fromBar) {
      cellEditor.focus({ preventScroll: true });
      const n = cellEditor.value.length;
      cellEditor.setSelectionRange(n, n);
    }
    updateRefHighlights();
    draw();
  }

  function autoSizeEditor() {
    cellEditor.style.width = 'auto';
    cellEditor.style.height = 'auto';
    const maxW = width - parseFloat(cellEditor.style.left) - 4;
    cellEditor.style.width = Math.min(maxW, Math.max(parseFloat(cellEditor.style.minWidth), cellEditor.scrollWidth + 8)) + 'px';
    cellEditor.style.height = Math.max(parseFloat(cellEditor.style.minHeight), cellEditor.scrollHeight) + 'px';
  }

  function activeInput() { return editing && editing.fromBar ? barInput : cellEditor; }

  function updateRefHighlights() {
    if (!editing) return;
    const text = activeInput().value;
    if (text[0] !== '=') { editing.refHighlights = null; return; }
    editing.refHighlights = refsInFormula(text.slice(1)).filter((t) => t.sheet == null && (t.kind === 'cell' || t.kind === 'range')).slice(0, 12)
      .map((t) => ({ r1: Math.min(t.r1, t.r2 ?? t.r1), c1: Math.min(t.c1, t.c2 ?? t.c1), r2: Math.max(t.r1, t.r2 ?? t.r1), c2: Math.max(t.c1, t.c2 ?? t.c1) }));
  }

  function commitEdit(move = null) {
    if (!editing) return;
    const text = activeInput().value;
    const { r, c, original } = editing;
    endEdit();
    if (text !== original) writeInput(r, c, text);
    if (move) moveSel(move[0], move[1]);
    else draw();
    focusGrid({ preventScroll: true });
  }
  function endEdit() {
    if (!editing) return;
    editing = null;
    cellEditor.hidden = true;
    acBox.hidden = true;
    syncBar();
    draw();
  }

  function cancelEdit() {
    endEdit();
    focusGrid({ preventScroll: true });
  }

  function writeInput(r, c, text) {
    const old = sheet().cells.get(key(r, c));
    const p = parseInput(text);
    const cell = {};
    let s = old && old.s;
    if (s && s.z === '@' && text !== '' && !p.f) {
      cell.v = text;
    } else if (p.f != null) {
      cell.f = p.f;
    } else if (p.v != null) {
      cell.v = p.v;
      if (p.z && (!s || !s.z || s.z === 'General')) s = Object.freeze({ ...(s || {}), z: p.z });
    }
    if (s) cell.s = s;
    if (/\n/.test(text) && !(s && s.wr)) cell.s = Object.freeze({ ...(cell.s || {}), wr: true });
    wb.setCell(si, r, c, cell);
  }

  // Formül düzenlerken hücreye tıklayınca başvuru ekleme
  function wantsRef() {
    if (!editing) return false;
    const inp = activeInput();
    const v = inp.value;
    if (v[0] !== '=') return false;
    const before = v.slice(0, inp.selectionStart).replace(/\s+$/, '');
    return /[=(,;+\-*/^&<>:]$/.test(before) || editing.refInsert;
  }

  function insertRef(r1, c1, r2, c2) {
    const inp = activeInput();
    const ref = r1 === r2 && c1 === c2 ? addr(r1, c1) : `${addr(Math.min(r1, r2), Math.min(c1, c2))}:${addr(Math.max(r1, r2), Math.max(c1, c2))}`;
    let start = inp.selectionStart, end = inp.selectionEnd;
    if (editing.refInsert) { start = editing.refInsert.start; end = editing.refInsert.end; }
    inp.value = inp.value.slice(0, start) + ref + inp.value.slice(end);
    editing.refInsert = { start, end: start + ref.length };
    const pos = start + ref.length;
    inp.setSelectionRange(pos, pos);
    (inp === cellEditor ? barInput : cellEditor).value = inp.value;
    updateRefHighlights();
    autoSizeEditor();
    draw();
  }

  // İşlev adı otomatik tamamlama
  const ALL_FUNCS = [];
  for (const cat of FUNCTION_LIST) for (const [en, tr, desc] of cat.items) ALL_FUNCS.push({ en, tr, desc });
  const EXTRA = ['SUMIFS', 'COUNTIFS', 'AVERAGEIFS', 'HLOOKUP', 'IFS', 'SWITCH', 'AND', 'OR', 'NOT', 'LEN', 'RIGHT', 'MID', 'LOWER', 'PROPER', 'SUBSTITUTE', 'FIND', 'SEARCH', 'TEXT', 'VALUE', 'NOW', 'DATE', 'YEAR', 'MONTH', 'DAY', 'WEEKDAY', 'EOMONTH', 'NETWORKDAYS', 'ROUNDUP', 'ROUNDDOWN', 'INT', 'ABS', 'MOD', 'POWER', 'SQRT', 'MEDIAN', 'STDEV', 'LARGE', 'SMALL', 'RANK', 'SUMPRODUCT', 'PRODUCT', 'COUNTA', 'COUNTBLANK', 'TEXTJOIN', 'CONCATENATE', 'ISBLANK', 'ISNUMBER', 'ISERROR', 'FV', 'PV', 'NPV', 'RAND', 'RANDBETWEEN', 'TRIM', 'UPPER', 'TODAY', 'DATEDIF', 'MAXIFS', 'MINIFS'];
  for (const e of EXTRA) if (!ALL_FUNCS.some((f) => f.en === e)) ALL_FUNCS.push({ en: e, tr: '', desc: '' });

  function updateAutocomplete() {
    if (!editing) { acBox.hidden = true; return; }
    const inp = activeInput();
    const v = inp.value;
    const pos = inp.selectionStart;
    const m = /([A-Za-zÇĞİÖŞÜçğıöşü_.]+)$/.exec(v.slice(0, pos));
    if (v[0] !== '=' || !m || m[1].length < 1) { acBox.hidden = true; return; }
    const q = m[1].toLocaleUpperCase('tr');
    const qe = m[1].toUpperCase();
    const hits = ALL_FUNCS.filter((f) => f.en.startsWith(qe) || (f.tr && f.tr.startsWith(q))).slice(0, 8);
    if (!hits.length) { acBox.hidden = true; return; }
    clear(acBox);
    hits.forEach((f, i) => {
      const useTr = f.tr && f.tr.startsWith(q) && !f.en.startsWith(qe);
      const b = h('button', { class: 'menu-item' + (i === 0 ? ' active' : ''), type: 'button' },
        h('span', { class: 'menu-label' }, useTr ? f.tr : f.en), f.desc ? h('span', { class: 'menu-hint' }, f.desc) : null);
      b.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const start = pos - m[1].length;
        inp.value = v.slice(0, start) + (useTr ? f.tr : f.en) + '(' + v.slice(pos);
        const p = start + (useTr ? f.tr : f.en).length + 1;
        inp.setSelectionRange(p, p);
        (inp === cellEditor ? barInput : cellEditor).value = inp.value;
        acBox.hidden = true;
        autoSizeEditor();
      });
      acBox.append(b);
    });
    const r = inp.getBoundingClientRect();
    acBox.hidden = false;
    acBox.style.left = r.left + 'px';
    acBox.style.top = r.bottom + 2 + 'px';
  }

  function acAccept() {
    if (acBox.hidden) return false;
    const first = acBox.querySelector('.menu-item.active') || acBox.querySelector('.menu-item');
    if (!first) return false;
    first.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    return true;
  }
  function acMove(d) {
    if (acBox.hidden) return false;
    const items = [...acBox.querySelectorAll('.menu-item')];
    let i = items.findIndex((x) => x.classList.contains('active'));
    items.forEach((x) => x.classList.remove('active'));
    i = (i + d + items.length) % items.length;
    items[i].classList.add('active');
    return true;
  }

  function onEditorInput(e) {
    const src = e.target;
    const other = src === cellEditor ? barInput : cellEditor;
    other.value = src.value;
    if (editing) editing.refInsert = null;
    autoSizeEditor();
    updateRefHighlights();
    updateAutocomplete();
    draw();
  }
  cellEditor.addEventListener('input', onEditorInput);
  barInput.addEventListener('input', (e) => {
    if (!editing) startEdit(barInput.value, true);
    onEditorInput(e);
  });
  barInput.addEventListener('focus', () => { if (!editing) startEdit(null, true); });

  function editorKeydown(e) {
    if (!editing) return;
    if (e.key === 'ArrowDown' && acMove(1)) { e.preventDefault(); return; }
    if (e.key === 'ArrowUp' && acMove(-1)) { e.preventDefault(); return; }
    if ((e.key === 'Tab' || e.key === 'Enter') && !acBox.hidden && acAccept()) { e.preventDefault(); return; }
    if (e.key === 'Enter' && (e.altKey || e.ctrlKey)) {
      e.preventDefault();
      const inp = activeInput();
      const p = inp.selectionStart;
      inp.value = inp.value.slice(0, p) + '\n' + inp.value.slice(inp.selectionEnd);
      inp.setSelectionRange(p + 1, p + 1);
      onEditorInput({ target: inp });
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); commitEdit(e.shiftKey ? [-1, 0] : [1, 0]); return; }
    if (e.key === 'Tab') { e.preventDefault(); commitEdit(e.shiftKey ? [0, -1] : [0, 1]); return; }
    if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); return; }
    // Formül yazarken ok tuşlarıyla başvuru seçme
    if (!editing.fromBar && e.key.startsWith('Arrow') && wantsRef()) {
      e.preventDefault();
      const d = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
      const base = editing.refCursor || { r: editing.r, c: editing.c };
      const nr = Math.max(0, base.r + d[0]), nc = Math.max(0, base.c + d[1]);
      editing.refCursor = { r: nr, c: nc };
      insertRef(nr, nc, nr, nc);
      return;
    }
    if (e.key === 'F4') {
      e.preventDefault();
      toggleAbsolute();
    }
  }
  cellEditor.addEventListener('keydown', editorKeydown);
  barInput.addEventListener('keydown', editorKeydown);
  cellEditor.addEventListener('blur', () => { setTimeout(() => { if (editing && !editing.fromBar && document.activeElement !== barInput && document.activeElement !== cellEditor && !pointerSelecting) commitEdit(); }, 0); });
  barInput.addEventListener('blur', () => { setTimeout(() => { if (editing && editing.fromBar && document.activeElement !== barInput && !pointerSelecting) commitEdit(); }, 0); });

  // F4: A1 → $A$1 → A$1 → $A1 → A1
  function toggleAbsolute() {
    const inp = activeInput();
    const v = inp.value, p = inp.selectionStart;
    const re = /(\$?)([A-Z]{1,3})(\$?)(\d+)/gi;
    let m;
    while ((m = re.exec(v))) {
      if (p >= m.index && p <= m.index + m[0].length) {
        const states = ['', '$$', 'r', 'c']; // '' göreli, '$$' ikisi mutlak, 'r' satır mutlak, 'c' sütun mutlak
        const cur = m[1] && m[3] ? 1 : m[3] ? 2 : m[1] ? 3 : 0;
        const nx = states[(cur + 1) % 4];
        const rep = (nx === '$$' || nx === 'c' ? '$' : '') + m[2] + (nx === '$$' || nx === 'r' ? '$' : '') + m[4];
        inp.value = v.slice(0, m.index) + rep + v.slice(m.index + m[0].length);
        const np = m.index + rep.length;
        inp.setSelectionRange(np, np);
        onEditorInput({ target: inp });
        return;
      }
    }
  }

  // ---- Hücre işlemleri -------------------------------------------------------------------
  function forEachSel(fn) {
    const { r1, c1, r2, c2 } = sel;
    const b = wb.bounds(si);
    const rr2 = Math.min(r2, Math.max(b.maxR, r1)), cc2 = Math.min(c2, Math.max(b.maxC, c1));
    for (let r = r1; r <= rr2; r++) for (let c = c1; c <= cc2; c++) fn(r, c);
  }

  function selIsHuge() { return (sel.r2 - sel.r1 + 1) * (sel.c2 - sel.c1 + 1) > 2000000; }

  function applyStyle(patch) {
    const whole = sel.r2 - sel.r1 > 5000 || sel.c2 - sel.c1 > 500;
    wb.transact(() => {
      const sh = sheet();
      const doCell = (r, c) => {
        const k = key(r, c);
        const cell = sh.cells.get(k);
        const base = (cell && cell.s) || {};
        const ns = { ...base };
        for (const [kk, vv] of Object.entries(typeof patch === 'function' ? patch(base) : patch)) {
          if (vv == null || vv === false) delete ns[kk]; else ns[kk] = vv;
        }
        const s = Object.keys(ns).length ? Object.freeze(ns) : undefined;
        wb.setCell(si, r, c, { ...(cell || {}), s });
      };
      if (whole) forEachSel(doCell);
      else for (let r = sel.r1; r <= sel.r2; r++) for (let c = sel.c1; c <= sel.c2; c++) doCell(r, c);
    });
  }

  function activeStyle() {
    const cell = sheet().cells.get(key(sel.r, sel.c));
    return (cell && cell.s) || {};
  }

  function toggleStyle(k) {
    const on = !activeStyle()[k];
    applyStyle({ [k]: on || null });
  }

  function clearSel(what = 'content') {
    if (selIsHuge()) { toast('Seçim çok büyük.', { type: 'error' }); return; }
    wb.transact(() => {
      forEachSel((r, c) => {
        const cell = sheet().cells.get(key(r, c));
        if (!cell) return;
        if (what === 'content') wb.setCell(si, r, c, cell.s ? { s: cell.s } : null);
        else if (what === 'format') wb.setCell(si, r, c, { v: cell.v, f: cell.f, cv: cell.cv });
        else wb.setCell(si, r, c, null);
      });
    });
  }

  function moveSel(dr, dc, extend = false) {
    if (extend) {
      // aralığın aktif olmayan ucunu hareket ettir
      const er = sel.r === sel.r1 ? sel.r2 : sel.r1;
      const ec = sel.c === sel.c1 ? sel.c2 : sel.c1;
      select(er + dr, ec + dc, true);
      return;
    }
    const m = wb.mergeAt(si, sel.r, sel.c);
    let r = sel.r + dr, c = sel.c + dc;
    if (m) { if (dr > 0) r = m.r2 + 1; if (dc > 0) c = m.c2 + 1; }
    // gizli satır/sütunları atla
    while (dr && r > 0 && r < MAX_ROWS - 1 && rowH(r) === 0) r += dr;
    while (dc && c > 0 && c < MAX_COLS - 1 && colW(c) === 0) c += dc;
    select(r, c);
  }

  function jumpEdge(dr, dc, extend) {
    const sh = sheet();
    const has = (r, c) => { const cell = sh.cells.get(key(r, c)); return !!cell && (cell.v != null || cell.f != null); };
    const b = wb.bounds(si);
    let er = extend ? (sel.r === sel.r1 ? sel.r2 : sel.r1) : sel.r;
    let ec = extend ? (sel.c === sel.c1 ? sel.c2 : sel.c1) : sel.c;
    const limitR = dr > 0 ? Math.max(b.maxR, er) : 0, limitC = dc > 0 ? Math.max(b.maxC, ec) : 0;
    const step = () => { er += dr; ec += dc; };
    const inside = () => er >= 0 && ec >= 0 && (dr <= 0 || er <= limitR) && (dc <= 0 || ec <= limitC) && (dr >= 0 || er >= 0) && (dc >= 0 || ec >= 0);
    const startFilled = has(er, ec);
    step();
    if (!inside()) { er = Math.max(0, Math.min(er, dr > 0 ? limitR : er)); ec = Math.max(0, Math.min(ec, dc > 0 ? limitC : ec)); }
    else if (startFilled && has(er, ec)) {
      while (inside() && has(er + dr, ec + dc) && er + dr >= 0 && ec + dc >= 0) step();
    } else {
      while (inside() && !has(er, ec)) step();
      if (!inside()) { er = Math.max(0, Math.min(er - dr, limitR)); ec = Math.max(0, Math.min(ec - dc, limitC)); if (dr > 0 || dc > 0) { er = dr > 0 ? limitR : er; ec = dc > 0 ? limitC : ec; } }
    }
    select(Math.max(0, er), Math.max(0, ec), extend);
  }

  // ---- Pano ---------------------------------------------------------------------------------
  let copyMarquee = null;
  function selectionToText() {
    const rows = [];
    for (let r = sel.r1; r <= Math.min(sel.r2, sel.r1 + 100000); r++) {
      const row = [];
      for (let c = sel.c1; c <= Math.min(sel.c2, sel.c1 + 1000); c++) {
        const cell = sheet().cells.get(key(r, c));
        if (!cell) { row.push(''); continue; }
        const { text } = cellDisplay(r, c, cell);
        row.push(/[\t\n"]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text);
      }
      rows.push(row.join('\t'));
    }
    return rows.join('\r\n');
  }

  function selectionToHtml() {
    const t = document.createElement('table');
    for (let r = sel.r1; r <= Math.min(sel.r2, sel.r1 + 5000); r++) {
      const tr = document.createElement('tr');
      for (let c = sel.c1; c <= Math.min(sel.c2, sel.c1 + 200); c++) {
        const td = document.createElement('td');
        const cell = sheet().cells.get(key(r, c));
        if (cell) { const { text, v } = cellDisplay(r, c, cell); td.textContent = text; applyCellCss(td.style, cell.s || {}, v); }
        tr.append(td);
      }
      t.append(tr);
    }
    return t.outerHTML;
  }

  function doCopy(cut = false) {
    if (selIsHuge()) { toast('Seçim kopyalamak için çok büyük.', { type: 'error' }); return null; }
    const cells = [];
    for (let r = sel.r1; r <= sel.r2; r++) {
      const row = [];
      for (let c = sel.c1; c <= sel.c2; c++) row.push(sheet().cells.get(key(r, c)));
      cells.push(row);
    }
    const text = selectionToText();
    clip = { si, r1: sel.r1, c1: sel.c1, r2: sel.r2, c2: sel.c2, cells, text, cut, merges: sheet().merges.filter((m) => m.r1 >= sel.r1 && m.r2 <= sel.r2 && m.c1 >= sel.c1 && m.c2 <= sel.c2) };
    copyMarquee = { r1: sel.r1, c1: sel.c1, r2: sel.r2, c2: sel.c2 };
    draw();
    return { text, html: selectionToHtml() };
  }

  function pasteInternal(onlyValues = false) {
    if (!clip) return;
    const R = clip.r2 - clip.r1 + 1, C = clip.c2 - clip.c1 + 1;
    // Seçim kopyanın katıysa tekrarla (Excel davranışı)
    const selR = sel.r2 - sel.r1 + 1, selC = sel.c2 - sel.c1 + 1;
    const repR = selR % R === 0 && selR > R ? selR / R : 1;
    const repC = selC % C === 0 && selC > C ? selC / C : 1;
    wb.transact(() => {
      if (clip.cut) {
        for (let r = clip.r1; r <= clip.r2; r++) for (let c = clip.c1; c <= clip.c2; c++) {
          if (clip.si === si && r >= sel.r1 && r < sel.r1 + R && c >= sel.c1 && c < sel.c1 + C) continue;
          wb.setCell(clip.si, r, c, null);
        }
      }
      for (let ir = 0; ir < repR; ir++) for (let ic = 0; ic < repC; ic++) {
        const br = sel.r1 + ir * R, bc = sel.c1 + ic * C;
        clip.cells.forEach((row, i) => row.forEach((cell, j) => {
          const r = br + i, c = bc + j;
          if (!cell) { wb.setCell(si, r, c, null); return; }
          if (onlyValues) {
            const v = cell.f != null ? wb.value(clip.si, clip.r1 + i, clip.c1 + j) : cell.v;
            const old = sheet().cells.get(key(r, c));
            wb.setCell(si, r, c, { v: v instanceof FErr ? v : v, s: old && old.s });
            return;
          }
          const nc = { ...cell };
          if (cell.f != null && !clip.cut) { nc.f = shiftFormula(cell.f, r - (clip.r1 + i), c - (clip.c1 + j)); delete nc.cv; }
          wb.setCell(si, r, c, nc);
        }));
      }
    });
    if (clip.merges.length && !onlyValues) {
      const dr = sel.r1 - clip.r1, dc = sel.c1 - clip.c1;
      for (const m of clip.merges) wb.setMerge(si, { r1: m.r1 + dr, c1: m.c1 + dc, r2: m.r2 + dr, c2: m.c2 + dc }, true);
    }
    setRange(sel.r1, sel.c1, sel.r1 + R * repR - 1, sel.c1 + C * repC - 1);
    if (clip.cut) { clip = null; copyMarquee = null; }
  }

  function parseTsv(text) {
    const rows = [];
    let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; continue; }
      if (ch === '"' && f === '') { q = true; continue; }
      if (ch === '\t') { row.push(f); f = ''; continue; }
      if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; continue; }
      f += ch;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows;
  }

  function pasteText(text) {
    const rows = parseTsv(text.replace(/\r?\n$/, ''));
    if (!rows.length) return;
    if (rows.length * Math.max(...rows.map((r) => r.length)) > 500000) { toast('Yapıştırılan veri çok büyük.', { type: 'error' }); return; }
    wb.transact(() => {
      rows.forEach((row, i) => row.forEach((val, j) => writeInput(sel.r1 + i, sel.c1 + j, val)));
    });
    setRange(sel.r1, sel.c1, sel.r1 + rows.length - 1, sel.c1 + Math.max(...rows.map((r) => r.length)) - 1);
  }

  function pasteHtml(html) {
    // DOMParser ile oluşturulan belge etkisizdir (betik çalışmaz); yalnızca metinleri okuruz.
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const table = doc.querySelector('table');
    if (!table) return false;
    const rows = [];
    for (const tr of table.querySelectorAll('tr')) rows.push([...tr.children].filter((x) => /^T[DH]$/.test(x.tagName)).map((td) => td.textContent.replace(/\u00a0/g, ' ').trim()));
    if (!rows.length) return false;
    pasteText(rows.map((r) => r.map((v) => (/[\t\n"]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v)).join('\t')).join('\n'));
    return true;
  }

  const onCopy = (e) => {
    if (editing || !root.contains(document.activeElement)) return;
    const r = doCopy(false);
    if (!r) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', r.text);
    e.clipboardData.setData('text/html', r.html);
  };
  const onCut = (e) => {
    if (editing || !root.contains(document.activeElement)) return;
    const r = doCopy(true);
    if (!r) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', r.text);
    e.clipboardData.setData('text/html', r.html);
  };
  const onPaste = (e) => {
    if (editing || !root.contains(document.activeElement) || document.activeElement === barInput || document.activeElement === nameBox) return;
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    if (clip && text === clip.text) { pasteInternal(); return; }
    clip = null; copyMarquee = null;
    const html = e.clipboardData.getData('text/html');
    if (html && pasteHtml(html)) return;
    if (text) pasteText(text);
  };
  document.addEventListener('copy', onCopy);
  document.addEventListener('cut', onCut);
  document.addEventListener('paste', onPaste);

  async function menuCopy(cut) {
    const r = doCopy(cut);
    if (!r) return;
    try { await navigator.clipboard.writeText(r.text); } catch { /* sistem panosu yoksa dahili pano yeterli */ }
    toast(cut ? 'Kesildi' : 'Kopyalandı');
  }
  async function menuPaste(onlyValues = false) {
    let text = null;
    try { text = await navigator.clipboard.readText(); } catch { text = null; }
    if (clip && (text == null || text === clip.text)) { pasteInternal(onlyValues); return; }
    if (text) { clip = null; copyMarquee = null; pasteText(text); }
    else toast('Pano boş veya erişim izni yok. Ctrl+V kullanın.', { type: 'error' });
  }

  // ---- Doldurma -------------------------------------------------------------------------------
  let fillPreview = null;
  function fillTo(target) {
    const src = { r1: sel.r1, c1: sel.c1, r2: sel.r2, c2: sel.c2 };
    const vertical = target.r2 > src.r2 || target.r1 < src.r1;
    wb.transact(() => {
      if (vertical) {
        for (let c = src.c1; c <= src.c2; c++) {
          const seq = [];
          for (let r = src.r1; r <= src.r2; r++) seq.push({ r, cell: sheet().cells.get(key(r, c)) });
          const series = numericSeries(seq.map((x) => x.cell));
          const down = target.r2 > src.r2;
          const from = down ? src.r2 + 1 : target.r1, to = down ? target.r2 : src.r1 - 1;
          for (let r = from; r <= to; r++) {
            const off = down ? r - src.r1 : r - src.r1;
            const idx = ((off % seq.length) + seq.length) % seq.length;
            const base = seq[idx];
            writeFilled(r, c, base, r - base.r, 0, series ? series(off) : null);
          }
        }
      } else {
        for (let r = src.r1; r <= src.r2; r++) {
          const seq = [];
          for (let c = src.c1; c <= src.c2; c++) seq.push({ c, cell: sheet().cells.get(key(r, c)) });
          const series = numericSeries(seq.map((x) => x.cell));
          const right = target.c2 > src.c2;
          const from = right ? src.c2 + 1 : target.c1, to = right ? target.c2 : src.c1 - 1;
          for (let c = from; c <= to; c++) {
            const off = c - src.c1;
            const idx = ((off % seq.length) + seq.length) % seq.length;
            const base = seq[idx];
            writeFilled(r, c, base, 0, c - base.c, series ? series(off) : null);
          }
        }
      }
    });
    setRange(target.r1, target.c1, target.r2, target.c2, sel.r, sel.c);
  }

  function writeFilled(r, c, base, dr, dc, seriesVal) {
    const cell = base.cell;
    if (!cell) { wb.setCell(si, r, c, null); return; }
    if (cell.f != null) { wb.setCell(si, r, c, { f: shiftFormula(cell.f, dr, dc), s: cell.s }); return; }
    if (seriesVal != null) { wb.setCell(si, r, c, { v: seriesVal, s: cell.s }); return; }
    if (typeof cell.v === 'string') {
      // "Ürün 1" -> "Ürün 2" gibi metin + sayı dizileri
      const m = /^(.*?)(\d+)$/.exec(cell.v);
      const step = dr || dc;
      if (m && !/^\d+$/.test(cell.v)) { wb.setCell(si, r, c, { v: m[1] + (parseInt(m[2], 10) + step), s: cell.s }); return; }
      const lists = [['Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi', 'Pazar'], ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'], ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'], ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'], ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'], ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']];
      for (const L of lists) {
        const i = L.findIndex((x) => x.toLocaleLowerCase('tr') === cell.v.toLocaleLowerCase('tr'));
        if (i >= 0) { wb.setCell(si, r, c, { v: L[(((i + step) % L.length) + L.length) % L.length], s: cell.s }); return; }
      }
    }
    wb.setCell(si, r, c, { v: cell.v, s: cell.s });
  }

  // Seçimdeki sayılar doğrusal bir dizi oluşturuyorsa devamını üretir.
  function numericSeries(cells) {
    const nums = cells.map((c) => (c && c.f == null && typeof c.v === 'number' ? c.v : null));
    if (nums.some((n) => n == null)) return null;
    if (nums.length === 1) return null; // tek sayı: kopyala (Excel gibi)
    const step = (nums[nums.length - 1] - nums[0]) / (nums.length - 1);
    for (let i = 1; i < nums.length; i++) if (Math.abs(nums[i] - nums[i - 1] - step) > 1e-9) return null;
    return (off) => nums[0] + step * off;
  }

  function fillDirection(dir) {
    if (dir === 'down' && sel.r2 > sel.r1) {
      const src = { ...sel };
      sel = { ...sel, r2: sel.r1 };
      fillTo({ r1: src.r1, c1: src.c1, r2: src.r2, c2: src.c2 });
    } else if (dir === 'right' && sel.c2 > sel.c1) {
      const src = { ...sel };
      sel = { ...sel, c2: sel.c1 };
      fillTo({ r1: src.r1, c1: src.c1, r2: src.r2, c2: src.c2 });
    } else toast('Önce doldurulacak alanı seçin (ilk satır/sütun kaynak olur).');
  }

  // ---- Fare ve dokunma -----------------------------------------------------------------------------
  let pointerSelecting = false;
  let drag = null;
  let lastTap = { t: 0, r: -1, c: -1 };
  let longPress = null;

  function hitTest(x, y) {
    if (x < HDR_W && y < HDR_H) return { area: 'corner' };
    if (y < HDR_H) {
      const c = colAtX(x);
      const edge = screenX(c + 1);
      const prevEdge = screenX(c);
      if (Math.abs(x - edge) <= 4) return { area: 'colResize', c };
      if (c > 0 && Math.abs(x - prevEdge) <= 4) return { area: 'colResize', c: c - 1 };
      return { area: 'colHdr', c };
    }
    if (x < HDR_W) {
      const r = rowAtY(y);
      const edge = screenY(r + 1);
      const prevEdge = screenY(r);
      if (Math.abs(y - edge) <= 3) return { area: 'rowResize', r };
      if (r > 0 && Math.abs(y - prevEdge) <= 3) return { area: 'rowResize', r: r - 1 };
      return { area: 'rowHdr', r };
    }
    const R = rangeRect(sel.r1, sel.c1, sel.r2, sel.c2);
    if (Math.abs(x - (R.x + R.w)) <= 6 && Math.abs(y - (R.y + R.h)) <= 6) return { area: 'fill' };
    return { area: 'cell', r: rowAtY(y), c: colAtX(x) };
  }

  function localXY(e) {
    const rect = gridWrap.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / zoom, y: (e.clientY - rect.top) / zoom };
  }

  scroller.addEventListener('pointerdown', (e) => {
    if (e.button === 2) return;
    // Kaydırma çubuğuna tıklanınca hücre seçme
    const { x, y } = localXY(e);
    if (x * zoom > scroller.clientWidth || y * zoom > scroller.clientHeight) return;
    const hit = hitTest(x, y);
    const touch = e.pointerType === 'touch';
    if (touch) {
      // Dokunmada kaydırma tarayıcıya bırakılır; seçim dokunma bitince yapılır.
      drag = { touch: true, x0: e.clientX, y0: e.clientY, hit, moved: false };
      clearTimeout(longPress);
      longPress = setTimeout(() => {
        if (drag && !drag.moved) {
          if (hit.area === 'cell' && !(hit.r >= sel.r1 && hit.r <= sel.r2 && hit.c >= sel.c1 && hit.c <= sel.c2)) select(hit.r, hit.c);
          drag = null;
          contextMenu({ x: e.clientX, y: e.clientY });
        }
      }, 550);
      return;
    }
    e.preventDefault();
    if (editing && hit.area === 'cell' && wantsRef()) {
      pointerSelecting = true;
      drag = { mode: 'ref', r0: hit.r, c0: hit.c };
      insertRef(hit.r, hit.c, hit.r, hit.c);
      scroller.setPointerCapture(e.pointerId);
      return;
    }
    if (editing) commitEdit();
    focusGrid({ preventScroll: true });
    scroller.setPointerCapture(e.pointerId);
    if (hit.area === 'corner') { setRange(0, 0, MAX_ROWS - 1, MAX_COLS - 1, 0, 0); return; }
    if (hit.area === 'colResize') { drag = { mode: 'colResize', c: hit.c, x0: x, w0: colW(hit.c) }; return; }
    if (hit.area === 'rowResize') { drag = { mode: 'rowResize', r: hit.r, y0: y, h0: rowH(hit.r) }; return; }
    if (hit.area === 'colHdr') {
      if (e.shiftKey) setRange(0, Math.min(sel.c, hit.c), MAX_ROWS - 1, Math.max(sel.c, hit.c), sel.r, sel.c);
      else setRange(0, hit.c, MAX_ROWS - 1, hit.c, Math.max(0, rowAtY(HDR_H + frozenH())), hit.c);
      drag = { mode: 'cols', c0: hit.c };
      return;
    }
    if (hit.area === 'rowHdr') {
      if (e.shiftKey) setRange(Math.min(sel.r, hit.r), 0, Math.max(sel.r, hit.r), MAX_COLS - 1, sel.r, sel.c);
      else setRange(hit.r, 0, hit.r, MAX_COLS - 1, hit.r, Math.max(0, colAtX(HDR_W + frozenW())));
      drag = { mode: 'rows', r0: hit.r };
      return;
    }
    if (hit.area === 'fill') { drag = { mode: 'fill' }; return; }
    if (e.shiftKey) select(hit.r, hit.c, true);
    else select(hit.r, hit.c);
    drag = { mode: 'cells' };
    pointerSelecting = true;
  });

  scroller.addEventListener('pointermove', (e) => {
    const { x, y } = localXY(e);
    if (!drag) {
      if (e.pointerType === 'mouse') {
        const hit = hitTest(x, y);
        scroller.style.cursor = hit.area === 'colResize' ? 'col-resize' : hit.area === 'rowResize' ? 'row-resize' : hit.area === 'fill' ? 'crosshair' : hit.area === 'colHdr' ? 's-resize' : hit.area === 'rowHdr' ? 'e-resize' : 'cell';
      }
      return;
    }
    if (drag.touch) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 8) { drag.moved = true; clearTimeout(longPress); }
      return;
    }
    autoScroll(x, y);
    const r = rowAtY(Math.max(HDR_H, y)), c = colAtX(Math.max(HDR_W, x));
    if (drag.mode === 'cells') { if (r !== sel.r2 || c !== sel.c2 || true) { sel = expandForMerges({ r: sel.r, c: sel.c, r1: Math.min(sel.r, r), c1: Math.min(sel.c, c), r2: Math.max(sel.r, r), c2: Math.max(sel.c, c) }); syncBar(); updateStatus(); draw(); } }
    else if (drag.mode === 'ref') insertRef(drag.r0, drag.c0, r, c);
    else if (drag.mode === 'cols') { sel = { ...sel, c1: Math.min(drag.c0, c), c2: Math.max(drag.c0, c) }; syncBar(); draw(); }
    else if (drag.mode === 'rows') { sel = { ...sel, r1: Math.min(drag.r0, r), r2: Math.max(drag.r0, r) }; syncBar(); draw(); }
    else if (drag.mode === 'colResize') { drag.w = Math.max(8, drag.w0 + (x - drag.x0)); sheet().colW.set(drag.c, drag.w); buildSizeCache(); draw(); }
    else if (drag.mode === 'rowResize') { drag.h = Math.max(8, drag.h0 + (y - drag.y0)); sheet().rowH.set(drag.r, drag.h); buildSizeCache(); draw(); }
    else if (drag.mode === 'fill') {
      const dRow = r > sel.r2 ? r - sel.r2 : r < sel.r1 ? r - sel.r1 : 0;
      const dCol = c > sel.c2 ? c - sel.c2 : c < sel.c1 ? c - sel.c1 : 0;
      if (Math.abs(dRow) >= Math.abs(dCol) && dRow) fillPreview = { r1: Math.min(sel.r1, r), r2: Math.max(sel.r2, r), c1: sel.c1, c2: sel.c2 };
      else if (dCol) fillPreview = { r1: sel.r1, r2: sel.r2, c1: Math.min(sel.c1, c), c2: Math.max(sel.c2, c) };
      else fillPreview = null;
      draw();
    }
  });

  let autoScrollTimer = null;
  function autoScroll(x, y) {
    clearInterval(autoScrollTimer);
    const dx = x > width - 20 ? 20 : x < HDR_W ? -20 : 0;
    const dy = y > height - 20 ? 20 : y < HDR_H ? -20 : 0;
    if (dx || dy) autoScrollTimer = setInterval(() => { scroller.scrollLeft += dx; scroller.scrollTop += dy; }, 40);
  }

  function endPointer(e) {
    clearInterval(autoScrollTimer);
    clearTimeout(longPress);
    const d = drag;
    drag = null;
    pointerSelecting = false;
    if (!d) return;
    if (d.touch) {
      if (d.moved) return;
      const hit = d.hit;
      const now = Date.now();
      if (editing && hit.area === 'cell' && wantsRef()) { insertRef(hit.r, hit.c, hit.r, hit.c); return; }
      if (editing) commitEdit();
      if (hit.area === 'cell') {
        const dbl = now - lastTap.t < 350 && lastTap.r === hit.r && lastTap.c === hit.c;
        lastTap = { t: now, r: hit.r, c: hit.c };
        select(hit.r, hit.c);
        if (dbl) startEdit();
      } else if (hit.area === 'colHdr') setRange(0, hit.c, MAX_ROWS - 1, hit.c, 0, hit.c);
      else if (hit.area === 'rowHdr') setRange(hit.r, 0, hit.r, MAX_COLS - 1, hit.r, 0);
      else if (hit.area === 'corner') setRange(0, 0, MAX_ROWS - 1, MAX_COLS - 1, 0, 0);
      return;
    }
    if (d.mode === 'colResize' && d.w != null) {
      const cols = sel.r1 === 0 && sel.r2 === MAX_ROWS - 1 && d.c >= sel.c1 && d.c <= sel.c2 ? range(sel.c1, sel.c2) : [d.c];
      sheet().colW.set(d.c, d.w0);
      wb.setSize(si, 'col', cols, d.w);
    } else if (d.mode === 'rowResize' && d.h != null) {
      const rows = sel.c1 === 0 && sel.c2 === MAX_COLS - 1 && d.r >= sel.r1 && d.r <= sel.r2 ? range(sel.r1, sel.r2) : [d.r];
      if (d.h0 === DEF_H) sheet().rowH.delete(d.r); else sheet().rowH.set(d.r, d.h0);
      wb.setSize(si, 'row', rows, d.h);
    } else if (d.mode === 'fill' && fillPreview) {
      const t = fillPreview;
      fillPreview = null;
      fillTo(t);
    } else if (d.mode === 'cells') {
      afterSelect({ r: sel.r2 === sel.r ? sel.r1 : sel.r2, c: sel.c2 === sel.c ? sel.c1 : sel.c2 });
    } else if (d.mode === 'ref') {
      activeInput().focus({ preventScroll: true });
    }
    fillPreview = null;
    draw();
    void e;
  }
  scroller.addEventListener('pointerup', endPointer);
  scroller.addEventListener('pointercancel', () => { clearTimeout(longPress); drag = null; pointerSelecting = false; clearInterval(autoScrollTimer); fillPreview = null; draw(); });

  const range = (a, b) => { const o = []; for (let i = a; i <= b && o.length < 20000; i++) o.push(i); return o; };

  scroller.addEventListener('dblclick', (e) => {
    const { x, y } = localXY(e);
    const hit = hitTest(x, y);
    if (hit.area === 'colResize') autoFitCol(hit.c);
    else if (hit.area === 'cell') startEdit();
  });

  scroller.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const { x, y } = localXY(e);
    const hit = hitTest(x, y);
    if (hit.area === 'cell' && !(hit.r >= sel.r1 && hit.r <= sel.r2 && hit.c >= sel.c1 && hit.c <= sel.c2)) select(hit.r, hit.c);
    else if (hit.area === 'colHdr' && !(hit.c >= sel.c1 && hit.c <= sel.c2 && sel.r1 === 0 && sel.r2 === MAX_ROWS - 1)) setRange(0, hit.c, MAX_ROWS - 1, hit.c, 0, hit.c);
    else if (hit.area === 'rowHdr' && !(hit.r >= sel.r1 && hit.r <= sel.r2 && sel.c1 === 0 && sel.c2 === MAX_COLS - 1)) setRange(hit.r, 0, hit.r, MAX_COLS - 1, hit.r, 0);
    contextMenu({ x: e.clientX, y: e.clientY });
  });

  scroller.addEventListener('scroll', () => {
    scrollX = scroller.scrollLeft / zoom;
    scrollY = scroller.scrollTop / zoom;
    const nearR = rowAtY(height) > extentR - 30, nearC = colAtX(width) > extentC - 5;
    if (nearR || nearC) updateExtent();
    if (editing && !editing.fromBar) positionEditor();
    draw();
  }, { passive: true });

  // Dokunmatik seçim tutamacı: seçimi genişletmek için sürüklenir.
  function positionHandle() {
    if (!isTouchUI()) { touchHandle.hidden = true; return; }
    const R = rangeRect(sel.r1, sel.c1, sel.r2, sel.c2);
    const x = R.x + R.w, y = R.y + R.h;
    touchHandle.hidden = editing != null || x < HDR_W || y < HDR_H || x > width || y > height;
    touchHandle.style.transform = `translate(${x * zoom - 11}px, ${y * zoom - 11}px)`;
  }
  const isTouchUI = () => window.matchMedia('(pointer: coarse)').matches;
  touchHandle.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    touchHandle.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const { x, y } = localXY(ev);
      const r = rowAtY(Math.max(HDR_H, y)), c = colAtX(Math.max(HDR_W, x));
      sel = expandForMerges({ r: sel.r, c: sel.c, r1: Math.min(sel.r, r), c1: Math.min(sel.c, c), r2: Math.max(sel.r, r), c2: Math.max(sel.c, c) });
      autoScroll(x, y);
      syncBar(); updateStatus(); draw();
    };
    const up = () => { clearInterval(autoScrollTimer); touchHandle.removeEventListener('pointermove', move); touchHandle.removeEventListener('pointerup', up); updateToolbarState(); };
    touchHandle.addEventListener('pointermove', move);
    touchHandle.addEventListener('pointerup', up);
  });

  function positionEditor() {
    const m = wb.mergeAt(si, editing.r, editing.c);
    const R = m ? rangeRect(m.r1, m.c1, m.r2, m.c2) : rangeRect(editing.r, editing.c, editing.r, editing.c);
    cellEditor.style.left = Math.max(HDR_W, R.x) + 'px';
    cellEditor.style.top = Math.max(HDR_H, R.y) + 'px';
  }

  function autoFitCol(c) {
    const sh = sheet();
    let max = 30;
    const b = wb.bounds(si);
    let n = 0;
    for (let r = 0; r <= b.maxR && n < 5000; r++) {
      const cell = sh.cells.get(key(r, c));
      if (!cell) continue;
      n++;
      const { text } = cellDisplay(r, c, cell);
      ctx.font = fontOf(cell.s);
      max = Math.max(max, ctx.measureText(text).width + 12);
    }
    wb.setSize(si, 'col', [c], Math.min(600, Math.ceil(max)));
  }

  // ---- Klavye -------------------------------------------------------------------------------
  function focusGrid(opts = { preventScroll: true }) {
    if (window.matchMedia('(pointer: coarse)').matches) scroller.focus(opts);
    else keySink.focus(opts);
  }
  keySink.addEventListener('input', (e) => {
    if (e.isComposing || editing) return;
    const v = keySink.value;
    keySink.value = '';
    if (v) startEdit(v);
  });
  keySink.addEventListener('compositionend', () => {
    const v = keySink.value;
    keySink.value = '';
    if (v && !editing) startEdit(v);
  });
  const gridKeydown = (e) => {
    if (editing || e.isComposing) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (arrows[k]) {
      e.preventDefault();
      if (mod) jumpEdge(...arrows[k], e.shiftKey);
      else moveSel(...arrows[k], e.shiftKey);
      return;
    }
    if (k === 'Enter') {
      e.preventDefault();
      if (sel.r1 !== sel.r2 || sel.c1 !== sel.c2) cycleInSelection(e.shiftKey ? -1 : 1, 'row');
      else moveSel(e.shiftKey ? -1 : 1, 0);
      return;
    }
    if (k === 'Tab') {
      e.preventDefault();
      if (sel.r1 !== sel.r2 || sel.c1 !== sel.c2) cycleInSelection(e.shiftKey ? -1 : 1, 'col');
      else moveSel(0, e.shiftKey ? -1 : 1);
      return;
    }
    if (k === 'F2') { e.preventDefault(); startEdit(); return; }
    if (k === 'Delete' || k === 'Backspace') {
      e.preventDefault();
      if (k === 'Backspace' && sel.r1 === sel.r2 && sel.c1 === sel.c2) { startEdit(''); return; }
      clearSel('content');
      return;
    }
    if (k === 'Escape') { copyMarquee = null; clip = clip && !clip.cut ? clip : null; draw(); return; }
    if (k === 'PageDown' || k === 'PageUp') {
      e.preventDefault();
      const rows = Math.max(1, Math.floor((height - HDR_H) / DEF_H) - 1);
      if (mod) { switchSheet(Math.max(0, Math.min(wb.sheets.length - 1, si + (k === 'PageDown' ? 1 : -1)))); return; }
      moveSel(k === 'PageDown' ? rows : -rows, 0, e.shiftKey);
      return;
    }
    if (k === 'Home') { e.preventDefault(); if (mod) select(0, 0, e.shiftKey); else select(sel.r, 0, e.shiftKey); return; }
    if (k === 'End' && mod) { e.preventDefault(); const b = wb.bounds(si); select(Math.max(0, b.maxR), Math.max(0, b.maxC), e.shiftKey); return; }
    if (mod) {
      const kk = k.toLowerCase();
      if (kk === 'z') { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); return; }
      if (kk === 'y') { e.preventDefault(); doRedo(); return; }
      if (kk === 'b' || kk === 'k') { e.preventDefault(); toggleStyle('b'); return; }
      if (kk === 'i') { e.preventDefault(); toggleStyle('i'); return; }
      if (kk === 'u') { e.preventDefault(); toggleStyle('u'); return; }
      if (kk === 'a') { e.preventDefault(); setRange(0, 0, MAX_ROWS - 1, MAX_COLS - 1, sel.r, sel.c); return; }
      if (kk === 'd') { e.preventDefault(); fillDirection('down'); return; }
      if (kk === 'r') { e.preventDefault(); fillDirection('right'); return; }
      if (kk === 'f' || kk === 'h') { e.preventDefault(); openFind(); return; }
      if (kk === 'p' && canPrint()) { e.preventDefault(); doPrint(); return; }
      if (k === ';') { e.preventDefault(); const d = new Date(); writeInput(sel.r, sel.c, `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`); draw(); return; }
      return;
    }
    if (k.length === 1 && !e.altKey) {
      e.preventDefault();
      startEdit(k);
    }
  };
  scroller.addEventListener('keydown', gridKeydown);
  keySink.addEventListener('keydown', gridKeydown);

  function cycleInSelection(d, dir) {
    let { r, c } = sel;
    if (dir === 'row') {
      r += d;
      if (r > sel.r2) { r = sel.r1; c = c + 1 > sel.c2 ? sel.c1 : c + 1; }
      if (r < sel.r1) { r = sel.r2; c = c - 1 < sel.c1 ? sel.c2 : c - 1; }
    } else {
      c += d;
      if (c > sel.c2) { c = sel.c1; r = r + 1 > sel.r2 ? sel.r1 : r + 1; }
      if (c < sel.c1) { c = sel.c2; r = r - 1 < sel.r1 ? sel.r2 : r - 1; }
    }
    sel = { ...sel, r, c };
    scrollIntoView(r, c);
    syncBar();
    draw();
  }

  nameBox.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = nameBox.value.trim();
      const parts = v.split(':');
      const a = parseAddr(parts[0]);
      const b = parts[1] ? parseAddr(parts[1]) : a;
      if (a && b) { setRange(a.r, a.c, b.r, b.c, a.r, a.c); focusGrid(); }
      else {
        const nr = wb.resolveName(v);
        if (nr && nr.si === si) { setRange(nr.r1, nr.c1, nr.r2, nr.c2); focusGrid(); }
        else toast('Geçersiz hücre adresi. Örnek: B5 veya A1:C10', { type: 'error' });
      }
    } else if (e.key === 'Escape') { syncBar(); focusGrid(); }
  });
  nameBox.addEventListener('focus', () => nameBox.select());

  // ---- Geri al / yinele ----------------------------------------------------------------------
  function doUndo() { if (editing) cancelEdit(); if (wb.undo()) { si = Math.min(si, wb.sheets.length - 1); afterStructure(); } }
  function doRedo() { if (editing) cancelEdit(); if (wb.redo()) { si = Math.min(si, wb.sheets.length - 1); afterStructure(); } }

  function afterStructure() {
    buildSizeCache();
    rebuildCovered();
    renderTabs();
    updateExtent();
    syncBar();
    updateToolbarState();
    updateStatus();
    draw();
  }

  wb.onChange = () => {
    app.markDirty();
    buildSizeCache();
    rebuildCovered();
    updateStatus();
    syncBar();
    draw();
  };

  // ---- Durum çubuğu ---------------------------------------------------------------------------
  function updateStatus() {
    const multi = sel.r1 !== sel.r2 || sel.c1 !== sel.c2;
    clear(statusSum);
    if (!multi) return;
    if (selIsHuge() && (sel.r2 - sel.r1) * (sel.c2 - sel.c1) > 5e6) {
      const b = wb.bounds(si);
      if (b.maxR < 0) return;
    }
    let sum = 0, count = 0, nums = 0;
    const r2 = Math.min(sel.r2, wb.bounds(si).maxR), c2 = Math.min(sel.c2, wb.bounds(si).maxC);
    let scanned = 0;
    for (let r = sel.r1; r <= r2 && scanned < 300000; r++) for (let c = sel.c1; c <= c2; c++, scanned++) {
      const cell = sheet().cells.get(key(r, c));
      if (!cell) continue;
      const v = cell.f != null ? wb.value(si, r, c) : cell.v;
      if (v == null || v === '') continue;
      count++;
      if (typeof v === 'number') { nums++; sum += v; }
    }
    const fmt = (n) => formatValue(n, Number.isInteger(n) ? '#,##0' : '#,##0.00');
    if (nums) statusSum.append(h('span', null, `Ortalama: ${fmt(sum / nums)}`), h('span', null, `Sayım: ${count}`), h('span', null, `Toplam: ${fmt(sum)}`));
    else if (count) statusSum.append(h('span', null, `Sayım: ${count}`));
  }

  // ---- Sayfa sekmeleri ------------------------------------------------------------------------
  function switchSheet(i) {
    if (editing) commitEdit();
    si = i;
    wb.active = i;
    sel = { r: 0, c: 0, r1: 0, c1: 0, r2: 0, c2: 0 };
    scroller.scrollLeft = 0; scroller.scrollTop = 0; scrollX = 0; scrollY = 0;
    copyMarquee = null;
    afterStructure();
    app.markDirty();
  }

  function renderTabs() {
    clear(tabs);
    tabs.append(tbtn('plus', 'Yeni sayfa', () => { const i = wb.addSheet(); switchSheet(i); }, { cls: 'tab-add' }));
    wb.sheets.forEach((sh, i) => {
      const t = h('button', { class: 'sheet-tab' + (i === si ? ' active' : ''), type: 'button', role: 'tab', 'aria-selected': i === si ? 'true' : 'false' }, sh.name);
      t.addEventListener('click', () => { if (i !== si) switchSheet(i); });
      t.addEventListener('dblclick', () => renameSheet(i));
      t.addEventListener('contextmenu', (e) => { e.preventDefault(); sheetMenu(i, { x: e.clientX, y: e.clientY }); });
      let lp;
      t.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') lp = setTimeout(() => sheetMenu(i, t), 550); });
      t.addEventListener('pointerup', () => clearTimeout(lp));
      t.addEventListener('pointerleave', () => clearTimeout(lp));
      tabs.append(t);
    });
    const active = tabs.querySelector('.sheet-tab.active');
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  async function renameSheet(i) {
    const name = await askText('Sayfayı yeniden adlandır', { value: wb.sheets[i].name, label: 'Sayfa adı' });
    if (name == null) return;
    const err = wb.renameSheet(i, name);
    if (err) toast(err, { type: 'error' });
    afterStructure();
  }

  function sheetMenu(i, at) {
    popupMenu(at, [
      { label: 'Yeniden adlandır', icon: 'textbox', onClick: () => renameSheet(i) },
      { label: 'Kopyasını oluştur', icon: 'duplicate', onClick: () => { const j = wb.duplicateSheet(i); switchSheet(j); } },
      { label: 'Sola taşı', icon: 'back', disabled: i === 0, onClick: () => { wb.moveSheet(i, -1); si = wb.active; afterStructure(); } },
      { label: 'Sağa taşı', icon: 'arrowShape', disabled: i === wb.sheets.length - 1, onClick: () => { wb.moveSheet(i, 1); si = wb.active; afterStructure(); } },
      { separator: true },
      {
        label: 'Sil', icon: 'trash', disabled: wb.sheets.length <= 1, onClick: async () => {
          if (!(await confirmBox('Sayfa silinsin mi?', `"${wb.sheets[i].name}" sayfası ve içindeki tüm veriler silinecek. Geri Al ile geri getirebilirsiniz.`, { okLabel: 'Sil', danger: true }))) return;
          wb.deleteSheet(i);
          si = Math.min(si, wb.sheets.length - 1);
          wb.active = si;
          afterStructure();
        },
      },
    ]);
  }

  // ---- Bağlam menüsü ------------------------------------------------------------------------
  function contextMenu(at) {
    const fullRows = sel.c1 === 0 && sel.c2 === MAX_COLS - 1;
    const fullCols = sel.r1 === 0 && sel.r2 === MAX_ROWS - 1;
    const nR = sel.r2 - sel.r1 + 1, nC = sel.c2 - sel.c1 + 1;
    popupMenu(at, [
      { label: 'Kes', icon: 'cut', hint: 'Ctrl+X', onClick: () => menuCopy(true) },
      { label: 'Kopyala', icon: 'copy', hint: 'Ctrl+C', onClick: () => menuCopy(false) },
      { label: 'Yapıştır', icon: 'paste', hint: 'Ctrl+V', onClick: () => menuPaste(false) },
      { label: 'Yalnızca değerleri yapıştır', icon: 'paste', disabled: !clip, onClick: () => menuPaste(true) },
      { separator: true },
      !fullCols ? { label: nR > 1 ? `Üste ${nR} satır ekle` : 'Üste satır ekle', icon: 'rowAdd', onClick: () => { wb.insertRows(si, sel.r1, Math.min(nR, 10000)); afterStructure(); } } : null,
      !fullCols ? { label: nR > 1 ? `Alta ${nR} satır ekle` : 'Alta satır ekle', icon: 'rowAdd', onClick: () => { wb.insertRows(si, sel.r2 + 1, Math.min(nR, 10000)); afterStructure(); } } : null,
      !fullRows ? { label: nC > 1 ? `Sola ${nC} sütun ekle` : 'Sola sütun ekle', icon: 'colAdd', onClick: () => { wb.insertCols(si, sel.c1, Math.min(nC, 1000)); afterStructure(); } } : null,
      !fullRows ? { label: nC > 1 ? `Sağa ${nC} sütun ekle` : 'Sağa sütun ekle', icon: 'colAdd', onClick: () => { wb.insertCols(si, sel.c2 + 1, Math.min(nC, 1000)); afterStructure(); } } : null,
      !fullCols ? { label: nR > 1 ? `${nR} satırı sil` : 'Satırı sil', icon: 'trash', onClick: () => { wb.deleteRows(si, sel.r1, nR); select(sel.r1, sel.c); afterStructure(); } } : null,
      !fullRows ? { label: nC > 1 ? `${nC} sütunu sil` : 'Sütunu sil', icon: 'trash', onClick: () => { wb.deleteCols(si, sel.c1, nC); select(sel.r, sel.c1); afterStructure(); } } : null,
      { separator: true },
      fullCols ? { label: 'Sütun genişliği…', icon: 'layout', onClick: () => askSize('col') } : null,
      fullRows ? { label: 'Satır yüksekliği…', icon: 'layout', onClick: () => askSize('row') } : null,
      fullCols ? { label: 'Sütunları gizle', icon: 'close', onClick: () => { wb.setSize(si, 'col', range(sel.c1, sel.c2), 0); afterStructure(); } } : null,
      fullRows ? { label: 'Satırları gizle', icon: 'close', onClick: () => { wb.setSize(si, 'row', range(sel.r1, sel.r2), 0); afterStructure(); } } : null,
      (fullCols || fullRows) ? { label: 'Gizlenenleri göster', icon: 'zoomIn', onClick: unhide } : null,
      { label: 'İçeriği temizle', icon: 'clearFormat', hint: 'Del', onClick: () => clearSel('content') },
      { label: 'Biçimi temizle', icon: 'clearFormat', onClick: () => clearSel('format') },
      { separator: true },
      { label: 'A → Z sırala', icon: 'sortAsc', onClick: () => sortSel(true) },
      { label: 'Z → A sırala', icon: 'sortDesc', onClick: () => sortSel(false) },
      { label: 'Aralığı adlandır…', icon: 'textbox', onClick: nameRange },
    ]);
  }

  function unhide() {
    const sh = sheet();
    if (sel.r1 === 0 && sel.r2 === MAX_ROWS - 1) {
      const cols = [...sh.colW].filter(([c, w]) => w === 0 && c >= sel.c1 && c <= sel.c2).map(([c]) => c);
      if (cols.length) wb.setSize(si, 'col', cols, null);
    }
    if (sel.c1 === 0 && sel.c2 === MAX_COLS - 1) {
      const rows = [...sh.rowH].filter(([r, hh]) => hh === 0 && r >= sel.r1 && r <= sel.r2).map(([r]) => r);
      if (rows.length) wb.setSize(si, 'row', rows, null);
    }
    afterStructure();
  }

  async function askSize(axis) {
    const cur = axis === 'col' ? colW(sel.c) : rowH(sel.r);
    const v = await askText(axis === 'col' ? 'Sütun genişliği (piksel)' : 'Satır yüksekliği (piksel)', { value: String(cur), type: 'number' });
    if (v == null) return;
    const n = parseFloat(v);
    if (!(n >= 0 && n <= 2000)) { toast('Geçersiz değer.', { type: 'error' }); return; }
    wb.setSize(si, axis, axis === 'col' ? range(sel.c1, sel.c2) : range(sel.r1, sel.r2), n);
    afterStructure();
  }

  async function nameRange() {
    const n = await askText('Aralığı adlandır', { label: `${sheet().name}!${addr(sel.r1, sel.c1)}:${addr(sel.r2, sel.c2)} için ad`, placeholder: 'ör. Satışlar' });
    if (!n) return;
    if (!/^[A-Za-zÇĞİÖŞÜçğıöşü_][\wÇĞİÖŞÜçğıöşü.]*$/.test(n) || parseAddr(n)) { toast('Geçersiz ad. Harfle başlamalı, boşluk içermemeli.', { type: 'error' }); return; }
    const q = /^[A-Za-z_][\w.]*$/.test(sheet().name) ? sheet().name : `'${sheet().name.replace(/'/g, "''")}'`;
    wb.structural(() => { wb.names[n] = `${q}!$${colName(sel.c1)}$${sel.r1 + 1}:$${colName(sel.c2)}$${sel.r2 + 1}`; });
    toast(`"${n}" adı tanımlandı. Formüllerde kullanabilirsiniz: =TOPLA(${n})`, { type: 'success' });
  }

  async function sortSel(asc) {
    let rng = { ...sel };
    const b = wb.bounds(si);
    if (rng.r1 === rng.r2 && rng.c1 === rng.c2) {
      // Tek hücre: bitişik veri bölgesini bul
      rng = currentRegion(sel.r, sel.c);
    }
    rng.r2 = Math.min(rng.r2, b.maxR);
    rng.c2 = Math.min(rng.c2, b.maxC);
    if (rng.r2 <= rng.r1) return;
    const first = sheet().cells.get(key(rng.r1, sel.c));
    const second = sheet().cells.get(key(rng.r1 + 1, sel.c));
    const header = first && typeof first.v === 'string' && second && typeof second.v === 'number';
    if (sheet().merges.some((m) => !(m.r2 < rng.r1 || m.r1 > rng.r2 || m.c2 < rng.c1 || m.c1 > rng.c2))) { toast('Birleştirilmiş hücreler içeren alan sıralanamaz.', { type: 'error' }); return; }
    wb.sortRange(si, rng, sel.c, asc, header);
    afterStructure();
    toast(header ? 'Sıralandı (ilk satır başlık olarak bırakıldı).' : 'Sıralandı.');
  }

  function currentRegion(r, c) {
    const has = (rr, cc) => rr >= 0 && cc >= 0 && sheet().cells.has(key(rr, cc));
    let r1 = r, r2 = r, c1 = c, c2 = c;
    let grow = true, guard = 0;
    while (grow && guard++ < 1000) {
      grow = false;
      for (let cc = c1; cc <= c2; cc++) { if (has(r1 - 1, cc)) { r1--; grow = true; break; } }
      for (let cc = c1; cc <= c2; cc++) { if (has(r2 + 1, cc)) { r2++; grow = true; break; } }
      for (let rr = r1; rr <= r2; rr++) { if (has(rr, c1 - 1)) { c1--; grow = true; break; } }
      for (let rr = r1; rr <= r2; rr++) { if (has(rr, c2 + 1)) { c2++; grow = true; break; } }
    }
    return { r1, c1, r2, c2 };
  }

  // ---- Bul ve değiştir --------------------------------------------------------------------
  const findBar = h('div', { class: 'findbar', hidden: true });
  root.insertBefore(findBar, gridWrap);
  function openFind() {
    clear(findBar);
    findBar.hidden = false;
    const q = h('input', { class: 'input', placeholder: 'Bul', 'aria-label': 'Bul' });
    const rep = h('input', { class: 'input', placeholder: 'Değiştir', 'aria-label': 'Değiştir' });
    const info = h('span', { class: 'find-info' });
    let hits = [], idx = -1;
    const search = () => {
      hits = [];
      idx = -1;
      const needle = q.value.toLocaleLowerCase('tr');
      if (!needle) { info.textContent = ''; return; }
      const keys = [...sheet().cells.keys()].sort((a, b) => a - b);
      for (const k of keys) {
        const cell = sheet().cells.get(k);
        const t = cell.f != null ? '=' + cell.f + ' ' + formatValue(wb.value(si, rowOf(k), colOf(k))) : formatValue(cell.v, cell.s && cell.s.z);
        if (t.toLocaleLowerCase('tr').includes(needle)) hits.push(k);
      }
      info.textContent = hits.length ? `${hits.length} sonuç` : 'Bulunamadı';
    };
    const go = (d) => {
      if (!hits.length) search();
      if (!hits.length) return;
      idx = (idx + d + hits.length) % hits.length;
      select(rowOf(hits[idx]), colOf(hits[idx]));
      info.textContent = `${idx + 1} / ${hits.length}`;
    };
    const replaceAll = () => {
      const needle = q.value;
      if (!needle) return;
      const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      let n = 0;
      wb.transact(() => {
        for (const [k, cell] of [...sheet().cells]) {
          if (cell.f != null || typeof cell.v !== 'string' || !re.test(cell.v)) continue;
          re.lastIndex = 0;
          wb.setCell(si, rowOf(k), colOf(k), { ...cell, v: cell.v.replace(re, rep.value) });
          n++;
        }
      });
      toast(`${n} hücre değiştirildi.`);
      search();
    };
    q.addEventListener('input', search);
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(e.shiftKey ? -1 : 1); } if (e.key === 'Escape') close(); });
    const close = () => { findBar.hidden = true; focusGrid(); };
    findBar.append(q, tbtn('arrowUp', 'Önceki', () => go(-1)), tbtn('arrowDown', 'Sonraki', () => go(1)), info, rep,
      h('button', { class: 'btn', type: 'button', onClick: replaceAll }, 'Tümünü değiştir'), tbtn('close', 'Kapat', close));
    q.focus();
  }

  // ---- İşlev ekleme ----------------------------------------------------------------------
  function insertFunction(name) {
    const isSum = ['SUM', 'AVERAGE', 'COUNT', 'MAX', 'MIN'].includes(name);
    if (isSum && !editing) {
      // Otomatik aralık: seçim çok hücreliyse onu, değilse üstteki sayıları kullan
      let rng;
      if (sel.r1 !== sel.r2 || sel.c1 !== sel.c2) {
        const target = { r: sel.r2 + 1, c: sel.c1 };
        rng = `${addr(sel.r1, sel.c1)}:${addr(sel.r2, sel.c2)}`;
        if (sel.c1 === sel.c2) { writeInput(target.r, target.c, `=${name}(${rng})`); select(target.r, target.c); return; }
        startEdit(`=${name}(${rng})`);
        return;
      }
      let r = sel.r - 1;
      const isNum = (rr, cc) => { const v = wb.value(si, rr, cc); return typeof v === 'number'; };
      while (r >= 0 && isNum(r, sel.c)) r--;
      if (r < sel.r - 1) rng = `${addr(r + 1, sel.c)}:${addr(sel.r - 1, sel.c)}`;
      else {
        let c = sel.c - 1;
        while (c >= 0 && isNum(sel.r, c)) c--;
        if (c < sel.c - 1) rng = `${addr(sel.r, c + 1)}:${addr(sel.r, sel.c - 1)}`;
      }
      startEdit(`=${name}(${rng || ''}`);
      if (rng) { cellEditor.value += ')'; barInput.value = cellEditor.value; updateRefHighlights(); draw(); }
      return;
    }
    if (!editing) startEdit('=' + name + '(');
    else {
      const inp = activeInput();
      const p = inp.selectionStart;
      const pre = inp.value.slice(0, p);
      const ins = (pre === '' ? '=' : '') + name + '(';
      inp.value = pre + ins + inp.value.slice(inp.selectionEnd);
      inp.setSelectionRange(p + ins.length, p + ins.length);
      onEditorInput({ target: inp });
      inp.focus();
    }
  }

  function functionMenu(anchor) {
    const items = [];
    for (const cat of FUNCTION_LIST) {
      items.push({ header: cat.cat });
      for (const [en, tr, desc] of cat.items) items.push({ label: `${tr} (${en})`, hint: desc, onClick: () => insertFunction(en) });
    }
    items.push({ separator: true }, { label: 'Tüm işlevler…', icon: 'search', onClick: allFunctionsDialog });
    popupMenu(anchor, items, { minWidth: 280 });
  }

  async function allFunctionsDialog() {
    const list = h('div', { class: 'fn-list' });
    const q = h('input', { class: 'input', placeholder: 'İşlev ara (ör. TOPLA, DÜŞEYARA, SUM)', 'aria-label': 'İşlev ara' });
    let chosen = null;
    const render = () => {
      clear(list);
      const needle = q.value.toLocaleUpperCase('tr');
      for (const f of ALL_FUNCS) {
        if (needle && !f.en.includes(needle.replace(/İ/g, 'I')) && !(f.tr && f.tr.includes(needle)) && !(f.desc || '').toLocaleUpperCase('tr').includes(needle)) continue;
        const b = h('button', { class: 'menu-item', type: 'button' }, h('span', { class: 'menu-label' }, f.tr ? `${f.tr} (${f.en})` : f.en), f.desc ? h('span', { class: 'menu-hint' }, f.desc) : null);
        b.addEventListener('click', () => { chosen = f.en; document.querySelector('.modal-overlay .btn-primary').click(); });
        list.append(b);
      }
    };
    q.addEventListener('input', render);
    render();
    const r = await modal({ title: 'İşlev ekle', body: h('div', null, q, list), actions: [{ label: 'Kapat', value: null }, { label: 'Ekle', primary: true, value: () => chosen }] });
    if (r) insertFunction(r);
  }
  fxBtn.addEventListener('mousedown', (e) => e.preventDefault());
  fxBtn.addEventListener('click', () => functionMenu(fxBtn));

  // ---- Araç çubuğu ------------------------------------------------------------------------------
  const fontSel = tselect(usableFonts(FONTS), (v) => { applyStyle({ ff: v === 'Calibri' ? null : v }); focusGrid(); }, { title: 'Yazı tipi', width: '120px', value: 'Calibri' });
  previewFontOptions(fontSel);
  const sizeSel = tselect(SIZES.map(String), (v) => { applyStyle({ fs: +v === 11 ? null : +v }); focusGrid(); }, { title: 'Yazı boyutu', width: '58px', value: '11' });
  const fmtSel = tselect(NUM_FORMATS, (v) => { applyStyle({ z: v === 'General' ? null : v }); focusGrid(); }, { title: 'Sayı biçimi', width: '130px', value: 'General' });
  const btn = {};
  const tb = (name, ic, title, fn, opts) => (btn[name] = tbtn(ic, title, fn, opts));

  function borderMenu(anchor) {
    // sides: hangi kenarlar; mode: 'all' her hücreye, 'outer' yalnızca seçimin dış kenarına
    const setBorders = (mode, col) => {
      if (selIsHuge()) { toast('Seçim çok büyük.', { type: 'error' }); return; }
      wb.transact(() => {
        for (let r = sel.r1; r <= Math.min(sel.r2, sel.r1 + 5000); r++) for (let c = sel.c1; c <= Math.min(sel.c2, sel.c1 + 500); c++) {
          const cell = sheet().cells.get(key(r, c));
          const s0 = { ...((cell && cell.s) || {}) };
          const put = (k, on) => { if (on) { if (col) s0[k] = col; else delete s0[k]; } };
          if (mode === 'all' || mode === 'none') { put('bt', true); put('bb', true); put('bl', true); put('br', true); }
          if (mode === 'outer') { put('bt', r === sel.r1); put('bb', r === sel.r2); put('bl', c === sel.c1); put('br', c === sel.c2); }
          if (mode === 'bottom') put('bb', r === sel.r2);
          if (mode === 'top') put('bt', r === sel.r1);
          const st = Object.keys(s0).length ? Object.freeze(s0) : undefined;
          wb.setCell(si, r, c, { ...(cell || {}), s: st });
        }
      });
    };
    popupMenu(anchor, [
      { label: 'Tüm kenarlıklar', icon: 'border', onClick: () => setBorders('all', '#000000') },
      { label: 'Dış kenarlıklar', icon: 'rect', onClick: () => setBorders('outer', '#000000') },
      { label: 'Üst kenarlık', icon: 'valignTop', onClick: () => setBorders('top', '#000000') },
      { label: 'Alt kenarlık', icon: 'valignBottom', onClick: () => setBorders('bottom', '#000000') },
      { label: 'Renkli tüm kenarlıklar…', icon: 'palette', onClick: () => colorPicker(anchor, (c) => c && setBorders('all', c)) },
      { separator: true },
      { label: 'Kenarlık yok', icon: 'close', onClick: () => setBorders('none', null) },
    ]);
  }

  function mergeToggle() {
    const m = wb.mergeAt(si, sel.r, sel.c);
    if (m && m.r1 === sel.r1 && m.c1 === sel.c1 && m.r2 === sel.r2 && m.c2 === sel.c2) {
      wb.setMerge(si, sel, false);
    } else {
      if (sel.r1 === sel.r2 && sel.c1 === sel.c2) { toast('Birleştirmek için birden fazla hücre seçin.'); return; }
      if ((sel.r2 - sel.r1 + 1) * (sel.c2 - sel.c1 + 1) > 100000) { toast('Seçim çok büyük.', { type: 'error' }); return; }
      let filled = 0;
      for (let r = sel.r1; r <= sel.r2; r++) for (let c = sel.c1; c <= sel.c2; c++) { const cell = sheet().cells.get(key(r, c)); if (cell && (cell.v != null || cell.f != null)) filled++; }
      if (filled > 1) toast('Birleştirmede yalnızca sol üst hücrenin değeri korundu.');
      wb.setMerge(si, sel, true);
      applyStyle({ ha: 'center' });
    }
    afterStructure();
  }

  function adjustDecimals(d) {
    const s = activeStyle();
    let z = s.z && s.z !== 'General' ? s.z : null;
    if (!z) {
      const v = wb.value(si, sel.r, sel.c);
      const dec = typeof v === 'number' ? Math.min(10, (String(v).split('.')[1] || '').length) : 0;
      z = dec ? '0.' + '0'.repeat(dec) : '0';
    }
    const m = /0(\.0*)?/.exec(z);
    if (!m) return;
    const cur = m[1] ? m[1].length - 1 : 0;
    const next = Math.max(0, Math.min(10, cur + d));
    const repl = next ? '0.' + '0'.repeat(next) : '0';
    applyStyle({ z: z.replace(/0(\.0*)?/, repl) });
  }

  function freezeMenu(anchor) {
    const f = sheet().freeze;
    popupMenu(anchor, [
      { label: `Seçimin üstünü ve solunu dondur (${addr(sel.r, sel.c)})`, icon: 'freeze', onClick: () => { wb.setFreeze(si, sel.r, sel.c); afterStructure(); } },
      { label: 'İlk satırı dondur', icon: 'freeze', onClick: () => { wb.setFreeze(si, 1, 0); afterStructure(); } },
      { label: 'İlk sütunu dondur', icon: 'freeze', onClick: () => { wb.setFreeze(si, 0, 1); afterStructure(); } },
      { label: 'Dondurmayı kaldır', icon: 'close', disabled: !f.r && !f.c, onClick: () => { wb.setFreeze(si, 0, 0); afterStructure(); } },
      { separator: true },
      { label: sheet().grid === false ? 'Kılavuz çizgilerini göster' : 'Kılavuz çizgilerini gizle', icon: 'table', onClick: () => { wb.structural(() => { sheet().grid = sheet().grid === false; }); draw(); } },
    ]);
  }

  function insertMenu(anchor) {
    popupMenu(anchor, [
      { label: 'Üste satır ekle', icon: 'rowAdd', onClick: () => { wb.insertRows(si, sel.r1, 1); afterStructure(); } },
      { label: 'Sola sütun ekle', icon: 'colAdd', onClick: () => { wb.insertCols(si, sel.c1, 1); afterStructure(); } },
      { label: 'Satırı sil', icon: 'trash', onClick: () => { wb.deleteRows(si, sel.r1, sel.r2 - sel.r1 + 1 > 100000 ? 1 : sel.r2 - sel.r1 + 1); afterStructure(); } },
      { label: 'Sütunu sil', icon: 'trash', onClick: () => { wb.deleteCols(si, sel.c1, sel.c2 - sel.c1 + 1 > 1000 ? 1 : sel.c2 - sel.c1 + 1); afterStructure(); } },
      { separator: true },
      { label: 'Aşağı doldur', icon: 'fillDown', hint: 'Ctrl+D', onClick: () => fillDirection('down') },
      { label: 'Sağa doldur', icon: 'fillDown', hint: 'Ctrl+R', onClick: () => fillDirection('right') },
      { label: 'Bugünün tarihi', icon: 'plus', hint: 'Ctrl+;', onClick: () => { const d = new Date(); writeInput(sel.r, sel.c, `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`); } },
      { label: 'Aralığı adlandır…', icon: 'textbox', onClick: nameRange },
    ]);
  }

  toolbar.append(
    tb('undo', 'undo', 'Geri al (Ctrl+Z)', doUndo), tb('redo', 'redo', 'Yinele (Ctrl+Y)', doRedo), tsep(),
    fontSel, sizeSel, tsep(),
    tb('b', null, 'Kalın (Ctrl+B)', () => toggleStyle('b'), { text: 'K', cls: 'fmt-b' }),
    tb('i', null, 'İtalik (Ctrl+I)', () => toggleStyle('i'), { text: 'T', cls: 'fmt-i' }),
    tb('u', null, 'Altı çizili (Ctrl+U)', () => toggleStyle('u'), { text: 'A', cls: 'fmt-u' }),
    tb('st', null, 'Üstü çizili', () => toggleStyle('st'), { text: 'Ü', cls: 'fmt-s' }),
    tb('fc', 'textColor', 'Yazı rengi', (e, b) => colorPicker(b, (c) => applyStyle({ fc: c && c !== '#000000' ? c : null }), { noneLabel: 'Otomatik' })),
    tb('bg', 'fill', 'Dolgu rengi', (e, b) => colorPicker(b, (c) => applyStyle({ bg: c && c !== '#ffffff' ? c : null }), { noneLabel: 'Dolgu yok' })),
    tb('border', 'border', 'Kenarlıklar', (e, b) => borderMenu(b)), tsep(),
    tb('al', 'alignLeft', 'Sola hizala', () => applyStyle((s) => ({ ha: s.ha === 'left' ? null : 'left' }))),
    tb('ac', 'alignCenter', 'Ortala', () => applyStyle((s) => ({ ha: s.ha === 'center' ? null : 'center' }))),
    tb('ar', 'alignRight', 'Sağa hizala', () => applyStyle((s) => ({ ha: s.ha === 'right' ? null : 'right' }))),
    tb('vt', 'valignTop', 'Üste hizala', () => applyStyle({ va: 'top' })),
    tb('vm', 'valignMiddle', 'Ortaya hizala', () => applyStyle({ va: 'middle' })),
    tb('vb', 'valignBottom', 'Alta hizala', () => applyStyle({ va: null })),
    tb('wr', 'wrap', 'Metni kaydır', () => toggleStyle('wr')),
    tb('merge', 'merge', 'Birleştir ve ortala', mergeToggle), tsep(),
    fmtSel,
    tb('pct', null, 'Yüzde biçimi', () => applyStyle({ z: '0%' }), { text: '%' }),
    tb('cur', null, 'Para birimi (₺)', () => applyStyle({ z: '#,##0.00 "₺"' }), { text: '₺' }),
    tb('decInc', 'decInc', 'Ondalık artır', () => adjustDecimals(1)),
    tb('decDec', 'decDec', 'Ondalık azalt', () => adjustDecimals(-1)), tsep(),
    tb('sum', 'sigma', 'Otomatik toplam', (e, b) => popupMenu(b, [
      { label: 'Toplam (TOPLA)', onClick: () => insertFunction('SUM') },
      { label: 'Ortalama (ORTALAMA)', onClick: () => insertFunction('AVERAGE') },
      { label: 'Say (BAĞ_DEĞ_SAY)', onClick: () => insertFunction('COUNT') },
      { label: 'En büyük (MAK)', onClick: () => insertFunction('MAX') },
      { label: 'En küçük (MİN)', onClick: () => insertFunction('MIN') },
      { separator: true },
      { label: 'Diğer işlevler…', onClick: allFunctionsDialog },
    ])),
    tb('sortA', 'sortAsc', 'A → Z sırala', () => sortSel(true)),
    tb('sortZ', 'sortDesc', 'Z → A sırala', () => sortSel(false)),
    tb('ins', 'rowAdd', 'Ekle / sil', (e, b) => insertMenu(b)),
    tb('freeze', 'freeze', 'Bölmeleri dondur', (e, b) => freezeMenu(b)),
    tb('find', 'search', 'Bul ve değiştir (Ctrl+F)', openFind),
    tb('clr', 'clearFormat', 'Biçimi temizle', () => clearSel('format')),
  );

  function updateToolbarState() {
    const s = activeStyle();
    for (const k of ['b', 'i', 'u', 'st', 'wr']) btn[k].classList.toggle('on', !!s[k]);
    btn.al.classList.toggle('on', s.ha === 'left');
    btn.ac.classList.toggle('on', s.ha === 'center');
    btn.ar.classList.toggle('on', s.ha === 'right');
    btn.vt.classList.toggle('on', s.va === 'top');
    btn.vm.classList.toggle('on', s.va === 'middle');
    btn.vb.classList.toggle('on', !s.va);
    btn.merge.classList.toggle('on', !!wb.mergeAt(si, sel.r, sel.c));
    const ff = s.ff || 'Calibri';
    if (![...fontSel.options].some((o) => o.value === ff)) fontSel.append(h('option', { value: ff }, ff));
    fontSel.value = ff;
    sizeSel.value = String(s.fs || 11);
    fmtSel.value = NUM_FORMATS.some((f) => f.value === (s.z || 'General')) ? (s.z || 'General') : 'General';
    btn.undo.disabled = !wb.canUndo();
    btn.redo.disabled = !wb.canRedo();
  }
  const prevOnChange = wb.onChange;
  wb.onChange = () => { prevOnChange(); updateToolbarState(); };

  // ---- Dışa aktarma ve yazdırma ------------------------------------------------------------
  function doPrint() {
    printElement(() => {
      const wrap = h('div', { class: 'print-sheet-wrap' });
      wrap.append(sheetToTable(wb, si));
      return wrap;
    }, { pageCss: '@page { size: A4 landscape; margin: 12mm; }' });
  }

  async function exportFile(kind, title) {
    if (editing) commitEdit();
    if (kind === 'xlsx') return saveBlob(await exportXlsx(wb), `${title}.xlsx`);
    if (kind === 'ods') return saveBlob(exportOds(wb), `${title}.ods`);
    if (kind === 'csv') return saveBlob(exportCsv(wb, si, { sep: ',' }), `${title} - ${sheet().name}.csv`);
    if (kind === 'csv-tr') return saveBlob(exportCsv(wb, si, { sep: ';', localized: true }), `${title} - ${sheet().name}.csv`);
    if (kind === 'html') {
      const doc = document.implementation.createHTMLDocument(title);
      const meta = doc.createElement('meta'); meta.setAttribute('charset', 'utf-8'); doc.head.append(meta);
      const st = doc.createElement('style');
      st.textContent = 'body{font-family:Calibri,Arial,sans-serif;font-size:11pt}table{border-collapse:collapse}td{border:1px solid #ddd;padding:2px 4px;white-space:nowrap}';
      doc.head.append(st);
      doc.body.append(doc.importNode(sheetToTable(wb, si), true));
      return saveBlob(new Blob(['<!doctype html>\n' + doc.documentElement.outerHTML], { type: 'text/html' }), `${title}.html`);
    }
    return null;
  }

  // ---- Yakınlaştırma (iki parmak / Ctrl + tekerlek / alt çubuktaki yüzde) -------------------
  const zoomBtn = h('button', { class: 'sheet-zoom', type: 'button', title: 'Yakınlaştırma (dokunarak %100)' }, '100%');
  zoomBtn.addEventListener('click', () => setZoom(1, 0, 0));
  bottom.append(zoomBtn);
  function setZoom(z, fx, fy) {
    z = Math.max(0.5, Math.min(3, Math.round(z * 100) / 100));
    if (z === zoom) return;
    // Parmakların altındaki mantıksal nokta yerinde kalsın
    const lx = scrollX + fx / zoom, ly = scrollY + fy / zoom;
    zoom = z;
    zoomBtn.textContent = Math.round(z * 100) + '%';
    resize();
    scroller.scrollLeft = Math.max(0, lx * z - fx);
    scroller.scrollTop = Math.max(0, ly * z - fy);
    scrollX = scroller.scrollLeft / z; scrollY = scroller.scrollTop / z;
    if (editing && !editing.fromBar) { cellEditor.style.zoom = String(z); positionEditor(); autoSizeEditor(); }
    positionHandle();
    draw();
  }
  pinchZoom(scroller, {
    content: () => canvas, getZoom: () => zoom, setZoom, min: 0.5, max: 3, anchor: false,
    onStart: () => { clearTimeout(longPress); drag = null; pointerSelecting = false; clearInterval(autoScrollTimer); },
  });

  // ---- Başlangıç ----------------------------------------------------------------------------
  const ro = new ResizeObserver(() => resize());
  ro.observe(gridWrap);
  buildSizeCache();
  rebuildCovered();
  renderTabs();
  resize();
  syncBar();
  updateToolbarState();
  const themeObs = new MutationObserver(() => draw());
  themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  setTimeout(() => focusGrid({ preventScroll: true }), 50);

  return {
    // Telefonun geri tuşu: önce hücre düzenlemeyi bitir (yazılan kaybolmaz), sonra arama çubuğunu kapat
    onBackButton: () => {
      if (editing) { commitEdit(); return true; }
      if (!findBar.hidden) { findBar.hidden = true; focusGrid(); return true; }
      return false;
    },
    serialize: () => { wb.active = si; return wb.serialize(); },
    primaryExport: { label: 'Excel (.xlsx) olarak indir', run: (title) => exportFile('xlsx', title) },
    fileMenu: (title) => [
      { label: 'Excel çalışma kitabı (.xlsx)', icon: 'download', onClick: () => exportFile('xlsx', title()) },
      { label: 'OpenDocument tablo (.ods)', icon: 'download', onClick: () => exportFile('ods', title()) },
      { label: 'CSV – bu sayfa (virgüllü, UTF-8)', icon: 'download', onClick: () => exportFile('csv', title()) },
      { label: 'CSV – bu sayfa (Türkçe Excel, noktalı virgül)', icon: 'download', onClick: () => exportFile('csv-tr', title()) },
      { label: 'Web sayfası (.html)', icon: 'download', onClick: () => exportFile('html', title()) },
      canPrint() ? { label: 'PDF olarak kaydet / Yazdır', icon: 'print', hint: 'Ctrl+P', onClick: doPrint } : null,
    ],
    flush: () => { if (editing) commitEdit(); },
    destroy() {
      ro.disconnect();
      themeObs.disconnect();
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCut);
      document.removeEventListener('paste', onPaste);
      acBox.remove();
      clear(root);
      root.classList.remove('editor', 'editor-sheet');
    },
  };
}

export function newSheetData() {
  return new Workbook().serialize();
}
