// Private adapter for the reviewed fixed 1.61.3 experiment. No package dependency adoption.
import { Input, BufferSource, ALL_FORMATS, EncodedPacketSink } from 'mediabunny';
import { savedTiming } from '../local-codec/browser-aac.mjs';
import { WindowCollector, prefixEnd } from '../../src/pcm/render.ts';
const need = (ok, message) => {
  if (!ok) throw Error(message);
};
const micros = (n, d) => Number((BigInt(n) * 1000000n) / BigInt(d));
const LIMITS = {
  originalBytes: 16 * 1024 * 1024,
  queue: 8,
  outstanding: 16,
  packetBytes: 1024 * 1024,
  deadlineMs: 10000,
};
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => {
        cleanup();
        reject(signal.reason);
      },
      cleanup = () => signal.removeEventListener('abort', aborted);
    // Always observe the supplied promise, even when cancellation already won.
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', aborted, { once: true });
    promise.then(
      (v) => {
        cleanup();
        resolve(v);
      },
      (e) => {
        cleanup();
        reject(e);
      },
    );
  });
}
/** Reset + bounded prefix preroll on every request, one terminal flush, never resume after it. */
export async function decodeWindow(
  buffer,
  plan,
  caller,
  { onConfigured, onSubmitted, onClosed } = {},
) {
  caller.throwIfAborted();
  need(buffer.byteLength > 0 && buffer.byteLength <= LIMITS.originalBytes, 'Original byte budget');
  const timing = savedTiming(buffer, { rationalEdges: true });
  need(plan.rate === timing.mediaScale, 'Source clock mismatch');
  need(
    BigInt(plan.first) >= BigInt(timing.validStart) &&
      BigInt(plan.end - 1) * timing.validEnd.d < timing.validEnd.n,
    'Window outside original valid presentation',
  );
  const finalIndex = prefixEnd(timing.samples, plan.end);
  const collector = new WindowCollector(plan),
    control = new globalThis.AbortController(),
    signal = control.signal,
    byTimestamp = new Map(),
    seen = new Set();
  let input,
    decoder,
    callbackError,
    submitted = 0,
    maxQueue = 0,
    maxOutstanding = 0,
    delivered = 0,
    inputDisposed = false;
  const cancel = () => control.abort(caller.reason);
  caller.addEventListener('abort', cancel, { once: true });
  const dispose = () => {
    // Reinspect current owners on every pass: cancellation may precede assignment
    // of a resource whose constructor synchronously notified the abort listener.
    if (decoder && decoder.state !== 'closed') decoder.close();
    if (input && !inputDisposed) {
      inputDisposed = true;
      input.dispose();
    }
  };
  signal.addEventListener('abort', dispose, { once: true });
  const deadline = globalThis.setTimeout(
    () => control.abort(new globalThis.DOMException('Decode deadline', 'AbortError')),
    LIMITS.deadlineMs,
  );
  const check = () => {
    signal.throwIfAborted();
    if (callbackError) throw callbackError;
  };
  try {
    check();
    input = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
    check();
    const track = await abortable(input.getPrimaryAudioTrack(), signal);
    check();
    need(track, 'No audio');
    const config = await abortable(track.getDecoderConfig(), signal);
    check();
    need(
      config?.codec === 'mp4a.40.2' &&
        config.sampleRate === plan.rate &&
        config.numberOfChannels === plan.channels,
      'AAC profile mismatch',
    );
    need(
      (await abortable(globalThis.AudioDecoder.isConfigSupported(config), signal)).supported,
      'Native AAC unsupported',
    );
    check();
    decoder = new globalThis.AudioDecoder({
      error: (e) => {
        callbackError = e;
      },
      output: (audio) => {
        try {
          if (signal.aborted) return;
          const sample = byTimestamp.get(audio.timestamp);
          need(sample && !seen.has(audio.timestamp), 'Unmapped/duplicate callback timestamp');
          byTimestamp.delete(audio.timestamp);
          seen.add(audio.timestamp);
          need(
            audio.sampleRate === plan.rate &&
              audio.numberOfChannels === plan.channels &&
              audio.numberOfFrames > 0 &&
              audio.numberOfFrames <= 4096,
            'Decoded format/budget',
          );
          const first = Math.max(sample.pts, plan.first),
            end = Math.min(sample.pts + audio.numberOfFrames, plan.end);
          if (end > first) {
            const planes = Array.from(
              { length: plan.channels },
              () => new Float32Array(end - first),
            );
            for (let ch = 0; ch < planes.length; ch++)
              audio.copyTo(planes[ch], {
                planeIndex: ch,
                format: 'f32-planar',
                frameOffset: first - sample.pts,
                frameCount: end - first,
              });
            collector.push({ first, rate: audio.sampleRate, planes });
            delivered += end - first;
          }
        } catch (e) {
          callbackError = e;
        } finally {
          audio.close();
        }
      },
    });
    check();
    decoder.configure(config);
    check();
    // Hooks are local deterministic test controls, never untrusted media callbacks.
    if (onConfigured) await abortable(Promise.resolve(onConfigured()), signal);
    check();
    let index = 0;
    for await (const packet of new EncodedPacketSink(track).packets()) {
      check();
      need(index <= finalIndex && packet.sequenceNumber === index, 'Demux sample identity');
      need(packet.data.byteLength <= LIMITS.packetBytes, 'Encoded packet byte budget');
      const sample = timing.samples[index++],
        timestamp = micros(sample.pts, timing.mediaScale);
      need(!seen.has(timestamp) && !byTimestamp.has(timestamp), 'Ambiguous packet timestamp');
      need(byTimestamp.size < LIMITS.outstanding, 'Outstanding callback budget');
      byTimestamp.set(timestamp, sample);
      decoder.decode(
        new globalThis.EncodedAudioChunk({
          type: 'key',
          timestamp,
          duration: micros(sample.duration, timing.mediaScale),
          data: packet.data,
        }),
      );
      submitted++;
      maxQueue = Math.max(maxQueue, decoder.decodeQueueSize);
      maxOutstanding = Math.max(maxOutstanding, byTimestamp.size);
      if (onSubmitted)
        await abortable(Promise.resolve(onSubmitted({ submitted, finalIndex })), signal);
      check();
      while (decoder.decodeQueueSize >= LIMITS.queue) {
        check();
        await abortable(
          new Promise((resolve) => decoder.addEventListener('dequeue', resolve, { once: true })),
          signal,
        );
        check();
      }
      if (index === finalIndex + 1) break;
    }
    need(submitted === finalIndex + 1, 'Missing demux prefix');
    await abortable(decoder.flush(), signal);
    check();
    const pcm = collector.finish();
    return {
      ...pcm,
      evidence: {
        submitted,
        prerollFromPacket: 0,
        flushes: 1,
        maxQueue,
        maxOutstanding,
        delivered,
        retainedPcmBytes: pcm.planes.reduce((n, p) => n + p.byteLength, 0),
        validEnd: { n: String(timing.validEnd.n), d: String(timing.validEnd.d) },
      },
    };
  } finally {
    globalThis.clearTimeout(deadline);
    caller.removeEventListener('abort', cancel);
    signal.removeEventListener('abort', dispose);
    dispose();
    collector.release();
    byTimestamp.clear();
    seen.clear();
    onClosed?.({
      decoderClosed: !decoder || decoder.state === 'closed',
      inputDisposed: !input || inputDisposed,
    });
  }
}
