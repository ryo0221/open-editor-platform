// Every Surface this Artifact Host shows, paired with the same definition objects as the adapter
// list (kinds/index.ts). Estimate's CAD/BIM reading is the engineering connection made here.
import { pairKinds } from '@editor-platform/artifact-kinds';
import { artifactEstimateGeometry } from '../estimate-bim';
import { engineeringSurfaces } from './engineering/surfaces';
import { hostDefinitions } from './index';
import { officeSurfaces } from './office/surfaces';
import type { ArtifactSurfaceEntry } from './surface-kind';

const surfaces = pairKinds(
  hostDefinitions,
  [...officeSurfaces({ estimateGeometry: artifactEstimateGeometry }), ...engineeringSurfaces],
  'Host Surface',
);

/** The Surface entry of a kind this Host opens. */
export const surfaceFor = (kind: string): ArtifactSurfaceEntry | undefined => surfaces.get(kind);
