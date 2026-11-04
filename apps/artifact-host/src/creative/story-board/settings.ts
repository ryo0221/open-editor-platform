/** Presentation references only. Story facts remain in their native owners. */
import { canonicalJson, clone, deepFreeze } from '@editor-platform/artifact-core';
import { command, type EditorCommand } from '@editor-platform/editor-core';
import { isStructuredData, type StructuredData } from '@editor-platform/structured-data/model';
import { TL1_LIMITS } from '../timeline/tl1-schema';

export interface BoardItem {
  artifactId: string;
  itemId: string;
}
export type BoardChoice = { kind: 'all' } | { kind: 'set'; ids: string[] };
export type BoardTime =
  | { kind: 'all' }
  | { kind: 'point'; clock: string; value: number }
  | { kind: 'range'; clock: string; start: number; end: number };
export interface BoardFilter {
  individuals: BoardChoice;
  places: BoardChoice;
  groups: BoardChoice;
  time: BoardTime;
  includeUnknown: boolean;
}
export type BoardPanel =
  | { nodeId: string; kind: 'timeline' | 'map' }
  | { nodeId: string; kind: 'event-card'; event: BoardItem };
export interface BoardSettings {
  schemaVersion: 1;
  boardArtifactId: string;
  storyId: string;
  world: string;
  clock: string;
  map: {
    artifactId: string;
    versionId: string;
    contentHash: string;
    view: { kind: 'document' } | { kind: 'named'; id: string };
    featureIds?: string[];
  };
  panels: BoardPanel[];
  locations: { place: BoardItem; featureId: string }[];
  groups: { id: string; name: string; individuals: string[]; events: BoardItem[] }[];
  presets: { id: string; name: string; filter: BoardFilter }[];
}
export const BOARD_LIMITS = Object.freeze({
  payloadBytes: 65_536,
  panels: 64,
  choices: 200,
  groups: 64,
  presets: 32,
});
export class BoardSettingsError extends Error {
  constructor() {
    super(
      '物語ボードの表示設定が不正、未対応、または上限を超えています。保存内容は変更していません。',
    );
  }
}
function need(value: unknown): asserts value {
  if (!value) throw new BoardSettingsError();
}
function object(value: unknown, allowed: string[], required = allowed) {
  need(value && typeof value === 'object' && !Array.isArray(value));
  const o = value as Record<string, unknown>;
  need(Object.keys(o).every((key) => allowed.includes(key)));
  need(required.every((key) => Object.hasOwn(o, key)));
  return o;
}
function text(v: unknown) {
  need(typeof v === 'string' && v.trim().length > 0 && v.length <= 512);
}
function items(value: unknown, limit: number, check: (item: unknown) => void) {
  need(Array.isArray(value) && value.length <= limit);
  for (const item of value) check(item);
  return value;
}
function unique(values: unknown[]) {
  need(new Set(values.map((value) => canonicalJson(value))).size === values.length);
}
function strings(value: unknown, limit = BOARD_LIMITS.choices) {
  const result = items(value, limit, text);
  unique(result);
}
function item(value: unknown) {
  const r = object(value, ['artifactId', 'itemId']);
  text(r.artifactId);
  text(r.itemId);
}
function choice(value: unknown) {
  const r = object(value, ['kind', 'ids'], ['kind']);
  need(r.kind === 'all' || r.kind === 'set');
  if (r.kind === 'all') need(!Object.hasOwn(r, 'ids'));
  else strings(r.ids);
}
function day(value: unknown) {
  need(Number.isSafeInteger(value) && Math.abs(value as number) <= TL1_LIMITS.safeDayAbs);
}
export function validateBoardFilter(value: unknown): BoardFilter {
  const f = object(value, ['individuals', 'places', 'groups', 'time', 'includeUnknown']);
  for (const field of ['individuals', 'places', 'groups']) choice(f[field]);
  need(typeof f.includeUnknown === 'boolean');
  const t = object(f.time, ['kind', 'clock', 'value', 'start', 'end'], ['kind']);
  if (t.kind === 'all') need(Object.keys(t).length === 1);
  else if (t.kind === 'point') {
    object(t, ['kind', 'clock', 'value']);
    text(t.clock);
    day(t.value);
  } else {
    need(t.kind === 'range');
    object(t, ['kind', 'clock', 'start', 'end']);
    text(t.clock);
    day(t.start);
    day(t.end);
    need((t.start as number) < (t.end as number));
  }
  return deepFreeze(clone(value as BoardFilter));
}
export function validateBoardSettings(value: unknown): BoardSettings {
  const r = object(value, [
    'schemaVersion',
    'boardArtifactId',
    'storyId',
    'world',
    'clock',
    'map',
    'panels',
    'locations',
    'groups',
    'presets',
  ]);
  need(r.schemaVersion === 1);
  for (const key of ['boardArtifactId', 'storyId', 'world', 'clock']) text(r[key]);
  const map = object(
    r.map,
    ['artifactId', 'versionId', 'contentHash', 'view', 'featureIds'],
    ['artifactId', 'versionId', 'contentHash', 'view'],
  );
  text(map.artifactId);
  text(map.versionId);
  need(typeof map.contentHash === 'string' && /^[a-f0-9]{64}$/.test(map.contentHash));
  const view = object(map.view, ['kind', 'id'], ['kind']);
  if (view.kind === 'document') need(Object.keys(view).length === 1);
  else {
    need(view.kind === 'named');
    text(view.id);
  }
  if (Object.hasOwn(map, 'featureIds')) {
    strings(map.featureIds);
    need((map.featureIds as unknown[]).length > 0);
  }
  const panels = items(r.panels, BOARD_LIMITS.panels, (value) => {
    const p = object(value, ['nodeId', 'kind', 'event'], ['nodeId', 'kind']);
    text(p.nodeId);
    if (p.kind === 'event-card') item(p.event);
    else {
      need(p.kind === 'map' || p.kind === 'timeline');
      need(!Object.hasOwn(p, 'event'));
    }
  });
  unique(panels.map((p) => p.nodeId));
  const locations = items(r.locations, BOARD_LIMITS.choices, (value) => {
    const l = object(value, ['place', 'featureId']);
    item(l.place);
    text(l.featureId);
  });
  // One LO can have multiple explicit map features; duplicate pairs are refused.
  unique(locations);
  const groups = items(r.groups, BOARD_LIMITS.groups, (value) => {
    const g = object(value, ['id', 'name', 'individuals', 'events']);
    text(g.id);
    text(g.name);
    strings(g.individuals);
    unique(items(g.events, BOARD_LIMITS.choices, item));
  });
  unique(groups.map((g) => g.id));
  const presets = items(r.presets, BOARD_LIMITS.presets, (value) => {
    const p = object(value, ['id', 'name', 'filter']);
    text(p.id);
    text(p.name);
    validateBoardFilter(p.filter);
  });
  unique(presets.map((p) => p.id));
  need(new TextEncoder().encode(canonicalJson(value)).length <= BOARD_LIMITS.payloadBytes);
  return deepFreeze(clone(value as BoardSettings));
}

