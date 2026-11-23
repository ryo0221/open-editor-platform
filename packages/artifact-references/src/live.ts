import { canonicalJson, clone, contentHash, deepFreeze } from '@editor-platform/artifact-core';
import {
  containsEmbeddedReference,
  ReferenceError,
  referenceLimits,
  validReferenceSnapshot,
  type ReferenceSnapshot,
} from './index';

export type LiveTarget =
  | { kind: 'value'; targetId: string; metricId: string }
  | { kind: 'figure'; figureId: string };
export type LiveSource = { artifactId: string; domain: string; target: LiveTarget };
/**
 * grouping: 3 桁ごとに「,」で区切る。scale: 10 の scale 乗で割ってから桁数で丸める（3 千・4 万・6 百万・8 億・12 兆）。
 * 単位の字（「億円」など）は unit に書く（倍率を選んでも単位は変えない）。倍率は小数（decimal）だけ。どちらも無ければ今までどおり。
 * 絶対値が 1e21 以上は toFixed が指数の表記になり、桁区切りは付かない（千〜兆の金額の範囲では起きない）。
 */
export type ValueFormat = {
  style: 'decimal' | 'percent';
  digits: number;
  unit: string;
  grouping?: boolean;
  scale?: ValueScale;
};
export const VALUE_SCALES = [3, 4, 6, 8, 12] as const;
export type ValueScale = (typeof VALUE_SCALES)[number];
export type LivePresentation =
  | { kind: 'value'; value: number; format: ValueFormat }
  | { kind: 'figure'; label: string };
/**
 * A fixed citation with its whole retained version. schema 2 is stored like this; schema 3 is
 * this shape only while editing (finding 79): a document or deck stores it packed, its version
 * kept once in `liveSnapshots`.
 */
export type LiveReference = {
  schemaVersion: 2 | 3;
  source: LiveSource;
  mode: 'fixed';
  snapshot: ReferenceSnapshot;
  presentation: LivePresentation;
};
/** The version a packed citation names; its content and dependencies live in `liveSnapshots`. */
export type LiveSnapshotIdentity = Pick<
  ReferenceSnapshot,
  'versionId' | 'revision' | 'contentHash'
>;
export type PackedLiveReference = Omit<LiveReference, 'schemaVersion' | 'snapshot'> & {
  schemaVersion: 3;
  snapshot: LiveSnapshotIdentity;
};
/** What a document or deck stores: a schema 2 citation with its version, or a packed schema 3. */
export type StoredLiveReference = (LiveReference & { schemaVersion: 2 }) | PackedLiveReference;
/**
 * One row per retained version (domain, artifact, version), however many citations name it.
 * Keyed by `liveSnapshotKey`. A different version is another row even when its content hash is
 * the same.
 */
export type LiveSnapshots = Record<string, ReferenceSnapshot>;
/** A citation in either form: with its version (editing, schema 2) or packed (stored schema 3). */
export type LiveCitation = LiveReference | PackedLiveReference;
export type LiveOption = (
  | { kind: 'value'; targetId: string; metricId: string }
  | { kind: 'figure'; figureId: string }
) & { label: string };
export type LiveResolution =
  | { kind: 'value'; value: number }
  | { kind: 'figure'; label: string; src: string };
/** The host authenticates saved snapshots and access; the source editor resolves data. */
export interface LiveReferenceProvider {
  checkAccess(source: LiveSource): void | Promise<void>;
  checkSnapshot(source: LiveSource, snapshot: ReferenceSnapshot): void | Promise<void>;
  list(snapshot: ReferenceSnapshot): LiveOption[] | Promise<LiveOption[]>;
  resolve(
    snapshot: ReferenceSnapshot,
    target: LiveTarget,
  ): LiveResolution | Promise<LiveResolution>;
}
export type PreparedLiveReference = {
  reference: LiveReference;
  figureSrc?: string;
};
export const safeLiveFigure = (src: unknown): src is string =>
  typeof src === 'string' &&
  src.length <= referenceLimits.closureBytes &&
  /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(src);

