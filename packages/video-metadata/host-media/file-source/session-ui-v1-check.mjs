import { productBuild } from '../product-build.mjs';
import { outputOracleV1 } from './output-oracle-v1.mjs';
import { writeDigestProvenance } from '../../file-backed-storage/integration/provenance.mjs';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
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
  entryPoint: 'packages/video-metadata/host-media/file-source/session-ui-v1.mjs',
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
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  args: ['--no-sandbox'],
});
const proofs = [];
let result;
const file = path.join(out, 'full-v1.mp4');
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      acceptDownloads: true,
    });
    const page = await context.newPage(),
      errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(() => globalThis.videoV1Ready);
    await expect(
      page.getByRole('button', { name: 'Save portable project', exact: true }),
    ).toBeDisabled();
    await expect(page.locator('#open')).toBeDisabled();
    await page.locator('#import').setInputFiles(original);
    await expect(page.locator('#status')).toHaveText('Import complete', { timeout: 120000 });
    const native = async () => JSON.parse(await page.locator('#native').textContent());
    const base = await native();
    assert.equal(
      base.sources[0].asset.sha256,
      '69e089ae0cc9ad02b7d2461965d6a00d47cb91f7b02e620d10db9ec356731dd4',
    );
    assert.deepEqual(base.sequence.duration, { value: 42251, timescale: 600 });
    await page.locator('#at').fill('1/1000');
    const click = (name) => page.getByRole('button', { name, exact: true }).click();
    await click('Split linked clips');
    const split = await native();
    assert.equal(split.sequence.clips.length, 4);
    await click('Undo');
    assert.deepEqual(await native(), base);
    const revision = await page.locator('main').getAttribute('data-revision');
    await page.locator('#at').fill('-1');
    await click('Split linked clips');
    assert.deepEqual(await native(), base);
    assert.equal(await page.locator('main').getAttribute('data-revision'), revision);
    await click('Redo');
    assert.deepEqual(await native(), split);
    await click('Undo');
    // Real UI trim -> linked move -> resize, then restore the exact whole original.
    await page.locator('#trim-start').fill('1/1000');
    await page.locator('#trim-end').fill('42251/600');
    for (const c of base.sequence.clips) {
      await page.locator('#selected').selectOption(c.id);
      await click('Trim selected clip');
    }
    await page.locator('#at').fill('-1/1000');
    await click('Move linked clips');
    await page.locator('#duration').fill('52813/750');
    await click('Resize sequence');
    const trimmed = await native();
    assert.deepEqual(trimmed.sequence.duration, { value: 52813, timescale: 750 });
    assert.deepEqual(trimmed.sources, base.sources);
    for (const c of trimmed.sequence.clips) {
      assert.deepEqual(c.start, { value: 0, timescale: 1 });
      assert.deepEqual(c.sourceIn, { value: 1, timescale: 1000 });
      assert.deepEqual(c.sourceOut, { value: 42251, timescale: 600 });
      assert.deepEqual(c.duration, { value: 52813, timescale: 750 });
    }
    for (let n = 0; n < 4; n++) await click('Undo');
    assert.deepEqual(await native(), base);
    // A non-integral output endpoint is explicitly unsupported for real-time playback.
    await page.locator('#trim-start').fill('0');
    await page.locator('#trim-end').fill('1/7');
    for (const c of base.sequence.clips) {
      await page.locator('#selected').selectOption(c.id);
      await click('Trim selected clip');
    }
    await page.locator('#duration').fill('1/7');
    await click('Resize sequence');
    await page.locator('#preview-frame').fill('0');
    await click('Play');
    await expect(page.locator('#status')).toContainText('integral 48000 Hz presentation endpoint');
    for (let n = 0; n < 3; n++) await click('Undo');
    assert.deepEqual(await native(), base);
    await page.locator('#preview-frame').fill('880');
    await click('Preview frame');
    await expect(page.locator('#status')).toHaveText('Preview complete', { timeout: 120000 });
    await page.screenshot({ path: path.join(out, `ui-${width}.png`), fullPage: true });
    await page.locator('#preview-frame').fill('1750');
    await click('Play');
    await expect(page.locator('#status')).toHaveText('Playback complete', { timeout: 120000 });
    const playback = JSON.parse(await page.locator('#playback').textContent());
    assert.equal(playback.state, 'ended');
    if (width === 1280) {
      const download = page.waitForEvent('download', { timeout: 660000 });
      download.catch(() => {});
      await click('Export MP4');
      await (await download).saveAs(file);
      await expect(page.locator('#status')).toHaveText('Export complete');
    }
    assert.deepEqual(errors, []);
    proofs.push({ width, base, split, trimmed, playback, errors });
    await page.evaluate(() => globalThis.closeVideoV1());
    await context.close();
  }
  const probe = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], {
      maxBuffer: 1024 * 1024,
    }),
  );
  const video = probe.streams.find((s) => s.codec_type === 'video'),
    audio = probe.streams.find((s) => s.codec_type === 'audio');
  assert.equal(video.width, 1080);
  assert.equal(video.height, 1920);
  assert.equal(Number(video.nb_frames), 1761);
  assert.equal(audio.channels, 1);
  assert.equal(audio.sample_rate, '48000');
  for (const stream of [video, audio])
    assert(Math.abs(Number(stream.duration) - 42251 / 600) < 1e-6);
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
  assert.equal(packets.length, 1761);
  assert.equal(Number(packets.at(-1).pts), 3379200);
  assert.equal(Number(packets.at(-1).duration), 880);
  execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], {
    maxBuffer: 1024 * 1024,
  });
  const independent = await outputOracleV1(original, file, out);
  result = {
    state: 'PASS',
    code: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    workingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
    proofs,
    probe,
    lastVideoPacket: packets.at(-1),
    independent,
    outputSha256: createHash('sha256')
      .update(await readFile(file))
      .digest('hex'),
  };
} catch (e) {
  result = { state: 'FAIL', error: String(e), stack: e.stack, proofs };
  process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
await writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
