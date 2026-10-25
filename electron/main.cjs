// Offisea Windows masaüstü ana süreci (Electron).
// Güvenlik: Electron güvenlik kontrol listesinin tamamı uygulanır.
//  - Tüm pencereler sandbox + contextIsolation ile, Node.js erişimi olmadan çalışır.
//  - Uygulama file:// yerine özel, yalıtılmış app:// protokolünden yüklenir (yol geçişi engellenir).
//  - Uygulama dışına gezinme, yeni pencere, <webview> ve gereksiz izinler engellenir.
//  - Dış bağlantılar yalnızca http/https/mailto ise varsayılan tarayıcıda açılır.
//  - Geliştirici araçları ve uzaktan hata ayıklama paket sürümünde kapalıdır (ayrıca Electron Fuses).
'use strict';

const { app, BrowserWindow, protocol, session, shell, ipcMain, Menu, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { createUpdater } = require('./updater.cjs');

const DIST = path.join(__dirname, '..', 'dist');
const SCHEME = 'app';
const HOST = 'offisea';
const ORIGIN = `${SCHEME}://${HOST}`;
const MAX_FILE_BYTES = 150 * 1024 * 1024;
const OPENABLE = /\.(docx|docm|dotx|dotm|odt|rtf|txt|md|html?|xlsx|xlsm|xltx|xltm|xls|xlsb|ods|fods|csv|tsv|pptx|pptm|ppsx|ppsm|potx|potm|pdf)$/i;
const isDev = !app.isPackaged && process.env.OFFISEA_DEV === '1';

const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "font-src 'self' data: blob:", "media-src 'self' data: blob:",
  "connect-src 'self' data: blob:", "worker-src 'self' blob:", "frame-src 'none'", "object-src 'none'",
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');

// Tek örnek: ikinci kez açılan Offisea, dosyayı mevcut pencereye iletir.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.enableSandbox();
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
]);

let win = null;
let updater = null;
// Sunulan arayüz klasörü: kurulumla gelen dist ya da doğrulanmış güncelleme paketi.
const appRoot = () => (updater ? updater.root() : DIST);
let rendererReady = false;
const pendingFiles = [];

function mimeOf(p) {
  const ext = path.extname(p).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.wasm': 'application/wasm',
    '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf', '.icc': 'application/vnd.iccprofile',
  })[ext] || 'application/octet-stream';
}

function registerAppProtocol(ses) {
  ses.protocol.handle(SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      if (url.host !== HOST) return new Response('Bulunamadı', { status: 404 });
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/' || rel === '') rel = '/index.html';
      // Yol geçişi koruması: çözümlenen yol dist klasörünün dışına çıkamaz.
      const root = appRoot();
      const target = path.normalize(path.join(root, rel));
      if (target !== root && !target.startsWith(root + path.sep)) return new Response('Yasak', { status: 403 });
      let body;
      try {
        if (!(await fs.promises.stat(target)).isFile()) return new Response('Bulunamadı', { status: 404 });
        // Dosya doğrudan okunur (net.fetch file:// kullanılmaz; ağ filtresi zaten tüm file:// isteklerini engeller).
        body = await fs.promises.readFile(target);
      } catch {
        return new Response('Bulunamadı', { status: 404 });
      }
      const headers = new Headers({
        'Content-Type': mimeOf(target),
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Referrer-Policy': 'no-referrer',
      });
      if (target.endsWith('.html')) headers.set('Content-Security-Policy', CSP);
      return new Response(body, { status: 200, headers });
    } catch {
      return new Response('Hata', { status: 500 });
    }
  });
}

function isSafeExternal(url) {
  try {
    const u = new URL(url);
    return ['https:', 'http:', 'mailto:'].includes(u.protocol);
  } catch {
    return false;
  }
}

