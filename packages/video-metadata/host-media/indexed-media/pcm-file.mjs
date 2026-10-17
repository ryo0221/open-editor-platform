import { mp4ProbeAudioV2 } from '../m2/audio-profile-v2.ts';
import { mp4ProbeV1 } from '../file-source/probe-v1.ts';
import { mp4Probe } from '../mp4-probe';
import { reserveScratch, ownRead } from './scratch.mjs';
import { Input, BlobSource, ALL_FORMATS, EncodedPacketSink } from 'mediabunny';
import { mp4Index } from '../mp4-index.mjs';
import { metadataBlob } from './metadata.ts';
import { abortable, micros } from '../native-video.mjs';
import { WindowCollector } from '../../../video-core/experiments/pcm-renderer/render.ts';
const need = (ok, message) => {
  if (!ok) throw Error(message);
};
/** Continuous decode once; range reads thereafter. Disposable derived PCM, never original replacement. */
let preflight = false;
export async function createPcmFile(original, caller, identity, sourceProfile = 'baseline') {
  if (preflight) throw Error('PCM preflight admission');
  preflight = true;
  try {
    return await openPcmFile(original, caller, identity, sourceProfile);
  } finally {
    preflight = false;
  }
}
async function openPcmFile(original, caller, identity, sourceProfile) {
  const audioOnly = sourceProfile === 'aac-mono-v2',
    v1 = sourceProfile === 'iphone-sdr-v1' || audioOnly;
  caller.throwIfAborted();
  need(
    identity &&
      /^[a-f0-9]{64}$/.test(identity.originalHash) &&
      identity.decodePolicy === (v1 ? 'native-aac-continuous-v1' : 'native-aac-continuous-v0'),
    'PCM immutable identity',
  );
  identity = Object.freeze({ ...identity });
  const metadata = await metadataBlob(original, caller),
    index = mp4Index(await metadata.arrayBuffer(), {
      maximumSampleBytes: 1024 * 1024,
      fileBytes: original.size,
      sourceProfile: v1 ? 'iphone-sdr-v1' : sourceProfile,
    });
  const probed = await (audioOnly ? mp4ProbeAudioV2 : v1 ? mp4ProbeV1 : mp4Probe).inspect(
    metadata,
    caller,
  );
  caller.throwIfAborted();
  const clock = index.tracks.find((t) => t.kind === 'soun');
  need(
    clock && (v1 ? [44100, 48000].includes(clock.scale) : clock.scale === 48000),
    'Indexed AAC rate profile',
  );
  const rate = clock.scale,
    channels = v1 ? 1 : 2,
    stride = channels * 4;
  const firstSample = v1 ? 0 : clock.mediaStart;
  const selected = probed.streams.find((s) => s.kind === 'audio');
  need(selected && selected.sampleRate === rate, 'PCM probed clock');
  need(String(clock.id) === identity.streamId, 'PCM stream identity');
  const span = BigInt(clock.span) * BigInt(clock.scale);
  if (!v1) need(span % BigInt(index.movieScale) === 0n, 'PCM integer presentation samples');
  const end = v1
    ? clock.samples.at(-1).pts + clock.samples.at(-1).duration
    : clock.mediaStart + Number(span / BigInt(index.movieScale));
  need(Number.isSafeInteger(end) && end - firstSample <= rate * 300, 'PCM file sample quota');
  const root = await globalThis.navigator.storage.getDirectory();
  caller.throwIfAborted();
  const reservation = reserveScratch((end - firstSample) * stride),
    name = reservation.id;
  let fileHandle;
  try {
    fileHandle = await root.getFileHandle(name, { create: true });
  } catch (e) {
    reservation.release();
    throw e;
  }
  let writer,
    input,
    decoder,
    error,
    inputClosed = false,
    writerClosed = false,
    tail = Promise.resolve(),
    cursor = firstSample,
    bytesPending = 0,
    maxPending = 0,
    callbackCount = 0,
    maxTimestampDeltaUs = 0,
    maxDecodeQueue = 0,
    maxOutstanding = 0;
  const byTime = new Map(),
    controller = new globalThis.AbortController(),
    signal = controller.signal;
  const stop = () => {
    controller.abort(caller.reason);
    if (decoder && decoder.state !== 'closed') decoder.close();
    if (input && !inputClosed) {
      inputClosed = true;
      input.dispose();
    }
  };
  caller.addEventListener('abort', stop, { once: true });
  const check = () => {
    caller.throwIfAborted();
    signal.throwIfAborted();
    if (error) throw error;
  };
  let retained = false;
  try {
    check();
    writer = await fileHandle.createWritable();
    check();
    input = new Input({
      source: new BlobSource(original, { maxCacheSize: 1024 * 1024, useStreamReader: false }),
      formats: ALL_FORMATS,
    });
    check();
    const track = await abortable(input.getPrimaryAudioTrack(), signal);
    check();
    need(track, 'No audio track');
    const config = await abortable(track.getDecoderConfig(), signal);
    check();
    need(
      config?.codec === 'mp4a.40.2' &&
        config.numberOfChannels === channels &&
        config.sampleRate === rate,
      'PCM source format',
    );
    need(
      (await abortable(globalThis.AudioDecoder.isConfigSupported(config), signal)).supported,
      'AAC unsupported',
    );
    check();
    decoder = new globalThis.AudioDecoder({
      error: (e) => {
        error = e;
      },
      output: (audio) => {
        try {
          check();
          // AAC-LC callbacks are matched in decode order to verified integer
          // packet/sample indices. Rounded microseconds are only a consistency check.
          const expectedTimestamp = byTime.keys().next().value;
          const row = byTime.get(expectedTimestamp);
          need(row, 'Unexpected AAC callback');
          const delta = Math.abs(audio.timestamp - expectedTimestamp);
          need(delta <= 1, 'AAC callback timestamp/order mismatch');
          maxTimestampDeltaUs = Math.max(maxTimestampDeltaUs, delta);
          byTime.delete(expectedTimestamp);
          need(
            audio.numberOfChannels === channels &&
              audio.sampleRate === rate &&
              (audio.numberOfFrames === row.duration ||
                (row === clock.samples.at(-1) && audio.numberOfFrames >= row.duration)) &&
              audio.numberOfFrames <= 4096,
            'PCM callback shape',
          );
          const first = Math.max(row.pts, firstSample),
            last = Math.min(row.pts + audio.numberOfFrames, end);
          if (last <= first) return;
          need(first === cursor, 'Missing/duplicate PCM coverage');
          const planes = Array.from({ length: channels }, () => new Float32Array(last - first));
          for (let ch = 0; ch < channels; ch++)
            audio.copyTo(planes[ch], {
              planeIndex: ch,
              format: 'f32-planar',
              frameOffset: first - row.pts,
              frameCount: last - first,
            });
          const interleaved = new Float32Array((last - first) * channels);
          for (let i = 0; i < last - first; i++)
            for (let ch = 0; ch < channels; ch++) {
              need(Number.isFinite(planes[ch][i]), 'Nonfinite PCM');
              interleaved[i * channels + ch] = planes[ch][i];
            }
          bytesPending += interleaved.byteLength;
          maxPending = Math.max(maxPending, bytesPending);
          need(bytesPending <= 256 * 1024, 'PCM write backpressure quota');
          tail = tail.then(async () => {
            check();
            await writer.write(new Uint8Array(interleaved.buffer));
            bytesPending -= interleaved.byteLength;
          });
          tail.catch((e) => {
            error = e;
          });
          cursor = last;
          callbackCount++;
        } catch (e) {
          error = e;
        } finally {
          audio.close();
        }
      },
    });
    check();
    decoder.configure(config);
    check();
    let i = 0;
    const sink = new EncodedPacketSink(track);
    for (
      let packet = await abortable(sink.getFirstPacket(), signal);
      packet;
      packet = await abortable(sink.getNextPacket(packet), signal)
    ) {
      check();
      need(i < clock.samples.length && packet.sequenceNumber === i, 'AAC packet identity');
      const row = clock.samples[i++],
        timestamp = micros(row.pts, clock.scale);
      need(
        packet.data.length <= 1024 * 1024 && byTime.size < 16 && !byTime.has(timestamp),
        'AAC packet budget/timestamp',
      );
      need(row.pts === row.dts, 'AAC composition reordering outside profile');
      byTime.set(timestamp, row);
      maxOutstanding = Math.max(maxOutstanding, byTime.size);
      decoder.decode(
        new globalThis.EncodedAudioChunk({
          type: packet.type,
          timestamp,
          duration: micros(row.duration, clock.scale),
          data: packet.data,
        }),
      );
      maxDecodeQueue = Math.max(maxDecodeQueue, decoder.decodeQueueSize);
      while (decoder.decodeQueueSize >= 8) {
        check();
        await abortable(
          new Promise((r) => decoder.addEventListener('dequeue', r, { once: true })),
          signal,
        );
        check();
      }
      await tail;
      check();
    }
    need(i === clock.samples.length, 'AAC table coverage');
    await abortable(decoder.flush(), signal);
    check();
    await tail;
    check();
    need(cursor === end && byTime.size === 0, 'Terminal PCM coverage');
    decoder.close();
    input.dispose();
    inputClosed = true;
    await writer.close();
    writerClosed = true;
    check();
    const file = await fileHandle.getFile();
    check();
    need(file.size === (end - firstSample) * stride, 'PCM file byte coverage');
    retained = true;
    reservation.ready();
    let disposed = false,
      closing = false,
      leases = 0,
      reads = 0,
      disposal,
      finishDisposal,
      failDisposal;
    const remove = () => {
      if (closing && !leases && !reads && !disposed) {
        disposed = true;
        root.removeEntry(name).then(() => {
          reservation.release();
          finishDisposal();
        }, failDisposal);
      }
    };
    const frozenIdentity = Object.freeze({
      ...identity,
      generation: name,
      streamId: String(clock.id),
      byteLength: original.size,
    });
    const result = {
      identity: frozenIdentity,
      valid: { first: firstSample, end, rate, channels },
      evidence: {
        packets: i,
        maxTimestampDeltaUs,
        maxDecodeQueue,
        maxOutstanding,
        callbackCount,
        fileBytes: file.size,
        maxPendingWriteBytes: maxPending,
        sourceCacheBytes: 1024 * 1024,
        decodeFromPacket: 0,
        repeatedPrefixDecodes: 0,
      },
      async decode(plan, signal) {
        signal.throwIfAborted();
        need(!closing && !disposed, 'PCM index disposed');
        need(
          plan.rate === rate &&
            plan.channels === channels &&
            plan.first >= firstSample &&
            plan.end <= end &&
            plan.end - plan.first <= 32768,
          'PCM read range',
        );
        const releaseRead = ownRead();
        reads++;
        try {
          const bytes = await file
            .slice((plan.first - firstSample) * stride, (plan.end - firstSample) * stride)
            .arrayBuffer();
          signal.throwIfAborted();
          need(!disposed, 'PCM index disposed');
          const data = new Float32Array(bytes),
            collector = new WindowCollector(plan);
          try {
            for (let first = plan.first; first < plan.end; first += 4096) {
              const last = Math.min(first + 4096, plan.end),
                planes = Array.from({ length: channels }, () => new Float32Array(last - first));
              for (let i = first; i < last; i++)
                for (let ch = 0; ch < channels; ch++)
                  planes[ch][i - first] = data[(i - plan.first) * channels + ch];
              collector.push({ first, rate, planes });
            }
            return collector.finish();
          } finally {
            collector.release();
          }
        } finally {
          releaseRead();
          reads--;
          remove();
        }
      },
      acquire() {
        need(!closing && !disposed, 'PCM lease closed');
        leases++;
        let released = false;
        return {
          decode: (plan, signal) => {
            need(!released, 'PCM lease released');
            return result.decode(plan, signal);
          },
          release() {
            if (!released) {
              released = true;
              leases--;
              remove();
            }
          },
        };
      },
      dispose() {
        if (!disposal) {
          disposal = new Promise((resolve, reject) => {
            finishDisposal = resolve;
            failDisposal = reject;
          });
          closing = true;
          remove();
        }
        return disposal;
      },
    };
    return result;
  } finally {
    caller.removeEventListener('abort', stop);
    if (decoder && decoder.state !== 'closed') decoder.close();
    if (input && !inputClosed) input.dispose();
    await tail.catch(() => {});
    if (writer && !writerClosed) await writer.abort().catch(() => {});
    if (!retained) {
      await root.removeEntry(name);
      reservation.release();
    }
  }
}
