import { verifyActualOutput } from './actual-output-oracle.mjs';
import { productBuild } from '../product-build.mjs';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
const [deps, one, two, out] = process.argv.slice(2);
await mkdir(out);
for (const [name, channels] of [['music', 1]])
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=330:sample_rate=44100:duration=4.5',
    '-ac',
    String(channels),
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    path.join(out, name + '.m4a'),
  ]);
const notice = await readFile(
  'packages/video-metadata/file-backed-storage/integration/NOBLE-HASHES-LICENSE.txt',
  'utf8',
);
const built = await productBuild(deps, {
  entryPoint: 'packages/video-metadata/host-media/m2/capacity-validation-entry.mjs',
  banner: { js: '/*! @noble/hashes1.8.0\n' + notice + '\n*/' },
});
const html = (
  await readFile('packages/video-metadata/host-media/m2/editing-ui.html', 'utf8')
).replace('<main', '<input id="inspect" type="file" hidden><main');
const server = createServer((q, r) => {
  r.setHeader('content-type', q.url === '/run.js' ? 'application/javascript' : 'text/html');
  r.end(
    q.url === '/run.js'
      ? built.outputFiles[0].contents
      : q.url === '/empty'
        ? '<!doctype html><title>Fresh origin</title>'
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
const sha = (file) => execFileSync('sha256sum', [file], { encoding: 'utf8' }).split(' ')[0];
const files = [one, two, path.join(out, 'music.m4a')],
  hashes = files.map(sha);
const originalBytes = await Promise.all(files.map(async (file) => (await stat(file)).size));
assert(
  originalBytes[0] + originalBytes[1] > 256 * 1024 ** 2,
  'Combined original capacity scope changed',
);
assert.equal(hashes[0], '69e089ae0cc9ad02b7d2461965d6a00d47cb91f7b02e620d10db9ec356731dd4');
assert.equal(hashes[1], '2d9e3284f777980c212702f8cbfe03a3817d4ad9a2bd08ef8d21d805cd556022');
const filesByHash = new Map(hashes.map((h, i) => [h, files[i]])),
  canvas = { width: 1080, height: 1920, background: '#000000' };
const open = async () => {
  const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      acceptDownloads: true,
    }),
    page = await context.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/empty`);
  assert.equal(
    await page.evaluate(async () => {
      let n = 0;
      for await (const entry of (await globalThis.navigator.storage.getDirectory()).values()) {
        void entry;
        n++;
      }
      return n;
    }),
    0,
  );
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(() => globalThis.videoV2Ready);
  return { context, page };
};
const click = (page, name) => page.getByRole('button', { name, exact: true }).click();
const native = async (page) => JSON.parse(await page.locator('#native').textContent());
const download = async (page, name, button) => {
  const [d] = await Promise.all([
    page.waitForEvent('download', { timeout: 180000 }),
    click(page, button),
  ]);
  const file = path.join(out, name);
  await d.saveAs(file);
  return file;
};
const inspect = async (page, file) => {
  await page.locator('#inspect').setInputFiles(file);
  return page.evaluate(() => globalThis.capacityQA.inspect());
};
try {
  let { context, page } = await open();
  const importFile = async (file) => {
    await page.locator('#import').setInputFiles(file);
    await expect(page.locator('#status')).toHaveText('Import complete', { timeout: 120000 });
  };
  const trim = async (id, start, end) => {
    await page.locator('#selected').selectOption(id);
    await page.locator('#trim-start').fill(start);
    await page.locator('#trim-end').fill(end);
    await click(page, 'Trim selected clip');
  };
  const resize = async (value) => {
    await page.locator('#duration').fill(value);
    await click(page, 'Resize sequence');
  };
  await importFile(one);
  const first = (await native(page)).sequence.clips.map((c) => c.id);
  for (const id of first) await trim(id, '0', '2');
  await resize('2');
  await importFile(two);
  for (const c of (await native(page)).sequence.clips.filter((c) => !first.includes(c.id)))
    await trim(c.id, '2', '4');
  await resize('4');
  await page.locator('#import-kind').selectOption('aac-mono-v2');
  await page.locator('#audio-start').fill('1/1000');
  await importFile(files[2]);
  const music = (await native(page)).sequence.clips.find((c) => c.trackId === 'music').id;
  await trim(music, '1/1000', '3999/1000');
  await resize('4');
  await page.locator('#selected').selectOption(music);
  await page.locator('#gain').fill('20');
  await click(page, 'Set volume');
  await page.locator('#fade-in').fill('1/2');
  await page.locator('#fade-out').fill('1/2');
  await click(page, 'Set fades');
  const content = await native(page);
  const firstArchive = await download(page, 'two-originals-v1.zip', 'Save portable project');
  const firstHash = sha(firstArchive),
    firstBytes = (await stat(firstArchive)).size;
  assert(firstBytes > 256 * 1024 ** 2 && firstBytes <= 512 * 1024 ** 2);
  const firstStored = await inspect(page, firstArchive),
    firstStatus = await page.evaluate(() => globalThis.capacityQA.status());
  assert.equal(firstStored.versions.length, 1);
  assert.deepEqual(firstStored.versions[0].content, content);
  assert.equal(firstStatus.usage.reservations.length, 0);
  assert.equal(firstStatus.usage.reservedAdditionalBytes, 0);
  await writeFile(
    path.join(out, 'first-save.json'),
    JSON.stringify({ firstHash, firstBytes, firstStored, firstStatus }, null, 2),
  );
  await page.evaluate(() => globalThis.closeVideoV2());
  await context.close();
  ({ context, page } = await open());
  await page.locator('#validation-open').setInputFiles(firstArchive);
  await expect.poll(() => native(page), { timeout: 180000 }).toEqual(content);
  await click(page, 'Play');
  await expect(page.locator('#status')).toHaveText('Playback complete', { timeout: 180000 });
  const output = await download(page, 'two-originals-reopened.mp4', 'Export MP4');
  await expect(page.locator('#status')).toHaveText('Export complete');
  assert.deepEqual(await native(page), content);
  const oracle = verifyActualOutput(content, filesByHash, output, canvas);
  await writeFile(path.join(out, 'output-oracle.json'), JSON.stringify(oracle, null, 2));
  // New edit becomes a second retained native version on the first fresh-origin save.
  await page.locator('#selected').selectOption(music);
  await page.locator('#fade-in').fill('1/4');
  await page.locator('#fade-out').fill('1/4');
  await click(page, 'Set fades');
  const edited = await native(page),
    secondArchive = await download(page, 'two-originals-v2.zip', 'Save portable project'),
    secondHash = sha(secondArchive);
  const secondStored = await inspect(page, secondArchive),
    secondStatus = await page.evaluate(() => globalThis.capacityQA.status());
  assert.equal(secondStored.versions.length, 2);
  assert.deepEqual(secondStored.versions[0], firstStored.versions[0]);
  assert.deepEqual(secondStored.versions[1].content, edited);
  assert.deepEqual(secondStored.originals, firstStored.originals);
  assert.equal(secondStatus.usage.reservations.length, 0);
  assert.equal(secondStatus.usage.reservedAdditionalBytes, 0);
  assert.equal(secondStatus.media.files, 0);
  assert.equal(secondStatus.limits.externalBytes, 512 * 1024 ** 2);
  assert.equal(secondStatus.limits.scratchBytes, 512 * 1024 ** 2);
  assert.equal(secondStatus.limits.journalBytes, 1024 ** 3);
  assert.equal(secondStatus.policy.totalBytes, 2 * 1024 ** 3);
  for (const state of [firstStatus, secondStatus]) {
    assert(
      state.events.some(
        (e) =>
          e.name === 'reserve' && e.state === 'complete' && e.usage.reservedAdditionalBytes > 0,
      ),
    );
    assert(state.events.some((e) => e.name === 'candidate' && e.state === 'complete'));
    assert(
      state.events.some(
        (e) => e.name === 'settle' && e.state === 'complete' && e.usage.reservations.length === 0,
      ),
    );
  }
  await writeFile(
    path.join(out, 'resave.json'),
    JSON.stringify({ secondHash, secondStored, secondStatus }, null, 2),
  );
  await page.locator('#gain').fill('15');
  await click(page, 'Set volume');
  const refusal = await page.evaluate(() => globalThis.capacityQA.quotaRefusal());
  await writeFile(path.join(out, 'quota-refusal.json'), JSON.stringify(refusal, null, 2));
  await page.screenshot({ path: path.join(out, 'quota-refusal.png'), fullPage: true });
  assert.equal(sha(firstArchive), firstHash);
  assert.equal(sha(secondArchive), secondHash);
  assert.equal(refusal.retry.stored.versions.length, 3);
  assert.deepEqual(await native(page), refusal.retry.native.content);
  await page.evaluate(() => globalThis.closeVideoV2());
  await context.close();
  assert.deepEqual(files.map(sha), hashes);
  assert.deepEqual(errors, []);
  proofs.push({
    firstHash,
    firstBytes,
    secondHash,
    secondBytes: (await stat(secondArchive)).size,
    native: content,
    edited,
    oracle,
    firstStatus,
    secondStatus,
    refusal,
  });
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
const result = {
  state: 'PASS',
  code: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }),
  hashes,
  originalBytes,
  proofs,
  errors,
};
await writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2));
console.log(
  JSON.stringify({
    state: result.state,
    code: result.code,
    archiveBytes: proofs[0].firstBytes,
    retainedVersions: proofs[0].secondStatus.history.length,
    quota: proofs[0].refusal.refusal,
  }),
);
