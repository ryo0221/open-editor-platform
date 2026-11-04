/** Synthetic local demo, built from the accepted F0 sample under distinct owner IDs.
 * Creation is atomic per Artifact and retryable; it never overwrites an existing owner. */
import {
  canonicalJson,
  contentHash,
  type Artifact,
  type StorageAdapter,
} from '@editor-platform/artifact-core';
import {
  createWhiteboard,
  makeWhiteboardNode,
  type WhiteboardContent,
} from '@editor-platform/whiteboard/model';
import { createFictionMap, validateFictionMap } from '@editor-platform/fiction-map/model';
import { createDocument } from '@editor-platform/document/model';
import type { StructuredData } from '@editor-platform/structured-data/model';
import { buildF0Sample } from '../timeline/sample';
import { insertRows } from '../timeline/commands';
import { readWorkspaceLinks, type CreativeWorkspaceLinksV2 } from '../workspace/model';
import {
  createBoardSettingsData,
  boardIndividualKey,
  type BoardSettings,
  type BoardFilter,
} from './settings';

export const STORY_BOARD_SAMPLE_SETTINGS = 'sb660-settings';
const stamp = '2026-11-03T00:00:00.000Z';
const names = [
  'アリア',
  'レオン',
  'ヴィオラ',
  'ミラ',
  'カイ',
  'エマ',
  'ノア',
  'リナ',
  'ソラ',
  'ユイ',
];
const character = (i: number) => `CH-${String(i + 1).padStart(3, '0')}`;
async function native(
  kind: string,
  id: string,
  name: string,
  content: unknown,
): Promise<Artifact<unknown>> {
  const versionId = 'board-sample-v1';
  return {
    schemaVersion: 1,
    id,
    name,
    kind,
    provenance: { source: 'created' },
    draft: { baseVersionId: versionId, updatedAt: stamp, content: structuredClone(content) },
    versions: [
      {
        artifactId: id,
        versionId,
        parentVersionId: null,
        schemaVersion: 1,
        createdAt: stamp,
        createdBy: null,
        reason: 'Story Board synthetic sample',
        content,
        contentHash: await contentHash(content),
      },
    ],
  };
}

