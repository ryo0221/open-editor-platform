/** Provisional schema: never register as production Animation v1. */
export const SCHEMA = 'animation-prototype-0' as const;
export const EVALUATOR = 'animation-evaluator-prototype-0' as const;
export const SCHEMA_V1 = 1 as const;
export const TICKS_PER_SECOND_V1 = 240000 as const;
export const EVALUATOR_V1 = 'animation-evaluator-rectangle-1' as const;
export interface Rational {
  numerator: number;
  denominator: number;
}
export interface SourceRef {
  artifactId: string;
  versionId: string;
  contentHash: string;
  compositionId: string;
}
export interface AssetRef {
  id: string;
  contentHash: string;
  byteLength: number;
  mediaType: 'image/png' | 'image/jpeg';
}
export interface Transform {
  x: number;
  y: number;
  anchorX: number;
  anchorY: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  opacity: number;
}
export type Property = keyof Transform;
export type Easing =
  | { type: 'hold' }
  | { type: 'linear' }
  | { type: 'bezier'; x1: number; y1: number; x2: number; y2: number };
export interface Keyframe {
  id: string;
  tick: number;
  value: number;
  easing: Easing;
}
export interface Track {
  id: string;
  layerId: string;
  property: Property;
  keys: Keyframe[];
}
export interface LayerBase {
  id: string;
  parentId: string | null;
  start: number;
  end: number;
  transform: Transform;
}
export interface TimeMapping {
  sourceIn: number;
  sourceOut: number;
  rate: Rational;
  after: 'hold' | 'loop' | 'hide';
}
export type Layer = LayerBase &
  (
    | { type: 'rect'; width: number; height: number; fill: string }
    | { type: 'group' }
    | {
        type: 'composition';
        source: { type: 'local'; compositionId: string } | { type: 'exact'; ref: SourceRef };
        time: TimeMapping;
      }
  );
export interface Composition {
  id: string;
  width: number;
  height: number;
  duration: number;
  frameRate: Rational;
  layers: Layer[];
  tracks: Track[];
}
export interface PrototypeAnimationContent {
  schemaVersion: typeof SCHEMA;
  ticksPerSecond: number;
  rootCompositionId: string;
  compositions: Composition[];
  assets: AssetRef[];
}
export type RectangleLayer = Exclude<Layer, { type: 'composition' }>;
export interface AnimationContentV1 {
  schemaVersion: typeof SCHEMA_V1;
  ticksPerSecond: typeof TICKS_PER_SECOND_V1;
  rootCompositionId: string;
  compositions: (Omit<Composition, 'layers'> & { layers: RectangleLayer[] })[];
  assets: [];
}
export type AnimationContent = PrototypeAnimationContent | AnimationContentV1;
export interface RetainedSource {
  ref: SourceRef;
  content: unknown;
}
export interface SuppliedAsset {
  contentHash: string;
  bytes: Uint8Array;
}
export const identityTransform = (): Transform => ({
  x: 0,
  y: 0,
  anchorX: 0,
  anchorY: 0,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  opacity: 1,
});
export class AnimationError extends Error {
  constructor(
    public readonly code: string,
    public readonly address: string,
  ) {
    super(`${code}: ${address}`);
  }
}
export function requireAnimation(
  condition: unknown,
  code: string,
  address: string,
): asserts condition {
  if (!condition) throw new AnimationError(code, address);
}
