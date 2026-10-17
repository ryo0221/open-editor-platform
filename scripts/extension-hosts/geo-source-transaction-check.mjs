/* global IDBObjectStore, indexedDB, DOMException */
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
async function save(page, expected) {
  const result = await page.evaluate('geoSourceHost.save()');
  assert.equal(result.state, 'outcome');
  assert.equal(result.outcome.state, expected);
  return result.outcome;
}
async function readBucket(page, artifactId) {
  return page.evaluate(async (key) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(key + '-v1', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('artifacts', 'readonly');
        const request = tx.objectStore('artifacts').get(key);
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }, artifactId);
}
async function installFault(page, artifactId, mode) {
  await page.evaluate(
    ({ key, mode }) => {
      const original = IDBObjectStore.prototype.put;
      const probe = { mode, calls: 0, putSuccess: 0, abortEvents: 0, quotaThrows: 0 };
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name !== 'artifacts' || this.transaction.db.name !== key + '-v1')
          return original.apply(this, args);
        probe.calls++;
        if (mode === 'quota') {
          probe.quotaThrows++;
          // A real DOMException injected at the backend call boundary. This does NOT
          // fill the disk or measure browser quota, and is not an application cap.
          throw new DOMException('Injected backend quota refusal', 'QuotaExceededError');
        }
        const tx = this.transaction;
        tx.addEventListener(
          'abort',
          () => {
            probe.abortEvents++;
          },
          { once: true },
        );
        const request = original.apply(this, args);
        request.addEventListener(
          'success',
          () => {
            probe.putSuccess++;
            // The real browser accepted the put; abort the SAME real transaction
            // before oncomplete. The prior committed version/head/ack must survive.
            tx.abort();
          },
          { once: true },
        );
        return request;
      };
      globalThis.sourceTransactionProbe = {
        probe,
        restore() {
          IDBObjectStore.prototype.put = original;
        },
      };
    },
    { key: artifactId, mode },
  );
}
for (const kind of ['reference', 'independent']) {
  const root = path.join(directory, kind);
  const pin = JSON.parse(await readFile(path.join(root, 'editor-pin.json'), 'utf8'));
  const artifactId = kind + '-geo-source-save';
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
      try {
        const page = await context.newPage(),
          errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        page.on('console', (message) => {
          if (message.type() === 'error') errors.push(message.text());
        });
        await page.route('**/*', (route) => {
          if (new URL(route.request().url()).origin !== origin) {
            errors.push(route.request().url());
            return route.abort();
          }
          return route.continue();
        });
        await page.goto(origin + '/geo-source-save.html');
        await page.waitForFunction('globalThis.ready');
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
        await expect
          .poll(async () => (await state(page)).content.layers[0]?.features.length)
          .toBe(1);
        await save(page, 'committed');
        const trials = [];
        for (const [mode, longitude] of [
          ['abort-after-put-success', '13'],
          ['quota', '14'],
        ]) {
          const beforeText = await readBucket(page, artifactId),
            before = await info(page);
          const beforeSaved = (await state(page)).saved;
          await page.getByLabel('Longitude', { exact: true }).fill(longitude);
          await button(page, 'Apply').click();
          const draft = await state(page);
          assert.equal(draft.inputs.dirty, 0);
          await installFault(page, artifactId, mode);
          let probe;
          try {
            const outcome = await save(page, 'aborted-before-write');
            assert.equal(outcome.proof, 'adapter-no-write-guarantee');
            probe = await page.evaluate('sourceTransactionProbe.probe');
          } finally {
            await page.evaluate('sourceTransactionProbe.restore()');
          }
          assert.equal(probe.calls, 1);
          assert.equal(probe.putSuccess, mode === 'quota' ? 0 : 1);
          assert.equal(probe.abortEvents, mode === 'quota' ? 0 : 1);
          assert.equal(probe.quotaThrows, mode === 'quota' ? 1 : 0);
          assert.equal(
            await readBucket(page, artifactId),
            beforeText,
            'entire persisted bucket unchanged: all version texts, head and ack',
          );
          assert.deepEqual(await info(page), before);
          const after = await state(page);
          assert.equal(after.hash, draft.hash);
          assert.deepEqual(after.revision, draft.revision);
          assert.deepEqual(after.saved, beforeSaved);
          assert.equal(after.retained, 0);
          assert.deepEqual(after.originals, draft.originals);
          await save(page, 'committed');
          const retried = await info(page);
          assert.equal(retried.versions, before.versions + 1);
          assert.equal(retried.acknowledgements, before.acknowledgements + 1);
          assert.notEqual(retried.head, before.head);
          const old = JSON.parse(beforeText),
            current = JSON.parse(await readBucket(page, artifactId));
          for (const version of old.versions)
            assert.deepEqual(
              current.versions.find((v) => v.id === version.id),
              version,
            );
          assert.equal((await state(page)).retained, 0);
          trials.push({
            ...probe,
            outcome: 'aborted-before-write',
            priorBucket: 'byte-identical',
            retry: 'committed',
          });
        }
        await page.reload();
        await page.waitForFunction('globalThis.ready');
        const restored = await state(page);
        assert.equal(restored.content.layers[0].features[0].geometry.coordinates[0], 14);
        assert.equal((await info(page)).versions, 3);
        assert.equal(restored.originals.length, 1);
        assert.deepEqual(errors, []);
        assert.deepEqual(restored.errors, []);
        console.log(
          JSON.stringify({
            state: 'PASS',
            host: kind,
            width,
            sourceCommit: pin.sourceCommit,
            trials,
            reload: 'latest native plus original',
            limitations:
              'Real IndexedDB abort after actual put success; quota is injected DOMException, not physical disk exhaustion or performance measurement; reload is not process restart.',
          }),
        );
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
