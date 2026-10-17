import { productBuild } from '../product-build.mjs';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
const [deps, out] = process.argv.slice(2);
await mkdir(out);
execFileSync('ffmpeg', [
  '-v',
  'error',
  '-f',
  'lavfi',
  '-i',
  `testsrc2=size=640x360:rate=25:duration=2,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709`,
  '-f',
  'lavfi',
  '-i',
  `sine=frequency=660:sample_rate=44100:duration=2`,
  '-c:v',
  'libx264',
  '-profile:v',
  'high',
  '-level',
  '4.0',
  '-bf',
  '0',
  '-g',
  '25',
  '-pix_fmt',
  'yuv420p',
  '-colorspace',
  'bt709',
  '-color_primaries',
  'bt709',
  '-color_trc',
  'bt709',
  '-color_range',
  'tv',
  '-c:a',
  'aac',
  '-ac',
  '1',
  '-af',
  'volume=7.2',
  '-b:a',
  '128k',
  '-movflags',
  '+faststart+write_colr',
  path.join(out, 'two-seconds.mp4'),
]);
const notice = await readFile(
  'packages/video-metadata/file-backed-storage/integration/NOBLE-HASHES-LICENSE.txt',
  'utf8',
);
const built = await productBuild(deps, {
  entryPoint: 'packages/video-metadata/host-media/m2/mount-test-entry.mjs',
  banner: { js: '/*! @noble/hashes1.8.0\n' + notice + '\n*/' },
});
const html = (
  await readFile('packages/video-metadata/host-media/m2/editing-ui.html', 'utf8')
).replace('<main', '<input id="fixture" type="file" hidden><main');
const server = createServer((q, r) => {
  r.setHeader('content-type', q.url === '/run.js' ? 'application/javascript' : 'text/html');
  r.end(
    q.url === '/run.js'
      ? built.outputFiles[0].contents
      : q.url === '/empty'
        ? '<!doctype html><title>Fresh origin check</title>'
        : html,
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  args: ['--no-sandbox'],
});
const proofs = [],
  errors = [];
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } }),
      page = await context.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.exposeFunction('captureMount', () =>
      page.screenshot({ path: path.join(out, `mount-${width}.png`), fullPage: true }),
    );
    page.on('console', (m) => {
      if (m.type() === 'log') console.log(m.text());
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('#fixture').setInputFiles(path.join(out, 'two-seconds.mp4'));
    const result = await page.evaluate(() => globalThis.runMountCheck());
    proofs.push({ width, ...result });
    await context.close();
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
const result = {
  code: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }),
  state: 'PASS',
  proofs,
  errors,
};
await writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
