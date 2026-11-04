/**
 * Story Timeline T1b: the Host projection for reading (design §10, t0-contract §2–§3, §6.4).
 *
 * Reads the Story binding and occurrence links (WorkspaceLinks v2), each owner's current
 * draft through readTimelineTable, and every exact reference at its saved version. It writes
 * nothing. T2 computes declared derived times; knowledge and presence are not evaluated.
 * Unreadable material is reported only as "partial", without
 * names, contents, counts or relations (§6.4).
 */
import { canonicalJson, contentHash, type Artifact } from '@editor-platform/artifact-core';
import type { StructuredData } from '@editor-platform/structured-data/model';
import { isDocument } from '@editor-platform/document/model';
import { hasElement, type CreativeWorkspaceLinksV2 } from '../workspace/model';
import { settingSourceCards } from '../setting-source';
import { readTimelineTable, type TimelineRole, type TimelineRow } from './table';
import { TL1_LIMITS } from './tl1-schema';
import {
  compareTimeConstraint,
  strictConstraintCycles,
  type TimeConstraintResult,
} from './time-constraints';
import {
  deriveTime,
  effectiveClock,
  rowTimeValue,
  unavailableTime,
  type TimelineCalculatedTime,
} from './time';

export interface TimelineSource {
  get(id: string): Promise<Artifact<unknown> | undefined>;
}
export interface TimelineQuery {
  /** The world shown in the world-time view. Changing it never changes the Story or owners. */
  world?: string;
}
export type TimelineRefState = 'resolved' | 'missing' | 'invalid' | 'unreadable';
/** A resolved exact reference. `unreadable` carries no target information at all. */
export type TimelineRefView =
  | {
      state: 'resolved' | 'missing' | 'invalid';
      artifact: string;
      version: string;
      item: string;
      facet?: string;
      reason?: string;
    }
  | { state: 'unreadable' };
export interface TimelineTime {
  kind: string;
  start?: number;
  end?: number;
  clock?: string;
}
export interface TimelineEvent {
  /** `owner#item`. Never a bare EV ID. */
  key: string;
  owner: string;
  id: string;
  /** The world of the ledger that owns the row. */
  world: string;
  label: string;
  time: TimelineTime;
  calculated?: TimelineCalculatedTime;
  /** Explicit pairwise checks only; no inferred travel, knowledge or global constraint solver. */
  constraints: TimelineTimeConstraint[];
  /** Individuals (`CH@origin world`) named by the event's relation rows. */
  participants: string[];
  /** SC keys whose cited saved version of this event equals the current draft row. */
  scenes: string[];
  /**
   * SCs that cite an older saved version whose row differs from the current draft. They do
   * not depict the draft; the author re-checks them. Never read as the latest version.
   */
  fixedScenes: { scene: string; version: string }[];
  /**
   * The event's own `derive-time` row as written, separate from `calculated`. An unreadable base is
   * only `unreadable`, never named (TL26, §6.4).
   */
  derivation?: {
    base: TimelineRefView | { state: 'internal'; item: string };
    anchor: string;
    offset: { min?: number; max?: number };
  };
}
/**
 * A `transfer` row of the world settings as written: who is carried from which event to which
 * (TL26). T1 reads it only; arrival knowledge is not inferred. An unreadable end is only
 * `unreadable`, without its name, content or whether it exists.
 */
export interface TimelineTimeConstraint {
  id: string;
  kind: 'after' | 'travel-min';
  base: TimelineRefView | { state: 'internal'; item: string };
  minimum: number;
  maximum?: number;
  anchor: 'start' | 'end';
  result: TimeConstraintResult;
}
export interface TimelineTransfer {
  id: string;
  label: string;
  individual?: string;
  from?: TimelineRefView;
  to?: TimelineRefView;
  /** Information IDs the transfer carries (`transfer-info`). */
  carries: string[];
}
export type TimelineExperience = Omit<TimelineTransfer, 'carries'>;
export interface TimelineWorldEntry {
  key: string;
  time: TimelineTime;
  calculated?: TimelineCalculatedTime;
  label: string;
  participants: string[];
  /** Present when the entry is inherited from the parent world through an exact reference. */
  inherited?: { version: string };
  /** Inherited only: the saved version's `derive-time` as written. */
  derivation?: TimelineEvent['derivation'];
  /** Unplaced only: why the entry has no place on the world's clock. */
  reason?: 'unset' | 'derived' | 'clock' | 'overflow';
  /**
   * Placed only: the time on the world's clock, used for the order. `time` keeps the time as
   * written (on its own clock); this is the converted one when an explicit offset applies.
   */
  onWorldClock?: { clock: string; start?: number; end?: number };
}
export interface TimelineScene {
  key: string;
  owner: string;
  id: string;
  label: string;
  cites: (TimelineRefView & { facet?: string })[];
  /** Derived from the cited events' ledgers and the worlds that inherit them. Not stored. */
  worlds: string[];
  worldsComplete: boolean;
  /** Occurrences placing this SC as it is in the draft. */
  occurrences: string[];
  /** Occurrences that cite an older saved version of this SC. */
  fixedOccurrences: string[];
}
export type TimelineManuscriptRegion =
  | {
      link: string;
      sceneId: string;
      artifactId: string;
      versionId: string;
      elementId: string;
      /** The scene's native domain: Document paragraphs or Design elements. */
      kind: 'document' | 'design';
      state: 'current' | 'missing' | 'invalid';
      /** Why the region is invalid: duplicated version, broken saved content, or no element. */
      reason?: string;
    }
  /** The link's own exact endpoint (composition version, hash, occurrence) did not resolve. */
  | { link: string; sceneId: string; state: 'link-missing' | 'link-invalid'; reason: string }
  /**
   * The link's saved occurrence places a different SC than the occurrence's current draft:
   * the region was linked for the old placement and is not shown as the draft's manuscript.
   * Order, part and label changes keep the link (the same SC placement, re-ordered).
   */
  | {
      link: string;
      sceneId: string;
      state: 'link-fixed';
      version: string;
      reason: string;
    }
  /** An unreadable manuscript keeps only the link the author owns, never the address. */
  | { link: string; sceneId: string; state: 'unreadable' };
