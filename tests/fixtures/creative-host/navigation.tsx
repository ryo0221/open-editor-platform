import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { clone, MemoryStorage, type Artifact } from '@editor-platform/artifact-core';
import {
  CreativeProductionHost,
  CreativeWorkspace,
  createHarborWorkspace,
  createHarborMapFixture,
  type CreativeWorkspaceStorage,
} from '@editor-platform/reference-artifact-host/creative/workspace';

/** Test-only consuming router. Calls the public Host; no production hook is installed. */
async function mount() {
  const artifacts = new MemoryStorage<Artifact<unknown>>();
  const mappings: Record<string, unknown> = {};
  let links: unknown,
    writes = 0;
  let pause: Promise<void> | undefined,
    resume: (() => void) | undefined,
    failSave = false;
  const io: CreativeWorkspaceStorage = {
    artifacts: {
      list: () => artifacts.list(),
      get: (id) => artifacts.get(id),
      remove: (id) => artifacts.remove(id),
      put: async (value) => {
        await pause;
        if (failSave) throw Error('fixture storage failure');
        writes++;
        await artifacts.put(value);
      },
    },
    creative: (mode) => ({
      artifacts,
      readMapping: async () => clone(mappings[mode]),
      writeMapping: async (value) => {
        mappings[mode] = clone(value);
      },
    }),
    readLinks: async () => clone(links),
    writeLinks: async (value) => {
      await pause;
      if (failSave) throw Error('fixture storage failure');
      links = clone(value);
    },
  };
  let workspace = await createHarborWorkspace(io);
  if (new URLSearchParams(location.search).has('noWorld')) {
    const unconnected = workspace.mapping;
    delete unconnected.world;
    links = unconnected;
    workspace = await CreativeWorkspace.open(io);
  }
  if (new URLSearchParams(location.search).has('return')) await workspace.captureReturn('SC-01');
  let mapEditor: Awaited<ReturnType<typeof workspace.maps.openUnbound>> | undefined;
  if (new URLSearchParams(location.search).has('map')) {
    await createHarborMapFixture(workspace);
    const ref = workspace.maps.mapping.locations.find(
      (r) => r.sceneId === 'SC-01' && r.itemId === 'LO-02',
    )!;
    mapEditor = await workspace.maps.openUnbound(ref.map.artifactId, ref.map.versionId);
  }
  writes = 0;
  const before = JSON.stringify(await artifacts.list());
  Object.assign(window, {
    creativeNavigation: {
      pauseSave() {
        pause = new Promise<void>((r) => {
          resume = r;
        });
      },
      resumeSave(fail = false) {
        failSave = fail;
        resume?.();
        pause = undefined;
      },
      async owner(kind: 'map' | 'world') {
        const editor =
          kind === 'map'
            ? mapEditor!
            : await workspace.openWorldSource(
                workspace.mapping.world!.contexts[0].references.find(
                  (r) => r.id === 'sample-anime',
                )!,
              );
        return {
          content: clone(editor.content),
          versions: editor.artifact.versions,
          undo: editor.canUndo,
          revision: editor.revision,
        };
      },
      snapshot: async () => ({
        writes,
        unchanged: before === JSON.stringify(await artifacts.list()),
        links: clone(links),
        source: workspace.characters.source.artifact,
        undo: workspace.characters.source.canUndo,
      }),
    },
  });
  function Router() {
    const [state, setState] = useState<{ dirty: boolean; busy: boolean }>();
    const [left, setLeft] = useState(false);
    const [confirm, setConfirm] = useState(false);
    if (left) return <p>移動先</p>;
    return (
      <>
        <output aria-label="外側Hostの編集状態">{JSON.stringify(state ?? null)}</output>
        <button onClick={() => (state?.dirty || state?.busy ? setConfirm(true) : setLeft(true))}>
          画面を移動
        </button>
        {confirm && (
          <div role="dialog" aria-label="未保存の変更">
            <button onClick={() => setConfirm(false)}>制作を続ける</button>
          </div>
        )}
        <CreativeProductionHost
          workspace={workspace}
          title="外側Hostの作品"
          initialSceneId={new URLSearchParams(location.search).get('scene') ?? 'SC-02'}
          onNavigationStateChange={setState}
        />
      </>
    );
  }
  createRoot(document.getElementById('root')!).render(<Router />);
}
void mount();
