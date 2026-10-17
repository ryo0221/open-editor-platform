// Isolated saved-MP4 timing reader and WebCodecs experiment, not a product API.
import { Input, BufferSource, ALL_FORMATS, EncodedPacketSink } from 'mediabunny';
function requireValue(ok, message) {
  if (!ok) throw Error(message);
}
function fraction(n, d) {
  n = BigInt(n);
  d = BigInt(d);
  requireValue(d > 0n, 'denominator');
  let a = n < 0n ? -n : n,
    b = d;
  while (b) [a, b] = [b, a % b];
  return { n: n / a, d: d / a };
}
const plus = (a, b) => fraction(a.n * b.d + b.n * a.d, a.d * b.d);
const serial = (q) => ({ numerator: String(q.n), denominator: String(q.d) });
function integer(q) {
  requireValue(q.n % q.d === 0n, 'interval not on decoded sample grid');
  const n = Number(q.n / q.d);
  requireValue(Number.isSafeInteger(n), 'integer overflow');
  return n;
}
function micros(n, d) {
  return Number((BigInt(n) * 1000000n) / BigInt(d));
}
export function savedTiming(buffer, { rationalEdges = false } = {}) {
  const v = new DataView(buffer),
    bytes = new Uint8Array(buffer);
  let boxCount = 0;
  function boxes(lo, hi) {
    const rows = [];
    while (lo < hi) {
      requireValue(++boxCount <= 10000, 'box budget');
      requireValue(lo + 8 <= hi, 'short box');
      let size = v.getUint32(lo),
        header = 8;
      const type = String.fromCharCode(...bytes.subarray(lo + 4, lo + 8));
      if (size === 1) {
        requireValue(lo + 16 <= hi, 'short large box');
        size = Number(v.getBigUint64(lo + 8));
        header = 16;
      }
      if (size === 0) size = hi - lo;
      requireValue(Number.isSafeInteger(size) && size >= header && lo + size <= hi, 'box bounds');
      rows.push({ type, start: lo, p: lo + header, end: lo + size });
      lo += size;
    }
    return rows;
  }
  function one(rows, type) {
    const found = rows.filter((b) => b.type === type);
    requireValue(found.length === 1, 'expected one ' + type);
    return found[0];
  }
  const moov = one(boxes(0, buffer.byteLength), 'moov'),
    top = boxes(moov.p, moov.end),
    mvhd = one(top, 'mvhd');
  function clock(box) {
    const version = v.getUint8(box.p);
    requireValue(version <= 1, 'clock version');
    const at = box.p + (version === 1 ? 20 : 12);
    requireValue(at + 4 <= box.end, 'clock bounds');
    const rate = v.getUint32(at);
    requireValue(rate > 0, 'zero clock');
    return rate;
  }
  const movieScale = clock(mvhd),
    tracks = [];
  for (const trak of top.filter((b) => b.type === 'trak')) {
    const tr = boxes(trak.p, trak.end),
      mdia = one(tr, 'mdia'),
      md = boxes(mdia.p, mdia.end),
      hdlr = one(md, 'hdlr');
    requireValue(hdlr.p + 12 <= hdlr.end, 'handler bounds');
    if (String.fromCharCode(...bytes.subarray(hdlr.p + 8, hdlr.p + 12)) === 'soun')
      tracks.push({ tr, md });
  }
  requireValue(tracks.length === 1, 'experiment needs one audio track');
  const { tr, md } = tracks[0],
    mediaScale = clock(one(md, 'mdhd'));
  const edts = one(tr, 'edts'),
    elst = one(boxes(edts.p, edts.end), 'elst'),
    version = v.getUint8(elst.p),
    count = v.getUint32(elst.p + 4);
  requireValue(version <= 1 && count >= 1 && count <= 2, 'unsupported edit list');
  const width = version === 1 ? 20 : 12;
  requireValue(elst.p + 8 + count * width === elst.end, 'edit bounds');
  let origin = fraction(0, 1),
    valid = null;
  for (let i = 0; i < count; i++) {
    const p = elst.p + 8 + i * width,
      duration = version ? v.getBigUint64(p) : BigInt(v.getUint32(p)),
      media = version ? v.getBigInt64(p + 8) : BigInt(v.getInt32(p + 4)),
      rate = v.getInt32(p + (version ? 16 : 8));
    requireValue(rate === 65536, 'nonunit edit');
    if (media === -1n) {
      requireValue(valid === null && i === 0, 'empty edit order');
      origin = plus(origin, fraction(duration, movieScale));
    } else {
      requireValue(valid === null && media >= 0n, 'multiple/negative media edits');
      valid = {
        start: media,
        end: fraction(media * BigInt(movieScale) + duration * BigInt(mediaScale), movieScale),
        duration,
      };
    }
  }
  requireValue(valid, 'missing media edit');
  const minf = one(md, 'minf'),
    stbl = one(boxes(minf.p, minf.end), 'stbl'),
    stts = one(boxes(stbl.p, stbl.end), 'stts');
  requireValue(v.getUint8(stts.p) === 0, 'stts version');
  const entries = v.getUint32(stts.p + 4);
  requireValue(entries <= 10000 && stts.p + 8 + entries * 8 === stts.end, 'stts bounds');
  const samples = [];
  let pts = 0;
  for (let i = 0; i < entries; i++) {
    const n = v.getUint32(stts.p + 8 + i * 8),
      duration = v.getUint32(stts.p + 12 + i * 8);
    requireValue(duration > 0 && samples.length + n <= 10000, 'sample budget');
    for (let j = 0; j < n; j++) {
      samples.push({ pts, duration });
      pts += duration;
      requireValue(Number.isSafeInteger(pts), 'pts overflow');
    }
  }
  // This AAC profile has no composition offsets. Reject rather than assume if present.
  requireValue(!boxes(stbl.p, stbl.end).some((b) => b.type === 'ctts'), 'audio ctts unsupported');
  return {
    movieScale,
    mediaScale,
    origin,
    validStart: integer(fraction(valid.start, 1)),
    validEnd: rationalEdges ? valid.end : integer(valid.end),
    samples,
  };
}
function present(blocks, timing) {
  let cursor = timing.validStart,
    total = 0;
  const channels = [[], []];
  for (const b of blocks) {
    requireValue(b.rate === timing.mediaScale && b.channels === 2, 'decoded format changed');
    const lo = Math.max(b.pts, timing.validStart),
      hi = Math.min(b.pts + b.frames, timing.validEnd);
    if (hi <= lo) continue;
    requireValue(lo === cursor, 'missing or overlapping decoded interval');
    for (let i = lo; i < hi; i++) {
      const offset = i - b.pts;
      channels[0].push(b.pcm[0][offset]);
      channels[1].push(b.pcm[1][offset]);
    }
    cursor = hi;
    total += hi - lo;
  }
  requireValue(cursor === timing.validEnd, 'missing terminal decoded interval');
  return {
    total,
    peaks: channels.map((values) => {
      let peak = 0,
        value = 0;
      for (let i = 0; i < values.length; i++)
        if (Math.abs(values[i]) > value) {
          value = Math.abs(values[i]);
          peak = i;
        }
      return { peak, value };
    }),
  };
}
export async function decodeSavedAudio(buffer) {
  const timing = savedTiming(buffer),
    input = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS }),
    blocks = [],
    byTimestamp = new Map();
  let decoder, callbackError;
  try {
    const track = await input.getPrimaryAudioTrack();
    requireValue(track, 'no audio');
    const config = await track.getDecoderConfig();
    requireValue(
      config?.codec === 'mp4a.40.2' &&
        config?.sampleRate === timing.mediaScale &&
        config?.numberOfChannels === 2,
      'config mismatch',
    );
    requireValue(
      (await globalThis.AudioDecoder.isConfigSupported(config)).supported,
      'native AAC unsupported',
    );
    decoder = new globalThis.AudioDecoder({
      error: (e) => {
        callbackError = e;
      },
      output: (audio) => {
        try {
          const sample = byTimestamp.get(audio.timestamp);
          requireValue(
            sample,
            'callback timestamp ' +
              audio.timestamp +
              ' has no submitted packet; first=' +
              Array.from(byTimestamp.keys()).slice(0, 5).join(','),
          );
          requireValue(!sample.seen, 'duplicate callback timestamp');
          sample.seen = true;
          const pcm = [
            new Float32Array(audio.numberOfFrames),
            new Float32Array(audio.numberOfFrames),
          ];
          for (let ch = 0; ch < 2; ch++)
            audio.copyTo(pcm[ch], { planeIndex: ch, format: 'f32-planar' });
          blocks.push({
            timestamp: audio.timestamp,
            pts: sample.pts,
            rate: audio.sampleRate,
            frames: audio.numberOfFrames,
            channels: audio.numberOfChannels,
            pcm,
          });
        } catch (e) {
          callbackError = e;
        } finally {
          audio.close();
        }
      },
    });
    decoder.configure(config);
    let index = 0;
    for await (const packet of new EncodedPacketSink(track).packets()) {
      requireValue(index < timing.samples.length, 'extra demux packet');
      requireValue(packet.sequenceNumber === index, 'demux sample identity mismatch');
      const sample = timing.samples[index++],
        timestamp = micros(sample.pts, timing.mediaScale);
      requireValue(!byTimestamp.has(timestamp), 'ambiguous microsecond packet timestamp');
      byTimestamp.set(timestamp, sample);
      decoder.decode(
        new globalThis.EncodedAudioChunk({
          type: 'key',
          timestamp,
          duration: micros(sample.duration, timing.mediaScale),
          data: packet.data,
        }),
      );
      if (decoder.decodeQueueSize > 8)
        await new Promise((resolve) =>
          decoder.addEventListener('dequeue', resolve, { once: true }),
        );
    }
    requireValue(index === timing.samples.length, 'demux omitted raw samples');
    await decoder.flush();
    if (callbackError) throw callbackError;
    const result = present(blocks, timing),
      last = blocks.findLastIndex(
        (b) => b.pts < timing.validEnd && b.pts + b.frames >= timing.validEnd,
      );
    requireValue(last >= 0, 'no terminal block');
    const missing = blocks.map((b, i) =>
      i === last ? { ...b, frames: timing.validEnd - b.pts - 1 } : b,
    );
    let rejectedMissing = false;
    try {
      present(missing, timing);
    } catch {
      rejectedMissing = true;
    }
    requireValue(rejectedMissing, 'one missing sample accepted');
    const active = blocks.findIndex((b) => b.pts + b.frames > timing.validStart);
    const duplicated = [
      ...blocks.slice(0, active + 1),
      blocks[active],
      ...blocks.slice(active + 1),
    ];
    let rejectedDuplicate = false;
    try {
      present(duplicated, timing);
    } catch {
      rejectedDuplicate = true;
    }
    requireValue(rejectedDuplicate, 'overlap accepted');
    return {
      ...result,
      origin: serial(timing.origin),
      validMediaInterval: [timing.validStart, timing.validEnd],
      mediaScale: timing.mediaScale,
      rawCount: blocks.reduce((n, b) => n + b.frames, 0),
      callbacks: blocks.map((b) => ({
        timestamp: b.timestamp,
        pts: b.pts,
        rate: b.rate,
        frames: b.frames,
        channels: b.channels,
      })),
      peakCompositionTimes: result.peaks.map((p) =>
        serial(plus(timing.origin, fraction(p.peak, timing.mediaScale))),
      ),
      rejectedMissing,
      rejectedDuplicate,
    };
  } finally {
    if (decoder && decoder.state !== 'closed') decoder.close();
    input.dispose();
  }
}
