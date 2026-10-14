import {
  test,
  expect,
  create,
  save,
  tinyPng,
  artifactView,
  setDocumentText,
  insertDoc,
  comments,
  editCell,
  addRecord,
  addField,
} from './fixtures';
import { readFile } from 'node:fs/promises';
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
});
test('document lifecycle, block editing, diagrams, comments, versions, exports and persistence', async ({
  page,
}, info) => {
  await create(page);
  await page.getByLabel('Artifact name').fill('Field notes');
  await setDocumentText(page, 'h1', 'A field guide');
  await setDocumentText(page, 'p', 'Draft one');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.ProseMirror > p').first()).toHaveText('');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.locator('.ProseMirror > p').first()).toHaveText('Draft one');
  await insertDoc(page, 'Table');
  await page.locator('.ProseMirror td').first().click();
  await page.keyboard.insertText('Research');
  await page.getByRole('button', { name: 'Add table row', exact: true }).click();
  await expect(page.locator('.ProseMirror tr')).toHaveCount(3);
  await insertDoc(page, 'Mermaid');
  await expect(page.getByRole('img', { name: 'Mermaid diagram' })).toBeVisible({ timeout: 20000 });
  await page
    .getByLabel('Document image file')
    .setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: tinyPng });
  await expect(page.getByRole('img', { name: 'pixel.png' })).toBeVisible();
  await page.locator('.ProseMirror h1').click();
  await comments(page);
  await page.getByLabel('Comment', { exact: true }).fill('Keep the title concise');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await page.getByRole('button', { name: 'Resolve', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reopen', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close comments', exact: true }).click();
  await save(page, 1);
  await setDocumentText(page, ':scope > p', 'Draft two with more detail');
  await save(page, 2);
  await page.screenshot({ path: info.outputPath('document-desktop.png') });
  await artifactView(page, 'Compare');
  await expect(page.getByText(/Draft two with more detail/)).toBeVisible();
  await page.screenshot({ path: info.outputPath('compare-desktop.png') });
  await page.getByRole('button', { name: 'Export artifact', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export Markdown', exact: true }).click();
  const file = await pending;
  expect(file.suggestedFilename()).toBe('Field notes.md');
  const markdown = await readFile((await file.path())!, 'utf8');
  expect(markdown).toContain('```mermaid');
  expect(markdown).toContain('Draft two with more detail');
  expect(markdown).not.toContain('block_');
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.getByLabel('Artifact name')).toHaveValue('Field notes');
  await expect(page.locator('.ProseMirror > p').first()).toHaveText('Draft two with more detail');
  await artifactView(page, 'History');
  await page.getByRole('button', { name: 'Restore to draft', exact: true }).first().click();
  await expect(page.locator('.ProseMirror > p').first()).toHaveText('Draft one');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.ProseMirror > p').first()).toHaveText('Draft two with more detail');
});
test('external proposal preview reject apply and undo preserves rich text', async ({ page }) => {
  await create(page);
  await setDocumentText(page, 'h1', 'A mixed title');
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await save(page, 1);
  await page.locator('.ProseMirror h1').click();
  const propose = async () => {
    await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
    await page.getByRole('button', { name: 'External proposal demo', exact: true }).click();
  };
  await propose();
  await expect(page.getByRole('dialog', { name: 'External proposal preview' })).toContainText(
    'A MIXED TITLE',
  );
  await page.getByRole('button', { name: 'Reject proposal', exact: true }).click();
  await expect(page.locator('.ProseMirror h1')).toHaveText('A mixed title');
  await page.keyboard.press('Escape');
  await propose();
  await page.getByRole('button', { name: 'Apply proposal', exact: true }).click();
  await expect(page.locator('.ProseMirror h1')).toHaveText('A MIXED TITLE');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.ProseMirror h1')).toHaveText('A mixed title');
});
test('safe previews isolate HTML scripts and Mermaid failures', async ({ page }) => {
  await create(page);
  await insertDoc(page, 'HTML preview');
  await page
    .getByLabel('HTML preview source')
    .fill('<script>parent.document.body.innerHTML="BROKEN"</script><h1>Safe preview</h1>');
  await page.getByLabel('HTML preview source').press('Tab');
  await expect(page.getByLabel('Artifact name')).toBeVisible();
  await expect(page.locator('iframe[title="Sandboxed HTML preview"]')).toHaveAttribute(
    'sandbox',
    '',
  );
  await expect(
    page.frameLocator('iframe').getByRole('heading', { name: 'Safe preview' }),
  ).toBeVisible();
  await insertDoc(page, 'Mermaid');
  await page.getByLabel('Mermaid source').fill('this is not a diagram');
  await page.getByLabel('Mermaid source').press('Tab');
  await expect(page.getByText('Invalid Mermaid syntax. Your other blocks are safe.')).toBeVisible();
  await setDocumentText(page, ':scope > p', 'Still editable');
  await expect(page.locator('.ProseMirror > p').first()).toHaveText('Still editable');
});
test('typed data editing, formula, validation, projections, grouping and CSV import/export', async ({
  page,
}, info) => {
  await create(page, 'data');
  await addRecord(page);
  await addRecord(page);
  await editCell(page, 'Name', 1, 'Research');
  await editCell(page, 'Name', 2, 'Publish');
  await editCell(page, 'Quantity', 1, '3');
  await editCell(page, 'Price', 1, '25');
  await expect(page.getByRole('gridcell', { name: 'Total · record 1', exact: true })).toHaveText(
    '75',
  );
  await addField(page, 'Due', 'date');
  await editCell(page, 'Due', 1, '2026-10-04');
  await addField(page, 'Approved', 'boolean');
  await editCell(page, 'Approved', 1, 'true', true);
  await page.getByRole('gridcell', { name: 'Name · record 1', exact: true }).click();
  await page.getByLabel('Data projection').selectOption('Form');
  await page.getByLabel('Record Quantity', { exact: true }).fill('wrong');
  await page.getByRole('button', { name: 'Save record', exact: true }).click();
  await expect(page.getByText('Enter a number', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel changes', exact: true }).click();
  await page.getByLabel('Record Name', { exact: true }).fill('Research complete');
  await page.getByRole('button', { name: 'Save record', exact: true }).click();
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByLabel('Read only', { exact: true }).check();
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Record Name', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByLabel('Read only', { exact: true }).uncheck();
  await page.keyboard.press('Escape');
  await page.getByLabel('Data projection').selectOption('Grid');
  await page.getByLabel('Search records', { exact: true }).fill('Research');
  await expect(page.getByRole('grid')).toHaveAttribute('aria-rowcount', '2');
  await page.getByLabel('Search records', { exact: true }).fill('');
  await page.getByLabel('Group field', { exact: true }).selectOption({ label: 'Status' });
  await expect(page.getByText(/Planned · 2 records/)).toBeVisible();
  await page.screenshot({ path: info.outputPath('data-grid-desktop.png') });
  await page.getByLabel('Data projection').selectOption('Kanban');
  await page.getByLabel('Move Research complete to', { exact: true }).selectOption('Done');
  await save(page, 1);
  await page.getByRole('button', { name: 'Export data', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'CSV export scope' })
    .getByRole('button', { name: 'Download CSV', exact: true })
    .click();
  const file = await pending;
  await page.keyboard.press('Escape');
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'Imported.csv',
    mimeType: 'text/csv',
    buffer: await readFile((await file.path())!),
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Imported');
  await expect(page.getByRole('gridcell', { name: 'Name · record 1', exact: true })).toHaveText(
    'Research complete',
  );
  await page.reload();
  await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Artifacts' })).toContainText('Imported');
});
test('review line annotations, file demos and downloads', async ({ page }, info) => {
  await create(page, 'review');
  await page.getByRole('button', { name: 'added new line 2', exact: true }).click();
  await comments(page);
  await page.getByLabel('Comment', { exact: true }).fill('Review this greeting');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await save(page, 1);
  await page.getByRole('button', { name: 'Close comments', exact: true }).click();
  await page.screenshot({ path: info.outputPath('review-desktop.png') });
  await create(page, 'file');
  await page.getByRole('button', { name: 'File line 2', exact: true }).click();
  await comments(page);
  await page.getByLabel('Comment', { exact: true }).fill('Log annotation');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await page.getByRole('button', { name: 'Close comments', exact: true }).click();
  await page.getByRole('button', { name: 'Sample files', exact: true }).click();
  await page.getByRole('button', { name: 'Demo IMAGE', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Select image region', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sample files', exact: true }).click();
  await page.getByRole('button', { name: 'Demo PDF', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Rendered PDF page 1', { exact: true })).toHaveAttribute(
    'data-rendered',
    'true',
  );
  await page.getByRole('button', { name: 'Select page', exact: true }).click();
  await comments(page);
  await expect(page.getByText('1 element selected · page')).toBeVisible();
  await page.getByRole('button', { name: 'Close comments', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download original file', exact: true }).click();
  expect((await pending).suggestedFilename()).toBe('sample.pdf');
  await save(page, 1);
});
test('Markdown and native JSON imports preserve content and reject malformed files', async ({
  page,
}) => {
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'Imported notes.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Imported title\n\nHello, ordinary markdown.\n\n- one\n- two\n'),
  });
  await expect(page.locator('.ProseMirror h1')).toHaveText('Imported title');
  await save(page, 1);
  await page.getByRole('button', { name: 'Export artifact', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  const file = await pending;
  await page.keyboard.press('Escape');
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'Roundtrip.json',
    mimeType: 'application/json',
    buffer: await readFile((await file.path())!),
  });
  await expect(page.locator('.ProseMirror h1')).toHaveText('Imported title');
  await artifactView(page, 'History');
  await expect(page.getByRole('button', { name: 'Restore to draft', exact: true })).toHaveCount(1);
  await artifactView(page, 'Editor');
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'Invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"schemaVersion":999}'),
  });
  await expect(page.getByRole('alert')).toContainText('Import failed');
  await expect(page.locator('.ProseMirror h1')).toHaveText('Imported title');
});
