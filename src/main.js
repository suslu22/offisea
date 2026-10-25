// Offisea uygulama kabuğu: yönlendirme, üst çubuk, dosya açma, otomatik kayıt.
import './fonts.css';
import './styles.css';
import { h, icon, clear, debounce, toast, popupMenu, closeMenus, closeTopModal, tbtn } from './core/ui.js';
import { saveDoc, loadDoc, newId, getPref, setPref } from './core/storage.js';
import { pickFile, pickFiles, kindOf, legacyMessage, baseName, readArrayBuffer, MAX_FILE_BYTES, ACCEPT_ALL } from './core/files.js';
import { isNative, isElectron, openExternal } from './core/platform.js';
import { initUpdates } from './core/updater.js';
import { LITE, whenIdle, applyPerfClass, applyGlass, probeGlassLater } from './core/perf.js';
import { renderHome, KINDS, showAbout, homeBack, currentFolder } from './home.js';
import { applyTheme, toggleTheme, onThemeChange } from './core/theme.js';

const topbar = document.getElementById('topbar');
const view = document.getElementById('view');

let cur = null; // { id, kind, title, editor, dirty, size }
let routeSeq = 0;

applyPerfClass();
applyGlass();

// ---- Tema ------------------------------------------------------------------------------------
applyTheme();
const themeBtn = () => {
  const b = tbtn(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon', 'Açık / koyu tema', () => toggleTheme());
  b.classList.add('theme-btn');
  return b;
};
// Tema ayarlardan ya da sistemden değişirse üst çubuktaki düğme de güncellenir.
onThemeChange(() => { for (const b of document.querySelectorAll('.theme-btn')) b.replaceWith(themeBtn()); });

// ---- Yükleniyor göstergesi ----------------------------------------------------------------------
function busy(text) {
  const el = h('div', { class: 'loading-overlay', role: 'status' }, h('div', { class: 'spinner' }), h('div', null, text));
  document.body.append(el);
  return () => el.remove();
}

// ---- Kayıt ------------------------------------------------------------------------------------
let statusEl = null;
function setStatus(text, kind = '') {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.className = 'save-status ' + kind;
}

// Düşük donanımlı cihazlarda kayıt biraz daha seyrek ve tarayıcı boştayken yapılır (yazarken takılmasın).
const scheduleSave = debounce(() => { if (LITE) whenIdle(() => saveNow()); else saveNow(); }, LITE ? 2500 : 1500);

function markDirty() {
  if (!cur) return;
  cur.dirty = true;
  setStatus('Kaydediliyor…', 'pending');
  scheduleSave();
}

let saving = Promise.resolve();
function saveNow({ force = false } = {}) {
  scheduleSave.cancel();
  const c = cur;
  if (!c || (!c.dirty && !force)) return saving;
  c.dirty = false;
  saving = saving.then(async () => {
    try {
      if (c.editor.flush) c.editor.flush();
      const data = c.editor.serialize();
      await saveDoc({ id: c.id, kind: c.kind, title: c.title, data, size: c.size || 0 });
      if (c === cur) setStatus('Bu cihaza kaydedildi', 'ok');
    } catch (err) {
      console.error(err);
      c.dirty = true;
      if (c === cur) setStatus('Kaydedilemedi!', 'error');
      toast('Belge kaydedilemedi. Depolama alanı dolu olabilir; belgeyi dosya olarak indirin.', { type: 'error', timeout: 8000 });
    }
  });
  return saving;
}

window.addEventListener('beforeunload', () => { if (cur && cur.dirty) saveNow(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && cur && cur.dirty) saveNow(); });

// ---- Üst çubuk ----------------------------------------------------------------------------------
function renderHomeBar() {
  clear(topbar);
  topbar.className = 'topbar topbar-home';
  topbar.append(
    h('div', { class: 'brand' }, h('img', { src: './icons/icon.svg', alt: '', class: 'brand-logo', width: '28', height: '28' }), h('span', null, 'Offisea')),
    h('div', { class: 'top-spacer' }),
    tbtn('folder', 'Dosya aç (Ctrl+O)', () => openFile(), { text: 'Aç', cls: 'tb-wide hide-sm' }),
    themeBtn(),
    tbtn('settings', 'Ayarlar ve hakkında', showAbout),
  );
  document.title = 'Offisea';
}

function renderEditorBar() {
  clear(topbar);
  topbar.className = 'topbar topbar-editor';
  const k = KINDS[cur.kind];
  const title = h('input', { class: 'doc-title', value: cur.title, 'aria-label': 'Belge adı', spellcheck: 'false', maxlength: '200' });
  title.addEventListener('input', () => {
    cur.title = title.value.trim() || k.newTitle;
    document.title = `${cur.title} – Offisea`;
    markDirty();
  });
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); title.blur(); } });
  title.addEventListener('blur', () => { if (!title.value.trim()) title.value = cur.title; });
  statusEl = h('span', { class: 'save-status ok' }, cur.editor.readOnly ? 'Salt okunur' : 'Bu cihaza kaydedildi');
  const fileBtn = tbtn('menu', 'Dosya menüsü', (e, b) => fileMenu(b), { text: 'Dosya', cls: 'tb-wide' });
  const exportBtn = tbtn('download', cur.editor.primaryExport.label, () => runExport(), { text: 'İndir', cls: 'tb-wide tb-accent' });
  topbar.append(
    tbtn('home', 'Ana ekran', () => goHome()),
    h('span', { class: `kind-badge kind-${cur.kind}`, title: k.long }, icon(k.icon, 18)),
    h('div', { class: 'title-wrap' }, title, statusEl),
    h('div', { class: 'top-spacer' }),
    fileBtn,
    exportBtn,
    themeBtn(),
  );
  document.title = `${cur.title} – Offisea`;
}

