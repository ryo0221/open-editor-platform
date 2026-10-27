import { test, expect, create, nativeArtifact, save } from './fixtures';
import { estimateFixture } from '../../packages/estimate-core/src/fixtures';
import { createArtifact, commitVersion } from '@editor-platform/artifact-core';
import { calculateEstimate } from '@editor-platform/estimate-core';
for (const kind of ['document', 'slide', 'design', 'whiteboard'])
  for (const mode of ['fixed', 'follow']) {
    test(`ES20/21 normal ${kind} places ${mode} verified Estimate and captures native history`, async ({
      page,
    }, info) => {
      const document = estimateFixture();
      document.calculations = [await calculateEstimate(document, 'saved-run')];
      const artifact = await commitVersion(
        createArtifact('estimate', '参照する見積', document),
        'local',
        'Fixture',
      );
      await page.goto('/');
      await page
        .locator('input[type=file]')
        .first()
        .setInputFiles({
          name: 'source.json',
          mimeType: 'application/json',
          buffer: Buffer.from(JSON.stringify({ ...artifact, annotations: [] })),
        });
      await expect(page.locator('.ep-estimate:visible')).toBeVisible();
      await save(page, 2);
      await expect(
        page.getByRole('dialog', { name: 'Save immutable version', exact: true }),
      ).toBeHidden();
      await create(page, kind);
      await expect(page.locator('.ep-estimate')).toHaveCount(0);
      const button = page.getByRole('button', { name: '参照を埋め込む', exact: true });
      if (!(await button.isVisible()))
        await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
      await button.click();
      const dialog = page.getByRole('dialog', { name: '参照を埋め込む', exact: true });
      const select = dialog.getByLabel('埋め込みの参照元', { exact: true });
      await expect(select.locator('option')).not.toHaveCount(0);
      const option = await select
        .locator('option')
        .evaluateAll((options) =>
          options
            .find((o) => o.textContent?.includes('現在の見積') && o.textContent.includes('table'))
            ?.getAttribute('value'),
        );
      expect(option).toBeTruthy();
      await select.selectOption(option!);
      await dialog.getByLabel('埋め込みの更新方式', { exact: true }).selectOption(mode);
      await dialog.getByRole('button', { name: '参照を配置', exact: true }).click();
      await expect(dialog.getByRole('button', { name: '参照を配置', exact: true })).toBeEnabled();
      await page.keyboard.press('Escape');
      const exported = await nativeArtifact(page);
      expect(JSON.stringify(exported.draft.content)).toContain('"domain":"estimate"');
      expect(JSON.stringify(exported.draft.content)).toContain('"mode":"' + mode + '"');
      expect(JSON.stringify(exported.draft.content)).toContain('"total":"1350"');
      await save(page, 1);
      if (kind === 'document') await page.locator('.ProseMirror img').click();
      if (!(await page.getByRole('button', { name: '元を編集', exact: true }).isVisible()))
        await page
          .getByRole('button', { name: /^Toggle (Slide|Document|Design|Board) inspector$/ })
          .click();
      await page.getByRole('button', { name: '元を編集', exact: true }).click();
      await expect(page.locator('.ProseMirror')).toHaveCount(0);
      await page
        .getByRole('region', { name: '数量一覧', exact: true })
        .getByRole('button', { name: '数量を編集', exact: true })
        .first()
        .click();
      await page.getByLabel('数量（空欄は未入力）', { exact: true }).fill('2');
      await page.getByRole('button', { name: '項目を確定', exact: true }).click();
      await page.getByRole('button', { name: '計算して採用', exact: true }).click();
      await expect(page.getByRole('region', { name: '見積結果', exact: true })).toContainText(
        '見積合計 2,550 JPY',
      );
      await save(page, 3);
      await page.getByRole('button', { name: '埋め込み先に戻る', exact: true }).click();
      const updated = await nativeArtifact(page);
      expect(JSON.stringify(updated.draft.content)).toContain(
        mode === 'follow' ? '"total":"2550"' : '"total":"1350"',
      );
      expect(JSON.stringify(updated.versions.at(-1)?.content)).toContain('"total":"1350"');
      expect(JSON.stringify(updated.versions.at(-1)?.content)).not.toContain('"total":"2550"');

      await page.screenshot({
        path: info.outputPath(`estimate-${kind}-${mode}.png`),
        fullPage: true,
      });
    });
  }
