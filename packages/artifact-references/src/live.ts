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
export type ValueFormat = { style: 'decimal' | 'percent'; digits: number; unit: string };
export type LivePresentation =
  | { kind: 'value'; value: number; format: ValueFormat }
  | { kind: 'figure'; label: string };
export type LiveReference = {
  schemaVersion: 2;
  source: LiveSource;
  mode: 'fixed';
  snapshot: ReferenceSnapshot;
  presentation: LivePresentation;
};
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
  label(f.unit);
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
      r.schemaVersion === 2 &&
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
      fields.schemaVersion?.value === 2 &&
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
  reference: LiveReference,
  destinationArtifactId: string,
): Promise<void> {
  if (!validLiveReference(reference) || reference.source.artifactId === destinationArtifactId)
    fail('参照元または保存版が不正です。');
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
    schemaVersion: 2,
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
  if (!result.figureSrc || canonicalJson(reference) !== canonicalJson(result.reference))
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

export function validLiveReferenceItems(
  references: readonly LiveReference[],
  embedded: readonly { reference?: unknown }[],
): boolean {
  if (!references.length) return true;
  const all = [
    ...references,
    ...embedded.flatMap(({ reference }) => (reference ? [reference] : [])),
  ];
  return (
    all.length <= referenceLimits.references &&
    references.every(validLiveReference) &&
    new TextEncoder().encode(canonicalJson(all)).length <= referenceLimits.closureBytes
  );
}

export function formatLiveValue(
  presentation: Extract<LivePresentation, { kind: 'value' }>,
): string {
  if (!Number.isFinite(presentation.value) || !validFormat(presentation.format))
    return fail('表示形式が不正です。');
  const { style, digits, unit } = presentation.format;
  return `${(presentation.value * (style === 'percent' ? 100 : 1)).toFixed(digits)}${style === 'percent' ? '%' : ''}${unit}`;
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
