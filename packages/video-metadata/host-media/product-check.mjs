import { Buffer } from 'node:buffer';
import { productBuild } from './product-build.mjs';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
const [deps, out] = process.argv.slice(2);
assert(deps && out);
await mkdir(out);
const raw = Buffer.alloc(48000 * 8);
for (let i = 0; i < 48000; i++)
  for (let ch = 0; ch < 2; ch++)
    raw.writeFloatLE(
      0.02 +
        0.03 * Math.sin((2 * Math.PI * (ch ? 700 : 440) * i) / 48000) +
        (i === (ch ? 34560 : 11520) ? 0.6 : 0),
      (i * 2 + ch) * 4,
    );
await writeFile(path.join(out, 'original.f32'), raw);
const original = path.join(out, 'original.mp4');
execFileSync('ffmpeg', [
  '-v',
  'error',
  '-y',
  '-f',
  'lavfi',
  '-i',
  "color=c=red:size=320x180:rate=25:duration=1,drawbox=c=blue:t=fill:enable='gte(t,0.4)',drawbox=c=green:t=fill:enable='gte(t,0.8)',setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709",
  '-f',
  'f32le',
  '-ar',
  '48000',
  '-ac',
  '2',
  '-i',
  path.join(out, 'original.f32'),
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  '-color_primaries',
  'bt709',
  '-color_trc',
  'bt709',
  '-colorspace',
  'bt709',
  '-c:a',
  'aac',
  '-b:a',
  '192k',
  '-movflags',
  '+faststart',
  original,
]);
const bundled = await productBuild(deps),
  html = await readFile('packages/video-metadata/host-media/browser-host.html');
