import { expect, type Page } from '@playwright/test';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { importUsability } from './usability-fixtures';
import { dataProjection, independentSource } from './structured-graph-fixtures';
import { createData, addRow } from '@editor-platform/structured-data/model';
import { tinyPng, nativeArtifact, save } from './fixtures';
import { confirmed } from './practical-fixtures';
import { artifactMenu } from './template-fixtures';
import { auditData } from './audit-fixtures';
import type { GraphDocument } from '@editor-platform/structured-graph';

async function imageDocument(page: Page) {
  await page.goto('/');
  await importUsability(page, 'document', {
    schemaVersion: 1,
    blocks: [
      {
        id: 'image',
        type: 'image',
        text: '',
        src: `data:image/png;base64,${tinyPng.toString('base64')}`,
        alt: 'Original alt',
        caption: 'Original caption',
        width: 100,
      },
    ],
  });
  await selectImage(page);
}
async function selectImage(page: Page) {
  const item = page.getByRole('button', { name: '01 · Original alt', exact: true });
  if (!(await item.isVisible()))
    await page.getByRole('button', { name: 'Toggle Document outline', exact: true }).click();
  await item.click();
  const close = page.getByRole('button', { name: 'Close Document outline', exact: true });
  if (await close.isVisible()) await close.click();
  if (!(await page.getByLabel('Alt text', { exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle Document inspector', exact: true }).click();
}
async function surfaceExport(page: Page, format: string) {
  const menu = page.getByRole('button', { name: 'Export document', exact: true });
  if (!(await menu.isVisible()))
    await page
      .getByRole('button', { name: 'More editor tools', exact: true })
      .dispatchEvent('click');
  await menu.dispatchEvent('click');
  await page.getByRole('button', { name: `Export ${format}`, exact: true }).dispatchEvent('click');
}
export async function documentSurfaceExport(page: Page) {
  await imageDocument(page);
  const downloads: string[] = [];
  page.on('download', (download) => downloads.push(download.suggestedFilename()));
  const alt = page.getByLabel('Alt text', { exact: true });
  await alt.fill('Focused latest surface alt');
  const pending = page.waitForEvent('download');
  await surfaceExport(page, 'MD');
  expect(await readFile((await (await pending).path())!, 'utf8')).toContain(
    'Focused latest surface alt',
  );
  await page.keyboard.press('Escape');
  const width = page.getByLabel('Image width', { exact: true });
  const caption = page.getByLabel('Caption', { exact: true });
  for (const format of ['MD', 'HTML', 'PDF']) {
    const count = downloads.length;
    await width.fill('');
    await surfaceExport(page, format);
    await expect(page.getByRole('alert').filter({ hasText: 'Image width' }).first()).toBeVisible();
    await expect(width).toHaveValue('');
    expect(downloads.length).toBe(count);
    await page.keyboard.press('Escape');
    await width.fill('500');
    await caption.fill('Retained composing caption');
    await caption.dispatchEvent('compositionstart');
    await surfaceExport(page, format);
    await expect(page.getByRole('alert').filter({ hasText: '入力変換' }).first()).toBeVisible();
    expect(downloads.length).toBe(count);
    await caption.dispatchEvent('compositionend');
    await page.keyboard.press('Escape');
  }
  await width.fill('960');
  await caption.fill('Latest HTML caption');
  const html = page.waitForEvent('download');
  await surfaceExport(page, 'HTML');
  const text = await readFile((await (await html).path())!, 'utf8');
  expect(text).toContain('width="960"');
  expect(text).toContain('Latest HTML caption');
  await page.keyboard.press('Escape');
  await caption.fill('Latest PDF caption');
  const pdf = page.waitForEvent('download');
  await surfaceExport(page, 'PDF');
  expect(
    (await promisify(execFile)('pdftotext', [(await (await pdf).path())!, '-'])).stdout,
  ).toContain('Latest PDF caption');
  await page.keyboard.press('Escape');
  const record = await nativeArtifact(page);
  expect(
    (record.draft.content as { blocks: { id: string; caption: string }[] }).blocks[0],
  ).toMatchObject({ id: 'image', caption: 'Latest PDF caption' });

  await mountBoundaryHost(page, 'document');
  await selectImage(page);
  await expect(alt).toBeVisible();
  await page.getByRole('button', { name: 'Enable second buffer', exact: true }).click();
  await page.getByLabel('Second buffer', { exact: true }).fill('Retained second draft');
  await alt.fill('Accepted first draft');
  const count = downloads.length;
  await surfaceExport(page, 'MD');
  await expect(page.getByRole('alert').filter({ hasText: 'Second buffer' }).first()).toBeVisible();
  expect(downloads.length).toBe(count);
  await expect(page.getByLabel('Native command count')).toHaveText('1');
  await expect(page.getByLabel('Pending inputs')).toHaveText('1');
  await expect(page.getByLabel('Second buffer', { exact: true })).toHaveValue(
    'Retained second draft',
  );
  await page.keyboard.press('Escape');
  await page.getByLabel('Accept second buffer', { exact: true }).check();
  const accepted = page.waitForEvent('download');
  await surfaceExport(page, 'MD');
  expect(await readFile((await (await accepted).path())!, 'utf8')).toContain(
    'Accepted first draft',
  );
  await expect(page.getByLabel('Native command count')).toHaveText('1');
  await expect(page.getByLabel('Canonical second')).toHaveText('Retained second draft');
  await expect(page.getByLabel('Pending inputs')).toHaveText('0');
}

async function startAuthor(page: Page, name: string) {
  await page
    .getByRole('button', { name: 'More artifact actions', exact: true })
    .dispatchEvent('click');
  await page.getByRole('button', { name, exact: true }).dispatchEvent('click');
}
async function catalogRecords(page: Page) {
  return page.evaluate(
    () =>
      new Promise<unknown[]>((resolve, reject) => {
        const open = indexedDB.open('editor-platform-templates', 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result,
            transaction = db.transaction('versions'),
            request = transaction.objectStore('versions').getAll();
          transaction.oncomplete = () => {
            db.close();
            resolve(request.result);
          };
          transaction.onerror = () => reject(transaction.error);
        };
      }),
  );
}
function authoringData() {
  const data = addRow().apply(createData());
  data.columns.find((column) => column.name === 'Name')!.required = true;
  return data;
}

export async function templateFormBoundary(page: Page) {
  await page.goto('/');
  const data = auditData();
  data.columns[0].required = true;
  await importUsability(page, 'data', data);
  await dataProjection(page, 'Form');
  const field = page.getByLabel('Record Name', { exact: true });
  for (const name of ['テンプレートとして保存', '再利用部品として保存']) {
    await field.fill('');
    await startAuthor(page, name);
    await expect(page.getByRole('dialog', { name, exact: true })).toHaveCount(0);
    await expect(page.locator('.error-banner')).toContainText('Name');
    await page.keyboard.press('Escape');
    await field.fill('Focused Form authoring source');
    await field.dispatchEvent('compositionstart');
    await startAuthor(page, name);
    await expect(page.getByRole('dialog', { name, exact: true })).toHaveCount(0);
    await expect(page.locator('.error-banner')).toContainText('入力変換');
    await field.dispatchEvent('compositionend');
    await page.keyboard.press('Escape');
  }
  await field.focus();
  await startAuthor(page, 'テンプレートとして保存');
  const dialog = page.getByRole('dialog', { name: 'テンプレートとして保存', exact: true });
  await dialog.getByRole('button', { name: '保存内容をプレビュー', exact: true }).click();
  await expect(dialog.locator('.tp-data-preview')).toContainText('Focused Form authoring source');
  await dialog.getByRole('button', { name: 'テンプレートを保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(JSON.stringify(await catalogRecords(page))).toContain('Focused Form authoring source');
  expect(JSON.stringify(await catalogRecords(page))).toContain('2026-11-01');
}

export async function reusableDocumentBoundary(page: Page) {
  await imageDocument(page);
  const caption = page.getByLabel('Caption', { exact: true });
  await caption.fill('Focused reusable caption');
  await startAuthor(page, '再利用部品として保存');
  const dialog = page.getByRole('dialog', { name: '再利用部品として保存', exact: true });
  await dialog.getByRole('button', { name: '部品をプレビュー', exact: true }).click();
  await expect(
    dialog.frameLocator('iframe[title="文書テンプレートの実描画"]').locator('body'),
  ).toContainText('Focused reusable caption');
  await dialog.getByRole('button', { name: '部品を公開', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(JSON.stringify(await catalogRecords(page))).toContain('Focused reusable caption');
  expect(JSON.stringify((await nativeArtifact(page)).draft.content)).toContain(
    'Focused reusable caption',
  );
}

export async function sharedAuthoringBoundary(page: Page) {
  await page.goto('/');
  const data = authoringData();
  await importUsability(page, 'data', data);
  await save(page, 1);
  await artifactMenu(page, 'Open collaboratively');
  await page.keyboard.press('Escape');
  await confirmed(page);
  await dataProjection(page, 'Form');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/collaboration-api/submit**', async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await page.getByLabel('Record Name', { exact: true }).fill('Confirmed authoring snapshot');
    await startAuthor(page, 'テンプレートとして保存');
    await expect(
      page.getByRole('dialog', { name: 'テンプレートとして保存', exact: true }),
    ).toHaveCount(0);
    await expect(page.locator('.error-banner')).toContainText('確認が完了');
  } finally {
    release();
  }
  await confirmed(page);
  await page.unroute('**/collaboration-api/submit**');
  await page.keyboard.press('Escape');
  await startAuthor(page, 'テンプレートとして保存');
  const dialog = page.getByRole('dialog', { name: 'テンプレートとして保存', exact: true });
  await expect(dialog).toBeVisible();
  const context = await page.context().browser()!.newContext();
  const peer = await context.newPage();
  const errors: string[] = [];
  peer.on('pageerror', (error) => errors.push(error.message));
  peer.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  try {
    const url = new URL(page.url());
    url.searchParams.set('actor', 'B');
    await peer.goto(url.toString());
    await confirmed(peer);
    await dataProjection(peer, 'Form');
    await peer.getByLabel('Record Name', { exact: true }).fill('Peer edit after authoring began');
    await peer.getByRole('button', { name: 'Save record', exact: true }).click();
    await confirmed(peer);
    await expect(page.locator('.app').getByLabel('Record Name', { exact: true })).toHaveValue(
      'Peer edit after authoring began',
    );
    await dialog.getByRole('button', { name: '保存内容をプレビュー', exact: true }).click();
    await expect(dialog.locator('.tp-data-preview')).toContainText('Confirmed authoring snapshot');
    await expect(dialog.locator('.tp-data-preview')).not.toContainText(
      'Peer edit after authoring began',
    );
    await dialog.getByRole('button', { name: 'テンプレートを保存', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const saved = JSON.stringify(await catalogRecords(page));
    expect(saved).toContain('Confirmed authoring snapshot');
    expect(saved).not.toContain('Peer edit after authoring began');
    await confirmed(page);
    const latest = await nativeArtifact(page);
    expect(JSON.stringify(latest.draft.content)).toContain('Peer edit after authoring began');
    expect(latest.versions).toHaveLength(1);
  } finally {
    await context.close();
  }
  expect(errors).toEqual([]);
}

export async function sharedTextExportWait(page: Page) {
  await imageDocument(page);
  await artifactMenu(page, 'Open collaboratively');
  await page.keyboard.press('Escape');
  await confirmed(page);
  await selectImage(page);
  let release!: () => void, submitted!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    submitted = resolve;
  });
  await page.route('**/collaboration-api/submit**', async (route) => {
    submitted();
    await gate;
    await route.continue();
  });
  const downloads: string[] = [];
  page.on('download', (value) => downloads.push(value.suggestedFilename()));
  const alt = page.getByLabel('Alt text', { exact: true });
  const exportHtml = async () => {
    await page.getByRole('button', { name: 'Export artifact', exact: true }).dispatchEvent('click');
    await page.getByRole('button', { name: 'Export HTML', exact: true }).dispatchEvent('click');
  };
  try {
    await alt.fill('First accepted input');
    await exportHtml();
    await started;
    await alt.fill('Additional input while waiting');
  } finally {
    release();
  }
  await expect(page.locator('.error-banner')).toContainText('待機中に入力');
  expect(downloads).toEqual([]);
  await expect(alt).toHaveValue('Additional input while waiting');
  await confirmed(page);
  await page.unroute('**/collaboration-api/submit**');
  // Export HTML closed the menu, so no Escape here: in the Alt text field it would discard the input.
  const pending = page.waitForEvent('download');
  await exportHtml();
  expect(await readFile((await (await pending).path())!, 'utf8')).toContain(
    'Additional input while waiting',
  );
}

export async function graphConnectionBoundary(page: Page) {
  await page.goto('/graph-host.html');
  await expect(page.getByRole('status').first()).toHaveText('Ready');
  const original = await independentSource<GraphDocument>(page);
  const edge = page.getByRole('button', { name: /^Select connection/ }).first();
  await edge.focus();
  await edge.press('Enter');
  const to = page.getByLabel('Connection to', { exact: true });
  if (!(await to.isVisible()))
    await page.getByRole('button', { name: 'Toggle Graph inspector', exact: true }).click();
  const target = original.nodes.find((node) => node.id !== original.edges[0].to)!.id;
  await to.selectOption(target);
  await page
    .getByRole('button', { name: /^Select node/ })
    .first()
    .click();
  await expect(
    page.getByText('Connection input is stale. Reload current values.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('form', { name: 'Connection editor', exact: true }).dispatchEvent('submit');
  await expect(
    page.getByRole('alert').filter({ hasText: 'Stale connection' }).first(),
  ).toBeVisible();
  expect(await independentSource(page)).toEqual(original);
  await page.getByRole('button', { name: 'Save draft', exact: true }).dispatchEvent('click');
  expect(await independentSource(page)).toEqual(original);
  await expect(page.getByRole('alert').filter({ hasText: 'Graph:' }).first()).toBeVisible();
  await expect(to).toHaveValue(target);
  await page.getByRole('button', { name: 'Reload connection', exact: true }).click();
  await to.selectOption(target);
  await page.getByRole('form', { name: 'Connection editor', exact: true }).dispatchEvent('submit');
  const changed = await independentSource<GraphDocument>(page);
  expect(changed.edges[0].to).toBe(target);
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  expect(await independentSource(page)).toEqual(original);

  await mountBoundaryHost(page, 'graph');
  if (!(await to.isVisible()))
    await page.getByRole('button', { name: 'Toggle Graph inspector', exact: true }).click();
  await to.selectOption('resource-a');
  await page.getByRole('button', { name: 'External layout update', exact: true }).click();
  const source = async () =>
    JSON.parse((await page.getByTestId('graph-boundary-source').textContent())!);
  const moved = await source();
  await page.getByRole('form', { name: 'Connection editor', exact: true }).dispatchEvent('submit');
  await expect(
    page.getByRole('alert').filter({ hasText: 'Stale connection' }).first(),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Host save', exact: true }).dispatchEvent('click');
  await expect(page.getByLabel('Graph save status')).toContainText('Stale connection');
  expect(await source()).toEqual(moved);
  await expect(to).toHaveValue('resource-a');
  await page.getByRole('button', { name: 'Reload connection', exact: true }).click();
  await to.selectOption('resource-a');
  await page.getByLabel('Graph Host read only', { exact: true }).check();
  await page.getByRole('button', { name: 'Host save', exact: true }).dispatchEvent('click');
  await expect(page.getByLabel('Graph save status')).toContainText('編集できません');
  expect(await source()).toEqual(moved);
}

export async function mountBoundaryHost(page: Page, kind: string) {
  const worker = (await readdir('dist/assets')).find((name) =>
    /^pdf\.worker\.min-.*\.mjs$/.test(name),
  );
  expect(worker).toBeTruthy();
  const bundle = await build({
    entryPoints: [
      fileURLToPath(new URL('../fixtures/pr52/new-comments-host.tsx', import.meta.url)),
    ],
    bundle: true,
    write: false,
    outdir: '/tmp/pr52-boundary-host',
    format: 'esm',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [
      {
        name: 'pdf-worker-url',
        setup(builder) {
          builder.onResolve({ filter: /pdf\.worker\.min\.mjs\?url$/ }, () => ({
            path: 'worker',
            namespace: 'pdf-worker-url',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'pdf-worker-url' }, () => ({
            contents: `export default ${JSON.stringify(`/assets/${worker}`)}`,
            loader: 'js',
          }));
        },
      },
    ],
  });
  await page.route('**/pr52-boundary-host.html*', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}pre{max-width:100%;overflow:auto}</style></head><body><div id="root"></div></body></html>',
    }),
  );
  await page.goto(`/pr52-boundary-host.html?kind=${kind}`);
  for (const file of bundle.outputFiles!) {
    if (file.path.endsWith('.css')) await page.addStyleTag({ content: file.text });
    if (file.path.endsWith('.js')) await page.addScriptTag({ content: file.text, type: 'module' });
  }
}
