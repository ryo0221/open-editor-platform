export * from './model';
export {
  assertBim,
  bimId,
  BimValidationError,
  canonicalContentBytes,
  isBimDocument,
  validateBim,
} from './validation';
export * from './geometry';
export {
  BimContext,
  bimJoinThrough,
  bimStairProfile,
  deriveBim,
  layersThickness,
  loopExtreme,
  loopSimple,
  profileArea,
  reverseLoop,
  type BimDerived,
  type BimQuantities,
  type BimRoofFace,
  type BimShape,
  type BimWallOpeningShape,
} from './derive';
export {
  bimPanelMm,
  bimGeometry,
  bimNodeRole,
  bimRampStepRad,
  type BimElementGeometry,
  type BimGeometry,
  type BimPlacement,
} from './ops';
export {
  bimProfileLoops,
  bimRoofPlanes,
  bimSlabPlanes,
  bimSectionAxes,
  bimWallAxis,
  bimWallOpeningLoop,
  bimWallOpeningRise,
  profileHeight,
  type BimPlane,
  type BimSectionAxes,
} from './solids';
export * from './drawing';
export * from './schedule';
export * from './mass';
export * from './operations';
export * from './commands';
export * from './fixtures';
