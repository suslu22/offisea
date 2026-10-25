// .odt, .rtf, .txt, .md ve .html içe aktarma. Hepsi DOM öğeleri kurar; sonuç ayrıca
// düzenleyiciye yüklenirken DOMPurify'dan geçer.
import JSZip from 'jszip';
import { checkZip, parseXml, mimeFromExt } from '../core/files.js';
import { cssFont } from './docx-import.js';

// ---- Metin kodlaması ---------------------------------------------------------------
export function decodeText(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch {
    return new TextDecoder('windows-1254').decode(bytes); // Türkçe Windows kodlaması
  }
}

function p(text) {
  const el = document.createElement('p');
  if (text) el.textContent = text; else el.append(document.createElement('br'));
  return el;
}

export function importText(buffer) {
  const out = document.createElement('div');
  for (const line of decodeText(buffer).split(/\r\n|\r|\n/)) {
    out.append(p(line.replace(/ {2,}/g, (m) => ' ' + '\u00a0'.repeat(m.length - 1))));
  }
  return out.innerHTML;
}

export function importHtml(buffer) {
  const text = decodeText(buffer);
  // DOMParser ile ayrıştırılan belge betik çalıştırmaz; asıl temizlik düzenleyicide yapılır.
  const doc = new DOMParser().parseFromString(text, 'text/html');
  return doc.body ? doc.body.innerHTML : '';
}

// ---- Markdown ------------------------------------------------------------------------
function mdInline(text, parent) {
  const re = /(\*\*|__)(.+?)\1|(\*|_)(.+?)\3|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    if (m[2] != null) { const b = document.createElement('b'); mdInline(m[2], b); parent.append(b); }
    else if (m[4] != null) { const i = document.createElement('i'); mdInline(m[4], i); parent.append(i); }
    else if (m[5] != null) { const c = document.createElement('code'); c.textContent = m[5]; parent.append(c); }
    else if (m[6] != null) {
      if (/^(https?:|mailto:)/i.test(m[7])) {
        const a = document.createElement('a'); a.href = m[7]; a.textContent = m[6]; parent.append(a);
      } else parent.append(m[6]);
    }
    last = re.lastIndex;
  }
  if (last < text.length) parent.append(text.slice(last));
}

export function importMarkdown(buffer) {
  const lines = decodeText(buffer).split(/\r\n|\r|\n/);
  const out = document.createElement('div');
  let list = null, para = null, code = null;
  for (const line of lines) {
    if (code) {
      if (/^```/.test(line)) { code = null; continue; }
      code.textContent += (code.textContent ? '\n' : '') + line;
      continue;
    }
    if (/^```/.test(line)) { list = para = null; code = document.createElement('pre'); out.append(code); continue; }
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      list = para = null;
      const hd = document.createElement('h' + m[1].length); mdInline(m[2], hd); out.append(hd); continue;
    }
    if ((m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line))) {
      para = null;
      const ordered = /\d/.test(m[1]);
      if (!list || (list.tagName === 'OL') !== ordered) { list = document.createElement(ordered ? 'ol' : 'ul'); out.append(list); }
      const li = document.createElement('li'); mdInline(m[2], li); list.append(li); continue;
    }
    if ((m = /^>\s?(.*)$/.exec(line))) {
      list = para = null;
      const q = document.createElement('blockquote'); mdInline(m[1], q); out.append(q); continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { list = para = null; out.append(document.createElement('hr')); continue; }
    if (!line.trim()) { list = para = null; continue; }
    list = null;
    if (para) { para.append(' '); mdInline(line, para); }
    else { para = document.createElement('p'); mdInline(line, para); out.append(para); }
  }
  return out.innerHTML;
}

// ---- RTF -------------------------------------------------------------------------------
const RTF_SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer', 'headerl', 'headerr', 'headerf',
  'footerl', 'footerr', 'footerf', 'footnote', 'fldinst', 'themedata', 'datastore', 'latentstyles', 'rsidtbl', 'generator', 'xmlnstbl',
  'listtable', 'listoverridetable', 'pgdsctbl', 'mmathPr', 'colorschememapping', 'filetbl', 'revtbl', 'listtext', 'pntext', 'pntxta', 'pntxtb']);

