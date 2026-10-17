import { observeCodecInputs } from '../../../video-core/experiments/pcm-wasm-m2/codec-inputs.mjs';
import {
  ConsumerOwner,
  m2PcmDiagnostics,
} from '../../../video-core/experiments/pcm-wasm-m2/owners';
import { addOwnedAudio } from '../../../video-core/experiments/pcm-wasm-m2/output.mjs';
import {
  Output,
  Mp4OutputFormat,
  AudioSampleSource,
  VideoSampleSource,
  VideoSample,
} from 'mediabunny';
import { boundedTarget } from '../indexed-media/bounded-target.mjs';
import { playTimeline } from './playback-v2.mjs';
import { registerAacEncoder } from '@mediabunny/aac-encoder';
import { time, frameTime, compare } from '@editor-platform/video-core';
import {
  timelinePlanV2 as timelinePlan,
  timelinePcmV2 as timelinePcm,
  timelineVideoV2 as timelineVideo,
  drawContainedV2,
} from './timeline-v2.mjs';
import { videoIntervalV1 } from '../file-source/timing-v1';
export { timelinePlanV2 } from './timeline-v2.mjs';
import { mp4Index } from '../mp4-index.mjs';
import { abortable } from '../native-video.mjs';
import { beginEncoding, endEncoding, closeOwnedEncoders } from '../encoder-state.mjs';
import { correctMetadata } from '../file-source/encoder-timing-v1.mjs';
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
export const productCodecV2 = {
  provenance: renderProvenance,
  play: playTimeline,

  async preview(snapshot, at, canvas, caller) {
    const plan = timelinePlan(snapshot),
      decoded = await timelineVideo(plan, caller);
    try {
      const row = await decoded.frameAt(at, caller);
      try {
        caller.throwIfAborted();
        const geometry = drawContainedV2(canvas, row, plan.output, true);
        return {
          sequence: at,
          sourceId: row?.sourceId,
          sourcePts: row?.pts,
          sourceScale: row?.scale,
          geometry,
          mode: 'exact-indexed',
        };
      } finally {
        row?.release();
      }
    } finally {
      await decoded.dispose();
    }
  },
  async encode(snapshot, caller) {
    const signal = globalThis.AbortSignal.any([caller, globalThis.AbortSignal.timeout(600000)]),
      plan = timelinePlan(snapshot);
    signal.throwIfAborted();
    const state = beginEncoding(plan.count);
    const codecInputs = observeCodecInputs(state);
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
    const pcmOutput = new ConsumerOwner('export', 256 * 1024);
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
      const staged = boundedTarget(64 * 1024 * 1024);
      output = new Output({
        format: new Mp4OutputFormat({ fastStart: false }),
        target: staged.target,
      });
      output.setMetadataTags({
        comment: JSON.stringify({
          profile: 'bounded-multisource-sdr-av-v2',
          boundary: profile,
          filter: 'blackman-windowed-sinc-v0',
          snapshotHash: snapshot.hash,
          originals: plan.content.sources.map((s) => s.asset.sha256),
          output: plan.output,
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
      const canvas = new globalThis.OffscreenCanvas(plan.output.width, plan.output.height),
        frames = plan.frames,
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
            await abortable(
              own(
                addOwnedAudio(audio, chunk, pcmOutput, (pcm, hash) => {
                  for (const v of pcm) peak = Math.max(peak, Math.abs(v));
                  firstPcm ??= [pcm[0], pcm[1]];
                  lastPcm = [pcm[pcm.length - 2], pcm[pcm.length - 1]];
                  chunkEvidence.push({ first: audioCursor, end, hash });
                }),
              ),
              signal,
            );
            audioCursor = end;
          }
          const geometry = drawContainedV2(canvas, row, plan.output);
          const sample = new VideoSample(canvas, {
            timestamp: number(at),
            duration: number(videoIntervalV1(i, fps, plan.duration).duration),
          });
          try {
            await abortable(own(video.add(sample)), signal);
          } finally {
            sample.close();
          }
          signal.throwIfAborted();
          frameEvidence.push({
            outputFrame: i,
            sourceId: row?.sourceId,
            sourcePts: row?.pts,
            sourceScale: row?.scale,
            geometry,
          });
        } finally {
          row?.release();
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
        presentationEnd: plan.duration,
        frames,
      });
      const bytes = new globalThis.Blob([corrected.buffer], { type: 'video/mp4' });
      const evidence = {
        profile: 'bounded-multisource-sdr-av-v2',
        boundary: profile,
        filter: 'blackman-windowed-sinc-v0',
        snapshotHash: snapshot.hash,
        revision: snapshot.native.revision,
        originals: plan.content.sources.map((s) => s.asset.sha256),
        output: plan.output,
        rate,
        channels: 1,
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
        pcmBackend: m2PcmDiagnostics(),
        codecInputs,
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
        pcmOutput.close();
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
    need(
      compare(time(index.movieDuration, index.movieScale), plan.duration) === 0,
      'Output exact movie interval',
    );
    for (const t of [audio, video])
      need(
        t.presentationStart === 0 && compare(time(t.span, index.movieScale), plan.duration) === 0,
        'Output track presentation interval',
      );
    need(audio.mediaStart === 1024 && audio.scale === rate, 'Output AAC edit/clock');
    need(video.samples.length === plan.frames, 'Output frame count');
    need(renderProvenance(bytes)?.snapshotHash === snapshot.hash, 'Output render provenance');
    need(
      JSON.stringify(renderProvenance(bytes)?.output) === JSON.stringify(plan.output),
      'Output composition provenance',
    );
    signal.throwIfAborted();
  },
};
