import { productBuild } from '../../packages/video-metadata/host-media/product-build.mjs';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import assert from 'node:assert/strict';
const [out, deps] = process.argv.slice(2);
assert(out?.startsWith('/tmp/') && deps);
await mkdir(out);
const built = await productBuild(deps, {
  entryPoint: 'packages/video-metadata/host-animation/host-v3-harness.mjs',
});
const fonts = new Set([
  'manifest.json',
  'COPYRIGHT.txt',
  'NotoSansCJKjp-Regular.otf',
  'NotoSansCJKjp-Bold.otf',
]);
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/test.js') {
      res.setHeader('content-type', 'application/javascript');
      res.end(built.outputFiles[0].contents);
    } else if (req.url.startsWith('/office-fonts/') && fonts.has(req.url.slice(14)))
      res.end(await readFile(path.join('apps/playground/public', req.url)));
    else if (req.url === '/favicon.ico') res.writeHead(204).end();
    else res.end('<!doctype html><main></main><script type="module" src="/test.js"></script>');
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  args: ['--no-sandbox'],
});
const errors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.addInitScript(() => {
    globalThis.videoTextPermissionFixture = true;
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(() => globalThis.animationReady);
  const click = (name) => page.getByRole('button', { name, exact: true }).click();
  await click('Load fixed Japanese regular font');
  await expect(page.locator('#status')).toHaveText('Load fixed font complete', { timeout: 60000 });
  await page.selectOption('#title-kind', 'caption');
  await page.locator('#title-text').fill('読取専用の字幕');
  await click('Apply title');
  const native = await page.evaluate(() => globalThis.animationFixture.read());
  assert.equal(native.sequence.clips[0].kind, 'caption');
  await page.evaluate(async () => {
    await globalThis.animationFixture.save();
    await globalThis.animationFixture.capture();
    await globalThis.animationFixture.reopenWithEdit(false);
  });
  for (const format of ['SRT', 'VTT']) {
    const downloaded = page.waitForEvent('download');
    downloaded.catch(() => {});
    await click('Export captions ' + format);
    await expect(page.locator('#status')).toHaveText('Caption export complete', { timeout: 10000 });
    const text = await readFile(await (await downloaded).path(), 'utf8');
    assert(text.includes('読取専用の字幕'));
  }
  await click('Prepare retained title font');
  await expect(page.locator('#status')).toHaveText('Prepare title font complete');
  await click('Edit selected title');
  await page.locator('#title-text').fill('未確定変更');
  await click('Export captions SRT');
  await expect(page.locator('#status')).toContainText('EditUnavailable');
  assert.deepEqual(await page.evaluate(() => globalThis.animationFixture.read()), native);
  await page.evaluate(() => globalThis.animationFixture.close());
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(out, 'results.json'),
    JSON.stringify(
      {
        state: 'PASS',
        cases: [
          'read-only clean SRT/VTT download',
          'dirty input requires edit permission; native unchanged',
        ],
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
