import { productBuild } from './product-build.mjs';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
import path from 'node:path';
const [deps, fixture, out] = process.argv.slice(2);
assert(deps && fixture && out);
await mkdir(out);
const bundle = await productBuild(deps, {
  entryPoint: 'packages/video-metadata/host-media/finalize-probe.ts',
  transformAacForTest: (contents) => {
    const needle = 'async flush() {';
    assert.equal(contents.split(needle).length, 2);
    const close = '    this.videoHostOwner?.encoders.delete(this);';
    assert.equal(contents.split(close).length, 2);
    return contents
      .replace(
        needle,
        needle + '\n    if (globalThis.__holdAacFlush) await globalThis.__holdAacFlush();',
      )
      .replace(close, close + '\n    globalThis.__aacClosed?.();');
  },
});
const bytes = Array.from(await readFile(fixture)),
  server = createServer((_q, r) => r.end('<!doctype html>'));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox'],
  }),
  results = [];
try {
  for (const mode of ['resolve', 'reject']) {
    const page = await browser.newPage(),
      errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const row = await page.evaluate(({ bytes, mode }) => globalThis.finalizeProbe(bytes, mode), {
      bytes,
      mode,
    });
    results.push({ ...row, errors });
    await page.close();
  }
  for (const r of results) {
    assert.deepEqual(r.before, {
      jobSettled: false,
      underlyingFinalizePending: true,
      encoderStateCleared: false,
      drain: 'incomplete',
      competingJobRefused: true,
      closedEncoders: 1,
    });
    assert.equal(r.after.jobSettled, true);
    assert.equal(r.after.outcome, 'rejected');
    assert.equal(r.after.drain, 'drained');
    assert.equal(r.after.published, false);
    assert.equal(r.before.closedEncoders, 1);
    assert.equal(r.after.closedEncoders, 1);
    assert(r.recoveredMp4Bytes > 0);
    assert.deepEqual(r.errors, []);
    assert.equal(r.after.packetsAfter, r.after.packetsBefore);
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
      kind: 'actual-pinned-AAC-flush-delayed-before-worker-command',
      results,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify(results, null, 2));
