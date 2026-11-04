import { createDocument } from '@editor-platform/document/model';
import { createRoot } from 'react-dom/client';
import {
  canonicalJson,
  clone,
  commitVersion,
  updateDraft,
  IndexedDBStorage,
  type Artifact,
} from '@editor-platform/artifact-core';
import {
  CreativeWorkspace,
  CreativeProductionHost,
  CreativeWorldHost,
  readWorkspaceLinks,
  createHarborWorkspace,
  type CreativeWorkspaceStorage,
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
  const query = new URLSearchParams(location.search);
  const count = Number(query.get('scenes'));
  if (count) {
    const links = readWorkspaceLinks(await io.readLinks());
    const original = (await store.get(links.scenes[0].origin.artifactId))!;
    const content = createDocument();
    content.blocks = Array.from({ length: count }, (_, i) => ({
      id: `scene-${i}`,
      type: 'heading' as const,
      level: 2 as const,
      text: `Scene ${i}`,
    }));
    const a = await commitVersion(
      updateDraft(original, content),
      null,
      'Large normal workspace fixture',
    );
    await store.put(a);
    links.scenes = Array.from({ length: count }, (_, i) => ({
      ...clone(links.scenes[0]),
      id: `SC-${i}`,
      origin: { artifactId: a.id, versionId: a.draft.baseVersionId!, elementId: `scene-${i}` },
      members: [],
    }));
    delete links.world;
    delete links.returnTo;
    await io.writeLinks(links);
  } else {
    const w = await CreativeWorkspace.open(io);
    const links = w.mapping,
      base = links.world!.contexts[0].references[0];
    for (const mode of ['character', 'setting'] as const) {
      const p = w.project(mode);
      for (const card of p.cards) {
        const chosen = p.binding(card)!.chosenFrameId;
        const frames = p
          .editor(card)!
          .content.elements.filter((e) => e.type === 'frame' && !e.parentId)
          .slice(0, 2);
        for (const frame of frames) {
          p.choose(card, frame.id);
          links.world!.contexts.push({
            id: w.itemContextId(mode, card.id)!,
            revision: 0,
            references: [{ ...base, id: `target-${card.id}-${frame.id}`, role: 'identity' }],
          });
        }
        p.choose(card, chosen);
      }
      await p.save();
    }
    await io.writeLinks(links);
  }
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
        {query.get('host') === 'character' ? (
          <CreativeWorldHost workspace={workspace} project={workspace.characters} />
        ) : query.get('host') === 'setting' ? (
          <CreativeWorldHost workspace={workspace} project={workspace.settings} />
        ) : (
          <CreativeProductionHost workspace={workspace} />
        )}
      </div>,
    );
  };
  window.worldReview = {
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
    worldReview: {
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
