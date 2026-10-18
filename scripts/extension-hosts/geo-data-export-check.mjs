/* global document, innerWidth, indexedDB, crypto */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { readFile, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { URL } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { chromium, expect } from '@playwright/test';

const directory = path.resolve(process.argv[2]);
const original = [
  'ID,lon,lat,value',
  ...Array.from(
    { length: 200 },
    (_, i) => `${String(i + 1).padStart(3, '0')},${i > 197 ? '' : 12 + i / 1000},34,${i}`,
  ),
].join('\n');
const originalHash = 'sha256:' + createHash('sha256').update(original).digest('hex');
for (const kind of ['reference', 'independent']) {
  const root = path.join(directory, kind);
  const server = createServer(async (req, res) => {
    const file = new URL(req.url, 'http://localhost').pathname.slice(1);
    if (!['geo-source-save.html', 'geo-source-save.js'].includes(file)) {
      res.writeHead(204).end();
      return;
    }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/html');
    res.end(await readFile(path.join(root, 'dist', file)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const width of [1280, 390]) {
      const profile = await mkdtemp('/tmp/issue97-export-browser-'),
        errors = [];
      let context,
        page,
        downloadCount = 0;
      const launch = async () => {
        context = await chromium.launchPersistentContext(profile, {
          executablePath: '/usr/bin/chromium',
          viewport: { width, height: 900 },
        });
        page = context.pages()[0];
        page.on('pageerror', (error) => errors.push(String(error)));
        page.on('console', (message) => {
          if (message.type() === 'error') errors.push(message.text());
        });
        page.on('download', () => downloadCount++);
        await page.route('**/*', (route) => {
          if (new URL(route.request().url()).origin !== origin) {
            errors.push(route.request().url());
            return route.abort();
          }
          return route.continue();
        });
        await page.goto(origin + '/geo-source-save.html');
        await page.waitForFunction('globalThis.ready');
      };
      const button = (name) => page.getByRole('button', { name, exact: true });
      const state = () => page.evaluate('geoSourceHost.state()');
      const info = () => page.evaluate('geoSourceHost.retained()');
      const status = () => page.getByRole('status', { name: 'Geo export status' });
      const acknowledge = async () => {
        for (const box of await page
          .getByRole('region', { name: 'Export preview', exact: true })
          .getByRole('checkbox')
          .all())
          await box.check();
      };
      const prepare = async (layerId, format = 'csv') => {
        await button('Load saved geographic version').click();
        await expect(status()).toContainText('Saved version loaded');
        await page.getByLabel('Export layer', { exact: true }).selectOption(layerId);
        await page.getByLabel('Export format', { exact: true }).selectOption(format);
        for (const field of ['field-1', 'field-2'])
          await page.getByLabel(`Include attribute ${field}`, { exact: true }).check();
        await button('Preview data export').click();
        await expect(status()).toContainText('Preview ready');
        await acknowledge();
      };
      const download = async (name) => {
        const pending = page.waitForEvent('download');
        await page.getByRole('link', { name, exact: true }).click();
        const file = await pending;
        assert.equal(await file.failure(), null);
        return readFile(await file.path());
      };
      try {
        await launch();
        await page.getByLabel('Local file', { exact: true }).setInputFiles({
          name: 'sites.csv',
          mimeType: 'text/csv',
          buffer: Buffer.from(original),
        });
        for (const [label, value] of [
          ['ID column (optional)', 'ID'],
          ['First coordinate column', 'lon'],
          ['Second coordinate column', 'lat'],
        ])
          await page.getByLabel(label, { exact: true }).fill(value);
        for (const [index, name, type] of [
          [1, 'ID', 'string'],
          [2, 'value', 'number'],
        ]) {
          await button('Add field').click();
          await page.getByLabel(`Input column/property ${index}`, { exact: true }).fill(name);
          await page.getByLabel(`Type ${index}`, { exact: true }).selectOption(type);
        }
        await button('Preview import').click();
        await expect(page.getByRole('region', { name: 'Import geographic data' })).toContainText(
          'Read 200; valid 198; problem 2',
        );
        await page
          .getByRole('region', { name: 'Import geographic data' })
          .getByRole('checkbox')
          .check();
        await button('Import previewed data').click();
        await expect.poll(async () => (await state()).content.layers[0]?.features.length).toBe(198);
        await button('Save original + native').click();
        await expect.poll(async () => (await info()).versions).toBe(1);
        await expect.poll(async () => (await state()).retained).toBe(0);
        const firstId = (await info()).head,
          first = await page.evaluate((id) => globalThis.geoSourceHost.load(id), firstId);
        await page.getByLabel('Scalar field', { exact: true }).selectOption('field-2');
        await page.getByLabel('Scalar value', { exact: true }).fill('42');
        await page.getByLabel('Longitude', { exact: true }).fill('12.5');
        await button('Save original + native').click();
        await expect.poll(async () => (await info()).versions).toBe(2);
        await expect.poll(async () => (await state()).retained).toBe(0);
        const currentHead = (await info()).head,
          currentHash = (await state()).hash;
        await context.close();
        await launch(); // Real Chromium process restart, same profile and origin.
        await page.getByLabel('Scalar field', { exact: true }).selectOption('field-2');
        assert.equal((await state()).hash, currentHash);
        assert.equal((await state()).originals[0].hash, originalHash);
        await page.getByLabel('Retained version', { exact: true }).selectOption(firstId);
        const before = await state();
        await prepare(first.request.content.layers[0].id);
        await button('Export data and receipt').click();
        await expect(
          page.getByRole('link', { name: 'Download geographic data', exact: true }),
        ).toBeVisible();
        const csv = await download('Download geographic data'),
          receiptBytes = await download('Download provenance receipt');
        const receipt = JSON.parse(receiptBytes.toString());
        const parsed = JSON.parse(
          execFileSync(
            'python3',
            [
              '-c',
              'import csv,json,sys; rows=list(csv.reader(sys.stdin)); print(json.dumps([rows[0], [[json.loads(c) for c in r] for r in rows[1:]]]))',
            ],
            { input: csv, encoding: 'utf8' },
          ),
        );
        assert.deepEqual(parsed[0], ['_feature_id', '_row_id', 'field-1', 'field-2']);
        assert.equal(parsed[1].length, 198);
        assert.deepEqual(parsed[1][0], [
          first.request.content.layers[0].features[0].id,
          first.request.content.layers[0].features[0].rowId,
          '001',
          0,
        ]);
        assert.equal(receipt.input.versionId, firstId);
        assert.equal(receipt.input.contentHash, 'sha256:' + first.nativeVersion.contentHash);
        assert.equal(receipt.sources[0].bytesHash, originalHash);
        assert.equal(
          receipt.output.bytesHash,
          'sha256:' + createHash('sha256').update(csv).digest('hex'),
        );
        assert.equal((await state()).hash, before.hash);
        assert.equal((await state()).head, currentHead);
        assert.equal((await state()).writes, before.writes);

        // Changing the selection retires both URLs; new GeoJSON still uses the old fixed pin.
        await page.getByLabel('Export format', { exact: true }).selectOption('geojson');
        await expect(
          page.getByRole('link', { name: 'Download geographic data', exact: true }),
        ).toHaveCount(0);
        await button('Preview data export').click();
        await acknowledge();
        await button('Export data and receipt').click();
        const json = JSON.parse((await download('Download geographic data')).toString());
        assert.equal(json.features.length, 198);
        assert.equal(json.features[0].properties['field-2'], 0);
        assert.deepEqual(json.features[0].geometry.coordinates, [12, 34]);
        const scalar = page.getByLabel('Scalar value', { exact: true });
        await scalar.fill('invalid');
        await button('Load saved geographic version').click();
        await expect(status()).toContainText('Export refused');
        await expect(scalar).toHaveValue('invalid');
        assert.equal((await state()).hash, before.hash);
        await scalar.dispatchEvent('compositionstart', { data: '' });
        await button('Load saved geographic version').click();
        await expect(status()).toContainText('GeoPendingInputs');
        await scalar.dispatchEvent('compositionend', { data: 'invalid' });
        await scalar.fill('43');
        await prepare(first.request.content.layers[0].id);
        assert.equal((await state()).content.layers[0].features[0].values['field-2'], 43);
        assert.equal((await state()).revision.sequence, before.revision.sequence + 1);
        assert.equal((await state()).head, currentHead); // valid input was flushed, never silently saved

        // Saved-source corruption must refuse capture, while keeping live edits and originals.
        const artifactId = (await state()).view.snapshot.scope.artifactId;
        const raw = await page.evaluate(
          async ({ artifactId, firstId }) => {
            const db = await new Promise((resolve, reject) => {
              const r = indexedDB.open(artifactId + '-v1', 1);
              r.onsuccess = () => resolve(r.result);
              r.onerror = () => reject(r.error);
            });
            try {
              return await new Promise((resolve, reject) => {
                const tx = db.transaction('artifacts', 'readwrite'),
                  store = tx.objectStore('artifacts'),
                  request = store.get(artifactId);
                let previous;
                request.onsuccess = () => {
                  previous = request.result;
                  const bucket = JSON.parse(previous);
                  const entry = bucket.versions.find((v) => v.id === firstId);
                  const record = JSON.parse(entry.text);
                  record.closure[0].bytes = 'eA==';
                  entry.text = JSON.stringify(record);
                  store.put(JSON.stringify(bucket), artifactId);
                };
                tx.oncomplete = () => resolve(previous);
                tx.onabort = () => reject(tx.error);
              });
            } finally {
              db.close();
            }
          },
          { artifactId, firstId },
        );
        const dirtyHash = (await state()).hash;
        await button('Load saved geographic version').click();
        await expect(status()).toContainText('Export refused');
        await expect(
          page.getByRole('link', { name: 'Download geographic data', exact: true }),
        ).toHaveCount(0);
        assert.equal((await state()).hash, dirtyHash);
        await page.evaluate(
          async ({ artifactId, raw }) => {
            const db = await new Promise((resolve, reject) => {
              const r = indexedDB.open(artifactId + '-v1', 1);
              r.onsuccess = () => resolve(r.result);
              r.onerror = () => reject(r.error);
            });
            try {
              await new Promise((resolve, reject) => {
                const tx = db.transaction('artifacts', 'readwrite');
                tx.objectStore('artifacts').put(raw, artifactId);
                tx.oncomplete = resolve;
                tx.onabort = () => reject(tx.error);
              });
            } finally {
              db.close();
            }
          },
          { artifactId, raw },
        );
        await prepare(first.request.content.layers[0].id);
        await button('Export data and receipt').click();
        await expect(
          page.getByRole('link', { name: 'Download provenance receipt', exact: true }),
        ).toBeVisible();
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page.screenshot({
          path: path.join(root, `data-export-${width}.png`),
          fullPage: true,
        });

        // Revocation while output hashing is pending must not leave new download links.
        await button('Preview data export').click();
        await acknowledge();
        await page.evaluate(() => {
          const digest = crypto.subtle.digest.bind(crypto.subtle);
          globalThis.exportHashEntered = false;
          crypto.subtle.digest = async (...args) => {
            crypto.subtle.digest = digest;
            globalThis.exportHashEntered = true;
            await new Promise((resolve) => {
              globalThis.releaseExportHash = resolve;
            });
            const result = await digest(...args);
            globalThis.exportHashDone = true;
            return result;
          };
        });
        const completedDownloads = downloadCount;
        await button('Export data and receipt').click();
        await page.waitForFunction('globalThis.exportHashEntered');
        await page.evaluate(() => {
          globalThis.geoSourceHost.revoke();
          globalThis.releaseExportHash();
        });
        await page.waitForFunction('globalThis.exportHashDone');
        await expect(status()).toContainText('scope closed');
        await expect(
          page.getByRole('link', { name: 'Download geographic data', exact: true }),
        ).toHaveCount(0);
        assert.equal(downloadCount, completedDownloads);
        assert.deepEqual(errors, []);
        console.log(
          'PASS',
          kind,
          width,
          '200→198 import / two saved versions / actual process restart / old-version CSV+GeoJSON and real receipt downloads / no write / invalid+IME retention / source corruption+retry / late hash revoke',
        );
      } finally {
        await context?.close();
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
