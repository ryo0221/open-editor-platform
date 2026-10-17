import { productBuild } from '../product-build.mjs';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
const [deps, original, out, expectedExport] = process.argv.slice(2);
await mkdir(out);
const built = await productBuild(deps, {
  entryPoint: 'packages/video-metadata/host-media/file-source/play-v1-run.mjs',
});
const server = createServer((q, r) => {
  r.setHeader('content-type', q.url === '/run.js' ? 'application/javascript' : 'text/html');
  r.end(
    q.url === '/run.js'
      ? built.outputFiles[0].text
      : '<!doctype html><input id="source" type="file"><canvas width="270" height="480"></canvas><script src="/run.js"></script>',
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  args: ['--no-sandbox'],
});
let result;
try {
  const page = await browser.newPage({ acceptDownloads: true }),
    errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('#source').setInputFiles(original);
  const proof = await page.evaluate(() => globalThis.playV1Original());
  const exported = JSON.parse(await readFile(expectedExport, 'utf8'));
  const expected = exported.evidence.evidence.chunkEvidence.at(-1);
  assert.deepEqual(proof.contexts, ['closed']);
  assert.equal(proof.result.initialFrame.frame, 1750);
  assert.equal(proof.result.state, 'ended');
  assert(
    proof.result.chunks.some(
      (c) => c.first === expected.first && c.end === expected.end && c.hash === expected.hash,
    ),
  );
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(out, 'playing-tail.png') });
  result = {
    state: 'PASS',
    code: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    workingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
    proof,
    expected,
    errors,
  };
} catch (e) {
  result = { state: 'FAIL', error: String(e), stack: e.stack };
  console.log(JSON.stringify(result));
  process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
await writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
