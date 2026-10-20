import { test, expect, create, nativeArtifact, save } from './fixtures';
import {
  editNestedText,
  editPrimitiveTextFromInspector,
  assertPrimitiveLocks,
  assertCompositeStyleLocks,
  assertStyledHiddenGeometry,
} from './design-instance-text-fixtures';
import { nestedTextFixture } from '../fixtures/design-nested-text/content';
import { artifactMenu } from './template-fixtures';
import { exportTemplatePack, saveAsTemplate } from '@editor-platform/templates';
import { independentDesignReuse } from './design-reuse-graphics-fixtures';

test('#27 styled hidden elements stay outside canvas and export geometry', async ({
  page,
}, info) => {
  await assertStyledHiddenGeometry(page, info);
});

test('#27 primitive canvas edits remain editable from Inspector after reload', async ({
  page,
}, info) => {
  await editPrimitiveTextFromInspector(page, info);
});

test('#27 primitive shared and root locks prevent opening a text editor', async ({
  page,
}, info) => {
  await assertPrimitiveLocks(page, info);
});

test('#27 composite shared styles hide descendants and prevent locked text input', async ({
  page,
}, info) => {
  await assertCompositeStyleLocks(page, info);
});

test('#27 variable Design text overflow identifies the stable item in the ordinary form', async ({
  page,
}, info) => {
  await page.goto('/');
  await create(page, 'design');
  const before = await nativeArtifact(page);
  await artifactMenu(page, '部分テンプレートを挿入');
  const gallery = page.getByRole('dialog', { name: '部分テンプレートを挿入', exact: true });
  await gallery
    .getByRole('button', { name: 'テンプレートを選択: 可変比較・複合部品のフレーム', exact: true })
    .click();
  await gallery.locator('.tp-form-fields > details > summary').click();
  const body = gallery.locator('[data-slot="items.0.body"]');
  await body.fill('確認した内容を省略せずにすべて表示する必要がある。'.repeat(3));
  await gallery.getByRole('button', { name: '入力内容をプレビュー', exact: true }).click();
  await expect(gallery.locator('.tp-error[role="alert"]')).toContainText('Input does not fit');
  await expect(body).toHaveAttribute('aria-invalid', 'true');
  await expect(body.locator('..')).toContainText('Text exceeds the available box');
  await page.screenshot({ path: info.outputPath('design-repeat-overflow-field.png') });
  await page.keyboard.press('Escape');
  expect((await nativeArtifact(page)).draft.content).toEqual(before.draft.content);
});

test('#27 colliding Design drawing IDs still edit the selected native text part', async ({
  page,
}) => {
  const content = nestedTextFixture();
  content.components[1].elements![0].id = 'a-b';
  content.components[0].elements![0].id = 'c';
  content.components[1].elements!.push({
    ...content.components[0].elements![0],
    id: 'a-b-c',
    text: 'Sibling label',
    bounds: { x: 20, y: 180, width: 240, height: 40 },
  });
  await independentDesignReuse(page, content);
  const canvas = page.getByRole('application', { name: 'Design canvas', exact: true });
  await canvas.getByText('Sibling label', { exact: true }).first().dblclick();
  const editor = page.getByRole('textbox', { name: 'Edit canvas text', exact: true });
  await editor.press('Control+a');
  await page.keyboard.insertText('Exact sibling');
  await editor.press('Control+Enter');
  await expect(canvas.getByText('Exact sibling', { exact: true })).toHaveCount(1);
  await expect(canvas.getByText('Nested title', { exact: true })).toHaveCount(2);
  const native = JSON.parse((await page.getByTestId('reuse-native').textContent())!);
  expect(native.elements[0].overrides['a-b-c'].text).toBe('Exact sibling');
  expect(native.elements[0].overrides['a-b']).toBeUndefined();
});

