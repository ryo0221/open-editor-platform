import type { EstimateDocument } from '@editor-platform/estimate-core';
import type { AnalysisDocument } from '@editor-platform/analysis-core';
import type { Artifact } from '@editor-platform/artifact-core';
import type { BimDocument } from '@editor-platform/bim-core';
import type { CadDocument } from '@editor-platform/cad-core';
import type { AnimationHostContent } from '@editor-platform/animation-core/v2';
import type { SharedEditorSession } from '@editor-platform/collaboration-adapters';
import type { GeoDocument } from '@editor-platform/geo-core';
import type { ReactUiDocument } from '@editor-platform/react-ui-core';
import { isGraphDocument, type GraphDocument } from '@editor-platform/structured-graph';
import { isSchedule, type ScheduleDocument } from '@editor-platform/schedule/model';
import { TemplateCatalog, builtinCatalog, LocalCatalog } from '@editor-platform/templates';
import { validContent, type Content, type StoredArtifact } from '../model';

/** Content kinds that templates and native reusable definitions can adapt. */
export type NativeContent = Exclude<
  Content,
  | EstimateDocument
  | AnalysisDocument
  | ReactUiDocument
  | GraphDocument
  | GeoDocument
  | AnimationHostContent
  | ScheduleDocument
  | CadDocument
  | BimDocument
>;
export function nativeContent(content: Content): NativeContent {
  if (validContent('estimate', content)) throw Error('Estimate has no template/reuse adapter');
  if (validContent('analysis', content)) throw Error('Analysis has no template/reuse adapter');
  if (validContent('animation', content))
    throw new Error('Animation has no template/reuse adapter');
  if (validContent('geo', content)) throw new Error('Geo has no template/reuse adapter');
  if (isGraphDocument(content)) throw new Error('Graph has no template/reuse adapter');
  if (isSchedule(content)) throw new Error('Schedule has no template/reuse adapter');
  if (validContent('cad', content)) throw new Error('3D CAD has no template/reuse adapter');
  if (validContent('bim', content)) throw new Error('Building has no template/reuse adapter');
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
