// Sunuyu PowerPoint (.pptx) dosyasına çevirir (pptxgenjs). Resimler yalnızca gömülü veri
// olarak eklenir; hiçbir dış adres yüklenmez. Şekil adları beyaz listeden geçer.
import PptxGenJS from 'pptxgenjs';
import JSZip from 'jszip';
import { sanitizeSlideHtml } from '../core/sanitize.js';
import { isSafeUrl } from '../core/platform.js';

const IN = (px) => Math.round((px / 96) * 10000) / 10000;
const PT = (px) => Math.round(px * 0.75 * 10) / 10;
const SHAPE_OK = new Set(['rect', 'roundRect', 'ellipse', 'triangle', 'rtTriangle', 'diamond', 'rightArrow', 'leftArrow', 'star5', 'hexagon', 'pentagon', 'chevron', 'parallelogram', 'trapezoid', 'line']);

function parseColor(c) {
  if (!c || typeof c !== 'string') return null;
  c = c.trim().toLowerCase();
  if (c === 'none' || c === 'transparent') return null;
  let m = /^#([0-9a-f]{3})$/.exec(c);
  if (m) return { hex: m[1].split('').map((x) => x + x).join('').toUpperCase(), a: 1 };
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(c);
  if (m) return { hex: m[1].toUpperCase(), a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(c);
  if (m) {
    const hex = [m[1], m[2], m[3]].map((v) => Math.max(0, Math.min(255, Math.round(+v))).toString(16).padStart(2, '0')).join('').toUpperCase();
    let a = 1;
    if (m[4] != null) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4];
    if (a <= 0) return null;
    return { hex, a };
  }
  return null;
}
const hexOf = (c) => { const p = parseColor(c); return p ? p.hex : undefined; };

function fillOf(c, opacity = 1) {
  const p = parseColor(c);
  if (!p) return { type: 'none' };
  const alpha = p.a * opacity;
  return alpha < 0.999 ? { color: p.hex, transparency: Math.round((1 - alpha) * 100) } : { color: p.hex };
}

