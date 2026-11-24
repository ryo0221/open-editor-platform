/* global document, window, fetch, navigator, sessionStorage, crypto, MessageChannel, setTimeout, clearTimeout */
import { mountSharedEditor, plan, apply, resource } from '/extension.js';
import { fingerprint } from '@editor-platform/collaboration-core';
const status = document.querySelector('#status');
let token,
  namespace,
  domain,
  snapshot,
  history,
  parent,
  connected = false;
let presenceRevision = 0;
const pointerListeners = new Set();
const revisions = new Map(),
  listeners = new Set();
const inputKey = 'external-own-input',
  pendingKey = 'external-edit-pending',
  savedKey = 'external-save-pending';
let detach;
function recover() {
  const panel = document.querySelector('#recovery');
  const own = JSON.parse(sessionStorage.getItem(inputKey) ?? 'null');
  panel.hidden = !own && !sessionStorage.getItem(pendingKey);
  panel.querySelector('textarea').value = own ? Object.values(own).join('\n') : '';
}
document.querySelector('#clear').onclick = () => {
  sessionStorage.removeItem(inputKey);
  sessionStorage.removeItem(pendingKey);
  recover();
};
function revoked() {
  connected = false;
  detach?.();
  snapshot = null;
  revisions.clear();
  sessionStorage.removeItem(pendingKey);
  sessionStorage.removeItem(savedKey);
  for (const id of ['save', 'redo', 'undo']) document.querySelector('#' + id).disabled = true;
  recover();
}
const api = async (path, body = {}) => {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (token ?? '') },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) {
    if (response.status === 403) revoked();
    const error = Error(value.error);
    error.definite = true;
    throw error;
  }
  return value;
};
const refresh = async () => {
  const state = await api('/open');
  if (
    snapshot &&
    state.snapshot.generation === snapshot.generation &&
    state.snapshot.revision < snapshot.revision
  )
    return;
  if (snapshot?.generation !== state.snapshot.generation) revisions.clear();
  ({ snapshot, history, parent } = state);
  revisions.set(snapshot.generation + '/' + snapshot.revision, snapshot);
  while (revisions.size > 256) revisions.delete(revisions.keys().next().value);
  document.querySelector('#undo').disabled = !history.undo;
  document.querySelector('#redo').disabled = !history.redo;
  presenceRevision = state.presenceRevision;
  for (const fn of listeners) fn();
  for (const fn of pointerListeners) fn(state.presence);
};

async function send(path, request) {
  const pending = sessionStorage.getItem(pendingKey);
  if (pending) throw Error('前の操作の結果を確かめてください。');
  sessionStorage.setItem(pendingKey, JSON.stringify({ path, request }));
  let receipt;
  try {
    receipt = await api(path, request);
  } catch (error) {
    if (error.definite) sessionStorage.removeItem(pendingKey);
    else recover();
    throw error;
  }
  sessionStorage.removeItem(pendingKey);
  await refresh();
  if (receipt.status !== 'accepted') throw Error(receipt.code);
}
async function main() {
  let worker;
  if ('serviceWorker' in navigator) {
    await navigator.serviceWorker.register('/session-worker.js');
    await navigator.serviceWorker.ready;
    worker = navigator.serviceWorker.controller;
    if (!worker)
      await new Promise((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
        setTimeout(resolve, 1000);
      });
    worker = navigator.serviceWorker.controller;
  }
  const exchange = (data) =>
    new Promise((resolve) => {
      if (!worker) return resolve(null);
      const channel = new MessageChannel();
      const finish = (value) => {
        clearTimeout(timer);
        channel.port1.close();
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), 1000);
      channel.port1.onmessage = (e) => finish(e.data);
      worker.postMessage(data, [channel.port2]);
    });
  const item = window.navigation?.currentEntry;
  const entry = item ? item.key + '/' + item.id : null;
  const session = await api('/session', { resume: await exchange({ entry }) });
  ({ token, namespace, domain } = session);
  await exchange({ entry, ticket: session.ticket });
  await refresh();
  const pending = JSON.parse(sessionStorage.getItem(pendingKey) ?? 'null');
  if (pending) {
    const receipt = await api('/receipt', pending.request);
    status.textContent =
      receipt?.status === 'accepted'
        ? '前の変更を反映しました。'
        : (receipt?.code ?? '前の操作は結果不明です。');
    if (receipt) sessionStorage.removeItem(pendingKey);
    if (receipt?.status === 'accepted') sessionStorage.removeItem(inputKey);
  }
  recover();
  detach = mountSharedEditor(document.querySelector('#editor'), {
    read: () => snapshot.content,
    revision: () => snapshot.generation + '/' + snapshot.revision,
    keepInput(value) {
      if (value) sessionStorage.setItem(inputKey, JSON.stringify(value));
      else sessionStorage.removeItem(inputKey);
    },
    onPointers(fn) {
      pointerListeners.add(fn);
      return () => pointerListeners.delete(fn);
    },
    pointer(target, x, y) {
      api('/pointer', { generation: snapshot.generation, target, x, y }).catch(() => {});
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async submit(revision, id, input) {
      const base = revisions.get(revision);
      if (!base) throw Error('元の版を開き直してください。');
      const keys = new Set();
      let content = base.content;
      for (const action of plan(id, '1.0.0', input, base.content)) {
        const effect = apply(content, action);
        for (const key of effect.required) keys.add(key);
        content = effect.content;
      }
      const conditions = [...keys].map((key) => {
        const stamp = Object.entries(base.stamps).reduce(
          (latest, [changed, n]) =>
            changed === key || changed.startsWith(key + '/') ? Math.max(latest, n) : latest,
          0,
        );
        return { key, stamp, fingerprint: fingerprint(resource(base.content, key)) };
      });
      await send('/submit', {
        protocol: 2,
        schema: 1,
        domain,
        artifactId: base.artifactId,
        generation: base.generation,
        operationId: namespace + '/' + crypto.randomUUID(),
        baseRevision: base.revision,
        declaration: { id, version: '1.0.0' },
        input,
        conditions,
      });
    },
  });
  const act = (id, callback) =>
    (document.querySelector('#' + id).onclick = async () => {
      try {
        await callback();
      } catch (e) {
        status.textContent = e.message;
      }
    });
  for (const direction of ['undo', 'redo'])
    act(direction, () =>
      send('/history', {
        direction,
        target: history[direction],
        generation: snapshot.generation,
        operationId: namespace + '/' + crypto.randomUUID(),
      }),
    );
  act('save', async () => {
    const request = JSON.parse(sessionStorage.getItem(savedKey) ?? 'null') ?? {
      generation: snapshot.generation,
      revision: snapshot.revision,
      contentHash: fingerprint(snapshot.content),
      parentVersionId: parent,
      requestId: crypto.randomUUID(),
    };
    sessionStorage.setItem(savedKey, JSON.stringify(request));
    let saved;
    try {
      saved = await api('/save', request);
    } catch (error) {
      if (error.definite) {
        sessionStorage.removeItem(savedKey);
        await refresh();
      }
      throw error;
    }
    sessionStorage.removeItem(savedKey);
    await refresh();
    status.textContent = '保存した版 r' + saved.confirmedRevision;
  });
  connected = true;
  while (connected) {
    try {
      await api('/changes', {
        generation: snapshot.generation,
        revision: snapshot.revision,
        presenceRevision,
      });
      await refresh();
    } catch (e) {
      status.textContent = e.message;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
window.addEventListener('pagehide', () => {
  connected = false;
});
main().catch((e) => {
  status.textContent = e.message;
});
