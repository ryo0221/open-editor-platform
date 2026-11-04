import { expect, it } from 'vitest';
import {
  canonicalJson,
  commitVersion,
  createArtifact,
  MemoryStorage,
  type Artifact,
} from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import { createWhiteboard, makeWhiteboardNode } from '@editor-platform/whiteboard/model';
import {
  BOARD_LIMITS,
  changeBoardSettings,
  createBoardSettingsData,
  readBoardSettings,
  validateBoardFilter,
  validateBoardSettings,
  type BoardFilter,
  type BoardSettings,
} from './settings';
import { openStoryBoard, BoardOpenError } from './open';

export function settingsFixture(boardArtifactId = 'board'): BoardSettings {
  return {
    schemaVersion: 1,
    boardArtifactId,
    storyId: 'story-S',
    world: 'world-A',
    clock: 'CL-1',
    map: {
      artifactId: 'map',
      versionId: 'map-v1',
      contentHash: 'a'.repeat(64),
      view: { kind: 'document' },
    },
    panels: [
      { nodeId: 'timeline', kind: 'timeline' },
      { nodeId: 'map', kind: 'map' },
    ],
    locations: [],
    groups: [],
    presets: [],
  };
}
const all: BoardFilter = {
  individuals: { kind: 'all' },
  places: { kind: 'all' },
  groups: { kind: 'all' },
  time: { kind: 'all' },
  includeUnknown: true,
};
async function fixture() {
  const storage = new MemoryStorage<Artifact<unknown>>();
  const content = createWhiteboard();
  content.nodes = ['timeline', 'map'].map((id) => ({
    ...makeWhiteboardNode('shape'),
    id,
    shape: 'rectangle' as const,
    text: '中立の枠',
  }));
  const board = await commitVersion(
    { ...createArtifact('whiteboard', 'Board', content), id: 'board' },
    null,
    null,
  );
  const config = await commitVersion(
    {
      ...createArtifact('data', '表示設定', createBoardSettingsData(settingsFixture())),
      id: 'config',
    },
    null,
    null,
  );
  await storage.put(board);
  await storage.put(config);
  let generation = 0;
  const hidden = new Set<string>();
  const options = {
    namespace: 'test',
    mayRead: (id: string) => !hidden.has(id),
    generation: () => generation,
  };
  return {
    storage,
    board: structuredClone(board),
    config: structuredClone(config),
    hidden,
    options,
    invalidate: () => {
      generation++;
    },
  };
}
it('SB01/09: explicit settings opens adopted config and current board layout without writing or history', async () => {
  const f = await fixture();
  // A valid unsaved settings draft must not replace the adopted settings source.
  f.config.draft.content = createBoardSettingsData(settingsFixture('a-different-board'));
  await f.storage.put(f.config);
  const before = canonicalJson(await f.storage.list());
  const opened = await openStoryBoard(f.storage, 'config', f.options);
  expect(opened.settings.boardArtifactId).toBe('board');
  expect(opened.settingsVersion).toBe(f.config.draft.baseVersionId);
  expect(opened.panels).toHaveLength(2);
  expect(opened.orphanPanels).toEqual([]);
  expect(opened.current()).toBe(true);
  expect(canonicalJson(await f.storage.list())).toBe(before);
  expect(Object.isFrozen(opened.settings.map)).toBe(true);
  f.invalidate();
  expect(opened.current()).toBe(false);
});
it('SB06/10: settings is native Data with one owner-local command/Undo and stale CAS refusal', () => {
  const initial = settingsFixture();
  const source = createBoardSettingsData(initial),
    session = new EditorSession(source);
  const next = {
    ...initial,
    presets: [
      {
        id: 'view-1',
        name: '遠征組',
        filter: {
          ...all,
          individuals: { kind: 'set' as const, ids: [] },
        },
      },
    ],
  };
  const before = canonicalJson(source);
  const command = changeBoardSettings(next, initial);
  session.execute(command);
  expect(readBoardSettings(session.content).presets[0].filter.individuals).toEqual({
    kind: 'set',
    ids: [],
  });
  const applied = canonicalJson(session.content),
    revision = session.revision;
  expect(() => session.execute(command)).toThrow();
  expect(canonicalJson(session.content)).toBe(applied);
  expect(session.revision).toEqual(revision);
  expect(canonicalJson(source)).toBe(before);
  session.undo();
  expect(session.content).toEqual(source);
  expect(session.canUndo).toBe(false);
  session.redo();
  expect(canonicalJson(session.content)).toBe(applied);
});
it.each([
  (s: BoardSettings) => ({ ...s, schemaVersion: 2 }),
  (s: BoardSettings) => ({ ...s, unknown: true }),
  (s: BoardSettings) => ({ ...s, panels: [...s.panels, s.panels[0]] }),
  (s: BoardSettings) => ({ ...s, panels: [{ nodeId: 'x', kind: 'script' }] }),
  (s: BoardSettings) => ({ ...s, map: { ...s.map, contentHash: 'bad' } }),
  (s: BoardSettings) => ({ ...s, map: { ...s.map, featureIds: [] } }),
  (s: BoardSettings) => ({
    ...s,
    panels: [{ nodeId: 'x', kind: 'event-card', event: { itemId: 'EV-1' } }],
  }),
  (s: BoardSettings) => ({
    ...s,
    panels: Array.from({ length: BOARD_LIMITS.panels + 1 }, (_, i) => ({
      kind: 'map',
      nodeId: String(i),
    })),
  }),
])('SB06/13: malformed/unknown/duplicate/oversized settings refuse %#', (change) => {
  expect(() => validateBoardSettings(change(settingsFixture()))).toThrow();
});
it.each([{ kind: 'all', ids: [] }, { kind: 'set' }, { kind: 'set', ids: ['x', 'x'] }])(
  'SB02/06: malformed choice refuses without widening to all %#',
  (individuals) => {
    expect(() => validateBoardFilter({ ...all, individuals })).toThrow();
  },
);
it('SB06: settings payload refuses noncanonical/duplicate JSON keys, wrong columns and over-budget bytes', () => {
  const native = createBoardSettingsData(settingsFixture());
  const payload = native.rows[0].values['sb1.payload'] as string;
  for (const invalid of [
    ' ' + payload,
    payload.replace('{', '{"schemaVersion":2,'),
    ' '.repeat(BOARD_LIMITS.payloadBytes + 1),
  ]) {
    const changed = structuredClone(native);
    changed.rows[0].values['sb1.payload'] = invalid;
    expect(() => readBoardSettings(changed)).toThrow();
  }
  native.columns[1].id = 'sb2.payload';
  expect(() => readBoardSettings(native)).toThrow();
});
it('SB13: only explicitly bound rectangle-shapes are panels; names and cloned frames do not activate', async () => {
  const f = await fixture();
  const nodes = f.board.draft.content.nodes;
  nodes.push({ ...nodes[0], id: 'copy', name: 'timeline', text: 'map' });
  nodes[0].kind = 'sticky';
  const open = () => openStoryBoard(f.storage, 'config', f.options);
  await f.storage.put(f.board);
  let opened = await open();
  expect(opened.panels.map((p) => p.nodeId)).toEqual(['map']);
  expect(opened.orphanPanels.map((p) => p.reason)).toEqual(['kind']);
  f.board.draft.content.nodes = nodes.filter((n) => n.id !== 'map');
  await f.storage.put(f.board);
  opened = await open();
  expect(opened.orphanPanels.map((p) => p.reason)).toEqual(['kind', 'missing']);
  nodes[0].kind = 'shape';
  f.board.draft.content.nodes = nodes;
  await f.storage.put(f.board);
  expect((await open()).panels).toHaveLength(2);
});
it('SB01: distinct board and settings identities have distinct opaque camera keys', async () => {
  const f = await fixture();
  const first = await openStoryBoard(f.storage, 'config', f.options);
  const config = await commitVersion(
    {
      ...createArtifact('data', 'Other', createBoardSettingsData(settingsFixture())),
      id: 'config-other',
    },
    null,
    null,
  );
  await f.storage.put(config);
  const second = await openStoryBoard(f.storage, config.id, f.options);
  expect(second.viewKey).not.toBe(first.viewKey);
});
it('SB11/12: forbidden config performs zero reads and exposes no identity/name/count', async () => {
  const f = await fixture();
  f.hidden.add('secret-config');
  const calls: string[] = [];
  await expect(
    openStoryBoard(
      {
        get: async (id) => {
          calls.push(id);
          return f.config;
        },
      },
      'secret-config',
      f.options,
    ),
  ).rejects.toMatchObject({ reason: 'unavailable' });
  expect(calls).toEqual([]);
});
it.each(['missing', 'wrong-id', 'wrong-board', 'hash', 'duplicate-version', 'native'] as const)(
  'SB11: %s refuses explicit open without scanning/fallback',
  async (mode) => {
    const f = await fixture();
    if (mode === 'wrong-id') f.config.id = 'wrong';
    if (mode === 'hash') f.config.versions[0].contentHash = '0'.repeat(64);
    if (mode === 'duplicate-version') f.config.versions.push(f.config.versions[0]);
    if (mode === 'native') f.board.versions[0].content.schemaVersion = 99 as 3;
    const calls: string[] = [];
    const source = {
      get: async (id: string) => {
        calls.push(id);
        return mode === 'missing' ? undefined : id === 'config' ? f.config : f.board;
      },
    };
    await expect(
      openStoryBoard(source, 'config', {
        ...f.options,
        ...(mode === 'wrong-board' ? { expectedBoardId: 'other' } : {}),
      }),
    ).rejects.toBeInstanceOf(BoardOpenError);
    expect(calls.every((id) => id === 'config' || id === 'board')).toBe(true);
    if (mode === 'wrong-board') expect(calls).toEqual(['config']);
  },
);
it.each(['generation', 'revocation', 'abort'] as const)(
  'SB11/12: %s during async read discards response',
  async (mode) => {
    const f = await fixture(),
      controller = new AbortController();
    const source = {
      get: async (id: string) => {
        if (mode === 'generation') f.invalidate();
        if (mode === 'revocation') f.hidden.add(id);
        if (mode === 'abort') controller.abort();
        return f.storage.get(id);
      },
    };
    await expect(
      openStoryBoard(source, 'config', { ...f.options, signal: controller.signal }),
    ).rejects.toMatchObject({ reason: 'stale' });
  },
);

it('SB12: config revocation while reading the board invalidates the complete read set', async () => {
  const f = await fixture();
  const before = canonicalJson(await f.storage.list());
  const source = {
    get: async (id: string) => {
      if (id === 'board') f.hidden.add('config');
      return f.storage.get(id);
    },
  };
  await expect(openStoryBoard(source, 'config', f.options)).rejects.toMatchObject({
    reason: 'stale',
  });
  expect(canonicalJson(await f.storage.list())).toBe(before);
});
it('SB12: source exceptions are redacted instead of exposing names from a storage error', async () => {
  const f = await fixture();
  const result = openStoryBoard(
    {
      get: async () => {
        throw Error('secret-name 31 people');
      },
    },
    'config',
    f.options,
  );
  await expect(result).rejects.toThrow('物語ボードを開けません。');
  await expect(result).rejects.not.toThrow('secret-name');
});
