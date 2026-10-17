/* global document, window */
// Repository tools build/check an already installed independent Host; no repo runtime imports.
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
const host = path.resolve(process.argv[2]);
const evidence = JSON.parse(await readFile(path.join(host, 'provenance.json')));
const pkg = evidence.packages.find((value) => value.name === '@editor-platform/extension-sample');
await mkdir(path.join(host, 'dist'));
const result = await build({
  absWorkingDir: host,
  entryPoints: ['browser.ts'],
  outdir: path.join(host, 'dist'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  metafile: true,
  define: {
    PACKAGED_SAMPLE_HASH: JSON.stringify(pkg.sha256),
    PACKAGING_NOTICE: JSON.stringify(evidence.notice),
  },
});
for (const input of Object.keys(result.metafile.inputs))
  assert.ok(
    input === 'browser.ts' || input.startsWith('node_modules/@editor-platform/'),
    'No repository/browser source fallback',
  );
await writeFile(path.join(host, 'browser-imports.json'), JSON.stringify(result.metafile, null, 2));
await writeFile(
  path.join(host, 'dist/index.html'),
  `<!doctype html><html lang="en"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Independent packaged Extension Host</title><link rel="icon" href="data:,"><style>body{font:16px system-ui;max-width:760px;margin:24px auto;padding:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere}button,input{margin:8px;max-width:90%}svg{max-width:100%}</style><h1>Independent packaged Extension Host</h1><p>Fixed-source, trusted read-only sample. Local packaging proof only.</p><p id="status" role="status">Loading</p><div id="surface"></div><button id="revoke">Revoke viewer</button><h2>Sample tarball SHA-256</h2><pre id="hash"></pre><h2>License notices</h2><pre id="notice"></pre><script type="module" src="/browser.js"></script></html>`,
);
const server = createServer(async (req, res) => {
  const name =
    req.url === '/' ? 'index.html' : req.url === '/browser.js' ? 'browser.js' : undefined;
  if (!name) {
    res.writeHead(404).end();
    return;
  }
  res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/html');
  res.end(await readFile(path.join(host, 'dist', name)));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true });
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('status').filter({ hasText: 'Ready' }).waitFor();
    await page.getByRole('slider', { name: 'Seek Animation tick' }).fill('120000');
    assert.equal(
      await page.locator('svg rect').getAttribute('transform'),
      'matrix(1 0 0 1 118 30)',
    );
    assert.equal(await page.locator('#hash').textContent(), pkg.sha256);
    assert.match(await page.locator('#notice').textContent(), /No distribution permission/);
    assert.match(
      await page.locator('#notice').textContent(),
      /repository license terms remain unchanged/,
    );
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({
      path: path.join(host, `packaged-${viewport.width}.png`),
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Revoke viewer' }).click();
    assert.equal(await page.locator('#surface svg').count(), 0);
    assert.equal(await page.getByRole('status').textContent(), 'Revoked');
    assert.deepEqual(errors, []);
    console.log(
      'PASS packaged browser',
      viewport.width,
      'real mount/seek/revoke/hash/visible notices; no console/page errors',
    );
    await page.close();
  }
} finally {
  await browser?.close();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
