import {
  test,
  expect,
  nativeArtifact,
  save,
  editCell,
  replaceFileSource,
  tinyPng,
  setDocumentText,
} from './fixtures';
import { slideLayoutBoundary, legacyDataRead, sharedInheritedStyle } from './pr52-extra-fixtures';
test('PR #52 extra: slide layout addition keeps composing invalid and refused input', async ({
  page,
}, info) => {
  await slideLayoutBoundary(page);
  await page.screenshot({ path: info.outputPath('layout-boundary-desktop.png') });
});
test('PR #52 extra: stored legacy null Graph labels remain readable with immutable versions', async ({
  page,
}, info) => {
  await legacyDataRead(page);
  await page.screenshot({ path: info.outputPath('legacy-label-desktop.png') });
});
for (const kind of ['slide', 'design', 'whiteboard'] as const)
  test(`PR #52 extra: shared ${kind} inherited styles toggle and survive peer history`, async ({
    page,
  }, info) => {
    await sharedInheritedStyle(page, kind);
    await page.screenshot({ path: info.outputPath(`${kind}-inherited-desktop.png`) });
  });
import { importUsability } from './usability-fixtures';
import { dataProjection } from './structured-graph-fixtures';
import { auditData } from './audit-fixtures';
import {
  fieldSettingsSave,
  sharedFormLeave,
  sharedFormStart,
  independentFormSwitch,
  sharedFormDetach,
  imageFirstPublicSlot,
} from './pr52-followup-fixtures';
import { artifactMenu } from './template-fixtures';
import { confirmed } from './practical-fixtures';
import { createArtifact, commitVersion } from '@editor-platform/artifact-core';
import { addAnnotation } from '@editor-platform/editor-core';
import { createReview, createFile, originalBytes } from '@editor-platform/review-surfaces/model';
import { createDesign, makeDesignElement, type DesignContent } from '@editor-platform/design/model';
import type { StructuredData } from '@editor-platform/structured-data/model';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import type { SlideContent } from '@editor-platform/slide/model';
import {
  documentSurfaceExport,
  templateFormBoundary,
  graphConnectionBoundary,
  reusableDocumentBoundary,
  sharedAuthoringBoundary,
  sharedTextExportWait,
} from './pr52-boundary-fixtures';
import {
  freshChartOutput,
  freshCanvasOutput,
  scalarEdgeLabels,
  pdfIndexFailureNotice,
} from './pr52-output-fixtures';

for (const kind of ['slide', 'whiteboard', 'design'] as const)
  test(`PR #52 output: ${kind} captures freshly flushed graphic export input`, async ({
    page,
  }, info) => {
    await freshCanvasOutput(page, kind, info.outputPath(`${kind}-fresh.png`));
    await page.screenshot({ path: info.outputPath(`${kind}-fresh-desktop.png`) });
  });

test('PR #52 output: Data chart captures committed records and private accent', async ({
  page,
}, info) => {
  await freshChartOutput(page, info.outputPath('fresh-chart.png'));
  await page.screenshot({ path: info.outputPath('fresh-chart-desktop.png') });
});
test('PR #52 output: Graph displays typed scalar edge labels', async ({ page }, info) => {
  await scalarEdgeLabels(page);
  await page.screenshot({ path: info.outputPath('scalar-graph-desktop.png') });
});
test('PR #52 output: PDF indexing errors suppress the scanned-file notice', async ({
  page,
}, info) => {
  await pdfIndexFailureNotice(page);
  await page.screenshot({ path: info.outputPath('pdf-index-notice-desktop.png') });
});