const identifier = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= 512 &&
  !['__proto__', 'prototype', 'constructor'].includes(v);
const label = (v: unknown): v is string => typeof v === 'string' && v.length <= 256;
const validFormat = (f: ValueFormat) =>
  !!f &&
  (f.style === 'decimal' || f.style === 'percent') &&
  Number.isInteger(f.digits) &&
  f.digits >= 0 &&
  f.digits <= 6 &&
  label(f.unit) &&
  (f.grouping === undefined || typeof f.grouping === 'boolean') &&
  (f.scale === undefined ||
    (f.style === 'decimal' && (VALUE_SCALES as readonly number[]).includes(f.scale)));
const validTarget = (t: LiveTarget) =>
  !!t &&
  (t.kind === 'value'
    ? identifier(t.targetId) && identifier(t.metricId)
    : t.kind === 'figure' && identifier(t.figureId));
// References are depth one: a retained snapshot must not itself carry a citation,
// because only the outer content and its direct dependencies are hashed.
const nestedReference = (snapshot: ReferenceSnapshot) =>
  [snapshot.content, ...snapshot.dependencies.map((d) => d.content)].some(
    (content) => containsLiveReference(content) || containsEmbeddedReference(content),
  );
const liveSnapshot = (snapshot: unknown): snapshot is ReferenceSnapshot =>
  validReferenceSnapshot(snapshot) && !nestedReference(snapshot);
const fail = (message: string): never => {
  throw new ReferenceError('error', message);
};
export function validLiveReference(value: unknown): value is LiveReference {
  try {
    const r = value as LiveReference;
    return (
      !!r &&
      (r.schemaVersion === 2 || r.schemaVersion === 3) &&
      r.mode === 'fixed' &&
      !!r.source &&
      identifier(r.source.artifactId) &&
      identifier(r.source.domain) &&
      validTarget(r.source.target) &&
      liveSnapshot(r.snapshot) &&
      r.snapshot.artifactId === r.source.artifactId &&
      r.snapshot.domain === r.source.domain &&
      !!r.presentation &&
      r.presentation.kind === r.source.target.kind &&
      (r.presentation.kind === 'value'
        ? Number.isFinite(r.presentation.value) && validFormat(r.presentation.format)
        : label(r.presentation.label)) &&
      new TextEncoder().encode(canonicalJson(r)).length <= referenceLimits.closureBytes
    );
  } catch {
    return false;
  }
}
/** Detect a fixed citation in native content or a serialized operation payload. */
export function containsLiveReference(value: unknown): boolean {
  const seen = new Set<object>();
  function visit(item: unknown): boolean {
    if (!item || typeof item !== 'object' || seen.has(item)) return false;
    seen.add(item);
    const fields = Object.getOwnPropertyDescriptors(item);
    if (
      (fields.schemaVersion?.value === 2 || fields.schemaVersion?.value === 3) &&
      fields.mode?.value === 'fixed' &&
      ['source', 'snapshot', 'presentation'].every(
        (key) => fields[key]?.value && typeof fields[key].value === 'object',
      )
    )
      return true;
    return Object.values(fields).some((field) => 'value' in field && visit(field.value));
  }
  return visit(value);
}

async function verify(
  source: LiveSource,
  snapshot: ReferenceSnapshot,
  provider: LiveReferenceProvider,
  destinationArtifactId?: string,
) {
  if (
    !source ||
    !identifier(source.artifactId) ||
    !identifier(source.domain) ||
    !validTarget(source.target) ||
    !liveSnapshot(snapshot) ||
    source.artifactId !== snapshot.artifactId ||
    source.domain !== snapshot.domain ||
    source.artifactId === destinationArtifactId
  )
    fail('参照元または保存版が不正です。');
  const owned = deepFreeze(clone(snapshot));
  await provider.checkAccess(source);
  await provider.checkSnapshot(source, owned);
  await verifyLiveSnapshotHashes(owned);
  return owned;
}

