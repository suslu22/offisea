// Tablo dosyalarını okuma/yazma.
// Okuma: SheetJS (0.20.3 — CVE-2023-30533 ve CVE-2024-22363 düzeltilmiş sürüm) değerleri okur,
// xlsx için biçimleri (yazı tipi, dolgu, kenarlık, hizalama) kendi ayrıştırıcımız ekler.
// Yazma: xlsx'i JSZip ile kendimiz üretiriz (biçimler korunur); ods için SheetJS kullanılır.
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { checkZip, isZip, parseXml, extOf, readArrayBuffer } from '../core/files.js';
import { decodeText } from '../word/other-import.js';
import { Workbook, newSheet, key, rowOf, colOf, DEF_W, DEF_H } from './model.js';
import { errFromCode, colName, addr, tokenize, parseInput, formatValue, setSSF, FErr, parseNumberText, parseDateText } from './formula.js';

setSSF(XLSX.SSF);
export { XLSX };

// ---- Renk yardımcıları -----------------------------------------------------------------
const INDEXED = ['000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080', '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF', '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF', '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99', '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696', '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333'];

function applyTint(hex, tint) {
  if (!tint) return hex;
  const n = parseInt(hex, 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const x = tint < 0 ? v * (1 + tint) : v + (255 - v) * tint;
    return Math.max(0, Math.min(255, Math.round(x)));
  });
  return ch.map((v) => v.toString(16).padStart(2, '0')).join('');
}

function colorOf(el, theme) {
  if (!el) return null;
  let hex = null;
  const rgb = el.getAttribute('rgb');
  if (rgb && /^[0-9a-f]{6,8}$/i.test(rgb)) hex = rgb.slice(-6);
  else if (el.hasAttribute('theme')) hex = theme[+el.getAttribute('theme')] || null;
  else if (el.hasAttribute('indexed')) {
    const i = +el.getAttribute('indexed');
    if (i === 64 || i === 65) return null; // sistem ön/arka plan
    hex = INDEXED[i] || null;
  }
  if (!hex) return null;
  hex = applyTint(hex, parseFloat(el.getAttribute('tint') || '0'));
  return '#' + hex.toLowerCase();
}

const kids = (el, name) => (el ? Array.from(el.children).filter((c) => c.localName === name) : []);
const kid = (el, name) => kids(el, name)[0] || null;