async function runExport() {
  if (!cur) return;
  try { await cur.editor.primaryExport.run(cur.title); } catch (err) {
    console.error(err);
    toast('Dışa aktarma başarısız: ' + (err.message || err), { type: 'error' });
  }
}

function fileMenu(anchor) {
  const items = [
    { header: 'Yeni' },
    { label: 'Yeni belge', icon: 'doc', onClick: () => createNew('word') },
    { label: 'Yeni tablo', icon: 'sheet', onClick: () => createNew('sheet') },
    { label: 'Yeni sunu', icon: 'pres', onClick: () => createNew('slides') },
    { label: 'Dosya aç…', icon: 'folder', hint: 'Ctrl+O', onClick: () => openFile() },
    { separator: true },
    { header: 'Kaydet / dışa aktar' },
    ...cur.editor.fileMenu(() => cur.title).filter(Boolean),
    { separator: true },
    !cur.editor.readOnly ? { label: 'Şimdi bu cihaza kaydet', icon: 'check', hint: 'Ctrl+S', onClick: () => { saveNow({ force: true }).then(() => toast('Bu cihaza kaydedildi.', { type: 'success' })); } } : null,
    { label: 'Ana ekrana dön', icon: 'home', onClick: goHome },
  ];
  popupMenu(anchor, items, { minWidth: 260 });
}

// ---- Yönlendirme --------------------------------------------------------------------------------
const DOC_RE = /^#\/doc\/([0-9a-f]{24})$/;

function go(id) {
  history.pushState({ fromHome: !cur }, '', '#/doc/' + id);
  route();
}

function goHome() {
  if (history.state && history.state.fromHome) history.back();
  else { history.replaceState(null, '', '#/'); route(); }
}

async function closeEditor() {
  if (!cur) return;
  closeMenus();
  await saveNow();
  const c = cur;
  cur = null;
  statusEl = null;
  try { c.editor.destroy(); } catch (e) { console.warn(e); }
  clear(view);
}

