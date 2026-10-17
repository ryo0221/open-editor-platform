/* eslint-disable no-undef */
import { productBuild } from './product-build.mjs';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url)),
  output = resolve(process.argv[2] ?? '/tmp/video-workflow-browser');
await mkdir(output, { recursive: true });
const fixture = resolve(output, 'av-bt709.mp4');
execFileSync('ffmpeg', [
  '-hide_banner',
  '-loglevel',
  'error',
  '-y',
  '-f',
  'lavfi',
  '-i',
  'color=c=red:size=320x180:rate=25:duration=1,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=48000:duration=1',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  '-color_primaries',
  'bt709',
  '-color_trc',
  'bt709',
  '-colorspace',
  'bt709',
  '-ac',
  '2',
  '-c:a',
  'aac',
  '-movflags',
  '+faststart+write_colr',
  fixture,
]);
// Move an interior composition-offset run one second later. The PTS envelope
// still contains the selected edit, but its actual union has an interior gap.
const gapBytes = await readFile(fixture),
  cttsType = gapBytes.indexOf(Buffer.from('ctts'));
checkFixture(cttsType > 0, 'Fixture must contain B-frame ctts');
const cttsStart = cttsType + 4,
  runs = gapBytes.readUInt32BE(cttsStart + 4);
checkFixture(runs >= 3, 'Fixture needs interior composition runs');
const shifted = cttsStart + 8 + Math.floor(runs / 2) * 8 + 4;
gapBytes.writeUInt32BE(gapBytes.readUInt32BE(shifted) + 12800, shifted);
const gapFixture = resolve(output, 'av-timestamp-gap.mp4');
await writeFile(gapFixture, gapBytes);
function checkFixture(ok, message) {
  if (!ok) throw Error(message);
}
const bundle = await productBuild('/workspace/video-codec-eval/deps');
const html = await readFile(resolve(here, 'browser-host.html'));
const server = createServer((req, res) => {
  if (req.url === '/host.js') {
    res.setHeader('content-type', 'text/javascript');
    res.end(bundle.outputFiles[0].text);
  } else if (req.url === '/favicon.ico') {
    res.statusCode = 204;
    res.end();
  } else if (req.url === '/') {
    res.setHeader('content-type', 'text/html');
    res.end(html);
  } else {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox'],
});
const results = [];
const check = (ok, message) => {
  if (!ok) throw Error(message);
};
try {
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    const errors = [],
      requests = [];
    const context = await browser.newContext({ viewport, acceptDownloads: true });
    const observe = (page) => {
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      page.on('request', (r) => requests.push(r.url()));
    };
    const a = await context.newPage();
    observe(a);
    await a.goto(url);
    await a.waitForFunction(() => document.querySelector('#status').textContent === 'Empty Host');
    await a.locator('#import').setInputFiles(gapFixture);
    await a.waitForFunction(() => document.querySelector('#status').textContent !== 'Working');
    check(
      (await a.locator('#status').innerText()).includes('presentation gap'),
      'Timestamp-gap rejection',
    );
    check(
      JSON.parse(await a.locator('#summary').textContent()).sources === 0,
      'Gap rejects before mutation',
    );
    await a.locator('#import').setInputFiles(fixture);
    await a.waitForFunction(() => document.querySelector('#status').textContent !== 'Working');
    check(
      (await a.locator('#status').innerText()).startsWith('Imported'),
      await a.locator('#status').innerText(),
    );
    const before = JSON.parse(await a.locator('#summary').textContent());
    check(before.sources === 1 && before.video === 1 && before.audio === 1, 'Atomic AV import');
    const pixel = await a
      .locator('#preview')
      .evaluate((c) => Array.from(c.getContext('2d').getImageData(100, 80, 1, 1).data));
    check(pixel[0] > 200 && pixel[1] < 40 && pixel[2] < 40, 'Decoded red preview');
    const hash = await a.locator('#preview').getAttribute('data-source-hash');
    check(
      hash ===
        createHash('sha256')
          .update(await readFile(fixture))
          .digest('hex'),
      'Original matches independently hashed selected file',
    );
    const download = a.waitForEvent('download');
    await a.locator('#save').click();
    const file = await download;
    const project = resolve(output, `project-${viewport.width}.vbp`);
    await file.saveAs(project);
    await a.screenshot({ path: resolve(output, `import-${viewport.width}.png`), fullPage: true });
    await context.close();
    // No page, cache, IndexedDB or in-memory original store is shared with the new Host.
    const fresh = await browser.newContext({ viewport, acceptDownloads: true }),
      b = await fresh.newPage();
    observe(b);
    await b.goto(url);
    await b.waitForFunction(() => document.querySelector('#status').textContent === 'Empty Host');
    check(
      JSON.parse(await b.locator('#summary').textContent()).sources === 0,
      'New Host must start empty',
    );
    await b.locator('#open').setInputFiles(project);
    await b.waitForFunction(() => document.querySelector('#status').textContent !== 'Working');
    check(
      (await b.locator('#status').innerText()).startsWith('Reopened'),
      await b.locator('#status').innerText(),
    );
    const after = JSON.parse(await b.locator('#summary').textContent());
    check(JSON.stringify(after.native) === JSON.stringify(before.native), 'Native exact restore');
    check(
      (await b.locator('#preview').getAttribute('data-source-hash')) === hash,
      'Original identity restore',
    );
    const restoredPixel = await b
      .locator('#preview')
      .evaluate((c) => Array.from(c.getContext('2d').getImageData(100, 80, 1, 1).data));
    check(JSON.stringify(restoredPixel) === JSON.stringify(pixel), 'Preview pixel restore');
    await b.getByLabel('Trim start (rational seconds)').fill('1/10');
    await b.locator('#open').setInputFiles([]);
    await b.locator('#open').setInputFiles(project);
    await b.waitForFunction(() => document.querySelector('#status').textContent !== 'Working');
    check(
      (await b.locator('#status').innerText()).includes('Pending inputs'),
      'Pending UI input must block reopen',
    );
    await b.getByRole('button', { name: 'Cancel inputs', exact: true }).click();
    // Malformed input must leave the currently activated Host intact.
    const bad = resolve(output, `bad-${viewport.width}.vbp`),
      bytes = await readFile(project);
    bytes[bytes.length - 1] ^= 1;
    await writeFile(bad, bytes);
    await b.locator('#open').setInputFiles(bad);
    await b.waitForFunction(() => document.querySelector('#status').textContent !== 'Working');
    check(
      (await b.locator('#status').innerText()).includes('digest mismatch'),
      'Tamper diagnostic',
    );
    check(
      JSON.parse(await b.locator('#summary').textContent()).native.sources[0].asset.sha256 === hash,
      'Failed reopen preserves active Host',
    );
    await b.screenshot({ path: resolve(output, `reopen-${viewport.width}.png`), fullPage: true });
    check(errors.length === 0, 'Browser errors: ' + errors.join('\n'));
    check(
      requests.every((r) => r.startsWith(url) || r.startsWith('blob:')),
      'Unexpected external request',
    );
    results.push({
      viewport,
      state: 'PASS',
      originalHash: hash,
      pixel,
      checks: [
        'timestamp-gap import rejects before mutation',
        'atomic real MP4 AV import',
        'native browser reference frame',
        'download single file',
        'new browser context empty Host',
        'bundle-only original/native/frame restore',
        'tamper refuses without replacing Host',
        'pending UI input blocks reopen',
        'no browser errors',
        'local requests only',
      ],
    });
    await fresh.close();
  }
} catch (e) {
  results.push({ state: 'FAIL', error: String(e), stack: e.stack });
  process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
await writeFile(
  resolve(output, 'results.json'),
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
