# Offisea

<img src="public/icons/icon.svg" width="96" alt="Offisea logosu" align="right">

- **Web sürümü:** https://suslu22.github.io/offisea/
- **Android (APK) ve Windows (EXE) indir:** https://suslu22.github.io/offisea/indir/ ([Releases](https://github.com/suslu22/offisea/releases/latest))

Ücretsiz, reklamsız ve çevrimdışı çalışan ofis uygulaması. Tek kod tabanından üç sürüm çıkar:

| Sürüm | Nasıl kullanılır |
|---|---|
| **Web / PWA** | Tarayıcıdan açılır; telefonda ve bilgisayarda "Ana ekrana ekle / Yükle" ile uygulama gibi kurulur, internetsiz de çalışır. |
| **Windows** | Kurulum dosyası (`Offisea-Kurulum-x64.exe`, ARM için `-arm64`, ikisini birden içeren `Offisea-Kurulum.exe`) veya kurulumsuz taşınabilir sürüm (`Offisea-Tasinabilir.exe`). |
| **Android** | `Offisea.apk` (Android 7.0 ve üzeri). |

Her üç sürüm de aynı özelliklere sahiptir.

## Özellikler

- **Belge (Word):** `.docx`, `.odt`, `.rtf`, `.txt`, `.md`, `.html` açar; `.docx`, `.html`, `.txt` olarak kaydeder, PDF olarak yazdırır. Başlıklar, yazı tipi ve renkler, listeler, tablolar, resimler, bağlantılar, bul-değiştir, sayfa yazdırma.
- **Tablo (Excel):** `.xlsx`, `.xlsm`, `.xls`, `.xlsb`, `.ods`, `.csv`, `.tsv` açar; `.xlsx`, `.ods`, `.csv` olarak kaydeder, PDF olarak yazdırır. Çok sayfa, 100'den fazla formül (Türkçe adlarıyla da: `TOPLA`, `EĞER`, `DÜŞEYARA`…), biçimlendirme, sıralama, birleştirilmiş hücreler, sabitlenmiş satır/sütun.
- **Sunu (PowerPoint):** `.pptx`, `.ppsx`, `.potx` açar; `.pptx` olarak kaydeder, PDF olarak yazdırır. Metin kutuları, şekiller, resimler, tablolar, konuşmacı notları, tam ekran slayt gösterisi.
- **PDF görüntüleyici:** Metin seçme ve arama, yakınlaştırma, bağlantılar, yazdırma.
- **PDF olarak kaydetme / yazdırma** her sürümde vardır: web ve Windows'ta yazdırma penceresi, Android'de sistemin yazdırma ekranı ("PDF olarak kaydet" seçeneğiyle) açılır.
- Otomatik kaydetme (belgeler yalnızca bu cihazda tutulur), son belgeler listesi, açık/koyu tema, dokunmatik ve klavye kullanımı.
- **Deniz camı görünümü:** Üst çubuk, menüler, pencereler ve bildirimlerde buzlu cam efekti; kenarlarda dalga renklerinde ince bir parıltı. Bulanıklık yalnızca küçük, sabit yüzeylerde kullanılır (kaydırılan içerikte asla) ve telefonlarda daha hafif uygulanır. Zayıf cihazlarda (az bellek, 4 veya daha az çekirdek, veri tasarrufu, sistemde "şeffaflığı azalt") ya da açılıştaki kısa akıcılık ölçümünde zorlanan cihazlarda kendiliğinden kapanır. "Ayarlar ve hakkında" penceresinden açılıp kapatılabilir.
- **Kendini güncelleme:** Yeni sürümler için APK/EXE indirmeye gerek yoktur; yalnızca değişen dosyalar indirilir (aşağıda "Güncellemeler").
- **Düşük donanımlı telefonlarda hızlı:** Açılışta yalnızca ~26 KB (sıkıştırılmış) yüklenir; Word/Excel/PDF kütüphaneleri ancak o tür belge açılınca gelir. Telefonlarda ve az bellekli cihazlarda kendiliğinden açılan **hafif mod**, PDF sayfalarını daha az bellekle çizer, bellekte daha az sayfa tutar, pahalı gölgeleri sadeleştirir ve otomatik kaydı cihaz boştayken yapar. "Ayarlar ve hakkında" penceresinden elle açılıp kapatılabilir.

