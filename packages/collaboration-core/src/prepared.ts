import { deepFreeze, isDeepFrozen } from '@editor-platform/artifact-core';
import { copy, fail, type DomainCodec, type Operation, type Snapshot } from './contracts';
import { sameContent } from './immutable-content';

declare const preparation: unique symbol;
/** Opaque, immutable operation prepared against one point-in-time snapshot. */
export interface PreparedOperation<T> {
  readonly operation: Operation;
  readonly [preparation]: T;
}
interface Projection<T> {
  codec: DomainCodec<T>;
  methods: unknown[];
  basis: Snapshot<T>;
  result: Snapshot<T>;
  reusable: boolean;
}
const projections = new WeakMap<object, Projection<unknown>>();
const methods = <T>(codec: DomainCodec<T>) => [
  codec.apply,
  codec.applyReadonly,
  codec.validate,
  codec.mapAnchor,
  codec.encode,
  codec.encodeActions,
  codec.resource,
  codec.resources,
];
/** Isolated read of a completed preparation for previews. This grants no authority receipt. */
export function preparedResult<T>(
  handle: PreparedOperation<T>,
  options?: { immutableContent?: boolean },
): Snapshot<T> {
  const stored = projections.get(handle) as Projection<T> | undefined;
  if (!stored) fail('invalid-operation', 'Unknown prepared operation');
  return options?.immutableContent
    ? { ...copy({ ...stored.result, content: undefined }), content: stored.result.content }
    : copy(stored.result);
}

export function retainPreparation<T>(
  codec: DomainCodec<T>,
  source: Snapshot<T>,
  result: Snapshot<T>,
  operation: Operation,
): PreparedOperation<T> {
  const reusable = !!codec.applyReadonly && isDeepFrozen(source.content);
  const handle = deepFreeze({ operation }) as PreparedOperation<T>;
  projections.set(handle, {
    codec,
    methods: methods(codec),
    basis: deepFreeze({
      ...copy({ ...source, content: undefined }),
      content: reusable ? source.content : undefined,
    }),
    result: deepFreeze(result),
    reusable,
  } as Projection<unknown>);
  return handle;
}

export function preparedProjection<T>(
  handle: PreparedOperation<T>,
  codec: DomainCodec<T>,
  current: Snapshot<T> | undefined,
): Snapshot<T> | undefined {
  const stored = projections.get(handle) as Projection<T> | undefined;
  if (!stored) fail('invalid-operation', 'Unknown prepared operation');
  if (
    current &&
    stored.reusable &&
    stored.codec === codec &&
    methods(codec).every((method, i) => method === stored.methods[i]) &&
    stored.basis.content === current.content &&
    sameContent({ ...stored.basis, content: undefined }, { ...current, content: undefined })
  )
    return stored.result;
}
