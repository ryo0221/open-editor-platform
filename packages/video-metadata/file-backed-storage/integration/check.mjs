import { writeDigestProvenance } from './provenance.mjs';
/* eslint-disable no-undef */
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const output = resolve(process.argv[2] ?? '/tmp/video-actual-save-integration');
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
  const fixtures = await (
    await import(pathToFileURL(join(output, 'fixtures.mjs')))
  ).generate(output);
  await rm(join(output, 'source.bin'));
  bundle = await build({
    entryPoints: ['packages/video-metadata/file-backed-storage/integration/harness.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    metafile: true,
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
  async function launch() {
    context = await chromium.launchPersistentContext(join(output, 'profile'), {
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
  const status = () => page.evaluate(() => window.qa.status());
  const start = (mode) => page.evaluate((mode) => window.qa.start(mode), mode);
  const result = () => page.evaluate(() => window.qa.result());
  await launch();
  await page.locator('input').setInputFiles(join(output, 'large.zip'));
  await page.evaluate(() => window.qa.seed());
  await start('normal');
  const first = await result();
  check(first.state === 'committed', 'Real coordinator initial ' + JSON.stringify(first));
  let s = await status();
  check(
    s.marked.length === 1 && s.retained === 0 && s.journal.current === first.operationId,
    'Committed releases capture and marks saved',
  );
  const restored = await page.evaluate((id) => window.qa.inspect(id), first.operationId);
  check(
    restored.versions === 3 &&
      restored.hashes.length === 1 &&
      restored.hashes[0].actual === fixtures.large.originalHash &&
      restored.hashes[0].size === 40 * 1024 ** 2,
    'Real captured parent-only closure',
  );
  results.push({
    case: 'I01 actual scoped SaveCoordinator commits ZIP64 with retained40MiB original and markSaved',
    status: 'PASS',
    operationId: first.operationId,
  });
  const oldHash = s.hash;
  await start('hold');
  await page.waitForFunction(() => window.qa.phase() === 'captured');
  check((await status()).retained === 1, 'Capture held during writer');
  await page.evaluate(() => {
    window.qa.edit();
    window.qa.forgetLiveOriginals();
  });
  await page.evaluate(() => window.qa.release());
  const old = await result();
  check(old.state === 'committed' && old.capture.contentHash === oldHash, 'Old capture committed');
  s = await status();
  check(
    s.hash !== oldHash && s.marked.length === 1 && s.retained === 0,
    'New draft not marked saved',
  );
  results.push({
    case: 'I02 edit and live original removal after capture retain pinned revision/closure; old completion cannot mark newer draft saved',
    status: 'PASS',
  });
  await start('unknown');
  const unknown = await result();
  check(unknown.state === 'indeterminate', 'Lost acknowledgement unknown');
  s = await status();
  check(s.retained === 1 && s.marked.length === 1, 'Unknown retains coordinator capture');
  check(
    (await page.evaluate(() => window.qa.busy())).error?.includes('SaveBusy'),
    'Actual coordinator claim blocks second save',
  );
  const wrong = await page.evaluate((id) => window.qa.wrongEvidence(id), unknown.operationId);
  check(
    wrong.retained === 1 &&
      wrong.marked.length === 1 &&
      wrong.observations.find((o) => o.operationId === unknown.operationId)?.outcome.reason ===
        'invalid-receipt',
    'Wrong capture evidence cannot settle claim',
  );
  const settled = await page.evaluate((id) => window.qa.reconcile(id), unknown.operationId);
  check(
    settled.evidence.state === 'committed' &&
      settled.status.retained === 0 &&
      settled.status.marked.length === 2,
    'Exact reconciliation settles and marks saved',
  );
  const newest = settled.status.journal.current;
  await page.evaluate((id) => window.qa.reconcile(id), first.operationId);
  check((await status()).journal.current === newest, 'Old reconciliation cannot republish');
  results.push({
    case: 'I03 unknown retains actual coordinator claim; verified exact evidence reconciles once',
    status: 'PASS',
  });
  await start('no-write');
  const refused = await result();
  check(
    refused.state === 'aborted-before-write' && refused.proof === 'adapter-no-write-guarantee',
    'Durable no-write coordinator evidence ' + JSON.stringify(refused),
  );
  s = await status();
  check(
    s.retained === 0 && s.marked.length === 2 && s.journal.current === newest,
    'No-write releases only its claim, keeps previous selection',
  );
  check(
    s.journal.operations.find((o) => o.pin.operationId === refused.operationId)?.phase ===
      'aborted',
    'Durable rejection fence',
  );
  const noWriteRecheck = await page.evaluate((id) => window.qa.reconcile(id), refused.operationId);
  check(
    noWriteRecheck.evidence.state === 'no-write' &&
      noWriteRecheck.status.marked.length === 2 &&
      noWriteRecheck.status.retained === 0,
    'No-write reconciliation remains definitive without markSaved',
  );
  results.push({
    case: 'I04 real coordinator accepts durably fenced no-write and preserves earlier output',
    status: 'PASS',
  });
  await start('unknown');
  const interrupted = await result();
  check(interrupted.state === 'indeterminate', 'Restart unknown');
  const beforeRestart = await status();
  check(beforeRestart.retained === 1, 'Old unresolved capture retained until process exit');
  check(
    (await page.evaluate(() => window.qa.scratch())).length === 0,
    'Scratch separate and cleaned after settled adapter call',
  );
  await page.screenshot({ path: join(output, 'integration-before-restart.png'), fullPage: true });
  await context.close();
  await launch();
  const recovered = await page.evaluate(() => window.qa.restore());
  check(
    recovered.receiptOperation === interrupted.operationId &&
      recovered.status.observations.length === 0 &&
      recovered.status.marked.length === 0,
    'Fresh coordinator does not fake old job or markSaved',
  );
  check(
    recovered.status.snapshot.scope.sessionId !== recovered.oldCapture.scope.sessionId,
    'Fresh session scope',
  );
  check(
    (await page.evaluate((id) => window.qa.oldJob(id), interrupted.operationId)).includes(
      'UnknownOperation',
    ),
    'No fabricated old coordinator recovery',
  );
  const original = await page.evaluate((id) => window.qa.inspect(id), interrupted.operationId);
  check(
    original.hashes[0].actual === fixtures.large.originalHash,
    'Restored original through exact lease adapter',
  );
  results.push({
    case: 'I05 fresh browser process restores verified native/history/original lease without reviving old job/grant',
    status: 'PASS',
  });
  await start('normal');
  const fresh = await result();
  check(fresh.state === 'committed', 'Fresh scoped save after recovery');
  s = await status();
  check(
    s.marked.length === 1 && s.retained === 0 && s.versions === 7,
    'Fresh capture saved on restored parent chain',
  );
  check(s.snapshot.scope.sessionId === fresh.capture.scope.sessionId, 'New capture identity');
  results.push({
    case: 'I06 restored originals and retained versions support new real scoped save',
    status: 'PASS',
  });
  await page.screenshot({ path: join(output, 'integration-recovered.png'), fullPage: true });
  check(errors.length === 0, 'Browser errors ' + errors.join('\n'));
} catch (e) {
  results.push({ case: 'runner', status: 'FAIL', error: String(e) });
  process.exitCode = 1;
} finally {
  await context?.close();
  if (server) await new Promise((r) => server.close(r));
  const report = {
    tested,
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
