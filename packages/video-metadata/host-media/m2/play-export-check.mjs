import { productBuild } from '../product-build.mjs';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
const [deps, out] = process.argv.slice(2);
await mkdir(out);
const files = [];
for (const [name, size, frequency] of [
  ['portrait', '1920x1080', 440],
  ['landscape', '640x360', 660],
]) {
  const file = path.join(out, name + '.mp4');
  files.push(file);
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${size}:rate=25:duration=1,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${frequency}:sample_rate=44100:duration=1`,
    '-c:v',
    'libx264',
    '-profile:v',
    'high',
    '-level',
    '4.0',
    '-bf',
    '0',
    '-g',
    '25',
    '-pix_fmt',
    'yuv420p',
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-color_range',
    'tv',
    '-c:a',
    'aac',
    '-ac',
    '1',
    '-af',
    'volume=7.2',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart+write_colr',
    file,
  ]);
}
const rotated = path.join(out, 'portrait-rotated.mp4');
execFileSync('ffmpeg', [
  '-v',
  'error',
  '-i',
  files[0],
  '-c',
  'copy',
  '-metadata:s:v:0',
  'rotate=-90',
  '-movflags',
  '+faststart',
  rotated,
]);
// Author the ordinary positive-coordinate clockwise display matrix used by the
// accepted 1920x1080 profile. Only this newly generated fixture is edited.
const rotatedBytes = await readFile(rotated),
  tkhd = rotatedBytes.indexOf('tkhd');
assert(tkhd > 0);
assert.equal(rotatedBytes.readUInt32BE(tkhd + 4), 3);
const matrix = [0, 65536, 0, 0xffff0000, 0, 0, 1080 * 65536, 0, 0x40000000];
for (let i = 0; i < matrix.length; i++)
  rotatedBytes.writeUInt32BE(matrix[i], tkhd + 4 + 40 + i * 4);
await writeFile(rotated, rotatedBytes);
files[0] = rotated;
const music = path.join(out, 'music.m4a');
files.push(music);
execFileSync('ffmpeg', [
  '-v',
  'error',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=330:sample_rate=44100:duration=2.2',
  '-af',
  'volume=7.2',
  '-ac',
  '1',
  '-c:a',
  'aac',
  '-b:a',
  '128k',
  '-movflags',
  '+faststart',
  music,
]);
const fixtureProbe = JSON.parse(
  execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height:stream_side_data=rotation',
      '-of',
      'json',
      files[0],
    ],
    { encoding: 'utf8' },
  ),
);
assert.equal(fixtureProbe.streams[0].width, 1920);
assert.equal(fixtureProbe.streams[0].height, 1080);
assert.equal(fixtureProbe.streams[0].side_data_list[0].rotation, -90);
const hashes = files.map((f) => execFileSync('sha256sum', [f], { encoding: 'utf8' }).split(' ')[0]);
const notice = await readFile(
  'packages/video-metadata/file-backed-storage/integration/NOBLE-HASHES-LICENSE.txt',
  'utf8',
);
const built = await productBuild(deps, {
  entryPoint: 'packages/video-metadata/host-media/m2/play-export-run.mjs',
  banner: { js: '/*! @noble/hashes1.8.0\n' + notice + '\n*/' },
});
const server = createServer((q, r) => {
  r.setHeader('content-type', q.url === '/run.js' ? 'application/javascript' : 'text/html');
  r.end(
    q.url === '/run.js'
      ? built.outputFiles[0].contents
      : '<!doctype html><input type="file" multiple><canvas></canvas><script src="/run.js"></script>',
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
let proof;
const errors = [],
  output = path.join(out, 'm2.mp4');
try {
  const page = await browser.newPage({ acceptDownloads: true });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('input').setInputFiles(files);
  const downloads = [];
  page.on('download', (d) => downloads.push(d));
  const result = await page.evaluate((h) => globalThis.runM2Delivery(h), hashes);
  await expect.poll(() => downloads.length, { timeout: 10000 }).toBe(2);
  proof = result;
  assert.equal(proof.encoded.frameEvidence[0].geometry.rotation, 90);
  assert.equal(proof.encoded.frameEvidence[25].geometry.rotation, 0);
  assert(proof.playback.frames.some((f) => f.sourceId === 'two'));
  for (const frame of proof.playback.frames) {
    assert.equal(frame.sourceId, frame.frame < 25 ? 'one' : 'two');
    assert.equal(
      BigInt(frame.sourcePts) * 25n,
      BigInt(frame.frame % 25) * BigInt(frame.sourceScale),
    );
  }
  assert(proof.scheduled.every((c) => c.rate === 48000));
  for (const d of downloads) await d.saveAs(path.join(out, d.suggestedFilename()));
  await page.screenshot({ path: path.join(out, 'preview.png') });
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
assert.deepEqual(
  files.map((f) => execFileSync('sha256sum', [f], { encoding: 'utf8' }).split(' ')[0]),
  hashes,
  'Fixture original bytes changed',
);
const meta = JSON.parse(
  execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output], {
    encoding: 'utf8',
  }),
);
const video = meta.streams.find((s) => s.codec_type === 'video'),
  audio = meta.streams.find((s) => s.codec_type === 'audio');
assert.equal(video.width, 1080);
assert.equal(video.height, 1920);
assert.equal(video.nb_frames, '50');
assert.equal(video.duration, '2.000000');
assert.equal(audio.channels, 1);
assert.equal(audio.sample_rate, '48000');
const decoded = files
  .concat(output)
  .map((f) =>
    execFileSync(
      'ffmpeg',
      ['-v', 'error', '-i', f, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'],
      { maxBuffer: 4 * 1024 * 1024 },
    ),
  );
assert(decoded[3].length >= 96000 * 4);
let max = 0,
  sum = 0;
for (let k = 0; k < 96000; k++) {
  const second = k >= 48000,
    local = (k % 48000) / 48000;
  const voice =
    decoded[second ? 1 : 0].readFloatLE((k % 48000) * 4) *
    0.25 *
    Math.min(1, local / 0.1, (1 - local) / 0.1);
  const t = (k - 48) / 48000;
  const bg =
    k >= 48 && k < 95952
      ? decoded[2].readFloatLE((k - 48) * 4) * 0.2 * Math.min(1, t / 0.1, (1.998 - t) / 0.1)
      : 0;
  const actual = decoded[3].readFloatLE(k * 4);
  assert(Number.isFinite(actual));
  const d = Math.abs(actual - voice - bg);
  max = Math.max(max, d);
  sum += d * d;
}
const rms = Math.sqrt(sum / 96000);
assert(max < 0.1 && rms < 0.03, `Independent encoded PCM ${max}/${rms}`);
const pictures = [];
for (const frame of [0, 24, 25, 49]) {
  const source = frame < 25 ? 0 : 1,
    sourceFrame = frame % 25;
  const expected = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      files[source],
      '-vf',
      `select=eq(n\\,${sourceFrame}),scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0x102030`,
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
  const actual = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      output,
      '-vf',
      `select=eq(n\\,${frame})`,
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
  assert.equal(actual.length, expected.length);
  let total = 0;
  for (let i = 0; i < actual.length; i++) total += Math.abs(actual[i] - expected[i]);
  const mean = total / actual.length;
  assert(mean < 8, `Independent contain pixels ${frame}/${mean}`);
  pictures.push({ frame, sourceFrame, mean });
}
const landscapeOutput = path.join(out, 'output-landscape.mp4');
const landscapeMeta = JSON.parse(
  execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height,nb_frames',
      '-of',
      'json',
      landscapeOutput,
    ],
    { encoding: 'utf8' },
  ),
);
assert.equal(landscapeMeta.streams[0].width, 1920);
assert.equal(landscapeMeta.streams[0].height, 1080);
assert.equal(landscapeMeta.streams[0].nb_frames, '50');
for (const frame of [0, 25]) {
  const source = frame === 0 ? 0 : 1;
  const expected = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      files[source],
      '-vf',
      'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x102030',
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
  const actual = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      landscapeOutput,
      '-vf',
      `select=eq(n\\,${frame})`,
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
  assert.equal(expected.length, actual.length);
  let total = 0;
  for (let i = 0; i < actual.length; i++) total += Math.abs(actual[i] - expected[i]);
  const mean = total / actual.length;
  assert(mean < 8, `Landscape contain ${mean}`);
  pictures.push({ canvas: 'landscape', frame, mean });
}
const result = {
  state: 'PASS',
  code: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }),
  hashes,
  errors,
  proof,
  independent: { audio: { max, rms }, pictures, video, audioMetadata: audio },
};
await writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2));
console.log(
  JSON.stringify({
    state: result.state,
    code: result.code,
    audio: { max, rms },
    pictures,
    after: proof.after,
  }),
);
