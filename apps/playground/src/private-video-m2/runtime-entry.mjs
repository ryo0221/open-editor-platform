// Approved private validation entry; the reviewed slot exclusively owns workspace handoff.
import './pcm-backend.mjs';
import { createV2MountSlot } from '../../../../packages/video-metadata/host-media/m2/mount-adapter.mjs';
import { productCodecV2 } from '../../../../packages/video-metadata/host-media/m2/product-codec-v2.mjs';
import { normalPersistence, acquireProject, committedProject } from './persistence.mjs';
import { readM2Catalog } from './catalog';
import { privateVideoM2, privateVideoM2Url } from './registration';
import { scratchStatus } from '../../../../packages/video-metadata/host-media/indexed-media/scratch.mjs';
import { acquireValidationOwner } from './validation-owner.mjs';
async function mount(root, entryId) {
  const owner = await acquireValidationOwner();
  const shadow = root.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>:host{display:block;height:100dvh;overflow:auto;font:16px system-ui;color:#182333}*{box-sizing:border-box}[hidden]{display:none!important}section{max-width:1100px;margin:auto;padding:12px}button,input,select{font:inherit;max-width:100%}button{padding:8px;margin:4px}label{display:block;margin:8px 0}canvas{display:block;max-width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere}nav{display:flex;flex-wrap:wrap}p[role=alert]{color:#a12626}</style><section><h1>Video（複数素材・音声編集）</h1><p>Private local validation · desktop 1280 profile. Managed Video logical budget only; old builds and other writers must not share this validation origin. Shared editing and migration unavailable.</p><nav aria-label="Video M2 project navigation"></nav><p role="alert" id="notice"></p><div id="workspace"></div><div id="versions"></div></section>`;
  const nav = shadow.querySelector('nav'),
    notice = shadow.querySelector('#notice');
  const versions = shadow.querySelector('#versions');
  const slot = createV2MountSlot(shadow.querySelector('#workspace'));
  const adapters = new WeakMap();
  let switching = true,
    closed = false,
    closing;
  const message = (text) => {
    notice.textContent = text;
  };
  function busy(value) {
    switching = value;
    nav.setAttribute('aria-busy', String(value));
    for (const node of nav.querySelectorAll('button,input')) node.disabled = value;
  }
  async function run(action) {
    if (switching || closed) return;
    busy(true);
    message('');
    try {
      await action();
    } catch (error) {
      message(String(error));
    } finally {
      busy(false);
    }
  }
  function button(label, action) {
    const node = globalThis.document.createElement('button');
    node.textContent = label;
    node.disabled = switching;
    node.onclick = () => run(action);
    nav.append(node);
  }
  async function replace(entry, file) {
    let source,
      unlock,
      persistenceOwns = false;
    const adapter = normalPersistence(
      entry,
      (event) => {
        if (event.error) message(event.error);
        if (event.locator) {
          globalThis.history.replaceState(null, '', privateVideoM2Url(event.locator.id));
          message('Saved project is registered in Library.');
        }
      },
      owner.capacity,
    );
    let releasing;
    const release = () =>
      (releasing ??= (async () => {
        source?.close();
        await unlock?.();
      })());
    try {
      unlock = await acquireProject(adapter.id);
      if (entry) {
        source = await committedProject(entry, new globalThis.AbortController().signal);
        file = source.file;
      }
      const workspace = await slot.replace({
        file,
        codec: owner.codec(productCodecV2),
        factory: async (live, input) => {
          const p = await adapter.factory(live, input);
          const close = p.close.bind(p);
          p.close = async () => {
            await close();
            await release();
          };
          persistenceOwns = true;
          return p;
        },
        assertCanLeave: async ({ snapshot, initialHash, fromPortable }) => {
          if (adapter.indexPending) throw Error('Library registration is pending');
          if (adapter.indexError) throw Error('Retry Library registration before leaving');
          if (
            snapshot.hash !== (adapter.savedHash ?? initialHash) ||
            (fromPortable && !entry && !adapter.savedHash)
          )
            throw Error('Save the project before leaving; current edits are retained');
        },
      });
      adapters.set(workspace, adapter);
      versions.replaceChildren();
      globalThis.history.replaceState(null, '', privateVideoM2Url(entry?.id));
    } catch (error) {
      if (!persistenceOwns) await release();
      throw error;
    }
  }
  function beforeUnload(event) {
    if (!closed && slot.current()) {
      event.preventDefault();
      event.returnValue = '';
    }
  }
  function close() {
    if (closing) return closing;
    if (closed) return Promise.resolve();
    if (switching) return Promise.reject(Error('Project operation is pending'));
    closing = (async () => {
      await slot.close();
      await owner.close();
      closed = true;
      globalThis.removeEventListener('beforeunload', beforeUnload);
    })().catch((error) => {
      closing = undefined;
      throw error;
    });
    return closing;
  }
  // run owns the navigation controls; slot.close owns guard and complete drain.
  async function leave(destination) {
    await slot.close();
    await owner.close();
    closed = true;
    globalThis.removeEventListener('beforeunload', beforeUnload);
    globalThis.location.assign(destination);
  }
  button('Return to Library', () => leave('/'));
  button('New Video M2 project', () => replace());
  button('Reload saved Video M2 project', () => leave(globalThis.location.href));
  const label = globalThis.document.createElement('label');
  label.textContent = 'Open portable Video M2 project ';
  const input = globalThis.document.createElement('input');
  input.type = 'file';
  input.disabled = true;
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) void run(() => replace(undefined, file));
    input.value = '';
  };
  label.append(input);
  nav.append(label);
  button('Retry Library registration', () => adapters.get(slot.current()).retryLocator());
  button('Saved Video M2 versions', async () => {
    const history = await adapters.get(slot.current()).versions();
    versions.replaceChildren();
    for (const version of history.versions) {
      const pre = globalThis.document.createElement('pre');
      pre.textContent = JSON.stringify(version, null, 2);
      versions.append(pre);
    }
  });
  globalThis.addEventListener('beforeunload', beforeUnload);
  try {
    const entry = entryId ? readM2Catalog().find((row) => row.id === entryId) : undefined;
    if (entryId && !entry) throw Error('Private M2 project not found');
    await replace(entry);
  } catch (error) {
    await slot.close();
    await owner.close();
    globalThis.removeEventListener('beforeunload', beforeUnload);
    throw error;
  } finally {
    busy(false);
  }
  return {
    close,
    inspection: async () => ({
      native: await slot.current().host.snapshot(),
      view: slot.current().host.editor.getSnapshot(),
      transition: slot.current().host.transitionState(),
      versions: await adapters.get(slot.current()).versions(),
      capacity: await owner.capacity.inspect(),
      media: scratchStatus(),
    }),
  };
}
globalThis.editorPrivateVideoM2 = Object.freeze({ contract: privateVideoM2.contract, mount });
