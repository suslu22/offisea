// PowerPoint (.pptx) içe aktarma. ZIP bombası kontrolünden sonra JSZip ile açılır, XML'ler
// tarayıcının güvenli DOMParser'ı ile ayrıştırılır (XXE yok). Dış bağlantılı resimler
// (TargetMode="External") asla yüklenmez.
import JSZip from 'jszip';
import { checkZip, parseXml, mimeFromExt, extOf } from '../core/files.js';
import { uid } from './model.js';

const EMU = 9525; // 1 px = 9525 EMU (96 dpi)
const px = (v) => (v == null ? 0 : Math.round((+v / EMU) * 100) / 100);
const ptToPx = (hundredthPt) => (hundredthPt / 100) * (96 / 72);
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const kids = (el, name) => (el ? Array.from(el.children).filter((c) => c.localName === name) : []);
const kid = (el, name) => (el ? Array.from(el.children).find((c) => c.localName === name) || null : null);
const path = (el, ...names) => { let cur = el; for (const n of names) { cur = kid(cur, n); if (!cur) return null; } return cur; };
const rid = (el, name) => (el ? el.getAttributeNS(R_NS, name) || el.getAttribute('r:' + name) : null);

function normPath(p) {
  const out = [];
  for (const part of p.split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}

// ---- Renk ----------------------------------------------------------------------------------
function hexToRgb(h) { const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function rgbToHex(r, g, b) { return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join(''); }
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}
function hslToRgb(h, s, l) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

const PRESET = { black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', gray: '808080', grey: '808080', orange: 'FFA500', darkBlue: '00008B', darkRed: '8B0000', lightGray: 'D3D3D3' };

class Reader {
  constructor(zip) {
    this.zip = zip;
    this.xmlCache = new Map();
    this.relCache = new Map();
    this.imgCache = new Map();
    this.imageBytes = 0;
  }

  async xml(p) {
    if (!p) return null;
    if (this.xmlCache.has(p)) return this.xmlCache.get(p);
    const f = this.zip.file(p);
    const doc = f ? parseXml(await f.async('string')) : null;
    this.xmlCache.set(p, doc);
    return doc;
  }

  async rels(p) {
    if (this.relCache.has(p)) return this.relCache.get(p);
    const dir = p.slice(0, p.lastIndexOf('/') + 1);
    const doc = await this.xml(dir + '_rels/' + p.slice(dir.length) + '.rels');
    const out = {};
    if (doc) {
      for (const r of doc.getElementsByTagName('Relationship')) {
        const ext = r.getAttribute('TargetMode') === 'External';
        const tg = r.getAttribute('Target') || '';
        out[r.getAttribute('Id')] = { type: (r.getAttribute('Type') || '').split('/').pop(), target: ext ? tg : tg.startsWith('/') ? tg.slice(1) : normPath(dir + tg), external: ext };
      }
    }
    this.relCache.set(p, out);
    return out;
  }

  relOfType(rels, type) {
    return Object.values(rels).find((r) => r.type === type && !r.external) || null;
  }

  async image(p) {
    if (this.imgCache.has(p)) return this.imgCache.get(p);
    let url = null;
    const f = this.zip.file(p);
    const mime = mimeFromExt(extOf(p));
    if (f && mime && /^image\/(png|jpeg|gif|bmp|webp)$/.test(mime)) {
      const b64 = await f.async('base64');
      const bytes = b64.length * 0.75;
      if (bytes < 25 * 1024 * 1024 && this.imageBytes + bytes < 400 * 1024 * 1024) {
        this.imageBytes += bytes;
        url = `data:${mime};base64,${b64}`;
      }
    }
    this.imgCache.set(p, url);
    return url;
  }

  // ---- Tema ----
  async loadTheme(masterPath) {
    const mrels = await this.rels(masterPath);
    const t = this.relOfType(mrels, 'theme');
    const doc = t ? await this.xml(t.target) : null;
    const colors = {};
    const fonts = { major: 'Calibri Light', minor: 'Calibri' };
    if (doc) {
      const scheme = doc.getElementsByTagNameNS('*', 'clrScheme')[0];
      if (scheme) {
        for (const c of scheme.children) {
          const v = c.firstElementChild;
          if (!v) continue;
          colors[c.localName] = (v.getAttribute('lastClr') || v.getAttribute('val') || '000000').slice(-6);
        }
      }
      const maj = doc.getElementsByTagNameNS('*', 'majorFont')[0];
      const min = doc.getElementsByTagNameNS('*', 'minorFont')[0];
      if (maj && kid(maj, 'latin')) fonts.major = kid(maj, 'latin').getAttribute('typeface') || fonts.major;
      if (min && kid(min, 'latin')) fonts.minor = kid(min, 'latin').getAttribute('typeface') || fonts.minor;
    }
    const mdoc = await this.xml(masterPath);
    const clrMap = {};
    const cm = mdoc && mdoc.getElementsByTagNameNS('*', 'clrMap')[0];
    if (cm) for (const a of cm.attributes) clrMap[a.name] = a.value;
    return { colors, fonts, clrMap };
  }
}

function colorFrom(parent, theme, phClr) {
  if (!parent) return null;
  const el = Array.from(parent.children).find((c) => ['srgbClr', 'schemeClr', 'sysClr', 'prstClr', 'scrgbClr', 'hslClr'].includes(c.localName));
  if (!el) return null;
  let hex = null;
  switch (el.localName) {
    case 'srgbClr': hex = el.getAttribute('val'); break;
    case 'sysClr': hex = el.getAttribute('lastClr') || (el.getAttribute('val') === 'window' ? 'FFFFFF' : '000000'); break;
    case 'prstClr': hex = PRESET[el.getAttribute('val')] || '000000'; break;
    case 'scrgbClr': hex = rgbToHex(+el.getAttribute('r') / 1000 * 2.55, +el.getAttribute('g') / 1000 * 2.55, +el.getAttribute('b') / 1000 * 2.55).slice(1); break;
    case 'hslClr': hex = rgbToHex(...hslToRgb(+el.getAttribute('hue') / 21600000, +el.getAttribute('sat') / 100000, +el.getAttribute('lum') / 100000)).slice(1); break;
    case 'schemeClr': {
      let v = el.getAttribute('val');
      if (v === 'phClr') { if (!phClr) return null; hex = phClr.replace('#', ''); break; }
      v = theme.clrMap[v] || ({ bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' })[v] || v;
      hex = theme.colors[v] || null;
      break;
    }
    default: break;
  }
  if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) return null;
  let [r, g, b] = hexToRgb(hex);
  let alpha = 1;
  for (const m of el.children) {
    const val = +m.getAttribute('val') / 100000;
    switch (m.localName) {
      case 'lumMod': case 'lumOff': {
        const [hh, s, l] = rgbToHsl(r, g, b);
        const nl = m.localName === 'lumMod' ? l * val : l + val;
        [r, g, b] = hslToRgb(hh, s, Math.max(0, Math.min(1, nl)));
        break;
      }
      case 'tint': r = r * val + 255 * (1 - val); g = g * val + 255 * (1 - val); b = b * val + 255 * (1 - val); break;
      case 'shade': r *= val; g *= val; b *= val; break;
      case 'alpha': alpha = val; break;
      default: break;
    }
  }
  const out = rgbToHex(r, g, b);
  if (alpha < 0.999) return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${Math.round(alpha * 100) / 100})`;
  return out;
}

function fillOf(spPr, theme, styleEl) {
  if (spPr) {
    if (kid(spPr, 'noFill')) return 'none';
    const sf = kid(spPr, 'solidFill');
    if (sf) return colorFrom(sf, theme);
    const gf = kid(spPr, 'gradFill');
    if (gf) { const gs = path(gf, 'gsLst', 'gs'); if (gs) return colorFrom(gs, theme); }
    if (kid(spPr, 'grpFill')) return null;
  }
  if (styleEl) {
    const fr = kid(styleEl, 'fillRef');
    if (fr && +fr.getAttribute('idx') > 0) return colorFrom(fr, theme);
  }
  return undefined;
}

function lineOf(spPr, theme, styleEl) {
  const ln = spPr && kid(spPr, 'ln');
  if (ln) {
    if (kid(ln, 'noFill')) return { stroke: 'none', strokeW: 0 };
    const w = ln.getAttribute('w') ? Math.max(0.5, px(ln.getAttribute('w'))) : 1;
    const sf = kid(ln, 'solidFill');
    const gf = kid(ln, 'gradFill');
    const gs = gf && gf.getElementsByTagNameNS('*', 'gs')[0];
    const c = sf ? colorFrom(sf, theme) : gs ? colorFrom(gs, theme) : null;
    const dash = kid(ln, 'prstDash');
    const tail = kid(ln, 'tailEnd');
    const res = { strokeW: w, dash: dash && dash.getAttribute('val') !== 'solid', arrowEnd: !!(tail && tail.getAttribute('type') && tail.getAttribute('type') !== 'none') };
    if (c) res.stroke = c;
    else if (styleEl) { const lr = kid(styleEl, 'lnRef'); if (lr && +lr.getAttribute('idx') > 0) res.stroke = colorFrom(lr, theme) || '#000000'; }
    // Dolgusu belirtilmemiş <a:ln>: çizgi stili yalnızca şekil stilinden gelir; stil yoksa çizgi yoktur.
    if (!res.stroke) return { stroke: 'none', strokeW: 0 };
    return res;
  }
  if (styleEl) {
    const lr = kid(styleEl, 'lnRef');
    if (lr && +lr.getAttribute('idx') > 0) return { stroke: colorFrom(lr, theme) || '#000000', strokeW: 1 };
  }
  return null;
}

// ---- Metin stilleri ------------------------------------------------------------------------
function readPPr(pPr, theme) {
  const o = {};
  if (!pPr) return o;
  const algn = pPr.getAttribute('algn');
  if (algn) o.align = ({ l: 'left', ctr: 'center', r: 'right', just: 'justify', dist: 'justify' })[algn] || 'left';
  if (pPr.hasAttribute('marL')) o.marL = px(pPr.getAttribute('marL'));
  if (pPr.hasAttribute('indent')) o.indent = px(pPr.getAttribute('indent'));
  if (kid(pPr, 'buNone')) o.bullet = 'none';
  else if (kid(pPr, 'buAutoNum')) o.bullet = 'num';
  else if (kid(pPr, 'buChar')) o.bullet = 'char';
  else if (kid(pPr, 'buBlip')) o.bullet = 'char';
  const ls = path(pPr, 'lnSpc', 'spcPct');
  if (ls) o.lnSpc = +ls.getAttribute('val') / 100000;
  const sb = path(pPr, 'spcBef', 'spcPts');
  if (sb) o.spcBef = ptToPx(+sb.getAttribute('val'));
  const sa = path(pPr, 'spcAft', 'spcPts');
  if (sa) o.spcAft = ptToPx(+sa.getAttribute('val'));
  const def = kid(pPr, 'defRPr');
  if (def) o.r = readRPr(def, theme);
  return o;
}

function readRPr(rPr, theme) {
  const o = {};
  if (!rPr) return o;
  if (rPr.hasAttribute('sz')) o.sz = +rPr.getAttribute('sz');
  if (rPr.hasAttribute('b')) o.b = rPr.getAttribute('b') === '1' || rPr.getAttribute('b') === 'true';
  if (rPr.hasAttribute('i')) o.i = rPr.getAttribute('i') === '1' || rPr.getAttribute('i') === 'true';
  if (rPr.hasAttribute('u')) o.u = rPr.getAttribute('u') !== 'none';
  if (rPr.hasAttribute('strike')) o.strike = rPr.getAttribute('strike') !== 'noStrike';
  if (rPr.hasAttribute('baseline')) { const b = +rPr.getAttribute('baseline'); o.base = b > 0 ? 'sup' : b < 0 ? 'sub' : null; }
  if (rPr.hasAttribute('cap')) o.cap = rPr.getAttribute('cap');
  const sf = kid(rPr, 'solidFill');
  if (sf) { const c = colorFrom(sf, theme); if (c) o.color = c; }
  const latin = kid(rPr, 'latin');
  if (latin && latin.getAttribute('typeface')) {
    let tf = latin.getAttribute('typeface');
    if (tf === '+mj-lt') tf = theme.fonts.major;
    else if (tf === '+mn-lt') tf = theme.fonts.minor;
    o.font = tf;
  }
  return o;
}

function mergeLevel(a, b) {
  const o = { ...a, ...b };
  delete o.r;
  o.r = { ...(a.r || {}), ...(b.r || {}) };
  return o;
}

function lstLevels(lst, theme) {
  const out = {};
  if (!lst) return out;
  for (let l = 1; l <= 9; l++) {
    const e = kid(lst, `lvl${l}pPr`);
    if (e) out[l] = readPPr(e, theme);
  }
  return out;
}

// ---- Asıl okuyucu --------------------------------------------------------------------------
export async function importPptx(buffer) {
  checkZip(buffer);
  const zip = await JSZip.loadAsync(buffer);
  const R = new Reader(zip);
  const rootRels = await R.rels('');
  let presPath = 'ppt/presentation.xml';
  const od = Object.values(rootRels).find((r) => r.type === 'officeDocument');
  if (od) presPath = od.target;
  const pres = await R.xml(presPath);
  if (!pres) throw new Error('Geçerli bir PowerPoint dosyası değil.');
  const presRels = await R.rels(presPath);
  const sz = pres.getElementsByTagNameNS('*', 'sldSz')[0];
  const W = sz ? px(sz.getAttribute('cx')) : 960;
  const H = sz ? px(sz.getAttribute('cy')) : 540;
  const defaultTextStyle = lstLevels(pres.getElementsByTagNameNS('*', 'defaultTextStyle')[0], { colors: {}, fonts: {}, clrMap: {} });

  const slideIds = pres.getElementsByTagNameNS('*', 'sldId');
  const slides = [];
  let count = 0;
  for (const s of slideIds) {
    const r = presRels[rid(s, 'id')];
    if (!r || r.external) continue;
    if (++count > 1000) break;
    try {
      slides.push(await readSlide(R, r.target, { W, H, defaultTextStyle }));
    } catch (e) {
      console.warn('Slayt okunamadı', r.target, e);
      slides.push({ id: uid(), bg: '#ffffff', notes: '', items: [{ id: uid(), type: 'text', x: 40, y: 40, w: W - 80, h: 80, fs: 20, html: '<p>Bu slayt okunamadı.</p>' }] });
    }
  }
  if (!slides.length) throw new Error('Sunumda slayt bulunamadı.');
  return { v: 1, w: W, h: H, slides };
}

async function readSlide(R, slidePath, ctx) {
  const doc = await R.xml(slidePath);
  const srels = await R.rels(slidePath);
  const layoutRel = R.relOfType(srels, 'slideLayout');
  const layoutPath = layoutRel ? layoutRel.target : null;
  const layoutDoc = layoutPath ? await R.xml(layoutPath) : null;
  const lrels = layoutPath ? await R.rels(layoutPath) : {};
  const masterRel = R.relOfType(lrels, 'slideMaster');
  const masterPath = masterRel ? masterRel.target : null;
  const masterDoc = masterPath ? await R.xml(masterPath) : null;
  const mrels = masterPath ? await R.rels(masterPath) : {};
  const theme = masterPath ? await R.loadTheme(masterPath) : { colors: {}, fonts: { major: 'Calibri', minor: 'Calibri' }, clrMap: {} };

  const txStyles = masterDoc ? masterDoc.getElementsByTagNameNS('*', 'txStyles')[0] : null;
  const masterStyles = {
    title: lstLevels(kid(txStyles, 'titleStyle'), theme),
    body: lstLevels(kid(txStyles, 'bodyStyle'), theme),
    other: lstLevels(kid(txStyles, 'otherStyle'), theme),
  };

  const phList = (d) => {
    const out = [];
    if (!d) return out;
    const tree = d.getElementsByTagNameNS('*', 'spTree')[0];
    if (!tree) return out;
    for (const sp of tree.getElementsByTagNameNS('*', 'sp')) {
      const ph = sp.getElementsByTagNameNS('*', 'ph')[0];
      if (ph) out.push({ sp, type: ph.getAttribute('type') || 'body', idx: ph.getAttribute('idx') });
    }
    return out;
  };
  const layoutPh = phList(layoutDoc);
  const masterPh = phList(masterDoc);
  const baseType = (t) => (t === 'ctrTitle' ? 'title' : t === 'subTitle' || t === 'obj' ? 'body' : t);
  const findPh = (list, type, idx, byIdx = true) => {
    if (byIdx && idx != null) { const m = list.find((p) => p.idx === idx); if (m) return m.sp; }
    let m = list.find((p) => p.type === type);
    if (!m) m = list.find((p) => baseType(p.type) === baseType(type));
    return m ? m.sp : null;
  };

  const sctx = { R, theme, rels: srels, layoutPh, masterPh, findPh, masterStyles, defaultTextStyle: ctx.defaultTextStyle, W: ctx.W, H: ctx.H, layoutRels: lrels, masterRels: mrels };

  // Arka plan
  let bg = '#ffffff', bgImg;
  const bgFrom = async (d, rels) => {
    const bgEl = d && d.getElementsByTagNameNS('*', 'bg')[0];
    if (!bgEl) return false;
    const bgPr = kid(bgEl, 'bgPr');
    if (bgPr) {
      const sf = kid(bgPr, 'solidFill');
      if (sf) { bg = colorFrom(sf, theme) || bg; return true; }
      const gf = kid(bgPr, 'gradFill');
      if (gf) { const gs = path(gf, 'gsLst', 'gs'); if (gs) bg = colorFrom(gs, theme) || bg; return true; }
      const bf = kid(bgPr, 'blipFill');
      if (bf) {
        const blip = kid(bf, 'blip');
        const rr = blip && rels[rid(blip, 'embed')];
        if (rr && !rr.external) bgImg = (await R.image(rr.target)) || undefined;
        return true;
      }
    }
    const ref = kid(bgEl, 'bgRef');
    if (ref) { bg = colorFrom(ref, theme) || bg; return true; }
    return false;
  };
  if (!(await bgFrom(doc, srels))) if (!(await bgFrom(layoutDoc, lrels))) await bgFrom(masterDoc, mrels);

  const items = [];
  // Asıl slayt şablonu ve düzendeki yer tutucu olmayan şekiller (logo, süs çizgileri)
  const showMaster = (d) => !d || d.documentElement.getAttribute('showMasterSp') !== '0';
  if (showMaster(doc) && showMaster(layoutDoc) && masterDoc) await readTree(masterDoc, { ...sctx, rels: mrels, decor: true }, items);
  if (showMaster(doc) && layoutDoc) await readTree(layoutDoc, { ...sctx, rels: lrels, decor: true }, items);
  await readTree(doc, sctx, items);

  // Konuşmacı notları
  let notes = '';
  const nr = R.relOfType(srels, 'notesSlide');
  if (nr) {
    const nd = await R.xml(nr.target);
    if (nd) {
      for (const sp of nd.getElementsByTagNameNS('*', 'sp')) {
        const ph = sp.getElementsByTagNameNS('*', 'ph')[0];
        if (ph && ph.getAttribute('type') === 'body') {
          notes = Array.from(sp.getElementsByTagNameNS('*', 'p')).map((p) => Array.from(p.getElementsByTagNameNS('*', 't')).map((t) => t.textContent).join('')).join('\n').trim();
        }
      }
    }
  }
  return { id: uid(), bg, bgImg, notes, items };
}

async function readTree(doc, ctx, items) {
  const tree = doc.getElementsByTagNameNS('*', 'spTree')[0];
  if (!tree) return;
  await readChildren(tree, ctx, items, (x) => x);
}

async function readChildren(parent, ctx, items, map) {
  for (const el of parent.children) {
    if (items.length > 2000) return;
    try {
      await readNode(el, ctx, items, map);
    } catch (e) {
      console.warn('Şekil okunamadı', e);
    }
  }
}

function readXfrm(xfrm) {
  if (!xfrm) return null;
  const off = kid(xfrm, 'off'), ext = kid(xfrm, 'ext');
  if (!off || !ext) return null;
  return {
    x: px(off.getAttribute('x')), y: px(off.getAttribute('y')),
    w: px(ext.getAttribute('cx')), h: px(ext.getAttribute('cy')),
    rot: xfrm.getAttribute('rot') ? +xfrm.getAttribute('rot') / 60000 : 0,
    flipH: xfrm.getAttribute('flipH') === '1', flipV: xfrm.getAttribute('flipV') === '1',
  };
}

async function readNode(el, ctx, items, map) {
  const name = el.localName;
  if (name === 'AlternateContent') {
    const pick = kid(el, 'Fallback') || kid(el, 'Choice');
    if (pick) await readChildren(pick, ctx, items, map);
    return;
  }
  if (name === 'grpSp') {
    const gx = path(el, 'grpSpPr', 'xfrm');
    let inner = map;
    if (gx) {
      const off = kid(gx, 'off'), ext = kid(gx, 'ext'), chOff = kid(gx, 'chOff'), chExt = kid(gx, 'chExt');
      if (off && ext && chOff && chExt) {
        const ox = px(off.getAttribute('x')), oy = px(off.getAttribute('y'));
        const cx = px(chOff.getAttribute('x')), cy = px(chOff.getAttribute('y'));
        const sx = +chExt.getAttribute('cx') ? +ext.getAttribute('cx') / +chExt.getAttribute('cx') : 1;
        const sy = +chExt.getAttribute('cy') ? +ext.getAttribute('cy') / +chExt.getAttribute('cy') : 1;
        inner = (b) => map({ ...b, x: ox + (b.x - cx) * sx, y: oy + (b.y - cy) * sy, w: b.w * sx, h: b.h * sy });
      }
    }
    await readChildren(el, ctx, items, inner);
    return;
  }
  if (name === 'sp') return readShape(el, ctx, items, map);
  if (name === 'cxnSp') return readShape(el, ctx, items, map, true);
  if (name === 'pic') return readPic(el, ctx, items, map);
  if (name === 'graphicFrame') return readFrame(el, ctx, items, map);
}

function decorate(item, ctx) {
  if (ctx.decor) item.lock = true;
  return item;
}

async function readShape(sp, ctx, items, map, connector = false) {
  const nv = kid(sp, connector ? 'nvCxnSpPr' : 'nvSpPr');
  const ph = nv ? path(nv, 'nvPr', 'ph') : null;
  const phType = ph ? ph.getAttribute('type') || 'body' : null;
  const phIdx = ph ? ph.getAttribute('idx') : null;
  if (ctx.decor && ph) return; // düzen/şablondaki yer tutucular slaytta görünmez
  if (ph && ['dt', 'ftr', 'sldNum', 'hdr'].includes(phType)) {
    // Tarih/altbilgi/slayt numarası: yalnızca metin içeriyorsa göster
    const txt = Array.from(sp.getElementsByTagNameNS('*', 't')).map((t) => t.textContent).join('').trim();
    if (!txt || phType === 'sldNum') return;
  }
  const spPr = kid(sp, 'spPr');
  const layoutSp = ph ? ctx.findPh(ctx.layoutPh, phType, phIdx) : null;
  const masterSp = ph ? ctx.findPh(ctx.masterPh, phType, phIdx, false) : null;
  let box = readXfrm(spPr && kid(spPr, 'xfrm'));
  if (!box && layoutSp) box = readXfrm(path(layoutSp, 'spPr', 'xfrm'));
  if (!box && masterSp) box = readXfrm(path(masterSp, 'spPr', 'xfrm'));
  if (!box) return;
  box = map(box);
  const styleEl = kid(sp, 'style');
  const geom = spPr && kid(spPr, 'prstGeom');
  const prst = geom ? geom.getAttribute('prst') : spPr && kid(spPr, 'custGeom') ? 'rect' : 'rect';
  let fill = fillOf(spPr, ctx.theme, styleEl);
  if (fill === undefined && layoutSp) fill = fillOf(kid(layoutSp, 'spPr'), ctx.theme, null);
  let line = lineOf(spPr, ctx.theme, styleEl);
  if (!line && layoutSp) line = lineOf(kid(layoutSp, 'spPr'), ctx.theme, null);

  // Resim dolgulu dikdörtgen -> resim
  const bf = spPr && kid(spPr, 'blipFill');
  if (bf) {
    const blip = kid(bf, 'blip');
    const rr = blip && ctx.rels[rid(blip, 'embed')];
    const src = rr && !rr.external ? await ctx.R.image(rr.target) : null;
    if (src) { items.push(decorate({ id: uid(), type: 'image', ...box, src }, ctx)); }
  }

  const txBody = kid(sp, 'txBody');
  const fontRef = styleEl && kid(styleEl, 'fontRef');
  const fontRefColor = fontRef ? colorFrom(fontRef, ctx.theme) : null;
  let text = null;
  if (txBody) text = readText(txBody, { ...ctx, phType, layoutSp, masterSp, fontRefColor });
  const hasText = text && text.plain.trim().length > 0;

  const isLine = connector || ['line', 'straightConnector1', 'bentConnector2', 'bentConnector3', 'curvedConnector3'].includes(prst);
  if (isLine) {
    if (!line || line.stroke === 'none') line = { stroke: (styleEl && colorFrom(kid(styleEl, 'lnRef'), ctx.theme)) || '#000000', strokeW: 1 };
    items.push(decorate({ id: uid(), type: 'shape', shape: 'line', x: box.x, y: box.y, w: Math.max(1, box.w), h: Math.max(1, box.h), rot: box.rot, flipH: box.flipH, flipV: box.flipV, stroke: line.stroke, strokeW: line.strokeW, dash: line.dash, arrowEnd: line.arrowEnd }, ctx));
    return;
  }

  const visibleFill = fill && fill !== 'none';
  const visibleLine = line && line.stroke !== 'none' && line.strokeW > 0;
  const textOnly = !visibleFill && !visibleLine && (prst === 'rect' || !geom);
  const SHAPE_MAP = { rect: 'rect', roundRect: 'roundRect', snip1Rect: 'rect', snip2SameRect: 'rect', round1Rect: 'roundRect', round2SameRect: 'roundRect', ellipse: 'ellipse', triangle: 'triangle', rtTriangle: 'rtTriangle', diamond: 'diamond', rightArrow: 'rightArrow', leftArrow: 'leftArrow', star5: 'star5', hexagon: 'hexagon', pentagon: 'pentagon', homePlate: 'chevron', chevron: 'chevron', parallelogram: 'parallelogram', trapezoid: 'trapezoid', flowChartProcess: 'rect', flowChartAlternateProcess: 'roundRect', flowChartDecision: 'diamond', flowChartConnector: 'ellipse', octagon: 'hexagon', plaque: 'roundRect', frame: 'rect', donut: 'ellipse' };

  const base = { id: uid(), ...box };
  if (text) Object.assign(base, text.props, { html: text.html });
  if (ph && !ctx.decor) base.ph = phType === 'ctrTitle' || phType === 'title' ? 'title' : phType === 'subTitle' ? 'subtitle' : 'body';
  if (textOnly) {
    if (!hasText && !ph) return; // boş, görünmez kutu
    if (!hasText && ph && ['pic', 'chart', 'tbl', 'media', 'clipArt', 'dgm'].includes(phType)) return;
    items.push(decorate({ ...base, type: 'text', fill: undefined }, ctx));
  } else if (prst === 'rect' && !visibleLine && hasText) {
    items.push(decorate({ ...base, type: 'text', fill: visibleFill ? fill : undefined }, ctx));
  } else {
    items.push(decorate({
      ...base, type: 'shape', shape: SHAPE_MAP[prst] || 'rect',
      fill: visibleFill ? fill : 'none', stroke: visibleLine ? line.stroke : 'none', strokeW: visibleLine ? line.strokeW : 0, dash: line && line.dash,
      html: text ? text.html : '',
    }, ctx));
  }
}

function readText(txBody, ctx) {
  const theme = ctx.theme;
  const bodyPr = kid(txBody, 'bodyPr');
  const layoutBody = ctx.layoutSp ? path(ctx.layoutSp, 'txBody') : null;
  const masterBody = ctx.masterSp ? path(ctx.masterSp, 'txBody') : null;
  const bp = (attr) => {
    for (const b of [bodyPr, layoutBody && kid(layoutBody, 'bodyPr'), masterBody && kid(masterBody, 'bodyPr')]) if (b && b.hasAttribute(attr)) return b.getAttribute(attr);
    return null;
  };
  const anchor = bp('anchor');
  const ins = ['tIns', 'rIns', 'bIns', 'lIns'].map((a) => { const v = bp(a); return v != null ? px(v) : a === 'tIns' || a === 'bIns' ? 4.8 : 9.6; });
  const fontScale = (() => { const na = bodyPr && kid(bodyPr, 'normAutofit'); return na && na.getAttribute('fontScale') ? +na.getAttribute('fontScale') / 100000 : 1; })();

  const type = ctx.phType;
  const styleSet = type == null ? ctx.masterStyles.other : (type === 'title' || type === 'ctrTitle') ? ctx.masterStyles.title : ['body', 'subTitle', 'obj'].includes(type) || !type ? ctx.masterStyles.body : ctx.masterStyles.other;
  const stacks = [
    type == null ? ctx.defaultTextStyle : {},
    styleSet,
    masterBody ? lstLevels(kid(masterBody, 'lstStyle'), theme) : {},
    layoutBody ? lstLevels(kid(layoutBody, 'lstStyle'), theme) : {},
    lstLevels(kid(txBody, 'lstStyle'), theme),
  ];
  const levelStyle = (lvl) => {
    let o = { r: {} };
    for (const s of stacks) if (s[lvl]) o = mergeLevel(o, s[lvl]);
    return o;
  };

  const doc = document.implementation.createHTMLDocument('');
  const root = doc.createElement('div');
  let list = null, listKind = null;
  let plain = '';
  let firstSize = null, firstAlign = null, firstColor = null;
  const subtitle = type === 'subTitle';

  for (const p of kids(txBody, 'p')) {
    const pPr = kid(p, 'pPr');
    const lvl = (pPr && +pPr.getAttribute('lvl') || 0) + 1;
    const ps = mergeLevel(levelStyle(lvl), readPPr(pPr, theme));
    const endRPr = readRPr(kid(p, 'endParaRPr'), theme);
    const runs = [];
    for (const r of p.children) {
      if (r.localName === 'r' || r.localName === 'fld') {
        const t = kid(r, 't');
        const rp = { ...ps.r, ...readRPr(kid(r, 'rPr'), theme) };
        let link = null;
        const hl = kid(r, 'rPr') && kid(kid(r, 'rPr'), 'hlinkClick');
        if (hl) { const rr = ctx.rels[rid(hl, 'id')]; if (rr && rr.external) link = rr.target; }
        runs.push({ text: t ? t.textContent : '', rp, link });
      } else if (r.localName === 'br') runs.push({ br: true, rp: { ...ps.r, ...readRPr(kid(r, 'rPr'), theme) } });
    }
    const text = runs.map((r) => (r.br ? '\n' : r.text)).join('');
    plain += text + '\n';
    const bullet = ps.bullet === 'num' ? 'num' : ps.bullet === 'char' && text.trim() ? 'char' : null;
    const isBullet = bullet && !(type === 'title' || type === 'ctrTitle' || subtitle);
    let block;
    if (isBullet) {
      const kind = bullet === 'num' ? 'ol' : 'ul';
      if (!list || listKind !== kind) { list = doc.createElement(kind); listKind = kind; root.append(list); }
      block = doc.createElement('li');
      list.append(block);
      if (lvl > 1) block.style.marginLeft = (lvl - 1) * 1.4 + 'em';
    } else {
      list = null; listKind = null;
      block = doc.createElement('p');
      root.append(block);
      if (ps.marL) block.style.marginLeft = Math.max(0, ps.marL + (ps.indent || 0)) + 'px';
    }
    if (ps.align && ps.align !== 'left') block.style.textAlign = ps.align;
    if (ps.lnSpc) block.style.lineHeight = String(Math.round(ps.lnSpc * 1.2 * 100) / 100);
    if (ps.spcBef) block.style.marginTop = Math.round(ps.spcBef * fontScale) + 'px';
    if (ps.spcAft) block.style.marginBottom = Math.round(ps.spcAft * fontScale) + 'px';
    if (firstAlign == null) firstAlign = ps.align || 'left';
    const sizeOf = (rp) => Math.round(ptToPx(rp.sz || 1800) * fontScale * 10) / 10;
    if (!runs.length || !text) {
      const sp = doc.createElement('span');
      sp.style.fontSize = sizeOf({ ...ps.r, ...endRPr }) + 'px';
      sp.append(doc.createElement('br'));
      block.append(sp);
      continue;
    }
    for (const run of runs) {
      const rp = run.rp;
      if (firstSize == null && !run.br) { firstSize = sizeOf(rp); firstColor = rp.color || ctx.fontRefColor || null; }
      if (run.br) { block.append(doc.createElement('br')); continue; }
      let node = doc.createElement('span');
      const st = node.style;
      st.fontSize = sizeOf(rp) + 'px';
      const color = rp.color || ctx.fontRefColor;
      if (color) st.color = color;
      if (rp.font) st.fontFamily = `"${rp.font.replace(/["\\;{}<>]/g, '')}"`;
      if (rp.b) st.fontWeight = 'bold';
      if (rp.i) st.fontStyle = 'italic';
      const deco = [rp.u && 'underline', rp.strike && 'line-through'].filter(Boolean).join(' ');
      if (deco) st.textDecoration = deco;
      if (rp.cap === 'all') st.textTransform = 'uppercase';
      let t = run.text;
      node.textContent = t;
      if (rp.base) { const w = doc.createElement(rp.base); w.append(node); node = w; }
      if (run.link) { const a = doc.createElement('a'); a.setAttribute('href', run.link); a.append(node); node = a; }
      block.append(node);
    }
  }
  const props = {
    valign: anchor === 'ctr' ? 'middle' : anchor === 'b' ? 'bottom' : 'top',
    pad: [ins[0], ins[1], ins[2], ins[3]],
    fs: firstSize || 24,
    align: firstAlign && firstAlign !== 'left' ? firstAlign : undefined,
    color: firstColor || undefined,
  };
  if (bodyPr && bodyPr.getAttribute('vert') && bodyPr.getAttribute('vert') !== 'horz') props.vertical = true;
  return { html: root.innerHTML, plain, props };
}

