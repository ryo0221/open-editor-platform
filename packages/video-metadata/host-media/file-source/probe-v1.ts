/** Bounded private feasibility profile: v1 unfragmented SDR AVC + optional AAC, exact raw validity, unit-rate edit. */
import { time } from '@editor-platform/video-core';
import type { ImportSetV1, SelectedStreamV1 } from './import-v1';
import {
  IDENTITY,
  inspectMp4,
  type Box,
  type Mp4Profile,
  type Mp4Reader,
  type Mp4Track,
} from '../mp4-boxes';
const CLOCKWISE = [0, 65536, 0, 4294901760, 0, 0, 70778880, 0, 1073741824];
const reference = (refs: Box[]) => {
  if (refs.length !== 1 || !['url ', 'alis'].includes(refs[0].type))
    throw Error('External media references');
  return refs[0];
};
const colorType = (r: Mp4Reader, color: Box) =>
  (color.end === color.data + 11 &&
    r.fourcc(color.data) === 'nclx' &&
    r.bytes[color.data + 10] === 0) ||
  (color.end === color.data + 10 && r.fourcc(color.data) === 'nclc');
const profile: Mp4Profile = {
  transforms: (kind) => (kind === 'video' ? [IDENTITY, CLOCKWISE] : [IDENTITY]),
  reference,
  quickTimePadding: true,
  colorType,
  audioVersions: [0, 1],
};
const toStream =
  (trackSet: 'video' | 'audio-only') =>
  (t: Mp4Track): SelectedStreamV1 => {
    if (t.kind === 'audio' && trackSet === 'audio-only' && t.channels !== 1)
      throw Error('AAC-only mono profile');
    const common = {
      id: String(t.id),
      destination: t.kind === 'video' ? 'visual' : 'audio',
      mediaStart: t.mediaStart,
      mediaEnd: t.mediaEnd,
      presentationStart: t.presentationStart,
    };
    return t.kind === 'audio'
      ? {
          ...common,
          kind: 'audio',
          sampleRate: t.scale,
          sampleCount: t.duration,
          sampleOrigin: time(0),
        }
      : { ...common, kind: 'video' };
  };
/** Shared bounded parser. Track-set admission is selected explicitly by each private profile. */
export async function inspectMp4Tracks(
  original: Blob,
  signal: AbortSignal,
  trackSet: 'video' | 'audio-only',
): Promise<ImportSetV1> {
  const streams = await inspectMp4(original, signal, profile, toStream(trackSet));
  if (trackSet === 'audio-only') {
    if (streams.length !== 1 || streams[0].kind !== 'audio')
      throw Error('One audio-only track required');
  } else if (streams.filter((s) => s.kind === 'video').length !== 1)
    throw Error('One video track required');
  signal.throwIfAborted();
  return { format: 'video-media-interpretation-v1', streams };
}
export const mp4ProbeV1 = {
  inspect: (original: Blob, signal: AbortSignal) => inspectMp4Tracks(original, signal, 'video'),
};
