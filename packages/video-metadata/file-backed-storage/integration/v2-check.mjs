/* eslint-disable no-undef */
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { writeDigestProvenance } from './provenance.mjs';
const output = resolve(process.argv[2]);
await mkdir(output);
const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
const license = await readFile(
  'packages/video-metadata/file-backed-storage/integration/NOBLE-HASHES-LICENSE.txt',
  'utf8',
);
if (license !== (await readFile('node_modules/@noble/hashes/LICENSE', 'utf8')))
  throw Error('Notice mismatch');
const bundle = await build({
  entryPoints: ['packages/video-metadata/file-backed-storage/integration/v2-harness.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  metafile: true,
  banner: { js: '/*!\n' + license + '\n*/' },
});
await writeDigestProvenance(output, bundle);
const server = createServer((req, res) => {
  if (req.url === '/test.js') {
    res.setHeader('content-type', 'text/javascript');
    res.end(bundle.outputFiles[0].contents);
  } else if (req.url === '/favicon.ico') {
    res.statusCode = 204;
    res.end();
  } else {
    res.setHeader('content-type', 'text/html');
    res.end(
      '<!doctype html><title>V2 portable functional fixture</title><section id="host"></section><h2>Test-only logical usage</h2><pre id="usage"></pre><script type="module" src="/test.js"></script>',
    );
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
const errors = [],
  results = [];
let context, version;
const watchdog = setTimeout(() => {
  errors.push('Functional harness did not settle before watchdog');
  void context?.close();
}, 60000);
try {
  if (!Object.keys(bundle.metafile.inputs).some((p) => p.endsWith('/draft2/save.ts')))
    throw Error('Real SaveCoordinator absent');
  if (!Object.keys(bundle.metafile.inputs).some((p) => p.endsWith('/m2/host-v2.ts')))
    throw Error('Exact private v2 Host absent');
  context = await chromium.launchPersistentContext(join(output, 'profile'), {
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox'],
  });
  version = context.browser()?.version();
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(url);
  await page.waitForFunction(() => !!window.v2QA);
  const result = await page.evaluate(() => window.v2QA.run());
  results.push(...result.results);
  await page.screenshot({ path: join(output, 'v2-storage.png'), fullPage: true });
  if (errors.length) throw Error(errors.join('\n'));
} catch (e) {
  errors.push(String(e));
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  await context?.close();
  await new Promise((r) => server.close(r));
  const report = {
    source,
    dirty,
    version,
    results,
    errors,
    claim:
      'Generated metadata only. No decoded media/real-original/performance/capacity increase acceptance.',
  };
  await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
