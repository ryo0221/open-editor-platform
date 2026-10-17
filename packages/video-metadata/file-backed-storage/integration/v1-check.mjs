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
const output = resolve(process.argv[2] ?? '/tmp/video-v1-integration');
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
    entryPoints: ['packages/video-metadata/file-backed-storage/integration/v1-harness.ts'],
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
    '<!doctype html><title>Private real save integration</title><h1>Scoped SaveCoordinator + ZIP64 + OPFS</h1><p>Independent synthetic Host; Video production wiring not changed</p><input id="portable-input" type="file"><section id="host"></section><script type="module" src="/test.js"></script>';
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
  await launch();
  const initial = await page.evaluate(() => window.qa.seed());
  check(
    initial.content.schema === 'video-core-prototype-v1' && initial.liveOriginals === 1,
    'Selected v1 closure in independent Host catalog',
  );
  const saved = await page.evaluate(() => window.qa.save());
  check(saved.state === 'committed', 'Real v1 scoped coordinator save: ' + JSON.stringify(saved));
  const first = await page.evaluate(() => window.qa.inspectCurrent());
  check(
    first.kind === 'v1' && first.versions.length === 3,
    'Portable v1 archive retains original versions',
  );
  const download = page.waitForEvent('download');
  await page.evaluate(() => window.qa.download());
  await (await download).saveAs(join(output, 'saved-v1.zip'));
  results.push({
    case: 'v1 actual #194 Host scope saves exact fractional native/history/original portable archive',
    status: 'PASS',
  });
  const leases = await page.evaluate(() => window.qa.leases());
  check(
    leases.maximumRead <= 65536 &&
      leases.maximumRead > 0 &&
      leases.oversized &&
      leases.lateRejected &&
      leases.blobRejected &&
      leases.capped &&
      leases.remaining === 0,
    'Bounded external leases and release: ' + JSON.stringify(leases),
  );
  results.push({
    case: 'external File full closure with bounded reads, late-release refusal and explicit byte cap',
    status: 'PASS',
    leases,
  });
  const closed = await page.evaluate(() => window.qa.close());
  check(
    closed.refused && closed.liveOriginals === 0,
    'Host closes consumers/catalog and persistence',
  );
  await context.close();
  // New browser process, new empty origin storage/profile. Only the downloaded portable File is provided.
  profile = 'empty-reopen-profile';
  await launch();
  await page.locator('#portable-input').setInputFiles(join(output, 'saved-v1.zip'));
  const reopened = await page.evaluate(() => window.qa.reopen());
  check(
    reopened.hash === initial.hash && reopened.liveOriginals === 1 && reopened.livePlans === 1,
    'Empty Host external-file reopen restores exact selected native and live catalogs',
  );
  const savedAgain = await page.evaluate(() => window.qa.save());
  check(savedAgain.state === 'committed', 'Fresh scope saves imported retained history');
  const second = await page.evaluate(() => window.qa.inspectCurrent());
  check(
    second.versions.length === 4 &&
      JSON.stringify(second.versions.slice(0, 3)) === JSON.stringify(first.versions) &&
      JSON.stringify(second.originals) === JSON.stringify(first.originals),
    'Historical native hashes/envelopes and original closure remain unchanged',
  );
  results.push({
    case: 'external File only -> fresh empty Host -> actual scoped save retains old hashes/history and originals',
    status: 'PASS',
  });
  const before = await page.evaluate(() => window.qa.status());
  await page.locator('#host #open').setInputFiles({
    name: 'invalid.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from('invalid archive'),
  });
  await page.waitForFunction(() =>
    document.querySelector('#host #status').textContent.includes('Error'),
  );
  const after = await page.evaluate(() => window.qa.status());
  check(
    before.hash === after.hash && before.liveOriginals === after.liveOriginals,
    'Failed replacement preserves live Host',
  );
  results.push({
    case: 'real #194 Host rejects invalid external replacement without losing previous draft/catalog',
    status: 'PASS',
  });
  await page.locator('#portable-input').setInputFiles(join(output, 'valid.zip'));
  const old = await page.evaluate(() => window.qa.v0());
  check(
    old.kind === 'v0' && old.rejected && old.liveOriginals === 0 && old.livePlans === 0,
    'Explicit v0 dispatch; v1 Host rejects without migration/live mutation',
  );
  results.push({
    case: 'v0 external read remains supported; v1 Host cannot silently upgrade it',
    status: 'PASS',
  });
  await page.screenshot({ path: join(output, 'v1-external-reopen.png'), fullPage: true });
  await page.evaluate(() => window.qa.close());
  await context.close();
  profile = 'parent-only-profile';
  await launch();
  await page.evaluate(() => window.qa.seed(true));
  check((await page.evaluate(() => window.qa.save())).state === 'committed', 'Parent-only save');
  const retained = await page.evaluate(() => window.qa.inspectCurrent());
  check(
    retained.versions[retained.versions.length - 1].content.sources.length === 0 &&
      retained.originals.length === 1,
    'Parent-only original not lost when selected version has no sources',
  );
  results.push({
    case: 'full retained closure includes parent-only source despite empty selected native',
    status: 'PASS',
  });
  await page.evaluate(() => window.qa.close());
  await context.close();
  profile = 'actual-owner-reconcile';
  await launch();
  const beforeUnknown = await page.evaluate(() => window.qa.seed());
  await page.evaluate(() => window.qa.startUnknown());
  await page.waitForFunction(() => window.qa.held());
  await page.evaluate(() => window.qa.startPendingClose());
  await page.evaluate(() => window.qa.releaseAck());
  const lost = await page.evaluate(() => window.qa.unknownResult());
  check(
    lost.state === 'outcome' && lost.outcome.state === 'indeterminate',
    'Real committed archive loses acknowledgement',
  );
  const refusedClose = await page.evaluate(() => window.qa.pendingCloseResult());
  check(
    refusedClose.includes('Unresolved Save'),
    'Pending close returns to live recoverable state',
  );
  let owners = await page.evaluate(() => window.qa.owners());
  check(
    owners.length === 1 &&
      owners[0].port &&
      owners[0].closes === 0 &&
      owners[0].originals === 1 &&
      owners[0].ownership.captures === 1,
    'Unresolved claim retains SAME owner/catalog/capture, no persistence drain',
  );
  const busy = await page.evaluate(() => window.qa.save().catch((e) => String(e)));
  check(
    typeof busy === 'string' && busy.includes('HostBusyOrUnresolved'),
    'Unknown blocks a new save',
  );
  check(await page.locator('#host #open').isDisabled(), 'Unknown blocks replacement');
  await page.evaluate(() => window.qa.cancelReconciliationRead(true));
  const still = await page.evaluate(() => window.qa.reconcileHost());
  check(
    still.includes('indeterminate'),
    'Aborted verification through actual storage stays unknown',
  );
  owners = await page.evaluate(() => window.qa.owners());
  check(
    owners.length === 1 &&
      owners[0].reconciles === 1 &&
      owners[0].closes === 0 &&
      owners[0].ownership.captures === 1,
    'Port delegates same storage, still-unknown does not release capture',
  );
  await page.evaluate(() => window.qa.cancelReconciliationRead(false));
  check(
    (await page.evaluate(() => window.qa.reconcileHost())) === 'settled',
    'Actual archive verification reconciles through same Host coordinator',
  );
  owners = await page.evaluate(() => window.qa.owners());
  check(
    owners.length === 1 &&
      owners[0].reconciles === 2 &&
      owners[0].closes === 0 &&
      owners[0].ownership.captures === 0 &&
      owners[0].originals === 1,
    'Exact receipt releases only claim; same owner remains live',
  );
  check(
    (await page.evaluate(() => window.qa.status())).hash === beforeUnknown.hash,
    'Recovery preserves native',
  );
  const next = await page.evaluate(() => window.qa.save());
  check(
    next.state === 'committed' &&
      next.capture.scope.sessionId === lost.outcome.capture.scope.sessionId,
    'Next save uses same original coordinator scope',
  );
  results.push({
    case: 'actual factory unknown -> refused pending close -> unknown -> committed reconciliation -> same-owner next save',
    status: 'PASS',
  });
  const replacementDownload = page.waitForEvent('download');
  await page.evaluate(() => window.qa.download());
  await (await replacementDownload).saveAs(join(output, 'reconciled-replacement.zip'));
  await page.locator('#host #open').setInputFiles(join(output, 'reconciled-replacement.zip'));
  await page.waitForFunction(
    () =>
      window.qa.owners().length === 2 &&
      window.qa.owners()[0].closes === 1 &&
      !!document.querySelector('#host > section'),
  );
  owners = await page.evaluate(() => window.qa.owners());
  check(
    owners[0].originals === 0 && owners[1].closes === 0 && owners[1].originals === 1,
    'Only settled owner closes during verified replacement',
  );
  await page.evaluate(() => window.qa.close());
  owners = await page.evaluate(() => window.qa.owners());
  check(
    owners.every((o) => o.closes === 1 && o.originals === 0 && o.plans === 0),
    'Replacement close releases both owners exactly once',
  );
  results.push({
    case: 'after same-owner settlement verified replacement and final close release original/catalog ownership exactly once',
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
