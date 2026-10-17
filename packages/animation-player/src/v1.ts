import {
  EVALUATOR_V1,
  inspectPreparedComposition,
  requireAnimation,
  type PreparedAnimation,
} from '@editor-platform/animation-core';
import { mountAnimationPreview } from './preview';
export const RECTANGLE_PLAYER_CONTRACT_V1 = 'animation-rectangle-player-1' as const;
export interface RectanglePlayerV1 {
  readonly tick: number;
  readonly playing: boolean;
  seek(tick: number): void;
  play(): void;
  pause(): void;
  setRate(rate: number): void;
  dispose(): void;
}
export interface RectanglePlayerClockV1 {
  now(): number;
  request(callback: () => void): number;
  cancel(id: number): void;
}
export interface RectanglePlayerOptionsV1 {
  source: PreparedAnimation;
  compositionId: string;
  label: string;
  signal?: AbortSignal;
  clock?: RectanglePlayerClockV1;
  loop?: boolean;
  autoPlay?: boolean;
}
/** v1 entrypoint refuses prototype content. Host read scope, lifecycle signal and placement remain external. */
export function mountRectanglePlayerV1(
  container: HTMLElement,
  options: RectanglePlayerOptionsV1,
): RectanglePlayerV1 {
  const metadata = inspectPreparedComposition(options.source, options.compositionId);
  requireAnimation(
    metadata.schemaVersion === 1 && options.source.evaluatorVersion === EVALUATOR_V1,
    'player-requires-v1',
    'source',
  );
  return mountAnimationPreview(container, options);
}
