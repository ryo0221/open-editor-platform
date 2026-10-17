import { productBuild } from '../product-build.mjs';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
const [deps, out] = process.argv.slice(2);
await mkdir(out);
const built = await productBuild(deps, {
  entryPoint: 'packages/video-metadata/host-media/m2/mount-race-entry.mjs',
});
const server = createServer((q, r) => {
  r.setHeader('content-type', q.url === '/run.js' ? 'application/javascript' : 'text/html');
  r.end(
    q.url === '/run.js'
      ? built.outputFiles[0].contents
      : '<!doctype html><script src="/run.js"></script>',
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox'],
  }),
  errors = [];
let cases;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  cases = await page
    .goto(`http://127.0.0.1:${server.address().port}`)
    .then(() => page.evaluate(() => globalThis.runMountRaces()));
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
const result = {
  code: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }),
  state: cases.every((c) => c.pass) && !errors.length ? 'PASS' : 'FAIL',
  cases,
  errors,
};
await writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
if (result.state === 'FAIL') process.exitCode = 1;
