import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
const [deps, fixtures, out] = process.argv.slice(2);
assert(deps && fixtures && out);
await mkdir(out);
const source = path.resolve('packages/video-core/experiments/local-codec/browser-aac.mjs');
const bundle = await build({
  stdin: {
    contents: `import {decodeSavedAudio} from ${JSON.stringify(source)};globalThis.run=async(bytes)=>decodeSavedAudio(new Uint8Array(bytes).buffer);`,
    resolveDir: deps,
  },
  nodePaths: [path.join(deps, 'node_modules')],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
});
const cases = JSON.parse(await readFile(path.join(fixtures, 'results.json'), 'utf8'));
const server = createServer((_req, res) => res.end('<!doctype html>'));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox'],
  }),
  results = [];
try {
  for (const original of cases) {
    const bytes = await readFile(path.join(fixtures, original.name + '.mp4'));
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      original.sha256,
      'input differs from saved fixture',
    );
    for (const rational of [
      false,
      ...(original.origin === 0.125 && original.count <= 1024 ? [true] : []),
    ]) {
      const name = original.name + (rational ? '-rational-origin' : ''),
        fileBytes = rational ? rationalOrigin(bytes, original.rate, original.count) : bytes,
        page = await browser.newPage();
      try {
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.addScriptTag({ content: bundle.outputFiles[0].text });
        const detail = await page.evaluate((bytes) => globalThis.run(bytes), Array.from(fileBytes));
        assert.equal(detail.total, original.count);
        assert.equal(detail.mediaScale, original.rate);
        const desired = [Math.floor(original.count / 4), Math.floor((original.count * 3) / 4)];
        assert(detail.peaks.every((p, i) => Math.abs(p.peak - desired[i]) <= 2 && p.value > 0.01));
        if (rational) assert.deepEqual(detail.origin, { numerator: '1', denominator: '8' });
        else
          assert(
            BigInt(detail.origin.numerator) * BigInt(original.rate) ===
              BigInt(Math.round(original.origin * original.rate)) *
                BigInt(detail.origin.denominator),
          );
        let avSync = null;
        if (original.count > 1024) {
          const frames = JSON.parse(
            execFileSync('ffprobe', [
              '-v',
              'error',
              '-select_streams',
              'v:0',
              '-show_frames',
              '-of',
              'json',
              path.join(fixtures, original.name + '.mp4'),
            ]),
          ).frames;
          assert.equal(frames.length, 3);
          const differences = detail.peakCompositionTimes.map(
            (t, i) =>
              Number(t.numerator) / Number(t.denominator) -
              Number(frames[i + 1].best_effort_timestamp_time),
          );
          assert(differences.every((d) => Math.abs(d) <= 2 / original.rate + 1 / 90000));
          avSync = { status: 'PASS', differences };
        }
        results.push({
          avSync,
          name,
          status: 'PASS',
          originalStrictStatus: original.status,
          originalDecodeAudioDataCount: original.browserFrames,
          sha256: createHash('sha256').update(fileBytes).digest('hex'),
          detail,
        });
        if (rational) await writeFile(path.join(out, name + '.mp4'), fileBytes);
      } catch (error) {
        results.push({ name, status: 'FAIL', error: String(error) });
      } finally {
        await page.close();
      }
      console.log(name, results.at(-1).status);
    }
  }
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
await writeFile(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
process.exitCode = results.some((r) => r.status === 'FAIL') ? 1 : 0;
// Only creates a comparison fixture: one audio track, v0 boxes, 0.125s origin.
// No access units/track timebase are changed; not a general muxer implementation.
function rationalOrigin(input, rate, count) {
  const bytes = Uint8Array.from(input),
    v = new DataView(bytes.buffer),
    boxes = [];
  function walk(lo, hi) {
    while (lo < hi) {
      const n = v.getUint32(lo),
        type = String.fromCharCode(...bytes.subarray(lo + 4, lo + 8));
      assert(n >= 8 && lo + n <= hi);
      boxes.push({ lo, type, n });
      if (['moov', 'trak', 'mdia', 'edts'].includes(type)) walk(lo + 8, lo + n);
      lo += n;
    }
  }
  walk(0, bytes.length);
  const one = (type) => {
    const found = boxes.filter((b) => b.type === type);
    assert.equal(found.length, 1);
    assert.equal(v.getUint8(found[0].lo + 8), 0);
    return found[0].lo;
  };
  const mvhd = one('mvhd'),
    tkhd = one('tkhd'),
    elst = one('elst');
  assert.equal(v.getUint32(mvhd + 20), rate);
  assert.equal(v.getUint32(elst + 12), 2);
  assert.equal(v.getInt32(elst + 20), -1);
  v.setUint32(mvhd + 20, rate * 8);
  v.setUint32(mvhd + 24, rate + count * 8);
  v.setUint32(tkhd + 28, rate + count * 8);
  v.setUint32(elst + 16, rate);
  v.setUint32(elst + 28, count * 8);
  return bytes;
}