export async function buildStoryBoardSample() {
  const f0 = await buildF0Sample();
  const source = new Map(f0.artifacts.map((a) => [a.id, a]));
  const ledger = source.get('story-ledger-A')!.draft.content as StructuredData;
  const added = Array.from({ length: 10 }, (_, i) => {
    const id = `EV-${400 + i}`,
      place = ['LO-01', 'LO-02', 'LO-03'][Math.floor(i / 4)];
    return [
      {
        id,
        values: {
          'tl1.row': 'event',
          'tl1.label': `${names[i]}の3日目`,
          'tl1.time.kind': 'point',
          'tl1.time.start': 3,
        },
      },
      ...[0, 1].map((phase) => ({
        id: `${id}.presence.${phase}`,
        values: {
          'tl1.row': 'presence',
          'tl1.subject': id,
          'tl1.ind.ch': character(i),
          'tl1.ind.origin': 'WL-A',
          'tl1.loc': phase ? ['LO-02', 'LO-03', 'LO-01'][Math.floor(i / 4)] : place,
          'tl1.time.kind': 'interval',
          'tl1.time.start': phase ? 4 : 2,
          'tl1.time.end': phase ? 6 : 4,
          'tl1.certainty': i === 9 ? 'uncertain' : 'confirmed',
        },
      })),
    ];
  }).flat();
  added.push(
    {
      id: 'EV-499',
      values: {
        'tl1.row': 'event',
        'tl1.label': '別個体アリアの砦',
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
        'tl1.loc': 'LO-04',
        'tl1.time.kind': 'interval',
        'tl1.time.start': 2,
        'tl1.time.end': 4,
        'tl1.certainty': 'confirmed',
      },
    },
  );
  source.get('story-ledger-A')!.draft.content = insertRows('ledger', added).apply(ledger);
  const chars = source.get('character-sheet')!.draft.content as StructuredData;
  chars.rows = names.map((name, i) => ({ id: character(i), values: { 'ch.name': name } }));
  const ids = new Map(f0.artifacts.map((a) => [a.id, 'sb660-' + a.id]));
  ids.set(f0.links.story.id, 'sb660-story-S');
  ids.set(f0.links.story.namespace, 'ns:sb660-story-S');
  const hashes = new Map<string, string>(),
    built = new Map<string, Artifact<unknown>>();
  const replace = (value: unknown): unknown =>
    typeof value === 'string'
      ? (ids.get(value) ?? hashes.get(value) ?? value)
      : Array.isArray(value)
        ? value.map(replace)
        : value && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]))
          : value;
  const strings = (value: unknown): string[] =>
    typeof value === 'string'
      ? [value]
      : Array.isArray(value)
        ? value.flatMap(strings)
        : value && typeof value === 'object'
          ? Object.values(value).flatMap(strings)
          : [];
  async function build(id: string, path = new Set<string>()) {
    if (built.has(id)) return;
    if (path.has(id)) throw Error('見本のexact依存が循環しています。');
    const a = source.get(id)!;
    for (const dependency of new Set(strings(a.draft.content).filter((s) => source.has(s))))
      await build(dependency, new Set([...path, id]));
    const content = replace(a.draft.content),
      hash = await contentHash(content),
      version = a.versions[0];
    hashes.set(version.contentHash, hash);
    const artifact: Artifact<unknown> = {
      ...a,
      id: ids.get(id)!,
      draft: { ...a.draft, content: structuredClone(content) },
      versions: [{ ...version, artifactId: ids.get(id)!, content, contentHash: hash }],
    };
    built.set(id, artifact);
  }
  for (const id of source.keys()) await build(id);
  const links = readWorkspaceLinks(replace(f0.links)) as CreativeWorkspaceLinksV2;
  const locations = createDocument();
  const placeNames = ['王都', '石橋', '港', '北の砦'];
  locations.blocks = placeNames.map((name, i) => ({
    id: `location-${i}`,
    type: 'heading',
    level: 1,
    text: `LO-0${i + 1} ${name}`,
  }));
  const map = validateFictionMap({
    ...createFictionMap(),
    coordinateSpace: {
      kind: 'local-plane',
      bounds: { minX: 0, minY: 0, maxX: 1000, maxY: 700 },
      unit: { name: 'map-unit' },
      yAxis: 'down',
    },
    layers: [
      { id: 'terrain', name: '地形', purpose: 'annotation', visibleByDefault: true },
      { id: 'places', name: '地点', purpose: 'annotation', visibleByDefault: true },
    ],
    features: [
      {
        id: 'river',
        name: '青の川',
        layerId: 'terrain',
        featureKind: 'path',
        geometry: {
          type: 'polyline',
          coordinates: [
            [100, 40],
            [350, 220],
            [500, 340],
            [670, 560],
            [1000, 650],
          ],
        },
        style: { color: '#76b7c5', lineWidth: 20 },
      },
      ...[
        [200, 520],
        [500, 340],
        [840, 580],
      ].map((coordinates, i) => ({
        id: `place-${i}`,
        name: placeNames[i],
        featureKind: 'place',
        layerId: 'places',
        geometry: { type: 'point', coordinates },
        style: { color: '#8c7354' },
      })),
      {
        id: 'place-3',
        name: '北の砦（領域）',
        layerId: 'places',
        featureKind: 'region',
        geometry: {
          type: 'polygon',
          outer: [
            [700, 70],
            [930, 70],
            [930, 220],
            [700, 220],
            [700, 70],
          ],
        },
        style: { color: '#7c9169' },
      },
    ],
    namedViews: [
      {
        id: 'north',
        name: '北部全景',
        extent: { minX: 0, minY: 0, maxX: 1000, maxY: 700 },
        visibleLayerIds: ['terrain', 'places'],
      },
    ],
  });
  if (!map.ok) throw Error('見本の地図を検証できません。');
  const mapArtifact = await native('fiction-map', 'sb660-map', '北部の地図', map.value);
  const board: WhiteboardContent = {
    ...createWhiteboard(),
    nodes: [
      ...[
        { id: 'timeline', x: 24, y: 24, width: 600, height: 400 },
        { id: 'map', x: 650, y: 24, width: 470, height: 400 },
        ...[0, 1, 2].map((i) => ({
          id: `event-${i}`,
          x: 24 + i * 290,
          y: 450,
          width: 270,
          height: 240,
        })),
      ].map(({ id, ...bounds }) => ({
        ...makeWhiteboardNode('shape'),
        id,
        shape: 'rectangle' as const,
        bounds,
        text: '連動表示は物語ボードで開いてください',
        color: '#fffdf7',
      })),
      {
        ...makeWhiteboardNode('sticky'),
        id: 'author-note',
        bounds: { x: 914, y: 470, width: 210, height: 200 },
        text: '作者メモ\n3日目は王都・石橋・港で同時進行。\n位置は在場の記録だけ。',
        color: '#fff0b6',
      },
    ],
  };
  const all: BoardFilter = {
    individuals: { kind: 'all' },
    places: { kind: 'all' },
    groups: { kind: 'all' },
    time: { kind: 'point', clock: 'CL-1', value: 3 },
    includeUnknown: true,
  };
  const people = [0, 1, 2].map((i) =>
    boardIndividualKey(links.story.namespace, character(i), 'WL-A'),
  );
  const settings: BoardSettings = {
    schemaVersion: 1,
    boardArtifactId: 'sb660-board',
    storyId: links.story.id,
    world: 'WL-A',
    clock: 'CL-1',
    map: {
      artifactId: mapArtifact.id,
      versionId: mapArtifact.versions[0].versionId,
      contentHash: mapArtifact.versions[0].contentHash,
      view: { kind: 'named', id: 'north' },
    },
    panels: [
      { nodeId: 'timeline', kind: 'timeline' },
      { nodeId: 'map', kind: 'map' },
      ...[0, 1, 2].map((i) => ({
        nodeId: `event-${i}`,
        kind: 'event-card' as const,
        event: { artifactId: ids.get('story-ledger-A')!, itemId: `EV-${400 + i * 4}` },
      })),
    ],
    locations: placeNames.map((_, i) => ({
      place: { artifactId: 'sb660-locations', itemId: `LO-0${i + 1}` },
      featureId: `place-${i}`,
    })),
    groups: [
      { id: 'expedition', name: '遠征組', individuals: people, events: [] },
      {
        id: 'capital-port',
        name: '王都と港の筋',
        individuals: [3, 4, 5, 6, 7, 8, 9].map((i) =>
          boardIndividualKey(links.story.namespace, character(i), 'WL-A'),
        ),
        events: [],
      },
    ],
    presets: [
      { id: 'all', name: '全員・3日目', filter: all },
      {
        id: 'expedition',
        name: '遠征組',
        filter: {
          ...all,
          individuals: { kind: 'set', ids: people },
          groups: { kind: 'set', ids: ['expedition'] },
        },
      },
    ],
  };
  const artifacts = [
    ...built.values(),
    mapArtifact,
    await native('document', 'sb660-locations', '北部の場所設定', locations),
    await native('whiteboard', settings.boardArtifactId, '霧の王国・物語ボード', board),
    await native(
      'data',
      STORY_BOARD_SAMPLE_SETTINGS,
      '霧の王国・表示条件',
      createBoardSettingsData(settings),
    ),
  ];
  return { artifacts, links, settingsId: STORY_BOARD_SAMPLE_SETTINGS };
}

export async function createStoryBoardSample(
  storage: StorageAdapter<Artifact<unknown>>,
  /** Trusted Host admission, including the current request generation. Default is a trusted seed. */
  mayCreate: (artifactId: string) => boolean = () => true,
) {
  if (!storage.putIfAbsent) throw Error('保存先が原子的な作成に対応していません。');
  const sample = await buildStoryBoardSample();
  const admit = (id: string) => {
    if (!mayCreate(id)) throw Error('見本を作成する権限または要求が失効しました。');
  };
  // Refuse a known forbidden later owner before creating the first one.
  for (const artifact of sample.artifacts) admit(artifact.id);
  for (const artifact of sample.artifacts) {
    admit(artifact.id);
    const stored = await storage.putIfAbsent(artifact);
    admit(artifact.id);
    if (canonicalJson(stored) !== canonicalJson(artifact))
      throw Error('見本の保存先に別の内容があります。上書きしません。');
  }
  return { links: sample.links, settingsId: sample.settingsId };
}