test('PR #52 boundary: Document Surface exports freshly flushed focused input', async ({
  page,
}) => {
  await documentSurfaceExport(page);
});
test('PR #52 boundary: template authoring refuses invalid retained Form input', async ({
  page,
}) => {
  await templateFormBoundary(page);
});
test('PR #52 boundary: Graph Host flush refuses selection-stale connection input', async ({
  page,
}) => {
  await graphConnectionBoundary(page);
});
test('PR #52 boundary: reusable authoring captures the focused Document source', async ({
  page,
}, info) => {
  await reusableDocumentBoundary(page);
  await page.screenshot({ path: info.outputPath('boundary-reusable-desktop.png') });
});
test('PR #52 boundary: shared template authoring blocks pending and holds one confirmed source', async ({
  page,
}, info) => {
  await sharedAuthoringBoundary(page);
  await page.screenshot({ path: info.outputPath('boundary-shared-authoring-desktop.png') });
});
test('PR #52 boundary: Host text export stops when more input arrives while awaiting confirmation', async ({
  page,
}) => {
  await sharedTextExportWait(page);
});

test('PR #52 scoped: shared start flushes focused Form input and retains saved versions', async ({
  page,
}, info) => {
  await sharedFormStart(page);
  await page.screenshot({ path: info.outputPath('scoped-shared-start-desktop.png') });
});
test('PR #52 scoped: independent Surface switching preserves valid drafts and blocks refused input', async ({
  page,
}, info) => {
  await independentFormSwitch(page, info.outputPath('scoped-independent-retained-desktop.png'));
  await page.screenshot({ path: info.outputPath('scoped-independent-switch-desktop.png') });
});
test('PR #52 scoped: shared detach retains focused Form input in an offline checkpoint', async ({
  page,
}, info) => {
  await sharedFormDetach(page);
  await page.screenshot({ path: info.outputPath('scoped-shared-detach-desktop.png') });
});
test('PR #52 scoped: image-first publication selects and reconciles an eligible slot part', async ({
  page,
}, info) => {
  await imageFirstPublicSlot(page);
  await page.screenshot({ path: info.outputPath('scoped-image-first-slot-desktop.png') });
});

async function mountNewCommentsHost(page: Page, kind: string) {
  const pdfWorker = (await readdir('dist/assets')).find((name) =>
    /^pdf\.worker\.min-.*\.mjs$/.test(name),
  );
  expect(pdfWorker).toBeTruthy();
  const bundle = await build({
    entryPoints: [
      fileURLToPath(new URL('../fixtures/pr52/new-comments-host.tsx', import.meta.url)),
    ],
    bundle: true,
    write: false,
    outdir: '/tmp/pr52-new-comments-host',
    format: 'esm',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [
      {
        name: 'vite-worker-url',
        setup(builder) {
          builder.onResolve({ filter: /pdf\.worker\.min\.mjs\?url$/ }, () => ({
            path: 'pdf-worker',
            namespace: 'vite-worker-url',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'vite-worker-url' }, () => ({
            contents: `export default ${JSON.stringify(`/assets/${pdfWorker}`)}`,
            loader: 'js',
          }));
        },
      },
    ],
  });
  await page.route('**/pr52-new-comments-host.html*', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>',
    }),
  );
  await page.goto(`/pr52-new-comments-host.html?kind=${kind}`);
  for (const file of bundle.outputFiles!) {
    if (file.path.endsWith('.css')) await page.addStyleTag({ content: file.text });
    if (file.path.endsWith('.js')) await page.addScriptTag({ content: file.text, type: 'module' });
  }
}

