// Düşük donanımlı cihazlar (ör. Galaxy A52 gibi orta/alt seviye telefonlar) için "hafif mod" ve
// "cam görünüm" kararları.
//  - Hafif mod: ekran çözünürlüğü sınırlı çizim, daha az sayfa bellekte, gölge/animasyon azaltma,
//    kayıt işleri boşta yapılır. Görünüm aynı kalır; yalnızca ağır işler hafifler.
//  - Cam görünüm: menü, üst çubuk, pencere ve bildirimlerde buzlu cam efekti. Yalnızca küçük, sabit
//    yüzeylerde kullanılır (kaydırılan içerikte asla). Zayıf cihazlarda kendiliğinden kapanır.
import { getPref, setPref } from './storage.js';

function safeMatch(q) {
  try { return matchMedia(q).matches; } catch { return false; }
}

function detect() {
  const pref = getPref('perfMode', 'auto'); // 'auto' | 'lite' | 'full'
  if (pref === 'lite') return true;
  if (pref === 'full') return false;
  const nav = navigator;
  const mem = nav.deviceMemory || 8; // Chrome 6 GB'ı 4 olarak bildirir
  const cores = nav.hardwareConcurrency || 8;
  const phone = safeMatch('(pointer: coarse)') && Math.min(screen.width, screen.height) <= 600;
  return mem <= 4 || cores <= 4 || phone;
}

export const LITE = detect();

/** Tuval çizimi için piksel oranı: telefonlarda 2'nin üstü gözle fark edilmez ama 2 kat bellek ister. */
export function canvasDpr() {
  const d = window.devicePixelRatio || 1;
  return LITE ? Math.min(d, 2) : d;
}

/** İşi tarayıcı boştayken yapar (dokunma ve kaydırma takılmasın). */
export function whenIdle(fn, timeout = 1500) {
  if (window.requestIdleCallback) return requestIdleCallback(() => fn(), { timeout });
  return setTimeout(fn, 1);
}

export function applyPerfClass() {
  document.documentElement.classList.toggle('lite', LITE);
}

// ---- Cam görünüm ---------------------------------------------------------------------------------

const GLASS_SUPPORTED = (() => {
  try { return CSS.supports('backdrop-filter', 'blur(2px)') || CSS.supports('-webkit-backdrop-filter', 'blur(2px)'); } catch { return false; }
})();

/** Cihaz özelliklerine göre cam efektinin otomatik açılıp açılmayacağı (ölçüm öncesi tahmin). */
function glassCapable() {
  if (!GLASS_SUPPORTED) return { ok: false, why: 'tarayıcı desteklemiyor' };
  if (safeMatch('(prefers-reduced-transparency: reduce)')) return { ok: false, why: 'sistemde şeffaflık azaltılmış' };
  const nav = navigator;
  if (nav.connection && nav.connection.saveData) return { ok: false, why: 'veri/pil tasarrufu açık' };
  if ((nav.deviceMemory || 8) <= 2) return { ok: false, why: 'cihaz belleği düşük' };
  if ((nav.hardwareConcurrency || 8) <= 4) return { ok: false, why: 'işlemci zayıf' };
  const probe = getPref('glassProbe', null); // önceki akıcılık ölçümünün sonucu
  if (probe && probe.ok === false) return { ok: false, why: 'bu cihazda akıcılık ölçümü düşük çıktı' };
  return { ok: true, why: '' };
}

export function glassPref() { return getPref('glass', 'auto'); } // 'auto' | 'on' | 'off'

/** Otomatik modda bu cihazda cam açık mı ve değilse neden. */
export function glassAutoState() { return glassCapable(); }

export function glassOn() {
  const pref = glassPref();
  if (pref === 'on') return true;
  if (pref === 'off') return false;
  return glassCapable().ok;
}

export function applyGlass() {
  const root = document.documentElement;
  root.classList.toggle('glass', glassOn());
  root.classList.toggle('no-blur', !GLASS_SUPPORTED);
}

export function setGlassPref(v) {
  setPref('glass', v);
  applyGlass();
}

/**
 * Bir kez yapılan kısa akıcılık ölçümü: cam açıkken bulanık bir yüzeyin arkasında küçük bir hareket
 * oynatılır ve kare süreleri ölçülür. Cihaz zorlanıyorsa (kareler yavaşsa) otomatik modda cam kapatılır
 * ve sonuç hatırlanır. Kullanıcı ayardan isterse yine açabilir.
 */
export function probeGlassLater() {
  if (glassPref() !== 'auto' || !glassOn() || getPref('glassProbe', null)) return;
  if (document.visibilityState !== 'visible') return;
  setTimeout(() => whenIdle(runProbe, 4000), 2500);
}

function runProbe() {
  if (document.visibilityState !== 'visible') return; // arka plandayken kareler yavaşlar; sonra denenir
  const box = document.createElement('div');
  box.setAttribute('aria-hidden', 'true');
  box.style.cssText = 'position:fixed;right:0;bottom:0;width:180px;height:180px;overflow:hidden;pointer-events:none;z-index:2147483000;opacity:0.02;contain:strict';
  const mover = document.createElement('div');
  mover.style.cssText = 'position:absolute;inset:0;background:linear-gradient(90deg,#19c3c9,#0a7bbf,#123a8c);will-change:transform';
  const pane = document.createElement('div');
  pane.style.cssText = 'position:absolute;inset:20px;-webkit-backdrop-filter:blur(18px) saturate(1.5);backdrop-filter:blur(18px) saturate(1.5);background:rgba(255,255,255,.4)';
  box.append(mover, pane);
  document.body.append(box);
  const times = [];
  let last = 0;
  let n = 0;
  const step = (t) => {
    if (last) times.push(t - last);
    last = t;
    mover.style.transform = `translateX(${(n % 40) - 20}px)`;
    if (++n < 75 && document.visibilityState === 'visible') requestAnimationFrame(step);
    else finish();
  };
  const finish = () => {
    box.remove();
    if (times.length < 60) return; // ölçüm yarım kaldı; bir sonraki açılışta tekrar denenir
    times.sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length / 2)];
    const p90 = times[Math.floor(times.length * 0.9)];
    // 60 Hz'de bir kare ~16,7 ms. Ortanca 22 ms'yi ya da yavaş kareler 40 ms'yi aşıyorsa cihaz zorlanıyor.
    const ok = p50 <= 22 && p90 <= 40;
    setPref('glassProbe', { ok, p50: Math.round(p50 * 10) / 10, p90: Math.round(p90 * 10) / 10, at: Date.now() });
    if (!ok) applyGlass();
  };
  requestAnimationFrame(step);
}

/** Ölçümü sıfırlar (kullanıcı "Otomatik"i yeniden seçtiğinde cihaz yeniden değerlendirilir). */
export function resetGlassProbe() { setPref('glassProbe', null); }