async function readPic(pic, ctx, items, map) {
  const spPr = kid(pic, 'spPr');
  let box = readXfrm(spPr && kid(spPr, 'xfrm'));
  if (!box) {
    const ph = path(pic, 'nvPicPr', 'nvPr', 'ph');
    if (ph) {
      const lsp = ctx.findPh(ctx.layoutPh, ph.getAttribute('type') || 'body', ph.getAttribute('idx'));
      if (lsp) box = readXfrm(path(lsp, 'spPr', 'xfrm'));
    }
  }
  if (!box) return;
  box = map(box);
  const bf = kid(pic, 'blipFill');
  const blip = bf && kid(bf, 'blip');
  if (!blip) return;
  const embed = rid(blip, 'embed');
  const rr = embed ? ctx.rels[embed] : null;
  if (!rr || rr.external) return; // dış bağlantılı resim: güvenlik nedeniyle yüklenmez
  const src = await ctx.R.image(rr.target);
  const item = { id: uid(), type: 'image', ...box };
  if (!src) {
    items.push(decorate({ ...item, type: 'shape', shape: 'rect', fill: '#f2f2f2', stroke: '#bfbfbf', strokeW: 1, html: '<p><span style="color:#7f7f7f;font-size:14px">Resim (bu biçim gösterilemiyor)</span></p>', valign: 'middle', align: 'center' }, ctx));
    return;
  }
  item.src = src;
  const sr = kid(bf, 'srcRect');
  if (sr) {
    const g = (a) => (sr.getAttribute(a) ? +sr.getAttribute(a) / 100000 : 0);
    const c = { l: g('l'), t: g('t'), r: g('r'), b: g('b') };
    if (c.l || c.t || c.r || c.b) item.crop = c;
  }
  const alpha = blip.getElementsByTagNameNS('*', 'alphaModFix')[0];
  if (alpha && alpha.getAttribute('amt')) item.opacity = +alpha.getAttribute('amt') / 100000;
  items.push(decorate(item, ctx));
}

