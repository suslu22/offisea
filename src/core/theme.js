// Açık / koyu tema. Tercih: 'auto' (sistemi izler) | 'light' | 'dark'.
import { getPref, setPref } from './storage.js';

const media = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set();

export function themePref() { return getPref('theme', 'auto'); }

export function applyTheme() {
  const pref = themePref();
  const dark = pref === 'dark' || (pref === 'auto' && media.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0d1822' : '#f2f7fa');
  for (const fn of listeners) fn(dark);
}

export function setThemePref(v) {
  setPref('theme', v);
  applyTheme();
}

export function toggleTheme() {
  setThemePref(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
}

/** Tema değişince çağrılır (ör. üst çubuktaki ay/güneş düğmesini yenilemek için). */
export function onThemeChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

media.addEventListener('change', applyTheme);