export function importRtf(buffer) {
  const src = new TextDecoder('latin1').decode(new Uint8Array(buffer));
  if (!src.startsWith('{\\rtf')) throw new Error('Geçerli bir RTF dosyası değil.');
  const out = document.createElement('div');
  let codepage = 'windows-1254';
  let para = document.createElement('p');
  let state = { skip: false, b: false, i: false, u: false, uc: 1 };
  const stack = [];
  let pendingBytes = [];
  let skipChars = 0;
  const flushBytes = () => {
    if (!pendingBytes.length) return;
    let txt;
    try { txt = new TextDecoder(codepage).decode(new Uint8Array(pendingBytes)); } catch { txt = String.fromCharCode(...pendingBytes); }
    pendingBytes = [];
    emit(txt);
  };
  const emit = (txt) => {
    if (state.skip || !txt) return;
    let node = document.createTextNode(txt);
    if (state.u) { const e = document.createElement('u'); e.append(node); node = e; }
    if (state.i) { const e = document.createElement('i'); e.append(node); node = e; }
    if (state.b) { const e = document.createElement('b'); e.append(node); node = e; }
    para.append(node);
  };
  const endPara = () => {
    flushBytes();
    if (!para.firstChild) para.append(document.createElement('br'));
    out.append(para);
    para = document.createElement('p');
  };
  let i = 0;
  let groupStart = false;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '{') { flushBytes(); stack.push({ ...state }); groupStart = true; i++; continue; }
    if (ch === '}') { flushBytes(); state = stack.pop() || state; groupStart = false; i++; continue; }
    if (ch === '\\') {
      const nx = src[i + 1];
      if (nx === '\'') {
        const hex = src.substr(i + 2, 2);
        if (skipChars > 0) skipChars--;
        else if (!state.skip) pendingBytes.push(parseInt(hex, 16));
        i += 4; continue;
      }
      if (nx === '*') { state.skip = true; i += 2; continue; }
      if (nx === '\\' || nx === '{' || nx === '}') { flushBytes(); emit(nx); i += 2; continue; }
      if (nx === '~') { flushBytes(); emit('\u00a0'); i += 2; continue; }
      if (nx === '-') { i += 2; continue; }
      if (nx === '\n' || nx === '\r') { endPara(); i += 2; continue; }
      const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(src.slice(i, i + 40));
      if (!m) { i++; continue; }
      i += m[0].length;
      const word = m[1], arg = m[2] != null ? +m[2] : null;
      if (groupStart && RTF_SKIP.has(word)) state.skip = true;
      groupStart = false;
      if (word !== 'u') flushBytes();
      switch (word) {
        case 'par': case 'sect': endPara(); break;
        case 'line': para.append(document.createElement('br')); break;
        case 'tab': emit('\t'); break;
        case 'b': state.b = arg !== 0; break;
        case 'i': state.i = arg !== 0; break;
        case 'ul': state.u = arg !== 0; break;
        case 'ulnone': state.u = false; break;
        case 'plain': state.b = state.i = state.u = false; break;
        case 'uc': state.uc = arg ?? 1; break;
        case 'ansicpg': if (arg) codepage = 'windows-' + arg; break;
        case 'u': flushBytes(); emit(String.fromCharCode(arg < 0 ? arg + 65536 : arg)); skipChars = state.uc; break;
        case 'emdash': emit('—'); break;
        case 'endash': emit('–'); break;
        case 'bullet': emit('•'); break;
        case 'lquote': emit('‘'); break;
        case 'rquote': emit('’'); break;
        case 'ldblquote': emit('“'); break;
        case 'rdblquote': emit('”'); break;
        default: break;
      }
      continue;
    }
    if (ch === '\r' || ch === '\n') { i++; continue; }
    groupStart = false;
    if (skipChars > 0) { skipChars--; i++; continue; }
    flushBytes();
    let j = i;
    while (j < src.length && !'\\{}\r\n'.includes(src[j])) j++;
    emit(src.slice(i, j));
    i = j;
  }
  endPara();
  return out.innerHTML;
}

