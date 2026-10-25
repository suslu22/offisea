// İki parmakla yakınlaştırma (dokunmatik) ve Ctrl + fare tekerleği (masaüstü).
// Parmaklar hareket ederken içerik yalnızca CSS transform ile büyütülüp küçültülür (eski telefonlarda
// bile akıcı, yeniden çizim yok); parmaklar kalkınca asıl yakınlaştırma bir kez uygulanır.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * @param {HTMLElement} scroller  Kaydırılan alan (dokunma olayları burada dinlenir).
 * @param {object} o
 * @param {() => HTMLElement|null} o.content  Önizlemede ölçeklenecek öğe (kendi transform'u olmamalı).
 * @param {() => number} o.getZoom
 * @param {(z: number, fx: number, fy: number) => void} o.setZoom  fx/fy: odak noktası (scroller'a göre px).
 * @param {number} o.min
 * @param {number} o.max
 * @param {boolean} [o.anchor=true]  Yakınlaştırmadan sonra odak noktası parmakların altında kalsın diye kaydır.
 * @param {boolean} [o.wheel=true]   Ctrl + tekerlek ile de yakınlaştır.
 * @param {() => void} [o.onStart]   Hareket başlarken (ör. süren sürüklemeyi iptal etmek için).
 */
export function pinchZoom(scroller, { content, getZoom, setZoom, min, max, anchor = true, wheel = true, onStart }) {
  let g = null;
  let raf = 0;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY) || 1;

  function apply(z, fx, fy, z0 = getZoom()) {
    z = clamp(z, min, max);
    const sx = scroller.scrollLeft + fx, sy = scroller.scrollTop + fy;
    setZoom(z, fx, fy);
    if (anchor) {
      const a = getZoom() / z0;
      scroller.scrollLeft = sx * a - fx;
      scroller.scrollTop = sy * a - fy;
    }
  }

  function begin(t) {
    const r = scroller.getBoundingClientRect();
    const cx = (t[0].clientX + t[1].clientX) / 2, cy = (t[0].clientY + t[1].clientY) / 2;
    const el = content();
    const er = el ? el.getBoundingClientRect() : null;
    g = { d0: dist(t), z0: getZoom(), ratio: 1, fx: cx - r.left, fy: cy - r.top, el };
    if (el) {
      g.prev = [el.style.transform, el.style.transformOrigin];
      el.style.transformOrigin = `${cx - er.left}px ${cy - er.top}px`;
      el.style.willChange = 'transform';
    }
    if (onStart) onStart();
  }

  function paint() {
    raf = 0;
    if (g && g.el) g.el.style.transform = `scale(${g.ratio})`;
  }

  function finish() {
    const s = g;
    g = null;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (s.el) {
      s.el.style.transform = s.prev[0];
      s.el.style.transformOrigin = s.prev[1];
      s.el.style.willChange = '';
    }
    if (Math.abs(s.ratio - 1) > 0.02) apply(s.z0 * s.ratio, s.fx, s.fy, s.z0);
  }

  scroller.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2 && !g) {
      begin(e.touches);
      if (e.cancelable) e.preventDefault();
    }
  }, { passive: false });

  scroller.addEventListener('touchmove', (e) => {
    if (!g || e.touches.length < 2) return;
    if (e.cancelable) e.preventDefault();
    g.ratio = clamp(dist(e.touches) / g.d0, min / g.z0, max / g.z0);
    if (!raf) raf = requestAnimationFrame(paint);
  }, { passive: false });

  const end = (e) => { if (g && e.touches.length < 2) finish(); };
  scroller.addEventListener('touchend', end);
  scroller.addEventListener('touchcancel', end);

  if (wheel) {
    scroller.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return; // dokunmatik yüzeyde iki parmakla sıkıştırma da ctrlKey ile gelir
      e.preventDefault();
      const r = scroller.getBoundingClientRect();
      const f = Math.exp(-clamp(e.deltaY, -50, 50) * 0.004);
      apply(getZoom() * f, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
  }

  return { active: () => !!g };
}
