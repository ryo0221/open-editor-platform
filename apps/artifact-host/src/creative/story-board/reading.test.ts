import { expect, it } from 'vitest';
import {
  canonicalJson,
  commitVersion,
  createArtifact,
  updateDraft,
  MemoryStorage,
  type Artifact,
} from '@editor-platform/artifact-core';
import { createFictionMap } from '@editor-platform/fiction-map/model';
import { createDocument } from '@editor-platform/document/model';
import { createWhiteboard, makeWhiteboardNode } from '@editor-platform/whiteboard/model';
import type { StructuredData } from '@editor-platform/structured-data/model';
import { buildF0Sample } from '../timeline/sample';
import { TimelineWorkbench } from '../timeline/workbench';
import { insertRows } from '../timeline/commands';
import { readStoryBoard, type BoardReading } from './reading';
import { filterStoryBoard, boardTimeMatches } from './filter';
import {
  createBoardSettingsData,
  boardIndividualKey,
  boardItemKey,
  type BoardFilter,
  type BoardSettings,
} from './settings';

const all: BoardFilter = {
  individuals: { kind: 'all' },
  places: { kind: 'all' },
  groups: { kind: 'all' },
  time: { kind: 'all' },
  includeUnknown: false,
};
async function fixture() {
  const storage = new MemoryStorage<Artifact<unknown>>(),
    sample = await buildF0Sample();
  for (const a of sample.artifacts) await storage.put(a);
  const w = await TimelineWorkbench.open(storage, sample.links, {
    mayRead: () => true,
    mayEdit: () => true,
  });
  const rows = Array.from({ length: 10 }, (_, i) => {
    const id = `EV-${400 + i}`,
      character = `CH-${String(i + 1).padStart(3, '0')}`;
    return [
      {
        id,
        values: {
          'tl1.row': 'event',
          'tl1.label': `同時進行${i}`,
          'tl1.time.kind': 'point',
          'tl1.time.start': 3,
        },
      },
      {
        id: id + '.presence',
        values: {
          'tl1.row': 'presence',
          'tl1.subject': id,
          'tl1.ind.ch': character,
          'tl1.ind.origin': 'WL-A',
          'tl1.loc': i < 3 ? 'LO-01' : 'LO-02',
          'tl1.time.kind': 'interval',
          'tl1.time.start': 2,
          'tl1.time.end': 4,
          'tl1.certainty': i === 9 ? 'uncertain' : 'confirmed',
        },
      },
    ];
  }).flat();
  expect(w.run('story-ledger-A', () => insertRows('ledger', rows))).toEqual({ ok: true });
  expect(await w.save('story-ledger-A')).toMatchObject({ ok: true });
  const map: ReturnType<typeof createFictionMap> = {
    ...createFictionMap(),
    layers: [{ id: 'places', name: '場所', purpose: 'annotation', visibleByDefault: true }],
    features: [
      {
        id: 'capital',
        name: '王都',
        layerId: 'places',
        featureKind: 'place',
        geometry: { type: 'point', coordinates: [0, 0] },
      },
      {
        id: 'port',
        name: '港',
        layerId: 'places',
        featureKind: 'place',
        geometry: { type: 'point', coordinates: [20, 20] },
      },
    ],
  };
  const mapArtifact = await commitVersion(
    { ...createArtifact('fiction-map', '地図', map), id: 'board-map' },
    null,
    null,
  );
  const loc = createDocument();
  loc.blocks = [
    { id: 'capital', type: 'heading', level: 1, text: 'LO-01 王都' },
    { id: 'port', type: 'heading', level: 1, text: 'LO-02 港' },
  ];
  await storage.put(
    await commitVersion(
      { ...createArtifact('document', '場所', loc), id: 'locations' },
      null,
      null,
    ),
  );
  const board = createWhiteboard();
  board.nodes = [{ ...makeWhiteboardNode('shape'), id: 'map', shape: 'rectangle' }];
  await storage.put(
    await commitVersion(
      { ...createArtifact('whiteboard', 'ボード', board), id: 'board' },
      null,
      null,
    ),
  );
  await storage.put(mapArtifact);
  const v = mapArtifact.versions[0];
  const settings: BoardSettings = {
    schemaVersion: 1,
    boardArtifactId: 'board',
    storyId: sample.links.story.id,
    world: 'WL-A',
    clock: 'CL-1',
    map: {
      artifactId: 'board-map',
      versionId: v.versionId,
      contentHash: v.contentHash,
      view: { kind: 'document' },
    },
    panels: [{ nodeId: 'map', kind: 'map' }],
    locations: ['LO-01', 'LO-02'].map((itemId, i) => ({
      place: { artifactId: 'locations', itemId },
      featureId: i ? 'port' : 'capital',
    })),
    groups: [
      {
        id: 'expedition',
        name: '遠征組',
        individuals: [0, 1, 2].map((i) =>
          boardIndividualKey(
            sample.links.story.namespace,
            `CH-${String(i + 1).padStart(3, '0')}`,
            'WL-A',
          ),
        ),
        events: [],
      },
    ],
    presets: [],
  };
  await storage.put(
    await commitVersion(
      { ...createArtifact('data', '設定', createBoardSettingsData(settings)), id: 'config' },
      null,
      null,
    ),
  );
  let generation = 0;
  const hidden = new Set<string>();
  const options = {
    namespace: 'test',
    generation: () => generation,
    mayRead: (id: string) => !hidden.has(id),
  };
  const open = () => readStoryBoard(storage, 'config', sample.links, options);
  const ready = async () => {
    const r = await open();
    expect(r.state).toBe('ready');
    return r as BoardReading;
  };
  return {
    storage,
    w,
    settings,
    links: sample.links,
    options,
    hidden,
    open,
    ready,
    invalidate: () => generation++,
  };
}

