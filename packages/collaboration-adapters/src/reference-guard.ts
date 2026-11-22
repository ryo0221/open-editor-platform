import {
  containsEmbeddedReference,
  containsLiveReference,
} from '@editor-platform/artifact-references';
import { fail } from '@editor-platform/collaboration-core';

export const containsSharedReference = (value: unknown, supportsLiveReferences = true) =>
  (supportsLiveReferences && containsLiveReference(value)) || containsEmbeddedReference(value);

export function assertNoSharedReference(value: unknown, supportsLiveReferences = true) {
  if (containsSharedReference(value, supportsLiveReferences))
    fail('invalid-operation', '参照埋め込みの共有編集は未対応です。ローカルで編集してください。');
}
