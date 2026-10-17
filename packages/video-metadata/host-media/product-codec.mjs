import {
  Output,
  Mp4OutputFormat,
  AudioSampleSource,
  AudioSample,
  VideoSampleSource,
  VideoSample,
} from 'mediabunny';
import { boundedTarget } from './indexed-media/bounded-target.mjs';
import { playTimeline, chunkHash } from './indexed-media/playback.mjs';
import { registerAacEncoder } from '@mediabunny/aac-encoder';
import { time, frameTime, sampleIndex } from '@editor-platform/video-core';
import { timelinePlan, timelinePcm, timelineVideo } from './indexed-media/timeline.mjs';
export { timelinePlan } from './indexed-media/timeline.mjs';
import { mp4Index } from './mp4-index.mjs';
import { abortable } from './native-video.mjs';
import { beginEncoding, endEncoding, closeOwnedEncoders } from './encoder-state.mjs';
import { correctMetadata } from './encoder-timing.mjs';
registerAacEncoder();
const need = (ok, msg) => {
  if (!ok) throw Error(msg);
};
const rate = 48000,
  fps = time(25),
  profile = 'edge-hold-v0';
const number = (t) => t.value / t.timescale;
const provenance = new WeakMap();
export function renderProvenance(bytes) {
  return provenance.get(bytes);
}
export const productCodec = {
  provenance: renderProvenance,
  play: playTimeline,
  async preview(snapshot, at, canvas, caller) {
    const plan = timelinePlan(snapshot),
      decoded = await timelineVideo(plan, caller);
    try {
      const row = await decoded.frameAt(at, caller);
      try {
        caller.throwIfAborted();
        canvas.width = 320;
        canvas.height = 180;
        canvas.getContext('2d').drawImage(row.frame, 0, 0, 320, 180);
        return {
          sequence: at,
          sourcePts: row.pts,
          sourceScale: decoded.clock.scale,
          mode: 'exact-indexed',
        };
      } finally {
        row.release();
      }
    } finally {
      await decoded.dispose();
    }
  },
  async encode(snapshot, caller) {
    const signal = globalThis.AbortSignal.any([caller, globalThis.AbortSignal.timeout(120000)]),
      plan = timelinePlan(snapshot, 10);
    signal.throwIfAborted();
    const state = beginEncoding(plan.count);
    let decoded,
      renderer,
      output,
      outputClosed = false,
      cancelPromise,
      finalization;
    const cleanupErrors = new Set(),
      cleanupWork = new Set();
    let primaryError,
      failed = false,
      completedBytes;
    const cleanup = (action) => {
      const task = Promise.resolve()
        .then(action)
        .catch((e) => {
          cleanupErrors.add(e);
        });
      cleanupWork.add(task);
      return task;
    };
    const pendingWork = new Set();
    const own = (promise) => {
      pendingWork.add(promise);
      promise.then(
        () => pendingWork.delete(promise),
        () => pendingWork.delete(promise),
      );
      return promise;
    };
    // Pinned private adapter: own each track close/flush, not only Output's
    // fail-fast Promise.all. Both promises remain in the job even if one rejects.
    const ownTrack = (source) => {
      const flush = source._flushAndClose;
      need(typeof flush === 'function', 'Pinned source lifecycle shape');
      source._flushAndClose = (...args) =>
        own(Promise.resolve().then(() => flush.apply(source, args)));
      return source;
    };
    const cancel = () => {
      cleanup(() => renderer?.dispose());
      cleanup(() => decoded?.dispose());
      cleanup(() => closeOwnedEncoders(state));
      if (output && !outputClosed)
        cleanup(() => {
          cancelPromise ??= output.cancel();
          return cancelPromise;
        });
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      decoded = await timelineVideo(plan, signal);
      renderer = await timelinePcm(plan, signal);
      let firstPcm,
        lastPcm,
        peak = 0,
        audioCursor = 0;
      const chunkEvidence = [];
      const staged = boundedTarget();
      output = new Output({
        format: new Mp4OutputFormat({ fastStart: false }),
        target: staged.target,
      });
      output.setMetadataTags({
        comment: JSON.stringify({
          profile: 'known-sdr-av-v0',
          boundary: profile,
          filter: 'blackman-windowed-sinc-v0',
          snapshotHash: snapshot.hash,
          original: plan.source.asset.sha256,
          rate,
          count: plan.count,
        }),
      });
      const audio = ownTrack(new AudioSampleSource({ codec: 'aac', bitrate: 192000 })),
        video = ownTrack(new VideoSampleSource({ codec: 'avc', bitrate: 4000000 }));
      output.addAudioTrack(audio);
      output.addVideoTrack(video);
      await abortable(own(output.start()), signal);
      signal.throwIfAborted();
      const canvas = new globalThis.OffscreenCanvas(1920, 1080),
        ctx = canvas.getContext('2d'),
        frames = sampleIndex(plan.duration, 25),
        frameEvidence = [];
      for (let i = 0; i < frames; i++) {
        const at = frameTime(i, fps),
          row = await decoded.frameAt(at, signal);
        try {
          signal.throwIfAborted();
          const audioEnd = Math.min(plan.count, Math.round(((i + 1) * rate) / 25));
          while (audioCursor < audioEnd) {
            const end = Math.min(audioCursor + 4096, audioEnd),
              chunk = await renderer.render(audioCursor, end, signal);
            const pcm = new Float32Array((end - audioCursor) * 2);
            for (let j = 0; j < end - audioCursor; j++)
              for (let ch = 0; ch < 2; ch++) {
                const v = chunk.planes[ch][j];
                pcm[j * 2 + ch] = v;
                peak = Math.max(peak, Math.abs(v));
              }
            firstPcm ??= Array.from(pcm.slice(0, 2));
            lastPcm = Array.from(pcm.slice(-2));
            chunkEvidence.push({ first: audioCursor, end, hash: await chunkHash(chunk) });
            const audioSample = new AudioSample({
              data: pcm,
              format: 'f32',
              numberOfChannels: 2,
              sampleRate: rate,
              timestamp: audioCursor / rate,
            });
            try {
              await abortable(own(audio.add(audioSample)), signal);
            } finally {
              audioSample.close();
            }
            audioCursor = end;
          }
          ctx.drawImage(row.frame, 0, 0, 1920, 1080);
          const sample = new VideoSample(canvas, { timestamp: number(at), duration: 1 / 25 });
          try {
            await abortable(own(video.add(sample)), signal);
          } finally {
            sample.close();
          }
          signal.throwIfAborted();
          frameEvidence.push({
            outputFrame: i,
            sourcePts: row.pts,
            sourceScale: decoded.clock.scale,
          });
        } finally {
          row.release();
        }
      }
      // Cancellation of our wait does not cancel the library's finalization.
      // Keep the actual promise owned until encoder flush/close has settled.
      finalization = own(output.finalize());
      await abortable(finalization, signal);
      signal.throwIfAborted();
      outputClosed = true;
      const corrected = correctMetadata(staged.read(), {
        rate,
        count: plan.count,
        origin: 0,
        rawPackets: state.rawPackets,
      });
      const bytes = new globalThis.Blob([corrected.buffer], { type: 'video/mp4' });
      const evidence = {
        profile: 'known-sdr-av-v0',
        boundary: profile,
        filter: 'blackman-windowed-sinc-v0',
        snapshotHash: snapshot.hash,
        revision: snapshot.native.revision,
        original: plan.source.asset.sha256,
        rate,
        channels: 2,
        count: plan.count,
        fps,
        frameEvidence,
        timing: corrected.evidence,
        outputStaging: staged.evidence(),
        firstPcm,
        lastPcm,
        peak,
        chunkEvidence,
        pcmReader: renderer.evidence,
        videoReader: decoded.evidence,
      };
      provenance.set(bytes, evidence);
      completedBytes = bytes;
    } catch (error) {
      primaryError = error;
      failed = true;
    } finally {
      signal.removeEventListener('abort', cancel);
      // No cleanup failure may skip an independent resource or release ownership early.
      cleanup(() => renderer?.dispose());
      cleanup(() => decoded?.dispose());
      cleanup(() => closeOwnedEncoders(state));
      if (output && !outputClosed)
        cleanup(() => {
          cancelPromise ??= output.cancel();
          return cancelPromise;
        });
      if (finalization) cleanup(() => finalization);
      try {
        await Promise.all([...cleanupWork]);
        await Promise.allSettled([...pendingWork]);
        await cleanup(() => closeOwnedEncoders(state));
      } finally {
        endEncoding(state);
      }
    }
    if (cleanupErrors.size)
      throw new globalThis.AggregateError(
        [...(failed ? [primaryError] : []), ...cleanupErrors],
        'Video job cleanup failed after all resources settled',
      );
    if (failed) throw primaryError;
    return completedBytes;
  },
  async verify(bytes, snapshot, signal) {
    signal.throwIfAborted();
    const plan = timelinePlan(snapshot),
      buffer = await bytes.arrayBuffer();
    signal.throwIfAborted();
    const index = mp4Index(buffer),
      audio = index.tracks.find((t) => t.kind === 'soun'),
      video = index.tracks.find((t) => t.kind === 'vide');
    need(index.tracks.length === 2 && audio && video, 'Output A/V tracks');
    need(index.movieScale === rate && index.movieDuration === plan.count, 'Output movie interval');
    for (const t of [audio, video])
      need(
        t.presentationStart === 0 && t.span === plan.count,
        'Output track presentation interval',
      );
    need(audio.mediaStart === 1024 && audio.scale === rate, 'Output AAC edit/clock');
    need(video.samples.length === sampleIndex(plan.duration, 25), 'Output frame count');
    need(renderProvenance(bytes)?.snapshotHash === snapshot.hash, 'Output render provenance');
    signal.throwIfAborted();
  },
};