it.each(['board', 'story-ledger-A'])(
  'opens a %s envelope above the former native limit through the shared admission boundary',
  async (id) => {
    const f = await fixture();
    const original = (await f.storage.get(id))!;
    await f.storage.put({
      ...original,
      provenance: { ...original.provenance, format: 'x'.repeat(17 * 1024 * 1024) },
    });
    const r = await f.ready();
    expect(r.events.length).toBeGreaterThan(0);
    expect((await f.storage.get(id))!.versions).toEqual(original.versions);
  },
);

it('SB02/03/09: ten individuals, shared point and half-open presence use only adopted saved content', async () => {
  const f = await fixture(),
    before = canonicalJson(await f.storage.list());
  const owner = f.w.owner('story-ledger-A')!;
  const revision = owner.editor.revision,
    undo = owner.editor.canUndo;
  const r = await f.ready();
  expect(r.individuals).toHaveLength(10);
  expect(r.events.filter((e) => e.ref.itemId.startsWith('EV-4'))).toHaveLength(10);
  const point = (value: number) =>
    filterStoryBoard(r, { ...all, time: { kind: 'point', clock: 'CL-1', value } });
  expect(point(3).positions.filter((p) => p.records.length)).toHaveLength(10);
  expect(point(4).positions.every((p) => p.state === 'unknown')).toBe(true);
  expect(point(3).events.filter((e) => e.ref.itemId.startsWith('EV-4'))).toHaveLength(10);
  expect(
    point(3).positions.find((p) => p.individual.character === 'CH-010')!.records[0].certainty,
  ).toBe('uncertain');
  expect(canonicalJson(await f.storage.list())).toBe(before);
  expect(owner.editor.revision).toEqual(revision);
  expect(owner.editor.canUndo).toBe(undo);
  const artifact = (await f.storage.get('story-ledger-A'))! as Artifact<StructuredData>;
  artifact.draft.content.rows.find((row) => row.id === 'EV-400')!.values['tl1.label'] =
    '未保存の秘密';
  await f.storage.put(artifact);
  f.invalidate();
  expect(r.current()).toBe(false);
  const next = await f.ready();
  expect(next.events.find((e) => e.ref.itemId === 'EV-400')!.label).toBe('同時進行0');
});

it('SB02/06: OR within an axis, AND across axes; empty/deleted choices never widen to all', async () => {
  const f = await fixture(),
    r = await f.ready();
  const people = r.individuals.slice(0, 3).map((i) => i.key);
  const filter: BoardFilter = {
    ...all,
    individuals: { kind: 'set', ids: people },
    places: { kind: 'set', ids: r.places.map((p) => p.key) },
    groups: { kind: 'set', ids: ['expedition'] },
    time: { kind: 'point', clock: 'CL-1', value: 3 },
  };
  expect(filterStoryBoard(r, filter).individuals).toHaveLength(3);
  expect(filterStoryBoard(r, { ...filter, individuals: { kind: 'set', ids: [] } }).events).toEqual(
    [],
  );
  expect(filterStoryBoard(r, { ...filter, places: { kind: 'set', ids: [] } }).individuals).toEqual(
    [],
  );
  expect(
    filterStoryBoard(r, { ...filter, groups: { kind: 'set', ids: ['deleted'] } }).events,
  ).toEqual([]);
  expect(
    filterStoryBoard(r, {
      ...filter,
      places: { kind: 'set', ids: [boardItemKey({ artifactId: 'locations', itemId: 'LO-02' })] },
    }).individuals,
  ).toEqual([]);
  expect(() =>
    filterStoryBoard(r, { ...filter, time: { kind: 'point', clock: 'other', value: 3 } }),
  ).toThrow('時計');
});

