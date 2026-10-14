import { test, expect, nativeArtifact } from './fixtures';
import { openWhole } from './template-fixtures';
import {
  collaborate,
  confirmed,
  download,
  finish,
  renderSvg,
  screenshot,
  value,
} from './practical-fixtures';
import type { WhiteboardContent } from '@editor-platform/whiteboard/model';

test('QL-03 thirty sticky notes: Sections, connectors, group move, membership, peers and reusable board', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(12000);
  await page.goto('/');
  const form = await openWhole(page, 'whiteboard', 'ブレインストーミング');
  for (let s = 0; s < 3; s++)
    await form
      .locator(`[data-slot="stage${s}"]`)
      .fill(
        Array.from(
          { length: 10 },
          (_, i) =>
            `${['観察', '整理', '試行'][s]} ${i + 1}：受付の${['案内', '入力', '確認'][i % 3]}を改善する`,
        ).join('\n'),
      );
  await form.getByRole('button', { name: '入力内容をプレビュー', exact: true }).click();
  await form.getByRole('button', { name: 'この内容で作成', exact: true }).click();
  await expect(form).toHaveCount(0);
  const original = (await nativeArtifact(page)).draft.content as WhiteboardContent;
  expect(original.nodes.filter((n) => n.kind === 'sticky')).toHaveLength(30);
  expect(original.sections).toHaveLength(3);
  const select = async (index: number, shift = false) => {
    const n = original.nodes[index];
    await page
      .getByRole('button', { name: `Layer ${n.name || `${n.kind} ${index + 1}`}`, exact: true })
      .click({ modifiers: shift ? ['Shift'] : [] });
  };
  await select(0);
  await select(1, true);
  await page.getByRole('button', { name: 'Connect selected', exact: true }).click();
  const edge = ((await nativeArtifact(page)).draft.content as WhiteboardContent).connectors.at(-1)!;
  expect([edge.from, edge.to].sort()).toEqual(
    original.nodes
      .slice(0, 2)
      .map((n) => n.id)
      .sort(),
  );
  const arrange = async (action: string) => {
    await page.getByRole('button', { name: 'Arrange', exact: true }).click();
    await page.getByRole('button', { name: action, exact: true }).click();
    await page.keyboard.press('Escape');
  };
  await arrange('Group');
  const grouped = (await nativeArtifact(page)).draft.content as WhiteboardContent;
  const groupIndex = grouped.nodes.findIndex((n) => n.kind === 'group');
  await page
    .getByRole('button', {
      name: `Layer ${grouped.nodes[groupIndex].name || `group ${groupIndex + 1}`}`,
      exact: true,
    })
    .click();
  await value(page, 'Element width', '430');
  await arrange('Ungroup');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(grouped);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  const shared = await collaborate(page, browser, baseURL, 'whiteboard');
  await select(1);
  await page.getByLabel('Object Section', { exact: true }).selectOption(original.sections![1].id);
  await confirmed(page);
  expect(((await nativeArtifact(page)).draft.content as WhiteboardContent).nodes[1].sectionId).toBe(
    original.sections![1].id,
  );
  await page.getByRole('button', { name: 'Add sticky', exact: true }).click();
  await value(page, 'Text', '削除する仮メモ');
  await confirmed(page);
  await page.getByRole('application', { name: 'Whiteboard canvas', exact: true }).press('Delete');
  await confirmed(page);
  const final = (await nativeArtifact(page)).draft.content as WhiteboardContent;
  expect(final.nodes.filter((n) => n.kind === 'sticky')).toHaveLength(30);
  expect(final.connectors.at(-1)).toEqual(edge);
  expect(JSON.stringify(final)).not.toContain('削除する仮メモ');
  expect(JSON.stringify(final)).toContain('人Bが確認した議題');
  await expect(page.getByRole('alert')).toHaveCount(0);
  if (
    (await page
      .getByRole('button', { name: 'Toggle Board inspector', exact: true })
      .getAttribute('aria-pressed')) !== 'true'
  )
    await page.getByRole('button', { name: 'Toggle Board inspector', exact: true }).click();
  await page.getByRole('button', { name: 'Fit board', exact: true }).click();
  await screenshot(page, 'whiteboard-overview');
  for (const [i, section] of final.sections!.entries()) {
    await page.getByRole('button', { name: `Go to Section ${section.title}`, exact: true }).click();
    if (!(await page.getByRole('button', { name: 'Export Section SVG', exact: true }).isVisible()))
      await page.getByRole('button', { name: 'Toggle Board inspector', exact: true }).click();
    const svg = await download(page, 'Export Section SVG', `board-section-${i + 1}.svg`);
    await renderSvg(page, svg, `board-section-${i + 1}`);
  }
  await shared.close();
  await finish(page, browser, baseURL, 'whiteboard');
});
