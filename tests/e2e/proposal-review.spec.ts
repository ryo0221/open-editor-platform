import { createArtifact } from '@editor-platform/artifact-core';
import type { StructuredData } from '@editor-platform/structured-data';
import { defaultView } from '@editor-platform/structured-data/views';
import { makeWhiteboardNode, type WhiteboardContent } from '@editor-platform/whiteboard/model';
import type { Page } from '@playwright/test';
import { test, expect, nativeArtifact, save } from './fixtures';

// #401: the Playground reviews Data and Whiteboard proposals as domain changes.
const data: StructuredData = {
  schemaVersion: 2,
  columns: [
    { id: 'name', name: 'Task', type: 'text' },
    { id: 'status', name: 'Status', type: 'select', options: ['Planned', 'Active', 'Done'] },
    { id: 'start', name: 'Start', type: 'date' },
    { id: 'end', name: 'End', type: 'date' },
  ],
  rows: [
    {
      id: 'task-design',
      values: { name: 'Design', status: 'Planned', start: '2026-10-05', end: '2026-10-09' },
    },
    {
      id: 'task-build',
      values: { name: 'Build', status: 'Planned', start: '2026-10-12', end: '2026-10-16' },
    },
  ],
};
data.views = [{ ...defaultView(data), id: 'plan', name: 'Plan', groupBy: 'status' }];
const board: WhiteboardContent = {
  schemaVersion: 3,
  sections: [],
  nodes: [
    {
      ...makeWhiteboardNode('sticky'),
      id: 'note-risks',
      name: 'Risks',
      text: 'Risks',
      bounds: { x: 120, y: 120, width: 180, height: 120 },
    },
    {
      ...makeWhiteboardNode('sticky'),
      id: 'note-ideas',
      name: 'Ideas',
      text: 'Ideas',
      bounds: { x: 420, y: 120, width: 180, height: 120 },
    },
  ],
  connectors: [],
};

async function open(page: Page, kind: string, name: string, content: unknown) {
  await page.goto('/');
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: `${name}.json`,
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({ ...createArtifact(kind, name, content as never), annotations: [] }),
    ),
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue(name);
  await save(page, 1);
}
async function propose(page: Page) {
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByRole('button', { name: 'External proposal demo', exact: true }).click();
  return page.getByRole('dialog', { name: 'External proposal preview' });
}
const changes = (page: Page) =>
  page
    .getByRole('region', { name: 'Proposed changes' })
    .locator('li')
    .evaluateAll((items) =>
      items.map((li) => [
        li.getAttribute('data-element-id'),
        li.getAttribute('data-kind'),
        li.textContent,
      ]),
    );

test('Data proposal shows the same record change from Grid, Kanban and Timeline', async ({
  page,
}, info) => {
  await open(page, 'data', 'Launch plan', data);
  const seen: unknown[] = [];
  for (const projection of ['Grid', 'Kanban', 'Timeline']) {
    await page.getByLabel('Data projection', { exact: true }).selectOption(projection);
    const dialog = await propose(page);
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    // The projection is private view state: no display-settings change is proposed.
    await expect(dialog.getByRole('region', { name: 'Display settings changes' })).toHaveCount(0);
    seen.push(await changes(page));
    if (projection === 'Timeline')
      await page.screenshot({ path: info.outputPath('data-proposal-timeline.png') });
    await dialog.getByRole('button', { name: 'Reject proposal', exact: true }).click();
    await page.keyboard.press('Escape');
  }
  expect(seen[0]).toEqual([
    [
      'task-design',
      'period',
      'Design task-design · period · Start – End (iso-date)2026-10-05 – 2026-10-09 → 2026-10-12 – 2026-10-16',
    ],
    ['task-design', 'field', 'Design task-design · field · StatusPlanned → Active'],
  ]);
  expect(seen[1]).toEqual(seen[0]);
  expect(seen[2]).toEqual(seen[0]);
  // Rejecting kept the draft; applying uses the native transaction and one Undo.
  expect(((await nativeArtifact(page)).draft.content as StructuredData).rows).toEqual(data.rows);
  await page.keyboard.press('Escape');
  const dialog = await propose(page);
  await dialog.getByRole('button', { name: 'Apply proposal', exact: true }).click();
  const applied = (await nativeArtifact(page)).draft.content as StructuredData;
  expect(applied.rows[0].values).toEqual({
    name: 'Design',
    status: 'Active',
    start: '2026-10-12',
    end: '2026-10-16',
  });
  expect(applied.rows[1]).toEqual(data.rows[1]);
  expect(applied.views).toEqual(data.views);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(((await nativeArtifact(page)).draft.content as StructuredData).rows).toEqual(data.rows);
});

test('Whiteboard proposal previews a move in board pixels before it is applied', async ({
  page,
}, info) => {
  await open(page, 'whiteboard', 'Retro board', board);
  await page.getByRole('button', { name: 'Layer Risks', exact: true }).click();
  const dialog = await propose(page);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  expect(await changes(page)).toEqual([
    [
      'note-risks',
      'move',
      'Risks note-risks · move · bounds (board-px)x 120, y 120 · 180 × 120 → x 200, y 160 · 180 × 120',
    ],
  ]);
  await expect(
    dialog.getByRole('img', { name: 'Move preview: from 120, 120 to 200, 160' }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath('whiteboard-proposal.png') });
  await dialog.getByRole('button', { name: 'Reject proposal', exact: true }).click();
  await page.keyboard.press('Escape');
  expect(((await nativeArtifact(page)).draft.content as WhiteboardContent).nodes).toEqual(
    board.nodes,
  );
  await page.keyboard.press('Escape');
  await (await propose(page)).getByRole('button', { name: 'Apply proposal', exact: true }).click();
  const moved = (await nativeArtifact(page)).draft.content as WhiteboardContent;
  expect(moved.nodes[0].bounds).toEqual({ x: 200, y: 160, width: 180, height: 120 });
  expect(moved.nodes[1]).toEqual(board.nodes[1]);
});
