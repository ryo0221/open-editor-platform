import { command } from '@editor-platform/editor-core';
import { contentHash } from '@editor-platform/artifact-core';
import { draftFor } from '../src/point-edit/model';
import { editHarness } from './edit-fixture';
import { retainedEditFixture } from './retained-edit-fixture';
async function createSourceEditFixture() {
  const retained = await retainedEditFixture();
  const host = editHarness('editable', document.querySelector<HTMLElement>('#editor')!, {
    content: retained.content,
    profile: retained.profile,
  });
  const target = { layerId: 'retained-sites', featureId: 'retained-edit:f:1', fieldId: 'metric' };
  const api = {
    async state() {
      const digest = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new Uint8Array(retained.original)),
      );
      return {
        content: host.binding.session.content,
        hash: await contentHash(host.binding.session.content),
        revision: host.binding.session.revision,
        excluded: retained.excluded,
        originalHash: `sha256:${Array.from(digest, (v) => v.toString(16).padStart(2, '0')).join('')}`,
        inputs: host.binding.inputs.getSnapshot(),
        errors: host.errors.map(String),
      };
    },
    closure: retained.closure,
    history: retained.history,
    applyInputs: () => host.editor.applyInputs(),
    nonUI(scalar: string) {
      return host.port.execute({ ...draftFor(host.handle.context.basic.read(), target), scalar });
    },
    prepareThenLose() {
      const snapshot = host.handle.context.basic.read();
      const prepared = host.port.prepare(snapshot, { ...draftFor(snapshot, target), scalar: '99' });
      retained.closure(false);
      return host.editor.execute(prepared);
    },
    changedPin() {
      host.binding.session.execute(
        command('test-host-change-pin', 'Synthetic pin replacement', (content) => ({
          ...content,
          sources: content.sources.map((s) => ({ ...s, pin: { ...s.pin, versionId: 'replaced' } })),
        })),
      );
    },
  };

  return api;
}
declare global {
  interface Window {
    geoSourceEditTest: Awaited<ReturnType<typeof createSourceEditFixture>>;
  }
}
void createSourceEditFixture().then((api) => {
  window.geoSourceEditTest = api;
});
