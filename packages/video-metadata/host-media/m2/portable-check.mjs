import { productBuild } from '../product-build.mjs';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
const [deps, fixtures, out] = process.argv.slice(2);
await mkdir(out);
const files = ['portrait-rotated.mp4', 'landscape.mp4', 'music.m4a'].map((f) =>
  path.join(fixtures, f),
);
const stereo = path.join(out, 'stereo.m4a');
execFileSync('ffmpeg', [
  '-v',
  'error',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=330:sample_rate=44100:duration=2.2',
  '-af',
  'volume=7.2',
  '-ac',
  '2',
  '-c:a',
  'aac',
  '-b:a',
  '128k',
  '-movflags',
  '+faststart',
  stereo,
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
let saved, nativeGood;
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
  const { context, page } = await open(1280);
  for (let i = 0; i < 3; i++) {
    await page.locator('#import-kind').selectOption(i < 2 ? 'av-sdr-v2' : 'aac-mono-v2');
    if (i === 2) await page.locator('#audio-start').fill('1/1000');
    await page.locator('#import').setInputFiles(files[i]);
    await expect(page.locator('#status')).toHaveText('Import complete', { timeout: 120000 });
  }
  let n = await native(page);
  const music = n.sequence.clips.find((c) => c.trackId === 'music').id;
  for (const voice of n.sequence.clips.filter((c) => c.trackId === 'audio')) {
    await page.locator('#selected').selectOption(voice.id);
    await page.locator('#gain').fill('25');
    await click(page, 'Set volume');
  }
  await page.locator('#selected').selectOption(music);
  await page.locator('#trim-start').fill('1/1000');
  await page.locator('#trim-end').fill('1999/1000');
  await click(page, 'Trim selected clip');
  await page.locator('#duration').fill('2');
  await click(page, 'Resize sequence');
  await page.locator('#gain').fill('20');
  await click(page, 'Set volume');
  const first = await download(page, 'first.zip', () => click(page, 'Save portable project')),
    before = await inspect(page, first);
  assert.equal(before.versions.length, 1);
  await page.locator('#fade-in').fill('1/10');
  await page.locator('#fade-out').fill('1/10');
  await click(page, 'Set fades');
  nativeGood = await native(page);
  saved = await download(page, 'edited.zip', () => click(page, 'Save portable project'));
  const second = await inspect(page, saved);
  assert.equal(second.versions.length, 2);
  assert.deepEqual(second.versions[0], before.versions[0]);
  assert.deepEqual(second.versions.at(-1).content, nativeGood);
  await page.locator('#bad').setInputFiles(stereo);
  for (const retainedOnly of [false, true]) {
    const [d, forgery] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate((flag) => globalThis.makeStereoPortableV2(flag), retainedOnly),
    ]);
    const bad = path.join(out, d.suggestedFilename());
    await d.saveAs(bad);
    assert.equal(forgery.kind, 'v2');
    assert.equal(forgery.selectedHasMusic, !retainedOnly);
    const namespaces = await page.evaluate(() => globalThis.m2Namespaces()),
      revision = await page.locator('main').getAttribute('data-revision');
    await page.locator('#open').setInputFiles(bad);
    await expect(page.locator('#status')).toContainText('mono', { timeout: 120000 });
    assert.deepEqual(await native(page), nativeGood);
    assert.equal(await page.locator('main').getAttribute('data-revision'), revision);
    assert.equal(
      await page.evaluate(() => globalThis.m2Namespaces()),
      namespaces,
      'Rejected source published namespace',
    );
    proofs.push({ negative: forgery, unchangedNative: true, noTargetNamespace: true });
  }
  const [validDownload, validRetained] = await Promise.all([
    page.waitForEvent('download'),
    page.evaluate(() => globalThis.makeStereoPortableV2(true, false)),
  ]);
  await validDownload.saveAs(path.join(out, 'valid-retained.zip'));
  assert.deepEqual(validRetained.admitted, {
    selectedSources: 2,
    liveOriginals: 2,
    retainedOriginals: 3,
  });
  proofs.push({ validRetained });
  await page.screenshot({ path: path.join(out, 'original-host.png'), fullPage: true });
  await page.evaluate(() => globalThis.closeVideoV2());
  await context.close();
  for (const width of [1280, 390]) {
    const { context, page } = await open(width);
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
      1,
      'Unexpected fresh origin data beyond empty candidate namespace',
    );
    await page.locator('#open').setInputFiles(saved);
    await expect(page.locator('#status')).toHaveText('Ready', { timeout: 120000 });
    await expect.poll(() => native(page), { timeout: 120000 }).toEqual(nativeGood);
    assert.deepEqual(await native(page), nativeGood);
    await page.locator('#preview-frame').fill('25');
    await click(page, 'Preview frame');
    await expect(page.locator('#status')).toHaveText('Preview complete', { timeout: 120000 });
    await page.locator('#preview-frame').fill('0');
    await click(page, 'Play');
    await expect(page.locator('#status')).toHaveText('Playback complete', { timeout: 120000 });
    const exported = await download(page, `reopened-${width}.mp4`, () => click(page, 'Export MP4'));
    execFileSync('ffmpeg', ['-v', 'error', '-i', exported, '-f', 'null', '-']);
    const next = await download(page, `reopened-${width}.zip`, () =>
      click(page, 'Save portable project'),
    );
    const reopened = await inspect(page, next);
    assert.equal(reopened.versions.length, 3);
    assert.deepEqual(reopened.versions.slice(0, 2), second.versions);
    assert.deepEqual(reopened.versions.at(-1).content, nativeGood);
    assert.deepEqual(reopened.originals.sort(), second.originals.sort());
    assert(
      await page.evaluate(
        () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
      ),
    );
    await page.screenshot({ path: path.join(out, `reopened-${width}.png`), fullPage: true });
    await page.evaluate(() => globalThis.closeVideoV2());
    await context.close();
    proofs.push({ width, reopened });
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
console.log(JSON.stringify({ state: result.state, code: result.code, groups: proofs.length }));
