import { createRoot } from 'react-dom/client';
import { canonicalJson, IndexedDBStorage, type Artifact } from '@editor-platform/artifact-core';
import { CreativeWorkspace, type CreativeWorkspaceStorage } from './model';
import { createHarborWorkspace } from './fixture';
import { createHarborMapFixture } from './map-fixture';
import { CreativeProductionHost } from './host';
import type { CreativeLayerConnection } from '../generation';
import {
  createCreativeWorldGenerationConnection,
  type CreativeWorldGenerationOptions,
} from './generation-execution';
import { showCreativeError } from '../browser';

export function createBrowserWorkspaceStorage(
  artifacts = new IndexedDBStorage<Artifact<unknown>>(),
): CreativeWorkspaceStorage {
  return {
    artifacts,
    creative(mode) {
      const sourceId = mode === 'character' ? 'd3a:characters' : 'd3a:world-notes';
      const key = `creative-design:${mode}:${sourceId}`;
      return {
        artifacts,
        readMapping: async () => {
          const s = localStorage.getItem(key);
          return s ? JSON.parse(s) : undefined;
        },
        writeMapping: async (v) => {
          localStorage.setItem(key, JSON.stringify(v));
        },
      };
    },
    readLinks: async () => {
      const s = localStorage.getItem('creative-design:production:harbor');
      return s ? JSON.parse(s) : undefined;
    },
    writeLinks: async (v, expected) => {
      const current = localStorage.getItem('creative-design:production:harbor');
      if (
        expected &&
        canonicalJson(current ? JSON.parse(current) : undefined) !== canonicalJson(expected)
      )
        throw Error('参照表の保存が競合しています。');
      localStorage.setItem('creative-design:production:harbor', JSON.stringify(v));
    },
  };
}
export async function mountCreativeProduction(options?: {
  generation?: CreativeLayerConnection;
  worldGeneration?: (workspace: CreativeWorkspace) => CreativeWorldGenerationOptions;
}) {
  if (options?.generation && options.worldGeneration)
    throw Error('生成接続は一つだけ指定してください。');
  const io = createBrowserWorkspaceStorage();
  const mayEdit = () => new URLSearchParams(location.search).get('access') !== 'viewer';
  const root = createRoot(document.getElementById('root')!);
  const render = (workspace: CreativeWorkspace) => {
    const generation = options?.worldGeneration
      ? createCreativeWorldGenerationConnection(workspace, options.worldGeneration(workspace))
      : options?.generation;
    root.render(<CreativeProductionHost workspace={workspace} generation={generation} />);
  };
  if (await io.readLinks()) render(await CreativeWorkspace.open(io, mayEdit));
  else
    root.render(
      <main className="production-start">
        <h1>小説・漫画の横断制作</h1>
        <p>港町の人物2名、場所2件、小説2Scene、漫画1ページと固定地図を用意します。</p>
        <button
          disabled={!mayEdit()}
          onClick={async (event) => {
            const button = event.currentTarget;
            button.disabled = true;
            try {
              const workspace = await createHarborWorkspace(io, mayEdit);
              await createHarborMapFixture(workspace);
              render(workspace);
            } catch (e) {
              if (button.isConnected) button.disabled = !mayEdit();
              showCreativeError(e);
            }
          }}
        >
          港町の制作例を作成
        </button>
      </main>,
    );
}