export interface TimelineOccurrence {
  id: string;
  order: number;
  part: string;
  label: string;
  scene: TimelineRefView;
  /**
   * `owner#item` of the SC when the reference resolves and the cited saved SC (its row and
   * the rows it owns) equals the current draft SC.
   */
  sceneKey?: string;
  /** The SC resolves, but the saved version cited here differs from the draft: re-check. */
  fixedScene?: { scene: string; version: string };
  /** Empty means "原稿未接続". */
  manuscript: TimelineManuscriptRegion[];
}
export interface TimelineWorld {
  id: string;
  label: string;
  clock: string;
  parent?: string;
  /** Display point of the branch. The inherited set is `inherits`, never derived from it. */
  branchPoint?: TimelineTime;
  inherits: TimelineRefView[];
}
export interface TimelineOwnerState {
  artifactId: string;
  role: TimelineRole;
  state: 'valid' | 'invalid' | 'missing';
  versionId?: string | null;
  problems?: string[];
}
export interface TimelineProjection {
  story: string;
  query: TimelineQuery;
  /** contentHash of the inputs (binding, owner drafts, links, query) and the resolved result. */
  snapshotId: string;
  /** `partial` when any owner or reference could not be read or resolved. */
  scope: 'complete' | 'partial';
  /** True when something was not readable. Nothing else about it is reported. */
  unreadable: boolean;
  owners: TimelineOwnerState[];
  worlds: TimelineWorld[];
  /** World-to-world transfers as written in the world settings, in row order. */
  transfers: TimelineTransfer[];
  experiences: TimelineExperience[];
  events: TimelineEvent[];
  /** Placed entries per world, in time order. */
  worldTime: Record<string, TimelineWorldEntry[]>;
  /** Entries with unset/unresolved times or without a known clock conversion. */
  unplaced: Record<string, TimelineWorldEntry[]>;
  scenes: TimelineScene[];
  /** Occurrences in presentation order (`tl1.order`). */
  occurrences: TimelineOccurrence[];
  /** Events cited by no SC at any version. */
  backEvents: string[];
  /** T1 reads only. These are shown as not available, never as passed. */
  unsupported: readonly ['edit', 'diagnostics'];
}

const UNSUPPORTED = ['edit', 'diagnostics'] as const;

/**
 * The projection exceeds the per-projection input limits (t0-contract §4.7, design §12). Each
 * owner table can be within its own limits while the Story's owners together are not: the
 * projection is then refused with the reason instead of being shown as complete.
 */
export class TimelineLimitError extends Error {
  constructor(
    readonly limit: keyof typeof TL1_LIMITS,
    readonly count: number,
  ) {
    super(
      `タイムラインの投影は ${limit} が ${TL1_LIMITS[limit]} までです（${count}）。` +
        '台帳やシーンカードを世界・巻で分けた作品は、範囲を絞って開いてください。',
    );
    this.name = 'TimelineLimitError';
  }
}
/** Row kinds counted against a limit of their own; every other kind is a relation row. */
const AGGREGATE: Record<string, keyof typeof TL1_LIMITS> = {
  event: 'events',
  scene: 'scenes',
  occurrence: 'occurrences',
  worldline: 'worlds',
  'clock-offset': 'clockOffsets',
};
const PLACED = new Set(['point', 'day', 'interval', 'range']);

/**
 * Resolves the reading projection. Permission is re-checked for every Artifact whose content
 * was used before the result is returned: if one was revoked meanwhile, the projection is
 * rebuilt so that the now-forbidden content reads as unreadable (§6.4).
 */
export async function resolveTimelineProjection(
  source: TimelineSource,
  links: CreativeWorkspaceLinksV2,
  query: TimelineQuery,
  mayRead: (artifactId: string) => boolean,
): Promise<TimelineProjection> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { projection, used } = await projectOnce(source, links, query, mayRead);
    if ([...used].every((id) => mayRead(id))) return projection;
  }
  throw Error('読取の権限が変わり続けているため、タイムラインを表示できません。');
}