function hardenSession(ses) {
  // İzinler: yalnızca tam ekran (slayt gösterisi), panoya yazma ve dosya kaydetme penceresi.
  const allowed = new Set(['fullscreen', 'clipboard-sanitized-write', 'fileSystem']);
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const fromApp = (details && details.requestingUrl ? details.requestingUrl : wc.getURL()).startsWith(ORIGIN + '/');
    cb(fromApp && allowed.has(permission));
  });
  ses.setPermissionCheckHandler((wc, permission, origin) => origin === ORIGIN && allowed.has(permission));
  ses.setDevicePermissionHandler(() => false);
  // Uygulama hiçbir uzak sunucuya bağlanmaz (CSP'ye ek ikinci savunma hattı).
  ses.webRequest.onBeforeRequest((details, cb) => {
    const u = details.url;
    const ok = u.startsWith(ORIGIN + '/') || u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('devtools:') || u.startsWith('chrome-extension:');
    cb({ cancel: !ok });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 380,
    minHeight: 480,
    show: false,
    backgroundColor: '#eef4f7',
    title: 'Offisea',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      enableBlinkFeatures: '',
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: true,
      devTools: isDev,
      safeDialogs: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-start-loading', () => { rendererReady = false; });
  win.webContents.on('did-finish-load', () => {
    rendererReady = true;
    while (pendingFiles.length) sendFile(pendingFiles.shift());
  });
  // Kapanmadan önce açık belge kaydedilir (en fazla 1,5 sn beklenir).
  let allowClose = false;
  win.on('close', (e) => {
    if (allowClose || !rendererReady) return;
    e.preventDefault();
    const w = win;
    const finish = () => { if (allowClose || w.isDestroyed()) return; allowClose = true; w.close(); };
    ipcMain.once('close-ok', finish);
    setTimeout(finish, 1500);
    w.webContents.send('close-request');
  });
  win.on('closed', () => { win = null; });
  win.loadURL(`${ORIGIN}/index.html#/`);
}


// ---- Komut satırından / dosya ilişkilendirmesinden gelen dosyalar ----------------------------------
function filesFromArgv(argv) {
  return argv.slice(app.isPackaged ? 1 : 2).filter((a) => a && !a.startsWith('-') && OPENABLE.test(a));
}

async function openPath(p) {
  try {
    const abs = path.resolve(p);
    const st = await fs.promises.stat(abs);
    if (!st.isFile()) return;
    if (st.size > MAX_FILE_BYTES) {
      dialog.showMessageBox({ type: 'warning', message: 'Dosya çok büyük (en fazla 150 MB).', title: 'Offisea' });
      return;
    }
    const buf = await fs.promises.readFile(abs);
    const file = { name: path.basename(abs), data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    if (win && rendererReady) sendFile(file);
    else pendingFiles.push(file);
  } catch {
    dialog.showMessageBox({ type: 'error', message: 'Dosya açılamadı.', title: 'Offisea' });
  }
}

function sendFile(file) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('open-file', file);
  if (win.isMinimized()) win.restore();
  win.focus();
}

app.on('second-instance', (_e, argv) => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  for (const f of filesFromArgv(argv)) openPath(f);
});

// ---- Tüm web içerikleri için genel kısıtlamalar ------------------------------------------------------
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (ev) => ev.preventDefault());
  contents.on('will-navigate', (ev, url) => {
    if (!url.startsWith(ORIGIN + '/')) {
      ev.preventDefault();
      if (isSafeExternal(url)) shell.openExternal(url);
    }
  });
  contents.on('will-redirect', (ev, url) => { if (!url.startsWith(ORIGIN + '/')) ev.preventDefault(); });
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternal(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  if (!isDev) {
    contents.on('devtools-opened', () => contents.closeDevTools());
    contents.on('before-input-event', (ev, input) => {
      const k = (input.key || '').toLowerCase();
      if (k === 'f12' || ((input.control || input.meta) && input.shift && (k === 'i' || k === 'j' || k === 'c'))) ev.preventDefault();
    });
  }
});

// ---- Dosyasız güncelleme ------------------------------------------------------------------------------
const fromApp = (e) => !!win && e.sender === win.webContents && e.senderFrame && e.senderFrame.url.startsWith(ORIGIN + '/');
ipcMain.handle('update:info', (e) => (fromApp(e) && updater ? updater.info() : null));
ipcMain.handle('update:check', async (e) => (fromApp(e) && updater ? updater.check() : { status: 'disabled' }));
ipcMain.handle('update:confirm', (e, build) => { if (fromApp(e) && updater && Number.isSafeInteger(build)) updater.confirm(build); });
ipcMain.handle('update:apply', (e) => {
  if (!fromApp(e) || !updater || !updater.applyNow()) return false;
  setTimeout(() => { if (win && !win.isDestroyed()) win.webContents.reloadIgnoringCache(); }, 50);
  return true;
});
ipcMain.handle('update:reset', (e) => {
  if (!fromApp(e) || !updater) return false;
  updater.reset();
  setTimeout(() => { if (win && !win.isDestroyed()) win.webContents.reloadIgnoringCache(); }, 50);
  return true;
});

ipcMain.on('renderer-ready', (e) => {
  if (win && e.sender === win.webContents) {
    rendererReady = true;
    while (pendingFiles.length) sendFile(pendingFiles.shift());
  }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  const ses = session.defaultSession;
  try {
    updater = createUpdater({ dist: DIST, userData: app.getPath('userData') });
    updater.prepare();
  } catch (err) {
    updater = null; // güncelleme bilgisi okunamazsa kurulumla gelen sürüm kullanılır
  }
  hardenSession(ses);
  registerAppProtocol(ses);
  createWindow();
  for (const f of filesFromArgv(process.argv)) openPath(f);
});

app.on('window-all-closed', () => app.quit());
