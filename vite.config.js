import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// İçerik Güvenlik Politikası (CSP): uygulama yalnızca kendi dosyalarını yükleyebilir,
// dışarıya bağlanamaz, uzak resim/betik çekemez. Belgelere gömülü kötü niyetli içerik
// bu sayede hiçbir şeyi dışarı sızdıramaz. (Güncellemeleri sayfa değil, uygulamanın
// yerel kodu ya da service worker indirir; bu yüzden CSP'de dış adres izni gerekmez.)
export function csp({ dev = false } = {}) {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    `connect-src 'self' data: blob:${dev ? ' ws://localhost:* ws://127.0.0.1:*' : ''}`,
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "manifest-src 'self'",
  ].join('; ');
}

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
function readUpdateConfig() {
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(new URL('./update.config.json', import.meta.url), 'utf8')); } catch { /* yok */ }
  let url = String(process.env.OFFISEA_UPDATE_URL || cfg.url || '').trim();
  if (url && !url.endsWith('/')) url += '/';
  if (url && !/^https:\/\//i.test(url)) throw new Error('update.config.json: "url" https:// ile başlamalı.');
  return { url, publicKey: String(cfg.publicKey || ''), download: String(cfg.download || '') };
}
const UPDATE = readUpdateConfig();
// Derleme numarası: güncellemelerin sırasını belirler (büyük olan yenidir). CI'da tüm işler aynı
// numarayı kullansın diye OFFISEA_BUILD ile verilir (ör. commit zamanı); yoksa şimdiki zaman.
const BUILD = Number(process.env.OFFISEA_BUILD) || Math.floor(Date.now() / 1000);
// Bu web paketinin çalışması için gereken en düşük yerel kabuk seviyesi (Android/Windows).
// Yerel tarafta yeni bir özellik gerektiren bir değişiklik yapıldığında artırılır.
const MIN_SHELL = 1;

// Paket listesine girmeyen dosyalar: sunucu ayarı, sürüm bilgisinin kendisi ve imzası.
const NOT_IN_BUNDLE = new Set(['_headers', 'version.json', 'update.json', 'sw.js']);
// Service worker'ın kurulumda hemen indirdiği dosyalar; pdf.js yardımcıları (karakter haritaları,
// yazı tipleri) yalnızca gerektiğinde indirilir ve sonra önbellekte tutulur.
const LAZY = /^pdfjs\//;

function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function swSource(files) {
  const precache = Object.keys(files).filter((p) => !LAZY.test(p));
  return `/* Offisea service worker - otomatik üretildi. Sürüm ${pkg.version} (${BUILD}) */
'use strict';
const CACHE = 'offisea-${BUILD}';
const FILES = ${JSON.stringify(files)};
const PRECACHE = ${JSON.stringify(precache)};
const HASH = 'x-offisea-sha256';
const base = new URL('./', self.location).href;
const rel = (url) => url.startsWith(base) ? decodeURIComponent(url.slice(base.length).split(/[?#]/)[0]) : null;

function tag(res, hash) {
  const headers = new Headers(res.headers);
  headers.set(HASH, hash);
  return res.blob().then((b) => new Response(b, { status: res.status, statusText: res.statusText, headers }));
}

// Kurulum: değişmeyen dosyalar eski önbellekten kopyalanır, yalnızca yeni/değişen dosyalar indirilir.
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const old = (await caches.keys()).filter((k) => k.startsWith('offisea-') && k !== CACHE);
    const reused = new Set();
    for (const name of old) {
      const c = await caches.open(name);
      for (const req of await c.keys()) {
        const p = rel(req.url);
        if (p == null || reused.has(p) || !FILES[p]) continue;
        const res = await c.match(req);
        if (res && res.headers.get(HASH) === FILES[p]) { await cache.put(base + p, res); reused.add(p); }
      }
    }
    await Promise.all(PRECACHE.filter((p) => !reused.has(p)).map(async (p) => {
      // ?h=: içerik özetine bağlı adres; CDN önbelleğinde eski dosya kalmışsa bile yenisi gelir.
      const res = await fetch(base + p + '?h=' + FILES[p].slice(0, 16), { cache: 'no-cache' });
      if (!res.ok) throw new Error('İndirilemedi: ' + p);
      await cache.put(base + p, await tag(res, FILES[p]));
    }));
    if (!(await cache.match(base + 'index.html'))) throw new Error('Eksik index.html');
  })());
});

// Yeni sürüm, kullanıcı "Yenile" deyince ya da tüm pencereler kapanınca etkinleşir;
// böylece açık sayfa eski dosyalarla çalışırken önbelleği silinmez.
self.addEventListener('message', (e) => { if (e.data === 'skip-waiting') self.skipWaiting(); });

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('offisea-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(caches.open(CACHE).then((c) => c.match(base + 'index.html')).then((hit) => hit || fetch(req)));
    return;
  }
  const p = rel(url.href);
  if (p == null || !FILES[p]) return;
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(base + p);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') { const t = await tag(res.clone(), FILES[p]); await c.put(base + p, t); }
    return res;
  }));
});
`;
}

