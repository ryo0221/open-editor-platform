import { productBuild } from './product-build.mjs';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
const [deps, fixture, out] = process.argv.slice(2);
await mkdir(out);
const bundle = await productBuild(deps, {
    entryPoint: 'packages/video-metadata/host-media/cleanup-probe.mjs',
  }),
  bytes = Array.from(await readFile(fixture));
const server = createServer((_q, r) => r.end('<!doctype html>'));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  }),
  results = [];
try {
  for (const mode of ['export', 'playback']) {
    const p = await browser.newPage(),
      errors = [];
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.goto(`http://127.0.0.1:${server.address().port}`);
    await p.addScriptTag({ content: bundle.outputFiles[0].text });
    const result = await p.evaluate(({ bytes, mode }) => globalThis.cleanupProbe(bytes, mode), {
      bytes,
      mode,
    });
    results.push({ ...result, errors });
    assert.equal(result.after.published, false);
    assert.match(result.after.rejected, /cleanup/i);
    assert.equal(result.after.video.sessions, 0);
    assert.equal(result.after.encoderRetained, false);
    assert.equal(result.after.scratch.files, 1);
    assert(result.recovered > 0);
    assert.deepEqual(errors, []);
    if (mode === 'playback') assert.equal(result.after.audioContext, 'closed');
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
