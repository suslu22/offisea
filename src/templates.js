// Hazır şablonlar: yeni belge, tablo ve sunular için başlangıç içerikleri.
// Tümü kod içinde üretilir; dışarıdan hiçbir şey indirilmez.
import { parseInput } from './sheet/formula.js';
import { key } from './sheet/model.js';
import { newSlide, DEF_W, DEF_H } from './slides/model.js';
import { themeById, applyThemeToSlide } from './slides/themes.js';

const today = () => new Date().toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' });

// ---- Word ------------------------------------------------------------------------------------
const cvHtml = () => `
<h1 style="text-align: left; color: #1f3864; margin-bottom: 0">Adınız Soyadınız</h1>
<p style="color: #595959; margin-top: 4px">Unvanınız · Şehir · e-posta@ornek.com · 0 (5xx) xxx xx xx</p>
<h2 style="color: #1f3864; border-bottom: 2px solid #1f3864">Özet</h2>
<p>Deneyiminizi, öne çıkan yeteneklerinizi ve hedeflerinizi iki üç cümleyle anlatın.</p>
<h2 style="color: #1f3864; border-bottom: 2px solid #1f3864">İş deneyimi</h2>
<p><strong>Pozisyon</strong> — Şirket adı <span style="color: #595959">(2022 – Günümüz)</span></p>
<ul><li>Sorumluluklarınız ve başardığınız işler</li><li>Ölçülebilir bir sonuç (ör. satışları %20 artırdım)</li></ul>
<p><strong>Pozisyon</strong> — Şirket adı <span style="color: #595959">(2019 – 2022)</span></p>
<ul><li>Sorumluluklarınız ve başardığınız işler</li></ul>
<h2 style="color: #1f3864; border-bottom: 2px solid #1f3864">Eğitim</h2>
<p><strong>Bölüm</strong> — Üniversite adı <span style="color: #595959">(2015 – 2019)</span></p>
<h2 style="color: #1f3864; border-bottom: 2px solid #1f3864">Yetenekler</h2>
<ul><li>Yetenek 1</li><li>Yetenek 2</li><li>Yabancı dil: İngilizce (ileri)</li></ul>
<h2 style="color: #1f3864; border-bottom: 2px solid #1f3864">Referanslar</h2>
<p>İstendiğinde verilecektir.</p>`;

const letterHtml = () => `
<p style="text-align: right">${today()}</p>
<p><br></p>
<p style="text-align: center"><strong>İLGİLİ MAKAMA / KURUM ADI</strong></p>
<p><br></p>
<p>Konu: Dilekçenizin konusu</p>
<p><br></p>
<p>Sayın Yetkili,</p>
<p>Buraya dilekçenizin ya da mektubunuzun metnini yazın. Talebinizi açık ve kısa biçimde belirtin.</p>
<p>Gereğinin yapılmasını saygılarımla arz ederim.</p>
<p><br></p>
<p style="text-align: right">Ad Soyad<br>İmza</p>
<p><br></p>
<p><strong>Adres:</strong> Açık adresiniz</p>
<p><strong>Telefon:</strong> 0 (5xx) xxx xx xx</p>
<p><strong>Ekler:</strong> 1) Ek belge</p>`;

