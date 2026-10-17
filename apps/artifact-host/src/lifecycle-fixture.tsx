import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HostApp } from './HostApp';
import { BrowserArtifactStorage, referenceArtifacts } from './model';
import type { HostContent } from './model';
import type { Artifact, StorageAdapter } from '@editor-platform/artifact-core';
import type { HostAccessAdapter, HostAccessMetadata } from '@editor-platform/editor-host';
declare const __ARTIFACT_PREVIEW_DOCUMENT__: string;
const samples = referenceArtifacts();
const base = new BrowserArtifactStorage(localStorage, 'lifecycle-fixture:');
let finishLoad = () => {},
  finishSave = () => {};
const loaded = new Promise<void>((resolve) => {
  finishLoad = resolve;
});
const oldReads: ((value: HostAccessMetadata) => void)[] = [];
const oldAccess: HostAccessAdapter = {
  read: () =>
    new Promise((resolve) => {
      oldReads.push(resolve);
    }),
};
const newAccess: HostAccessAdapter = {
  async read() {
    return { scope: 'public', revision: 1, expiresAt: Date.now() + 60000, source: 'fixture' };
  },
};
function Fixture() {
  const [pending, setPending] = useState(false);
  const [adapter, setAdapter] = useState(oldAccess);
  const [storage] = useState<StorageAdapter<Artifact<HostContent>>>(() => ({
    async list() {
      await loaded;
      return base.list();
    },
    get: (id) => base.get(id),
    remove: (id) => base.remove(id),
    async put(value) {
      setPending(true);
      await new Promise<void>((resolve) => {
        finishSave = resolve;
      });
      await base.put(value);
      setPending(false);
    },
  }));
  return (
    <>
      <p>Injected asynchronous adapters; reference fixture only.</p>
      <button onClick={() => finishLoad()}>Finish initial load</button>
      <button onClick={() => setAdapter(newAccess)}>Replace access adapter</button>
      <button
        onClick={() =>
          oldReads
            .splice(0)
            .forEach((resolve) =>
              resolve({
                scope: 'owner-only',
                revision: 1,
                expiresAt: Date.now() + 60000,
                source: 'old fixture',
              }),
            )
        }
      >
        Finish old access reads
      </button>
      <button onClick={() => finishSave()}>Finish pending save</button>
      <output aria-label="Fixture save state">{pending ? 'Save pending' : 'Save idle'}</output>
      <HostApp
        samples={samples}
        storage={storage}
        accessAdapter={adapter}
        previewDocument={__ARTIFACT_PREVIEW_DOCUMENT__}
      />
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