function cleanFont(f) {
  if (!f) return undefined;
  const first = String(f).split(',')[0].replace(/["']/g, '').trim();
  return first && !/^(serif|sans-serif|monospace|system-ui|inherit)$/i.test(first) ? first.slice(0, 60) : undefined;
}

// ---- HTML -> metin parçaları -----------------------------------------------------------------
const BLOCK = /^(P|DIV|LI|H[1-6]|BLOCKQUOTE|PRE|TR)$/;

function htmlToRuns(html, { list = false } = {}) {
  const box = document.createElement('div');
  box.innerHTML = sanitizeSlideHtml(html || '');
  const paras = [];
  let curPara = null;
  const newPara = (props) => { curPara = { runs: [], ...props }; paras.push(curPara); return curPara; };

  const inlineStyle = (el, st) => {
    const s = { ...st };
    const tag = el.tagName;
    if (tag === 'B' || tag === 'STRONG') s.bold = true;
    if (tag === 'I' || tag === 'EM') s.italic = true;
    if (tag === 'U') s.underline = true;
    if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') s.strike = true;
    if (tag === 'SUP') s.superscript = true;
    if (tag === 'SUB') s.subscript = true;
    if (tag === 'A') { const href = el.getAttribute('href') || ''; if (isSafeUrl(href)) s.link = new URL(href).href; }
    if (tag === 'FONT') {
      if (el.getAttribute('color')) s.color = hexOf(el.getAttribute('color')) || s.color;
      if (el.getAttribute('face')) s.font = cleanFont(el.getAttribute('face')) || s.font;
    }
    const css = el.style;
    if (css) {
      if (css.fontSize && /px$/.test(css.fontSize)) s.size = PT(parseFloat(css.fontSize));
      else if (css.fontSize && /pt$/.test(css.fontSize)) s.size = parseFloat(css.fontSize);
      if (css.color) s.color = hexOf(css.color) || s.color;
      if (css.fontFamily) s.font = cleanFont(css.fontFamily) || s.font;
      if (css.fontWeight) s.bold = css.fontWeight === 'bold' || +css.fontWeight >= 600;
      if (css.fontStyle) s.italic = css.fontStyle === 'italic';
      const deco = css.textDecorationLine || css.textDecoration || '';
      if (deco.includes('underline')) s.underline = true;
      if (deco.includes('line-through')) s.strike = true;
      if (css.backgroundColor) { const hl = hexOf(css.backgroundColor); if (hl) s.highlight = hl; }
      if (css.textTransform === 'uppercase') s.upper = true;
    }
    return s;
  };

  const pushText = (text, st) => {
    if (!curPara) newPara({});
    if (st.upper) text = text.toLocaleUpperCase('tr');
    curPara.runs.push({ text, st });
  };

  const walk = (node, st, ctx) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) {
        const t = n.textContent.replace(/[\r\n\t]+/g, ' ');
        if (t) pushText(t, st);
        continue;
      }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName;
      if (tag === 'BR') { newPara({ ...curParaProps(), soft: true }); continue; }
      if (tag === 'UL' || tag === 'OL') { walk(n, st, { ...ctx, list: tag === 'OL' ? 'number' : 'bullet', level: (ctx.level || 0) + (ctx.list ? 1 : 0) }); curPara = null; continue; }
      if (tag === 'TABLE' || tag === 'TBODY' || tag === 'THEAD') { walk(n, st, ctx); continue; }
      if (tag === 'TD' || tag === 'TH') { walk(n, inlineStyle(n, st), ctx); pushText('\t', st); continue; }
      if (BLOCK.test(tag)) {
        const align = n.style && n.style.textAlign ? n.style.textAlign : ctx.align;
        const ml = n.style && n.style.marginLeft ? parseFloat(n.style.marginLeft) || 0 : 0;
        const p = { align, bullet: tag === 'LI' ? ctx.list : list && tag !== 'TR' ? 'bullet' : null, level: (ctx.level || 0) + (ml > 20 ? Math.min(4, Math.round(ml / 40)) : 0) };
        newPara(p);
        walk(n, inlineStyle(n, st), { ...ctx, align });
        curPara = null;
        continue;
      }
      walk(n, inlineStyle(n, st), ctx);
    }
  };
  const curParaProps = () => (curPara ? { align: curPara.align, bullet: null, level: curPara.level } : {});
  walk(box, {}, {});

  // pptxgenjs biçimine dönüştür
  const runs = [];
  paras.forEach((p, pi) => {
    const last = pi === paras.length - 1;
    const parts = p.runs.length ? p.runs : [{ text: '', st: {} }];
    parts.forEach((r, ri) => {
      const o = {};
      const st = r.st;
      if (st.bold) o.bold = true;
      if (st.italic) o.italic = true;
      if (st.underline) o.underline = { style: 'sng' };
      if (st.strike) o.strike = 'sngStrike';
      if (st.superscript) o.superscript = true;
      if (st.subscript) o.subscript = true;
      if (st.size) o.fontSize = Math.max(1, Math.min(400, st.size));
      if (st.color) o.color = st.color;
      if (st.font) o.fontFace = st.font;
      if (st.highlight) o.highlight = st.highlight;
      if (st.link) o.hyperlink = { url: st.link };
      if (p.align && ['left', 'center', 'right', 'justify'].includes(p.align)) o.align = p.align;
      if (p.bullet) o.bullet = p.bullet === 'number' ? { type: 'number' } : true;
      if (p.level) o.indentLevel = Math.min(8, p.level);
      if (ri === 0 && p.soft && pi > 0) o.softBreakBefore = true;
      if (ri === parts.length - 1 && !last && !(paras[pi + 1] && paras[pi + 1].soft)) o.breakLine = true;
      runs.push({ text: r.text, options: o });
    });
  });
  return runs;
}

// Kırpılmış resimleri tuval üzerinde kırpar (pptx'e olduğu gibi görünen hali gider).
async function croppedData(src, crop) {
  if (!crop) return src;
  const img = new Image();
  img.src = src;
  await img.decode();
  const sx = (crop.l || 0) * img.naturalWidth, sy = (crop.t || 0) * img.naturalHeight;
  const sw = Math.max(1, img.naturalWidth * (1 - (crop.l || 0) - (crop.r || 0)));
  const sh = Math.max(1, img.naturalHeight * (1 - (crop.t || 0) - (crop.b || 0)));
  const c = document.createElement('canvas');
  c.width = Math.round(sw); c.height = Math.round(sh);
  c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c.toDataURL(/^data:image\/jpe?g/i.test(src) ? 'image/jpeg' : 'image/png', 0.92);
}

