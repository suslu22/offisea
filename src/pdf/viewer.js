// PDF görüntüleyici (pdf.js). Güvenlik:
// - pdf.js 6.x: yazı tiplerinde eval/new Function kullanılmaz (CVE-2024-4367 bu sürümlerde kapalı).
// - PDF içi JavaScript (scripting) hiç yüklenmez, XFA formları kapalı, WebAssembly kapalı
//   (CSP'de 'wasm-unsafe-eval' gerekmez; saf JS yedekleri kullanılır).
// - Bağlantılar yalnızca http/https/mailto ise ve kullanıcı tıklarsa sistem tarayıcısında açılır.
import { pdfjs, loadPdfJs } from './pdfjs.js';
import { h, tbtn, tsep, tselect, toast, clear, modal, popupMenu, askText, confirmBox } from '../core/ui.js';
import { saveBlob, printElement, canPrint, isSafeUrl, openExternal } from '../core/platform.js';
import { LITE, canvasDpr } from '../core/perf.js';
import { pinchZoom } from '../core/pinch.js';
import { createAnnotator, cleanAnnots, renderLayerPng, drawItems, isVectorItem, teditLines, textLines } from './annotate.js';
import { textBlocks, sampleColors, loadScreenFonts } from './textlayout.js';

const loadTools = () => import('./tools.js');
// Telefonlarda sayfa başına tuval belleği sınırlı tutulur; bellekte daha az sayfa kalır.
const MAX_CANVAS_PIXELS = (LITE ? 6 : 16) * 1024 * 1024;
const KEEP_PAGES = LITE ? 3 : 6;

/** Saklanan form değerlerini doğrular. */
function cleanForm(v) {
  const out = {};
  if (!v || typeof v !== 'object') return out;
  for (const [k, val] of Object.entries(v).slice(0, 3000)) {
    const key = String(k).slice(0, 500);
    if (typeof val === 'string') out[key] = val.slice(0, 20000);
    else if (Array.isArray(val)) out[key] = val.filter((x) => typeof x === 'string').slice(0, 200).map((x) => x.slice(0, 2000));
  }
  return out;
}

async function askPassword(retry) {
  const input = h('input', { class: 'input', type: 'password', autocomplete: 'off', 'aria-label': 'PDF parolası' });
  const r = await modal({
    title: retry ? 'Parola yanlış, tekrar deneyin' : 'Bu PDF parola korumalı',
    body: h('div', null, h('label', { class: 'field-label' }, 'Parola'), input),
    actions: [{ label: 'İptal', value: null }, { label: 'Aç', primary: true, value: () => input.value }],
  });
  return r;
}