async function route() {
  const seq = ++routeSeq;
  const m = DOC_RE.exec(location.hash);
  if (m && cur && cur.id === m[1]) return;
  await closeEditor();
  if (seq !== routeSeq) return;
  if (!m) {
    renderHomeBar();
    await renderHome(view, { openFile, createNew, openDoc: go, installPrompt, scanDoc, mergePdfs: mergePdfFiles });
    return;
  }
  const done = busy('Açılıyor…');
  try {
    const doc = await loadDoc(m[1]);
    if (seq !== routeSeq) return;
    if (!doc) { toast('Belge bulunamadı.', { type: 'error' }); history.replaceState(null, '', '#/'); route(); return; }
    await mountEditor(doc, seq);
  } catch (err) {
    console.error(err);
    toast(err.message || 'Belge açılamadı.', { type: 'error', timeout: 7000 });
    history.replaceState(null, '', '#/');
    route();
  } finally { done(); }
}

async function mountEditor(doc, seq) {
  clear(view);
  view.className = 'view view-editor';
  const host = h('div', { class: 'editor-host' });
  view.append(host);
  const app = { markDirty, createDoc, replaceData, pickFiles, busy, title: () => (cur ? cur.title : doc.title || '') };
  let editor;
  if (doc.kind === 'word') editor = await (await import('./word/editor.js')).mountWord(host, doc.data, app);
  else if (doc.kind === 'sheet') editor = await (await import('./sheet/grid.js')).mountSheet(host, doc.data, app);
  else if (doc.kind === 'slides') editor = await (await import('./slides/editor.js')).mountSlides(host, doc.data, app);
  else if (doc.kind === 'pdf') editor = await (await import('./pdf/viewer.js')).mountPdf(host, doc.data, app);
  else throw new Error('Bilinmeyen belge türü.');
  if (seq !== routeSeq) { editor.destroy(); return; }
  cur = { id: doc.id, kind: doc.kind, title: doc.title || KINDS[doc.kind].newTitle, editor, dirty: false, size: doc.size || 0 };
  renderEditorBar();
}

window.addEventListener('popstate', () => {
  if (cur && cur.editor.handleBack && cur.editor.handleBack()) return;
  route();
});
window.addEventListener('hashchange', () => route());

// ---- Belge oluşturma ve dosya açma --------------------------------------------------------------
async function createNew(kind, { template } = {}) {
  let data, title = KINDS[kind].newTitle;
  if (template) {
    const t = (await import('./templates.js')).templateById(template);
    if (t) { data = t.data(); title = t.title; kind = t.kind; }
  }
  if (!data) {
    if (kind === 'word') data = { html: '<p><br></p>' };
    else if (kind === 'sheet') data = (await import('./sheet/grid.js')).newSheetData();
    else data = (await import('./slides/editor.js')).newSlidesData();
  }
  await createDoc({ kind, title, data, size: 0 });
}

/** Yeni belgeyi kaydedip açar (ana ekranda seçili klasöre konur). */
async function createDoc({ kind, title, data, size = 0 }) {
  const id = newId();
  await saveDoc({ id, kind, title: String(title || KINDS[kind].newTitle).slice(0, 200), data, size, folder: currentFolder() });
  if (cur) await closeEditor();
  go(id);
  return id;
}

/** Açık belgenin içeriğini değiştirip düzenleyiciyi yeniden yükler (ör. PDF sayfa işlemleri). */
async function replaceData(data, { size } = {}) {
  if (!cur) return;
  const c = cur;
  await saveNow();
  await saveDoc({ id: c.id, kind: c.kind, title: c.title, data, size: size != null ? size : c.size || 0 });
  if (c !== cur) return;
  const seq = ++routeSeq;
  cur = null;
  statusEl = null;
  try { c.editor.destroy(); } catch (e) { console.warn(e); }
  const doc = await loadDoc(c.id);
  if (doc) await mountEditor(doc, seq);
}

