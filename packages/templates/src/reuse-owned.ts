import { clone, isDeepFrozen } from '@editor-platform/artifact-core';
import { validateReuseStateSync } from '@editor-platform/reuse-core';
import type { Snapshot } from '@editor-platform/collaboration-core';
import type { NativeContent } from './types';

/** Async preparation owns caller input. Retain its validated metadata as one
 * immutable tree while native properties are staged; native guards can safely
 * reuse that validation without trusting a mutable or shallow-frozen caller. */
export function ownReuseOptions<T extends { state: Snapshot<NativeContent> }>(input: T): T {
  const source = input.state.content;
  const reuse =
    'reuse' in source && source.reuse ? validateReuseStateSync(source.reuse) : undefined;
  // Immutable definitions are owned already; preserving their identity allows
  // subsequent validation to reuse its certified result. Exclude these retained
  // trees before cloning, rather than cloning and immediately discarding them.
  const parameters = input as T & Partial<Record<'definition' | 'closure', unknown>>;
  const retained: Partial<Record<'definition' | 'closure', unknown>> = {};
  for (const key of ['definition', 'closure'] as const)
    if (key in parameters && isDeepFrozen(parameters[key])) retained[key] = parameters[key];
  const basis = { ...input };
  for (const key of Object.keys(retained)) delete (basis as Record<string, unknown>)[key];
  const immutable = isDeepFrozen(source);
  if (immutable) basis.state = { ...input.state, content: undefined as never };
  else if (reuse) basis.state = { ...input.state, content: { ...source, reuse: undefined } };
  const options = clone(basis);
  // Native preparation reads this basis; all writes use cloneReuseNative or the
  // codec's private evaluation. Preserve only certified immutable native trees.
  if (immutable) options.state.content = source;
  else if (reuse && 'reuse' in options.state.content) options.state.content.reuse = reuse;
  Object.assign(options, retained);
  return options;
}

/** The editable native graph is owned; unchanged metadata remains immutable. */
export function cloneReuseNative<T extends NativeContent>(content: T): T {
  const reuse =
    'reuse' in content && content.reuse ? validateReuseStateSync(content.reuse) : undefined;
  const next = clone(reuse ? { ...content, reuse: undefined } : content);
  if (reuse && 'reuse' in next) next.reuse = reuse;
  return next;
}
