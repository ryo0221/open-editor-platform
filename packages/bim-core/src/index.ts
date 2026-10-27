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
  type BimElementGeometry,
  type BimGeometry,
  type BimPlacement,
} from './ops';
export {
  bimProfileLoops,
  bimRoofPlanes,
  bimWallAxis,
  bimWallOpeningLoop,
  profileHeight,
  type BimPlane,
} from './solids';
export * from './drawing';
export * from './operations';
export * from './commands';
export * from './fixtures';