async function verifyLiveSnapshotHashes(snapshot: ReferenceSnapshot): Promise<void> {
  if ((await contentHash(snapshot.content)) !== snapshot.contentHash)
    fail('参照元の内容が一致しません。');
  for (const d of snapshot.dependencies)
    if ((await contentHash(d.content)) !== d.contentHash) fail('参照依存の内容が一致しません。');
}

/** Verify a retained fixed reference without access to the source Editor. */
export async function verifyRetainedLiveReference(
  stored: LiveReference | StoredLiveReference,
  destinationArtifactId: string,
  liveSnapshots?: LiveSnapshots,
): Promise<void> {
  let reference: LiveReference | undefined;
  try {
    reference = hydrateLiveReference(stored, liveSnapshots);
  } catch {
    reference = undefined;
  }
  if (
    !reference ||
    !validLiveReference(reference) ||
    reference.source.artifactId === destinationArtifactId
  )
    return fail('参照元または保存版が不正です。');
  await verifyLiveSnapshotHashes(reference.snapshot);
}
function targetMatches(a: LiveTarget, b: LiveTarget) {
  return (
    a.kind === b.kind &&
    (a.kind === 'value'
      ? b.kind === 'value' && a.targetId === b.targetId && a.metricId === b.metricId
      : b.kind === 'figure' && a.figureId === b.figureId)
  );
}
export async function listLiveOptions(
  snapshot: ReferenceSnapshot,
  provider: LiveReferenceProvider,
) {
  if (!validReferenceSnapshot(snapshot)) return fail('保存版が不正です。');
  const options = await provider.list(snapshot);
  if (
    !Array.isArray(options) ||
    options.filter((o) => o?.kind === 'value').length > 1000 ||
    options.filter((o) => o?.kind === 'figure').length > 1000 ||
    options.some((o) => !o || !validTarget(o) || !label(o.label))
  )
    fail('対象一覧が不正か上限を超えています。');
  const keys = options.map((option) =>
    option.kind === 'figure'
      ? JSON.stringify([option.kind, option.figureId])
      : JSON.stringify([option.kind, option.targetId, option.metricId]),
  );
  if (new Set(keys).size !== keys.length) return fail('保存版の対象が重複しています。');
  return options;
}

export async function prepareLiveReference(
  source: LiveSource,
  snapshot: ReferenceSnapshot,
  provider: LiveReferenceProvider,
  format?: ValueFormat,
  destinationArtifactId?: string,
): Promise<PreparedLiveReference> {
  const owned = await verify(source, snapshot, provider, destinationArtifactId);
  const options = await listLiveOptions(owned, provider);
  if (!options.some((o) => targetMatches(source.target, o)))
    throw new ReferenceError('missing-target', '保存版に対象がありません。');
  const resolved = await provider.resolve(owned, source.target);
  let presentation: LivePresentation;
  let figureSrc: string | undefined;
  if (
    resolved?.kind === 'value' &&
    source.target.kind === 'value' &&
    Number.isFinite(resolved.value) &&
    format &&
    validFormat(format)
  )
    presentation = { kind: 'value', value: resolved.value, format: clone(format) };
  else if (
    resolved?.kind === 'figure' &&
    source.target.kind === 'figure' &&
    label(resolved.label) &&
    safeLiveFigure(resolved.src)
  ) {
    presentation = { kind: 'figure', label: resolved.label };
    figureSrc = resolved.src;
  } else return fail('対象の解決結果または表示形式が不正です。');
  await provider.checkAccess(source);
  const result: LiveReference = {
    schemaVersion: 3,
    source: clone(source),
    mode: 'fixed',
    snapshot: owned,
    presentation,
  };
  if (!validLiveReference(result)) fail('引用が上限を超えています。');
  return { reference: deepFreeze(result), ...(figureSrc ? { figureSrc } : {}) };
}
export async function createLiveReference(
  ...args: Parameters<typeof prepareLiveReference>
): Promise<LiveReference> {
  return (await prepareLiveReference(...args)).reference;
}

