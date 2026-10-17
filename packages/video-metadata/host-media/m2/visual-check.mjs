import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
const [deps, one, two, nativeEvidence, out] = process.argv.slice(2);
await mkdir(out);
const native = JSON.parse(await readFile(nativeEvidence, 'utf8')).proof.native;
const built = await build({
  entryPoints: ['packages/video-metadata/host-media/m2/visual-run.mjs'],
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
const errors = [];
let proof;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('input').setInputFiles([one, two]);
  proof = await page.evaluate((n) => globalThis.runVisualV2(n), native);
  await page.screenshot({ path: path.join(out, 'concatenated-frames.png') });
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
// Independent rational oracle. No production time/planner/reader functions.
const rational = (t) => [BigInt(t.value), BigInt(t.timescale)];
const plus = (a, b) => [a[0] * b[1] + b[0] * a[1], a[1] * b[1]];
const minus = (a, b) => plus(a, [-b[0], b[1]]);
const product = (a, b) => [a[0] * b[0], a[1] * b[1]];
const compare = (a, b) => a[0] * b[1] - b[0] * a[1];
const canonical = ([n, d]) => {
  let a = n < 0n ? -n : n,
    b = d;
  while (b) {
    const next = a % b;
    a = b;
    b = next;
  }
  return { value: Number(n / a), timescale: Number(d / a) };
};
const indexes = new Map(
  [
    ['one', one],
    ['two', two],
  ].map(([id, file]) => {
    const data = JSON.parse(
      execFileSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_packets',
          '-show_streams',
          '-show_entries',
          'packet=pts,duration:stream=time_base',
          '-of',
          'json',
          file,
        ],
        { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      ),
    );
    assert.equal(data.streams[0].time_base, '1/600');
    return [id, data.packets];
  }),
);
const expectedFrame = (at) => {
  const target = rational(at);
  const matches = native.sequence.clips.filter(
    (c) =>
      c.kind === 'video' &&
      native.sequence.tracks.find((t) => t.id === c.trackId).enabled &&
      compare(target, rational(c.start)) >= 0n &&
      compare(target, plus(rational(c.start), rational(c.duration))) < 0n,
  );
  assert.equal(matches.length, 1);
  const clip = matches[0],
    source = native.sources.find((s) => s.id === clip.sourceId),
    stream = source.streams.find((s) => s.id === clip.streamId);
  const sourceTime = plus(
    rational(clip.sourceIn),
    product(minus(target, rational(clip.start)), rational(clip.rate)),
  );
  const rawTime = minus(sourceTime, rational(stream.presentationOrigin));
  const candidates = indexes
    .get(source.id)
    .filter(
      (p) =>
        compare([BigInt(p.pts), 600n], rawTime) <= 0n &&
        compare(rawTime, [BigInt(p.pts) + BigInt(p.duration), 600n]) < 0n,
    );
  assert.equal(candidates.length, 1);
  return {
    sourceId: source.id,
    sourceTime: canonical(sourceTime),
    rawTime: canonical(rawTime),
    pts: candidates[0].pts,
    scale: 600,
  };
};
const assertSelection = (actual, expected) => {
  for (const key of ['sourceId', 'sourceTime', 'rawTime', 'pts', 'scale'])
    assert.deepEqual(actual[key], expected[key], `Independent selection ${key}`);
};
for (const p of proof.pictures) {
  const selected = expectedFrame(p.at);
  assertSelection(p, selected);
  assert.throws(() => assertSelection({ ...p, pts: p.pts + 20 }, selected));
  assert.throws(() => assertSelection({ ...p, rawTime: { value: 0, timescale: 1 } }, selected));
  p.independentSelection = selected;
  const file = selected.sourceId === 'one' ? one : two;
  const expected = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      file,
      '-ss',
      String(selected.pts / selected.scale),
      '-frames:v',
      '1',
      '-vf',
      `scale=${p.width}:${p.height}`,
      '-pix_fmt',
      'rgba',
      '-f',
      'rawvideo',
      '-',
    ],
    { maxBuffer: 1024 * 1024 },
  );
  assert.equal(expected.length, p.pixels.length);
  let sum = 0,
    max = 0;
  for (let i = 0; i < expected.length; i++) {
    const delta = Math.abs(expected[i] - p.pixels[i]);
    sum += delta;
    max = Math.max(max, delta);
  }
  p.comparison = { mean: sum / expected.length, max };
  assert(p.comparison.mean < 8, `Pixel mismatch ${p.sourceId}: ${p.comparison.mean}`);
  delete p.pixels;
}
const result = {
  state: 'PASS',
  code: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }),
  errors,
  proof,
};
await writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
