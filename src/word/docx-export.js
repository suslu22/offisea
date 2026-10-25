// Düzenleyicideki içeriği .docx dosyasına çevirir. Biçimleri tarayıcının hesapladığı
// stillerden okur; böylece hem içe aktarılan hem de elle biçimlenen metin doğru çıkar.
import {
  Document, Packer, Paragraph, TextRun, ImageRun, ExternalHyperlink, Table, TableRow, TableCell,
  WidthType, ShadingType, PageBreak, LevelFormat, AlignmentType, HeadingLevel, Tab, BorderStyle,
  LineRuleType, VerticalAlign,
} from 'docx';
import { dataUrlToBytes } from '../core/files.js';

const BLOCK = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'TABLE', 'BLOCKQUOTE', 'PRE', 'HR', 'FIGURE', 'FIGCAPTION']);
const HEADINGS = { H1: HeadingLevel.HEADING_1, H2: HeadingLevel.HEADING_2, H3: HeadingLevel.HEADING_3, H4: HeadingLevel.HEADING_4, H5: HeadingLevel.HEADING_5, H6: HeadingLevel.HEADING_6 };
const DEFAULT_FONT = 'Calibri';
const DEFAULT_SIZE = 22; // yarım punto (11pt)

function rgbToHex(rgb) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(rgb || '');
  if (!m) return null;
  if (m[4] != null && +m[4] === 0) return null;
  return [m[1], m[2], m[3]].map((x) => (+x).toString(16).padStart(2, '0')).join('').toUpperCase();
}
const pxToTwip = (px) => Math.round(px * 15);

class Exporter {
  constructor(root) {
    this.root = root;
    this.cs = new WeakMap();
    this.images = new Map();
    this.listInstance = 0;
  }

  style(el) {
    let s = this.cs.get(el);
    if (!s) { s = getComputedStyle(el); this.cs.set(el, s); }
    return s;
  }

