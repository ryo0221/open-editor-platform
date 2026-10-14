import { test, expect, nativeArtifact, setDocumentText, create, tinyPng } from './fixtures';
import { designDrawings, type DesignContent } from '@editor-platform/design/model';
import {
  authorAndInsert,
  insertPublished,
  publishRevision,
  stageRevision,
} from './reuse-revision-fixtures';
import { reuseHistory, reuseMenu } from './reuse-fixtures';
import type { DocumentContent } from '@editor-platform/document/model';
test('R04/R05/R07 normal draft publication, required slot, selective adoption, reload and Undo/Redo', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  await authorAndInsert(page, true);
  const before = await insertPublished(page, '旧版に留める本文', true);
  const [first, second] = before.reuse!.instances;
  const nativeIds = before.blocks.map((b) => b.id);
  await publishRevision(page);
  expect((await nativeArtifact(page)).draft.content).toEqual(before);
  const inspector = await stageRevision(page);
  await page.screenshot({ path: info.outputPath('component-update-diff.png'), fullPage: true });
  await inspector.getByRole('button', { name: 'プレビューした変更を適用', exact: true }).click();
  await expect(inspector).toHaveCount(0);
  const adopted = (await nativeArtifact(page)).draft.content as DocumentContent;
  expect(adopted.blocks.map((b) => b.id)).toEqual(nativeIds);
  expect(adopted.reuse!.instances.find((i) => i.id === first.id)!.ref.version).toBe(2);
  expect(adopted.reuse!.instances.find((i) => i.id === second.id)).toEqual(second);
  expect(adopted.blocks.find((b) => Object.values(first.parts).includes(b.id))).toMatchObject({
    style: { fontSize: 22, color: '#2255aa' },
  });
  expect(adopted.blocks.map((b) => b.text)).toEqual(before.blocks.map((b) => b.text));
  await reuseHistory(page, 'Undo');
  expect((await nativeArtifact(page)).draft.content).toEqual(before);
  await reuseHistory(page, 'Redo');
  expect((await nativeArtifact(page)).draft.content).toEqual(adopted);
  await page.reload();
  expect((await nativeArtifact(page)).draft.content).toEqual(adopted);
});

