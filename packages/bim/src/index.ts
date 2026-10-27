export {
  bimDirectKernel,
  bimDisplayMesh,
  bimEvaluationLimits,
  BimEvaluator,
  type BimElementResult,
  type BimEvaluation,
  type BimKernel,
  type BimKernelOutcome,
  type BimSolid,
} from './evaluate';
export { BimDrawings, drawBim, type BimDrawingResult } from './drawing';
export {
  bimIfcPartMesh,
  bimIfcPartMeshFor,
  exportBimIfc,
  meshClosed,
  type BimIfcFileOptions,
  type BimIfcFileResult,
} from './ifc';
export { createBimKernelHost, type BimKernelHostOptions } from './kernel-host';
export type { BimWorkerRequest, BimWorkerResponse } from './protocol';
export {
  bimKernelLimits,
  WorkerBimKernel,
  type BimWorkerLike,
  type WorkerBimKernelOptions,
} from './port';
export {
  BimController,
  type BimControllerOptions,
  type BimNotice,
  type BimSession,
  type BimState,
} from './controller';
export {
  bimElementLevel,
  bimKindStyle,
  bimViewBounds,
  bimViewSolids,
  placementMatrix,
  type BimViewOptions,
} from './view';
export { BimSurface } from './surface';
export type {
  BimPartCandidate,
  BimPartReference,
  BimPartShape,
  BimPartLook,
  BimPartSource,
  BimPartStatus,
  BimPartVersion,
} from './parts';
