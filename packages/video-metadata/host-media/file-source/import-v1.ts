/** Versioned pure Host interpretation adapter; no staging, storage or automatic v0 migration. */
import {
  add,
  compare,
  isTime,
  subtract,
  time,
  assertVideoContentV1,
  type Time,
  type VideoContentV1,
  type ClipV1,
} from '@editor-platform/video-core';
interface SelectedBaseV1 {
  id: string;
  destination: string;
  mediaStart: Time;
  mediaEnd: Time;
  presentationStart: Time;
}
export type SelectedStreamV1 =
  | (SelectedBaseV1 & { kind: 'video' })
  | (SelectedBaseV1 & {
      kind: 'audio';
      sampleRate: number;
      sampleCount: number;
      sampleOrigin: Time;
    });
export interface ImportSetV1 {
  format: 'video-media-interpretation-v1';
  streams: SelectedStreamV1[];
}
function checkTime(t: Time) {
  if (!isTime(t)) throw Error('Invalid import time');
}
export function prepareImportSetV1(
  content: VideoContentV1,
  set: ImportSetV1,
  asset: { assetId: string; sha256: string; byteLength: number },
  id: string,
): VideoContentV1 {
  assertVideoContentV1(content);
  if (!Array.isArray(set.streams) || set.streams.length < 1 || set.streams.length > 2)
    throw Error('Select one video and optional one audio');
  if (
    Object.keys(set).sort().join() !== 'format,streams' ||
    set.format !== 'video-media-interpretation-v1'
  )
    throw Error('Import set fields');
  for (const stream of set.streams) {
    if (!stream || typeof stream !== 'object') throw Error('Stream shape');
    const keys = [
      'id',
      'kind',
      'destination',
      'mediaStart',
      'mediaEnd',
      'presentationStart',
      ...(stream.kind === 'audio' ? ['sampleRate', 'sampleOrigin', 'sampleCount'] : []),
    ];
    if (
      Object.keys(stream).sort().join() !== keys.sort().join() ||
      typeof stream.id !== 'string' ||
      typeof stream.destination !== 'string'
    )
      throw Error('Stream fields');
    [stream.mediaStart, stream.mediaEnd, stream.presentationStart].forEach(checkTime);
  }
  const video = set.streams.filter((s) => s.kind === 'video'),
    audio = set.streams.filter((s) => s.kind === 'audio');
  if (
    video.length !== 1 ||
    audio.length > 1 ||
    new Set(set.streams.map((s) => s.id)).size !== set.streams.length
  )
    throw Error('Ambiguous selected streams');
  const native = structuredClone(content),
    source: VideoContentV1['sources'][number] = { id, asset: structuredClone(asset), streams: [] },
    clips: ClipV1[] = [];
  const origin = set.streams.reduce(
    (a, s) => (compare(s.presentationStart, a) < 0 ? s.presentationStart : a),
    set.streams[0].presentationStart,
  );
  for (const s of set.streams) {
    [s.mediaStart, s.mediaEnd, s.presentationStart].forEach(checkTime);
    const duration = subtract(s.mediaEnd, s.mediaStart);
    if (compare(duration, time(0)) <= 0) throw Error('Empty selected stream');
    const destination = native.sequence.tracks.find((t) => t.id === s.destination);
    if (
      !destination ||
      destination.locked ||
      destination.kind !== (s.kind === 'video' ? 'visual' : 'audio')
    )
      throw Error('Selected destination unavailable');
    const start = add(content.sequence.duration, subtract(s.presentationStart, origin)),
      base = {
        id: id + ':' + s.id,
        sourceId: id,
        streamId: s.id,
        trackId: s.destination,
        start,
        duration,
        ...(set.streams.length === 2 ? { linkGroupId: id + ':linked' } : {}),
      };
    if (s.kind === 'video') {
      // Raw seconds use a common rational tick; do not round presentation origin to frame ticks.
      const d = BigInt(s.mediaStart.timescale) * BigInt(s.mediaEnd.timescale);
      if (d > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Source clock overflow');
      const scale = Number(d),
        first = s.mediaStart.value * (scale / s.mediaStart.timescale),
        last = s.mediaEnd.value * (scale / s.mediaEnd.timescale);
      source.streams.push({
        id: s.id,
        kind: 'video',
        timebase: time(1, scale),
        startPts: first,
        endPts: last,
        presentationOrigin: subtract(s.presentationStart, s.mediaStart),
      });
      clips.push({
        ...base,
        kind: 'video',
        sourceIn: s.presentationStart,
        sourceOut: add(s.presentationStart, duration),
        rate: time(1),
      });
    } else {
      source.streams.push({
        id: s.id,
        kind: 'audio',
        sampleRate: s.sampleRate,
        sampleCount: s.sampleCount,
        sampleOrigin: s.sampleOrigin,
        presentationOrigin: subtract(s.presentationStart, s.mediaStart),
        validity: { start: s.mediaStart, end: s.mediaEnd },
      });
      clips.push({
        ...base,
        kind: 'audio',
        sourceIn: s.presentationStart,
        sourceOut: add(s.presentationStart, duration),
      });
    }
  }
  native.sources.push(source);
  native.sequence.clips.push(...clips);
  for (const c of clips) {
    const end = add(c.start, c.duration);
    if (compare(end, native.sequence.duration) > 0) native.sequence.duration = end;
  }
  assertVideoContentV1(native);
  if (new TextEncoder().encode(JSON.stringify(native)).length > 60000)
    throw Error('Native capture capacity');
  return structuredClone(native);
}
