/** #94-based controlled Surface handoff. Player and React root are adapter-owned. */
import type { AnimationContent } from '@editor-platform/animation-core';
import type {
  ControlledSurfaceController,
  SurfaceOperation,
} from '@editor-platform/extension-contract/controlled-surface';
export interface AnimationPlaybackSnapshot {
  readonly compositionId: string;
  readonly tick: number;
  readonly duration: number;
  readonly ticksPerSecond: 240000;
  readonly playing: boolean;
  readonly ready: boolean;
  readonly error?: string;
}
export interface AnimationPlaybackPort {
  getSnapshot(): AnimationPlaybackSnapshot;
  subscribe(listener: () => void): () => void;
  /** Attach the adapter-owned Player presentation; returned callback detaches it.
   * Adapter owns pending preparation/disposal and lifecycle drain, not the Surface. */
  attach(container: HTMLElement): () => void;
  selectComposition(id: string): SurfaceOperation;
  play(): SurfaceOperation;
  pause(): SurfaceOperation;
  seek(tick: number): SurfaceOperation;
  setRate(rate: number): SurfaceOperation;
}
export interface AnimationControlledSurfaceProps {
  readonly editor: ControlledSurfaceController<AnimationContent>;
  readonly playback: AnimationPlaybackPort;
  /** Ordinary Hosts provide their own common Undo/Redo/version toolbar. */
  readonly hostActions?: 'surface' | 'external';
}