export async function mountPdf(root, data, app) {
  root.classList.add('editor', 'editor-pdf');
  const bytes = data && data.bytes ? data.bytes : null;
  if (!bytes) throw new Error('PDF verisi bulunamadı.');

  const toolbar = h('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'PDF araçları' });
  const pagesEl = h('div', { class: 'pdf-pages' });
  const scroller = h('div', { class: 'pdf-scroller', tabindex: '0', 'aria-label': 'PDF sayfaları' }, pagesEl);
  const status = h('div', { class: 'statusbar' });
  const findBar = h('div', { class: 'findbar', hidden: true });
  root.append(toolbar, findBar, scroller, status);
  status.textContent = 'PDF açılıyor…';

  // pdf.js veriyi işçiye aktarır (transfer); kayıtlı kopyayı korumak için kopyasını veriyoruz.
  const task = loadPdfJs(bytes);
  let pwTries = 0;
  let password; // yalnızca bellekte tutulur; sayfa işlemlerinde dosyayı çözmek için
  task.onPassword = async (update, reason) => {
    const pw = await askPassword(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD || pwTries > 0);
    pwTries++;
    if (pw == null) { task.destroy(); return; }
    password = pw;
    update(pw);
  };

  let pdf;
  try {
    pdf = await task.promise;
  } catch (err) {
    clear(root);
    root.classList.remove('editor', 'editor-pdf');
    if (err && err.name === 'PasswordException') throw new Error('PDF açılmadı: parola girilmedi.');
    throw new Error('PDF açılamadı. Dosya bozuk olabilir.');
  }

  const n = pdf.numPages;
  let zoomMode = 'width'; // 'width' | 'page' | sayı
  let scale = 1;
  let destroyed = false;
  const pages = []; // { el, canvasBox, textBox, linkBox, vp1, rendered, task, num }

  // Sayfa boyutlarını öğren (ilk sayfayı temel al, diğerleri görünür olunca düzeltilir)
  const first = await pdf.getPage(1);
  const baseVp = first.getViewport({ scale: 1 });
  for (let i = 1; i <= n; i++) {
    const el = h('div', { class: 'pdf-page', dataset: { num: String(i) }, 'aria-label': `Sayfa ${i}` });
    const canvasBox = h('div', { class: 'pdf-canvas-box' });
    const textBox = h('div', { class: 'textLayer' });
    const linkBox = h('div', { class: 'pdf-links' });
    const formBox = h('div', { class: 'pdf-form' });
    el.append(canvasBox, textBox, linkBox, formBox, h('div', { class: 'pdf-page-num' }, String(i)));
    pagesEl.append(el);
    pages.push({ el, canvasBox, textBox, linkBox, formBox, num: i, vp1: i === 1 ? baseVp : null, page: i === 1 ? first : null, renderedScale: 0, task: null });
  }

  // ---- Form alanları --------------------------------------------------------------------------
  // Yalnızca kullanıcının değiştirdiği alanlar saklanır; kaydederken PDF'in form alanlarına yazılır.
  const formValues = cleanForm(data.form);
  const widgets = new Map(); // alan adı → Map(pdf.js açıklama kimliği → { type, exp })
  let formHinted = false;
  const storeOne = (id, f, value) => {
    let v;
    if (f.type === 'text') v = { value: Array.isArray(value) ? value[0] || '' : String(value) };
    else if (f.type === 'check') v = { value: value === f.exp };
    else v = { value: Array.isArray(value) ? value : [value] };
    try { pdf.annotationStorage.setValue(id, v); } catch { /* yok say */ }
  };
  // Yazdırmada (pdf.js) girilen değerler görünsün diye pdf.js'in form deposuna da yazılır
  function storeField(name, value) {
    for (const [id, f] of widgets.get(name) || []) storeOne(id, f, value);
  }
  /** Sayfadaki form alanını tanır; doldurulabilir değilse null döner. */
  function registerWidget(a) {
    if (a.subtype !== 'Widget' || !a.fieldName || !a.rect || a.hidden || a.readOnly) return null;
    let f = null;
    if (a.fieldType === 'Tx') f = { type: 'text' };
    else if (a.fieldType === 'Btn' && (a.checkBox || a.radioButton)) {
      const exp = a.checkBox ? a.exportValue : a.buttonValue;
      if (exp != null) f = { type: 'check', exp: String(exp) };
    } else if (a.fieldType === 'Ch' && Array.isArray(a.options)) f = { type: 'choice' };
    if (!f) return null;
    if (!widgets.has(a.fieldName)) widgets.set(a.fieldName, new Map());
    if (!widgets.get(a.fieldName).has(a.id)) {
      widgets.get(a.fieldName).set(a.id, f);
      if (Object.prototype.hasOwnProperty.call(formValues, a.fieldName)) storeOne(a.id, f, formValues[a.fieldName]);
    }
    return f;
  }
  async function registerPageWidgets(pg) {
    try { for (const a of await pg.getAnnotations({ intent: 'display' })) registerWidget(a); } catch { /* yok say */ }
  }
  function setField(name, value, from) {
    formValues[name] = value;
    data.form = { ...formValues };
    storeField(name, value);
    // Aynı adlı diğer alanlar (başka sayfalarda da olabilir) eşitlenir
    for (const el of pagesEl.querySelectorAll('.pdf-field')) {
      if (el === from || el.dataset.field !== name) continue;
      if (el.type === 'checkbox' || el.type === 'radio') el.checked = value === el.value;
      else if (el.multiple) for (const o of el.options) o.selected = value.includes(o.value);
      else el.value = Array.isArray(value) ? value[0] || '' : value;
    }
    app.markDirty();
  }

  // ---- Notlar (kalem, vurgulayıcı, metin, imza, yazı düzenleme) ------------------------------------
  const annot = createAnnotator({
    pages, pagesEl,
    getSize: (p) => p.vp1 || baseVp,
    currentPage: () => currentPage(),
    initial: cleanAnnots(data.annots, n),
    onChange: (items) => { data.annots = items; app.markDirty(); },
    readOnlyReason: () => null,
    getBlocks: async (p) => {
      if (!p.page) p.page = await pdf.getPage(p.num);
      await loadScreenFonts(); // blok boyutları bu yazı tipleriyle ölçülür
      const tc = await p.page.getTextContent();
      return textBlocks(tc, p.vp1 || p.page.getViewport({ scale: 1 }), p.page.commonObjs);
    },
    colorsAt: (p, rect) => {
      const c = p.canvasBox.querySelector('canvas');
      const vp = p.vp1 || baseVp;
      return sampleColors(c, rect, c ? c.width / vp.width : 1);
    },
  });
  toolbar.after(annot.bar);

  function computeScale() {
    const avail = Math.max(100, scroller.clientWidth - 32);
    const availH = Math.max(100, scroller.clientHeight - 32);
    if (zoomMode === 'width') return Math.min(4, avail / baseVp.width);
    if (zoomMode === 'page') return Math.min(avail / baseVp.width, availH / baseVp.height);
    return zoomMode;
  }

  function layout() {
    scale = computeScale();
    for (const p of pages) {
      const vp = p.vp1 || baseVp;
      p.el.style.width = Math.floor(vp.width * scale) + 'px';
      p.el.style.height = Math.floor(vp.height * scale) + 'px';
      p.el.style.setProperty('--total-scale-factor', String(scale));
      p.el.style.setProperty('--scale-round-x', '1px');
      p.el.style.setProperty('--scale-round-y', '1px');
    }
    updateStatus();
    queueVisible();
  }

  async function renderPage(p) {
    if (destroyed) return;
    if (p.renderedScale === scale || p.task) return;
    const target = scale;
    try {
      if (!p.page) p.page = await pdf.getPage(p.num);
      if (!p.vp1) {
        p.vp1 = p.page.getViewport({ scale: 1 });
        p.el.style.width = Math.floor(p.vp1.width * scale) + 'px';
        p.el.style.height = Math.floor(p.vp1.height * scale) + 'px';
      }
      const vp = p.page.getViewport({ scale: target });
      let dpr = canvasDpr();
      if (vp.width * vp.height * dpr * dpr > MAX_CANVAS_PIXELS) dpr = Math.sqrt(MAX_CANVAS_PIXELS / (vp.width * vp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = Math.floor(vp.width) + 'px';
      canvas.style.height = Math.floor(vp.height) + 'px';
      const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null;
      p.task = p.page.render({ canvas, viewport: vp, transform, annotationMode: pdfjs.AnnotationMode.ENABLE });
      await p.task.promise;
      p.task = null;
      if (destroyed) return;
      clear(p.canvasBox);
      p.canvasBox.append(canvas);
      p.renderedScale = target;
      // Metin katmanı (seçme ve kopyalama için)
      clear(p.textBox);
      try {
        const tl = new pdfjs.TextLayer({ textContentSource: p.page.streamTextContent(), container: p.textBox, viewport: vp });
        await tl.render();
      } catch { /* metin katmanı isteğe bağlı */ }
      await renderLinks(p, vp);
      annot.drawPage(p);
      if (target !== scale) { p.renderedScale = 0; renderPage(p); }
    } catch (err) {
      p.task = null;
      if (err && err.name === 'RenderingCancelledException') return;
      console.warn('Sayfa çizilemedi', err);
    }
  }

  async function renderLinks(p, vp) {
    clear(p.linkBox);
    clear(p.formBox);
    let annots = [];
    try { annots = await p.page.getAnnotations({ intent: 'display' }); } catch { return; }
    for (const a of annots) {
      if (a.subtype === 'Widget') { formField(p, vp, a); continue; }
      if (a.subtype !== 'Link' || !a.rect) continue;
      const [x1, y1] = vp.convertToViewportPoint(a.rect[0], a.rect[1]);
      const [x2, y2] = vp.convertToViewportPoint(a.rect[2], a.rect[3]);
      const box = { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
      const link = h('a', { class: 'pdf-link', style: Object.fromEntries(Object.entries(box).map(([k, v]) => [k, v + 'px'])) });
      if (a.url && isSafeUrl(a.url)) {
        link.href = a.url;
        link.rel = 'noopener noreferrer nofollow';
        link.title = a.url;
        link.addEventListener('click', (e) => { e.preventDefault(); openExternal(a.url); });
      } else if (a.dest) {
        link.href = '#';
        link.title = 'Belge içi bağlantı';
        link.addEventListener('click', async (e) => {
          e.preventDefault();
          try {
            const dest = typeof a.dest === 'string' ? await pdf.getDestination(a.dest) : a.dest;
            if (!dest) return;
            const idx = typeof dest[0] === 'object' ? await pdf.getPageIndex(dest[0]) : +dest[0];
            gotoPage(idx + 1);
          } catch { /* yok say */ }
        });
      } else continue; // javascript:, file:, launch eylemleri vb. yok sayılır
      p.linkBox.append(link);
    }
  }

  // Form alanının üstüne aynı yerde düzenlenebilir bir HTML alanı konur
  function formField(p, vp, a) {
    if (!registerWidget(a)) return;
    if (!formHinted) {
      formHinted = true;
      toast('Bu PDF doldurulabilir form alanları içeriyor. Alanlara dokunarak doldurabilirsiniz.', { timeout: 5000 });
    }
    const [x1, y1] = vp.convertToViewportPoint(a.rect[0], a.rect[1]);
    const [x2, y2] = vp.convertToViewportPoint(a.rect[2], a.rect[3]);
    const left = Math.min(x1, x2), top = Math.min(y1, y2), w = Math.abs(x2 - x1), hh = Math.abs(y2 - y1);
    if (w < 2 || hh < 2) return;
    const name = a.fieldName;
    const has = Object.prototype.hasOwnProperty.call(formValues, name);
    const val = has ? formValues[name] : a.fieldValue;
    const da = a.defaultAppearanceData && a.defaultAppearanceData.fontSize > 0 ? a.defaultAppearanceData.fontSize * vp.scale : 0;
    const label = String(a.alternativeText || name).slice(0, 120);
    let el;
    if (a.fieldType === 'Tx') {
      el = h(a.multiLine ? 'textarea' : 'input', { class: 'pdf-field pdf-field-text', 'aria-label': label, title: label, spellcheck: 'false', autocomplete: 'off' });
      if (!a.multiLine) el.type = 'text';
      if (a.maxLen > 0) el.maxLength = a.maxLen;
      el.value = Array.isArray(val) ? val[0] || '' : val == null ? '' : String(val);
      el.style.fontSize = (da || (a.multiLine ? 10 * vp.scale : Math.min(hh * 0.62, 12 * vp.scale))) + 'px';
      el.style.textAlign = ['left', 'center', 'right'][a.textAlignment] || 'left';
      el.addEventListener('input', () => setField(name, el.value, el));
    } else if (a.fieldType === 'Btn' && (a.checkBox || a.radioButton)) {
      const exp = a.checkBox ? a.exportValue : a.buttonValue;
      if (exp == null) return;
      el = h('input', { class: 'pdf-field pdf-field-check', type: a.checkBox ? 'checkbox' : 'radio', 'aria-label': label, title: label, value: String(exp) });
      if (a.radioButton) el.name = 'pdfr-' + name;
      el.checked = String(val) === String(exp);
      el.addEventListener('change', () => {
        if (a.radioButton) { if (el.checked) setField(name, String(exp), el); } else setField(name, el.checked ? String(exp) : 'Off', el);
      });
    } else if (a.fieldType === 'Ch' && Array.isArray(a.options)) {
      el = h('select', { class: 'pdf-field pdf-field-choice', 'aria-label': label, title: label });
      if (!a.combo) { el.multiple = !!a.multiSelect; el.size = Math.max(2, Math.min(a.options.length, Math.floor(hh / 14) || 2)); }
      const cur = Array.isArray(val) ? val.map(String) : val == null ? [] : [String(val)];
      if (a.combo && !cur.length) el.append(h('option', { value: '' }, ''));
      for (const o of a.options) {
        const opt = h('option', { value: String(o.exportValue) }, String(o.displayValue == null ? o.exportValue : o.displayValue));
        opt.selected = cur.includes(String(o.exportValue));
        el.append(opt);
      }
      el.style.fontSize = (da || Math.min(hh * 0.62, 12 * vp.scale)) + 'px';
      el.addEventListener('change', () => setField(name, el.multiple ? [...el.selectedOptions].map((o) => o.value) : [el.value], el));
    } else return;
    el.dataset.field = name;
    Object.assign(el.style, { left: left + 'px', top: top + 'px', width: w + 'px', height: hh + 'px' });
    p.formBox.append(el);
  }

  function unrender(p) {
    if (p.task) { p.task.cancel(); p.task = null; }
    if (p.renderedScale) {
      clear(p.canvasBox); clear(p.textBox); clear(p.linkBox); clear(p.formBox);
      p.renderedScale = 0;
    }
  }

  // Görünür sayfaları çiz, çok uzaktakileri bellekten at
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const p = pages[+e.target.dataset.num - 1];
      p.visible = e.isIntersecting;
    }
    queueVisible();
  }, { root: scroller, rootMargin: LITE ? '300px 0px' : '600px 0px' });
  for (const p of pages) io.observe(p.el);

  let queued = false;
  function queueVisible() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const vis = pages.filter((p) => p.visible);
      for (const p of vis) renderPage(p);
      if (vis.length) {
        const lo = vis[0].num - KEEP_PAGES, hi = vis[vis.length - 1].num + KEEP_PAGES;
        for (const p of pages) if ((p.num < lo || p.num > hi) && p.renderedScale) unrender(p);
      }
      updateStatus();
    });
  }

  function currentPage() {
    const top = scroller.scrollTop + scroller.clientHeight * 0.3;
    for (const p of pages) if (p.el.offsetTop + p.el.offsetHeight > top) return p.num;
    return n;
  }

  function gotoPage(num) {
    num = Math.max(1, Math.min(n, num | 0));
    const p = pages[num - 1];
    scroller.scrollTop = p.el.offsetTop - 12;
    pageInput.value = String(num);
  }

  function updateStatus() {
    const c = currentPage();
    if (document.activeElement !== pageInput) pageInput.value = String(c);
    status.textContent = `Sayfa ${c} / ${n}  ·  %${Math.round(scale * 100)}`;
  }
  let statusQueued = false;
  scroller.addEventListener('scroll', () => {
    if (statusQueued) return;
    statusQueued = true;
    requestAnimationFrame(() => { statusQueued = false; updateStatus(); });
  }, { passive: true });

  function setZoom(z) {
    const keep = currentPage();
    const frac = (() => { const p = pages[keep - 1]; return p.el.offsetHeight ? (scroller.scrollTop - p.el.offsetTop) / p.el.offsetHeight : 0; })();
    zoomMode = z;
    layout();
    const p = pages[keep - 1];
    scroller.scrollTop = p.el.offsetTop + frac * p.el.offsetHeight;
    zoomSel.value = typeof z === 'number' ? (['0.5', '0.75', '1', '1.25', '1.5', '2', '3'].includes(String(z)) ? String(z) : 'custom') : z;
    if (zoomSel.value === 'custom' || !zoomSel.value) {
      let opt = zoomSel.querySelector('option[value="custom"]');
      if (!opt) { opt = h('option', { value: 'custom' }); zoomSel.append(opt); }
      opt.textContent = `%${Math.round(scale * 100)}`;
      zoomSel.value = 'custom';
    }
  }
  const zoomStep = (dir) => {
    const levels = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
    const curS = scale;
    const next = dir > 0 ? levels.find((l) => l > curS + 0.01) || 4 : [...levels].reverse().find((l) => l < curS - 0.01) || 0.25;
    setZoom(next);
  };

  // ---- Arama ----------------------------------------------------------------------------------
  const textCache = new Map();
  async function pageText(num) {
    if (textCache.has(num)) return textCache.get(num);
    const pg = await pdf.getPage(num);
    const tc = await pg.getTextContent();
    const t = tc.items.map((i) => i.str || '').join(' ');
    textCache.set(num, t);
    return t;
  }
  const findInput = h('input', { class: 'input find-input', type: 'search', placeholder: 'PDF içinde ara', 'aria-label': 'PDF içinde ara' });
  const findInfo = h('span', { class: 'find-info' });
  let lastFind = { q: '', page: 0 };
  async function findNext(dir = 1) {
    const q = findInput.value.trim().toLocaleLowerCase('tr');
    if (!q) return;
    const start = lastFind.q === q ? lastFind.page : currentPage() - dir;
    findInfo.textContent = 'Aranıyor…';
    for (let k = 1; k <= n; k++) {
      const num = ((start - 1 + dir * k) % n + n) % n + 1;
      const t = (await pageText(num)).toLocaleLowerCase('tr');
      if (t.includes(q)) {
        lastFind = { q, page: num };
        gotoPage(num);
        findInfo.textContent = `Sayfa ${num}`;
        highlightOn(num, q);
        return;
      }
    }
    findInfo.textContent = 'Bulunamadı';
  }
  function highlightOn(num, q) {
    const p = pages[num - 1];
    const tryMark = () => {
      for (const s of p.textBox.querySelectorAll('span')) {
        s.classList.toggle('highlight', !!q && s.textContent.toLocaleLowerCase('tr').includes(q));
      }
    };
    setTimeout(tryMark, 400);
    setTimeout(tryMark, 1200);
  }
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); findNext(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { findBar.hidden = true; scroller.focus(); }
  });
  findBar.append(findInput,
    tbtn('arrowUp', 'Önceki', () => findNext(-1)),
    tbtn('arrowDown', 'Sonraki', () => findNext(1)),
    findInfo,
    tbtn('close', 'Kapat', () => { findBar.hidden = true; }));
  function openFind() { findBar.hidden = false; findInput.focus(); findInput.select(); }

  // ---- Yazdırma ve kaydetme ---------------------------------------------------------------------
  async function doPrint() {
    if (!canPrint()) { toast('Bu cihazda yazdırma desteklenmiyor.', { type: 'error' }); return; }
    if (n > 300) { toast('Çok sayfalı PDF yazdırılıyor, bu biraz sürebilir…'); }
    const t = toast('Yazdırma için sayfalar hazırlanıyor…', { timeout: 60000 });
    const imgs = [];
    try {
      for (let i = 1; i <= n; i++) {
        const pg = await pdf.getPage(i);
        await registerPageWidgets(pg);
        const vp = pg.getViewport({ scale: 150 / 72 });
        const c = document.createElement('canvas');
        c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
        await pg.render({ canvas: c, viewport: vp, intent: 'print', annotationMode: pdfjs.AnnotationMode.ENABLE_STORAGE }).promise;
        const its = annot.items().filter((x) => x.p === i - 1);
        if (its.length) await drawItems(c.getContext('2d'), its, 150 / 72);
        const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
        imgs.push({ url: URL.createObjectURL(blob), w: pg.getViewport({ scale: 1 }).width, h: pg.getViewport({ scale: 1 }).height });
        c.width = c.height = 0;
      }
    } finally { t.remove(); }
    const w0 = imgs[0] ? imgs[0].w : 595, h0 = imgs[0] ? imgs[0].h : 842;
    printElement(() => {
      const wrap = h('div', { class: 'print-pdf' });
      for (const im of imgs) wrap.append(h('img', { src: im.url, alt: '', class: 'print-pdf-page' }));
      return wrap;
    }, { pageCss: `@page { size: ${w0}pt ${h0}pt; margin: 0; } .print-pdf-page { display:block; width:100%; height:auto; page-break-after: always; break-after: page; }` });
    setTimeout(() => imgs.forEach((im) => URL.revokeObjectURL(im.url)), 120000);
  }

  async function showInfo() {
    let meta = {};
    try { meta = (await pdf.getMetadata()).info || {}; } catch { /* yok say */ }
    const rows = [
      ['Başlık', meta.Title], ['Yazar', meta.Author], ['Konu', meta.Subject], ['Oluşturan', meta.Creator],
      ['Üretici', meta.Producer], ['PDF sürümü', meta.PDFFormatVersion], ['Sayfa sayısı', String(n)],
    ].filter((r) => r[1]);
    const tbl = h('table', { class: 'info-table' }, ...rows.map(([k, v]) => h('tr', null, h('th', null, k), h('td', null, String(v).slice(0, 300)))));
    const hasJs = await pdf.getJSActions().then((a) => a && Object.keys(a).length > 0).catch(() => false);
    const note = h('p', { class: 'muted' }, hasJs
      ? 'Bu PDF gömülü JavaScript içeriyor. Offisea güvenlik nedeniyle PDF içindeki betikleri asla çalıştırmaz.'
      : 'Offisea PDF içindeki betikleri (JavaScript) hiçbir zaman çalıştırmaz.');
    modal({ title: 'Belge bilgileri', body: h('div', null, tbl, note) });
  }

  // ---- Sayfa işlemleri ---------------------------------------------------------------------------
  async function pageSize(idx) {
    const p = pages[idx];
    if (p.vp1) return p.vp1;
    return (await pdf.getPage(idx + 1)).getViewport({ scale: 1 });
  }
  const needsBake = () => annot.items().length > 0 || Object.keys(formValues).length > 0;
  /** Notlar, yazı düzenlemeleri ve form değerleri işlenmiş PDF baytları (yoksa dosyanın kendisi). */
  async function outputBytes() {
    annot.flush();
    const items = annot.items();
    if (!needsBake()) return new Uint8Array(bytes);
    const tools = await loadTools();
    if (items.some(isVectorItem)) await loadScreenFonts();
    const plans = new Map();
    for (const idx of [...new Set(items.map((i) => i.p))]) {
      const vp = await pageSize(idx);
      const its = items.filter((i) => i.p === idx);
      const raster = its.filter((i) => !isVectorItem(i));
      const toUser = (x, y) => vp.convertToPdfPoint(x, y);
      const urect = (r) => {
        const pts = [toUser(r.x, r.y), toUser(r.x + r.w, r.y), toUser(r.x, r.y + r.h), toUser(r.x + r.w, r.y + r.h)];
        const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
        return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      };
      // Ekrandaki yatay yönün PDF'teki açısı (sayfa döndürülmüşse 90'ın katları)
      const o = toUser(0, 0), ex = toUser(1, 0);
      const angle = (Math.atan2(ex[1] - o[1], ex[0] - o[0]) * 180) / Math.PI;
      const plan = { removes: [], texts: [], png: raster.length ? await renderLayerPng(raster, vp.width, vp.height) : null };
      const conv = (lines) => lines.map((l) => ({ str: l.str, at: toUser(l.x, l.y) }));
      for (const it of its) {
        if (it.t === 'tedit') {
          plan.removes.push({ rect: urect(it), bg: it.bg, oc: it.oc });
          plan.texts.push({ family: it.ff, bold: it.b, italic: it.i, size: it.s, color: it.c, angle, lines: conv(teditLines(it)) });
        } else if (it.t === 'text') {
          plan.texts.push({ family: 'sans', bold: false, italic: false, size: it.s, color: it.c, angle, lines: conv(textLines(it)) });
        }
      }
      plans.set(idx, plan);
    }
    const r = await tools.bakeEdits(bytes, plans, { password, form: formValues });
    if (r.warn) toast('Bazı yazılar dosyadan tamamen silinemedi; üzerleri örtüldü.', { timeout: 6000 });
    return r.bytes;
  }
  async function work(text, fn) {
    const done = app.busy ? app.busy(text) : () => {};
    try { return await fn(await loadTools()); } catch (err) {
      console.error(err);
      toast((err && err.message) || 'İşlem başarısız.', { type: 'error', timeout: 7000 });
      return null;
    } finally { done(); }
  }
  async function confirmBake() {
    annot.flush();
    if (!annot.items().length) return true;
    return confirmBox('Notlar sayfaya işlenecek', 'Bu işlemden önce eklediğiniz notlar ve imzalar sayfalara kalıcı olarak işlenir (sonradan taşınamaz). Devam edilsin mi?', { okLabel: 'Devam et' });
  }
  async function replaceBytes(u8, msg, page) {
    const tools = await loadTools();
    const buf = tools.toBuffer(u8);
    await app.replaceData({ bytes: buf, lastPage: page || currentPage() }, { size: buf.byteLength });
    if (msg) toast(msg, { type: 'success' });
  }
  async function rotate(indices, delta) {
    if (!(await confirmBake())) return;
    const page = currentPage();
    const out = await work('Sayfalar döndürülüyor…', async (t) => t.rotatePages(await outputBytes(), indices, delta, { password }));
    if (out) await replaceBytes(out, null, page);
  }
  async function removePages(indices) {
    if (indices.length >= n) { toast('Tüm sayfalar silinemez.', { type: 'error' }); return; }
    const label = indices.length === 1 ? `${indices[0] + 1}. sayfa` : `${indices.length} sayfa`;
    if (!(await confirmBox('Sayfaları sil', `${label} silinsin mi?`, { okLabel: 'Sil', danger: true }))) return;
    if (!(await confirmBake())) return;
    const page = Math.min(currentPage(), n - indices.length);
    const out = await work('Sayfalar siliniyor…', async (t) => t.deletePages(await outputBytes(), indices, { password }));
    if (out) await replaceBytes(out, `${label} silindi.`, page);
  }
  async function askRange(title, okHint) {
    const t = await askText(title, { label: `Sayfa aralığı (1–${n}). ${okHint}`, placeholder: 'ör. 1-3, 5, 8-' });
    if (t == null || !t.trim()) return null;
    const { parseRange } = await loadTools();
    const r = parseRange(t, n);
    if (!r) { toast('Sayfa aralığı anlaşılamadı. Örnek: 1-3, 5', { type: 'error' }); return null; }
    return { list: r, text: t.trim() };
  }
  async function extract() {
    const r = await askRange('Sayfaları ayrı PDF olarak çıkar', 'Seçilen sayfalar yeni bir PDF olur.');
    if (!r) return;
    const out = await work('Sayfalar çıkarılıyor…', async (t) => t.extractPages(await outputBytes(), r.list, { password }));
    if (!out) return;
    const buf = (await loadTools()).toBuffer(out);
    await app.createDoc({ kind: 'pdf', title: `${app.title ? app.title() : 'PDF'} (sayfa ${r.text})`, data: { bytes: buf }, size: buf.byteLength });
  }
  async function deleteRange() {
    const r = await askRange('Sayfaları sil', 'Seçilen sayfalar silinir.');
    if (r) removePages([...new Set(r.list)]);
  }
  async function appendFiles() {
    const files = (await app.pickFiles('.pdf,application/pdf')).filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!files.length) return;
    if (!(await confirmBake())) return;
    const page = currentPage();
    const out = await work('PDF ekleniyor…', async (t) => {
      const others = [];
      for (const f of files) others.push(await f.arrayBuffer());
      return t.appendPdfs(await outputBytes(), others, { password });
    });
    if (out) await replaceBytes(out, `${files.length} dosya sona eklendi.`, page);
  }
  async function compress() {
    const sel = h('select', { class: 'input', 'aria-label': 'Kalite' },
      h('option', { value: '150|0.8' }, 'Yüksek kalite (az küçülür)'),
      h('option', { value: '110|0.7' }, 'Dengeli (önerilen)'),
      h('option', { value: '80|0.55' }, 'En küçük boyut'));
    sel.value = '110|0.7';
    const r = await modal({
      title: 'PDF’i küçült',
      body: h('div', null,
        h('p', null, 'Sayfalar sıkıştırılmış resimlere dönüştürülerek dosya küçültülür. Küçültülmüş kopyada metin seçilemez ve aranamaz; asıl dosya değişmez.'),
        h('label', { class: 'field-label' }, 'Kalite'), sel),
      actions: [{ label: 'İptal', value: null }, { label: 'Küçült', primary: true, value: () => sel.value }],
    });
    if (!r) return;
    const [dpi, q] = r.split('|').map(Number);
    const before = bytes.byteLength;
    const out = await work('PDF küçültülüyor…', async (t) => t.rasterize(await outputBytes(), { password, dpi, quality: q }));
    if (!out) return;
    if (out.byteLength >= before * 0.95) { toast('Bu dosya daha fazla küçültülemiyor.', { timeout: 5000 }); return; }
    const fmt = (b) => (b / 1024 / 1024 >= 1 ? (b / 1024 / 1024).toFixed(1).replace('.', ',') + ' MB' : Math.round(b / 1024) + ' KB');
    toast(`${fmt(before)} → ${fmt(out.byteLength)} (küçültülmüş kopya oluşturuldu)`, { type: 'success', timeout: 6000 });
    const buf = (await loadTools()).toBuffer(out);
    await app.createDoc({ kind: 'pdf', title: `${app.title ? app.title() : 'PDF'} (küçültülmüş)`, data: { bytes: buf }, size: buf.byteLength });
  }
  // ---- Yazı tanıma (OCR) ------------------------------------------------------------------------
  function progressOverlay(text) {
    const msg = h('div', null, text);
    let cancelled = false;
    const cancel = h('button', { class: 'btn', type: 'button' }, 'İptal');
    const el = h('div', { class: 'loading-overlay', role: 'status' }, h('div', { class: 'spinner' }), msg, cancel);
    cancel.addEventListener('click', () => { cancelled = true; cancel.disabled = true; msg.textContent = 'İptal ediliyor…'; });
    document.body.append(el);
    return { set: (t) => { if (!cancelled) msg.textContent = t; }, cancelled: () => cancelled, close: () => el.remove() };
  }
  async function pagesWithoutText() {
    const out = [];
    for (let i = 1; i <= n; i++) if ((await pageText(i)).replace(/\s/g, '').length < 15) out.push(i);
    return out;
  }
  async function runOcr() {
    annot.flush();
    let list = await pagesWithoutText();
    if (!list.length) {
      const ok = await confirmBox('Yazılar zaten seçilebilir', 'Bu PDF’in sayfalarında seçilebilir yazı var. Yine de tüm sayfalarda yazı tanıma yapılsın mı? (Sayfalara ikinci, görünmez bir yazı katmanı eklenir.)', { okLabel: 'Yine de tanı' });
      if (!ok) return;
      list = pages.map((p) => p.num);
    } else if (!(await confirmBox('Yazıları tanı (OCR)', `${list.length === n ? 'Tüm sayfalardaki' : list.length + ' sayfadaki'} yazılar bu cihazda tanınacak; sayfalara görünmez bir yazı katmanı eklenecek. Böylece metin seçilebilir, kopyalanabilir ve aranabilir olur. Görünüm değişmez. Belgeleriniz hiçbir yere gönderilmez.`, { okLabel: 'Başlat' }))) return;
    if (!(await confirmBake())) return;
    const pr = progressOverlay('Yazı tanıma hazırlanıyor…');
    const layers = new Map();
    let words = 0;
    const ocr = await import('./ocr.js');
    try {
      for (let k = 0; k < list.length; k++) {
        if (pr.cancelled()) break;
        pr.set(`Yazılar tanınıyor… Sayfa ${k + 1} / ${list.length}`);
        const pg = await pdf.getPage(list[k]);
        const vp1 = pg.getViewport({ scale: 1 });
        let s = 300 / 72;
        const maxPx = (LITE ? 6 : 10) * 1e6;
        if (vp1.width * vp1.height * s * s > maxPx) s = Math.sqrt(maxPx / (vp1.width * vp1.height));
        const vp = pg.getViewport({ scale: s });
        const c = document.createElement('canvas');
        c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        await pg.render({ canvas: c, viewport: vp, intent: 'print' }).promise;
        const r = await ocr.recognize(c);
        c.width = c.height = 0;
        const toUser = (x, y) => vp1.convertToPdfPoint(x, y);
        const o = toUser(0, 0), ex = toUser(1, 0);
        const angle = (Math.atan2(ex[1] - o[1], ex[0] - o[0]) * 180) / Math.PI;
        const ws = ocr.layoutWords(r.words, 1 / s, toUser, angle);
        if (ws.length) { layers.set(list[k] - 1, ws); words += ws.length; }
      }
      if (pr.cancelled() && !layers.size) return;
      if (!layers.size) { toast('Sayfalarda tanınabilir yazı bulunamadı.', { timeout: 5000 }); return; }
      pr.set('Yazılar PDF’e ekleniyor…');
      const tools = await loadTools();
      const out = await tools.addOcrLayers(await outputBytes(), layers, { password });
      await replaceBytes(out, `${layers.size} sayfada yazılar tanındı (${words} kelime). Artık metin seçilebilir ve aranabilir.`);
    } catch (err) {
      console.error(err);
      toast((err && err.message) || 'Yazı tanıma başarısız.', { type: 'error', timeout: 7000 });
    } finally {
      pr.close();
      ocr.stopOcr();
    }
  }

  // ---- Word belgesine dönüştürme ------------------------------------------------------------------
  async function toWord() {
    const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const done = app.busy ? app.busy('Word belgesine dönüştürülüyor…') : () => {};
    try {
      const all = [];
      let chars = 0;
      for (let i = 1; i <= n; i++) {
        const pg = await pdf.getPage(i);
        const tc = await pg.getTextContent();
        all.push(textBlocks(tc, pg.getViewport({ scale: 1 }), null).sort((a, b) => (Math.abs(a.y - b.y) < 4 ? a.x - b.x : a.y - b.y)));
      }
      // Başlıklar belgenin olağan yazı boyutuna göre seçilir (en çok yazının kullandığı boyut)
      const bySize = new Map();
      for (const b of all.flat()) bySize.set(Math.round(b.s), (bySize.get(Math.round(b.s)) || 0) + b.text.length);
      const body = [...bySize].sort((a, b) => b[1] - a[1])[0]?.[0] || 11;
      const parts = [];
      all.forEach((blocks, i) => {
        for (const b of blocks) {
          const big = b.s >= body * 1.3 && b.text.length < 150;
          const lvl = b.s >= body * 1.7 ? 1 : 2;
          const inner = esc(b.text).replace(/\n/g, '<br>');
          const styled = b.b && !big ? `<strong>${inner}</strong>` : inner;
          parts.push(big ? `<h${lvl}>${inner}</h${lvl}>` : `<p>${styled}</p>`);
          chars += b.text.length;
        }
        if (i < all.length - 1) parts.push('<hr>');
      });
      if (chars < 20) {
        toast('Bu PDF’te dönüştürülecek yazı bulunamadı. Taranmış bir belgeyse önce “Yazıları tanı (OCR)”yı kullanın.', { timeout: 7000 });
        return;
      }
      await app.createDoc({ kind: 'word', title: `${app.title ? app.title() : 'PDF'}`, data: { html: parts.join('\n') } });
    } catch (err) {
      console.error(err);
      toast('Dönüştürülemedi.', { type: 'error' });
    } finally { done(); }
  }

  function pageMenu(anchor) {
    const cp = currentPage();
    popupMenu(anchor, [
      { header: `Bu sayfa (${cp})` },
      { label: 'Sağa döndür', icon: 'rotate', onClick: () => rotate([cp - 1], 90) },
      { label: 'Sola döndür', icon: 'restore', onClick: () => rotate([cp - 1], -90) },
      n > 1 ? { label: 'Bu sayfayı sil', icon: 'trash', onClick: () => removePages([cp - 1]) } : null,
      { separator: true },
      { header: 'Tüm belge' },
      { label: 'Tüm sayfaları sağa döndür', icon: 'rotate', onClick: () => rotate(pages.map((p) => p.num - 1), 90) },
      { label: 'Sayfaları ayrı PDF olarak çıkar…', icon: 'pages', onClick: extract },
      n > 1 ? { label: 'Sayfaları sil…', icon: 'trash', onClick: deleteRange } : null,
      { label: 'Sona başka PDF ekle…', icon: 'plus', onClick: appendFiles },
      { label: 'PDF’i küçült…', icon: 'compress', onClick: compress },
      { label: 'Yazıları tanı (OCR)…', icon: 'search', onClick: runOcr },
      { label: 'Word belgesine dönüştür', icon: 'doc', onClick: toWord },
    ], { minWidth: 250 });
  }
  async function savePdf(title) {
    annot.flush();
    if (!needsBake()) { saveBlob(new Blob([bytes], { type: 'application/pdf' }), `${title}.pdf`); return; }
    const out = await work('Değişiklikler PDF’e işleniyor…', () => outputBytes());
    if (out) saveBlob(new Blob([out], { type: 'application/pdf' }), `${title}.pdf`);
  }

  // ---- Araç çubuğu ---------------------------------------------------------------------------
  const pageInput = h('input', { class: 'input page-input', type: 'number', min: '1', max: String(n), value: '1', 'aria-label': 'Sayfa numarası' });
  pageInput.addEventListener('change', () => gotoPage(+pageInput.value));
  pageInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { gotoPage(+pageInput.value); scroller.focus(); } });
  const zoomSel = tselect([
    { value: 'width', label: 'Sayfa genişliği' }, { value: 'page', label: 'Tüm sayfa' },
    { value: '0.5', label: '%50' }, { value: '0.75', label: '%75' }, { value: '1', label: '%100' },
    { value: '1.25', label: '%125' }, { value: '1.5', label: '%150' }, { value: '2', label: '%200' }, { value: '3', label: '%300' },
  ], (v) => { if (v !== 'custom') setZoom(v === 'width' || v === 'page' ? v : +v); }, { title: 'Yakınlaştırma', value: 'width', width: '140px' });

  toolbar.append(
    tbtn('arrowUp', 'Önceki sayfa', () => gotoPage(currentPage() - 1)),
    pageInput, h('span', { class: 'page-total' }, `/ ${n}`),
    tbtn('arrowDown', 'Sonraki sayfa', () => gotoPage(currentPage() + 1)),
    tsep(),
    tbtn('zoomOut', 'Uzaklaştır', () => zoomStep(-1)),
    zoomSel,
    tbtn('zoomIn', 'Yakınlaştır', () => zoomStep(1)),
    tsep(),
    tbtn('pen', 'Düzenle: yazıları değiştir, not ekle, imzala', () => annot.toggleBar(!annot.isOpen()), { text: 'Düzenle', cls: 'tb-wide' }),
    tbtn('pages', 'Sayfa işlemleri', (e, b) => pageMenu(b), { text: 'Sayfalar', cls: 'tb-wide' }),
    tsep(),
    tbtn('search', 'Ara (Ctrl+F)', openFind),
    canPrint() ? tbtn('print', 'Yazdır (Ctrl+P)', doPrint) : null,
    tbtn('info', 'Belge bilgileri', showInfo),
  );

  const onKey = (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.target === findInput || e.target === pageInput) return;
    if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); openFind(); }
    else if (mod && e.key.toLowerCase() === 'p') { e.preventDefault(); doPrint(); }
    else if (mod && (e.key === '+' || e.key === '=')) { e.preventDefault(); zoomStep(1); }
    else if (mod && e.key === '-') { e.preventDefault(); zoomStep(-1); }
    else if (mod && e.key === '0') { e.preventDefault(); setZoom('width'); }
    else if (e.key === 'PageDown' && !mod) { e.preventDefault(); gotoPage(currentPage() + 1); }
    else if (e.key === 'PageUp' && !mod) { e.preventDefault(); gotoPage(currentPage() - 1); }
    else if (e.key === 'Home' && !mod) { e.preventDefault(); gotoPage(1); }
    else if (e.key === 'End' && !mod) { e.preventDefault(); gotoPage(n); }
  };
  root.addEventListener('keydown', onKey);

  // Ctrl + fare tekerleği ile yakınlaştırma
  scroller.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoomStep(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  // İki parmakla yakınlaştırma (telefon / dokunmatik ekran)
  pinchZoom(scroller, { content: () => pagesEl, getZoom: () => scale, setZoom: (z) => setZoom(Math.round(z * 100) / 100), min: 0.25, max: 4, wheel: false });

  scroller.addEventListener('contextmenu', (e) => {
    const s = document.getSelection();
    if (s && String(s).trim()) return; // seçili metin varsa tarayıcı menüsü (kopyala)
    e.preventDefault();
    popupMenu({ x: e.clientX, y: e.clientY }, [
      { label: 'Yakınlaştır', icon: 'zoomIn', onClick: () => zoomStep(1) },
      { label: 'Uzaklaştır', icon: 'zoomOut', onClick: () => zoomStep(-1) },
      { label: 'Sayfa genişliğine sığdır', icon: 'fullscreen', onClick: () => setZoom('width') },
      { separator: true },
      { label: 'Ara…', icon: 'search', onClick: openFind },
      canPrint() ? { label: 'Yazdır…', icon: 'print', onClick: doPrint } : null,
    ]);
  });

  let lastW = 0;
  const ro = new ResizeObserver(() => {
    const w = scroller.clientWidth;
    if (Math.abs(w - lastW) < 2) return;
    lastW = w;
    if (zoomMode === 'width' || zoomMode === 'page') setZoom(zoomMode);
  });
  ro.observe(scroller);
  layout();
  annot.refreshAll();
  status.textContent = `Sayfa 1 / ${n}`;
  if (n <= 60) {
    // Yazısı olmayan (taranmış) PDF'lerde yazı tanıma önerilir
    pagesWithoutText().then((l) => {
      if (destroyed || l.length < Math.max(1, n * 0.6)) return;
      toast('Bu PDF’teki yazılar seçilemiyor (taranmış olabilir).', { timeout: 8000, action: { label: 'Yazıları tanı', onClick: runOcr } });
    }).catch(() => {});
  }
  if (data.lastPage > 1 && data.lastPage <= n) requestAnimationFrame(() => gotoPage(data.lastPage));
  setTimeout(() => scroller.focus({ preventScroll: true }), 50);

  return {
    onBackButton: () => {
      if (!findBar.hidden) { findBar.hidden = true; return true; }
      return annot.back();
    },
    serialize: () => ({ bytes, annots: annot.items(), form: { ...formValues }, lastPage: currentPage() }),
    primaryExport: { label: 'PDF dosyasını kaydet', run: (title) => savePdf(title) },
    fileMenu: (title) => [
      { label: 'PDF dosyasını kaydet', icon: 'download', onClick: () => savePdf(title()) },
      { label: 'Yazıları düzenle, not ekle ve imzala', icon: 'signature', onClick: () => annot.toggleBar(true) },
      { label: 'Yazıları tanı (OCR)…', icon: 'search', onClick: runOcr },
      { label: 'Word belgesine dönüştür', icon: 'doc', onClick: toWord },
      { label: 'Sayfa işlemleri…', icon: 'pages', onClick: () => setTimeout(() => pageMenu(toolbar), 0) },
      canPrint() ? { label: 'Yazdır', icon: 'print', hint: 'Ctrl+P', onClick: doPrint } : null,
      { label: 'Metni dışa aktar (.txt)', icon: 'download', onClick: async () => {
        const parts = [];
        for (let i = 1; i <= n; i++) parts.push(await pageText(i));
        saveBlob(new Blob([parts.join('\n\n')], { type: 'text/plain;charset=utf-8' }), `${title()}.txt`);
      } },
      { label: 'Belge bilgileri', icon: 'info', onClick: showInfo },
    ],
    destroy() {
      destroyed = true;
      annot.destroy();
      io.disconnect();
      ro.disconnect();
      root.removeEventListener('keydown', onKey);
      for (const p of pages) if (p.task) p.task.cancel();
      if (pdf) Promise.resolve().then(() => pdf.loadingTask.destroy()).catch(() => {});
      clear(root);
      root.classList.remove('editor', 'editor-pdf');
    },
  };
}
