import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
const [deps, out] = process.argv.slice(2);
assert(deps && out);
await mkdir(out);
const count = 48000 * 48,
  raw = Buffer.alloc(count * 8),
  impulses = [48000 * 45 + 11520, 48000 * 46 + 34560];
for (let i = 0; i < count; i++)
  for (let ch = 0; ch < 2; ch++)
    raw.writeFloatLE(
      0.02 +
        0.025 * Math.sin((2 * Math.PI * (ch ? 700 : 440) * i) / 48000) +
        (i === impulses[ch] ? 0.6 : 0),
      (i * 2 + ch) * 4,
    );
await writeFile(path.join(out, 'source.f32'), raw);
const source = path.join(out, 'source.mp4');
execFileSync('ffmpeg', [
  '-v',
  'error',
  '-y',
  '-f',
  'lavfi',
  '-i',
  "color=c=red:size=320x180:rate=25:duration=48,drawbox=c=blue:t=fill:enable='between(t,1,3)',drawbox=c=green:t=fill:enable='between(t,45,47)',drawbox=c=white:t=fill:enable='gte(t,47)',setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709",
  '-f',
  'f32le',
  '-ar',
  '48000',
  '-ac',
  '2',
  '-i',
  path.join(out, 'source.f32'),
  '-c:v',
  'libx264',
  '-g',
  '25',
  '-keyint_min',
  '25',
  '-sc_threshold',
  '0',
  '-bf',
  '2',
  '-x264-params',
  'open-gop=0',
  '-pix_fmt',
  'yuv420p',
  '-color_primaries',
  'bt709',
  '-color_trc',
  'bt709',
  '-colorspace',
  'bt709',
  '-c:a',
  'aac',
  '-b:a',
  '192k',
  '-movflags',
  '+faststart',
  source,
]);
const hash = createHash('sha256')
  .update(await readFile(source))
  .digest('hex');
const bundle = await build({
  entryPoints: ['packages/video-metadata/host-media/indexed-media/check-run.mjs'],
  nodePaths: [path.join(deps, 'node_modules')],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
});
const server = createServer((req, r) => {
  r.setHeader('content-type', req.url === '/run.js' ? 'application/javascript' : 'text/html');
  r.end(
    req.url === '/run.js'
      ? bundle.outputFiles[0].text
      : '<!doctype html><input type=file id=source><canvas id=frame width=320 height=180></canvas><script src=/run.js></script>',
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox'],
  }),
  results = [];
try {
  const page = await browser.newPage(),
    errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('#source').setInputFiles(source);
  const result = await page.evaluate((hash) => globalThis.checkIndexed(hash), hash);
  const decoded = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', source, '-map', '0:a:0', '-f', 'f32le', '-'],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  const pcm = new Float32Array(
    decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength),
  );
  for (const window of result.windows) {
    let max = 0;
    for (let i = 0; i < window.samples.length; i++)
      max = Math.max(max, Math.abs(window.samples[i] - pcm[window.relativeFirst * 2 + i]));
    assert(max < 0.0001);
    window.maxDiff = max;
    delete window.samples;
  }
  assert(result.pcm.packets > 2048);
  assert.equal(result.pcm.fileBytes, count * 8);
  assert(result.pcm.maxPendingWriteBytes <= 256 * 1024);
  assert(result.video.maxCachedFrames <= 64);
  assert(result.video.decodedPackets < 200);
  assert.equal(result.zeroWholeOriginalReads, true);
  assert.equal(result.leaseDrainHeld, true);
  assert.equal(result.oldCleanupKeptNew, true);
  assert.equal(result.faults.length, 3);
  assert.deepEqual(result.videoBudget, { sessions: 0 });
  assert.deepEqual(result.finalBudget, { building: 0, reads: 0, files: 0, bytes: 0 });
  assert.deepEqual(errors, []);
  results.push({ state: 'PASS', ...result, errors, originalHash: hash });
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