const meetingHtml = () => `
<h1 style="color: #1f3864">Toplantı notu</h1>
<table style="width: 100%; border-collapse: collapse">
<tr><td style="border: 1px solid #bfbfbf; padding: 6px; width: 30%; background-color: #f2f2f2"><strong>Tarih</strong></td><td style="border: 1px solid #bfbfbf; padding: 6px">${today()}</td></tr>
<tr><td style="border: 1px solid #bfbfbf; padding: 6px; background-color: #f2f2f2"><strong>Yer</strong></td><td style="border: 1px solid #bfbfbf; padding: 6px">Toplantı odası / çevrim içi</td></tr>
<tr><td style="border: 1px solid #bfbfbf; padding: 6px; background-color: #f2f2f2"><strong>Katılımcılar</strong></td><td style="border: 1px solid #bfbfbf; padding: 6px">Ad Soyad, Ad Soyad</td></tr>
</table>
<h2 style="color: #1f3864">Gündem</h2>
<ol><li>Konu 1</li><li>Konu 2</li><li>Konu 3</li></ol>
<h2 style="color: #1f3864">Görüşülenler</h2>
<p>Toplantıda konuşulanları özetleyin.</p>
<h2 style="color: #1f3864">Alınan kararlar</h2>
<ul><li>Karar 1</li></ul>
<h2 style="color: #1f3864">Yapılacaklar</h2>
<table style="width: 100%; border-collapse: collapse">
<tr><td style="border: 1px solid #bfbfbf; padding: 6px; background-color: #1f3864; color: #ffffff"><strong>Görev</strong></td><td style="border: 1px solid #bfbfbf; padding: 6px; background-color: #1f3864; color: #ffffff"><strong>Sorumlu</strong></td><td style="border: 1px solid #bfbfbf; padding: 6px; background-color: #1f3864; color: #ffffff"><strong>Son tarih</strong></td></tr>
<tr><td style="border: 1px solid #bfbfbf; padding: 6px">Görev açıklaması</td><td style="border: 1px solid #bfbfbf; padding: 6px">Ad Soyad</td><td style="border: 1px solid #bfbfbf; padding: 6px">gg.aa.yyyy</td></tr>
<tr><td style="border: 1px solid #bfbfbf; padding: 6px"><br></td><td style="border: 1px solid #bfbfbf; padding: 6px"><br></td><td style="border: 1px solid #bfbfbf; padding: 6px"><br></td></tr>
</table>
<p><br></p>
<p><strong>Sonraki toplantı:</strong> gg.aa.yyyy</p>`;

// ---- Tablo (Excel) ---------------------------------------------------------------------------
const colIdx = (letters) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
function a1(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  return { r: +m[2] - 1, c: colIdx(m[1]) };
}

/** Küçük bir tablo kurucu: hücreleri A1 adresleriyle yazar, stilleri paylaşır. */
function sheetBuilder(name) {
  const styles = [];
  const styleIdx = new Map();
  const cells = new Map();
  const sh = { name, colW: [], rowH: [], merges: [], freeze: { r: 0, c: 0 }, grid: true };
  const sid = (s) => {
    if (!s) return undefined;
    const j = JSON.stringify(s);
    if (!styleIdx.has(j)) styleIdx.set(j, styles.push(s) - 1);
    return styleIdx.get(j);
  };
  const api = {
    set(ref, text, style) {
      const { r, c } = a1(ref);
      const p = parseInput(text == null ? '' : String(text));
      const o = {};
      if (p.v !== undefined && p.v !== null) o.v = p.v;
      if (p.f) o.f = p.f;
      const st = { ...(p.z ? { z: p.z } : {}), ...(style || {}) };
      const s = sid(Object.keys(st).length ? st : null);
      if (s !== undefined) o.s = s;
      cells.set(key(r, c), o);
      return api;
    },
    row(ref, values, style) {
      const { r, c } = a1(ref);
      values.forEach((v, i) => {
        if (v === undefined) return;
        const col = String.fromCharCode(65 + c + i);
        api.set(col + (r + 1), v, typeof style === 'function' ? style(i) : style);
      });
      return api;
    },
    width(col, w) { sh.colW.push([colIdx(col), w]); return api; },
    height(row, hh) { sh.rowH.push([row - 1, hh]); return api; },
    merge(from, to) { const a = a1(from), b = a1(to); sh.merges.push({ r1: a.r, c1: a.c, r2: b.r, c2: b.c }); return api; },
    freeze(r, c = 0) { sh.freeze = { r, c }; return api; },
    build() { return { ...sh, cells: [...cells] }; },
    styles,
  };
  return api;
}

function workbook(builder) {
  // Tek sayfalık kitap; stiller kurucudan gelir.
  return { v: 1, active: 0, names: {}, styles: builder.styles, sheets: [builder.build()] };
}

