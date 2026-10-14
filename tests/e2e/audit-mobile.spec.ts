import { test, expect } from './fixtures';
import { slideLayoutBoundary, legacyDataRead, sharedInheritedStyle } from './pr52-extra-fixtures';
test('PR #52 extra mobile: slide layout addition keeps composing invalid and refused input', async ({
  page,
}, info) => {
  await slideLayoutBoundary(page);
  await page.screenshot({ path: info.outputPath('layout-boundary-mobile.png') });
});
test('PR #52 extra mobile: stored legacy null Graph labels remain readable with immutable versions', async ({
  page,
}, info) => {
  await legacyDataRead(page);
  await page.screenshot({ path: info.outputPath('legacy-label-mobile.png') });
});
for (const kind of ['slide', 'design', 'whiteboard'] as const)
  test(`PR #52 extra mobile: shared ${kind} inherited styles toggle and survive peer history`, async ({
    page,
  }, info) => {
    await sharedInheritedStyle(page, kind);
    await page.screenshot({ path: info.outputPath(`${kind}-inherited-mobile.png`) });
  });
import { importUsability } from './usability-fixtures';
import { auditData, auditDocument } from './audit-fixtures';
import { dataProjection, independentSource } from './structured-graph-fixtures';
import type { StructuredData } from '@editor-platform/structured-data/model';
import {
  freshChartOutput,
  freshCanvasOutput,
  scalarEdgeLabels,
  pdfIndexFailureNotice,
} from './pr52-output-fixtures';
for (const kind of ['slide', 'whiteboard', 'design'] as const)
  test(`PR #52 output mobile: ${kind} captures freshly flushed graphic export input`, async ({
    page,
  }, info) => {
    await freshCanvasOutput(page, kind, info.outputPath(`${kind}-fresh.png`));
    await page.screenshot({ path: info.outputPath(`${kind}-fresh-mobile.png`) });
  });
