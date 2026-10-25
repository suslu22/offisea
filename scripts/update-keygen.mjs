// Güncelleme imza anahtarı üretir (ECDSA P-256).
//  - Gizli anahtar: keys/update-private.pem  (ASLA paylaşmayın, depoya eklemeyin; yedekleyin)
//  - Açık anahtar: update.config.json içindeki "publicKey" alanına yazılır (uygulamaya gömülür).
// Uygulamalar yalnızca bu anahtarla imzalanmış güncellemeleri kabul eder.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const keyFile = join(root, 'keys', 'update-private.pem');
const cfgFile = join(root, 'update.config.json');

if (existsSync(keyFile) && !process.argv.includes('--force')) {
  console.error('Anahtar zaten var: keys/update-private.pem\nYeni anahtar, eski sürümlerin güncelleme almasını engeller. Yine de istiyorsanız --force ekleyin.');
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
mkdirSync(dirname(keyFile), { recursive: true });
writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });

let cfg = { url: '', download: '', publicKey: '' };
try { cfg = { ...cfg, ...JSON.parse(readFileSync(cfgFile, 'utf8')) }; } catch { /* yeni dosya */ }
cfg.publicKey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');

console.log('Anahtar üretildi.\n  Gizli: keys/update-private.pem (yedekleyin, kimseyle paylaşmayın)\n  Açık:  update.config.json → publicKey');
