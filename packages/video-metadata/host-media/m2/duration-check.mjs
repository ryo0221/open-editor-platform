import { productBuild } from '../product-build.mjs';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
const [deps, out, mode] = process.argv.slice(2);
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
  entryPoint: 'packages/video-metadata/host-media/m2/portable-test-entry.mjs',
  banner: { js: '/*! @noble/hashes1.8.0\n' + notice + '\n*/' },
});
const html = (
  await readFile('packages/video-metadata/host-media/m2/editing-ui.html', 'utf8')
).replace(
  '<main',
  '<input id="inspect" type="file" hidden><input id="bad" type="file" hidden><main',
);
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
const errors = [],
  proofs = [],
  url = `http://127.0.0.1:${server.address().port}`;

async function open(width) {
  const context = await browser.newContext({
      viewport: { width, height: 900 },
      acceptDownloads: true,
    }),
    page = await context.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(url + '/empty');
  assert.equal(
    await page.evaluate(async () => {
      const root = await globalThis.navigator.storage.getDirectory();
      let count = 0;
      for await (const entry of root.values()) {
        void entry;
        count++;
      }
      return count;
    }),
    0,
    'Origin not empty before Host mount',
  );
  await page.goto(url);
  await page.evaluate(() => globalThis.videoV2Ready);
  return { context, page };
}
const click = (page, name) => page.getByRole('button', { name, exact: true }).click();
const native = async (page) => JSON.parse(await page.locator('#native').textContent());
const download = async (page, name, action) => {
  const [d] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), action()]);
  const file = path.join(out, name);
  await d.saveAs(file);
  return file;
};
const inspect = async (page, file) => {
  await page.locator('#inspect').setInputFiles(file);
  return page.evaluate(() => globalThis.inspectPortableV2());
};
try {
  for (const width of [1280, 390]) {
    const { context, page } = await open(width);
    await page.locator('#import').setInputFiles(path.join(out, 'two-seconds.mp4'));
    await expect(page.locator('#status')).toHaveText('Import complete', { timeout: 120000 });
    await page.locator('#duration').fill('2');
    await click(page, 'Resize sequence');
    await page
      .locator('#selected')
      .selectOption((await native(page)).sequence.clips.find((c) => c.kind === 'audio').id);
    await page.locator('#gain').fill('25');
    await click(page, 'Set volume');
    const gained = await native(page);
    await click(page, 'Undo');
    const before = await native(page);
    const revision = await page.locator('main').getAttribute('data-revision');
    // Full 2-second clip plus a pending Redo; resize below must reject.
    if (mode !== 'save') {
      await page.locator('#duration').fill('1');
      await click(page, 'Resize sequence');
      await expect(page.locator('#status')).toContainText('Clip exceeds sequence');
      await expect(page.locator('#duration')).toHaveValue('1');
      assert.deepEqual(await native(page), before);
      assert.equal(await page.locator('main').getAttribute('data-revision'), revision);
      await click(page, 'Redo');
      assert.deepEqual(await native(page), gained, 'Rejected resize lost Redo');
      await expect(page.locator('#duration')).toHaveValue('1');
      await click(page, 'Undo');
    }
    const saveRevision = await page.locator('main').getAttribute('data-revision');
    await page.locator('#duration').fill('3');
    const saved = await download(page, `duration-${width}.zip`, () =>
      click(page, 'Save portable project'),
    );
    await expect(page.locator('#status')).toHaveText('Save complete');
    await expect(page.locator('#duration')).toHaveValue('3');
    assert.deepEqual(await native(page), before);
    assert.equal(await page.locator('main').getAttribute('data-revision'), saveRevision);
    const archive = await inspect(page, saved);
    assert.equal(archive.versions.length, 1);
    assert.deepEqual(archive.versions[0].content, before, 'Save applied unsubmitted duration');
    await click(page, 'Redo');
    assert.deepEqual(await native(page), gained, 'Save lost Redo');
    await expect(page.locator('#duration')).toHaveValue('3');
    await click(page, 'Reset duration');
    await expect(page.locator('#duration')).toHaveValue('2/1');
    assert.deepEqual(await native(page), gained, 'Reset submitted an edit');
    await click(page, 'Undo');
    assert.deepEqual(await native(page), before, 'Reset added history');
    await click(page, 'Redo');
    assert.deepEqual(await native(page), gained);
    await page.locator('#duration').fill('3');
    await click(page, 'Resize sequence');
    await expect(page.locator('#duration')).toHaveValue('3/1');
    assert.deepEqual((await native(page)).sequence.duration, { value: 3, timescale: 1 });
    await click(page, 'Undo');
    await expect(page.locator('#duration')).toHaveValue('2/1');
    assert.deepEqual(await native(page), gained);
    await click(page, 'Redo');
    await expect(page.locator('#duration')).toHaveValue('3/1');
    await page.screenshot({ path: path.join(out, `duration-${width}.png`), fullPage: true });
    proofs.push({
      width,
      rejection: 'PASS',
      save: 'PASS',
      redo: 'PASS',
      reset: 'PASS',
      applyUndoRedo: 'PASS',
    });
    await page.evaluate(() => globalThis.closeVideoV2());
    await context.close();
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
const result = {
  state: 'PASS',
  code: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }),
  proofs,
  errors,
};
await writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
