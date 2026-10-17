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
  entryPoints: [
    'packages/video-metadata/file-backed-storage/integration/capacity-coordinator-harness.ts',
  ],
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
      '<!doctype html><title>Capacity coordinator functional fixture</title><section id="host"></section><h2>Test-only logical usage</h2><pre id="usage"></pre><script type="module" src="/test.js"></script>',
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
const policy = {
  totalBytes: 4 * 1024 ** 2,
  managementBytes: 1024,
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
  await p.waitForFunction(() => !!window.coordinatorQA);
  return p;
}
const limits = {
  journalBytes: 1024 ** 3,
  scratchBytes: 256 * 1024 ** 2,
  externalBytes: 256 * 1024 ** 2,
};
const setup = (p, policy) =>
  p.evaluate(({ policy, limits }) => window.coordinatorQA.setup(policy, limits), {
    policy,
    limits,
  });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const usageMatches = (state, files) =>
  state.usage.observedBytes === files.reduce((n, f) => n + f.bytes, 0) &&
  state.usage.accountedBytes ===
    state.usage.observedBytes +
      state.usage.reservedAdditionalBytes +
      state.usage.policy.managementBytes &&
  state.usage.kind === 'logical-opfs' &&
  state.usage.physicalDiskGuaranteed === false &&
  same(state.limits, limits);
