import { productBuild } from './product-build.mjs';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
const [deps, original, out, iphone] = process.argv.slice(2);
await mkdir(out);
const bundled = await productBuild(deps),
  html = await readFile('packages/video-metadata/host-media/browser-host.html');
const server = createServer((q, r) => {
  r.setHeader('content-type', q.url === '/host.js' ? 'application/javascript' : 'text/html');
  r.end(q.url === '/host.js' ? bundled.outputFiles[0].text : html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox'],
  }),
  results = [];
try {
  for (const mode of ['silent', 'wider']) {
    const file = path.join(out, mode + '.mp4');
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-i',
      original,
      '-t',
      '2',
      ...(mode === 'silent'
        ? ['-an', '-c:v', 'libx264']
        : ['-vf', 'scale=1280:720', '-c:v', 'libx264', '-c:a', 'aac']),
      '-movflags',
      '+faststart',
      file,
    ]);
    const context = await browser.newContext({ acceptDownloads: true }),
      p = await context.newPage(),
      errors = [];
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.goto(`http://127.0.0.1:${server.address().port}`);
    const done = () =>
      p.waitForFunction(
        () => globalThis.document.querySelector('#status').textContent !== 'Working',
      );
    await p.locator('#import').setInputFiles(file);
    await done();
    assert.match(await p.locator('#status').innerText(), /^Imported/);
    const native = await p.locator('#summary').textContent(),
      evidence = JSON.parse(await p.locator('#preview').getAttribute('data-evidence'));
    assert.equal(evidence.mode, 'browser-reference');
    const pixel = await p
      .locator('#preview')
      .evaluate((c) => Array.from(c.getContext('2d').getImageData(100, 80, 1, 1).data));
    assert(pixel[0] > 200);
    await p.locator('#export').click();
    await done();
    assert.notEqual(await p.locator('#status').innerText(), 'Verified MP4 download requested');
    assert.equal(await p.locator('#summary').textContent(), native);
    const refusal = await p.locator('#status').innerText(),
      download = p.waitForEvent('download');
    await p.locator('#save').click();
    await (await download).saveAs(path.join(out, mode + '.vbp'));
    results.push({
      mode,
      state: 'PASS',
      evidence,
      pixel,
      exportRefusal: refusal,
      nativePreserved: true,
      errors,
    });
    assert.deepEqual(errors, []);
    await context.close();
  }
  if (iphone) {
    const p = await browser.newPage();
    await p.goto(`http://127.0.0.1:${server.address().port}`);
    await p.locator('#import').setInputFiles(iphone);
    await p.waitForFunction(
      () => globalThis.document.querySelector('#status').textContent !== 'Working',
    );
    const status = await p.locator('#status').innerText(),
      summary = JSON.parse(await p.locator('#summary').textContent());
    assert.equal(summary.sources, 0);
    assert.match(status, /size|quota|large|MiB|budget/i);
    results.push({
      mode: 'iphone-original',
      state: 'CAPABILITY GAP',
      status,
      bytes: (await stat(iphone)).size,
      nativeUnchanged: true,
    });
    await p.close();
  }
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
