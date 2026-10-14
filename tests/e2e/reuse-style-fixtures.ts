import { expect, type Page, type TestInfo } from '@playwright/test';
import { create, nativeArtifact, setDocumentText } from './fixtures';
import { reuseMenu, reuseHistory } from './reuse-fixtures';
import { reusableParts } from '@editor-platform/templates';
import type { DocumentContent } from '@editor-platform/document/model';
import type { DesignContent } from '@editor-platform/design/model';
import type { SlideContent } from '@editor-platform/slide/model';
type StyledContent = DocumentContent | DesignContent | SlideContent;

const exact = { exact: true };
const editor = (page: Page) =>
  page.getByRole('dialog', { name: 'トークン・スタイルの下書き', ...exact });
const styleLibrary = (page: Page) =>
  page.getByRole('dialog', { name: 'トークン・スタイル', ...exact });
async function publishStyle(page: Page) {
  const draft = editor(page);
  await draft.getByRole('button', { name: '定義をプレビュー', ...exact }).click();
  await expect(draft.getByRole('region', { name: '定義のプレビュー' })).toBeVisible();
  await draft.getByRole('button', { name: '下書きを保存', ...exact }).click();
  await draft.getByRole('button', { name: '保存した版を公開', ...exact }).click();
  await expect(draft).toHaveCount(0);
}
async function chooseDefinition(page: Page, name: string) {
  await reuseMenu(page, 'トークン・スタイル');
  await styleLibrary(page)
    .getByRole('button', { name, ...exact })
    .click();
}
async function apply(page: Page, name: string) {
  const dialog = page.getByRole('dialog', { name, ...exact });
  await dialog.getByRole('button', { name: '変更をプレビュー', ...exact }).click();
  await dialog.getByRole('button', { name: 'プレビューした変更を適用', ...exact }).click();
  await expect(dialog).toHaveCount(0);
}

