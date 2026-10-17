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
const context = await browser.newContext({ acceptDownloads: true });
await context.tracing.start({ screenshots: true, snapshots: true });
const errors = [];
let result;
const pages = [];
try {
  for (let i = 0; i < 2; i++) {
    const page = await context.newPage();
    pages.push(page);
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto(origin);
    await page.getByRole('button', { name: 'New Video project (private)', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Video — exact timeline', exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await expect(page.locator('#open')).toBeHidden();
    assert.equal(
      await page.evaluate(
        () =>
          globalThis.getComputedStyle(globalThis.document.querySelector('#root > div')).overflowY,
      ),
      'auto',
    );
  }
  const [a, b] = pages;
  await b.evaluate(() => {
    globalThis.catalogHeld = false;
    void globalThis.navigator.locks.request('normal-video-catalog@0', async () => {
      globalThis.catalogHeld = true;
      await new Promise((resolve) => {
        globalThis.releaseCatalog = resolve;
      });
    });
  });
  await b.waitForFunction(() => globalThis.catalogHeld);
  await a.evaluate(() => {
    const original = globalThis.FileSystemFileHandle.prototype.createWritable;
    globalThis.FileSystemFileHandle.prototype.createWritable = async function (...args) {
      globalThis.FileSystemFileHandle.prototype.createWritable = original;
      globalThis.writeHeld = true;
      await new Promise((resolve) => {
        globalThis.releaseWrite = resolve;
      });
      return original.apply(this, args);
    };
  });
  await a.getByRole('button', { name: 'Save portable project', exact: true }).click();
  await a.waitForFunction(() => globalThis.writeHeld);
  await a.getByRole('button', { name: 'Return to Library', exact: true }).click();
  await expect(a.locator('#notice')).toHaveText('Error: Save is pending');
  assert.equal(new URL(a.url()).searchParams.get('privateEditor'), 'video-v1-review');
  await a.evaluate(() => globalThis.releaseWrite());
  await expect(a.locator('#status')).toHaveText('Save complete', { timeout: 30000 });
  await a.getByRole('button', { name: 'Return to Library', exact: true }).click();
  await expect(a.locator('#notice')).toHaveText('Error: Library registration is pending');
  await expect(a.getByRole('button', { name: 'Save portable project', exact: true })).toBeEnabled();
  await b.getByRole('button', { name: 'Save portable project', exact: true }).click();
  await expect(b.locator('#status')).toHaveText('Save complete', { timeout: 30000 });
  assert.equal(
    await a.evaluate(() => globalThis.localStorage.getItem('ep-private-video-locators@0')),
    null,
  );
  await b.evaluate(() => globalThis.releaseCatalog());
  for (const page of pages)
    await expect(page.locator('#notice')).toHaveText('Saved project is registered in Library.');
  const catalog = await a.evaluate(() =>
    Object.keys(globalThis.localStorage)
      .filter((key) => key.startsWith('ep-private-video-locator@0:'))
      .map((key) => JSON.parse(globalThis.localStorage.getItem(key))),
  );
  assert.equal(catalog.length, 2);
  assert.equal(new Set(catalog.map((x) => x.id)).size, 2);
  for (const page of pages) {
    await page.getByRole('button', { name: 'Return to Library', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'New Video project (private)', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
    await expect(page.locator('[data-private-project]')).toHaveCount(2);
  }
  assert.deepEqual(errors, []);
  result = {
    state: 'PASS',
    code,
    catalog,
    errors,
    cases: [
      'in-flight same-hash Save retains live owner',
      'committed but catalog-pending refuses navigation',
      'two project publishers retain both locators',
    ],
  };
} catch (error) {
  result = { state: 'FAIL', code, error: String(error), stack: error.stack, errors };
  process.exitCode = 1;
  for (let i = 0; i < pages.length; i++)
    await pages[i].screenshot({ path: path.join(out, `failure-${i}.png`) }).catch(() => {});
} finally {
  await context.tracing.stop({ path: path.join(out, 'trace.zip') });
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2));
}
