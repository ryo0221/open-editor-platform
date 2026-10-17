import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
const [deps, fixtures, out] = process.argv.slice(2);
if (!deps || !fixtures || !out) throw Error('deps fixtures fresh-output required');
await mkdir(out);
const entry = path.resolve('packages/video-core/experiments/pcm-renderer/boundary-browser-run.ts');
const built = await build({
  stdin: {
    resolveDir: process.cwd(),
    contents: `import {boundaries} from ${JSON.stringify(entry)};globalThis.boundaries=boundaries;`,
  },
  nodePaths: [path.join(deps, 'node_modules')],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
});
const cases = JSON.parse(await readFile(path.join(fixtures, 'results.json'), 'utf8')).filter(
  (c) => c.origin === 0 && [1, 17, 1024, 1025, c.rate + 123].includes(c.count),
);
const server = createServer((_q, r) => r.end('<!doctype html>'));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox'],
  }),
  results = [];
try {
  if (cases.length !== 10) throw Error('Expected ten actual AAC sources');
  for (const c of cases) {
    const bytes = await readFile(path.join(fixtures, c.name + '.mp4'));
    if (createHash('sha256').update(bytes).digest('hex') !== c.sha256)
      throw Error('Original identity');
    const page = await browser.newPage(),
      errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.addScriptTag({ content: built.outputFiles[0].text });
    results.push(
      ...(await page.evaluate(
        ({ bytes, rate, count }) => globalThis.boundaries(bytes, rate, count),
        { bytes: Array.from(bytes), rate: c.rate, count: c.count },
      )),
    );
    if (errors.length) throw Error(errors.join('\n'));
    await page.close();
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
