/** Independent native-tool oracle for the approved unchanged original; outputs stay outside Git. */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
export async function outputOracleV1(original, output, directory) {
  const count = 3380080;
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
  const rawSource = await readFile(path.join(directory, 'source-48k.f32')),
    rawOutput = await readFile(path.join(directory, 'output-48k.f32'));
  assert.equal(rawOutput.length % 4, 0);
  assert(rawSource.length >= count * 4 && rawOutput.length >= count * 4);
  const windows = [];
  for (const [first, end] of [
    [0, 256],
    [Math.floor(count / 2), Math.floor(count / 2) + 256],
    [count - 256, count],
  ]) {
    let max = 0,
      sum = 0;
    for (let i = first; i < end; i++) {
      const a = rawSource.readFloatLE(i * 4),
        b = rawOutput.readFloatLE(i * 4);
      assert(Number.isFinite(a) && Number.isFinite(b));
      const d = Math.abs(a - b);
      max = Math.max(max, d);
      sum += d * d;
    }
    const rms = Math.sqrt(sum / (end - first));
    assert(max < 0.1 && rms < 0.03, `Independent PCM ${first}: ${max}, ${rms}`);
    windows.push({ first, end, max, rms });
  }
  for (let i = 0; i < count; i++) assert(Number.isFinite(rawOutput.readFloatLE(i * 4)));
  const pictures = [];
  // FFmpeg independent PTS selection picks the VFR source interval containing each output point.
  for (const [frame, sourcePts] of [
    [0, 0],
    [880, 21116],
    [1760, 42231],
  ]) {
    const source = execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-i',
        original,
        '-vf',
        `select='eq(pts,${sourcePts})',scale=270:480`,
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
    const out = execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-i',
        output,
        '-vf',
        `select='eq(n,${frame})',scale=270:480`,
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
    assert.equal(source.length, 270 * 480 * 3);
    assert.equal(out.length, source.length);
    let sum = 0,
      max = 0;
    for (let i = 0; i < source.length; i++) {
      const d = Math.abs(source[i] - out[i]);
      sum += d;
      max = Math.max(max, d);
    }
    const mean = sum / source.length;
    assert(mean < 8, `Independent video ${frame}: ${mean}`);
    pictures.push({ frame, sourcePts, mean, max });
  }
  return { validMonoSamples: count, decodedSamples: rawOutput.length / 4, windows, pictures };
}