const pptxData = (dataUrl) => (typeof dataUrl === 'string' && /^data:image\/(png|jpe?g|gif|bmp|webp);base64,/i.test(dataUrl) ? dataUrl.slice(5) : null);

function lineOf(it, defColor) {
  const w = it.strokeW != null ? +it.strokeW : 0;
  const c = parseColor(it.stroke);
  if (!c || w <= 0) return { type: 'none' };
  const o = { color: c.hex, width: Math.max(0.25, PT(w)) };
  if (it.dash) o.dashType = 'dash';
  void defColor;
  return o;
}

function boxOpts(it) {
  const o = { x: IN(it.x), y: IN(it.y), w: IN(Math.max(1, it.w)), h: IN(Math.max(1, it.h)) };
  if (it.rot) o.rotate = ((+it.rot % 360) + 360) % 360;
  if (it.flipH) o.flipH = true;
  if (it.flipV) o.flipV = true;
  return o;
}

function textOpts(it, defaults = {}) {
  const pad = Array.isArray(it.pad) && it.pad.length === 4 ? it.pad : [7, 10, 7, 10];
  const o = {
    ...boxOpts(it),
    fontSize: PT(it.fs || defaults.fs || 24),
    fontFace: cleanFont(it.font) || 'Calibri',
    color: hexOf(it.color || defaults.color) || '000000',
    valign: it.valign || defaults.valign || 'top',
    // pptxgenjs sırası: [sol, sağ, alt, üst] (punto)
    margin: [PT(pad[3]), PT(pad[1]), PT(pad[2]), PT(pad[0])],
    fit: 'none',
  };
  const align = it.align || defaults.align;
  if (align) o.align = align;
  if (it.bold) o.bold = true;
  if (it.italic) o.italic = true;
  if (it.lh) o.lineSpacingMultiple = Math.max(0.5, Math.min(5, +it.lh / 1.2));
  return o;
}

export async function exportPptx(deck, title = 'Sunu') {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'OFFISEA', width: IN(deck.w), height: IN(deck.h) });
  pptx.layout = 'OFFISEA';
  pptx.title = String(title).slice(0, 200);
  pptx.company = 'Offisea';
  pptx.author = 'Offisea';

  for (const s of deck.slides) {
    const slide = pptx.addSlide();
    const bgImg = pptxData(s.bgImg);
    if (bgImg) slide.background = { data: bgImg };
    else slide.background = { color: hexOf(s.bg) || 'FFFFFF' };

    for (const it of s.items) {
      try {
        await addItem(pptx, slide, it);
      } catch (e) {
        console.warn('Öğe dışa aktarılamadı', e);
      }
    }
    if (s.notes) slide.addNotes(String(s.notes).slice(0, 100000));
  }
  let out = await pptx.write({ outputType: 'blob' });
  if (deck.slides.some((s) => TRANSITION_XML[s.transition])) {
    try {
      out = await addTransitions(out, deck.slides);
    } catch (e) {
      console.warn('Geçişler eklenemedi', e);
    }
  }
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
}

// pptxgenjs geçiş desteklemez: oluşan dosyadaki slayt XML'lerine standart <p:transition> eklenir.
// Değerler sabit bir tablodan gelir; kullanıcı verisi XML'e yazılmaz.
const TRANSITION_XML = {
  fade: '<p:transition spd="med"><p:fade/></p:transition>',
  push: '<p:transition spd="med"><p:push dir="l"/></p:transition>',
  wipe: '<p:transition spd="med"><p:wipe dir="r"/></p:transition>',
  cover: '<p:transition spd="med"><p:cover dir="u"/></p:transition>',
  zoom: '<p:transition spd="med"><p:zoom/></p:transition>',
};

