/* global self, URL, setTimeout */
// Claim tickets live in the worker. Reloads carry the browser's history entry key and id;
// opening another tab with a copy of sessionStorage confers no ticket.
const entries = new Map();
const reloads = new Set();
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate' || new URL(event.request.url).pathname !== '/') return;
  if (event.isReload && event.resultingClientId) {
    reloads.add(event.resultingClientId);
    setTimeout(() => reloads.delete(event.resultingClientId), 15_000);
  }
  event.respondWith(self.fetch(event.request));
});
self.addEventListener('message', (event) => {
  const id = event.source?.id;
  const key = event.data?.entry;
  const port = event.ports[0];
  if (!id || !port || !key) {
    port?.postMessage(null);
    return;
  }
  event.waitUntil(
    (async () => {
      const previous = entries.get(key);
      if (event.data.ticket) {
        entries.set(key, { id, ticket: event.data.ticket });
        port.postMessage(null);
        return;
      }
      if (
        !reloads.delete(id) ||
        !previous ||
        previous.id === id ||
        (await self.clients.get(previous.id))
      ) {
        port.postMessage(null);
        return;
      }
      // Recheck after the async lookup, so two claimants cannot redeem the same ticket.
      if (entries.get(key) !== previous) {
        port.postMessage(null);
        return;
      }
      entries.delete(key);
      port.postMessage(previous.ticket);
    })(),
  );
});
