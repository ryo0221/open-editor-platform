import { test, expect, create, nativeArtifact, save, comments } from './fixtures';
import { importUsability, dragBetween } from './usability-fixtures';
import { auditData, auditDocument } from './audit-fixtures';
import { dataProjection } from './structured-graph-fixtures';
import {
  createReview,
  originalBytes,
  type FileContent,
  type ReviewContent,
} from '@editor-platform/review-surfaces/model';
import { createDeck, makeSlideObject, type SlideContent } from '@editor-platform/slide/model';
import { makeWhiteboardNode, type WhiteboardContent } from '@editor-platform/whiteboard/model';
import {
  createDesign,
  makeDesignElement,
  layoutDesign,
  type DesignContent,
} from '@editor-platform/design/model';
import { createArtifact } from '@editor-platform/artifact-core';
import { type StructuredData } from '@editor-platform/structured-data/model';
import { type DocumentContent } from '@editor-platform/document/model';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { unzipSync, strFromU8 } from 'fflate';
import { authorDesignReact, layer } from './design-react-fixtures';

async function sourceReplacement(
  page: import('@playwright/test').Page,
  buffer: Buffer,
  name: string,
  mimeType: string,
) {
  await page.getByRole('button', { name: 'Replace source', exact: true }).click();
  await page.getByLabel('Open file', { exact: true }).setInputFiles({ name, mimeType, buffer });
}
async function csvDownload(
  page: import('@playwright/test').Page,
  rows = 'filtered',
  columns = 'visible',
) {
  const dialog = page.getByRole('dialog', { name: 'CSV export scope' });
  await dialog.getByLabel('CSV rows scope').selectOption(rows);
  await dialog.getByLabel('CSV columns scope').selectOption(columns);
  const pending = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download CSV', exact: true }).click();
  return readFile((await (await pending).path())!, 'utf8');
}

test('#53 #54 #71 table Tab/Shift-Tab and Add row keep cell focus, readonly ARIA follows capability', async ({
  page,
}) => {
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
  await page.keyboard.insertText('20');
  expect(
    ((await nativeArtifact(page)).draft.content as DocumentContent).blocks[2].cells![1][1],
  ).toBe('20');
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
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.insertText('活動更新');
  expect(
    ((await nativeArtifact(page)).draft.content as DocumentContent).blocks[2].cells![1][0],
  ).toBe('活動更新');
  await table
    .locator('td')
    .filter({ hasText: '20' })
    .locator('p')
    .click({ position: { x: 3, y: 6 } });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.getByRole('button', { name: 'Add table row', exact: true }).click();
  await page.keyboard.insertText('1.5');
  let content = (await nativeArtifact(page)).draft.content as DocumentContent;
  expect(content.blocks[2].cells!.at(-1)).toEqual(['', '1.5']);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(table.locator('tr')).toHaveCount(2);
  await table
    .locator('td')
    .filter({ hasText: '20' })
    .locator('p')
    .click({ position: { x: 3, y: 6 } });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.keyboard.press('Tab');
  await page.keyboard.insertText('新規先頭');
  content = (await nativeArtifact(page)).draft.content as DocumentContent;
  expect(content.blocks[2].cells!.at(-1)![0]).toBe('新規先頭');
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByLabel('Read only', { exact: true }).check();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('textbox', { name: 'Document body' })).toHaveAttribute(
    'aria-readonly',
    'true',
  );
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByLabel('Read only', { exact: true }).uncheck();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('textbox', { name: 'Document body' })).toHaveAttribute(
    'aria-readonly',
    'false',
  );
});

