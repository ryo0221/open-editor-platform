// The Playground's office kinds, in the order the Playground lists them. Each shared definition
// comes from its package's `./kind`; only Host data (templates, time zone) is supplied here.
import { registerKind, type KindDefinition } from '@editor-platform/artifact-kinds';
import { analysisKind } from '@editor-platform/analysis/kind';
import { animationKind } from '@editor-platform/animation/kind';
import { designKind } from '@editor-platform/design/kind';
import { documentKind } from '@editor-platform/document/kind';
import { estimateKind } from '@editor-platform/estimate/kind';
import { fictionMapKind } from '@editor-platform/fiction-map/kind';
import { geoKind } from '@editor-platform/geo-inspector/kind';
import { reactUiKind } from '@editor-platform/react-ui/kind';
import { fileKind, reviewKind } from '@editor-platform/review-surfaces/kind';
import { scheduleKind } from '@editor-platform/schedule/kind';
import { slideKind } from '@editor-platform/slide/kind';
import { dataKind } from '@editor-platform/structured-data/kind';
import { structuredGraphKind } from '@editor-platform/structured-graph/kind';
import { whiteboardKind } from '@editor-platform/whiteboard/kind';
import { createReferenceDocument } from '../../../react-ui-reference/src/catalog';
import { graphProfileFor, graphTemplates } from '../app/graph-templates';

/** The kinds built from Host data; kinds/office/*.tsx pairs these same objects with Surfaces. */
export const graphDefinition = structuredGraphKind({
  create: (template = 'relations') => graphTemplates.find((t) => t.id === template)!.create(),
  profileFor: graphProfileFor,
});
export const reactUiDefinition = reactUiKind(() => createReferenceDocument());
export const scheduleDefinition = scheduleKind(
  () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
);

/** The typed definitions, in list order (kinds/surfaces.ts checks each has one Surface). */
export const officeDefinitions: readonly KindDefinition<unknown>[] = [
  estimateKind,
  analysisKind,
  animationKind,
  fictionMapKind,
  geoKind,
  graphDefinition,
  reactUiDefinition,
  documentKind,
  dataKind,
  reviewKind,
  fileKind,
  whiteboardKind,
  designKind,
  slideKind,
  scheduleDefinition,
];

export const officeKinds = officeDefinitions.map((definition) => registerKind(definition));