const BORDER = '#bfbfbf';
const boxed = (extra = {}) => ({ bt: BORDER, bb: BORDER, bl: BORDER, br: BORDER, ...extra });
const HEAD = (bg) => boxed({ b: true, fc: '#ffffff', bg, ha: 'center', va: 'middle' });
const TL = '#,##0.00 "₺"';

function invoiceSheet() {
  const b = sheetBuilder('Fatura');
  b.width('A', 40).width('B', 260).width('C', 80).width('D', 110).width('E', 120);
  b.set('B2', 'FATURA', { b: true, fs: 22, fc: '#1f3864' });
  b.set('B3', 'Şirket adınız · Adres · Vergi dairesi / no', { fc: '#595959' });
  b.set('D2', 'Fatura no', { b: true, ha: 'right' }).set('E2', '2026-001', { ha: 'right' });
  b.set('D3', 'Tarih', { b: true, ha: 'right' }).set('E3', today(), { ha: 'right', z: 'dd.mm.yyyy' });
  b.set('B5', 'Sayın', { b: true }).set('B6', 'Müşteri adı').set('B7', 'Müşteri adresi');
  b.height(9, 28);
  b.row('B9', ['Açıklama', 'Miktar', 'Birim fiyat', 'Tutar'], HEAD('#1f3864'));
  const items = [['Ürün veya hizmet 1', 2, 150], ['Ürün veya hizmet 2', 1, 400], ['Ürün veya hizmet 3', 5, 35]];
  for (let i = 0; i < 6; i++) {
    const r = 10 + i;
    const [d, q, p] = items[i] || ['', '', ''];
    b.set('B' + r, d, boxed());
    b.set('C' + r, q, boxed({ ha: 'center' }));
    b.set('D' + r, p, boxed({ z: TL }));
    b.set('E' + r, `=EĞER(C${r}="";"";C${r}*D${r})`, boxed({ z: TL }));
  }
  b.set('D17', 'Ara toplam', { b: true, ha: 'right' }).set('E17', '=TOPLA(E10:E15)', boxed({ z: TL }));
  b.set('C18', '20%', { ha: 'right', z: '0%' }).set('D18', 'KDV', { b: true, ha: 'right' }).set('E18', '=E17*C18', boxed({ z: TL }));
  b.set('D19', 'Genel toplam', { b: true, ha: 'right' }).set('E19', '=E17+E18', boxed({ b: true, z: TL, bg: '#d9e2f3' }));
  b.set('B22', 'Ödeme bilgileri: Banka adı · IBAN TRxx xxxx xxxx xxxx xxxx xxxx xx', { fc: '#595959' });
  b.set('B23', 'Teşekkür ederiz!', { i: true, fc: '#1f3864' });
  return workbook(b);
}

