import { writeDigestProvenance } from '../integration/provenance.mjs';
/* eslint-disable no-undef */
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { execFileSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
const output = resolve(process.argv[2] ?? '/tmp/video-browser-archive');
await mkdir(output);
const tested = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceTreeStatus = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
const results = [],
  errors = [];
let browser, server, bundle, fixtures;
const check = (v, m) => {
  if (!v) throw Error(m);
};
const hashFile = async (path) => {
  const h = createHash('sha256');
  for await (const b of createReadStream(path, { highWaterMark: 65536 })) h.update(b);
  return h.digest('hex');
};
try {
  const version = JSON.parse(
    await readFile('node_modules/@noble/hashes/package.json', 'utf8'),
  ).version;
  check(version === '1.8.0', 'Exact test-host digest version');
  const notice = await readFile(
    'packages/video-metadata/file-backed-storage/integration/NOBLE-HASHES-LICENSE.txt',
    'utf8',
  );
  check(
    notice === (await readFile('node_modules/@noble/hashes/LICENSE', 'utf8')),
    'Full installed license notice',
  );
  await writeFile(join(output, 'THIRD-PARTY-NOTICES.txt'), notice, { flag: 'wx' });
  await build({
    entryPoints: ['packages/video-metadata/file-backed-storage/browser-verifier/fixtures.ts'],
    outfile: join(output, 'fixtures.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
  });
  fixtures = await (await import(pathToFileURL(join(output, 'fixtures.mjs')))).generate(output);
  // Exact reviewed Node source is bundled as a differential oracle, without changing checkout.
  const legacyPin = '414514241ee0dff13159635826c7493f513c2865';
  await mkdir(join(output, 'legacy'));
  await build({
    entryPoints: ['packages/video-metadata/file-backed-storage/browser-verifier/fixtures.ts'],
    outfile: join(output, 'legacy-fixtures.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    plugins: [
      {
        name: 'reviewed-node-source',
        setup(build) {
          build.onLoad({ filter: /file-backed-storage\/(io|project|zip64)\.ts$/ }, (args) => {
            const relative = args.path.slice(process.cwd().length + 1);
            return {
              contents: execFileSync('git', ['show', `${legacyPin}:${relative}`], {
                encoding: 'utf8',
              }),
              loader: 'ts',
              resolveDir: dirname(args.path),
            };
          });
        },
      },
    ],
  });
  const legacy = await (
    await import(pathToFileURL(join(output, 'legacy-fixtures.mjs')))
  ).generate(join(output, 'legacy'));
  check(isDeepStrictEqual(fixtures, legacy), 'Reviewed Node byte/profile/verdict parity');
  results.push({
    case: 'V00 identical portable bytes and malformed verdicts against exact reviewed Node base',
    status: 'PASS',
    legacyPin,
  });
  await rm(join(output, 'source.bin')); // Only portable archive survives; no original service/cache.
  execFileSync('python3', [
    '-c',
    'import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1]) as z:\n for i in z.infolist():\n  assert i.compress_type==0\n  with z.open(i) as f:\n   while f.read(65536): pass\n print("ZIP CRC PASS")',
    join(output, 'large.zip'),
  ]);
  bundle = await build({
    entryPoints: ['packages/video-metadata/file-backed-storage/browser-verifier/harness.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    metafile: true,
    banner: { js: '/*! @noble/hashes1.8.0\n' + notice + '\n*/' },
  });
  check(
    !Object.keys(bundle.metafile.inputs).some(
      (n) => n.endsWith('/file-backed-storage/io.ts') || n.includes('cryptoNode'),
    ),
    'Browser excludes Node backend',
  );
  await writeDigestProvenance(output, bundle);
  await writeFile(join(output, 'bundle-meta.json'), JSON.stringify(bundle.metafile, null, 2), {
    flag: 'wx',
  });
  const html =
    '<!doctype html><title>Private browser archive verifier</title><h1>Portable ZIP64 verifier</h1><p>Synthetic archive test; no Video product integration</p><input type="file"><pre></pre><script type="module" src="/test.js"></script>';
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
  browser = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox'],
  });
  const pageFor = async () => {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto(url);
    await page.waitForFunction(() => !!window.qa);
    return { context, page };
  };
  let { context, page } = await pageFor();
  check((await page.evaluate(() => window.qa.vectors())) === 9, 'Digest/WebCrypto vectors');
  results.push({
    case: 'V01 injected streaming SHA-256 matches WebCrypto at block/padding boundaries',
    status: 'PASS',
  });
  await page.locator('input').setInputFiles(join(output, 'large.zip'));
  const pin = {
    operationId: fixtures.large.operationId,
    capture: fixtures.large.capture,
    sha256: fixtures.large.sha256,
    bytes: fixtures.large.bytes,
  };
  const large = await page.evaluate((pin) => window.qa.inspect(pin), pin);
  check(
    large.ok &&
      large.maxRead === 65536 &&
      large.maxInFlight === 1 &&
      fixtures.large.bytes > 32 * 1024 ** 2,
    'Large bounded archive ' + JSON.stringify(large),
  );
  check(
    isDeepStrictEqual(large.versions, fixtures.large.versions) && large.selected === 'selected',
    'Native retained versions',
  );
  check(
    large.retained.length === 1 && large.retained[0].actual === fixtures.large.originalHash,
    'Parent-only original retained',
  );
  results.push({
    case: 'V02 actual >40MiB portable archive/native/retained original closure in browser',
    status: 'PASS',
    bytes: fixtures.large.bytes,
    sha256: large.receipt.sha256,
    maxRead: large.maxRead,
    maxInFlight: large.maxInFlight,
  });
  check((await page.evaluate(() => window.qa.bounds())) === 3, 'Bounded Blob ranges');
  const cancelled = await page.evaluate(() => window.qa.inspect(undefined, 10));
  check(!cancelled.ok && cancelled.reason.includes('Abort'), 'Cancellation');
  check(
    !(await page.evaluate((pin) => window.qa.pinMismatch({ ...pin, operationId: 'foreign' }), pin)),
    'Foreign operation',
  );
  check(
    !(await page.evaluate((pin) => window.qa.pinMismatch({ ...pin, sha256: '0'.repeat(64) }), pin)),
    'Foreign digest',
  );
  check(
    !(await page.evaluate((pin) => window.qa.pinMismatch({ ...pin, bytes: pin.bytes - 1 }), pin)),
    'Expected byte length mismatch',
  );
  check(
    !(await page.evaluate(
      (pin) =>
        window.qa.pinMismatch({
          ...pin,
          capture: {
            ...pin.capture,
            revision: { ...pin.capture.revision, sequence: pin.capture.revision.sequence + 1 },
          },
        }),
      pin,
    )),
    'Expected capture mismatch',
  );
  results.push({
    case: 'V03 cancellation, range bounds and journal pin mismatch reject',
    status: 'PASS',
  });
  await page.screenshot({ path: join(output, 'large-archive.png'), fullPage: true });
  const waiting = page.waitForEvent('download');
  await page.evaluate(() => window.qa.download());
  const download = await waiting;
  await download.saveAs(join(output, 'downloaded-project.zip'));
  check(
    (await hashFile(join(output, 'downloaded-project.zip'))) === pin.sha256,
    'Portable download bytes',
  );
  await context.close();
  ({ context, page } = await pageFor());
  await page.locator('input').setInputFiles(join(output, 'downloaded-project.zip'));
  check(
    (await page.evaluate((pin) => window.qa.inspect(pin), pin)).ok,
    'Fresh empty context reload',
  );
  results.push({
    case: 'V04 downloaded project bytes reopen in fresh context independent of OPFS/source cache',
    status: 'PASS',
  });
  for (const [kind, record] of Object.entries(fixtures)) {
    if (kind === 'large' || kind === 'valid') continue;
    await page.locator('input').setInputFiles(join(output, kind + '.zip'));
    const verdict = await page.evaluate(() => window.qa.inspect());
    check(
      !verdict.ok && verdict.reason === record.nodeReason,
      `Browser/Node refusal ${kind}: ${JSON.stringify(verdict)}`,
    );
    results.push({
      case: 'V05 valid-CRC/SHA malformed ' + kind,
      status: 'PASS',
      reason: verdict.reason,
    });
  }
  // Corrupt original payload in the small valid archive, preserving metadata/header layout.
  const small = await readFile(join(output, 'valid.zip'));
  const at = small.indexOf(Buffer.from([1, 2, 3, 4]));
  check(at >= 0, 'Original payload');
  small[at] ^= 1;
  await writeFile(join(output, 'tampered.zip'), small, { flag: 'wx' });
  await page.locator('input').setInputFiles(join(output, 'tampered.zip'));
  const tampered = await page.evaluate(() => window.qa.inspect());
  check(!tampered.ok && tampered.reason.includes('CRC/SHA'), 'Tampered original');
  results.push({ case: 'V06 original payload tampering rejected', status: 'PASS' });
  check(errors.length === 0, 'Browser errors ' + errors.join('\n'));
  await context.close();
} catch (e) {
  results.push({ case: 'runner', status: 'FAIL', error: String(e) });
  process.exitCode = 1;
} finally {
  const browserVersion = browser?.version();
  await browser?.close();
  if (server) await new Promise((r) => server.close(r));
  const report = {
    tested,
    sourceTreeStatus,
    browserVersion,
    digest: '@noble/hashes1.8.0 MIT; test Host injection only',
    browserErrors: errors,
    results,
    fixturePins: fixtures,
    bundleSha256: bundle
      ? createHash('sha256').update(bundle.outputFiles[0].contents).digest('hex')
      : null,
    limits:
      'Local synthetic portable archive verification. No OPFS journal or normal Host integration, crash/power-loss, performance, codec/media decode or permanent dependency adoption.',
  };
  await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
}
