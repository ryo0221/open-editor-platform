import { test, expect } from './fixtures';
import { hostJson, openWorkflowHost, workflowTab } from './workflow-definition-fixtures';

const n = (i: number) => `n-${i.toString(16).padStart(32, '0')}`;

test('#99 WD4 Mind Map links: add from a branch, separate Undo, rename follows, drift and refusal', async ({
  page,
}, info) => {
  await openWorkflowHost(page);
  await workflowTab(page, 'マインドマップ');
  const panel = page.getByRole('region', { name: 'Mind Map branches' });
  await expect(panel).toContainText('対応あり 2・対応先が無い 0・対応が付いていない 2');

  // A branch becomes an acceptance; the Mind Map gets the link as its own edit.
  await panel.getByLabel('Kind for branch 関係者の合意').selectOption({ label: '達成条件にする' });
  await panel.getByLabel('ID for branch 関係者の合意').fill('agreement');
  await panel.getByRole('button', { name: 'Add branch 関係者の合意' }).click();
  await expect(panel).toContainText('対応あり 3');
  await expect(page.getByLabel('Mind Map status')).toHaveText('枝の操作');
  expect((await hostJson(page)).acceptance.map((a) => a.id)).toContain('agreement');
  await page.screenshot({ path: info.outputPath('workflow-mindmap.png') });
  // Two artifacts, two Undo records: undoing the Mind Map leaves the definition.
  await page.getByRole('button', { name: 'Mind Map Undo' }).click();
  await expect(panel).toContainText('対応が付いていない 2');
  expect((await hostJson(page)).acceptance.map((a) => a.id)).toContain('agreement');

  // Changing an ID asks the Mind Map to follow.
  await workflowTab(page, '一覧');
  await page.getByRole('button', { name: 'Change ID of 工程 research', exact: true }).click();
  await page.getByLabel('New ID of 工程 research', { exact: true }).fill('survey');
  await page.getByRole('button', { name: '変える', exact: true }).click();
  await workflowTab(page, 'マインドマップ');
  await expect(panel.getByRole('button', { name: '工程 survey' })).toBeVisible();

  // Deleting a linked element is shown as drift, not fixed silently; unlinking is explicit.
  await workflowTab(page, '一覧');
  await page.getByRole('button', { name: 'Delete 成果物 plan-doc', exact: true }).click();
  await page.getByRole('button', { name: '参照も外して削除' }).click();
  await workflowTab(page, 'マインドマップ');
  await expect(panel).toContainText('対応先が無い：成果物 plan-doc');
  await panel.getByRole('button', { name: 'Unlink branch 計画書' }).click();
  await expect(panel).toContainText('対応先が無い 0');

  // When the Mind Map refuses, the definition keeps the element and says the link is missing.
  await page.getByLabel('Mind Map refuses links').check();
  await panel.getByLabel('ID for branch Pilot').fill('pilot');
  await panel.getByRole('button', { name: 'Add branch Pilot' }).click();
  await expect(panel.getByRole('alert')).toContainText('枝の対応は付いていません');
  expect((await hostJson(page)).phases.map((p) => p.id)).toContain('pilot');
  // A refused rename link is reported by the Surface, after the row is remounted under the new ID.
  await workflowTab(page, '一覧');
  await page.getByRole('button', { name: 'Change ID of 工程 survey', exact: true }).click();
  await page.getByLabel('New ID of 工程 survey', { exact: true }).fill('trial');
  await page.getByRole('button', { name: '変える', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '古い ID のまま' })).toContainText(
    '工程 trial',
  );
  await page.getByLabel('Mind Map refuses links').uncheck();
  await workflowTab(page, 'マインドマップ');

  // The Mind Map Surface shows a link and removes it.
  await page.locator(`[data-node-id="${n(2)}"]`).click();
  const link = page.getByRole('group', { name: 'つながり' });
  await expect(link).toContainText('phase:survey');
  await link.getByRole('button', { name: 'つながりを外す' }).click();
  await expect(link).toContainText('なし');
});

test('#99 WD4 proposals: preview, apply as one edit, refuse a stale one, reject', async ({
  page,
}) => {
  await openWorkflowHost(page);
  await page.getByRole('button', { name: 'Propose', exact: true }).click();
  const proposal = page.getByRole('region', { name: 'Proposal' });
  await expect(proposal).toContainText('追加 達成条件 review.ok');
  // Nothing enters the definition until it is applied.
  expect((await hostJson(page)).acceptance.map((a) => a.id)).not.toContain('review.ok');
  await proposal.getByRole('button', { name: '提案を適用' }).click();
  await expect(page.getByLabel('Host status')).toHaveText('Proposal applied');
  expect((await hostJson(page)).acceptance.map((a) => a.id)).toContain('review.ok');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await hostJson(page)).acceptance.map((a) => a.id)).not.toContain('review.ok');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  // The same proposal again no longer applies; it can only be rejected.
  await page.getByRole('button', { name: 'Propose', exact: true }).click();
  await expect(proposal.getByRole('alert')).toContainText('適用できません');
  await expect(proposal.getByRole('button', { name: '提案を適用' })).toBeDisabled();
  await proposal.getByRole('button', { name: '提案を断る' }).click();
  await expect(page.getByLabel('Host status')).toHaveText('Proposal rejected');
  // Read only: a proposal cannot be applied.
  await page.getByLabel('Read only', { exact: true }).check();
  await page.getByRole('button', { name: 'Propose', exact: true }).click();
  await expect(proposal.getByRole('button', { name: '提案を適用' })).toBeDisabled();
});
