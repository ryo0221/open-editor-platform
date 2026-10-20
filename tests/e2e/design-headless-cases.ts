import { build } from 'esbuild';
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { nestedTextFixture } from '../fixtures/design-nested-text/content';

let bundle: Promise<{ js: string; css: string }>;
async function host(page: Page) {
  bundle ??= build({
    entryPoints: ['tests/fixtures/design-headless/host.tsx'],
    bundle: true,
    write: false,
    outdir: '/tmp/design-headless-bundle',
    format: 'esm',
    define: { 'process.env.NODE_ENV': '"production"' },
  }).then((r) => ({
    js: r.outputFiles!.find((f) => f.path.endsWith('.js'))!.text,
    css: r.outputFiles!.find((f) => f.path.endsWith('.css'))!.text,
  }));
  const files = await bundle;
  await page.route('**/design-headless-host.js', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: files.js }),
  );
  await page.route('**/design-headless-host.css', (r) =>
    r.fulfill({ contentType: 'text/css', body: files.css }),
  );
  await page.route('**/design-headless-host', (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/design-headless-host.css"><div id="root"></div><script type="module" src="/design-headless-host.js"></script>',
    }),
  );
  await page.goto('/design-headless-host');
}
const source = (page: Page) => page.getByTestId('design-source');
const history = (page: Page) => page.getByLabel('Host history state', { exact: true });
export function designHeadlessCases() {
  test('#27 nested JSON state overrides reveal and unlock only the addressed text', async ({
    page,
  }, info) => {
    const initial = nestedTextFixture();
    Object.assign(initial.components[0].elements![0], { locked: true, hidden: true });
    await page.addInitScript((encoded) => {
      if (!sessionStorage.getItem('design-headless-content'))
        sessionStorage.setItem('design-headless-content', encoded);
    }, JSON.stringify(initial));
    await host(page);
    const canvas = page.getByRole('application', { name: 'Design canvas', exact: true });
    await expect(canvas.getByText('Nested title', { exact: true })).toHaveCount(0);
    await page
      .getByLabel('Design JSON intents', { exact: true })
      .fill(
        JSON.stringify([
          {
            type: 'override',
            id: 'card',
            partId: ['section', 'title'],
            patch: { locked: false, hidden: false },
          },
        ]),
      );
    await page.getByRole('button', { name: 'Preview intents', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByRole('button', { name: 'Apply intents', exact: true }).click();
    await expect(canvas.getByText('Nested title', { exact: true })).toHaveCount(1);
    await canvas.getByText('Nested title', { exact: true }).dblclick();
    const editor = page.getByRole('textbox', { name: 'Edit canvas text', exact: true });
    await editor.press('Control+a');
    await page.keyboard.insertText('Unlocked title');
    await editor.press('Control+Enter');
    await expect(canvas.getByText('Unlocked title', { exact: true })).toHaveCount(1);
    const after = await source(page).textContent();
    const content = JSON.parse(after!);
    expect(content.components).toEqual(initial.components);
    expect(content.elements[1]).toEqual(initial.elements[1]);
    await page.getByRole('button', { name: 'Host undo', exact: true }).click();
    await page.getByRole('button', { name: 'Host undo', exact: true }).click();
    await expect(canvas.getByText('Nested title', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Host redo', exact: true }).click();
    await page.getByRole('button', { name: 'Host redo', exact: true }).click();
    await expect(source(page)).toHaveText(after!);
    await page.getByRole('button', { name: 'Host save', exact: true }).click();
    await page.reload();
    await expect(canvas.getByText('Unlocked title', { exact: true })).toHaveCount(1);
    await expect(source(page)).toHaveText(after!);
    await page.screenshot({ path: info.outputPath('nested-state-unlock-reload.png') });
  });

  test('#27 nested JSON overrides preview, apply, undo and survive native reload', async ({
    page,
  }, info) => {
    const initial = nestedTextFixture();
    await page.addInitScript((encoded) => {
      if (!sessionStorage.getItem('design-headless-content'))
        sessionStorage.setItem('design-headless-content', encoded);
    }, JSON.stringify(initial));
    await host(page);
    const before = await source(page).textContent();
    await page.getByLabel('Design JSON intents', { exact: true }).fill(
      JSON.stringify([
        {
          type: 'override',
          id: 'card',
          partId: ['section', 'title'],
          patch: { text: 'JSON title' },
        },
        { type: 'override', id: 'other', partId: 'section', patch: { fill: '#abcdef' } },
      ]),
    );
    await page.getByRole('button', { name: 'Preview intents', exact: true }).click();
    await expect(page.getByTestId('intent-preview')).toContainText('JSON title');
    await expect(source(page)).toHaveText(before!);
    await page.getByRole('button', { name: 'Apply intents', exact: true }).click();
    const canvas = page.getByRole('application', { name: 'Design canvas', exact: true });
    await expect(canvas.getByText('JSON title', { exact: true })).toHaveCount(1);
    const after = await source(page).textContent();
    const content = JSON.parse(after!);
    expect(content.components).toEqual(initial.components);
    expect(content.elements[1].overrides.section.fill).toBe('#abcdef');
    await page.getByRole('button', { name: 'Host undo', exact: true }).click();
    await expect(source(page)).toHaveText(before!);
    await page.getByRole('button', { name: 'Host redo', exact: true }).click();
    await expect(source(page)).toHaveText(after!);
    await page.getByRole('button', { name: 'Host save', exact: true }).click();
    await page.reload();
    await expect(source(page)).toHaveText(after!);
    await expect(canvas.getByText('JSON title', { exact: true })).toHaveCount(1);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('nested-json-intent-reload.png') });
  });

  test('#296 review rejects nested fields, React manufacture and locked parents; edits saved instance templates', async ({
    page,
  }) => {
    await host(page);
    const before = await source(page).textContent();
    const beforeHistory = await history(page).textContent();
    const batches = [
      [
        { type: 'insert', elementType: 'text', options: { id: 'item' } },
        { type: 'update', id: 'item', patch: { typography: { fontSize: 18, unexpected: true } } },
      ],
      [
        { type: 'insert', elementType: 'text', options: { id: 'item' } },
        {
          type: 'update',
          id: 'item',
          patch: {
            type: 'react',
            react: {
              component: {
                registryId: 'fixture',
                componentId: 'Ghost',
                version: '1',
                contractHash: '0'.repeat(64),
                implementationHash: '0'.repeat(64),
              },
              import: { source: './Ghost', export: 'named', name: 'Ghost' },
              props: {},
              bindings: {},
              slots: {},
            },
          },
        },
      ],
      [
        { type: 'update', id: 'frame', patch: { locked: true } },
        { type: 'insert', elementType: 'text', options: { id: 'item' } },
        { type: 'properties', ids: ['item'], patch: { parentId: 'frame' } },
      ],
    ];
    for (const batch of batches) {
      await page.getByLabel('Design JSON intents', { exact: true }).fill(JSON.stringify(batch));
      await page.getByRole('button', { name: 'Preview intents', exact: true }).click();
      await expect(page.getByRole('alert')).toBeVisible();
      await expect(source(page)).toHaveText(before!);
      await expect(history(page)).toHaveText(beforeHistory!);
      await expect(page.getByTestId('intent-preview')).toHaveCount(0);
    }
    await page.getByLabel('Design JSON intents', { exact: true }).fill(
      JSON.stringify([
        { type: 'insert', elementType: 'text', options: { id: 'seed' } },
        { type: 'create-component', ids: ['seed'], componentId: 'base' },
        { type: 'create-component', ids: ['seed'], componentId: 'wrapper' },
        {
          type: 'update-component',
          componentId: 'wrapper',
          patch: { fill: '#112233', text: 'Updated instance template' },
        },
      ]),
    );
    await page.getByRole('button', { name: 'Preview intents', exact: true }).click();
    await expect(page.getByTestId('intent-preview')).toContainText('Updated instance template');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByRole('button', { name: 'Apply intents', exact: true }).click();
    await expect(source(page)).toContainText('Updated instance template');
    await page.getByRole('button', { name: 'Host save', exact: true }).click();
    await page.reload();
    await expect(source(page)).toContainText('Updated instance template');
    await page
      .getByLabel('Design JSON intents', { exact: true })
      .fill(
        JSON.stringify([
          { type: 'update-component', componentId: 'wrapper', patch: { text: 'After reload' } },
        ]),
      );
    await page.getByRole('button', { name: 'Preview intents', exact: true }).click();
    await page.getByRole('button', { name: 'Apply intents', exact: true }).click();
    await expect(source(page)).toContainText('After reload');
    await page.getByRole('button', { name: 'Host undo', exact: true }).click();
    await expect(source(page)).toContainText('Updated instance template');
  });
  test('#294/#295 preview/cancel/apply retains IDs and one Undo, ordinary Inspector, save/reload', async ({
    page,
  }, info) => {
    await host(page);
    const original = await source(page).textContent();
    const initialHistory = await history(page).textContent();
    await page.getByRole('button', { name: 'Preview intents', exact: true }).click();
    await expect(
      page.getByRole('img', { name: 'Proposed Design preview', exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId('intent-preview')).toContainText('Agent title');
    await expect(source(page)).toHaveText(original!);
    await expect(history(page)).toHaveText(initialHistory!);
    await page.screenshot({ path: info.outputPath('headless-preview.png') });
    await page.getByRole('button', { name: 'Cancel intents', exact: true }).click();
    await expect(page.getByTestId('intent-preview')).toHaveCount(0);
    await expect(source(page)).toHaveText(original!);
    await page.getByRole('button', { name: 'Preview intents', exact: true }).click();
    const preview = await page.getByTestId('intent-preview').textContent();
    await page.getByRole('button', { name: 'Apply intents', exact: true }).click();
    await expect(source(page)).toHaveText(preview!);
    await page.getByRole('button', { name: 'Host undo', exact: true }).click();
    await expect(source(page)).toHaveText(original!);
    await expect(history(page)).toContainText('"canUndo":false');
    await page.getByRole('button', { name: 'Host redo', exact: true }).click();
    await expect(source(page)).toHaveText(preview!);
    const layer = page.getByRole('button', { name: 'Layer Agent title', exact: true });
    if (!(await layer.isVisible()))
      await page.getByRole('button', { name: 'Toggle Design navigator', exact: true }).click();
    await layer.click();
    await expect(page.getByLabel('Host selection', { exact: true })).toContainText('agent-title');
    const name = page.getByLabel('Layer name', { exact: true });
    if (!(await name.isVisible()))
      await page.getByRole('button', { name: 'Toggle Design inspector', exact: true }).click();
    await name.fill('Ordinary Inspector');
    await name.press('Enter');
    await expect(source(page)).toContainText('Ordinary Inspector');
    const saved = await source(page).textContent();
    await page.getByRole('button', { name: 'Host save', exact: true }).click();
    await expect(page.getByLabel('Host action status', { exact: true })).toHaveText('Saved');
    await page.reload();
    await expect(source(page)).toHaveText(saved!);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
  test('#295 rejects stale and ABA previews without consuming the history branch', async ({
    page,
  }) => {
    await host(page);
    const original = await source(page).textContent();
    await page.getByRole('button', { name: 'Preview intents', exact: true }).click();
    await page.getByRole('button', { name: 'Host edit base', exact: true }).click();
    const changed = await source(page).textContent();
    const changedHistory = await history(page).textContent();
    await page.getByRole('button', { name: 'Apply intents', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('stale');
    await expect(source(page)).toHaveText(changed!);
    await expect(history(page)).toHaveText(changedHistory!);
    await page.getByRole('button', { name: 'Host undo', exact: true }).click();
    await expect(source(page)).toHaveText(original!);
    const aba = await history(page).textContent();
    await page.getByRole('button', { name: 'Apply intents', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('stale');
    await expect(history(page)).toHaveText(aba!);
  });
  test('#295 commit-time revocation rejects headless apply and retains the preview', async ({
    page,
  }) => {
    await host(page);
    await page.getByRole('button', { name: 'Preview intents', exact: true }).click();
    const before = await source(page).textContent();
    const beforeHistory = await history(page).textContent();
    await page.getByLabel('Host read only', { exact: true }).check();
    await page.getByRole('button', { name: 'Apply intents', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('read only');
    await expect(source(page)).toHaveText(before!);
    await expect(history(page)).toHaveText(beforeHistory!);
    await expect(page.getByTestId('intent-preview')).toBeVisible();
    await page.getByLabel('Host read only', { exact: true }).uncheck();
    await page.getByRole('button', { name: 'Apply intents', exact: true }).click();
    await expect(page.getByLabel('Host action status', { exact: true })).toHaveText('Applied');
  });
  test('#295 failed JSON batch leaves no partial insertion or history change', async ({ page }) => {
    await host(page);
    const before = await source(page).textContent();
    const beforeHistory = await history(page).textContent();
    await page.getByLabel('Design JSON intents', { exact: true }).fill(
      JSON.stringify([
        { type: 'insert', elementType: 'text', options: { id: 'partial' } },
        { type: 'update', id: 'partial', patch: { opacity: 2 } },
      ]),
    );
    await page.getByRole('button', { name: 'Preview intents', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Invalid Design element');
    await expect(source(page)).toHaveText(before!);
    await expect(history(page)).toHaveText(beforeHistory!);
    await expect(page.getByTestId('intent-preview')).toHaveCount(0);
  });
}
