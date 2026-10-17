import { EditorSession } from '@editor-platform/editor-core';
import { ExtensionRegistry } from '@editor-platform/extension-runtime';
import { counterExtension, createCounter, isCounter } from '@editor-platform/extension-sample';
// Bundled, trusted source fixture. This digest labels the fixture only, not release provenance.
const fixtureHash = `sha256:${'0'.repeat(64)}`;
const registry = new ExtensionRegistry();
const registration = registry.install(counterExtension(fixtureHash), {
  trust: 'trusted',
  verifiedPackageHash: fixtureHash,
});
const readOnly = document.querySelector<HTMLInputElement>('#readonly')!;
const status = document.querySelector<HTMLElement>('#status')!;
const surface = document.querySelector<HTMLElement>('#surface')!;
let session = new EditorSession(createCounter());
let handle = open();
function open() {
  const h = registration.open({
    artifactKind: 'example.counter',
    schemaVersion: 1,
    allowed: () => true,
    readOnly: () => readOnly.checked,
    read: () => session.content,
    execute: (c) => {
      session.execute(c);
    },
    undo: () => {
      session.undo();
    },
    redo: () => {
      session.redo();
    },
    save: async () => {
      localStorage.setItem('extension.counter.draft', JSON.stringify(session.content));
    },
    select: () => {
      throw new Error('Selection unsupported');
    },
  });
  h.mount(surface);
  return h;
}
document.querySelector<HTMLButtonElement>('#reload')!.onclick = () => {
  try {
    if (readOnly.checked) throw new Error('Permission denied');
    const raw: unknown = JSON.parse(localStorage.getItem('extension.counter.draft') ?? 'null');
    if (!isCounter(raw)) throw new Error('Invalid saved draft');
    // Check registration liveness before replacing the local session.
    handle.api.read();
    handle.close();
    session = new EditorSession(raw);
    handle = open();
    status.textContent = 'Reloaded saved draft';
  } catch (e) {
    status.textContent = e instanceof Error ? e.message : 'Reload failed';
  }
};
document.querySelector<HTMLButtonElement>('#uninstall')!.onclick = () => {
  registration.uninstall();
  status.textContent = 'Uninstalled; saved draft retained';
};
