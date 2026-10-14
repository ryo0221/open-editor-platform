import type { Page, Locator } from '@playwright/test';
import { expect, nativeArtifact, setDocumentText } from './fixtures';
import { openImport, ready } from './office-import-fixtures';
import { artifactMenu, downloadText } from './template-fixtures';
import { prototypeImage } from './authored-image';
import type { TemplateDefinition } from '@editor-platform/templates';
export type ReuseDomain = 'slide' | 'document';
export async function visibleTemplateFailure(dialog: Locator) {
  const alert = dialog.getByRole('alert');
  await expect(alert).toBeFocused();
  await expect
    .poll(() =>
      alert.evaluate((node) => {
        const box = node.getBoundingClientRect(),
          host = node.closest('dialog')!,
          heading = host.querySelector('.ep-dialog-heading')!.getBoundingClientRect();
        return box.top >= heading.bottom && box.bottom <= host.getBoundingClientRect().bottom;
      }),
    )
    .toBe(true);
}
export async function importForReuse(page: Page, domain: ReuseDomain) {
  const dialog = await openImport(page);
  if (domain === 'slide') await ready(dialog);
  else {
    await dialog
      .getByLabel('Office file', { exact: true })
      .setInputFiles('tests/fixtures/office/import/document/external.docx');
    await dialog.getByLabel('Import conversion policy').selectOption('review-conversions');
    await dialog.getByRole('button', { name: 'Prepare import preview', exact: true }).click();
    await expect(dialog.getByLabel('Accept import conversions')).toBeEnabled({ timeout: 30000 });
  }
  await dialog.getByLabel('Accept import conversions').check();
  await dialog.getByRole('button', { name: 'Create imported artifact', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
export async function changeReuseHeading(
  page: Page,
  domain: ReuseDomain,
  current: string,
  next: string,
) {
  if (domain === 'document') await setDocumentText(page, 'h1', next);
  else {
    await page
      .getByRole('application', { name: 'Slide canvas', exact: true })
      .getByRole('button')
      .filter({ hasText: current })
      .dblclick();
    const text = page.getByRole('textbox', { name: 'Edit canvas text', exact: true });
    await text.press('Control+a');
    await page.keyboard.insertText(next);
    await text.press('Control+Enter');
  }
}
export async function authorForReuse(page: Page, domain: ReuseDomain, name: string) {
  await changeReuseHeading(
    page,
    domain,
    domain === 'slide' ? '外部作成の受付改善資料' : '外部作成の受付改善提案書',
    '修正した社内提案書',
  );
  const original = await nativeArtifact(page),
    image = await prototypeImage(page);
  await artifactMenu(page, 'テンプレートとして保存');
  const dialog = page.getByRole('dialog', { name: 'テンプレートとして保存', exact: true });
  await dialog.getByLabel('テンプレート名', { exact: true }).fill(name);
  const title = dialog.locator('.tp-slot').filter({ hasText: '修正した社内提案書 (text)' });
  await title.getByRole('checkbox').check();
  await title.getByRole('textbox', { name: /Slot label/ }).fill('案件名');
  await title.getByRole('textbox', { name: /Slot sample/ }).fill('架空の提案');
  const list =
    domain === 'document'
      ? dialog.locator('.tp-slot').filter({ hasText: '(list)' }).first()
      : dialog.locator('.tp-slot').filter({ hasText: '受付 (text)' });
  await list.getByRole('checkbox').check();
  if (domain === 'slide') await list.getByLabel(/Slot type/).selectOption('list');
  await list.getByRole('textbox', { name: /Slot label/ }).fill('確認項目');
  await list.getByRole('textbox', { name: /Slot sample/ }).fill('確認');
  const asset = dialog.locator('.tp-slot').filter({ hasText: '(asset)' }).first();
  await asset.getByRole('checkbox').check();
  await asset.getByRole('textbox', { name: /Slot label/ }).fill('説明画像');
  await asset
    .getByLabel(/Slot sample/)
    .setInputFiles({ name: 'sample.png', mimeType: 'image/png', buffer: image });
  await dialog.getByRole('button', { name: '保存内容をプレビュー', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: 'テンプレートを保存', exact: true }),
  ).toBeVisible();
  return { dialog, original };
}
export async function reuseGallery(page: Page, name: string) {
  if (!(await page.getByRole('button', { name: 'テンプレートから作成', exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page.getByRole('button', { name: 'テンプレートから作成', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'テンプレートから作成', exact: true });
  await dialog.getByLabel('テンプレート検索', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: `テンプレートを選択: ${name}`, exact: true }).click();
  await expect
    .poll(() =>
      dialog
        .getByRole('img', { name: '説明画像の選択画像', exact: true })
        .evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0),
    )
    .toBe(true);
  return dialog;
}
export async function reusePack(page: Page) {
  const text = await downloadText(page, 'packを書き出す');
  return { text, definition: JSON.parse(text).definitions[0] as TemplateDefinition };
}
