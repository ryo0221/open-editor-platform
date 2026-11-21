// The Artifact Host's native content: the shared kinds it hosts and its own Code kind.
import type { FictionMapContent } from '@editor-platform/fiction-map/model';
import type { EstimateDocument } from '@editor-platform/estimate-core';
import type { AnalysisDocument } from '@editor-platform/analysis-core';
import { command, type EditorCommand } from '@editor-platform/editor-core';
import { isDeck, hasSlideAnimations, type SlideContent } from '@editor-platform/slide/model';
import type { WhiteboardContent } from '@editor-platform/whiteboard/model';
import type { DesignContent } from '@editor-platform/design/model';
import type { StructuredData } from '@editor-platform/structured-data/model';
import type { CadDocument } from '@editor-platform/cad-core';
import type { BimDocument } from '@editor-platform/bim-core';
import { sealReactEnvironment, type ReactRuntimeResolution } from '@editor-platform/react-ui-core';

export interface CodeContent {
  schemaVersion: 1;
  domain: 'host-code';
  fileId: string;
  filename: string;
  source: string;
}
export type HostContent =
  | FictionMapContent
  | EstimateDocument
  | AnalysisDocument
  | SlideContent
  | WhiteboardContent
  | DesignContent
  | StructuredData
  | CodeContent
  | CadDocument
  | BimDocument;
export const isCode = (v: unknown): v is CodeContent => {
  if (!v || typeof v !== 'object') return false;
  const c = v as Partial<CodeContent>;
  return (
    c.schemaVersion === 1 &&
    c.domain === 'host-code' &&
    typeof c.fileId === 'string' &&
    /^[\w-]{1,128}$/.test(c.fileId) &&
    typeof c.filename === 'string' &&
    /^[\w-]+\.tsx$/.test(c.filename) &&
    typeof c.source === 'string' &&
    c.source.length <= 150000
  );
};
export function codeSource(source: string): EditorCommand<CodeContent> {
  return command('host-code.source', 'Edit TSX source', (c) => ({ ...c, source }), {
    origin: 'local',
    transactionId: crypto.randomUUID(),
    mergeKey: 'host-code.source',
  });
}
export const nativeEnvironment = sealReactEnvironment({
  schemaVersion: 1,
  ref: { id: 'artifact-host', version: '1.0.0' },
  reactVersion: '19.1.1',
  dependencies: [],
  providerOrder: [],
  stylePolicy: 'allow-literals',
  tokenVariables: {},
});
export const nativeResolution: ReactRuntimeResolution = {
  environment: nativeEnvironment.ref,
  components: [],
  dependencies: [],
};
/** This reference Host provides static SVG export and saved-page previews. */
export const isStaticSlide = (value: unknown): value is SlideContent =>
  isDeck(value) && !hasSlideAnimations(value);
