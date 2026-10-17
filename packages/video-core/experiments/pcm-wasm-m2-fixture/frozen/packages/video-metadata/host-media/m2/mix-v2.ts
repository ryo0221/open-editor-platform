/** Shared private preview/export block renderer. Never schedules audio or commits a sink. */
import {
  assertVideoContentV2,
  audioGainAtV2,
  time,
  type VideoContentV2,
  type VideoContentV1,
} from '../../../../core';
import { prepareSourceRequests } from './requests';
type Requests = ReturnType<typeof prepareSourceRequests>;
export type AudioRequestV2 = ReturnType<Requests['audioWindow']>[number];
export interface ResampledBlockV2 {
  first: number;
  rate: number;
  planes: Float32Array[];
}
export type ResamplePortV2 = (
  request: AudioRequestV2,
  signal: AbortSignal,
) => Promise<ResampledBlockV2>;
export function prepareMixV2(content: VideoContentV2, resample: ResamplePortV2) {
  assertVideoContentV2(content);
  const owned = structuredClone(content);
  const timing: VideoContentV1 = {
    ...owned,
    schema: 'video-core-prototype-v1',
    sequence: {
      ...owned.sequence,
      clips: owned.sequence.clips.map((c) => {
        if (c.kind === 'video') return c;
        const { gain, fade, ...base } = c;
        void gain;
        void fade;
        return base;
      }),
    },
  };
  const requests = prepareSourceRequests(timing);
  return {
    async render(first: number, end: number, signal: AbortSignal): Promise<ResampledBlockV2> {
      signal.throwIfAborted();
      const rows = requests.audioWindow(first, end);
      // At most two simultaneous contributors, not two clips over an entire block.
      const edges = rows
        .flatMap((r) => [
          [r.first, 1],
          [r.end, -1],
        ])
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let active = 0;
      for (const [, delta] of edges) {
        active += delta;
        if (active > 2) throw Error('V2 audio contributor limit');
      }
      const mixed = new Float64Array(end - first);
      for (const row of rows) {
        signal.throwIfAborted();
        const pcm = await resample(structuredClone(row), signal);
        signal.throwIfAborted();
        if (
          pcm.first !== row.first ||
          pcm.rate !== 48000 ||
          pcm.planes.length !== 1 ||
          !(pcm.planes[0] instanceof Float32Array) ||
          pcm.planes[0].length !== row.end - row.first
        )
          throw Error('V2 resampler block mismatch');
        const clip = owned.sequence.clips.find((c) => c.id === row.clipId)!;
        if (clip.kind !== 'audio') throw Error('V2 audio identity');
        for (let k = row.first; k < row.end; k++)
          mixed[k - first] += pcm.planes[0][k - row.first] * audioGainAtV2(clip, time(k, 48000));
      }
      signal.throwIfAborted();
      // No partial-sum clipping/refusal: a later contributor may cancel an overshoot.
      for (const value of mixed)
        if (!Number.isFinite(value) || value < -1 || value > 1)
          throw Error('V2 final mixed sample nonfinite or out of range');
      const plane = Float32Array.from(mixed);
      return { first, rate: 48000, planes: [plane] };
    },
  };
}
