import { deepFreeze, isDeepFrozen } from '@editor-platform/artifact-core';
import { retainPreparation, type PreparedOperation } from './prepared';
export type { PreparedOperation } from './prepared';
export { preparedResult } from './prepared';
import {
  canonical,
  fingerprint,
  copy,
  fail,
  uid,
  type Action,
  type Anchor,
  type Condition,
  type DomainCodec,
  type Identity,
  type Operation,
  type Origin,
  type Snapshot,
  type Thread,
} from './contracts';
export function resource<T>(codec: DomainCodec<T>, state: Snapshot<T>, key: string): unknown {
  if (key === '*') return { content: state.content, threads: state.threads };
  if (key.startsWith('thread:')) {
    const [, id, field, replyId] = key.split(':');
    const thread = state.threads.find((t) => t.id === id);
    return field === 'reply'
      ? thread?.replies.find((r) => r.id === replyId)
      : field === 'resolved'
        ? thread?.resolved
        : field === 'anchor'
          ? thread?.anchor
          : thread;
  }
  return codec.resource(state.content, key);
}
/** Whole resources include their descendants' history; sibling fields remain independent. */
export function resourceRevision<T>(state: Snapshot<T>, key: string): number {
  let revision = Math.max(state.stamps[key] ?? 0, state.stamps.structure ?? 0);
  for (const [changed, stamp] of Object.entries(state.stamps))
    if (
      changed.startsWith(`${key}/`) ||
      changed.startsWith(`${key}:`) ||
      (changed.startsWith('entity:') && key.startsWith(`${changed}/`))
    )
      revision = Math.max(revision, stamp);
  return revision;
}
export function condition<T>(codec: DomainCodec<T>, state: Snapshot<T>, key: string): Condition {
  return {
    key,
    stamp: resourceRevision(state, key),
    fingerprint: fingerprint(resource(codec, state, key)),
  };
}
/** Batch a single immutable precondition read without repeatedly scanning every stamp.
 * The index lasts only for this call; mutable caller snapshots never leave a stale cache.
 */
export function conditions<T>(
  codec: DomainCodec<T>,
  state: Snapshot<T>,
  keys: readonly string[],
): Condition[] {
  const revisions = resourceRevisions(state, keys);
  const domainKeys = keys.filter((key) => key !== '*' && !key.startsWith('thread:'));
  const domainValues = codec.resources?.(state.content, domainKeys);
  const values = domainValues
    ? new Map(domainKeys.map((key, i) => [key, domainValues[i]]))
    : undefined;
  return keys.map((key, index) => ({
    key,
    stamp: revisions[index],
    fingerprint: fingerprint(values?.has(key) ? values.get(key) : resource(codec, state, key)),
  }));
}
/** Batch the same ownership stamps used by resourceRevision, without retaining mutable state. */
export function resourceRevisions<T>(state: Snapshot<T>, keys: readonly string[]): number[] {
  if (!keys.length) return [];
  const descendants = new Map<string, number>();
  const requested = new Set(keys);
  for (const [changed, stamp] of Object.entries(state.stamps))
    for (const separator of ['/', ':'])
      for (let i = changed.indexOf(separator); i >= 0; i = changed.indexOf(separator, i + 1)) {
        const prefix = changed.slice(0, i);
        if (requested.has(prefix))
          descendants.set(prefix, Math.max(descendants.get(prefix) ?? 0, stamp));
      }
  return keys.map((key) => {
    let stamp = Math.max(
      state.stamps[key] ?? 0,
      state.stamps.structure ?? 0,
      descendants.get(key) ?? 0,
    );
    if (key.startsWith('entity:'))
      for (let i = key.indexOf('/'); i >= 0; i = key.indexOf('/', i + 1))
        stamp = Math.max(stamp, state.stamps[key.slice(0, i)] ?? 0);
    return stamp;
  });
}
/** Restores retain stable references and explicitly orphan targets absent from the new content. */
export function mapAnchor<T>(
  codec: DomainCodec<T>,
  anchor: Anchor,
  before: T,
  action: Action,
  after: T,
): Anchor {
  const mapped = codec.mapAnchor?.(anchor, before, action) ?? anchor;
  return action.type === 'domain.restore' && !mapped.orphan && !codec.validateAnchor(after, mapped)
    ? { ...mapped, orphan: true }
    : mapped;
}
export function checkConditions<T>(
  codec: DomainCodec<T>,
  state: Snapshot<T>,
  values: Condition[],
): void {
  const actual = conditions(
    codec,
    state,
    values.map((c) => c.key),
  );
  const bad = values.filter((c, i) => canonical(actual[i]) !== canonical(c)).map((c) => c.key);
  if (bad.length)
    fail('stale-precondition', 'A read or write dependency changed; review again', bad);
}
export function evaluate<T>(
  codec: DomainCodec<T>,
  source: Snapshot<T>,
  actions: Action[],
  actorId: string,
  options?: { immutableContent?: boolean },
) {
  const readonly = !!options?.immutableContent && !!codec.applyReadonly;
  // Opt-in clients may share frozen content, but even a shallow-frozen external
  // input must be copied before becoming an owned immutable snapshot.
  const basis =
    readonly && !isDeepFrozen(source.content)
      ? { ...source, content: deepFreeze(copy(source.content)) }
      : source;
  const result = evaluateActions(codec, basis, actions, actorId, readonly);
  if (options?.immutableContent) deepFreeze(result.state.content);
  return result;
}
/** Rebase inverse engine versions in action order on one private evaluation.
 * Native attributes may advance those versions too. The final operation still
 * goes through independent preparation, authorization and commit validation. */
