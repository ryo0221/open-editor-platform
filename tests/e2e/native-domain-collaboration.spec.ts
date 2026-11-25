import type { BrowserContext, Page } from '@playwright/test';
import { create, expect, nativeArtifact, save, test } from './fixtures';

const button = (p: Page, name: string) => p.getByRole('button', { name, exact: true });
const edits: Record<string, (page: Page) => Promise<void>> = {
  cad: async (p) => {
    await expect(p.getByTestId('cad-geometry-state')).toHaveText('Shape up to date');
    const add = button(p, 'Add plate');
    if (!(await add.isVisible())) await button(p, 'More editor tools').click();
    await add.click();
  },
  simulation: async (p) => {
    const size = p.getByLabel('Element size (mm)', { exact: true });
    await size.fill('4');
    await size.press('Enter');
  },
  construction: async (p) => {
    await p.getByText('Calendar', { exact: true }).click();
    await p.getByLabel('Start date', { exact: true }).fill('2031-02-03');
    await button(p, 'Set calendar').click();
  },
  cosim: async (p) => {
    const name = p.getByLabel('Name', { exact: true });
    await name.fill('共同シミュレーション');
    await name.press('Enter');
  },
  pcb: async (p) => {
    await p.locator('.pcb-inspector').getByLabel('Copper layers').selectOption('4');
  },
  schematic: async (p) => {
    await p.locator('.sch-inspector').getByLabel('Sheet size').selectOption('A3');
  },
  ladder: (p) => button(p, 'Add rung').click(),
  factory: (p) => button(p, 'Add source').click(),
  analysis: async (p) => {
    const title = p.getByLabel('タイトル', { exact: true });
    await title.fill('二人で編集した分析');
    await title.press('Tab');
  },
  estimate: async (p) => {
    await button(p, '数量を追加').click();
    await p.getByLabel('名称', { exact: true }).fill('パネル');
    await p.getByLabel('数量（空欄は未入力）').fill('3');
    await p.getByLabel('数量の根拠・出典').fill('図面から集計');
    await button(p, '項目を確定').click();
  },
  'fiction-map': async (p) => {
    await p.getByLabel('New layer name').fill('Territories');
    await button(p, 'Add layer').click();
  },
};

for (const [kind, edit] of Object.entries(edits)) {
  test(`${kind} shares a native edit, selective history and a saved version between two browsers`, async ({
    page,
    browser,
    baseURL,
  }) => {
    let peerContext: BrowserContext | undefined;
    try {
      await page.goto('/');

      if (kind === 'construction' || kind === 'simulation') {
        test.setTimeout(90_000);
        // Both participants have the same immutable source version in their own library.
        await create(page, kind === 'construction' ? 'bim' : 'cad');
        if (kind === 'simulation') {
          await edits.cad(page);
          await expect(
            page
              .getByRole('list', { name: 'Bodies' })
              .getByRole('button', { name: 'Plate', exact: true }),
          ).toBeVisible();
          await expect(page.getByTestId('cad-geometry-state')).toHaveText('Shape up to date');
        }
        await save(page, 1);
        // Provision the exact source ID and immutable version on the other device before
        // either participant has a shared session. A file import creates an independent copy.
        peerContext = await browser.newContext({
          baseURL,
          storageState: await page.context().storageState({ indexedDB: true }),
        });
      } else {
        peerContext = await browser.newContext({ baseURL });
      }
      const peer = await peerContext.newPage();
      await create(page, kind);
      const menu = button(page, 'More artifact actions');
      await menu.click();
      await button(page, 'Open collaboratively').click();
      await expect(page.locator('.save-status')).toContainText('Shared · confirmed');
      await menu.click();
      const link = await page.getByRole('link', { name: 'Open peer editor' }).getAttribute('href');
      await page.keyboard.press('Escape');
      const errors: string[] = [];
      peer.on('pageerror', (error) => errors.push(error.message));
      peer.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      await peer.goto(link!);
      await expect(peer.locator('.save-status')).toContainText('Shared · confirmed');
      const before = (await nativeArtifact(peer)).draft.content;
      await edit(page);
      await expect(page.locator('.save-status')).toContainText('confirmed r1');
      const edited = (await nativeArtifact(page)).draft.content;
      expect(edited).not.toEqual(before);
      await expect.poll(async () => (await nativeArtifact(peer)).draft.content).toEqual(edited);
      await page.getByRole('banner').getByRole('button', { name: 'Undo', exact: true }).click();
      await expect.poll(async () => (await nativeArtifact(peer)).draft.content).toEqual(before);
      await page.getByRole('banner').getByRole('button', { name: 'Redo', exact: true }).click();
      await expect(page.locator('.save-status')).toContainText('confirmed r3');
      await button(page, 'Save version').click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'この版を保存', exact: true })
        .click();
      await expect
        .poll(async () => (await nativeArtifact(peer)).versions.at(-1)?.content)
        .toEqual(edited);
      expect(errors).toEqual([]);
    } finally {
      await peerContext?.close();
    }
  });
}
