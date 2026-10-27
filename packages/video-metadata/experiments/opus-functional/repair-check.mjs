/* global window */
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import assert from 'node:assert/strict';
import { discardSamples } from './discard-timing.mjs';
import { repairMetadata } from './metadata-repair.mjs';
import { parse } from './metadata.mjs';
import { metrics } from './metrics.mjs';
import { signal } from './signal.mjs';
import { pins } from './candidate-pins.mjs';
const [baseline, deps, out] = process.argv.slice(2);
assert(baseline && deps && out);
const report = JSON.parse(await readFile(baseline + '/results/report.json', 'utf8'));
assert.deepEqual(report.pins, pins, 'Baseline candidate identity');
for (const [file, hash] of Object.entries(pins))
  assert.equal(
    createHash('sha256')
      .update(await readFile(deps + '/' + file))
      .digest('hex'),
    hash,
    'Candidate source drift',
  );
await mkdir(out);
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('./metadata-browser.mjs', import.meta.url))],
  nodePaths: [deps + '/node_modules'],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
});
const server = createServer((req, res) => {
  if (req.url === '/b.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(bundle.outputFiles[0].contents);
  } else if (req.url === '/favicon.ico') res.writeHead(204).end();
  else res.end('<script src="/b.js"></script>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = `http://127.0.0.1:${server.address().port}`;
let browser;
const rows = [],
  errors = [];
try {
  browser = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('**/*', (route) =>
    route
      .request()
      .url()
      .startsWith(address + '/')
      ? route.continue()
      : route.abort(),
  );
  await page.goto(address);
  await page.waitForFunction(() => !!window.decodeMetadataFixture);
  for (const old of report.rows) {
    const bytes = await readFile(`${baseline}/results/${old.name}.webm`);
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      old.bytesHash,
      'Baseline fixture drift',
    );
    let fixed;
    try {
      fixed = repairMetadata(bytes, old.expectedSamples);
    } catch (error) {
      rows.push({ name: old.name, state: 'BLOCKED', reason: String(error) });
      continue;
    }
    const file = `${out}/${old.name}.webm`;
    await writeFile(file, fixed.bytes);
    const meta = parse(fixed.bytes),
      audio = meta.tracks.find((t) => t.codec === 'A_OPUS'),
      blocks = meta.blocks.filter((b) => b.track === audio.number);
    const discardNs = blocks.at(-1).discardPadding?.nanoseconds ?? 0n;
    // The decoder receives container-derived coverage, never the fixture's expected sample count.
    const timing = {
      decodedFrames: blocks.length * 960 - Number(audio.opus.preSkip),
      discardFrames: discardSamples(discardNs),
    };
    const decoded = await page.evaluate(
      async ({ bytes, timing }) => window.decodeMetadataFixture(bytes, timing),
      { bytes: Array.from(fixed.bytes), timing },
    );
    const pcm = execFileSync(
      'ffmpeg',
      ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 'f32le', '-'],
      { maxBuffer: 2 * 1024 * 1024 },
    );
    const ff = Float32Array.from({ length: pcm.length / 4 }, (_, i) => pcm.readFloatLE(i * 4));
    const probe = JSON.parse(
      execFileSync('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'a',
        '-show_frames',
        '-show_entries',
        'frame=pts_time,nb_samples',
        '-of',
        'json',
        file,
      ]),
    );
    const expected = signal(old.expectedSamples),
      qualities = {
        browser: [0, 1].map((c) =>
          metrics(expected, decoded.pcm, c, decoded.frames[0]?.timestamp, old.origin),
        ),
        ffmpeg: [0, 1].map((c) =>
          metrics(expected, ff, c, Number(probe.frames[0]?.pts_time), old.origin),
        ),
      };
    rows.push({
      name: old.name,
      videoPass: old.videoPass === true,
      state:
        old.videoPass === true &&
        Object.values(qualities)
          .flat()
          .every((q) => q.pass)
          ? 'PASS'
          : 'FAIL',
      rawBrowserFrames: decoded.rawFrames,
      browserFrames: decoded.pcm.length / 2,
      ffmpegFrames: ff.length / 2,
      expectedFrames: old.expectedSamples,
      timing,
      qualities,
      ffmpegFirst: probe.frames[0],
      ffmpegLast: probe.frames.at(-1),
    });
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await writeFile(
    out + '/report.json',
    JSON.stringify(
      {
        source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        baselinePins: report.pins,
        rows,
        errors,
        claim:
          'Finite linear-decode candidate only. Original16 FAIL retained; no product/seek/performance acceptance.',
      },
      null,
      2,
    ),
  );
}
process.exitCode = errors.length || rows.some((r) => r.state !== 'PASS') ? 2 : 0;