it.each(['story-ledger-A', 'character-sheet', 'locations', 'board-map'])(
  'SB12: unreadable %s reveals no source IDs, labels, counts, map or relationships',
  async (owner) => {
    const f = await fixture();
    f.hidden.add(owner);
    const result = await f.open();
    expect(result.state).toBe('partial');
    expect(Object.keys(result).sort()).toEqual(['current', 'state']);
    expect(canonicalJson(result)).not.toMatch(/CH-|LO-|EV-|遠征|王都|board-map/);
  },
);

it('SB11/12: source read revocation, abort and request generation invalidate the whole snapshot', async () => {
  const f = await fixture();
  const source = {
    get: async (id: string) => {
      const a = await f.storage.get(id);
      if (id === 'locations') {
        f.hidden.add(id);
        f.invalidate();
      }
      return a;
    },
  };
  await expect(readStoryBoard(source, 'config', f.links, f.options)).rejects.toMatchObject({
    reason: 'stale',
  });
  f.hidden.clear();
  const abort = new AbortController();
  const r = await readStoryBoard(f.storage, 'config', f.links, {
    ...f.options,
    signal: abort.signal,
  });
  abort.abort();
  expect(r.current()).toBe(false);
  const current = await f.ready();
  f.invalidate();
  expect(() => filterStoryBoard(current, all)).toThrow('変わりました');
});

it('SB09: fixed map ignores a newer saved version and storage draft; corrupt hash refuses display', async () => {
  const f = await fixture();
  const a = (await f.storage.get('board-map'))!;
  const draft = structuredClone(a.draft.content) as ReturnType<typeof createFictionMap>;
  a.draft.content = {
    ...draft,
    features: draft.features.map((f, i) => (i ? f : { ...f, name: '新版' })),
  };
  await f.storage.put(await commitVersion(a, null, null));
  const r = await f.ready();
  expect(r.map.features[0].name).toBe('王都');
  const bad = (await f.storage.get('board-map'))!;
  const fixed = bad.versions[0].content as typeof draft;
  bad.versions[0].content = {
    ...fixed,
    features: fixed.features.map((f, i) => (i ? f : { ...f, name: '改竄' })),
  };
  await f.storage.put(bad);
  expect((await f.open()).state).toBe('partial');
});

it('SB04: day/range remain intervals, unknown clock is not an exact location, endpoints are half open', () => {
  const query = { kind: 'point' as const, clock: 'CL-1', value: 3 };
  expect(boardTimeMatches({ kind: 'day', clock: 'CL-1', start: 3 }, query)).toBe(true);
  expect(boardTimeMatches({ kind: 'interval', clock: 'CL-1', start: 2, end: 3 }, query)).toBe(
    false,
  );
  expect(boardTimeMatches({ kind: 'point', clock: 'other', start: 3 }, query)).toBeUndefined();
});

it('SB04: presence consumes its subject EV explicit clock, then only a declared fixed conversion', async () => {
  const f = await fixture();
  const ledger = (await f.storage.get('story-ledger-A'))! as Artifact<StructuredData>;
  const draft = structuredClone(ledger.draft.content);
  draft.rows.find((r) => r.id === 'EV-400')!.values['tl1.clock'] = 'CL-P';
  await f.storage.put(await commitVersion(updateDraft(ledger, draft), null, null));
  const without = await f.ready();
  expect(
    without.presences.find(
      (p) => p.event === boardItemKey({ artifactId: ledger.id, itemId: 'EV-400' }),
    )!.time,
  ).toBeUndefined();
  const world = (await f.storage.get('world-S'))! as Artifact<StructuredData>;
  const command = insertRows('world', [
    { id: 'CL-P', values: { 'tl1.row': 'clock', 'tl1.label': '別時計' } },
    {
      id: 'offset-P',
      values: {
        'tl1.row': 'clock-offset',
        'tl1.clock': 'CL-P',
        'tl1.clock2': 'CL-1',
        'tl1.offset.min': 10,
        'tl1.offset.max': 10,
      },
    },
  ]);
  await f.storage.put(
    await commitVersion(updateDraft(world, command.apply(world.draft.content)), null, null),
  );
  f.invalidate();
  const withOffset = await f.ready();
  expect(
    withOffset.presences.find(
      (p) => p.event === boardItemKey({ artifactId: ledger.id, itemId: 'EV-400' }),
    )!.time,
  ).toEqual({ kind: 'interval', clock: 'CL-1', start: 12, end: 14 });
});

