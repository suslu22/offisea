import { extOf, readArrayBuffer, isZip } from '../core/files.js';
import { importDocx } from './docx-import.js';
import { importOdt, importRtf, importText, importMarkdown, importHtml } from './other-import.js';

export async function importWordData(file) {
  const ext = extOf(file.name);
  const buf = await readArrayBuffer(file);
  let html;
  if (['docx', 'docm', 'dotx', 'dotm'].includes(ext)) {
    if (!isZip(buf)) {
      // Bazı ".docx" dosyaları aslında RTF veya HTML'dir.
      const head = new TextDecoder('latin1').decode(new Uint8Array(buf.slice(0, 8)));
      if (head.startsWith('{\\rtf')) html = importRtf(buf);
      else throw new Error('Bu dosya geçerli bir .docx değil. Eski .doc biçimindeyse Word ile .docx olarak kaydedin.');
    } else html = await importDocx(buf);
  } else if (ext === 'odt') html = await importOdt(buf);
  else if (ext === 'rtf') html = importRtf(buf);
  else if (ext === 'md') html = importMarkdown(buf);
  else if (ext === 'html' || ext === 'htm') html = importHtml(buf);
  else html = importText(buf);
  return { html };
}
