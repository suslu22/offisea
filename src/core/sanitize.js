// Belge HTML'ini temizleyen tek giriş noktası. Yapıştırılan, içe aktarılan ve kayıttan
// geri yüklenen her içerik buradan geçer. DOMPurify (güncel sürüm, bilinen mXSS
// açıkları kapatılmış) + ek kurallar: yalnızca izin verilen etiketler/CSS özellikleri,
// uzak resim yok (izleme pikseli ve Windows NTLM hash sızıntısına karşı), güvenli bağlantılar.
import DOMPurify from 'dompurify';

const ALLOWED_TAGS = [
  'p', 'div', 'span', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ins', 'sub', 'sup', 'mark',
  'font', 'small', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'colgroup', 'col', 'caption', 'a', 'img', 'hr',
  'figure', 'figcaption',
];
const ALLOWED_ATTR = [
  'style', 'href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'width', 'height', 'align', 'valign',
  'color', 'face', 'size', 'class', 'start', 'type', 'contenteditable',
];
const ALLOWED_CLASSES = new Set(['offisea-page-break', 'offisea-tab']);
const ALLOWED_CSS = new Set([
  'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  'text-decoration', 'text-decoration-line', 'text-align', 'vertical-align', 'line-height', 'text-indent',
  'text-transform', 'letter-spacing', 'white-space',
  'margin-left', 'margin-right', 'margin-top', 'margin-bottom', 'padding-left', 'padding-right', 'padding-top', 'padding-bottom',
  'width', 'height', 'max-width', 'border', 'border-top', 'border-bottom', 'border-left', 'border-right',
  'border-color', 'border-style', 'border-width', 'border-collapse', 'list-style-type', 'float',
]);
// Tarayıcı kısa yazımları (border, margin, text-decoration) uzun hallerine açar.
const CSS_PATTERNS = [
  /^border(-(top|right|bottom|left))?(-(width|style|color))?$/,
  /^text-decoration(-(line|color|style|thickness))?$/,
  /^(margin|padding)-(top|right|bottom|left)$/,
];
function cssAllowed(prop) {
  return ALLOWED_CSS.has(prop) || CSS_PATTERNS.some((r) => r.test(prop));
}
const SAFE_IMG =/^data:image\/(png|jpe?g|gif|webp|bmp);base64,[a-z0-9+/=\s]+$/i;
const SAFE_LINK = /^(https?:|mailto:|#)/i;

let hooked = false;
function installHooks() {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeType !== 1) return;
    if (node.hasAttribute('style')) {
      const s = node.style;
      const keep = [];
      for (let i = 0; i < s.length; i++) {
        const prop = s[i];
        if (!cssAllowed(prop)) continue;
        const val = s.getPropertyValue(prop);
        if (/url\s*\(|expression|javascript:|@import|var\s*\(/i.test(val)) continue;
        keep.push(`${prop}: ${val}`);
      }
      if (keep.length) node.setAttribute('style', keep.join('; '));
      else node.removeAttribute('style');
    }
    if (node.hasAttribute('class')) {
      const cls = node.getAttribute('class').split(/\s+/).filter((c) => ALLOWED_CLASSES.has(c));
      if (cls.length) node.setAttribute('class', cls.join(' '));
      else node.removeAttribute('class');
    }
    if (node.hasAttribute('contenteditable')) {
      if (node.classList.contains('offisea-page-break')) node.setAttribute('contenteditable', 'false');
      else node.removeAttribute('contenteditable');
    }
    if (node.tagName === 'IMG') {
      const src = node.getAttribute('src') || '';
      if (!SAFE_IMG.test(src)) {
        // Uzak veya yerel dosya yolu içeren resimler engellenir.
        node.removeAttribute('src');
        node.setAttribute('alt', node.getAttribute('alt') || '[resim engellendi]');
      }
    }
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') || '';
      if (!SAFE_LINK.test(href)) node.removeAttribute('href');
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    }
  });
}

const CONFIG = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  SANITIZE_NAMED_PROPS: true,
  KEEP_CONTENT: true,
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#|data:image\/(?:png|jpe?g|gif|webp|bmp);base64,)/i,
};

export function sanitizeHtml(html) {
  installHooks();
  return DOMPurify.sanitize(String(html || ''), CONFIG);
}

export function sanitizeToFragment(html) {
  installHooks();
  return DOMPurify.sanitize(String(html || ''), { ...CONFIG, RETURN_DOM_FRAGMENT: true });
}

// Sunum metin kutuları için daha dar bir alt küme.
export function sanitizeSlideHtml(html) {
  installHooks();
  return DOMPurify.sanitize(String(html || ''), {
    ...CONFIG,
    ALLOWED_TAGS: ['p', 'div', 'span', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'sub', 'sup', 'font', 'ul', 'ol', 'li', 'a', 'table', 'tbody', 'thead', 'tr', 'td', 'th'],
  });
}
