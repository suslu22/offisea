// Belge (Word) düzenleyicisi.
import { h, tbtn, tsep, tselect, popupMenu, colorPicker, askText, formDialog, toast, debounce, clear } from '../core/ui.js';
import { sanitizeHtml, sanitizeToFragment } from '../core/sanitize.js';
import { pickFile, normalizeImage } from '../core/files.js';
import { saveBlob, printElement, canPrint, openExternal, isSafeUrl } from '../core/platform.js';
import { usableFonts, previewFontOptions } from '../core/fonts.js';
import { pinchZoom } from '../core/pinch.js';

const FONTS = ['Calibri', 'Arial', 'Times New Roman', 'Georgia', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Segoe UI', 'Courier New', 'Garamond'];
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];
const BLOCKS = [
  { value: 'p', label: 'Normal' }, { value: 'h1', label: 'Başlık 1' }, { value: 'h2', label: 'Başlık 2' },
  { value: 'h3', label: 'Başlık 3' }, { value: 'h4', label: 'Başlık 4' }, { value: 'blockquote', label: 'Alıntı' }, { value: 'pre', label: 'Kod' },
];

export const WORD_ACCEPT_IMAGES = 'image/png,image/jpeg,image/gif,image/webp,image/bmp';

export async function mountWord(root, data, app) {
  root.classList.add('editor', 'editor-word');
  const page = h('div', {
    class: 'page', contenteditable: 'true', spellcheck: 'true', lang: 'tr',
    role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Belge içeriği',
  });
  page.append(sanitizeToFragment(data && data.html ? data.html : '<p><br></p>'));
  if (!page.firstChild) page.append(h('p', null, h('br')));

  const toolbar = h('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Biçimlendirme' });
  const findBar = h('div', { class: 'findbar', hidden: true });
  const scroller = h('div', { class: 'doc-scroller' }, h('div', { class: 'page-wrap' }, page));
  const status = h('div', { class: 'statusbar' });
  root.append(toolbar, findBar, scroller, status);

  let zoom = 1;
  let savedRange = null;
  const state = {};

  // ---- Seçim yönetimi --------------------------------------------------------------
  const inPage = (node) => node && (node === page || page.contains(node));
  const onSelChange = () => {
    const sel = document.getSelection();
    if (sel && sel.rangeCount && inPage(sel.anchorNode)) {
      savedRange = sel.getRangeAt(0).cloneRange();
      updateState();
    }
  };
  document.addEventListener('selectionchange', onSelChange);

  function restore() {
    page.focus({ preventScroll: true });
    if (!savedRange) return;
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(savedRange);
  }

  function exec(cmd, val = null, css = true) {
    restore();
    document.execCommand('styleWithCSS', false, css);
    document.execCommand(cmd, false, val);
    changed();
    updateState();
  }

  const changed = () => { app.markDirty(); updateStats(); };

  // ---- Biçimlendirme işlemleri -----------------------------------------------------
  function setFontSize(pt) {
    restore();
    document.execCommand('styleWithCSS', false, false);
    document.execCommand('fontSize', false, '7');
    const spans = [];
    for (const f of page.querySelectorAll('font[size="7"]')) {
      const span = document.createElement('span');
      span.style.fontSize = pt + 'pt';
      span.append(...f.childNodes);
      f.replaceWith(span);
      spans.push(span);
      // İç içe eski boyutları temizle ki yeni boyut geçerli olsun.
      for (const inner of span.querySelectorAll('[style*="font-size"]')) inner.style.fontSize = '';
    }
    if (spans.length) {
      const r = document.createRange();
      r.setStartBefore(spans[0]);
      r.setEndAfter(spans[spans.length - 1]);
      const sel = document.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      savedRange = r.cloneRange();
    }
    document.execCommand('styleWithCSS', false, true);
    changed();
  }

  function selectedBlocks() {
    restore();
    const sel = document.getSelection();
    if (!sel.rangeCount) return [];
    const range = sel.getRangeAt(0);
    const blockOf = (n) => {
      let e = n.nodeType === 1 ? n : n.parentElement;
      while (e && e !== page && !/^(P|H[1-6]|LI|BLOCKQUOTE|PRE|DIV|TD|TH)$/.test(e.tagName)) e = e.parentElement;
      return e && e !== page ? e : null;
    };
    const out = new Set();
    const walker = document.createTreeWalker(page, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let n = walker.currentNode;
    while (n) {
      if (range.intersectsNode(n)) { const b = blockOf(n); if (b) out.add(b); }
      n = walker.nextNode();
    }
    const s = blockOf(range.startContainer); if (s) out.add(s);
    return [...out];
  }

  function setLineHeight(v) {
    for (const b of selectedBlocks()) b.style.lineHeight = v;
    changed();
  }

  function clearFormatting() {
    exec('removeFormat');
    for (const b of selectedBlocks()) { b.style.removeProperty('background-color'); }
    exec('formatBlock', '<p>');
  }

  async function insertLink() {
    restore();
    const sel = document.getSelection();
    const existing = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement).closest('a');
    const url = await askText('Bağlantı ekle', { value: existing ? existing.getAttribute('href') : 'https://', label: 'Adres (https://...)' });
    if (url == null) return;
    const clean = url.trim();
    if (!isSafeUrl(clean)) { toast('Yalnızca http, https ve mailto bağlantılarına izin verilir.', { type: 'error' }); return; }
    restore();
    if (document.getSelection().isCollapsed && !existing) {
      const a = h('a', { href: clean, rel: 'noopener noreferrer nofollow' }, clean);
      exec('insertHTML', a.outerHTML);
    } else {
      exec('createLink', clean);
    }
    for (const a of page.querySelectorAll('a')) a.setAttribute('rel', 'noopener noreferrer nofollow');
  }

  async function insertImageFile(file) {
    try {
      const { dataUrl, width } = await normalizeImage(file);
      const img = h('img', { src: dataUrl, alt: '' });
      img.style.width = Math.min(width, 600) + 'px';
      exec('insertHTML', img.outerHTML);
    } catch (e) {
      toast(e.message || 'Resim eklenemedi.', { type: 'error' });
    }
  }

  async function insertImage() {
    const f = await pickFile(WORD_ACCEPT_IMAGES);
    if (f) await insertImageFile(f);
  }

  async function insertTable() {
    const r = await formDialog('Tablo ekle', [
      { name: 'rows', label: 'Satır sayısı', type: 'number', value: 3, min: 1, max: 200 },
      { name: 'cols', label: 'Sütun sayısı', type: 'number', value: 3, min: 1, max: 30 },
    ], { okLabel: 'Ekle' });
    if (!r) return;
    const rows = Math.max(1, Math.min(200, parseInt(r.rows, 10) || 3));
    const cols = Math.max(1, Math.min(30, parseInt(r.cols, 10) || 3));
    const table = h('table', { style: { borderCollapse: 'collapse', width: '100%' } });
    const tbody = h('tbody');
    for (let i = 0; i < rows; i++) {
      const tr = h('tr');
      for (let j = 0; j < cols; j++) tr.append(h('td', { style: { border: '1px solid #000000', padding: '2pt 5pt', verticalAlign: 'top' } }, h('br')));
      tbody.append(tr);
    }
    table.append(tbody);
    exec('insertHTML', table.outerHTML + '<p><br></p>');
  }

  function currentCell() {
    if (!savedRange) return null;
    let n = savedRange.startContainer;
    n = n.nodeType === 1 ? n : n.parentElement;
    const td = n && n.closest('td,th');
    return td && page.contains(td) ? td : null;
  }

  function tableOp(op) {
    const td = currentCell();
    if (!td) { toast('Önce imleci bir tablo hücresine koyun.'); return; }
    const tr = td.parentElement;
    const table = td.closest('table');
    const idx = Array.from(tr.children).indexOf(td);
    const newCell = () => {
      const c = td.cloneNode(false);
      c.removeAttribute('colspan'); c.removeAttribute('rowspan');
      c.append(h('br'));
      return c;
    };
    if (op === 'rowBelow' || op === 'rowAbove') {
      const nr = tr.cloneNode(false);
      for (let i = 0; i < tr.children.length; i++) nr.append(newCell());
      op === 'rowBelow' ? tr.after(nr) : tr.before(nr);
    } else if (op === 'colRight' || op === 'colLeft') {
      for (const row of table.querySelectorAll('tr')) {
        const ref = row.children[Math.min(idx, row.children.length - 1)];
        if (!ref) continue;
        op === 'colRight' ? ref.after(newCell()) : ref.before(newCell());
      }
    } else if (op === 'delRow') {
      if (table.querySelectorAll('tr').length <= 1) table.remove(); else tr.remove();
    } else if (op === 'delCol') {
      for (const row of table.querySelectorAll('tr')) { const c = row.children[idx]; if (c) c.remove(); }
      if (!table.querySelector('td,th')) table.remove();
    } else if (op === 'delTable') {
      table.remove();
    }
    changed();
  }

  function insertPageBreak() {
    exec('insertHTML', '<div class="offisea-page-break" contenteditable="false"></div><p><br></p>');
  }

  // ---- Bul / Değiştir ------------------------------------------------------------
  const findInput = h('input', { class: 'input small', placeholder: 'Bul', 'aria-label': 'Bul' });
  const replInput = h('input', { class: 'input small', placeholder: 'Değiştir', 'aria-label': 'Şununla değiştir' });
  const caseBox = h('input', { type: 'checkbox', 'aria-label': 'Büyük/küçük harf duyarlı' });
  const findCount = h('span', { class: 'find-count' });
  let matchIndex = -1;

  function matches() {
    const q = findInput.value;
    if (!q) return [];
    const res = [];
    const cs = caseBox.checked;
    const needle = cs ? q : q.toLocaleLowerCase('tr');
    const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const hay = cs ? n.nodeValue : n.nodeValue.toLocaleLowerCase('tr');
      let i = hay.indexOf(needle);
      while (i >= 0) { res.push({ node: n, start: i, end: i + q.length }); i = hay.indexOf(needle, i + Math.max(1, q.length)); }
    }
    return res;
  }

  function selectMatch(m) {
    const r = document.createRange();
    r.setStart(m.node, m.start);
    r.setEnd(m.node, m.end);
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    savedRange = r.cloneRange();
    const rect = r.getBoundingClientRect();
    const sr = scroller.getBoundingClientRect();
    if (rect.top < sr.top + 40 || rect.bottom > sr.bottom - 40) scroller.scrollTop += rect.top - sr.top - sr.height / 3;
  }

  function findNext(dir = 1) {
    const all = matches();
    findCount.textContent = all.length ? '' : 'Bulunamadı';
    if (!all.length) return;
    matchIndex = (matchIndex + dir + all.length) % all.length;
    findCount.textContent = `${matchIndex + 1}/${all.length}`;
    selectMatch(all[matchIndex]);
  }

  function replaceOne() {
    const sel = document.getSelection();
    const q = findInput.value;
    if (!q) return;
    const selected = sel.rangeCount && inPage(sel.anchorNode) ? sel.toString() : '';
    const same = caseBox.checked ? selected === q : selected.toLocaleLowerCase('tr') === q.toLocaleLowerCase('tr');
    if (same) { page.focus({ preventScroll: true }); document.execCommand('insertText', false, replInput.value); changed(); }
    matchIndex -= 1;
    findNext(1);
  }

  function replaceAll() {
    const all = matches();
    if (!all.length) { findCount.textContent = 'Bulunamadı'; return; }
    page.focus({ preventScroll: true });
    for (let i = all.length - 1; i >= 0; i--) {
      selectMatch(all[i]);
      document.execCommand('insertText', false, replInput.value);
    }
    findCount.textContent = `${all.length} değiştirildi`;
    changed();
  }

  findInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); findNext(e.shiftKey ? -1 : 1); } });
  findInput.addEventListener('input', () => { matchIndex = -1; findCount.textContent = ''; });
  findBar.append(
    findInput, tbtn('arrowUp', 'Önceki', () => findNext(-1)), tbtn('arrowDown', 'Sonraki', () => findNext(1)),
    h('label', { class: 'find-case' }, caseBox, 'Aa'), findCount, replInput,
    h('button', { class: 'btn small', type: 'button', onClick: replaceOne }, 'Değiştir'),
    h('button', { class: 'btn small', type: 'button', onClick: replaceAll }, 'Tümü'),
    tbtn('close', 'Kapat', () => { findBar.hidden = true; page.focus(); }),
  );
  function openFind() {
    findBar.hidden = false;
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed && inPage(sel.anchorNode)) findInput.value = sel.toString().slice(0, 100);
    findInput.focus();
    findInput.select();
  }

  // ---- Araç çubuğu ---------------------------------------------------------------
  const blockSel = tselect(BLOCKS, (v) => exec('formatBlock', `<${v}>`), { title: 'Paragraf stili', width: '110px' });
  const fontSel = tselect(usableFonts(FONTS).map((f) => ({ value: f, label: f })), (v) => exec('fontName', v), { title: 'Yazı tipi', width: '130px' });
  previewFontOptions(fontSel);
  const sizeSel = tselect(SIZES.map((s) => ({ value: String(s), label: String(s) })), (v) => setFontSize(+v), { title: 'Yazı boyutu', width: '64px', value: '11' });
  const btn = (key, ic, title, fn, opts) => { const b = tbtn(ic, title, fn, opts); state[key] = b; return b; };

  toolbar.append(
    tbtn('undo', 'Geri al (Ctrl+Z)', () => exec('undo')),
    tbtn('redo', 'Yinele (Ctrl+Y)', () => exec('redo')),
    tsep(), blockSel, fontSel, sizeSel, tsep(),
    btn('bold', null, 'Kalın (Ctrl+B)', () => exec('bold'), { text: 'K', cls: 'tb-bold' }),
    btn('italic', null, 'İtalik (Ctrl+I)', () => exec('italic'), { text: 'T', cls: 'tb-italic' }),
    btn('underline', null, 'Altı çizili (Ctrl+U)', () => exec('underline'), { text: 'A', cls: 'tb-underline' }),
    btn('strikeThrough', null, 'Üstü çizili', () => exec('strikeThrough'), { text: 'Ü', cls: 'tb-strike' }),
    btn('superscript', 'superscript', 'Üst simge', () => exec('superscript')),
    btn('subscript', 'subscript', 'Alt simge', () => exec('subscript')),
    tsep(),
    tbtn('textColor', 'Yazı rengi', (e, b) => colorPicker(b, (c) => exec('foreColor', c || '#000000'), { noneLabel: 'Otomatik' }), { cls: 'tb-color' }),
    tbtn('highlight', 'Vurgu rengi', (e, b) => colorPicker(b, (c) => exec('hiliteColor', c || 'transparent'), { noneLabel: 'Renk yok' })),
    tsep(),
    btn('justifyLeft', 'alignLeft', 'Sola hizala', () => exec('justifyLeft')),
    btn('justifyCenter', 'alignCenter', 'Ortala', () => exec('justifyCenter')),
    btn('justifyRight', 'alignRight', 'Sağa hizala', () => exec('justifyRight')),
    btn('justifyFull', 'justify', 'İki yana yasla', () => exec('justifyFull')),
    tsep(),
    btn('insertUnorderedList', 'listBullet', 'Madde işaretleri', () => exec('insertUnorderedList')),
    btn('insertOrderedList', 'listNumber', 'Numaralandırma', () => exec('insertOrderedList')),
    tbtn('outdent', 'Girintiyi azalt', () => exec('outdent')),
    tbtn('indent', 'Girintiyi artır', () => exec('indent')),
    tbtn(null, 'Satır aralığı', (e, b) => popupMenu(b, ['1.0', '1.15', '1.5', '2.0', '2.5', '3.0'].map((v) => ({ label: v, onClick: () => setLineHeight(v) }))), { text: '↕', cls: 'tb-text' }),
    tsep(),
    tbtn('link', 'Bağlantı ekle', insertLink),
    tbtn('image', 'Resim ekle', insertImage),
    tbtn('table', 'Tablo', (e, b) => popupMenu(b, [
      { label: 'Tablo ekle…', icon: 'table', onClick: insertTable },
      { separator: true },
      { label: 'Üste satır ekle', onClick: () => tableOp('rowAbove'), disabled: !currentCell() },
      { label: 'Alta satır ekle', onClick: () => tableOp('rowBelow'), disabled: !currentCell() },
      { label: 'Sola sütun ekle', onClick: () => tableOp('colLeft'), disabled: !currentCell() },
      { label: 'Sağa sütun ekle', onClick: () => tableOp('colRight'), disabled: !currentCell() },
      { separator: true },
      { label: 'Satırı sil', icon: 'trash', onClick: () => tableOp('delRow'), disabled: !currentCell() },
      { label: 'Sütunu sil', icon: 'trash', onClick: () => tableOp('delCol'), disabled: !currentCell() },
      { label: 'Tabloyu sil', icon: 'trash', onClick: () => tableOp('delTable'), disabled: !currentCell() },
    ])),
    tbtn('hr', 'Yatay çizgi', () => exec('insertHorizontalRule')),
    tbtn('pageBreak', 'Sayfa sonu', insertPageBreak),
    tsep(),
    tbtn('clearFormat', 'Biçimi temizle', clearFormatting),
    tbtn('search', 'Bul ve değiştir (Ctrl+F)', openFind),
  );

  function updateState() {
    for (const k of ['bold', 'italic', 'underline', 'strikeThrough', 'superscript', 'subscript', 'justifyLeft', 'justifyCenter', 'justifyRight', 'justifyFull', 'insertUnorderedList', 'insertOrderedList']) {
      let on = false;
      try { on = document.queryCommandState(k); } catch { /* yok say */ }
      state[k] && state[k].classList.toggle('active', on);
    }
    let block = '';
    try { block = (document.queryCommandValue('formatBlock') || '').toLowerCase(); } catch { /* yok say */ }
    blockSel.value = BLOCKS.some((b) => b.value === block) ? block : 'p';
    const sel = document.getSelection();
    if (sel && sel.anchorNode) {
      const el = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
      if (el && inPage(el)) {
        const cs = getComputedStyle(el);
        const pt = Math.round(parseFloat(cs.fontSize) * 0.75 * 2) / 2;
        const ptStr = String(pt);
        if (![...sizeSel.options].some((o) => o.value === ptStr)) {
          const extra = sizeSel.querySelector('option[data-extra]') || h('option', { dataset: { extra: '1' } });
          extra.value = ptStr; extra.textContent = ptStr;
          sizeSel.prepend(extra);
        }
        sizeSel.value = ptStr;
        const fam = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim();
        if (![...fontSel.options].some((o) => o.value === fam)) {
          const extra = fontSel.querySelector('option[data-extra]') || h('option', { dataset: { extra: '1' } });
          extra.value = fam; extra.textContent = fam;
          fontSel.prepend(extra);
        }
        fontSel.value = fam;
      }
    }
  }

  // ---- Durum çubuğu ---------------------------------------------------------------
  const statText = h('span', { class: 'stat-text' });
  const zoomLabel = h('span', { class: 'zoom-label' }, '100%');
  const setZoom = (z) => {
    zoom = Math.max(0.5, Math.min(2.5, Math.round(z * 10) / 10));
    page.style.zoom = zoom;
    zoomLabel.textContent = Math.round(zoom * 100) + '%';
  };
  status.append(statText, h('span', { class: 'spacer' }),
    tbtn('zoomOut', 'Uzaklaştır', () => setZoom(zoom - 0.1)), zoomLabel, tbtn('zoomIn', 'Yakınlaştır', () => setZoom(zoom + 0.1)));
  // İki parmakla (telefon) veya Ctrl + tekerlekle yakınlaştırma
  pinchZoom(scroller, { content: () => scroller.firstElementChild, getZoom: () => zoom, setZoom: (z) => setZoom(z), min: 0.5, max: 2.5 });
  const updateStats = debounce(() => {
    const text = page.innerText || '';
    const words = (text.match(/\S+/g) || []).length;
    const last = page.lastElementChild;
    const pr = page.getBoundingClientRect();
    const contentH = last ? last.getBoundingClientRect().bottom - pr.top : 0;
    // A4 oranı: içerik yüksekliği / (sayfa genişliği × √2)
    const pages = Math.max(1, Math.ceil((contentH - 4) / Math.max(1, pr.width * 1.4142)));
    statText.textContent = `Sayfa ≈ ${pages}  ·  ${words.toLocaleString('tr-TR')} sözcük  ·  ${text.replace(/\s/g, '').length.toLocaleString('tr-TR')} karakter`;
  }, 400);
  updateStats();

  // ---- Olaylar --------------------------------------------------------------------
  page.addEventListener('input', changed);

  page.addEventListener('paste', async (e) => {
    const cd = e.clipboardData;
    if (!cd) return;
    const img = Array.from(cd.files || []).find((f) => f.type.startsWith('image/'));
    if (img) { e.preventDefault(); await insertImageFile(img); return; }
    const html = cd.getData('text/html');
    if (html) {
      e.preventDefault();
      const clean = sanitizeHtml(html.replace(/<!--[\s\S]*?-->/g, ''));
      document.execCommand('insertHTML', false, clean || '');
      changed();
    }
  });

  page.addEventListener('drop', async (e) => {
    const files = Array.from(e.dataTransfer?.files || []);
    if (!files.length) return;
    const img = files.find((f) => f.type.startsWith('image/'));
    if (img) {
      e.preventDefault();
      e.stopPropagation();
      if (document.caretRangeFromPoint) {
        const r = document.caretRangeFromPoint(e.clientX, e.clientY);
        if (r) { savedRange = r; }
      }
      await insertImageFile(img);
    }
  });

  page.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (a && page.contains(a)) {
      e.preventDefault();
      const href = a.getAttribute('href') || '';
      if ((e.ctrlKey || e.metaKey) && isSafeUrl(href)) { openExternal(href); return; }
      popupMenu({ x: e.clientX, y: e.clientY + 8 }, [
        { header: href.length > 50 ? href.slice(0, 50) + '…' : href },
        { label: 'Bağlantıyı aç', icon: 'link', onClick: () => openExternal(href), disabled: !isSafeUrl(href) },
        { label: 'Bağlantıyı kaldır', icon: 'close', onClick: () => { a.replaceWith(...a.childNodes); changed(); } },
      ]);
      return;
    }
    if (e.target.tagName === 'IMG' && page.contains(e.target)) {
      const im = e.target;
      const setW = (pct) => { im.style.width = pct; im.style.height = 'auto'; changed(); };
      popupMenu({ x: e.clientX, y: e.clientY + 8 }, [
        { header: 'Resim' },
        { label: 'Genişlik %25', onClick: () => setW('25%') },
        { label: 'Genişlik %50', onClick: () => setW('50%') },
        { label: 'Genişlik %75', onClick: () => setW('75%') },
        { label: 'Genişlik %100', onClick: () => setW('100%') },
        { separator: true },
        { label: 'Sola yasla (metin sağda)', onClick: () => { im.style.float = 'left'; im.style.marginRight = '12px'; changed(); } },
        { label: 'Sağa yasla (metin solda)', onClick: () => { im.style.float = 'right'; im.style.marginLeft = '12px'; changed(); } },
        { label: 'Satır içi', onClick: () => { im.style.float = ''; im.style.margin = ''; changed(); } },
        { separator: true },
        { label: 'Resmi sil', icon: 'trash', onClick: () => { im.remove(); changed(); } },
      ]);
    }
  });

  page.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      const td = currentCell();
      const sel = document.getSelection();
      const li = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement).closest('li');
      e.preventDefault();
      if (td) {
        const cells = Array.from(td.closest('table').querySelectorAll('td,th'));
        const next = cells[cells.indexOf(td) + (e.shiftKey ? -1 : 1)];
        if (next) {
          const r = document.createRange();
          r.selectNodeContents(next);
          r.collapse(false);
          sel.removeAllRanges();
          sel.addRange(r);
        }
      } else if (li) exec(e.shiftKey ? 'outdent' : 'indent');
      else exec('insertHTML', '<span class="offisea-tab">\t</span>');
    }
  });

  const onKey = (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === 'f' || k === 'h') { e.preventDefault(); openFind(); }
    else if (k === 'p' && canPrint()) { e.preventDefault(); doPrint(); }
  };
  root.addEventListener('keydown', onKey);

  // ---- Dışa aktarma ---------------------------------------------------------------
  async function exportDocxFile(title) {
    const { exportDocx } = await import('./docx-export.js');
    const blob = await exportDocx(page, title);
    return saveBlob(blob, `${title}.docx`);
  }

  function standaloneHtml(title) {
    const doc = document.implementation.createHTMLDocument(title);
    const meta = doc.createElement('meta'); meta.setAttribute('charset', 'utf-8'); doc.head.append(meta);
    const st = doc.createElement('style');
    st.textContent = 'body{font-family:Calibri,Arial,sans-serif;font-size:11pt;max-width:800px;margin:40px auto;line-height:1.4;color:#000}table{border-collapse:collapse}img{max-width:100%}.offisea-page-break{page-break-after:always}';
    doc.head.append(st);
    const body = doc.createElement('div');
    body.innerHTML = sanitizeHtml(page.innerHTML);
    doc.body.append(...body.childNodes);
    return '<!doctype html>\n' + doc.documentElement.outerHTML;
  }

  function doPrint() {
    printElement(() => {
      const wrap = h('div', { class: 'print-doc' });
      wrap.append(sanitizeToFragment(page.innerHTML));
      return wrap;
    }, { pageCss: '@page { size: A4; margin: 25mm; }' });
  }

  async function insertFromFile() {
    const f = await pickFile('.docx,.odt,.rtf,.txt,.md,.html,.htm');
    if (!f) return;
    try {
      const { importWordData } = await import('./import.js');
      const res = await importWordData(f);
      restore();
      exec('insertHTML', sanitizeHtml(res.html));
    } catch (err) { toast(err.message || 'Dosya eklenemedi.', { type: 'error' }); }
  }

  updateState();
  setTimeout(() => { page.focus({ preventScroll: true }); }, 50);

  return {
    serialize: () => ({ html: page.innerHTML }),
    primaryExport: { label: 'Word (.docx) olarak indir', run: (title) => exportDocxFile(title) },
    fileMenu: (title) => [
      { label: 'Word belgesi (.docx)', icon: 'download', onClick: () => exportDocxFile(title()) },
      canPrint() ? { label: 'PDF olarak kaydet / Yazdır', icon: 'print', hint: 'Ctrl+P', onClick: doPrint } : null,
      { label: 'Web sayfası (.html)', icon: 'download', onClick: () => saveBlob(new Blob([standaloneHtml(title())], { type: 'text/html' }), `${title()}.html`) },
      { label: 'Düz metin (.txt)', icon: 'download', onClick: () => saveBlob(new Blob([page.innerText], { type: 'text/plain;charset=utf-8' }), `${title()}.txt`) },
      { separator: true },
      { label: 'Başka bir belgenin içeriğini ekle…', icon: 'upload', onClick: insertFromFile },
    ],
    canAcceptImage: true,
    insertImageFile,
    destroy() {
      document.removeEventListener('selectionchange', onSelChange);
      root.removeEventListener('keydown', onKey);
      clear(root);
      root.classList.remove('editor', 'editor-word');
    },
  };
}