async function scanDoc() {
  try {
    const r = await (await import('./pdf/scan.js')).scanDocument();
    if (!r) return;
    const date = new Date().toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    await createDoc({ kind: 'pdf', title: `Taranmış belge ${date}`, data: { bytes: r.bytes }, size: r.bytes.byteLength });
  } catch (err) {
    console.error(err);
    toast(err.message || 'Tarama başarısız.', { type: 'error', timeout: 7000 });
  }
}

async function mergePdfFiles() {
  const files = (await pickFiles('.pdf,application/pdf')).filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (!files.length) return;
  if (files.length === 1) { openFileObj(files[0]); return; }
  if (files.some((f) => f.size > MAX_FILE_BYTES)) { toast('Dosyalardan biri çok büyük (en fazla 150 MB).', { type: 'error' }); return; }
  try {
    const ui = await import('./pdf/tools-ui.js');
    const ordered = await ui.orderFilesDialog(files);
    if (!ordered) return;
    const done = busy('PDF dosyaları birleştiriliyor…');
    try {
      const tools = await import('./pdf/tools.js');
      const bufs = [];
      for (const f of ordered) bufs.push(await readArrayBuffer(f));
      const { bytes, rasterized } = await tools.mergePdfs(bufs);
      const buf = tools.toBuffer(bytes);
      done();
      if (rasterized) toast('Şifreli dosyalardaki sayfalar resim olarak eklendi.', { timeout: 6000 });
      await createDoc({ kind: 'pdf', title: baseName(ordered[0].name) + ' (birleştirilmiş)', data: { bytes: buf }, size: buf.byteLength });
    } finally { done(); }
  } catch (err) {
    console.error(err);
    toast('PDF dosyaları birleştirilemedi: ' + (err.message || err), { type: 'error', timeout: 8000 });
  }
}

async function openFile() {
  const f = await pickFile(ACCEPT_ALL);
  if (f) openFileObj(f);
}

async function openFileObj(file) {
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) { toast('Dosya çok büyük (en fazla 150 MB).', { type: 'error' }); return; }
  const legacy = legacyMessage(file.name);
  if (legacy) { toast(legacy, { type: 'error', timeout: 9000 }); return; }
  const kind = kindOf(file.name);
  if (!kind) { toast('Bu dosya türü desteklenmiyor. Word, Excel, PowerPoint, PDF, metin veya CSV dosyası açabilirsiniz.', { type: 'error', timeout: 7000 }); return; }
  const done = busy(`“${file.name}” açılıyor…`);
  try {
    let data;
    if (kind === 'word') data = await (await import('./word/import.js')).importWordData(file);
    else if (kind === 'sheet') data = await (await import('./sheet/xlsx-io.js')).importSheetFile(file);
    else if (kind === 'slides') {
      const buf = await readArrayBuffer(file);
      data = await (await import('./slides/pptx-import.js')).importPptx(buf);
    } else {
      const bytes = await readArrayBuffer(file);
      const head = new TextDecoder('latin1').decode(new Uint8Array(bytes.slice(0, 1024)));
      if (!head.includes('%PDF')) throw new Error('Bu dosya geçerli bir PDF değil.');
      data = { bytes };
    }
    const id = newId();
    await saveDoc({ id, kind, title: baseName(file.name).slice(0, 200), data, size: file.size, folder: currentFolder() });
    done();
    if (cur) await closeEditor();
    go(id);
  } catch (err) {
    done();
    console.error(err);
    toast(err.message || 'Dosya açılamadı.', { type: 'error', timeout: 8000 });
  }
}

// Sürükle-bırak: resimler açık düzenleyiciye eklenir, diğer dosyalar yeni belge olarak açılır.
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; document.body.classList.add('dragging'); } });
window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  dragDepth = 0;
  document.body.classList.remove('dragging');
  if (!hasFiles(e)) return;
  e.preventDefault();
  const files = Array.from(e.dataTransfer.files || []);
  if (!files.length) return;
  const f = files[0];
  if (cur && cur.editor.canAcceptImage && /^image\//.test(f.type)) { cur.editor.insertImageFile(f); return; }
  openFileObj(f);
});