export function prepareInverseActions<T>(
  codec: DomainCodec<T>,
  source: Snapshot<T>,
  actions: Action[],
  actorId: string,
): Action[] {
  const normalized: Action[] = [];
  const normalize = (action: Action, state: Snapshot<T>): Action => {
    const next =
      action.type === 'document.steps'
        ? { ...action, payload: { ...action.payload, version: state.engineVersion } }
        : action.type === 'canvas.text-steps'
          ? {
              ...action,
              payload: { ...action.payload, version: state.textVersions?.[action.target] ?? 0 },
            }
          : action;
    normalized.push(next);
    return next;
  };
  if (actions.some((a, i) => i > 0 && ['document.steps', 'canvas.text-steps'].includes(a.type)))
    evaluateActions(codec, source, actions, actorId, !!codec.applyReadonly, normalize);
  else actions.forEach((action) => normalize(action, source));
  return normalized;
}
function evaluateActions<T>(
  codec: DomainCodec<T>,
  source: Snapshot<T>,
  actions: Action[],
  actorId: string,
  readonlyContent: boolean,
  normalize?: (action: Action, state: Snapshot<T>) => Action,
) {
  const state = readonlyContent
      ? { ...copy({ ...source, content: undefined }), content: source.content }
      : copy(source),
    required = new Set<string>(),
    touched = new Set<string>(),
    invalidates = new Set<string>(),
    targets = new Set<string>();
  let inverse: Action[] = [];
  const engineSteps: unknown[] = [];
  for (const input of actions) {
    const action = normalize ? normalize(input, state) : input;
    if (action.type.startsWith('thread.')) {
      if (!action.target || action.target.includes(':'))
        fail('schema-mismatch', 'Invalid thread ID');
      const key = `thread:${action.target}`;
      const thread = state.threads.find((t) => t.id === action.target);
      const p = action.payload;
      targets.add(action.target);
      if (action.type === 'thread.create') {
        if (thread) fail('stale-precondition', 'Thread already exists');
        const anchor = p.anchor as Anchor;
        if (!anchor || !codec.validateAnchor(state.content, anchor))
          fail('invalid-operation', 'Invalid annotation anchor');
        if (
          p.color !== undefined &&
          (typeof p.color !== 'string' || !/^#[a-f0-9]{6}(?:[a-f0-9]{2})?$/i.test(p.color))
        )
          fail('invalid-operation', 'Invalid annotation color');
        required.add(key);
        touched.add(key);
        state.threads.push({
          id: action.target,
          anchor: copy(anchor),
          ...(typeof p.color === 'string' ? { color: p.color } : {}),
          resolved: false,
          ...(typeof p.createdAt === 'string' ? { createdAt: p.createdAt } : {}),
          replies: [],
        });
        inverse.unshift({ type: 'thread.remove', target: action.target, payload: {} });
      } else {
        if (!thread) fail('target-deleted', 'Thread is missing');
        if (action.type === 'thread.reply') {
          if (
            typeof p.id !== 'string' ||
            p.id.includes(':') ||
            typeof p.text !== 'string' ||
            p.text.length > 20000
          )
            fail('invalid-operation', 'Invalid reply');
          const k = `${key}:reply:${p.id}`;
          if (thread.replies.some((r) => r.id === p.id))
            fail('stale-precondition', 'Reply already exists');
          required.add(k);
          touched.add(k);
          touched.add(key);
          thread.replies.push({
            id: p.id,
            actorId,
            text: p.text,
            ...(typeof p.createdAt === 'string' ? { createdAt: p.createdAt } : {}),
          });
          inverse.unshift({
            type: 'thread.remove-reply',
            target: action.target,
            payload: { id: p.id },
          });
        } else if (action.type === 'thread.remove-reply') {
          const reply = thread.replies.find((r) => r.id === p.id);
          if (!reply) fail('target-deleted', 'Reply missing');
          const k = `${key}:reply:${p.id}`;
          required.add(k);
          touched.add(k);
          touched.add(key);
          thread.replies = thread.replies.filter((r) => r.id !== p.id);
          inverse.unshift({
            type: 'thread.reply',
            target: action.target,
            payload: {
              id: reply.id,
              text: reply.text,
              ...(reply.createdAt ? { createdAt: reply.createdAt } : {}),
            },
          });
        } else if (action.type === 'thread.resolve' || action.type === 'thread.anchor') {
          const field = action.type === 'thread.resolve' ? 'resolved' : 'anchor';
          if (
            field === 'resolved'
              ? typeof p.value !== 'boolean'
              : !p.value || !codec.validateAnchor(state.content, p.value as Anchor)
          )
            fail('invalid-operation', 'Invalid annotation value');
          const k = `${key}:${field}`;
          required.add(k);
          touched.add(k);
          touched.add(key);
          inverse.unshift({
            type: action.type,
            target: action.target,
            payload: { value: copy(thread[field]) },
          });
          if (field === 'resolved') thread.resolved = p.value as boolean;
          else thread.anchor = copy(p.value as Anchor);
        } else if (action.type === 'thread.remove') {
          if (thread.replies.length || thread.resolved)
            fail('unsupported-operation', 'Remove replies and reopen before removing a thread');
          required.add(key);
          touched.add(key);
          inverse.unshift(
            {
              type: 'thread.create',
              target: thread.id,
              payload: {
                anchor: thread.anchor,
                ...(thread.color ? { color: thread.color } : {}),
                ...(thread.createdAt ? { createdAt: thread.createdAt } : {}),
              },
            },
            ...thread.replies.map((r) => ({
              type: 'thread.reply',
              target: thread.id,
              payload: { id: r.id, text: r.text },
            })),
          );
          state.threads = state.threads.filter((t) => t.id !== thread.id);
        } else fail('unsupported-operation', 'Unsupported annotation operation');
      }
    } else {
      const before = state.content;
      // state is already a private copy. Preserve a second before-image only when
      // annotations need it for mapping; codec inverse construction owns its own basis.
      const apply = readonlyContent ? codec.applyReadonly! : codec.apply;
      const effect = apply.call(
        codec,
        state.threads.length && !readonlyContent ? copy(before) : before,
        action,
        state.engineVersion,
        state.textVersions,
      );
      if (!codec.validate(effect.content)) fail('invalid-operation', 'Domain invariant failed');
      state.content = effect.content;
      effect.required.forEach((k) => required.add(k));
      effect.touched.forEach((k) => touched.add(k));
      effect.invalidates?.forEach((k) => invalidates.add(k));
      effect.targets.forEach((k) => targets.add(k));
      inverse = [...effect.inverse, ...inverse];
      if (effect.engineSteps) {
        engineSteps.push(...effect.engineSteps);
        state.engineVersion += effect.engineSteps.length;
      }
      if (effect.textSteps) {
        const { target, steps } = effect.textSteps;
        state.textVersions = {
          ...state.textVersions,
          [target]: (state.textVersions?.[target] ?? 0) + steps.length,
        };
      }
      state.threads = state.threads.map((t) => {
        const anchor = mapAnchor(codec, t.anchor, before, action, state.content);
        if (canonical(anchor) !== canonical(t.anchor)) {
          touched.add(`thread:${t.id}:anchor`);
          touched.add(`thread:${t.id}`);
        }
        return { ...t, anchor };
      });
    }
  }
  return {
    state,
    required: [...required],
    touched: [...touched],
    invalidates: [...invalidates],
    targets: [...targets].sort(),
    inverse,
    engineSteps,
  };
}
export function operation<T>(
  codec: DomainCodec<T>,
  state: Snapshot<T>,
  identity: Identity,
  actions: Action[],
  origin: Origin = 'human',
): Operation {
  actions = (codec.encodeActions?.(actions) ?? actions).map(
    (action) => codec.encode?.(action) ?? action,
  );
  // Preparation consumes only dependencies/targets, so a pure codec can borrow
  // source content. Public evaluate() still returns a fully isolated snapshot.
  const result = evaluateActions(codec, state, actions, identity.actorId, !!codec.applyReadonly);
  return describeOperation(codec, state, identity, actions, origin, result);
}
function describeOperation<T>(
  codec: DomainCodec<T>,
  state: Snapshot<T>,
  identity: Identity,
  actions: Action[],
  origin: Origin,
  result: { targets: string[]; required: string[] },
): Operation {
  return {
    protocol: 1,
    schema: 1,
    ...copy(identity),
    artifactId: state.artifactId,
    domain: state.domain,
    operationId: uid(),
    transactionId: uid(),
    origin,
    baseRevision: state.revision,
    targets: result.targets,
    actions: copy(actions),
    conditions: conditions(codec, state, result.required),
  };
}
/** Reuse the checked optimistic projection only on the exact immutable basis.
 * Authority submission still independently evaluates permissions and conditions.
 */
export function prepareOperation<T>(
  codec: DomainCodec<T>,
  state: Snapshot<T>,
  identity: Identity,
  actions: Action[],
  origin: Origin = 'human',
  transactionId?: string,
): PreparedOperation<T> {
  const { operation: op, result } = evaluatedOperation(
    codec,
    state,
    identity,
    actions,
    origin,
    transactionId,
  );
  return retainPreparation(codec, state, result.state, op);
}
/** Package-private builder for a checked operation and its complete evaluation.
 * External prepared handles never supply authority evaluations. */
export function evaluatedOperation<T>(
  codec: DomainCodec<T>,
  state: Snapshot<T>,
  identity: Identity,
  actions: Action[],
  origin: Origin,
  transactionId?: string,
) {
  const encoded = (codec.encodeActions?.(actions) ?? actions).map(
    (action) => codec.encode?.(action) ?? action,
  );
  const result = evaluate(codec, state, encoded, identity.actorId, { immutableContent: true });
  const op = describeOperation(codec, state, identity, encoded, origin, result);
  if (transactionId) op.transactionId = transactionId;
  return { operation: op, result };
}
export function initial<T>(
  artifactId: string,
  codec: DomainCodec<T>,
  content: T,
  threads: Thread[] = [],
): Snapshot<T> {
  if (!codec.validate(content)) fail('invalid-operation', 'Invalid initial domain content');
  if (!threads.every((t) => t.anchor.orphan || codec.validateAnchor(content, t.anchor)))
    fail('invalid-operation', 'Invalid initial annotations');
  return {
    protocol: 1,
    artifactId,
    domain: codec.domain,
    revision: 0,
    content: copy(content),
    threads: copy(threads),
    stamps: {},
    engineVersion: 0,
  };
}

export function validateSnapshot<T>(codec: DomainCodec<T>, value: Snapshot<T>) {
  if (
    !value ||
    value.protocol !== 1 ||
    value.domain !== codec.domain ||
    typeof value.artifactId !== 'string' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Number.isSafeInteger(value.engineVersion) ||
    value.engineVersion < 0 ||
    (value.textVersions !== undefined &&
      (!value.textVersions ||
        typeof value.textVersions !== 'object' ||
        Object.values(value.textVersions).some((v) => !Number.isSafeInteger(v) || v < 0))) ||
    !codec.validate(value.content) ||
    !value.stamps ||
    Object.values(value.stamps).some(
      (n) => !Number.isSafeInteger(n) || n < 0 || n > value.revision,
    ) ||
    !Array.isArray(value.threads) ||
    new Set(value.threads.map((t) => t.id)).size !== value.threads.length ||
    !value.threads.every(
      (t) =>
        typeof t.id === 'string' &&
        typeof t.resolved === 'boolean' &&
        (t.color === undefined ||
          (typeof t.color === 'string' && /^#[a-f0-9]{6}(?:[a-f0-9]{2})?$/i.test(t.color))) &&
        Array.isArray(t.replies) &&
        new Set(t.replies.map((r) => r.id)).size === t.replies.length &&
        t.replies.every(
          (r) =>
            typeof r.id === 'string' && typeof r.text === 'string' && typeof r.actorId === 'string',
        ) &&
        (t.anchor.orphan || codec.validateAnchor(value.content, t.anchor)),
    )
  )
    fail('schema-mismatch', 'Invalid collaboration snapshot');
}
