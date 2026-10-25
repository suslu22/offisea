// public/icons/icon.svg dosyasından tüm platform simgelerini üretir (web, Windows, Android).
// icon.svg içinde "tile" (yuvarlak köşeli zemin) ve "glyph" (dalga) ayrı tutulur; böylece Android'in
// uyarlanabilir simgesi ve maskelenebilir web simgesi için zemin kenara kadar uzatılabilir.
import sharp from 'sharp';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'public/icons/icon.svg'), 'utf8');
const icons = join(root, 'public/icons');

const defs = src.match(/<defs>[\s\S]*?<\/defs>/)[0];
const glyph = src.match(/<g id="glyph"[\s\S]*?<\/g>/)[0];
const wrap = (body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${defs}${body}</svg>`);
const scaled = (s) => `<g transform="translate(256 256) scale(${s}) translate(-256 -256)">${glyph}</g>`;

const full = Buffer.from(src);
const bleed = (s) => wrap(`<rect width="512" height="512" fill="url(#bg)"/>${scaled(s)}`); // kenarsız zemin
const bgOnly = wrap('<rect width="512" height="512" fill="url(#bg)"/>');
const fgOnly = (s) => wrap(scaled(s)); // saydam zemin üzerinde yalnızca dalga

// Uzun Windows yollarında da çalışsın diye dosyaya Node ile yazılır.
const out = async (img, size, file) => writeFileSync(file, await sharp(img, { density: 384 }).resize(size, size).png().toBuffer());

await out(full, 192, join(icons, 'icon-192.png'));
await out(full, 512, join(icons, 'icon-512.png'));
await out(bleed(1), 180, join(icons, 'apple-touch-icon.png')); // iOS köşeleri kendisi yuvarlar
await out(bleed(0.78), 512, join(icons, 'maskable-512.png')); // dalga, kırpmada kesilmeyen güvenli alanda

// Windows (electron-builder build/icon.png -> .ico'ya kendisi çevirir)
mkdirSync(join(root, 'build'), { recursive: true });
await out(full, 512, join(root, 'build/icon.png'));
await out(full, 256, join(root, 'build/icon-256.png'));

// Android (android klasörü oluşturulduysa)
const res = join(root, 'android/app/src/main/res');
if (existsSync(res)) {
  const dens = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
  for (const [d, s] of Object.entries(dens)) {
    const dir = join(res, `mipmap-${d}`);
    mkdirSync(dir, { recursive: true });
    await out(full, s, join(dir, 'ic_launcher.png'));
    await out(full, s, join(dir, 'ic_launcher_round.png'));
    // Uyarlanabilir simge: 108dp tuval, ortadaki 66dp daire her cihazda görünür.
    const fg = Math.round(s * 108 / 48);
    await out(fgOnly(0.66), fg, join(dir, 'ic_launcher_foreground.png'));
    await out(bgOnly, fg, join(dir, 'ic_launcher_background.png'));
  }
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
`;
  const any = join(res, 'mipmap-anydpi-v26');
  mkdirSync(any, { recursive: true });
  writeFileSync(join(any, 'ic_launcher.xml'), xml);
  writeFileSync(join(any, 'ic_launcher_round.xml'), xml);

  // Açılış ekranı (Android 11 ve öncesi): mevcut splash.png'ler aynı boyutta, ortada logo ile yeniden çizilir.
  // Android 12+ açılışta zaten uygulama simgesini gösterir.
  for (const e of readdirSync(res, { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.startsWith('drawable')) continue;
    const f = join(res, e.name, 'splash.png');
    if (!existsSync(f)) continue;
    const { width, height } = await sharp(f).metadata();
    const logo = Math.round(Math.min(width, height) * 0.28);
    const icon = await sharp(full, { density: 384 }).resize(logo, logo).png().toBuffer();
    writeFileSync(f, await sharp({ create: { width, height, channels: 4, background: '#eef4f7' } })
      .composite([{ input: icon, gravity: 'center' }]).png().toBuffer());
  }
  console.log('Android simgeleri güncellendi.');
}
console.log('Simgeler üretildi.');
