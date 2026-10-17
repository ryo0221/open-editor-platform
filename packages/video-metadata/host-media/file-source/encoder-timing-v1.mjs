/** Exact presentation correction of generated output only; coded access units stay byte-identical. */
import { correctMetadata as correctAudio } from '../encoder-timing.mjs';
import { mp4Index } from '../mp4-index.mjs';
import { time, compare, multiply } from '@editor-platform/video-core';
import { videoIntervalV1 } from './timing-v1';
const need = (ok, msg) => {
  if (!ok) throw Error(msg);
};
const gcd = (a, b) => {
  while (b) [a, b] = [b, a % b];
  return a;
};
export function correctMetadata(buffer, options) {
  const { presentationEnd, frames, rate } = options;
  const audio = correctAudio(buffer, options),
    view = new DataView(audio.buffer),
    bytes = new Uint8Array(audio.buffer);
  const before = mp4Index(buffer),
    video = before.tracks.find((t) => t.kind === 'vide');
  need(video && video.samples.length === frames, 'v1 generated video count');
  const scale =
    (BigInt(rate) * BigInt(presentationEnd.timescale)) /
    gcd(BigInt(rate), BigInt(presentationEnd.timescale));
  need(scale <= 0xffffffffn && scale % 25n === 0n, 'v1 output timescale bound');
  const duration = BigInt(presentationEnd.value) * (scale / BigInt(presentationEnd.timescale));
  need(duration > 0n && duration <= 0xffffffffn, 'v1 output duration bound');
  const ticks = Number(duration),
    movieScale = Number(scale),
    runs = [];
  for (let i = 0; i < frames; i++) {
    const row = video.samples[i],
      exact = videoIntervalV1(i, time(25), presentationEnd);
    need(row.pts === row.dts, 'v1 encoded B-frame timing requires separate proof');
    // Check the actual muxer timing against the submitted rational interval first.
    const delta = Math.abs(row.pts / video.scale - exact.start.value / exact.start.timescale);
    const deltaEnd = Math.abs(
      (row.pts + row.duration) / video.scale - exact.end.value / exact.end.timescale,
    );
    need(
      delta <= 1 / video.scale + 1e-9 && deltaEnd <= 1 / video.scale + 1e-9,
      'v1 unexpected encoded video timing',
    );
    const span = multiply(exact.duration, time(movieScale));
    need(span.timescale === 1 && span.value > 0, 'v1 exact frame tick');
    if (runs.at(-1)?.duration === span.value) runs.at(-1).count++;
    else runs.push({ count: 1, duration: span.value });
  }
  const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts']);
  function boxes(lo, hi) {
    const list = [];
    while (lo < hi) {
      need(lo + 8 <= hi, 'v1 generated box');
      const n = view.getUint32(lo);
      need(n >= 8 && lo + n <= hi, 'v1 generated box bounds');
      list.push({
        p: lo,
        d: lo + 8,
        e: lo + n,
        type: String.fromCharCode(...bytes.subarray(lo + 4, lo + 8)),
      });
      lo += n;
    }
    return list;
  }
  const roots = boxes(0, bytes.length),
    moov = roots.find((b) => b.type === 'moov'),
    mdat = roots.find((b) => b.type === 'mdat');
  need(moov && mdat && moov.p > mdat.e - 1, 'v1 generated tail metadata required');
  const top = boxes(moov.d, moov.e),
    mvhd = top.find((b) => b.type === 'mvhd');
  need(mvhd && view.getUint32(mvhd.d) === 0, 'v1 movie header');
  view.setUint32(mvhd.d + 12, movieScale);
  view.setUint32(mvhd.d + 16, ticks);
  let videoStts;
  for (const track of top.filter((b) => b.type === 'trak')) {
    const children = boxes(track.d, track.e),
      mdia = children.find((b) => b.type === 'mdia'),
      md = boxes(mdia.d, mdia.e),
      hdlr = md.find((b) => b.type === 'hdlr'),
      kind = String.fromCharCode(...bytes.subarray(hdlr.d + 8, hdlr.d + 12)),
      tkhd = children.find((b) => b.type === 'tkhd');
    need(view.getUint8(tkhd.d) === 0, 'v1 track header');
    view.setUint32(tkhd.d + 20, ticks);
    const edts = children.find((b) => b.type === 'edts');
    if (edts) {
      const elst = boxes(edts.d, edts.e).find((b) => b.type === 'elst');
      need(view.getUint32(elst.d) === 0 && view.getUint32(elst.d + 4) === 1, 'v1 unit output edit');
      view.setUint32(elst.d + 8, ticks);
    }
    if (kind === 'vide') {
      const mdhd = md.find((b) => b.type === 'mdhd');
      need(view.getUint8(mdhd.d) === 0, 'v1 video header');
      view.setUint32(mdhd.d + 12, movieScale);
      view.setUint32(mdhd.d + 16, ticks);
      const minf = md.find((b) => b.type === 'minf'),
        stbl = boxes(minf.d, minf.e).find((b) => b.type === 'stbl'),
        st = boxes(stbl.d, stbl.e);
      need(!st.some((b) => b.type === 'ctts'), 'v1 unexpected generated composition table');
      videoStts = st.find((b) => b.type === 'stts').p;
    }
  }
  const concat = (parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  };
  function rebuild(b) {
    if (b.p === videoStts) {
      const out = new Uint8Array(16 + runs.length * 8),
        v = new DataView(out.buffer);
      v.setUint32(0, out.length);
      out.set([115, 116, 116, 115], 4);
      v.setUint32(12, runs.length);
      runs.forEach((r, i) => {
        v.setUint32(16 + i * 8, r.count);
        v.setUint32(20 + i * 8, r.duration);
      });
      return out;
    }
    if (!containers.has(b.type)) return bytes.subarray(b.p, b.e);
    const body = concat(boxes(b.d, b.e).map(rebuild)),
      out = new Uint8Array(body.length + 8);
    new DataView(out.buffer).setUint32(0, out.length);
    out.set(bytes.subarray(b.p + 4, b.p + 8), 4);
    out.set(body, 8);
    return out;
  }
  const result = concat(roots.map(rebuild)),
    after = mp4Index(result.buffer),
    last = after.tracks.find((t) => t.kind === 'vide').samples.at(-1);
  need(
    compare(time(after.movieDuration, after.movieScale), presentationEnd) === 0,
    'v1 movie endpoint readback',
  );
  need(
    result.subarray(mdat.p, mdat.e).every((b, i) => b === bytes[mdat.p + i]),
    'v1 coded payload changed',
  );
  return {
    buffer: result.buffer,
    evidence: {
      ...audio.evidence,
      presentationEnd,
      movieTimescale: movieScale,
      exactDurationTicks: ticks,
      videoFrames: frames,
      lastVideoDurationTicks: last.duration,
      lastVideoScale: movieScale,
      codedMediaUnchanged: true,
    },
  };
}
