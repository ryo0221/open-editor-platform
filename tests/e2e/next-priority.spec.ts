import { test, expect, create, save, nativeArtifact } from './fixtures';
import type { Page } from '@playwright/test';
import type { SlideContent } from '@editor-platform/slide/model';
import type { ReactUiDocument } from '@editor-platform/react-ui-core';

async function action(page: Page, name: string) {
  const button = page.getByRole('button', { name, exact: true });
  if (!(await button.isVisible()))
    await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await button.click();
  await page.keyboard.press('Escape');
}
test('version confirmation distinguishes opening from saving and retains cancellation', async ({
  page,
}) => {
  await page.goto('/');
  await create(page, 'slide');
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Save immutable version', exact: true });
  await expect(dialog.getByRole('button', { name: 'この版を保存', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  expect((await nativeArtifact(page)).versions).toHaveLength(0);
  await save(page, 1);
  expect((await nativeArtifact(page)).versions).toHaveLength(1);
});
test('opening embed discovers saved sources and places one with the fixed default', async ({
  page,
}, info) => {
  await page.goto('/');
  await create(page, 'data');
  await save(page, 1);
  const source = await nativeArtifact(page);
  await create(page, 'slide');
  const embed = page.getByRole('button', { name: '参照を埋め込む', exact: true });
  if (!(await embed.isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await embed.click();
  const dialog = page.getByRole('dialog', { name: '参照を埋め込む', exact: true });
  await expect(dialog.getByLabel('埋め込みの参照元').locator('option')).not.toHaveCount(1);
  await expect(dialog.getByLabel('埋め込みの更新方式')).toHaveValue('fixed');
  await dialog.getByRole('button', { name: '参照を配置', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '参照を配置', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  const output = (await nativeArtifact(page)).draft.content as SlideContent;
  expect(output.slides[0].objects[0].reference).toMatchObject({
    mode: 'fixed',
    source: { artifactId: source.id },
  });
  await page.screenshot({ path: info.outputPath('automatic-reference-discovery.png') });
});
test('Japanese samples explain data-bound text and open its editable preview input', async ({
  page,
}, info) => {
  await page.goto('/');
  await create(page, 'react-ui');
  await page
    .getByRole('button', { name: 'Load example 製品ページ（日本語）', exact: true })
    .click();
  const preview = page.frameLocator('iframe[title="React component preview"]');
  await expect(preview.getByText('色からはじまる、新しい体験', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'title · Text', exact: true }).click();
  await expect(page.getByLabel('Prop text', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'プレビュー入力を編集: title', exact: true }).click();
  const input = page.getByLabel('Preview input title', { exact: true });
  await expect(input).toBeFocused();
  await input.fill('日本語のプレビュー入力を編集');
  await input.press('Enter');
  await expect(preview.getByText('日本語のプレビュー入力を編集', { exact: true })).toBeVisible();
  await action(page, 'Undo');
  await expect(preview.getByText('色からはじまる、新しい体験', { exact: true })).toBeVisible();
  await action(page, 'Redo');
  await save(page, 1);
  await page.reload();
  await expect(preview.getByText('日本語のプレビュー入力を編集', { exact: true })).toBeVisible();
  const native = (await nativeArtifact(page)).draft.content as ReactUiDocument;
  expect(native.nodes.find((node) => node.id === 'title')?.bindings.text).toEqual({
    kind: 'data',
    input: 'title',
    path: [],
  });
  await page.screenshot({ path: info.outputPath('bound-text-preview-input.png'), fullPage: true });
  await page
    .getByRole('button', { name: 'Load example お問い合わせ（日本語）', exact: true })
    .click();
  await page.getByRole('button', { name: 'Interact', exact: true }).click();
  await expect(preview.locator('[data-preview-mode="interact"]')).toBeVisible();
  await preview.getByRole('textbox', { name: 'お名前', exact: true }).fill('利用者');
  await expect(preview.getByRole('textbox', { name: 'お名前', exact: true })).toHaveValue('利用者');
  await preview.getByRole('button', { name: '送信する', exact: true }).click();
  await expect(preview.getByText('Thanks 利用者', { exact: true })).toBeVisible();
});
test('canvas vector text exposes the native string as an accessible description', async ({
  page,
}) => {
  await page.goto('/');
  await create(page, 'slide');
  const insert = page.getByRole('button', { name: 'Insert text', exact: true });
  if (!(await insert.isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await insert.click();
  await page.keyboard.press('Escape');
  const inspector = page.getByRole('button', { name: 'Toggle Slide inspector', exact: true });
  const text = page.getByLabel('Text', { exact: true });
  if (!(await text.isVisible())) await inspector.click();
  await text.fill('読み上げ対象の日本語テキスト');
  await text.press('Tab');
  await expect(
    page.getByRole('button', { name: 'text object 1', exact: true }),
  ).toHaveAccessibleDescription('読み上げ対象の日本語テキスト');
});

test('rejected preview inputs stay pending and nullable fixtures survive save/reload', async ({
  page,
}, info) => {
  await page.goto('/');
  await create(page, 'react-ui');
  await page
    .getByRole('button', { name: 'Load example 製品ページ（日本語）', exact: true })
    .click();
  const preview = page.frameLocator('iframe[title="React component preview"]');
  await expect(preview.getByText('色からはじまる、新しい体験', { exact: true })).toBeVisible();
  await page.getByText('Page data, callbacks & breakpoints', { exact: true }).click();
  const json = page.getByLabel('Page contract JSON', { exact: true });
  const contract = JSON.parse(await json.inputValue());
  contract.inputs.title.schema.maxLength = 40;
  contract.inputs.count = {
    required: false,
    schema: { type: 'number', minimum: 1, maximum: 20 },
    default: 2,
  };
  contract.inputs.nullFlag = {
    required: false,
    schema: { type: 'boolean', nullable: true },
    default: true,
  };
  contract.inputs.missingFlag = {
    required: false,
    schema: { type: 'boolean', nullable: true },
    default: true,
  };
  contract.inputs.nullText = {
    required: false,
    schema: { type: 'string', nullable: true },
    default: 'default text',
  };
  contract.fixture.nullFlag = null;
  contract.fixture.nullText = null;
  await json.fill(JSON.stringify(contract));
  await page.getByRole('button', { name: 'Apply page contract', exact: true }).click();
  await expect(page.getByLabel('Preview input nullFlag', { exact: true })).not.toBeChecked();
  await expect(page.getByLabel('Preview input missingFlag', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Preview input nullText', { exact: true })).toHaveValue('');

  for (const [name, invalid, valid] of [
    ['title', 'x'.repeat(41), '確定した見出し'],
    ['count', '21', '12'],
  ]) {
    const input = page.getByLabel(`Preview input ${name}`, { exact: true });
    await input.fill(invalid);
    await input.press('Enter');
    await expect(input.locator('..').getByRole('alert')).toContainText('変更が拒否されました');
    await page.getByRole('button', { name: 'Save version', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Save immutable version', exact: true });
    await dialog.getByRole('button', { name: 'この版を保存', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: '変更を確定できません' })).toBeVisible();
    await expect(input).toHaveValue(invalid);
    await input.fill(valid);
    await input.press('Enter');
    await expect(input.locator('..').getByRole('alert')).toHaveCount(0);
  }
  await expect(preview.getByText('確定した見出し', { exact: true })).toBeVisible();
  await save(page, 1);
  const saved = await nativeArtifact(page);
  expect((saved.draft.content as ReactUiDocument).fixture).toMatchObject({
    title: '確定した見出し',
    count: 12,
    nullFlag: null,
    nullText: null,
  });
  expect((saved.draft.content as ReactUiDocument).fixture).not.toHaveProperty('missingFlag');
  await page.reload();
  await page.getByText('Page data, callbacks & breakpoints', { exact: true }).click();
  await expect(page.getByLabel('Preview input nullFlag', { exact: true })).not.toBeChecked();
  await expect(page.getByLabel('Preview input missingFlag', { exact: true })).toBeChecked();
  expect((await nativeArtifact(page)).versions).toEqual(saved.versions);
  await page.screenshot({ path: info.outputPath('rejected-preview-input-recovery.png') });
});
