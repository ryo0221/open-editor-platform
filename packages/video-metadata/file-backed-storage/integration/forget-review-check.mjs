import { writeDigestProvenance } from './provenance.mjs';
/* eslint-disable no-undef */
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
const output = resolve(process.argv[2]);
const baseline = process.argv.includes('--baseline');
const baselinePin = 'a4f7f2c658aecc013b8fec5824e1a02e184680f5';
await mkdir(output);
const tested = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceTreeStatus = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
const results = [],
  errors = [];
let context,
  server,
  bundle,
  page,
  launches = 0,
  browserVersion;
const check = (value, message) => {
  if (!value) throw Error(message);
};
try {
  check(
    JSON.parse(await readFile('node_modules/@noble/hashes/package.json', 'utf8')).version ===
      '1.8.0',
    'Digest exact version',
  );
  const license = await readFile(
    'packages/video-metadata/file-backed-storage/integration/NOBLE-HASHES-LICENSE.txt',
    'utf8',
  );
  check(
    license === (await readFile('node_modules/@noble/hashes/LICENSE', 'utf8')),
    'Complete dependency notice',
  );
  await writeFile(join(output, 'THIRD-PARTY-NOTICES.txt'), license, { flag: 'wx' });
  await build({
    entryPoints: ['packages/video-metadata/file-backed-storage/browser-verifier/fixtures.ts'],
    outfile: join(output, 'fixtures.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
  });
  await (await import(pathToFileURL(join(output, 'fixtures.mjs')))).generate(output);
  await rm(join(output, 'source.bin'));
  bundle = await build({
    entryPoints: ['packages/video-metadata/file-backed-storage/integration/harness.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    metafile: true,
    plugins: baseline
      ? [
          {
            name: 'exact-reviewed-storage',
            setup(b) {
              b.onLoad({ filter: /integration\/storage\.ts$/ }, (a) => ({
                contents: execFileSync(
                  'git',
                  [
                    'show',
                    baselinePin +
                      ':packages/video-metadata/file-backed-storage/integration/storage.ts',
                  ],
                  { encoding: 'utf8' },
                ),
                loader: 'ts',
                resolveDir: dirname(a.path),
              }));
            },
          },
        ]
      : [],
    banner: { js: '/*! @noble/hashes1.8.0\n' + license + '\n*/' },
  });
  check(bundle.outputFiles[0].text.includes(license), 'Full MIT notice in served bundle');
  check(
    Object.keys(bundle.metafile.inputs).some((p) => p.endsWith('/draft2/save.ts')),
    'Actual SaveCoordinator bundled',
  );
  await writeDigestProvenance(output, bundle);
  await writeFile(join(output, 'bundle-meta.json'), JSON.stringify(bundle.metafile, null, 2), {
    flag: 'wx',
  });
  const html =
    '<!doctype html><title>Private real save integration</title><h1>Scoped SaveCoordinator + ZIP64 + OPFS</h1><p>Independent synthetic Host; Video production wiring not changed</p><input type="file"><pre></pre><script type="module" src="/test.js"></script>';
  server = createServer((req, res) => {
    if (req.url === '/test.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(bundle.outputFiles[0].contents);
    } else if (req.url === '/favicon.ico') {
      res.statusCode = 204;
      res.end();
    } else {
      res.setHeader('content-type', 'text/html');
      res.end(html);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const profile = 'profile';
  async function launch() {
    context = await chromium.launchPersistentContext(join(output, profile), {
      executablePath: '/usr/bin/chromium',
      headless: true,
      args: ['--no-sandbox'],
      viewport: { width: 1280, height: 800 },
    });
    launches++;
    browserVersion = context.browser()?.version();
    page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto(url);
    await page.waitForFunction(() => !!window.qa);
  }
  const start = (mode) => page.evaluate((mode) => window.qa.start(mode), mode);
  const result = () => page.evaluate(() => window.qa.result());
  await launch();
  await page.locator('input').setInputFiles(join(output, 'valid.zip'));
  await page.evaluate(() => window.qa.seed());
  await start('normal');
  const committed = await result();
  check(committed.state === 'committed', 'Actual coordinator initial save');
  const delayed = await page.evaluate((id) => window.qa.delayedForget(id), committed.operationId);
  check(delayed.evidence.state === 'committed', 'Delayed exact evidence remains valid');
  check(!delayed.reinserted, 'Forgotten receipt was reinserted by delayed reconciliation');
  check(
    JSON.stringify(delayed.before) === JSON.stringify(delayed.after),
    'Forget does not remove durable journal fence/history',
  );
  check(delayed.ownership.unresolvedWrites === 0, 'No unresolved project ownership');
  results.push({
    case: 'settled reconcile paused, forget, late verified completion cannot reinsert receipt',
    status: 'PASS',
  });
  check(errors.length === 0, 'Browser errors');
} catch (e) {
  results.push({ case: 'runner', status: 'FAIL', error: String(e) });
  process.exitCode = 1;
} finally {
  await context?.close();
  if (server) await new Promise((r) => server.close(r));
  const report = {
    tested,
    baselineSource: baseline ? baselinePin : null,
    sourceTreeStatus,
    browserVersion,
    launches,
    browserErrors: errors,
    results,
    bundleSha256: bundle
      ? createHash('sha256').update(bundle.outputFiles[0].contents).digest('hex')
      : null,
    limits:
      'Private real scoped SaveCoordinator integration. Controlled browser process restart, not crash/power loss. No normal Video Host/UI or codec acceptance; source/profile artifacts local only.',
  };
  await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
}
