import { Buffer } from 'node:buffer';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
const [deps, out] = process.argv.slice(2);
assert(deps && out, 'usage: h264-check.mjs ISOLATED_DEPS NEW_OUTPUT');
await mkdir(out);
const bundle = await build({
  stdin: {
    resolveDir: deps,
    contents: `
import { Output, Mp4OutputFormat, BufferTarget, VideoSampleSource, VideoSample } from 'mediabunny';
globalThis.encodeCase = async ({ width, height, numerator, denominator }) => {
  const canvas = new OffscreenCanvas(width,height), ctx = canvas.getContext('2d');
  const target = new BufferTarget(), output = new Output({ format: new Mp4OutputFormat(), target });
  const source = new VideoSampleSource({ codec:'avc', bitrate:8000000 });
  output.addVideoTrack(source,{frameRate:numerator/denominator});
  await output.start();
  for(let n=0;n<12;n++) {
    ctx.fillStyle='rgb('+n*16+',80,160)'; ctx.fillRect(0,0,width,height);
    const sample=new VideoSample(canvas,{ timestamp:n*denominator/numerator, duration:denominator/numerator });
    try { await source.add(sample); } finally { sample.close(); }
  }
  await output.finalize();
  return { bytes:Array.from(new Uint8Array(target.buffer)), state:output.state };
};`,
  },
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
});
const server = createServer((_q, r) => r.end('<!doctype html>'));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox'],
});
const results = [];
try {
  for (const [width, height] of [
    [1920, 1080],
    [1080, 1920],
  ])
    for (const [numerator, denominator] of [
      [24, 1],
      [25, 1],
      [30000, 1001],
    ]) {
      const name = `${width}x${height}-${numerator}-${denominator}`,
        page = await browser.newPage(),
        errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      try {
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.addScriptTag({ content: bundle.outputFiles[0].text });
        const encoded = await page.evaluate((args) => globalThis.encodeCase(args), {
          width,
          height,
          numerator,
          denominator,
        });
        assert.equal(encoded.state, 'finalized');
        const bytes = Buffer.from(encoded.bytes),
          file = path.join(out, name + '.mp4');
        assert(bytes.length > 0 && bytes.length < 16 * 1024 * 1024);
        await writeFile(file, bytes);
        const probe = JSON.parse(
          execFileSync(
            'ffprobe',
            [
              '-v',
              'error',
              '-select_streams',
              'v:0',
              '-show_streams',
              '-show_frames',
              '-of',
              'json',
              file,
            ],
            { maxBuffer: 16 * 1024 * 1024 },
          ),
        );
        assert.equal(probe.streams[0].codec_name, 'h264');
        assert.equal(probe.streams[0].width, width);
        assert.equal(probe.streams[0].height, height);
        assert.equal(probe.frames.length, 12);
        for (let n = 0; n < 12; n++)
          assert(
            Math.abs(Number(probe.frames[n].pts_time) - (n * denominator) / numerator) <= 0.000002,
            'PTS at ' + n,
          );
        assert(
          Math.abs(Number(probe.streams[0].duration) - (12 * denominator) / numerator) <= 0.000002,
          'duration',
        );
        const rgb = execFileSync(
          'ffmpeg',
          [
            '-v',
            'error',
            '-i',
            file,
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
        assert.equal(rgb.length, 36);
        for (let n = 0; n < 12; n++)
          for (const [c, value] of [n * 16, 80, 160].entries())
            assert(Math.abs(rgb[n * 3 + c] - value) <= 8, `color ${n}/${c}: ${rgb[n * 3 + c]}`);
        assert.deepEqual(errors, []);
        await writeFile(path.join(out, name + '.probe.json'), JSON.stringify(probe, null, 2));
        results.push({
          name,
          status: 'PASS',
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          frames: 12,
          ptsToleranceSeconds: 0.000002,
          colorTolerance8bit: 8,
        });
      } catch (error) {
        results.push({ name, status: 'FAIL', error: String(error) });
      } finally {
        await page.close();
      }
      console.log(results.at(-1));
    }
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
await writeFile(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
process.exitCode = results.some((r) => r.status === 'FAIL') ? 1 : 0;
