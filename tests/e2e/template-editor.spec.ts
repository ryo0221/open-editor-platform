import {
  test,
  expect,
  nativeArtifact,
  save,
  artifactView,
  setDocumentText,
  editCell,
} from './fixtures';
import { openWhole, createWhole, artifactMenu, downloadText } from './template-fixtures';
import { nativeIds, type NativeContent } from '@editor-platform/templates';
import { mkdir, writeFile } from 'node:fs/promises';
const domains = [
  ['slide', '選択肢比較'],
  ['whiteboard', 'KPT振り返り'],
  ['design', '入力フォーム'],
  ['document', '議事録'],
  ['data', '備品・在庫台帳'],
] as const;
for (const [domain, name] of domains) {
  test(`TP-Q03 ${domain}: ordinary form creation, direct content edit, save, reload and rendered export`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    page.setDefaultTimeout(12000);
    await page.goto('/');
    const dialog = await openWhole(page, domain, name),
      marker = `${domain}の入力を差し替え`;
    await dialog
      .locator(
        `[data-slot="${domain === 'whiteboard' ? 'stage0' : domain === 'data' ? 'rows.0.label' : 'title'}"]`,
      )
      .fill(marker);
    await dialog.getByRole('button', { name: '入力内容をプレビュー', exact: true }).click();
    await dialog.getByRole('button', { name: 'この内容で作成', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(JSON.stringify((await nativeArtifact(page)).draft.content)).toContain(marker);
    const edited = `${domain}で通常編集した内容`;
    if (domain === 'document') await setDocumentText(page, 'h1', edited);
    else if (domain === 'data') await editCell(page, '品名', 1, edited);
    else {
      const canvas = page.getByRole('application', {
        name: `${domain[0].toUpperCase() + domain.slice(1)} canvas`,
        exact: true,
      });
      await canvas.getByRole('button').filter({ hasText: marker }).first().dblclick();
      const text = page.getByRole('textbox', { name: 'Edit canvas text', exact: true });
      await text.press('Control+a');
      await page.keyboard.insertText(edited);
      await text.press('Control+Enter');
    }
    const after = await nativeArtifact(page);
    expect(JSON.stringify(after.draft.content)).toContain(edited);
    await save(page, 1);
    await artifactView(page, 'Editor');
    await page.reload();
    expect((await nativeArtifact(page)).draft.content).toEqual(after.draft.content);
    const menu =
      domain === 'document' || domain === 'data'
        ? 'Export artifact'
        : domain === 'slide'
          ? 'Export visual'
          : domain === 'whiteboard'
            ? 'Export whiteboard'
            : 'Export design';
    await page.getByRole('button', { name: menu, exact: true }).click();
    const type = domain === 'document' ? 'html' : domain === 'data' ? 'csv' : 'svg';
    const text = await downloadText(
      page,
      domain === 'document'
        ? 'Export HTML'
        : domain === 'data'
          ? 'Export CSV'
          : domain === 'slide'
            ? 'Export SVG'
            : 'Export all SVG',
    );
    const readable =
      type === 'svg'
        ? await page.evaluate(
            (xml) =>
              new DOMParser().parseFromString(xml, 'image/svg+xml').documentElement.textContent,
            text,
          )
        : text;
    expect(readable).toContain(edited);
    await mkdir('docs/exports/issue-4', { recursive: true });
    await writeFile(`docs/exports/issue-4/${domain}-edited.${type}`, text);
    await page.keyboard.press('Escape');
    await mkdir('docs/screenshots/issue-4', { recursive: true });
    await page.screenshot({
      path: `docs/screenshots/issue-4/${domain}-editor.png`,
      fullPage: true,
    });
    if (type !== 'csv') {
      const rendered = await page.context().newPage();
      if (type === 'html') {
        await rendered.setContent(text);
        await expect(rendered.locator('body')).toContainText(edited);
      } else {
        await rendered.setContent('<img alt="Exported SVG" style="max-width:100%">');
        await rendered.getByRole('img').evaluate(async (img, xml) => {
          const element = img as HTMLImageElement;
          element.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
          await element.decode();
          if (!element.naturalWidth) throw new Error('Export did not render');
        }, text);
        await expect(rendered.getByRole('img')).toBeVisible();
      }
      await rendered.screenshot({
        path: `docs/screenshots/issue-4/${domain}-export.png`,
        fullPage: true,
      });
      await rendered.close();
    } else {
      await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
      await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
        name: 'template-export.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(text),
      });
      await expect(page.getByRole('grid')).toContainText(edited);
    }
  });
}
const fragments: Record<string, string[]> = {
  slide: ['左右比較ページ', 'データグラフページ'],
  whiteboard: ['議題Section', '接続付きプロセス図'],
  design: ['カード群', '入力field群'],
  document: ['比較table', '要約・結論section'],
  data: ['共通field set', '互換fieldへのchart view'],
};
for (const [domain, name] of domains) {
  test(`TP-Q05/11/12 ${domain}: both fragment kinds and scoped preset use normal Undo/Redo`, async ({
    page,
  }) => {
    test.setTimeout(120000);
    page.setDefaultTimeout(12000);
    await page.goto('/');
    await createWhole(page, domain, name);
    for (const fragment of fragments[domain]) {
      const before = (await nativeArtifact(page)).draft.content as NativeContent;
      await artifactMenu(page, '部分テンプレートを挿入');
      const dialog = page.getByRole('dialog', { name: '部分テンプレートを挿入', exact: true });
      await dialog
        .getByRole('button', { name: `テンプレートを選択: ${fragment}`, exact: true })
        .click();
      if (fragment === '互換fieldへのchart view' && 'columns' in before) {
        await dialog
          .getByLabel('Map 分類', { exact: true })
          .selectOption(before.columns.find((c) => c.type === 'text')!.id);
        await dialog
          .getByLabel('Map 値', { exact: true })
          .selectOption(before.columns.find((c) => c.type === 'number')!.id);
      }
      await dialog.getByRole('button', { name: '入力内容をプレビュー', exact: true }).click();
      await dialog.getByRole('button', { name: 'この内容を挿入', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      const inserted = (await nativeArtifact(page)).draft.content as NativeContent;
      expect(nativeIds(inserted).length).toBeGreaterThan(nativeIds(before).length);
      expect(new Set(nativeIds(inserted)).size).toBe(nativeIds(inserted).length);
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      expect((await nativeArtifact(page)).draft.content).toEqual(before);
      await page.getByRole('button', { name: 'Redo', exact: true }).click();
      expect((await nativeArtifact(page)).draft.content).toEqual(inserted);
    }
    const before = (await nativeArtifact(page)).draft.content as NativeContent;
    await artifactMenu(page, 'スタイル・表示プリセット');
    const dialog = page.getByRole('dialog', { name: 'スタイル・表示プリセット', exact: true });
    await dialog
      .getByRole('button', {
        name: 'テンプレートを選択: 落ち着いた色・読みやすい設定',
        exact: true,
      })
      .click();
    await dialog.getByLabel('プリセットの適用範囲', { exact: true }).selectOption('artifact');
    await dialog.getByRole('button', { name: '入力内容をプレビュー', exact: true }).click();
    await dialog.getByRole('button', { name: 'この設定を適用', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const after = (await nativeArtifact(page)).draft.content as NativeContent;
    expect(after).not.toEqual(before);
    expect(nativeIds(after)).toEqual(nativeIds(before));
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    expect((await nativeArtifact(page)).draft.content).toEqual(before);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    expect((await nativeArtifact(page)).draft.content).toEqual(after);
  });
}
