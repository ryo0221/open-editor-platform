import { canonicalJson, deepFreeze } from '@editor-platform/artifact-core';
import {
  EditorSession,
  immutableCommand,
  sameLocalRevision,
  type LocalDraftRevision,
} from '@editor-platform/editor-core';
import { admit, checkCapacity, isOwnedContent } from './admission';
import { copyData, requestBudget } from './input';
import { mergeNative } from './import';
import { fictionMapLimits, checkAffectedIds } from './limits';
import { record, text, checkReferences } from './schema';
import { attempt, fail } from './result';
import type { FictionMapContent, FictionMapFeature, FictionMapResult } from './types';

/** Structural command port to the Host's existing local Session; owns no history. */
export type FictionMapSession = Pick<
  EditorSession<FictionMapContent>,
  'content' | 'revision' | 'execute' | 'peekHistory' | 'undo' | 'redo'
>;
export interface FictionMapBase {
  readonly content: FictionMapContent;
  readonly revision: LocalDraftRevision;
}
declare const preparedBrand: unique symbol;
export interface PreparedFictionMapChange {
  readonly [preparedBrand]: true;
}
export type FictionMapPermission = (
  current: FictionMapContent,
  candidate: FictionMapContent,
) => boolean;
interface PreparedState {
  readonly base: FictionMapContent;
  readonly canonicalBase: string;
  readonly revision: LocalDraftRevision;
  readonly candidate: FictionMapContent;
  readonly policy: string;
  consumed: boolean;
  active: boolean;
}
const prepared = new WeakMap<object, PreparedState>();
const historyCertificates = new WeakMap<object, FictionMapContent>();
const changeFields = [
  'create',
  'update',
  'delete',
  'featureOrder',
  'layers',
  'namedViews',
  'coordinateSpace',
  'precision',
] as const;

