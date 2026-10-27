import { test, expect, create, save, nativeArtifact } from './fixtures';
import { type GraphDocument } from '@editor-platform/structured-graph/model';
import { graphAttribute, dataProjection, independentSource } from './structured-graph-fixtures';
test('mobile ordinary Graph: attributes, deletion Cancel, readonly and persisted draft', async ({
  page,
}, info) => {
  await page.goto('/');
  await create(page, 'structured-graph');
  await graphAttribute(page, 'Research', 'name', 'Mobile Research');
  await save(page, 1);
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Select node Mobile Research', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Select node Mobile Research', exact: true }).click();
  await page.getByRole('button', { name: 'Delete selection', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel deletion', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Select node Mobile Research', exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('ordinary-graph-mobile.png') });
});
test('mobile independent Graph and Data: responsive controls, typed edit and shared history', async ({
  page,
}, info) => {
  await page.goto('/graph-host.html');
  await expect(page.getByRole('status').first()).toHaveText('Ready');
  await graphAttribute(page, 'Research', 'name', 'Mobile independent');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
  expect((await independentSource(page)).nodes[0].attributes.name).toBe('Mobile independent');
  await page.screenshot({ path: info.outputPath('independent-graph-mobile.png') });
  await page.getByLabel('Graph source', { exact: true }).selectOption('data');
  await expect(page.getByRole('status').first()).toHaveText('Ready');
  await dataProjection(page, 'Graph');
  await graphAttribute(page, 'Research', 'Name', 'Mobile Data');
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Select node Research', exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('independent-data-graph-mobile.png') });
});
test('#396 mobile node shapes: Appearance choices, outline drawing, no page overflow and reload', async ({
  page,
}, info) => {
  await page.goto('/');
  await create(page, 'structured-graph');
  const node = page.locator('[data-node-id="resource-a"]');
  await page.getByRole('button', { name: 'Select node Research', exact: true }).click();
  const shape = page.getByLabel('Node shape', { exact: true });
  await shape.scrollIntoViewIfNeeded();
  await shape.selectOption('cylinder');
  await page.getByLabel('Node fill', { exact: true }).selectOption({ label: 'Green' });
  await expect(node).toHaveAttribute('data-shape', 'cylinder');
  await expect(node.locator('.ep-graph-node-shape path')).toHaveAttribute('d', / A/);
  expect(
    ((await nativeArtifact(page)).draft.content as GraphDocument).presentation.nodes['resource-a'],
  ).toMatchObject({ shape: 'cylinder', style: { fill: '#dcfce7' } });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await node.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('node-shapes-mobile.png') });
  await save(page, 1);
  await page.reload();
  await expect(node).toHaveAttribute('data-shape', 'cylinder');
});
test('#396 mobile Sections: add around a node, choose membership, collapse, no page overflow and reload', async ({
  page,
}, info) => {
  await page.goto('/');
  await create(page, 'structured-graph');
  await page.getByRole('button', { name: 'Select node Research', exact: true }).click();
  await page.getByRole('button', { name: 'Add section around node', exact: true }).click();
  const sectionId = ((await nativeArtifact(page)).draft.content as GraphDocument).sections[0].id;
  // Membership is also a plain choice in the Inspector, no drag needed.
  await page.getByRole('button', { name: 'Select node Planning', exact: true }).click();
  const membership = page.getByLabel('Node section', { exact: true });
  await membership.scrollIntoViewIfNeeded();
  await membership.selectOption(sectionId);
  let graph = (await nativeArtifact(page)).draft.content as GraphDocument;
  expect(graph.nodes.map((n) => n.sectionId)).toEqual([sectionId, sectionId]);
  const frame = page.locator(`[data-section-id="${sectionId}"]`);
  await frame.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('sections-mobile.png') });
  await page.getByRole('button', { name: 'Collapse section New section', exact: true }).click();
  await expect(page.locator('[data-node-id]')).toHaveCount(0);
  expect((await nativeArtifact(page)).draft.content).toEqual(graph);
  await page.screenshot({ path: info.outputPath('sections-collapsed-mobile.png') });
  await save(page, 1);
  await page.reload();
  // Collapse is not saved: members show again after reload.
  await expect(page.locator('[data-node-id]')).toHaveCount(2);
  graph = (await nativeArtifact(page)).draft.content as GraphDocument;
  expect(graph.sections.map((s) => s.id)).toEqual([sectionId]);
});
test('#396 mobile diagrams: flowchart template, palette, Arrange diagram, no page overflow and reload', async ({
  page,
}, info) => {
  await page.goto('/');
  if (!(await page.getByLabel('Artifact type', { exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page.getByLabel('Artifact type', { exact: true }).selectOption('structured-graph');
  await page.getByLabel('Graph template', { exact: true }).selectOption('flow');
  await page.getByRole('button', { name: 'New artifact' }).click();
  await expect(page.getByLabel('Artifact name')).toBeVisible();
  await expect(page.locator('[data-node-id="check"]')).toHaveAttribute('data-shape', 'diamond');
  await page.locator('.ep-graph-palette > summary').click();
  await page
    .getByRole('group', { name: 'Node palette', exact: true })
    .getByRole('button', { name: 'Add Record', exact: true })
    .click();
  await expect(page.getByRole('group', { name: 'Node palette', exact: true })).toBeHidden();
  const added = ((await nativeArtifact(page)).draft.content as GraphDocument).nodes.at(-1)!;
  expect(added.type).toBe('record');
  await page.getByRole('button', { name: 'Arrange diagram', exact: true }).click();
  await page.getByRole('button', { name: 'Fit graph', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('[data-node-id="check"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('flowchart-mobile.png') });
  await save(page, 1);
  await page.reload();
  await expect(page.locator(`[data-node-id="${added.id}"]`)).toHaveAttribute(
    'data-shape',
    'cylinder',
  );
});
