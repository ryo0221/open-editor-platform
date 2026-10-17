import { test, expect, create, nativeArtifact, addRecord } from './fixtures';
import { commitVersion, createArtifact } from '@editor-platform/artifact-core';

test('CSV type preview is reversible, reports invalid cells and imports original quoted values', async ({
  page,
}) => {
  await page.goto('/');
  await create(page, 'data');
  const before = (await nativeArtifact(page)).draft.content;
  await page.getByLabel('Import CSV file').setInputFiles({
    name: 'typed.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'Code,Description,Date\r\n001,"日本語,メモ",2026-02-30\r\n002,"複数\n行",2026-10-03\r\n',
    ),
  });
  const dialog = page.getByRole('dialog', { name: 'CSV import preview' });
  await dialog.getByLabel('Append to matching fields').uncheck();
  await dialog.getByLabel('Import type Code').selectOption('text');
  await expect(dialog.getByRole('cell', { name: '001', exact: true })).toBeVisible();
  await dialog.getByLabel('Import type Code').selectOption('number');
  await dialog.getByLabel('Import type Code').selectOption('text');
  await expect(dialog.getByRole('cell', { name: '001', exact: true })).toBeVisible();
  await dialog.getByLabel('Import type Date').selectOption('date');
  const diagnostics = dialog.getByRole('status').getByRole('listitem');
  await expect(diagnostics).toHaveCount(1);
  await expect(diagnostics).toHaveText(
    'Row 2, field 3 Date · value "2026-02-30": Enter a valid date (YYYY-MM-DD). CSVまたは列対応を修正してください。',
  );
  await expect(dialog.getByRole('button', { name: 'Import records', exact: true })).toBeDisabled();
  await dialog.getByLabel('Import type Date').selectOption('text');
  await dialog.getByRole('button', { name: 'Import records', exact: true }).click();
  const content = (await nativeArtifact(page)).draft.content;
  expect(content).toMatchObject({
    columns: [
      { name: 'Code', type: 'text' },
      { name: 'Description' },
      { name: 'Date', type: 'text' },
    ],
  });
  expect(JSON.stringify(content)).toContain('001');
  expect(JSON.stringify(content)).toContain('複数\\n行');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(before);
});

test('Grid distinguishes a cell range from selected records and respects read-only deletion', async ({
  page,
}) => {
  await page.goto('/');
  await create(page, 'data');
  for (let i = 0; i < 4; i++) await addRecord(page);
  const before = (await nativeArtifact(page)).draft.content;
  await page.getByRole('rowheader', { name: 'Select record 2' }).click();
  await page.getByRole('rowheader', { name: 'Select record 3' }).click({ modifiers: ['Shift'] });
  await expect(page.getByRole('row', { selected: true })).toHaveCount(2);
  await page.getByRole('grid').press('Delete');
  const after = (await nativeArtifact(page)).draft.content;
  expect(after).toMatchObject({
    rows: [
      expect.objectContaining({ id: (before as { rows: { id: string }[] }).rows[0].id }),
      expect.objectContaining({ id: (before as { rows: { id: string }[] }).rows[3].id }),
    ],
  });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(before);
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByLabel('Read only', { exact: true }).check();
  await page.keyboard.press('Escape');
  await page.getByRole('rowheader', { name: 'Select record 2' }).click();
  await page.getByRole('grid').press('Delete');
  expect((await nativeArtifact(page)).draft.content).toEqual(before);
});

const legacy: Record<string, { content: unknown; elementId: string }> = {
  document: {
    content: {
      schemaVersion: 1,
      blocks: [{ id: 'legacy-text', type: 'paragraph', text: '旧版の日本語本文' }],
    },
    elementId: 'legacy-text',
  },
  data: {
    content: {
      schemaVersion: 1,
      columns: [
        { id: 'name', name: 'Name', type: 'text' },
        { id: 'qty', name: 'Quantity', type: 'number' },
      ],
      rows: [{ id: 'legacy-row', values: { name: '旧版の案件', qty: 12 } }],
    },
    elementId: 'legacy-row',
  },
  review: {
    content: {
      schemaVersion: 1,
      files: [{ id: 'legacy-file', name: 'notes.txt', oldText: '古い内容', newText: '新しい内容' }],
    },
    elementId: 'legacy-file',
  },
  file: {
    content: {
      schemaVersion: 1,
      id: 'legacy-file',
      name: 'notes.txt',
      mime: 'text/plain',
      size: 16,
      data: '旧版のログ\r\n次の行',
    },
    elementId: 'legacy-file',
  },
  design: {
    content: {
      schemaVersion: 1,
      elements: [
        {
          id: 'legacy-text',
          type: 'text',
          name: '旧版の文字',
          text: '旧版の図案',
          fill: '#253044',
          bounds: { x: 40, y: 40, width: 300, height: 100 },
        },
      ],
      components: [],
    },
    elementId: 'legacy-text',
  },
  slide: {
    content: {
      schemaVersion: 1,
      width: 960,
      height: 540,
      slides: [
        {
          id: 'legacy-page',
          title: '旧版のページ',
          background: '#ffffff',
          objects: [
            {
              id: 'legacy-text',
              type: 'text',
              text: '旧版の資料',
              fill: '#253044',
              bounds: { x: 40, y: 40, width: 300, height: 100 },
            },
          ],
        },
      ],
    },
    elementId: 'legacy-text',
  },
};
for (const [kind, fixture] of Object.entries(legacy))
  test(`Legacy ${kind} native import, reopen and roundtrip preserve committed hashes and annotation identity`, async ({
    page,
  }) => {
    const artifact = await commitVersion(
      createArtifact(kind, `Legacy ${kind}`, fixture.content),
      'legacy-author',
      'Keep this version',
    );
    const source = {
      ...artifact,
      annotations: [
        {
          id: 'thread',
          resolved: false,
          createdAt: '2026-10-01T00:00:00.000Z',
          anchor: { addresses: [{ artifactId: artifact.id, elementId: fixture.elementId }] },
          comments: [
            {
              id: 'comment',
              author: 'legacy-author',
              body: '保存するコメント',
              createdAt: '2026-10-01T00:00:00.000Z',
            },
          ],
        },
      ],
    };
    await page.goto('/');
    await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
      name: 'legacy.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(source)),
    });
    await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue(`Legacy ${kind}`);
    const imported = await nativeArtifact(page);
    expect(imported.draft.content).toEqual(fixture.content);
    expect(imported.versions.map((v) => [v.versionId, v.contentHash, v.content])).toEqual(
      source.versions.map((v) => [v.versionId, v.contentHash, v.content]),
    );
    expect(imported.annotations[0].anchor.addresses[0]).toEqual({
      artifactId: imported.id,
      elementId: fixture.elementId,
    });
    await page.reload();
    expect((await nativeArtifact(page)).draft.content).toEqual(fixture.content);
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
    await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
      name: 'roundtrip.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(imported)),
    });
    const again = await nativeArtifact(page);
    expect(again.id).not.toBe(imported.id);
    expect(again.draft.content).toEqual(fixture.content);
    expect(again.versions[0].contentHash).toBe(imported.versions[0].contentHash);
    expect(again.annotations[0].anchor.addresses[0]).toEqual({
      artifactId: again.id,
      elementId: fixture.elementId,
    });
  });
