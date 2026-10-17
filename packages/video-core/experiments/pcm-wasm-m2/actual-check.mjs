import { verifyPreview } from './preview-oracle.mjs';
import { verifyActualOutput } from '../../../video-metadata/host-media/m2/actual-output-oracle.mjs';
import { consumerBuild as productBuild } from './build.mjs';
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
process.env.M2_PCM_BUILD = out;
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
  entryPoint: 'packages/video-metadata/host-media/m2/portable-ui.mjs',
  banner: { js: '/*! @noble/hashes1.8.0\n' + notice + '\n*/' },
});
const html = await readFile('packages/video-metadata/host-media/m2/editing-ui.html');
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
try {
  for (const kind of ['two-direct', 'single-reopened']) {
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
    for (const id of first) await trim(id, '0', kind === 'two-direct' ? '2' : '4');
    await resize(kind === 'two-direct' ? '2' : '4');
    if (kind === 'two-direct') {
      await importFile(two);
      for (const c of (await native(page)).sequence.clips.filter((c) => !first.includes(c.id)))
        await trim(c.id, '2', '4');
      await resize('4');
    }
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
    await writeFile(path.join(out, kind + '-native.json'), JSON.stringify(content, null, 2));
    let archive;
    if (kind === 'single-reopened') {
      archive = await download(page, 'single.zip', 'Save portable project');
      assert(
        (await stat(archive)).size < 256 * 1024 ** 2,
        'Single-original archive exceeds unchanged cap',
      );
      await page.evaluate(() => globalThis.closeVideoV2());
      await context.close();
      ({ context, page } = await open());
      await page.locator('#open').setInputFiles(archive);
      await expect.poll(() => native(page), { timeout: 180000 }).toEqual(content);
    }
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(page.locator('#playback')).toHaveText('Playback: playing', { timeout: 180000 });
    await page.getByRole('button', { name: 'Stop media', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled({
      timeout: 180000,
    });
    const stopped = await page.evaluate(() => globalThis.privatePcmDiagnostics());
    await writeFile(path.join(out, kind + '-stop.json'), JSON.stringify(stopped, null, 2));
    assert.equal(stopped.realmBytes, stopped.moduleBytes, 'Stop did not drain managed owners');
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(page.locator('#playback')).toHaveText('Playback: ended', { timeout: 180000 });
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled({
      timeout: 180000,
    });
    const playback = JSON.parse(await page.locator('#playback-debug').textContent());
    await writeFile(path.join(out, kind + '-playback.json'), JSON.stringify(playback, null, 2));
    assert.ok(playback.frames.length > 0);
    const preview = await page.evaluate(() => globalThis.privatePreview);
    await writeFile(path.join(out, kind + '-preview.json'), JSON.stringify(preview));
    const previewOracle = verifyPreview(content, filesByHash, preview);
    await page.evaluate(() => {
      globalThis.privateNativeEncoder = globalThis.VideoEncoder;
      globalThis.privateCancelledFrames = 0;
      globalThis.VideoEncoder = class extends globalThis.privateNativeEncoder {
        encode(...args) {
          super.encode(...args);
          globalThis.privateCancelledFrames++;
          globalThis.document.querySelectorAll('button').forEach((b) => {
            if (b.textContent === 'Stop media') b.click();
          });
        }
      };
    });
    let cancelledDownloads = 0;
    const unexpectedDownload = () => cancelledDownloads++;
    page.on('download', unexpectedDownload);
    await click(page, 'Export MP4');
    await expect
      .poll(() => page.evaluate(() => globalThis.privateCancelledFrames), { timeout: 180000 })
      .toBe(1);
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled({
      timeout: 180000,
    });
    page.off('download', unexpectedDownload);
    assert.equal(cancelledDownloads, 0, 'Cancelled export published an output');
    const cancelledExport = await page.evaluate(() => {
      globalThis.VideoEncoder = globalThis.privateNativeEncoder;
      return globalThis.privatePcmDiagnostics();
    });
    assert.equal(
      cancelledExport.realmBytes,
      cancelledExport.moduleBytes,
      'Cancelled export PCM did not drain',
    );
    assert.deepEqual(await native(page), content);
    await writeFile(
      path.join(out, kind + '-cancelled-export.json'),
      JSON.stringify(cancelledExport, null, 2),
    );
    const output = await download(page, kind + '.mp4', 'Export MP4');
    await expect(page.locator('#status')).toHaveText('Export complete');
    assert.deepEqual(await native(page), content);
    const encodedEvidence = await page.evaluate(() => globalThis.privateLastExport);
    assert.deepEqual(
      playback.chunks.map((x) => [x.first, x.end, x.hash]),
      encodedEvidence.chunkEvidence.map((x) => [x.first, x.end, x.hash]),
    );
    for (const source of encodedEvidence.pcmReader) {
      assert.ok(source.identity.originalHash);
      assert.equal(source.backend.backend, process.env.M2_PCM_MODE ?? 'js');
      assert.equal(source.backend.fallback, false);
      assert.ok(source.backend.completedRequests > 0);
      if (process.env.M2_PCM_MODE === 'wasm') {
        assert.ok(source.backend.invocations > 0, 'Forced WASM did no kernel work');
        assert.equal(source.backend.invocations, source.backend.completions);
      }
    }
    const backend = await page.evaluate(() => globalThis.privatePcmDiagnostics());
    assert.equal(backend.realmBytes, backend.moduleBytes, 'Export did not drain managed owners');
    assert.ok(backend.realmPeak <= 8 * 1024 * 1024);
    assert.ok(backend.sessions.some((x) => x.completedRequests > 0));
    for (const session of backend.sessions) {
      assert.equal(session.backend, process.env.M2_PCM_MODE ?? 'js');
      assert.equal(session.fallback, false);
      assert.equal(session.drained, true);
      assert.equal(session.externalBytes, 0);
      if (process.env.M2_PCM_MODE === 'wasm')
        assert.equal(
          session.wasmSha256,
          '142871dcfdb24035b228f42ae72a369f6fb389d9b179a13512ae0053901a6bca',
        );
    }
    await page.screenshot({ path: path.join(out, kind + '.png'), fullPage: true });
    await page.evaluate(() => globalThis.closeVideoV2());
    await context.close();
    const oracle = verifyActualOutput(content, filesByHash, output, canvas);
    proofs.push({
      kind,
      stopped,
      previewOracle,
      cancelledExport,
      encodedEvidence,
      playback,
      backend,
      native: content,
      canvas,
      outputHash: sha(output),
      archiveHash: archive ? sha(archive) : null,
      archiveBytes: archive ? (await stat(archive)).size : null,
      outputBytes: (await stat(output)).size,
      oracle,
    });
    await writeFile(path.join(out, kind + '-oracle.json'), JSON.stringify(proofs.at(-1), null, 2));
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(files.map(sha), hashes, 'Original bytes changed');
} catch (error) {
  const pages = [];
  for (const context of browser.contexts())
    for (const page of context.pages()) {
      pages.push(
        await page
          .evaluate(() => ({
            status: globalThis.document.querySelector('#status')?.textContent,
            playback: globalThis.document.querySelector('#playback-debug')?.textContent,
            backend: globalThis.privatePcmDiagnostics?.(),
          }))
          .catch((e) => ({ error: String(e) })),
      );
    }
  await writeFile(
    path.join(out, 'FAIL.json'),
    JSON.stringify({ error: String(error), pages, proofs, errors }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
const result = {
  state: 'PASS',
  code: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }),
  mode: process.env.M2_PCM_MODE ?? 'js',
  hashes,
  originalBytes,
  browser: browser.version(),
  ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0],
  attribution: {
    dataset: 'VISION',
    creator: 'CSP Lab., University of Florence (2017)',
    license: 'CC BY-SA 4.0',
    source: 'https://lesc.dinfo.unifi.it/VISION/README.txt',
    mediaRedistributed: false,
  },
  proofs,
  errors,
};
await writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2));
console.log(
  JSON.stringify({
    state: result.state,
    code: result.code,
    proofs: proofs.map((p) => ({
      kind: p.kind,
      audio: p.oracle.audio,
      pictures: p.oracle.pictures,
    })),
  }),
);
