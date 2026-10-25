// Platform farkları: web (PWA), Windows (Electron) ve Android (Capacitor).
import { toast } from './ui.js';
import { safeFileName } from './files.js';

export function isNative() {
  return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
}

export function isElectron() {
  return !!window.offiseaDesktop;
}

// Platform çalışma anında belirlenir; böylece aynı web paketi web, Android ve Windows'ta
// çalışır ve uygulamalar yeni sürümü yeni kurulum dosyası indirmeden alabilir.
export const PLATFORM = isElectron() ? 'electron' : isNative() ? 'android' : 'web';

// Android WebView window.print() desteklemez; orada uygulamanın kendi yazdırma eklentisi
// (Android yazdırma servisi: yazıcı veya "PDF olarak kaydet") kullanılır.
export function canPrint() {
  return isNative() ? PLATFORM === 'android' : typeof window.print === 'function';
}

let nativePrinter = null;
async function nativePrint() {
  if (!nativePrinter) {
    const { registerPlugin } = await import('@capacitor/core');
    nativePrinter = registerPlugin('OffiseaPrint');
  }
  const name = (document.title || 'Offisea').replace(/\s+[-–]\s+Offisea$/, '');
  await nativePrinter.print({ name });
}

export function isSafeUrl(url) {
  try {
    const u = new URL(url);
    return ['http:', 'https:', 'mailto:'].includes(u.protocol);
  } catch {
    return false;
  }
}

export function openExternal(url) {
  if (!isSafeUrl(url)) { toast('Bu bağlantı güvenli değil, açılmadı.', { type: 'error' }); return; }
  if (isNative()) { window.location.href = url; return; }
  window.open(url, '_blank', 'noopener,noreferrer');
}

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

const TYPE_DESC = {
  docx: 'Word belgesi', xlsx: 'Excel çalışma kitabı', pptx: 'PowerPoint sunusu', pdf: 'PDF',
  html: 'Web sayfası', txt: 'Düz metin', csv: 'CSV', ods: 'OpenDocument tablo', md: 'Markdown',
};

// Dosyayı kullanıcının cihazına kaydeder. true: kaydedildi, false: iptal edildi.
export async function saveBlob(blob, filename) {
  filename = safeFileName(filename);
  const ext = (filename.split('.').pop() || '').toLowerCase();

  if (isNative()) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    const data = await blobToBase64(blob);
    try {
      const r = await Filesystem.writeFile({ path: `Offisea/${filename}`, data, directory: Directory.Documents, recursive: true });
      toast(`Belgeler/Offisea klasörüne kaydedildi: ${filename}`, {
        type: 'success', timeout: 6000,
        action: { label: 'Paylaş', onClick: () => Share.share({ title: filename, files: [r.uri] }).catch(() => {}) },
      });
      return true;
    } catch {
      const r = await Filesystem.writeFile({ path: filename, data, directory: Directory.Cache });
      await Share.share({ title: filename, files: [r.uri], dialogTitle: 'Dosyayı kaydet veya paylaş' }).catch(() => {});
      return true;
    }
  }

  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const opts = { suggestedName: filename };
      if (TYPE_DESC[ext] && blob.type) opts.types = [{ description: TYPE_DESC[ext], accept: { [blob.type]: ['.' + ext] } }];
      const handle = await window.showSaveFilePicker(opts);
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      toast(`Kaydedildi: ${handle.name}`, { type: 'success' });
      return true;
    } catch (e) {
      if (e && e.name === 'AbortError') return false;
      // Diğer hatalarda klasik indirmeye düş.
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  toast(`İndiriliyor: ${filename}`, { type: 'success' });
  return true;
}

export function printElement(buildContent, { pageCss = '' } = {}) {
  if (!canPrint()) { toast('Bu cihazda yazdırma desteklenmiyor. Dosyayı indirip paylaşabilirsiniz.', { type: 'error' }); return; }
  const area = document.getElementById('print-area');
  while (area.firstChild) area.firstChild.remove();
  const style = document.createElement('style');
  style.textContent = pageCss;
  area.append(style, buildContent());
  document.body.classList.add('printing');
  const cleanup = () => {
    document.body.classList.remove('printing');
    while (area.firstChild) area.firstChild.remove();
    window.removeEventListener('afterprint', cleanup);
  };
  if (isNative()) {
    // Android: yazdırma ekranı kapanana kadar yazdırma görünümü korunur.
    setTimeout(() => {
      nativePrint().catch(() => toast('Yazdırma başlatılamadı.', { type: 'error' })).finally(cleanup);
    }, 50);
    return;
  }
  window.addEventListener('afterprint', cleanup);
  setTimeout(() => { window.print(); setTimeout(cleanup, 1000); }, 50);
}