async function addTransitions(blob, slides) {
  const zip = await JSZip.loadAsync(blob);
  for (let i = 0; i < slides.length; i++) {
    const xml = TRANSITION_XML[slides[i].transition];
    if (!xml) continue;
    const name = 'ppt/slides/slide' + (i + 1) + '.xml';
    const f = zip.file(name);
    if (!f) continue;
    let s = await f.async('string');
    if (s.includes('<p:transition')) continue;
    // Şemaya göre sıra: cSld, clrMapOvr, transition, timing, extLst
    const m = /<p:timing[\s>]|<p:extLst[\s>]|<\/p:sld>/.exec(s);
    if (!m) continue;
    s = s.slice(0, m.index) + xml + s.slice(m.index);
    zip.file(name, s);
  }
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

async function addItem(pptx, slide, it) {
  const opacity = it.opacity != null ? Math.max(0, Math.min(1, +it.opacity)) : 1;
  if (it.type === 'image') {
    const src = await croppedData(it.src, it.crop);
    const data = pptxData(src);
    if (!data) return;
    const o = { ...boxOpts(it), data };
    if (opacity < 1) o.transparency = Math.round((1 - opacity) * 100);
    if (it.alt) o.altText = String(it.alt).slice(0, 500);
    slide.addImage(o);
    return;
  }

  if (it.type === 'shape') {
    const shape = SHAPE_OK.has(it.shape) ? it.shape : 'rect';
    if (shape === 'line') {
      const c = parseColor(it.stroke) || { hex: '4472C4' };
      const line = { color: c.hex, width: Math.max(0.25, PT(it.strokeW != null ? +it.strokeW : 2)) };
      if (it.dash) line.dashType = 'dash';
      if (it.arrowEnd) line.endArrowType = 'triangle';
      slide.addShape('line', { ...boxOpts(it), line });
      return;
    }
    const base = {
      ...boxOpts(it),
      fill: fillOf(it.fill == null ? '#4472c4' : it.fill, opacity),
      line: lineOf(it),
    };
    if (shape === 'roundRect') base.rectRadius = 0.16;
    const runs = it.html && htmlToRuns(it.html).some((r) => r.text.trim()) ? htmlToRuns(it.html) : null;
    if (runs) {
      slide.addText(runs, { ...textOpts(it, { fs: 20, color: '#ffffff', align: 'center', valign: 'middle' }), ...base, shape });
    } else {
      slide.addShape(shape, base);
    }
    return;
  }

  if (it.type === 'table') {
    const rowsIn = Array.isArray(it.rows) ? it.rows : [];
    if (!rowsIn.length) return;
    const border = hexOf(it.border) || '8EAADB';
    const fs = PT(it.fs || 16);
    const rows = rowsIn.map((row, ri) => row.filter((c) => c && !c.hidden).map((c) => {
      const runs = htmlToRuns(c.html || '');
      const o = { fontSize: fs, valign: 'middle', border: { type: 'solid', pt: 1, color: border }, margin: 0.05 };
      const fill = c.fill || (it.header && ri === 0 ? '#4472c4' : it.banded && ri % 2 === 0 ? '#d9e2f3' : null);
      if (fill) o.fill = fillOf(fill);
      if (it.header && ri === 0) { o.color = 'FFFFFF'; o.bold = true; }
      if (c.color) o.color = hexOf(c.color) || o.color;
      if (c.colSpan > 1) o.colspan = c.colSpan;
      if (c.rowSpan > 1) o.rowspan = c.rowSpan;
      return { text: runs.length ? runs : '', options: o };
    }));
    const nCols = rowsIn[0].length;
    const colW = Array.isArray(it.colW) && it.colW.length === nCols ? it.colW.map(IN) : Array.from({ length: nCols }, () => IN(it.w / nCols));
    slide.addTable(rows, {
      x: IN(it.x), y: IN(it.y), w: IN(it.w), colW,
      rowH: Array.from({ length: rows.length }, () => IN(it.h / rows.length)),
      fontFace: 'Calibri', fontSize: fs, color: '000000', autoPage: false,
    });
    return;
  }

  // Metin kutusu
  const runs = htmlToRuns(it.html || '', { list: !!it.list });
  if (!runs.some((r) => r.text.trim())) {
    // Boş kutu: yalnızca dolgu veya kenarlık varsa çiz
    const f = parseColor(it.fill), l = parseColor(it.stroke);
    if (!f && !(l && it.strokeW)) return;
  }
  const o = { ...textOpts(it), isTextBox: true };
  const f = parseColor(it.fill);
  if (f) o.fill = fillOf(it.fill, opacity);
  if (it.stroke && it.strokeW) o.line = lineOf(it);
  slide.addText(runs.length ? runs : [{ text: '', options: {} }], o);
}