function budgetSheet() {
  const b = sheetBuilder('Aylık bütçe');
  b.width('A', 200).width('B', 120).width('C', 120).width('D', 120);
  b.set('A1', 'Aylık bütçe', { b: true, fs: 20, fc: '#2d5a27' });
  b.height(3, 26).row('A3', ['Gelirler', 'Planlanan', 'Gerçekleşen', 'Fark'], HEAD('#6a994e'));
  const inc = [['Maaş', 30000, 30000], ['Ek gelir', 3000, 2500], ['Diğer', 0, 0]];
  inc.forEach(([n, p, g], i) => {
    const r = 4 + i;
    b.row('A' + r, [n, p, g, `=C${r}-B${r}`], (k) => boxed(k ? { z: TL } : {}));
  });
  b.row('A7', ['Toplam gelir', '=TOPLA(B4:B6)', '=TOPLA(C4:C6)', '=C7-B7'], (k) => boxed({ b: true, bg: '#e9f2e3', ...(k ? { z: TL } : {}) }));
  b.height(9, 26).row('A9', ['Giderler', 'Planlanan', 'Gerçekleşen', 'Fark'], HEAD('#bc4749'));
  const exp = [['Kira', 12000, 12000], ['Faturalar (elektrik, su, doğalgaz)', 2500, 2800], ['İnternet ve telefon', 800, 800],
    ['Market', 6000, 6400], ['Ulaşım', 2000, 1700], ['Sağlık', 500, 0], ['Eğlence', 1500, 1900], ['Birikim', 5000, 5000], ['Diğer', 1000, 600]];
  exp.forEach(([n, p, g], i) => {
    const r = 10 + i;
    b.row('A' + r, [n, p, g, `=B${r}-C${r}`], (k) => boxed(k ? { z: TL } : {}));
  });
  b.row('A19', ['Toplam gider', '=TOPLA(B10:B18)', '=TOPLA(C10:C18)', '=B19-C19'], (k) => boxed({ b: true, bg: '#f6e3e3', ...(k ? { z: TL } : {}) }));
  b.row('A21', ['Kalan', '=B7-B19', '=C7-C19'], (k) => boxed({ b: true, fs: 13, bg: '#d9e2f3', ...(k ? { z: TL } : {}) }));
  b.set('A23', 'Fark sütunu: gelirde fazlası, giderde tasarrufu gösterir (artı değer iyidir).', { i: true, fc: '#595959' });
  b.freeze(3);
  return workbook(b);
}

function todoSheet() {
  const b = sheetBuilder('Yapılacaklar');
  b.width('A', 40).width('B', 280).width('C', 110).width('D', 100).width('E', 110).width('F', 160);
  b.set('B1', 'Yapılacaklar listesi', { b: true, fs: 20, fc: '#1f3864' });
  b.set('B2', '=EĞERSAY(E4:E40;"Tamamlandı")&" / "&BAĞ_DEĞ_DOLU_SAY(B4:B40)&" görev tamamlandı"', { fc: '#595959' });
  b.height(3, 26).row('A3', ['#', 'Görev', 'Son tarih', 'Öncelik', 'Durum', 'Not'], HEAD('#1f3864'));
  const rows = [['Raporu hazırla', 'Yüksek', 'Devam ediyor'], ['Toplantı ayarla', 'Orta', 'Tamamlandı'], ['Faturaları öde', 'Yüksek', 'Başlamadı']];
  for (let i = 0; i < 12; i++) {
    const r = 4 + i;
    const [g, p, s] = rows[i] || ['', '', ''];
    b.set('A' + r, i + 1, boxed({ ha: 'center', fc: '#7f7f7f' }));
    b.set('B' + r, g, boxed());
    b.set('C' + r, rows[i] ? today() : '', boxed({ ha: 'center', z: 'dd.mm.yyyy' }));
    b.set('D' + r, p, boxed({ ha: 'center' }));
    b.set('E' + r, s, boxed({ ha: 'center' }));
    b.set('F' + r, '', boxed());
  }
  b.freeze(3);
  return workbook(b);
}

// ---- Sunu ------------------------------------------------------------------------------------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const para = (t) => `<p>${esc(t)}</p>`;
const list = (items) => items.map(para).join('');

function fill(slide, texts) {
  let i = 0;
  slide.items = slide.items.map((it) => (it.type === 'text' && texts[i] !== undefined ? { ...it, html: texts[i++] } : it));
  return slide;
}

function deck(themeId, slides) {
  const th = themeById(themeId);
  return { v: 1, w: DEF_W, h: DEF_H, theme: themeId, slides: slides.map((s) => applyThemeToSlide(s, th)) };
}

function accentBar(themeId, y = 0, h = 12) {
  const th = themeById(themeId);
  return { id: 'bar-' + Math.random().toString(36).slice(2, 8), type: 'shape', shape: 'rect', x: 0, y, w: DEF_W, h, fill: th.accent, stroke: 'none', strokeW: 0 };
}

