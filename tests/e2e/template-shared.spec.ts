import { test, expect, nativeArtifact } from './fixtures';
import { createWhole, artifactMenu } from './template-fixtures';
import type { SlideContent } from '@editor-platform/slide/model';
import { mkdir } from 'node:fs/promises';

test('TP-Q06/07 shared template preview keeps peer edits, retries a lost acknowledgement once and rejects stale targets', async ({
  page: a,
  browser,
  baseURL,
}) => {
  test.setTimeout(120000);
  a.setDefaultTimeout(12000);
  await a.goto('/');
  await createWhole(a, 'slide', '選択肢比較');
  const initial = (await nativeArtifact(a)).draft.content as SlideContent;
  await artifactMenu(a, 'Open collaboratively');
  await a.keyboard.press('Escape');
  await expect(a.locator('.save-status')).toContainText('Shared · confirmed');
  await a.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  const peer = await a.getByRole('link', { name: 'Open peer editor' }).getAttribute('href');
  await a.keyboard.press('Escape');
  const context = await browser.newContext({ baseURL }),
    b = await context.newPage(),
    errors: string[] = [];
  b.on('pageerror', (e) => errors.push(e.message));
  b.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await b.goto(peer!);
  await expect(b.locator('.save-status')).toContainText('Shared · confirmed');
  const preview = async () => {
    await artifactMenu(a, '部分テンプレートを挿入');
    const dialog = a.getByRole('dialog', { name: '部分テンプレートを挿入', exact: true });
    await dialog
      .getByRole('button', { name: 'テンプレートを選択: 左右比較ページ', exact: true })
      .click();
    await dialog.getByRole('button', { name: '入力内容をプレビュー', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'この内容を挿入', exact: true })).toBeVisible();
    return dialog;
  };
  let dialog = await preview();
  await b.getByLabel('Slide background', { exact: true }).fill('#cceecc');
  await b.getByLabel('Slide background', { exact: true }).press('Tab');
  await expect(b.locator('.save-status')).toContainText('Shared · confirmed');
  let lost = false;
  // Authority accepts, but the Host receives no receipt. A truncated JSON receipt
  // models this without intentionally adding a browser network-console error.
  await a.route('**/collaboration-api/proposal/apply?*', async (route) => {
    const response = await route.fetch();
    if (!lost) {
      lost = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{',
      });
    } else await route.fulfill({ response });
  });
  await dialog.getByRole('button', { name: 'この内容を挿入', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByRole('button', { name: 'この内容を挿入', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(lost).toBe(true);
  const accepted = (await nativeArtifact(a)).draft.content as SlideContent;
  expect(accepted.slides).toHaveLength(initial.slides.length + 1);
  expect(accepted.slides[0].background).toBe('#cceecc');
  await expect
    .poll(async () => ((await nativeArtifact(b)).draft.content as SlideContent).slides.length)
    .toBe(accepted.slides.length);
  await a.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect
    .poll(async () => ((await nativeArtifact(a)).draft.content as SlideContent).slides.length)
    .toBe(initial.slides.length);
  const undone = (await nativeArtifact(a)).draft.content as SlideContent;
  expect(undone.slides[0].background).toBe('#cceecc');
  // The next operation is a peer edit against the post-Undo page order.
  // Wait for that state before testing the separate stale-preview conflict.
  await expect.poll(async () => (await nativeArtifact(b)).draft.content).toEqual(undone);
  dialog = await preview();
  await b.getByRole('button', { name: 'Add slide', exact: true }).click();
  await expect(b.locator('.save-status')).toContainText('Shared · confirmed');
  await dialog.getByRole('button', { name: 'この内容を挿入', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await mkdir('docs/screenshots/issue-4', { recursive: true });
  await dialog.screenshot({ path: 'docs/screenshots/issue-4/shared-stale-preview.png' });
  await dialog.getByRole('button', { name: '入力内容をプレビュー', exact: true }).click();
  await dialog.getByRole('button', { name: 'この内容を挿入', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(async () => ((await nativeArtifact(b)).draft.content as SlideContent).slides.length)
    .toBe(initial.slides.length + 2);
  await a.unroute('**/collaboration-api/proposal/apply?*');
  await context.close();
  expect(errors).toEqual([]);
});
