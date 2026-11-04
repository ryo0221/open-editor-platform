import { createArtifact, commitVersion } from '@editor-platform/artifact-core';
import {
  createDesign,
  insertDesignPath,
  presetDesignPath,
  insertElement,
  patchDesign,
  updateElement,
} from '@editor-platform/design/model';
import { test, expect, create, nativeArtifact, save } from './fixtures';
import type { Page } from '@playwright/test';
import type { InkContext } from '../../apps/playground/src/app/design-ink-proposal';
import { readFile } from 'node:fs/promises';
const button = (p: Page, n: string) => p.getByRole('button', { name: n, exact: true });
const read = (p: Page) => p.evaluate(() => window.playgroundInk!.read());
async function tool(p: Page, n: string) {
  if (!(await button(p, n).isVisible())) await button(p, 'More editor tools').click();
  await button(p, n).click();
  if (
    await p
      .getByRole('dialog', { name: 'More editor tools', exact: true })
      .isVisible()
      .catch(() => false)
  )
    await p.keyboard.press('Escape');
}
async function openInkTools(p: Page) {
  const region = p.getByRole('region', { name: '作画ツール', exact: true });
  if (!(await region.isVisible())) {
    const opener = button(p, '作画ツールを開く');
    if (!(await opener.isVisible())) await button(p, 'More editor tools').click();
    await opener.click();
  }
  await expect(region).toBeVisible();
}
async function ink(p: Page) {
  await tool(p, 'Draw ink stroke');
  const c = (await p
    .getByRole('application', { name: 'Design canvas', exact: true })
    .boundingBox())!;
  await p.mouse.move(c.x + c.width * 0.25, c.y + c.height * 0.45);
  await p.mouse.down();
  await p.mouse.move(c.x + c.width * 0.45, c.y + c.height * 0.55, { steps: 12 });
  await p.mouse.up();
  await tool(p, 'Finish drawing strokes');
}
function request(c: InkContext) {
  const e = c.content.elements.find((e) => e.path)!,
    path = structuredClone(e.path!);
  path.subpaths[0].anchors[0].y += 8;
  return {
    id: 'playground-coauthor',
    summary: '同じ線のカーブを修正',
    artifactId: c.artifactId,
    baseRevision: c.revision,
    operations: [{ type: 'replace', id: e.id, path }],
  };
}
async function undo(p: Page) {
  if (!(await button(p, 'Undo').isVisible())) await button(p, 'More artifact actions').click();
  await button(p, 'Undo').click();
  await p.keyboard.press('Escape');
}
test('ordinary Playground pen, AI preview/apply, human reedit, Undo and saved reload use the same path', async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await create(page, 'design');
  await openInkTools(page);
  await button(page, '白紙の作画ページを用意').click();
  const initial = await read(page);
  await ink(page);
  const human = await read(page);
  expect(human.content.elements.filter((e) => e.path)).toHaveLength(
    initial.content.elements.filter((e) => e.path).length + 1,
  );
  const proposal = request(human);
  await openInkTools(page);
  await page.getByText('線を描く・AIと編集する', { exact: true }).click();
  const next = page.waitForEvent('download');
  await button(page, 'AIに渡す作画データを保存').click();
  const context = JSON.parse(await readFile((await (await next).path())!, 'utf8'));
  expect(context.content).toEqual(human.content);
  expect(context.revision).toEqual(human.revision);
  await page.getByLabel('作画提案を開く', { exact: true }).setInputFiles({
    name: 'proposal.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(proposal)),
  });
  expect((await read(page)).content).toEqual(human.content);
  await expect(page.getByRole('dialog', { name: '作画案を確認' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('proposal.png') });
  await button(page, '作画案を採用').click();
  const details = page.getByText('線を描く・AIと編集する', { exact: true });
  if (await details.isVisible()) await details.click();
  const after = await read(page);
  expect(after.content).not.toEqual(human.content);
  if (!(await page.getByLabel('Search layers').isVisible()))
    await button(page, 'Toggle Design navigator').click();
  await page.getByLabel('Search layers').fill('Hand drawn stroke');
  await page
    .locator(`[data-layer-id="${proposal.operations[0].id}"]`)
    .getByRole('button', { name: /^Layer / })
    .click();
  await button(page, 'Close Design navigator').click();
  if (
    !(await page.getByRole('complementary', { name: 'Design inspector', exact: true }).isVisible())
  )
    await button(page, 'Toggle Design inspector').click();
  await button(page, 'Edit path points').click();
  await page.getByLabel('Path point', { exact: true }).selectOption({ label: 'Anchor 1.1' });
  const x = page.getByLabel('Path point X', { exact: true });
  await x.fill(String(Number(await x.inputValue()) + 3));
  await x.press('Enter');
  await button(page, 'Finish point editing').click();
  await button(page, 'Close Design inspector').click();
  expect((await read(page)).content).not.toEqual(after.content);
  await undo(page);
  expect((await read(page)).content).toEqual(after.content);
  await undo(page);
  expect((await read(page)).content).toEqual(human.content);
  await save(page, 1);
  const exported = await nativeArtifact(page);
  await page.reload();
  await expect
    .poll(async () => Boolean(await page.evaluate(() => window.playgroundInk)))
    .toBe(true);
  expect((await read(page)).content).toEqual(exported.draft.content);
  await page.screenshot({ path: info.outputPath('playground-ink.png') });
});
test('ordinary Library imports a staged manuscript preserving versions and draws into a visible group', async ({
  page,
}) => {
  let c = createDesign();
  for (const id of ['rough', 'ink', 'alternate'])
    c = insertElement('group', { id, bounds: { x: 0, y: 0, width: 800, height: 1000 } }).apply(c);
  c = updateElement('alternate', { name: '別の描画層' }).apply(c);
  c = patchDesign(['rough'], { hidden: true }).apply(c);
  c = insertDesignPath(
    presetDesignPath('line'),
    { x: 10, y: 10, width: 200, height: 150 },
    'ink',
  ).apply(c);
  const source = await commitVersion(createArtifact('design', '段階原稿', c), null, 'ink');
  await page.goto('/');
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'ink.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(source)),
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('段階原稿');
  const imported = await nativeArtifact(page);
  expect(imported.id).not.toEqual(source.id);
  expect(imported.versions.map((v) => v.contentHash)).toEqual(
    source.versions.map((v) => v.contentHash),
  );
  expect(imported.draft.content).toEqual(c);
  await openInkTools(page);
  await page.getByLabel('描くレイヤー', { exact: true }).selectOption('ink');
  await ink(page);
  const current = await read(page);
  expect(current.content.elements.at(-1)?.parentId).toBe('ink');
  expect(current.content.elements.find((e) => e.id === 'rough')?.hidden).toBe(true);
  if (!(await page.getByLabel('Search layers').isVisible()))
    await button(page, 'Toggle Design navigator').click();
  await page.getByLabel('Search layers').fill('別の描画層');
  await page
    .locator('[data-layer-id="alternate"]')
    .getByRole('button', { name: 'Layer 別の描画層', exact: true })
    .click();
  await button(page, 'Close Design navigator').click();
  await openInkTools(page);
  await page.getByLabel('描くレイヤー', { exact: true }).selectOption('ink');
  await ink(page);
  expect((await read(page)).content.elements.at(-1)?.parentId).toBe('ink');
});
test('outside-bounds path edits remain visible in the proposal image before applying', async ({
  page,
}, info) => {
  await page.goto('/');
  await create(page, 'design');
  await ink(page);
  const current = await read(page),
    proposal = request(current);
  for (const sub of proposal.operations[0].path.subpaths) {
    for (const a of sub.anchors) a.x += 1000;
    for (const edge of sub.segments)
      if (edge.type === 'cubic') {
        edge.c1.x += 1000;
        edge.c2.x += 1000;
      }
  }
  await page.evaluate((p) => window.playgroundInk!.propose(p), proposal);
  const pixels = await page
    .getByRole('img', { name: '提案された線画', exact: true })
    .evaluate(async (node) => {
      const img = node as HTMLImageElement;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = 0;
      for (let i = 0; i < data.length; i += 4)
        if (data[i + 3] > 0 && Math.min(data[i], data[i + 1], data[i + 2]) < 200) ink++;
      return ink;
    });
  await page.screenshot({ path: info.outputPath('outside-bounds-proposal.png') });
  expect(pixels).toBeGreaterThan(0);
  expect((await read(page)).content).toEqual(current.content);
  await button(page, '作画案を却下').click();
});
test('stale proposals, unfinished strokes and readonly cannot change the live draft', async ({
  page,
}) => {
  await page.goto('/');
  await create(page, 'design');
  await ink(page);
  const old = await read(page),
    proposal = request(old);
  await ink(page);
  expect(
    await page.evaluate((p) => {
      try {
        window.playgroundInk!.propose(p);
        return false;
      } catch {
        return true;
      }
    }, proposal),
  ).toBe(true);
  const current = await read(page);
  await tool(page, 'Draw ink stroke');
  const c = (await page
    .getByRole('application', { name: 'Design canvas', exact: true })
    .boundingBox())!;
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
  await page.mouse.down();
  await page.mouse.move(c.x + c.width / 2 + 25, c.y + c.height / 2 + 25);
  expect(
    await page.evaluate(() => {
      try {
        window.playgroundInk!.read();
        return false;
      } catch {
        return true;
      }
    }),
  ).toBe(true);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect((await read(page)).content).toEqual(current.content);
  await button(page, 'More artifact actions').click();
  await page.getByLabel('Read only', { exact: true }).check();
  await page.keyboard.press('Escape');
  expect(
    await page.evaluate(
      (p) => {
        try {
          window.playgroundInk!.propose(p);
          return false;
        } catch {
          return true;
        }
      },
      request(await read(page)),
    ),
  ).toBe(true);
  await openInkTools(page);
  await expect(page.getByLabel('描くレイヤー', { exact: true })).toBeDisabled();
});