function businessDeck(themeId) {
  const s1 = fill(newSlide('title'), [para('Proje sunumu'), para('Ekip adı · ' + today())]);
  s1.items.push(accentBar(themeId, DEF_H - 16, 16));
  const s2 = fill(newSlide('content'), [para('Gündem'), list(['Amaç ve kapsam', 'Mevcut durum', 'Öneriler', 'Zaman planı', 'Sorular'])]);
  const s3 = fill(newSlide('section'), [para('Mevcut durum'), para('Nereden başlıyoruz?')]);
  const s4 = fill(newSlide('two'), [para('Güçlü ve zayıf yönler'), list(['Güçlü yön 1', 'Güçlü yön 2', 'Güçlü yön 3']), list(['Geliştirilecek alan 1', 'Geliştirilecek alan 2'])]);
  const s5 = fill(newSlide('content'), [para('Zaman planı'), list(['1. ay: Hazırlık', '2. ay: Uygulama', '3. ay: Değerlendirme'])]);
  const s6 = fill(newSlide('title'), [para('Teşekkürler'), para('Sorularınız?')]);
  for (const s of [s2, s4, s5]) s.items.push(accentBar(themeId, 0, 8));
  return deck(themeId, [s1, s2, s3, s4, s5, s6]).slides.map((s, i) => ({ ...s, transition: i ? 'fade' : undefined }));
}

function classDeck(themeId) {
  const s1 = fill(newSlide('title'), [para('Ders konusu'), para('Ad Soyad · Sınıf')]);
  const s2 = fill(newSlide('content'), [para('Öğrenme hedefleri'), list(['Bu derste ... öğreneceğiz', 'Temel kavramlar', 'Örnekler ve alıştırmalar'])]);
  const s3 = fill(newSlide('content'), [para('Temel kavramlar'), list(['Kavram 1: kısa açıklama', 'Kavram 2: kısa açıklama', 'Kavram 3: kısa açıklama'])]);
  const s4 = fill(newSlide('two'), [para('Örnek'), list(['Adım 1', 'Adım 2', 'Adım 3']), list(['Sonuç', 'Yorum'])]);
  const s5 = fill(newSlide('content'), [para('Özet'), list(['Önemli nokta 1', 'Önemli nokta 2', 'Ödev: ...'])]);
  return deck(themeId, [s1, s2, s3, s4, s5]).slides.map((s, i) => ({ ...s, transition: i ? 'push' : undefined }));
}

// ---- Liste ---------------------------------------------------------------------------------
export const TEMPLATES = [
  { id: 'cv', kind: 'word', name: 'Özgeçmiş (CV)', title: 'Özgeçmiş', data: () => ({ html: cvHtml() }) },
  { id: 'letter', kind: 'word', name: 'Dilekçe / mektup', title: 'Dilekçe', data: () => ({ html: letterHtml() }) },
  { id: 'meeting', kind: 'word', name: 'Toplantı notu', title: 'Toplantı notu', data: () => ({ html: meetingHtml() }) },
  { id: 'invoice', kind: 'sheet', name: 'Fatura', title: 'Fatura', data: invoiceSheet },
  { id: 'budget', kind: 'sheet', name: 'Aylık bütçe', title: 'Aylık bütçe', data: budgetSheet },
  { id: 'todo', kind: 'sheet', name: 'Yapılacaklar', title: 'Yapılacaklar', data: todoSheet },
  { id: 'pitch', kind: 'slides', name: 'İş sunumu', title: 'Proje sunumu', data: () => ({ v: 1, w: DEF_W, h: DEF_H, theme: 'ocean', slides: businessDeck('ocean') }) },
  { id: 'night', kind: 'slides', name: 'Gece teması sunu', title: 'Sunu', data: () => ({ v: 1, w: DEF_W, h: DEF_H, theme: 'night', slides: businessDeck('night') }) },
  { id: 'lesson', kind: 'slides', name: 'Ders anlatımı', title: 'Ders sunumu', data: () => ({ v: 1, w: DEF_W, h: DEF_H, theme: 'forest', slides: classDeck('forest') }) },
];

export const templateById = (id) => TEMPLATES.find((t) => t.id === id) || null;
