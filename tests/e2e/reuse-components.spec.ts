import { test, expect, nativeArtifact } from './fixtures';
import { componentFlow } from './reuse-fixtures';
for (const domain of ['design', 'document'] as const)
  test(`R02/R03 ${domain}: ordinary reusable component, inputs, reload, visibility and local Undo`, async ({
    page,
  }, info) => {
    test.setTimeout(120000);
    const { inspector, hidden } = await componentFlow(page, domain);
    await page.screenshot({ path: info.outputPath(domain + '-component.png'), fullPage: true });
    await inspector.getByRole('button', { name: 'リンク解除をプレビュー', exact: true }).click();
    await inspector.getByRole('button', { name: 'プレビューした変更を適用', exact: true }).click();
    const detached = (await nativeArtifact(page)).draft.content;
    expect(detached).not.toHaveProperty('reuse');
    const { reuse: _, ...native } = hidden;
    void _;
    expect(detached).toEqual(native);
  });
