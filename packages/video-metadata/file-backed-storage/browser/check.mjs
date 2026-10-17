/* eslint-disable no-undef */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const output = resolve(process.argv[2] ?? '/tmp/video-browser-journal');
// Evidence directories are exclusive: never overwrite a prior failure or profile.
await mkdir(output);
const fixtures = Object.fromEntries(
  [
    ['large', 40 * 1024 ** 2, 90],
    ['small', 256 * 1024, 51],
    ['other', 256 * 1024, 17],
  ].map(([name, bytes, seed]) => {
    const chunk = Buffer.alloc(65536, seed),
      h = createHash('sha256');
    for (let n = 0; n < bytes; n += chunk.length) h.update(chunk);
    return [
      name,
      {
        bytes,
        seed,
        sha256: h.digest('hex'),
        chunkHash: createHash('sha256').update(chunk).digest('hex'),
        captureKey: createHash('sha256').update(name).digest('hex'),
      },
    ];
  }),
);
const bundle = await build({
  entryPoints: ['packages/video-metadata/file-backed-storage/browser/harness.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
});
const html =
  '<!doctype html><title>Private storage verification</title><h1>OPFS journal candidate</h1><p>Controlled synthetic storage tests; no Video UI integration</p><pre></pre><script type="module" src="/test.js"></script>';
const server = createServer((req, res) => {
  if (req.url === '/test.js') {
    res.setHeader('content-type', 'text/javascript');
    res.end(bundle.outputFiles[0].contents);
  } else if (req.url === '/fixtures.json') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(fixtures));
  } else if (req.url === '/favicon.ico') {
    res.statusCode = 204;
    res.end();
  } else {
    res.setHeader('content-type', 'text/html');
    res.end(html);
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`,
  profile = resolve(output, 'profile');
let context,
  page,
  launches = 0;
const sourceTreeStatus = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
let browserVersion = '';
const errors = [],
  results = [];
const check = (v, why) => {
  if (!v) throw Error(why);
};
async function launch(name = 'journal-tests') {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox'],
    viewport: { width: 1280, height: 800 },
  });
  launches++;
  browserVersion = context.browser()?.version() ?? 'unknown';
  page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(url);
  await page.waitForFunction(() => !!window.qa);
  await page.evaluate((name) => window.qa.open(name), name);
}
async function state() {
  return page.evaluate(() => window.qa.state());
}
async function save(id, which, head, pause = '', cancel = 0) {
  return page.evaluate((a) => window.qa.save(...a), [id, which, head, pause, cancel]);
}
async function restartedPaused(id, phase, expectedHead, name = 'journal-tests') {
  // The pending transport is expected to reject when this actual browser process exits.
  const pending = save(id, 'small', expectedHead, phase).catch((e) => ({ interrupted: String(e) }));
  await page.waitForFunction((p) => window.qa.phase().phase === p, phase);
  await context.close();
  await pending;
  await launch(name);
}
try {
  await launch();
  check((await save('A', 'large', 0)).state === 'saved', '40MiB OPFS save');
  const leaseA = await page.evaluate(() => window.qa.leaseCheck('A'));
  check(
    leaseA.bytes === fixtures.large.bytes &&
      leaseA.refused &&
      leaseA.hashes.every((h) => h === fixtures.large.chunkHash),
    'File/Blob/range lease',
  );
  results.push({
    case: 'B01 real40MiB OPFS save and stable File/Blob/range lease',
    status: 'PASS',
    sha256: fixtures.large.sha256,
  });
  const filesBefore = await page.evaluate(() => window.qa.files());
  check((await save('cancel', 'small', 1, '', 2)).state === 'not-written', 'Mid-write cancel');
  check((await state()).current === 'A', 'Cancel old current');
  check(
    JSON.stringify(await page.evaluate(() => window.qa.files())) === JSON.stringify(filesBefore),
    'Cancel cleanup',
  );
  check(
    (await save('quota', 'large', 1)).state === 'not-written',
    'Cumulative64MiB configured quota',
  );
  check((await state()).current === 'A', 'Quota old current');
  check(
    (await save('A', 'large', 1)).state === 'unknown',
    'Reused committed operation never claims no-write',
  );
  results.push({
    case: 'B02 mid-write cancel and real configured quota reservation preserve A',
    status: 'PASS',
  });
  await restartedPaused('B', 'prepared', 1);
  check((await state()).current === 'A', 'Prepared restart did not overwrite A');
  check(
    (await page.evaluate(() => window.qa.reconcile('B'))).state === 'ready',
    'Prepared restart ready',
  );
  await page.evaluate(() => window.qa.authority(false));
  check(
    (await page.evaluate(() => window.qa.resume('B'))).state === 'unknown',
    'Revoked resume refused',
  );
  check((await state()).current === 'A', 'Revoked resume old current');
  await page.evaluate(() => window.qa.authority(true));
  check((await page.evaluate(() => window.qa.resume('B'))).state === 'saved', 'Explicit resumed B');
  check(
    (await page.evaluate(() => window.qa.reconcile('A'))).state === 'saved',
    'Old receipt still valid',
  );
  check((await state()).current === 'B', 'Old receipt never republishes A');
  check((await save('stale', 'other', 0)).state === 'not-written', 'Stale expected head refused');
  check((await state()).current === 'B', 'Stale save preserved B');
  check(
    (await page.evaluate(() => window.qa.leaseCheck('A'))).hashes.every(
      (h) => h === fixtures.large.chunkHash,
    ),
    'Old file preserved after B',
  );
  results.push({
    case: 'B03 new browser process restores prepared B, authority + explicit resume, stale A cannot overwrite B',
    status: 'PASS',
  });
  await restartedPaused('C', 'committed', 2);
  check(
    (await page.evaluate(() => window.qa.reconcile('C'))).state === 'saved',
    'Lost acknowledgement after IDB commit',
  );
  check((await state()).current === 'C', 'Current C survived process restart');
  results.push({
    case: 'B04 committed receipt recovered after browser process exit before acknowledgement',
    status: 'PASS',
  });
  await restartedPaused('D', 'intent', 3);
  check(
    (await page.evaluate(() => window.qa.reconcile('D'))).state === 'unknown',
    'Missing stage is unknown',
  );
  check(
    (await save('blocked', 'other', 3)).state === 'not-written',
    'Unresolved D blocks new save',
  );
  check((await state()).current === 'C', 'Unknown D preserved C');
  results.push({
    case: 'B05 restart after durable intent: missing candidate unknown, current C retained, new save blocked',
    status: 'PASS',
  });
  await page.evaluate(() => window.qa.tamper('C'));
  check(
    (await page.evaluate(() => window.qa.reconcile('C'))).state === 'unknown',
    'Tampered committed candidate unknown',
  );
  await page.evaluate(() => window.qa.remove('B'));
  check(
    (await page.evaluate(() => window.qa.reconcile('B'))).state === 'unknown',
    'Missing completed candidate unknown',
  );
  results.push({
    case: 'B06 missing/tampered completed file is never successful receipt',
    status: 'PASS',
  });
  await page.screenshot({ path: resolve(output, 'journal-state.png'), fullPage: true });
  await page.evaluate(() => window.qa.dropJournal());
  check(
    (await page.evaluate(() => window.qa.save('A', 'large', 0, '', 0, false))).state === 'unknown',
    'Unavailable journal cannot prove no previous write',
  );
  let missingRefused = false;
  try {
    await page.evaluate(() => window.qa.open());
  } catch (e) {
    missingRefused = String(e).includes('Missing journal');
  }
  check(missingRefused, 'Missing journal must not silently reset when files remain');
  results.push({
    case: 'B07 missing journal with existing OPFS candidates refuses fresh initialization',
    status: 'PASS',
  });
  await page.evaluate(() => window.qa.open('lease-tests'));
  check((await save('leaseA', 'small', 0)).state === 'saved', 'Lease A');
  await page.evaluate(() => window.qa.hold('leaseA'));
  check((await save('leaseB', 'other', 1)).state === 'saved', 'Lease B');
  const held = await page.evaluate(() => window.qa.checkHeld());
  check(
    held.hashes.every((h) => h === fixtures.small.chunkHash) && held.refused,
    'Held old File/Blob stable, late read refused after release',
  );
  results.push({
    case: 'B08 held File/Blob survives newer selection, release rejects pending range read',
    status: 'PASS',
  });
  const beforeFault = await page.evaluate(() => window.qa.files());
  check(
    (await page.evaluate(() => window.qa.quotaFault(2))).state === 'not-written',
    'Injected QuotaExceededError is no-write',
  );
  check(
    (await state()).current === 'leaseB' &&
      JSON.stringify(await page.evaluate(() => window.qa.files())) === JSON.stringify(beforeFault),
    'Write fault preserved old file and cleaned stage',
  );
  results.push({
    case: 'B09 injected browser QuotaExceededError during actual OPFS write preserves previous completed candidate',
    status: 'PASS',
  });
  await page.evaluate(() => window.qa.open('partial-tests'));
  check((await save('partialA', 'small', 0)).state === 'saved', 'Partial baseline');
  await restartedPaused('partialB', 'chunk', 1, 'partial-tests');
  check(
    (await page.evaluate(() => window.qa.reconcile('partialB'))).state === 'unknown',
    'Interrupted unclosed OPFS write remains unknown',
  );
  check((await state()).current === 'partialA', 'Interrupted write old selection');
  check(
    (await page.evaluate(() => window.qa.leaseCheck('partialA'))).hashes.every(
      (h) => h === fixtures.small.chunkHash,
    ),
    'Prior bytes survive partial write restart',
  );
  results.push({
    case: 'B10 actual browser process exits during open OPFS writer, fresh process retains unknown and old complete file',
    status: 'PASS',
  });
  await page.evaluate(() => window.qa.authority(false));
  check(
    (await page.evaluate(() => window.qa.abandon('partialB'))).state === 'unknown',
    'Revoked abandonment refused',
  );
  await page.evaluate(() => window.qa.authority(true));
  check(
    (await page.evaluate(() => window.qa.abandon('partialB'))).state === 'not-written',
    'Explicit abandon settles unpublished partial file',
  );
  check(
    (await save('retry-after-abandon', 'other', 1)).state === 'saved',
    'New operation after abandonment',
  );
  check(
    (await page.evaluate(() => window.qa.abandon('partialA'))).state === 'saved',
    'Abandon cannot delete prior committed file',
  );
  check(
    (await page.evaluate(() => window.qa.leaseCheck('partialA'))).hashes.every(
      (h) => h === fixtures.small.chunkHash,
    ),
    'Committed file retained',
  );
  results.push({
    case: 'B11 explicit authorized abandonment releases interrupted staging; committed files remain immutable',
    status: 'PASS',
  });
  await page.evaluate(() => window.qa.corruptCommittedParent());
  let corruptRefused = false;
  try {
    await state();
  } catch (e) {
    corruptRefused = String(e).includes('Journal sequence');
  }
  check(corruptRefused, 'Future committed parent rejected');
  check(
    (await page.evaluate(() => window.qa.save('unverifiable', 'small', 2, '', 0, false))).state ===
      'unknown',
    'Corrupt journal cannot prove no-write',
  );
  results.push({
    case: 'B12 corrupt committed sequence is refused without issuing false no-write evidence',
    status: 'PASS',
  });
  await page.evaluate(() => window.qa.open('competing-tests'));
  for (const kind of ['cancel', 'authority', 'stale']) {
    const outcomes = await page.evaluate(
      (kind) => window.qa.rejectThenCompete(`rejected-${kind}`, kind),
      kind,
    );
    check(
      outcomes[0].state === 'not-written' && outcomes[1].state === 'unknown',
      `Competing ${kind} must not commit fenced ID: ${JSON.stringify(outcomes)}`,
    );
    check((await state()).head === 0, 'Rejected ID never selected');
  }
  check((await page.evaluate(() => window.qa.files())).length === 0, 'No rejected candidate file');
  await context.close();
  await launch('competing-tests');
  for (const kind of ['cancel', 'authority', 'stale'])
    check(
      (await save(`rejected-${kind}`, 'small', 0)).state === 'unknown',
      'Restart preserves rejected IDs',
    );
  check(
    (await save('fresh-after-fences', 'small', 0)).state === 'saved',
    'New operation can proceed',
  );
  results.push({
    case: 'B13 competing owners and restart retain rejected operation fences',
    status: 'PASS',
  });
  for (const [when, expected] of [
    ['prepared', 'not-written'],
    ['commit', 'unknown'],
    ['committed', 'saved'],
  ]) {
    await page.evaluate((name) => window.qa.open(name), `boundary-${when}`);
    check((await save('boundary-base', 'small', 0)).state === 'saved', 'Boundary base');
    const result = await page.evaluate((when) => window.qa.boundaryCancel(when), when);
    check(result.state === expected, `Cancellation at ${when}: ${JSON.stringify(result)}`);
    check(
      (await state()).current === (when === 'committed' ? `boundary-${when}` : 'boundary-base'),
      'Commit cancellation preserves actual selection',
    );
    if (when === 'commit')
      check(
        (await page.evaluate(() => window.qa.reconcile('boundary-commit'))).state === 'ready',
        'Cancelled transaction left prepared, never committed',
      );
  }
  results.push({
    case: 'B14 cancellation before, inside, and after journal commit preserves actual outcome',
    status: 'PASS',
  });
  check(errors.length === 0, `Browser errors: ${errors.join('\n')}`);
} catch (e) {
  results.push({ case: 'runner', status: 'FAIL', error: String(e) });
  process.exitCode = 1;
} finally {
  await context?.close();
  await new Promise((r) => server.close(r));
  const report = {
    tested: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    launches,
    browserVersion,
    sourceTreeStatus,
    bundleSha256: createHash('sha256').update(bundle.outputFiles[0].contents).digest('hex'),
    fixturePins: fixtures,
    browserErrors: errors,
    results,
    limits:
      'Controlled restart of actual Chromium processes, not OS power-loss. Synthetic payload verifier, not ZIP/native integration. Configured application quota, not forced browser disk exhaustion.',
  };
  await writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
