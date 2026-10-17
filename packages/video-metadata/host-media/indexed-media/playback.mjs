import { time, sampleIndex } from '@editor-platform/video-core';
import { timelinePlan, timelinePcm, timelineVideo } from './timeline.mjs';
const rate = 48000,
  quantum = 1920;
const sleep = (signal) =>
  new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const id = globalThis.setTimeout(done, 8);
    function done() {
      signal.removeEventListener('abort', abort);
      resolve();
    }
    function abort() {
      globalThis.clearTimeout(id);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    }
    signal.addEventListener('abort', abort, { once: true });
  });
export async function chunkHash(chunk) {
  const data = new Float32Array((chunk.end - chunk.first) * 2);
  for (let i = 0; i < chunk.end - chunk.first; i++)
    for (let ch = 0; ch < 2; ch++) data[i * 2 + ch] = chunk.planes[ch][i];
  return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data)), (x) =>
    x.toString(16).padStart(2, '0'),
  ).join('');
}
/** Private provisional player. Output timestamp drives picture; currentTime schedules audio only. */
export async function playTimeline(snapshot, at, canvas, caller, report = () => {}) {
  const plan = timelinePlan(snapshot),
    start = sampleIndex(at, rate);
  if (start < 0 || start >= plan.count || start % quantum)
    throw Error('Playback starts on 25 fps grid');
  const context = new globalThis.AudioContext({ sampleRate: rate, latencyHint: 'interactive' });
  const abort = new globalThis.AbortController(),
    signal = globalThis.AbortSignal.any([caller, abort.signal]);
  let pcm,
    video,
    videoWork = Promise.resolve(),
    next = start,
    anchor,
    origin = start,
    scheduledEnd = 0,
    lastDraw = -1,
    stopping = false,
    closing,
    primaryError,
    failed = false,
    failures = [];
  const sources = new Set(),
    evidence = {
      state: 'preparing',
      clock:
        typeof context.getOutputTimestamp === 'function' ? 'output-timestamp' : 'estimated-latency',
      chunks: [],
      frames: [],
      rebuffer: [],
      suspensions: 0,
      maxScheduledSamples: 0,
    };
  const publish = () => report({ ...evidence });
  const stop = () => {
    stopping = true;
    for (const source of sources) {
      try {
        source.stop();
      } catch {
        /* already ended */
      }
      source.disconnect();
    }
    sources.clear();
    closing ??= context.close();
  };
  signal.addEventListener('abort', stop, { once: true });
  const outputClock = () =>
    typeof context.getOutputTimestamp === 'function'
      ? context.getOutputTimestamp().contextTime
      : Math.max(
          0,
          context.currentTime - (context.outputLatency ?? 0) - (context.baseLatency ?? 0),
        );
  const position = (clock = outputClock()) =>
    anchor === undefined
      ? origin
      : Math.min(next, plan.count, origin + Math.max(0, Math.floor((clock - anchor) * rate)));
  try {
    await context.resume();
    signal.throwIfAborted();
    video = await timelineVideo(plan, signal);
    pcm = await timelinePcm(plan, signal);
    signal.throwIfAborted();
    canvas.width = 320;
    canvas.height = 180;
    videoWork = (async () => {
      while (!stopping) {
        signal.throwIfAborted();
        const sample = position(),
          frame = Math.min(Math.floor(sample / quantum), Math.ceil(plan.count / quantum) - 1);
        if (anchor !== undefined && context.state === 'running' && frame !== lastDraw) {
          const row = await video.frameAt(time(frame, 25), signal);
          try {
            signal.throwIfAborted();
            const outputContextTime = outputClock(),
              drawn = position(outputContextTime);
            if (!stopping && Math.floor(drawn / quantum) === frame) {
              canvas.getContext('2d').drawImage(row.frame, 0, 0, 320, 180);
              lastDraw = frame;
              evidence.frames.push({
                frame,
                sample: drawn,
                outputContextTime,
                anchor,
                origin,
                scheduledThrough: next,
                sourcePts: row.pts,
                sourceScale: video.clock.scale,
              });
              publish();
            }
          } finally {
            row.release();
          }
        }
        await sleep(signal);
      }
    })().catch((e) => {
      abort.abort(e);
    });
    while (true) {
      signal.throwIfAborted();
      if (context.state === 'suspended') {
        if (evidence.state !== 'suspended') {
          evidence.suspensions++;
          evidence.state = 'suspended';
          publish();
        }
        await sleep(signal);
        continue;
      }
      if (context.state === 'closed') throw Error('Audio context closed');
      const heard = position();
      if (heard >= plan.count && next === plan.count) {
        evidence.state = 'ended';
        publish();
        break;
      }
      // No silence repair: after a real scheduling gap, wait until the previous
      // valid audio has reached output, freeze at its end, and establish a new origin.
      if (anchor !== undefined && context.currentTime > scheduledEnd && next < plan.count) {
        if (heard < next) {
          await sleep(signal);
          continue;
        }
        evidence.rebuffer.push({ sample: next });
        origin = next;
        anchor = undefined;
        lastDraw = -1;
      }
      if (
        next < plan.count &&
        (anchor === undefined || scheduledEnd - context.currentTime < 0.24)
      ) {
        const end = Math.min(next + quantum, plan.count),
          chunk = await pcm.render(next, end, signal),
          hash = await chunkHash(chunk);
        signal.throwIfAborted();
        if (anchor !== undefined && context.currentTime > scheduledEnd) {
          continue;
        }
        if (anchor === undefined) {
          anchor = context.currentTime + 0.08;
          scheduledEnd = anchor;
        }
        const buffer = context.createBuffer(2, end - next, rate);
        for (let ch = 0; ch < 2; ch++) buffer.copyToChannel(chunk.planes[ch], ch);
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        sources.add(source);
        source.onended = () => {
          sources.delete(source);
          source.disconnect();
        };
        const when = anchor + (next - origin) / rate;
        source.start(when);
        scheduledEnd = when + (end - next) / rate;
        evidence.chunks.push({ first: next, end, when, origin, anchor, hash });
        next = end;
        evidence.maxScheduledSamples = Math.max(
          evidence.maxScheduledSamples,
          Math.ceil((scheduledEnd - context.currentTime) * rate),
        );
        evidence.state = 'playing';
        publish();
      }
      await sleep(signal);
    }
  } catch (error) {
    primaryError = error;
    failed = true;
  } finally {
    signal.removeEventListener('abort', stop);
    stop();
    const settled = await Promise.allSettled(
      [() => videoWork, () => pcm?.dispose(), () => video?.dispose(), () => closing].map((action) =>
        Promise.resolve().then(action),
      ),
    );
    failures = settled.filter((r) => r.status === 'rejected').map((r) => r.reason);
    if (stopping && evidence.state !== 'ended') {
      evidence.state = 'stopped';
      publish();
    }
  }
  if (failures.length)
    throw new globalThis.AggregateError(
      [...(failed ? [primaryError] : []), ...failures],
      'Playback cleanup failed after all resources settled',
    );
  if (failed) throw primaryError;
  return evidence;
}
