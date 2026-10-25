// dist/version.json dosyasını imzalayıp dist/update.json üretir.
// Android ve Windows uygulamaları bu dosyayı web sunucusundan okur, imzayı uygulamaya gömülü
// açık anahtarla doğrular ve yalnızca özeti değişen dosyaları indirir.
// Gizli anahtar sırasıyla şuradan okunur: OFFISEA_UPDATE_KEY (PEM metni), OFFISEA_UPDATE_KEY_FILE,
// keys/update-private.pem.
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const fail = (msg) => { console.error(msg); process.exit(1); };

let pem = process.env.OFFISEA_UPDATE_KEY;
if (!pem) {
  const f = process.env.OFFISEA_UPDATE_KEY_FILE || join(root, 'keys', 'update-private.pem');
  if (!existsSync(f)) fail('İmza anahtarı bulunamadı. Önce "npm run update-key" çalıştırın ya da OFFISEA_UPDATE_KEY tanımlayın.');
  pem = readFileSync(f, 'utf8');
}
const key = createPrivateKey(pem);
if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') fail('Anahtar ECDSA P-256 olmalı.');

const versionFile = join(dist, 'version.json');
if (!existsSync(versionFile)) fail('dist/version.json yok. Önce "npm run build" çalıştırın.');
const payload = readFileSync(versionFile);
const info = JSON.parse(payload.toString('utf8'));
if (info.app !== 'offisea' || !Number.isSafeInteger(info.build) || !info.files || !info.files['index.html']) fail('version.json geçersiz.');
if (!info.updateUrl) console.warn('Uyarı: update.config.json içinde "url" boş; uygulamalar güncelleme denetlemeyecek.');

// Uygulamaya gömülü açık anahtar bu gizli anahtarla eşleşmeli; yoksa güncellemeler reddedilir.
const pub = createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');
if (info.publicKey !== pub) fail('update.config.json içindeki publicKey bu gizli anahtarla eşleşmiyor. Derlemeyi doğru anahtarla yapın.');

const sig = sign('sha256', payload, key); // DER biçiminde ECDSA imzası
if (!verify('sha256', payload, createPublicKey({ key: Buffer.from(pub, 'base64'), format: 'der', type: 'spki' }), sig)) fail('İmza doğrulanamadı.');

writeFileSync(join(dist, 'update.json'), JSON.stringify({ payload: payload.toString('base64'), sig: sig.toString('base64') }));
console.log(`update.json hazır: sürüm ${info.version}, derleme ${info.build}, ${Object.keys(info.files).length} dosya.`);
console.log('dist klasörünü web sunucusuna yükleyin; uygulamalar bir sonraki denetimde güncellenir.');
