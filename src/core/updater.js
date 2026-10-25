// Dosyasız güncelleme istemcisi. Kullanıcı yeni APK/EXE indirmez:
//  - Web: service worker yalnızca değişen dosyaları indirir; "Yenile" ile ya da sonraki açılışta etkinleşir.
//  - Android / Windows: uygulamanın yerel kodu imzalı güncelleme listesini web sunucusundan okur,
//    yalnızca değişen dosyaları indirip doğrular; yeni sürüm sonraki açılışta (veya hemen) yüklenir.
import { toast } from './ui.js';
import { getPref, setPref } from './storage.js';
import { isNative, isElectron, openExternal } from './platform.js';

/* global __APP_VERSION__, __APP_BUILD__ */
export const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';
export const APP_BUILD = typeof __APP_BUILD__ !== 'undefined' ? __APP_BUILD__ : 0;

const CHECK_EVERY = 6 * 60 * 60 * 1000; // en fazla 6 saatte bir otomatik denetim
let beforeReload = async () => {};
let backend = null;
let swReg = null;
let readyShown = false;

async function nativeBackend() {
  const { registerPlugin } = await import('@capacitor/core');
  const plugin = registerPlugin('OffiseaUpdater');
  return {
    info: () => plugin.info(),
    check: (force) => plugin.check({ force: !!force }),
    confirm: () => plugin.confirm({ build: APP_BUILD }),
    applyNow: () => plugin.applyNow(),
    reset: () => plugin.reset(),
  };
}

function desktopBackend() {
  const u = window.offiseaDesktop && window.offiseaDesktop.update;
  if (!u) return null;
  return {
    info: () => u.info(),
    check: async () => {
      const r = await u.check();
      if (r && r.status === 'error') throw new Error(r.message || 'Güncelleme denetlenemedi.');
      return r;
    },
    confirm: () => u.confirm(APP_BUILD),
    applyNow: () => u.applyNow(),
    reset: () => u.reset(),
  };
}

function showReady(version) {
  if (readyShown) return;
  readyShown = true;
  toast(`Offisea'nın yeni sürümü${version ? ` (${version})` : ''} indirildi. Bir sonraki açılışta etkin olur.`, {
    type: 'success', timeout: 0,
    action: { label: 'Şimdi yeniden başlat', onClick: () => applyNow() },
  });
}

async function applyNow() {
  try { await beforeReload(); } catch { /* yine de devam */ }
  if (swReg && swReg.waiting) { swReg.waiting.postMessage('skip-waiting'); return; }
  if (backend) {
    try { await backend.applyNow(); } catch { toast('Güncelleme uygulanamadı; bir sonraki açılışta denenecek.', { type: 'error' }); }
  }
}

function handleResult(r, manual) {
  const st = r && r.status;
  if (st === 'ready') showReady(r.version);
  else if (st === 'shell') {
    const key = 'shellNotice:' + r.build;
    if (manual || !getPref(key, false)) {
      setPref(key, true);
      toast(`Offisea ${r.version} için uygulamanın yeni sürümünü bir kez yüklemeniz gerekiyor.`, {
        timeout: 0,
        action: r.download ? { label: 'İndir', onClick: () => openExternal(r.download) } : null,
      });
    }
  } else if (manual) {
    if (st === 'none') toast(`Offisea güncel (sürüm ${APP_VERSION}).`, { type: 'success' });
    else if (st === 'disabled') toast('Güncelleme sunucusu henüz ayarlanmamış.', { type: 'info' });
    else if (st === 'busy') toast('Güncelleme zaten denetleniyor…');
    else if (st === 'metered') toast('Mobil veride otomatik güncelleme yapılmaz.');
  }
}

/** Güncellemeleri denetler. manual=true: kullanıcı istedi (sonuç her durumda gösterilir). */
export async function checkForUpdates(manual = false) {
  if (!manual && Date.now() - getPref('lastUpdateCheck', 0) < CHECK_EVERY) return;
  if (!navigator.onLine) { if (manual) toast('İnternet bağlantısı yok.', { type: 'error' }); return; }
  if (swReg) {
    try {
      setPref('lastUpdateCheck', Date.now());
      await swReg.update();
      if (swReg.waiting && navigator.serviceWorker.controller) showReady('');
      else if (swReg.installing) { if (manual) toast('Yeni sürüm indiriliyor…'); }
      else if (manual) toast(`Offisea güncel (sürüm ${APP_VERSION}).`, { type: 'success' });
    } catch {
      if (manual) toast('Güncelleme denetlenemedi.', { type: 'error' });
    }
    return;
  }
  if (!backend) { if (manual) toast('Bu sürümde güncelleme desteklenmiyor.'); return; }
  try {
    if (manual) toast('Güncellemeler denetleniyor…', { timeout: 2000 });
    const r = await backend.check(manual);
    if (r && r.status !== 'metered' && r.status !== 'busy') setPref('lastUpdateCheck', Date.now());
    handleResult(r, manual);
  } catch (err) {
    if (manual) toast((err && err.message) || 'Güncelleme denetlenemedi.', { type: 'error' });
  }
}

export async function updateInfo() {
  const base = { version: APP_VERSION, build: APP_BUILD };
  if (!backend) return base;
  try { return { ...base, ...(await backend.info()) }; } catch { return base; }
}

/** Sorun olursa uygulamayla gelen sürüme döner (yalnızca Android/Windows). */
export async function resetToBuiltin() {
  if (!backend) return;
  try { await beforeReload(); } catch { /* yok say */ }
  await backend.reset();
}

export const canReset = () => !!backend;

function initServiceWorker() {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return;
  if (!(location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) return;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).then((reg) => {
      swReg = reg;
      const watch = (w) => {
        if (!w) return;
        w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) showReady('');
        });
      };
      if (reg.waiting && navigator.serviceWorker.controller) showReady('');
      watch(reg.installing);
      reg.addEventListener('updatefound', () => watch(reg.installing));
      setTimeout(() => checkForUpdates(false), 15000);
    }).catch((err) => console.warn('Service worker kaydedilemedi', err));
  });
}

/**
 * Uygulama açılışında bir kez çağrılır.
 * onBeforeReload: sayfa yeniden yüklenmeden önce açık belgeyi kaydeder.
 */
export async function initUpdates({ onBeforeReload } = {}) {
  if (onBeforeReload) beforeReload = onBeforeReload;
  if (!isNative() && !isElectron()) { initServiceWorker(); return; }
  try {
    backend = isNative() ? await nativeBackend() : desktopBackend();
  } catch {
    backend = null;
  }
  if (!backend) return;
  // Arayüz sorunsuz açıldı: yeni sürüm "deneme" modundan çıkar (aksi halde otomatik geri alınır).
  setTimeout(() => { backend.confirm().catch(() => {}); }, 1500);
  // Açılışı yavaşlatmamak için ilk denetim gecikmeli ve boşta yapılır.
  const later = () => checkForUpdates(false);
  setTimeout(() => (window.requestIdleCallback ? requestIdleCallback(later, { timeout: 10000 }) : later()), 12000);
  setInterval(later, CHECK_EVERY);
  if (isNative()) {
    try {
      const { App } = await import('@capacitor/app');
      App.addListener('resume', later);
    } catch { /* yok say */ }
  }
}
