import { outputOracleV1 } from './output-oracle-v1.mjs';
import { productBuild } from '../product-build.mjs';
import { chromium } from '@playwright/test';
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
const built = await productBuild(deps, {
  entryPoint: 'packages/video-metadata/host-media/file-source/export-v1-run.mjs',
});
const server = createServer((q, r) => {
  r.setHeader('content-type', q.url === '/run.js' ? 'application/javascript' : 'text/html');
  r.end(
    q.url === '/run.js'
      ? built.outputFiles[0].text
      : '<!doctype html><input id="source" type="file"><script src="/run.js"></script>',
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  args: ['--no-sandbox'],
});
let result;
try {
  const page = await browser.newPage({ acceptDownloads: true }),
    errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('#source').setInputFiles(original);
  const download = page.waitForEvent('download', { timeout: 660000 });
  download.catch(() => {});
  const evidence = await page.evaluate(() => globalThis.exportV1Original());
  await (await download).saveAs(path.join(out, 'full-v1.mp4'));
  const probe = JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_streams',
        '-show_format',
        '-of',
        'json',
        path.join(out, 'full-v1.mp4'),
      ],
      { maxBuffer: 1024 * 1024 },
    ),
  );
  await writeFile(path.join(out, 'ffprobe.json'), JSON.stringify(probe, null, 2));
  const v = probe.streams.find((s) => s.codec_type === 'video'),
    a = probe.streams.find((s) => s.codec_type === 'audio');
  assert.equal(v.width, 1080);
  assert.equal(v.height, 1920);
  assert.equal(Number(v.nb_frames), 1761);
  assert.equal(a.channels, 1);
  assert.equal(a.sample_rate, '48000');
  assert(Math.abs(Number(v.duration) - 42251 / 600) < 1e-6);
  assert(Math.abs(Number(a.duration) - 42251 / 600) < 1e-6);
  execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(out, 'full-v1.mp4'), '-f', 'null', '-'], {
    maxBuffer: 1024 * 1024,
  });
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
        path.join(out, 'full-v1.mp4'),
      ],
      { maxBuffer: 1024 * 1024 },
    ),
  ).packets;
  assert.equal(packets.length, 1761);
  assert.equal(Number(packets.at(-1).duration), 880);
  assert.equal(v.time_base, '1/48000');
  const independent = await outputOracleV1(original, path.join(out, 'full-v1.mp4'), out);
  assert.deepEqual(errors, []);
  result = {
    state: 'PASS',
    independent,
    code: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    workingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }),
    evidence,
    probe,
    lastVideoPacket: packets.at(-1),
    outputSha256: createHash('sha256')
      .update(await readFile(path.join(out, 'full-v1.mp4')))
      .digest('hex'),
    errors,
  };
} catch (e) {
  result = { state: 'FAIL', error: String(e), stack: e.stack };
  console.log(JSON.stringify(result));
  process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
await writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