// ---- ODT (OpenDocument metin) ---------------------------------------------------------
const NS = {
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  xlink: 'http://www.w3.org/1999/xlink',
  svg: 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
};
const at = (el, ns, name) => (el ? el.getAttributeNS(NS[ns], name) : null);

function odtStyles(xmlDocs) {
  const map = new Map();
  for (const xml of xmlDocs) {
    for (const st of xml.getElementsByTagNameNS(NS.style, 'style')) {
      const name = at(st, 'style', 'name');
      const tp = st.getElementsByTagNameNS(NS.style, 'text-properties')[0];
      const pp = st.getElementsByTagNameNS(NS.style, 'paragraph-properties')[0];
      const css = {};
      if (tp) {
        if (at(tp, 'fo', 'font-weight') === 'bold') css.fontWeight = 'bold';
        if (at(tp, 'fo', 'font-style') === 'italic') css.fontStyle = 'italic';
        const deco = [];
        const ul = at(tp, 'style', 'text-underline-style');
        if (ul && ul !== 'none') deco.push('underline');
        const lt = at(tp, 'style', 'text-line-through-style');
        if (lt && lt !== 'none') deco.push('line-through');
        if (deco.length) css.textDecorationLine = deco.join(' ');
        const color = at(tp, 'fo', 'color'); if (/^#[0-9a-f]{6}$/i.test(color || '')) css.color = color;
        const bg = at(tp, 'fo', 'background-color'); if (/^#[0-9a-f]{6}$/i.test(bg || '')) css.backgroundColor = bg;
        const fs = at(tp, 'fo', 'font-size'); if (/^[\d.]+pt$/.test(fs || '')) css.fontSize = fs;
        const fn = at(tp, 'style', 'font-name'); if (fn) css.fontFamily = cssFont(fn);
      }
      if (pp) {
        const al = at(pp, 'fo', 'text-align');
        if (al) css.textAlign = al === 'end' ? 'right' : al === 'start' ? 'left' : al;
        const ml = at(pp, 'fo', 'margin-left'); if (/^[\d.]+(cm|in|pt|mm)$/.test(ml || '')) css.marginLeft = ml;
      }
      map.set(name, { css, parent: at(st, 'style', 'parent-style-name') });
    }
  }
  return map;
}

function applyOdtStyle(el, styles, name) {
  let depth = 0;
  const chain = [];
  while (name && depth++ < 10) {
    const s = styles.get(name);
    if (!s) break;
    chain.unshift(s.css);
    name = s.parent;
  }
  for (const css of chain) Object.assign(el.style, css);
}

export async function importOdt(buffer) {
  checkZip(buffer);
  const zip = await JSZip.loadAsync(buffer);
  const cf = zip.file('content.xml');
  if (!cf) throw new Error('Geçerli bir ODT dosyası değil.');
  const content = parseXml(await cf.async('string'));
  const sf = zip.file('styles.xml');
  const styles = odtStyles([...(sf ? [parseXml(await sf.async('string'))] : []), content]);
  const images = new Map();
  for (const img of content.getElementsByTagNameNS('urn:oasis:names:tc:opendocument:xmlns:drawing:1.0', 'image')) {
    const href = at(img, 'xlink', 'href');
    if (!href || /^[a-z]+:/i.test(href)) continue; // harici bağlantılar yüklenmez
    const f = zip.file(href);
    const mime = mimeFromExt((href.split('.').pop() || '').toLowerCase());
    if (f && mime && mime !== 'image/svg+xml') images.set(href, `data:${mime};base64,${await f.async('base64')}`);
  }

  const inline = (node, parent) => {
    for (const ch of node.childNodes) {
      if (ch.nodeType === 3) { parent.append(ch.nodeValue); continue; }
      if (ch.nodeType !== 1) continue;
      switch (ch.localName) {
        case 'span': { const s = document.createElement('span'); applyOdtStyle(s, styles, at(ch, 'text', 'style-name')); inline(ch, s); parent.append(s); break; }
        case 's': parent.append('\u00a0'.repeat(Math.min(100, +(at(ch, 'text', 'c') || 1)))); break;
        case 'tab': { const t = document.createElement('span'); t.className = 'offisea-tab'; t.textContent = '\t'; parent.append(t); break; }
        case 'line-break': parent.append(document.createElement('br')); break;
        case 'a': {
          const href = at(ch, 'xlink', 'href') || '';
          if (/^(https?:|mailto:)/i.test(href)) { const a = document.createElement('a'); a.href = href; inline(ch, a); parent.append(a); } else inline(ch, parent);
          break;
        }
        case 'frame': {
          const imgEl = Array.from(ch.children).find((c) => c.localName === 'image');
          const src = imgEl && images.get(at(imgEl, 'xlink', 'href'));
          if (src) {
            const img = document.createElement('img');
            img.src = src;
            const w = at(ch, 'svg', 'width');
            if (/^[\d.]+(cm|in|pt|mm)$/.test(w || '')) img.style.width = w;
            parent.append(img);
          }
          break;
        }
        case 'note': case 'bookmark': case 'bookmark-start': case 'bookmark-end': case 'soft-page-break': case 'annotation': break;
        default: inline(ch, parent);
      }
    }
  };

  const blocks = (node, out, depth = 0) => {
    if (depth > 30) return;
    for (const ch of node.children) {
      switch (ch.localName) {
        case 'p': case 'h': {
          const lvl = ch.localName === 'h' ? Math.min(6, Math.max(1, +(at(ch, 'text', 'outline-level') || 1))) : 0;
          const el = document.createElement(lvl ? 'h' + lvl : 'p');
          applyOdtStyle(el, styles, at(ch, 'text', 'style-name'));
          inline(ch, el);
          if (!el.firstChild) el.append(document.createElement('br'));
          out.append(el);
          break;
        }
        case 'list': {
          const ul = document.createElement('ul');
          for (const item of ch.children) {
            if (item.localName !== 'list-item' && item.localName !== 'list-header') continue;
            const li = document.createElement('li');
            const tmp = document.createElement('div');
            blocks(item, tmp, depth + 1);
            for (const n of Array.from(tmp.childNodes)) {
              if (n.tagName === 'P') li.append(...n.childNodes); else li.append(n);
            }
            ul.append(li);
          }
          out.append(ul);
          break;
        }
        case 'table': {
          const table = document.createElement('table');
          table.style.borderCollapse = 'collapse';
          table.style.width = '100%';
          const tbody = document.createElement('tbody');
          table.append(tbody);
          const rows = ch.getElementsByTagNameNS(NS.table, 'table-row');
          for (const r of rows) {
            const tr = document.createElement('tr');
            for (const c of r.children) {
              if (c.localName !== 'table-cell') continue;
              const td = document.createElement('td');
              td.style.border = '1px solid #000000';
              td.style.padding = '2pt 5pt';
              const cs = +(at(c, 'table', 'number-columns-spanned') || 1);
              const rs = +(at(c, 'table', 'number-rows-spanned') || 1);
              if (cs > 1) td.colSpan = cs;
              if (rs > 1) td.rowSpan = rs;
              blocks(c, td, depth + 1);
              tr.append(td);
            }
            tbody.append(tr);
          }
          out.append(table);
          break;
        }
        case 'section': case 'table-of-content': case 'index-body': blocks(ch, out, depth + 1); break;
        default: break;
      }
    }
  };
  const textRoot = content.getElementsByTagNameNS('urn:oasis:names:tc:opendocument:xmlns:office:1.0', 'text')[0];
  const out = document.createElement('div');
  if (textRoot) blocks(textRoot, out);
  if (!out.firstChild) out.append(p(''));
  return out.innerHTML;
}
