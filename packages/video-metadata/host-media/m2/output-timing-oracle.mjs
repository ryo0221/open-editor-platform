/** Independent verification-only presentation timeline check. */
import assert from 'node:assert/strict';
const integer = (value) => {
  assert(Number.isSafeInteger(value), 'Missing/unsafe ffprobe integer');
  return BigInt(value);
};
export function verifyVideoPresentation(stream, packets, frames) {
  assert.match(stream.time_base, /^[1-9]\d*\/[1-9]\d*$/);
  const [numerator, denominator] = stream.time_base.split('/').map(BigInt);
  const at = (ticks, frame) =>
    assert.equal(
      integer(ticks) * numerator * 25n,
      BigInt(frame) * denominator,
      'Video PTS differs from exact 25fps grid',
    );
  const duration = (ticks) =>
    assert.equal(
      integer(ticks) * numerator * 25n,
      denominator,
      'Video frame duration differs from 1/25',
    );
  at(stream.start_pts, 0);
  assert.equal(stream.start_time, '0.000000');
  assert.equal(integer(stream.duration_ts) * numerator, 4n * denominator);
  assert.equal(stream.duration, '4.000000');
  assert.equal(packets.length, 100);
  assert.equal(frames.length, 100);
  // Demux packet order may be decode/DTS order. Never use its ordinal as presentation time.
  const presented = packets
    .map((p, decodeIndex) => ({ ...p, decodeIndex }))
    .sort((a, b) =>
      integer(a.pts) < integer(b.pts) ? -1 : integer(a.pts) > integer(b.pts) ? 1 : 0,
    );
  presented.forEach((p, n) => {
    at(p.pts, n);
    duration(p.duration);
  });
  // ffprobe decoded-frame output is the same presentation ordering used by FFmpeg select(n).
  frames.forEach((f, n) => {
    at(f.pts, n);
    at(f.best_effort_timestamp, n);
    duration(f.duration);
  });
  return {
    timeBase: stream.time_base,
    startPts: stream.start_pts,
    startTime: stream.start_time,
    durationTs: stream.duration_ts,
    duration: stream.duration,
    packetDecodeOrder: packets,
    presentationPackets: presented,
    decodedFrames: frames,
  };
}
