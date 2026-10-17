// Normal production Host acceptance; raw evidence remains outside Git.
import { chromium, expect } from '@playwright/test';
import { URL } from 'node:url';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import assert from 'node:assert/strict';
const [out] = process.argv.slice(2);
assert(out && path.resolve(out).startsWith('/tmp/'));
const code = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), '');
await mkdir(out);
const server = createServer(async (req, res) => {
  try {
    const name = new URL(req.url, 'http://local').pathname;
    if (name === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    assert(!name.includes('..'));
    res.setHeader(
      'content-type',
      name.endsWith('.js')
        ? 'application/javascript'
        : name.endsWith('.css')
          ? 'text/css'
          : name.endsWith('.woff2')
            ? 'font/woff2'
            : 'text/html',
    );
    res.end(await readFile(path.join(process.cwd(), 'dist', name === '/' ? 'index.html' : name)));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
const origin = `http://127.0.0.1:${server.address().port}`;
const errors = [],
  cases = [];
let page, context, result, stage;
const click = (name) => page.getByRole('button', { name, exact: true }).click();
async function launch(name) {
  stage = name;
  context = await browser.newContext({ acceptDownloads: true });
  await context.tracing.start({ screenshots: true, snapshots: true });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.goto(origin);
}
async function finish() {
  await page.screenshot({ path: path.join(out, `${stage}.png`), fullPage: true });
  await context.tracing.stop({ path: path.join(out, `${stage}.zip`) });
  await context.close();
  context = undefined;
  cases.push(stage);
}
async function video() {
  await click('Video（複数素材・音声編集）');
  await expect(page.locator('#duration')).toBeVisible({ timeout: 30000 });
}
async function text(value) {
  await page.locator('.ProseMirror h1').evaluate((node) => {
    node.closest('.ProseMirror').focus();
    const range = globalThis.document.createRange();
    range.selectNodeContents(node);
    const selection = globalThis.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    globalThis.document.dispatchEvent(new globalThis.Event('selectionchange'));
  });
  await page.keyboard.insertText(value);
}
try {
  await launch('m2-publication-retry-and-cross-version-owner');
  await video();
  await page.locator('#duration').fill('1');
  await click('Return to Library');
  await expect(page.locator('#notice')).toContainText('duration');
  await expect(page.locator('#duration')).toHaveValue('1');
  await click('Resize sequence');
  await click('Return to Library');
  await expect(page.locator('#notice')).toContainText('Save the project');
  await page.evaluate(() => {
    const original = globalThis.Storage.prototype.setItem;
    globalThis.Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('ep-private-video-m2-locator@0:')) throw Error('Injected locator failure');
      return original.call(this, key, value);
    };
    globalThis.restorePublication = () => {
      globalThis.Storage.prototype.setItem = original;
    };
  });
  const download = page.waitForEvent('download');
  await click('Save portable project');
  await (await download).saveAs(path.join(out, 'committed-before-locator.zip'));
  await expect(page.locator('#notice')).toContainText('registration failed');
  const before = await page.evaluate(() => globalThis.editorPrivateVideoHandle.inspection());
  await click('Return to Library');
  await expect(page.locator('#notice')).toContainText('Retry Library registration');
  const peer = await context.newPage();
  await peer.goto(origin + '/?privateEditor=video-v1-review');
  await expect(peer.getByRole('alert')).toContainText('Another validation Video');
  await peer.close();
  await page.evaluate(() => globalThis.restorePublication());
  await click('Retry Library registration');
  await expect(page.locator('#notice')).toHaveText('Saved project is registered in Library.');
  const after = await page.evaluate(() => globalThis.editorPrivateVideoHandle.inspection());
  assert.deepEqual(after.native, before.native);
  assert.deepEqual(after.versions, before.versions);
  assert.equal(
    await page.evaluate(
      () =>
        Object.keys(globalThis.localStorage).filter((k) =>
          k.startsWith('ep-private-video-m2-locator@0:'),
        ).length,
    ),
    1,
  );
  await click('Return to Library');
  await click('New Video project (private)');
  await expect(page.locator('#duration')).toBeVisible();
  const other = await context.newPage();
  await other.goto(origin + '/?privateEditor=video-v2-review');
  await expect(other.getByRole('alert')).toContainText('Another validation Video');
  await other.close();
  await click('Return to Library');
  await click('Toggle library');
  await page.locator('[data-private-m2-project]').click();
  await expect(page.locator('#duration')).toHaveValue('1/1');
  await click('Return to Library');
  await finish();
  await launch('pending-save-and-locator-retain-m2-owner');
  await video();
  await page.evaluate(() => {
    void globalThis.navigator.locks.request('normal-video-m2-catalog@0', async () => {
      globalThis.catalogHeld = true;
      await new Promise((resolve) => {
        globalThis.releaseCatalog = resolve;
      });
    });
    const create = globalThis.FileSystemFileHandle.prototype.createWritable;
    globalThis.FileSystemFileHandle.prototype.createWritable = async function (...args) {
      globalThis.FileSystemFileHandle.prototype.createWritable = create;
      globalThis.writeHeld = true;
      await new Promise((resolve) => {
        globalThis.releaseWrite = resolve;
      });
      return create.apply(this, args);
    };
  });
  await page.waitForFunction(() => globalThis.catalogHeld);
  await click('Save portable project');
  await page.waitForFunction(() => globalThis.writeHeld);
  await click('Return to Library');
  await expect(page.locator('#notice')).toContainText('Workspace operation pending');
  assert.equal(new URL(page.url()).searchParams.get('privateEditor'), 'video-v2-review');
  await page.evaluate(() => globalThis.releaseWrite());
  await expect(page.locator('#status')).toHaveText('Save complete', { timeout: 30000 });
  await click('Return to Library');
  await expect(page.locator('#notice')).toContainText('Library registration is pending');
  await page.evaluate(() => globalThis.releaseCatalog());
  await expect(page.locator('#notice')).toHaveText('Saved project is registered in Library.');
  await click('Return to Library');
  await finish();
  await launch('unknown-save-retains-m2-owner');
  await video();
  await page.locator('#duration').fill('1');
  await click('Resize sequence');
  await page.evaluate(() => {
    const put = globalThis.IDBObjectStore.prototype.put;
    globalThis.IDBObjectStore.prototype.put = function (value, ...args) {
      if (this.name === 'journal' && value.operations?.some((o) => o.phase === 'committed')) {
        globalThis.IDBObjectStore.prototype.put = put;
        put.call(this, value, ...args);
        throw Error('Injected commit acknowledgement failure');
      }
      return put.call(this, value, ...args);
    };
  });
  await click('Save portable project');
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => globalThis.editorPrivateVideoHandle.inspection())).transition
          .unresolvedSave,
    )
    .toBe(true);
  const retained = await page.evaluate(() => globalThis.editorPrivateVideoHandle.inspection());
  await click('Return to Library');
  await expect(page.locator('#notice')).toContainText('Unresolved Save');
  assert.deepEqual(
    (await page.evaluate(() => globalThis.editorPrivateVideoHandle.inspection())).native,
    retained.native,
  );
  const locked = await context.newPage();
  await locked.goto(origin + '/?privateEditor=video-v1-review');
  await expect(locked.getByRole('alert')).toContainText('Another validation Video');
  await locked.close();
  await finish();
  await launch('committed-ack-loss-reconcile-and-drain');
  await video();
  await page.locator('#duration').fill('1');
  await click('Resize sequence');
  await page.evaluate(() => {
    const put = globalThis.IDBObjectStore.prototype.put;
    globalThis.IDBObjectStore.prototype.put = function (value, ...args) {
      const request = put.call(this, value, ...args);
      if (this.name === 'journal' && value.operations?.some((o) => o.phase === 'committed')) {
        globalThis.IDBObjectStore.prototype.put = put;
        const tx = this.transaction;
        globalThis.ackLostDatabase = tx.db.name;
        const rejectAcknowledgement = tx.onabort;
        // The actual transaction completes. Only the adapter's completion promise loses ACK.
        tx.oncomplete = (event) => rejectAcknowledgement.call(tx, event);
      }
      return request;
    };
  });
  await click('Save portable project');
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => globalThis.editorPrivateVideoHandle.inspection())).transition
          .unresolvedSave,
    )
    .toBe(true);
  const committedJournal = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = globalThis.indexedDB.open(globalThis.ackLostDatabase);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction('journal').objectStore('journal').get('root');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  });
  assert.equal(committedJournal.head, 1);
  assert.equal(committedJournal.operations.filter((o) => o.phase === 'committed').length, 1);
  await click('Return to Library');
  await expect(page.locator('#notice')).toContainText('Unresolved Save');
  const committedNative = (
    await page.evaluate(() => globalThis.editorPrivateVideoHandle.inspection())
  ).native;
  await click('Reconcile save');
  await expect(page.locator('#status')).toHaveText('Reconcile complete', { timeout: 30000 });
  await expect(page.locator('#notice')).toHaveText('Saved project is registered in Library.');
  const reconciled = await page.evaluate(() => globalThis.editorPrivateVideoHandle.inspection());
  assert.equal(reconciled.transition.unresolvedSave, false);
  assert.deepEqual(reconciled.native, committedNative);
  assert.equal(reconciled.versions.versions.length, 1);
  assert.equal(reconciled.capacity.reservations.length, 0);
  assert.deepEqual(reconciled.media, { building: 0, reads: 0, files: 0, bytes: 0 });
  await click('Return to Library');
  await click('New Video project (private)');
  await expect(page.locator('#duration')).toBeVisible();
  await click('Return to Library');
  await finish();
  for (const ime of [false, true]) {
    await launch(ime ? 'held-write-late-ime' : 'held-write-late-text');
    if (!(await page.getByLabel('Artifact type', { exact: true }).isVisible()))
      await click('Toggle library');
    await page.getByLabel('Artifact type', { exact: true }).selectOption('document');
    await page.getByRole('button', { name: 'New artifact' }).click();
    await expect(page.getByRole('status').first()).toHaveText('Saved locally');
    await page.evaluate(() => {
      const original = globalThis.IDBObjectStore.prototype.put;
      globalThis.IDBObjectStore.prototype.put = function (...args) {
        const request = original.apply(this, args);
        if (this.name === 'artifacts') {
          globalThis.IDBObjectStore.prototype.put = original;
          globalThis.writeHeld = true;
          globalThis.releaseWrite = false;
          const keepAlive = () => {
            if (!globalThis.releaseWrite)
              this.get('__navigation_test_hold__').onsuccess = keepAlive;
          };
          keepAlive();
        }
        return request;
      };
    });
    await text('Held canonical');
    await page.waitForFunction(() => globalThis.writeHeld);
    await click('Toggle library');
    await click('Video（複数素材・音声編集）');
    await click('Close library panel');
    const late = ime ? '変換中の日本語を保持' : 'Late text must survive';
    const editor = page.getByRole('textbox', { name: 'Document body', exact: true });
    if (ime) {
      await editor.dispatchEvent('compositionstart', { data: '保持' });
      await editor.locator('h1').evaluate((node, value) => {
        node.textContent = value;
        node.dispatchEvent(
          new globalThis.InputEvent('input', {
            bubbles: true,
            inputType: 'insertCompositionText',
            data: '保持',
            isComposing: true,
          }),
        );
      }, late);
    } else await text(late);
    await page.evaluate(() => {
      globalThis.releaseWrite = true;
    });
    await expect(page.getByRole('alert')).toContainText('Editor changed while waiting to switch');
    await expect(editor.locator('h1')).toHaveText(late);
    assert.equal(new URL(page.url()).searchParams.has('privateEditor'), false);
    if (ime) await editor.dispatchEvent('compositionend', { data: '保持' });
    await expect(page.getByRole('status').first()).toHaveText('Saved locally');
    await page.reload();
    await expect(page.locator('.ProseMirror h1')).toHaveText(late);
    await finish();
  }
  for (const corruptM2 of [true, false]) {
    await launch(corruptM2 ? 'corrupt-m2-preserves-v1' : 'corrupt-v1-preserves-m2');
    const label = corruptM2 ? 'New Video project (private)' : 'Video（複数素材・音声編集）';
    await click(label);
    await page.locator('#duration').fill('1');
    await click('Resize sequence');
    const d = page.waitForEvent('download');
    await click('Save portable project');
    await (await d).saveAs(path.join(out, `${stage}-saved.zip`));
    await expect(page.locator('#notice')).toHaveText('Saved project is registered in Library.');
    await click('Return to Library');
    const prefix = corruptM2 ? 'ep-private-video-m2-locator@0:' : 'ep-private-video-locator@0:';
    const id = '00000000-0000-4000-8000-000000000001';
    for (const bad of [
      '{invalid',
      JSON.stringify({
        id,
        namespace: (corruptM2 ? 'normal-video-m2-' : 'normal-video-') + id,
        name: 'bad',
        updatedAt: '2026-10-13',
        unknown: true,
      }),
    ]) {
      await page.evaluate(({ key, bad }) => globalThis.localStorage.setItem(key, bad), {
        key: prefix + id,
        bad,
      });
      await page.reload();
      await expect(page.getByRole('alert').first()).toContainText('Library unavailable');
      if (!(await page.getByLabel('Artifact type', { exact: true }).isVisible()))
        await click('Toggle library');
      await expect(
        page
          .getByRole('region', {
            name: corruptM2 ? 'Private Video projects' : 'Private Video M2 projects',
            exact: true,
          })
          .getByRole('button', { name: label, exact: true }),
      ).toBeVisible();
      await page
        .locator(corruptM2 ? '[data-private-project]' : '[data-private-m2-project]')
        .click();
      await expect(page.locator('#duration')).toHaveValue('1/1');
      await click('Return to Library');
    }
    await finish();
  }
  assert.deepEqual(errors, []);
  result = {
    state: 'PASS',
    code,
    cases,
    errors,
    limitations: ['Synthetic IME, not OS native IME', 'Performance held'],
  };
} catch (error) {
  result = { state: 'FAIL', code, stage, cases, error: String(error), stack: error.stack, errors };
  process.exitCode = 1;
  await page?.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  if (context)
    await context.tracing.stop({ path: path.join(out, `${stage}-failure.zip`) }).catch(() => {});
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2));
}
