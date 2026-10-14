import { test, expect, create, nativeArtifact, setDocumentText } from './fixtures';
import { reuseHistory, reuseMenu } from './reuse-fixtures';
import type { DocumentContent } from '@editor-platform/document/model';

test('R02/R07 normal rich form retains marks, isolates form Undo, archives and restores the library', async ({
  page,
}, info) => {
  test.setTimeout(150000);
  await page.goto('/');
  await create(page, 'document');
  await setDocumentText(page, 'p', '再利用する装飾');
  await reuseMenu(page, '再利用部品として保存');
  const author = page.getByRole('dialog', { name: '再利用部品として保存', exact: true });
  await author.getByRole('textbox', { name: '部品名', exact: true }).fill('書式付き注意書き');
  await author.getByRole('button', { name: '部品をプレビュー', exact: true }).click();
  const plain = author
    .locator('.tp-component-contract > details')
    .filter({ has: page.locator('summary', { hasText: '再利用する装飾（text）' }) });
  await plain.locator('summary').click();
  await plain
    .getByRole('button', { name: '「再利用する装飾」の公開をやめる', exact: true })
    .click();
  const partSelect = author.getByRole('combobox', { name: '対象の部品', exact: true });
  await partSelect.selectOption(
    (await partSelect
      .locator('option')
      .filter({ hasText: '再利用する装飾' })
      .getAttribute('value'))!,
  );
  await author.getByRole('combobox', { name: '公開する属性', exact: true }).selectOption('rich');
  await author.getByRole('button', { name: '入力を追加', exact: true }).click();
  await author.getByRole('button', { name: '部品をプレビュー', exact: true }).click();
  await author.getByRole('button', { name: '部品を公開', exact: true }).click();
  await reuseMenu(page, '部品ライブラリ');
  let library = page.getByRole('dialog', { name: '部品ライブラリ', exact: true });
  await library.getByRole('button', { name: '書式付き注意書き v1', exact: true }).click();
  const rich = library.locator('.tp-rich-input [role="textbox"]');
  await rich.fill('案件の装飾付き本文');
  await rich.press('ControlOrMeta+a');
  await library.getByRole('button', { name: '太字', exact: true }).click();
  await library.getByRole('button', { name: '変更をプレビュー', exact: true }).click();
  await library.getByRole('button', { name: 'プレビューした変更を適用', exact: true }).click();
  const inserted = (await nativeArtifact(page)).draft.content as DocumentContent;
  const body = inserted.blocks.find((b) => b.text === '案件の装飾付き本文')!;
  expect(body.rich).toEqual([{ text: '案件の装飾付き本文', bold: true }]);
  const outlineRow = page.locator('.ep-outline-item').filter({ hasText: body.text! });
  await outlineRow.click();
  await expect(outlineRow).toHaveClass(/active/);
  const selectedBlock = () =>
    page.evaluate(() =>
      window
        .getSelection()
        ?.anchorNode?.parentElement?.closest('[data-block-id]')
        ?.getAttribute('data-block-id'),
    );
  await expect.poll(selectedBlock).toBe(body.id);
  await page.reload();
  await outlineRow.click();
  await expect(outlineRow).toHaveClass(/active/);
  await expect.poll(selectedBlock).toBe(body.id);
  await reuseMenu(page, '部品の入力・表示');
  const inspector = page.getByRole('dialog', { name: '部品の入力・表示', exact: true });
  await inspector.getByRole('button', { name: '書式付き注意書き v1', exact: true }).click();
  const field = inspector.locator('.tp-rich-input [role="textbox"]');
  await expect(field.locator('strong')).toHaveText(body.text!);
  await field.press('ControlOrMeta+a');
  await inspector.getByRole('button', { name: '斜体', exact: true }).click();
  await expect(field.locator('em')).toHaveText(body.text!);
  await field.press('ControlOrMeta+z');
  await expect(field.locator('em')).toHaveCount(0);
  await expect(field.locator('strong')).toHaveText(body.text!);
  await inspector.getByRole('button', { name: '変更をプレビュー', exact: true }).click();
  await inspector.getByRole('button', { name: 'プレビューした変更を適用', exact: true }).click();
  const edited = (await nativeArtifact(page)).draft.content as DocumentContent;
  expect(edited.blocks).toEqual(inserted.blocks);
  await reuseHistory(page, 'Undo');
  expect((await nativeArtifact(page)).draft.content).toEqual(inserted);
  await reuseMenu(page, '部品ライブラリ');
  library = page.getByRole('dialog', { name: '部品ライブラリ', exact: true });
  await library.getByRole('button', { name: '書式付き注意書き v1', exact: true }).click();
  await library.getByRole('button', { name: '部品をアーカイブ', exact: true }).click();
  await expect(
    library.getByRole('button', { name: '書式付き注意書き v1', exact: true }),
  ).toHaveCount(0);
  await library.getByRole('button', { name: 'Close 部品ライブラリ', exact: true }).click();
  await page.reload();
  expect((await nativeArtifact(page)).draft.content).toEqual(inserted);
  await reuseMenu(page, '部品ライブラリ');
  library = page.getByRole('dialog', { name: '部品ライブラリ', exact: true });
  await library.getByRole('checkbox', { name: 'アーカイブ済みも表示', exact: true }).check();
  await library
    .getByRole('button', { name: '書式付き注意書き v1（アーカイブ済み）', exact: true })
    .click();
  await page.screenshot({ path: info.outputPath('rich-input-archived.png'), fullPage: true });
  await library.getByRole('button', { name: 'アーカイブから戻す', exact: true }).click();
  await expect(
    library.getByRole('button', { name: '書式付き注意書き v1', exact: true }),
  ).toBeVisible();
});
