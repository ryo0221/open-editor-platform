import { decodedFrameRealm, FRAME_SESSION_CAPACITY } from './frame-budget.ts';
import { mp4ProbeV1 } from '../file-source/probe-v1.ts';
import { mp4Probe } from '../mp4-probe';
import { Input, BlobSource, ALL_FORMATS, EncodedPacketSink } from 'mediabunny';
import { mp4Index } from '../mp4-index.mjs';
import { metadataBlob } from './metadata.ts';
import { abortable, micros } from '../native-video.mjs';
const need = (ok, message) => {
  if (!ok) throw Error(message);
};
function requireIdr(packet, description) {
  const config = new Uint8Array(description);
  need(config.length >= 7 && config[0] === 1, 'AVC configuration');
  const width = (config[4] & 3) + 1,
    data = packet.data;
  let at = 0,
    idr = false;
  while (at < data.length) {
    need(at + width <= data.length, 'AVC NAL size');
    let length = 0;
    for (let i = 0; i < width; i++) length = length * 256 + data[at++];
    need(length > 0 && at + length <= data.length, 'AVC NAL range');
    if ((data[at] & 31) === 5) idr = true;
    at += length;
  }
  need(idr, 'Only independently verified IDR restart is supported');
}
/** One indexed GOP cache; original file and packet reads remain range-backed. */
let sessions = 0;
export function videoStatus() {
  return { sessions };
}
export async function createVideoWindow(original, signal, sourceProfile = 'baseline') {
  need(sessions < 2, 'Video session admission');
  sessions++;
  const budget = decodedFrameRealm.session(FRAME_SESSION_CAPACITY);
  try {
    const value = await openVideoWindow(original, signal, sourceProfile, budget),
      close = value.dispose;
    let disposal;
    value.dispose = () =>
      (disposal ??= close().then(() => {
        budget.close();
        sessions--;
      }));
    return value;
  } catch (e) {
    budget.close();
    sessions--;
    throw e;
  }
}
async function openVideoWindow(original, signal, sourceProfile, budget) {
  const v1 = sourceProfile === 'iphone-sdr-v1',
    maxWidth = v1 ? 1920 : 640,
    maxHeight = v1 ? 1080 : 360,
    maxCodedHeight = v1 ? maxHeight + 32 : maxHeight,
    framePixels = maxWidth * maxCodedHeight,
    frameCost = { pixels: framePixels, bytes: framePixels * 4 };
  const metadata = await metadataBlob(original, signal),
    index = mp4Index(await metadata.arrayBuffer(), {
      maximumSampleBytes: 1024 * 1024,
      fileBytes: original.size,
      sourceProfile,
    });
  await (v1 ? mp4ProbeV1 : mp4Probe).inspect(metadata, signal);
  signal.throwIfAborted();
  const clock = index.tracks.find((t) => t.kind === 'vide');
  need(clock && clock.samples.length <= 25 * 300, 'Video index profile');
  let input,
    decoder,
    disposed = false,
    cache = [],
    keyIndex = -1,
    nextKeyIndex = -1,
    work = Promise.resolve(),
    generation = 0,
    queued = 0,
    cacheReservation;
  const evidence = {
    maxCachedFrames: 0,
    decodedPackets: 0,
    seeks: 0,
    sourceCacheBytes: 1024 * 1024,
  };
  const clear = () => {
    for (const row of cache) row.frame.close();
    cache = [];
    cacheReservation?.release();
    cacheReservation = undefined;
  };
  input = new Input({
    source: new BlobSource(original, { maxCacheSize: 1024 * 1024, useStreamReader: false }),
    formats: ALL_FORMATS,
  });
  try {
    const track = await abortable(input.getPrimaryVideoTrack(), signal);
    signal.throwIfAborted();
    need(track, 'No video');
    const config = await abortable(track.getDecoderConfig(), signal);
    signal.throwIfAborted();
    need(
      config?.codec.startsWith('avc1') &&
        config.codedWidth > 0 &&
        config.codedWidth <= maxWidth &&
        config.codedHeight > 0 &&
        config.codedHeight <= maxHeight &&
        config.codedWidth * 9 === config.codedHeight * 16,
      'Video pixel/profile',
    );
    need(
      (await abortable(globalThis.VideoDecoder.isConfigSupported(config), signal)).supported,
      'Video unsupported',
    );
    signal.throwIfAborted();
    const rotation = await track.getRotation();
    need(v1 ? [0, 90].includes(rotation) : rotation === 0, 'Video orientation profile');
    const sink = new EncodedPacketSink(track);
    async function frameAt(raw, caller) {
      caller.throwIfAborted();
      need(!disposed, 'Video index disposed');
      const target = clock.samples.findIndex(
        (s) =>
          BigInt(s.pts) * BigInt(raw.timescale) <= BigInt(raw.value) * BigInt(clock.scale) &&
          BigInt(s.pts + s.duration) * BigInt(raw.timescale) >
            BigInt(raw.value) * BigInt(clock.scale),
      );
      need(target >= 0, 'Missing source frame interval');
      if (target >= keyIndex && target < nextKeyIndex) {
        const found = cache.find((r) => r.index === target);
        need(found, 'Missing cached frame');
        return found;
      }
      clear();
      const token = ++generation;
      let error;
      const byTime = new Map();
      const check = () => {
        caller.throwIfAborted();
        need(!disposed && generation === token, 'Video seek superseded');
        if (error) throw error;
      };
      const abort = () => {
        if (decoder && decoder.state !== 'closed') decoder.close();
      };
      caller.addEventListener('abort', abort, { once: true });
      try {
        const presentation =
          (clock.samples[target].pts - clock.mediaStart) / clock.scale +
          clock.presentationStart / index.movieScale;
        const first = await abortable(
          sink.getKeyPacket(presentation, { verifyKeyPackets: true }),
          caller,
        );
        check();
        need(
          first && first.sequenceNumber >= 0 && first.sequenceNumber <= target,
          'No verified prior keyframe',
        );
        requireIdr(first, config.description);
        const following = await abortable(
          sink.getNextKeyPacket(first, { verifyKeyPackets: true }),
          caller,
        );
        check();
        const start = first.sequenceNumber,
          end = following?.sequenceNumber ?? clock.samples.length;
        need(
          end > start && end - start <= 64 && target < end,
          'GOP exceeds 64-packet decode bound',
        );
        // Reserve the entire admitted GOP before constructing/configuring the decoder.
        cacheReservation = budget.reserve({
          pixels: frameCost.pixels * (end - start),
          bytes: frameCost.bytes * (end - start),
        });
        decoder = new globalThis.VideoDecoder({
          error: (e) => {
            error = e;
          },
          output: (frame) => {
            const row = byTime.get(frame.timestamp);
            if (
              caller.aborted ||
              disposed ||
              generation !== token ||
              !row ||
              row.seen ||
              frame.codedWidth <= 0 ||
              frame.codedHeight <= 0 ||
              frame.codedWidth > maxWidth ||
              frame.codedHeight > maxCodedHeight ||
              (v1 && (frame.displayWidth > maxWidth || frame.displayHeight > maxHeight)) ||
              cache.length >= end - start
            ) {
              const shape = {
                timestamp: frame.timestamp,
                mapped: !!row,
                seen: row?.seen,
                coded: [frame.codedWidth, frame.codedHeight],
                display: [frame.displayWidth, frame.displayHeight],
                cache: cache.length,
              };
              frame.close();
              error ??= Error('Unmapped video callback: ' + JSON.stringify(shape));
              return;
            }
            row.seen = true;
            cache.push({ ...row, frame });
            evidence.maxCachedFrames = Math.max(evidence.maxCachedFrames, cache.length);
          },
        });
        check();
        decoder.configure(config);
        check();
        let count = 0;
        for (
          let packet = first;
          packet && packet.sequenceNumber < end;
          packet =
            packet.sequenceNumber + 1 < end
              ? await abortable(sink.getNextPacket(packet), caller)
              : null
        ) {
          check();
          need(
            packet.sequenceNumber === start + count &&
              packet.sequenceNumber < end &&
              packet.data.length <= 1024 * 1024,
            'GOP packet identity/budget',
          );
          const sample = clock.samples[packet.sequenceNumber],
            timestamp = micros(sample.pts, clock.scale);
          need(!byTime.has(timestamp), 'Video timestamp collision');
          byTime.set(timestamp, { ...sample, index: packet.sequenceNumber, seen: false });
          decoder.decode(
            new globalThis.EncodedVideoChunk({
              type: packet.type,
              timestamp,
              duration: micros(sample.duration, clock.scale),
              data: packet.data,
            }),
          );
          count++;
        }
        need(count === end - start, 'GOP packet coverage');
        await abortable(decoder.flush(), caller);
        check();
        need(cache.length === count, 'GOP frame coverage');
        decoder.close();
        keyIndex = start;
        nextKeyIndex = end;
        evidence.decodedPackets += count;
        evidence.seeks++;
        const row = cache.find((r) => r.index === target);
        need(row, 'Target frame absent');
        return row;
      } catch (e) {
        generation++;
        // No callback may retain a new frame after its reservation is returned.
        if (decoder && decoder.state !== 'closed') decoder.close();
        clear();
        keyIndex = nextKeyIndex = -1;
        throw e;
      } finally {
        caller.removeEventListener('abort', abort);
        if (decoder && decoder.state !== 'closed') decoder.close();
      }
    }
    let leases = 0,
      releaseDrain;
    const drained = new Promise((r) => {
      releaseDrain = r;
    });
    const leased = (row) => {
      need(!disposed, 'Video index disposed');
      const reservation = budget.reserve(frameCost);
      let frame;
      try {
        frame = row.frame.clone();
      } catch (e) {
        reservation.release();
        throw e;
      }
      let released = false;
      leases++;
      return {
        ...row,
        frame,
        release() {
          if (!released) {
            released = true;
            frame.close();
            reservation.release();
            leases--;
            if (disposed && !leases) releaseDrain();
          }
        },
      };
    };
    return {
      clock,
      rotation,
      evidence,
      frameAt(raw, caller) {
        if (disposed || queued + leases >= 2)
          return Promise.reject(Error('Video request admission'));
        queued++;
        const combined = globalThis.AbortSignal.any([signal, caller]);
        const result = work.then(async () => {
          const row = await frameAt(raw, combined);
          combined.throwIfAborted();
          return leased(row);
        });
        work = result.then(
          () => {
            queued--;
          },
          () => {
            queued--;
          },
        );
        return result;
      },
      async dispose() {
        if (!disposed) {
          disposed = true;
          generation++;
          if (decoder && decoder.state !== 'closed') decoder.close();
          input.dispose();
          await work;
          clear();
          if (!leases) releaseDrain();
          await drained;
        }
      },
    };
  } catch (e) {
    input?.dispose();
    clear();
    throw e;
  }
}
