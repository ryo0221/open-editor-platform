import type { Page } from '@playwright/test';
import {
  test,
  expect,
  nativeArtifact,
  save,
  editorToolbarAction as workspaceTool,
} from './fixtures';
import type { DesignContent } from '@editor-platform/design/model';
import { commitVersion, type Artifact } from '@editor-platform/artifact-core';
import { captureDesignPages } from '@editor-platform/design/pagination';
import type { DesignPageProposalRequest } from '@editor-platform/design/page-proposals';

const host = (baseURL?: string) => /:4177$/.test(baseURL ?? '');
async function tools(page: Page) {
  await expect(page.locator('[data-workspace]')).toHaveAttribute('data-workspace', 'manga');
  const panel = page.getByRole('region', { name: 'Manga pages and panels' });
  const toggle = page.getByRole('button', { name: 'Toggle 漫画のページ・コマ', exact: true });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  await expect(panel).toBeVisible();
  return panel;
}
async function closeTools(page: Page) {
  const close = page.getByRole('button', { name: 'Close 漫画のページ・コマ', exact: true });
  if (await close.isVisible()) await close.click();
}
async function native(page: Page, independent: boolean): Promise<Artifact<DesignContent>> {
  if (!independent) return (await nativeArtifact(page)) as Artifact<DesignContent>;
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await expect(page.getByLabel('Save state', { exact: true })).toHaveText('Saved');
  return page.evaluate(() => JSON.parse(localStorage.getItem('authoring:comic')!));
}
async function open(page: Page, independent: boolean) {
  await page.goto(independent ? '/authoring.html' : '/');
  if (independent) {
    await page.getByRole('button', { name: 'Comic pages', exact: true }).click();
    await workspaceTool(page, '漫画ワークスペース');
    const panel = await tools(page);
    await panel.getByRole('button', { name: 'Add page', exact: true }).click();
  } else {
    await page.getByRole('button', { name: '漫画を作成', exact: true }).click();
  }
  await expect(page.locator('[data-workspace]')).toHaveAttribute('data-workspace', 'manga');
  return tools(page);
}
test('manga and Design share native content; linked slanted panels, Undo, save and reload', async ({
  page,
  baseURL,
}, info) => {
  const independent = host(baseURL),
    panel = await open(page, independent);
  await panel.getByRole('button', { name: '連動コマ割りをプレビュー', exact: true }).click();
  await panel.getByRole('button', { name: 'このコマ割りを採用', exact: true }).click();
  await panel.getByRole('button', { name: '分割をプレビュー', exact: true }).click();
  await panel.getByRole('button', { name: 'このコマ割りを採用', exact: true }).click();
  // A T junction: split the retained upper panel vertically.
  await panel.getByLabel('境界の法線角度', { exact: true }).fill('0');
  await panel.getByRole('button', { name: '分割をプレビュー', exact: true }).click();
  await panel.getByRole('button', { name: 'このコマ割りを採用', exact: true }).click();
  await panel.getByLabel('編集する境界', { exact: true }).selectOption({ index: 0 });
  await panel.getByRole('button', { name: '境界の値を読み込む', exact: true }).click();
  await panel.getByLabel('境界の法線角度', { exact: true }).fill('80');
  await panel.getByRole('button', { name: '境界変更をプレビュー', exact: true }).click();
  await panel.getByRole('button', { name: 'このコマ割りを採用', exact: true }).click();
  await panel.getByRole('button', { name: '単ページ', exact: true }).click();
  await closeTools(page);
  const before = await native(page, independent),
    linked = before.draft.content.pagination!.pages.find((p) => p.division)!;
  expect(before.draft.content.schemaVersion).toBe(4);
  expect(linked.panelIds).toHaveLength(3);
  expect(
    before.draft.content.elements
      .filter((e) => linked.panelIds.includes(e.id))
      .some((e) => e.panelGeometry!.polygon.some((p) => p.y !== 0 && p.y !== 1)),
  ).toBe(true);
  await workspaceTool(page, 'Designで詳細編集');
  const same = await native(page, independent);
  expect(same.draft.content).toEqual(before.draft.content);
  await workspaceTool(page, '漫画ワークスペース');
  const handle = page.getByRole('slider', { name: 'コマ境界 1', exact: true });
  await handle.focus();
  await handle.press('ArrowDown');
  const after = await native(page, independent);
  expect(after.draft.content).not.toEqual(before.draft.content);
  if (!(await page.getByRole('button', { name: 'Undo', exact: true }).isVisible()))
    await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.keyboard.press('Escape');
  expect((await native(page, independent)).draft.content).toEqual(before.draft.content);
  await page.screenshot({ path: info.outputPath('manga-linked-panels.png'), fullPage: true });
  if (!independent) await save(page, 1);
  await page.reload();
  if (independent) await page.getByRole('button', { name: 'Comic pages', exact: true }).click();
  expect((await native(page, independent)).draft.content).toEqual(before.draft.content);
  if (!independent)
    await expect(page.locator('[data-workspace]')).toHaveAttribute('data-workspace', 'manga');
});

