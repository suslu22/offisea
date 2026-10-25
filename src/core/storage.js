// Belgeler yalnızca bu cihazda (IndexedDB) saklanır; hiçbir sunucuya gönderilmez.
const DB_NAME = 'offisea';
const DB_VERSION = 3; // 2: klasörler, 3: arama dizini
let dbPromise = null;

/** Çöp kutusundaki belgeler bu kadar gün sonra kendiliğinden kalıcı olarak silinir. */
export const TRASH_DAYS = 30;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('data')) db.createObjectStore('data', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('folders')) db.createObjectStore('folders', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('text')) db.createObjectStore('text', { keyPath: 'id' });
    };
    // Başka bir sekmede yeni sürüm açılırsa bu bağlantı kapatılır (yükseltme beklemede kalmasın)
    req.onblocked = () => {};
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, stores, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
    result = fn(t);
  });
}

export function newId() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Belgeyi kaydeder. Klasör ve çöp kutusu bilgisi (folder, trashed) korunur; yeni belge için
 * `folder` verilebilir.
 */
export async function saveDoc({ id, kind, title, data, size = 0, folder }) {
  const db = await openDb();
  const updated = Date.now();
  await tx(db, ['meta', 'data'], 'readwrite', (t) => {
    const metas = t.objectStore('meta');
    metas.get(id).onsuccess = (e) => {
      const old = e.target.result || {};
      const m = { id, kind, title, updated, size };
      const f = folder !== undefined ? folder : old.folder;
      if (f) m.folder = f;
      if (old.trashed) m.trashed = old.trashed;
      metas.put(m);
    };
    t.objectStore('data').put({ id, data });
  });
  requestPersistence();
  return updated;
}

/** Yalnızca belge bilgilerini değiştirir (ad, klasör, çöp kutusu); içerik ve tarih aynı kalır. */
export async function updateMeta(id, patch) {
  const db = await openDb();
  await tx(db, ['meta'], 'readwrite', (t) => {
    const metas = t.objectStore('meta');
    metas.get(id).onsuccess = (e) => {
      const m = e.target.result;
      if (!m) return;
      const n = { ...m, ...patch };
      for (const k of Object.keys(n)) if (n[k] === undefined || n[k] === null) delete n[k];
      metas.put(n);
    };
  });
}

export async function loadDoc(id) {
  const db = await openDb();
  let meta, data;
  await tx(db, ['meta', 'data'], 'readonly', (t) => {
    t.objectStore('meta').get(id).onsuccess = (e) => { meta = e.target.result; };
    t.objectStore('data').get(id).onsuccess = (e) => { data = e.target.result; };
  });
  if (!meta || !data) return null;
  return { ...meta, data: data.data };
}

/** Tüm belgeler (çöp kutusundakiler dahil; `trashed` alanıyla ayırt edilir), en yeni önce. */
export async function listDocs() {
  const db = await openDb();
  let all = [];
  await tx(db, ['meta'], 'readonly', (t) => {
    t.objectStore('meta').getAll().onsuccess = (e) => { all = e.target.result || []; };
  });
  return all.sort((a, b) => b.updated - a.updated);
}

/** Kalıcı olarak siler. */
export async function deleteDoc(id) {
  const db = await openDb();
  await tx(db, ['meta', 'data', 'text'], 'readwrite', (t) => {
    t.objectStore('meta').delete(id);
    t.objectStore('data').delete(id);
    t.objectStore('text').delete(id);
  });
}

// ---- Arama dizini (belge içeriğinin düz metni; yalnızca bu cihazda) ------------------------------
/** Tüm dizin kayıtları: [{ id, u (belgenin dizinlendiği sürümün tarihi), t (metin) }] */
export async function listTextIndex() {
  const db = await openDb();
  let all = [];
  await tx(db, ['text'], 'readonly', (t) => {
    t.objectStore('text').getAll().onsuccess = (e) => { all = e.target.result || []; };
  });
  return all;
}

export async function putTextIndex(rec) {
  const db = await openDb();
  await tx(db, ['text'], 'readwrite', (t) => { t.objectStore('text').put(rec); });
}

export async function deleteTextIndex(id) {
  const db = await openDb();
  await tx(db, ['text'], 'readwrite', (t) => { t.objectStore('text').delete(id); });
}

export const trashDoc = (id) => updateMeta(id, { trashed: Date.now() });
export const restoreDoc = (id) => updateMeta(id, { trashed: null });

/** Süresi dolan çöp kutusu belgelerini kalıcı olarak siler; silinen sayısını döndürür. */
export async function purgeTrash(days = TRASH_DAYS) {
  const limit = Date.now() - days * 86400000;
  const old = (await listDocs()).filter((d) => d.trashed && d.trashed < limit);
  for (const d of old) await deleteDoc(d.id);
  return old.length;
}

// ---- Klasörler ----------------------------------------------------------------------------------
export async function listFolders() {
  const db = await openDb();
  let all = [];
  await tx(db, ['folders'], 'readonly', (t) => {
    t.objectStore('folders').getAll().onsuccess = (e) => { all = e.target.result || []; };
  });
  return all.sort((a, b) => a.name.localeCompare(b.name, 'tr'));
}

export async function saveFolder({ id = newId(), name }) {
  const db = await openDb();
  const f = { id, name: String(name).slice(0, 80) };
  await tx(db, ['folders'], 'readwrite', (t) => { t.objectStore('folders').put(f); });
  return f;
}

/** Klasörü siler; içindeki belgeler silinmez, klasörsüz kalır. */
export async function deleteFolder(id) {
  const db = await openDb();
  await tx(db, ['folders', 'meta'], 'readwrite', (t) => {
    t.objectStore('folders').delete(id);
    const metas = t.objectStore('meta');
    metas.openCursor().onsuccess = (e) => {
      const cur = e.target.result;
      if (!cur) return;
      if (cur.value.folder === id) { const m = { ...cur.value }; delete m.folder; cur.update(m); }
      cur.continue();
    };
  });
}

let persistAsked = false;
function requestPersistence() {
  if (persistAsked) return;
  persistAsked = true;
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}

export function getPref(key, def) {
  try { const v = localStorage.getItem('offisea:' + key); return v == null ? def : JSON.parse(v); } catch { return def; }
}
export function setPref(key, value) {
  try { localStorage.setItem('offisea:' + key, JSON.stringify(value)); } catch { /* yok say */ }
}