it('SB11: late old read is rejected after a newer valid read, including Story link changes', async () => {
  const f = await fixture();
  let release!: () => void, started!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const old = readStoryBoard(
    {
      get: async (id) => {
        const value = await f.storage.get(id);
        if (id === 'locations') {
          started();
          await blocked;
        }
        return value;
      },
    },
    'config',
    f.links,
    f.options,
  );
  await began;
  f.invalidate();
  const newer = await f.ready();
  release();
  await expect(old).rejects.toMatchObject({ reason: 'stale' });
  expect(newer.current()).toBe(true);
  f.links.story.namespace = 'changed';
  expect(newer.current()).toBe(false);
});

it('SB12: storage failures never reveal the underlying private error', async () => {
  const f = await fixture();
  const get = async (id: string) => {
    if (id === 'locations') throw Error('秘密の組織に資料が48件あります');
    return f.storage.get(id);
  };
  await expect(readStoryBoard({ get }, 'config', f.links, f.options)).rejects.toThrow('閲覧権限');
});

it('SB04: same character in a different origin remains a distinct selectable individual', async () => {
  const f = await fixture();
  const ledger = (await f.storage.get('story-ledger-A'))! as Artifact<StructuredData>;
  const add = insertRows('ledger', [
    {
      id: 'EV-499',
      values: {
        'tl1.row': 'event',
        'tl1.label': '別個体',
        'tl1.time.kind': 'point',
        'tl1.time.start': 3,
      },
    },
    {
      id: 'EV-499.presence',
      values: {
        'tl1.row': 'presence',
        'tl1.subject': 'EV-499',
        'tl1.ind.ch': 'CH-001',
        'tl1.ind.origin': 'WL-B',
        'tl1.loc': 'LO-01',
        'tl1.time.kind': 'interval',
        'tl1.time.start': 2,
        'tl1.time.end': 4,
        'tl1.certainty': 'confirmed',
      },
    },
  ]);
  await f.storage.put(
    await commitVersion(updateDraft(ledger, add.apply(ledger.draft.content)), null, null),
  );
  const r = await f.ready();
  expect(r.individuals.filter((i) => i.character === 'CH-001')).toHaveLength(2);
  const key = boardIndividualKey(f.links.story.namespace, 'CH-001', 'WL-B');
  const v = filterStoryBoard(r, { ...all, individuals: { kind: 'set', ids: [key] } });
  expect(v.individuals).toHaveLength(1);
  expect(v.events.map((e) => e.ref.itemId)).toEqual(['EV-499']);
});

it('SB04/13: ambiguous bare LO and a deleted qualified LO never reconnect by name', async () => {
  const f = await fixture();
  const original = (await f.storage.get('locations'))!;
  await f.storage.put({
    ...structuredClone(original),
    id: 'other-locations',
    versions: original.versions.map((v) => ({ ...v, artifactId: 'other-locations' })),
  });
  const config = (await f.storage.get('config'))!;
  const nextSettings = {
    ...f.settings,
    locations: [
      ...f.settings.locations,
      { place: { artifactId: 'other-locations', itemId: 'LO-01' }, featureId: 'capital' },
    ],
  };
  await f.storage.put(
    await commitVersion(updateDraft(config, createBoardSettingsData(nextSettings)), null, null),
  );
  const ambiguous = await f.ready();
  const key = boardItemKey({ artifactId: 'story-ledger-A', itemId: 'EV-400' });
  expect(ambiguous.presences.find((p) => p.event === key)!.place).toBeUndefined();
  const source = original.draft.content as ReturnType<typeof createDocument>;
  const deleted = { ...source, blocks: source.blocks.filter((b) => b.id !== 'capital') };
  await f.storage.put(await commitVersion(updateDraft(original, deleted), null, null));
  f.invalidate();
  const after = await f.ready();
  expect(after.presences.find((p) => p.event === key)!.place).toBeUndefined();
  const deletedKey = boardItemKey({ artifactId: 'locations', itemId: 'LO-01' });
  expect(after.places.some((p) => p.key === deletedKey)).toBe(false);
  expect(
    filterStoryBoard(after, { ...all, places: { kind: 'set', ids: [deletedKey] } }).events,
  ).toEqual([]);
});

