import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { open } from 'node:fs/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
const [deps, original, out] = process.argv.slice(2);
await mkdir(out);
const bundle = await build({
  entryPoints: ['packages/video-metadata/host-media/file-source/inspect-run.mjs'],
  nodePaths: [path.join(deps, 'node_modules')],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
});
const server = createServer((q, r) => {
  r.setHeader('content-type', q.url === '/run.js' ? 'application/javascript' : 'text/html');
  r.end(
    q.url === '/run.js'
      ? bundle.outputFiles[0].text
      : '<!doctype html><input id="source" type="file"><canvas id="frame"></canvas><script src="/run.js"></script>',
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox'],
  }),
  results = [];
try {
  const p = await browser.newPage(),
    errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.goto(`http://127.0.0.1:${server.address().port}`);
  await p.locator('#source').setInputFiles(original);
  const result = await p.evaluate(() => globalThis.inspectFileSource());
  const expected = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      original,
      '-frames:v',
      '1',
      '-vf',
      'scale=270:480',
      '-pix_fmt',
      'rgba',
      '-f',
      'rawvideo',
      '-',
    ],
    { maxBuffer: 1024 * 1024 },
  );
  assert.equal(expected.length, result.pixels.length);
  let max = 0,
    sum = 0;
  for (let i = 0; i < expected.length; i++) {
    const d = Math.abs(expected[i] - result.pixels[i]);
    sum += d;
    max = Math.max(max, d);
  }
  const mean = sum / expected.length;
  await p.screenshot({ path: path.join(out, 'native-oriented-frame.png') });
  assert(mean < 8, `Orientation/color comparison mean ${mean}`);
  delete result.pixels;
  assert.equal(result.audio.exactEditSamples.remainder, '300');
  assert.equal(result.audio.decodedPrefixSamples, 8192);
  assert.deepEqual(errors, []);
  const handle = await open(original),
    hash = createHash('sha256'),
    chunk = new Uint8Array(65536);
  let bytes = 0;
  try {
    for (;;) {
      const r = await handle.read(chunk, 0, chunk.length, null);
      if (!r.bytesRead) break;
      hash.update(chunk.subarray(0, r.bytesRead));
      bytes += r.bytesRead;
    }
  } finally {
    await handle.close();
  }
  const sha256 = hash.digest('hex');
  assert.equal(sha256, '69e089ae0cc9ad02b7d2461965d6a00d47cb91f7b02e620d10db9ec356731dd4');
  assert.equal(bytes, 146163851);
  results.push({
    state: 'PASS',
    ...result,
    independentOrientation: { mean, max },
    sha256,
    errors,
    scope: 'read-only native codec feasibility, not Host import or playback/export acceptance',
  });
} catch (e) {
  results.push({ state: 'FAIL', error: String(e), stack: e.stack });
  process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
await writeFile(
  path.join(out, 'results.json'),
  JSON.stringify(
    {
      code: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      workingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }),
      results,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify(results, null, 2));
