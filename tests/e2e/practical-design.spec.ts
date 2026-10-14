import { test, expect, nativeArtifact } from './fixtures';
import { openWhole, artifactMenu } from './template-fixtures';
import {
  collaborate,
  confirmed,
  download,
  finish,
  insertFragment,
  renderSvg,
  screenshot,
  value,
} from './practical-fixtures';
import type { DesignContent } from '@editor-platform/design/model';

test('QL-04 three reception screens: layout, constraints, components, long Japanese, peers and frame exports', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(240000);
  page.setDefaultTimeout(12000);
  await page.goto('/');
  const form = await openWhole(page, 'design', '入力フォーム');
  for (const [slot, text] of Object.entries({
    title: '来訪の受付',
    summary: '来訪の目的と連絡先を入力してください。保存前に内容を確認できます。',
    items: 'お名前\n来訪の目的\n連絡先\n確認したいこと',
  }))
    await form.locator(`[data-slot="${slot}"]`).fill(text);
  await form.getByRole('button', { name: '入力内容をプレビュー', exact: true }).click();
  await form.getByRole('button', { name: 'この内容で作成', exact: true }).click();
  await expect(form).toHaveCount(0);
  await page.getByRole('button', { name: 'Layer 入力フォーム', exact: true }).click();
  await value(page, 'Layer name', '受付入力');
  const canvas = page.getByRole('application', { name: 'Design canvas', exact: true });
  for (const [name, x] of [
    ['内容確認', '1100'],
    ['受付完了', '2200'],
  ]) {
    await page.getByRole('button', { name: 'Layer 受付入力', exact: true }).click();
    await canvas.focus();
    await canvas.press('Control+d');
    await page.getByRole('button', { name: 'Layer 受付入力 copy', exact: true }).click();
    await value(page, 'Layer name', name);
    await value(page, 'Element x', x);
  }
  let content = (await nativeArtifact(page)).draft.content as DesignContent;
  expect(content.elements.filter((e) => e.type === 'frame' && !e.parentId)).toHaveLength(3);
  const titles = ['来訪の受付', '入力内容の確認', '受付が完了しました'];
  for (const [index, frame] of content.elements
    .filter((e) => e.type === 'frame' && !e.parentId)
    .entries()) {
    await page.getByRole('button', { name: `Layer ${frame.name}`, exact: true }).click();
    await page.getByLabel('Layout direction', { exact: true }).selectOption('column');
    await value(page, 'Layout gap (px)', '24');
    const heading = content.elements.find(
      (e) => e.parentId === frame.id && e.name.startsWith('heading'),
    )!;
    // Duplicate names are disambiguated through the layer tree's source order.
    await page
      .getByRole('button', { name: `Layer ${heading.name}`, exact: true })
      .first()
      .click();
    await value(page, 'Text', titles[index]);
    await value(page, 'Layer name', `表題${index + 1}`);
    const intro = content.elements.find(
      (e) => e.parentId === frame.id && e.name.startsWith('intro'),
    )!;
    await page
      .getByRole('button', { name: `Layer ${intro.name}`, exact: true })
      .first()
      .click();
    await value(
      page,
      'Text',
      index === 0
        ? '連絡先が分からない場合も受付担当に相談できます。入力内容は保存前にもう一度確認し、誤りがあればこの画面へ戻って修正してください。'
        : '受付担当が内容を確認します。案内があるまでお待ちください。',
    );
    await value(page, 'Element height', '160');
    if (!(await page.getByLabel('horizontal constraint', { exact: true }).isVisible()))
      await page.getByText('Size behavior', { exact: true }).click();
    await page.getByLabel('horizontal constraint', { exact: true }).selectOption('stretch');
    await value(page, 'Layer name', `説明${index + 1}`);
  }
  // Existing native template component becomes a reusable CTA with separate instance text.
  await page.getByRole('button', { name: 'Layer cta', exact: true }).click();
  const componentInput = page.getByRole('textbox', { name: /^Component text / }).first();
  await componentInput.fill('入力内容を確認');
  await componentInput.press('Enter');
  await page.getByRole('button', { name: 'Edit shared definition', exact: true }).click();
  await componentInput.fill('受付を保存');
  await componentInput.press('Enter');
  await page.getByRole('button', { name: 'Edit shared definition', exact: true }).click();
  await expect(componentInput).toHaveValue('入力内容を確認');
  // Reuse the authored CTA as a fragment and place its new instance in the completion screen.
  await artifactMenu(page, 'テンプレートとして保存');
  const author = page.getByRole('dialog', { name: 'テンプレートとして保存', exact: true });
  await author.getByLabel('テンプレート名', { exact: true }).fill('受付の再利用CTA');
  await author.getByRole('combobox', { name: '保存範囲', exact: true }).selectOption('fragment');
  await author.getByRole('button', { name: '保存内容をプレビュー', exact: true }).click();
  await author.getByRole('button', { name: 'テンプレートを保存', exact: true }).click();
  await expect(author).toHaveCount(0);
  await insertFragment(page, '受付の再利用CTA');
  await page.getByRole('button', { name: 'Layer cta', exact: true }).last().click();
  if (!(await page.getByLabel('Layer name', { exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle Design inspector', exact: true }).click();
  await value(page, 'Layer name', '受付へ戻る');
  const completion = content.elements.find((e) => e.name === '受付完了')!;
  await page.getByLabel('Parent layer', { exact: true }).selectOption(completion.id);
  const reusedText = page.getByRole('textbox', { name: /^Component text / }).first();
  await reusedText.fill('受付トップへ戻る');
  await reusedText.press('Enter');
  await page.getByRole('button', { name: 'Layer 受付完了', exact: true }).click();
  await value(page, 'Element height', '1300');
  const shared = await collaborate(page, browser, baseURL, 'design');
  // A edits a distinct screen while B's first-frame label and C's background survive.
  await page.getByRole('button', { name: 'Layer 受付完了', exact: true }).click();
  if (!(await page.getByLabel('Element width', { exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle Design inspector', exact: true }).click();
  await value(page, 'Element width', '1000');
  await confirmed(page);
  content = (await nativeArtifact(page)).draft.content as DesignContent;
  expect(content.components.length).toBeGreaterThan(0);
  const instances = content.elements.filter((e) => e.type === 'instance');
  expect(new Set(instances.map((e) => e.componentId)).size).toBe(2);
  expect(instances.filter((e) => e.overrides)).toHaveLength(2);
  for (const [index, frame] of content.elements
    .filter((e) => e.type === 'frame' && !e.parentId)
    .entries()) {
    await page.getByRole('button', { name: `Layer ${frame.name}`, exact: true }).click();
    await page.getByRole('button', { name: 'Export design', exact: true }).click();
    const svg = await download(page, 'Export selection SVG', `screen-${index + 1}.svg`);
    await renderSvg(page, svg, `design-frame-${index + 1}`);
    const text = await page.evaluate(
      (xml) => new DOMParser().parseFromString(xml, 'image/svg+xml').documentElement.textContent,
      svg.toString(),
    );
    expect(text).toContain(titles[index]);
  }
  await page.getByRole('button', { name: 'Fit design', exact: true }).click();
  await screenshot(page, 'design-overview');
  await shared.close();
  await finish(page, browser, baseURL, 'design');
});
