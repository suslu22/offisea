// pdf.js yardımcı dosyalarını (yazı tipleri, karakter haritaları, görüntü çözücüler) public/pdfjs altına kopyalar.
// Güvenlik: PDF içi JavaScript motoru (quickjs-eval) bilerek kopyalanmaz; uygulama PDF betiklerini asla çalıştırmaz.
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'pdfjs-dist');
const out = join(root, 'public', 'pdfjs');

if (!existsSync(src)) {
  console.error('pdfjs-dist bulunamadı. Önce "npm install" çalıştırın.');
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const dir of ['cmaps', 'standard_fonts', 'iccs', 'wasm']) {
  cpSync(join(src, dir), join(out, dir), {
    recursive: true,
    filter: (p) => !/^quickjs-eval/i.test(basename(p)),
  });
}
console.log('pdf.js dosyaları kopyalandı (betik motoru hariç).');
