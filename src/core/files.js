// Dosya türü tespiti, dosya seçme ve güvenlik kontrolleri.

export const FORMATS = {
  word: ['docx', 'docm', 'dotx', 'dotm', 'odt', 'rtf', 'txt', 'md', 'html', 'htm'],
  sheet: ['xlsx', 'xlsm', 'xltx', 'xltm', 'xls', 'xlsb', 'ods', 'fods', 'csv', 'tsv', 'numbers'],
  slides: ['pptx', 'pptm', 'ppsx', 'ppsm', 'potx', 'potm'],
  pdf: ['pdf'],
};

const LEGACY = {
  doc: 'Eski Word (.doc) biçimi desteklenmiyor. Dosyayı Word veya LibreOffice ile .docx olarak kaydedip tekrar deneyin.',
  ppt: 'Eski PowerPoint (.ppt) biçimi desteklenmiyor. Dosyayı .pptx olarak kaydedip tekrar deneyin.',
  odp: 'OpenDocument sunum (.odp) henüz desteklenmiyor. Dosyayı .pptx olarak kaydedip tekrar deneyin.',
};

export const ACCEPT_ALL = Object.values(FORMATS).flat().map((e) => '.' + e).join(',');
export const MAX_FILE_BYTES = 150 * 1024 * 1024; // 150 MB

export function extOf(name = '') {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : '';
}

export function baseName(name = '') {
  return name.replace(/\.[^.]+$/, '') || 'Adsız';
}

export function kindOf(name) {
  const ext = extOf(name);
  for (const [kind, exts] of Object.entries(FORMATS)) if (exts.includes(ext)) return kind;
  return null;
}

export function legacyMessage(name) {
  return LEGACY[extOf(name)] || null;
}

export function pickFile(accept = ACCEPT_ALL) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    let settled = false;
    const finish = (f) => { if (!settled) { settled = true; input.remove(); resolve(f); } };
    input.addEventListener('change', () => finish(input.files && input.files[0] ? input.files[0] : null));
    input.addEventListener('cancel', () => finish(null));
    document.body.append(input);
    input.click();
  });
}

/** Birden çok dosya seçtirir (iptalde boş dizi). */
export function pickFiles(accept = ACCEPT_ALL) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = true;
    input.style.display = 'none';
    let settled = false;
    const finish = (f) => { if (!settled) { settled = true; input.remove(); resolve(f); } };
    input.addEventListener('change', () => finish(Array.from(input.files || [])));
    input.addEventListener('cancel', () => finish([]));
    document.body.append(input);
    input.click();
  });
}

export function readArrayBuffer(file) {
  if (file.arrayBuffer) return file.arrayBuffer();
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsArrayBuffer(file);
  });
}

export function readText(file) {
  if (file.text) return file.text();
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsText(file);
  });
}

// ---- ZIP bombası koruması ------------------------------------------------------
// Office dosyaları (docx/xlsx/pptx/odt) ZIP arşividir. Küçük bir dosya açıldığında
// gigabaytlarca veriye dönüşebilir ve uygulamayı çökertebilir. Kütüphanelere vermeden
// önce ZIP'in merkez dizinini okuyup toplam açılmış boyutu ve dosya sayısını sınırlıyoruz.
const ZIP_LIMITS = { maxTotal: 1024 * 1024 * 1024, maxEntries: 20000, maxRatio: 200 };

export function checkZip(buffer) {
  const dv = new DataView(buffer);
  const len = buffer.byteLength;
  if (len < 22) throw new Error('Dosya bozuk veya geçerli bir Office dosyası değil.');
  if (dv.getUint32(0, true) !== 0x04034b50) throw new Error('Dosya geçerli bir Office (ZIP) dosyası değil.');
  // Merkez dizin sonu kaydını (EOCD) sondan geriye doğru ara.
  let eocd = -1;
  for (let i = len - 22; i >= Math.max(0, len - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Dosya bozuk: ZIP dizini bulunamadı.');
  const entries = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (entries === 0xffff || cdOffset === 0xffffffff) throw new Error('Çok büyük (ZIP64) dosyalar desteklenmiyor.');
  if (entries > ZIP_LIMITS.maxEntries) throw new Error('Dosya çok fazla parça içeriyor; güvenlik nedeniyle açılmadı.');
  if (cdOffset + cdSize > len) throw new Error('Dosya bozuk: ZIP dizini hatalı.');
  let p = cdOffset, total = 0;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > len || dv.getUint32(p, true) !== 0x02014b50) throw new Error('Dosya bozuk: ZIP kaydı hatalı.');
    const comp = dv.getUint32(p + 20, true);
    const uncomp = dv.getUint32(p + 24, true);
    if (uncomp === 0xffffffff || comp === 0xffffffff) throw new Error('Çok büyük (ZIP64) dosyalar desteklenmiyor.');
    if (comp > 0 && uncomp / comp > ZIP_LIMITS.maxRatio && uncomp > 10 * 1024 * 1024) {
      throw new Error('Dosya şüpheli derecede yüksek sıkıştırma içeriyor (ZIP bombası olabilir); açılmadı.');
    }
    total += uncomp;
    if (total > ZIP_LIMITS.maxTotal) throw new Error('Dosyanın açılmış boyutu çok büyük; güvenlik nedeniyle açılmadı.');
    p += 46 + dv.getUint16(p + 28, true) + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  return true;
}

export function isZip(buffer) {
  return buffer.byteLength > 4 && new DataView(buffer).getUint32(0, true) === 0x04034b50;
}

// XML ayrıştırma: tarayıcının DOMParser'ı dış varlıkları (XXE) çözmez, bu yüzden güvenlidir.
export function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Dosyanın içindeki XML bozuk.');
  return doc;
}

export function mimeFromExt(ext) {
  return ({
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp',
    webp: 'image/webp', svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff',
  })[ext] || null;
}

// Görüntüleri yeniden çizerek EXIF/GPS gibi gizli meta verileri temizler ve boyutu sınırlar.
export async function normalizeImage(blobOrFile, maxDim = 2000) {
  const allowed = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'];
  if (!allowed.includes(blobOrFile.type)) throw new Error('Desteklenmeyen resim türü. PNG, JPEG, GIF, WEBP veya BMP kullanın.');
  if (blobOrFile.size > 40 * 1024 * 1024) throw new Error('Resim çok büyük (en fazla 40 MB).');
  const bmp = await createImageBitmap(blobOrFile);
  let { width, height } = bmp;
  const k = Math.min(1, maxDim / Math.max(width, height));
  width = Math.max(1, Math.round(width * k));
  height = Math.max(1, Math.round(height * k));
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.getContext('2d').drawImage(bmp, 0, 0, width, height);
  bmp.close && bmp.close();
  const type = blobOrFile.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  return { dataUrl: canvas.toDataURL(type, 0.9), width, height };
}

export function dataUrlToBytes(dataUrl) {
  const i = dataUrl.indexOf(',');
  const meta = dataUrl.slice(5, i);
  const b64 = dataUrl.slice(i + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
  return { bytes: out, mime: meta.split(';')[0] };
}

export function safeFileName(name) {
  return (name || 'Adsız').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^\.+/, '').slice(0, 120).trim() || 'Adsız';
}
