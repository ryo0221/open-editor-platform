import { time, add, subtract, compare, sampleIndex } from '@editor-platform/video-core';
import { PcmRenderSession } from '../../../video-core/src/pcm/session.ts';
import { createPcmFile } from './pcm-file.mjs';
import { createVideoWindow } from './video-window.mjs';
const rate = 48000;
const need = (ok, msg) => {
  if (!ok) throw Error(msg);
};
export function timelinePlan(snapshot, maximumSeconds = 60) {
  const c = snapshot.native.content,
    duration = c.sequence.duration,
    count = sampleIndex(duration, rate);
  need(
    count >= 4800 && count <= 48000 * maximumSeconds && sampleIndex(duration, 25) > 0,
    `Product duration profile: 0.1–${maximumSeconds} s on 25 fps grid`,
  );
  need(c.sources.length === 1 && snapshot.originals.length === 1, 'Product one-original profile');
  const source = c.sources[0],
    original = snapshot.originals[0];
  const clips = (kind) =>
    c.sequence.clips.filter((x) => x.kind === kind).sort((a, b) => compare(a.start, b.start));
  const video = clips('video'),
    audio = clips('audio');
  for (const list of [video, audio]) {
    need(list.length > 0, 'Both tracks required');
    let cursor = time(0);
    for (const clip of list) {
      const track = c.sequence.tracks.find((t) => t.id === clip.trackId);
      need(
        track?.enabled && clip.sourceId === source.id && compare(clip.start, cursor) === 0,
        'No disabled tracks, gaps, overlaps or alternate originals in this profile',
      );
      cursor = add(cursor, clip.duration);
      if (clip.kind === 'video') need(compare(clip.rate, time(1)) === 0, 'Unity video speed only');
      sampleIndex(clip.start, 25);
      sampleIndex(cursor, 25);
    }
    need(compare(cursor, duration) === 0, 'Full sequence coverage required');
  }
  const audioStream = source.streams.find((x) => x.kind === 'audio'),
    videoStream = source.streams.find((x) => x.kind === 'video');
  need(audioStream && videoStream, 'Both source streams required');
  const aPlan = original.plan.streams.find((x) => x.kind === 'audio'),
    vPlan = original.plan.streams.find((x) => x.kind === 'video');
  need(aPlan && vPlan && audioStream.sampleRate === 48000, 'First output profile: 48 kHz original');
  return {
    source,
    original,
    duration,
    count,
    video,
    audio,
    audioStream,
    videoStream,
    aPlan,
    vPlan,
  };
}
function locate(list, at) {
  const clip = list.find(
    (c) => compare(c.start, at) <= 0 && compare(at, add(c.start, c.duration)) < 0,
  );
  need(clip, 'No clip at timeline time');
  return clip;
}

export async function timelineVideo(plan, signal) {
  const video = await createVideoWindow(plan.original.bytes, signal);
  return {
    clock: video.clock,
    evidence: video.evidence,
    dispose: video.dispose,
    frameAt: (at, caller) => {
      const clip = locate(plan.video, at);
      const raw = subtract(
        add(clip.sourceIn, subtract(at, clip.start)),
        plan.videoStream.presentationOrigin,
      );
      return video.frameAt(raw, caller);
    },
  };
}
export async function timelinePcm(plan, signal) {
  const index = await createPcmFile(plan.original.bytes, signal, {
    originalHash: plan.source.asset.sha256,
    streamId: plan.audioStream.id,
    decodePolicy: 'native-aac-continuous-v0',
  });
  const lease = index.acquire(),
    renderer = new PcmRenderSession(lease, 'edge-hold-v0');
  let disposal;
  return {
    evidence: index.evidence,
    async render(first, end, caller) {
      need(
        Number.isSafeInteger(first) && end > first && end - first <= 4096 && end <= plan.count,
        'Timeline PCM range',
      );
      const planes = [new Float32Array(end - first), new Float32Array(end - first)];
      for (let cursor = first; cursor < end; ) {
        const clip = locate(plan.audio, time(cursor, rate));
        const clipEnd = add(clip.start, clip.duration),
          last = Math.min(end, sampleIndex(clipEnd, rate));
        const chunk = await renderer.render(
          {
            start: clip.start,
            end: clipEnd,
            sourceStart: add(plan.aPlan.mediaStart, time(clip.sampleIn, rate)),
            speed: time(1),
          },
          cursor,
          last,
          rate,
          rate,
          { start: plan.aPlan.mediaStart, end: plan.aPlan.mediaEnd },
          2,
          caller,
        );
        for (let ch = 0; ch < 2; ch++) planes[ch].set(chunk.planes[ch], cursor - first);
        cursor = last;
      }
      for (const plane of planes)
        for (const value of plane)
          need(
            Number.isFinite(value) && Math.abs(value) <= 1,
            'PCM outside unclipped encoder range',
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
