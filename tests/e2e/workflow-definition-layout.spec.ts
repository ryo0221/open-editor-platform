// #99: a changed phase or section ID keeps the place and frame the person gave it, in the same
// Undo record as the rename.
import { test, expect } from './fixtures';
import { type Page } from '@playwright/test';
import { openWorkflowHost, workflowTab } from './workflow-definition-fixtures';

const box = async (page: Page, selector: string) =>
  (await page.locator(selector).first().boundingBox())!;
/** The moved phase relative to an unmoved one, and the resized frame relative to the other frame. */
async function layout(page: Page, phase: string, section: string) {
  const node = await box(page, `[data-node-id="phase:${phase}"]`),
    still = await box(page, '[data-node-id="phase:plan"]'),
    frame = await box(page, `[data-section-id="section:${section}"]`),
    other = await box(page, '[data-section-id="section:late"]');
  return {
    dx: Math.round(node.x - still.x),
    dy: Math.round(node.y - still.y),
    width: Math.round((frame.width / other.width) * 100),
    height: Math.round((frame.height / other.height) * 100),
  };
}
async function rename(page: Page, kind: string, from: string, to: string) {
  await workflowTab(page, '一覧');
  await page.getByRole('button', { name: `Change ID of ${kind} ${from}`, exact: true }).click();
  await page.getByLabel(`New ID of ${kind} ${from}`, { exact: true }).fill(to);
  await page.getByRole('button', { name: '変える', exact: true }).click();
  await workflowTab(page, '流れ');
}

test('#99 a renamed phase and section keep their place and frame, with Undo and Redo', async ({
  page,
}) => {
  await openWorkflowHost(page);
  const host = page.getByRole('toolbar', { name: 'Host', exact: true });
  const initial = await layout(page, 'research', 'early');
  // Move a phase and resize its section by hand.
  const node = await box(page, '[data-node-id="phase:research"]');
  await page.mouse.move(node.x + node.width / 2, node.y + node.height / 2);
  await page.mouse.down();
  await page.mouse.move(node.x + node.width / 2 + 40, node.y + node.height / 2 + 30, { steps: 5 });
  await page.mouse.up();
  const corner = await box(page, '[aria-label="Resize section 前半"]');
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
  await page.mouse.down();
  await page.mouse.move(corner.x + 60, corner.y + 50, { steps: 5 });
  await page.mouse.up();
  const arranged = await layout(page, 'research', 'early');
  expect(arranged).not.toEqual(initial);

  await rename(page, '工程', 'research', 'survey');
  await rename(page, 'まとまり', 'early', 'first');
  expect(await layout(page, 'survey', 'first')).toEqual(arranged);

  // Undo takes back the rename and its layout move together; the old IDs keep the layout.
  await host.getByRole('button', { name: 'Undo', exact: true }).click();
  await host.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('[data-node-id="phase:research"]')).toBeVisible();
  expect(await layout(page, 'research', 'early')).toEqual(arranged);
  await host.getByRole('button', { name: 'Redo', exact: true }).click();
  await host.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.locator('[data-node-id="phase:survey"]')).toBeVisible();
  expect(await layout(page, 'survey', 'first')).toEqual(arranged);
});

test('#99 a Host without the joint write still keeps the layout across a rename', async ({
  page,
}) => {
  await openWorkflowHost(page);
  await page.getByLabel('Host commits layout with edits').uncheck();
  const node = await box(page, '[data-node-id="phase:research"]');
  await page.mouse.move(node.x + node.width / 2, node.y + node.height / 2);
  await page.mouse.down();
  await page.mouse.move(node.x + node.width / 2 + 40, node.y + node.height / 2 + 30, { steps: 5 });
  await page.mouse.up();
  const arranged = await layout(page, 'research', 'early');
  await rename(page, '工程', 'research', 'survey');
  expect(await layout(page, 'survey', 'early')).toEqual(arranged);
  await page
    .getByRole('toolbar', { name: 'Host', exact: true })
    .getByRole('button', { name: 'Undo', exact: true })
    .click();
  await expect(page.locator('[data-node-id="phase:research"]')).toBeVisible();
  expect(await layout(page, 'research', 'early')).toEqual(arranged);
});
