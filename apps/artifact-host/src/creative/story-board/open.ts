import {
  canonicalJson,
  contentHash,
  deepFreeze,
  deserializeArtifact,
  type Artifact,
  type StorageAdapter,
} from '@editor-platform/artifact-core';
import { serializeHostNativeArtifact } from '@editor-platform/editor-host';
import { isWhiteboard, type WhiteboardContent } from '@editor-platform/whiteboard/model';
import type { StructuredData } from '@editor-platform/structured-data/model';
import { readBoardSettings, type BoardPanel, type BoardSettings } from './settings';

export class BoardOpenError extends Error {
  constructor(readonly reason: 'unavailable' | 'invalid' | 'stale') {
    super(
      reason === 'stale'
        ? '物語ボードの対象または権限が変わりました。読み直してください。'
        : '物語ボードを開けません。指定と閲覧権限を確認してください。',
    );
  }
}
export interface BoardOpenOptions {
  mayRead(id: string): boolean;
  /** Changes on source writes, permission changes or a different open request (including ABA). */
  generation(): unknown;
  namespace: string;
  expectedBoardId?: string;
  signal?: AbortSignal;
}
export interface OpenedStoryBoard {
  settingsArtifact: Artifact<StructuredData>;
  settings: BoardSettings;
  settingsVersion: string;
  boardArtifact: Artifact<WhiteboardContent>;
  panels: BoardPanel[];
  orphanPanels: { panel: BoardPanel; reason: 'missing' | 'kind' }[];
  viewKey: string;
  /** Host must clear projected data when this becomes false, including after rendering. */
  current(): boolean;
}

/** Explicit settings ID only: no library scan, native sentinel names or WorkspaceLinks mutation. */
export async function openStoryBoard(
  storage: Pick<StorageAdapter<Artifact<unknown>>, 'get'>,
  settingsId: string,
  options: BoardOpenOptions,
): Promise<OpenedStoryBoard> {
  const generation = options.generation(),
    read = new Set<string>();
  const current = () =>
    !options.signal?.aborted &&
    Object.is(generation, options.generation()) &&
    [...read].every((id) => options.mayRead(id));
  const check = () => {
    if (!current()) throw new BoardOpenError('stale');
  };
  const get = async (id: string, kind: string, valid: (value: unknown) => boolean) => {
    check();
    if (!options.mayRead(id)) throw new BoardOpenError('unavailable');
    read.add(id);
    let raw: Artifact<unknown> | undefined;
    try {
      raw = await storage.get(id);
    } catch {
      check();
      throw new BoardOpenError('unavailable');
    }
    check();
    if (!raw) throw new BoardOpenError('unavailable');
    let a: Artifact<unknown>;
    try {
      const encoded = serializeHostNativeArtifact(raw);
      a = deserializeArtifact(encoded);
      if (a.id !== id || a.kind !== kind || !valid(a.draft.content)) throw new Error();
      const ids = new Set<string>();
      for (const v of a.versions) {
        if (
          ids.has(v.versionId) ||
          !valid(v.content) ||
          v.contentHash !== (await contentHash(v.content))
        )
          throw new Error();
        ids.add(v.versionId);
        check();
      }
      if (!a.draft.baseVersionId || !ids.has(a.draft.baseVersionId)) throw new Error();
    } catch (error) {
      check();
      if (error instanceof BoardOpenError) throw error;
      throw new BoardOpenError('invalid');
    }
    check();
    return a;
  };
  if (!settingsId.trim() || !options.namespace.trim()) throw new BoardOpenError('invalid');
  const settingsArtifact = (await get(settingsId, 'data', (value) => {
    try {
      readBoardSettings(value);
      return true;
    } catch {
      return false;
    }
  })) as Artifact<StructuredData>;
  const adopted = settingsArtifact.versions.find(
    (v) => v.versionId === settingsArtifact.draft.baseVersionId,
  )!;
  const settings = readBoardSettings(adopted.content);
  if (options.expectedBoardId !== undefined && options.expectedBoardId !== settings.boardArtifactId)
    throw new BoardOpenError('invalid');
  const boardArtifact = (await get(
    settings.boardArtifactId,
    'whiteboard',
    isWhiteboard,
  )) as Artifact<WhiteboardContent>;
  const panels: BoardPanel[] = [],
    orphanPanels: OpenedStoryBoard['orphanPanels'] = [];
  for (const panel of settings.panels) {
    const node = boardArtifact.draft.content.nodes.find((n) => n.id === panel.nodeId);
    if (!node) orphanPanels.push({ panel, reason: 'missing' });
    else if (node.kind !== 'shape' || node.shape !== 'rectangle')
      orphanPanels.push({ panel, reason: 'kind' });
    else panels.push(panel);
  }
  check();
  return deepFreeze({
    settingsArtifact,
    settings,
    settingsVersion: adopted.versionId,
    boardArtifact,
    panels,
    orphanPanels,
    viewKey: canonicalJson(['story-board', options.namespace, boardArtifact.id, settingsId]),
    current,
  });
}