// Derleme bitince tüm dosyaların SHA-256 özetleri çıkarılır:
//  - version.json: sürüm, derleme numarası ve dosya listesi (Android/Windows güncellemeleri için;
//    scripts/sign-update.mjs bunu imzalayıp update.json üretir).
//  - sw.js: web sürümünde yalnızca değişen dosyaları indiren service worker.
function bundleManifestPlugin() {
  let outDir = 'dist';
  return {
    name: 'offisea-bundle-manifest',
    apply: 'build',
    configResolved(cfg) { outDir = cfg.build.outDir; },
    closeBundle() {
      const files = {};
      for (const abs of listFiles(outDir).sort()) {
        const p = relative(outDir, abs).split(sep).join('/');
        if (NOT_IN_BUNDLE.has(p)) continue;
        files[p] = createHash('sha256').update(readFileSync(abs)).digest('hex');
      }
      if (!files['index.html']) throw new Error('index.html bulunamadı');
      writeFileSync(join(outDir, 'sw.js'), swSource(files));
      const info = {
        app: 'offisea',
        version: pkg.version,
        build: BUILD,
        minShell: MIN_SHELL,
        date: new Date().toISOString(),
        updateUrl: UPDATE.url,
        download: UPDATE.download,
        publicKey: UPDATE.publicKey,
        files,
      };
      writeFileSync(join(outDir, 'version.json'), JSON.stringify(info));
    },
  };
}

export default defineConfig(({ command }) => {
  const dev = command === 'serve';
  return {
    base: './',
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __APP_BUILD__: JSON.stringify(BUILD),
      __UPDATES_ENABLED__: JSON.stringify(!!UPDATE.url),
    },
    plugins: [
      {
        name: 'offisea-csp',
        transformIndexHtml(html) {
          return html.replace('<!-- %CSP% -->', `<meta http-equiv="Content-Security-Policy" content="${csp({ dev })}" />`);
        },
      },
      bundleManifestPlugin(),
    ],
    server: {
      host: '127.0.0.1', // geliştirme sunucusunu ağa açma (Vite dev server açıklarına karşı)
      strictPort: false,
    },
    preview: { host: '127.0.0.1' },
    build: {
      target: 'es2022',
      sourcemap: false,
      chunkSizeWarningLimit: 4000,
      outDir: 'dist',
      emptyOutDir: true,
      rolldownOptions: {
        output: {
          // Büyük kütüphaneler kendi parçalarında: uygulama kodu değişince adları/özetleri değişmez,
          // böylece güncellemelerde yalnızca küçük uygulama dosyaları indirilir.
          // Ayrıca açılışta yalnızca küçük uygulama kabuğu yüklenir; kütüphaneler ilgili belge
          // açılınca gelir (düşük donanımlı telefonlarda hızlı açılış için).
          codeSplitting: {
            groups: [
              // Vite'ın yükleme yardımcısı ve ortak çalışma zamanı: bir kütüphane parçasına
              // düşerse açılışta o kütüphane de indirilir; bu yüzden ayrı tutulur.
              { name: 'runtime', test: /preload-helper|commonjsHelpers|^\0rolldown|rolldown[:/]runtime/, priority: 100 },
              { name: 'lib-zip', test: /node_modules[\\/]jszip[\\/]/, priority: 50 },
              { name: 'lib-purify', test: /node_modules[\\/]dompurify[\\/]/, priority: 50 },
              { name: 'lib-xlsx', test: /node_modules[\\/]xlsx[\\/]/, priority: 10 },
              { name: 'lib-docx', test: /node_modules[\\/]docx[\\/]/, priority: 10 },
              { name: 'lib-pptx', test: /node_modules[\\/]pptxgenjs[\\/]/, priority: 10 },
              { name: 'lib-pdf', test: /node_modules[\\/]pdfjs-dist[\\/]/, priority: 10 },
            ],
          },
        },
      },
    },
  };
});
