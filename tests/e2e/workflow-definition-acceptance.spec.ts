// #99 acceptance flows (design §10 WD5): a new definition from a Mind Map, and a published
// definition repaired and extended, each checked with the pinned OWD check at the end.
import { readFileSync } from 'node:fs';
import { test, expect } from './fixtures';
import {
  addElement,
  hostJson,
  openWorkflowHost,
  workflowTab,
} from './workflow-definition-fixtures';
import { check } from '../../packages/workflow-definition/fixtures/owd-446706b/src/check.mjs';

const definitions = 'packages/workflow-definition/fixtures/owd-446706b/definitions';
async function importJson(page: import('@playwright/test').Page, value: unknown) {
  await page
    .getByRole('toolbar', { name: 'Host', exact: true })
    .getByRole('button', { name: 'JSON', exact: true })
    .click();
  await page.getByLabel('Definition JSON text').fill(JSON.stringify(value));
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByLabel('Host status')).toHaveText('Imported');
}

test('#99 acceptance: a new definition from Mind Map branches, finished until the OWD check passes', async ({
  page,
}, info) => {
  await openWorkflowHost(page);
  await importJson(page, {
    format: 1,
    id: 'pilot-plan',
    version: '0.1.0',
    title: '試験運用',
    purpose: 'マインドマップで洗い出したことから工程を作る。',
    phases: [],
    deliverables: [],
    acceptance: [],
  });
  await workflowTab(page, 'マインドマップ');
  const panel = page.getByRole('region', { name: 'Mind Map branches' });
  // Branches linked to another definition are not this one's.
  await expect(panel).toContainText('ほか 2');
  await panel.getByLabel('ID for branch Pilot').fill('pilot');
  await panel.getByRole('button', { name: 'Add branch Pilot' }).click();
  await panel.getByLabel('Kind for branch 関係者の合意').selectOption({ label: '成果物にする' });
  await panel.getByLabel('ID for branch 関係者の合意').fill('agreement');
  await panel.getByRole('button', { name: 'Add branch 関係者の合意' }).click();
  await expect(panel).toContainText('対応あり 2');

  // The rest is filled in the lists: purpose, form, the phase's deliverable and its acceptance.
  await workflowTab(page, '一覧');
  const fill = async (label: string, value: string) => {
    const field = page.getByLabel(label, { exact: true });
    await field.fill(value);
    await field.press('Enter');
  };
  await fill('Purpose of pilot', '小さく試す');
  await fill('Form of agreement', '文書');
  await page.getByLabel('Add to Deliverables of pilot').selectOption('agreement');
  await addElement(page, '達成条件', 'agreement.ok', '関係者が合意している');
  await page.getByLabel('Checked by of agreement.ok').selectOption('人');
  await page.getByLabel('Target of agreement.ok').selectOption('agreement');
  await page.getByLabel('Add to Acceptance of pilot').selectOption('agreement.ok');
  // The OWD check still reports the empty outline until a heading is added.
  await page.getByRole('button', { name: /^診断 [1-9]/ }).click();
  await expect(page.getByRole('region', { name: 'Diagnostics' })).toContainText('outline');
  await page.getByRole('button', { name: 'Select 成果物 agreement', exact: true }).click();
  await page
    .getByRole('region', { name: 'Outline of agreement' })
    .getByRole('button', { name: '見出しを足す' })
    .click();
  const json = await hostJson(page);
  expect(check(json)).toEqual([]);
  await expect(page.getByRole('button', { name: /^診断 0 件/ })).toBeVisible();
  await page.screenshot({ path: info.outputPath('new-definition.png') });
});

test('#99 acceptance: a published definition repaired and extended, sections and rules included', async ({
  page,
}, info) => {
  await openWorkflowHost(page);
  const original = JSON.parse(readFileSync(`${definitions}/fiction-manga.json`, 'utf8'));
  await importJson(page, original);
  await expect(page.getByRole('button', { name: /^診断 0 件/ })).toBeVisible();

  // A broken reference is shown as a structure problem and repaired.
  const broken = structuredClone(original);
  broken.phases[1].after = ['missing-phase'];
  await importJson(page, broken);
  await expect(page.getByRole('button', { name: /構造の問題 1/ })).toBeVisible();
  await workflowTab(page, '一覧');
  await page.getByRole('button', { name: 'Remove missing-phase from After of concept' }).click();
  await page.getByLabel('Add to After of concept').selectOption('process');
  await expect(page.getByRole('button', { name: /^診断 0 件/ })).toBeVisible();

  // Sections: add one, move a phase into it explicitly, then delete it again.
  await addElement(page, 'まとまり', 'review', '見直し');
  await page.getByRole('button', { name: 'Remove story from Phases of design' }).click();
  await page.getByLabel('Add to Phases of review').selectOption('story');
  let json = await hostJson(page);
  expect(json.sections.find((s) => s.id === 'review')?.phases).toEqual(['story']);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Delete まとまり review', exact: true }).click();
  json = await hostJson(page);
  expect(json.sections.map((s) => s.id)).not.toContain('review');
  expect(json.sections.find((s) => s.id === 'design')?.phases).toContain('story');

  // Rules: a new citation pair from the matrix, then refused input changes nothing.
  await workflowTab(page, 'マトリクス');
  await page.getByRole('button', { name: 'Allow cites theme → art-rule', exact: true }).click();
  const pair = page.getByRole('group', { name: 'New cites theme → art-rule' });
  await pair.getByLabel('New rule ID for theme → art-rule').fill('Bad ID');
  await pair.getByRole('button', { name: '新しい規則' }).click();
  await expect(pair.getByRole('alert')).toContainText('英小文字');
  await pair.getByLabel('New rule ID for theme → art-rule').fill('theme-cites-art-rule');
  await pair.getByRole('button', { name: '新しい規則' }).click();
  await expect(
    page.getByRole('button', { name: 'Select rule theme-cites-art-rule' }).first(),
  ).toBeVisible();

  // An ID change follows every reference; the result still passes the OWD check.
  await workflowTab(page, '一覧');
  await page.getByRole('button', { name: 'Change ID of 工程 concept', exact: true }).click();
  await page.getByLabel('New ID of 工程 concept', { exact: true }).fill('idea');
  await page.getByRole('button', { name: '変える', exact: true }).click();
  json = await hostJson(page);
  expect(JSON.stringify(json)).not.toMatch(/"concept"/);
  expect(check(json)).toEqual([]);
  await workflowTab(page, '差分');
  await expect(page.getByRole('button', { name: '工程 idea', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('repaired-definition.png') });
});