test('PR #52 output mobile: Data chart captures committed records and private accent', async ({
  page,
}, info) => {
  await freshChartOutput(page, info.outputPath('fresh-chart.png'));
  await page.screenshot({ path: info.outputPath('fresh-chart-mobile.png') });
});
test('PR #52 output mobile: Graph displays typed scalar edge labels', async ({ page }, info) => {
  await scalarEdgeLabels(page);
  await page.screenshot({ path: info.outputPath('scalar-graph-mobile.png') });
});
test('PR #52 output mobile: PDF indexing errors suppress the scanned-file notice', async ({
  page,
}, info) => {
  await pdfIndexFailureNotice(page);
  await page.screenshot({ path: info.outputPath('pdf-index-notice-mobile.png') });
});
import {
  documentSurfaceExport,
  templateFormBoundary,
  graphConnectionBoundary,
  reusableDocumentBoundary,
  sharedAuthoringBoundary,
  sharedTextExportWait,
} from './pr52-boundary-fixtures';
test('PR #52 boundary mobile: Document Surface exports freshly flushed focused input', async ({
  page,
}, info) => {
  await documentSurfaceExport(page);
  await page.screenshot({ path: info.outputPath('boundary-document-mobile.png') });
});
test('PR #52 boundary mobile: template authoring refuses invalid retained Form input', async ({
  page,
}, info) => {
  await templateFormBoundary(page);
  await page.screenshot({ path: info.outputPath('boundary-template-mobile.png') });
});
test('PR #52 boundary mobile: Graph Host flush refuses selection-stale connection input', async ({
  page,
}, info) => {
  await graphConnectionBoundary(page);
  await page.screenshot({ path: info.outputPath('boundary-graph-mobile.png') });
});
test('PR #52 boundary mobile: reusable authoring captures the focused Document source', async ({
  page,
}, info) => {
  await reusableDocumentBoundary(page);
  await page.screenshot({ path: info.outputPath('boundary-reusable-mobile.png') });
});
test('PR #52 boundary mobile: shared template authoring blocks pending and holds one confirmed source', async ({
  page,
}, info) => {
  await sharedAuthoringBoundary(page);
  await page.screenshot({ path: info.outputPath('boundary-shared-authoring-mobile.png') });
});
test('PR #52 boundary mobile: Host text export stops when more input arrives while awaiting confirmation', async ({
  page,
}) => {
  await sharedTextExportWait(page);
});
import {
  sharedFormSave,
  sharedFormLeave,
  replacementEncoding,
  fieldSettingsSave,
  sharedFormStart,
  independentFormSwitch,
  sharedFormDetach,
  imageFirstPublicSlot,
} from './pr52-followup-fixtures';
test('PR #52 scoped mobile: shared start flushes focused Form input and retains saved versions', async ({
  page,
}, info) => {
  await sharedFormStart(page);
  await page.screenshot({ path: info.outputPath('scoped-shared-start-mobile.png') });
});
test('PR #52 scoped mobile: independent Surface switching preserves valid drafts and blocks refused input', async ({
  page,
}, info) => {
  await independentFormSwitch(page, info.outputPath('scoped-independent-retained-mobile.png'));
  await page.screenshot({ path: info.outputPath('scoped-independent-switch-mobile.png') });
});
test('PR #52 scoped mobile: shared detach retains focused Form input in an offline checkpoint', async ({
  page,
}, info) => {
  await sharedFormDetach(page);
  await page.screenshot({ path: info.outputPath('scoped-shared-detach-mobile.png') });
});
test('PR #52 scoped mobile: image-first publication selects and reconciles an eligible slot part', async ({
  page,
}, info) => {
  await imageFirstPublicSlot(page);
  await page.screenshot({ path: info.outputPath('scoped-image-first-slot-mobile.png') });
});
test('PR #52 new mobile: leaving shared Form confirms valid input and retains invalid composition', async ({
  page,
}, info) => {
  await sharedFormLeave(page);
  await page.screenshot({ path: info.outputPath('shared-leave-mobile.png') });
});
test('PR #52 remaining mobile: focused field decimal settings save atomically and survive reload', async ({
  page,
}, info) => {
  await fieldSettingsSave(page);
  await page.screenshot({ path: info.outputPath('field-settings-mobile.png') });
});
test('PR #52 mobile shared Form save retains pending inputs across rejected and accepted versions', async ({
  page,
}, info) => {
  await sharedFormSave(page);
  await page.screenshot({ path: info.outputPath('shared-form-save-mobile.png') });
});
test('PR #52 mobile replacement encoding re-decodes retained bytes and saves the current text', async ({
  page,
}) => {
  await replacementEncoding(page);
});
test('audit mobile: CSV scope dialog and series table remain keyboard reachable in a narrow Host', async ({
  page,
}, info) => {
  await page.goto('/');
  await importUsability(page, 'data', auditData());
  await dataProjection(page, 'Chart');
  await page.getByText('Chart aggregate table / 集計表', { exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('table').getByText('Sum of displayed aggregates')).toBeVisible();
  const more = page.getByRole('button', { name: 'More editor tools', exact: true });
  if (!(await page.getByRole('button', { name: 'Export data', exact: true }).isVisible()))
    await more.click();
  await page.getByRole('button', { name: 'Export data', exact: true }).click();
  await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: 'CSV export scope' }).getByLabel('CSV columns scope'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Cancel CSV export', exact: true }).click();
  await page.screenshot({ path: info.outputPath('audit-mobile-chart.png') });
});
test('audit mobile: Document table Tab remains within the native body', async ({ page }, info) => {
  await page.goto('/');
  await importUsability(page, 'document', auditDocument());
  const table = page.locator('.ProseMirror table');
  await table
    .locator('td')
    .filter({ hasText: '活動' })
    .locator('p')
    .click({ position: { x: 3, y: 6 } });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.keyboard.press('Tab');
  await expect(page.getByRole('textbox', { name: 'Document body' })).toBeFocused();
  await page.keyboard.insertText('30');
  await expect(table).toContainText('30');
  await page.screenshot({ path: info.outputPath('audit-mobile-table.png') });
});
test('PR #52 mobile: independent Graph Host enables and routes private Dashboard history', async ({
  page,
}, info) => {
  await page.goto('/graph-host.html');
  await expect(page.getByRole('status').first()).toHaveText('Ready');
  await page.getByLabel('Graph source', { exact: true }).selectOption('data');
  await expect(page.getByRole('status').first()).toHaveText('Ready');
  await dataProjection(page, 'Dashboard');
  const toggle = page.getByRole('button', { name: 'Toggle Data inspector', exact: true });
  if (!(await page.getByRole('button', { name: 'Add metric widget', exact: true }).isVisible()))
    await toggle.click();
  await page.getByRole('button', { name: 'Add metric widget', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Host Undo', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  await expect(page.locator('.ep-widget')).toHaveCount(0);
  await page.getByRole('button', { name: 'Host Redo', exact: true }).click();
  await expect(page.locator('.ep-widget')).toHaveCount(1);
  await page.getByLabel('Host read only', { exact: true }).check();
  await expect(page.getByRole('button', { name: 'Host Undo', exact: true })).toBeDisabled();
  await page.screenshot({ path: info.outputPath('graph-host-private-history-mobile.png') });
});
test('PR #52 mobile: version restore blocks invalid Form input and preserves corrected input in Undo', async ({
  page,
}, info) => {
  await page.goto('/graph-host.html');
  await expect(page.getByRole('status').first()).toHaveText('Ready');
  await page.getByLabel('Graph source', { exact: true }).selectOption('data');
  await expect(page.getByRole('status').first()).toHaveText('Ready');
  await dataProjection(page, 'Form');
  const original = await independentSource(page);
  await page.getByRole('button', { name: 'Commit version', exact: true }).click();
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
  await page.getByText('Saved versions', { exact: true }).click();
  const field = page.getByLabel('Record Name', { exact: true });
  await field.fill('');
  const restore = page.getByRole('button', { name: 'Restore version 1', exact: true });
  await restore.focus();
  await restore.press('Enter');
  await expect(page.getByRole('status').first()).toHaveText('Uncommitted input; restore blocked');
  await expect(field).toHaveValue('');
  expect(await independentSource(page)).toEqual(original);
  await field.fill('Mobile retained before restore');
  await restore.focus();
  await restore.press('Enter');
  await expect(page.getByRole('status').first()).toHaveText('Unsaved draft');
  expect(await independentSource(page)).toEqual(original);
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  expect((await independentSource<StructuredData>(page)).rows[0].values.name).toBe(
    'Mobile retained before restore',
  );
  await page.screenshot({ path: info.outputPath('graph-host-restore-mobile.png') });
});