// ---- xlsx biçim katmanı ------------------------------------------------------------------
async function readXlsxStyles(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const text = async (p) => { const f = zip.file(p); return f ? f.async('string') : null; };
  const relsOf = async (p) => {
    const dir = p.slice(0, p.lastIndexOf('/') + 1);
    const t = await text(dir + '_rels/' + p.slice(dir.length) + '.rels');
    const out = {};
    if (!t) return out;
    for (const r of parseXml(t).getElementsByTagName('Relationship')) {
      const tg = r.getAttribute('Target') || '';
      if (r.getAttribute('TargetMode') === 'External') continue;
      out[r.getAttribute('Id')] = tg.startsWith('/') ? tg.slice(1) : normPath(dir + tg);
    }
    return out;
  };
  const rootT = await text('_rels/.rels');
  let wbPath = 'xl/workbook.xml';
  if (rootT) {
    for (const r of parseXml(rootT).getElementsByTagName('Relationship')) {
      if (/officeDocument$/.test(r.getAttribute('Type') || '')) wbPath = (r.getAttribute('Target') || wbPath).replace(/^\//, '');
    }
  }
  const wbXml = await text(wbPath);
  if (!wbXml) return null;
  const wbRels = await relsOf(wbPath);
  const wbDoc = parseXml(wbXml);
  const sheetPaths = Array.from(wbDoc.getElementsByTagName('sheet')).map((s) => {
    const rid = s.getAttribute('r:id') || s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    return wbRels[rid] || null;
  });

  // Tema renkleri
  const theme = [];
  const themePath = Object.values(wbRels).find((p) => /theme\d*\.xml$/.test(p));
  const themeXml = themePath ? await text(themePath) : null;
  if (themeXml) {
    const doc = parseXml(themeXml);
    const scheme = doc.getElementsByTagNameNS('*', 'clrScheme')[0];
    if (scheme) {
      const get = (n) => {
        const el = kid(scheme, n);
        const c = el && el.firstElementChild;
        if (!c) return null;
        return c.getAttribute('lastClr') || c.getAttribute('val');
      };
      theme.push(get('lt1') || 'FFFFFF', get('dk1') || '000000', get('lt2'), get('dk2'));
      for (let i = 1; i <= 6; i++) theme.push(get('accent' + i));
      theme.push(get('hlink'), get('folHlink'));
    }
  }

  const stylesPath = Object.values(wbRels).find((p) => /styles\.xml$/.test(p));
  const stylesXml = stylesPath ? await text(stylesPath) : null;
  const xfStyles = [];
  if (stylesXml) {
    const doc = parseXml(stylesXml);
    const root = doc.documentElement;
    const fonts = kids(kid(root, 'fonts'), 'font').map((f) => {
      const o = {};
      if (kid(f, 'b') && kid(f, 'b').getAttribute('val') !== '0') o.b = true;
      if (kid(f, 'i') && kid(f, 'i').getAttribute('val') !== '0') o.i = true;
      if (kid(f, 'u') && kid(f, 'u').getAttribute('val') !== 'none') o.u = true;
      if (kid(f, 'strike') && kid(f, 'strike').getAttribute('val') !== '0') o.st = true;
      const sz = kid(f, 'sz'); if (sz) { const v = parseFloat(sz.getAttribute('val')); if (v && v !== 11) o.fs = v; }
      const nm = kid(f, 'name'); if (nm) { const v = nm.getAttribute('val'); if (v && v !== 'Calibri') o.ff = v; }
      const c = colorOf(kid(f, 'color'), theme); if (c && c !== '#000000') o.fc = c;
      return o;
    });
    const fills = kids(kid(root, 'fills'), 'fill').map((f) => {
      const p = kid(f, 'patternFill');
      if (!p || !p.getAttribute('patternType') || p.getAttribute('patternType') === 'none') return {};
      const c = colorOf(kid(p, 'fgColor'), theme) || colorOf(kid(p, 'bgColor'), theme);
      return c ? { bg: c } : {};
    });
    const borders = kids(kid(root, 'borders'), 'border').map((b) => {
      const o = {};
      for (const [side, k] of [['top', 'bt'], ['bottom', 'bb'], ['left', 'bl'], ['right', 'br']]) {
        const e = kid(b, side);
        if (e && e.getAttribute('style') && e.getAttribute('style') !== 'none') o[k] = colorOf(kid(e, 'color'), theme) || '#000000';
      }
      return o;
    });
    for (const xf of kids(kid(root, 'cellXfs'), 'xf')) {
      const s = { ...(fonts[+xf.getAttribute('fontId') || 0] || {}) };
      Object.assign(s, fills[+xf.getAttribute('fillId') || 0] || {});
      Object.assign(s, borders[+xf.getAttribute('borderId') || 0] || {});
      const al = kid(xf, 'alignment');
      if (al) {
        const hz = al.getAttribute('horizontal');
        if (['left', 'center', 'right'].includes(hz)) s.ha = hz;
        else if (hz === 'centerContinuous') s.ha = 'center';
        const vt = al.getAttribute('vertical');
        if (vt === 'top') s.va = 'top'; else if (vt === 'center') s.va = 'middle';
        if (al.getAttribute('wrapText') === '1' || al.getAttribute('wrapText') === 'true') s.wr = true;
      }
      xfStyles.push(s);
    }
  }

  // Sayfa XML'lerinden hücre stil numaraları ve dondurulmuş bölmeler (büyük dosyalar için regex ile).
  const sheets = [];
  for (const p of sheetPaths) {
    const info = { styles: new Map(), freeze: null, grid: true };
    const xml = p ? await text(p) : null;
    if (xml) {
      const cre = /<c\b([^>]*?)\/?>/g;
      let m;
      while ((m = cre.exec(xml))) {
        const attrs = m[1];
        const sm = /\bs="(\d+)"/.exec(attrs);
        if (!sm || sm[1] === '0') continue;
        const rm = /\br="([A-Z]{1,3})(\d+)"/.exec(attrs);
        if (!rm) continue;
        info.styles.set(rm[1] + rm[2], +sm[1]);
      }
      const pane = /<pane\b([^>]*)\/?>/.exec(xml);
      if (pane && /state="frozen(?:Split)?"/.test(pane[1])) {
        const xs = /xSplit="(\d+(?:\.\d+)?)"/.exec(pane[1]);
        const ys = /ySplit="(\d+(?:\.\d+)?)"/.exec(pane[1]);
        info.freeze = { r: ys ? Math.round(+ys[1]) : 0, c: xs ? Math.round(+xs[1]) : 0 };
      }
      if (/<sheetView\b[^>]*showGridLines="(0|false)"/.test(xml)) info.grid = false;
    }
    sheets.push(info);
  }
  return { xfStyles, sheets };
}

function normPath(p) {
  const out = [];
  for (const part of p.split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}

function stripPrefixes(f) {
  if (!/_xl(fn|ws|udf)\./i.test(f)) return f;
  try {
    return tokenize(f).map((t) => (t.t === 'NAME' ? t.s.replace(/^_xl(fn|ws|udf)\./i, '') : t.s)).join('');
  } catch { return f.replace(/_xl(fn|ws)\./gi, ''); }
}

const DATE_FMT_FIX = { 'm/d/yy': 'dd.mm.yyyy', 'm/d/yyyy': 'dd.mm.yyyy', 'mm-dd-yy': 'dd.mm.yyyy', 'm/d/yy h:mm': 'dd.mm.yyyy hh:mm', 'd-mmm-yy': 'd mmm yy', 'd-mmm': 'd mmm', 'mmm-yy': 'mmm yy' };

// ---- İçe aktarma -------------------------------------------------------------------------
export async function importSheetFile(file) {
  const ext = extOf(file.name);
  const buf = await readArrayBuffer(file);
  if (ext === 'csv' || ext === 'tsv') return importCsv(buf, ext === 'tsv' ? '\t' : null);
  const zipLike = isZip(buf);
  if (zipLike) checkZip(buf);
  else if (['xlsx', 'xlsm', 'xltx', 'xltm', 'ods', 'numbers'].includes(ext)) {
    throw new Error('Dosya bozuk veya bu türde değil.');
  }
  let wbx;
  try {
    wbx = XLSX.read(buf, { type: 'array', dense: true, cellFormula: true, cellNF: true, cellStyles: true, cellDates: false, sheetStubs: false, WTF: false });
  } catch (e) {
    throw new Error('Tablo dosyası okunamadı: ' + (e && e.message ? e.message : 'bilinmeyen hata'));
  }
  let overlay = null;
  if (zipLike && ['xlsx', 'xlsm', 'xltx', 'xltm'].includes(ext)) {
    try { overlay = await readXlsxStyles(buf); } catch { overlay = null; }
  }
  const wb = new Workbook();
  wb.sheets = [];
  const styleCache = new Map();
  const internStyle = (o) => {
    const k = JSON.stringify(o);
    let s = styleCache.get(k);
    if (!s) { s = Object.freeze(o); styleCache.set(k, s); }
    return s;
  };
  wbx.SheetNames.forEach((name, si) => {
    const ws = wbx.Sheets[name];
    const sh = newSheet(name);
    const ov = overlay && overlay.sheets[si];
    const data = ws['!data'] || [];
    let count = 0;
    for (let r = 0; r < data.length; r++) {
      const row = data[r];
      if (!row) continue;
      for (let c = 0; c < row.length; c++) {
        const x = row[c];
        if (!x) continue;
        if (++count > 3000000) throw new Error('Tablo çok büyük (3 milyondan fazla hücre).');
        const cell = {};
        let v;
        if (x.t === 'n') v = x.v;
        else if (x.t === 's' || x.t === 'str') v = x.v == null ? '' : String(x.v);
        else if (x.t === 'b') v = !!x.v;
        else if (x.t === 'e') v = errFromCode(x.w || '#N/A');
        else if (x.t === 'd') v = x.v instanceof Date ? (x.v.getTime() - Date.UTC(1899, 11, 30)) / 86400000 : null;
        if (x.f) {
          cell.f = stripPrefixes(String(x.f).replace(/^=/, ''));
          if (v !== undefined) cell.cv = v;
        } else if (v !== undefined && v !== null && v !== '') cell.v = v;
        else if (v === '') cell.v = '';
        const st = {};
        const ref = colName(c) + (r + 1);
        if (ov) {
          const xi = ov.styles.get(ref);
          if (xi != null && overlay.xfStyles[xi]) Object.assign(st, overlay.xfStyles[xi]);
        } else if (x.s && x.s.fgColor && x.s.fgColor.rgb && x.s.patternType === 'solid') {
          st.bg = '#' + String(x.s.fgColor.rgb).slice(-6).toLowerCase();
        }
        if (x.z && x.z !== 'General' && typeof x.z === 'string') st.z = DATE_FMT_FIX[x.z] || x.z;
        if (Object.keys(st).length) cell.s = internStyle(st);
        if (cell.v === undefined && cell.f === undefined && !cell.s) continue;
        sh.cells.set(key(r, c), cell);
      }
    }
    // Yalnızca stili olan boş hücreler (ör. dolgu renkli alanlar)
    if (ov) {
      for (const [ref, xi] of ov.styles) {
        const m = /^([A-Z]+)(\d+)$/.exec(ref);
        const r = +m[2] - 1;
        let c = 0;
        for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64;
        c -= 1;
        const k = key(r, c);
        if (sh.cells.has(k)) continue;
        const st = overlay.xfStyles[xi];
        if (st && (st.bg || st.bt || st.bb || st.bl || st.br)) sh.cells.set(k, { s: internStyle({ ...st }) });
      }
      if (ov.freeze) sh.freeze = ov.freeze;
      sh.grid = ov.grid;
    }
    (ws['!cols'] || []).forEach((col, c) => {
      if (!col) return;
      if (col.hidden) sh.colW.set(c, 0);
      else {
        const px = col.wpx || (col.wch ? Math.round(col.wch * 7 + 5) : col.width ? Math.round(col.width * 7 + 5) : null);
        if (px && Math.abs(px - DEF_W) > 2) sh.colW.set(c, Math.min(1500, px));
      }
    });
    (ws['!rows'] || []).forEach((row, r) => {
      if (!row) return;
      if (row.hidden) sh.rowH.set(r, 0);
      else {
        const px = row.hpx || (row.hpt ? Math.round(row.hpt / 0.75) : null);
        if (px && Math.abs(px - DEF_H) > 2) sh.rowH.set(r, Math.min(800, px));
      }
    });
    sh.merges = (ws['!merges'] || []).map((m) => ({ r1: m.s.r, c1: m.s.c, r2: m.e.r, c2: m.e.c }));
    wb.sheets.push(sh);
  });
  if (!wb.sheets.length) wb.sheets.push(newSheet('Sayfa1'));
  const names = (wbx.Workbook && wbx.Workbook.Names) || [];
  for (const n of names) {
    if (!n || !n.Name || n.Sheet != null || /^_xlnm\./i.test(n.Name) || !n.Ref) continue;
    wb.names[n.Name] = String(n.Ref).replace(/^=/, '');
  }
  wb.resetCalc();
  return wb.serialize();
}

// Kendi CSV ayrıştırıcımız: "=" ile başlayan alanlar formül olarak DEĞİL metin olarak alınır
// (CSV formül enjeksiyonuna karşı).
export function importCsv(buf, forcedSep) {
  const text = decodeText(buf).replace(/^\ufeff/, '');
  let sep = forcedSep;
  if (!sep) {
    const first = text.slice(0, 5000).split(/\r?\n/).slice(0, 5).join('\n').replace(/"(?:[^"]|"")*"/g, '');
    const counts = [';', ',', '\t', '|'].map((s) => [s, first.split(s).length - 1]);
    counts.sort((a, b) => b[1] - a[1]);
    sep = counts[0][1] > 0 ? counts[0][0] : ',';
  }
  const rows = [];
  let row = [], field = '', q = false, i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } q = false; i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { q = true; i++; continue; }
    if (ch === sep) { row.push(field); field = ''; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      row.push(field); field = ''; rows.push(row); row = [];
      if (ch === '\r' && text[i + 1] === '\n') i++;
      i++;
      if (rows.length > 1048575) break;
      continue;
    }
    field += ch; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const wb = new Workbook();
  const sh = wb.sheets[0];
  const zStyles = new Map();
  rows.forEach((r, ri) => r.forEach((val, ci) => {
    if (val === '' || ci >= 16384) return;
    const p = val[0] === '=' || val[0] === '+' || val[0] === '@' ? { v: val } : parseInput(val);
    if (p.f) return; // olmaz, ama yine de
    const cell = { v: p.v };
    if (p.z) { let s = zStyles.get(p.z); if (!s) { s = Object.freeze({ z: p.z }); zStyles.set(p.z, s); } cell.s = s; }
    sh.cells.set(key(ri, ci), cell);
  }));
  wb.resetCalc();
  return wb.serialize();
}

