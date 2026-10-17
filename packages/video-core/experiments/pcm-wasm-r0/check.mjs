/** Manual correctness only. Mandatory real WASM bytes; never skip/fallback on missing build. */
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
const root = path.dirname(fileURLToPath(import.meta.url));
const [built, out] = process.argv.slice(2);
if (!built || !out)
  throw Error('Verified build directory and fresh external evidence directory required');
await mkdir(out);
const bytes = new Uint8Array(await readFile(path.join(built, 'pcm.wasm'))),
  manifest = JSON.parse(await readFile(path.join(built, 'manifest.json'), 'utf8'));
const sha = createHash('sha256').update(bytes).digest('hex');
if (sha !== manifest.wasmSha256) throw Error('Build hash mismatch');
const metadata = {
  code: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }),
  wasmSha256: sha,
};
const nodeFile = path.join(path.resolve(out), 'suite.mjs');
await build({
  entryPoints: [path.join(root, 'suite.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: nodeFile,
});
const results = [];
try {
  const { suite } = await import(pathToFileURL(nodeFile).href);
  results.push({
    engine: `Node ${process.version} / V8 ${process.versions.v8}`,
    state: 'PASS',
    result: await suite(bytes, sha),
  });
} catch (error) {
  results.push({
    engine: `Node ${process.version}`,
    state: 'FAIL',
    error: String(error),
    stack: error.stack,
  });
  process.exitCode = 1;
}
await writeFile(
  path.join(out, 'results-node.json'),
  JSON.stringify({ ...metadata, results }, null, 2) + '\n',
);
const browserBuild = await build({
  stdin: { resolveDir: root, contents: "import {suite} from './suite';globalThis.r0Suite=suite;" },
  bundle: true,
  platform: 'browser',
  format: 'iife',
  write: false,
});
const server = createServer((_q, r) =>
  r.end('<!doctype html><title>Private R0 correctness</title>'),
);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
const errors = [];
try {
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.addScriptTag({ content: browserBuild.outputFiles[0].text });
  const result = await page.evaluate(
    async ({ bytes, sha }) => globalThis.r0Suite(new Uint8Array(bytes), sha),
    { bytes: [...bytes], sha },
  );
  if (errors.length) throw Error(errors.join('\n'));
  await writeFile(
    path.join(out, 'results-chromium.json'),
    JSON.stringify(
      { ...metadata, engine: `Chromium ${browser.version()}`, state: 'PASS', errors, result },
      null,
      2,
    ) + '\n',
  );
} catch (error) {
  process.exitCode = 1;
  await writeFile(
    path.join(out, 'results-chromium.json'),
    JSON.stringify(
      { ...metadata, state: 'FAIL', errors, error: String(error), stack: error.stack },
      null,
      2,
    ) + '\n',
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
console.log(JSON.stringify({ state: process.exitCode ? 'FAIL' : 'PASS', out, wasmSha256: sha }));
