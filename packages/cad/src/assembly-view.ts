/**
 * Placed parts in the viewport (docs/cad/r2b-assembly.md, Instancing), drawn by the domain-free
 * instancing of `geometry-view` (R2c-3b): every instance of one version shares one set of
 * buffers; a connector is picked on the version's own mesh (`userData.mesh`) at the instance's
 * frame (`userData.frames`).
 */
import type { CadMesh } from '@editor-platform/cad-kernel-occt';
import type { ViewInstance, ViewSolid } from '@editor-platform/geometry-view';

export {
  disposeInstances as disposeParts,
  instancePath as partPath,
  instancesBytes as partsBytes,
  instancesGroup as partsGroup,
  lodLevel,
  movedKey,
  poseInstances as poseParts,
  type ViewLevel,
} from '@editor-platform/geometry-view';

/** An instance's path is its component IDs from the assembly down. */
export type ViewportPartInstance = ViewInstance;
/** A version's body meshes, drawn at each instance's matrix of the part's origin. */
export type ViewportPart = ViewSolid<CadMesh>;
