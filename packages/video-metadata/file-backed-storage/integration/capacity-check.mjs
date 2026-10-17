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
  entryPoints: ['packages/video-metadata/file-backed-storage/integration/capacity-harness.ts'],
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
      '<!doctype html><title>Capacity functional fixture</title><script type="module" src="/test.js"></script>',
    );
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
const errors = [],
  results = [];
let context, version;
const policy = {
  totalBytes: 100000,
  managementBytes: 100,
  maxEntries: 1000,
  maxDepth: 10,
  maxReservations: 20,
};
const check = (ok, message) => {
  if (!ok) throw Error(message);
};
async function launch(name) {
  context = await chromium.launchPersistentContext(join(output, name), {
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox'],
  });
  version = context.browser()?.version();
  return page();
}
async function page() {
  const p = await context.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await p.goto(url);
  await p.waitForFunction(() => !!window.capacityQA);
  return p;
}
try {
  let p = await launch('success');
  await p.evaluate((policy) => window.capacityQA.open(policy), policy);
  await p.evaluate(() => window.capacityQA.seed('closed-old-host/unknown-file', 1234));
  await p.evaluate(() => window.capacityQA.owner('success'));
  const saved = await p.evaluate(() => window.capacityQA.save('success', 'save-one'));
  check(saved.evidence.state === 'committed' && saved.state.head === 1, 'Real save did not commit');
  check(
    saved.usage.reservations.length === 0 &&
      saved.usage.observedBytes === saved.state.operations[0].pin.bytes + 1234,
    'Committed/old namespace accounting',
  );
  results.push({ id: 'CAP-B01', state: 'PASS', saved });
  await context.close();

  for (const [name, total, quota, stage] of [
    ['total-refusal', 500, 100000, 'total'],
    ['journal-refusal', 100000, 500, 'journal'],
  ]) {
    p = await launch(name);
    await p.evaluate((policy) => window.capacityQA.open(policy), { ...policy, totalBytes: total });
    await p.evaluate(({ name, quota }) => window.capacityQA.owner(name, quota), { name, quota });
    const refused = await p.evaluate((name) => window.capacityQA.save(name, 'refused'), name);
    check(
      refused.evidence.state === 'no-write' && refused.refusal.stage === stage,
      'Refusal lacks correlated evidence',
    );
    check(
      !refused.stages.includes('scratch-chunk') &&
        refused.usage.observedBytes === 0 &&
        refused.state.head === 0,
      'Refusal allocated/committed file',
    );
    results.push({ id: 'CAP-B02-' + stage, state: 'PASS', refused });
    await context.close();
  }
  p = await launch('lost-ack');
  await p.evaluate((policy) => window.capacityQA.open(policy), policy);
  await p.evaluate(() => window.capacityQA.owner('lost', 100000, 'committed'));
  const lost = await p.evaluate(() => window.capacityQA.save('lost', 'lost-one'));
  check(
    lost.evidence.state === 'unknown' &&
      lost.usage.reservations.length === 1 &&
      lost.state.head === 1,
    'Unknown write lost reservation',
  );
  const reconciled = await p.evaluate(() => window.capacityQA.reconcile('lost', 'lost-one'));
  const settled = await p.evaluate(() => window.capacityQA.inspect());
  check(
    reconciled.state === 'committed' &&
      settled.reservations.length === 0 &&
      settled.observedBytes > 0,
    'Reconcile did not transfer to occupancy',
  );
  results.push({ id: 'CAP-B03', state: 'PASS', lost, reconciled, settled });
  await context.close();

  p = await launch('cleanup-fault');
  await p.evaluate((policy) => window.capacityQA.open(policy), policy);
  await p.evaluate(() => window.capacityQA.owner('cleanup', 100000, 'scratch-cleaning'));
  const interrupted = await p.evaluate(() => window.capacityQA.save('cleanup', 'cleanup-one'));
  check(
    interrupted.evidence.state === 'unknown' && interrupted.usage.reservations.length === 1,
    'Interrupted cleanup released reservation',
  );
  check(
    (await p.evaluate(() => window.capacityQA.reconcile('cleanup', 'cleanup-one'))).state ===
      'unknown',
    'Incomplete cleanup prematurely settled',
  );
  await p.evaluate(() => window.capacityQA.clearFault('cleanup'));
  const recovered = await p.evaluate(() => window.capacityQA.recover('cleanup', 'cleanup-one'));
  check(
    recovered.state === 'committed' &&
      (await p.evaluate(() => window.capacityQA.inspect())).reservations.length === 0,
    'Existing scratch recovery did not settle',
  );
  results.push({ id: 'CAP-B04', state: 'PASS', interrupted, recovered });
  await context.close();

  p = await launch('journal-fault');
  await p.evaluate((policy) => window.capacityQA.open(policy), policy);
  await p.evaluate(() => window.capacityQA.owner('failed', 100000, 'chunk'));
  const failed = await p.evaluate(() => window.capacityQA.save('failed', 'failed-one'));
  check(
    failed.evidence.state === 'no-write' &&
      failed.usage.observedBytes === 0 &&
      failed.usage.reservations.length === 0 &&
      failed.state.head === 0,
    'Fenced failure accounting',
  );
  results.push({ id: 'CAP-B05', state: 'PASS', failed });
  await context.close();

  p = await launch('concurrent-saves');
  const second = await page();
  const actualSize = saved.state.operations[0].pin.bytes;
  const threeCopies = { ...policy, totalBytes: 3 * actualSize + 200 };
  await Promise.all([
    p.evaluate((policy) => window.capacityQA.open(policy), threeCopies),
    second.evaluate((policy) => window.capacityQA.open(policy), threeCopies),
  ]);
  await p.evaluate(() => window.capacityQA.owner('owner-one', 100000, 'hold:scratch-ready'));
  await second.evaluate(() => window.capacityQA.owner('owner-two'));
  const firstJob = p.evaluate(() => window.capacityQA.save('owner-one', 'first-one'));
  await p.waitForFunction(() => window.capacityQA.held('owner-one'));
  const competing = await second.evaluate(() => window.capacityQA.save('owner-two', 'other-one'));
  check(
    competing.evidence.state === 'no-write' &&
      competing.refusal.stage === 'total' &&
      !competing.stages.includes('scratch-chunk'),
    'Concurrent real owner was not blocked before scratch',
  );
  await p.evaluate(() => window.capacityQA.clearFault('owner-one'));
  const firstCompleted = await firstJob;
  check(firstCompleted.evidence.state === 'committed', 'First owner lost its reservation');
  const retried = await second.evaluate(() => window.capacityQA.save('owner-two', 'other-two'));
  check(
    retried.evidence.state === 'committed' && retried.usage.reservations.length === 0,
    'Fresh operation did not reuse released headroom: ' + JSON.stringify(retried),
  );
  results.push({ id: 'CAP-B07', state: 'PASS', competing, firstCompleted, retried });
  await context.close();

  p = await launch('concurrent');
  const q = await page();
  const small = { ...policy, totalBytes: 1000 };
  await Promise.all([
    p.evaluate((policy) => window.capacityQA.open(policy), small),
    q.evaluate((policy) => window.capacityQA.open(policy), small),
  ]);
  const concurrent = await Promise.all([
    p.evaluate(() =>
      window.capacityQA.reserve('left:one', 'left-scratch/preparation-' + '1'.repeat(36), 400).then(
        () => 'reserved',
        () => 'refused',
      ),
    ),
    q.evaluate(() =>
      window.capacityQA
        .reserve('right:one', 'right-scratch/preparation-' + '2'.repeat(36), 400)
        .then(
          () => 'reserved',
          () => 'refused',
        ),
    ),
  ]);
  check(
    concurrent.filter((r) => r === 'reserved').length === 1,
    'Concurrent owners oversubscribed',
  );
  await context.close();
  p = await launch('concurrent');
  const reopened = await p.evaluate((policy) => window.capacityQA.open(policy), small);
  check(
    reopened.reservations.length === 1 && reopened.reservedAdditionalBytes === 800,
    'Crash/reopen lost reservation',
  );
  results.push({ id: 'CAP-B06', state: 'PASS', concurrent, reopened });
  await context.close();
  p = await launch('duplicate-direct-owner');
  await p.evaluate((policy) => window.capacityQA.open(policy), threeCopies);
  await p.evaluate(() => window.capacityQA.directOwner('A', 'shared', 'scratch-owner-a'));
  await p.evaluate(() => window.capacityQA.directOwner('B', 'shared', 'scratch-owner-b'));
  await p.evaluate(() => window.capacityQA.holdAfterReserve());
  const originalJob = p
    .evaluate(() => window.capacityQA.save('A', 'duplicate'))
    .catch((error) => ({ error: String(error) }));
  await p.waitForFunction(() => window.capacityQA.reservedHeld());
  const beforeDuplicate = await p.evaluate(() => window.capacityQA.inspect());
  const duplicate = await p.evaluate(() => window.capacityQA.save('B', 'duplicate'));
  const afterDuplicate = await p.evaluate(() => window.capacityQA.inspect());
  const third = await p.evaluate(() =>
    window.capacityQA
      .reserve('third:third', 'third-scratch/preparation-' + '3'.repeat(36), 1500)
      .then(
        () => 'reserved',
        () => 'refused',
      ),
  );
  results.push({
    id: 'CAP-B08-observation',
    state: 'OBSERVED',
    beforeDuplicate,
    duplicate,
    afterDuplicate,
    third,
  });
  check(
    afterDuplicate.reservations.length === 1 &&
      afterDuplicate.reservedAdditionalBytes === beforeDuplicate.reservedAdditionalBytes &&
      third === 'refused',
    'Duplicate direct owner released another reservation before scratch: ' +
      JSON.stringify({ afterDuplicate, third }),
  );
  await p.evaluate(() => window.capacityQA.resumeReserved());
  const originalResult = await originalJob;
  const originalEvidence = await p.evaluate(() => window.capacityQA.reconcile('A', 'duplicate'));
  check(
    originalEvidence.state === 'no-write' &&
      (await p.evaluate(() => window.capacityQA.inspect())).reservations.length === 0,
    'Exact original owner failed to settle its fenced operation',
  );
  results.pop(); // Keep detailed observations inside the passing regression, not as a separate case.
  results.push({
    id: 'CAP-B08',
    state: 'PASS',
    beforeDuplicate,
    duplicate,
    afterDuplicate,
    third,
    originalResult,
    originalEvidence,
  });
  check(errors.length === 0, 'Browser errors');
} catch (error) {
  results.push({ state: 'FAIL', error: String(error), stack: error.stack });
  process.exitCode = 1;
} finally {
  await context?.close();
  await new Promise((r) => server.close(r));
  await writeFile(
    join(output, 'results.json'),
    JSON.stringify({ source, dirty, version, results, errors }, null, 2),
    { flag: 'wx' },
  );
  console.log(
    JSON.stringify({
      source,
      cases: results.map(({ id, state, error }) => ({ id, state, error })),
      errors,
    }),
  );
}
