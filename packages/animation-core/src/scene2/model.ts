import type { Easing, Rational, SourceRef, Transform } from '../model';
import type { TextRun } from '@editor-platform/editor-core';
/** Conservative nested clip budget; SVG serialization retains its independent 8 MiB bound. */
export const MAX_ANIMATION_EXPANDED_CLIPS2 = 32_768;
/** Reserve half of the SVG serialization budget for expanded path and text markup. */
export const MAX_ANIMATION_EXPANDED_SVG_DATA2 = 4 * 1024 * 1024;
export type PathCommand2 =
  | ['M' | 'L', number, number]
  | ['C', number, number, number, number, number, number]
  | ['Q', number, number, number, number]
  | ['Z'];
export type VectorPath2 = PathCommand2[];
export interface MotionPath2 {
  path: VectorPath2;
  start: number;
  end: number;
  orient: boolean;
}
export interface LayerBase2 {
  id: string;
  name: string;
  parentId: string | null;
  start: number;
  end: number;
  transform: Transform;
  visible: boolean;
  locked: boolean;
  clipId: string | null;
  maskOnly: boolean;
  motion: MotionPath2 | null;
}
export type Layer2 = LayerBase2 &
  (
    | {
        type: 'rect';
        width: number;
        height: number;
        fill: string;
        stroke: string;
        strokeWidth: number;
      }
    | { type: 'path'; path: VectorPath2; fill: string; stroke: string; strokeWidth: number }
    | {
        type: 'text';
        text: string;
        runs: TextRun[];
        width: number;
        height: number;
        fontAssetId: string | null;
        fontSize: number;
        lineHeight: number;
        fill: string;
      }
    | { type: 'image'; assetId: string; width: number; height: number }
    | { type: 'group' }
    | {
        type: 'composition';
        source: { type: 'local'; compositionId: string } | { type: 'exact'; ref: SourceRef };
        time: {
          sourceIn: number;
          sourceOut: number;
          rate: Rational;
          after: 'hold' | 'loop' | 'hide';
        };
      }
  );
export type Property2 = keyof Transform | 'fill' | 'stroke' | 'strokeWidth' | 'text';
export interface Key2 {
  id: string;
  tick: number;
  value: number | string;
  easing: Easing;
}
export interface Track2 {
  id: string;
  layerId: string;
  property: Property2;
  keys: Key2[];
}
export interface Composition2 {
  id: string;
  name: string;
  width: number;
  height: number;
  duration: number;
  frameRate: Rational;
  layers: Layer2[];
  tracks: Track2[];
}
export interface Asset2 {
  id: string;
  contentHash: string;
  mediaType: 'image/png' | 'image/jpeg' | 'font/otf' | 'font/ttf' | 'font/woff2';
  base64: string;
  attribution: string;
  license: string;
}
export interface PublicInput2 {
  id: string;
  name: string;
  kind: 'number' | 'color' | 'text';
  default: number | string;
  min: number;
  max: number;
  target: { compositionId: string; layerId: string; property: Property2 };
}
export interface AnimationContent2 {
  schemaVersion: 2;
  ticksPerSecond: 240000;
  rootCompositionId: string;
  compositions: Composition2[];
  assets: Asset2[];
  publicInputs: PublicInput2[];
  sources: { ref: SourceRef; content: AnimationContent2 }[];
  provenance: {
    source: SourceRef;
    mapping: { sourceId: string; layerId: string }[];
    losses: string[];
  }[];
}
export interface SceneClip2 {
  path: VectorPath2;
  matrix: Matrix2;
}
export type Matrix2 = [number, number, number, number, number, number];
export interface SceneItem2 {
  id: string;
  instancePath: string[];
  layer: Exclude<Layer2, { type: 'group' | 'composition' }>;
  matrix: Matrix2;
  opacity: number;
  clips: SceneClip2[];
  asset?: Asset2;
}
export interface Scene2 {
  version: 'animation-scene-2';
  contentHash: string;
  compositionId: string;
  tick: number;
  width: number;
  height: number;
  items: SceneItem2[];
  /** Native poses in the selected composition, including non-painting containers. */
  layerPoses: { id: string; matrix: Matrix2; parentMatrix: Matrix2 }[];
  provenance: { ownerHash: string; records: AnimationContent2['provenance'] }[];
}
export const EVALUATOR2 = 'animation-evaluator-2' as const;
