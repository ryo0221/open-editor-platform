import type { DesignContent } from '@editor-platform/design/model';
import { expect, nativeArtifact, test } from './fixtures';

test('manga peers share dialogue and linked panel changes', async ({ page: a, browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    await a.goto('/');
    await a.getByRole('main').getByRole('button', { name: '漫画を作成', exact: true }).click();
    await expect(a.locator('[data-workspace]')).toHaveAttribute('data-workspace', 'manga');
    const menu = a.getByRole('button', { name: 'More artifact actions', exact: true });
    await menu.click();
    await a.getByRole('button', { name: 'Open collaboratively', exact: true }).click();
    await expect(a.locator('.save-status')).toContainText('Shared · confirmed');
    await menu.click();
    const link = await a.getByRole('link', { name: 'Open peer editor', exact: true }).getAttribute('href');
    expect(link).toBeTruthy();
    await a.keyboard.press('Escape');
    const b = await context.newPage();
    const errors: string[] = [];
    b.on('pageerror', (error) => errors.push(error.message));
    await b.goto(link!);
    await expect(b.locator('[data-workspace]')).toHaveAttribute('data-workspace', 'manga');
    const openPanel = a.getByRole('button', { name: 'Toggle 漫画のページ・コマ', exact: true });
    if ((await openPanel.getAttribute('aria-pressed')) !== 'true') await openPanel.click();
    const panel = a.getByRole('region', { name: 'Manga pages and panels' });
    await panel.getByRole('button', { name: 'Add page', exact: true }).click();
    await panel.getByRole('button', { name: '連動コマ割りをプレビュー', exact: true }).click();
    await panel.getByRole('button', { name: 'このコマ割りを採用', exact: true }).click();
    await panel.getByRole('button', { name: '分割をプレビュー', exact: true }).click();
    await panel.getByRole('button', { name: 'このコマ割りを採用', exact: true }).click();
    const peerDesign = async () => (await nativeArtifact(b)).draft.content as DesignContent;
    await expect.poll(async () => (await peerDesign()).pagination?.pages.some((p) => p.panelIds.length === 2)).toBe(true);
    const close = a.getByRole('button', { name: 'Close 漫画のページ・コマ', exact: true });
    if (await close.isVisible()) await close.click();
    const add = a.getByRole('button', { name: '台詞を追加', exact: true });
    if (!(await add.isVisible()))
      await a.getByRole('button', { name: 'More editor tools', exact: true }).click();
    await add.click();
    await expect.poll(async () => (await peerDesign()).elements.some((e) => e.type === 'text')).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
