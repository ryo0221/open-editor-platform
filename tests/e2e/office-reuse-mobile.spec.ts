import { test, expect, nativeArtifact } from './fixtures';
import { importForReuse, authorForReuse, reuseGallery } from './office-reuse-fixtures';
test.use({ viewport: { width: 390, height: 844 } });
for (const domain of ['slide', 'document'] as const) {
  test(`T01/T02 ${domain} mobile import authoring, sample preview and reuse`, async ({
    page,
  }, info) => {
    test.setTimeout(120000);
    await importForReuse(page, domain);
    // Observe the parent's load event. Evaluating inside the sandboxed frame can
    // make WebKit report Playwright's injected script as blocked user content.
    await page.evaluate(() => {
      document.addEventListener(
        'load',
        (event) => {
          if (
            event.target instanceof HTMLIFrameElement &&
            event.target.title === '文書テンプレートの実描画'
          )
            event.target.dataset.testPreviewLoadedSource = event.target.srcdoc;
        },
        true,
      );
    });
    const name = `モバイル${domain}提案`,
      { dialog, original } = await authorForReuse(page, domain, name);
    expect(await dialog.evaluate((n) => n.scrollWidth <= n.clientWidth + 1)).toBe(true);
    await dialog.locator('.tp-preview-column').scrollIntoViewIfNeeded();
    if (domain === 'document') {
      await expect(dialog.locator('iframe')).toHaveAttribute(
        'data-test-preview-loaded-source',
        /架空の提案/,
      );
      await expect(dialog.locator('iframe')).toHaveAttribute('srcdoc', /架空の提案/);
    }
    await page.screenshot({ path: info.outputPath('mobile-author.png'), fullPage: true });
    await dialog.getByRole('button', { name: 'テンプレートを保存', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect((await nativeArtifact(page)).draft.content).toEqual(original.draft.content);
    const gallery = await reuseGallery(page, name);
    await gallery.getByLabel('案件名', { exact: false }).fill('モバイルの別案件');
    await gallery.getByRole('button', { name: '入力内容をプレビュー', exact: true }).click();
    await gallery.locator('.tp-preview-column').scrollIntoViewIfNeeded();
    if (domain === 'document') {
      await expect(gallery.locator('iframe')).toHaveAttribute(
        'data-test-preview-loaded-source',
        /モバイルの別案件/,
      );
      await expect(gallery.locator('iframe')).toHaveAttribute('srcdoc', /モバイルの別案件/);
    }
    await page.screenshot({ path: info.outputPath('mobile-reuse.png'), fullPage: true });
    await gallery.getByRole('button', { name: 'この内容で作成', exact: true }).click();
    await expect(gallery).toHaveCount(0);
    expect(JSON.stringify((await nativeArtifact(page)).draft.content)).toContain(
      'モバイルの別案件',
    );
  });
}