// ---- Dışa aktarma: xlsx ----------------------------------------------------------------
// eslint-disable-next-line no-control-regex
const BAD_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
const esc = (s) => String(s).replace(BAD_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const XLFN = new Set(['XLOOKUP', 'IFS', 'SWITCH', 'CONCAT', 'TEXTJOIN', 'MAXIFS', 'MINIFS', 'XOR', 'IFNA', 'DAYS', 'STDEV.S', 'STDEV.P', 'VAR.S', 'RANK.EQ']);
function xlFormula(f) {
  try {
    const toks = tokenize(f);
    return toks.map((t, i) => {
      if (t.t === 'NAME') {
        const nx = toks.slice(i + 1).find((x) => x.t !== 'WS');
        if (nx && nx.t === 'LP' && XLFN.has(t.v.toUpperCase())) return '_xlfn.' + t.v.toUpperCase();
      }
      return t.s;
    }).join('');
  } catch { return f; }
}

const argb = (hex) => 'FF' + String(hex).replace('#', '').toUpperCase().padStart(6, '0');

export async function exportXlsx(wb) {
  const zip = new JSZip();
  const fonts = ['<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>'];
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  const numFmts = [];
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  const fontIdx = new Map(), fillIdx = new Map(), borderIdx = new Map(), fmtIdx = new Map(), xfIdx = new Map(), xfByXml = new Map();
  const BUILTIN = { General: 0, '0': 1, '0.00': 2, '#,##0': 3, '#,##0.00': 4, '0%': 9, '0.00%': 10, '0.00E+00': 11, '@': 49 };

  const idOf = (map, list, k, xml) => { let i = map.get(k); if (i === undefined) { i = list.push(xml) - 1; map.set(k, i); } return i; };

  const styleId = (s) => {
    if (!s) return 0;
    let id = xfIdx.get(s);
    if (id !== undefined) return id;
    const fxml = `<font>${s.b ? '<b/>' : ''}${s.i ? '<i/>' : ''}${s.st ? '<strike/>' : ''}${s.u ? '<u/>' : ''}<sz val="${+s.fs || 11}"/>${s.fc ? `<color rgb="${argb(s.fc)}"/>` : '<color theme="1"/>'}<name val="${esc(s.ff || 'Calibri')}"/><family val="2"/></font>`;
    const fontId = idOf(fontIdx, fonts, fxml, fxml);
    const fillXml = s.bg ? `<fill><patternFill patternType="solid"><fgColor rgb="${argb(s.bg)}"/><bgColor indexed="64"/></patternFill></fill>` : null;
    const fillId = fillXml ? idOf(fillIdx, fills, fillXml, fillXml) : 0;
    const side = (n, c) => (c ? `<${n} style="thin"><color rgb="${argb(c === true ? '#000000' : c)}"/></${n}>` : `<${n}/>`);
    const hasB = s.bl || s.br || s.bt || s.bb;
    const bxml = hasB ? `<border>${side('left', s.bl)}${side('right', s.br)}${side('top', s.bt)}${side('bottom', s.bb)}<diagonal/></border>` : null;
    const borderId = bxml ? idOf(borderIdx, borders, bxml, bxml) : 0;
    let numFmtId = 0;
    if (s.z) {
      if (BUILTIN[s.z] !== undefined) numFmtId = BUILTIN[s.z];
      else {
        numFmtId = fmtIdx.get(s.z);
        if (numFmtId === undefined) { numFmtId = 164 + numFmts.length; numFmts.push(`<numFmt numFmtId="${numFmtId}" formatCode="${esc(s.z)}"/>`); fmtIdx.set(s.z, numFmtId); }
      }
    }
    const al = [];
    if (s.ha) al.push(`horizontal="${s.ha}"`);
    if (s.va) al.push(`vertical="${s.va === 'middle' ? 'center' : s.va}"`);
    if (s.wr) al.push('wrapText="1"');
    const xml = `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"${numFmtId ? ' applyNumberFormat="1"' : ''}${fontId ? ' applyFont="1"' : ''}${fillId ? ' applyFill="1"' : ''}${borderId ? ' applyBorder="1"' : ''}${al.length ? ' applyAlignment="1"><alignment ' + al.join(' ') + '/></xf>' : '/>'}`;
    id = idOf(xfByXml, xfs, xml, xml);
    xfIdx.set(s, id);
    return id;
  };

  const sst = [];
  const sstIdx = new Map();
  const strId = (s) => { let i = sstIdx.get(s); if (i === undefined) { i = sst.push(s) - 1; sstIdx.set(s, i); } return i; };

  const sheetXmls = wb.sheets.map((sh, si) => {
    const rows = new Map();
    for (const [k, cell] of sh.cells) {
      const r = rowOf(k);
      if (!rows.has(r)) rows.set(r, []);
      rows.get(r).push([colOf(k), cell]);
    }
    for (const r of sh.rowH.keys()) if (!rows.has(r)) rows.set(r, []);
    const rowKeys = [...rows.keys()].sort((a, b) => a - b);
    const b = wb.bounds(si);
    const parts = [];
    parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">');
    parts.push(`<dimension ref="A1${b.maxR >= 0 ? ':' + addr(b.maxR, Math.max(0, b.maxC)) : ''}"/>`);
    const fz = sh.freeze;
    let pane = '';
    if (fz.r || fz.c) {
      const which = fz.r && fz.c ? 'bottomRight' : fz.r ? 'bottomLeft' : 'topRight';
      pane = `<pane${fz.c ? ` xSplit="${fz.c}"` : ''}${fz.r ? ` ySplit="${fz.r}"` : ''} topLeftCell="${addr(fz.r, fz.c)}" activePane="${which}" state="frozen"/>`;
    }
    parts.push(`<sheetViews><sheetView workbookViewId="0"${si === wb.active ? ' tabSelected="1"' : ''}${sh.grid === false ? ' showGridLines="0"' : ''}>${pane}</sheetView></sheetViews>`);
    parts.push('<sheetFormatPr defaultRowHeight="18"/>');
    if (sh.colW.size) {
      parts.push('<cols>');
      for (const [c, w] of [...sh.colW].sort((a, b2) => a[0] - b2[0])) {
        parts.push(w === 0 ? `<col min="${c + 1}" max="${c + 1}" width="0" hidden="1" customWidth="1"/>` : `<col min="${c + 1}" max="${c + 1}" width="${Math.max(0.5, (w - 5) / 7).toFixed(2)}" customWidth="1"/>`);
      }
      parts.push('</cols>');
    }
    parts.push('<sheetData>');
    for (const r of rowKeys) {
      const cells = rows.get(r).sort((a, b2) => a[0] - b2[0]);
      const hh = sh.rowH.get(r);
      parts.push(`<row r="${r + 1}"${hh != null ? (hh === 0 ? ' hidden="1" ht="0" customHeight="1"' : ` ht="${(hh * 0.75).toFixed(2)}" customHeight="1"`) : ''}>`);
      for (const [c, cell] of cells) {
        const ref = addr(r, c);
        const s = styleId(cell.s);
        const sa = s ? ` s="${s}"` : '';
        if (cell.f != null) {
          const v = wb.value(si, r, c);
          let t = '', vx = '';
          if (typeof v === 'number' && isFinite(v)) vx = `<v>${v}</v>`;
          else if (typeof v === 'boolean') { t = ' t="b"'; vx = `<v>${v ? 1 : 0}</v>`; }
          else if (v instanceof FErr) { t = ' t="e"'; vx = `<v>${esc(v.code === '#DÖNGÜ!' ? '#REF!' : v.code)}</v>`; }
          else if (v != null) { t = ' t="str"'; vx = `<v>${esc(v)}</v>`; }
          parts.push(`<c r="${ref}"${sa}${t}><f>${esc(xlFormula(cell.f))}</f>${vx}</c>`);
          continue;
        }
        const v = cell.v;
        if (v == null) { parts.push(`<c r="${ref}"${sa}/>`); continue; }
        if (typeof v === 'number') parts.push(isFinite(v) ? `<c r="${ref}"${sa}><v>${v}</v></c>` : `<c r="${ref}"${sa} t="e"><v>#NUM!</v></c>`);
        else if (typeof v === 'boolean') parts.push(`<c r="${ref}"${sa} t="b"><v>${v ? 1 : 0}</v></c>`);
        else if (v instanceof FErr) parts.push(`<c r="${ref}"${sa} t="e"><v>${esc(v.code)}</v></c>`);
        else parts.push(`<c r="${ref}"${sa} t="s"><v>${strId(String(v).slice(0, 32767))}</v></c>`);
      }
      parts.push('</row>');
    }
    parts.push('</sheetData>');
    if (sh.merges.length) {
      parts.push(`<mergeCells count="${sh.merges.length}">`);
      for (const m of sh.merges) parts.push(`<mergeCell ref="${addr(m.r1, m.c1)}:${addr(m.r2, m.c2)}"/>`);
      parts.push('</mergeCells>');
    }
    parts.push('<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>');
    return parts.join('');
  });

  const n = wb.sheets.length;
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${wb.sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`);
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>Offisea</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`);
  zip.file('docProps/app.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Offisea</Application></Properties>');
  const definedNames = Object.entries(wb.names).filter(([k]) => /^[A-Za-z_\\][\w.]*$/.test(k));
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="${wb.active}"/></bookViews><sheets>${wb.sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>${definedNames.length ? `<definedNames>${definedNames.map(([k, v]) => `<definedName name="${esc(k)}">${esc(v)}</definedName>`).join('')}</definedNames>` : ''}<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${wb.sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${n + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`);
  sheetXmls.forEach((x, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, x));
  zip.file('xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sst.length}" uniqueCount="${sst.length}">${sst.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`);
  zip.file('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${numFmts.length ? `<numFmts count="${numFmts.length}">${numFmts.join('')}</numFmts>` : ''}<fonts count="${fonts.length}">${fonts.join('')}</fonts><fills count="${fills.length}">${fills.join('')}</fills><borders count="${borders.length}">${borders.join('')}</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', compression: 'DEFLATE' });
}

// ---- Dışa aktarma: ods (SheetJS) ---------------------------------------------------------
export function exportOds(wb) {
  const out = XLSX.utils.book_new();
  wb.sheets.forEach((sh, si) => {
    const ws = { '!data': [] };
    const b = wb.bounds(si);
    for (const [k, cell] of sh.cells) {
      const r = rowOf(k), c = colOf(k);
      const v = cell.f != null ? wb.value(si, r, c) : cell.v;
      let x;
      if (typeof v === 'number') x = { t: 'n', v };
      else if (typeof v === 'boolean') x = { t: 'b', v };
      else if (v instanceof FErr) x = { t: 'e', v: 0x0f, w: v.code };
      else if (v != null) x = { t: 's', v: String(v) };
      else if (cell.f == null) continue;
      else x = { t: 's', v: '' };
      if (cell.f != null) x.f = cell.f;
      if (cell.s && cell.s.z) x.z = cell.s.z;
      (ws['!data'][r] ||= [])[c] = x;
    }
    ws['!ref'] = b.maxR >= 0 ? `A1:${addr(b.maxR, Math.max(0, b.maxC))}` : 'A1';
    ws['!merges'] = sh.merges.map((m) => ({ s: { r: m.r1, c: m.c1 }, e: { r: m.r2, c: m.c2 } }));
    XLSX.utils.book_append_sheet(out, ws, sh.name.slice(0, 31));
  });
  const data = XLSX.write(out, { bookType: 'ods', type: 'array', dense: true });
  return new Blob([data], { type: 'application/vnd.oasis.opendocument.spreadsheet' });
}

// ---- Dışa aktarma: CSV ---------------------------------------------------------------------
// Formül enjeksiyonu koruması: = + - @ ile başlayan METİN hücrelerinin başına ' eklenir,
// böylece CSV başka bir programda açıldığında komut çalıştıramaz.
export function exportCsv(wb, si, { sep = ',', localized = false } = {}) {
  const sh = wb.sheets[si];
  const b = wb.bounds(si);
  const lines = [];
  for (let r = 0; r <= b.maxR; r++) {
    const row = [];
    for (let c = 0; c <= b.maxC; c++) {
      const cell = sh.cells.get(key(r, c));
      const v = cell ? (cell.f != null ? wb.value(si, r, c) : cell.v) : null;
      let s;
      if (v == null) s = '';
      else if (typeof v === 'number') s = localized ? formatValue(v, cell && cell.s && cell.s.z) : String(v);
      else if (typeof v === 'boolean') s = localized ? (v ? 'DOĞRU' : 'YANLIŞ') : (v ? 'TRUE' : 'FALSE');
      else if (v instanceof FErr) s = v.code;
      else {
        s = String(v);
        if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      }
      if (s.includes(sep) || /["\r\n]/.test(s) || /^\s|\s$/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
      row.push(s);
    }
    lines.push(row.join(sep));
  }
  return new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
}

// Yazdırma / HTML için tablo görünümü (yalnızca textContent ile oluşturulur).
export function sheetToTable(wb, si, doc = document) {
  const sh = wb.sheets[si];
  const b = wb.bounds(si);
  const table = doc.createElement('table');
  table.className = 'print-sheet';
  const covered = new Set();
  const mergeStart = new Map();
  for (const m of sh.merges) {
    mergeStart.set(key(m.r1, m.c1), m);
    for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) if (r !== m.r1 || c !== m.c1) covered.add(key(r, c));
  }
  const cg = doc.createElement('colgroup');
  for (let c = 0; c <= b.maxC; c++) {
    const col = doc.createElement('col');
    col.style.width = (sh.colW.has(c) ? sh.colW.get(c) : DEF_W) + 'px';
    cg.append(col);
  }
  table.append(cg);
  for (let r = 0; r <= b.maxR; r++) {
    if (sh.rowH.get(r) === 0) continue;
    const tr = doc.createElement('tr');
    for (let c = 0; c <= b.maxC; c++) {
      const k = key(r, c);
      if (covered.has(k) || sh.colW.get(c) === 0) continue;
      const td = doc.createElement('td');
      const m = mergeStart.get(k);
      if (m) { td.rowSpan = m.r2 - m.r1 + 1; td.colSpan = m.c2 - m.c1 + 1; }
      const cell = sh.cells.get(k);
      if (cell) {
        const v = cell.f != null ? wb.value(si, r, c) : cell.v;
        const s = cell.s || {};
        td.textContent = formatValue(v, s.z);
        applyCellCss(td.style, s, v);
      }
      tr.append(td);
    }
    table.append(tr);
  }
  return table;
}

export function applyCellCss(st, s, v) {
  if (s.b) st.fontWeight = 'bold';
  if (s.i) st.fontStyle = 'italic';
  const deco = [s.u && 'underline', s.st && 'line-through'].filter(Boolean).join(' ');
  if (deco) st.textDecoration = deco;
  if (s.fc) st.color = s.fc;
  if (s.bg) st.background = s.bg;
  if (s.fs) st.fontSize = s.fs + 'pt';
  if (s.ff) st.fontFamily = `"${String(s.ff).replace(/["\\;{}<>]/g, '')}", sans-serif`;
  st.textAlign = s.ha || (typeof v === 'number' ? 'right' : typeof v === 'boolean' || v instanceof FErr ? 'center' : 'left');
  st.verticalAlign = s.va === 'top' ? 'top' : s.va === 'middle' ? 'middle' : 'bottom';
  if (s.wr) st.whiteSpace = 'pre-wrap';
  const bd = (c) => `1px solid ${c === true ? '#000' : c}`;
  if (s.bt) st.borderTop = bd(s.bt);
  if (s.bb) st.borderBottom = bd(s.bb);
  if (s.bl) st.borderLeft = bd(s.bl);
  if (s.br) st.borderRight = bd(s.br);
}

export { parseNumberText, parseDateText };
