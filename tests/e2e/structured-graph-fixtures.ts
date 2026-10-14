import { expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createDataGraphFixture } from '@editor-platform/structured-data-graph/model';
import { type GraphDocument } from '@editor-platform/structured-graph/model';
import { createArtifact } from '@editor-platform/artifact-core';
export async function independentSource<T = GraphDocument>(page: Page): Promise<T> {
  return JSON.parse((await page.getByTestId('graph-source').textContent()) ?? '{}');
}
/** Install fictional source through the reference Host's declared storage contract. */
export async function storeIndependentDefinition(page: Page, content: unknown) {
  const artifact = {
    ...createArtifact('reference-definition', 'Boundary fixture', content),
    id: 'graph-host-definition',
  };
  await page.evaluate(async (serialized) => {
    const artifact = JSON.parse(serialized);
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('independent-graph-host', 1);
      request.onsuccess = () => {
        const db = request.result,
          tx = db.transaction('artifacts', 'readwrite');
        tx.objectStore('artifacts').put(artifact);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
  }, JSON.stringify(artifact));
  await page.reload();
  await page.getByLabel('Graph source', { exact: true }).selectOption('definition');
  await expect(page.getByRole('status').first()).toHaveText('Reloaded locally');
}
export async function graphAttribute(page: Page, node: string, field: string, value: string) {
  await page.getByRole('button', { name: `Select node ${node}`, exact: true }).click();
  await page.getByLabel(field, { exact: true }).fill(value);
  await page.getByRole('button', { name: 'Apply attributes', exact: true }).click();
}
export async function dataProjection(page: Page, name: string) {
  const menu = page.getByRole('button', { name: 'More editor tools', exact: true });
  const select = page.getByLabel('Data projection', { exact: true });
  if (!(await select.isVisible())) await menu.click();
  await select.selectOption(name);
  await page.keyboard.press('Escape');
}
export async function importRelationData(page: Page) {
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'relations.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(createDataGraphFixture())),
  });
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue('relations');
}
export async function downloadJson(page: Page, button: string) {
  const promise = page.waitForEvent('download');
  await page.getByRole('button', { name: button, exact: true }).click();
  const result = await promise;
  return JSON.parse(await readFile((await result.path())!, 'utf8'));
}
/** Build the public Surface independently; generated JS/CSS stays in memory. */
async function mountGraphFixture(page: Page, name: string, query = '') {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL(`../fixtures/graph/${name}-host.tsx`, import.meta.url))],
    bundle: true,
    write: false,
    outdir: '/tmp/bounded-graph-host',
    format: 'iife',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  await page.route(`**/${name}-graph-host.html*`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Independent Graph Host</title></head><body><div id="root"></div></body></html>',
    }),
  );
  await page.goto(`/${name}-graph-host.html${query}`);
  // Match a production Host: package styles are installed before React measures/mounts.
  for (const file of bundle.outputFiles!)
    if (file.path.endsWith('.css')) await page.addStyleTag({ content: file.text });
  for (const file of bundle.outputFiles!)
    if (file.path.endsWith('.js')) await page.addScriptTag({ content: file.text });
  await expect(page.getByLabel('Structured Graph Editor', { exact: true })).toBeVisible();
}
export const mountBoundedGraphHost = (page: Page) => mountGraphFixture(page, 'bounded');
export const mountReadingGraphHost = (page: Page, query = '') =>
  mountGraphFixture(page, 'reading', query);
