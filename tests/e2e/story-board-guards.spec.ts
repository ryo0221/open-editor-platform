import { build } from 'esbuild';
import { test, expect } from './fixtures';

let bundle: Promise<{ js: string; css: string }>;
for (const host of ['通常', '独立'] as const) {
  test.describe(host, () => {
    test(`SB07/10 ${host}: buffered view name blocks navigation and composing input cannot save`, async ({
      page,
    }) => {
      const name = page.getByRole('textbox', { name: '表示名', exact: true });
      await name.fill('入力中の表示');
      await page.getByRole('button', { name: 'Probe guard', exact: true }).click();
      await expect(page.getByTestId('guard')).toHaveText('blocked');
      await name.dispatchEvent('compositionstart');
      await page.getByRole('button', { name: 'この条件を名前付きで保存', exact: true }).click();
      await expect(name).toHaveValue('入力中の表示');
      await expect(page.getByTestId('attempts')).toHaveText('0');
      await name.dispatchEvent('compositionend');
      await page.getByRole('button', { name: '表示名を取消', exact: true }).click();
      await page.getByRole('button', { name: 'Probe guard', exact: true }).click();
      await expect(page.getByTestId('guard')).toHaveText('allowed');
      await expect(page.getByTestId('attempts')).toHaveText('0');
    });
    test.beforeEach(async ({ page }) => {
      bundle ??= build({
        entryPoints: ['tests/fixtures/story-board/host.tsx'],
        bundle: true,
        write: false,
        outdir: '/tmp/story-board-host-bundle',
        format: 'esm',
        define: { 'process.env.NODE_ENV': '"production"' },
      }).then((result) => ({
        js: result.outputFiles!.find((f) => f.path.endsWith('.js'))!.text,
        css: result.outputFiles!.find((f) => f.path.endsWith('.css'))?.text ?? '',
      }));
      const files = await bundle;
      await page.route('**/negative-fixture.js', (route) =>
        route.fulfill({ contentType: 'text/javascript', body: files.js }),
      );
      await page.route('**/negative-fixture.css', (route) =>
        route.fulfill({ contentType: 'text/css', body: files.css }),
      );
      await page.route('**/negative-fixture-host', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/negative-fixture.css"><div id="root"></div><script type="module" src="/negative-fixture.js"></script>',
        }),
      );
      await page.goto(
        host === '通常' ? '/negative-fixture-host' : 'http://127.0.0.1:4177/negative-fixture-host',
      );
      await expect(page.getByRole('slider', { name: '共通の時点', exact: true })).toHaveValue('3');
    });

    test(`SB11/14 ${host}: pending save blocks navigation/history; cancel hides late completion`, async ({
      page,
    }) => {
      await page.getByRole('button', { name: 'Hold settings', exact: true }).click();
      await page.getByRole('textbox', { name: '表示名', exact: true }).fill('遅延結果');
      await page.getByRole('button', { name: 'この条件を名前付きで保存', exact: true }).click();
      await expect(page.getByRole('alert').filter({ hasText: '保存中' })).toBeVisible();
      await page.getByRole('button', { name: 'Probe guard', exact: true }).click();
      await expect(page.getByTestId('guard')).toHaveText('blocked');
      await page.getByRole('button', { name: '物語タイムラインで確認・編集', exact: true }).click();
      await expect(page.getByRole('heading', { name: '物語の元資料', exact: true })).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: '表示条件をUndo', exact: true }),
      ).toBeDisabled();
      await page.getByRole('button', { name: '保存を取消', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: '操作を取り消しました', exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: '状態を再確認', exact: true })).toBeDisabled();
      await page.getByRole('button', { name: 'Release settings', exact: true }).click();
      await expect(page.getByRole('button', { name: '状態を再確認', exact: true })).toBeEnabled();
      await expect(page.getByRole('combobox', { name: '保存した表示', exact: true })).toHaveCount(
        0,
      );
      await expect(page.getByTestId('attempts')).toHaveText('1');
    });

    test(`SB06/14 ${host}: failed settings retry retains one definition and clears its form only after success`, async ({
      page,
    }) => {
      await page.getByRole('button', { name: 'Fail settings', exact: true }).click();
      await page.getByRole('textbox', { name: '表示名', exact: true }).fill('再試行する表示');
      await page.getByRole('button', { name: 'この条件を名前付きで保存', exact: true }).click();
      await expect(page.getByRole('button', { name: '保存を再試行', exact: true })).toBeVisible();
      await expect(page.getByRole('textbox', { name: '表示名', exact: true })).toHaveValue(
        '再試行する表示',
      );
      const captured = await page.getByTestId('native').textContent();
      await page.getByRole('button', { name: 'Release settings', exact: true }).click();
      await page.getByRole('button', { name: '保存を再試行', exact: true }).click();
      await expect(page.getByRole('textbox', { name: '表示名', exact: true })).toHaveValue('');
      await expect(page.getByTestId('native')).toHaveText(captured!);
      await expect(
        page
          .getByRole('combobox', { name: '保存した表示', exact: true })
          .locator('option')
          .filter({ hasText: '再試行する表示' }),
      ).toHaveCount(1);
      await expect(page.getByTestId('attempts')).toHaveText('2');
    });

    test(`SB12 ${host}: permission loss clears all derived names/counts/map while native remains unchanged`, async ({
      page,
    }) => {
      const before = await page.getByTestId('native').textContent();
      await page.getByRole('button', { name: 'Revoke source', exact: true }).click();
      await expect(page.getByRole('slider', { name: '共通の時点', exact: true })).toHaveCount(0);
      await expect(
        page.locator('[data-board-lane],[data-board-map-marker],.sb-list article'),
      ).toHaveCount(0);
      await expect(page.locator('.story-board')).not.toContainText(
        /アリア|レオン|11個体|sb660-story-ledger-A/,
      );
      await expect(page.getByTestId('native')).toHaveText(before!);
      await page.getByRole('button', { name: 'Restore access', exact: true }).click();
      await expect(page.getByRole('slider', { name: '共通の時点', exact: true })).toHaveValue('3');
      await expect(page.getByTestId('native')).toHaveText(before!);
    });
  });
}
