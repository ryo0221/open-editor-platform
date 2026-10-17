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
const outerOpen = () =>
  page.getByText('Open portable Video project', { exact: false }).locator('input');
const native = async () => JSON.parse(await page.locator('#native').textContent());
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
  await click('New Video project (private)');
  await expect(page.locator('#duration')).toBeVisible({ timeout: 30000 });
}
async function resize(value) {
  await page.locator('#duration').fill(String(value));
  await click('Resize sequence');
  await expect
    .poll(async () => (await native()).sequence.duration)
    .toEqual({ value, timescale: 1 });
}
async function save(name) {
  const pending = page.waitForEvent('download');
  await click('Save portable project');
  await (await pending).saveAs(path.join(out, name));
  await expect(page.locator('#notice')).toHaveText('Saved project is registered in Library.', {
    timeout: 30000,
  });
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
  await launch('initial-restore-and-late-replacement');
  await video();
  await resize(1);
  await save('seed.zip');
  await click('Return to Library');
  await click('Toggle library');
  await context.addInitScript(() => {
    const original = globalThis.FileSystemDirectoryHandle.prototype.getDirectoryHandle;
    globalThis.FileSystemDirectoryHandle.prototype.getDirectoryHandle = async function (
      name,
      options,
    ) {
      if (name.startsWith('normal-video-') && options?.create === false) {
        globalThis.FileSystemDirectoryHandle.prototype.getDirectoryHandle = original;
        globalThis.restoreHeld = true;
        await new Promise((resolve) => {
          globalThis.releaseRestore = resolve;
        });
      }
      return original.call(this, name, options);
    };
  });
  await page.locator('[data-private-project]').click();
  await page.waitForFunction(() => globalThis.restoreHeld);
  await expect(page.getByRole('button', { name: 'New Video project', exact: true })).toBeDisabled();
  await expect(outerOpen()).toBeDisabled();
  // Synthetic events also exercise admission while the initial owner is unresolved.
  await page.getByRole('button', { name: 'New Video project', exact: true }).dispatchEvent('click');
  await outerOpen().setInputFiles(path.join(out, 'seed.zip'));
  await expect(page.locator('#duration')).toHaveCount(0);
  await page.evaluate(() => globalThis.releaseRestore());
  await expect
    .poll(async () => (await native()).sequence.duration)
    .toEqual({ value: 1, timescale: 1 });
  await click('New Video project');
  await expect(page.getByRole('button', { name: 'New Video project', exact: true })).toBeEnabled();
  await expect
    .poll(async () => (await native()).sequence.duration)
    .toEqual({ value: 0, timescale: 1 });
  await resize(2);
  await save('active.zip');
  await page.evaluate(() => {
    const original = globalThis.Blob.prototype.arrayBuffer;
    globalThis.Blob.prototype.arrayBuffer = async function (...args) {
      globalThis.Blob.prototype.arrayBuffer = original;
      globalThis.openHeld = true;
      await new Promise((resolve) => {
        globalThis.releaseOpen = resolve;
      });
      return original.apply(this, args);
    };
  });
  await outerOpen().setInputFiles(path.join(out, 'seed.zip'));
  await page.waitForFunction(() => globalThis.openHeld);
  // Real UI is inert. A synthetic/headless event must still not let late candidate win.
  await page.locator('#duration').evaluate((node) => {
    node.value = '3';
    node.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
  });
  await page.getByRole('button', { name: 'Resize sequence', exact: true }).dispatchEvent('click');
  await expect
    .poll(async () => (await native()).sequence.duration)
    .toEqual({ value: 3, timescale: 1 });
  await page.locator('#duration').evaluate((node) => {
    node.value = '4';
    node.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
  });
  await page.evaluate(() => globalThis.releaseOpen());
  await expect(page.locator('#notice')).toContainText('Project changed while opening');
  assert.deepEqual((await native()).sequence.duration, { value: 3, timescale: 1 });
  await expect(page.locator('#duration')).toHaveValue('4');
  assert.equal(
    await page.locator('#duration').evaluate((node) => !!node.closest('[inert]')),
    false,
  );
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
    await click('New Video project (private)');
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
