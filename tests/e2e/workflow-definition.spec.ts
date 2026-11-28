import { test, expect } from './fixtures';
import {
  addElement,
  hostJson,
  openWorkflowHost,
  workflowTab,
} from './workflow-definition-fixtures';

test('#99 workflow definition: add, edit in lists and matrix, cascade delete, Undo, changes and read only', async ({
  page,
}, info) => {
  await openWorkflowHost(page);
  // The flow shows the phases, each in its section.
  await expect(page.getByRole('button', { name: 'Select node 調べる', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('workflow-flow.png') });

  // A new phase goes after the selected one, with an ID in the OWD form.
  await page.getByRole('button', { name: 'Select node 調べる', exact: true }).click();
  await page.getByLabel('New element ID').fill('Bad ID');
  await expect(page.getByRole('alert')).toContainText('英小文字');
  await addElement(page, '工程', 'scope', '範囲');
  await expect(page.getByLabel('Host status')).toHaveText('Unsaved draft');
  expect((await hostJson(page)).phases.map((p) => p.id)).toEqual([
    'process',
    'research',
    'scope',
    'plan',
    'review',
  ]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await hostJson(page)).phases.map((p) => p.id)).not.toContain('scope');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect((await hostJson(page)).phases.map((p) => p.id)).toContain('scope');

  // Lists: a name edit commits on Enter; an ID list adds a reference.
  await workflowTab(page, '一覧');
  const name = page.getByLabel('Name of scope', { exact: true });
  await name.fill('範囲を決める');
  await name.press('Enter');
  await page.getByLabel('Add to After of scope').selectOption('research');
  let json = await hostJson(page);
  expect(json.phases.find((p) => p.id === 'scope')).toMatchObject({
    name: '範囲を決める',
    after: ['research'],
  });

  // Matrix: a phase × deliverable cell sets the phase's deliverables.
  await workflowTab(page, 'マトリクス');
  await page.getByLabel('scope makes notes', { exact: true }).check();
  json = await hostJson(page);
  expect(json.phases.find((p) => p.id === 'scope')?.deliverables).toEqual(['notes']);

  // A used deliverable is deleted only after confirming the references and acceptance it takes.
  await workflowTab(page, '一覧');
  await page.getByRole('button', { name: 'Delete 成果物 notes', exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Confirm deleting 成果物 notes' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '参照も外して削除' }).click();
  json = await hostJson(page);
  expect(json.deliverables.map((d) => d.id)).not.toContain('notes');
  expect(json.acceptance.map((a) => a.id)).not.toContain('notes.ok');
  expect(JSON.stringify(json)).not.toContain('"notes"');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await hostJson(page)).deliverables.map((d) => d.id)).toContain('notes');

  // Changes from the saved version, then none after saving a version.
  await workflowTab(page, '差分');
  await expect(page.getByRole('button', { name: '工程 scope', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('workflow-changes.png') });
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await expect(page.getByText('版から変わっていません。')).toBeVisible();

  // Read only: no add form, no edit controls, and Undo is off.
  await page.getByLabel('Read only', { exact: true }).check();
  await expect(page.getByRole('form', { name: 'Add element' })).toHaveCount(0);
  await workflowTab(page, '一覧');
  await expect(page.getByRole('button', { name: 'Delete 工程 scope', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.screenshot({ path: info.outputPath('workflow-read-only.png') });
});

test('#99 workflow definition: OWD check diagnostics, outline editing and JSON import', async ({
  page,
}) => {
  await openWorkflowHost(page);
  await expect(page.getByRole('button', { name: /^診断 0 件/ })).toBeVisible();
  // An empty section is an incomplete draft that the OWD check reports, without blocking.
  await workflowTab(page, '一覧');
  await page
    .getByRole('button', { name: 'Remove review from Phases of late', exact: true })
    .click();
  await page.getByRole('button', { name: 'Remove plan from Phases of late', exact: true }).click();
  await page.getByRole('button', { name: /^診断 [1-9]/ }).click();
  await expect(page.getByRole('region', { name: 'Diagnostics' })).toContainText('OWD の検査');
  // Without the Host's check, the Surface says the definition is not checked.
  await page.getByLabel('OWD check', { exact: true }).uncheck();
  await expect(page.getByRole('button', { name: /^診断 1 件/ })).toBeVisible();

  // The outline of a selected deliverable edits headings (the Host remounted the Surface).
  await workflowTab(page, '一覧');
  await page.getByRole('button', { name: 'Select 成果物 plan-doc', exact: true }).click();
  const outline = page.getByRole('region', { name: 'Outline of plan-doc' });
  await outline.getByRole('button', { name: '見出しを足す' }).click();
  const heading = outline.getByLabel('Heading of heading 2', { exact: true });
  await heading.fill('根拠');
  await heading.press('Enter');
  await outline
    .getByRole('button', { name: 'Add a heading inside heading 2', exact: true })
    .click();
  await expect(outline.getByLabel('Heading of heading 2.1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(outline.getByLabel('Heading of heading 2.1', { exact: true })).toHaveCount(0);
  await expect(outline.getByLabel('Heading of heading 2', { exact: true })).toHaveValue('根拠');

  // A JSON that is not an OWD definition is refused and changes nothing.
  await page.getByRole('button', { name: 'JSON', exact: true }).click();
  await page.getByLabel('Definition JSON text').fill('{"format": 2}');
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByLabel('Host status')).toContainText('Import refused');
});