it.each([
  [{ kind: 'range', start: 3, end: 3 }, 3],
  [{ kind: 'range', start: 2, end: 4 }, 4],
  [{ kind: 'range', end: 4 }, -100],
  [{ kind: 'range', start: 3 }, 100],
] as const)(
  'SB04 range inclusive/open bound %j remains a candidate at cursor %s',
  (time, value) => {
    expect(
      boardTimeMatches({ ...time, clock: 'CL-1' }, { kind: 'point', clock: 'CL-1', value }),
    ).toBe(true);
  },
);

it('SB02: shared-event participants outside the selected place never become unknown-location matches', async () => {
  const f = await fixture();
  const ledger = (await f.storage.get('story-ledger-A'))! as Artifact<StructuredData>;
  const draft = structuredClone(ledger.draft.content);
  draft.rows.find((r) => r.id === 'EV-404.presence')!.values['tl1.subject'] = 'EV-400';
  await f.storage.put(await commitVersion(updateDraft(ledger, draft), null, null));
  const r = await f.ready();
  const place = boardItemKey({ artifactId: 'locations', itemId: 'LO-01' });
  for (const includeUnknown of [false, true]) {
    const view = filterStoryBoard(r, {
      ...all,
      places: { kind: 'set', ids: [place] },
      time: { kind: 'point', clock: 'CL-1', value: 3 },
      includeUnknown,
    });
    expect(view.events.some((e) => e.ref.itemId === 'EV-400')).toBe(true);
    expect(view.individuals.some((i) => i.character === 'CH-005')).toBe(false);
    expect(view.positions.some((p) => p.individual.character === 'CH-005')).toBe(false);
  }
});

it('SB04: inclusive uncertain range intersects the start but not the excluded end of a query interval', () => {
  const time = { kind: 'range', clock: 'CL-1', start: 3, end: 3 };
  expect(boardTimeMatches(time, { kind: 'range', clock: 'CL-1', start: 3, end: 4 })).toBe(true);
  expect(boardTimeMatches(time, { kind: 'range', clock: 'CL-1', start: 2, end: 3 })).toBe(false);
});

it.each(
  (
    [
      { kind: 'all' },
      { kind: 'point', clock: 'CL-1', value: 3 },
      { kind: 'range', clock: 'CL-1', start: 2, end: 4 },
    ] as const
  ).flatMap((time) => [false, true].map((includeUnknown) => ({ time, includeUnknown }))),
)(
  'P2 4456688751: event place belongs to the selected individual %j',
  async ({ time, includeUnknown }) => {
    const f = await fixture();
    const ledger = (await f.storage.get('story-ledger-A'))! as Artifact<StructuredData>;
    const draft = structuredClone(ledger.draft.content);
    draft.rows.find((row) => row.id === 'EV-404.presence')!.values['tl1.subject'] = 'EV-400';
    await f.storage.put(await commitVersion(updateDraft(ledger, draft), null, null));
    const before = canonicalJson(await f.storage.list());
    const reading = await f.ready();
    const person = (character: string) => ({
      kind: 'set' as const,
      ids: [boardIndividualKey(f.links.story.namespace, character, 'WL-A')],
    });
    const at = (itemId: string) => ({
      kind: 'set' as const,
      ids: [boardItemKey({ artifactId: 'locations', itemId })],
    });
    const selected = { ...all, time, includeUnknown };
    const mismatched = filterStoryBoard(reading, {
      ...selected,
      individuals: person('CH-001'),
      places: at('LO-02'),
    });
    // Other F0 events with genuinely unrecorded locations may remain when requested.
    expect(mismatched.events.some((event) => event.ref.itemId === 'EV-400')).toBe(false);
    expect(mismatched.presences).toEqual([]);
    expect(mismatched.individuals).toEqual([]);
    expect(mismatched.positions).toEqual([]);
    for (const [individuals, places] of [
      [person('CH-001'), at('LO-01')],
      [person('CH-005'), at('LO-02')],
      [all.individuals, at('LO-02')],
    ] as const) {
      expect(
        filterStoryBoard(reading, { ...selected, individuals, places }).events.some(
          (event) => event.ref.itemId === 'EV-400',
        ),
      ).toBe(true);
    }
    expect(canonicalJson(await f.storage.list())).toBe(before);
  },
);
