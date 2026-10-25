// Offisea dosyasız güncelleme (Windows). Yeni kurulum dosyası indirmeden uygulamanın arayüzünü
// (web paketi) web sunucusundan günceller; yalnızca özeti değişen dosyalar indirilir.
//
// Güvenlik:
//  - update.json, uygulamaya gömülü (ASAR içindeki dist/version.json) açık anahtarla doğrulanan
//    ECDSA P-256 imzası taşır. İmzasız/yanlış imzalı güncelleme asla yüklenmez.
//  - İndirilen her dosyanın SHA-256 özeti imzalı listeyle karşılaştırılır.
//  - Her açılışta etkin paketin imzası ve TÜM dosyalarının özetleri yeniden doğrulanır; bozulmuş veya
//    değiştirilmiş paket yerine kurulumla gelen sürüm yüklenir.
//  - Yalnızca daha yeni derleme numaraları kabul edilir; açılamayan yeni sürüm otomatik geri alınır.
//  - İndirme yalnızca HTTPS ile, sayfadan (renderer) ayrı bir oturumda ana süreçte yapılır.
'use strict';

const { session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SHELL = 1; // yerel kabuk seviyesi (bkz. vite.config.js MIN_SHELL)
const MANIFEST = 'offisea-update.json';
const MAX_TRIALS = 2;
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 40 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const SAFE_PATH = /^[A-Za-z0-9_~+@-][A-Za-z0-9_.~+@-]*(\/[A-Za-z0-9_~+@-][A-Za-z0-9_.~+@-]*)*$/;
const HEX64 = /^[0-9a-f]{64}$/;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function parseInfo(raw) {
  const o = JSON.parse(Buffer.from(raw).toString('utf8'));
  if (!o || o.app !== 'offisea') throw new Error('Geçersiz paket');
  if (!Number.isSafeInteger(o.build) || o.build <= 0) throw new Error('Geçersiz derleme numarası');
  const files = o.files && typeof o.files === 'object' ? o.files : null;
  const keys = files ? Object.keys(files) : [];
  if (!keys.length || keys.length > MAX_FILES) throw new Error('Geçersiz dosya listesi');
  for (const p of keys) {
    if (p.length > 300 || !SAFE_PATH.test(p) || typeof files[p] !== 'string' || !HEX64.test(files[p])) throw new Error('Geçersiz dosya: ' + p);
  }
  if (!files['index.html']) throw new Error('index.html yok');
  return {
    version: String(o.version || '').replace(/[^0-9A-Za-z.+-]/g, '').slice(0, 32),
    build: o.build,
    minShell: Number.isSafeInteger(o.minShell) ? o.minShell : 1,
    updateUrl: typeof o.updateUrl === 'string' ? o.updateUrl : '',
    download: typeof o.download === 'string' ? o.download : '',
    publicKey: typeof o.publicKey === 'string' ? o.publicKey : '',
    files,
    raw: Buffer.from(raw),
  };
}

function createUpdater({ dist, userData, fetchImpl = null }) {
  const dir = path.join(userData, 'offisea-bundles');
  const stateFile = path.join(dir, 'state.json');
  const builtin = parseInfo(fs.readFileSync(path.join(dist, 'version.json')));
  const publicKey = builtin.publicKey
    ? crypto.createPublicKey({ key: Buffer.from(builtin.publicKey, 'base64'), format: 'der', type: 'spki' })
    : null;
  const binary = `${builtin.version}:${builtin.build}`;
  let state = { binary: '', active: 0, pending: 0, prev: 0, trials: 0, bad: [] };
  let root = dist;
  let busy = false;
  let net = null;

  const bundleDir = (build) => path.join(dir, String(build));

  function saveState() {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, stateFile);
  }

  function verifySigned(json) {
    if (!publicKey) throw new Error('Güncelleme anahtarı tanımlı değil');
    const o = JSON.parse(json);
    const payload = Buffer.from(String(o.payload || ''), 'base64');
    const sig = Buffer.from(String(o.sig || ''), 'base64');
    if (!crypto.verify('sha256', payload, publicKey, sig)) {
      const err = new Error('Güncelleme imzası geçersiz');
      err.security = true;
      throw err;
    }
    const info = parseInfo(payload);
    info.sig = String(o.sig);
    return info;
  }

  function readBundleManifest(d) {
    return verifySigned(fs.readFileSync(path.join(d, MANIFEST), 'utf8'));
  }

  function verifyBundle(d, build) {
    try {
      const info = readBundleManifest(d);
      if (info.build !== build) return false;
      for (const [p, h] of Object.entries(info.files)) {
        if (sha256(fs.readFileSync(path.join(d, ...p.split('/')))) !== h) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  function rmTree(p) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* yok say */ }
  }

  function cleanup(keepA, keepB) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (n === 'state.json' || n === String(keepA) || n === String(keepB)) continue;
      rmTree(path.join(dir, n));
    }
  }

  // Açılışta: etkin paketi doğrula, deneme sayacını işlet, sunulacak klasörü seç.
  function prepare() {
    try {
      try { state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch { /* ilk açılış */ }
      if (!Array.isArray(state.bad)) state.bad = [];
      if (state.binary !== binary) {
        // Yeni kurulum: kurulumla gelen sürüm esas alınır.
        state = { binary, active: 0, pending: 0, prev: 0, trials: 0, bad: state.bad.slice(-50) };
        cleanup(0, 0);
        saveState();
        return root;
      }
      if (state.active && state.pending === state.active) {
        state.trials = (state.trials | 0) + 1;
        if (state.trials > MAX_TRIALS) {
          state.bad.push(state.active);
          state.active = state.prev || 0;
          state.prev = 0;
          state.pending = 0;
          state.trials = 0;
        }
      }
      if (state.active) {
        const d = bundleDir(state.active);
        if (state.active > builtin.build && verifyBundle(d, state.active)) root = d;
        else { state.active = 0; state.pending = 0; state.trials = 0; }
      }
      saveState();
    } catch {
      root = dist;
    }
    return root;
  }

  function current() {
    if (state.active && root === bundleDir(state.active)) {
      try { return { info: readBundleManifest(root), dir: root }; } catch { /* yerleşik */ }
    }
    if (state.active) {
      try {
        const d = bundleDir(state.active);
        const info = readBundleManifest(d);
        if (info.build === state.active) return { info, dir: d };
      } catch { /* yerleşik */ }
    }
    return { info: builtin, dir: dist };
  }

  async function fetchBytes(url, max, expectHash) {
    if (!/^https:\/\//i.test(url)) throw Object.assign(new Error('Yalnızca HTTPS'), { security: true });
    // Sayfanın oturumundan ayrı bir oturum: sayfanın ağ filtresi ve çerezleri buraya karışmaz.
    if (!net) net = fetchImpl ? { fetch: fetchImpl } : session.fromPartition('offisea-updater', { cache: false });
    const res = await net.fetch(url, { cache: 'no-store', redirect: 'follow' });
    if (!/^https:\/\//i.test(res.url || url)) throw Object.assign(new Error('Yalnızca HTTPS'), { security: true });
    if (res.status !== 200) throw new Error('HTTP ' + res.status);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > max) throw new Error('Dosya çok büyük');
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) { reader.cancel().catch(() => {}); throw new Error('Dosya çok büyük'); }
      chunks.push(Buffer.from(value));
    }
    const buf = Buffer.concat(chunks);
    if (expectHash && sha256(buf) !== expectHash) throw Object.assign(new Error('Dosya özeti uyuşmuyor'), { security: true });
    return buf;
  }

  async function doCheck() {
    const cur = current();
    let base = cur.info.updateUrl;
    if (!/^https:\/\//i.test(base) || !publicKey) return { status: 'disabled' };
    if (!base.endsWith('/')) base += '/';
    const body = await fetchBytes(`${base}update.json?t=${Date.now()}`, 4 * 1024 * 1024);
    const nw = verifySigned(body.toString('utf8'));
    const out = { version: nw.version, build: nw.build };
    // Daha önce indirildi, yeniden başlatılmayı bekliyor.
    if (state.active === nw.build && root !== bundleDir(nw.build)) return { ...out, status: 'ready', downloaded: 0 };
    if (nw.build <= cur.info.build || nw.build <= builtin.build || state.bad.includes(nw.build)) return { ...out, status: 'none' };
    if (nw.minShell > SHELL) return { ...out, status: 'shell', download: nw.download };

    const tmp = path.join(dir, `.tmp-${nw.build}`);
    rmTree(tmp);
    let total = 0;
    let downloaded = 0;
    try {
      for (const [p, h] of Object.entries(nw.files)) {
        const target = path.join(tmp, ...p.split('/'));
        if (!target.startsWith(tmp + path.sep)) throw Object.assign(new Error('Geçersiz yol'), { security: true });
        fs.mkdirSync(path.dirname(target), { recursive: true });
        let data = null;
        if (cur.info.files[p] === h) {
          try {
            const local = fs.readFileSync(path.join(cur.dir, ...p.split('/')));
            if (sha256(local) === h) data = local;
          } catch { /* indirilecek */ }
        }
        if (!data) {
          data = await fetchBytes(base + p.split('/').map(encodeURIComponent).join('/') + '?h=' + h.slice(0, 16), MAX_FILE_BYTES, h);
          downloaded++;
        }
        total += data.length;
        if (total > MAX_TOTAL_BYTES) throw new Error('Paket çok büyük');
        fs.writeFileSync(target, data);
      }
      fs.writeFileSync(path.join(tmp, MANIFEST), JSON.stringify({ payload: nw.raw.toString('base64'), sig: nw.sig }));
      const dest = bundleDir(nw.build);
      rmTree(dest);
      fs.renameSync(tmp, dest);
      if (!verifyBundle(dest, nw.build)) throw Object.assign(new Error('Paket doğrulanamadı'), { security: true });
      const prev = state.active;
      state = { ...state, prev, active: nw.build, pending: nw.build, trials: 0 };
      saveState();
      cleanup(nw.build, root === dist ? prev : path.basename(root));
    } catch (err) {
      rmTree(tmp);
      throw err;
    }
    return { ...out, status: 'ready', downloaded };
  }

  return {
    prepare,
    root: () => root,
    info() {
      const cur = current();
      return {
        shell: SHELL,
        builtinVersion: builtin.version,
        builtinBuild: builtin.build,
        activeVersion: cur.info.version,
        activeBuild: root === dist ? 0 : state.active,
        pending: state.pending,
        enabled: /^https:\/\//i.test(cur.info.updateUrl) && !!publicKey,
      };
    },
    async check() {
      if (busy) return { status: 'busy' };
      busy = true;
      try {
        fs.mkdirSync(dir, { recursive: true });
        return await doCheck();
      } catch (err) {
        return { status: 'error', message: err && err.security ? 'Güncelleme doğrulanamadı; yüklenmedi.' : 'Güncelleme denetlenemedi. İnternet bağlantınızı kontrol edin.' };
      } finally {
        busy = false;
      }
    },
    // Hazırlanan sürüme hemen geç (çağıran pencereyi yeniden yükler).
    applyNow() {
      if (!state.active) return false;
      const d = bundleDir(state.active);
      if (!verifyBundle(d, state.active)) return false;
      root = d;
      return true;
    },
    confirm(build) {
      if (state.active && build === state.active && state.pending === state.active && root === bundleDir(state.active)) {
        state.pending = 0;
        state.trials = 0;
        state.prev = 0;
        saveState();
        cleanup(state.active, 0);
      }
    },
    reset() {
      if (state.active) state.bad.push(state.active);
      state = { ...state, active: 0, pending: 0, prev: 0, trials: 0 };
      saveState();
      root = dist;
      setTimeout(() => cleanup(0, 0), 3000);
    },
  };
}

module.exports = { createUpdater };
