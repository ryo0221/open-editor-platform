/** Independent FFmpeg oracle for original[T-2,T), then original[0.001,2.001). */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
export async function reorderedOutputOracleV1(original, output, directory) {
  const count = 192000,
    cut = 96000,
    sourceTail = 3284080;
  for (const [input, name] of [
    [original, 'source-48k.f32'],
    [output, 'output-48k.f32'],
  ])
    execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-i',
        input,
        '-map',
        '0:a:0',
        '-ac',
        '1',
        '-ar',
        '48000',
        '-f',
        'f32le',
        path.join(directory, name),
      ],
      { maxBuffer: 1024 * 1024 },
    );
  const source = await readFile(path.join(directory, 'source-48k.f32')),
    out = await readFile(path.join(directory, 'output-48k.f32'));
  assert.equal(out.length % 4, 0);
  assert(source.length >= 3380080 * 4 && out.length >= count * 4);
  const sourceIndex = (i) => (i < cut ? sourceTail + i : 48 + i - cut);
  const windows = [];
  for (const [first, end] of [
    [0, 256],
    [cut - 128, cut + 128],
    [Math.floor(count / 2), Math.floor(count / 2) + 256],
    [count - 256, count],
  ]) {
    let max = 0,
      sum = 0;
    for (let i = first; i < end; i++) {
      const a = source.readFloatLE(sourceIndex(i) * 4),
        b = out.readFloatLE(i * 4);
      assert(Number.isFinite(a) && Number.isFinite(b));
      const d = Math.abs(a - b);
      max = Math.max(max, d);
      sum += d * d;
    }
    const rms = Math.sqrt(sum / (end - first));
    assert(max < 0.1 && rms < 0.03, `Reordered PCM ${first}: ${max},${rms}`);
    windows.push({ first, end, max, rms });
  }
  const segments = [];
  for (const [first, end] of [
    [0, cut],
    [cut, count],
  ]) {
    let sum = 0,
      max = 0;
    for (let i = first; i < end; i++) {
      const a = source.readFloatLE(sourceIndex(i) * 4),
        b = out.readFloatLE(i * 4);
      assert(Number.isFinite(a) && Number.isFinite(b));
      const d = Math.abs(a - b);
      sum += d * d;
      max = Math.max(max, d);
    }
    const rms = Math.sqrt(sum / (end - first));
    assert(rms < 0.03, `Reordered full segment PCM ${first}: ${rms}`);
    segments.push({ first, end, sourceFirst: sourceIndex(first), max, rms });
  }
  const frames = JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_frames',
        '-show_entries',
        'frame=best_effort_timestamp',
        '-of',
        'json',
        original,
      ],
      { maxBuffer: 4 * 1024 * 1024 },
    ),
  ).frames;
  const pts = frames.map((f) => Number(f.best_effort_timestamp)).sort((a, b) => a - b);
  assert.equal(pts.length, 2113);
  assert(pts.every(Number.isSafeInteger));
  const pictures = [];
  for (const frame of [0, 25, 49, 50, 51, 99]) {
    const sourceTick = frame < 50 ? 41051 + frame * 24 : 3 / 5 + (frame - 50) * 24;
    const sourcePts = pts.filter((p) => p <= sourceTick).at(-1);
    assert.notEqual(sourcePts, undefined);
    const rgb = (file, selection) =>
      execFileSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-i',
          file,
          '-vf',
          `${selection},scale=270:480`,
          '-frames:v',
          '1',
          '-pix_fmt',
          'rgb24',
          '-f',
          'rawvideo',
          '-',
        ],
        { maxBuffer: 1024 * 1024 },
      );
    const a = rgb(original, `select='eq(pts,${sourcePts})'`),
      b = rgb(output, `select='eq(n,${frame})'`);
    assert.equal(a.length, 270 * 480 * 3);
    assert.equal(b.length, a.length);
    let sum = 0,
      max = 0;
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs(a[i] - b[i]);
      sum += d;
      max = Math.max(max, d);
    }
    const mean = sum / a.length;
    assert(mean < 8, `Reordered picture ${frame}: ${mean}`);
    pictures.push({ frame, sourceTick, sourcePts, mean, max });
  }
  return {
    mapping: 'original[41051/600,42251/600),original[1/1000,2001/1000)',
    validMonoSamples: count,
    decodedSamples: out.length / 4,
    windows,
    segments,
    pictures,
  };
}
