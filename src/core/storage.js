// Belgeler yalnızca bu cihazda (IndexedDB) saklanır; hiçbir sunucuya gönderilmez.
const DB_NAME = 'offisea';
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('data')) db.createObjectStore('data', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
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

export async function saveDoc({ id, kind, title, data, size = 0 }) {
  const db = await openDb();
  const updated = Date.now();
  await tx(db, ['meta', 'data'], 'readwrite', (t) => {
    t.objectStore('meta').put({ id, kind, title, updated, size });
    t.objectStore('data').put({ id, data });
  });
  requestPersistence();
  return updated;
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

export async function listDocs() {
  const db = await openDb();
  let all = [];
  await tx(db, ['meta'], 'readonly', (t) => {
    t.objectStore('meta').getAll().onsuccess = (e) => { all = e.target.result || []; };
  });
  return all.sort((a, b) => b.updated - a.updated);
}

export async function deleteDoc(id) {
  const db = await openDb();
  await tx(db, ['meta', 'data'], 'readwrite', (t) => {
    t.objectStore('meta').delete(id);
    t.objectStore('data').delete(id);
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
