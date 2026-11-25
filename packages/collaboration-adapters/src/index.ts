import { checksOfficeNativeHistory } from '@editor-platform/collaboration-office';
import type { Domain } from '@editor-platform/collaboration-core';
import { engineeringSchemas } from './engineering-records';

export * from '@editor-platform/collaboration-office';
export * from './engineering-records';
export { nativeEditorCodecs } from './native-editor-codecs';

export function checksSharedNativeHistory(domain: Domain): boolean {
  return checksOfficeNativeHistory(domain) || Object.hasOwn(engineeringSchemas, domain);
}
