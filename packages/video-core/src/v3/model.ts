/** Private native Video version. Existing v0/v1/v2 records remain closed and unchanged. */
import type { AnimationEmbed2 } from '@editor-platform/animation-core/v2';
import type { ClipV2, VideoContentV2, AudioFadeV2 } from '../v2/model';
import type { Time } from '../time';
import type { MediaAssetRef } from '../model';
export interface ImageSourceV3 {
  id: string;
  kind: 'image';
  asset: MediaAssetRef;
  mime: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  orientation: number;
}
export interface FontSourceV3 {
  id: string;
  kind: 'font';
  asset: MediaAssetRef;
  fontProfile: 'noto-cjk-jp-2.004';
  weight: 'regular' | 'bold';
}
export interface TitleClipV3 extends Omit<ImageClipV3, 'kind'> {
  kind: 'title';
  text: string;
  style: {
    x: number;
    y: number;
    width: number;
    height: number;
    size: number;
    color: string;
    align: 'left' | 'center' | 'right';
  };
}
export interface CaptionClipV3 extends Omit<TitleClipV3, 'kind'> {
  kind: 'caption';
}
export type TextClipV3 = TitleClipV3 | CaptionClipV3;
export interface AnimationClipV3 {
  linkGroupId?: string;
  id: string;
  kind: 'animation';
  trackId: string;
  start: Time;
  duration: Time;
  sourceIn: Time;
  sourceOut: Time;
  rate: Time;
  /** Immutable exact native source snapshot. The Host authorizes admission/update. */
  embed: AnimationEmbed2;
  /** Opacity envelope anchored in source time; trim/split preserve its function. */
  visualFade?: AudioFadeV2;
}
export type ClipV3 =
  | Extract<ClipV2, { kind: 'audio' }>
  | (Extract<ClipV2, { kind: 'video' }> & { visualFade?: AudioFadeV2 })
  | AnimationClipV3
  | ImageClipV3
  | TitleClipV3
  | CaptionClipV3;
export interface ImageClipV3 extends Omit<AnimationClipV3, 'kind' | 'embed'> {
  kind: 'image';
  sourceId: string;
}
export interface DissolveV3 {
  id: string;
  kind: 'cross-dissolve';
  leftClipId: string;
  rightClipId: string;
  duration: Time;
}
export interface VideoContentV3 extends Omit<VideoContentV2, 'schema' | 'sequence' | 'sources'> {
  schema: 'video-core-prototype-v3';
  sequence: Omit<VideoContentV2['sequence'], 'clips'> & {
    clips: ClipV3[];
    transitions?: DissolveV3[];
  };
  sources: (VideoContentV2['sources'][number] | ImageSourceV3 | FontSourceV3)[];
}