async function projectOnce(
  source: TimelineSource,
  links: CreativeWorkspaceLinksV2,
  query: TimelineQuery,
  mayRead: (artifactId: string) => boolean,
): Promise<{ projection: TimelineProjection; used: Set<string> }> {
  const story = links.story;
  /** Artifacts whose content entered the result. Re-checked before returning. */
  const used = new Set<string>();
  let unreadable = false,
    partial = false;
  const artifacts = new Map<string, Promise<Artifact<unknown> | undefined | 'unreadable'>>();
  /** One read per Artifact; permission is checked before and after the await (§6.4). */
  const read = (id: string) => {
    let p = artifacts.get(id);
    if (!p) {
      p = (async () => {
        if (!mayRead(id)) return 'unreadable' as const;
        const a = await source.get(id);
        if (!mayRead(id)) return 'unreadable' as const;
        if (a && a.id === id) {
          used.add(id);
          return a;
        }
        return undefined;
      })();
      artifacts.set(id, p);
    }
    return p;
  };
  const hashes = new Map<string, Promise<string>>();
  const verifiedHash = (a: Artifact<unknown>, versionId: string, content: unknown) => {
    const k = `${a.id}@${versionId}`;
    if (!hashes.has(k)) hashes.set(k, contentHash(content));
    return hashes.get(k)!;
  };
  /** The timeline role of an owner: its binding, else the row kind the reference expects. */
  const ROLE_OF_KIND: Record<string, TimelineRole> = {
    event: 'ledger',
    scene: 'scene-cards',
    occurrence: 'composition',
  };
  const boundRole = (id: string): TimelineRole | undefined =>
    id === story.composition
      ? 'composition'
      : id === story.worldSettings
        ? 'world'
        : story.ledgers.some((l) => l.artifactId === id)
          ? 'ledger'
          : story.sceneCards.includes(id)
            ? 'scene-cards'
            : undefined;
  /** Saved timeline tables pass the same reader as drafts before their rows are used. */
  const savedTables = new Map<string, TimelineRow[] | undefined>();
  /** The saved table's rows as the reader reads them, or undefined when it is invalid. */
  const savedTable = (artifact: string, version: string, role: TimelineRole, data: unknown) => {
    const k = `${artifact}@${version}`;
    if (!savedTables.has(k)) {
      const r = readTimelineTable(role, data);
      savedTables.set(k, r.state === 'invalid' ? undefined : r.state === 'valid' ? r.rows : []);
    }
    return savedTables.get(k);
  };
  /** Exact reference: artifact → version → stored and recomputed hash → item. No fallback. */
  async function exact(
    artifact: string,
    version: string,
    hash: string,
    item: string,
    facet?: string,
    /** Row kinds (`tl1.row`) the target must have. Omitted for non-timeline sheets. */
    kinds?: readonly string[],
  ): Promise<{
    view: TimelineRefView;
    row?: TimelineRow['cells'];
    rows?: StructuredData['rows'];
    /** The saved timeline table as read, when the target is one. */
    table?: TimelineRow[];
  }> {
    const base = { artifact, version, item, ...(facet ? { facet } : {}) };
    const a = await read(artifact);
    if (a === 'unreadable') {
      unreadable = partial = true;
      return { view: { state: 'unreadable' } };
    }
    const fail = (state: 'missing' | 'invalid', reason: string) => {
      partial = true;
      return { view: { state, ...base, reason } };
    };
    if (!a) return fail('missing', '参照先のArtifactがありません。');
    // Exactly one saved version may carry the ID: duplicates are corrupt, never picked from.
    const found = a.versions.filter((x) => x.versionId === version);
    if (found.length > 1) return fail('invalid', '同じ版IDの保存版が複数あります。');
    const v = found[0];
    if (!v) return fail('missing', '参照していた保存版がありません。');
    if (v.contentHash !== hash || (await verifiedHash(a, version, v.content)) !== hash)
      return fail('invalid', '保存版のhashが参照と一致しません。');
    if (!mayRead(artifact)) {
      unreadable = partial = true;
      return { view: { state: 'unreadable' } };
    }
    // A location sheet in a world-notes Document: items are its LO headings (§2.1), resolved
    // by the existing setting-source projection. Timeline tables are Data only.
    if (isDocument(v.content)) {
      if (kinds) return fail('invalid', '参照先がタイムラインの表ではありません。');
      let cards: { id: string }[];
      try {
        cards = settingSourceCards(v.content);
      } catch {
        return fail('invalid', '参照先の文書から項目を読めません。');
      }
      if (!cards.some((c) => c.id === item))
        return fail('missing', '参照していた項目がその版にありません。');
      return { view: { state: 'resolved', ...base } };
    }
    const rows = (v.content as StructuredData)?.rows;
    const row = Array.isArray(rows) ? rows.find((r) => r.id === item) : undefined;
    if (!row) return fail('missing', '参照していた項目がその版にありません。');
    const rowKind = (row.values as Record<string, unknown>)['tl1.row'] as string | undefined;
    if (kinds && !kinds.includes(rowKind as string))
      return fail('invalid', '参照先の行の種類が違います。');
    // A timeline target: the saved table must be valid timeline data, like an owner draft
    // (a point without its start, a broken relation…). Non-timeline sheets are not checked.
    const role = boundRole(artifact) ?? (rowKind ? ROLE_OF_KIND[rowKind] : undefined);
    const table = role ? savedTable(artifact, version, role, v.content) : undefined;
    if (role && !table)
      return fail('invalid', '参照先の保存版がタイムラインの表として正しくありません。');
    return {
      view: { state: 'resolved', ...base },
      row: row.values as TimelineRow['cells'],
      rows,
      ...(table ? { table } : {}),
    };
  }
  const refOf = (r: TimelineRow, p: 'ref' | 'ref2', kinds?: readonly string[]) => {
    const ref = r[p];
    return ref?.type === 'exact'
      ? exact(ref.artifact, ref.version, ref.hash, ref.item, ref.facet, kinds)
      : undefined;
  };
  /**
   * The event's `derive-time` row as written, from the table it is read in (a draft, or the
   * saved version an inheritance cites). An exact base is resolved like any reference (version,
   * hash and permission again); an internal base names an event of that same table.
   */
  const derivationOf = async (
    rows: TimelineRow[],
    ev: string,
  ): Promise<TimelineEvent['derivation']> => {
    const derive = rows.find((r) => r.kind === 'derive-time' && cell(r, 'tl1.subject') === ev);
    if (!derive?.ref) return undefined;
    const base =
      derive.ref.type === 'exact'
        ? (await refOf(derive, 'ref', ['event']))!.view
        : { state: 'internal' as const, item: derive.ref.item };
    const min = cell(derive, 'tl1.offset.min'),
      max = cell(derive, 'tl1.offset.max');
    return {
      base,
      anchor: String(cell(derive, 'tl1.anchor') ?? ''),
      offset: {
        ...(typeof min === 'number' ? { min } : {}),
        ...(typeof max === 'number' ? { max } : {}),
      },
    };
  };

  // ---------- owners ----------
  const roles: [string, TimelineRole, string?][] = [
    [story.composition, 'composition'],
    [story.worldSettings, 'world'],
    ...story.ledgers.map(
      (l) => [l.artifactId, 'ledger', l.world] as [string, TimelineRole, string],
    ),
    ...story.sceneCards.map((id) => [id, 'scene-cards'] as [string, TimelineRole]),
  ];
  const owners: TimelineOwnerState[] = [];
  const tables = new Map<string, TimelineRow[]>();
  const fingerprint: unknown[] = [];
  for (const [id, role] of roles) {
    const a = await read(id);
    if (a === 'unreadable') {
      unreadable = partial = true;
      continue;
    }
    if (!a || a.kind !== 'data') {
      partial = true;
      owners.push({ artifactId: id, role, state: 'missing' });
      fingerprint.push([id, null]);
      continue;
    }
    const versionId = a.draft.baseVersionId ?? null;
    fingerprint.push([id, versionId, await contentHash(a.draft.content)]);
    const t = readTimelineTable(role, a.draft.content);
    if (t.state === 'invalid') {
      partial = true;
      owners.push({
        artifactId: id,
        role,
        state: 'invalid',
        versionId,
        problems: t.problems.map((p) => p.message),
      });
      continue;
    }
    owners.push({ artifactId: id, role, state: 'valid', versionId });
    tables.set(id, t.rows);
  }
  // Aggregate limits over every owner of the projection, before any reference is resolved.
  const totals = new Map<keyof typeof TL1_LIMITS, number>();
  for (const rows of tables.values())
    for (const r of rows) {
      const k = AGGREGATE[r.kind] ?? 'relations';
      totals.set(k, (totals.get(k) ?? 0) + 1);
    }
  for (const [k, n] of totals) if (n > TL1_LIMITS[k]) throw new TimelineLimitError(k, n);
  const rowsOf = (id: string) => tables.get(id) ?? [];
  const cell = (r: TimelineRow | undefined, k: string) => r?.cells[k];
  const timeOf = (c: TimelineRow['cells'] | undefined): TimelineTime => ({
    kind: (c?.['tl1.time.kind'] as string) ?? 'unset',
    ...(typeof c?.['tl1.time.start'] === 'number' ? { start: c['tl1.time.start'] } : {}),
    ...(typeof c?.['tl1.time.end'] === 'number' ? { end: c['tl1.time.end'] } : {}),
    ...(typeof c?.['tl1.clock'] === 'string' ? { clock: c['tl1.clock'] } : {}),
  });
  /** Individuals named by the event's own relation rows (participant, knows, info-use…). */
  const participantsOf = (
    rows: { id: string; values?: unknown; cells?: unknown }[],
    ev: string,
  ) => [
    ...new Set(
      rows
        .map((r) => (r.cells ?? r.values) as Record<string, unknown>)
        .filter((c) => c['tl1.subject'] === ev && c['tl1.ind.ch'] && c['tl1.ind.origin'])
        .map((c) => `${c['tl1.ind.ch']}@${c['tl1.ind.origin']}`),
    ),
  ];

  // ---------- clocks ----------
  /** `clock2 = clock + offset` (§5). Only an explicit offset makes two clocks comparable. */
  const worldRows = rowsOf(story.worldSettings);
  const offsets = worldRows
    .filter((r) => r.kind === 'clock-offset')
    .map((r) => ({
      from: cell(r, 'tl1.clock') as string,
      to: cell(r, 'tl1.clock2') as string,
      offset: cell(r, 'tl1.offset.min') as number,
    }));
  const worldClock = new Map(
    worldRows
      .filter((r) => r.kind === 'worldline')
      .map((r) => [r.id, (cell(r, 'tl1.clock') as string | undefined) ?? ''] as const),
  );
  /** The time on the world's clock, or undefined when the clocks cannot be compared. */
  const onClock = (t: TimelineTime, own: string, target: string) => {
    const shift = (d: number) => ({
      ...(t.start !== undefined ? { start: t.start + d } : {}),
      ...(t.end !== undefined ? { end: t.end + d } : {}),
    });
    const c = effectiveClock(t.clock, own);
    // Both unknown means the same (unread) default clock of the same world: comparable as is.
    if (c === target) return shift(0);
    // One side unknown (e.g. world-S not readable): the conversion cannot be established.
    if (!c || !target) return undefined;
    // Every declared offset between the two clocks, in either direction, as target − own.
    const ds = new Set([
      ...offsets.filter((o) => o.from === target && o.to === c).map((o) => -o.offset),
      ...offsets.filter((o) => o.from === c && o.to === target).map((o) => o.offset),
    ]);
    // None, or offsets that disagree: the clocks are not comparable (no first-match pick).
    return ds.size === 1 ? shift([...ds][0]) : undefined;
  };
  const at = new Map<TimelineWorldEntry, number>();
  const calculations = new Map<string, TimelineCalculatedTime>();
  async function calculate(
    owner: string,
    version: string | null,
    rows: TimelineRow[],
    id: string,
    path = new Set<string>(),
  ): Promise<TimelineCalculatedTime> {
    const key = JSON.stringify([owner, version, id]);
    if (path.has(key)) return unavailableTime('cycle');
    if (calculations.has(key)) return calculations.get(key)!;
    const row = rows.find((r) => r.id === id && r.kind === 'event');
    if (!row) return unavailableTime('reference');
    const time = rowTimeValue(row.cells);
    const ownClock = effectiveClock(
      time.clock,
      worldClock.get(story.ledgers.find((l) => l.artifactId === owner)?.world ?? ''),
    );
    if (time.kind !== 'derived')
      return time.kind === 'unset'
        ? unavailableTime('unset')
        : { state: 'resolved', time: { ...time, ...(ownClock ? { clock: ownClock } : {}) } };
    const relation = rows.find((r) => r.kind === 'derive-time' && r.cells['tl1.subject'] === id);
    if (!relation?.ref) return unavailableTime('reference');
    let base: TimelineCalculatedTime;
    const next = new Set([...path, key]);
    if (relation.ref.type === 'internal')
      base = await calculate(owner, version, rows, relation.ref.item, next);
    else {
      const target = await refOf(relation, 'ref', ['event']);
      if (target?.view.state !== 'resolved' || !target.table) return unavailableTime('reference');
      base = await calculate(
        target.view.artifact,
        target.view.version,
        target.table,
        target.view.item,
        next,
      );
    }
    if (base.state === 'unavailable') return base;
    // A cross-owner calculation needs the clocks to be known, not two absent IDs.
    if (!ownClock || !base.time.clock) return unavailableTime('clock');
    const shifted = onClock(base.time, base.time.clock, ownClock);
    if (!shifted) return unavailableTime('clock');
    if (
      Object.values(shifted).some(
        (n) => !Number.isSafeInteger(n) || Math.abs(n) > TL1_LIMITS.safeDayAbs,
      )
    )
      return unavailableTime('overflow');
    const result = deriveTime({ ...base.time, ...shifted, clock: ownClock }, relation);
    calculations.set(key, result);
    return result;
  }
  const cycleCache = new WeakMap<TimelineRow[], Set<string>>();
  const constraintsOf = async (
    owner: string,
    rows: TimelineRow[],
    id: string,
  ): Promise<TimelineTimeConstraint[]> => {
    const checks: TimelineTimeConstraint[] = [];
    if (!cycleCache.has(rows))
      cycleCache.set(
        rows,
        strictConstraintCycles(
          rows,
          worldClock.get(story.ledgers.find((l) => l.artifactId === owner)?.world ?? ''),
        ),
      );
    for (const relation of rows.filter(
      (r) => (r.kind === 'after' || r.kind === 'travel-min') && r.cells['tl1.subject'] === id,
    )) {
      const ref = relation.ref;
      if (!ref) continue;
      let base: TimelineRefView | { state: 'internal'; item: string };
      let origin: TimelineCalculatedTime;
      if (ref.type === 'internal') {
        base = { state: 'internal', item: ref.item };
        origin = await calculate(owner, null, rows, ref.item);
      } else {
        const read = await refOf(relation, 'ref', ['event']);
        if (!read || read.view.state === 'unreadable') continue;
        base = read.view;
        origin =
          read.view.state === 'resolved' && read.table
            ? await calculate(read.view.artifact, read.view.version, read.table, read.view.item)
            : unavailableTime('reference');
      }
      const subject = await calculate(owner, null, rows, id);
      const minimum = Number(relation.cells['tl1.offset.min'] ?? 0);
      const maximum =
        typeof relation.cells['tl1.offset.max'] === 'number'
          ? relation.cells['tl1.offset.max']
          : undefined;
      const anchor = relation.cells['tl1.anchor'] === 'end' ? 'end' : 'start';
      let result: TimeConstraintResult;
      if (cycleCache.get(rows)!.has(relation.id)) result = { state: 'violated' };
      else if (origin.state === 'unavailable' || subject.state === 'unavailable') {
        const reasons = [origin, subject].flatMap((t) =>
          t.state === 'unavailable' ? [t.reason] : [],
        );
        result = {
          state: 'undetermined',
          reason: reasons.includes('reference')
            ? 'reference'
            : reasons.includes('clock')
              ? 'clock'
              : reasons.includes('overflow')
                ? 'overflow'
                : 'time',
        };
      } else if (!origin.time.clock || !subject.time.clock)
        result = { state: 'undetermined', reason: 'clock' };
      else {
        const converted = onClock(origin.time, origin.time.clock, subject.time.clock);
        result = converted
          ? compareTimeConstraint(
              subject.time,
              { ...origin.time, ...converted },
              relation.kind as 'after' | 'travel-min',
              minimum,
              anchor,
              maximum,
            )
          : { state: 'undetermined', reason: 'clock' };
      }
      checks.push({
        id: relation.id,
        kind: relation.kind as 'after' | 'travel-min',
        base,
        minimum,
        ...(maximum === undefined ? {} : { maximum }),
        anchor,
        result,
      });
    }
    return checks;
  };
  /** Places an entry in the world's time order, or in unplaced with the reason. */
  const place = (world: string, e: TimelineWorldEntry, ownClock: string) => {
    worldTime[world] ??= [];
    unplaced[world] ??= [];
    const time = e.calculated?.state === 'resolved' ? e.calculated.time : e.time;
    if (!PLACED.has(time.kind)) {
      unplaced[world].push({ ...e, reason: e.time.kind === 'derived' ? 'derived' : 'unset' });
      return;
    }
    const n = onClock(time, ownClock, worldClock.get(world) ?? '');
    if (!n) {
      unplaced[world].push({ ...e, reason: 'clock' });
      return;
    }
    if (
      Object.values(n).some(
        (value) => !Number.isSafeInteger(value) || Math.abs(value) > TL1_LIMITS.safeDayAbs,
      )
    ) {
      unplaced[world].push({ ...e, reason: 'overflow' });
      return;
    }
    const placed = { ...e, onWorldClock: { clock: worldClock.get(world) ?? '', ...n } };
    at.set(placed, n.start ?? n.end ?? 0);
    worldTime[world].push(placed);
  };
  const worldTime: Record<string, TimelineWorldEntry[]> = {};
  const unplaced: Record<string, TimelineWorldEntry[]> = {};

  // ---------- worlds ----------
  const ledgerWorld = new Map(story.ledgers.map((l) => [l.artifactId, l.world]));
  const parentOf = new Map(
    worldRows
      .filter((r) => r.kind === 'worldline')
      .map((r) => [r.id, cell(r, 'tl1.world.parent') as string | undefined] as const),
  );
  /**
   * The worlds a world branched from. An individual of any of them is the same CH in the child
   * world (§2.5), however many branches lie between. Other origins (transfers) are kept.
   */
  const ancestors = (world: string) => {
    const seen = new Set<string>();
    for (let p = parentOf.get(world); p && !seen.has(p); p = parentOf.get(p)) seen.add(p);
    return seen;
  };
  const worlds: TimelineWorld[] = [];
  /** `owner#item@version` -> worlds inheriting exactly that saved version. */
  const inheritedBy = new Map<string, string[]>();
  /** False when the inheritance inputs are not all available, so derived world sets are not final. */
  let inheritanceComplete = tables.has(story.worldSettings);
  for (const w of worldRows.filter((r) => r.kind === 'worldline')) {
    const inherits: TimelineRefView[] = [];
    worldTime[w.id] = [];
    unplaced[w.id] = [];
    const parent = cell(w, 'tl1.world.parent') as string | undefined;
    for (const r of worldRows.filter(
      (x) => x.kind === 'inherits' && cell(x, 'tl1.subject') === w.id,
    )) {
      const res = await refOf(r, 'ref', ['event']);
      if (!res) continue;
      inherits.push(res.view);
      if (res.view.state !== 'resolved' || !res.row) {
        inheritanceComplete = false;
        continue;
      }
      const key = `${res.view.artifact}#${res.view.item}`;
      const exactKey = `${key}@${res.view.version}`;
      // Inheritance is a set of exact references (§5): the same saved event enters once.
      if (inheritedBy.get(exactKey)?.includes(w.id)) continue;
      inheritedBy.set(exactKey, [...(inheritedBy.get(exactKey) ?? []), w.id]);
      const sourceWorld = ledgerWorld.get(res.view.artifact);
      // The inherited saved version's own derivation, not the parent's current draft.
      const derivation = res.table ? await derivationOf(res.table, res.view.item) : undefined;
      place(
        w.id,
        {
          key,
          label: String(res.row['tl1.label'] ?? res.view.item),
          time: timeOf(res.row),
          ...(res.row['tl1.time.kind'] === 'derived' && res.table
            ? {
                calculated: await calculate(
                  res.view.artifact,
                  res.view.version,
                  res.table,
                  res.view.item,
                ),
              }
            : {}),
          // The saved event's own world's individuals read as the same CH in the child world
          // (§2.5). Origins other than that world are transfers and keep their origin. Only
          // when the source ledger is outside the Story is the lineage used instead.
          participants: participantsOf(res.rows ?? [], res.view.item).map((p) => {
            const at = p.lastIndexOf('@');
            const origin = p.slice(at + 1);
            const native = sourceWorld ? origin === sourceWorld : ancestors(w.id).has(origin);
            return native ? `${p.slice(0, at)}@${w.id}` : p;
          }),
          inherited: { version: res.view.version },
          ...(derivation ? { derivation } : {}),
        },
        // The saved event's own clock: its source ledger's world, not the immediate parent.
        worldClock.get(ledgerWorld.get(res.view.artifact) ?? parent ?? '') ?? '',
      );
    }
    const kind = cell(w, 'tl1.time.kind');
    worlds.push({
      id: w.id,
      label: String(cell(w, 'tl1.label') ?? w.id),
      clock: String(cell(w, 'tl1.clock') ?? ''),
      ...(parent ? { parent } : {}),
      ...(kind ? { branchPoint: timeOf(w.cells) } : {}),
      inherits,
    });
  }

  // ---------- scenes and their citations ----------
  const scenes: TimelineScene[] = [];
  /** owner#item -> citing SCs with the saved row they cite. */
  const citedBy = new Map<string, { scene: string; version: string; content: string }[]>();
  /** An event's content: its row and the relation rows it owns (§8.1), by row ID. */
  /** Empty (null/undefined) cells are absent, as the table reader reads them. */
  const present = (v: unknown) =>
    Object.fromEntries(
      Object.entries((v ?? {}) as Record<string, unknown>).filter(([, x]) => x != null),
    );
  const eventContent = (row: unknown, relations: { id: string; values: unknown }[]) =>
    canonicalJson({
      row: present(row),
      relations: [...relations]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((r) => [r.id, present(r.values)]),
    });
  for (const owner of story.sceneCards) {
    const rows = rowsOf(owner);
    for (const sc of rows.filter((r) => r.kind === 'scene')) {
      const key = `${owner}#${sc.id}`;
      const cites: TimelineScene['cites'] = [];
      const worldSet = new Set<string>();
      let complete = inheritanceComplete;
      for (const c of rows.filter((r) => r.kind === 'cite' && cell(r, 'tl1.subject') === sc.id)) {
        const target = c.ref?.type === 'exact' ? c.ref.artifact : undefined;
        const isLedger = !!target && ledgerWorld.has(target);
        const res = await refOf(c, 'ref', isLedger ? ['event'] : undefined);
        if (!res) continue;
        cites.push(res.view);
        const v = res.view;
        // An event is recognised by its row kind, also in a ledger outside the Story binding.
        const isEvent = isLedger || res.row?.['tl1.row'] === 'event';
        if (v.state !== 'resolved') {
          // An unresolved target cannot be shown to carry no world, unless it is the Story's
          // character sheet.
          if (target !== story.characters) complete = false;
          continue;
        }
        // CH/LO citations carry no world.
        if (!isEvent) continue;
        const evKey = `${v.artifact}#${v.item}`;
        const list = citedBy.get(evKey) ?? [];
        if (!list.some((x) => x.scene === key && x.version === v.version))
          list.push({
            scene: key,
            version: v.version,
            content: eventContent(
              res.row,
              (res.rows ?? []).filter(
                (r) => (r.values as Record<string, unknown>)['tl1.subject'] === v.item,
              ),
            ),
          });
        citedBy.set(evKey, list);
        const own = ledgerWorld.get(v.artifact);
        // An external ledger's own world is not known here: the set is not final.
        if (own) worldSet.add(own);
        else complete = false;
        // Only a world inheriting the very version the SC cites applies to it.
        for (const w of inheritedBy.get(`${evKey}@${v.version}`) ?? []) worldSet.add(w);
      }
      const order = worlds.map((w) => w.id);
      scenes.push({
        key,
        owner,
        id: sc.id,
        label: String(cell(sc, 'tl1.label') ?? sc.id),
        cites,
        worlds: [...worldSet].sort((a, b) => order.indexOf(a) - order.indexOf(b)),
        worldsComplete: complete,
        occurrences: [],
        fixedOccurrences: [],
      });
    }
  }

  // ---------- events and world time ----------
  const events: TimelineEvent[] = [];
  for (const l of story.ledgers) {
    const rows = rowsOf(l.artifactId);
    for (const ev of rows.filter((r) => r.kind === 'event')) {
      const key = `${l.artifactId}#${ev.id}`;
      // A citation depicts the draft only when the cited saved event, with the relation rows it
      // owns, equals the draft.
      const draft = eventContent(
        ev.cells,
        rows
          .filter((r) => r.kind !== 'event' && cell(r, 'tl1.subject') === ev.id)
          .map((r) => ({ id: r.id, values: r.cells })),
      );
      const cites = citedBy.get(key) ?? [];
      const current = cites.filter((c) => c.content === draft);
      const derivation = await derivationOf(rows, ev.id);
      const e: TimelineEvent = {
        key,
        owner: l.artifactId,
        id: ev.id,
        world: l.world,
        label: String(cell(ev, 'tl1.label') ?? ev.id),
        time: timeOf(ev.cells),
        ...(ev.cells['tl1.time.kind'] === 'derived'
          ? { calculated: await calculate(l.artifactId, null, rows, ev.id) }
          : {}),
        constraints: await constraintsOf(l.artifactId, rows, ev.id),
        participants: participantsOf(rows, ev.id),
        scenes: [...new Set(current.map((c) => c.scene))],
        fixedScenes: cites
          .filter((c) => !current.includes(c))
          .map((c) => ({ scene: c.scene, version: c.version })),
        ...(derivation ? { derivation } : {}),
      };
      events.push(e);
      place(
        l.world,
        {
          key,
          label: e.label,
          time: e.time,
          calculated: e.calculated,
          participants: e.participants,
        },
        worldClock.get(l.world) ?? '',
      );
    }
  }
  for (const list of Object.values(worldTime)) list.sort((a, b) => at.get(a)! - at.get(b)!);

  // ---------- transfers ----------
  const transfers: TimelineTransfer[] = [];
  for (const t of worldRows.filter((r) => r.kind === 'transfer')) {
    const ch = cell(t, 'tl1.ind.ch'),
      origin = cell(t, 'tl1.ind.origin');
    const from = await refOf(t, 'ref', ['event']),
      to = await refOf(t, 'ref2', ['event']);
    transfers.push({
      id: t.id,
      label: String(cell(t, 'tl1.label') ?? t.id),
      ...(ch && origin ? { individual: `${ch}@${origin}` } : {}),
      ...(from ? { from: from.view } : {}),
      ...(to ? { to: to.view } : {}),
      carries: worldRows
        .filter((r) => r.kind === 'transfer-info' && cell(r, 'tl1.subject') === t.id)
        .map((r) => String(cell(r, 'tl1.info'))),
    });
  }

  // Experience is an explicit Story relation, never sorted or inferred from world dates.
  const experiences: TimelineExperience[] = [];
  for (const r of rowsOf(story.composition).filter((r) => r.kind === 'experience')) {
    const from = await refOf(r, 'ref', ['event']),
      to = await refOf(r, 'ref2', ['event']);
    if (from?.view.state === 'unreadable' || to?.view.state === 'unreadable') continue;
    experiences.push({
      id: r.id,
      label: String(cell(r, 'tl1.label') ?? r.id),
      individual: `${cell(r, 'tl1.ind.ch')}@${cell(r, 'tl1.ind.origin')}`,
      ...(from ? { from: from.view } : {}),
      ...(to ? { to: to.view } : {}),
    });
  }

  // ---------- occurrences and manuscript ----------
  const occurrences: TimelineOccurrence[] = [];
  const sceneKind = new Map(links.scenes.map((s) => [s.id, s.kind]));
  for (const o of rowsOf(story.composition)
    .filter((r) => r.kind === 'occurrence')
    .sort((a, b) => (cell(a, 'tl1.order') as number) - (cell(b, 'tl1.order') as number))) {
    const res = await refOf(o, 'ref', ['scene']);
    const view: TimelineRefView = res?.view ?? {
      state: 'missing',
      artifact: '',
      version: '',
      item: '',
    };
    let sceneKey: string | undefined;
    let fixedScene: TimelineOccurrence['fixedScene'];
    if (view.state === 'resolved') {
      const key = `${view.artifact}#${view.item}`;
      const draftRows = rowsOf(view.artifact);
      const draftScene = draftRows.find((r) => r.id === view.item && r.kind === 'scene');
      const same =
        !!draftScene &&
        eventContent(
          res?.row,
          (res?.rows ?? []).filter(
            (r) => (r.values as Record<string, unknown>)['tl1.subject'] === view.item,
          ),
        ) ===
          eventContent(
            draftScene.cells,
            draftRows
              .filter((r) => r.kind !== 'scene' && cell(r, 'tl1.subject') === view.item)
              .map((r) => ({ id: r.id, values: r.cells })),
          );
      if (same) sceneKey = key;
      else fixedScene = { scene: key, version: view.version };
    }
    const manuscript: TimelineManuscriptRegion[] = [];
    for (const l of links.occurrenceLinks.filter(
      (x) => x.occurrence.artifactId === story.composition && x.occurrence.itemId === o.id,
    )) {
      // The link's own endpoint is an exact reference to a saved composition version.
      const end = await exact(
        l.occurrence.artifactId,
        l.occurrence.versionId,
        l.occurrence.contentHash,
        l.occurrence.itemId,
        undefined,
        ['occurrence'],
      );
      if (end.view.state !== 'resolved') {
        for (const g of l.regions)
          manuscript.push(
            end.view.state === 'unreadable'
              ? { link: l.id, sceneId: g.sceneId, state: 'unreadable' }
              : {
                  link: l.id,
                  sceneId: g.sceneId,
                  state: end.view.state === 'missing' ? 'link-missing' : 'link-invalid',
                  reason: end.view.reason ?? '',
                },
          );
        continue;
      }
      // The linked saved occurrence must place the same SC as the current draft occurrence.
      const sceneRef = (v: Record<string, unknown> | undefined) =>
        canonicalJson(
          present(
            Object.fromEntries(Object.entries(v ?? {}).filter(([k]) => k.startsWith('tl1.ref.'))),
          ),
        );
      if (sceneRef(end.row) !== sceneRef(o.cells)) {
        for (const g of l.regions)
          manuscript.push({
            link: l.id,
            sceneId: g.sceneId,
            state: 'link-fixed',
            version: l.occurrence.versionId,
            reason: '提示位置の対応は保存版の提示位置に結ばれ、今のdraftは別のSCを置いています。',
          });
        continue;
      }
      for (const g of l.regions) {
        const a = await read(g.address.artifactId);
        if (a === 'unreadable') {
          unreadable = partial = true;
          manuscript.push({ link: l.id, sceneId: g.sceneId, state: 'unreadable' });
          continue;
        }
        const kind = sceneKind.get(g.sceneId) === 'design' ? 'design' : 'document';
        const found = a ? a.versions.filter((x) => x.versionId === g.address.versionId) : [];
        const v = found.length === 1 ? found[0] : undefined;
        // The same exact-version rule as references (§3): one saved version with that ID,
        // whose stored hash matches its content, and the element in it. No fallback.
        const reason =
          found.length > 1
            ? '同じ版IDの原稿の保存版が複数あります。'
            : !v
              ? undefined
              : v.contentHash !== (await verifiedHash(a!, v.versionId, v.content))
                ? '原稿の保存版の内容がhashと一致しません。'
                : !hasElement(kind, v.content, g.address.elementId)
                  ? '原稿の保存版に該当の要素がありません。'
                  : undefined;
        const state: 'current' | 'missing' | 'invalid' = reason
          ? 'invalid'
          : !v
            ? 'missing'
            : 'current';
        if (state !== 'current') partial = true;
        manuscript.push({
          link: l.id,
          sceneId: g.sceneId,
          ...g.address,
          kind,
          state,
          ...(reason ? { reason } : {}),
        });
      }
    }
    occurrences.push({
      id: o.id,
      order: cell(o, 'tl1.order') as number,
      part: String(cell(o, 'tl1.part') ?? ''),
      label: String(cell(o, 'tl1.label') ?? o.id),
      scene: view,
      ...(sceneKey ? { sceneKey } : {}),
      ...(fixedScene ? { fixedScene } : {}),
      manuscript,
    });
    if (sceneKey) scenes.find((s) => s.key === sceneKey)?.occurrences.push(o.id);
    if (fixedScene) scenes.find((s) => s.key === fixedScene!.scene)?.fixedOccurrences.push(o.id);
  }

  const result = {
    story: story.id,
    query: { ...query },
    scope: partial ? ('partial' as const) : ('complete' as const),
    unreadable,
    owners,
    worlds,
    transfers,
    experiences,
    events,
    worldTime,
    unplaced,
    scenes,
    occurrences,
    backEvents: events.filter((e) => !e.scenes.length && !e.fixedScenes.length).map((e) => e.key),
    unsupported: UNSUPPORTED,
  };
  // The snapshot covers the inputs and every resolution state in the (already redacted)
  // result, so a manuscript that disappears or returns changes it (§6.4: no hidden IDs).
  const snapshotId = await contentHash(
    JSON.parse(
      JSON.stringify({
        contract: 'story-timeline-t2/constraints-1',
        story,
        owners: fingerprint,
        links: await contentHash(JSON.parse(JSON.stringify(links))),
        query,
        result,
      }),
    ),
  );
  const projection = { ...result, snapshotId };
  const bytes = new TextEncoder().encode(JSON.stringify(projection)).length;
  if (bytes > TL1_LIMITS.projectionBytes) throw new TimelineLimitError('projectionBytes', bytes);
  return { projection, used };
}