/** Reproject the exact retained figure only after checking its version and access. */
export async function projectLiveFigure(
  reference: LiveReference,
  provider: LiveReferenceProvider,
  destinationArtifactId?: string,
): Promise<string> {
  const result = await prepareLiveReference(
    reference.source,
    reference.snapshot,
    provider,
    undefined,
    destinationArtifactId,
  );
  if (
    !result.figureSrc ||
    canonicalJson({ ...reference, schemaVersion: 3 }) !== canonicalJson(result.reference)
  )
    throw new ReferenceError('error', '保存版の図が引用時の内容と一致しません。');
  return result.figureSrc;
}

export async function compareLiveReference(
  reference: LiveReference,
  latest: ReferenceSnapshot,
  provider: LiveReferenceProvider,
  destinationArtifactId?: string,
): Promise<'same' | 'newer'> {
  if (!validLiveReference(reference)) return fail('引用が不正です。');
  const current = await verify(
    reference.source,
    reference.snapshot,
    provider,
    destinationArtifactId,
  );
  const next = await verify(reference.source, latest, provider, destinationArtifactId);
  await provider.checkAccess(reference.source);
  for (const dependency of next.dependencies) {
    const previous = current.dependencies.find((item) => item.id === dependency.id);
    if (previous && previous.contentHash !== dependency.contentHash)
      return fail('同じ依存IDの内容が矛盾しています。');
  }
  if (next.versionId === current.versionId) {
    if (canonicalJson(next) !== canonicalJson(current))
      return fail('同じ版の内容が矛盾しています。');
    return 'same';
  }
  if (next.revision <= current.revision) return fail('保存版が逆行または矛盾しています。');
  return 'newer';
}
export async function prepareLiveReferenceUpdate(
  reference: LiveReference,
  latest: ReferenceSnapshot,
  provider: LiveReferenceProvider,
  destinationArtifactId?: string,
): Promise<PreparedLiveReference> {
  if ((await compareLiveReference(reference, latest, provider, destinationArtifactId)) !== 'newer')
    return fail('新しい版がありません。');
  return prepareLiveReference(
    reference.source,
    latest,
    provider,
    reference.presentation.kind === 'value' ? reference.presentation.format : undefined,
    destinationArtifactId,
  );
}
export async function updateLiveReference(
  ...args: Parameters<typeof prepareLiveReferenceUpdate>
): Promise<LiveReference> {
  return (await prepareLiveReferenceUpdate(...args)).reference;
}

/**
 * Count, validity and retained bytes of a surface's citations. Stored citations are checked
 * against the surface's `liveSnapshots`; a version kept once in the table counts once.
 */
export function validLiveReferenceItems(
  references: readonly (LiveReference | StoredLiveReference)[],
  embedded: readonly { reference?: unknown }[],
  liveSnapshots?: LiveSnapshots,
): boolean {
  if (!references.length)
    return liveSnapshots === undefined || validLiveSnapshotRows(liveSnapshots, []);
  const all = [
    ...references,
    ...embedded.flatMap(({ reference }) => (reference ? [reference] : [])),
  ];
  return (
    all.length <= referenceLimits.references &&
    validLiveSnapshotRows(liveSnapshots ?? {}, references) &&
    // Stored schema 3 is always packed; schema 2 keeps its version inline.
    references.every((r) =>
      r.schemaVersion === 2
        ? validLiveReference(r)
        : isPackedLiveReference(r) && validPackedLiveReference(r, liveSnapshots),
    ) &&
    new TextEncoder().encode(canonicalJson(all)).length +
      new TextEncoder().encode(canonicalJson(liveSnapshots ?? {})).length <=
      referenceLimits.closureBytes
  );
}

/** The `liveSnapshots` key: the version's domain, artifact and version ID, without collisions. */
export const liveSnapshotKey = (
  snapshot: Pick<ReferenceSnapshot, 'domain' | 'artifactId' | 'versionId'>,
) => canonicalJson([snapshot.domain, snapshot.artifactId, snapshot.versionId]);
const referenceKey = (r: { source: LiveSource; snapshot: { versionId: string } }) =>
  liveSnapshotKey({ ...r.source, versionId: r.snapshot.versionId });
