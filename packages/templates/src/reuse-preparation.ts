import {
  canonical,
  preparedResult,
  type Operation,
  type PreparedOperation,
} from '@editor-platform/collaboration-core';
import type { PreparedApplication } from './apply';
import { clone, deepFreeze, isDeepFrozen } from '@editor-platform/artifact-core';
import { problem, type NativeContent } from './types';

// Keep the existing checked preparation behind its exact, privately produced
// operation. Component results may add fields by spreading the application;
// the operation identity and complete serialized bytes still have to match.
const preparations = new WeakMap<
  Operation,
  { handle: PreparedOperation<NativeContent>; signature: string }
>();
/** Internal staging retains owned immutable native trees. Public entry points
 * materialize their editable preview/base before their promise resolves. */
export function retainedApplicationContent(
  handle: PreparedOperation<NativeContent>,
  basis: NativeContent,
) {
  return {
    preview: preparedResult(handle, { immutableContent: true }).content,
    base: isDeepFrozen(basis) ? basis : deepFreeze(clone(basis)),
  };
}
export function exposeApplicationContent(application: PreparedApplication): PreparedApplication {
  application.preview = clone(application.preview);
  application.base = clone(application.base);
  return application;
}
export function retainApplicationPreparation(
  application: PreparedApplication,
  handle: PreparedOperation<NativeContent>,
) {
  preparations.set(application.operation, {
    handle,
    signature: canonical(application.operation),
  });
}
/** Internal recursive staging only; this snapshot grants no authority receipt. */
export function applicationSnapshot(application: PreparedApplication) {
  const preparation = preparations.get(application.operation);
  if (!preparation || preparation.signature !== canonical(application.operation))
    problem('preparation-changed', 'The prepared native operation changed');
  return preparedResult(preparation.handle, { immutableContent: true });
}