/**
 * The saved manuscript version a region names, by the exact-version rule (§3): exactly one
 * saved version with the ID, whose stored hash matches its content. Used where a manuscript is
 * opened, so a duplicated or broken version is refused there as in the projection.
 */
export async function exactSavedVersion(
  a: Artifact<unknown>,
  versionId: string,
): Promise<{ content: unknown } | { reason: string }> {
  const found = a.versions.filter((x) => x.versionId === versionId);
  if (found.length > 1) return { reason: '同じ版IDの原稿の保存版が複数あります。' };
  const v = found[0];
  if (!v) return { reason: '参照していた原稿の版がありません。' };
  if (v.contentHash !== (await contentHash(v.content)))
    return { reason: '原稿の保存版の内容がhashと一致しません。' };
  return { content: v.content };
}

/**
 * Keeps only the newest query's result (TL32): a slow read of world A that returns after the
 * author switched to world B is dropped instead of replacing B.
 */
export class TimelineQueryGate {
  private latest = 0;
  async run<T>(load: () => Promise<T>): Promise<{ current: true; value: T } | { current: false }> {
    const ticket = ++this.latest;
    let value: T;
    try {
      value = await load();
    } catch (e) {
      // A superseded query's failure is as irrelevant as its result: only the newest throws.
      if (ticket !== this.latest) return { current: false };
      throw e;
    }
    return ticket === this.latest ? { current: true, value } : { current: false };
  }
}