test('#61 Timeline without date fields creates and assigns shared native columns with one Undo', async ({
  page,
}) => {
  const data = auditData();
  data.columns = data.columns.filter((column) => !['start', 'end'].includes(column.id));
  data.rows.forEach((row) => {
    delete row.values.start;
    delete row.values.end;
  });
  delete data.views;
  await page.goto('/');
  await importUsability(page, 'data', data);
  await dataProjection(page, 'Timeline');
  await expect(
    page.getByText('開始日・終了日にはdate型の列が必要です。', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Add start and end date fields', exact: true }).click();
  const updated = (await nativeArtifact(page)).draft.content as StructuredData;
  expect(updated.columns.filter((column) => column.type === 'date')).toHaveLength(2);
  expect(updated.rows).toHaveLength(3);
  await page.getByRole('button', { name: 'First period', exact: true }).click();
  await page.getByLabel('Timeline start date').fill('2026-11-01');
  await page.getByLabel('Timeline end date').fill('2026-11-03');
  await page.getByRole('button', { name: 'Apply dates', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Dates for First period', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(((await nativeArtifact(page)).draft.content as StructuredData).columns).toEqual(
    data.columns,
  );
});

test('#62 Timeline pointer focuses the dragged record, no-delta click is clean and Undo/Redo target only that period', async ({
  page,
}) => {
  const data = auditData();
  await page.goto('/');
  await importUsability(page, 'data', data);
  await dataProjection(page, 'Timeline');
  const first = page.getByRole('button', { name: 'Dates for First period', exact: true });
  const second = page.getByRole('button', { name: 'Dates for Second period', exact: true });
  await first.focus();
  await second.click();
  await expect(second).toBeFocused();
  expect((await nativeArtifact(page)).draft.content).toEqual(data);
  const box = (await second.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 55, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(second).toBeFocused();
  const dragged = (await nativeArtifact(page)).draft.content as StructuredData;
  expect(dragged.rows[0]).toEqual(data.rows[0]);
  expect(dragged.rows[1].values.start).not.toBe(data.rows[1].values.start);
  await second.focus();
  await page.keyboard.press('ArrowRight');
  const keyed = (await nativeArtifact(page)).draft.content as StructuredData;
  expect(keyed.rows[0]).toEqual(data.rows[0]);
  expect(keyed.rows[1].values.start).not.toBe(dragged.rows[1].values.start);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(dragged);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(data);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(dragged);
});

test('#63 #64 Dashboard first Undo restores widget, save flushes named view and last projection survives re-open/reload', async ({
  page,
}) => {
  const data = auditData();
  await page.goto('/');
  await importUsability(page, 'data', data, 'Dashboard audit');
  await expect(page.locator('.ep-widget')).toHaveCount(3);
  await page.getByRole('button', { name: 'Delete widget 3', exact: true }).click();
  await expect(page.locator('.ep-widget')).toHaveCount(2);
  await expect(page.locator('.save-status')).toContainText('未確定');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.ep-widget')).toHaveCount(3);
  expect(((await nativeArtifact(page)).draft.content as StructuredData).views![0].name).toBe(
    'Audit dashboard',
  );
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.locator('.ep-widget')).toHaveCount(2);
  await save(page, 1);
  const saved = (await nativeArtifact(page)).draft.content as StructuredData;
  expect(saved.views![0].widgets).toHaveLength(2);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.ep-widget')).toHaveCount(3);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.locator('.ep-widget')).toHaveCount(2);
  await dataProjection(page, 'Timeline');
  await create(page, 'document');
  await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page.getByRole('button', { name: /Dashboard audit/ }).click();
  await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await expect(page.getByLabel('Data projection')).toHaveValue('Timeline');
  await page.reload();
  await expect(page.getByLabel('Data projection')).toHaveValue('Timeline');
  await dataProjection(page, 'Dashboard');
  await expect(page.locator('.ep-widget')).toHaveCount(2);
});

test('#66 #72 native and Host CSV share range/counts, Chart exposes distinct series and an aggregate table', async ({
  page,
}, info) => {
  await page.goto('/');
  await importUsability(page, 'data', auditData());
  await page.getByLabel('Search records', { exact: true }).fill('period');
  await dataProjection(page, 'Chart');
  const image = page.getByRole('img', { name: /Data chart:/ });
  await expect(image).toHaveAttribute(
    'aria-label',
    /Plan \/ Alpha: 40.*Plan \/ Beta: 50.*Ready \/ Alpha: 80/,
  );
  await page.getByText('Chart aggregate table / 集計表', { exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('table').getByText('Sum of displayed aggregates')).toBeVisible();
  await expect(
    page.getByRole('table').getByRole('cell', { name: '170', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Search records', { exact: true }).fill('Beta');
  await page.getByRole('button', { name: 'Export data', exact: true }).click();
  await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'CSV export scope' })).toContainText('1 records');
  const native = await csvDownload(page);
  expect(native).not.toContain('Note');
  expect(native).toContain('Second period');
  expect(native).not.toContain('Third period');
  await page.getByRole('button', { name: 'Export artifact', exact: true }).click();
  await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
  const host = await csvDownload(page);
  expect(host).toBe(native);
  await page.getByRole('button', { name: 'Export data', exact: true }).click();
  await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
  const all = await csvDownload(page, 'all', 'all');
  expect(all).toContain('日本語,""引用""');
  expect(all).toContain('改行\n本文');
  await page.screenshot({ path: info.outputPath('chart-accessible-table.png') });
});

test('#67 CSV append previews target number/Select/Relation diagnostics and cancel leaves existing data intact', async ({
  page,
}) => {
  const data = auditData();
  await page.goto('/');
  await importUsability(page, 'data', data);
  await page.getByLabel('Import CSV file', { exact: true }).setInputFiles({
    name: 'bad.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Name,Value,State,Related\n新規,wrong,Unknown,missing\n'),
  });
  const dialog = page.getByRole('dialog', { name: 'CSV import preview' });
  await expect(dialog).toContainText('Row 2, field 2 Value');
  await expect(dialog).toContainText('Row 2, field 3 State');
  await expect(dialog).toContainText('Row 2, field 4 Related');
  await expect(dialog.getByRole('button', { name: 'Import records', exact: true })).toBeDisabled();
  await expect(dialog.getByLabel('Append target Value')).toHaveValue('value');
  await page.getByRole('button', { name: 'Close CSV import preview', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(data);
  await page.getByLabel('Import CSV file', { exact: true }).setInputFiles({
    name: 'good.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Name,Value,State,Related\n新規,3,Plan,first\n'),
  });
  await dialog.getByRole('button', { name: 'Import records', exact: true }).click();
  expect(((await nativeArtifact(page)).draft.content as StructuredData).rows).toHaveLength(4);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(data);
});

test('#58 #65 File replacement explains annotation impact, cancel/Undo preserve source and UTF-16 originals remain byte-identical', async ({
  page,
}) => {
  await page.goto('/');
  await create(page, 'file');
  await page.getByRole('button', { name: 'File line 1', exact: true }).click();
  await comments(page);
  await page.getByPlaceholder('Leave a note on this selection…').fill('原本への注釈');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await page.getByRole('button', { name: 'Close comments', exact: true }).click();
  const beforeReplacement = await nativeArtifact(page);
  const original = beforeReplacement.draft.content;
  await page.getByRole('button', { name: 'Replace source', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Replace source' })).toContainText(
    '1 annotations may become Orphan',
  );
  await page.getByRole('button', { name: 'Cancel replacement', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(original);
  const text = '日本語\n二行目\n終わり';
  const bytes = Buffer.concat([Buffer.from([255, 254]), Buffer.from(text, 'utf16le')]);
  await sourceReplacement(page, bytes, 'utf16.txt', 'text/plain');
  await page.getByRole('button', { name: 'Confirm source replacement', exact: true }).click();
  await expect(page.getByText('二行目', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: '原本への注釈 · Orphan', exact: true }),
  ).toBeVisible();
  expect((await nativeArtifact(page)).annotations).toEqual(beforeReplacement.annotations);
  const replaced = (await nativeArtifact(page)).draft.content as FileContent;
  expect(Buffer.from(originalBytes(replaced))).toEqual(bytes);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(original);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(replaced);
  await save(page, 1);
  await page.reload();
  expect((await nativeArtifact(page)).draft.content).toEqual(replaced);
  await sourceReplacement(page, Buffer.from([255]), 'invalid.txt', 'text/plain');
  await expect(page.getByRole('dialog', { name: 'Replace source' })).toContainText('UTF-8に変換');
  await page.getByRole('button', { name: 'Cancel replacement', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(replaced);
});

test('#55 #56 Review clears Host selection on file/source switch and resolves a saved old version instead of silently jumping', async ({
  page,
}) => {
  const review = createReview();
  await page.goto('/');
  await importUsability(page, 'review', review);
  await save(page, 1);
  await page
    .getByRole('button', { name: /added new line 2/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByRole('button', { name: /Comments \(/ }).click();
  await page.keyboard.press('Escape');
  await page.getByPlaceholder('Leave a note on this selection…').fill('版に固定したコメント');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await page
    .locator('.ep-review-nav')
    .getByRole('button', { name: review.files[1].name, exact: true })
    .click();
  await expect(page.getByRole('button', { name: 'Add comment', exact: true })).toBeDisabled();
  await page
    .locator('.ep-review-nav')
    .getByRole('button', { name: review.files[0].name, exact: true })
    .click();
  await page.getByRole('button', { name: 'Comparison sources', exact: true }).click();
  await page.getByLabel('New text', { exact: true }).fill('追加行\n' + review.files[0].newText);
  await page.getByRole('button', { name: 'Apply comparison sources', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add comment', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Close comments', exact: true }).click();
  await page
    .locator('.ep-review-info')
    .getByRole('button', { name: /版に固定したコメント.*Outdated/ })
    .click();
  await expect(page.getByRole('dialog', { name: 'Annotation source version' })).toContainText(
    review.files[0].name,
  );
  await expect(
    page.getByRole('dialog', { name: 'Annotation source version' }).locator('pre'),
  ).toHaveText(review.files[0].newText);
  await expect(
    page.getByRole('dialog', { name: 'Annotation source version' }).locator('mark'),
  ).toHaveText(review.files[0].newText.split('\n')[1]);
  await page.getByRole('button', { name: 'Close Annotation source version', exact: true }).click();
  await page
    .getByRole('button', { name: /added new line 1/ })
    .first()
    .click();
  await page
    .getByRole('button', { name: 'Remap annotation to selected current lines', exact: true })
    .click();
  const updated = await nativeArtifact(page);
  expect(updated.annotations[0].anchor.addresses[0].region).toMatchObject({
    revisionId: (updated.draft.content as ReviewContent).files[0].newRevision,
    start: 1,
  });
});

test('#57 #59 #60 Document PDF preserves Japanese extraction and heading-next layout; File searches/selects text without rewriting bytes', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  await page.goto('/');
  const document = auditDocument();
  document.blocks = [
    {
      id: 'code',
      type: 'code',
      text: Array.from({ length: 40 }, (_, i) => `記録行${i + 1}`).join('\n'),
    },
    { id: 'section', type: 'heading', level: 3, text: '次の図の見出し' },
    {
      id: 'figure',
      type: 'image',
      text: '',
      src: `data:image/png;base64,${(await readFile('tests/fixtures/office/images/quadrants.png')).toString('base64')}`,
      width: 240,
      alt: '図の内容',
    },
    ...auditDocument().blocks,
    { id: 'repeat', type: 'paragraph', text: '日本語の監査：同ページの二つ目の検索結果' },
    {
      id: 'checklist',
      type: 'check-list',
      text: '確認する本文',
      items: [{ id: 'check-item', rich: [{ text: '確認する本文' }], checked: true }],
    },
  ];
  await importUsability(page, 'document', document);
  await page.getByRole('button', { name: 'Export document', exact: true }).click();
  await page.getByRole('button', { name: 'Print preview', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'Document print preview' });
  await expect(preview.getByRole('img')).toHaveCount(2);
  await page.screenshot({ path: info.outputPath('heading-next-preview.png') });
  await page.getByRole('button', { name: 'Close Document print preview', exact: true }).click();
  await page.getByRole('button', { name: 'Export document', exact: true }).click();
  await expect(page.getByText(/Tagged PDFは未対応/)).toBeVisible();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  const downloaded = await pending;
  const pdfPath = info.outputPath('searchable-document.pdf');
  await downloaded.saveAs(pdfPath);
  const extracted = execFileSync('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8' });
  expect(extracted).toContain('日本語の監査');
  expect(extracted).toContain('検索してコピーする本文');
  expect(extracted).toContain('活動');
  expect(extracted).toContain('[x] 確認する本文');
  expect(extracted.split('\f')[0]).not.toContain('次の図の見出し');
  expect(extracted.split('\f')[1]).toContain('次の図の見出し');
  expect((await nativeArtifact(page)).draft.content).toEqual(document);
  await create(page, 'file');
  const bytes = await readFile(pdfPath);
  await sourceReplacement(page, bytes, 'searchable.pdf', 'application/pdf');
  await page.getByRole('button', { name: 'Confirm source replacement', exact: true }).click();
  await expect(page.getByLabel('Rendered PDF page 1')).toHaveAttribute('data-rendered', 'true');
  await page.getByLabel('Search PDF text').fill('日本語の監査');
  await page.getByRole('button', { name: 'Next PDF text match', exact: true }).click();
  await expect(page.getByLabel('PDF page', { exact: true })).toHaveValue('2');
  await expect(page.locator('.ep-pdf-text-layer')).toContainText('日本語の監査');
  await expect(page.locator('[data-pdf-match]')).not.toHaveCount(0);
  const activeMatch = page.locator('[data-pdf-active-match]').first();
  await expect(activeMatch).toBeVisible();
  const firstMatchPosition = await activeMatch.getAttribute('style');
  await page.getByRole('button', { name: 'Next PDF text match', exact: true }).click();
  await expect(activeMatch).not.toHaveAttribute('style', firstMatchPosition!);
  await page.locator('.ep-pdf-text-layer').evaluate((element) => {
    const range = window.document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  expect(await page.evaluate(() => window.getSelection()?.toString())).toContain('日本語の監査');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.keyboard.press('Control+c');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('日本語の監査');
  const file = (await nativeArtifact(page)).draft.content as FileContent;
  expect(Buffer.from(originalBytes(file))).toEqual(bytes);
  await page.screenshot({ path: info.outputPath('pdf-text-search-selection.png') });
});

test('#69 Whiteboard endpoint handles win hit testing over stickies, show candidates and cancel/Undo keep node geometry', async ({
  page,
}, info) => {
  const a = {
    ...makeWhiteboardNode('sticky'),
    id: 'first',
    text: 'First',
    bounds: { x: 50, y: 100, width: 180, height: 140 },
  };
  const b = {
    ...makeWhiteboardNode('sticky'),
    id: 'second',
    text: 'Second',
    bounds: { x: 330, y: 100, width: 180, height: 140 },
  };
  const c = {
    ...makeWhiteboardNode('sticky'),
    id: 'third',
    text: 'Third',
    bounds: { x: 330, y: 300, width: 180, height: 140 },
  };
  const board: WhiteboardContent = {
    schemaVersion: 3,
    nodes: [a, b, c],
    connectors: [
      {
        id: 'edge',
        from: 'first',
        to: 'second',
        label: 'Connection',
        fromPort: 'right',
        toPort: 'left',
      },
    ],
  };
  await page.goto('/');
  await importUsability(page, 'whiteboard', board);
  const point = await page
    .locator('[data-testid="board-connector"] path')
    .last()
    .evaluate((element) => {
      const path = element as SVGPathElement;
      const p = path.getPointAtLength(path.getTotalLength() / 2);
      const screen = new DOMPoint(p.x, p.y).matrixTransform(path.getScreenCTM()!);
      return { x: screen.x, y: screen.y };
    });
  await page.mouse.click(point.x, point.y);
  const handle = page.getByRole('button', { name: 'Move connector to', exact: true });
  await expect(handle).toBeVisible();
  expect(
    await handle.evaluate((element) => {
      const r = element.getBoundingClientRect();
      return document
        .elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
        ?.getAttribute('aria-label');
    }),
  ).toBe('Move connector to');

  // Native canvas node hit targets expose stable ID through data-target.
  const to = page.locator('[data-canvas-target="third"]');
  const start = (await handle.boundingBox())!,
    candidate = (await to.boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(candidate.x + candidate.width / 2, candidate.y + candidate.height / 2, {
    steps: 5,
  });
  await expect(page.getByTestId('connector-candidate')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.getByTestId('connector-candidate')).toHaveCount(0);
  expect((await nativeArtifact(page)).draft.content).toEqual(board);
  await dragBetween(page, handle, to);
  const moved = (await nativeArtifact(page)).draft.content as WhiteboardContent;
  expect(moved.nodes).toEqual(board.nodes);
  expect(moved.connectors[0].to).toBe('third');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(board);
  await page.screenshot({ path: info.outputPath('whiteboard-endpoint-overlay.png') });
});

test('#70 Design preset explains Hug, applies exact dimensions and controlled selection follows Undo/Redo', async ({
  page,
}) => {
  const frame = {
    ...makeDesignElement('frame'),
    id: 'frame',
    name: 'Audit frame',
    bounds: { x: 40, y: 40, width: 800, height: 600 },
    layout: {
      direction: 'column' as const,
      gap: 16,
      padding: 16,
      align: 'start' as const,
      sizing: 'hug' as const,
    },
  };
  const child = {
    ...makeDesignElement('rectangle'),
    id: 'child',
    name: 'Wide child',
    parentId: 'frame',
    bounds: { x: 56, y: 56, width: 840, height: 80 },
  };
  const design = layoutDesign({ ...createDesign(), elements: [frame, child] });
  await page.goto('/');
  await importUsability(page, 'design', design);
  await page.getByRole('button', { name: 'Audit frame', exact: true }).click();
  await page.getByLabel('Frame preset').selectOption('390x844');
  const dialog = page.getByRole('dialog', { name: 'Frame preset constraints' });
  await expect(dialog).toContainText('Hug');
  await dialog.getByRole('button', { name: 'Use fixed frame size', exact: true }).click();
  await expect(page.getByLabel('Frame preset')).toHaveValue('390x844');
  const updated = (await nativeArtifact(page)).draft.content as DesignContent;
  expect(updated.elements[0].bounds).toMatchObject({ width: 390, height: 844 });
  expect(updated.elements[1].bounds.width).toBe(840);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByLabel('Frame preset')).toHaveValue('');
  expect((await nativeArtifact(page)).draft.content).toEqual(design);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.getByLabel('Frame preset')).toHaveValue('390x844');
});

test('#46 D23 ordinary PNG gets native HTML semantics/alt and diagnostic navigation, retains settings after save/reload and exports React', async ({
  page,
}) => {
  await authorDesignReact(page);
  await layer(page, 'Product');
  await page
    .getByLabel('Insert image file', { exact: true })
    .setInputFiles('tests/fixtures/office/images/quadrants.png');
  await page.getByLabel('Layer name', { exact: true }).fill('Audit ordinary PNG');
  await page.getByLabel('Layer name', { exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Review React export', exact: true }).click();
  await page
    .getByRole('button', { name: 'Edit HTML semantics Audit ordinary PNG', exact: true })
    .click();
  await expect(page.getByLabel('Element HTML meaning')).toBeVisible();
  await page.getByLabel('Element HTML meaning').selectOption('img');
  await page.getByLabel('Image alt text', { exact: true }).fill('日本語の画像説明');
  await page.getByLabel('Image alt text', { exact: true }).press('Enter');
  await save(page, 1);
  await page.reload();
  await layer(page, 'Audit ordinary PNG');
  await expect(page.getByLabel('Element HTML meaning')).toHaveValue('img');
  await expect(page.getByLabel('Image alt text')).toHaveValue('日本語の画像説明');
  await page.getByRole('button', { name: 'Review React export', exact: true }).click();
  await page.getByRole('button', { name: 'Accept reviewed conversion', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download React bundle', exact: true }).click();
  const bundle = unzipSync(await readFile((await (await pending).path())!));
  expect(
    Object.entries(bundle)
      .filter(([path]) => path.endsWith('.tsx'))
      .map(([, bytes]) => strFromU8(bytes))
      .join('\n'),
  ).toContain('img');
  expect(
    Object.entries(bundle)
      .filter(([path]) => path.endsWith('.tsx'))
      .map(([, bytes]) => strFromU8(bytes))
      .join('\n'),
  ).toContain('日本語の画像説明');
});

test('PR #52 rejected CommitInput stays dirty and blocks independent Host flush', async ({
  page,
}) => {
  await page.goto('/embed.html?rejected-input=1');
  await page.getByLabel('Rejected field', { exact: true }).fill('retained rejected value');
  await page.getByRole('button', { name: 'Host flush inputs', exact: true }).focus();
  await page.getByRole('button', { name: 'Host flush inputs', exact: true }).click();
  await expect(page.getByLabel('Rejected field')).toHaveValue('retained rejected value');
  await expect(page.getByLabel('Rejected input observed')).toHaveText('retained rejected value');
  await expect(page.locator('.embed-controls output')).toContainText('変更を確定できません');
  await expect(page.getByLabel('Rejected field')).toBeFocused();
});

test('PR #52 invalid pending input blocks native import before any library creation', async ({
  page,
}) => {
  await page.goto('/');
  await importUsability(page, 'data', auditData());
  await dataProjection(page, 'Form');
  await page.getByLabel('Record Value', { exact: true }).fill('invalid number');
  const names = await page.locator('.library nav button').allTextContents();
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'blocked.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify(createArtifact('document', 'Unexpected import', auditDocument())),
    ),
  });
  await expect(page.getByLabel('Record Value')).toHaveValue('invalid number');
  await expect(page.getByLabel('Artifact name')).not.toHaveValue('Unexpected import');
  expect(await page.locator('.library nav button').allTextContents()).toEqual(names);
  await expect(page.locator('.error-banner')).toContainText('Enter a number');
});

test('PR #52 duplicate slide blocks composition without changing active slide or canonical content', async ({
  page,
}) => {
  const deck = createDeck();
  deck.slides[0].objects = [
    {
      ...makeSlideObject('text', 0),
      id: 'text',
      text: 'Original',
      bounds: { x: 80, y: 80, width: 300, height: 100 },
    },
  ];
  await page.goto('/');
  await importUsability(page, 'slide', deck);
  await page.getByRole('button', { name: 'text object 1', exact: true }).dblclick();
  const input = page.getByRole('textbox', { name: 'Edit canvas text', exact: true });
  await input.dispatchEvent('compositionstart', { data: '変換' });
  await page.getByRole('button', { name: 'Duplicate slide', exact: true }).click();
  await expect(page.getByLabel('Current page')).toHaveValue('1');
  await expect(input).toBeVisible();
  await expect(page.locator('.surface-error')).toContainText('入力変換');
  await input.dispatchEvent('compositionend', { data: '' });
  await input.press('Escape');
  expect(((await nativeArtifact(page)).draft.content as SlideContent).slides).toHaveLength(
    deck.slides.length,
  );
});

test('#68 independent Host Office capabilities disable each unavailable format while Document readonly and clear-selection notification work', async ({
  page,
}) => {
  await page.goto('/embed.html?no-office=1');
  await page.getByLabel('Surface', { exact: true }).selectOption('slide');
  await page.getByRole('button', { name: 'Export visual', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Export PPTX', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Export PPTX', exact: true })).toHaveAttribute(
    'title',
    /Host/,
  );
  await page.keyboard.press('Escape');
  await page.getByLabel('Surface', { exact: true }).selectOption('document');
  await page.getByRole('button', { name: 'Export document', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Export DOCX', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.getByLabel('Read only', { exact: true }).check();
  await expect(page.getByRole('textbox', { name: 'Document body' })).toHaveAttribute(
    'aria-readonly',
    'true',
  );
  await page.getByLabel('Surface', { exact: true }).selectOption('review');
  await page
    .getByRole('button', { name: /added new line 2/ })
    .first()
    .click();
  await page
    .locator('.ep-review-nav')
    .getByRole('button', { name: 'notes.md', exact: true })
    .click();
  await expect(page.locator('.embed-controls output')).toContainText('Selection:');
});

test('#73 D04 native duplicate remaps only local annotation artifact IDs and preserves external references', async ({
  page,
}) => {
  await page.goto('/');
  const artifact = {
    ...createArtifact('document', 'Annotation import audit', auditDocument()),
    annotations: [
      {
        id: 'thread',
        createdAt: '2026-10-10T00:00:00Z',
        resolved: false,
        anchor: {
          addresses: [
            { artifactId: '', elementId: 'body', region: { type: 'text', start: 0, end: 2 } },
            { artifactId: 'external-artifact', elementId: 'external-node' },
          ],
        },
        comments: [
          {
            id: 'comment',
            author: 'Sample',
            body: '保持する注釈',
            createdAt: '2026-10-10T00:00:00Z',
          },
        ],
      },
    ],
  };
  artifact.annotations[0].anchor.addresses[0].artifactId = artifact.id;
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'annotations.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(artifact)),
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue(artifact.name);
  const imported = await nativeArtifact(page);
  expect(imported.id).not.toBe(artifact.id);
  expect(imported.annotations[0].anchor.addresses[0].artifactId).toBe(imported.id);
  expect(imported.annotations[0].anchor.addresses[1].artifactId).toBe('external-artifact');
  await page.reload();
  expect((await nativeArtifact(page)).annotations).toEqual(imported.annotations);
});

test('PR #52 unused native component publication validates its definition with no composition roots', async ({
  page,
}) => {
  await authorDesignReact(page);
  await layer(page, 'Product title');
  await page.getByRole('button', { name: 'Make component', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel publication settings', exact: true }).click();
  const design = (await nativeArtifact(page)).draft.content as DesignContent;
  const instance = design.elements.find((element) => element.name === 'Product title')!;
  const id = instance.componentId!;
  design.elements = design.elements.filter((element) => element.componentId !== id);
  await importUsability(page, 'design', design, 'Unused definition audit');
  await page.getByRole('button', { name: 'Components', exact: true }).click();
  await page.getByRole('button', { name: 'React公開設定 Product title', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'React component publication' });
  await expect(
    dialog.getByRole('button', { name: 'Save React publication settings', exact: true }),
  ).toBeEnabled();
  await dialog
    .getByRole('button', { name: 'Save React publication settings', exact: true })
    .click();
  const published = (await nativeArtifact(page)).draft.content as DesignContent;
  expect(published.components.find((component) => component.id === id)?.web?.version).toBe('1.0.0');
  expect(published.elements.some((element) => element.componentId === id)).toBe(false);
});

test('PR #52 Host CSV commits pending Form values before capturing canonical output', async ({
  page,
}) => {
  await page.goto('/');
  await importUsability(page, 'data', auditData());
  await dataProjection(page, 'Form');
  await page.getByLabel('Record Value', { exact: true }).fill('73');
  await page.getByRole('button', { name: 'Export artifact', exact: true }).click();
  await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
  const csv = await csvDownload(page, 'all', 'all');
  expect(csv).toContain('First period,73');
  expect(((await nativeArtifact(page)).draft.content as StructuredData).rows[0].values.value).toBe(
    73,
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(((await nativeArtifact(page)).draft.content as StructuredData).rows[0].values.value).toBe(
    40,
  );
});
