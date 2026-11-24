/* global self, URL, indexedDB */
// Persist the browser's reload evidence and the last owner's ticket across worker restarts.
let database;
function openTickets() {
  if (!database) {
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open('external-editor-claims', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('claims');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch((error) => {
      database = undefined;
      throw error;
    });
  }
  return database;
}

async function change(key, update) {
  const db = await openTickets();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('claims', 'readwrite');
    const store = tx.objectStore('claims');
    const read = store.get(key);
    let previous;
    read.onsuccess = () => {
      previous = read.result;
      const next = update(previous);
      if (next === undefined) store.delete(key);
      else store.put(next, key);
    };
    tx.oncomplete = () => resolve(previous);
    tx.onabort = () => reject(tx.error);
  });
}

self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate' || new URL(event.request.url).pathname !== '/') return;
  event.respondWith(
    (async () => {
      if (event.isReload && event.resultingClientId)
        await change('reload/' + event.resultingClientId, () => Date.now() + 15_000);
      return self.fetch(event.request);
    })(),
  );
});
self.addEventListener('message', (event) => {
  const id = event.source?.id;
  const entry = event.data?.entry;
  const port = event.ports[0];
  if (!id || !port || !entry) {
    port?.postMessage(null);
    return;
  }
  const key = 'entry/' + entry;
  event.waitUntil(
    (async () => {
      const expires = await change('reload/' + id, () => undefined);
      if (event.data.ticket) {
        await change(key, () => ({ id, ticket: event.data.ticket }));
        return null;
      }
      if (!expires || expires < Date.now()) return null;
      const previous = await change(key, (current) => current);
      if (!previous || previous.id === id || (await self.clients.get(previous.id))) return null;
      // Compare and consume in one write transaction, including across worker incarnations.
      const consumed = await change(key, (current) =>
        current?.ticket === previous.ticket ? undefined : current,
      );
      return consumed?.ticket === previous.ticket ? previous.ticket : null;
    })().then(
      (ticket) => port.postMessage(ticket),
      () => port.postMessage(null),
    ),
  );
});
