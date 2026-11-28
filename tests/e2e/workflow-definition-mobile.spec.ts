import { test, expect } from './fixtures';
import {
  addElement,
  hostJson,
  noPageOverflow,
  openWorkflowHost,
  workflowTab,
} from './workflow-definition-fixtures';

test('#99 mobile workflow definition: flow, lists, matrix and Mind Map fit, add and Undo', async ({
  page,
}, info) => {
  await openWorkflowHost(page);
  await expect(page.getByRole('button', { name: 'Select node 調べる', exact: true })).toBeVisible();
  expect(await noPageOverflow(page)).toBe(true);
  await page.screenshot({ path: info.outputPath('workflow-flow-mobile.png') });
  await addElement(page, '役割', 'reviewer', 'レビュー担当');
  expect(JSON.stringify(await hostJson(page))).toContain('reviewer');
  await workflowTab(page, '一覧');
  expect(await noPageOverflow(page)).toBe(true);
  await page.screenshot({ path: info.outputPath('workflow-lists-mobile.png') });
  await workflowTab(page, 'マトリクス');
  expect(await noPageOverflow(page)).toBe(true);
  await page.screenshot({ path: info.outputPath('workflow-matrix-mobile.png') });
  await workflowTab(page, 'マインドマップ');
  expect(await noPageOverflow(page)).toBe(true);
  await page.screenshot({ path: info.outputPath('workflow-mindmap-mobile.png') });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(JSON.stringify(await hostJson(page))).not.toContain('reviewer');
});
