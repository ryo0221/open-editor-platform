import type { Artifact } from '@editor-platform/artifact-core';
import type { AnimationHostContent } from '@editor-platform/animation-core/v2';
import type { SharedEditorSession } from '@editor-platform/collaboration-adapters';
import type { GeoDocument } from '@editor-platform/geo-core';
import type { ReactUiDocument } from '@editor-platform/react-ui-core';
import { isGraphDocument, type GraphDocument } from '@editor-platform/structured-graph';
import { TemplateCatalog, builtinCatalog, LocalCatalog } from '@editor-platform/templates';
import { validContent, type Content, type StoredArtifact } from '../model';

/** Content kinds that templates and native reusable definitions can adapt. */
export type NativeContent = Exclude<
  Content,
  ReactUiDocument | GraphDocument | GeoDocument | AnimationHostContent
>;
export function nativeContent(content: Content): NativeContent {
  if (validContent('animation', content))
    throw new Error('Animation has no template/reuse adapter');
  if (validContent('geo', content)) throw new Error('Geo has no template/reuse adapter');
  if (isGraphDocument(content)) throw new Error('Graph has no template/reuse adapter');
  if (validContent('react-ui', content))
    throw new Error('React UI uses its Host registrations, not native reusable definitions');
  return content as NativeContent;
}
export function nativeShared(
  session: SharedEditorSession<Content> | undefined,
): SharedEditorSession<NativeContent> | undefined {
  if (session && String(session.codec.domain) === 'react-ui')
    throw new Error('React UI uses its own domain operations');
  return session as SharedEditorSession<NativeContent> | undefined;
}
export function nativeRecord(record: StoredArtifact): Artifact<NativeContent> {
  nativeContent(record.draft.content);
  return record as Artifact<NativeContent>;
}
export const personalTemplates = new LocalCatalog();
export const templateCatalog = new TemplateCatalog([builtinCatalog(), personalTemplates]);
