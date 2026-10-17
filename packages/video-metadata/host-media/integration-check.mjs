import { productBuild } from './product-build.mjs';
import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import assert from 'node:assert/strict';
import console from 'node:console';
const [deps, source, out] = process.argv.slice(2);
assert(deps && source && out);
await mkdir(out);
const build = await productBuild(deps),
  html = await readFile('packages/video-metadata/host-media/browser-host.html');
const server = createServer((q, r) => {
  r.setHeader('content-type', q.url === '/host.js' ? 'application/javascript' : 'text/html');
  r.end(q.url === '/host.js' ? build.outputFiles[0].text : html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`,
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] }),
  results = [];
try {
  for (const width of [1280, 390]) {
    const errors = [];
    const observe = (p) => {
      p.on('pageerror', (e) => errors.push(String(e)));
      p.on('request', (r) =>
        assert(
          r.url().startsWith(url) || r.url().startsWith('data:') || r.url().startsWith('blob:'),
        ),
      );
    };
    let context = await browser.newContext({
        viewport: { width, height: 950 },
        acceptDownloads: true,
      }),
      p = await context.newPage();
    observe(p);
    await p.goto(url);
    const done = () =>
      p.waitForFunction(
        () => globalThis.document.querySelector('#status').textContent !== 'Working',
      );
    const native = async () => JSON.parse(await p.locator('#summary').textContent()).native;
    const field = (name) => p.getByLabel(name, { exact: true }),
      button = (name) => p.getByRole('button', { name, exact: true });
    await p.locator('#import').setInputFiles(source);
    await done();
    assert.match(await p.locator('#status').innerText(), /^Imported/);
    await p.locator('#preview-frame').fill('1199');
    await p.locator('#seek-preview').click();
    await done();
    const endSeek = JSON.parse(await p.locator('#preview').getAttribute('data-evidence'));
    assert.equal(endSeek.mode, 'exact-indexed');
    await field('Split at sequence frame').fill('1150');
    await button('Split linked clips').click();
    let content = await native();
    assert.equal(content.sequence.clips.length, 4);
    const early = content.sequence.clips.filter((c) => c.start.value === 0),
      late = content.sequence.clips.filter((c) => c.start.value === 46);
    assert.equal(early.length, 2);
    assert.equal(late.length, 2);
    for (const c of early) {
      await field('Selected clip').selectOption(c.id);
      await field('Trim start (rational seconds)').fill('1');
      await field('Trim end (rational seconds)').fill('3');
      await button('Apply independent trim').click();
    }
    // Stage the earlier pair away from the destination before the linked reorder.
    await field('Selected clip').selectOption(early.find((c) => c.kind === 'video').id);
    await field('Move linked clips to frame').fill('100');
    await button('Move linked clips to target').click();
    // Reorder actual timeline positions through native linked move commands.
    await field('Selected clip').selectOption(late.find((c) => c.kind === 'video').id);
    await field('Move linked clips to frame').fill('0');
    await button('Move linked clips to target').click();
    await field('Selected clip').selectOption(early.find((c) => c.kind === 'video').id);
    await field('Move linked clips to frame').fill('50');
    await button('Move linked clips to target').click();
    await field('Sequence duration (rational seconds)').fill('4');
    await button('Apply sequence duration').click();
    content = await native();
    await writeFile(path.join(out, `edited-${width}.json`), JSON.stringify(content, null, 2));
    assert.deepEqual(content.sequence.duration, { value: 4, timescale: 1 });
    assert.equal(content.sequence.clips.length, 4);
    const videos = content.sequence.clips
      .filter((c) => c.kind === 'video')
      .sort((a, b) => a.start.value / a.start.timescale - b.start.value / b.start.timescale);
    assert.deepEqual(
      videos.map((c) => [
        c.start.value / c.start.timescale,
        c.sourceIn.value / c.sourceIn.timescale,
        c.duration.value / c.duration.timescale,
      ]),
      [
        [0, 46, 2],
        [2, 1, 2],
      ],
    );
    const download = p.waitForEvent('download');
    await p.locator('#save').click();
    const bundle = path.join(out, `long-${width}.vbp`);
    await (await download).saveAs(bundle);
    await context.close();
    context = await browser.newContext({ viewport: { width, height: 950 }, acceptDownloads: true });
    p = await context.newPage();
    observe(p);
    await p.addInitScript(() => {
      const Base = globalThis.AudioContext;
      globalThis.AudioContext = class extends Base {
        constructor(...args) {
          super(...args);
          globalThis.testAudio = this;
        }
      };
    });
    await p.goto(url);
    await p.locator('#open').setInputFiles(bundle);
    await done();
    assert.match(await p.locator('#status').innerText(), /^Reopened/);
    assert.deepEqual(await native(), content);
    await p.locator('#preview-frame').fill('0');
    await p.locator('#play-preview').click();
    await p.waitForFunction(
      () =>
        JSON.parse(globalThis.document.querySelector('#playback-status').dataset.evidence).chunks
          .length >= 4,
      {},
      { timeout: 90000 },
    );
    await p.evaluate(() => {
      globalThis.oldAudio = globalThis.testAudio;
    });
    await p.locator('#preview-frame').fill('40');
    await p.locator('#play-preview').click();
    await p.waitForFunction(
      () => globalThis.document.querySelector('#playback-status').textContent.startsWith('ended'),
      {},
      { timeout: 90000 },
    );
    const seekPlayback = JSON.parse(
      await p.locator('#playback-status').getAttribute('data-evidence'),
    );
    assert.equal(seekPlayback.chunks[0].first, 76800);
    assert.equal(await p.evaluate(() => globalThis.oldAudio.state), 'closed');
    await p.locator('#preview-frame').fill('0');
    await p.locator('#play-preview').click();
    await p.waitForFunction(
      () =>
        JSON.parse(globalThis.document.querySelector('#playback-status').dataset.evidence).chunks
          .length >= 4,
      {},
      { timeout: 90000 },
    );
    await p.evaluate(() => {
      const proto = globalThis.Blob.prototype,
        read = proto.arrayBuffer;
      globalThis.delayInjected = false;
      proto.arrayBuffer = async function () {
        if (!globalThis.delayInjected && this.size > 12000 && this.size < 25000) {
          globalThis.delayInjected = true;
          proto.arrayBuffer = read;
          await new Promise((r) => globalThis.setTimeout(r, 500));
        }
        return read.call(this);
      };
    });
    await p.waitForFunction(
      () =>
        JSON.parse(globalThis.document.querySelector('#playback-status').dataset.evidence).rebuffer
          .length > 0,
    );
    await p.evaluate(async () => {
      await globalThis.testAudio.suspend();
      globalThis.suspendAt = globalThis.testAudio.currentTime;
    });
    await p.waitForFunction(() =>
      globalThis.document.querySelector('#playback-status').textContent.startsWith('suspended'),
    );
    await p.evaluate(async () => {
      if (globalThis.testAudio.currentTime !== globalThis.suspendAt)
        throw Error('Suspended clock moved');
      await globalThis.testAudio.resume();
    });
    await p.waitForFunction(
      () => globalThis.document.querySelector('#playback-status').textContent.startsWith('ended'),
      {},
      { timeout: 90000 },
    );
    const playback = JSON.parse(await p.locator('#playback-status').getAttribute('data-evidence'));
    assert.equal(playback.suspensions, 1);
    assert(playback.rebuffer.length > 0);
    assert.equal(playback.clock, 'output-timestamp');
    assert(playback.maxScheduledSamples <= 18000);
    assert(playback.frames.length > 0);
    for (const row of playback.frames) assert.equal(Math.floor(row.sample / 1920), row.frame);
    assert(playback.frames.some((r) => r.frame < 50));
    assert(playback.frames.some((r) => r.frame >= 50));
    await p.evaluate(() => {
      globalThis.AudioContext.prototype.getOutputTimestamp = undefined;
    });
    await p.locator('#preview-frame').fill('98');
    await p.locator('#play-preview').click();
    await p.waitForFunction(
      () => globalThis.document.querySelector('#playback-status').textContent.startsWith('ended'),
      {},
      { timeout: 90000 },
    );
    const estimated = JSON.parse(await p.locator('#playback-status').getAttribute('data-evidence'));
    assert.equal(estimated.clock, 'estimated-latency');
    assert.equal(estimated.chunks[0].first, 188160);
    await p.evaluate(() => {
      delete globalThis.AudioContext.prototype.getOutputTimestamp;
    });
    await p.locator('#preview-frame').fill('0');
    await p.locator('#play-preview').click();
    await p.waitForFunction(
      () =>
        JSON.parse(globalThis.document.querySelector('#playback-status').dataset.evidence).chunks
          .length >= 4,
      {},
      { timeout: 90000 },
    );
    await p.locator('#stop-preview').click();
    await p.waitForFunction(() =>
      globalThis.document.querySelector('#playback-status').textContent.startsWith('stopped'),
    );
    assert.equal(await p.evaluate(() => globalThis.testAudio.state), 'closed');
    const exporting = p.waitForEvent('download', { timeout: 120000 });
    await p.locator('#export').click();
    await done();
    assert.equal(await p.locator('#status').innerText(), 'Verified MP4 download requested');
    const file = path.join(out, `long-${width}.mp4`);
    await (await exporting).saveAs(file);
    const provenance = JSON.parse(await p.locator('#status').getAttribute('data-provenance'));
    assert.deepEqual(
      playback.chunks.map(({ first, end, hash }) => ({ first, end, hash })),
      provenance.chunkEvidence,
    );
    for (const row of playback.frames) {
      assert.equal(row.sourcePts, provenance.frameEvidence[row.frame].sourcePts);
      assert.equal(row.sourceScale, provenance.frameEvidence[row.frame].sourceScale);
      assert.equal(
        row.sample,
        Math.min(
          row.scheduledThrough,
          192000,
          row.origin + Math.max(0, Math.floor((row.outputContextTime - row.anchor) * 48000)),
        ),
      );
    }
    assert.equal(provenance.count, 192000);
    assert.equal(provenance.frameEvidence.length, 100);
    const probe = JSON.parse(
      execFileSync('ffprobe', [
        '-v',
        'error',
        '-show_streams',
        '-show_format',
        '-of',
        'json',
        file,
      ]),
    );
    for (const stream of probe.streams) {
      assert.equal(Number(stream.start_time), 0);
      assert.equal(Number(stream.duration), 4);
    }
    const times = JSON.parse(
      execFileSync('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'frame=best_effort_timestamp_time',
        '-of',
        'json',
        file,
      ]),
    ).frames;
    assert.equal(times.length, 100);
    for (let i = 0; i < 100; i++)
      assert(Math.abs(Number(times[i].best_effort_timestamp_time) - i / 25) < 1e-6);
    const pcm = execFileSync(
      'ffmpeg',
      ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 'f32le', '-'],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    const values = new Float32Array(
      pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength),
    );
    assert.equal(pcm.byteLength % 8, 0, 'Stereo PCM byte shape');
    assert(values.length >= 192000 * 2, 'Truncated valid stereo PCM');
    let maxLeft = 0;
    for (let i = 0; i < 192000; i++)
      for (let ch = 0; ch < 2; ch++) {
        const value = values[i * 2 + ch];
        assert(Number.isFinite(value), 'Nonfinite valid output PCM');
        if (ch === 0) maxLeft = Math.max(maxLeft, Math.abs(value));
      }
    assert(maxLeft < 0.15, 'Removed left impulse reappeared');
    const sourcePcm = execFileSync(
      'ffmpeg',
      ['-v', 'error', '-i', source, '-map', '0:a:0', '-f', 'f32le', '-'],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    const sourceValues = new Float32Array(
        sourcePcm.buffer.slice(sourcePcm.byteOffset, sourcePcm.byteOffset + sourcePcm.byteLength),
      ),
      boundaryWindows = [];
    for (const [first, end] of [
      [0, 128],
      [96000 - 128, 96000 + 128],
      [192000 - 128, 192000],
    ]) {
      let maxDiff = 0;
      for (let i = first; i < end; i++)
        for (let ch = 0; ch < 2; ch++) {
          const src = (i < 96000 ? 46 * 48000 + i : 48000 + i - 96000) * 2 + ch;
          assert(Number.isFinite(sourceValues[src]), 'Independent source boundary coverage');
          maxDiff = Math.max(maxDiff, Math.abs(values[i * 2 + ch] - sourceValues[src]));
        }
      assert(maxDiff < 0.1, 'Lossy AAC boundary/tail tolerance');
      boundaryWindows.push({ first, end, maxDiff });
    }
    let peak = 0;
    for (let i = 0; i < 192000; i++)
      if (Math.abs(values[i * 2 + 1]) > Math.abs(values[peak * 2 + 1])) peak = i;
    assert(Math.abs(peak - 34560) <= 2);
    const pixels = execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-i',
        file,
        '-map',
        '0:v:0',
        '-vf',
        'scale=1:1',
        '-pix_fmt',
        'rgb24',
        '-f',
        'rawvideo',
        '-',
      ],
      { maxBuffer: 1024 * 1024 },
    );
    assert.equal(pixels.length, 300);
    for (let i = 0; i < 100; i++) {
      const [r, g, b] = pixels.subarray(i * 3, i * 3 + 3);
      assert(
        i < 25
          ? g > 70 && r < 40 && b < 40
          : i < 50
            ? r > 220 && g > 220 && b > 220
            : b > 200 && r < 40,
      );
    }
    await p.screenshot({ path: path.join(out, `long-${width}.png`), fullPage: true });
    assert.deepEqual(errors, []);
    results.push({
      width,
      state: 'PASS',
      endSeek,
      seekPlayback,
      playback,
      estimated,
      seekReplacedContextClosed: true,
      stopClosed: true,
      provenance,
      outputSha256: createHash('sha256')
        .update(await readFile(file))
        .digest('hex'),
      independent: {
        duration: 4,
        frames: 100,
        rightImpulseSample: peak,
        validStereoFrames: 192000,
        allValidFinite: true,
        maxLeft,
        boundaryWindows,
        decodedSamples: values.length / 2,
      },
      errors,
    });
    await context.close();
  }
} catch (e) {
  results.push({ state: 'FAIL', error: String(e), stack: e.stack });
  process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
await writeFile(
  path.join(out, 'results.json'),
  JSON.stringify(
    {
      code: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      workingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }),
      results,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify(results, null, 2));
