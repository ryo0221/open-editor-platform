import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
const [deps, one, two, out] = process.argv.slice(2);
await mkdir(out);
const music = path.join(out, 'music.m4a');
execFileSync('ffmpeg', [
  '-v',
  'error',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=330:sample_rate=44100:duration=4.5',
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
const files = [one, two, music],
  hashes = files.map(
    (file) => execFileSync('sha256sum', [file], { encoding: 'utf8' }).split(' ')[0],
  );
assert.equal(hashes[0], '69e089ae0cc9ad02b7d2461965d6a00d47cb91f7b02e620d10db9ec356731dd4');
assert.equal(hashes[1], '2d9e3284f777980c212702f8cbfe03a3817d4ad9a2bd08ef8d21d805cd556022');
const built = await build({
  entryPoints: ['packages/video-metadata/host-media/m2/mixed-pcm-run.mjs'],
  nodePaths: [path.join(deps, 'node_modules')],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
});
const server = createServer((q, r) => {
  r.setHeader('content-type', q.url === '/run.js' ? 'application/javascript' : 'text/html');
  r.end(
    q.url === '/run.js'
      ? built.outputFiles[0].text
      : '<!doctype html><input type="file" multiple><script src="/run.js"></script>',
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  args: ['--no-sandbox'],
});
let proof;
const errors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('input').setInputFiles(files);
  proof = await page.evaluate((h) => globalThis.runMixedPcmV2(h), hashes);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
const decoded = files.map((file) => {
  const bytes = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-f', 'f32le', '-ar', '48000', '-ac', '1', '-'],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
});
let max = 0,
  squares = 0;
const windows = [
  { start: 0, end: 256 },
  { start: 95872, end: 96128 },
  { start: 191744, end: 192000 },
].map((x) => ({ ...x, max: 0, squares: 0 }));
for (let k = 0; k < 192000; k++) {
  const first = k < 96000,
    local = (first ? k : k - 96000) / 48000,
    voice =
      decoded[first ? 0 : 1].getFloat32(
        ((first ? 3284080 : 48) + (first ? k : k - 96000)) * 4,
        true,
      ) *
      0.25 *
      Math.min(1, local / 0.1, (2 - local) / 0.1);
  let bg = 0;
  if (k >= 48 && k < 191952) {
    const t = (k - 48) / 48000;
    bg = decoded[2].getFloat32((k - 48) * 4, true) * 0.2 * Math.min(1, t / 0.5, (3.998 - t) / 0.5);
  }
  const expected = voice + bg,
    actual = proof.pcm[k];
  assert(Number.isFinite(actual) && Math.abs(actual) <= 1);
  const d = actual - expected;
  max = Math.max(max, Math.abs(d));
  squares += d * d;
  for (const w of windows)
    if (k >= w.start && k < w.end) {
      w.max = Math.max(w.max, Math.abs(d));
      w.squares += d * d;
    }
}
const rms = Math.sqrt(squares / 192000);
assert(max < 0.005);
assert(rms < 0.001);
const result = {
  state: 'PASS',
  code: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }),
  hashes,
  errors,
  oracle: {
    max,
    rms,
    windows: windows.map((w) => ({
      start: w.start,
      end: w.end,
      max: w.max,
      rms: Math.sqrt(w.squares / (w.end - w.start)),
    })),
  },
  proof,
};
await writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2));
console.log(
  JSON.stringify({
    state: result.state,
    code: result.code,
    oracle: result.oracle,
    after: proof.after,
  }),
);
