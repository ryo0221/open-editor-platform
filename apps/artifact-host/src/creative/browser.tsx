import { createRoot } from 'react-dom/client';
import { IndexedDBStorage, type Artifact } from '@editor-platform/artifact-core';
import { CreativeProject, type CreativeStorage } from './project';
import { CreativeHost } from './host';
import type { CreativeLayerConnection } from './generation';
import type { CreativeMode } from './types';
import { CreativeWorkspace } from './workspace/model';
import { createBrowserWorkspaceStorage } from './workspace/browser';
import {
  createCreativeWorldGenerationConnection,
  type CreativeWorldGenerationOptions,
} from './workspace/generation-execution';
import { CreativeWorldHost } from './workspace/creative-world-host';

/** Reference single-user Host. Consuming products supply their own storage and trusted access. */
export async function mountCreativeMode<T>(
  mode: CreativeMode<T>,
  options?: {
    generation?: CreativeLayerConnection;
    workspace?: CreativeWorkspace;
    worldGeneration?: (workspace: CreativeWorkspace) => CreativeWorldGenerationOptions;
  },
) {
  if (options?.generation && options.worldGeneration)
    throw Error('生成接続は一つだけ指定してください。');
  const artifacts = new IndexedDBStorage<Artifact<unknown>>();
  const query = new URLSearchParams(location.search);
  const sourceId = query.get('source') || undefined;
  const key = `creative-design:${mode.id}:${sourceId ?? 'reference'}`;
  const io: CreativeStorage = {
    artifacts,
    async readMapping() {
      const value = localStorage.getItem(key);
      return value === null ? undefined : JSON.parse(value);
    },
    async writeMapping(value) {
      localStorage.setItem(key, JSON.stringify(value));
    },
  };
  // Viewer is a reference fixture, not authentication. Product Hosts inject trusted mayEdit.
  const writable = () => new URLSearchParams(location.search).get('access') !== 'viewer';
  let workspace = options?.workspace;
  const workspaceStorage = createBrowserWorkspaceStorage(artifacts);
  if (!workspace && sourceId && (await workspaceStorage.readLinks())) {
    const candidate = await CreativeWorkspace.open(workspaceStorage, writable);
    const role = mode.id === 'character' ? 'character' : 'setting';
    if (candidate.modeAvailable(role) && candidate.project(role).source.id === sourceId)
      workspace = candidate;
  }
  if (options?.worldGeneration && !workspace)
    throw Error('World生成には作品との明示接続が必要です。');
  let project = workspace
    ? (workspace.project(
        mode.id === 'character' ? 'character' : 'setting',
      ) as unknown as CreativeProject<T>)
    : await CreativeProject.open(mode, io, writable, sourceId);
  if (workspace && sourceId && project.source.id !== sourceId)
    throw Error('作品と指定正本の接続が一致しません。');
  if (workspace) {
    const nativeProject = workspace.project(mode.id === 'character' ? 'character' : 'setting');
    if (nativeProject.source.id !== project.source.id)
      throw Error('作品と正本の接続が一致しません。');
    project = nativeProject as unknown as CreativeProject<T>;
    const generation = options?.worldGeneration
      ? createCreativeWorldGenerationConnection(workspace, options.worldGeneration(workspace))
      : options?.generation;
    createRoot(document.getElementById('root')!).render(
      <CreativeWorldHost project={project} workspace={workspace} generation={generation} />,
    );
    return;
  }
  const sources = (await artifacts.list())
    .filter((a) => a.kind === mode.adapter.kind && mode.adapter.validate(a.draft.content))
    .map(({ id, name }) => ({ id, name }));
  createRoot(document.getElementById('root')!).render(
    <CreativeHost
      project={project}
      generation={options?.generation}
      sources={sources}
      connectSource={(id) => {
        const next = new URL(location.href);
        next.searchParams.set('source', id);
        location.assign(next.href);
      }}
    />,
  );
}
export function showCreativeError(error: unknown) {
  const root = document.getElementById('root')!;
  const p = document.createElement('p');
  p.setAttribute('role', 'alert');
  p.textContent = `制作画面を開けません: ${error instanceof Error ? error.message : String(error)}。保存データは削除していません。`;
  root.append(p);
}
