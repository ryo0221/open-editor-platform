import {
  add,
  subtract,
  time,
  assertVideoContentV2,
  videoCommandV2,
  type MediaAssetRef,
  type Time,
  type VideoContentV2,
} from '@editor-platform/video-core';
import type { AudioImportSetV2 } from './audio-profile-v2';
/** Pure explicit source insertion; Host stages original bytes then submits one transaction. */
export function prepareAudioImportV2(
  content: VideoContentV2,
  set: AudioImportSetV2,
  asset: MediaAssetRef,
  id: string,
  start: Time,
) {
  assertVideoContentV2(content);
  if (
    Object.keys(set).sort().join() !== 'format,profile,streams' ||
    set.format !== 'video-media-interpretation-v2' ||
    set.profile !== 'aac-mono-v2' ||
    set.streams.length !== 1
  )
    throw Error('V2 audio import set');
  const s = set.streams[0];
  if (
    Object.keys(s).sort().join() !==
      'destination,id,kind,mediaEnd,mediaStart,presentationStart,sampleCount,sampleOrigin,sampleRate' ||
    s.kind !== 'audio' ||
    ![44100, 48000].includes(s.sampleRate)
  )
    throw Error('V2 audio stream fields');
  const duration = subtract(s.mediaEnd, s.mediaStart),
    sourceIn = s.presentationStart,
    sourceOut = add(sourceIn, duration);
  const draft = structuredClone(content);
  draft.sources.push({
    id,
    asset: structuredClone(asset),
    streams: [
      {
        id: s.id,
        kind: 'audio',
        sampleRate: s.sampleRate,
        sampleCount: s.sampleCount,
        sampleOrigin: { ...s.sampleOrigin },
        validity: { start: { ...s.mediaStart }, end: { ...s.mediaEnd } },
        presentationOrigin: subtract(s.presentationStart, s.mediaStart),
      },
    ],
  });
  return videoCommandV2({
    type: 'insert',
    clip: {
      id: id + ':' + s.id,
      kind: 'audio',
      sourceId: id,
      streamId: s.id,
      trackId: s.destination,
      start: { ...start },
      duration,
      sourceIn: { ...sourceIn },
      sourceOut,
      gain: 1,
      fade: { start: { ...sourceIn }, end: { ...sourceOut }, in: time(0), out: time(0) },
    },
  }).apply(draft);
}
