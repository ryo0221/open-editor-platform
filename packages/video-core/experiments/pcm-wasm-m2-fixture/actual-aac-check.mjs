/** Manual actual AAC/browser correctness and independent FFmpeg comparison. No benchmark. */
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
import { productBuild } from '../../../video-metadata/host-media/product-build.mjs';
const base = dirname(fileURLToPath(import.meta.url)),
  [depsArg, outArg] = process.argv.slice(2);
if (!depsArg || !outArg)
  throw Error('Usage: actual-aac-check.mjs <verified dependency root> <fresh external evidence>');
const deps = resolve(depsArg),
  out = resolve(outArg),
  repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
if (out === repo || out.startsWith(repo + '/')) throw Error('Keep evidence outside Git');
const sha = (x) => createHash('sha256').update(x).digest('hex');
const sources = JSON.parse(await readFile(resolve(base, 'REAL-CONSUMER-SOURCES.json'), 'utf8'));
for (const f of sources.packageFiles)
  assert.equal(sha(await readFile(resolve(deps, 'node_modules', f.path))), f.sha256, f.path);
for (const f of sources.repositoryFiles.filter((f) => /product-build|encoder-state/.test(f.path)))
  assert.equal(sha(await readFile(resolve(repo, f.path))), f.sha256, f.path);