  // Satır içi biçimi, metnin ebeveyn öğesinden blok öğesine kadar çıkarak hesaplar.
  runProps(el, block) {
    const s = this.style(el);
    const props = {};
    if (parseInt(s.fontWeight, 10) >= 600) props.bold = true;
    if (s.fontStyle === 'italic') props.italics = true;
    let underline = false, strike = false, bg = null, vert = null;
    for (let e = el; e && e !== this.root; e = e.parentElement) {
      const es = this.style(e);
      const d = es.textDecorationLine || es.textDecoration || '';
      if (d.includes('underline')) underline = true;
      if (d.includes('line-through')) strike = true;
      if (!bg && e !== block && !BLOCK.has(e.tagName)) bg = rgbToHex(es.backgroundColor);
      if (!vert && (es.verticalAlign === 'super' || es.verticalAlign === 'sub')) vert = es.verticalAlign;
      if (e === block) break;
    }
    if (underline) props.underline = {};
    if (strike) props.strike = true;
    if (bg) props.shading = { type: ShadingType.CLEAR, color: 'auto', fill: bg };
    if (vert === 'super') props.superScript = true;
    if (vert === 'sub') props.subScript = true;
    const color = rgbToHex(s.color);
    if (color && color !== '000000') props.color = color;
    const size = Math.round(parseFloat(s.fontSize) * 0.75 * 2);
    if (size && size !== DEFAULT_SIZE) props.size = size;
    const font = (s.fontFamily || '').split(',')[0].replace(/["']/g, '').trim();
    if (font && font !== DEFAULT_FONT) props.font = font;
    if (s.textTransform === 'uppercase') props.allCaps = true;
    if (s.fontVariant === 'small-caps') props.smallCaps = true;
    return props;
  }

  paraProps(el) {
    const s = this.style(el);
    const p = {};
    const al = s.textAlign;
    if (al === 'center') p.alignment = AlignmentType.CENTER;
    else if (al === 'right' || al === 'end') p.alignment = AlignmentType.RIGHT;
    else if (al === 'justify') p.alignment = AlignmentType.JUSTIFIED;
    const ml = parseFloat(s.marginLeft) || 0;
    const mr = parseFloat(s.marginRight) || 0;
    const ti = parseFloat(s.textIndent) || 0;
    const indent = {};
    if (ml > 0) indent.left = pxToTwip(ml);
    if (mr > 0) indent.right = pxToTwip(mr);
    if (ti > 0) indent.firstLine = pxToTwip(ti);
    if (ti < 0) indent.hanging = pxToTwip(-ti);
    if (Object.keys(indent).length) p.indent = indent;
    const spacing = {
      before: pxToTwip(parseFloat(s.marginTop) || 0),
      after: pxToTwip(parseFloat(s.marginBottom) || 0),
    };
    const lh = parseFloat(s.lineHeight);
    const fs = parseFloat(s.fontSize) || 14.67;
    if (lh && s.lineHeight.endsWith('px')) {
      spacing.line = Math.max(200, Math.round((lh / fs / 1.15) * 240));
      spacing.lineRule = LineRuleType.AUTO;
    }
    p.spacing = spacing;
    const bg = rgbToHex(s.backgroundColor);
    if (bg) p.shading = { type: ShadingType.CLEAR, color: 'auto', fill: bg };
    return p;
  }

  async prepareImages() {
    for (const img of this.root.querySelectorAll('img')) {
      const src = img.getAttribute('src') || '';
      if (!src.startsWith('data:image/')) continue;
      let { bytes, mime } = dataUrlToBytes(src);
      let type = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/bmp': 'bmp' }[mime];
      if (!type) {
        // WEBP vb. -> PNG
        const c = document.createElement('canvas');
        c.width = img.naturalWidth || 1; c.height = img.naturalHeight || 1;
        c.getContext('2d').drawImage(img, 0, 0);
        ({ bytes } = dataUrlToBytes(c.toDataURL('image/png')));
        type = 'png';
      }
      const zoom = parseFloat(getComputedStyle(this.root).zoom) || 1;
      const r = img.getBoundingClientRect();
      let w = r.width / zoom || img.naturalWidth || 100;
      let hgt = r.height / zoom || img.naturalHeight || 100;
      const maxW = 600;
      if (w > maxW) { hgt = hgt * maxW / w; w = maxW; }
      this.images.set(img, { data: bytes, type, w: Math.round(w), h: Math.round(hgt) });
    }
  }

  inline(nodes, block, out, link = false) {
    for (const n of nodes) {
      if (n.nodeType === 3) {
        const parent = n.parentElement || block;
        const ws = this.style(parent).whiteSpace || '';
        let text = n.nodeValue;
        if (!ws.startsWith('pre') && ws !== 'break-spaces') text = text.replace(/[\t\n\r ]+/g, ' ');
        if (!text) continue;
        const props = this.runProps(parent, block);
        if (link) { props.style = 'Hyperlink'; props.color = props.color || '0563C1'; props.underline = {}; }
        const lines = text.split('\n');
        lines.forEach((line, li) => {
          const parts = line.split('\t');
          const children = [];
          parts.forEach((part, pi) => { if (pi > 0) children.push(new Tab()); if (part) children.push(part); });
          if (children.length || li > 0) out.push(new TextRun({ ...props, children, break: li > 0 ? 1 : undefined }));
        });
        continue;
      }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName;
      if (tag === 'BR') { out.push(new TextRun({ text: '', break: 1 })); continue; }
      if (tag === 'IMG') {
        const im = this.images.get(n);
        if (im) out.push(new ImageRun({ type: im.type, data: im.data, transformation: { width: im.w, height: im.h } }));
        continue;
      }
      if (tag === 'A' && /^(https?:|mailto:)/i.test(n.getAttribute('href') || '')) {
        const kids = [];
        this.inline(n.childNodes, block, kids, true);
        if (kids.length) out.push(new ExternalHyperlink({ link: n.getAttribute('href'), children: kids }));
        continue;
      }
      if (n.classList && n.classList.contains('offisea-page-break')) { out.push(new PageBreak()); continue; }
      this.inline(n.childNodes, block, out, link);
    }
  }

  paragraph(el, extra = {}) {
    const runs = [];
    this.inline(el.childNodes, el, runs);
    const opts = { ...this.paraProps(el), ...extra, children: runs };
    if (HEADINGS[el.tagName]) opts.heading = HEADINGS[el.tagName];
    return new Paragraph(opts);
  }

  hasBlockChild(el) {
    for (const c of el.children) if (BLOCK.has(c.tagName) || c.classList.contains('offisea-page-break')) return true;
    return false;
  }

  blocks(container, out, depth = 0) {
    let pending = [];
    const flush = () => {
      if (!pending.length) return;
      const onlyBlank = pending.every((n) => n.nodeType === 3 && !n.nodeValue.trim());
      if (!onlyBlank) {
        const runs = [];
        this.inline(pending, container, runs);
        out.push(new Paragraph({ ...this.paraProps(container), children: runs }));
      }
      pending = [];
    };
    for (const n of container.childNodes) {
      if (n.nodeType === 1 && n.classList.contains('offisea-page-break')) { flush(); out.push(new Paragraph({ children: [new PageBreak()] })); continue; }
      if (n.nodeType === 1 && BLOCK.has(n.tagName)) { flush(); this.block(n, out, depth); }
      else pending.push(n);
    }
    flush();
  }

  block(el, out, depth) {
    const tag = el.tagName;
    if (tag === 'UL' || tag === 'OL') { this.list(el, out, 0, ++this.listInstance); return; }
    if (tag === 'TABLE') { out.push(this.table(el)); return; }
    if (tag === 'HR') {
      out.push(new Paragraph({ children: [], border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '999999', space: 1 } } }));
      return;
    }
    if (depth < 20 && this.hasBlockChild(el)) { this.blocks(el, out, depth + 1); return; }
    out.push(this.paragraph(el));
  }