try {
  check(
    Object.keys(bundle.metafile.inputs).some((p) => p.endsWith('/draft2/save.ts')),
    'Actual SaveCoordinator not bundled',
  );
  let p = await launch('calibration');
  await setup(p, policy);
  await p.evaluate(() => window.coordinatorQA.seedOld());
  const initial = await p.evaluate(() => window.coordinatorQA.mount());
  const oldFiles = await p.evaluate(() => window.coordinatorQA.files());
  await p.evaluate(() => window.coordinatorQA.buffer(true));
  const invalid = await p.evaluate(() => window.coordinatorQA.save());
  const invalidState = await p.evaluate(() => window.coordinatorQA.status());
  check(
    invalid.state === 'refused' &&
      invalidState.inputDirty &&
      invalidState.requests.length === 0 &&
      invalidState.hash === initial.hash,
    'Invalid buffered input was lost or dispatched',
  );
  results.push({ id: 'SCAP01', state: 'PASS', invalid, inputDirty: invalidState.inputDirty });

  await p.evaluate(() => window.coordinatorQA.buffer(false));
  await p.evaluate(() => window.coordinatorQA.start(false, true));
  await p.waitForFunction(() => window.coordinatorQA.held());
  const captured = await p.evaluate(() => window.coordinatorQA.status());
  check(
    captured.draftDirty &&
      !captured.inputDirty &&
      captured.ownership.captures === 1 &&
      captured.marks.length === 0 &&
      captured.requests.length === 1,
    'Real coordinator capture/dirty state',
  );
  check(
    captured.requests[0].capture.contentHash === captured.hash &&
      same(captured.requests[0].capture.revision, captured.snapshot.revision),
    'Actual captured identity',
  );
  check(
    same(await p.evaluate(() => window.coordinatorQA.files()), oldFiles),
    'Scratch allocated before admission',
  );
  await p.evaluate(() => window.coordinatorQA.resume());
  const saved = await p.evaluate(() => window.coordinatorQA.result());
  const savedState = await p.evaluate(() => window.coordinatorQA.status());
  check(
    saved.state === 'outcome' &&
      saved.outcome.state === 'committed' &&
      !savedState.draftDirty &&
      savedState.marks.length === 1 &&
      savedState.ownership.captures === 0,
    'Real coordinator did not settle/mark current draft',
  );
  const A = savedState.journal.operations[0].pin.bytes;
  const savedFiles = await p.evaluate(() => window.coordinatorQA.files());
  check(
    usageMatches(savedState, savedFiles) &&
      savedState.usage.reservations.length === 0 &&
      savedFiles.some((f) => same(f, oldFiles[0])),
    'Truthful committed usage/old file preservation',
  );
  const beforePoll = {
    hash: savedState.hash,
    revision: savedState.snapshot.revision,
    marks: savedState.marks,
  };
  await p.evaluate(() => window.coordinatorQA.usage());
  const afterPoll = await p.evaluate(() => window.coordinatorQA.status());
  check(
    same(beforePoll, {
      hash: afterPoll.hash,
      revision: afterPoll.snapshot.revision,
      marks: afterPoll.marks,
    }),
    'Usage read changed native/capture marker',
  );
  results.push({ id: 'SCAP02', state: 'PASS', A, captured, saved, savedState, savedFiles });
  await p.screenshot({ path: join(output, 'coordinator-saved-usage.png'), fullPage: true });
  check((await p.evaluate(() => window.coordinatorQA.close())) === 'closed', 'Settled Host close');
  check(
    same(await p.evaluate(() => window.coordinatorQA.files()), savedFiles),
    'Host close deleted archive/old file',
  );
  await context.close();

  // New browser origin/profile: same captured closure, one byte short including old namespace and both copies.
  p = await launch('combined-refusal');
  const tight = { ...policy, totalBytes: 4096 + 2 * A + policy.managementBytes - 1 };
  await setup(p, tight);
  await p.evaluate(() => window.coordinatorQA.seedOld());
  await p.evaluate(() => window.coordinatorQA.mount());
  await p.evaluate(() => window.coordinatorQA.edit());
  const before = await p.evaluate(() => window.coordinatorQA.status());
  const beforeFiles = await p.evaluate(() => window.coordinatorQA.files());
  await p.evaluate(() => window.coordinatorQA.start(false, true));
  await p.waitForFunction(() => window.coordinatorQA.held());
  const during = await p.evaluate(() => window.coordinatorQA.status());
  check(
    during.ownership.captures === 1 &&
      during.draftDirty &&
      during.requests[0].capture.contentHash === before.hash,
    'Refusal preparation lost capture',
  );
  await p.evaluate(() => window.coordinatorQA.resume());
  const refused = await p.evaluate(() => window.coordinatorQA.result());
  const after = await p.evaluate(() => window.coordinatorQA.status());
  check(
    refused.state === 'outcome' &&
      refused.outcome.state === 'aborted-before-write' &&
      refused.outcome.proof === 'adapter-no-write-guarantee',
    'Capacity refusal lacked actual coordinator no-write proof',
  );
  check(
    after.refusal.stage === 'total' &&
      after.refusal.archiveBytes === A &&
      after.refusal.additionalBytes === 2 * A,
    'Combined quota refusal not the expected exact plan',
  );
  check(
    after.draftDirty &&
      after.hash === before.hash &&
      same(after.snapshot.revision, before.snapshot.revision) &&
      after.marks.length === 0 &&
      after.originals === before.originals &&
      after.plans === before.plans,
    'Refusal changed native or marked it saved',
  );
  check(
    same(refused.outcome.capture, during.requests[0].capture) && after.ownership.captures === 0,
    'Definitive refusal lost capture identity or leaked its lifetime',
  );
  const afterFiles = await p.evaluate(() => window.coordinatorQA.files());
  check(
    same(beforeFiles, afterFiles) &&
      after.journal.head === 0 &&
      after.usage.reservations.length === 0 &&
      usageMatches(after, afterFiles),
    'Refusal allocated/deleted files or leaked capacity',
  );
  results.push({
    id: 'SCAP03',
    state: 'PASS',
    tight,
    before,
    during,
    refused,
    after,
    beforeFiles,
    afterFiles,
  });
  await p.screenshot({ path: join(output, 'coordinator-capacity-refusal.png'), fullPage: true });
  await context.close();

  p = await launch('same-owner-unknown');
  await setup(p, policy);
  await p.evaluate(() => window.coordinatorQA.seedOld());
  await p.evaluate(() => window.coordinatorQA.mount());
  await p.evaluate(() => window.coordinatorQA.edit());
  await p.evaluate(() => window.coordinatorQA.start(true));
  const unknown = await p.evaluate(() => window.coordinatorQA.result());
  const unknownState = await p.evaluate(() => window.coordinatorQA.status());
  check(
    unknown.state === 'outcome' &&
      unknown.outcome.state === 'indeterminate' &&
      unknownState.ownership.captures === 1 &&
      unknownState.draftDirty &&
      unknownState.marks.length === 0 &&
      unknownState.usage.reservations.length === 1,
    'Unknown did not retain actual claim/capture/reservation',
  );
  const unknownFiles = await p.evaluate(() => window.coordinatorQA.files());
  check(
    usageMatches(unknownState, unknownFiles) && unknownState.usage.reservedAdditionalBytes === A,
    'Unknown remaining scratch reservation untruthful',
  );
  check(
    (await p.evaluate(() => window.coordinatorQA.close())).includes('Unresolved Save'),
    'Unknown close abandoned owner',
  );
  await p.evaluate(() => window.coordinatorQA.cancelRead(true));
  check(
    (await p.evaluate(() => window.coordinatorQA.reconcile())).includes('indeterminate'),
    'Aborted evidence settled unknown',
  );
  const still = await p.evaluate(() => window.coordinatorQA.status());
  check(
    still.ownership.captures === 1 &&
      same(still.usage, unknownState.usage) &&
      still.marks.length === 0,
    'Aborted reconcile released ownership',
  );
  await p.evaluate(() => window.coordinatorQA.cancelRead(false));
  check(
    (await p.evaluate(() => window.coordinatorQA.reconcile())) === 'settled',
    'Same-owner coordinator reconciliation',
  );
  const settled = await p.evaluate(() => window.coordinatorQA.status());
  check(
    !settled.draftDirty &&
      settled.marks.length === 1 &&
      settled.ownership.captures === 0 &&
      settled.usage.reservations.length === 0 &&
      settled.hash === unknownState.hash,
    'Same-owner settlement changed native or failed to mark/release',
  );
  check(
    same(await p.evaluate(() => window.coordinatorQA.files()), unknownFiles),
    'Reconcile deleted committed/old files',
  );
  results.push({
    id: 'SCAP04',
    state: 'PASS',
    unknown,
    unknownState,
    still,
    settled,
    unknownFiles,
  });
  await context.close();

  p = await launch('fresh-owner-recovery');
  await setup(p, policy);
  await p.evaluate(() => window.coordinatorQA.seedOld());
  await p.evaluate(() => window.coordinatorQA.mount());
  await p.evaluate(() => window.coordinatorQA.edit());
  await p.evaluate(() => window.coordinatorQA.start(true));
  const coldUnknown = await p.evaluate(() => window.coordinatorQA.result());
  const coldState = await p.evaluate(() => window.coordinatorQA.status());
  const coldFiles = await p.evaluate(() => window.coordinatorQA.files());
  check(
    coldUnknown.state === 'outcome' &&
      coldUnknown.outcome.state === 'indeterminate' &&
      coldState.usage.reservations.length === 1,
    'Cold recovery fixture not unknown',
  );
  await context.close(); // Controlled process loss; never falsely report successful Host close.
  p = await launch('fresh-owner-recovery');
  const reopenedUsage = await setup(p, policy);
  check(
    same(reopenedUsage, coldState.usage),
    'Fresh accounting owner silently released reservation',
  );
  const recovered = await p.evaluate(
    ({ namespace, id }) => window.coordinatorQA.recover(namespace, id),
    { namespace: coldState.namespace, id: coldUnknown.outcome.operationId },
  );
  check(
    recovered.aborted.state === 'unknown' &&
      same(recovered.before, recovered.afterAborted) &&
      recovered.evidence.state === 'committed',
    'Fresh authorized recovery lost unknown or lacked verified evidence',
  );
  check(
    recovered.current.hash === coldState.hash &&
      recovered.current.marks.length === 0 &&
      recovered.current.requests.length === 0 &&
      recovered.current.ownership.captures === 0 &&
      recovered.current.usage.reservations.length === 0,
    'Fresh coordinator resurrected old job/marker or lost content',
  );
  check(
    recovered.current.snapshot.scope.sessionId !== recovered.oldCapture.scope.sessionId &&
      recovered.current.namespace !== coldState.namespace,
    'Recovery reused old coordinator/journal identity',
  );
  check(
    same(await p.evaluate(() => window.coordinatorQA.files()), coldFiles),
    'Fresh recovery/import deleted or copied old archives',
  );
  const freshSaved = await p.evaluate(() => window.coordinatorQA.save());
  const freshState = await p.evaluate(() => window.coordinatorQA.status());
  const freshFiles = await p.evaluate(() => window.coordinatorQA.files());
  const freshArchive = await p.evaluate(() => window.coordinatorQA.inspectArchive());
  check(
    freshSaved.state === 'outcome' &&
      freshSaved.outcome.state === 'committed' &&
      freshSaved.outcome.capture.scope.sessionId !== coldUnknown.outcome.capture.scope.sessionId &&
      freshState.marks.length === 1,
    'Fresh actual coordinator cannot save recovered native',
  );
  check(
    same(
      freshState.history.slice(0, recovered.current.history.length),
      recovered.current.history,
    ) && coldFiles.every((old) => freshFiles.some((f) => same(f, old))),
    'Fresh save altered retained versions or old file bytes',
  );
  check(
    usageMatches(freshState, freshFiles) && freshState.usage.reservations.length === 0,
    'Fresh save usage excludes prior namespace',
  );
  results.push({
    id: 'SCAP05',
    state: 'PASS',
    coldUnknown,
    coldState,
    reopenedUsage,
    recovered,
    freshSaved,
    freshState,
    freshArchive,
    coldFiles,
    freshFiles,
  });
  check(
    (await p.evaluate(() => window.coordinatorQA.close())) === 'closed',
    'Fresh settled Host close',
  );
  check(
    same(await p.evaluate(() => window.coordinatorQA.files()), freshFiles),
    'Close deleted retained files',
  );
  check(errors.length === 0, 'Browser errors');
} catch (error) {
  results.push({ state: 'FAIL', error: String(error), stack: error.stack });
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  await context?.close();
  await new Promise((r) => server.close(r));
  await writeFile(
    join(output, 'results.json'),
    JSON.stringify({ source, dirty, version, limits, results, errors }, null, 2),
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
