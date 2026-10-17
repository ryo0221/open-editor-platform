// Private compiled Host registration. Deliberately not a package/public Surface export.
import { mountV1Host } from '../../../../packages/video-metadata/host-media/file-source/host-v1';
import { productCodecV1 } from '../../../../packages/video-metadata/host-media/file-source/product-codec-v1.mjs';
import { normalPersistence, acquireProject, committedProject } from './persistence.mjs';
import { readCatalog } from './catalog';
import { disposeGuarded } from './navigation';
import { privateVideo, privateVideoUrl } from './registration';
import { acquireValidationOwner } from '../private-video-m2/validation-owner.mjs';
const styles = `:host{display:block;height:100dvh;overflow:auto;font:16px system-ui;color:#182333}*{box-sizing:border-box}[hidden]{display:none!important}section{max-width:980px;margin:auto;padding:16px}button,input,select{font:inherit;max-width:100%}button{padding:8px;margin:4px}label{display:block;margin:10px 0}canvas{display:block;max-width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere}ol{padding-left:24px}nav{display:flex;flex-wrap:wrap}p[role=alert]{color:#a12626}details{margin:12px 0}`;
async function mount(root, entryId, validation = false) {
  const validationOwner = validation ? await acquireValidationOwner() : undefined;
  const shadow = root.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>${styles}</style><section><nav aria-label="Video project navigation"></nav><p>Private Video integration · local AVC/SDR profile. Shared, templates and reuse are unavailable. Mobile output and physical Safari are not accepted.</p><p role="alert" id="notice"></p><div id="workspace"></div><div id="versions"></div></section>`;
  const nav = shadow.querySelector('nav'),
    notice = shadow.querySelector('#notice');
  const container = shadow.querySelector('#workspace'),
    versions = shadow.querySelector('#versions');
  let current,
    switching = true,
    replacementGeneration = 0,
    closed = false;
  function message(value) {
    notice.textContent = value;
  }
  function setSwitching(value) {
    switching = value;
    nav.setAttribute('aria-busy', String(value));
    for (const control of nav.querySelectorAll('button,input')) control.disabled = value;
  }
  function button(label, action) {
    const node = globalThis.document.createElement('button');
    node.textContent = label;
    node.disabled = switching;
    node.onclick = () => run(action);
    nav.append(node);
    return node;
  }
  async function run(action) {
    if (switching || closed) return;
    setSwitching(true);
    message('');
    try {
      await action();
    } catch (error) {
      message(String(error));
    } finally {
      setSwitching(false);
    }
  }
  async function prepare(entry, file) {
    let source, host, unlock;
    const target = globalThis.document.createElement('div');
    let inputEpoch = 0;
    for (const event of ['input', 'change', 'compositionstart', 'compositionend'])
      target.addEventListener(
        event,
        () => {
          inputEpoch++;
        },
        true,
      );
    const adapter = normalPersistence(
      entry,
      (event) => {
        if (event.error) message(event.error);
        if (event.locator) {
          globalThis.history.replaceState(null, '', privateVideoUrl(event.locator.id));
          message('Saved project is registered in Library.');
        }
      },
      validationOwner?.capacity,
    );
    try {
      unlock = await acquireProject(adapter.id);
      if (entry) {
        source = await committedProject(entry, new globalThis.AbortController().signal);
        file = source.file;
      }
      host = await mountV1Host(
        target,
        adapter.factory,
        validationOwner?.codec(productCodecV1) ?? productCodecV1,
        file,
      );
      // Normal Host owns project switching. The original standalone private Host is untouched.
      // Keeping its nested replacement input here would leave the returned original controller stale.
      target.querySelector('#open').closest('label').hidden = true;
      const initialHash = (await host.snapshot()).hash;
      let disposed = false;
      const pin = () =>
        JSON.stringify([
          host.editor.getSnapshot(),
          inputEpoch,
          [...target.querySelectorAll('input,select,textarea')].map((node) => [
            node.id,
            node.value,
            node.checked,
          ]),
        ]);
      return {
        host,
        adapter,
        target,
        pin,
        async guard() {
          target.inert = true;
          try {
            if (host.editor.getSnapshot().saving) throw Error('Save is pending');
            const flushed = host.editor.applyInputs();
            if (flushed.state === 'refused') throw Error(flushed.message);
            const beforeSnapshot = pin();
            const snapshot = await host.snapshot();
            if (pin() !== beforeSnapshot)
              throw Error(
                'Project changed while checking navigation; current draft and inputs are retained',
              );
            if (host.editor.getSnapshot().saving) throw Error('Save is pending');
            if (adapter.indexPending) throw Error('Library registration is pending');
            if (adapter.indexError)
              throw Error('Retry Library registration or retain the portable file before leaving');
            if (
              snapshot.hash !== (adapter.savedHash ?? initialHash) ||
              (file && !entry && !adapter.savedHash)
            )
              throw Error('Save the project before leaving; current edits are retained');
            return beforeSnapshot;
          } catch (error) {
            target.inert = false;
            throw error;
          }
        },
        resume() {
          target.inert = false;
        },
        async dispose() {
          if (disposed) return;
          await host.close(); // Refusal retains this exact owner and its resources.
          disposed = true;
          source?.close();
          await unlock();
        },
      };
    } catch (error) {
      if (host) await host.close();
      source?.close();
      await unlock?.();
      throw error;
    }
  }
  async function replace(entry, file) {
    const previous = current;
    const token = ++replacementGeneration;
    const previousPin = await previous?.guard();
    let candidate;
    try {
      candidate = await prepare(entry, file);
      if (
        closed ||
        token !== replacementGeneration ||
        current !== previous ||
        (previous && previous.pin() !== previousPin)
      )
        throw Error('Project changed while opening; current draft and inputs are retained');
      await previous?.dispose();
      current = candidate;
      container.replaceChildren(candidate.target);
      versions.replaceChildren();
      globalThis.history.replaceState(null, '', privateVideoUrl(entry?.id));
    } catch (error) {
      try {
        await candidate?.dispose();
      } finally {
        previous?.resume();
      }
      throw error;
    }
  }
  async function close() {
    if (closed) return;
    if (switching) throw Error('Project operation is pending');
    if (current) {
      await disposeGuarded(current);
    }
    closed = true;
    await validationOwner?.close();
    globalThis.removeEventListener('beforeunload', beforeUnload);
  }
  button('Return to Library', async () => {
    await disposeGuarded(current);
    closed = true;
    await validationOwner?.close();
    globalThis.removeEventListener('beforeunload', beforeUnload);
    globalThis.location.assign('/');
  });
  button('New Video project', () => replace());
  button('Reload saved Video project', async () => {
    await disposeGuarded(current);
    closed = true;
    await validationOwner?.close();
    globalThis.removeEventListener('beforeunload', beforeUnload);
    globalThis.location.reload();
  });
  const label = globalThis.document.createElement('label');
  label.textContent = 'Open portable Video project ';
  const input = globalThis.document.createElement('input');
  input.type = 'file';
  input.disabled = switching;
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) void run(() => replace(undefined, file));
    input.value = '';
  };
  label.append(input);
  nav.append(label);
  button('Retry Library registration', () => current.adapter.retryLocator());
  button('Saved Video versions', async () => {
    const saved = await current.adapter.versions();
    versions.replaceChildren();
    const heading = globalThis.document.createElement('h2');
    heading.textContent = 'Saved versions';
    versions.append(heading);
    for (const version of saved.versions) {
      const details = globalThis.document.createElement('details');
      const summary = globalThis.document.createElement('summary');
      summary.textContent = version.versionId;
      const text = globalThis.document.createElement('pre');
      text.textContent = JSON.stringify(version, null, 2);
      details.append(summary, text);
      versions.append(details);
    }
  });
  function beforeUnload(event) {
    if (!closed && current) {
      event.preventDefault();
      event.returnValue = '';
    }
  }
  globalThis.addEventListener('beforeunload', beforeUnload);
  setSwitching(true);
  try {
    const entry = entryId ? readCatalog().find((row) => row.id === entryId) : undefined;
    if (entryId && !entry) throw Error('Private Video project not found');
    await replace(entry);
  } catch (error) {
    globalThis.removeEventListener('beforeunload', beforeUnload);
    await validationOwner?.close();
    throw error;
  } finally {
    setSwitching(false);
  }
  return {
    close,
    inspection: async () => ({
      native: await current.host.snapshot(),
      view: current.host.editor.getSnapshot(),
      versions: await current.adapter.versions(),
    }),
  };
}
globalThis.editorPrivateVideo = Object.freeze({ contract: privateVideo.contract, mount });
