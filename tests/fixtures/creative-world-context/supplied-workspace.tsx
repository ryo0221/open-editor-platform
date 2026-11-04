import {
  MemoryStorage,
  IndexedDBStorage,
  clone,
  type Artifact,
} from '@editor-platform/artifact-core';
import { characterMode } from '@editor-platform/reference-artifact-host/creative';
import { settingMode } from '@editor-platform/reference-artifact-host/creative/setting';
import { mountCreativeMode } from '@editor-platform/reference-artifact-host/creative/browser';
import {
  createHarborWorkspace,
  type CreativeWorkspaceStorage,
} from '@editor-platform/reference-artifact-host/creative/workspace';
async function mount() {
  const artifacts = new MemoryStorage<Artifact<unknown>>();
  let links: unknown;
  const maps: Record<string, unknown> = {};
  const io: CreativeWorkspaceStorage = {
    artifacts,
    readLinks: async () => clone(links),
    writeLinks: async (v) => {
      links = clone(v);
    },
    creative: (mode) => ({
      artifacts,
      readMapping: async () => clone(maps[mode]),
      writeMapping: async (v) => {
        maps[mode] = clone(v);
      },
    }),
  };
  const workspace = await createHarborWorkspace(io);
  const before = (await artifacts.list()).map((a) => a.id).sort();
  if (new URLSearchParams(location.search).has('setting'))
    await mountCreativeMode(settingMode, { workspace });
  else await mountCreativeMode(characterMode, { workspace });
  window.suppliedWorld = {
    before,
    after: (await artifacts.list()).map((a) => a.id).sort(),
    unrelated: (await new IndexedDBStorage<Artifact<unknown>>().list()).map((a) => a.id),
  };
}
declare global {
  interface Window {
    suppliedWorld: { before: string[]; after: string[]; unrelated: string[] };
  }
}
void mount();