Desteklenmeyenler: eski ikili `.doc` ve `.ppt` biçimleri (uygulama, dosyayı `.docx`/`.pptx` olarak kaydetmenizi söyler) ve `.odp`.

## Güvenlik

Uygulama, belge açan yazılımlarda sık görülen ve son dönemde gündeme gelen açık türlerine karşı baştan kapalı tasarlandı:

| Tehdit | Önlem |
|---|---|
| Makro virüsleri, gömülü OLE nesneleri | VBA makroları ve OLE nesneleri hiçbir zaman çalıştırılmaz. |
| Kötü amaçlı PDF (PDF içi JavaScript, XFA formları, pdf.js açıkları) | Güncel pdf.js 6; `isEvalSupported` ve XFA kapalı, JavaScript motoru dosyaları pakete hiç eklenmez. |
| Belge içinden betik çalıştırma (XSS) | Tüm içerik güncel DOMPurify ile temizlenir; sıkı İçerik Güvenlik Politikası (CSP) satır içi betiği ve dış bağlantıyı engeller. |
| Uzak resim / şablon ile izleme ve Windows NTLM parola özeti sızıntısı | Belgelerdeki uzak adresler otomatik yüklenmez; CSP ve masaüstünde ağ filtresi tüm dış istekleri keser. |
| ZIP bombası, dev dosyalar | Açılmış boyut ve dosya sayısı sınırlı; en fazla 150 MB dosya. |
| XML dış varlıkları (XXE) | Belgeler tarayıcının güvenli XML ayrıştırıcısıyla okunur; dış varlıklar ve dış dosyalar hiçbir zaman çözülmez. |
| Formül enjeksiyonu (CSV/DDE) | Formüller kendi motorumuzla hesaplanır (`eval` yok); CSV dışa aktarımında `= + - @` ile başlayan hücreler etkisizleştirilir. |
| Resimlerde gizli konum bilgisi | Eklenen resimlerin EXIF/GPS bilgileri silinir. |
| Electron (Windows) açıkları | Güncel Electron 45; sandbox, `contextIsolation`, Node.js kapalı, `webview` kapalı, yalıtılmış `app://` protokolü ve yol geçişi koruması, uygulama dışına gezinme ve yeni pencere engeli, izinler en aza indirildi. Electron Fuses ile `RunAsNode`, `NODE_OPTIONS`, `--inspect` kapatıldı; ASAR bütünlük denetimi açık. |
| Android WebView açıkları | Doğrudan dosya/içerik erişimi, konum ve karışık içerik kapalı; şifresiz HTTP yasak; yedekleme ve cihazdan cihaza aktarım kapalı; paylaşım yalnızca `Belgeler/Offisea` klasörüyle sınırlı; WebView hata ayıklama kapalı. |
| Tedarik zinciri saldırıları | Tüm bağımlılıklar `package-lock.json` ile sabit; çalışma zamanında hiçbir CDN kullanılmaz; GitHub Actions eylemleri commit SHA'sı ile sabitlendi; derlemede `npm audit` çalışır. |

Belgeler hiçbir sunucuya gönderilmez, hesap gerekmez, analiz/izleme kodu yoktur.

## Güncellemeler

