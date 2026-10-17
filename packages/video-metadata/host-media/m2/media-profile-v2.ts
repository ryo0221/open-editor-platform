/** Exact new interpretation dispatch; generic Artifact envelope remains version1. */
import {
  assertVideoContentV2,
  adoptVideoContentV2,
  type VideoContentV1,
  type VideoContentV2,
  type MediaAssetRef,
} from '@editor-platform/video-core';
import { inspectOriginalV1 } from '../file-source/inspect-v1';
import { prepareImportSetV1, type SelectedStreamV1 } from '../file-source/import-v1';
import { inspectAudioOriginalV2, type AudioImportSetV2 } from './audio-profile-v2';
export interface AvImportSetV2 {
  format: 'video-media-interpretation-v2';
  profile: 'av-sdr-v2';
  streams: SelectedStreamV1[];
}
export type MediaImportSetV2 = AvImportSetV2 | AudioImportSetV2;
export async function inspectMediaOriginalV2(
  original: Blob,
  profile: MediaImportSetV2['profile'],
  signal: AbortSignal,
) {
  if (profile === 'aac-mono-v2') return inspectAudioOriginalV2(original, signal);
  if (profile !== 'av-sdr-v2') throw Error('Unknown v2 media profile');
  const { metadata, plan } = await inspectOriginalV1(original, signal);
  return { metadata, plan: { ...plan, format: 'video-media-interpretation-v2' as const, profile } };
}
export function prepareAvImportV2(
  content: VideoContentV2,
  set: AvImportSetV2,
  asset: MediaAssetRef,
  id: string,
): VideoContentV2 {
  assertVideoContentV2(content);
  if (
    Object.keys(set).sort().join() !== 'format,profile,streams' ||
    set.format !== 'video-media-interpretation-v2' ||
    set.profile !== 'av-sdr-v2'
  )
    throw Error('V2 AV import set');
  const base: VideoContentV1 = {
    ...content,
    schema: 'video-core-prototype-v1',
    sequence: {
      ...content.sequence,
      clips: content.sequence.clips.map((c) => {
        if (c.kind === 'video') return c;
        const { gain, fade, ...clip } = c;
        void gain;
        void fade;
        return clip;
      }),
    },
  };
  const result = adoptVideoContentV2(
    prepareImportSetV1(
      base,
      { format: 'video-media-interpretation-v1', streams: structuredClone(set.streams) },
      asset,
      id,
    ),
  );
  for (const clip of result.sequence.clips) {
    if (clip.kind !== 'audio') continue;
    const previous = content.sequence.clips.find((c) => c.id === clip.id);
    if (previous?.kind === 'audio') {
      clip.gain = previous.gain;
      clip.fade = structuredClone(previous.fade);
    }
  }
  assertVideoContentV2(result);
  return result;
}
