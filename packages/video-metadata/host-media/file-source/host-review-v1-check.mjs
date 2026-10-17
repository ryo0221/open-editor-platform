import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
const out = process.argv[2];
await mkdir(out);
const notice = await readFile(
  'packages/video-metadata/file-backed-storage/integration/NOBLE-HASHES-LICENSE.txt',
  'utf8',
);
const built = await build({
  entryPoints: ['packages/video-metadata/host-media/file-source/host-review-v1-run.mjs'],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  banner: { js: '/*! @noble/hashes1.8.0\n' + notice + '\n*/' },
});
const server = createServer((q, r) => {
  r.setHeader('content-type', q.url === '/run.js' ? 'application/javascript' : 'text/html');
  r.end(
    q.url === '/run.js'
      ? built.outputFiles[0].text
      : '<!doctype html><script src="/run.js"></script>',
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  args: ['--no-sandbox'],
});
let result;
try {
  const page = await browser.newPage(),
    errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const proof = await page.evaluate(() => globalThis.reviewHostV1());
  assert.deepEqual(errors, []);
  result = {
    state: 'PASS',
    proof,
    errors,
    code: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    workingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
  };
} catch (e) {
  result = { state: 'FAIL', error: String(e), stack: e.stack };
  process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
await writeFile(out + '/results.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
