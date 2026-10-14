/** Remember the player's game archive in IndexedDB so it only has to be supplied once. */
const DB = 'thunderstrike-js', STORE = 'files', KEY = 'game.zip';

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function saveArchive(entries) {
  try {
    const db = await open();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(entries, KEY);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  } catch { /* storage unavailable: the player will be asked again next time */ }
}

export async function loadArchive() {
  try {
    const db = await open();
    return await new Promise((res) => {
      const r = db.transaction(STORE).objectStore(STORE).get(KEY);
      r.onsuccess = () => res(r.result ?? null);
      r.onerror = () => res(null);
    });
  } catch { return null; }
}

export async function forgetArchive() {
  try {
    const db = await open();
    db.transaction(STORE, 'readwrite').objectStore(STORE).delete(KEY);
  } catch { /* ignore */ }
}