const ownKey = (table: LiveSnapshots, key: string) =>
  Object.prototype.hasOwnProperty.call(table, key);
const sameIdentity = (a: LiveSnapshotIdentity, b: LiveSnapshotIdentity) =>
  a.versionId === b.versionId && a.revision === b.revision && a.contentHash === b.contentHash;
const identity = (s: LiveSnapshotIdentity): LiveSnapshotIdentity => ({
  versionId: s.versionId,
  revision: s.revision,
  contentHash: s.contentHash,
});

export function isPackedLiveReference(value: unknown): value is PackedLiveReference {
  const r = value as PackedLiveReference;
  return !!r && r.schemaVersion === 3 && !!r.snapshot && !('content' in r.snapshot);
}
function validPackedLiveReference(r: PackedLiveReference, table: LiveSnapshots | undefined) {
  if (!table || !r.source || !r.snapshot || typeof r.snapshot.versionId !== 'string') return false;
  const key = referenceKey(r);
  if (
    !ownKey(table, key) ||
    Object.keys(r.snapshot).sort().join() !== 'contentHash,revision,versionId'
  )
    return false;
  const row = table[key];
  return sameIdentity(r.snapshot, row) && validLiveReference({ ...r, snapshot: row });
}
/**
 * Every row is a valid retained version under its own key and is named by a packed citation.
 * A version is either packed or kept inline by schema 2 citations, never both.
 */
function validLiveSnapshotRows(
  table: LiveSnapshots,
  references: readonly (LiveReference | StoredLiveReference)[],
): boolean {
  if (!table || typeof table !== 'object' || Array.isArray(table)) return false;
  const named = new Set(references.filter(isPackedLiveReference).map(referenceKey));
  const inline = new Set(references.filter((r) => r.schemaVersion === 2).map(referenceKey));
  return Object.entries(table).every(
    ([key, row]) =>
      liveSnapshot(row) && liveSnapshotKey(row) === key && named.has(key) && !inline.has(key),
  );
}

/** A citation with its retained version, read from the surface's table when it is packed. */
export function hydrateLiveReference(
  reference: LiveReference | StoredLiveReference,
  liveSnapshots?: LiveSnapshots,
): LiveReference {
  if (!isPackedLiveReference(reference)) return reference as LiveReference;
  const key = referenceKey(reference);
  const row = liveSnapshots && ownKey(liveSnapshots, key) ? liveSnapshots[key] : undefined;
  if (!row || !sameIdentity(reference.snapshot, row)) return fail('引用の保存版がありません。');
  return { ...reference, snapshot: row };
}

/**
 * The stored form of a surface's citations (finding 79): each schema 3 citation is packed and its
 * version kept once in the returned table; schema 2 citations of a version that a schema 3
 * citation also names move into the table in the same edit, and rows no citation names are
 * dropped. Schema 2 citations of other versions are left exactly as they are. Pure: the same
 * editing state always gives the same stored form, so Undo/Redo restore citations and rows
 * together. Rows of packed citations come from `previous`.
 */
