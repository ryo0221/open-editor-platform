// The Playground's office Surfaces, in the order of kinds/office.ts. Nothing here imports an
// engineering package (scripts/check-area-boundaries.mjs); the Host connections that need
// engineering code arrive as arguments from kinds/surfaces.ts.
import type { GeometryQuantitySources } from '@editor-platform/calculation-core';
import { analysisSurface } from './analysis';
import { animationSurface } from './animation';
import { dataSurface } from './data';
import { designSurface } from './design';
import { documentSurface } from './document';
import { estimateSurface } from './estimate';
import { fictionMapSurface } from './fiction-map';
import { fileSurface } from './file';
import { geoSurface } from './geo';
import { mindmapSurface } from './mindmap';
import { graphSurface } from './structured-graph';
import { reactUiSurface } from './react-ui';
import { reviewSurface } from './review';
import { scheduleSurface } from './schedule';
import { slideSurface } from './slide';
import { whiteboardSurface } from './whiteboard';

export interface OfficeConnections {
  /** CAD/BIM quantity reading for Estimate; without it Estimate shows no quantity panels. */
  estimateGeometry?: GeometryQuantitySources;
}

export function officeSurfaces({ estimateGeometry }: OfficeConnections) {
  return [
    estimateSurface(estimateGeometry),
    analysisSurface,
    animationSurface,
    fictionMapSurface,
    geoSurface,
    graphSurface,
    reactUiSurface,
    documentSurface,
    dataSurface,
    reviewSurface,
    fileSurface,
    whiteboardSurface,
    mindmapSurface,
    designSurface,
    slideSurface,
    scheduleSurface,
  ];
}
