/** Independent native timing and FFmpeg pixels; never imports product renderer/mapping. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const q = (t) => [BigInt(t.value), BigInt(t.timescale)];
const add = (a, b) => [a[0] * b[1] + b[0] * a[1], a[1] * b[1]];
const sub = (a, b) => add(a, [-b[0], b[1]]);
const mul = (a, b) => [a[0] * b[0], a[1] * b[1]];
const cmp = (a, b) => a[0] * b[1] - b[0] * a[1];
export function verifyPreview(native, files, actual) {
  assert.ok(actual, 'No actual preview readback');
  const at = [BigInt(actual.frame), 25n];
  const enabled = new Set(native.sequence.tracks.filter((t) => t.enabled).map((t) => t.id));
  const clips = native.sequence.clips.filter(
    (c) =>
      c.kind === 'video' &&
      enabled.has(c.trackId) &&
      cmp(at, q(c.start)) >= 0n &&
      cmp(at, add(q(c.start), q(c.duration))) < 0n,
  );
  assert.equal(clips.length, 1);
  const clip = clips[0],
    source = native.sources.find((s) => s.id === clip.sourceId),
    stream = source.streams.find((s) => s.id === clip.streamId);
  const raw = sub(
    add(q(clip.sourceIn), mul(sub(at, q(clip.start)), q(clip.rate))),
    q(stream.presentationOrigin),
  );
  const file = files.get(source.asset.sha256);
  const packets = JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_packets',
        '-show_entries',
        'packet=pts,duration',
        '-of',
        'json',
        file,
      ],
      { encoding: 'utf8' },
    ),
  ).packets;
  const covering = packets.filter(
    (p) =>
      cmp([BigInt(p.pts), 600n], raw) <= 0n && cmp(raw, [BigInt(p.pts + p.duration), 600n]) < 0n,
  );
  assert.equal(covering.length, 1);
  assert.equal(actual.sourceId, source.id);
  assert.equal(actual.sourcePts, covering[0].pts);
  assert.equal(actual.sourceScale, 600);
  const expected = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      file,
      '-vf',
      `select=eq(pts\\,${covering[0].pts}),scale=${actual.width}:${actual.height}:force_original_aspect_ratio=decrease,pad=${actual.width}:${actual.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
      '-frames:v',
      '1',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      '-',
    ],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  assert.equal(actual.rgba.length, actual.width * actual.height * 4);
  assert.equal(expected.length, actual.width * actual.height * 3);
  let total = 0;
  for (let i = 0; i < expected.length; i++)
    total += Math.abs(expected[i] - actual.rgba[Math.floor(i / 3) * 4 + (i % 3)]);
  const mean = total / expected.length;
  assert.ok(mean < 8, `Preview pixels ${mean}`);
  return {
    frame: actual.frame,
    sourceHash: source.asset.sha256,
    pts: covering[0].pts,
    scale: 600,
    mean,
    width: actual.width,
    height: actual.height,
  };
}