test('PR #52 new: blurred invalid and rejected inputs survive canonical updates until correction or Escape', async ({
  page,
}, info) => {
  await mountNewCommentsHost(page, 'inputs');
  const number = page.getByLabel('Numeric draft', { exact: true });
  const text = page.getByLabel('Rejected draft', { exact: true });
  async function incomingUpdate() {
    const button = page.getByRole('button', { name: 'Incoming canonical update' });
    await button.focus();
    await button.press('Enter');
  }
  await number.fill('');
  await incomingUpdate();
  await expect(number).toHaveValue('');
  await expect(page.getByLabel('Canonical number')).toHaveText('110');
  await expect(text).toHaveValue('Initial remote');
  await text.fill('Retained rejected draft');
  await incomingUpdate();
  await expect(number).toHaveValue('');
  await expect(text).toHaveValue('Retained rejected draft');
  await expect(page.getByLabel('Pending inputs')).toHaveText('2');
  await page.getByRole('button', { name: 'Host save', exact: true }).click();
  await expect(page.getByLabel('Save status')).toHaveText('Blocked');
  await expect(number).toBeFocused();
  await number.fill('150');
  await page.getByRole('button', { name: 'Host save', exact: true }).click();
  await expect(page.getByLabel('Save status')).toHaveText('Blocked');
  await expect(text).toBeFocused();
  await page.getByLabel('Accept input').check();
  await page.getByRole('button', { name: 'Host save', exact: true }).click();
  await expect(page.getByLabel('Save status')).toHaveText('Accepted');
  await expect(page.getByLabel('Canonical number')).toHaveText('150');
  await expect(page.getByLabel('Canonical text')).toHaveText('Retained rejected draft');
  await expect(page.getByLabel('Pending inputs')).toHaveText('0');
  await number.fill('');
  await incomingUpdate();
  await number.press('Escape');
  await expect(number).toHaveValue('160');
  await page.screenshot({ path: info.outputPath('retained-inputs.png') });
});

test('PR #52 new: slide add and delete retain composition and rejected text and preserve flushed content', async ({
  page,
}, info) => {
  await mountNewCommentsHost(page, 'slide');
  const source = async (): Promise<SlideContent> =>
    JSON.parse((await page.getByTestId('slide-source').textContent())!);
  const before = await source();
  await page.getByRole('button', { name: 'text object 1', exact: true }).dblclick();
  const input = page.getByRole('textbox', { name: 'Edit canvas text', exact: true });
  await input.press('Control+End');
  await page.keyboard.type(' edited');
  await input.dispatchEvent('compositionstart');
  for (const action of ['Add slide', 'Delete slide']) {
    await page.getByRole('button', { name: action, exact: true }).dispatchEvent('click');
    await expect(input).toHaveText('Original edited');
    await expect(page.getByLabel('Current page')).toHaveValue('1');
    await expect(page.locator('.surface-error')).toContainText('入力変換');
    expect(await source()).toEqual(before);
  }
  await input.dispatchEvent('compositionend');
  for (const action of ['Add slide', 'Delete slide']) {
    await page.getByRole('button', { name: action, exact: true }).dispatchEvent('click');
    await expect(input).toHaveText('Original edited');
    expect(await source()).toEqual(before);
  }
  await page.getByLabel('Host accepts commands').check();
  await page.getByRole('button', { name: 'Add slide', exact: true }).dispatchEvent('click');
  await expect(input).toHaveCount(0);
  const added = await source();
  expect(added.slides).toHaveLength(before.slides.length + 1);
  expect(added.slides[0].objects[0].text).toBe('Original edited');
  await expect(page.getByLabel('Current page')).toHaveValue(String(added.slides.length));
  await page.getByLabel('Host accepts commands').uncheck();
  await page.getByRole('button', { name: 'Add slide', exact: true }).click();
  await page.getByRole('button', { name: 'Delete slide', exact: true }).click();
  expect(await source()).toEqual(added);
  await expect(page.getByLabel('Current page')).toHaveValue(String(added.slides.length));
  await page.getByLabel('Host accepts commands').check();
  await page.getByRole('button', { name: 'Delete slide', exact: true }).click();
  expect((await source()).slides).toEqual(added.slides.slice(0, -1));
  await page.screenshot({ path: info.outputPath('slide-input-boundary.png') });
});

