import { build } from 'esbuild';
import { test, expect } from './fixtures';
let bundle: Promise<{ js: string; css: string }>;
for (const host of ['通常', '独立'] as const) {
  test.describe(host, () => {
    test.beforeEach(async ({ page }) => {
      bundle ??= build({
        entryPoints: ['tests/fixtures/story-board/browser.tsx'],
        bundle: true,
        write: false,
        outdir: '/tmp/story-board-entry-bundle',
        format: 'esm',
        define: { 'process.env.NODE_ENV': '"production"' },
      }).then((result) => ({
        js: result.outputFiles!.find((f) => f.path.endsWith('.js'))!.text,
        css: result.outputFiles!.find((f) => f.path.endsWith('.css'))?.text ?? '',
      }));
      const files = await bundle;
      await page.route('**/entry-fixture.js', (route) =>
        route.fulfill({ contentType: 'text/javascript', body: files.js }),
      );
      await page.route('**/entry-fixture.css', (route) =>
        route.fulfill({ contentType: 'text/css', body: files.css }),
      );
      await page.route('**/entry-fixture-host?*', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/entry-fixture.css"><nav><output id="fixture-status"></output><output id="fixture-writes">0</output><output id="fixture-reads">0</output><button id="fixture-inspect">Inspect persistence</button><button id="fixture-revoke">Revoke setting</button></nav><div id="root"></div><script type="module" src="/entry-fixture.js"></script>',
        }),
      );
    });
    const url = (mode: string) =>
      `${host === '通常' ? '' : 'http://127.0.0.1:4177'}/entry-fixture-host?mode=${mode}`;
    test('P2 4456688778 exact-ID permissions allow typing and redact a revoked retained ID', async ({
      page,
    }) => {
      await page.goto(url('typing'));
      const field = page.getByRole('textbox', { name: '表示設定のArtifact ID', exact: true });
      await field.pressSequentially('sb660-settingx');
      await expect(field).toHaveValue('sb660-settingx');
      await page.getByRole('button', { name: '指定したボードを開く', exact: true }).click();
      await expect(page.locator('.sb-start [role="status"]')).toContainText('開けません');
      await expect(page.locator('#fixture-reads')).toHaveText('0');
      await field.press('End');
      await field.press('Backspace');
      await field.pressSequentially('s');
      await expect(field).toHaveValue('sb660-settings');
      await page.getByRole('button', { name: '指定したボードを開く', exact: true }).click();
      await expect(page.getByRole('heading', { name: /霧の王国/ })).toBeVisible();
      await page.getByRole('button', { name: '別のボード', exact: true }).click();
      await expect(field).toHaveValue('sb660-settings');
      await field.press('End');
      await field.press('Backspace');
      await expect(field).toHaveValue('sb660-setting');
      await field.pressSequentially('s');
      await page.getByRole('button', { name: '指定したボードを開く', exact: true }).click();
      await expect(page.getByRole('heading', { name: /霧の王国/ })).toBeVisible();
      await page.getByRole('button', { name: '別のボード', exact: true }).click();
      await page.getByRole('button', { name: 'Revoke setting', exact: true }).click();
      await expect(field).toHaveValue('');
      await expect(
        page.getByRole('button', { name: '指定したボードを開く', exact: true }),
      ).toBeDisabled();
      await expect(page.locator('#fixture-writes')).toHaveText('0');
      await page.getByRole('button', { name: 'Inspect persistence', exact: true }).click();
      await expect(page.locator('#fixture-status')).toHaveText(/^persisted:[1-9]\d*$/);
    });
    test('P2 4455222890 readonly sample creation performs zero writes', async ({ page }) => {
      await page.goto(url('readonly'));
      await page.getByRole('button', { name: '10人の物語ボードを作る', exact: true }).click();
      await expect(page.locator('.sb-start [role="status"]')).toContainText(
        '見本の作成を完了できません',
      );
      await expect(page.locator('#fixture-writes')).toHaveText('0');
      await page.getByRole('button', { name: 'Inspect persistence', exact: true }).click();
      await expect(page.locator('#fixture-status')).toHaveText('persisted:0');
    });
    test('P2 4455222890 revoking permission stops after already accepted first write', async ({
      page,
    }) => {
      await page.goto(url('revoking'));
      await page.getByRole('button', { name: '10人の物語ボードを作る', exact: true }).click();
      await expect(page.locator('#fixture-status')).toHaveText(
        'revoked after accepted first write',
      );
      await expect(
        page.getByRole('button', { name: '10人の物語ボードを作る', exact: true }),
      ).toBeEnabled();
      await expect(page.locator('#fixture-writes')).toHaveText('1');
      await expect(page.getByRole('heading', { name: /霧の王国/ })).toHaveCount(0);
      await page.getByRole('button', { name: 'Inspect persistence', exact: true }).click();
      await expect(page.locator('#fixture-status')).toHaveText('persisted:1');
    });
    test('SB12 config revocation clears the retained setting ID from the entry form', async ({
      page,
    }) => {
      await page.goto(url('config-revoked'));
      await expect(page.locator('#fixture-status')).toHaveText(
        'notified before final open read returned',
      );
      await expect(
        page.getByRole('textbox', { name: '表示設定のArtifact ID', exact: true }),
      ).toHaveValue('');
      await expect(
        page.getByRole('button', { name: '指定したボードを開く', exact: true }),
      ).toBeDisabled();
      await expect(page.getByRole('heading', { name: /霧の王国/ })).toHaveCount(0);
    });
    for (const mode of ['sources', 'permissions'])
      test(`P2 4455222910 ${mode} notification rejects open before React effect`, async ({
        page,
      }) => {
        await page.goto(url(mode));
        await expect(page.locator('#fixture-status')).toHaveText(
          'notified before final open read returned',
        );
        await expect(
          page.getByRole('button', { name: '指定したボードを開く', exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole('button', { name: '指定したボードを開く', exact: true }),
        ).toBeEnabled();
        await expect(page.getByRole('heading', { name: /霧の王国/ })).toHaveCount(0);
        await expect(page.locator('#fixture-writes')).toHaveText('0');
      });
  });
}
