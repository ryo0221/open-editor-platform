import { productBuild } from '../product-build.mjs';
import { reorderedOutputOracleV1 } from './reordered-oracle-v1.mjs';
import { writeDigestProvenance } from '../../file-backed-storage/integration/provenance.mjs';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
const [deps, original, out] = process.argv.slice(2);
await mkdir(out);
const notice = await readFile(
  'packages/video-metadata/file-backed-storage/integration/NOBLE-HASHES-LICENSE.txt',
  'utf8',
);
const built = await productBuild(deps, {
  entryPoint: 'packages/video-metadata/host-media/file-source/portable-ui-v1.mjs',
  metafile: true,
  banner: { js: '/*! @noble/hashes 1.8.0\n' + notice + '\n*/' },
});
await writeDigestProvenance(out, built);
await writeFile(path.join(out, 'THIRD-PARTY-NOTICES.txt'), notice);
await writeFile(path.join(out, 'bundle-meta.json'), JSON.stringify(built.metafile));
const html = await readFile('packages/video-metadata/host-media/file-source/session-ui-v1.html');
const server = createServer((q, r) => {
  r.setHeader('content-type', q.url === '/run.js' ? 'application/javascript' : 'text/html');
  r.end(q.url === '/run.js' ? built.outputFiles[0].contents : html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let browser, page, result;
const errors = [],
  proofs = [];
async function launch(width) {
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
  page = await browser.newPage({ viewport: { width, height: 900 }, acceptDownloads: true });
  await page.addInitScript(() => {
    globalThis.File.prototype.arrayBuffer = () => {
      throw Error('Whole File arrayBuffer prohibited');
    };
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(() => globalThis.videoV1Ready);
  assert.deepEqual(await page.evaluate(() => globalThis.videoPortable.initialEntries), []);
}
const click = (name) => page.getByRole('button', { name, exact: true }).click();
async function save(name) {
  const download = page.waitForEvent('download', { timeout: 300000 });
  download.catch(() => {});
  await click('Save portable project');
  await (await download).saveAs(path.join(out, name));
  await expect(page.locator('#status')).toHaveText('Save complete');
  return page.evaluate(() => globalThis.videoPortable.inspectSaved());
}
async function close() {
  await page.evaluate(() => globalThis.videoPortable.close());
  await browser.close();
  browser = undefined;
}
try {
  await launch(1280);
  await page.locator('#import').setInputFiles(original);
  await expect(page.locator('#status')).toHaveText('Import complete', { timeout: 120000 });
  const initial = await page.evaluate(() => globalThis.videoPortable.status());
  assert(initial.reconcileAvailable, 'Owner must expose same-storage reconciliation port');
  assert.equal(
    initial.originals[0].actualHash,
    '69e089ae0cc9ad02b7d2461965d6a00d47cb91f7b02e620d10db9ec356731dd4',
  );
  assert.equal(initial.originals[0].bytes, 146163851);
  const first = await save('first.zip');
  assert.equal(first.versions.length, 1);
  const native = async () => JSON.parse(await page.locator('#native').textContent());
  await page.locator('#at').fill('2001/1000');
  await click('Split linked clips');
  const split = await native();
  const firstPair = split.sequence.clips.filter((c) => c.start.value === 0);
  const lastPair = split.sequence.clips.filter((c) => c.start.value !== 0);
  await page.locator('#trim-start').fill('1/1000');
  await page.locator('#trim-end').fill('2001/1000');
  for (const clip of firstPair) {
    await page.locator('#selected').selectOption(clip.id);
    await click('Trim selected clip');
  }
  await page.locator('#trim-start').fill('41051/600');
  await page.locator('#trim-end').fill('42251/600');
  for (const clip of lastPair) {
    await page.locator('#selected').selectOption(clip.id);
    await click('Trim selected clip');
  }
  // Park the early pair beyond the old end, move the true-end pair to zero, then early pair to two.
  await page.locator('#selected').selectOption(firstPair.find((c) => c.kind === 'video').id);
  await page.locator('#at').fill('42251/600');
  await click('Move linked clips');
  await page.locator('#selected').selectOption(lastPair.find((c) => c.kind === 'video').id);
  await page.locator('#at').fill('-41051/600');
  await click('Move linked clips');
  await page.locator('#selected').selectOption(firstPair.find((c) => c.kind === 'video').id);
  await page.locator('#at').fill('-102629/1500');
  await click('Move linked clips');
  await page.locator('#duration').fill('4');
  await click('Resize sequence');
  const edited = await page.evaluate(() => globalThis.videoPortable.status());
  assert.equal(edited.native.sequence.clips.length, 4);
  assert.notEqual(edited.hash, initial.hash);
  assert.deepEqual(edited.native.sources, initial.native.sources);
  assert.deepEqual(edited.native.sequence.duration, { value: 4, timescale: 1 });
  const expectedMapping = [
    {
      start: { value: 0, timescale: 1 },
      duration: { value: 2, timescale: 1 },
      sourceIn: { value: 41051, timescale: 600 },
      sourceOut: { value: 42251, timescale: 600 },
    },
    {
      start: { value: 2, timescale: 1 },
      duration: { value: 2, timescale: 1 },
      sourceIn: { value: 1, timescale: 1000 },
      sourceOut: { value: 2001, timescale: 1000 },
    },
  ];
  for (const kind of ['video', 'audio']) {
    const mapping = edited.native.sequence.clips
      .filter((c) => c.kind === kind)
      .sort((a, b) => a.start.value / a.start.timescale - b.start.value / b.start.timescale)
      .map((c) => ({
        start: c.start,
        duration: c.duration,
        sourceIn: c.sourceIn,
        sourceOut: c.sourceOut,
      }));
    assert.deepEqual(mapping, expectedMapping);
  }
  const second = await save('reordered.zip');
  assert.equal(second.versions.length, 2);
  await click('Undo');
  await click('Redo');
  assert.deepEqual(
    (await page.evaluate(() => globalThis.videoPortable.status())).native,
    edited.native,
  );
  const third = await save('portable-v1.zip');
  assert.equal(third.versions.length, 3);
  assert.deepEqual(third.versions.slice(0, 2), second.versions);
  assert.deepEqual(third.originals, [{ hash: initial.originals[0].hash, bytes: 146163851 }]);
  await page.screenshot({ path: path.join(out, 'saved-1280.png'), fullPage: true });
  proofs.push({ stage: 'saved', initial, edited, first, second, third });
  await close();
  for (const width of [1280, 390]) {
    await launch(width);
    assert.equal(await page.locator('#timeline li').count(), 0);
    await page.locator('#open').setInputFiles(path.join(out, 'portable-v1.zip'));
    await expect(page.locator('#timeline li')).toHaveCount(4, { timeout: 300000 });
    const reopened = await page.evaluate(() => globalThis.videoPortable.status());
    assert.deepEqual(reopened.native, edited.native);
    assert.equal(reopened.hash, edited.hash);
    assert.deepEqual(reopened.originals, initial.originals);
    const admission = await page.evaluate(() => globalThis.videoPortable.admission);
    assert.deepEqual(admission, [{ kind: 'v1', retainedVersions: 3, originalProbes: 1 }]);
    const saved = await save(`reopened-${width}.zip`);
    assert.equal(saved.versions.length, 4);
    assert.deepEqual(saved.versions.slice(0, 3), third.versions);
    assert.deepEqual(saved.originals, third.originals);
    assert.deepEqual(saved.plans, third.plans);
    await page.locator('#preview-frame').fill('49');
    await click('Preview frame');
    await expect(page.locator('#status')).toHaveText('Preview complete', { timeout: 120000 });
    await page.screenshot({ path: path.join(out, `reopened-${width}.png`), fullPage: true });
    await page.locator('#preview-frame').fill('0');
    await click('Play');
    await expect(page.locator('#status')).toHaveText('Playback complete', { timeout: 120000 });
    const playback = JSON.parse(await page.locator('#playback').textContent());
    assert.equal(playback.state, 'ended');
    if (width === 1280) {
      const download = page.waitForEvent('download', { timeout: 660000 });
      download.catch(() => {});
      await click('Export MP4');
      await (await download).saveAs(path.join(out, 'reopened-edited.mp4'));
      await expect(page.locator('#status')).toHaveText('Export complete');
    }
    proofs.push({ stage: 'empty-origin-reopened', width, reopened, saved, admission, playback });
    await close();
  }
  const file = path.join(out, 'reopened-edited.mp4');
  const probe = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], {
      maxBuffer: 1024 * 1024,
    }),
  );
  const video = probe.streams.find((s) => s.codec_type === 'video'),
    audio = probe.streams.find((s) => s.codec_type === 'audio');
  assert.equal(video.width, 1080);
  assert.equal(video.height, 1920);
  assert.equal(Number(video.nb_frames), 100);
  assert.equal(audio.channels, 1);
  assert.equal(audio.sample_rate, '48000');
  for (const stream of [video, audio]) assert(Math.abs(Number(stream.duration) - 4) < 1e-6);
  const packets = JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_packets',
        '-show_entries',
        'packet=pts,duration',
        '-of',
        'json',
        file,
      ],
      { maxBuffer: 1024 * 1024 },
    ),
  ).packets;
  assert.equal(video.time_base, '1/48000');
  assert.equal(packets.length, 100);
  assert.equal(Number(packets.at(-1).pts), 190080);
  assert.equal(Number(packets.at(-1).duration), 1920);
  execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], {
    maxBuffer: 1024 * 1024,
  });
  const independent = await reorderedOutputOracleV1(original, file, out);
  assert.deepEqual(errors, []);
  result = {
    state: 'PASS',
    code: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    workingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
    proofs,
    probe,
    independent,
    lastVideoPacket: packets.at(-1),
    archiveBytes: (await stat(path.join(out, 'portable-v1.zip'))).size,
    outputSha256: createHash('sha256')
      .update(await readFile(file))
      .digest('hex'),
    errors,
  };
} catch (e) {
  result = { state: 'FAIL', error: String(e), stack: e.stack, proofs, errors };
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
}
await writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