test('PR #52 new: current annotation selection supersedes a delayed outdated source lookup', async ({
  page,
}, info) => {
  await mountNewCommentsHost(page, 'review');
  await page.getByRole('button', { name: 'Outdated annotation · Outdated', exact: true }).click();
  await expect(page.getByLabel('Source lookup status')).toHaveText('Pending');
  await page.getByRole('button', { name: 'Current annotation · Current', exact: true }).click();
  const revision = await page.getByLabel('Selected revision').textContent();
  expect(revision).toBeTruthy();
  await page.getByRole('button', { name: 'Finish source lookup', exact: true }).click();
  await expect(page.getByLabel('Source lookup status')).toHaveText('Finished');
  await expect(page.getByRole('dialog', { name: 'Annotation source version' })).toHaveCount(0);
  await expect(page.getByLabel('Selected revision')).toHaveText(revision!);
  // The resolver still opens a source when that outdated annotation remains selected.
  await page.getByRole('button', { name: 'Outdated annotation · Outdated', exact: true }).click();
  await page.getByRole('button', { name: 'Finish source lookup', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Annotation source version' })).toContainText(
    'Retained text',
  );
  await page.screenshot({ path: info.outputPath('review-source-navigation.png') });
});

test('PR #52 new: independent Host keyboard Undo and Redo use the same native history as its buttons', async ({
  page,
}) => {
  await page.goto('/embed.html');
  await page.getByLabel('Surface', { exact: true }).selectOption('slide');
  const source = async (): Promise<SlideContent> =>
    JSON.parse((await page.locator('.embed-content pre').textContent())!);
  const before = await source();
  await page.getByRole('button', { name: 'Add slide', exact: true }).click();
  expect((await source()).slides).toHaveLength(before.slides.length + 1);
  const canvas = page.getByRole('application', { name: 'Slide canvas', exact: true });
  await canvas.focus();
  await page.keyboard.press('Control+z');
  expect(await source()).toEqual(before);
  await page.keyboard.press('Control+Shift+z');
  expect((await source()).slides).toHaveLength(before.slides.length + 1);
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  expect(await source()).toEqual(before);
});

test('PR #52 new: CSV append rejects wider rows before confirming the batch', async ({ page }) => {
  await page.goto('/');
  const data = auditData();
  await importUsability(page, 'data', data);
  const dialog = page.getByRole('dialog', { name: 'CSV import preview' });
  for (const header of [true, false]) {
    await page.getByLabel('Import CSV file', { exact: true }).setInputFiles({
      name: 'wide.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(header ? 'Name,Value\nValid,3\nWide,4,lost\n' : 'Valid,3\nWide,4,lost\n'),
    });
    if (!header) {
      await dialog.getByLabel('First row is a header').uncheck();
      await dialog.getByLabel('Append target Column 1').selectOption('title');
      await dialog.getByLabel('Append target Column 2').selectOption('value');
    }
    await expect(dialog).toContainText(`Row ${header ? 3 : 2}, field 3 Column 3`);
    await expect(dialog).toContainText('lost');
    await expect(
      dialog.getByRole('button', { name: 'Import records', exact: true }),
    ).toBeDisabled();
    await page.getByRole('button', { name: 'Close CSV import preview', exact: true }).click();
    expect((await nativeArtifact(page)).draft.content).toEqual(data);
  }
});

test('PR #52 new: CSV append diagnoses readonly mappings and allows an editable target', async ({
  page,
}) => {
  await page.goto('/');
  const data = auditData();
  data.columns[0].readOnly = true;
  await importUsability(page, 'data', data);
  await page.getByLabel('Import CSV file', { exact: true }).setInputFiles({
    name: 'readonly.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Name\n3\n'),
  });
  const dialog = page.getByRole('dialog', { name: 'CSV import preview' });
  await expect(dialog).toContainText('Read-only fields cannot be imported');
  await expect(dialog.getByRole('button', { name: 'Import records', exact: true })).toBeDisabled();
  await dialog.getByLabel('Append target Name').selectOption('value');
  await expect(dialog.getByRole('button', { name: 'Import records', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Import records', exact: true }).click();
  const imported = (await nativeArtifact(page)).draft.content as StructuredData;
  expect(imported.rows).toHaveLength(data.rows.length + 1);
  expect(imported.rows.at(-1)?.values.value).toBe(3);
  expect(imported.rows.at(-1)?.values.title).toBeNull();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(data);
});

test('PR #52 new: Host Markdown and HTML retain invalid and composing Document inputs and capture flushed edits', async ({
  page,
}) => {
  await page.goto('/');
  await importUsability(page, 'document', {
    schemaVersion: 2,
    blocks: [
      {
        id: 'image',
        type: 'image',
        text: '',
        src: `data:image/png;base64,${tinyPng.toString('base64')}`,
        alt: 'Export image',
        caption: 'Original caption',
        width: 100,
      },
    ],
  });
  await page.getByRole('button', { name: '01 · Export image', exact: true }).click();
  const width = page.getByLabel('Image width', { exact: true });
  if (!(await width.isVisible()))
    await page.getByRole('button', { name: 'Toggle Document inspector', exact: true }).click();
  const downloads: string[] = [];
  page.on('download', (download) => downloads.push(download.suggestedFilename()));
  async function exportText(name: string) {
    await page.getByRole('button', { name: 'Export artifact', exact: true }).dispatchEvent('click');
    await page.getByRole('button', { name, exact: true }).dispatchEvent('click');
  }
  for (const name of ['Export Markdown', 'Export HTML']) {
    await width.fill('');
    await exportText(name);
    await expect(page.locator('.error-banner')).toContainText('Image width');
    await expect(width).toHaveValue('');
    expect(downloads).toEqual([]);
    await page.keyboard.press('Escape');
    await width.fill('700');
    await width.dispatchEvent('compositionstart');
    await exportText(name);
    await expect(page.locator('.error-banner')).toContainText('入力変換');
    expect(downloads).toEqual([]);
    await width.dispatchEvent('compositionend');
    await page.keyboard.press('Escape');
  }
  await width.fill('950');
  const htmlDownload = page.waitForEvent('download');
  await exportText('Export HTML');
  expect(await readFile((await (await htmlDownload).path())!, 'utf8')).toContain('width="950"');
  await page.keyboard.press('Escape');
  await page.getByLabel('Alt text', { exact: true }).fill('Flushed latest description');
  const markdownDownload = page.waitForEvent('download');
  await exportText('Export Markdown');
  expect(await readFile((await (await markdownDownload).path())!, 'utf8')).toContain(
    'Flushed latest description',
  );
});

test('PR #52 new: leaving a shared session retains invalid composition and confirms a valid Form draft', async ({
  page,
}, info) => {
  await sharedFormLeave(page);
  await page.screenshot({ path: info.outputPath('shared-leave.png') });
});

test('PR #52 new: Host text exports capture confirmed shared Document edits from both actors', async ({
  page,
}) => {
  await page.goto('/');
  await importUsability(page, 'document', {
    schemaVersion: 2,
    blocks: [{ id: 'text', type: 'paragraph', text: 'Original shared text' }],
  });
  await artifactMenu(page, 'Open collaboratively');
  await page.keyboard.press('Escape');
  await confirmed(page);
  const artifactId = new URL(page.url()).searchParams.get('shared')!;
  async function exportedText(name: string) {
    await page.getByRole('button', { name: 'Export artifact', exact: true }).dispatchEvent('click');
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name, exact: true }).dispatchEvent('click');
    const result = await readFile((await (await pending).path())!, 'utf8');
    await page.keyboard.press('Escape');
    return result;
  }
  await setDocumentText(page, ':scope > p', 'Local shared edit before download');
  expect(await exportedText('Export Markdown')).toContain('Local shared edit before download');
  const response = await page.request.post('/collaboration-api/editor/session', {
    data: { actor: 'B', artifactId, domain: 'document' },
  });
  expect(response.ok()).toBe(true);
  const configuration = { ...(await response.json()), domain: 'document' };
  const peer = await page.context().newPage();
  const errors: string[] = [];
  peer.on('pageerror', (error) => errors.push(error.message));
  peer.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await peer.goto('/embed.html');
  await peer.evaluate(
    (value) => sessionStorage.setItem('ep-independent-host', JSON.stringify(value)),
    configuration,
  );
  await peer.reload();
  await expect(peer.getByLabel('Host sync status')).toContainText('confirmed');
  await setDocumentText(peer, ':scope > p', 'Confirmed remote shared text');
  await expect(peer.getByLabel('Host sync status')).toContainText('confirmed');
  await expect(page.locator('.ProseMirror')).toContainText('Confirmed remote shared text');
  expect(await exportedText('Export Markdown')).toContain('Confirmed remote shared text');
  expect(await exportedText('Export HTML')).toContain('Confirmed remote shared text');
  expect(errors).toEqual([]);
  await peer.close();
});

test('PR #52 remaining: the first Data column sets the Graph label before any layout edit', async ({
  page,
}) => {
  const source: StructuredData = {
    schemaVersion: 2,
    columns: [],
    rows: [{ id: 'record', values: {} }],
    graphView: { schemaVersion: 1, labelColumnId: null, positions: { record: { x: 40, y: 40 } } },
  };
  await page.goto('/');
  await importUsability(page, 'data', source);
  await page.getByRole('button', { name: 'Add field', exact: true }).click();
  await page.getByLabel('New field name').fill('Label');
  await page.getByLabel('New field default').fill('Persisted label');
  await page.getByRole('button', { name: 'Create field', exact: true }).click();
  const added = (await nativeArtifact(page)).draft.content as StructuredData;
  expect(added.graphView).toEqual({ ...source.graphView, labelColumnId: added.columns[0].id });
  await dataProjection(page, 'Graph');
  const node = page.getByRole('button', { name: 'Select node Persisted label', exact: true });
  await node.click();
  await node.press('ArrowRight');
  const moved = (await nativeArtifact(page)).draft.content as StructuredData;
  expect(moved.graphView?.labelColumnId).toBe(added.graphView?.labelColumnId);
  expect(moved.rows).toEqual(added.rows);
  expect(moved.graphView?.positions.record).not.toEqual(added.graphView?.positions.record);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(added);
  await save(page, 1);
  await page.reload();
  expect((await nativeArtifact(page)).draft.content).toEqual(added);
});

test('PR #52 remaining: focused field decimal settings save atomically and survive reload', async ({
  page,
}, info) => {
  await fieldSettingsSave(page);
  await page.screenshot({ path: info.outputPath('field-settings-desktop.png') });
});

test('PR #52 remaining: focused Dashboard widget titles are included in the parent save transaction', async ({
  page,
}) => {
  await page.goto('/');
  await importUsability(page, 'data', auditData());
  await dataProjection(page, 'Dashboard');
  await page
    .locator('.ep-widget')
    .filter({ has: page.getByRole('heading', { name: 'Total', exact: true }) })
    .click();
  const title = page.getByLabel('Widget title', { exact: true });
  await title.fill('Parent-owned widget title');
  await expect(title).toBeFocused();
  // The Host save opens its ordinary version dialog without first blurring the field.
  await page.getByRole('button', { name: 'Save version', exact: true }).dispatchEvent('click');
  await page
    .getByRole('dialog', { name: 'Save immutable version', exact: true })
    .getByRole('button', { name: 'この版を保存', exact: true })
    .click();
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
  const saved = await nativeArtifact(page);
  expect((saved.draft.content as StructuredData).views?.[0].widgets[0].title).toBe(
    'Parent-owned widget title',
  );
  await page.reload();
  expect((await nativeArtifact(page)).draft.content).toEqual(saved.draft.content);
});

test('PR #52 remaining: Host CSV uses confirmed local and remote shared Data', async ({ page }) => {
  await page.goto('/');
  await importUsability(page, 'data', auditData());
  await artifactMenu(page, 'Open collaboratively');
  await page.keyboard.press('Escape');
  await confirmed(page);
  await dataProjection(page, 'Grid');
  await editCell(page, 'Value', 1, '73');
  await confirmed(page);
  const artifactId = new URL(page.url()).searchParams.get('shared')!;
  const response = await page.request.post('/collaboration-api/editor/session', {
    data: { actor: 'B', artifactId, domain: 'data' },
  });
  expect(response.ok()).toBe(true);
  const peer = await page.context().newPage();
  const errors: string[] = [];
  peer.on('pageerror', (error) => errors.push(error.message));
  peer.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await peer.goto('/embed.html');
  await peer.evaluate(
    (configuration) => sessionStorage.setItem('ep-independent-host', JSON.stringify(configuration)),
    { ...(await response.json()), domain: 'data' },
  );
  await peer.reload();
  await expect(peer.getByLabel('Host sync status')).toContainText('confirmed');
  await dataProjection(peer, 'Grid');
  await editCell(peer, 'Name', 1, 'Remote confirmed');
  await expect(peer.getByLabel('Host sync status')).toContainText('confirmed');
  await expect(page.getByRole('gridcell', { name: 'Name · record 1', exact: true })).toContainText(
    'Remote confirmed',
  );
  await confirmed(page);
  await page.getByRole('button', { name: 'Export artifact', exact: true }).click();
  await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
  await page.getByLabel('CSV rows scope').selectOption('all');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV', exact: true }).click();
  const csv = await readFile((await (await pending).path())!, 'utf8');
  expect(csv).toContain('Remote confirmed,73');
  expect(csv).not.toContain('First period,40');
  expect(
    ((await nativeArtifact(page)).draft.content as StructuredData).rows[0].values,
  ).toMatchObject({ title: 'Remote confirmed', value: 73 });
  await peer.close();
  expect(errors).toEqual([]);
});

for (const side of ['old', 'new'] as const)
  test(`PR #52 remaining: legacy ${side} Review anchors retrieve their saved source after replacement`, async ({
    page,
  }) => {
    const review = createReview(),
      file = review.files[0];
    const artifact = createArtifact('review', 'Legacy review', review);
    const annotations = [
      addAnnotation(
        {
          addresses: [
            {
              artifactId: artifact.id,
              elementId: file.id,
              region: { type: 'lines', start: 1, end: 1, side },
            },
          ],
        },
        'Legacy note',
        'Author',
      ),
    ];
    const annotated = { ...artifact, annotations };
    const saved = await commitVersion(annotated, 'Author', 'Legacy source');
    await page.goto('/');
    await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
      name: 'legacy.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(saved)),
    });
    const imported = await nativeArtifact(page);
    await page.getByRole('button', { name: 'Comparison sources', exact: true }).click();
    await page
      .getByLabel(side === 'old' ? 'Old text' : 'New text', { exact: true })
      .fill(`Changed ${side} source`);
    await page.getByRole('button', { name: 'Apply comparison sources', exact: true }).click();
    await page
      .locator('.ep-review-info')
      .getByRole('button', { name: 'Legacy note · Outdated', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Annotation source version' });
    await expect(dialog.locator('pre')).toHaveText(side === 'old' ? file.oldText : file.newText);
    await expect(dialog.locator('mark')).toHaveText(
      (side === 'old' ? file.oldText : file.newText).split('\n')[0],
    );
    await page
      .getByRole('button', { name: 'Close Annotation source version', exact: true })
      .click();
    const after = await nativeArtifact(page);
    expect(after.annotations).toEqual(imported.annotations);
    expect(after.versions).toEqual(imported.versions);
  });

test('PR #52 remaining: File remap preserves imported foreign and additional anchors through save/reload', async ({
  page,
}) => {
  const file = createFile(),
    artifact = createArtifact('file', 'Multi-anchor file', file);
  const address = {
    artifactId: artifact.id,
    elementId: file.id,
    region: { type: 'lines' as const, start: 1, end: 1 },
  };
  const external = { ...address, artifactId: 'external' };
  const other = { ...address, region: { ...address.region, start: 2, end: 2 } };
  const annotations = [
    {
      ...addAnnotation(
        { addresses: [external, address, other] },
        'Multi-anchor File note',
        'Author',
      ),
      color: '#123456',
    },
  ];
  await page.goto('/');
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'file-anchors.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ ...artifact, annotations })),
  });
  const imported = await nativeArtifact(page);
  await replaceFileSource(page, {
    name: 'replacement.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('New first line\nNew second line'),
  });
  await expect(
    page.getByRole('button', { name: 'Multi-anchor File note · Orphan', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'File line 1', exact: true }).click();
  await page
    .getByRole('button', { name: 'Remap annotation to current selection', exact: true })
    .click();
  const after = await nativeArtifact(page),
    annotation = after.annotations[0];
  expect(annotation.anchor.addresses).toHaveLength(3);
  expect(annotation.anchor.addresses[0]).toEqual(imported.annotations[0].anchor.addresses[0]);
  expect(annotation.anchor.addresses[2]).toEqual(imported.annotations[0].anchor.addresses[2]);
  expect(annotation.anchor.addresses[1]).toMatchObject({
    artifactId: imported.id,
    elementId: (after.draft.content as typeof file).id,
    region: { type: 'lines', start: 1, end: 1 },
  });
  expect(annotation.comments).toEqual(annotations[0].comments);
  expect(annotation.color).toBe('#123456');
  await save(page, 1);
  await page.reload();
  expect((await nativeArtifact(page)).annotations).toEqual(after.annotations);
});