test('toolbar dialogue stays on the current page after deselection and consecutive additions survive reading and capture', async ({
  page,
  baseURL,
}) => {
  const independent = host(baseURL),
    panel = await open(page, independent);
  await panel.getByRole('button', { name: 'Add page', exact: true }).click();
  await panel.getByRole('button', { name: '連動コマ割りをプレビュー', exact: true }).click();
  await panel.getByRole('button', { name: 'このコマ割りを採用', exact: true }).click();
  await panel.getByRole('button', { name: '単ページ', exact: true }).click();
  await closeTools(page);
  const before = (await native(page, independent)).draft.content;
  const target = before.pagination!.pages.at(-1)!;
  await page.locator('.canvas-stage').click({ position: { x: 5, y: 5 } });
  const add = page.getByRole('button', { name: '台詞を追加', exact: true });
  if (!(await add.isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await add.click();
  await add.click();
  if (await page.getByRole('button', { name: 'More editor tools', exact: true }).isVisible())
    await page.keyboard.press('Escape');
  const after = await native(page, independent);
  const added = after.draft.content.elements.filter(
    (e) => !before.elements.some((b) => b.id === e.id),
  );
  expect(added).toHaveLength(2);
  expect(added.every((e) => e.type === 'text' && e.parentId === target.panelIds[0])).toBe(true);
  await tools(page);
  await expect(
    panel.getByRole('button', { name: `ページ ${before.pagination!.pages.length}`, exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await panel.getByRole('button', { name: '見開き', exact: true }).click();
  await closeTools(page);
  const reading = page.getByRole('region', { name: '漫画の通読', exact: true });
  await expect(reading.locator('svg text').filter({ hasText: added[0].text! })).toHaveCount(2);
  await reading.getByRole('button', { name: '通読を閉じる', exact: true }).click();
  const saved = await commitVersion(after, null, 'Toolbar dialogue');
  const capture = await captureDesignPages(saved, saved.versions.at(-1)!.versionId, {
    mode: 'vector',
  });
  expect(capture.ok).toBe(true);
  const texts = await page.evaluate(
    (svg) =>
      [...new DOMParser().parseFromString(svg, 'image/svg+xml').querySelectorAll('text')].map(
        (n) => n.textContent,
      ),
    capture.pages.at(-1)!.svg,
  );
  expect(texts.filter((text) => text === added[0].text)).toHaveLength(2);
  await workspaceTool(page, '元に戻す');
  const undone = (await native(page, independent)).draft.content;
  expect(undone.elements.filter((e) => added.some((a) => a.id === e.id))).toHaveLength(1);
});

test('toolbar and sidebar dialogue remain visible inside a lower triangular panel', async ({
  page,
  baseURL,
}, info) => {
  const independent = host(baseURL),
    panel = await open(page, independent);
  await panel.getByRole('button', { name: '連動コマ割りをプレビュー', exact: true }).click();
  await panel.getByRole('button', { name: 'このコマ割りを採用', exact: true }).click();
  await panel
    .getByLabel('境界の法線角度', { exact: true })
    .fill(String((Math.atan2(540, 740) * 180) / Math.PI));
  await panel.getByRole('button', { name: '分割をプレビュー', exact: true }).click();
  await panel.getByRole('button', { name: 'このコマ割りを採用', exact: true }).click();
  await panel.getByLabel('分割するコマ', { exact: true }).selectOption({ index: 1 });
  await panel.getByRole('button', { name: '単ページ', exact: true }).click();
  await closeTools(page);
  const before = (await native(page, independent)).draft.content;
  const target = before.pagination!.pages.find((p) => p.division)!;
  const triangle = before.elements.find((e) => e.id === target.panelIds[1])!;
  expect(triangle.panelGeometry!.polygon).toHaveLength(3);
  const add = page.getByRole('button', { name: '台詞を追加', exact: true });
  if (!(await add.isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await add.click();
  await page.keyboard.press('Escape');
  const first = (await native(page, independent)).draft.content.elements.at(-1)!;
  expect(first.parentId).toBe(triangle.id);
  const text = page.locator(`[data-canvas-target="${first.id}"] text`).first();
  await expect(text).toBeVisible();
  const shot = await text.screenshot({
    path: info.outputPath('triangle-dialogue.png'),
    scale: 'css',
  });
  const ink = await page.evaluate(
    async (src) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4)
        if (pixels[i] === 48 && pixels[i + 1] === 74 && pixels[i + 2] === 57) count++;
      return count;
    },
    'data:image/png;base64,' + shot.toString('base64'),
  );
  expect(ink).toBeGreaterThan(0);
  await tools(page);
  await panel
    .getByRole('button', { name: /^Add dialogue to panel / })
    .last()
    .click();
  await closeTools(page);
  const after = await native(page, independent);
  const added = after.draft.content.elements.filter(
    (e) => !before.elements.some((b) => b.id === e.id),
  );
  expect(added).toHaveLength(2);
  for (const dialogue of added) {
    expect(dialogue.parentId).toBe(triangle.id);
    const b = dialogue.bounds,
      owner = triangle.bounds;
    for (const [x, y] of [
      [b.x, b.y],
      [b.x + b.width, b.y],
      [b.x + b.width, b.y + b.height],
      [b.x, b.y + b.height],
    ]) {
      const u = (x - owner.x) / owner.width,
        v = (y - owner.y) / owner.height;
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(u + v).toBeGreaterThan(1);
    }
  }
  const saved = await commitVersion(after, null, 'Triangle dialogue');
  const capture = await captureDesignPages(saved, saved.versions.at(-1)!.versionId, {
    mode: 'vector',
  });
  expect(capture.ok).toBe(true);
  expect(capture.pages.at(-1)!.svg).toContain('台詞');
  expect(capture.pages.at(-1)!.svg).toContain('Dialogue');
});

test('workspace prop changes wait for a pointer gesture and cancel creates no edit', async ({
  page,
  baseURL,
}) => {
  const independent = host(baseURL),
    panel = await open(page, independent);
  await panel.getByRole('button', { name: '連動コマ割りをプレビュー', exact: true }).click();
  await panel.getByRole('button', { name: 'このコマ割りを採用', exact: true }).click();
  await panel.getByRole('button', { name: '分割をプレビュー', exact: true }).click();
  await panel.getByRole('button', { name: 'このコマ割りを採用', exact: true }).click();
  await panel.getByRole('button', { name: '単ページ', exact: true }).click();
  await closeTools(page);
  const before = (await native(page, independent)).draft.content;
  const handle = page.getByRole('slider', { name: 'コマ境界 1', exact: true });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 15, { steps: 3 });
  // Controlled Host prop change while the original pointer remains captured.
  await workspaceTool(page, 'Designで詳細編集', true);
  await expect(page.locator('[data-workspace]')).toHaveAttribute('data-workspace', 'manga');
  await expect(page.getByRole('button', { name: '切替を取り消す', exact: true })).toBeVisible();
  const overflow = page.getByRole('button', { name: 'More editor tools', exact: true });
  if (await overflow.isVisible()) await overflow.evaluate((e) => (e as HTMLButtonElement).click());
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('[data-workspace]')).toHaveAttribute('data-workspace', 'design');
  expect((await native(page, independent)).draft.content).toEqual(before);
});

test('draws a diagonal split as a preview before adoption', async ({ page, baseURL }, info) => {
  const independent = host(baseURL),
    panel = await open(page, independent);
  await panel.getByRole('button', { name: '連動コマ割りをプレビュー', exact: true }).click();
  await panel.getByRole('button', { name: 'このコマ割りを採用', exact: true }).click();
  await panel.getByRole('button', { name: '単ページ', exact: true }).click();
  await closeTools(page);
  const before = (await native(page, independent)).draft.content;
  await tools(page);
  await panel.getByRole('button', { name: '線を引いて分割', exact: true }).click();
  await closeTools(page);
  const rect = page.getByRole('button', { name: '分割線をドラッグ', exact: true }),
    box = (await rect.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.05, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.95, box.y + box.height * 0.55, { steps: 6 });
  await page.mouse.up();
  await tools(page);
  await expect(
    panel.getByRole('region', { name: 'コマ割りプレビュー', exact: true }),
  ).toBeVisible();
  await closeTools(page);
  // Saving a new version intentionally invalidates this pending preview in the independent Host.
  // Its state remains Saved until adoption; inspect the saved source without creating a version.
  if (independent) {
    await expect(page.getByLabel('Save state', { exact: true })).toHaveText('Saved');
    expect(
      await page.evaluate(() => JSON.parse(localStorage.getItem('authoring:comic')!).draft.content),
    ).toEqual(before);
  } else expect((await native(page, false)).draft.content).toEqual(before);
  await tools(page);
  await panel.getByRole('button', { name: 'このコマ割りを採用', exact: true }).click();
  await closeTools(page);
  const after = (await native(page, independent)).draft.content;
  expect(after.pagination!.pages.find((p) => p.division)!.panelIds).toHaveLength(2);
  await page.screenshot({ path: info.outputPath('drawn-diagonal.png'), fullPage: true });
});

test('retains composing dialogue across a controlled workspace switch', async ({
  page,
  baseURL,
}) => {
  const independent = host(baseURL),
    panel = await open(page, independent);
  await panel.getByRole('button', { name: '連動コマ割りをプレビュー', exact: true }).click();
  await panel.getByRole('button', { name: 'このコマ割りを採用', exact: true }).click();
  await panel
    .getByRole('button', { name: /^Add dialogue to panel / })
    .last()
    .click();
  await closeTools(page);
  const field = page.getByLabel('Text', { exact: true });
  if (!(await field.isVisible()))
    await page.getByRole('button', { name: 'Toggle Design inspector', exact: true }).click();
  await field.dispatchEvent('compositionstart', { data: '入力' });
  await field.fill('入力を保持する');
  await workspaceTool(page, 'Designで詳細編集', true);
  await expect(page.locator('[data-workspace]')).toHaveAttribute('data-workspace', 'manga');
  await expect(page.getByRole('button', { name: '切替を取り消す', exact: true })).toBeVisible();
  const overflow = page.getByRole('button', { name: 'More editor tools', exact: true });
  if (await overflow.isVisible()) await overflow.evaluate((e) => (e as HTMLButtonElement).click());
  await field.dispatchEvent('compositionend', { data: '入力を保持する' });
  await field.press('Enter');
  await expect(page.locator('[data-workspace]')).toHaveAttribute('data-workspace', 'design');
  const close = page.getByRole('button', { name: 'Close Design inspector', exact: true });
  if (await close.isVisible()) await close.click();
  expect(
    (await native(page, independent)).draft.content.elements.some(
      (e) => e.text === '入力を保持する',
    ),
  ).toBe(true);
  if (independent) {
    await page.getByRole('checkbox', { name: 'Read only', exact: true }).check();
    await workspaceTool(page, '漫画ワークスペース');
    await tools(page);
    await expect(
      panel.getByRole('button', { name: '分割をプレビュー', exact: true }),
    ).toBeDisabled();
  }
});

test('reviews a dependency-closed boundary change, keeps unselected dialogue and rejects the old proposal after Undo', async ({
  page,
  baseURL,
}, info) => {
  const independent = host(baseURL),
    panel = await open(page, independent);
  await panel.getByRole('button', { name: '連動コマ割りをプレビュー', exact: true }).click();
  await panel.getByRole('button', { name: 'このコマ割りを採用', exact: true }).click();
  await panel.getByRole('button', { name: '分割をプレビュー', exact: true }).click();
  await panel.getByRole('button', { name: 'このコマ割りを採用', exact: true }).click();
  await panel
    .getByRole('button', { name: /^Add dialogue to panel / })
    .last()
    .click();
  await closeTools(page);
  const before = (await native(page, independent)).draft.content;
  const review = page.getByRole('region', { name: '漫画の変更提案', exact: true });
  const openReview = async () => {
    if (!(await review.isVisible()))
      await page.getByRole('button', { name: 'Toggle Design inspector', exact: true }).click();
  };
  await openReview();
  await review.getByText('提案データを読み込む', { exact: true }).click();
  await review.getByRole('button', { name: '現在の対象情報を表示', exact: true }).click();
  const context = JSON.parse(
    await review.getByLabel('提案の対象情報', { exact: true }).inputValue(),
  ) as Pick<DesignPageProposalRequest, 'artifactId' | 'baseLocalRevision' | 'reads'> & {
    pages: NonNullable<DesignContent['pagination']>['pages'];
  };
  const target = context.pages.find((p) => p.division)!,
    root = target.division!.root;
  if (!('dividerId' in root)) throw Error('Expected split fixture');
  const dialogue = before.elements.find(
    (e) => e.type === 'text' && e.parentId === target.panelIds[1],
  )!;
  const request: DesignPageProposalRequest = {
    id: 'review-boundary',
    summary: '境界を広げる案',
    artifactId: context.artifactId,
    baseLocalRevision: context.baseLocalRevision,
    reads: context.reads,
    units: [
      {
        id: 'boundary',
        label: '境界を広げる',
        requires: [],
        operations: [
          {
            type: 'setDivider',
            pageId: target.frameId,
            dividerId: root.dividerId,
            line: { ...root.line, offset: root.line.offset + 20 },
            gap: root.gap,
          },
        ],
      },
      {
        id: 'dialogue',
        label: '台詞を変える',
        requires: ['boundary'],
        operations: [{ type: 'text', id: dialogue.id, value: '採用しない台詞' }],
      },
    ],
  };
  await review.getByLabel('提案JSON', { exact: true }).fill(JSON.stringify(request));
  await review.getByRole('button', { name: '提案を読み込む', exact: true }).click();
  await review.getByRole('checkbox', { name: /^台詞を変える/ }).uncheck();
  await review.getByRole('button', { name: '選択した変更を再プレビュー', exact: true }).click();
  await review.getByLabel('比較するページ', { exact: true }).selectOption(target.frameId);
  await expect(review.getByRole('region', { name: '採用後', exact: true })).toBeVisible();
  const resources = await page.evaluate(() => {
    const clips = [...document.querySelectorAll('clipPath[id]')];
    const references = [...document.querySelectorAll('[clip-path]')];
    return {
      ids: clips.map((e) => e.id),
      invalid: references
        .filter((e) => {
          const id = e.getAttribute('clip-path')!.match(/^url\(#(.+)\)$/)?.[1];
          return !id || !e.closest('svg')?.contains(document.getElementById(id));
        })
        .map((e) => e.getAttribute('clip-path')),
    };
  });
  expect(resources.ids.length).toBeGreaterThan(0);
  expect(new Set(resources.ids).size).toBe(resources.ids.length);
  expect(resources.invalid).toEqual([]);
  const clips = async (label: string) =>
    review
      .getByRole('region', { name: label, exact: true })
      .locator('clipPath path')
      .evaluateAll((paths) => paths.map((p) => p.getAttribute('d')));
  expect(await clips('採用後')).not.toEqual(await clips('採用前'));
  await review.getByRole('region', { name: '採用後', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('partial-proposal-review.png'), fullPage: true });
  await review.getByRole('button', { name: '選択した変更を採用', exact: true }).click();
  await page.getByRole('button', { name: 'Close Design inspector', exact: true }).click();
  const after = (await native(page, independent)).draft.content;
  expect(after.elements.find((e) => e.id === dialogue.id)!.text).toBe(dialogue.text);
  const changed = after.pagination!.pages.find((p) => p.frameId === target.frameId)!.division!.root;
  expect('line' in changed && changed.line.offset).toBe(root.line.offset + 20);
  await workspaceTool(page, '元に戻す');
  expect((await native(page, independent)).draft.content).toEqual(before);
  await openReview();
  await review.getByRole('button', { name: '提案を読み込む', exact: true }).click();
  await review.getByRole('button', { name: '選択した変更を再プレビュー', exact: true }).click();
  await expect(review.getByRole('alert')).toContainText('draft changed');
});
