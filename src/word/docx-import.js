// .docx okuyucu. Belgeyi doğrudan DOM öğeleri olarak kurar (HTML metni birleştirmez),
// böylece belgeye gömülü hiçbir içerik betik olarak çalışamaz. Dış bağlantılı resimler
// (r:link) bilerek yüklenmez: bu, bilinen "harici dosya erişimi" ve NTLM sızıntısı
// saldırılarının kapısını kapatır.
import JSZip from 'jszip';
import { checkZip, parseXml, mimeFromExt } from '../core/files.js';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const kids = (el, name) => (el ? Array.from(el.children).filter((c) => c.localName === name) : []);
function kid(el, name) {
  if (!el) return null;
  for (const c of el.children) if (c.localName === name) return c;
  return null;
}
function desc(el, name) {
  if (!el) return null;
  const all = el.getElementsByTagNameNS('*', name);
  return all.length ? all[0] : null;
}
function wattr(el, name) {
  if (!el) return null;
  let v = el.getAttributeNS(W_NS, name);
  if (v == null || v === '') v = el.getAttribute('w:' + name);
  return v === '' ? null : v;
}
function rattr(el, name) {
  if (!el) return null;
  return el.getAttributeNS(R_NS, name) || el.getAttribute('r:' + name) || null;
}
const isOn = (el) => !!el && !['0', 'false', 'off', 'none'].includes((wattr(el, 'val') || '').toLowerCase());
const num = (v) => (v == null || v === '' || isNaN(+v) ? undefined : +v);
const hexColor = (v) => (v && /^[0-9a-f]{6}$/i.test(v) ? '#' + v.toLowerCase() : undefined);

const HIGHLIGHT = {
  yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000',
  darkBlue: '#000080', darkCyan: '#008080', darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000',
  darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000', white: '#ffffff',
};