test('PR #52 remaining: dense PDF search explicitly shows partial results and clears the warning for a narrower query', async ({
  page,
}, info) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  const sheet = pdf.addPage([612, 792]);
  for (let line = 0; line < 100; line++)
    sheet.drawText('a '.repeat(100), { x: 10, y: 780 - line * 7, size: 2, font });
  sheet.drawText('a unique-ending', { x: 10, y: 70, size: 2, font });
  const bytes = await pdf.save();
  const file = {
    ...createFile('pdf'),
    name: 'dense.pdf',
    size: bytes.length,
    data: `data:application/pdf;base64,${Buffer.from(bytes).toString('base64')}`,
  };
  await page.goto('/');
  await importUsability(page, 'file', file);
  await expect(page.getByLabel('Rendered PDF page 1', { exact: true })).toHaveAttribute(
    'data-rendered',
    'true',
  );
  await page.getByLabel('Search PDF text').fill('a');
  await expect(
    page.getByRole('status').filter({ hasText: '10000 text matches (partial)' }),
  ).toBeVisible();
  await expect(page.getByText('検索結果の一部を表示しています。', { exact: false })).toBeVisible();
  await page.screenshot({ path: info.outputPath('pdf-truncated-search.png') });
  await page.getByLabel('Search PDF text').fill('unique-ending');
  await expect(page.getByRole('status').filter({ hasText: '1 text matches' })).toBeVisible();
  await expect(page.getByText('検索結果の一部を表示しています。', { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: 'Next PDF text match', exact: true }).click();
  await expect(page.locator('[data-pdf-active-match]')).toContainText('unique-ending');
  expect(
    Buffer.from(originalBytes((await nativeArtifact(page)).draft.content as typeof file)),
  ).toEqual(Buffer.from(bytes));
});

