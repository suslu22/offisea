// Sunu renk temaları ve slayt geçişleri.

export const THEMES = [
  { id: 'office', name: 'Beyaz', bg: '#ffffff', title: '#1f1f1f', text: '#262626', muted: '#595959', accent: '#4472c4', font: 'Calibri' },
  { id: 'ocean', name: 'Okyanus', bg: '#eaf6fb', title: '#0b4f6c', text: '#1d3b4a', muted: '#3f6a7d', accent: '#1597bb', font: 'Calibri' },
  { id: 'night', name: 'Gece', bg: '#14213d', title: '#ffffff', text: '#dfe6f3', muted: '#a9b6cc', accent: '#fca311', font: 'Arial' },
  { id: 'forest', name: 'Orman', bg: '#f3f7f0', title: '#2d5a27', text: '#2f3a2c', muted: '#5d6f57', accent: '#6a994e', font: 'Georgia' },
  { id: 'sunset', name: 'Gün batımı', bg: '#fff5ec', title: '#c2410c', text: '#3b2a20', muted: '#8a5a3c', accent: '#f97316', font: 'Calibri' },
  { id: 'violet', name: 'Mor', bg: '#2a1b3d', title: '#f4d35e', text: '#ece4f5', muted: '#bba9d1', accent: '#a26df2', font: 'Calibri' },
  { id: 'classic', name: 'Klasik', bg: '#fbf8f1', title: '#1f3864', text: '#222222', muted: '#555555', accent: '#8b1e3f', font: 'Garamond' },
  { id: 'mono', name: 'Siyah', bg: '#111111', title: '#ffffff', text: '#e6e6e6', muted: '#9e9e9e', accent: '#e63946', font: 'Arial' },
];

export const themeById = (id) => THEMES.find((t) => t.id === id) || null;

const DEFAULT_COLORS = new Set(['', '#000', '#000000', '#1f1f1f', '#262626', '#595959', '#ffffff', '#fff']);
const DEFAULT_ACCENTS = new Set(['', '#4472c4']);

/**
 * Temayı slayta uygular (yeni slayt nesnesi döndürür). Kullanıcının kendi seçtiği renkler
 * mümkün olduğunca korunur: yalnızca varsayılan ya da önceki temadan gelen renkler değişir.
 */
export function applyThemeToSlide(slide, theme, prev = null) {
  const lc = (c) => String(c || '').toLowerCase();
  const fromTheme = (c) => DEFAULT_COLORS.has(lc(c)) || (prev && [prev.title, prev.text, prev.muted].includes(lc(c)));
  const fromAccent = (c) => DEFAULT_ACCENTS.has(lc(c)) || (prev && lc(c) === prev.accent);
  const fromFont = (f) => !f || (prev && f === prev.font) || f === 'Calibri';
  const items = slide.items.map((it) => {
    if (it.type === 'text') {
      const role = it.ph === 'title' ? 'title' : it.ph === 'subtitle' ? 'muted' : 'text';
      const n = { ...it };
      if (it.ph || fromTheme(it.color)) n.color = theme[role];
      if (it.ph || fromFont(it.font)) n.font = theme.font;
      return n;
    }
    if (it.type === 'shape') {
      const n = { ...it };
      if (it.shape === 'line') { if (fromAccent(it.stroke)) n.stroke = theme.accent; } else if (fromAccent(it.fill)) n.fill = theme.accent;
      return n;
    }
    return it;
  });
  const out = { ...slide, bg: theme.bg, items };
  delete out.bgImg;
  return out;
}

export const TRANSITIONS = [
  { id: 'none', label: 'Yok' },
  { id: 'fade', label: 'Solma' },
  { id: 'push', label: 'İtme' },
  { id: 'wipe', label: 'Silme' },
  { id: 'cover', label: 'Örtme' },
  { id: 'zoom', label: 'Yakınlaşma' },
];
export const TRANSITION_IDS = new Set(TRANSITIONS.map((t) => t.id));

/**
 * Slayt gösterisinde geçiş animasyonu (Web Animations API). `back` true ise yön ters çevrilir.
 * Hareket azaltma tercihi açıksa yalnızca kısa bir solma yapılır.
 */
export function animateTransition(incoming, outgoing, type, { back = false, duration = 550 } = {}) {
  if (!type || type === 'none' || !incoming.animate) { if (outgoing) outgoing.remove(); return; }
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) type = 'fade';
  const dir = back ? -1 : 1;
  const opts = { duration, easing: 'cubic-bezier(.22,.61,.36,1)', fill: 'both' };
  let inK, outK = null;
  switch (type) {
    case 'push':
      inK = [{ transform: `translateX(${100 * dir}%)` }, { transform: 'translateX(0)' }];
      outK = [{ transform: 'translateX(0)' }, { transform: `translateX(${-100 * dir}%)` }];
      break;
    case 'wipe':
      inK = [{ clipPath: back ? 'inset(0 0 0 100%)' : 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }];
      break;
    case 'cover':
      inK = [{ transform: `translateY(${100 * dir}%)` }, { transform: 'translateY(0)' }];
      break;
    case 'zoom':
      inK = [{ transform: 'scale(0.6)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }];
      outK = [{ opacity: 1 }, { opacity: 0 }];
      break;
    default:
      inK = [{ opacity: 0 }, { opacity: 1 }];
  }
  const a = incoming.animate(inK, opts);
  if (outgoing && outK) outgoing.animate(outK, opts);
  let ended = false;
  const done = () => {
    if (ended) return;
    ended = true;
    if (outgoing) outgoing.remove();
    incoming.getAnimations().forEach((x) => x.cancel());
  };
  a.onfinish = done;
  a.oncancel = () => { if (outgoing) outgoing.remove(); };
  // Sekme arka planda kalıp animasyon ilerlemezse de geçiş tamamlanır
  setTimeout(done, duration + 200);
}
