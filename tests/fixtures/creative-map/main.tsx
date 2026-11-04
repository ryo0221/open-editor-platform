import { createRoot } from 'react-dom/client';
import {
  clone,
  canonicalJson,
  IndexedDBStorage,
  type Artifact,
} from '@editor-platform/artifact-core';
import {
  CreativeWorkspace,
  CreativeProductionHost,
  CreativeWorldHost,
  createHarborWorkspace,
  createHarborMapFixture,
  type CreativeWorkspaceStorage,
} from '@editor-platform/reference-artifact-host/creative/workspace';

async function mount() {
  const root = createRoot(document.getElementById('root')!);
  const store = new IndexedDBStorage<Artifact<unknown>>();
  const denied = new Set<string>(),
    access = { write: true };
  const faults = { native: '', links: '', holdRead: false, holding: false };
  let release: (() => void) | undefined;
  const io: CreativeWorkspaceStorage = {
    artifacts: {
      list: store.list.bind(store),
      remove: store.remove.bind(store),
      putIfAbsent: store.putIfAbsent.bind(store),
      get: async (id) => {
        const value = await store.get(id);
        if (faults.holdRead && id === 'cw3:harbor:map') {
          faults.holdRead = false;
          faults.holding = true;
          await new Promise<void>((r) => {
            release = r;
          });
          faults.holding = false;
        }
        return value;
      },
      put: async (a) => {
        if (faults.native === 'fail') {
          faults.native = '';
          throw Error('fixture native disk full');
        }
        await store.put(a);
        if (faults.native === 'lost') {
          faults.native = '';
          throw Error('fixture native lost ack');
        }
      },
    },
    creative: (mode) => ({
      artifacts: store,
      readMapping: async () => JSON.parse(localStorage.getItem('cw3:mode:' + mode) ?? 'null'),
      writeMapping: async (v) => localStorage.setItem('cw3:mode:' + mode, JSON.stringify(v)),
    }),
    readLinks: async () => JSON.parse(localStorage.getItem('cw3:links') ?? 'null'),
    writeLinks: async (v, expected) => {
      if (faults.links === 'fail') {
        faults.links = '';
        throw Error('fixture links disk full');
      }
      const previous = await io.readLinks();
      if (expected && canonicalJson(expected) !== canonicalJson(previous))
        throw Error('fixture CAS conflict');
      localStorage.setItem('cw3:links', JSON.stringify(v));
      if (faults.links === 'lost') {
        faults.links = '';
        throw Error('fixture links lost ack');
      }
    },
  };
  if (!(await io.readLinks())) {
    const w = await createHarborWorkspace(io);
    await createHarborMapFixture(w);
  }
  const params = new URLSearchParams(location.search);
  access.write = params.get('viewer') !== 'true';
  const workspace = await CreativeWorkspace.open(
    io,
    () => access.write,
    (id) => !denied.has(id),
  );
  const surface = params.get('surface') ?? 'production';
  function render() {
    root.render(
      surface === 'production' ? (
        <CreativeProductionHost workspace={workspace} />
      ) : surface === 'character' ? (
        <CreativeWorldHost workspace={workspace} project={workspace.characters} />
      ) : (
        <CreativeWorldHost workspace={workspace} project={workspace.settings} />
      ),
    );
  }
  window.cw3Fixture = {
    workspace,
    links: () => workspace.mapping,
    artifacts: () => store.list(),
    native: (id) => store.get(id),
    faults: (value) => {
      Object.assign(faults, value);
    },
    holding: () => faults.holding,
    release: () => release?.(),
    permission: (id, allowed) => {
      if (allowed) denied.delete(id);
      else denied.add(id);
      render();
    },
    write: (allowed) => {
      access.write = allowed;
      render();
    },
    async sceneSelection() {
      return (await workspace.openScene('SC-01')).snapshot.selection;
    },
    async damage(kind) {
      const r = workspace.maps.mapping.locations.find((r) => r.id === 'harbor-map:SC-01:LO-02')!;
      if (kind === 'artifact') await store.remove(r.map.artifactId);
      else {
        const links = clone(workspace.mapping);
        const target = links.mapLocations!.locations.find((v) => v.id === r.id)!;
        if (kind === 'hash') target.map.contentHash = '0'.repeat(64);
        if (kind === 'feature') target.map.featureIds = ['deleted'];
        if (kind === 'ref') target.map.featureIds = ['house'];
        localStorage.setItem('cw3:links', JSON.stringify(links));
      }
    },
  };
  render();
}
declare global {
  interface Window {
    cw3Fixture: {
      workspace: CreativeWorkspace;
      links(): CreativeWorkspace['mapping'];
      artifacts(): Promise<Artifact<unknown>[]>;
      native(id: string): Promise<Artifact<unknown> | undefined>;
      faults(value: { native?: string; links?: string; holdRead?: boolean }): void;
      holding(): boolean;
      release(): void;
      permission(id: string, allowed: boolean): void;
      write(allowed: boolean): void;
      sceneSelection(): Promise<import('@editor-platform/editor-core').Selection>;
      damage(kind: 'artifact' | 'hash' | 'feature' | 'ref'): Promise<void>;
    };
  }
}
void mount().catch((e) => {
  const error = document.createElement('p');
  error.setAttribute('role', 'alert');
  error.textContent = String(e);
  document.getElementById('root')!.append(error);
});
