import {
  copy,
  canonical,
  fail,
  type Action,
  type DomainCodec,
  type Effect,
} from '@editor-platform/collaboration-core';
import {
  validateReuseStateSync,
  validateClosureSync,
  stableId,
  type ReuseInstance,
  type ReuseState,
} from '@editor-platform/reuse-core';

type Carrier = { reuse?: ReuseState };
/** Consecutive adopted instances already retain an identical preceding closure.
 * Compare the full payload, not only its claimed hash; reset at every other action.
 * This also compacts selective inverses while each stored inverse stays self-contained. */
function compactReuseDefinitions(actions: Action[]): Action[] {
  let previous: { hash: string; json: string; value: object } | undefined;
  return actions.map((action) => {
    const value = action.payload.value as ReuseInstance | null | undefined;
    const closure = action.payload.closure as { hash?: string } | undefined;
    if (
      action.type !== 'reuse.instance' ||
      !value ||
      !closure ||
      closure.hash !== value.closureHash
    ) {
      previous = undefined;
      return action;
    }
    const json = previous?.value === closure ? previous.json : canonical(closure),
      identical = previous?.hash === closure.hash && previous.json === json;
    previous = { hash: closure.hash, json, value: closure };
    if (!identical) return action;
    const payload = { ...action.payload };
    delete payload.closure;
    return { ...action, payload };
  });
}
export const reuseInstanceKey = (id: string) => 'reuse/instance/' + encodeURIComponent(id);
/** Retained definitions and instance ownership use the same authority/history as native edits. */
export function withNativeReuse<T extends Carrier>(codec: DomainCodec<T>): DomainCodec<T> {
  const resource = (content: T, key: string) =>
    key === 'reuse'
      ? content.reuse
      : key === 'reuse/mode'
        ? content.reuse?.artifactMode
        : key === 'reuse/instances'
          ? (content.reuse?.instances.map((i) => i.id) ?? [])
          : key.startsWith('reuse/instance/')
            ? content.reuse?.instances.find(
                (i) => i.id === decodeURIComponent(key.slice('reuse/instance/'.length)),
              )
            : codec.resource(content, key);
  const applyReuse = (content: T, action: Action): Effect<T> => {
    if (action.type === 'reuse.mode') {
      const mode = action.payload.value;
      if (mode !== null && !stableId(mode))
        fail('invalid-operation', 'Invalid artifact token mode');
      const reuse: ReuseState = {
        ...(content.reuse ?? { schemaVersion: 1, instances: [], closures: [] }),
      };
      if (mode === null) delete reuse.artifactMode;
      else reuse.artifactMode = mode as string;
      const next = { ...content };
      if (reuse.instances.length || reuse.artifactMode) next.reuse = validateReuseStateSync(reuse);
      else delete next.reuse;
      return {
        content: next,
        required: ['reuse/mode'],
        touched: ['reuse/mode'],
        targets: ['*'],
        inverse: [
          {
            type: 'reuse.mode',
            target: '*',
            payload: { value: content.reuse?.artifactMode ?? null },
          },
        ],
      };
    }
    if (action.type === 'reuse.restore') {
      const next = { ...content },
        reuse = validateReuseStateSync(action.payload.value ?? undefined);
      if (reuse) next.reuse = reuse;
      else delete next.reuse;
      return {
        content: next,
        required: ['*'],
        touched: ['*', 'reuse'],
        targets: ['*'],
        inverse: [
          { type: 'reuse.restore', target: '*', payload: { value: content.reuse ?? null } },
        ],
      };
    }
    const id = action.target;
    const previous = content.reuse?.instances.find((i) => i.id === id);
    const value = action.payload.value as ReuseInstance | null;
    if (value !== null && (!value || value.id !== id || value.ref?.domain !== codec.domain))
      fail('invalid-operation', 'Reusable instance identity/domain mismatch');
    if (!value && !previous) fail('target-deleted', 'Reusable instance is missing');
    const closure =
      action.payload.closure === undefined
        ? undefined
        : validateClosureSync(action.payload.closure);
    const closures = new Map((content.reuse?.closures ?? []).map((c) => [c.hash, c]));
    if (closure) closures.set(closure.hash, closure);
    const oldClosure = previous && closures.get(previous.closureHash);
    const instances = (content.reuse?.instances ?? []).flatMap((i) =>
      i.id === id ? (value ? [copy(value)] : []) : [i],
    );
    if (value && !previous) instances.push(copy(value));
    const used = new Set(instances.map((i) => i.closureHash));
    const reuse = validateReuseStateSync({
      schemaVersion: 1,
      ...(content.reuse?.artifactMode ? { artifactMode: content.reuse.artifactMode } : {}),
      instances,
      closures: [...closures.values()].filter((c) => used.has(c.hash)),
    });
    const next = { ...content };
    if (instances.length || reuse?.artifactMode) next.reuse = reuse;
    else delete next.reuse;
    const targets =
      codec.domain === 'document'
        ? ['text']
        : [
            ...new Set(
              [previous, value].flatMap((i) =>
                i
                  ? Object.values(i.parts).map((address) =>
                      codec.domain === 'design' ? address.split('/')[0] : address,
                    )
                  : [],
              ),
            ),
          ];
    if (!targets.length) fail('invalid-operation', 'Reusable instance must address native parts');
    return {
      content: next,
      required: [reuseInstanceKey(id)],
      touched: [reuseInstanceKey(id), ...(!previous || !value ? ['reuse/instances'] : [])],
      targets,
      inverse: [
        {
          type: 'reuse.instance',
          target: id,
          payload: { value: previous ?? null, ...(oldClosure ? { closure: oldClosure } : {}) },
        },
      ],
    };
  };
  const apply = (
    content: T,
    action: Action,
    version: number,
    textVersions?: Record<string, number>,
    readonly = false,
  ) => {
    if (['reuse.instance', 'reuse.restore', 'reuse.mode'].includes(action.type))
      return applyReuse(content, action);
    const native = content.reuse
      ? { ...content, reuse: validateReuseStateSync(content.reuse) }
      : content;
    const result = readonly
      ? codec.applyReadonly!(native, action, version, textVersions)
      : codec.apply(native, action, version, textVersions);
    if (action.type === 'domain.restore' && codec.domain === 'document') {
      const restored = action.payload.content as T;
      result.content = { ...result.content };
      if (restored.reuse) result.content.reuse = copy(restored.reuse);
      else delete result.content.reuse;
      result.inverse.push({
        type: 'reuse.restore',
        target: '*',
        payload: { value: content.reuse ?? null },
      });
    }
    if (result.content.reuse)
      result.content = { ...result.content, reuse: validateReuseStateSync(result.content.reuse) };
    return result;
  };
  return {
    ...codec,
    ...(codec.rebaseInverse
      ? {
          rebaseInverse: ((event, later, current) => {
            const metadata = event.inverse.filter((a) => a.type === 'reuse.instance');
            if (!metadata.length) return codec.rebaseInverse!(event, later, current);
            // Keep native text rebasing in its existing engine. Metadata has
            // separate ownership and must never bypass another actor's edits.
            for (const key of event.touched.filter((k) => k.startsWith('reuse/'))) {
              const active = new Map<string, (typeof later)[number]>();
              for (const next of later.filter((e) => e.touched.includes(key))) {
                const own =
                  next.operation.actorId === event.operation.actorId &&
                  next.operation.sessionId === event.operation.sessionId;
                if (own && next.operation.undoOf && active.has(next.operation.undoOf))
                  active.delete(next.operation.undoOf);
                else active.set(next.operation.operationId, next);
              }
              if (active.size)
                fail('undo-conflict', 'A later edit owns the reusable structure', [key]);
            }
            const native = event.inverse.filter((a) => a.type !== 'reuse.instance');
            const rebased = codec.rebaseInverse!(
              {
                ...event,
                inverse: native,
                touched: event.touched.filter((k) => !k.startsWith('reuse/')),
              },
              later,
              current,
            );
            return [...metadata, ...rebased];
          }) as NonNullable<DomainCodec<T>['rebaseInverse']>,
        }
      : {}),
    encodeActions: (actions) => compactReuseDefinitions(codec.encodeActions?.(actions) ?? actions),
    resource,
    resources: (content, keys) => {
      // Preserve the native codec's batched indexes for ordinary operations.
      const isReuse = (key: string) =>
        key === 'reuse' ||
        key === 'reuse/mode' ||
        key === 'reuse/instances' ||
        key.startsWith('reuse/instance/');
      const native = keys.filter((k) => !isReuse(k));
      const values =
        codec.resources?.(content, native) ?? native.map((k) => codec.resource(content, k));
      let index = 0;
      return keys.map((key) => (isReuse(key) ? resource(content, key) : values[index++]));
    },
    apply,
    ...(codec.applyReadonly
      ? {
          applyReadonly: (
            content: T,
            action: Action,
            version: number,
            textVersions?: Record<string, number>,
          ) => apply(content, action, version, textVersions, true),
        }
      : {}),
  };
}