test('#27 nested Design template: gallery creation, native edits and saved round trip', async ({
  page,
}, info) => {
  const content = nestedTextFixture();
  const definition = await saveAsTemplate({
    domain: 'design',
    content,
    kind: 'whole',
    name: 'Nested text cards',
    purpose: 'Nested component editing',
    category: 'test',
    slots: [],
    overflow: { policy: 'error', minFontSize: 10 },
  });
  const original = JSON.stringify(definition);
  const pack = await exportTemplatePack([definition]);
  await page.goto('/');
  await create(page, 'design');
  if (!(await page.getByLabel('Artifact type', { exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page.getByRole('button', { name: 'テンプレートから作成', exact: true }).click();
  const creation = page.getByRole('dialog', { name: 'テンプレートから作成', exact: true });
  await creation.getByLabel('テンプレートpackを読み込む', { exact: true }).setInputFiles({
    name: 'nested.template.json',
    mimeType: 'application/json',
    buffer: Buffer.from(pack),
  });
  await creation
    .getByRole('button', { name: 'テンプレートを選択: Nested text cards', exact: true })
    .click();
  await creation.getByRole('button', { name: 'この内容で作成', exact: true }).click();
  const canvas = page.getByRole('application', { name: 'Design canvas', exact: true });
  await canvas.getByText('Nested title', { exact: true }).first().dblclick();
  const editor = page.getByRole('textbox', { name: 'Edit canvas text', exact: true });
  await editor.press('Control+a');
  await page.keyboard.insertText('Template edited');
  await editor.press('Control+Enter');
  await save(page, 1);
  const saved = await nativeArtifact(page);
  await page.reload();
  await expect(canvas.getByText('Template edited', { exact: true })).toHaveCount(1);
  expect((await nativeArtifact(page)).versions).toEqual(saved.versions);
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'nested-saved.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(saved)),
  });
  await page.keyboard.press('Escape');
  await expect(canvas.getByText('Template edited', { exact: true })).toHaveCount(1);
  const imported = await nativeArtifact(page);
  expect(imported.draft.content).toEqual(saved.draft.content);
  expect(JSON.stringify(definition)).toBe(original);
  await page.screenshot({ path: info.outputPath('nested-template-saved.png') });
});

test('#27 nested Design text: independent Host edit, history and reload', async ({
  page,
}, info) => {
  await editNestedText(page, info);
});

test('#27 nested Design text: independent peers preserve a conflicting private input', async ({
  page: a,
  browser,
  baseURL,
}, info) => {
  test.setTimeout(120000);
  await a.goto('/');
  await create(a, 'design');
  const record = await nativeArtifact(a);
  record.draft.content = nestedTextFixture();
  await a.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await a.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'nested.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(record)),
  });
  await a.keyboard.press('Escape');
  await artifactMenu(a, 'Open collaboratively');
  await a.keyboard.press('Escape');
  await expect(a.locator('.save-status')).toContainText('Shared · confirmed');
  await a.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  const link = await a
    .getByRole('link', { name: 'Open peer editor', exact: true })
    .getAttribute('href');
  await a.keyboard.press('Escape');
  const context = await browser.newContext({ baseURL });
  const b = await context.newPage();
  const errors: string[] = [];
  b.on('pageerror', (e) => errors.push(e.message));
  b.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  try {
    await b.goto(link!);
    await expect(b.locator('.save-status')).toContainText('Shared · confirmed');
    for (const page of [a, b]) {
      await page
        .getByRole('application', { name: 'Design canvas', exact: true })
        .getByText('Nested title', { exact: true })
        .first()
        .dblclick();
      await page.getByRole('textbox', { name: 'Edit canvas text', exact: true }).press('Control+a');
      await page.keyboard.insertText(page === a ? 'Private input' : 'Peer title');
    }
    const textA = a.getByRole('textbox', { name: 'Edit canvas text', exact: true });
    await b.getByRole('textbox', { name: 'Edit canvas text', exact: true }).press('Control+Enter');
    await expect
      .poll(async () => JSON.stringify((await nativeArtifact(b)).draft.content))
      .toContain('Peer title');
    // A visible sibling update confirms the newer canonical snapshot without
    // blurring A's private editor or relying on timing.
    await b
      .getByRole('application', { name: 'Design canvas', exact: true })
      .getByText('Retained body', { exact: true })
      .first()
      .dblclick();
    const textB = b.getByRole('textbox', { name: 'Edit canvas text', exact: true });
    await textB.press('Control+a');
    await b.keyboard.insertText('Peer body');
    await textB.press('Control+Enter');
    await expect(
      a
        .getByRole('application', { name: 'Design canvas', exact: true })
        .getByText('Peer body', { exact: true }),
    ).toHaveCount(1);
    await expect(textA).toContainText('Private input');
    await textA.press('Control+Enter');
    await expect(textA).toContainText('Private input');
    await expect(a.getByRole('alert')).toHaveText(
      '文字または書式が変更済み、または編集できません。入力をコピーして現在値を確認してください。',
    );
    await a.screenshot({ path: info.outputPath('nested-shared-conflict.png') });
    await textA.press('Escape');
    await expect(
      a
        .getByRole('application', { name: 'Design canvas', exact: true })
        .getByText('Peer title', { exact: true }),
    ).toHaveCount(1);
    const current = await nativeArtifact(a);
    expect(JSON.stringify(current.draft.content)).toContain('Peer title');
    expect(JSON.stringify(current.draft.content)).not.toContain('Private input');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