export function packLiveReferences<T>(
  value: T,
  previous: LiveSnapshots = {},
): { value: T; liveSnapshots: LiveSnapshots } {
  const table: LiveSnapshots = {};
  const packedKeys = new Set<string>();
  const add = (key: string, row: ReferenceSnapshot) => {
    if (ownKey(table, key)) {
      if (canonicalJson(table[key]) !== canonicalJson(row)) fail('同じ版の内容が矛盾しています。');
    } else table[key] = row;
  };
  const visit = (
    item: unknown,
    f: (r: LiveReference | PackedLiveReference) => unknown,
  ): unknown => {
    if (!item || typeof item !== 'object') return item;
    if (Array.isArray(item)) {
      let changed = false;
      const next = item.map((child) => {
        const v = visit(child, f);
        if (v !== child) changed = true;
        return v;
      });
      return changed ? next : item;
    }
    const r = item as LiveReference;
    if (
      (r.schemaVersion === 2 || r.schemaVersion === 3) &&
      r.mode === 'fixed' &&
      r.source &&
      r.snapshot &&
      r.presentation
    )
      return f(r);
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [k, child] of Object.entries(item)) {
      const v = visit(child, f);
      if (v !== child) changed = true;
      next[k] = v;
    }
    return changed ? next : item;
  };
  // First pass: the versions schema 3 citations name.
  visit(value, (r) => {
    if (r.schemaVersion === 3) packedKeys.add(referenceKey(r));
    return r;
  });
  const out = visit(value, (r) => {
    const key = referenceKey(r);
    if (r.schemaVersion === 2 && !packedKeys.has(key)) return r;
    if (isPackedLiveReference(r)) {
      const row = ownKey(previous, key) ? previous[key] : undefined;
      if (!row || !sameIdentity(r.snapshot, row)) fail('引用の保存版がありません。');
      add(key, row!);
      return r;
    }
    const hydrated = r as LiveReference;
    if (!liveSnapshot(hydrated.snapshot) || liveSnapshotKey(hydrated.snapshot) !== key)
      fail('参照元または保存版が不正です。');
    add(key, hydrated.snapshot);
    const packed: PackedLiveReference = {
      ...hydrated,
      schemaVersion: 3,
      snapshot: identity(hydrated.snapshot),
    };
    return packed;
  }) as T;
  return { value: out, liveSnapshots: table };
}

/** The editing form: every packed citation carries its version again. Rows are checked. */
export function unpackLiveReferences<T>(value: T, liveSnapshots: LiveSnapshots = {}): T {
  const visit = (item: unknown): unknown => {
    if (!item || typeof item !== 'object') return item;
    if (Array.isArray(item)) return item.map(visit);
    if (isPackedLiveReference(item) && (item as PackedLiveReference).mode === 'fixed')
      return hydrateLiveReference(item as PackedLiveReference, liveSnapshots);
    return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, visit(v)]));
  };
  return visit(value) as T;
}

/** Re-checks a table row's hashes (a retained version read without its source Editor). */
export async function verifyLiveSnapshots(liveSnapshots: LiveSnapshots): Promise<void> {
  for (const row of Object.values(liveSnapshots)) await verifyLiveSnapshotHashes(row);
}

export function formatLiveValue(
  presentation: Extract<LivePresentation, { kind: 'value' }>,
): string {
  if (!Number.isFinite(presentation.value) || !validFormat(presentation.format))
    return fail('表示形式が不正です。');
  const { style, digits, unit, grouping, scale } = presentation.format;
  const shown = (presentation.value * (style === 'percent' ? 100 : 1)) / 10 ** (scale ?? 0);
  let text = shown.toFixed(digits);
  if (grouping) {
    const [whole, fraction] = text.split('.');
    const sign = whole.startsWith('-') ? '-' : '';
    const grouped = whole.slice(sign.length).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    text = `${sign}${grouped}${fraction === undefined ? '' : `.${fraction}`}`;
  }
  return `${text}${style === 'percent' ? '%' : ''}${unit}`;
}
/** Preconditions make a single replacement/removal suitable for a native command. */
export function changeLiveReference<T extends { id: string; reference: LiveReference }>(
  items: readonly T[],
  id: string,
  expected: LiveReference,
  replacement?: LiveReference,
): T[] {
  const index = items.findIndex((item) => item.id === id);
  if (index < 0 || canonicalJson(items[index].reference) !== canonicalJson(expected))
    return fail('対象引用が存在しないか変更されています。');
  if (replacement && !validLiveReference(replacement)) return fail('引用が不正です。');
  const result = items.slice();
  if (replacement) result[index] = { ...result[index], reference: replacement };
  else result.splice(index, 1);
  return result;
}
export function deferLiveReference<T extends { id: string; reference: LiveReference }>(
  items: readonly T[],
  id: string,
  expected: LiveReference,
): void {
  if (
    !items.some(
      (item) => item.id === id && canonicalJson(item.reference) === canonicalJson(expected),
    )
  )
    fail('対象引用が存在しないか変更されています。');
}