test('R06/R07/R09 independent peer Japanese input and lost update receipt preserve native body and selective Undo', async ({
  page: a,
  browser,
  baseURL,
}, info) => {
  test.setTimeout(150000);
  const before = await authorAndInsert(a);
  const instance = before.reuse!.instances[0],
    id = Object.values(instance.parts)[0];
  await publishRevision(a);
  await reuseMenu(a, 'Open collaboratively');
  await a.keyboard.press('Escape');
  await expect(a.locator('.save-status')).toContainText('Shared · confirmed');
  await a.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  const peer = await a
    .getByRole('link', { name: 'Open peer editor', exact: true })
    .getAttribute('href');
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
  const inspector = await stageRevision(a);
  await setDocumentText(b, `[data-block-id="${id}"]`, '別の人が編集中の日本語');
  await expect(b.locator('.save-status')).toContainText('Shared · confirmed');
  let lost = false;
  await a.route('**/collaboration-api/proposal/apply?*', async (route) => {
    const response = await route.fetch();
    if (!lost) {
      lost = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{' });
    } else await route.fulfill({ response });
  });
  await inspector.getByRole('button', { name: 'プレビューした変更を適用', exact: true }).click();
  await expect(inspector.getByRole('alert')).toBeVisible();
  await inspector.getByRole('button', { name: 'プレビューした変更を適用', exact: true }).click();
  await expect(inspector).toHaveCount(0);
  expect(lost).toBe(true);
  const current = (await nativeArtifact(a)).draft.content as DocumentContent;
  expect(current.blocks.find((block) => block.id === id)).toMatchObject({
    text: '別の人が編集中の日本語',
    style: { fontSize: 22 },
  });
  await expect.poll(async () => (await nativeArtifact(b)).draft.content).toEqual(current);
  await reuseHistory(a, 'Undo');
  const undone = (await nativeArtifact(a)).draft.content as DocumentContent;
  expect(undone.blocks.find((block) => block.id === id)?.text).toBe('別の人が編集中の日本語');
  expect(undone.reuse!.instances[0].ref.version).toBe(1);
  await expect.poll(async () => (await nativeArtifact(b)).draft.content).toEqual(undone);
  await reuseHistory(a, 'Redo');
  await expect.poll(async () => (await nativeArtifact(b)).draft.content).toEqual(current);
  await a.screenshot({ path: info.outputPath('shared-adopted-component.png'), fullPage: true });
  await a.unroute('**/collaboration-api/proposal/apply?*');
  await context.close();
  expect(errors).toEqual([]);
});
test('R02/R14 Design image component publication, explicit omission, reset and catalog-free reload keep the native part', async ({
  page,
}, info) => {
  test.setTimeout(90000);
  page.setDefaultTimeout(12000);
  await page.goto('/');
  await create(page, 'design');
  const choosing = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Insert image', exact: true }).click();
  await (await choosing).setFiles({ name: 'brand.png', mimeType: 'image/png', buffer: tinyPng });
  await reuseMenu(page, '再利用部品として保存');
  const author = page.getByRole('dialog', { name: '再利用部品として保存', exact: true });
  await author.getByLabel('部品名', { exact: true }).fill('画像部品');
  await author.getByRole('button', { name: '部品をプレビュー', exact: true }).click();
  await author
    .getByRole('combobox', { name: '対象の部品', exact: true })
    .selectOption({ index: 1 });
  await author.getByRole('combobox', { name: '公開する属性', exact: true }).selectOption('src');
  await author.getByRole('button', { name: '入力を追加', exact: true }).click();
  await author.getByRole('button', { name: '部品をプレビュー', exact: true }).click();
  await author.getByRole('button', { name: '部品を公開', exact: true }).click();
  await reuseMenu(page, '部品ライブラリ');
  const library = page.getByRole('dialog', { name: '部品ライブラリ', exact: true });
  await library.getByRole('button', { name: '画像部品 v1', exact: true }).click();
  await library.getByRole('button', { name: '画像を省略', exact: true }).click();
  await library.getByRole('button', { name: '変更をプレビュー', exact: true }).click();
  await library.getByRole('button', { name: 'プレビューした変更を適用', exact: true }).click();
  const empty = (await nativeArtifact(page)).draft.content as DesignContent;
  const root = Object.values(empty.reuse!.instances[0].parts)[0].split('/')[0];
  expect(
    designDrawings(empty, empty.elements.find((e) => e.id === root)!).find(
      (e) => e.kind === 'image',
    )?.src,
  ).toBe('');
  await reuseMenu(page, '部品の入力・表示');
  const inspector = page.getByRole('dialog', { name: '部品の入力・表示', exact: true });
  await inspector.getByRole('button', { name: '画像部品 v1', exact: true }).click();
  await inspector.getByRole('button', { name: '入力を既定値に戻す', exact: true }).click();
  await inspector.getByRole('button', { name: 'プレビューした変更を適用', exact: true }).click();
  const restored = (await nativeArtifact(page)).draft.content as DesignContent;
  expect(
    restored.components.flatMap((c) => c.elements ?? []).find((e) => e.type === 'image')?.src,
  ).toBe('data:image/png;base64,' + tinyPng.toString('base64'));
  expect(restored.reuse!.instances[0].parts).toEqual(empty.reuse!.instances[0].parts);
  // Fault setup: remove the catalog, leaving the artifact and its retained closure.
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const opening = indexedDB.open('editor-platform-templates', 1);
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => {
          const db = opening.result,
            tx = db.transaction('versions', 'readwrite');
          tx.objectStore('versions').clear();
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
  );
  await page.reload();
  expect((await nativeArtifact(page)).draft.content).toEqual(restored);
  await reuseMenu(page, '部品ライブラリ');
  const missing = page.getByRole('dialog', { name: '部品ライブラリ', exact: true });
  await expect(missing.getByRole('button', { name: '画像部品 v1', exact: true })).toHaveCount(0);
  await missing.getByRole('button', { name: 'Close 部品ライブラリ', exact: true }).click();
  await page.screenshot({ path: info.outputPath('design-image-component.png'), fullPage: true });
});
