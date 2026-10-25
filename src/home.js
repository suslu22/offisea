// Giriş ekranı: yeni belge oluşturma, dosya açma, son belgeler.
import { h, icon, clear, popupMenu, askText, confirmBox, toast, modal } from './core/ui.js';
import {
  listDocs, deleteDoc, loadDoc, saveDoc, newId, getPref, setPref, updateMeta, trashDoc, restoreDoc, purgeTrash,
  listFolders, saveFolder, deleteFolder, TRASH_DAYS,
} from './core/storage.js';
import { LITE, glassPref, glassAutoState, setGlassPref, resetGlassProbe } from './core/perf.js';
import { themePref, setThemePref } from './core/theme.js';
import { isNative, isElectron } from './core/platform.js';
import { APP_VERSION, checkForUpdates, updateInfo, resetToBuiltin, canReset } from './core/updater.js';

export const KINDS = {
  word: { label: 'Belge', long: 'Belge (Word)', icon: 'doc', newTitle: 'Adsız belge', exts: 'docx, odt, rtf, txt, md, html' },
  sheet: { label: 'Tablo', long: 'Tablo (Excel)', icon: 'sheet', newTitle: 'Adsız tablo', exts: 'xlsx, xls, ods, csv' },
  slides: { label: 'Sunu', long: 'Sunu (PowerPoint)', icon: 'pres', newTitle: 'Adsız sunu', exts: 'pptx, ppsx, potx' },
  pdf: { label: 'PDF', long: 'PDF', icon: 'pdf', newTitle: 'PDF', exts: 'pdf' },
};

function fmtDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return 'Bugün ' + time;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Dün ' + time;
  return d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

function fmtSize(b) {
  if (!b) return '';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return Math.round(b / 1024) + ' KB';
  return (b / 1024 / 1024).toFixed(1).replace('.', ',') + ' MB';
}