// PWA: işletim sisteminden "Birlikte aç" ile gelen dosyalar
if ('launchQueue' in window && window.launchQueue && typeof window.launchQueue.setConsumer === 'function') {
  window.launchQueue.setConsumer(async (params) => {
    for (const handle of params.files || []) {
      try { openFileObj(await handle.getFile()); } catch (e) { console.warn(e); }
      break;
    }
  });
}

// Windows masaüstü: dosyaya çift tıklayınca açılması
if (isElectron() && window.offiseaDesktop) {
  window.offiseaDesktop.onOpenFile((f) => {
    if (!f || !f.name || !f.data) return;
    openFileObj(new File([f.data], f.name));
  });
  if (window.offiseaDesktop.onCloseRequest) window.offiseaDesktop.onCloseRequest(() => saveNow());
}

// Telefonun geri tuşu. Sıra: açık diyalog → açık menü → slayt gösterisi → düzenleyicinin kendi durumu
// (arama çubuğu, hücre/metin düzenleme) → belgeden ana ekrana → ana ekranda iki kez basınca çıkış.
let lastBackAtHome = 0;
function handleBackButton(exitApp) {
  if (closeTopModal()) return;
  if (closeMenus()) return;
  if (history.state && history.state.slideshow) { history.back(); return; }
  if (cur) {
    try { if (cur.editor.onBackButton && cur.editor.onBackButton()) return; } catch (e) { console.warn(e); }
    goHome();
    return;
  }
  if (DOC_RE.test(location.hash)) { goHome(); return; } // belge henüz açılıyor
  if (homeBack()) return; // klasör / çöp kutusu açıksa önce "Tümü"ne dön
  const now = Date.now();
  if (now - lastBackAtHome < 2000) { exitApp(); return; }
  lastBackAtHome = now;
  toast('Çıkmak için tekrar basın.', { timeout: 2000 });
}
if (import.meta.env.DEV) window.__offiseaBack = () => handleBackButton(() => console.log('exitApp'));

// Android
if (isNative()) {
  import('@capacitor/app').then(({ App }) => {
    App.addListener('backButton', () => handleBackButton(() => App.exitApp()));
    // "Birlikte aç" ile gelen dosyalar (uygulama kapalıyken veya açıkken)
    App.getLaunchUrl().then((r) => { if (r && r.url) openNativeUrl(r.url); }).catch(() => {});
    App.addListener('appUrlOpen', (e) => { if (e && e.url) openNativeUrl(e.url); });
  }).catch(() => {});
}

// Android'den gelen content:// adresi Capacitor'ın yerel sunucusu üzerinden okunur
// (aynı köken; CSP'de dışarıya bağlantı izni gerekmez).
async function openNativeUrl(url) {
  if (!/^(content|file):\/\//i.test(url)) return;
  const done = busy('Dosya okunuyor…');
  try {
    const res = await fetch(window.Capacitor.convertFileSrc(url));
    if (!res.ok) throw new Error('read');
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_FILE_BYTES) throw new Error('big');
    const blob = await res.blob();
    if (blob.size > MAX_FILE_BYTES) throw new Error('big');
    const name = await guessName(url, blob);
    done();
    openFileObj(new File([blob], name, { type: blob.type }));
  } catch (err) {
    done();
    toast(err.message === 'big' ? 'Dosya çok büyük (en fazla 150 MB).' : 'Dosya açılamadı.', { type: 'error' });
  }
}

