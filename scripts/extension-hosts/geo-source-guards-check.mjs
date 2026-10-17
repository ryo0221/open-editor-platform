/* global document, innerWidth, CompositionEvent, structuredClone */
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { URL } from 'node:url';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
const directory = path.resolve(process.argv[2]);
const csv = 'ID,lon,lat,value\n001,12,34,7';
const state = (page) => page.evaluate('geoSourceHost.state()');
const info = (page) => page.evaluate('geoSourceHost.retained()');
const button = (page, name) => page.getByRole('button', { name, exact: true });
async function save(page, expected = 'committed') {
  const result = await page.evaluate('geoSourceHost.save()');
  assert.equal(result.state, 'outcome');
  assert.equal(result.outcome.state, expected);
  return result.outcome;
}
async function importPoint(page) {
  await page
    .getByLabel('Local file', { exact: true })
    .setInputFiles({ name: 'one-point.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  for (const [label, value] of [
    ['ID column (optional)', 'ID'],
    ['First coordinate column', 'lon'],
    ['Second coordinate column', 'lat'],
  ])
    await page.getByLabel(label, { exact: true }).fill(value);
  for (const [i, name, type] of [
    [1, 'ID', 'string'],
    [2, 'value', 'number'],
  ]) {
    await button(page, 'Add field').click();
    await page.getByLabel(`Input column/property ${i}`, { exact: true }).fill(name);
    await page.getByLabel(`Type ${i}`, { exact: true }).selectOption(type);
  }
  await button(page, 'Preview import').click();
  await expect(page.getByRole('region', { name: 'Import geographic data' })).toContainText(
    'Read 1; valid 1; problem 0',
  );
  await button(page, 'Import previewed data').click();
  await expect.poll(async () => (await state(page)).content.layers[0]?.features.length).toBe(1);
  assert.equal((await state(page)).content.layers[0].features[0].values['field-1'], '001');
}
for (const kind of ['reference', 'independent']) {
  const root = path.join(directory, kind);
  const pin = JSON.parse(await readFile(path.join(root, 'editor-pin.json'), 'utf8'));
  const server = createServer(async (request, response) => {
    const name = new URL(request.url, 'http://localhost').pathname.slice(1);
    if (!['geo-source-save.html', 'geo-source-save.js'].includes(name)) {
      response.writeHead(204).end();
      return;
    }
    response.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/html');
    response.end(await readFile(path.join(root, 'dist', name)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
  try {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const errors = [];
      context.on('page', (page) => {
        page.on('pageerror', (error) => errors.push(String(error)));
        page.on('console', (message) => {
          if (message.type() === 'error') errors.push(message.text());
        });
      });
      await context.route('**/*', (route) => {
        if (new URL(route.request().url()).origin !== origin) {
          errors.push(route.request().url());
          return route.abort();
        }
        return route.continue();
      });
      try {
        const first = await context.newPage(),
          page = await context.newPage();
        for (const tab of [first, page]) {
          await tab.goto(origin + '/geo-source-save.html');
          await tab.waitForFunction('globalThis.ready');
        }
        assert.equal((await state(first)).head, null);
        assert.equal((await state(page)).head, null);
        await importPoint(page);
        const uncommitted = await state(page);
        // Another real tab acknowledges the first immutable empty version.
        await button(first, 'Save original + native').click();
        await expect.poll(async () => (await info(first)).versions).toBe(1);
        await expect.poll(async () => (await state(first)).retained).toBe(0);
        const firstId = (await info(first)).head;
        const firstRecord = await first.evaluate(
          (id) => globalThis.geoSourceHost.load(id),
          firstId,
        );
        await save(page, 'aborted-before-write');
        assert.equal((await state(page)).lastCode, 'SourceHeadConflict');
        assert.equal((await state(page)).head, null);
        assert.equal((await state(page)).hash, uncommitted.hash);
        assert.equal((await info(page)).versions, 1);
        await expect(page.getByRole('status', { name: 'Source save status' })).toContainText(
          'SourceHeadConflict',
        );
        // Only explicit latest reopen adopts the new head; rebuilding the import is deliberate.
        await button(page, 'Reopen latest').click();
        await expect.poll(async () => (await state(page)).head).toBe(firstId);
        assert.equal((await state(page)).content.layers.length, 0);
        await importPoint(page);
        await save(page);
        assert.equal((await info(page)).versions, 2);
        const imported = await state(page);
        const secondId = (await info(page)).head;
        const secondRecord = await page.evaluate(
          (id) => globalThis.geoSourceHost.load(id),
          secondId,
        );
        assert.equal(Buffer.from(secondRecord.closure[0].bytes, 'base64').toString(), csv);
        // Start read and IME in one JS turn, before asynchronous IndexedDB/hash admission completes.
        const imeResult = await page.evaluate(async () => {
          const input =
            document.querySelector('input[aria-label="ID column (optional)"]') ??
            [...document.querySelectorAll('input')].find((element) => element.type === 'text');
          if (!input) throw Error('MissingCompositionTarget');
          const pending = globalThis.geoSourceHost.reopen();
          input.dispatchEvent(
            new CompositionEvent('compositionstart', { bubbles: true, data: 'x' }),
          );
          try {
            await pending;
            return 'unexpected-success';
          } catch (error) {
            return String(error);
          } finally {
            input.dispatchEvent(
              new CompositionEvent('compositionend', { bubbles: true, data: 'x' }),
            );
          }
        });
        assert.match(imeResult, /GeoPendingInputs/);
        assert.equal((await state(page)).hash, imported.hash);
        assert.deepEqual((await state(page)).revision, imported.revision);
        assert.equal((await state(page)).head, secondId);
        assert.deepEqual((await state(page)).originals, imported.originals);
        for (const malformed of ['corrupt', 'missing']) {
          const candidate = structuredClone(secondRecord);
          if (malformed === 'corrupt') candidate.closure[0].bytes = 'eA==';
          else candidate.closure = [];
          const rejected = await page.evaluate(async (text) => {
            try {
              await globalThis.geoSourceHost.reopenText(text);
              return 'unexpected-success';
            } catch (error) {
              return String(error);
            }
          }, JSON.stringify(candidate));
          assert.match(
            rejected,
            malformed === 'corrupt' ? /SourceOriginalHash/ : /SourceClosureCount/,
          );
          assert.equal((await state(page)).hash, imported.hash);
          assert.deepEqual((await state(page)).revision, imported.revision);
          assert.equal((await state(page)).head, secondId);
          assert.deepEqual((await state(page)).originals, imported.originals);
        }
        const immutable = new Map([
          [firstId, firstRecord],
          [secondId, secondRecord],
        ]);
        // Every alternating Save is a distinct version; canonical Undo/Redo never mutates past records.
        for (let count = 3; count <= 16; count++) {
          await button(page, count % 2 ? 'Undo last change' : 'Redo last change').click();
          assert.equal((await state(page)).content.layers.length, count % 2 ? 0 : 1);
          await save(page);
          const index = await info(page);
          assert.equal(index.versions, count);
          immutable.set(
            index.head,
            await page.evaluate((id) => globalThis.geoSourceHost.load(id), index.head),
          );
        }
        const full = await info(page);
        assert.equal(full.versionIds.length, 16);
        const fullState = await state(page);
        await save(page); // No-op acknowledgement at the version limit does not allocate a version.
        assert.equal((await info(page)).versions, 16);
        assert.equal((await info(page)).head, full.head);
        assert.equal((await info(page)).acknowledgements, full.acknowledgements + 1);
        await button(page, 'Undo last change').click();
        const seventeenth = await state(page);
        await save(page, 'aborted-before-write');
        assert.equal((await state(page)).lastCode, 'SourceVersionLimit');
        assert.equal((await state(page)).hash, seventeenth.hash);
        assert.deepEqual((await state(page)).revision, seventeenth.revision);
        assert.equal((await info(page)).versions, 16);
        assert.equal((await info(page)).head, full.head);
        await expect(page.getByRole('status', { name: 'Source save status' })).toContainText(
          'SourceVersionLimit',
        );
        for (const [id, record] of immutable)
          assert.deepEqual(
            await page.evaluate((version) => globalThis.geoSourceHost.load(version), id),
            record,
          );
        await button(page, 'Reopen latest').click();
        await expect.poll(async () => (await state(page)).hash).toBe(fullState.hash);
        assert.equal((await state(page)).head, full.head);
        assert.equal((await state(page)).originals.length, 1);
        await page.evaluate("geoSourceHost.storageMode('uncertain')");
        const unknown = await save(page, 'indeterminate');
        assert.equal((await info(page)).versions, 16);
        assert.equal((await info(page)).head, full.head);
        assert.equal((await state(page)).retained, 1);
        await button(page, 'Close edit scope').click();
        assert.equal((await state(page)).originals.length, 0);
        assert.equal((await state(page)).retained, 1);
        assert.equal((await state(page)).policy, 'readonly');
        await page.evaluate('geoSourceHost.reconcile()');
        await expect.poll(async () => (await state(page)).retained).toBe(0);
        const settled = (await state(page)).observations.find(
          (job) => job.operationId === unknown.operationId,
        );
        assert.equal(settled?.outcome.state, 'committed');
        assert.equal((await info(page)).versions, 16);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        assert.deepEqual((await state(page)).errors, []);
        assert.deepEqual((await state(first)).errors, []);
        assert.deepEqual(errors, []);
        await page.screenshot({ path: path.join(root, `source-guards-${width}.png`) });
        console.log(
          'PASS',
          kind,
          width,
          pin.sourceCommit,
          'two-tab expected-head refusal + explicit reopen / IME async read refusal / corrupt+missing closure refusal / 16 immutable versions + no-op + 17th refusal / unknown+revoke retains originals until reconcile',
        );
      } finally {
        await context.close();
      }
      // A separate browser storage/authority scope proves the conservative history guard
      // still requires originals when the currently visible native has no sources at all.
      const historyContext = await browser.newContext({ viewport: { width, height: 900 } });
      const historyErrors = [];
      try {
        const page = await historyContext.newPage();
        page.on('pageerror', (error) => historyErrors.push(String(error)));
        page.on('console', (message) => {
          if (message.type() === 'error') historyErrors.push(message.text());
        });
        await historyContext.route('**/*', (route) => {
          if (new URL(route.request().url()).origin !== origin) {
            historyErrors.push(route.request().url());
            return route.abort();
          }
          return route.continue();
        });
        await page.goto(origin + '/geo-source-save.html');
        await page.waitForFunction('globalThis.ready');
        assert.equal((await state(page)).head, null);
        await importPoint(page);
        const imported = await state(page);
        assert.equal(imported.originals.length, 1);
        const resourceId = imported.originals[0].resourceId;
        await button(page, 'Undo last change').click();
        const empty = await state(page);
        assert.equal(empty.content.layers.length, 0);
        assert.equal(empty.content.sources.length, 0);
        assert.equal(empty.canUndo, false);
        assert.equal(empty.canRedo, true);
        assert.equal(empty.originals.length, 1);
        assert.equal(
          await page.evaluate((id) => globalThis.geoSourceHost.loseOriginal(id), resourceId),
          true,
        );
        assert.equal((await state(page)).originals.length, 0);
        const unchanged = async () => {
          const after = await state(page);
          assert.deepEqual(after.content, empty.content);
          assert.equal(after.hash, empty.hash);
          assert.deepEqual(after.revision, empty.revision);
          assert.equal(after.canUndo, empty.canUndo);
          assert.equal(after.canRedo, empty.canRedo);
          assert.equal(after.head, empty.head);
          assert.equal(after.originals.length, 0);
          assert.equal(after.retained, 0);
          assert.deepEqual(after.errors, []);
        };
        // The button was eligible before loss; its handler must recheck at invocation.
        await button(page, 'Redo last change').click();
        await unchanged();
        const refused = await page.evaluate('geoSourceHost.redo()');
        assert.deepEqual(refused, {
          state: 'refused',
          code: 'GeoHistoryRefused',
          message: 'GeoSourceClosureRequired',
        });
        await unchanged();
        assert.equal((await info(page)).versions, 0);
        assert.deepEqual(historyErrors, []);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page.screenshot({ path: path.join(root, `source-history-closure-${width}.png`) });
        console.log(
          'PASS',
          kind,
          width,
          pin.sourceCommit,
          'isolated import → Undo to empty native → lose original / UI and public API Redo refused / native + revision + UndoRedo preserved',
        );
      } finally {
        await historyContext.close();
      }
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