/** A closed Host-specific table in existing native Data, not a new Artifact kind. */
export function createBoardSettingsData(value: BoardSettings): StructuredData {
  const settings = validateBoardSettings(value);
  return {
    schemaVersion: 2,
    columns: [
      { id: 'sb1.contract', name: 'Contract', type: 'text' },
      { id: 'sb1.payload', name: 'Presentation references', type: 'text' },
    ],
    rows: [
      {
        id: 'settings',
        values: {
          'sb1.contract': 'story-board/1',
          'sb1.payload': canonicalJson(settings),
        },
      },
    ],
  };
}
export function readBoardSettings(data: unknown): BoardSettings {
  need(isStructuredData(data) && data.columns.length === 2 && data.rows.length === 1);
  need(
    data.columns.every((c) => ['sb1.contract', 'sb1.payload'].includes(c.id) && c.type === 'text'),
  );
  need(new Set(data.columns.map((c) => c.id)).size === 2);
  const row = data.rows[0];
  need(row.id === 'settings');
  object(row.values, ['sb1.contract', 'sb1.payload']);
  need(row.values['sb1.contract'] === 'story-board/1');
  const payload = row.values['sb1.payload'];
  need(
    typeof payload === 'string' &&
      new TextEncoder().encode(payload).length <= BOARD_LIMITS.payloadBytes,
  );
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new BoardSettingsError();
  }
  const settings = validateBoardSettings(value);
  // Host-owned canonical payloads have one representation; this also refuses duplicate keys.
  need(payload === canonicalJson(settings));
  return settings;
}
export function changeBoardSettings(
  next: BoardSettings,
  expected: BoardSettings,
): EditorCommand<StructuredData> {
  const payload = canonicalJson(validateBoardSettings(next));
  const before = canonicalJson(validateBoardSettings(expected));
  return command('story-board.settings', '表示条件を保存', (data) => {
    need(canonicalJson(readBoardSettings(data)) === before);
    return {
      ...data,
      rows: [
        {
          ...data.rows[0],
          values: {
            ...data.rows[0].values,
            'sb1.payload': payload,
          },
        },
      ],
    };
  });
}
export const boardItemKey = (value: BoardItem) => canonicalJson([value.artifactId, value.itemId]);
export const boardIndividualKey = (namespace: string, character: string, origin: string) =>
  canonicalJson([namespace, character, origin]);