Offisea, yeni bir kurulum dosyası indirmeden kendini günceller. Uygulamanın arayüzü ve tüm belge işleme kodu web dosyalarından oluşur; güncellemede yalnızca bu dosyalardan **değişenler** indirilir (tipik bir güncelleme birkaç yüz KB'dır).

| Sürüm | Nasıl güncellenir |
|---|---|
| Web / PWA | Service worker yalnızca değişen dosyaları indirir. "Şimdi yeniden başlat" ile ya da bir sonraki açılışta etkinleşir. |
| Android | Uygulama, imzalı güncelleme listesini okur, değişen dosyaları indirip doğrular. Otomatik denetim yalnızca Wi-Fi gibi kotasız ağlarda yapılır. Yeni sürüm bir sonraki açılışta (ya da "Şimdi yeniden başlat" ile) yüklenir. |
| Windows | Android ile aynı yöntem. Dosyalar kullanıcı klasöründe saklanır ve her açılışta doğrulanır. |

**Güvenlik:**

- Her güncelleme listesi ECDSA P-256 ile imzalanır. Açık anahtar uygulamanın içinde gelir ve imzası tutmayan güncelleme reddedilir.
- Listedeki her dosyanın SHA-256 özeti, indirmeden sonra ve her açılışta denetlenir. Değiştirilmiş bir dosya varsa kurulumla gelen sürüm açılır.
- Yalnızca HTTPS kullanılır. Dosya adlarında `../` gibi yol geçişleri ve aşırı büyük dosyalar reddedilir.
- Eski bir sürüme geri düşürme kabul edilmez.
- Yeni sürüm açılamazsa iki denemeden sonra otomatik olarak önceki sürüme dönülür ve o sürüm bir daha indirilmez. "Hakkında" penceresinde "Kurulumla gelen sürüme dön" düğmesi de vardır.

### GitHub ile yayınlama (bu depo böyle kurulu)

Güncelleme sunucusu bu deponun **GitHub Pages** sayfasıdır: `https://suslu22.github.io/offisea/`.

1. Kodda değişiklik yapın ve `main` dalına gönderin (`git push`).
2. GitHub Actions uygulamayı derler, `update.json` dosyasını `OFFISEA_UPDATE_KEY` sırrıyla imzalar ve GitHub Pages'e yayınlar.
3. Web, Android ve Windows kullanıcıları bir sonraki denetimde (açılıştan kısa süre sonra, en fazla 6 saatte bir) yeni sürümü alır. Yeni APK/EXE gerekmez.

İlk kez yükleyecekler için yeni kurulum dosyaları yayınlamak isterseniz `package.json` içindeki sürümü artırıp bir etiket gönderin:

```bash
git tag v1.0.1
```

```bash
git push origin v1.0.1
```

APK ve EXE dosyaları otomatik olarak [Releases](https://github.com/suslu22/offisea/releases) sayfasına eklenir.

**Anahtarlar:** Güncelleme imza anahtarı (`offisea-update-private.pem`) ve Android uygulama imza anahtarı (`offisea-android.p12` ve parolası) bilgisayardaki **Belgeler\Offisea** klasöründe saklanır. GitHub'da yalnızca şifreli depo sırları (Secrets) olarak bulunur, depoya asla eklenmez. Bu dosyaları yedekleyin ve kimseyle paylaşmayın: güncelleme anahtarı kaybolursa kurulu uygulamalar yeni güncellemeleri kabul etmez; Android anahtarı kaybolursa yeni APK eskisinin üzerine kurulamaz.

### Başka bir sunucuyla yayınlama

1. `npm run update-key` ile yeni bir imza anahtarı üretin (gizli anahtar `keys/update-private.pem` dosyasına, açık anahtar `update.config.json` dosyasına yazılır).
2. Web sürümünü yayınlayacağınız HTTPS adresini `update.config.json` dosyasındaki `"url"` alanına, yeni APK/EXE indirme sayfasını `"download"` alanına yazın.
3. `npm run release:web` ile derleyip imzalayın ve `dist/` klasörünün tamamını o adrese yükleyin.

### Notlar

- Sürümlerin sırasını derleme numarası belirler; varsayılan olarak derleme zamanıdır. CI'da tüm işler aynı numarayı (commit zamanı) `OFFISEA_BUILD` ortam değişkeniyle alır.
- Android veya Windows'un yerel kodunda yeni bir özellik gereken bir değişiklik yaptıysanız `vite.config.js` içindeki `MIN_SHELL` değerini, Android'de `UpdateStore.SHELL` ve Windows'ta `electron/updater.cjs` içindeki kabuk seviyesini birlikte artırın. Eski kurulumlar bu güncellemeyi indirmez; kullanıcıya bir kez yeni APK/EXE yüklemesi gerektiği söylenir.
- Güncelleme istemcileri `update.json` dosyasını önbelleği atlayarak, diğer dosyaları içerik özetine bağlı adreslerle ister; böylece GitHub Pages'in önbelleği eski dosya döndüremez.

## Geliştirme

Gereken: Node.js 22 veya üzeri.

```bash
npm install
```

```bash
npm run dev
```

Tarayıcıda `http://localhost:5173` adresini açın.

## Derleme

### Web / PWA

```bash
npm run build
```

`dist/` klasörü herhangi bir statik sunucuya (GitHub Pages, Netlify, Cloudflare Pages, nginx…) yüklenir. İçerik Güvenlik Politikası (CSP) sayfanın içinde gelir, bu yüzden her sunucuda geçerlidir. `public/_headers` dosyası Netlify ve Cloudflare Pages için ek güvenlik başlıklarını (HSTS, X-Frame-Options vb.) ayarlar; GitHub Pages bu dosyayı kullanmaz. PWA kurulumu için site HTTPS üzerinden sunulmalıdır.

### Windows

Windows bilgisayarda:

```bash
npm run dist:win
```

Çıktılar `release/` klasörüne yazılır: `Kurulum-x64` (çoğu bilgisayar), `Kurulum-arm64` (ARM işlemcili Windows), ikisini birden içeren `Kurulum.exe` ve kurulumsuz `Tasinabilir.exe`. Proje klasörünün yolu çok uzunsa (260 karakter sınırı) kurulum adımı hata verir; projeyi `C:\offisea` gibi kısa bir yola taşıyın. Dağıtım için kod imzalama sertifikası önerilir (yoksa Windows SmartScreen uyarı gösterebilir).

### Android

Gereken: Java 21 ve Android SDK (Android Studio ile gelir).

```bash
npm run android:sync
```

Ardından `android` klasörünü Android Studio ile açıp **Build › Generate Signed App Bundle / APK** seçin, ya da komut satırından imzalı APK için `OFFISEA_KEYSTORE`, `OFFISEA_KEYSTORE_PASSWORD`, `OFFISEA_KEY_ALIAS`, `OFFISEA_KEY_PASSWORD` ortam değişkenlerini tanımlayıp `npm run android:apk` çalıştırın.

### Otomatik derleme (GitHub Actions)

`.github/workflows/build.yml` her gönderimde web, Windows ve Android sürümlerini derler; dosyalar çalıştırmanın **Artifacts** bölümünden de indirilebilir.

- `main` dalında web sürümü imzalanıp GitHub Pages'e (güncelleme sunucusu) yayınlanır. `v*` etiketlerinde APK ve EXE, Releases sayfasına eklenir.
- Depo sırları (Settings › Secrets and variables › Actions): `OFFISEA_UPDATE_KEY` (güncelleme imza anahtarı); `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` (Android imzası); isteğe bağlı Windows kod imzası için `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`.
- Android imza sırları yoksa test amaçlı `Offisea-test.apk` üretilir.
- `OFFISEA_UPDATE_URL` değişkeni (Variables) tanımlanırsa `update.config.json` içindeki adresin yerine geçer.
- Her iş yalnızca gereken izinle çalışır: Pages'e yalnızca yayın işi, depoya yalnızca Releases işi yazabilir. Tüm eylemler commit SHA'sıyla sabitlenmiştir.

## Proje yapısı

```
src/
  main.js            Uygulama kabuğu: yönlendirme, otomatik kayıt, dosya açma
  home.js            Giriş ekranı
  core/              Ortak modüller (arayüz, depolama, dosya güvenliği, platform,
                     güncelleme istemcisi updater.js, hafif mod ve cam görünüm perf.js, tema theme.js)
  word/              Belge düzenleyici, DOCX/ODT/RTF içe-dışa aktarım
  sheet/             Tablo düzenleyici, formül motoru, XLSX/ODS/CSV
  slides/            Sunu düzenleyici, PPTX içe-dışa aktarım
  pdf/               PDF görüntüleyici
electron/            Windows masaüstü (ana süreç, önyükleme betiği, updater.cjs)
android/             Android projesi (Capacitor)
public/              Simgeler, PWA bildirimi, güvenlik başlıkları
scripts/             Yardımcı betikler (pdf.js varlıkları, simgeler, güncelleme anahtarı ve imzalama)
update.config.json   Güncelleme adresi ve açık anahtar
```

## Güncel tutma

Yeni güvenlik açıklarından korunmak için bağımlılıkları düzenli güncelleyin:

```bash
npm audit
```

```bash
npm update
```

Özellikle Electron, pdf.js, DOMPurify ve SheetJS sürümlerini takip edin; güncellemeden sonra değişikliği `main` dalına gönderin; GitHub yeni sürümü yayınlar. Kullanıcılar yeni kurulum dosyası indirmeden güncellenir.

## Lisans

Ücretsiz kullanım içindir. Kullanılan açık kaynak kütüphaneler kendi lisanslarına tabidir (pdf.js: Apache-2.0, SheetJS CE: Apache-2.0, DOMPurify: MPL-2.0/Apache-2.0, docx: MIT, JSZip: MIT/GPLv3, PptxGenJS: MIT, Electron: MIT, Capacitor: MIT).
