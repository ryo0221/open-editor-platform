import { test, expect, nativeArtifact, create } from './fixtures';
import { createWhole, artifactMenu, downloadText } from './template-fixtures';
import { prototypeImage } from './authored-image';
import { mkdir, writeFile } from 'node:fs/promises';

test('TP-Q09/10/13 text, list and image slots survive local reload, versioning and portable pack import', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(150000);
  page.setDefaultTimeout(12000);
  await page.goto('/');
  await createWhole(page, 'document', '議事録');
  const image = await prototypeImage(page);
  await page
    .getByLabel('Document image file')
    .setInputFiles({ name: 'portable-sample.png', mimeType: 'image/png', buffer: image });
  await expect(
    page
      .getByRole('textbox', { name: 'Document body' })
      .getByRole('img', { name: 'portable-sample.png' }),
  ).toBeVisible();
  const original = await nativeArtifact(page);
  await artifactMenu(page, 'テンプレートとして保存');
  const author = page.getByRole('dialog', { name: 'テンプレートとして保存', exact: true });
  await author.getByLabel('テンプレート名', { exact: true }).fill('画像付き再利用メモ');
  for (const [type, label, sample] of [
    ['text', '再利用の表題', '架空の打合せメモ'],
    ['list', '再利用の項目', '確認事項A\n確認事項B'],
    ['asset', '説明画像', ''],
  ] as const) {
    const slot = author
      .locator('.tp-slot')
      .filter({ hasText: `(${type})` })
      .first();
    await slot.getByRole('checkbox').check();
    await slot.getByRole('textbox', { name: /Slot label/ }).fill(label);
    if (type !== 'asset') await slot.getByRole('textbox', { name: /Slot sample/ }).fill(sample);
    else
      await slot
        .getByLabel(/Slot sample/)
        .setInputFiles({ name: 'portable-sample.png', mimeType: 'image/png', buffer: image });
  }
  await author.getByRole('button', { name: '保存内容をプレビュー', exact: true }).click();
  await expect(
    author.getByRole('button', { name: 'テンプレートを保存', exact: true }),
  ).toBeVisible();
  await mkdir('docs/screenshots/issue-4', { recursive: true });
  await author.screenshot({ path: 'docs/screenshots/issue-4/save-slots.png' });
  await author.getByRole('button', { name: 'テンプレートを保存', exact: true }).click();
  await expect(author).toHaveCount(0);
  expect((await nativeArtifact(page)).draft.content).toEqual(original.draft.content);
  await page.reload();
  await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page.getByRole('button', { name: 'テンプレートから作成', exact: true }).click();
  let gallery = page.getByRole('dialog', { name: 'テンプレートから作成', exact: true });
  await gallery.getByLabel('テンプレート検索', { exact: true }).fill('画像付き再利用メモ');
  await gallery
    .getByRole('button', { name: 'テンプレートを選択: 画像付き再利用メモ', exact: true })
    .click();
  await gallery.getByLabel('再利用の表題', { exact: false }).fill('入力し直した表題');
  const pack = await downloadText(page, 'packを書き出す'),
    definition = JSON.parse(pack).definitions[0];
  expect(definition.inputs.map((i: { type: string }) => i.type).sort()).toEqual([
    'asset',
    'list',
    'text',
  ]);
  expect(definition.assets.length).toBeGreaterThan(0);
  expect(definition.versions).toBeUndefined();
  expect(definition.annotations).toBeUndefined();
  await mkdir('docs/exports/issue-4', { recursive: true });
  await writeFile('docs/exports/issue-4/personal.template.json', pack);
  await gallery.getByRole('button', { name: '入力内容をプレビュー', exact: true }).click();
  await gallery.getByRole('button', { name: 'この内容で作成', exact: true }).click();
  await expect(gallery).toHaveCount(0);
  const created = await nativeArtifact(page);
  expect(JSON.stringify(created.draft.content)).toContain('入力し直した表題');
  expect(created.id).not.toBe(original.id);
  await artifactMenu(page, 'テンプレートとして保存');
  await author.getByLabel('テンプレート名', { exact: true }).fill('画像付き再利用メモ');
  await author.getByRole('button', { name: '既存テンプレートの新版を保存', exact: true }).click();
  await author
    .getByLabel('改訂元テンプレート', { exact: true })
    .selectOption(definition.templateId);
  await author.getByRole('button', { name: '保存内容をプレビュー', exact: true }).click();
  await author.getByRole('button', { name: 'テンプレートを保存', exact: true }).click();
  await expect(author).toHaveCount(0);
  expect((await nativeArtifact(page)).draft.content).toEqual(created.draft.content);
  await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page.getByRole('button', { name: 'テンプレートから作成', exact: true }).click();
  gallery = page.getByRole('dialog', { name: 'テンプレートから作成', exact: true });
  await gallery.getByLabel('テンプレート検索', { exact: true }).fill('画像付き再利用メモ');
  await gallery
    .getByRole('button', { name: 'テンプレートを選択: 画像付き再利用メモ', exact: true })
    .click();
  await expect(gallery.getByLabel('テンプレートの版', { exact: true })).toHaveValue('2');
  await gallery.getByLabel('テンプレートの版', { exact: true }).selectOption('1');
  await expect(gallery.getByLabel('再利用の表題', { exact: false })).toHaveValue(
    '架空の打合せメモ',
  );
  const otherContext = await browser.newContext({ baseURL }),
    other = await otherContext.newPage(),
    errors: string[] = [];
  other.on('pageerror', (e) => errors.push(e.message));
  other.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await other.goto('/template-host.html');
  await other.getByRole('button', { name: 'Galleryを開く', exact: true }).click();
  const imported = other.getByRole('dialog', { name: 'テンプレートから作成', exact: true });
  await imported.getByLabel('テンプレートpackを読み込む', { exact: true }).setInputFiles({
    name: 'personal.template.json',
    mimeType: 'application/json',
    buffer: Buffer.from(pack),
  });
  await imported
    .getByRole('button', { name: 'テンプレートを選択: 画像付き再利用メモ', exact: true })
    .click();
  await imported.getByRole('button', { name: '入力内容をプレビュー', exact: true }).click();
  await imported.getByRole('button', { name: 'この内容で作成', exact: true }).click();
  await expect(imported).toHaveCount(0);
  const result = other.getByRole('region', { name: 'Host result' });
  await expect(result.frameLocator('iframe').locator('body')).toContainText('架空の打合せメモ');
  await expect(result.frameLocator('iframe').getByRole('img')).toBeVisible();
  await otherContext.close();
  expect(errors).toEqual([]);
});
for (const domain of ['review', 'file'] as const) {
  test(`TP-Q14 ${domain}: private view preset preserves source content and persists settings`, async ({
    page,
  }) => {
    page.setDefaultTimeout(12000);
    await page.goto('/');
    await create(page, domain);
    const before = await nativeArtifact(page);
    await artifactMenu(page, 'スタイル・表示プリセット');
    const dialog = page.getByRole('dialog', { name: 'スタイル・表示プリセット', exact: true });
    await dialog
      .getByRole('button', {
        name: `テンプレートを選択: ${domain === 'review' ? '読みやすい差分表示' : 'ページに合わせて表示'}`,
        exact: true,
      })
      .click();
    if (domain === 'review') await dialog.locator('[data-slot="split"]').uncheck();
    else await dialog.locator('[data-slot="fit"]').selectOption('width');
    await dialog.locator('[data-slot="annotations"]').uncheck();
    await dialog.getByRole('button', { name: '入力内容をプレビュー', exact: true }).click();
    await dialog.getByRole('button', { name: 'この設定を適用', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect((await nativeArtifact(page)).draft.content).toEqual(before.draft.content);
    await page.reload();
    expect((await nativeArtifact(page)).draft.content).toEqual(before.draft.content);
    const settings = await page.evaluate(
      (id) => JSON.parse(localStorage.getItem('ep-template-view-settings')!)[id],
      before.id,
    );
    expect(settings.annotations).toBe(false);
    expect(domain === 'review' ? settings.split : settings.fit).toBe(
      domain === 'review' ? false : 'width',
    );
  });
}
