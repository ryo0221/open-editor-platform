/* global document, InputEvent, CompositionEvent, fetch, crypto */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { URL } from 'node:url';
import { chromium, expect } from '@playwright/test';

const directory = path.resolve(process.argv[2]),
  failures = [];
for (const kind of ['reference', 'independent']) {
  const root = path.join(directory, kind);
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
  try {
    for (const width of [1280, 390]) {
      const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [],
        expectedRevoked = new Set();
      page.on('pageerror', (error) => errors.push(String(error)));
      page.on('console', (message) => {
        if (message.type() !== 'error') return;
        // These failures are the regression's expected result, not browser faults.
        if (
          expectedRevoked.has(message.location().url) &&
          /net::ERR_(FILE_NOT_FOUND|FAILED)/.test(message.text())
        )
          return;
        errors.push(message.text());
      });
      await page.route('**/*', (route) => {
        if (new URL(route.request().url()).origin !== origin) {
          errors.push(route.request().url());
          return route.abort();
        }
        return route.continue();
      });
      const button = (name) => page.getByRole('button', { name, exact: true });
      const state = () => page.evaluate('geoSourceHost.state()');
      const urls = () =>
        page
          .getByRole('link')
          .evaluateAll((links) => links.filter((link) => link.download).map((link) => link.href));
      const readable = (values) =>
        page.evaluate(
          async (values) =>
            Promise.all(
              values.map(async (url) => {
                try {
                  const response = await fetch(url);
                  await response.text();
                  return response.ok;
                } catch {
                  return false;
                }
              }),
            ),
          values,
        );
      const output = async () => {
        await button('Load saved geographic version').click();
        await expect(page.getByRole('status', { name: 'Geo export status' })).toContainText(
          'Saved version loaded',
        );
        await page
          .getByLabel('Export layer', { exact: true })
          .selectOption((await state()).content.layers[0].id);
        await page.getByLabel('Include attribute field-1', { exact: true }).check();
        await button('Preview data export').click();
        for (const checkbox of await page
          .getByRole('region', { name: 'Export preview', exact: true })
          .getByRole('checkbox')
          .all())
          await checkbox.check();
        await button('Export data and receipt').click();
        await expect(
          page.getByRole('link', { name: 'Download geographic data', exact: true }),
        ).toBeVisible();
        const values = await urls();
        assert.equal(values.length, 2);
        assert.deepEqual(await readable(values), [true, true]);
        return values;
      };
      try {
        await page.goto(origin + '/geo-source-save.html');
        await page.waitForFunction('globalThis.ready');
        await page.getByLabel('Local file', { exact: true }).setInputFiles({
          name: 'point.csv',
          mimeType: 'text/csv',
          buffer: Buffer.from('lon,lat,value\n12,34,10'),
        });
        await page.getByLabel('First coordinate column', { exact: true }).fill('lon');
        await page.getByLabel('Second coordinate column', { exact: true }).fill('lat');
        await button('Add field').click();
        await page.getByLabel('Input column/property 1', { exact: true }).fill('value');
        await page.getByLabel('Type 1', { exact: true }).selectOption('number');
        await button('Preview import').click();
        await button('Import previewed data').click();
        await expect.poll(async () => (await state()).content.layers[0]?.features.length).toBe(1);
        await button('Save original + native').click();
        await expect
          .poll(async () => (await page.evaluate('geoSourceHost.retained()')).versions)
          .toBe(1);
        await expect.poll(async () => (await state()).retained).toBe(0);
        const firstVersion = (await page.evaluate('geoSourceHost.retained()')).head;
        for (const mode of ['dirty', 'composing']) {
          // Replacement installs a new input subscription and releases the old one.
          if (mode === 'composing') await page.evaluate('geoSourceHost.reopen()');
          const values = await output(),
            before = await state();
          for (const value of values) expectedRevoked.add(value);
          const result = await page.getByLabel('Scalar value', { exact: true }).evaluate(
            async (input, { mode, values }) => {
              if (mode === 'dirty') {
                input.value = 'invalid';
                input.dispatchEvent(
                  new InputEvent('input', {
                    bubbles: true,
                    inputType: 'insertText',
                    data: 'invalid',
                  }),
                );
              } else
                input.dispatchEvent(
                  new CompositionEvent('compositionstart', { bubbles: true, data: '' }),
                );
              // Inspect in the same event turn: no click/onClick, polling or native Apply.
              const links = document.querySelectorAll('a[download]').length;
              const accessible = await Promise.all(
                values.map(async (url) => {
                  try {
                    const response = await fetch(url);
                    await response.text();
                    return response.ok;
                  } catch {
                    return false;
                  }
                }),
              );
              return { links, accessible };
            },
            { mode, values },
          );
          const after = await state();
          assert.equal(after.hash, before.hash);
          assert.deepEqual(after.revision, before.revision);
          assert.equal(after.canUndo, before.canUndo);
          assert.equal(after.canRedo, before.canRedo);
          assert.equal(
            mode === 'dirty' ? after.inputs.dirty > 0 : after.inputs.composing > 0,
            true,
          );
          if (mode === 'dirty')
            await expect(page.getByLabel('Scalar value', { exact: true })).toHaveValue('invalid');
          try {
            assert.equal(
              result.links,
              0,
              'pending Point inputs must immediately remove both links',
            );
            assert.deepEqual(
              result.accessible,
              [false, false],
              'copied blob URLs must be revoked without onclick',
            );
            await page
              .getByRole('region', { name: 'Saved geographic data output', exact: true })
              .screenshot({ path: path.join(root, `export-inputs-${width}-${mode}.png`) });
            console.log(
              'PASS',
              kind,
              width,
              mode,
              'links removed and copied data/receipt blob URLs unreadable; native/history unchanged',
            );
          } catch (error) {
            failures.push(
              `${kind}/${width}/${mode}: ${error.message}; observed ${JSON.stringify(result)}`,
            );
          }
          if (mode === 'composing')
            await page
              .getByLabel('Scalar value', { exact: true })
              .dispatchEvent('compositionend', { data: '' });
          await button('Cancel').click();
        }
        // Keep a distinct latest version so both Reopen actions exercise their own target.
        await page.getByLabel('Scalar value', { exact: true }).fill('20');
        await button('Save original + native').click();
        await expect
          .poll(async () => (await page.evaluate('geoSourceHost.retained()')).versions)
          .toBe(2);
        await expect.poll(async () => (await state()).retained).toBe(0);
        const retained = await page.evaluate('geoSourceHost.retained()');
        for (const action of ['reopen', 'reopen-version']) {
          for (const outcome of ['success', 'failure']) {
            await page.getByLabel('Retained version', { exact: true }).selectOption(firstVersion);
            const values = await output(),
              before = await state();
            for (const value of values) expectedRevoked.add(value);
            const immediate = await page.evaluate(
              ({ action, outcome }) => {
                // Hold the real storage.read at its first integrity digest. No Host bypass/hook.
                const digest = crypto.subtle.digest.bind(crypto.subtle);
                globalThis.reopenReadStarted = false;
                crypto.subtle.digest = async (...args) => {
                  crypto.subtle.digest = digest;
                  globalThis.reopenReadStarted = true;
                  await new Promise((resolve) => {
                    globalThis.releaseReopenRead = resolve;
                  });
                  if (outcome === 'failure') throw Error('GeoReopenReadInjected');
                  return digest(...args);
                };
                document.getElementById(action).click();
                return {
                  links: document.querySelectorAll('a[download]').length,
                  busy: ['reopen', 'reopen-version'].every(
                    (id) => document.getElementById(id).disabled,
                  ),
                };
              },
              { action, outcome },
            );
            await page.waitForFunction('globalThis.reopenReadStarted');
            try {
              assert.equal(immediate.busy, true);
              const during = await state(),
                accessible = await readable(values);
              assert.equal(during.hash, before.hash);
              assert.deepEqual(during.revision, before.revision);
              assert.deepEqual(during.inputs, before.inputs);
              assert.equal(during.canUndo, before.canUndo);
              assert.equal(during.canRedo, before.canRedo);
              try {
                assert.equal(immediate.links, 0, 'Reopen must remove both links before awaiting');
                assert.deepEqual(accessible, [false, false], 'Reopen must revoke copied URLs');
                await page
                  .getByRole('region', { name: 'Saved geographic data output', exact: true })
                  .screenshot({
                    path: path.join(root, `export-reopen-${width}-${action}-${outcome}.png`),
                  });
                console.log(
                  'PASS',
                  kind,
                  width,
                  action,
                  outcome,
                  'copied URLs revoked while reading',
                );
              } catch (error) {
                failures.push(
                  `${kind}/${width}/${action}/${outcome}: ${error.message}; observed ${JSON.stringify({ immediate, accessible })}`,
                );
              }
            } finally {
              await page.evaluate('globalThis.releaseReopenRead()');
            }
            await expect(button('Reopen latest')).toBeEnabled();
            const after = await state();
            if (outcome === 'success') {
              await expect(page.getByRole('status', { name: 'Source save status' })).toContainText(
                'Reopened acknowledged native and complete originals',
              );
              assert.equal(
                after.content.layers[0].features[0].values['field-1'],
                action === 'reopen' ? 20 : 10,
              );
            } else {
              await expect(page.getByRole('status', { name: 'Source save status' })).toContainText(
                'GeoReopenReadInjected',
              );
              assert.equal(after.hash, before.hash);
              assert.deepEqual(after.revision, before.revision);
              assert.equal(after.canUndo, before.canUndo);
              assert.equal(after.canRedo, before.canRedo);
            }
            assert.deepEqual(after.originals, before.originals);
            assert.equal(after.writes, before.writes);
            assert.deepEqual(await page.evaluate('geoSourceHost.retained()'), retained);
            try {
              assert.deepEqual(await urls(), [], 'completed Reopen must not restore old links');
              assert.deepEqual(await readable(values), [false, false]);
            } catch (error) {
              failures.push(`${kind}/${width}/${action}/${outcome}/settled: ${error.message}`);
            }
          }
        }
        // A clean new output remains usable until its own scope closes.
        const values = await output();
        for (const value of values) expectedRevoked.add(value);
        await page.evaluate('geoSourceHost.revoke()');
        assert.deepEqual(await readable(values), [false, false]);
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
assert.deepEqual(failures, [], 'all pending-input/Reopen cases must revoke the actual blob URLs');