const timingSha256 = '85917ad1d02d64554e4db0ad2d2a191ea00e6c922cfd1b49beba87b510997acc';
assert.equal(
  sha(await readFile(resolve(base, '../../../video-metadata/host-media/encoder-timing.mjs'))),
  timingSha256,
);
await mkdir(out);
const inventory = execFileSync(process.execPath, [resolve(base, 'aac-inventory.mjs'), deps], {
  encoding: 'utf8',
});
await writeFile(resolve(out, 'aac-inventory.json'), inventory);
const build = await productBuild(deps, {
  entryPoint: resolve(base, 'actual-aac-browser.mjs'),
  metafile: true,
});
await writeFile(resolve(out, 'fixture.js'), build.outputFiles[0].contents);
await writeFile(resolve(out, 'metafile.json'), JSON.stringify(build.metafile, null, 2));
const evidence = {
  code: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }),
  scope: 'actual accepted AAC encoder/worker, private fixture only',
  bundleSha256: sha(build.outputFiles[0].contents),
  timingSha256,
  aacInventory: JSON.parse(inventory),
  toolVersions: Object.fromEntries(
    ['ffmpeg', 'ffprobe'].map((tool) => [
      tool,
      execFileSync(tool, ['-version'], { encoding: 'utf8' }).split('\n')[0],
    ]),
  ),
  results: [],
  independent: [],
  errors: [],
};
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/fixture.js' ? 'application/javascript' : 'text/html');
  res.end(
    req.url === '/fixture.js'
      ? build.outputFiles[0].contents
      : '<!doctype html><title>Actual AAC ownership fixture</title><script src="/fixture.js"></script>',
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let browser;
try {
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
  evidence.engine = browser.version();
  for (const spec of [
    { mode: 'buffer', count: 1000 },
    { mode: 'resource', count: 1000 },
    { mode: 'buffer', count: 1024 },
    { mode: 'resource', count: 1024 },
    ...['abort-after-post', 'close-after-post', 'post-throw'].map((fault) => ({
      mode: 'resource',
      count: 1024,
      fault,
    })),
  ]) {
    const context = await browser.newContext(),
      page = await context.newPage();
    page.on('pageerror', (e) => evidence.errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') evidence.errors.push(m.text());
    });
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      const result = await page.evaluate(async (spec) => {
        let timeout;
        try {
          return await Promise.race([
            globalThis.actualAacCase(spec),
            new Promise((_, reject) => {
              timeout = globalThis.setTimeout(
                () => reject(Error('AAC correctness deadline')),
                30000,
              );
            }),
          ]);
        } finally {
          globalThis.clearTimeout(timeout);
        }
      }, spec);
      const name = `${spec.mode}-${spec.count}-${spec.fault ?? 'none'}`;
      if (result.bytes) {
        await writeFile(resolve(out, name + '.mp4'), new Uint8Array(result.bytes));
        result.outputSha256 = sha(new Uint8Array(result.bytes));
        delete result.bytes;
      }
      evidence.results.push(result);
    } catch (error) {
      evidence.results.push({ ...spec, status: 'FAIL', error: String(error) });
      throw error;
    } finally {
      await context.close();
      await writeFile(resolve(out, 'results.json'), JSON.stringify(evidence, null, 2) + '\n');
    }
  }
  for (const count of [1000, 1024]) {
    const reports = [];
    for (const mode of ['buffer', 'resource']) {
      const input = resolve(out, `${mode}-${count}-none.mp4`),
        pcm = resolve(out, `${mode}-${count}.f32`);
      const probe = JSON.parse(
        execFileSync(
          'ffprobe',
          [
            '-v',
            'error',
            '-select_streams',
            'a:0',
            '-show_streams',
            '-show_packets',
            '-show_data_hash',
            'sha256',
            '-of',
            'json',
            input,
          ],
          { encoding: 'utf8' },
        ),
      );
      await writeFile(resolve(out, `${mode}-${count}-probe.json`), JSON.stringify(probe, null, 2));
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-i',
        input,
        '-map',
        '0:a:0',
        '-c:a',
        'pcm_f32le',
        '-f',
        'f32le',
        pcm,
      ]);
      const data = readFileSync(pcm),
        s = probe.streams[0];
      assert.equal(s.sample_rate, '48000');
      assert.equal(s.channels, 1);
      assert.equal(s.time_base, '1/48000');
      assert.equal(s.start_pts, 0);
      assert.equal(s.duration_ts, count);
      assert.deepEqual(
        probe.packets.map((p) => [p.pts, p.dts, p.duration]),
        [
          [-1024, -1024, 1024],
          [0, 0, count],
        ],
      );
      assert.equal(probe.packets[0].side_data_list[0].skip_samples, 1024);
      assert.ok(data.length >= count * 4);
      assert.ok(data.length - count * 4 < 1024 * 4);
      reports.push({ probe, pcm: data });
    }
    const inputs = evidence.results.filter((r) => r.count === count && r.fault === 'none');
    assert.equal(inputs.length, 2);
    assert.deepEqual(
      inputs[0].samples.map((s) => [s.first, s.end, s.inputHash]),
      inputs[1].samples.map((s) => [s.first, s.end, s.inputHash]),
    );
    const select = (p) =>
      p.packets.map((x) => ({
        pts: x.pts,
        dts: x.dts,
        duration: x.duration,
        size: x.size,
        hash: x.data_hash,
        side_data: x.side_data_list,
      }));
    assert.deepEqual(select(reports[0].probe), select(reports[1].probe));
    assert.deepEqual(reports[0].pcm, reports[1].pcm);
    assert.equal(reports[0].probe.packets[0].pts, -1024);
    evidence.independent.push({
      count,
      status: 'PASS',
      presentation: [0, count],
      timeBase: '1/48000',
      allPacketPtsDtsDurationPayloadHashesEqual: true,
      allDecodedPcmBitsEqual: true,
      decodedFrames: reports[0].pcm.length / 4,
      trailingDecodedFrames: reports[0].pcm.length / 4 - count,
      pcmSha256: sha(reports[0].pcm),
    });
  }
  assert.deepEqual(evidence.errors, []);
} catch (error) {
  evidence.failure = String(error);
  process.exitCode = 1;
} finally {
  await writeFile(resolve(out, 'results.json'), JSON.stringify(evidence, null, 2) + '\n');
  await browser?.close();
  await new Promise((r) => server.close(r));
}
console.log(JSON.stringify(evidence, null, 2));
