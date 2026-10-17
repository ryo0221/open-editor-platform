import {
  add,
  subtract,
  compare,
  time,
  assertVideoContentV1,
  multiply,
} from '@editor-platform/video-core';
import { audioMappingV1, outputSpanV1 } from './timing-v1';
import { ceilTime } from '../../../video-core/experiments/pcm-renderer/render.ts';
import { PcmRenderSession } from '../../../video-core/experiments/pcm-renderer/session.ts';
import { createPcmFile } from '../indexed-media/pcm-file.mjs';
import { createVideoWindow } from '../indexed-media/video-window.mjs';
const need = (ok, msg) => {
  if (!ok) throw Error(msg);
};
const rate = 48000;
export function timelinePlanV1(snapshot) {
  const content = snapshot.native.content;
  assertVideoContentV1(content);
  const duration = content.sequence.duration,
    count = outputSpanV1(duration, rate).end;
  need(count >= 4800 && count <= rate * 90, 'v1 duration quota');
  need(
    content.sources.length === 1 && snapshot.originals.length === 1,
    'v1 single original profile',
  );
  const source = content.sources[0],
    original = snapshot.originals[0];
  need(original.plan.format === 'video-media-interpretation-v1', 'v1 original interpretation');
  const clips = (kind) =>
    content.sequence.clips.filter((c) => c.kind === kind).sort((a, b) => compare(a.start, b.start));
  const video = clips('video'),
    audio = clips('audio');
  for (const list of [video, audio]) {
    need(list.length > 0, 'Both v1 tracks required');
    let end = time(0);
    for (const c of list) {
      need(
        c.sourceId === source.id &&
          content.sequence.tracks.find((t) => t.id === c.trackId)?.enabled &&
          compare(c.start, end) === 0,
        'v1 full contiguous enabled tracks',
      );
      if (c.kind === 'video') need(compare(c.rate, time(1)) === 0, 'v1 unity video rate');
      end = add(c.start, c.duration);
    }
    need(compare(end, duration) === 0, 'v1 full sequence coverage');
  }
  const audioStream = source.streams.find((s) => s.kind === 'audio'),
    videoStream = source.streams.find((s) => s.kind === 'video');
  need(audioStream && videoStream, 'v1 both streams');
  return {
    content,
    source,
    original,
    duration,
    count,
    video,
    audio,
    audioStream,
    videoStream,
    frames: ceilTime(multiply(duration, time(25))),
  };
}
const locate = (clips, at) => {
  const c = clips.find(
    (c) => compare(c.start, at) <= 0 && compare(at, add(c.start, c.duration)) < 0,
  );
  need(c, 'No v1 clip');
  return c;
};
export async function timelineVideoV1(plan, signal) {
  const video = await createVideoWindow(plan.original.bytes, signal, 'iphone-sdr-v1');
  return {
    clock: video.clock,
    rotation: video.rotation,
    evidence: video.evidence,
    dispose: video.dispose,
    frameAt(at, caller) {
      const clip = locate(plan.video, at);
      return video.frameAt(
        subtract(add(clip.sourceIn, subtract(at, clip.start)), plan.videoStream.presentationOrigin),
        caller,
      );
    },
  };
}
export async function timelinePcmV1(plan, signal) {
  const index = await createPcmFile(
    plan.original.bytes,
    signal,
    {
      originalHash: plan.source.asset.sha256,
      streamId: plan.audioStream.id,
      decodePolicy: 'native-aac-continuous-v1',
    },
    'iphone-sdr-v1',
  );
  const lease = index.acquire(),
    renderer = new PcmRenderSession(lease, 'edge-hold-v0');
  let disposal;
  return {
    evidence: index.evidence,
    channels: 1,
    async render(first, end, caller) {
      need(
        Number.isSafeInteger(first) &&
          Number.isSafeInteger(end) &&
          first >= 0 &&
          end > first &&
          end - first <= 4096 &&
          end <= plan.count,
        'v1 PCM range',
      );
      const planes = [new Float32Array(end - first)];
      for (let cursor = first; cursor < end; ) {
        const clip = locate(plan.audio, time(cursor, rate)),
          b = audioMappingV1(plan.content, clip.id);
        const last = Math.min(end, ceilTime(multiply(b.mapping.end, time(rate))));
        const chunk = await renderer.render(
          b.mapping,
          cursor,
          last,
          rate,
          plan.audioStream.sampleRate,
          b.valid,
          1,
          caller,
        );
        planes[0].set(chunk.planes[0], cursor - first);
        cursor = last;
      }
      need(
        planes[0].every((x) => Number.isFinite(x) && Math.abs(x) <= 1),
        'v1 PCM clipping/nonfinite',
      );
      return { first, end, planes };
    },
    dispose() {
      if (!disposal) {
        renderer.dispose();
        lease.release();
        disposal = index.dispose();
      }
      return disposal;
    },
  };
}
