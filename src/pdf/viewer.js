// PDF görüntüleyici (pdf.js). Güvenlik:
// - pdf.js 6.x: yazı tiplerinde eval/new Function kullanılmaz (CVE-2024-4367 bu sürümlerde kapalı).
// - PDF içi JavaScript (scripting) hiç yüklenmez, XFA formları kapalı, WebAssembly kapalı
//   (CSP'de 'wasm-unsafe-eval' gerekmez; saf JS yedekleri kullanılır).
// - Bağlantılar yalnızca http/https/mailto ise ve kullanıcı tıklarsa sistem tarayıcısında açılır.
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { h, tbtn, tsep, tselect, toast, clear, modal, popupMenu } from '../core/ui.js';
import { saveBlob, printElement, canPrint, isSafeUrl, openExternal } from '../core/platform.js';
import { LITE, canvasDpr } from '../core/perf.js';
import { pinchZoom } from '../core/pinch.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const assetUrl = (p) => new URL(p, document.baseURI).href;
// Telefonlarda sayfa başına tuval belleği sınırlı tutulur; bellekte daha az sayfa kalır.
const MAX_CANVAS_PIXELS = (LITE ? 6 : 16) * 1024 * 1024;
const KEEP_PAGES = LITE ? 3 : 6;

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
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes.slice(0)),
    enableXfa: false,
    useWasm: false,
    isEvalSupported: false, // eski sürümlerle uyumluluk için; 6.x zaten eval kullanmaz
    disableAutoFetch: true,
    stopAtErrors: false,
    cMapUrl: assetUrl('pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: assetUrl('pdfjs/standard_fonts/'),
    wasmUrl: assetUrl('pdfjs/wasm/'),
    iccUrl: assetUrl('pdfjs/iccs/'),
  });
  let pwTries = 0;
  task.onPassword = async (update, reason) => {
    const pw = await askPassword(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD || pwTries > 0);
    pwTries++;
    if (pw == null) { task.destroy(); return; }
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
    el.append(canvasBox, textBox, linkBox, h('div', { class: 'pdf-page-num' }, String(i)));
    pagesEl.append(el);
    pages.push({ el, canvasBox, textBox, linkBox, num: i, vp1: i === 1 ? baseVp : null, page: i === 1 ? first : null, renderedScale: 0, task: null });
  }

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
      if (target !== scale) { p.renderedScale = 0; renderPage(p); }
    } catch (err) {
      p.task = null;
      if (err && err.name === 'RenderingCancelledException') return;
      console.warn('Sayfa çizilemedi', err);
    }
  }

  async function renderLinks(p, vp) {
    clear(p.linkBox);
    let annots = [];
    try { annots = await p.page.getAnnotations({ intent: 'display' }); } catch { return; }
    for (const a of annots) {
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

  function unrender(p) {
    if (p.task) { p.task.cancel(); p.task = null; }
    if (p.renderedScale) {
      clear(p.canvasBox); clear(p.textBox); clear(p.linkBox);
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
        const vp = pg.getViewport({ scale: 150 / 72 });
        const c = document.createElement('canvas');
        c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
        await pg.render({ canvas: c, viewport: vp, intent: 'print', annotationMode: pdfjs.AnnotationMode.ENABLE_STORAGE }).promise;
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
      : 'Offisea PDF içindeki betikleri ve formları çalıştırmaz; dosya yalnızca görüntülenir.');
    modal({ title: 'Belge bilgileri', body: h('div', null, tbl, note) });
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
  status.textContent = `Sayfa 1 / ${n}`;
  setTimeout(() => scroller.focus({ preventScroll: true }), 50);
  void app;

  return {
    onBackButton: () => { if (findBar.hidden) return false; findBar.hidden = true; return true; },
    readOnly: true,
    serialize: () => data,
    primaryExport: { label: 'PDF dosyasını kaydet', run: (title) => saveBlob(new Blob([bytes], { type: 'application/pdf' }), `${title}.pdf`) },
    fileMenu: (title) => [
      { label: 'PDF dosyasını kaydet', icon: 'download', onClick: () => saveBlob(new Blob([bytes], { type: 'application/pdf' }), `${title()}.pdf`) },
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
      io.disconnect();
      ro.disconnect();
      root.removeEventListener('keydown', onKey);
      for (const p of pages) if (p.task) p.task.cancel();
      pdf.destroy().catch(() => {});
      clear(root);
      root.classList.remove('editor', 'editor-pdf');
    },
  };
}