test('PR #52 remaining: absolute Hug frame disables child fitting and preserves geometry with fixed size and Undo', async ({
  page,
}, info) => {
  const frame = {
    ...makeDesignElement('frame'),
    id: 'absolute',
    name: 'Absolute frame',
    bounds: { x: 40, y: 40, width: 1000, height: 1000 },
    layout: {
      direction: 'absolute' as const,
      gap: 16,
      padding: 16,
      align: 'start' as const,
      sizing: 'hug' as const,
    },
  };
  const child = {
    ...makeDesignElement('rectangle'),
    id: 'child',
    parentId: frame.id,
    bounds: { x: 900, y: 800, width: 600, height: 700 },
  };
  const source: DesignContent = { ...createDesign(), elements: [frame, child] };
  await page.goto('/');
  await importUsability(page, 'design', source);
  await page.getByRole('button', { name: frame.name, exact: true }).click();
  await page.getByLabel('Frame preset').selectOption('390x844');
  await expect(
    page.getByRole('button', { name: 'Fit children to fixed frame', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText('絶対配置では子要素の自動調整を利用できません。', { exact: false }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath('absolute-preset-choice.png') });
  await page.getByRole('button', { name: 'Use fixed frame size', exact: true }).click();
  const fixed = (await nativeArtifact(page)).draft.content as DesignContent;
  expect(fixed.elements[0].bounds).toMatchObject({ width: 390, height: 844 });
  expect(fixed.elements[1]).toEqual(child);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(source);
});
