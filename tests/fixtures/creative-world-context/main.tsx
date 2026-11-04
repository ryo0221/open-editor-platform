import { createRoot } from 'react-dom/client';
import { canonicalJson, IndexedDBStorage, type Artifact } from '@editor-platform/artifact-core';
import { updateBlock } from '@editor-platform/document/model';
import {
  CreativeWorkspace,
  CreativeProductionHost,
  createHarborWorkspace,
  type CreativeWorkspaceStorage,
  type SceneReturn,
} from '@editor-platform/reference-artifact-host/creative/workspace';

const root = createRoot(document.getElementById('root')!);
async function mount() {
  const store = new IndexedDBStorage<Artifact<unknown>>();
  let read = true,
    write = true,
    fail = false,
    holdReads = false,
    holdWrites = false;
  let reads: (() => void)[] = [],
    writes: (() => void)[] = [];
  const key = 'creative-design:production:harbor';
  const io: CreativeWorkspaceStorage = {
    artifacts: {
      get: async (id) => {
        if (holdReads) await new Promise<void>((r) => reads.push(r));
        return store.get(id);
      },
      list: () => store.list(),
      put: (a) => store.put(a),
      remove: (id) => store.remove(id),
      putIfAbsent: (a) => store.putIfAbsent(a),
    },
    creative: (mode) => ({
      artifacts: store,
      readMapping: async () => {
        const s = localStorage.getItem(`cw1:${mode}`);
        return s ? JSON.parse(s) : undefined;
      },
      writeMapping: async (v) => localStorage.setItem(`cw1:${mode}`, JSON.stringify(v)),
    }),
    readLinks: async () => {
      const s = localStorage.getItem(key);
      return s ? JSON.parse(s) : undefined;
    },
    writeLinks: async (v, expected) => {
      if (holdWrites) await new Promise<void>((r) => writes.push(r));
      if (fail) {
        fail = false;
        throw Error('fixture: disk full');
      }
      if (!write) throw Error('fixture: permission revoked');
      const current = await io.readLinks();
      if (expected && canonicalJson(expected) !== canonicalJson(current))
        throw Error('fixture: revision conflict');
      localStorage.setItem(key, JSON.stringify(v));
    },
  };
  await createHarborWorkspace(io);
  const workspace = await CreativeWorkspace.open(
    io,
    () => write,
    () => read,
  );
  let revision = 0;
  const render = () => {
    revision++;
    root.render(
      <div data-authority-revision={revision}>
        <CreativeProductionHost workspace={workspace} />
      </div>,
    );
  };
  window.worldFixture = {
    async richFacts() {
      const context = workspace.worldContext('work'),
        reference = context.references[0];
      const editor = await workspace.openWorldSource(reference);
      editor.execute(
        updateBlock('world-facts', {
          rich: [{ text: 'rich spansの採用事実', bold: true }],
        }) as never,
      );
      await workspace.saveWorldSource(editor.id);
      const latest = (await workspace.readWorld('work'))[0].latest!;
      await workspace.saveWorldContext(
        {
          ...context,
          references: context.references.map((r) =>
            r.id === reference.id ? { ...r, ...latest } : r,
          ),
        },
        context.revision,
      );
      render();
    },
    get currentReturn() {
      return workspace.mapping.returnTo;
    },
    read(value) {
      read = value;
      render();
    },
    write(value) {
      write = value;
      render();
    },
    failNext() {
      fail = true;
    },
    holdReads(value) {
      holdReads = value;
    },
    holdWrites(value) {
      holdWrites = value;
    },
    releaseReads() {
      holdReads = false;
      const pending = reads;
      reads = [];
      pending.forEach((r) => r());
    },
    releaseWrites() {
      holdWrites = false;
      const pending = writes;
      writes = [];
      pending.forEach((r) => r());
    },
    get pendingReads() {
      return reads.length;
    },
    get pendingWrites() {
      return writes.length;
    },
    async corrupt(kind) {
      const a = (await store.get('cw1:harbor:facts'))!;
      if (kind === 'hash') a.versions[0].contentHash = '0'.repeat(64);
      else if (kind === 'version') a.versions = [];
      else {
        await store.remove(a.id);
        return;
      }
      await store.put(a);
    },
  };
  render();
}
declare global {
  interface Window {
    worldFixture: {
      richFacts(): Promise<void>;
      readonly currentReturn: SceneReturn | undefined;
      read(v: boolean): void;
      write(v: boolean): void;
      failNext(): void;
      holdReads(v: boolean): void;
      holdWrites(v: boolean): void;
      releaseReads(): void;
      releaseWrites(): void;
      readonly pendingReads: number;
      readonly pendingWrites: number;
      corrupt(kind: 'hash' | 'version' | 'artifact'): Promise<void>;
    };
  }
}
void mount();