export function showAbout() {
  const li = (t) => h('li', null, t);
  const plat = isElectron() ? 'Windows masaüstü' : isNative() ? 'Android' : 'Web';
  const verLine = h('p', { class: 'muted' }, `Sürüm ${APP_VERSION} · ${plat}`);
  updateInfo().then((i) => {
    if (i.activeBuild) verLine.textContent = `Sürüm ${i.activeVersion || APP_VERSION} (güncelleme ile yüklendi) · ${plat}`;
  });
  const upd = h('div', { class: 'about-update' },
    h('button', { class: 'btn btn-primary', type: 'button', onClick: () => checkForUpdates(true) }, 'Güncellemeleri denetle'));
  if (canReset()) {
    upd.append(h('button', { class: 'btn', type: 'button', onClick: async () => {
      if (await confirmBox('Kurulumla gelen sürüme dön', 'Son güncelleme kaldırılıp uygulamayla gelen sürüm yüklensin mi? Belgeleriniz silinmez.', { okLabel: 'Geri dön' })) resetToBuiltin();
    } }, 'Kurulumla gelen sürüme dön'));
  }
  // Performans: otomatik algılama yanlış karar verirse kullanıcı değiştirebilir (yeniden açılışta etkin olur).
  const perfSel = h('select', { class: 'input', 'aria-label': 'Hafif mod' },
    h('option', { value: 'auto' }, `Otomatik (bu cihazda ${LITE ? 'açık' : 'kapalı'})`),
    h('option', { value: 'lite' }, 'Her zaman açık'),
    h('option', { value: 'full' }, 'Kapalı'));
  perfSel.value = getPref('perfMode', 'auto');
  perfSel.addEventListener('change', () => {
    setPref('perfMode', perfSel.value);
    toast('Ayar kaydedildi. Uygulama yeniden açılınca etkin olur.', { type: 'success' });
  });
  // Görünüm: tema ve cam efekti hemen uygulanır.
  const themeSel = h('select', { class: 'input', 'aria-label': 'Tema' },
    h('option', { value: 'auto' }, 'Otomatik (sistemle aynı)'),
    h('option', { value: 'light' }, 'Açık'),
    h('option', { value: 'dark' }, 'Koyu'));
  themeSel.value = themePref();
  themeSel.addEventListener('change', () => setThemePref(themeSel.value));
  const autoGlass = glassAutoState();
  const glassSel = h('select', { class: 'input', 'aria-label': 'Cam efekti' },
    h('option', { value: 'auto' }, `Otomatik (bu cihazda ${autoGlass.ok ? 'açık' : 'kapalı'})`),
    h('option', { value: 'on' }, 'Açık'),
    h('option', { value: 'off' }, 'Kapalı'));
  glassSel.value = glassPref();
  const glassNote = h('p', { class: 'muted small-note' });
  const noteText = () => {
    const v = glassSel.value;
    if (v === 'auto') return autoGlass.ok ? 'Bu cihaz cam efektini rahat çalıştırabiliyor.' : `Bu cihazda otomatik olarak kapalı: ${autoGlass.why}.`;
    if (v === 'on' && !autoGlass.ok) return `Uyarı: ${autoGlass.why}; uygulama yavaşlarsa “Otomatik” ya da “Kapalı” seçin.`;
    return '';
  };
  glassNote.textContent = noteText();
  glassSel.addEventListener('change', () => {
    if (glassSel.value === 'auto' && getPref('glassProbe', null) && getPref('glassProbe', null).ok === false) {
      // "Otomatik" yeniden seçildiyse eski ölçüm bir kez daha denenir (cihaz güncellenmiş olabilir).
      resetGlassProbe();
    }
    setGlassPref(glassSel.value);
    glassNote.textContent = noteText();
  });
  modal({
    title: 'Ayarlar ve hakkında',
    body: h('div', { class: 'about' },
      h('h3', null, 'Görünüm'),
      h('div', { class: 'settings-grid' },
        h('label', { class: 'field-label' }, 'Tema'), themeSel,
        h('label', { class: 'field-label' }, 'Cam efekti'), glassSel),
      glassNote,
      h('h3', null, 'Offisea hakkında'),
      h('p', null, 'Offisea ücretsiz, reklamsız ve çevrimdışı çalışan bir ofis uygulamasıdır. Belgeleriniz yalnızca bu cihazda saklanır; hiçbir sunucuya gönderilmez, hesap gerekmez.'),
      h('h3', null, 'Güvenlik önlemleri'),
      h('ul', null,
        li('Belgelerdeki makrolar (VBA), gömülü OLE nesneleri, PDF içi JavaScript ve XFA formları asla çalıştırılmaz.'),
        li('Belgelerdeki uzak resim ve bağlantılar otomatik yüklenmez (izleme pikselleri ve Windows NTLM parola özeti sızıntısı açıklarına karşı).'),
        li('Tüm belge içeriği güncel DOMPurify ile temizlenir; sıkı İçerik Güvenlik Politikası (CSP) dışarıya bağlantıyı engeller.'),
        li('ZIP bombası ve aşırı büyük dosya koruması; XML dış varlıkları (XXE) çözülmez.'),
        li('Excel formülleri kendi güvenli motorumuzla hesaplanır (eval kullanılmaz); CSV dışa aktarımında formül enjeksiyonu engellenir.'),
        li('Eklenen resimlerdeki konum (GPS/EXIF) bilgileri temizlenir.'),
        li('Masaüstü sürümünde Electron yalıtımı (sandbox, contextIsolation) açıktır; Node.js erişimi kapalıdır.'),
      ),
      h('h3', null, 'Güncellemeler'),
      h('p', null, 'Offisea kendini otomatik günceller; yeni kurulum dosyası indirmeniz gerekmez. Yalnızca değişen dosyalar, Android’de yalnızca Wi-Fi’da indirilir. Her güncelleme dijital imzayla doğrulanır.'),
      upd,
      h('h3', null, 'Performans'),
      h('p', null, 'Hafif mod, düşük donanımlı telefonlarda daha akıcı çalışmak için çizim kalitesini ve bellek kullanımını dengeler.'),
      h('div', { class: 'about-update' }, h('label', { class: 'field-label' }, 'Hafif mod'), perfSel),
      verLine,
    ),
  });
}

