// The Playground's office kinds, in the order the Playground lists them. Each shared definition
// comes from its package's `./kind`; only Host data (templates, time zone) is supplied here.
import { registerKind } from '@editor-platform/artifact-kinds';
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

export const officeKinds = [
  registerKind(estimateKind),
  registerKind(analysisKind),
  registerKind(animationKind),
  registerKind(fictionMapKind),
  registerKind(geoKind),
  registerKind(
    structuredGraphKind({
      create: (template = 'relations') => graphTemplates.find((t) => t.id === template)!.create(),
      profileFor: graphProfileFor,
    }),
  ),
  registerKind(reactUiKind(() => createReferenceDocument())),
  registerKind(documentKind),
  registerKind(dataKind),
  registerKind(reviewKind),
  registerKind(fileKind),
  registerKind(whiteboardKind),
  registerKind(designKind),
  registerKind(slideKind),
  registerKind(scheduleKind(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')),
];
