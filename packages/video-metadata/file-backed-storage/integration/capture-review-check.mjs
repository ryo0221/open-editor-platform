/* eslint-disable no-undef */
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const output = resolve(process.argv[2]),
  baseline = process.argv.includes('--baseline');
await mkdir(output);
const baselinePin = 'b807de140f96c129f8aca0be56da36c0869e10cc';
const tested = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
let browser, server, bundle;
const results = [],
  errors = [];
const check = (v, m) => {
  if (!v) throw Error(m);
};
try {
  await build({
    entryPoints: ['packages/video-metadata/file-backed-storage/browser-verifier/fixtures.ts'],
    outfile: join(output, 'fixtures.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
  });
  await (await import(pathToFileURL(join(output, 'fixtures.mjs')))).generate(output);
  const notice = await readFile(
    'packages/video-metadata/file-backed-storage/integration/NOBLE-HASHES-LICENSE.txt',
    'utf8',
  );
  bundle = await build({
    entryPoints: ['packages/video-metadata/file-backed-storage/integration/harness.ts'],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    banner: { js: '/*!\n' + notice + '\n*/' },
    plugins: baseline
      ? [
          {
            name: 'exact-old-storage',
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
  });
  server = createServer((req, res) => {
    if (req.url === '/test.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(bundle.outputFiles[0].contents);
    } else if (req.url === '/favicon.ico') {
      res.statusCode = 204;
      res.end();
    } else {
      res.setHeader('content-type', 'text/html');
      res.end(
        '<!doctype html><h1>Capture ownership regression</h1><input type="file"><pre></pre><script type="module" src="/test.js"></script>',
      );
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  browser = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox'],
  });
  for (const test of [
    'stale-owner',
    'normal-live',
    'normal-undo',
    'unknown-live',
    'unknown-undo',
  ]) {
    const context = await browser.newContext(),
      page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.waitForFunction(() => !!window.qa);
      await page.locator('input').setInputFiles(join(output, 'valid.zip'));
      await page.evaluate(() => window.qa.seed());
      await page.evaluate(
        (mode) => window.qa.start(mode),
        test.startsWith('unknown') ? 'hold-unknown' : 'hold',
      );
      await page.waitForFunction(() => window.qa.phase() === 'captured');
      if (test === 'stale-owner') {
        const b = await page.evaluate(() => window.qa.otherOwner());
        check(b.state === 'committed', 'B commits via separate registry');
        await page.evaluate(() => window.qa.release());
        const a = await page.evaluate(() => window.qa.result());
        check(
          a.state === 'aborted-before-write',
          `A stale capture must refuse, got ${JSON.stringify(a)}`,
        );
        const s = await page.evaluate(() => window.qa.status());
        check(
          s.journal.current === b.operationId && s.journal.head === 1 && s.historyHead === 0,
          'B head preserved; stale A history not rebound',
        );
        check(
          s.ownership.captures === 0 && s.ownership.unresolvedWrites === 0,
          'Stale no-write releases actual adapter/capture pins',
        );
      } else {
        const undo = test.endsWith('undo'),
          added = await page.evaluate((undo) => window.qa.importAfterCapture(undo), undo);
        await page.evaluate(() => window.qa.release());
        const saved = await page.evaluate(() => window.qa.result());
        if (test.startsWith('unknown')) {
          check(saved.state === 'indeterminate', 'Unknown retained');
          const pending = await page.evaluate(() => window.qa.status());
          check(pending.retained === 1, 'Actual capture remains');
          await page.evaluate((id) => window.qa.reconcile(id), saved.operationId);
        } else check(saved.state === 'committed', 'Normal committed');
        const catalog = await page.evaluate((a) => window.qa.catalogHas(a.hash, a.sourceId), added);
        check(
          catalog.original && catalog.plan && !catalog.saved,
          `Post-capture B must remain live/Undo-owned, excluded from A saved catalog: ${JSON.stringify(catalog)}`,
        );
        const archive = await page.evaluate((id) => window.qa.inspect(id), saved.operationId);
        check(!archive.hashes.some((v) => v.id === added.hash), 'A archive excludes new B');
        const settled = await page.evaluate(() => window.qa.status());
        check(
          settled.ownership.captures === 0 && settled.ownership.unresolvedWrites === 0,
          'No settled pending Blob/History retention',
        );
        if (undo) await page.evaluate(() => window.qa.redo());
        await page.evaluate(() => window.qa.start('normal'));
        const next = await page.evaluate(() => window.qa.result());
        check(
          next.state === 'committed',
          `Next real retainCapture succeeds: ${JSON.stringify(next)}`,
        );
        const nextArchive = await page.evaluate((id) => window.qa.inspect(id), next.operationId);
        check(
          nextArchive.hashes.some((v) => v.id === added.hash),
          'Next archive owns B',
        );
        await page.evaluate((a) => window.qa.releaseLive(a.hash, a.sourceId), added);
        const released = await page.evaluate(
          (a) => window.qa.catalogHas(a.hash, a.sourceId),
          added,
        );
        check(
          !released.original && released.saved,
          'Live owner explicitly releases; retained native still owns B',
        );
      }
      results.push({ case: test, status: 'PASS' });
    } catch (e) {
      results.push({ case: test, status: 'FAIL', error: String(e) });
      process.exitCode = 1;
    } finally {
      await context.close();
    }
  }
  check(errors.length === 0, 'Browser errors');
} catch (e) {
  results.push({ case: 'runner', status: 'FAIL', error: String(e) });
  process.exitCode = 1;
} finally {
  const browserVersion = browser?.version();
  await browser?.close();
  if (server) await new Promise((r) => server.close(r));
  const report = {
    tested,
    sourceTreeStatus: status,
    baselineStorage: baseline ? baselinePin : null,
    browserVersion,
    browserErrors: errors,
    results,
    bundleSha256: bundle
      ? createHash('sha256').update(bundle.outputFiles[0].contents).digest('hex')
      : null,
  };
  await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
}