// Seçili görünüm: null = tüm belgeler, 'trash' = çöp kutusu, diğerleri klasör kimliği.
// Belge açıp geri dönünce aynı klasör seçili kalır.
let homeView = null;
let redrawHome = null;
let purged = false;

/** Yeni belgelerin konacağı klasör (çöp kutusu ya da tümü seçiliyse yok). */
export function currentFolder() {
  return homeView && homeView !== 'trash' ? homeView : undefined;
}

/** Telefonun geri tuşu: klasör ya da çöp kutusu açıksa "Tümü"ne döner. */
export function homeBack() {
  if (homeView == null || !redrawHome) return false;
  homeView = null;
  redrawHome();
  return true;
}

const daysLeft = (ts) => Math.max(0, Math.ceil((ts + TRASH_DAYS * 86400000 - Date.now()) / 86400000));

export async function renderHome(view, { openFile, createNew, openDoc, installPrompt, scanDoc, mergePdfs }) {
  clear(view);
  view.className = 'view view-home';
  const wrap = h('div', { class: 'home' });

  // Yeni oluştur
  const tiles = h('div', { class: 'new-tiles' });
  for (const kind of ['word', 'sheet', 'slides']) {
    const k = KINDS[kind];
    tiles.append(h('button', { class: `new-tile tile-${kind}`, type: 'button', onClick: () => createNew(kind) },
      h('span', { class: 'tile-icon' }, icon(k.icon, 30)),
      h('span', { class: 'tile-label' }, `Yeni ${k.label.toLocaleLowerCase('tr')}`),
      h('span', { class: 'tile-sub' }, k.long)));
  }
  tiles.append(h('button', { class: 'new-tile tile-open', type: 'button', onClick: () => openFile() },
    h('span', { class: 'tile-icon' }, icon('folder', 30)),
    h('span', { class: 'tile-label' }, 'Dosya aç'),
    h('span', { class: 'tile-sub' }, 'Word, Excel, PowerPoint, PDF')));

  const tools = h('div', { class: 'home-tools' },
    h('button', { class: 'tool-chip', type: 'button', onClick: () => scanDoc() }, icon('camera', 18), h('span', null, 'Belge tara')),
    h('button', { class: 'tool-chip', type: 'button', onClick: () => mergePdfs() }, icon('pages', 18), h('span', null, 'PDF birleştir')));

  const drop = h('div', { class: 'drop-hint' }, icon('upload', 18), h('span', null, isNative() || window.matchMedia('(pointer: coarse)').matches ? 'Telefonunuzdaki dosyaları açmak için “Dosya aç”a dokunun.' : 'Dosyaları bu pencereye sürükleyip bırakarak da açabilirsiniz.'));

  const hero = h('section', { class: 'home-hero' },
    h('h1', { class: 'home-title' }, 'Merhaba! Ne üzerinde çalışmak istersiniz?'),
    tiles, tools, drop);

  if (installPrompt && installPrompt.available()) {
    hero.append(h('button', { class: 'btn install-btn', type: 'button', onClick: () => installPrompt.prompt() }, icon('download', 18), ' Offisea\'yı bu cihaza yükle'));
  }

  // Şablonlar (modül yalnızca gerektiğinde yüklenir)
  const tplRow = h('div', { class: 'tpl-row', role: 'list' });
  const tplSec = h('section', { class: 'home-templates' }, h('h2', null, 'Şablonlar'), tplRow);
  import('./templates.js').then(({ TEMPLATES }) => {
    for (const t of TEMPLATES) {
      const k = KINDS[t.kind];
      tplRow.append(h('button', { class: `tpl-card tpl-${t.id}`, type: 'button', role: 'listitem', onClick: () => createNew(t.kind, { template: t.id }) },
        h('span', { class: `tpl-thumb kind-${t.kind}` }, icon(k.icon, 26)),
        h('span', { class: 'tpl-name' }, t.name),
        h('span', { class: 'tpl-kind' }, k.label)));
    }
  }).catch((e) => { console.warn(e); tplSec.remove(); });

  // Belgeler
  const headTitle = h('h2', null, 'Son belgeler');
  const headTools = h('div', { class: 'recent-head-tools' });
  const filter = h('input', { class: 'input recent-filter', type: 'search', placeholder: 'Belgelerde ara (ad ve içerik)', 'aria-label': 'Belgelerde ara (ad ve içerik)' });
  const searchNote = h('p', { class: 'search-status', hidden: true, role: 'status' });
  headTools.append(filter);
  const recentHead = h('div', { class: 'recent-head' }, headTitle, headTools);
  const chips = h('div', { class: 'folder-chips', role: 'tablist', 'aria-label': 'Klasörler' });
  const note = h('p', { class: 'muted trash-note' });
  const list = h('div', { class: 'recent-list', role: 'list' });
  const recent = h('section', { class: 'home-recent' }, recentHead, chips, note, searchNote, list);

  const foot = h('footer', { class: 'home-foot' },
    icon('shield', 16),
    h('span', null, 'Belgeleriniz yalnızca bu cihazda saklanır. İnternete gönderilmez.'),
    h('button', { class: 'linkish', type: 'button', onClick: showAbout }, 'Ayarlar ve hakkında'));

  wrap.append(hero, tplSec, recent, foot);
  view.append(wrap);

  let docs = [];
  let folders = [];
  const folderName = (id) => (folders.find((f) => f.id === id) || {}).name;

  const newFolder = async () => {
    const t = await askText('Yeni klasör', { label: 'Klasör adı', placeholder: 'ör. İş, Okul, Faturalar' });
    if (t == null || !t.trim()) return null;
    return saveFolder({ name: t.trim() });
  };

  const folderMenu = (anchor, f) => popupMenu(anchor, [
    { label: 'Yeniden adlandır', icon: 'textbox', onClick: async () => {
      const t = await askText('Klasörü yeniden adlandır', { value: f.name, label: 'Klasör adı' });
      if (t == null || !t.trim()) return;
      await saveFolder({ id: f.id, name: t.trim() });
      refresh();
    } },
    { label: 'Klasörü sil', icon: 'trash', onClick: async () => {
      if (!(await confirmBox('Klasörü sil', `“${f.name}” klasörü silinsin mi? İçindeki belgeler silinmez, “Tümü” altında kalır.`, { okLabel: 'Klasörü sil', danger: true }))) return;
      await deleteFolder(f.id);
      if (homeView === f.id) homeView = null;
      refresh();
    } },
  ]);

  const drawChips = () => {
    clear(chips);
    const live = docs.filter((d) => !d.trashed);
    const trashN = docs.length - live.length;
    const chip = (id, label, count, ico) => {
      const on = homeView === id;
      const b = h('button', { class: 'folder-chip' + (on ? ' on' : '') + (id === 'trash' ? ' chip-trash' : ''), type: 'button', role: 'tab', 'aria-selected': on ? 'true' : 'false', title: on && id && id !== 'trash' ? 'Klasör seçenekleri' : label },
        ico ? icon(ico, 16) : null, h('span', null, label), count ? h('span', { class: 'chip-count' }, String(count)) : null);
      b.addEventListener('click', () => {
        const f = folders.find((x) => x.id === id);
        if (on && f) { folderMenu(b, f); return; }
        homeView = id; filter.value = ''; draw();
      });
      return b;
    };
    chips.append(chip(null, 'Tümü', 0, null));
    for (const f of folders) chips.append(chip(f.id, f.name, live.filter((d) => d.folder === f.id).length, 'folder'));
    chips.append(h('button', { class: 'folder-chip chip-add', type: 'button', title: 'Yeni klasör', onClick: async () => {
      const f = await newFolder();
      if (f) { homeView = f.id; refresh(); }
    } }, icon('folderPlus', 16), h('span', null, 'Klasör')));
    chips.append(chip('trash', 'Çöp kutusu', trashN, 'trash'));
  };

  const moveMenu = (anchor, d) => {
    const items = folders.map((f) => ({ label: f.name + (d.folder === f.id ? ' ✓' : ''), icon: 'folder', onClick: async () => { await updateMeta(d.id, { folder: f.id }); toast(`“${f.name}” klasörüne taşındı.`); refresh(); } }));
    if (d.folder) items.push({ label: 'Klasörden çıkar', icon: 'close', onClick: async () => { await updateMeta(d.id, { folder: null }); refresh(); } });
    if (items.length) items.push({ separator: true });
    items.push({ label: 'Yeni klasör…', icon: 'folderPlus', onClick: async () => {
      const f = await newFolder();
      if (!f) return;
      await updateMeta(d.id, { folder: f.id });
      toast(`“${f.name}” klasörüne taşındı.`);
      refresh();
    } });
    popupMenu(anchor, items);
  };

  const docMenu = (more, d) => popupMenu(more, [
    { label: 'Aç', icon: 'file', onClick: () => openDoc(d.id) },
    { label: 'Yeniden adlandır', icon: 'textbox', onClick: async () => {
      const t = await askText('Yeniden adlandır', { value: d.title, label: 'Yeni ad' });
      if (t == null || !t.trim()) return;
      await updateMeta(d.id, { title: t.trim().slice(0, 200) });
      refresh();
    } },
    { label: 'Kopyasını oluştur', icon: 'duplicate', onClick: async () => {
      const full = await loadDoc(d.id);
      if (!full) return;
      await saveDoc({ ...full, id: newId(), title: `${full.title} (kopya)` });
      refresh();
    } },
    { label: 'Klasöre taşı…', icon: 'folder', onClick: () => setTimeout(() => moveMenu(more, d), 0) },
    { separator: true },
    { label: 'Çöp kutusuna taşı', icon: 'trash', onClick: async () => {
      await trashDoc(d.id);
      toast(`“${d.title}” çöp kutusuna taşındı.`, { action: { label: 'Geri al', onClick: async () => { await restoreDoc(d.id); refresh(); } } });
      refresh();
    } },
  ]);

  const trashMenu = (anchor, d) => popupMenu(anchor, [
    { label: 'Geri yükle', icon: 'restore', onClick: async () => { await restoreDoc(d.id); toast('Belge geri yüklendi.', { type: 'success' }); refresh(); } },
    { separator: true },
    { label: 'Kalıcı olarak sil', icon: 'trash', onClick: async () => {
      if (!(await confirmBox('Kalıcı olarak sil', `“${d.title}” kalıcı olarak silinsin mi? Bu işlem geri alınamaz.`, { okLabel: 'Kalıcı olarak sil', danger: true }))) return;
      await deleteDoc(d.id);
      refresh();
    } },
  ]);

  const draw = () => {
    if (homeView && homeView !== 'trash' && !folders.some((f) => f.id === homeView)) homeView = null;
    drawChips();
    clear(list);
    clear(headTools);
    headTools.append(filter);
    const inTrash = homeView === 'trash';
    headTitle.textContent = inTrash ? 'Çöp kutusu' : homeView ? folderName(homeView) : 'Son belgeler';
    note.hidden = !inTrash;
    note.textContent = `Çöp kutusundaki belgeler ${TRASH_DAYS} gün sonra kendiliğinden kalıcı olarak silinir.`;
    const pool = docs.filter((d) => (inTrash ? d.trashed : !d.trashed && (!homeView || d.folder === homeView)));
    if (inTrash && pool.length) {
      headTools.append(h('button', { class: 'btn btn-danger', type: 'button', onClick: async () => {
        if (!(await confirmBox('Çöp kutusunu boşalt', `Çöp kutusundaki ${pool.length} belge kalıcı olarak silinsin mi? Bu işlem geri alınamaz.`, { okLabel: 'Boşalt', danger: true }))) return;
        for (const d of pool) await deleteDoc(d.id);
        toast('Çöp kutusu boşaltıldı.');
        refresh();
      } }, 'Boşalt'));
    }
    const q = filter.value.trim().toLocaleLowerCase('tr');
    const hits = contentQ && contentQ === filter.value.trim() ? contentHits : null;
    const shown = pool.filter((d) => !q || (d.title || '').toLocaleLowerCase('tr').includes(q) || (hits && hits.has(d.id)));
    if (!pool.length) {
      if (inTrash) list.append(h('div', { class: 'empty' }, h('p', null, 'Çöp kutusu boş.')));
      else if (homeView) list.append(h('div', { class: 'empty' }, h('p', null, 'Bu klasör boş.'), h('p', { class: 'muted' }, 'Burada yeni belge oluşturabilir ya da bir belgenin menüsünden “Klasöre taşı”yı seçebilirsiniz.')));
      else list.append(h('div', { class: 'empty' }, h('p', null, 'Henüz belge yok.'), h('p', { class: 'muted' }, 'Yeni bir belge oluşturun, şablon seçin veya bir dosya açın.')));
      return;
    }
    if (!shown.length) { list.append(h('div', { class: 'empty muted' }, 'Eşleşen belge yok.')); return; }
    for (const d of shown) {
      const k = KINDS[d.kind] || KINDS.word;
      const more = h('button', { class: 'tbtn recent-more', type: 'button', title: 'Diğer işlemler', 'aria-label': `${d.title} için diğer işlemler` }, icon('more'));
      const fname = !homeView && d.folder ? folderName(d.folder) : null;
      const meta = inTrash
        ? `${k.label} · ${daysLeft(d.trashed)} gün sonra silinecek`
        : `${k.label}${fname ? ' · ' + fname : ''} · ${fmtDate(d.updated)}${d.size ? ' · ' + fmtSize(d.size) : ''}`;
      const hit = q && hits ? hits.get(d.id) : null;
      // Eşleşen içerik parçası: metin düğümleriyle kurulur (belge içeriği HTML olarak yorumlanmaz)
      const snippet = hit ? h('span', { class: 'search-snippet' }, hit.before, h('mark', null, hit.match), hit.after) : null;
      const openBtn = h('button', { class: 'recent-open', type: 'button' },
        h('span', { class: `recent-icon kind-${d.kind}` }, icon(k.icon, 22)),
        h('span', { class: 'recent-text' },
          h('span', { class: 'recent-title' }, d.title || 'Adsız'),
          h('span', { class: 'recent-meta' }, meta), snippet));
      openBtn.addEventListener('click', () => (inTrash ? trashMenu(openBtn, d) : openDoc(d.id)));
      const row = h('div', { class: 'recent-item' + (inTrash ? ' is-trashed' : ''), role: 'listitem' }, openBtn, more);
      more.addEventListener('click', () => (inTrash ? trashMenu(more, d) : docMenu(more, d)));
      list.append(row);
    }
  };
  const refresh = async () => {
    try { [docs, folders] = await Promise.all([listDocs(), listFolders()]); } catch { docs = []; folders = []; toast('Kayıtlı belgeler okunamadı (tarayıcı depolaması kapalı olabilir).', { type: 'error' }); }
    if (list.isConnected) draw();
  };
  redrawHome = () => { if (list.isConnected) draw(); };
  // İçerikte arama: yazmayı bitirince belge metinleri (gerekirse önce dizinlenerek) taranır
  let contentQ = '', contentHits = new Map(), searchTimer = 0, searchSeq = 0;
  const runContentSearch = async () => {
    const q = filter.value.trim();
    const seq = ++searchSeq;
    if (q.length < 2 || homeView === 'trash') { contentQ = ''; contentHits = new Map(); searchNote.hidden = true; return; }
    try {
      const s = await import('./search.js');
      const pool = docs.filter((d) => !d.trashed);
      if (await s.staleCount(pool)) {
        searchNote.hidden = false;
        searchNote.textContent = 'Belge içerikleri taranıyor…';
        await s.updateIndex(pool, (i, n) => { if (n > 1) searchNote.textContent = `Belge içerikleri taranıyor… ${i} / ${n}`; });
      }
      if (seq !== searchSeq || filter.value.trim() !== q) return;
      contentHits = await s.searchContent(q);
      contentQ = q;
      searchNote.hidden = true;
      if (list.isConnected) draw();
    } catch (e) {
      console.warn(e);
      searchNote.hidden = true;
    }
  };
  filter.addEventListener('input', () => {
    draw();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runContentSearch, 300);
  });
  if (!purged) { purged = true; try { await purgeTrash(); } catch (e) { console.warn(e); } }
  await refresh();
}