/** Base snapshots come from admission/commit/history results, not a shallow readonly assertion. */
function readBase(input: FictionMapBase): FictionMapBase {
  if (
    !input ||
    typeof input !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    fail('invalid-data', '/base');
  const slots = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(input).some(
      (k) => typeof k !== 'string' || !['content', 'revision', 'changed'].includes(k),
    )
  )
    fail('invalid-data', '/base');
  for (const k of ['content', 'revision'])
    if (!slots[k] || !slots[k].enumerable || !('value' in slots[k]))
      fail('invalid-data', '/base/' + k);
  if (
    slots.changed &&
    (!slots.changed.enumerable ||
      !('value' in slots.changed) ||
      typeof slots.changed.value !== 'boolean')
  )
    fail('invalid-data', '/base/changed');
  const content: unknown = slots.content.value;
  if (!isOwnedContent(content)) fail('invalid-data', '/base/content');
  const r = record(copyData(slots.revision.value, requestBudget), '/base/revision', [
    'kind',
    'sessionId',
    'sequence',
  ]);
  if (
    r.kind !== 'local-draft' ||
    typeof r.sessionId !== 'string' ||
    !r.sessionId ||
    !Number.isSafeInteger(r.sequence) ||
    Number(r.sequence) < 0
  )
    fail('invalid-field', '/base/revision');
  return {
    content,
    revision: deepFreeze({
      kind: 'local-draft',
      sessionId: r.sessionId,
      sequence: r.sequence as number,
    }),
  };
}
function list(input: unknown, path: string): unknown[] {
  if (!Array.isArray(input)) fail('invalid-field', path);
  return input;
}
function materialize(base: FictionMapContent, input: unknown): FictionMapContent {
  const o = record(copyData(input, requestBudget), '', [], changeFields);
  const create = Object.hasOwn(o, 'create') ? list(o.create, '/create') : [],
    update = Object.hasOwn(o, 'update') ? list(o.update, '/update') : [],
    remove = Object.hasOwn(o, 'delete') ? list(o.delete, '/delete') : [];
  const count = create.length + update.length + remove.length;
  if (count > fictionMapLimits.edits)
    fail('operation-feature-limit', '', { limit: fictionMapLimits.edits, actual: count });
  const existing = new Map(base.features.map((f) => [f.id, f])),
    used = new Set<string>(),
    created: FictionMapFeature[] = [],
    updated = new Map<string, FictionMapFeature>(),
    deleted = new Set<string>();
  const unique = (id: string, path: string) => {
    if (used.has(id)) fail('duplicate-id', path, { id });
    used.add(id);
  };
  for (const [key, items] of [
    ['create', create],
    ['update', update],
  ] as const)
    items.forEach((v, i) => {
      const p = `/${key}/${i}`,
        f = record(
          v,
          p,
          ['id', 'layerId', 'featureKind', 'geometry', 'name'],
          ['description', 'category', 'style', 'worldEntityRef'],
        );
      const id = text(f.id, p + '/id');
      unique(id, p + '/id');
      if (key === 'create') {
        if (existing.has(id)) fail('duplicate-id', p + '/id', { id });
        created.push(f as unknown as FictionMapFeature);
      } else {
        if (!existing.has(id)) fail('missing-feature', p + '/id', { id });
        updated.set(id, f as unknown as FictionMapFeature);
      }
    });
  remove.forEach((v, i) => {
    const id = text(v, '/delete/' + i);
    unique(id, '/delete/' + i);
    if (!existing.has(id)) fail('missing-feature', '/delete/' + i, { id });
    deleted.add(id);
  });
  let features = [
    ...base.features.filter((f) => !deleted.has(f.id)).map((f) => updated.get(f.id) ?? f),
    ...created,
  ];
  if (Object.hasOwn(o, 'featureOrder')) {
    const ids = list(o.featureOrder, '/featureOrder').map((v, i) => text(v, '/featureOrder/' + i)),
      map = new Map(features.map((f) => [f.id, f]));
    if (
      ids.length !== map.size ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !map.has(id))
    )
      fail('invalid-field', '/featureOrder');
    features = ids.map((id) => map.get(id)!);
  }
  return admit(
    {
      ...base,
      ...Object.fromEntries(
        ['layers', 'namedViews', 'coordinateSpace', 'precision']
          .filter((k) => Object.hasOwn(o, k))
          .map((k) => [k, o[k]]),
      ),
      features,
    },
    base,
  );
}
function seal(base: FictionMapBase, candidate: FictionMapContent): PreparedFictionMapChange {
  checkAffectedIds(
    new Set([...base.content.features.map((f) => f.id), ...candidate.features.map((f) => f.id)])
      .size,
  );
  const result = Object.freeze({}) as PreparedFictionMapChange;
  prepared.set(result, {
    base: base.content,
    canonicalBase: canonicalJson(base.content),
    revision: base.revision,
    candidate,
    policy: fictionMapLimits.policy,
    consumed: false,
    active: false,
  });
  return result;
}
export function prepareFictionMapChange(
  base: FictionMapBase,
  input: unknown,
): FictionMapResult<PreparedFictionMapChange> {
  return attempt('candidate', () => {
    const b = readBase(base);
    return seal(b, materialize(b.content, input));
  });
}
export function prepareFictionMapImport(
  base: FictionMapBase,
  input: unknown,
  options: unknown,
): FictionMapResult<PreparedFictionMapChange> {
  return attempt('candidate', () => {
    const b = readBase(base);
    return seal(b, mergeNative(b.content, input, options));
  });
}
function stateOf(value: PreparedFictionMapChange): PreparedState {
  if (!value || typeof value !== 'object') fail('invalid-data', '/prepared');
  const state = prepared.get(value);
  if (!state) fail('invalid-data', '/prepared');
  return state;
}
export function previewFictionMapChange(
  value: PreparedFictionMapChange,
): FictionMapResult<FictionMapContent> {
  return attempt('input', () => stateOf(value).candidate);
}
function permission(
  canEdit: FictionMapPermission,
  current: FictionMapContent,
  candidate: FictionMapContent,
): void {
  if (typeof canEdit !== 'function')
    throw new TypeError('FictionMap permission gate must be synchronous');
  const result: unknown = canEdit(deepFreeze(current), candidate);
  if (typeof result !== 'boolean')
    throw new TypeError('FictionMap permission gate must return boolean');
  if (!result) fail('permission-denied', '');
}
function currentBase(
  session: FictionMapSession,
  state: PreparedState,
  current: FictionMapContent,
): void {
  if (!sameLocalRevision(session.revision, state.revision)) fail('stale-revision', '/revision');
  if (canonicalJson(current) !== state.canonicalBase)
    fail('prepared-base-mismatch', '/base/content');
}
export function checkPreparedPolicy(policy: string): void {
  if (policy !== fictionMapLimits.policy) fail('prepared-policy-mismatch', '/policy');
}
function finalCheck(state: PreparedState): void {
  checkPreparedPolicy(state.policy);
  checkCapacity(state.candidate);
  checkReferences(state.candidate);
}
export function commitFictionMapChange(
  session: FictionMapSession,
  value: PreparedFictionMapChange,
  canEdit: FictionMapPermission,
): FictionMapResult<FictionMapBase & { readonly changed: boolean }> {
  return attempt('commit', () => {
    const state = stateOf(value);
    if (state.consumed || state.active) fail('prepared-consumed', '/prepared');
    state.active = true;
    try {
      const current = session.content;
      permission(canEdit, current, state.candidate);
      // A permission hook can synchronously advance this session: check after it.
      currentBase(session, state, session.content);
      finalCheck(state);
      const changed = canonicalJson(state.candidate) !== state.canonicalBase;
      if (changed) {
        session.execute(
          immutableCommand('fiction-map.change', 'Edit fiction map', (content) => {
            if (state.consumed) fail('prepared-consumed', '/prepared');
            permission(canEdit, content, state.candidate);
            currentBase(session, state, content);
            finalCheck(state);
            return state.candidate;
          }),
        );
      }
      state.consumed = true;
      return { content: state.candidate, revision: session.revision, changed };
    } finally {
      state.active = false;
    }
  });
}
/** Uses EditorSession's one history stack and synchronous pre-publication validation. */
function history(
  session: FictionMapSession,
  direction: 'undo' | 'redo',
  canEdit: FictionMapPermission,
): FictionMapResult<FictionMapBase & { readonly changed: boolean }> {
  return attempt('commit', () => {
    const revision = session.revision,
      current = deepFreeze(session.content),
      entry = session.peekHistory(direction);
    if (!entry) {
      permission(canEdit, current, current);
      if (!sameLocalRevision(session.revision, revision)) fail('stale-revision', '/revision');
      return { content: admit(current), revision: session.revision, changed: false };
    }
    let candidate = historyCertificates.get(entry);
    if (!candidate) {
      candidate = admit(entry);
      historyCertificates.set(entry, candidate);
    }
    const admitted = candidate;
    session[direction]((provided) => {
      permission(canEdit, current, admitted);
      if (!sameLocalRevision(session.revision, revision)) fail('stale-revision', '/revision');
      if (canonicalJson(provided) !== canonicalJson(admitted))
        fail('prepared-base-mismatch', '/history');
      checkPreparedPolicy(fictionMapLimits.policy);
      checkCapacity(admitted);
      checkReferences(admitted);
    });
    return { content: admitted, revision: session.revision, changed: true };
  });
}
export const undoFictionMap = (session: FictionMapSession, canEdit: FictionMapPermission) =>
  history(session, 'undo', canEdit);
export const redoFictionMap = (session: FictionMapSession, canEdit: FictionMapPermission) =>
  history(session, 'redo', canEdit);