  list(listEl, out, level, instance) {
    const ordered = listEl.tagName === 'OL';
    for (const li of listEl.children) {
      if (li.tagName !== 'LI') {
        if (li.tagName === 'UL' || li.tagName === 'OL') this.list(li, out, Math.min(8, level + 1), instance);
        continue;
      }
      const own = [], nested = [];
      for (const c of li.childNodes) {
        if (c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL')) nested.push(c); else own.push(c);
      }
      const runs = [];
      this.inline(own, li, runs);
      const pp = this.paraProps(li);
      delete pp.indent;
      out.push(new Paragraph({
        ...pp,
        children: runs,
        numbering: { reference: ordered ? 'offisea-num' : 'offisea-bullet', level, instance },
      }));
      for (const nl of nested) this.list(nl, out, Math.min(8, level + 1), nl.tagName === 'OL' ? ++this.listInstance : instance);
    }
  }

  table(tableEl) {
    const rows = [];
    for (const tr of tableEl.querySelectorAll(':scope > tr, :scope > tbody > tr, :scope > thead > tr, :scope > tfoot > tr')) {
      const cells = [];
      for (const td of tr.children) {
        if (td.tagName !== 'TD' && td.tagName !== 'TH') continue;
        const children = [];
        this.blocks(td, children, 1);
        if (!children.length) children.push(new Paragraph({ children: [] }));
        const s = this.style(td);
        const opts = { children };
        if (td.colSpan > 1) opts.columnSpan = td.colSpan;
        if (td.rowSpan > 1) opts.rowSpan = td.rowSpan;
        const bg = rgbToHex(s.backgroundColor);
        if (bg) opts.shading = { type: ShadingType.CLEAR, color: 'auto', fill: bg };
        if (s.verticalAlign === 'middle') opts.verticalAlign = VerticalAlign.CENTER;
        else if (s.verticalAlign === 'bottom') opts.verticalAlign = VerticalAlign.BOTTOM;
        const noBorder = s.borderTopStyle === 'none' && s.borderLeftStyle === 'none';
        if (noBorder) {
          const nb = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
          opts.borders = { top: nb, bottom: nb, left: nb, right: nb };
        }
        cells.push(new TableCell(opts));
      }
      if (cells.length) rows.push(new TableRow({ children: cells }));
    }
    if (!rows.length) rows.push(new TableRow({ children: [new TableCell({ children: [new Paragraph({ children: [] })] })] }));
    return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } });
  }
}

function numberingConfig() {
  const bullets = ['•', '◦', '▪'];
  const fmts = [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN];
  const lv = (i, format, text) => ({
    level: i, format, text, alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: 720 * (i + 1), hanging: 360 } } },
  });
  return {
    config: [
      { reference: 'offisea-bullet', levels: Array.from({ length: 9 }, (_, i) => lv(i, LevelFormat.BULLET, bullets[i % 3])) },
      { reference: 'offisea-num', levels: Array.from({ length: 9 }, (_, i) => lv(i, fmts[i % 3], `%${i + 1}.`)) },
    ],
  };
}

export async function exportDocx(rootEl, title) {
  const ex = new Exporter(rootEl);
  await ex.prepareImages();
  const children = [];
  ex.blocks(rootEl, children);
  if (!children.length) children.push(new Paragraph({ children: [] }));
  const doc = new Document({
    creator: 'Offisea',
    title: title || 'Belge',
    styles: { default: { document: { run: { font: DEFAULT_FONT, size: DEFAULT_SIZE } } } },
    numbering: numberingConfig(),
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
      children,
    }],
  });
  return Packer.toBlob(doc);
}
