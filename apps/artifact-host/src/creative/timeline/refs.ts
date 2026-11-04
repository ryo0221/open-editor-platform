/**
 * Story Timeline T2: new exact references are confirmed before they are written
 * (t0-contract.md §2.3, TL30b, TL34d). A command cannot read other owners, so a row that
 * writes an exact reference reaches `insertRows` only through `verifyNewReferences`, which
 * resolves each one the way the reading does (permission, artifact, one saved version, stored
 * and recomputed hash, item, row kind, a valid saved timeline table), re-checking permission
 * after every await. Keeping an existing unresolved reference is a different rule (reading).
 */
import { contentHash, type Artifact } from '@editor-platform/artifact-core';
import { isDocument } from '@editor-platform/document/model';
import type { StructuredData } from '@editor-platform/structured-data/model';
import { settingSourceCards } from '../setting-source';
import { TimelineEditError, type TimelineRowInput } from './edit-error';
import { readTimelineTable, type TimelineRole } from './table';
import { TL1_ROLES } from './tl1-schema';

export interface TimelineReferenceSource {
  get(id: string): Promise<Artifact<unknown> | undefined>;
}

/** Rows whose exact references were confirmed; only `verifyNewReferences` makes one. */
export interface VerifiedTimelineRows {
  readonly rows: readonly TimelineRowInput[];
  /** The exact targets, re-checked against `mayRead` when the command is applied. */
  readonly targets: readonly string[];
  readonly mayRead: (artifactId: string) => boolean;
}
const issued = new WeakSet<VerifiedTimelineRows>();
export const isVerifiedRows = (v: unknown): v is VerifiedTimelineRows =>
  !!v && typeof v === 'object' && issued.has(v as VerifiedTimelineRows);

/** The exact references a row writes, as `[column prefix, artifact]`. */
export function exactTargets(values: TimelineRowInput['values']) {
  return (['tl1.ref', 'tl1.ref2'] as const)
    .filter((p) => values[`${p}.artifact`] !== undefined && values[`${p}.artifact`] !== null)
    .map((p) => [p, String(values[`${p}.artifact`])] as const);
}

/**
 * The row kinds a reference of each relation may point at, as the reader allows them
 * internally: an occurrence places an SC, a diagnostic exception's target or basis may name
 * any row (contract §2.6), and every other relation names an event. A cite may also name a
 * CH/LO item of a non-timeline sheet or document.
 */
const targetAllowed = (rowKind: unknown, target: string) =>
  rowKind === 'occurrence'
    ? target === 'scene'
    : rowKind === 'exception-basis' || rowKind === 'exception-target'
      ? true
      : target === 'event';
/** The roles whose tables may hold a row kind: a saved target must read as one of them. */
const rolesOf = (kind: string) =>
  (Object.keys(TL1_ROLES) as TimelineRole[]).filter((r) => Object.hasOwn(TL1_ROLES[r].rows, kind));
const deepFreeze = <T>(v: T): T => {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
};

async function confirm(
  source: TimelineReferenceSource,
  mayRead: (id: string) => boolean,
  row: TimelineRowInput,
  prefix: 'tl1.ref' | 'tl1.ref2',
) {
  const v = row.values;
  const [artifact, version, hash, item] = ['artifact', 'version', 'hash', 'item'].map((k) =>
    String(v[`${prefix}.${k}`] ?? ''),
  );
  // An unreadable target is refused without saying whether it exists (§6.4).
  const unreadable = () =>
    new TimelineEditError(`${row.id} の参照先を読めないため、この参照は書けません。`);
  const missing = (why: string) =>
    new TimelineEditError(
      `${row.id} の参照先が確かめられません（${why}）。新しい欠落参照は書けません。`,
    );
  if (!mayRead(artifact)) throw unreadable();
  const a = await source.get(artifact);
  if (!mayRead(artifact)) throw unreadable();
  // The source must return the artifact asked for: another one is not read in its place,
  // whatever its saved versions hold (as the projection's reading requires).
  if (!a || a.id !== artifact) throw missing('Artifactがありません');
  const found = a.versions.filter((x) => x.versionId === version);
  if (found.length !== 1)
    throw missing(found.length ? '同じ版IDの保存版が複数あります' : '保存版がありません');
  const saved = found[0];
  if (saved.contentHash !== hash || (await contentHash(saved.content)) !== hash)
    throw missing('保存版のhashが参照と一致しません');
  if (!mayRead(artifact)) throw unreadable();
  if (isDocument(saved.content)) {
    let cards: { id: string }[] = [];
    try {
      cards = settingSourceCards(saved.content);
    } catch {
      throw missing('文書から項目を読めません');
    }
    if (v['tl1.row'] !== 'cite' || !cards.some((c) => c.id === item))
      throw missing('その版に項目がありません');
    return;
  }
  const target = (saved.content as StructuredData)?.rows?.find((r) => r.id === item);
  if (!target) throw missing('その版に項目がありません');
  const kind = (target.values as Record<string, unknown>)['tl1.row'];
  if (kind === undefined) {
    // A non-timeline sheet (characters): only a citation may name its items.
    if (v['tl1.row'] !== 'cite') throw missing('参照先がタイムラインの表ではありません');
    return;
  }
  if (typeof kind !== 'string' || !targetAllowed(v['tl1.row'], kind))
    throw missing('参照先の行の種類が違います');
  if (!rolesOf(kind).some((role) => readTimelineTable(role, saved.content).state !== 'invalid'))
    throw missing('参照先の保存版がタイムラインの表として正しくありません');
}

/**
 * Confirms every exact reference the rows write and returns them for `insertRows`. Saved
 * versions do not change, so a confirmed reference stays exact; only permission can change
 * between this check and the command, and the command checks it again when it is applied.
 */
export async function verifyNewReferences(
  source: TimelineReferenceSource,
  rows: TimelineRowInput[],
  mayRead: (artifactId: string) => boolean,
): Promise<VerifiedTimelineRows> {
  // The rows are copied and frozen before the first await: what is checked is what is
  // written, whatever the caller does with its own rows meanwhile or afterwards.
  const snapshot = deepFreeze(structuredClone(rows));
  const targets = new Set<string>();
  for (const r of snapshot)
    for (const [prefix, artifact] of exactTargets(r.values)) {
      await confirm(source, mayRead, r, prefix);
      targets.add(artifact);
    }
  const verified: VerifiedTimelineRows = Object.freeze({
    rows: snapshot,
    targets: Object.freeze([...targets]),
    mayRead,
  });
  issued.add(verified);
  return verified;
}
