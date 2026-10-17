/* global document, window */
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { URL } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
const directory = path.resolve(process.argv[2]),
  reports = [],
  hashes = [];
for (const kind of ['reference', 'independent']) {
  const root = path.join(directory, kind),
    pin = JSON.parse(await readFile(path.join(root, 'editor-pin.json'))).packages[
      '@editor-platform/video-metadata'
    ];
  hashes.push(pin);
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file =
      pathname === '/'
        ? 'video-edit.html'
        : pathname === '/video-edit.js'
          ? 'video-edit.js'
          : undefined;
    if (!file) {
      res.writeHead(204).end();
      return;
    }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/html');
    res.end(await readFile(path.join(root, 'dist', file)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 844 } }),
        errors = [],
        external = [];
      const origin = `http://127.0.0.1:${server.address().port}`;
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      await page.route('**/*', (route) => {
        if (new URL(route.request().url()).origin !== origin) {
          external.push(route.request().url());
          return route.abort();
        }
        return route.continue();
      });
      await page.goto(origin);
      await page.waitForFunction('globalThis.ready');
      const state = () => page.evaluate('host.state()');
      const button = (name) => page.getByRole('button', { name, exact: true });
      const input = (name) => page.getByLabel(name, { exact: true });
      const clickReopen = async () => {
        const previousSession = (await state()).revision.sessionId;
        await expect(button('Reopen saved')).toBeEnabled();
        await button('Reopen saved').click();
        await expect.poll(async () => {
          const current = await state();
          return current.revision.sessionId !== previousSession && current.view.state === 'open';
        }).toBe(true);
        assert.equal((await state()).view.state, 'open');
      };
      const status = page.getByRole('status', { name: 'Host persistence status' });
      assert.equal(await page.locator('code').textContent(), pin);
      const manifest = await page.evaluate('host.manifest()');
      assert.equal(manifest.contractVersion, '1.0.0-experiment.schema-edit.1');
      assert.deepEqual(manifest.schemaIdentity, {
        kind: 'literal',
        value: 'video-core-prototype-v0',
      });
      assert.equal(manifest.schemaVersion, undefined);
      assert.equal(manifest.addons.resources, undefined);
      const initial = await state();
      await button('Move +1 frame').click();
      assert.deepEqual(
        (await state()).content.sequence.clips.map((c) => c.start),
        [
          { value: 26, timescale: 25 },
          { value: 26, timescale: 25 },
        ],
      );
      await button('Undo').click();
      await button('Redo').click();
      await button('Undo').click();
      assert.deepEqual((await state()).content, initial.content);
      await button('Split linked clips').click();
      const split = await state();
      assert.deepEqual(
        split.content.sequence.clips.map((c) => c.id),
        ['v', 'a', 'clip-1', 'clip-2'],
      );
      assert.equal(split.content.sequence.clips[3].sampleIn, 144000);
      assert.equal(split.content.sequence.clips[3].linkGroupId, 'link-1');
      assert.deepEqual(split.content.sources, initial.content.sources);
      await button('Delete linked clips').click();
      assert.deepEqual(
        (await state()).content.sequence.clips.map((c) => c.id),
        ['clip-1', 'clip-2'],
      );
      await button('Undo').click();
      await button('Undo').click();
      assert.deepEqual((await state()).content, initial.content);
      assert.equal((await page.evaluate('host.move(1)')).state, 'applied');
      await button('Undo').click();
      const beforeSave = await state();
      await button('Save native JSON').click();
      await expect(status).toHaveText('Saved current capture');
      assert.deepEqual((await state()).revision, beforeSave.revision);
      assert.equal((await state()).canRedo, true);
      // Reordered acknowledged native data preserves insertion order through no-op Undo/Redo.
      const reordered = await page.evaluate(async () => {
        const record = JSON.parse(await globalThis.host.raw());
        const reverse = (v) =>
          Array.isArray(v)
            ? v.map(reverse)
            : v && typeof v === 'object'
              ? Object.fromEntries(
                  Object.keys(v)
                    .reverse()
                    .map((k) => [k, reverse(v[k])]),
                )
              : v;
        record.request.content = reverse(record.request.content);
        await globalThis.host.reopenText(JSON.stringify(record));
        return record.request.content;
      });
      assert.equal(JSON.stringify((await state()).content), JSON.stringify(reordered));
      await button('Move +1 frame').click();
      await button('Undo').click();
      const undone = await state();
      assert.equal(undone.revision.sequence, 2);
      assert.equal((await page.evaluate('host.move(0)')).state, 'unchanged');
      await input('Trim start (rational seconds)').fill('1/1');
      await button('Apply independent trim').click();
      const noop = await state();
      assert.deepEqual(noop.revision, undone.revision);
      assert.equal(noop.canRedo, true);
      assert.equal(JSON.stringify(noop.content), JSON.stringify(undone.content));
      await button('Redo').click();
      assert.deepEqual((await state()).content.sequence.clips[0].start, {
        value: 26,
        timescale: 25,
      });
      await button('Undo').click();
      await input('Selected clip').selectOption('a');
      await input('Trim start (rational seconds)').fill('26/25');
      await button('Save native JSON').click();
      await expect(status).toHaveText('Saved current capture');
      const saved = await state(),
        raw = await page.evaluate('host.raw()'),
        record = JSON.parse(raw);
      assert.equal(saved.content.sequence.clips[1].sampleIn, 97920);
      assert.deepEqual(saved.content.sequence.clips[0], initial.content.sequence.clips[0]);
      assert.deepEqual(saved.content.sources, initial.content.sources);
      assert.deepEqual(record.request.content, saved.content);
      assert.equal(record.request.capture.contentHash, saved.hash);
      assert.deepEqual(record.request.capture, saved.view.lastSave.capture);
      assert.equal(record.receiptId, saved.view.lastSave.receipt.adapterReceiptId);
      await page.screenshot({
        path: path.join(root, `video-edit-saved-${width}.png`),
        fullPage: true,
      });
      // New -> old and old -> new front doors share the same actual owner/key exclusion.
      await page.evaluate("host.mode('delayed')");
      const writes = saved.writes;
      await page.evaluate(() => {
        globalThis.pendingSave = globalThis.host.save();
      });
      await expect.poll(async () => (await state()).writes).toBeGreaterThan(writes);
      assert.match(
        await page.evaluate(() =>
          globalThis.host.counterSave().then(
            () => 'unexpected',
            (e) => String(e),
          ),
        ),
        /SaveBusy/,
      );
      await page.evaluate('host.release()');
      assert.equal((await page.evaluate('pendingSave')).outcome.state, 'committed');
      await page.evaluate(() => {
        globalThis.counterSave = globalThis.host.counterSave();
      });
      await expect.poll(async () => (await state()).observations.some((j) => !j.outcome)).toBe(true);
      const blocked = await page.evaluate('host.save()');
      assert.equal(blocked.state, 'refused');
      assert.match(blocked.message, /SaveBusy/);
      await page.evaluate('host.releaseCounter()');
      assert.equal((await page.evaluate('counterSave')).state, 'aborted-before-write');
      await page.evaluate("host.mode('normal')");
      assert.equal((await page.evaluate('host.save()')).outcome.state, 'committed');
      const stableRaw = await page.evaluate('host.raw()');
      await input('Trim start (rational seconds)').fill('4');
      await input('Trim end (rational seconds)').fill('2');
      const invalidBefore = await state();
      assert.equal((await page.evaluate('host.save()')).state, 'refused');
      await expect(input('Trim start (rational seconds)')).toHaveValue('4');
      await button('Reopen saved').click();
      await expect(status).toContainText('VideoPendingInputs');
      assert.deepEqual((await state()).content, invalidBefore.content);
      assert.equal(await page.evaluate('host.raw()'), stableRaw);
      await button('Cancel inputs').click();
      await input('Trim start (rational seconds)').dispatchEvent('compositionstart', { data: '' });
      assert.equal((await page.evaluate('host.save()')).state, 'refused');
      assert.equal((await state()).inputs.composing, 1);
      await input('Trim start (rational seconds)').dispatchEvent('compositionend', { data: '' });
      await button('Cancel inputs').click();
      await input('Trim start (rational seconds)').fill('27/25');
      await page.evaluate('host.stale()');
      const stale = await state();
      assert.equal((await page.evaluate('host.save()')).state, 'refused');
      assert.deepEqual((await state()).content, stale.content);
      await expect(input('Trim start (rational seconds)')).toHaveValue('27/25');
      await button('Cancel inputs').click();
      await page.evaluate('host.reopen()');
      assert.deepEqual((await state()).content, saved.content);
      assert.equal((await state()).revision.sequence, 0);
      assert.equal((await state()).canUndo, false);
      assert.equal((await state()).canRedo, false);
      const beforeFault = await state();
      for (const fault of ['hash', 'receipt', 'schema', 'capacity']) {
        const message = await page.evaluate(async (fault) => {
          const record = JSON.parse(await globalThis.host.raw());
          if (fault === 'hash') record.request.capture.contentHash = 'f'.repeat(64);
          if (fault === 'receipt') record.receiptId = 'bad';
          if (fault === 'schema') record.request.content.schema = 'other';
          if (fault === 'capacity') record.request.content.extra = 'x'.repeat(65536);
          try {
            await globalThis.host.reopenText(JSON.stringify(record));
            return 'unexpected';
          } catch (e) {
            return String(e);
          }
        }, fault);
        assert.match(
          message,
          fault === 'hash'
            ? /CaptureHashMismatch/
            : fault === 'receipt'
              ? /VideoStoredReceipt/
              : fault === 'schema'
                ? /VideoNative/
                : /VideoStoredRecordLimit/,
        );
        assert.deepEqual((await state()).content, beforeFault.content);
        assert.deepEqual((await state()).revision, beforeFault.revision);
        assert.equal(await page.evaluate('host.raw()'), stableRaw);
      }
      await page.reload();
      await page.waitForFunction('globalThis.ready');
      assert.deepEqual((await state()).content, saved.content);
      assert.equal((await state()).canUndo, false);
      await page.evaluate('host.authorizeEditable(true)');
      const locked = await state();
      for (const name of ['Move +1 frame', 'Split linked clips', 'Delete linked clips']) {
        await button(name).click();
        assert.deepEqual((await state()).content, locked.content);
        assert.deepEqual((await state()).revision, locked.revision);
      }
      await page.evaluate('host.authorizeEditable()');
      await page.evaluate("host.mode('no-write')");
      await input('Trim start (rational seconds)').fill('26/25');
      assert.equal((await page.evaluate('host.save()')).outcome.state, 'aborted-before-write');
      assert.equal((await state()).revision.sequence, 1);
      assert.equal((await state()).inputs.dirty, 0);
      await button('Undo').click();
      assert.deepEqual((await state()).content, initial.content);
      await page.evaluate("host.mode('normal')");
      assert.equal((await page.evaluate('host.save()')).outcome.state, 'committed');
      await page.evaluate("host.mode('delayed')");
      const oldWrites = (await state()).writes;
      await page.evaluate(() => {
        globalThis.pendingSave = globalThis.host.save();
      });
      await expect.poll(async () => (await state()).writes).toBeGreaterThan(oldWrites);
      assert.equal((await page.evaluate('host.move(1)')).state, 'applied');
      const newer = await state();
      await page.evaluate('host.release()');
      assert.equal((await page.evaluate('pendingSave')).outcome.state, 'committed');
      await expect(status).toHaveText('Older capture saved; current metadata unsaved');
      assert.notDeepEqual((await state()).saved?.revision, newer.revision);
      await page.evaluate("host.mode('uncertain')");
      assert.equal((await page.evaluate('host.save()')).outcome.state, 'indeterminate');
      await expect(button('Reopen saved')).toBeDisabled();
      assert.match(
        await page.evaluate(() =>
          globalThis.host.reopen().then(
            () => 'unexpected',
            (e) => String(e),
          ),
        ),
        /VideoSavePending/,
      );
      assert.equal((await page.evaluate('host.save()')).state, 'refused');
      assert.equal((await page.evaluate('host.revoke()')).state, 'incomplete');
      await page.evaluate('host.reconcile()');
      await clickReopen();
      await expect(button('Move +1 frame')).toBeDisabled();
      const readonly = await state();
      await expect(button('Move +1 frame')).toBeDisabled();
      await expect(button('Save native JSON')).toBeDisabled();
      assert.equal((await page.evaluate('host.move(1)')).state, 'refused');
      assert.deepEqual((await state()).revision, readonly.revision);
      assert.deepEqual((await state()).content, readonly.content);
      assert.equal(readonly.policy, 'readonly');
      assert.equal(readonly.canUndo, false);
      // Deadline is a correctness check after actual write, never performance measurement.
      await page.evaluate('host.authorizeEditable()');
      await page.evaluate("host.mode('delayed')");
      const deadlineWrites = (await state()).writes;
      await page.evaluate(() => {
        globalThis.pendingSave = globalThis.host.save();
      });
      await expect.poll(async () => (await state()).writes).toBeGreaterThan(deadlineWrites);
      if (kind === 'reference') await page.evaluate('host.expireSave()');
      const deadline = await page.evaluate('pendingSave');
      assert.equal(deadline.outcome.state, 'indeterminate');
      assert.equal(deadline.outcome.reason, 'deadline');
      assert.equal((await page.evaluate('host.revoke()')).state, 'incomplete');
      await expect(button('Reopen saved')).toBeDisabled();
      await page.evaluate('host.release()');
      await expect.poll(async () => (await state()).observations.at(-1).outcome?.state).toBe('committed');
      assert.equal((await page.evaluate('pendingSave')).outcome.state, 'indeterminate');
      assert.notDeepEqual((await state()).saved, deadline.outcome.capture);
      await clickReopen();
      await expect(button('Move +1 frame')).toBeDisabled();
      for (const mode of ['readonly', 'no-inputs', 'no-save', 'no-storage']) {
        await page.evaluate((mode) => globalThis.host.open(mode), mode);
        if (mode === 'readonly' || mode === 'no-inputs') {
          await expect(button('Move +1 frame')).toBeDisabled();
          assert.equal((await page.evaluate('host.move(1)')).state, 'refused');
        } else {
          await expect(button('Save native JSON')).toBeDisabled();
          assert.equal((await page.evaluate('host.save()')).state, 'refused');
        }
      }
      assert.deepEqual((await state()).errors, []);
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      );
      assert.equal((await page.evaluate('host.close()')).state, 'drained');
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      reports.push({ kind, width, sha256: pin, result: 'PASS' });
      console.log(
        'PASS',
        kind,
        width,
        'installed Video edit/native Save/history/noop/shared exclusion/reopen/revoke/budgets',
      );
      await page.close();
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
assert.equal(hashes[0], hashes[1]);
await writeFile(path.join(directory, 'video-edit-results.json'), JSON.stringify(reports, null, 2));
