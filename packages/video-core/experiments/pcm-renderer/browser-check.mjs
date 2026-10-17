import process from 'node:process';
import console from 'node:console';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const [deps, fixtures, out] = process.argv.slice(2);
if (!deps || !fixtures || !out) throw Error('deps fixtures output required');
await mkdir(out);
const source = path.resolve('packages/video-core/experiments/pcm-renderer/browser-run.ts');
const built = await build({
  stdin: {
    contents: `import {run,fractional} from ${JSON.stringify(source)};globalThis.run=run;globalThis.fractional=fractional;`,
    resolveDir: process.cwd(),
  },
  nodePaths: [path.join(deps, 'node_modules')],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
});
const server = createServer((_req, res) => res.end('<!doctype html>'));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox'],
  }),
  results = [],
  errors = [];
const cases = JSON.parse(await readFile(path.join(fixtures, 'results.json'), 'utf8')).filter(
  (c) => c.origin === 0 && c.count === c.rate + 123,
);
try {
  if (cases.length !== 2) throw Error('Expected 44.1/48 kHz fixtures');
  for (const c of cases) {
    const bytes = await readFile(path.join(fixtures, c.name + '.mp4'));
    if (createHash('sha256').update(bytes).digest('hex') !== c.sha256)
      throw Error('Fixture identity');
    const page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.addScriptTag({ content: built.outputFiles[0].text });
    results.push(
      await page.evaluate(({ bytes, rate, count }) => globalThis.run(bytes, rate, count), {
        bytes: Array.from(bytes),
        rate: c.rate,
        count: c.count,
      }),
    );
    const changed = fractionalEnd(bytes);
    await writeFile(path.join(out, `fractional-${c.rate}.mp4`), changed);
    results.push(
      await page.evaluate(({ bytes, rate }) => globalThis.fractional(bytes, rate), {
        bytes: Array.from(changed),
        rate: c.rate,
      }),
    );
    await page.close();
  }
  if (errors.length) throw Error(errors.join('\n'));
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
      errors,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify(results, null, 2));
function fractionalEnd(input) {
  const bytes = Uint8Array.from(input),
    v = new DataView(bytes.buffer);
  const boxes = (lo, hi) => {
    const list = [];
    while (lo < hi) {
      const n = v.getUint32(lo);
      if (n < 8 || lo + n > hi) throw Error('Fixture boxes');
      list.push({ lo, n, type: String.fromCharCode(...bytes.subarray(lo + 4, lo + 8)) });
      lo += n;
    }
    return list;
  };
  const one = (list, type) => {
    const found = list.filter((b) => b.type === type);
    if (found.length !== 1) throw Error('Fixture ' + type);
    return found[0];
  };
  const child = (b) => boxes(b.lo + 8, b.lo + b.n),
    moov = child(one(boxes(0, bytes.length), 'moov')),
    mvhd = one(moov, 'mvhd');
  if (v.getUint8(mvhd.lo + 8) !== 0) throw Error('Fixture mvhd version');
  v.setUint32(mvhd.lo + 20, 30000);
  v.setUint32(mvhd.lo + 24, 1001);
  const audio = moov
    .filter((b) => b.type === 'trak')
    .find((b) => {
      const h = one(child(one(child(b), 'mdia')), 'hdlr');
      return String.fromCharCode(...bytes.subarray(h.lo + 16, h.lo + 20)) === 'soun';
    });
  if (!audio) throw Error('Fixture audio');
  const track = child(audio),
    tkhd = one(track, 'tkhd'),
    elst = one(child(one(track, 'edts')), 'elst');
  if (v.getUint8(elst.lo + 8) !== 0 || v.getUint32(elst.lo + 12) !== 1)
    throw Error('Fixture one edit required');
  v.setUint32(tkhd.lo + 28, 1001);
  v.setUint32(elst.lo + 16, 1001);
  return bytes;
}
