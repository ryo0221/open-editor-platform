export * from './model';
export { validateAnimation } from './validate';
export { frameTick, mapNestedTick } from './time';
export { prepareAnimation, inspectPreparedComposition, type PreparedAnimation } from './prepare';
export { evaluateAnimation, type EvaluatedScene, type SceneRect, type Matrix } from './evaluate';
export { replaceTrack, type AnimationEditScope } from './commands';
export {
  readPrototypeAnimation,
  readAnimationV1,
  prepareRectangleAnimationV1,
  frameTickV1,
  migratePrototypeDraftToV1,
  migratePrototypeToV1Command,
} from './v1';
export { putRectangleLayerV1, removeAnimationTrackV1 } from './edit-v1';
export { prepareRectangleAnimationV1Sync } from './prepare';
export * from './embedding';
export {
  inspectAnimationLayerSubtreeV1,
  duplicateAnimationLayerV1,
  removeAnimationLayerV1,
  type AnimationLayerSubtreeV1,
} from './layer-actions-v1';
