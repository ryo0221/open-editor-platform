import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
const out = process.argv[2];
await mkdir(out);
const notice = await readFile(
  'packages/video-metadata/file-backed-storage/integration/NOBLE-HASHES-LICENSE.txt',
  'utf8',
);
const built = await build({
  entryPoints: ['packages/video-metadata/host-media/m2/capacity-cross-version-entry.mjs'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  banner: { js: '/*!\n' + notice + '\n*/' },
});
const server = createServer((q, r) => {
  if (q.url === '/test.js') {
    r.setHeader('content-type', 'application/javascript');
    r.end(built.outputFiles[0].contents);
  } else {
    r.setHeader('content-type', 'text/html');
    r.end(
      '<!doctype html><title>Coordinated versions only</title><main></main><script type="module" src="/test.js"></script>',
    );
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  args: ['--no-sandbox'],
});
const errors = [],
  proofs = [];
try {
  for (const holder of ['2', '1']) {
    const context = await browser.newContext(),
      pages = {};
    for (const version of ['1', '2']) {
      const p = await context.newPage();
      pages[version] = p;
      p.on('pageerror', (e) => errors.push(String(e)));
      await p.goto(`http://127.0.0.1:${server.address().port}/?v=${version}`);
      await p.waitForFunction(() => !!globalThis.crossQA);
      await p.evaluate(() => globalThis.crossQA.edit(1));
      const saved = await p.evaluate(() => globalThis.crossQA.save());
      assert.equal(saved.outcome?.state, 'committed');
    }
    const peer = holder === '1' ? '2' : '1',
      holding = pages[holder],
      refused = pages[peer];
    await refused.evaluate(() => globalThis.crossQA.retainOld());
    const oldHash = await refused.evaluate(() => globalThis.crossQA.oldHash());
    await holding.evaluate(() => globalThis.crossQA.edit(2));
    await refused.evaluate(() => globalThis.crossQA.edit(2));
    const before = await refused.evaluate(() => globalThis.crossQA.status());
    await holding.evaluate(() => globalThis.crossQA.startHeld());
    await holding
      .waitForFunction(() => globalThis.crossQA.held())
      .catch(async (error) => {
        await writeFile(
          path.join(out, 'held-failure.json'),
          JSON.stringify(
            {
              result: await holding.evaluate(() => globalThis.crossQA.pending()),
              status: await holding.evaluate(() => globalThis.crossQA.status()),
            },
            null,
            2,
          ),
        );
        throw error;
      });
    const held = await holding.evaluate(() => globalThis.crossQA.status());
    assert(held.usage.reservations.length >= 2);
    assert(held.usage.availableBytes <= 1);
    const refusal = await refused.evaluate(() => globalThis.crossQA.save());
    assert.equal(refusal.state, 'outcome');
    assert.equal(refusal.outcome.state, 'aborted-before-write');
    assert.equal(refusal.outcome.proof, 'adapter-no-write-guarantee');
    const after = await refused.evaluate(() => globalThis.crossQA.status());
    assert.equal(after.ownership.captures, 0);
    assert.equal(after.ownership.unresolvedWrites, 0);
    assert.equal(after.transition?.unresolvedSave ?? false, false);
    assert.equal(after.saveEnabled, true);
    assert.equal(after.reconcileEnabled, false);
    assert(after.scratch.every((record) => record.phase === 'done'));
    assert.equal(after.refusal.stage, 'total');
    assert.equal(after.chunks, before.chunks);
    assert.deepEqual(after.native, before.native);
    assert.deepEqual(after.history, before.history);
    assert.deepEqual(after.journal, before.journal);
    assert.equal(await refused.evaluate(() => globalThis.crossQA.archiveHash()), oldHash);
    assert.deepEqual(after.usage.reservations, held.usage.reservations);
    await holding.evaluate(() => globalThis.crossQA.resume());
    const committed = await holding.evaluate(() => globalThis.crossQA.result());
    assert.equal(committed.outcome?.state, 'committed');
    const beforeRelease = await holding.evaluate(() => globalThis.crossQA.status());
    assert.equal(beforeRelease.usage.reservations.length, held.usage.reservations.length - 1);
    await holding.evaluate(() => globalThis.crossQA.settleCompeting());
    const settled = await holding.evaluate(() => globalThis.crossQA.status());
    assert.equal(settled.usage.reservations.length, 0);
    assert.equal(settled.usage.reservedAdditionalBytes, 0);
    assert.equal(settled.usage.overBudget, false);
    assert.equal(await refused.evaluate(() => globalThis.crossQA.archiveHash()), oldHash);
    const retry = await refused.evaluate(() => globalThis.crossQA.save());
    assert.equal(retry.outcome?.state, 'committed');
    assert.notEqual(retry.outcome.operationId, refusal.outcome.operationId);
    const recovered = await refused.evaluate(() => globalThis.crossQA.status());
    assert.equal(recovered.ownership.captures, 0);
    assert.equal(recovered.ownership.unresolvedWrites, 0);
    assert.equal(recovered.transition?.unresolvedSave ?? false, false);
    assert.equal(recovered.saveEnabled, true);
    assert.equal(recovered.reconcileEnabled, false);
    assert.deepEqual(recovered.native, before.native);
    assert.deepEqual(recovered.history.slice(0, -1), before.history);
    assert.equal(recovered.history.length, before.history.length + 1);
    assert.equal(recovered.usage.reservations.length, 0);
    assert.equal(recovered.usage.reservedAdditionalBytes, 0);
    assert.equal(recovered.usage.overBudget, false);
    assert.equal(await refused.evaluate(() => globalThis.crossQA.oldHash()), oldHash);
    for (const p of Object.values(pages)) await p.evaluate(() => globalThis.crossQA.close());
    proofs.push({
      holder,
      peer,
      oldHash,
      refusal,
      before,
      held,
      after,
      committed,
      beforeRelease,
      settled,
      retry,
      recovered,
    });
    await context.close();
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
const result = {
  state: 'PASS',
  code: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }),
  proofs,
  errors,
};
await writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2));
console.log(
  JSON.stringify({
    state: result.state,
    code: result.code,
    directions: proofs.map((p) => p.holder + ' reserves; ' + p.peer + ' refuses'),
  }),
);