const verifier = await build({
  stdin: {
    resolveDir: process.cwd(),
    contents: `import {decodeWindow} from './packages/video-core/experiments/pcm-renderer/native-aac.mjs';import {savedTiming} from './packages/video-core/experiments/local-codec/browser-aac.mjs';globalThis.verifySaved=async(bytes)=>{const buffer=new Uint8Array(bytes).buffer,t=savedTiming(buffer),pcm=[];for(let first=t.validStart;first<t.validEnd;first+=16000){const end=Math.min(first+16000,t.validEnd),w=await decodeWindow(buffer,{first,end,rate:t.mediaScale,channels:2},new AbortController().signal);for(let i=0;i<end-first;i++)pcm.push(w.planes[0][i],w.planes[1][i]);}return {pcm,first:t.validStart,end:t.validEnd,rate:t.mediaScale};};`,
  },
  nodePaths: [path.join(deps, 'node_modules')],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
});
const server = createServer((req, res) => {
  res.setHeader('content-type', req.url === '/host.js' ? 'application/javascript' : 'text/html');
  res.end(
    req.url === '/host.js'
      ? bundled.outputFiles[0].text
      : req.url === '/verify'
        ? '<!doctype html>'
        : html,
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`,
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] }),
  results = [];
try {
  for (const width of [1280, 390]) {
    const errors = [],
      requests = [];
    const observe = (p) => {
      p.on('pageerror', (e) => errors.push(String(e)));
      p.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      p.on('request', (r) => requests.push(r.url()));
    };
    const context = await browser.newContext({
        viewport: { width, height: 900 },
        acceptDownloads: true,
      }),
      p = await context.newPage();
    observe(p);
    await p.goto(url);
    const done = async (page) => {
      await page.waitForFunction(
        () => globalThis.document.querySelector('#status').textContent !== 'Working',
      );
    };
    await p.locator('#import').setInputFiles(original);
    await done(p);
    assert.match(
      await p.locator('#status').innerText(),
      /^Imported/,
      await p.locator('#status').innerText(),
    );
    const field = (name) => p.getByLabel(name, { exact: true });
    await field('Split at sequence frame').fill('20');
    await p.getByRole('button', { name: 'Split linked clips', exact: true }).click();
    const summary = () => p.locator('#summary').textContent().then(JSON.parse);
    const split = await summary();
    assert.equal(split.native.sequence.clips.length, 4);
    const tail = split.native.sequence.clips.find(
      (c) => c.kind === 'video' && c.start.value === 4 && c.start.timescale === 5,
    );
    assert(tail);
    await field('Selected clip').selectOption(tail.id);
    await p.getByRole('button', { name: 'Delete linked clips', exact: true }).click();
    await field('Sequence duration (rational seconds)').fill('4/5');
    await p.getByRole('button', { name: 'Apply sequence duration', exact: true }).click();
    const edited = await summary();
    assert.equal(edited.native.sequence.clips.length, 2);
    assert.deepEqual(edited.native.sequence.duration, { value: 4, timescale: 5 });
    await p.locator('#preview-frame').fill('15');
    await p.locator('#seek-preview').click();
    await done(p);
    assert.equal(await p.locator('#status').innerText(), 'Timeline frame ready');
    const pixel = await p
      .locator('#preview')
      .evaluate((c) => Array.from(c.getContext('2d').getImageData(100, 80, 1, 1).data));
    assert(pixel[2] > 200 && pixel[0] < 40);
    const snapshot = await summary(),
      preview = await p.locator('#preview').getAttribute('data-evidence');
    const download = p.waitForEvent('download');
    await p.locator('#save').click();
    const bundle = path.join(out, `project-${width}.vbp`);
    await (await download).saveAs(bundle);
    await context.close();
    const fresh = await browser.newContext({
        viewport: { width, height: 900 },
        acceptDownloads: true,
      }),
      q = await fresh.newPage();
    observe(q);
    await q.goto(url);
    await q.locator('#open').setInputFiles(bundle);
    await done(q);
    assert.match(
      await q.locator('#status').innerText(),
      /^Reopened/,
      await q.locator('#status').innerText(),
    );
    assert.deepEqual(JSON.parse(await q.locator('#summary').textContent()), snapshot);
    await q.locator('#preview-frame').fill('15');
    await q.locator('#seek-preview').click();
    await done(q);
    assert.equal(await q.locator('#preview').getAttribute('data-evidence'), preview);
    const exportDownload = q.waitForEvent('download', { timeout: 60000 });
    await q.locator('#export').click();
    await done(q);
    assert.equal(await q.locator('#status').innerText(), 'Verified MP4 download requested');
    const file = path.join(out, `export-${width}.mp4`);
    await (await exportDownload).saveAs(file);
    const provenance = JSON.parse(await q.locator('#status').getAttribute('data-provenance'));
    assert.equal(provenance.boundary, 'edge-hold-v0');
    await q.screenshot({ path: path.join(out, `product-${width}.png`), fullPage: true });
    let lateDownloads = 0;
    q.on('download', () => lateDownloads++);
    await q.evaluate(() => {
      const prototype = globalThis.AudioDecoder.prototype,
        decode = prototype.decode;
      globalThis.cancelledAfterAudioPacket = false;
      prototype.decode = function (chunk) {
        prototype.decode = decode;
        decode.call(this, chunk);
        globalThis.cancelledAfterAudioPacket = true;
        globalThis.document.querySelector('#cancel-export').click();
      };
    });
    await q.locator('#export').click();
    await done(q);
    assert(await q.evaluate(() => globalThis.cancelledAfterAudioPacket));
    assert.match(await q.locator('#status').innerText(), /Abort/);
    assert.equal(lateDownloads, 0);
    const recoveryDownload = q.waitForEvent('download');
    await q.locator('#export').click();
    await done(q);
    assert.equal(await q.locator('#status').innerText(), 'Verified MP4 download requested');
    await (await recoveryDownload).saveAs(path.join(out, `recovery-${width}.mp4`));
    assert.equal(lateDownloads, 1);
    const bytes = await readFile(file);
    const verifyPage = await fresh.newPage();
    observe(verifyPage);
    await verifyPage.goto(url + '/verify');
    await verifyPage.addScriptTag({ content: verifier.outputFiles[0].text });
    const native = await verifyPage.evaluate(
      (bytes) => globalThis.verifySaved(bytes),
      Array.from(bytes),
    );
    assert.equal(native.end - native.first, 38400);
    assert.equal(native.first, 1024);
    assert.equal(native.pcm.length, 76800);
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
    const audio = probe.streams.find((s) => s.codec_type === 'audio'),
      video = probe.streams.find((s) => s.codec_type === 'video');
    assert.equal(audio.start_time, '0.000000');
    assert.equal(video.start_time, '0.000000');
    assert.equal(audio.duration, '0.800000');
    assert.equal(video.duration, '0.800000');
    assert.equal(video.width, 1920);
    assert.equal(video.height, 1080);
    const tag = JSON.parse(probe.format.tags.comment);
    assert.equal(tag.boundary, 'edge-hold-v0');
    assert.equal(tag.snapshotHash, provenance.snapshotHash);
    const ff = execFileSync(
      'ffmpeg',
      ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 'f32le', '-'],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    assert(ff.length >= 76800 * 4);
    const reference = new Float32Array(
      ff.buffer.slice(ff.byteOffset, ff.byteOffset + ff.byteLength),
    );
    let maxDiff = 0;
    for (let i = 0; i < 76800; i++)
      maxDiff = Math.max(maxDiff, Math.abs(native.pcm[i] - reference[i]));
    assert(maxDiff < 0.0001, `Decoder difference ${maxDiff}`);
    const sourcePcmBytes = execFileSync(
      'ffmpeg',
      ['-v', 'error', '-i', original, '-map', '0:a:0', '-f', 'f32le', '-'],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    const sourcePcm = new Float32Array(
      sourcePcmBytes.buffer.slice(
        sourcePcmBytes.byteOffset,
        sourcePcmBytes.byteOffset + sourcePcmBytes.byteLength,
      ),
    );
    const sourceEndpoints = [
      Array.from(sourcePcm.slice(0, 2)),
      Array.from(sourcePcm.slice(76798, 76800)),
    ];
    for (let ch = 0; ch < 2; ch++) {
      assert(Math.abs(provenance.firstPcm[ch] - sourceEndpoints[0][ch]) < 0.01);
      assert(Math.abs(provenance.lastPcm[ch] - sourceEndpoints[1][ch]) < 0.01);
      assert(Math.abs(native.pcm[ch] - provenance.firstPcm[ch]) < 0.015);
      assert(Math.abs(native.pcm[76798 + ch] - provenance.lastPcm[ch]) < 0.015);
      assert(Math.abs(native.pcm[ch]) > 0.005 && Math.abs(native.pcm[76798 + ch]) > 0.005);
    }
    const peaks = [0, 1].map((ch) => {
      let at = 0;
      for (let i = 0; i < 38400; i++)
        if (Math.abs(native.pcm[i * 2 + ch]) > Math.abs(native.pcm[at * 2 + ch])) at = i;
      return at;
    });
    assert(Math.abs(peaks[0] - 11520) <= 2);
    assert(Math.abs(peaks[1] - 34560) <= 2);
    const frames = JSON.parse(
      execFileSync('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_frames',
        '-of',
        'json',
        file,
      ]),
    ).frames;
    assert.equal(frames.length, 20);
    for (let i = 0; i < 20; i++) assert(Math.abs(Number(frames[i].pts_time) - i / 25) < 1e-6);
    const pixels = execFileSync('ffmpeg', [
      '-v',
      'error',
      '-i',
      file,
      '-map',
      '0:v:0',
      '-vf',
      'scale=1:1',
      '-fps_mode',
      'passthrough',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      '-',
    ]);
    for (let i = 0; i < 20; i++) {
      const [r, g, b] = pixels.subarray(i * 3, i * 3 + 3);
      assert(i < 10 ? r > 200 && g < 50 && b < 50 : b > 200 && r < 50 && g < 50);
    }
    assert.deepEqual(errors, []);
    assert(
      requests.every(
        (r) =>
          r.startsWith(url) ||
          r.startsWith('blob:' + url) ||
          r.startsWith('data:application/wasm;base64,'),
      ),
      JSON.stringify(requests.filter((r) => !r.startsWith(url)).map((r) => r.slice(0, 100))),
    );
    results.push({
      state: 'PASS',
      width,
      code: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      steps: [
        'actual import',
        'linked split/delete',
        'sequence duration edit',
        'exact timeline seek',
        'save',
        'new-context bundle-only reopen',
        'actual 1080p AVC + stereo AAC export',
        'cancel after actual AAC packet submission: no download; fresh export recovers',
      ],
      originalSha256: createHash('sha256')
        .update(await readFile(original))
        .digest('hex'),
      outputSha256: createHash('sha256').update(bytes).digest('hex'),
      provenance,
      independent: {
        presentation: [0, 0.8],
        validSamples: 38400,
        sourceEndpoints,
        endpointTolerance: { renderedVsSource: 0.01, encodedVsRendered: 0.015 },
        nativeFirst: native.pcm.slice(0, 2),
        nativeLast: native.pcm.slice(-2),
        ffmpegFirst: Array.from(reference.slice(0, 2)),
        ffmpegLast: Array.from(reference.slice(76798, 76800)),
        maxDiff,
        peaks,
        videoFrames: 20,
        colorBoundaryFrame: 10,
        ffmpegDecodedSamples: ff.length / 8,
      },
      errors,
      localRequestsOnly: true,
    });
    await fresh.close();
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
