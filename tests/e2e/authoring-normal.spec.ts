import { test, expect, create, save, nativeArtifact } from './fixtures';
import type { DesignContent } from '@editor-platform/design/model';

test('ordinary Design creates four pages and panels, reorders, Undo/Redo, saves and reloads native pagination', async ({
  page,
}, info) => {
  await page.goto('/');
  await create(page, 'design');
  // Desktop opens the library; on narrow layouts the native left panel is user-controlled.
  const order = page.getByRole('region', { name: 'Page reading order' });
  if (!(await order.isVisible())) {
    const toggle = page.getByRole('button', { name: 'Toggle Design navigator', exact: true });
    if (await toggle.count()) await toggle.click();
  }
  for (let p = 1; p <= 4; p++) {
    await order.getByRole('button', { name: 'Add page', exact: true }).click();
    await order.getByRole('button', { name: `Add panel to page ${p}`, exact: true }).click();
    await order.getByRole('button', { name: `Add panel to page ${p}`, exact: true }).click();
    await order.getByRole('button', { name: `Add dialogue to panel ${p}.1`, exact: true }).click();
  }
  await order.getByRole('button', { name: 'Move page 4 earlier', exact: true }).click();
  if (await page.getByRole('button', { name: 'Close Design navigator', exact: true }).isVisible())
    await page.getByRole('button', { name: 'Close Design navigator', exact: true }).click();
  if (!(await page.getByLabel('Element x', { exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle Design inspector', exact: true }).click();
  await page.getByLabel('Text', { exact: true }).fill('Edited native dialogue');
  await page.getByLabel('Text', { exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Close Design inspector', exact: true }).click();
  await page.getByRole('button', { name: 'Toggle Design navigator', exact: true }).click();
  await order.getByRole('button', { name: 'Panel 1.1', exact: true }).click();
  await page.getByRole('button', { name: 'Close Design navigator', exact: true }).click();
  await page.getByRole('button', { name: 'Toggle Design inspector', exact: true }).click();
  await page.getByLabel('Element x', { exact: true }).fill('120');
  await page.getByLabel('Element x', { exact: true }).press('Enter');
  await page.getByLabel('Element width', { exact: true }).fill('500');
  await page.getByLabel('Element width', { exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Close Design inspector', exact: true }).click();
  if (!(await page.getByRole('button', { name: 'Undo', exact: true }).isVisible()))
    await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.keyboard.press('Escape');
  const undone = (await nativeArtifact(page)).draft.content as DesignContent;
  expect(
    undone.elements.find((e) => e.id === undone.pagination!.pages[0].panelIds[0])!.bounds.width,
  ).toBe(540);
  if (!(await page.getByRole('button', { name: 'Redo', exact: true }).isVisible()))
    await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await page.keyboard.press('Escape');
  const artifact = await nativeArtifact(page);
  const d = artifact.draft.content as DesignContent;
  expect(d.pagination!.pages).toHaveLength(4);
  expect(d.elements.some((e) => e.text === 'Edited native dialogue')).toBe(true);
  expect(d.elements.find((e) => e.id === d.pagination!.pages[0].panelIds[0])!.bounds).toMatchObject(
    { x: 120, width: 500 },
  );
  expect(d.pagination!.pages.every((p) => p.panelIds.length === 2)).toBe(true);
  await save(page, 1);
  await page.reload();
  const reloaded = await nativeArtifact(page);
  expect((reloaded.draft.content as DesignContent).pagination).toEqual(d.pagination);
  expect(reloaded.versions).toHaveLength(1);
  await page.screenshot({ path: info.outputPath('ordinary-pages.png'), fullPage: true });
});

test('M1 ordinary Design edits native page linework and saves an editable balloon', async ({
  page,
}, info) => {
  await page.goto('/');
  await create(page, 'design');
  const order = page.getByRole('region', { name: 'Page reading order' });
  const openOrder = async () => {
    if (!(await order.isVisible()))
      await page.getByRole('button', { name: 'Toggle Design navigator', exact: true }).click();
  };
  await openOrder();
  await order.getByRole('button', { name: 'Add page', exact: true }).click();
  await order.getByRole('button', { name: 'Add panel to page 1', exact: true }).click();
  await order.getByRole('button', { name: 'Add cubic to panel 1.1', exact: true }).click();
  await page.getByRole('button', { name: 'Close Design navigator', exact: true }).click();
  const edit = page.getByRole('button', { name: 'Edit path points', exact: true });
  if (!(await edit.isVisible()))
    await page.getByRole('button', { name: 'Toggle Design inspector', exact: true }).click();
  await edit.click();
  await page.getByLabel('Path point X', { exact: true }).fill('15');
  await page.getByLabel('Path point X', { exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Finish point editing', exact: true }).click();
  await page.getByRole('button', { name: 'Close Design inspector', exact: true }).click();
  await openOrder();
  await order.getByRole('button', { name: 'Add balloon to panel 1.1', exact: true }).click();
  await page.getByRole('button', { name: 'Close Design navigator', exact: true }).click();
  async function history(name: 'Undo' | 'Redo') {
    if (!(await page.getByRole('button', { name, exact: true }).isVisible()))
      await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
    await page.getByRole('button', { name, exact: true }).click();
    await page.keyboard.press('Escape');
  }
  await history('Undo');
  const undone = (await nativeArtifact(page)).draft.content as DesignContent;
  expect(undone.elements.filter((e) => e.path)).toHaveLength(1);
  expect(undone.elements.find((e) => e.path)!.path!.subpaths[0].anchors[0].x).toBe(15);
  await history('Redo');
  const created = (await nativeArtifact(page)).draft.content as DesignContent;
  expect(created.schemaVersion).toBe(3);
  expect(created.elements.filter((e) => e.path)).toHaveLength(2);
  const balloon = created.elements.find((e) => e.name === 'Speech balloon')!;
  expect(
    created.elements
      .filter((e) => e.parentId === balloon.id)
      .map((e) => e.type)
      .sort(),
  ).toEqual(['shape', 'text']);
  await save(page, 1);
  await page.reload();
  const restored = await nativeArtifact(page);
  expect(restored.draft.content).toEqual(created);
  expect(
    (restored.versions[0].content as DesignContent).elements.filter((e) => e.path).map((e) => e.id),
  ).toEqual(created.elements.filter((e) => e.path).map((e) => e.id));
  await page.screenshot({ path: info.outputPath('m1-ordinary-path-balloon.png'), fullPage: true });
});