// content:// adreslerinde dosya adı çoğu zaman yoktur; tür, dosyanın ilk baytlarından anlaşılır.
async function guessName(url, blob) {
  let last = '';
  try { last = decodeURIComponent(url.split(/[?#]/)[0].split('/').pop() || ''); } catch { /* geçersiz kodlama */ }
  last = last.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(-120);
  if (kindOf(last) || legacyMessage(last)) return last;
  const base = (last.replace(/\.[^.]*$/, '') || 'Belge').slice(0, 80);
  const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  if ((await blob.slice(0, 1024).text()).includes('%PDF')) return base + '.pdf';
  if (head[0] === 0x50 && head[1] === 0x4b) {
    try {
      const { default: JSZip } = await import('jszip');
      const zip = await JSZip.loadAsync(blob);
      const names = Object.keys(zip.files);
      if (names.some((n) => n.startsWith('word/'))) return base + '.docx';
      if (names.some((n) => n.startsWith('xl/'))) return base + '.xlsx';
      if (names.some((n) => n.startsWith('ppt/'))) return base + '.pptx';
      const mt = zip.file('mimetype');
      const mime = mt ? (await mt.async('string')).trim() : '';
      if (mime.endsWith('opendocument.text')) return base + '.odt';
      if (mime.endsWith('opendocument.spreadsheet')) return base + '.ods';
      if (mime.endsWith('opendocument.presentation')) return base + '.odp';
    } catch { /* geçerli ZIP değil */ }
    return base + '.zip';
  }
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) return base + '.xls';
  if (String.fromCharCode(...head.slice(0, 5)) === '{\\rtf') return base + '.rtf';
  if (/csv/i.test(blob.type)) return base + '.csv';
  return base + '.txt';
}

// ---- Bağlantılar: uygulama içinde asla gezinme ---------------------------------------------------
document.addEventListener('click', (e) => {
  if (e.defaultPrevented) return;
  const a = e.target.closest && e.target.closest('a[href]');
  if (!a || a.hasAttribute('download')) return;
  e.preventDefault();
  const href = a.getAttribute('href') || '';
  if (href.startsWith('#')) return;
  // Düzenlenebilir metindeki bağlantılar yalnızca Ctrl+tıklama ile açılır
  if (a.closest('[contenteditable="true"]') && !(e.ctrlKey || e.metaKey)) return;
  openExternal(href);
});
document.addEventListener('auxclick', (e) => { if (e.target.closest && e.target.closest('a[href]')) e.preventDefault(); });

// ---- Klavye kısayolları ---------------------------------------------------------------------------
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'o') { e.preventDefault(); openFile(); }
  else if (k === 's' && cur) {
    e.preventDefault();
    if (e.shiftKey) runExport();
    else if (!cur.editor.readOnly) saveNow({ force: true }).then(() => toast('Bu cihaza kaydedildi. Dosya olarak indirmek için Ctrl+Shift+S veya “İndir”.', { type: 'success' }));
  }
});

// ---- PWA kurulum ve service worker ------------------------------------------------------------------
let deferredInstall = null;
const installPrompt = {
  available: () => !!deferredInstall,
  prompt: async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    try { await deferredInstall.userChoice; } catch { /* yok say */ }
    deferredInstall = null;
    if (!cur) route();
  },
};
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  if (!cur && !DOC_RE.test(location.hash)) {
    const hero = document.querySelector('.home-hero');
    if (hero && !hero.querySelector('.install-btn')) {
      hero.append(h('button', { class: 'btn install-btn', type: 'button', onClick: () => installPrompt.prompt() }, icon('download', 18), ' Offisea\'yı bu cihaza yükle'));
    }
  }
});


window.addEventListener('unhandledrejection', (e) => console.error('İşlenmemiş hata:', e.reason));

// ---- Başlat --------------------------------------------------------------------------------------
if (!DOC_RE.test(location.hash) && location.hash !== '#/') history.replaceState(null, '', '#/');
route();
// Güncellemeler: sayfa yenilenmeden önce açık belge kaydedilir.
initUpdates({ onBeforeReload: () => saveNow({ force: true }) });
// Cam görünüm: bu cihazda akıcı mı diye bir kez kısa ölçüm (zorlanırsa otomatik kapanır).
probeGlassLater();
