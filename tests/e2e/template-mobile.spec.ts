import { test, expect, nativeArtifact } from './fixtures';
import { openWhole } from './template-fixtures';
import { mkdir } from 'node:fs/promises';
for (const [domain, name] of [
  ['slide', '選択肢比較'],
  ['whiteboard', 'KPT振り返り'],
  ['design', '入力フォーム'],
  ['document', '議事録'],
  ['data', '備品・在庫台帳'],
] as const) {
  test(`TP-Q16 mobile ${domain}: form draft, back, preview and ordinary artifact`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    page.setDefaultTimeout(12000);
    await page.goto('/');
    const gallery = await openWhole(page, domain, name);
    const key = domain === 'whiteboard' ? 'stage0' : domain === 'data' ? 'rows.0.label' : 'title',
      value = 'モバイルで差し替えた内容';
    await gallery.locator(`[data-slot="${key}"]`).fill(value);
    await gallery.getByRole('button', { name: '← 一覧に戻る', exact: true }).click();
    await gallery.getByRole('button', { name: `テンプレートを選択: ${name}`, exact: true }).click();
    await expect(gallery.locator(`[data-slot="${key}"]`)).toHaveValue(value);
    await gallery.getByRole('button', { name: '入力内容をプレビュー', exact: true }).click();
    await expect(
      gallery.getByRole('button', { name: 'この内容で作成', exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await mkdir('docs/screenshots/issue-4', { recursive: true });
    await gallery.locator('.tp-preview-column').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `docs/screenshots/issue-4/${domain}-mobile.png` });
    await gallery.getByRole('button', { name: 'この内容で作成', exact: true }).click();
    await expect(gallery).toHaveCount(0);
    expect(JSON.stringify((await nativeArtifact(page)).draft.content)).toContain(value);
  });
}
