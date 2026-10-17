import { Input, BufferSource, ALL_FORMATS, EncodedPacketSink } from 'mediabunny';
import { mp4Index } from './mp4-index.mjs';
export const micros = (n, d) => Number((BigInt(n) * 1000000n) / BigInt(d));
export function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const stop = () => {
      signal.removeEventListener('abort', stop);
      reject(signal.reason);
    };
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', stop);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', stop);
        reject(error);
      },
    );
  });
}
/** First product profile: small originals, at most 64 frames, max 640x360. */
export async function readVideo(buffer, caller) {
  const signal = globalThis.AbortSignal.any([caller, globalThis.AbortSignal.timeout(10000)]);
  signal.throwIfAborted();
  if (buffer.byteLength > 16 * 1024 * 1024) throw Error('Video original quota');
  const index = mp4Index(buffer),
    clocks = index.tracks.filter((t) => t.kind === 'vide');
  if (clocks.length !== 1 || clocks[0].samples.length > 64)
    throw Error('Video frame quota/profile');
  const clock = clocks[0],
    frames = [],
    byTime = new Map();
  let input,
    decoder,
    error,
    inputClosed = false;
  const close = () => {
    if (decoder && decoder.state !== 'closed') decoder.close();
    for (const row of frames) row.frame.close();
    frames.length = 0;
    if (input && !inputClosed) {
      inputClosed = true;
      input.dispose();
    }
  };
  signal.addEventListener('abort', close, { once: true });
  try {
    input = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
    signal.throwIfAborted();
    const track = await abortable(input.getPrimaryVideoTrack(), signal);
    signal.throwIfAborted();
    if (!track) throw Error('Video track absent');
    const config = await abortable(track.getDecoderConfig(), signal);
    signal.throwIfAborted();
    if (
      !config ||
      config.codedWidth <= 0 ||
      config.codedHeight <= 0 ||
      config.codedWidth * 9 !== config.codedHeight * 16 ||
      config.codedWidth > 640 ||
      config.codedHeight > 360 ||
      !config.codec.startsWith('avc1')
    )
      throw Error('Video decoded pixel/profile quota');
    const support = await abortable(globalThis.VideoDecoder.isConfigSupported(config), signal);
    signal.throwIfAborted();
    if (!support.supported) throw Error('Video decoder unsupported');
    decoder = new globalThis.VideoDecoder({
      error: (e) => {
        error = e;
      },
      output: (frame) => {
        const row = byTime.get(frame.timestamp);
        if (
          signal.aborted ||
          error ||
          !row ||
          row.seen ||
          frame.codedWidth > 640 ||
          frame.codedHeight > 360
        ) {
          frame.close();
          error ??= Error('Video timestamp/coverage/profile');
          return;
        }
        row.seen = true;
        frames.push({ frame, pts: row.pts, duration: row.duration });
      },
    });
    signal.throwIfAborted();
    decoder.configure(config);
    signal.throwIfAborted();
    let i = 0;
    for await (const packet of new EncodedPacketSink(track).packets()) {
      signal.throwIfAborted();
      if (error) throw error;
      if (i >= clock.samples.length || packet.data.length > 1024 * 1024)
        throw Error('Video packet budget');
      const row = clock.samples[i++],
        timestamp = micros(row.pts, clock.scale);
      if (byTime.has(timestamp)) throw Error('Video timestamp collision');
      byTime.set(timestamp, { ...row, seen: false });
      decoder.decode(
        new globalThis.EncodedVideoChunk({
          type: packet.type,
          timestamp,
          duration: micros(row.duration, clock.scale),
          data: packet.data,
        }),
      );
    }
    if (i !== clock.samples.length) throw Error('Video packet/index mismatch');
    await abortable(decoder.flush(), signal);
    signal.throwIfAborted();
    if (error) throw error;
    if (frames.length !== clock.samples.length) throw Error('Missing video frame');
    decoder.close();
    input.dispose();
    inputClosed = true;
    frames.sort((a, b) => a.pts - b.pts);
    return { clock, index, frames, close };
  } catch (e) {
    close();
    throw e;
  } finally {
    signal.removeEventListener('abort', close);
  }
}
