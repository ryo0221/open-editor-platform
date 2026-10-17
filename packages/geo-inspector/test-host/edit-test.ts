import { command } from '@editor-platform/editor-core';
import { contentHash } from '@editor-platform/artifact-core';
import { editHarness, type EditMode } from './edit-fixture';
import { draftFor } from '../src/point-edit/model';
const container = document.querySelector<HTMLElement>('#editor')!;
let host = editHarness('editable', container);
const old: (typeof host)[] = [];
const api = {
  open(mode: EditMode = 'editable') {
    old.push(host);
    host.close();
    host = editHarness(mode, container);
  },
  nonUI(longitude: string, latitude: string, scalar: string, featureId = 'point-1') {
    const draft = draftFor(host.handle.context.basic.read(), {
      layerId: 'synthetic-sites',
      featureId,
      fieldId: 'metric',
    });
    return host.port.execute({ ...draft, longitude, latitude, scalar });
  },
  revoke() {
    host.revoke();
  },
  replace() {
    old.push(host);
    host.close();
    host = editHarness('editable', container);
  },
  stale() {
    host.binding.session.execute(
      command('host-test', 'Synthetic Host stale revision', (content) => ({
        ...content,
        layers: content.layers.map((l) => ({ ...l, name: 'Host changed' })),
      })),
    );
  },
  removeFeatures(ids: string[]) {
    return host.editor.execute({
      baseRevision: host.binding.session.revision,
      command: command('host-remove-features', 'Synthetic Host deletion', (content) => ({
        ...content,
        layers: content.layers.map((layer) => ({
          ...layer,
          features: layer.features.filter((feature) => !ids.includes(feature.id)),
        })),
      })),
    });
  },
  async state() {
    const s = host.binding.session;
    return {
      content: s.content,
      hash: await contentHash(s.content),
      revision: s.revision,
      canUndo: s.canUndo,
      canRedo: s.canRedo,
      inputs: host.binding.inputs.getSnapshot(),
      errors: host.errors.map(String),
      scope: host.editor.getSnapshot().state,
    };
  },
  async drain() {
    return host.drain();
  },
  async retired() {
    return Promise.all(old.map((h) => h.drain()));
  },
};
declare global {
  interface Window {
    geoEditTest: typeof api;
  }
}
window.geoEditTest = api;