async function readFrame(gf, ctx, items, map) {
  const x = kid(gf, 'xfrm');
  let box = readXfrm(x);
  if (!box) return;
  box = map(box);
  const gd = path(gf, 'graphic', 'graphicData');
  if (!gd) return;
  const uri = gd.getAttribute('uri') || '';
  const tbl = kid(gd, 'tbl');
  if (tbl) {
    const grid = kids(kid(tbl, 'tblGrid'), 'gridCol').map((g) => px(g.getAttribute('w')));
    const tblPr = kid(tbl, 'tblPr');
    const rows = [];
    let fs = null;
    for (const tr of kids(tbl, 'tr')) {
      const row = [];
      for (const tc of kids(tr, 'tc')) {
        const cell = {};
        if (tc.getAttribute('hMerge') === '1' || tc.getAttribute('vMerge') === '1') cell.hidden = true;
        if (+tc.getAttribute('gridSpan') > 1) cell.colSpan = +tc.getAttribute('gridSpan');
        if (+tc.getAttribute('rowSpan') > 1) cell.rowSpan = +tc.getAttribute('rowSpan');
        const tb = kid(tc, 'txBody');
        if (tb) {
          const t = readText(tb, { ...ctx, phType: null, layoutSp: null, masterSp: null, fontRefColor: null });
          cell.html = t.html;
          if (fs == null && t.plain.trim()) fs = t.props.fs;
        }
        const tcPr = kid(tc, 'tcPr');
        const sf = tcPr && kid(tcPr, 'solidFill');
        if (sf) cell.fill = colorFrom(sf, ctx.theme);
        row.push(cell);
      }
      rows.push(row);
    }
    if (!rows.length) return;
    items.push(decorate({
      id: uid(), type: 'table', ...box, rows, colW: grid, fs: fs || 16,
      header: tblPr ? tblPr.getAttribute('firstRow') === '1' : false,
      banded: tblPr ? tblPr.getAttribute('bandRow') === '1' : false,
    }, ctx));
    return;
  }
  const label = /chart/.test(uri) ? 'Grafik' : /diagram/.test(uri) ? 'SmartArt grafiği' : /ole/i.test(uri) ? 'Gömülü nesne' : 'Nesne';
  // Gömülü OLE nesneleri (güvenlik riski) çalıştırılmaz; varsa önizleme resmini gösteririz.
  const fallbackPic = gd.getElementsByTagNameNS('*', 'pic')[0];
  if (fallbackPic) { await readPic(fallbackPic, ctx, items, () => box); return; }
  items.push(decorate({
    id: uid(), type: 'shape', shape: 'rect', ...box, fill: '#f2f2f2', stroke: '#bfbfbf', strokeW: 1, valign: 'middle', align: 'center',
    html: `<p><span style="color:#7f7f7f;font-size:16px">${label} (önizleme desteklenmiyor)</span></p>`,
  }, ctx));
}