export function cssFont(name) {
  const clean = String(name).replace(/["'\\;{}<>]/g, '').trim();
  if (!clean) return '';
  const serif = /times|cambria|georgia|garamond|serif|book antiqua|palatino/i.test(clean);
  return `"${clean}", ${serif ? 'serif' : 'sans-serif'}`;
}

function resolvePath(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/');
  parts.pop();
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

async function loadRels(zip, partPath) {
  const dir = partPath.includes('/') ? partPath.slice(0, partPath.lastIndexOf('/') + 1) : '';
  const relPath = dir + '_rels/' + partPath.slice(dir.length) + '.rels';
  const f = zip.file(relPath);
  const map = new Map();
  if (!f) return map;
  const xml = parseXml(await f.async('string'));
  for (const r of xml.getElementsByTagNameNS('*', 'Relationship')) {
    const external = r.getAttribute('TargetMode') === 'External';
    const target = r.getAttribute('Target') || '';
    map.set(r.getAttribute('Id'), {
      type: r.getAttribute('Type') || '',
      external,
      target: external ? target : resolvePath(partPath, target),
    });
  }
  return map;
}

async function findMainPart(zip) {
  const f = zip.file('_rels/.rels');
  if (f) {
    const xml = parseXml(await f.async('string'));
    for (const r of xml.getElementsByTagNameNS('*', 'Relationship')) {
      if (/\/officeDocument$/.test(r.getAttribute('Type') || '')) {
        const t = (r.getAttribute('Target') || '').replace(/^\//, '');
        if (zip.file(t)) return t;
      }
    }
  }
  return 'word/document.xml';
}

// ---- Özellik ayrıştırma -----------------------------------------------------------
function parseRPr(rPr, theme) {
  const o = {};
  if (!rPr) return o;
  const b = kid(rPr, 'b'); if (b) o.b = isOn(b);
  const i = kid(rPr, 'i'); if (i) o.i = isOn(i);
  const st = kid(rPr, 'strike') || kid(rPr, 'dstrike'); if (st) o.strike = isOn(st);
  const caps = kid(rPr, 'caps'); if (caps) o.caps = isOn(caps);
  const sc = kid(rPr, 'smallCaps'); if (sc) o.smallCaps = isOn(sc);
  const van = kid(rPr, 'vanish'); if (van) o.vanish = isOn(van);
  const u = kid(rPr, 'u'); if (u) o.u = (wattr(u, 'val') || 'single') !== 'none';
  const c = kid(rPr, 'color'); if (c) { const col = hexColor(wattr(c, 'val')); if (col) o.color = col; }
  const sz = kid(rPr, 'sz'); if (sz && num(wattr(sz, 'val'))) o.sz = num(wattr(sz, 'val')) / 2;
  const f = kid(rPr, 'rFonts');
  if (f) {
    const name = wattr(f, 'ascii') || wattr(f, 'hAnsi') || wattr(f, 'cs');
    const th = wattr(f, 'asciiTheme') || wattr(f, 'hAnsiTheme');
    if (name) o.font = name;
    else if (th && theme) o.font = /^major/.test(th) ? theme.major : theme.minor;
  }
  const hl = kid(rPr, 'highlight'); if (hl && HIGHLIGHT[wattr(hl, 'val')]) o.bg = HIGHLIGHT[wattr(hl, 'val')];
  const shd = kid(rPr, 'shd'); if (shd && !o.bg) { const col = hexColor(wattr(shd, 'fill')); if (col) o.bg = col; }
  const va = kid(rPr, 'vertAlign'); if (va) { const v = wattr(va, 'val'); if (v === 'superscript' || v === 'subscript') o.vert = v; else o.vert = null; }
  return o;
}

function parsePPr(pPr) {
  const o = {};
  if (!pPr) return o;
  const ps = kid(pPr, 'pStyle'); if (ps) o.styleId = wattr(ps, 'val');
  const jc = kid(pPr, 'jc');
  if (jc) {
    const v = wattr(jc, 'val');
    o.align = v === 'center' ? 'center' : (v === 'right' || v === 'end') ? 'right' : (v === 'both' || v === 'distribute' || v === 'thaiDistribute') ? 'justify' : 'left';
  }
  const ind = kid(pPr, 'ind');
  if (ind) {
    const left = num(wattr(ind, 'left') ?? wattr(ind, 'start'));
    const right = num(wattr(ind, 'right') ?? wattr(ind, 'end'));
    const first = num(wattr(ind, 'firstLine'));
    const hang = num(wattr(ind, 'hanging'));
    if (left != null) o.indLeft = left / 20;
    if (right != null) o.indRight = right / 20;
    if (first != null) o.firstLine = first / 20;
    if (hang != null) o.firstLine = -hang / 20;
  }
  const sp = kid(pPr, 'spacing');
  if (sp) {
    const before = num(wattr(sp, 'before')); if (before != null) o.before = before / 20;
    const after = num(wattr(sp, 'after')); if (after != null) o.after = after / 20;
    if (isOn(kid(sp, 'x')) || wattr(sp, 'beforeAutospacing') === '1') o.before = o.before ?? 14;
    if (wattr(sp, 'afterAutospacing') === '1') o.after = o.after ?? 14;
    const line = num(wattr(sp, 'line'));
    if (line != null) {
      const rule = wattr(sp, 'lineRule') || 'auto';
      o.line = rule === 'auto' ? { mult: line / 240 } : { pt: line / 20 };
    }
  }
  const numPr = kid(pPr, 'numPr');
  if (numPr) {
    const id = wattr(kid(numPr, 'numId'), 'val');
    const lvl = num(wattr(kid(numPr, 'ilvl'), 'val')) || 0;
    if (id != null) o.num = { numId: id, ilvl: lvl };
  }
  const shd = kid(pPr, 'shd'); if (shd) { const col = hexColor(wattr(shd, 'fill')); if (col) o.bg = col; }
  if (isOn(kid(pPr, 'pageBreakBefore'))) o.pageBreakBefore = true;
  const ol = kid(pPr, 'outlineLvl'); if (ol && num(wattr(ol, 'val')) != null) o.outline = num(wattr(ol, 'val'));
  return o;
}

function defined(o) {
  const r = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) r[k] = v;
  return r;
}

// ---- Stiller ------------------------------------------------------------------------
async function loadTheme(zip) {
  const f = zip.file('word/theme/theme1.xml');
  const th = { major: 'Calibri Light', minor: 'Calibri' };
  if (!f) return th;
  try {
    const xml = parseXml(await f.async('string'));
    const maj = desc(xml.getElementsByTagNameNS('*', 'majorFont')[0], 'latin');
    const min = desc(xml.getElementsByTagNameNS('*', 'minorFont')[0], 'latin');
    if (maj && maj.getAttribute('typeface')) th.major = maj.getAttribute('typeface');
    if (min && min.getAttribute('typeface')) th.minor = min.getAttribute('typeface');
  } catch { /* varsayılanları kullan */ }
  return th;
}

async function loadStyles(zip, theme) {
  const styles = { byId: new Map(), defaults: { r: { sz: 10, font: 'Times New Roman' }, p: {} }, defaultPara: null, cache: new Map() };
  const f = zip.file('word/styles.xml');
  if (!f) return styles;
  const xml = parseXml(await f.async('string'));
  const dd = xml.getElementsByTagNameNS('*', 'docDefaults')[0];
  if (dd) {
    Object.assign(styles.defaults.r, defined(parseRPr(desc(desc(dd, 'rPrDefault'), 'rPr'), theme)));
    Object.assign(styles.defaults.p, defined(parsePPr(desc(desc(dd, 'pPrDefault'), 'pPr'))));
  }
  for (const s of xml.getElementsByTagNameNS('*', 'style')) {
    if (s.parentElement !== xml.documentElement) continue;
    const id = wattr(s, 'styleId');
    const type = wattr(s, 'type');
    const name = (wattr(kid(s, 'name'), 'val') || '').toLowerCase();
    const pPr = parsePPr(kid(s, 'pPr'));
    delete pPr.styleId;
    const tblPr = kid(s, 'tblPr');
    styles.byId.set(id, {
      id, type, name, basedOn: wattr(kid(s, 'basedOn'), 'val'),
      r: parseRPr(kid(s, 'rPr'), theme), p: pPr, tblPr,
    });
    if (type === 'paragraph' && (wattr(s, 'default') === '1' || wattr(s, 'default') === 'true')) styles.defaultPara = id;
  }
  return styles;
}

function resolveStyle(styles, id, depth = 0) {
  if (!id || depth > 20) return { r: {}, p: {}, heading: 0, tblPr: null };
  if (styles.cache.has(id)) return styles.cache.get(id);
  const s = styles.byId.get(id);
  if (!s) return { r: {}, p: {}, heading: 0, tblPr: null };
  const parent = resolveStyle(styles, s.basedOn, depth + 1);
  let heading = 0;
  const m = /^heading\s*(\d)$/.exec(s.name);
  if (m) heading = Math.min(6, +m[1]);
  else if (s.name === 'title') heading = 1;
  else if (s.p.outline != null && s.p.outline < 6) heading = s.p.outline + 1;
  else heading = parent.heading;
  const res = {
    r: { ...parent.r, ...s.r },
    p: { ...parent.p, ...s.p },
    heading,
    tblPr: s.tblPr || parent.tblPr,
  };
  styles.cache.set(id, res);
  return res;
}

// ---- Numaralandırma ---------------------------------------------------------------
async function loadNumbering(zip) {
  const res = { abstract: new Map(), nums: new Map() };
  const f = zip.file('word/numbering.xml');
  if (!f) return res;
  const xml = parseXml(await f.async('string'));
  for (const a of xml.getElementsByTagNameNS('*', 'abstractNum')) {
    const levels = new Map();
    for (const l of kids(a, 'lvl')) {
      levels.set(num(wattr(l, 'ilvl')) || 0, {
        fmt: wattr(kid(l, 'numFmt'), 'val') || 'decimal',
        start: num(wattr(kid(l, 'start'), 'val')) ?? 1,
      });
    }
    res.abstract.set(wattr(a, 'abstractNumId'), levels);
  }
  for (const n of xml.getElementsByTagNameNS('*', 'num')) {
    res.nums.set(wattr(n, 'numId'), wattr(kid(n, 'abstractNumId'), 'val'));
  }
  return res;
}

function numFormat(numbering, numId, ilvl) {
  const abs = numbering.abstract.get(numbering.nums.get(numId));
  const lvl = abs && (abs.get(ilvl) || abs.get(0));
  const fmt = lvl ? lvl.fmt : 'bullet';
  if (fmt === 'none') return null;
  const types = { decimal: '1', lowerLetter: 'a', upperLetter: 'A', lowerRoman: 'i', upperRoman: 'I', decimalZero: '1' };
  if (fmt === 'bullet') return { ordered: false };
  return { ordered: true, type: types[fmt] || '1', start: lvl ? lvl.start : 1 };
}

// ---- Oluşturma ----------------------------------------------------------------------
function applyRunCss(el, props, base) {
  const s = el.style;
  if (!!props.b !== !!base.b) s.fontWeight = props.b ? 'bold' : 'normal';
  if (!!props.i !== !!base.i) s.fontStyle = props.i ? 'italic' : 'normal';
  if (!!props.u !== !!base.u || !!props.strike !== !!base.strike) {
    s.textDecorationLine = [props.u && 'underline', props.strike && 'line-through'].filter(Boolean).join(' ') || 'none';
  }
  if (props.color && props.color !== base.color) s.color = props.color;
  if (props.sz && props.sz !== base.sz) s.fontSize = props.sz + 'pt';
  if (props.font && props.font !== base.font) s.fontFamily = cssFont(props.font);
  if (props.bg && props.bg !== base.bg) s.backgroundColor = props.bg;
  if (props.vert && props.vert !== base.vert) {
    s.verticalAlign = props.vert === 'superscript' ? 'super' : 'sub';
    s.fontSize = ((props.sz || 11) * 0.7).toFixed(1) + 'pt';
  }
  if (props.caps && !base.caps) s.textTransform = 'uppercase';
  if (props.smallCaps && !base.smallCaps) s.fontVariant = 'small-caps';
}

function normText(t) {
  return t.replace(/ {2,}/g, (m) => ' ' + '\u00a0'.repeat(m.length - 1));
}

function pageBreakEl() {
  const d = document.createElement('div');
  d.className = 'offisea-page-break';
  d.setAttribute('contenteditable', 'false');
  return d;
}

function makeImage(ctx, rid, wPx, hPx) {
  const rel = ctx.rels.get(rid);
  if (!rel || rel.external) return null; // harici resimler bilerek yüklenmez
  const src = ctx.images.get(rel.target);
  if (!src) {
    const span = document.createElement('span');
    span.textContent = '[desteklenmeyen resim]';
    span.style.color = '#888';
    return span;
  }
  const img = document.createElement('img');
  img.src = src;
  img.alt = '';
  if (wPx) img.style.width = Math.round(wPx) + 'px';
  if (hPx && wPx) img.style.height = 'auto';
  return img;
}

function renderRun(r, parent, ctx, base, state) {
  const direct = parseRPr(kid(r, 'rPr'), ctx.theme);
  const rStyle = wattr(kid(kid(r, 'rPr'), 'rStyle'), 'val');
  const props = { ...base, ...(rStyle ? resolveStyle(ctx.styles, rStyle).r : {}), ...defined(direct) };
  if (props.vanish) return;
  let span = null;
  const target = () => {
    if (span) return span;
    const probe = document.createElement('span');
    applyRunCss(probe, props, base);
    if (probe.getAttribute('style')) { span = probe; parent.append(span); return span; }
    return parent;
  };
  const processChild = (ch) => {
    switch (ch.localName) {
      case 't': target().append(document.createTextNode(normText(ch.textContent))); break;
      case 'tab': {
        const t = document.createElement('span');
        t.className = 'offisea-tab';
        t.textContent = '\t';
        target().append(t);
        break;
      }
      case 'br':
        if (wattr(ch, 'type') === 'page') state.pageBreak = true;
        else target().append(document.createElement('br'));
        break;
      case 'cr': target().append(document.createElement('br')); break;
      case 'noBreakHyphen': target().append('\u2011'); break;
      case 'softHyphen': target().append('\u00ad'); break;
      case 'sym': {
        let code = parseInt(wattr(ch, 'char') || '', 16);
        if (code >= 0xf000) code -= 0xf000;
        if (code > 0) target().append(String.fromCharCode(code));
        break;
      }
      case 'drawing': case 'pict': case 'object': {
        const blip = desc(ch, 'blip');
        if (blip) {
          const ext = desc(ch, 'extent');
          const w = ext ? num(ext.getAttribute('cx')) / 9525 : 0;
          const hgt = ext ? num(ext.getAttribute('cy')) / 9525 : 0;
          const img = makeImage(ctx, rattr(blip, 'embed'), w, hgt);
          if (img) target().append(img);
        } else {
          const vimg = desc(ch, 'imagedata');
          if (vimg) {
            const shape = vimg.parentElement;
            const st = (shape && shape.getAttribute('style')) || '';
            const wm = /width:\s*([\d.]+)pt/.exec(st);
            const img = makeImage(ctx, rattr(vimg, 'id'), wm ? +wm[1] * 1.333 : 0, 0);
            if (img) target().append(img);
          }
        }
        for (const tx of ch.getElementsByTagNameNS('*', 'txbxContent')) state.extra.push(tx);
        break;
      }
      case 'AlternateContent': {
        const choice = kid(ch, 'Choice') || kid(ch, 'Fallback');
        if (choice) for (const c of choice.children) processChild(c);
        break;
      }
      default: break;
    }
  };
  for (const ch of r.children) processChild(ch);
}

function renderInline(nodes, parent, ctx, base, state) {
  for (const n of nodes) {
    switch (n.localName) {
      case 'r': renderRun(n, parent, ctx, base, state); break;
      case 'hyperlink': {
        const rel = ctx.rels.get(rattr(n, 'id'));
        const href = rel && rel.external ? rel.target : null;
        if (href && /^(https?:|mailto:)/i.test(href)) {
          const a = document.createElement('a');
          a.href = href;
          a.rel = 'noopener noreferrer nofollow';
          parent.append(a);
          renderInline(n.children, a, ctx, base, state);
        } else renderInline(n.children, parent, ctx, base, state);
        break;
      }
      case 'sdt': renderInline((kid(n, 'sdtContent') || n).children, parent, ctx, base, state); break;
      case 'smartTag': case 'customXml': case 'sdtContent': case 'ins': case 'moveTo': case 'fldSimple': case 'dir': case 'bdo':
        renderInline(n.children, parent, ctx, base, state);
        break;
      case 'oMath': case 'oMathPara': {
        const span = document.createElement('span');
        span.style.fontStyle = 'italic';
        span.textContent = Array.from(n.getElementsByTagNameNS('*', 't'), (t) => t.textContent).join('');
        parent.append(span);
        break;
      }
      default: break;
    }
  }
}

function renderParagraph(p, ctx) {
  const direct = parsePPr(kid(p, 'pPr'));
  const st = resolveStyle(ctx.styles, direct.styleId || ctx.styles.defaultPara);
  const pp = { ...ctx.styles.defaults.p, ...st.p, ...defined(direct) };
  const pRunDirect = {};
  const base = { ...ctx.styles.defaults.r, ...st.r, ...pRunDirect };
  const heading = direct.outline != null && direct.outline < 6 ? direct.outline + 1 : st.heading;
  const el = document.createElement(heading ? 'h' + heading : 'p');
  const s = el.style;
  if (pp.align && pp.align !== 'left') s.textAlign = pp.align;
  const inList = !!(pp.num && pp.num.numId && pp.num.numId !== '0');
  if (!inList) {
    if (pp.indLeft) s.marginLeft = pp.indLeft + 'pt';
    if (pp.firstLine) s.textIndent = pp.firstLine + 'pt';
  }
  if (pp.indRight) s.marginRight = pp.indRight + 'pt';
  s.marginTop = (pp.before || 0) + 'pt';
  s.marginBottom = (pp.after || 0) + 'pt';
  if (pp.line) s.lineHeight = pp.line.mult ? (pp.line.mult * 1.15).toFixed(2) : pp.line.pt + 'pt';
  if (pp.bg) s.backgroundColor = pp.bg;
  // Paragrafın temel yazı tipi özellikleri
  if (base.font) s.fontFamily = cssFont(base.font);
  if (base.sz) s.fontSize = base.sz + 'pt';
  if (base.color) s.color = base.color;
  if (base.b) s.fontWeight = 'bold';
  else if (heading) s.fontWeight = 'normal';
  if (base.i) s.fontStyle = 'italic';
  if (base.u || base.strike) s.textDecorationLine = [base.u && 'underline', base.strike && 'line-through'].filter(Boolean).join(' ');
  if (base.caps) s.textTransform = 'uppercase';
  const state = { pageBreak: false, extra: [] };
  renderInline(p.children, el, ctx, base, state);
  if (!el.textContent && !el.querySelector('img')) el.append(document.createElement('br'));
  return { el, num: inList ? pp.num : null, pageBreak: state.pageBreak, pageBreakBefore: !!pp.pageBreakBefore, extra: state.extra };
}

function bordersOf(tblPr) {
  const b = kid(tblPr, 'tblBorders');
  if (!b) return null;
  let visible = false, color = '#000000';
  for (const side of b.children) {
    const v = wattr(side, 'val');
    if (v && v !== 'nil' && v !== 'none') { visible = true; const c = hexColor(wattr(side, 'color')); if (c) color = c; }
  }
  return { visible, color };
}

function renderTable(tbl, ctx) {
  const table = document.createElement('table');
  table.style.borderCollapse = 'collapse';
  table.style.width = '100%';
  const tblPr = kid(tbl, 'tblPr');
  const styleId = wattr(kid(tblPr, 'tblStyle'), 'val');
  const borders = bordersOf(tblPr) || bordersOf(resolveStyle(ctx.styles, styleId).tblPr) || { visible: false };
  const tbody = document.createElement('tbody');
  table.append(tbody);
  const origin = [];
  const rows = [];
  const collectRows = (parent) => {
    for (const ch of parent.children) {
      if (ch.localName === 'tr') rows.push(ch);
      else if (ch.localName === 'sdt') collectRows(kid(ch, 'sdtContent') || ch);
      else if (ch.localName === 'customXml') collectRows(ch);
    }
  };
  collectRows(tbl);
  for (const tr of rows) {
    const row = document.createElement('tr');
    let col = 0;
    const cells = [];
    const collectCells = (parent) => {
      for (const ch of parent.children) {
        if (ch.localName === 'tc') cells.push(ch);
        else if (ch.localName === 'sdt') collectCells(kid(ch, 'sdtContent') || ch);
        else if (ch.localName === 'customXml') collectCells(ch);
      }
    };
    collectCells(tr);
    for (const tc of cells) {
      const tcPr = kid(tc, 'tcPr');
      const span = num(wattr(kid(tcPr, 'gridSpan'), 'val')) || 1;
      const vm = kid(tcPr, 'vMerge');
      if (vm && wattr(vm, 'val') !== 'restart') {
        if (origin[col]) origin[col].rowSpan += 1;
        col += span;
        continue;
      }
      const td = document.createElement('td');
      if (span > 1) td.colSpan = span;
      origin[col] = vm ? td : null;
      const shd = hexColor(wattr(kid(tcPr, 'shd'), 'fill'));
      if (shd) td.style.backgroundColor = shd;
      const w = kid(tcPr, 'tcW');
      if (w && wattr(w, 'type') === 'dxa' && num(wattr(w, 'w'))) td.style.width = (num(wattr(w, 'w')) / 20).toFixed(1) + 'pt';
      const va = wattr(kid(tcPr, 'vAlign'), 'val');
      if (va === 'center') td.style.verticalAlign = 'middle';
      else if (va === 'bottom') td.style.verticalAlign = 'bottom';
      else td.style.verticalAlign = 'top';
      td.style.border = borders.visible ? `1px solid ${borders.color}` : 'none';
      td.style.padding = '2pt 5pt';
      renderBlocks(tc, td, ctx);
      if (!td.firstChild) td.append(document.createElement('br'));
      row.append(td);
      col += span;
    }
    tbody.append(row);
  }
  return table;
}

function renderBlocks(container, out, ctx, depth = 0) {
  if (!container || depth > 30) return;
  let stack = [];
  for (const ch of container.children) {
    switch (ch.localName) {
      case 'p': {
        const r = renderParagraph(ch, ctx);
        if (r.pageBreakBefore) { out.append(pageBreakEl()); stack = []; }
        const fmt = r.num ? numFormat(ctx.numbering, r.num.numId, r.num.ilvl) : null;
        if (fmt) {
          const lvl = Math.min(8, r.num.ilvl || 0);
          while (stack.length > lvl + 1) stack.pop();
          if (stack.length === lvl + 1) {
            const top = stack[lvl];
            if (top.numId !== r.num.numId || top.ordered !== fmt.ordered) stack.pop();
          }
          while (stack.length < lvl + 1) {
            const list = document.createElement(fmt.ordered ? 'ol' : 'ul');
            if (fmt.ordered) {
              if (fmt.type !== '1') list.type = fmt.type;
              if (fmt.start > 1) list.start = fmt.start;
            }
            if (!stack.length) out.append(list);
            else {
              const parentList = stack[stack.length - 1].el;
              let li = parentList.lastElementChild;
              if (!li) { li = document.createElement('li'); parentList.append(li); }
              li.append(list);
            }
            stack.push({ el: list, numId: r.num.numId, ordered: fmt.ordered });
          }
          const li = document.createElement('li');
          if (r.el.tagName === 'P') {
            const st = r.el.getAttribute('style');
            if (st) li.setAttribute('style', st);
            li.style.marginTop = '0pt';
            li.style.marginBottom = '0pt';
            li.append(...r.el.childNodes);
          } else li.append(r.el);
          stack[lvl].el.append(li);
        } else {
          stack = [];
          out.append(r.el);
        }
        for (const tx of r.extra) {
          const box = document.createElement('div');
          box.style.border = '1px solid #999999';
          box.style.padding = '4pt';
          box.style.marginBottom = '6pt';
          renderBlocks(tx, box, ctx, depth + 1);
          out.append(box);
        }
        if (r.pageBreak) { out.append(pageBreakEl()); stack = []; }
        break;
      }
      case 'tbl': stack = []; out.append(renderTable(ch, ctx)); break;
      case 'sdt': renderBlocks(kid(ch, 'sdtContent') || ch, out, ctx, depth + 1); break;
      case 'customXml': case 'ins': case 'moveTo': renderBlocks(ch, out, ctx, depth + 1); break;
      default: break;
    }
  }
}

export async function importDocx(buffer) {
  checkZip(buffer);
  const zip = await JSZip.loadAsync(buffer);
  const mainPath = await findMainPart(zip);
  const main = zip.file(mainPath);
  if (!main) throw new Error('Bu dosya geçerli bir Word belgesi değil.');
  const xml = parseXml(await main.async('string'));
  const theme = await loadTheme(zip);
  const ctx = {
    zip, theme,
    rels: await loadRels(zip, mainPath),
    styles: await loadStyles(zip, theme),
    numbering: await loadNumbering(zip),
    images: new Map(),
  };
  // Resimleri önceden yükle (yalnızca paket içindekiler).
  for (const rel of ctx.rels.values()) {
    if (rel.external || !/\/image$/.test(rel.type)) continue;
    const f = zip.file(rel.target);
    const mime = mimeFromExt((rel.target.split('.').pop() || '').toLowerCase());
    if (!f || !mime || mime === 'image/svg+xml' || mime === 'image/tiff') continue;
    ctx.images.set(rel.target, `data:${mime};base64,${await f.async('base64')}`);
  }
  const body = xml.getElementsByTagNameNS('*', 'body')[0];
  const out = document.createElement('div');
  renderBlocks(body, out, ctx);
  if (!out.firstChild) out.append(document.createElement('p'));
  return out.innerHTML;
}
