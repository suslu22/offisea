// Giriş ekranı: yeni belge oluşturma, dosya açma, son belgeler.
import { h, icon, clear, popupMenu, askText, confirmBox, toast, modal } from './core/ui.js';
import { listDocs, deleteDoc, loadDoc, saveDoc, newId, getPref, setPref } from './core/storage.js';
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

export async function renderHome(view, { openFile, createNew, openDoc, installPrompt }) {
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

  const drop = h('div', { class: 'drop-hint' }, icon('upload', 18), h('span', null, isNative() || window.matchMedia('(pointer: coarse)').matches ? 'Telefonunuzdaki dosyaları açmak için “Dosya aç”a dokunun.' : 'Dosyaları bu pencereye sürükleyip bırakarak da açabilirsiniz.'));

  const hero = h('section', { class: 'home-hero' },
    h('h1', { class: 'home-title' }, 'Merhaba! Ne üzerinde çalışmak istersiniz?'),
    tiles, drop);

  if (installPrompt && installPrompt.available()) {
    hero.append(h('button', { class: 'btn install-btn', type: 'button', onClick: () => installPrompt.prompt() }, icon('download', 18), ' Offisea\'yı bu cihaza yükle'));
  }

  // Son belgeler
  const recentHead = h('div', { class: 'recent-head' }, h('h2', null, 'Son belgeler'));
  const filter = h('input', { class: 'input recent-filter', type: 'search', placeholder: 'Belgelerde ara', 'aria-label': 'Belgelerde ara' });
  recentHead.append(filter);
  const list = h('div', { class: 'recent-list', role: 'list' });
  const recent = h('section', { class: 'home-recent' }, recentHead, list);

  const foot = h('footer', { class: 'home-foot' },
    icon('shield', 16),
    h('span', null, 'Belgeleriniz yalnızca bu cihazda saklanır. İnternete gönderilmez.'),
    h('button', { class: 'linkish', type: 'button', onClick: showAbout }, 'Ayarlar ve hakkında'));

  wrap.append(hero, recent, foot);
  view.append(wrap);

  let docs = [];
  const draw = () => {
    clear(list);
    const q = filter.value.trim().toLocaleLowerCase('tr');
    const shown = docs.filter((d) => !q || (d.title || '').toLocaleLowerCase('tr').includes(q));
    if (!docs.length) {
      list.append(h('div', { class: 'empty' }, h('p', null, 'Henüz belge yok.'), h('p', { class: 'muted' }, 'Yeni bir belge oluşturun veya bir dosya açın.')));
      return;
    }
    if (!shown.length) { list.append(h('div', { class: 'empty muted' }, 'Eşleşen belge yok.')); return; }
    for (const d of shown) {
      const k = KINDS[d.kind] || KINDS.word;
      const more = h('button', { class: 'tbtn recent-more', type: 'button', title: 'Diğer işlemler', 'aria-label': `${d.title} için diğer işlemler` }, icon('more'));
      const row = h('div', { class: 'recent-item', role: 'listitem' },
        h('button', { class: 'recent-open', type: 'button', onClick: () => openDoc(d.id) },
          h('span', { class: `recent-icon kind-${d.kind}` }, icon(k.icon, 22)),
          h('span', { class: 'recent-text' },
            h('span', { class: 'recent-title' }, d.title || 'Adsız'),
            h('span', { class: 'recent-meta' }, `${k.label} · ${fmtDate(d.updated)}${d.size ? ' · ' + fmtSize(d.size) : ''}`))),
        more);
      more.addEventListener('click', () => popupMenu(more, [
        { label: 'Aç', icon: 'file', onClick: () => openDoc(d.id) },
        { label: 'Yeniden adlandır', icon: 'textbox', onClick: async () => {
          const t = await askText('Yeniden adlandır', { value: d.title, label: 'Yeni ad' });
          if (t == null || !t.trim()) return;
          const full = await loadDoc(d.id);
          if (!full) return;
          await saveDoc({ ...full, title: t.trim().slice(0, 200) });
          refresh();
        } },
        d.kind !== 'pdf' ? { label: 'Kopyasını oluştur', icon: 'duplicate', onClick: async () => {
          const full = await loadDoc(d.id);
          if (!full) return;
          await saveDoc({ ...full, id: newId(), title: `${full.title} (kopya)` });
          refresh();
        } } : null,
        { separator: true },
        { label: 'Sil', icon: 'trash', onClick: async () => {
          if (!(await confirmBox('Belgeyi sil', `“${d.title}” bu cihazdan silinsin mi? Bu işlem geri alınamaz.`, { okLabel: 'Sil', danger: true }))) return;
          await deleteDoc(d.id);
          toast('Belge silindi.');
          refresh();
        } },
      ]));
      list.append(row);
    }
  };
  const refresh = async () => {
    try { docs = await listDocs(); } catch { docs = []; toast('Kayıtlı belgeler okunamadı (tarayıcı depolaması kapalı olabilir).', { type: 'error' }); }
    draw();
  };
  filter.addEventListener('input', draw);
  await refresh();
}
