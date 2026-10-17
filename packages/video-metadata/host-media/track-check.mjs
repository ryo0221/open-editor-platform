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
const bundled = await productBuild(deps, {
  entryPoint: 'packages/video-metadata/host-media/track-probe.ts',
  transformAacForTest: (contents) => {
    for (const [a, b] of [
      [
        'async flush() {',
        'async flush() {\n    if(globalThis.__holdAacFlush) await globalThis.__holdAacFlush();',
      ],
      [
        '    this.videoHostOwner?.encoders.delete(this);',
        '    this.videoHostOwner?.encoders.delete(this);\n    globalThis.__aacClosed?.();',
      ],
      [
        '      const pending = this.pendingMessages.get(data.id);',
        '      if (globalThis.__holdInitReply?.(this,data,()=>onMessage(data))) return;\n      const pending = this.pendingMessages.get(data.id);',
      ],
    ]) {
      assert.equal(contents.split(a).length, 2);
      contents = contents.replace(a, b);
    }
    return contents;
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
  for (const mode of ['aac-fails-video-held', 'video-fails-aac-held', 'init-reply-held']) {
    const page = await browser.newPage(),
      errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.addScriptTag({ content: bundled.outputFiles[0].text });
    const result = await page.evaluate(({ bytes, mode }) => globalThis.trackProbe(bytes, mode), {
      bytes,
      mode,
    });
    results.push({ ...result, errors });
    await page.close();
  }
  for (const r of results) {
    if (r.mode !== 'init-reply-held') {
      assert.equal(r.before.settled, false);
      assert.equal(r.before.held, true);
      assert.equal(r.before.stateHeld, true);
      assert.equal(r.before.competingRefused, true);
      assert.equal(r.before.drain, 'incomplete');
    } else {
      assert.equal(r.before.pendingRpcBefore, 1);
      assert.equal(r.before.pendingRpcAfter, 0);
      assert.equal(r.after.lateInitCtx, 0);
      assert.equal(r.after.workerRetained, false);
    }
    assert.equal(r.after.outcome, 'rejected');
    assert.equal(r.after.drain, 'drained');
    assert.equal(r.after.closed, 1);
    assert.equal(r.after.videoClosed, r.mode === 'init-reply-held' ? 0 : 1);
    assert.equal(r.after.published, false);
    assert(r.recovered > 0);
    assert.deepEqual(r.errors, []);
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
