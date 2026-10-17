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
const output = resolve(process.argv[2] ?? '/tmp/video-scratch-recovery');
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
  let profile = 'profile';
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
  const status = () => page.evaluate(() => window.qa.status());
  const start = (mode) => page.evaluate((mode) => window.qa.start(mode), mode);
  const result = () => page.evaluate(() => window.qa.result());
  for (const phase of [
    'scratch-intent',
    'scratch-chunk',
    'scratch-closed',
    'scratch-ready',
    'scratch-cleaning',
    'scratch-removed',
  ]) {
    profile = phase;
    await launch();
    await page.locator('input').setInputFiles(join(output, 'valid.zip'));
    await page.evaluate(() => window.qa.seed());
    await start('normal');
    let completed = await result();
    check(completed.state === 'committed', 'Initial completed save');
    const before = await page.evaluate((id) => window.qa.inspect(id), completed.operationId);
    await page.evaluate(() => window.qa.edit());
    await start(phase);
    await page.waitForFunction((phase) => window.qa.phase() === phase, phase);
    const interrupted = await page.evaluate(() => window.qa.pausedRecord());
    // Controlled browser close/relaunch: no process kill, power-loss or crash guarantee.
    await context.close();
    await launch();
    await page.evaluate(() => window.qa.restore());
    const after = await page.evaluate((id) => window.qa.inspect(id), completed.operationId);
    check(
      JSON.stringify(before) === JSON.stringify(after),
      'Previous completed archive/native/original unchanged',
    );
    const records = await page.evaluate(() => window.qa.ledger());
    const record = records.find((r) => r.operationId === interrupted.operationId);
    check(record && record.phase !== 'done', 'Interrupted ownership remains durable');
    const denied = await page.evaluate(
      (id) => window.qa.recoverScratch(id, false),
      record.operationId,
    );
    check(denied.state === 'unknown', 'Revoked authority cannot clean');
    const evidence = await page.evaluate(
      (id) => window.qa.recoverScratch(id, true),
      record.operationId,
    );
    const expected = ['scratch-cleaning', 'scratch-removed'].includes(phase)
      ? 'committed'
      : 'no-write';
    check(
      evidence.state === expected,
      'Recovery evidence ' + phase + ': ' + JSON.stringify(evidence),
    );
    check(
      evidence.operationId === record.operationId &&
        JSON.stringify(evidence.capture) === JSON.stringify(record.capture),
      'Exact capture evidence',
    );
    check(
      (await page.evaluate(() => window.qa.scratch())).length === 0,
      'Only owned scratch removed',
    );
    const twice = await page.evaluate(
      (id) => window.qa.recoverScratch(id, true),
      record.operationId,
    );
    check(JSON.stringify(twice) === JSON.stringify(evidence), 'Idempotent repeated recovery');
    if (expected === 'no-write') {
      const replay = await page.evaluate((id) => window.qa.replayScratch(id), record.operationId);
      check(
        replay.result.state === 'unknown' && replay.reads === 0 && replay.mismatch === 'occupied',
        'Another owner cannot reuse fenced operation',
      );
      check(
        (await status()).journal.current === completed.operationId,
        'No implicit publication of discarded scratch',
      );
      // Restart again AFTER the refusal transaction committed, then use another owner.
      await context.close();
      await launch();
      await page.evaluate(() => window.qa.restore());
      const coldReplay = await page.evaluate(
        (id) => window.qa.replayScratch(id),
        record.operationId,
      );
      check(
        coldReplay.result.state === 'unknown' &&
          coldReplay.reads === 0 &&
          coldReplay.mismatch === 'occupied',
        'Durable refusal survives a further controlled process restart',
      );
      const coldEvidence = await page.evaluate(
        (id) => window.qa.recoverScratch(id, true),
        record.operationId,
      );
      check(
        JSON.stringify(coldEvidence) === JSON.stringify(evidence),
        'Exact no-write evidence persists across restart',
      );
      check(
        (await status()).journal.current === completed.operationId,
        'Restarted refusal cannot select another archive',
      );
    }
    await start('normal');
    completed = await result();
    check(
      completed.state === 'committed',
      'Fresh scoped save after explicit recovery: ' +
        phase +
        ' ' +
        JSON.stringify(completed) +
        ' ' +
        JSON.stringify(await status()),
    );
    const state = await status();
    check(
      state.ownership.unresolvedWrites === 0 && state.retained === 0,
      'Final resource ownership released',
    );
    await context.close();
    context = undefined;
    results.push({
      case: phase,
      status: 'PASS',
      evidence: expected,
      restart: 'controlled context close/new browser process',
      postFenceRestart: expected === 'no-write',
      interrupted,
    });
  }
  for (const fault of [
    'foreign-file',
    'missing-ledger',
    'corrupt-ledger',
    'corrupt-completed-candidate',
    'legacy-v1-upgrade',
  ]) {
    profile = fault;
    await launch();
    await page.locator('input').setInputFiles(join(output, 'valid.zip'));
    await page.evaluate(() => window.qa.seed());
    await start('normal');
    const committed = await result();
    check(committed.state === 'committed', 'Guard initial commit');
    const before = await page.evaluate((id) => window.qa.inspect(id), committed.operationId);
    if (fault === 'legacy-v1-upgrade') {
      const snapshot = await page.evaluate(() => window.qa.fixtureLegacyJournal());
      await context.close();
      await launch();
      await page.evaluate(() => window.qa.restore());
      check(
        JSON.stringify((await status()).journal) === JSON.stringify(snapshot),
        'v1 metadata root unchanged on v2 upgrade',
      );
      check(
        JSON.stringify(
          await page.evaluate((id) => window.qa.inspect(id), committed.operationId),
        ) === JSON.stringify(before),
        'Upgrade retains verified original/native',
      );
      await start('normal');
      check((await result()).state === 'committed', 'Upgraded journal supports real save');
    } else {
      await page.evaluate(() => window.qa.edit());
      const stop = fault === 'corrupt-completed-candidate' ? 'scratch-cleaning' : 'scratch-ready';
      await start(stop);
      await page.waitForFunction((stop) => window.qa.phase() === stop, stop);
      const record = await page.evaluate(() => window.qa.pausedRecord());
      await context.close();
      await launch();
      await page.evaluate(() => window.qa.restore());
      if (fault === 'corrupt-completed-candidate')
        await page.evaluate((id) => window.qa.fixtureCorruptCandidate(id), record.operationId);
      else if (fault === 'foreign-file')
        await page.evaluate(() => window.qa.fixtureForeignScratch());
      else
        await page.evaluate(
          (remove) => window.qa.fixtureLedgerDamage(remove),
          fault === 'missing-ledger',
        );
      const evidence = await page.evaluate(
        (id) => window.qa.recoverScratch(id, true),
        record.operationId,
      );
      const files = await page.evaluate(() => window.qa.scratch());
      if (fault === 'foreign-file') {
        check(
          evidence.state === 'no-write' && files.length === 1 && files[0] === 'foreign-owned',
          'Recovery deletes only owned scratch',
        );
      } else
        check(
          evidence.state === 'unknown' && files.includes(record.file),
          'Missing/corrupt ledger refuses cleanup and preserves bytes',
        );
      check(
        JSON.stringify(
          await page.evaluate((id) => window.qa.inspect(id), committed.operationId),
        ) === JSON.stringify(before),
        'Guard failure leaves previous archive intact',
      );
      await start('normal');
      check((await result()).state !== 'committed', 'Unresolved state blocks later publication');
      check(
        (await status()).journal.current ===
          (fault === 'corrupt-completed-candidate' ? record.operationId : committed.operationId),
        'No mutation of selected journal version',
      );
    }
    results.push({ case: fault, status: 'PASS' });
    await context.close();
    context = undefined;
  }
  profile = 'same-process-cleanup';
  await launch();
  await page.locator('input').setInputFiles(join(output, 'valid.zip'));
  await page.evaluate(() => window.qa.seed());
  await start('scratch-fail-cleaning');
  const unfinished = await result();
  check(
    unfinished.state === 'indeterminate',
    'Cleanup interruption does not claim successful settlement',
  );
  check((await status()).retained === 1, 'Actual coordinator retains unresolved capture');
  const early = await page.evaluate((id) => window.qa.reconcile(id), unfinished.operationId);
  check(
    early.evidence.state === 'unknown' && early.status.retained === 1,
    'Cannot settle before cleanup ownership is resolved',
  );
  const recovered = await page.evaluate(
    (id) => window.qa.recoverScratch(id, true),
    unfinished.operationId,
  );
  check(recovered.state === 'committed', 'Explicit cleanup verifies completed archive');
  const settled = await page.evaluate((id) => window.qa.reconcile(id), unfinished.operationId);
  check(
    settled.evidence.state === 'committed' &&
      settled.status.retained === 0 &&
      settled.status.ownership.unresolvedWrites === 0 &&
      settled.status.marked.length === 1,
    'Exact evidence settles real coordinator and releases project/capture',
  );
  const repeated = await page.evaluate((id) => window.qa.reconcile(id), unfinished.operationId);
  check(repeated.status.marked.length === 1, 'Idempotent settlement marks once');
  results.push({
    case: 'same-process interrupted cleanup and actual coordinator settlement',
    status: 'PASS',
  });
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