export async function brandStyleFlow(
  page: Page,
  info: TestInfo,
  domain: 'document' | 'design' | 'slide' = 'document',
) {
  page.setDefaultTimeout(12000);
  await page.goto('/');
  await create(page, domain);
  if (domain === 'document') await setDocumentText(page, 'p', 'ブランド本文');
  else {
    const tool = page.getByRole('button', { name: 'Insert text', ...exact });
    if (!(await tool.isVisible()))
      await page.getByRole('button', { name: 'More editor tools', ...exact }).click();
    await tool.click();
    await page.keyboard.press('Escape');
  }
  await reuseMenu(page, 'トークン・スタイル');
  await styleLibrary(page)
    .getByRole('button', { name: 'トークンセットを作成', ...exact })
    .click();
  let draft = editor(page);
  await draft.getByRole('textbox', { name: '定義名', ...exact }).fill('共通ブランド');
  await draft.getByRole('combobox', { name: '編集する値', ...exact }).selectOption('dark');
  await draft.getByRole('checkbox', { name: 'brand.primaryをdarkで上書き', ...exact }).check();
  await draft.getByLabel('brand.primaryの色', exact).fill('#99ccff');
  await draft.getByRole('combobox', { name: '編集する値', ...exact }).selectOption('');
  await draft.getByRole('textbox', { name: 'トークンID', ...exact }).fill('font.size');
  await draft.getByRole('combobox', { name: '値の型', ...exact }).selectOption('dimension');
  await draft.getByRole('button', { name: 'トークンを追加', ...exact }).click();
  await draft.getByRole('textbox', { name: 'トークンID', ...exact }).fill('brand.text');
  await draft.getByRole('combobox', { name: '値の型', ...exact }).selectOption('color');
  await draft.getByRole('button', { name: 'トークンを追加', ...exact }).click();
  await draft
    .getByRole('combobox', { name: 'brand.textの指定方法', ...exact })
    .selectOption('alias');
  await draft
    .getByRole('combobox', { name: 'brand.textの参照先', ...exact })
    .selectOption('brand.primary');
  await draft.getByRole('button', { name: '下書きを保存', ...exact }).click();
  await draft.getByRole('button', { name: 'Close トークン・スタイルの下書き', ...exact }).click();
  await styleLibrary(page)
    .getByRole('button', { name: '共通ブランド — 下書き 1', ...exact })
    .click();
  await publishStyle(page);
  await styleLibrary(page)
    .getByRole('button', { name: 'スタイルを作成', ...exact })
    .click();
  draft = editor(page);
  await draft.getByRole('textbox', { name: '定義名', ...exact }).fill('媒体の本文スタイル');
  await draft
    .getByRole('combobox', { name: '参照するトークンの版', ...exact })
    .selectOption({ label: '共通ブランド v1' });
  await draft
    .getByRole('combobox', {
      name: `スタイル属性: ${domain === 'document' ? 'color' : 'typography.color'}`,
      ...exact,
    })
    .selectOption('brand.text');
  await draft
    .getByRole('combobox', {
      name: `スタイル属性: ${domain === 'document' ? 'fontSize' : 'typography.fontSize'}`,
      ...exact,
    })
    .selectOption('font.size');
  await publishStyle(page);
  await styleLibrary(page)
    .getByRole('button', { name: 'Close トークン・スタイル', ...exact })
    .click();
  await reuseMenu(page, '再利用部品として保存');
  const author = page.getByRole('dialog', { name: '再利用部品として保存', ...exact });
  await author.getByRole('textbox', { name: '部品名', ...exact }).fill('ブランド部品');
  await author.getByRole('button', { name: '部品をプレビュー', ...exact }).click();
  const part = author.getByRole('combobox', { name: 'スタイルの対象', ...exact });
  await part.selectOption(
    (await part
      .locator('option')
      .filter({ hasText: domain === 'document' ? ' — paragraph ' : ' — text ' })
      .first()
      .getAttribute('value'))!,
  );
  await author
    .getByRole('combobox', { name: '採用するスタイルの版', ...exact })
    .selectOption({ label: '媒体の本文スタイル v1' });
  await author.getByRole('button', { name: '部品をプレビュー', ...exact }).click();
  await author.getByRole('button', { name: '部品を公開', ...exact }).click();
  await reuseMenu(page, '部品ライブラリ');
  let library = page.getByRole('dialog', { name: '部品ライブラリ', ...exact });
  await library.getByRole('button', { name: 'ブランド部品 v1', ...exact }).click();
  await library.locator('textarea[data-slot^="text_"]').first().fill('案件Aの本文');
  await apply(page, '部品ライブラリ');
  const inserted = (await nativeArtifact(page)).draft.content as StyledContent;
  const instance = inserted.reuse!.instances[0];
  const nativeBody = (content: typeof inserted) =>
    [...reusableParts(content).values()].find(
      (p) => p.text === '案件Aの本文' && p.type !== 'instance',
    )!;
  const appearance = (content: typeof inserted) =>
    nativeBody(content)[domain === 'document' ? 'style' : 'typography'] as {
      color: string;
      fontSize: number;
    };
  expect(appearance(inserted)).toMatchObject({
    color: '#336699',
    fontSize: domain === 'document' ? 12 : 16,
  });
  await reuseMenu(page, '部品の入力・表示');
  let inspector = page.getByRole('dialog', { name: '部品の入力・表示', ...exact });
  await inspector
    .getByRole('combobox', { name: '成果物で継承するモード', ...exact })
    .selectOption('dark');
  await inspector.getByRole('button', { name: '成果物のモードをプレビュー', ...exact }).click();
  await inspector.getByRole('button', { name: 'プレビューした変更を適用', ...exact }).click();
  const dark = (await nativeArtifact(page)).draft.content as StyledContent;
  expect(appearance(dark).color).toBe('#99ccff');
  expect(dark.reuse!.artifactMode).toBe('dark');
  await reuseHistory(page, 'Undo');
  expect((await nativeArtifact(page)).draft.content).toEqual(inserted);
  await reuseHistory(page, 'Redo');
  await reuseMenu(page, '部品の入力・表示');
  inspector = page.getByRole('dialog', { name: '部品の入力・表示', ...exact });
  await inspector.getByRole('button', { name: 'ブランド部品 v1', ...exact }).click();
  await inspector
    .getByRole('combobox', { name: '部品のトークンモード', ...exact })
    .selectOption('light');
  await apply(page, '部品の入力・表示');
  const explicit = (await nativeArtifact(page)).draft.content as StyledContent;
  expect(appearance(explicit).color).toBe('#336699');
  expect(explicit.reuse!.instances[0].mode).toBe('light');
  await chooseDefinition(page, '共通ブランド v1（共通トークン）');
  await styleLibrary(page)
    .getByRole('button', { name: '新版の下書きを作成', ...exact })
    .click();
  await editor(page).getByLabel('brand.primaryの色', exact).fill('#cc0000');
  await publishStyle(page);
  await styleLibrary(page)
    .getByRole('button', { name: '媒体の本文スタイル v1（スタイル）', ...exact })
    .click();
  await styleLibrary(page)
    .getByRole('button', { name: '新版の下書きを作成', ...exact })
    .click();
  await editor(page)
    .getByRole('combobox', { name: '参照するトークンの版', ...exact })
    .selectOption({ label: '共通ブランド v2' });
  await publishStyle(page);
  await styleLibrary(page)
    .getByRole('button', { name: 'Close トークン・スタイル', ...exact })
    .click();
  expect((await nativeArtifact(page)).draft.content).toEqual(explicit);
  await reuseMenu(page, '部品ライブラリ');
  library = page.getByRole('dialog', { name: '部品ライブラリ', ...exact });
  await library.getByRole('button', { name: 'ブランド部品 v1', ...exact }).click();
  await library.getByRole('button', { name: '新版の下書きを作成', ...exact }).click();
  const revision = page.getByRole('dialog', { name: '部品の下書き・新版公開', ...exact });
  const styledPart = revision.getByRole('combobox', { name: 'スタイルの対象', ...exact });
  await styledPart.selectOption(
    (await styledPart
      .locator('option')
      .filter({ hasText: domain === 'document' ? ' — paragraph ' : ' — text ' })
      .first()
      .getAttribute('value'))!,
  );
  await revision
    .getByRole('combobox', { name: '採用するスタイルの版', ...exact })
    .selectOption({ label: '媒体の本文スタイル v2' });
  await revision.getByRole('button', { name: '下書きを保存', ...exact }).click();
  await revision.getByRole('button', { name: '保存した版を公開', ...exact }).click();
  await library.getByRole('button', { name: 'Close 部品ライブラリ', ...exact }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(explicit);
  await reuseMenu(page, '部品の入力・表示');
  inspector = page.getByRole('dialog', { name: '部品の入力・表示', ...exact });
  await inspector.getByRole('button', { name: 'ブランド部品 v1', ...exact }).click();
  await inspector.locator('summary', { hasText: '改訂の採用・部品の差し替え' }).click();
  await inspector.getByRole('button', { name: '更新差分をプレビュー', ...exact }).click();
  await inspector.getByRole('button', { name: 'プレビューした変更を適用', ...exact }).click();
  const adopted = (await nativeArtifact(page)).draft.content as StyledContent;
  expect(appearance(adopted).color).toBe('#cc0000');
  expect(adopted.reuse!.instances[0].parts).toEqual(instance.parts);
  expect(adopted.reuse!.instances[0].mode).toBe('light');
  expect(adopted.reuse!.instances[0].ref.version).toBe(2);
  await reuseHistory(page, 'Undo');
  expect((await nativeArtifact(page)).draft.content).toEqual(explicit);
  await reuseHistory(page, 'Redo');
  expect((await nativeArtifact(page)).draft.content).toEqual(adopted);
  await expect(page.locator('.save-status')).toHaveText('Saved locally');
  await page.reload();
  expect((await nativeArtifact(page)).draft.content).toEqual(adopted);
  await reuseMenu(page, '部品の入力・表示');
  inspector = page.getByRole('dialog', { name: '部品の入力・表示', ...exact });
  await inspector.getByRole('button', { name: 'ブランド部品 v2', ...exact }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`${domain}-brand-adoption.png`), fullPage: true });
  if (domain === 'document') {
    await inspector.getByRole('button', { name: 'リンク解除をプレビュー', ...exact }).click();
    await inspector.getByRole('button', { name: 'プレビューした変更を適用', ...exact }).click();
    const detached = (await nativeArtifact(page)).draft.content as StyledContent;
    expect(detached.reuse).toMatchObject({ artifactMode: 'dark', instances: [], closures: [] });
    await reuseMenu(page, '部品の入力・表示');
    inspector = page.getByRole('dialog', { name: '部品の入力・表示', ...exact });
    await inspector
      .getByRole('combobox', { name: '成果物で継承するモード', ...exact })
      .selectOption('');
    await inspector.getByRole('button', { name: '成果物のモードをプレビュー', ...exact }).click();
    await inspector.getByRole('button', { name: 'プレビューした変更を適用', ...exact }).click();
    const cleared = (await nativeArtifact(page)).draft.content as StyledContent;
    expect(cleared.reuse).toBeUndefined();
    expect(appearance(cleared)).toEqual(appearance(adopted));
    await reuseHistory(page, 'Undo');
    await reuseHistory(page, 'Undo');
    expect((await nativeArtifact(page)).draft.content).toEqual(adopted);
  }
}
