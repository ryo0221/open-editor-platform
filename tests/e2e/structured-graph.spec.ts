import { test, expect, create, save, nativeArtifact, artifactView, editCell } from './fixtures';
import {
  graphAttribute,
  independentSource,
  dataProjection,
  importRelationData,
  downloadJson,
  mountBoundedGraphHost,
  storeIndependentDefinition,
} from './structured-graph-fixtures';
import { createRelationGraph, type GraphDocument } from '@editor-platform/structured-graph/model';
import { type StructuredData } from '@editor-platform/structured-data/model';
import { createDataGraphFixture, dataFieldId } from '@editor-platform/structured-data-graph/model';
import { createArtifact, commitVersion } from '@editor-platform/artifact-core';
import { createDocument } from '@editor-platform/document/model';
import { artifactMenu } from './template-fixtures';
import { confirmed, monitor } from './practical-fixtures';
import type { ReferenceDefinition } from '../../apps/graph-reference/src/definition';
test('independent native: typed properties, one drag edit, cancel, Undo, versions, reload and readonly', async ({
  page,
}, info) => {
  await page.goto('/graph-host.html');
  await expect(page.getByRole('status').first()).toHaveText('Ready');
  const initial = await independentSource(page);
  await graphAttribute(page, 'Research', 'name', 'Independent Research');
  await expect(
    page.getByRole('button', { name: 'Select node Independent Research', exact: true }),
  ).toBeVisible();
  await page.getByLabel('name', { exact: true }).fill('Cancelled');
  await page.getByRole('button', { name: 'Cancel attributes', exact: true }).click();
  expect((await independentSource(page)).nodes[0].attributes.name).toBe('Independent Research');
  const mover = page.getByRole('button', { name: 'Move node Independent Research', exact: true }),
    box = (await mover.boundingBox())!;
  await page.mouse.move(box.x + 8, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + 48, box.y + 28, { steps: 5 });
  await page.mouse.up();
  const moved = await independentSource(page);
  expect(moved.layout['resource-a']).not.toEqual(initial.layout['resource-a']);
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  expect((await independentSource(page)).layout).toEqual(initial.layout);
  expect((await independentSource(page)).nodes[0].attributes.name).toBe('Independent Research');
  await page.getByRole('button', { name: 'Commit version', exact: true }).click();
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
  const exported = await downloadJson(page, 'Export native JSON');
  expect(exported.versions).toHaveLength(1);
  await page.reload();
  await expect(page.getByRole('status').first()).toHaveText('Reloaded locally');
  expect(await independentSource(page)).toEqual(exported.draft.content);
  await page.getByLabel('Host read only', { exact: true }).check();
  await expect(page.getByRole('button', { name: 'Add node', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Host Undo', exact: true })).toBeDisabled();
  await page.screenshot({ path: info.outputPath('independent-native-desktop.png') });
});
test('ordinary native: create, edit, immutable hashes, restore and complete native import', async ({
  page,
}, info) => {
  await page.goto('/');
  await create(page, 'structured-graph');
  await graphAttribute(page, 'Research', 'name', 'Ordinary Research');
  await save(page, 1);
  const first = await nativeArtifact(page),
    old = first.versions[0];
  await graphAttribute(page, 'Ordinary Research', 'name', 'Current Research');
  await save(page, 2);
  const second = await nativeArtifact(page);
  expect(second.versions[0]).toEqual(old);
  await artifactView(page, 'History');
  await page.getByRole('button', { name: 'Restore to draft', exact: true }).first().click();
  await artifactView(page, 'Editor');
  await expect(
    page.getByRole('button', { name: 'Select node Ordinary Research', exact: true }),
  ).toBeVisible();
  const restored = await nativeArtifact(page);
  expect(restored.versions[0]).toEqual(old);
  expect((restored.draft.content as GraphDocument).nodes[0].id).toBe('resource-a');
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'roundtrip.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(second)),
  });
  await expect(
    page.getByRole('button', { name: 'Select node Current Research', exact: true }),
  ).toBeVisible();
  const imported = await nativeArtifact(page);
  expect(imported.draft.content).toEqual(second.draft.content);
  expect(imported.versions.map((v) => v.contentHash)).toEqual(
    second.versions.map((v) => v.contentHash),
  );
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Select node Current Research', exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath('ordinary-native-desktop.png') });
});
test('ordinary native: keyboard selection, cascade preview Cancel, deletion Undo and unsupported capabilities', async ({
  page,
}) => {
  await page.goto('/');
  await create(page, 'structured-graph');
  const original = (await nativeArtifact(page)).draft.content;
  await page.getByRole('button', { name: 'Fit graph', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(original);
  await page.getByRole('button', { name: 'Select node Research', exact: true }).click();
  await page.keyboard.press('Delete');
  await expect(
    page.getByRole('dialog', { name: 'Confirm graph deletion', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Cancel deletion', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(original);
  await page.getByRole('button', { name: 'Select node Research', exact: true }).click();
  await page.keyboard.press('Delete');
  await page.getByRole('button', { name: 'Confirm deletion', exact: true }).click();
  expect(((await nativeArtifact(page)).draft.content as GraphDocument).edges).toHaveLength(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  expect((await nativeArtifact(page)).draft.content).toEqual(original);
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open collaboratively', exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole('button', { name: 'テンプレートとして保存', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Comments \(/ })).toBeDisabled();
  await page.getByLabel('Read only', { exact: true }).check();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Add node', exact: true })).toHaveCount(0);
});
test('ordinary Data: Grid→Graph→Form common Undo and persisted layout, unknown values and hidden target', async ({
  page,
}, info) => {
  await page.goto('/');
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
  await importRelationData(page);
  const initial = (await nativeArtifact(page)).draft.content as StructuredData;
  await editCell(page, 'Name', 1, 'Grid Research');
  await dataProjection(page, 'Graph');
  await expect(
    page.getByRole('button', { name: 'Select node Grid Research', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Relation type', { exact: true }).selectOption('related');
  await page.getByLabel('Connection from', { exact: true }).selectOption({ label: 'Planning' });
  await page.getByLabel('Connection to', { exact: true }).selectOption({ label: 'Delivery' });
  await page.getByRole('button', { name: 'Add connection', exact: true }).click();
  expect(
    ((await nativeArtifact(page)).draft.content as StructuredData).rows[1].values.related,
  ).toBe('delivery');
  await page.getByRole('button', { name: 'Select node Grid Research', exact: true }).click();
  await dataProjection(page, 'Form');
  await expect(page.getByLabel('Record Name', { exact: true })).toHaveValue('Grid Research');
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  const undone = (await nativeArtifact(page)).draft.content as StructuredData;
  expect(undone.rows[0].values.name).toBe('Grid Research');
  expect(undone.rows[1].values.related).toBeNull();
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  expect((await nativeArtifact(page)).draft.content).toEqual(initial);
  await expect(page.getByLabel('Record Name', { exact: true })).toHaveValue('Research');
  await dataProjection(page, 'Graph');
  await page.getByRole('button', { name: 'Select node Research', exact: true }).click();
  await page.keyboard.press('ArrowRight');
  const moved = (await nativeArtifact(page)).draft.content as StructuredData;
  expect(moved.rows).toEqual(initial.rows);
  expect(moved.graphView?.positions.research.x).toBe(50);
  await save(page, 1);
  await page.reload();
  await expect(page.getByLabel('Data projection', { exact: true })).toBeVisible();
  await dataProjection(page, 'Graph');
  const reloaded = (await nativeArtifact(page)).draft.content as StructuredData;
  expect(reloaded).toEqual(moved);
  expect(reloaded.rows[0].values['private-note']).toBe('Unshown value retained');
  await page.screenshot({ path: info.outputPath('ordinary-data-graph-desktop.png') });
});
test('independent Data: Form and Graph share canonical edits, history and Save/Reload', async ({
  page,
}) => {
  await page.goto('/graph-host.html');
  await page.getByLabel('Graph source', { exact: true }).selectOption('data');
  await expect(page.getByRole('status').first()).toHaveText('Ready');
  await dataProjection(page, 'Form');
  await page.getByLabel('Record Name', { exact: true }).fill('Form Research');
  await page.getByRole('button', { name: 'Save record', exact: true }).click();
  await dataProjection(page, 'Graph');
  await expect(
    page.getByRole('button', { name: 'Select node Form Research', exact: true }),
  ).toBeVisible();
  await graphAttribute(page, 'Form Research', 'Name', 'Graph Research');
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Select node Form Research', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
  await page.reload();
  await page.getByLabel('Graph source', { exact: true }).selectOption('data');
  await expect(page.getByRole('status').first()).toHaveText('Reloaded locally');
  await dataProjection(page, 'Grid');
  await expect(page.getByRole('gridcell', { name: 'Name · record 1', exact: true })).toHaveText(
    'Form Research',
  );
});
test('fictional Definition: sidecar preserves source, derived edge readonly, proposals and save failure retry', async ({
  page,
}, info) => {
  await page.goto('/graph-host.html');
  await page.getByLabel('Graph source', { exact: true }).selectOption('definition');
  await expect(page.getByRole('status').first()).toHaveText('Ready');
  const initial = await independentSource(page);
  await page.getByRole('button', { name: 'Select node Research', exact: true }).click();
  await page.keyboard.press('ArrowRight');
  expect(await independentSource(page)).toEqual(initial);
  await page.getByRole('button', { name: 'Preview reference proposal', exact: true }).click();
  expect(await independentSource(page)).toEqual(initial);
  await page.getByRole('button', { name: 'Reject reference proposal', exact: true }).click();
  expect(await independentSource(page)).toEqual(initial);
  await page.getByRole('button', { name: 'Preview reference proposal', exact: true }).click();
  await page.getByRole('button', { name: 'Apply reference proposal', exact: true }).click();
  expect(JSON.stringify(await independentSource(page))).toContain('Proposal purpose');
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  expect(await independentSource(page)).toEqual(initial);
  await page.getByRole('button', { name: 'Fail next save', exact: true }).click();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Draft retained');
  expect(await independentSource(page)).toEqual(initial);
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
  await page.screenshot({ path: info.outputPath('definition-adapter-desktop.png') });
  await page.reload();
  await page.getByLabel('Graph source', { exact: true }).selectOption('definition');
  await expect(page.getByRole('status').first()).toHaveText('Reloaded locally');
  expect(await independentSource(page)).toEqual(initial);
  expect(await downloadJson(page, 'Export Definition')).toEqual(initial);
});

test('independent Commit retains edits and Undo during hashing, blocks a second Commit and reloads the same draft', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = window as unknown as {
      delayHash: boolean;
      releaseHash: () => void;
      delayedCalls: number;
    };
    state.delayHash = false;
    state.delayedCalls = 0;
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async (...args) => {
      if (state.delayHash) {
        state.delayedCalls++;
        await new Promise<void>((resolve) => {
          state.releaseHash = resolve;
        });
      }
      return digest(...args);
    };
  });
  await page.goto('/graph-host.html');
  await expect(page.getByRole('status').first()).toHaveText('Ready');
  const start = await independentSource(page);
  await page.evaluate(() => {
    (window as unknown as { delayHash: boolean }).delayHash = true;
  });
  await page.getByRole('button', { name: 'Commit version', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { delayedCalls: number }).delayedCalls))
    .toBe(1);
  await graphAttribute(page, 'Research', 'name', 'Temporary edit');
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  await graphAttribute(page, 'Research', 'name', 'Latest accepted edit');
  await page.getByRole('button', { name: 'Commit version', exact: true }).click();
  expect(
    await page.evaluate(() => (window as unknown as { delayedCalls: number }).delayedCalls),
  ).toBe(1);
  await page.evaluate(() => {
    const state = window as unknown as { delayHash: boolean; releaseHash: () => void };
    state.delayHash = false;
    state.releaseHash();
  });
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
  const saved = await downloadJson(page, 'Export native JSON');
  expect(saved.versions).toHaveLength(1);
  expect(saved.versions[0].content).toEqual(start);
  expect(saved.draft.content.nodes[0].attributes.name).toBe('Latest accepted edit');
  expect(await independentSource(page)).toEqual(saved.draft.content);
  await page.reload();
  await expect(page.getByRole('status').first()).toHaveText('Reloaded locally');
  expect(await independentSource(page)).toEqual(saved.draft.content);
  expect((await downloadJson(page, 'Export native JSON')).versions).toEqual(saved.versions);
});

test('connection editor refreshes clean input and refuses dirty input after source or selection changes', async ({
  page,
}) => {
  await page.goto('/graph-host.html');
  await expect(page.getByRole('status').first()).toHaveText('Ready');
  const selectEdge = () =>
    page.getByRole('button', { name: /^Select connection Related:/ }).press('Enter');
  await selectEdge();
  await expect(page.getByLabel('Connection from', { exact: true })).toHaveValue('resource-a');
  await page.getByLabel('Connection to', { exact: true }).selectOption('resource-a');
  await page.getByRole('button', { name: 'Retarget connection', exact: true }).click();
  expect((await independentSource(page)).edges[0].to).toBe('resource-a');
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  await expect(page.getByLabel('Connection to', { exact: true })).toHaveValue('resource-b');
  // A dirty form belongs to the source revision on which editing began.
  await page.getByLabel('Connection from', { exact: true }).selectOption('resource-b');
  await page.getByRole('button', { name: 'Host Redo', exact: true }).click();
  const before = await independentSource(page);
  await expect(
    page.getByText('Connection input is stale. Reload current values.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Retarget connection', exact: true }).click();
  await expect(page.getByRole('alert').first()).toContainText('Stale connection input');
  expect(await independentSource(page)).toEqual(before);
  await page.getByRole('button', { name: 'Reload connection', exact: true }).click();
  await expect(page.getByLabel('Connection from', { exact: true })).toHaveValue('resource-a');
  await expect(page.getByLabel('Connection to', { exact: true })).toHaveValue('resource-a');
  await page.getByLabel('Connection to', { exact: true }).selectOption('resource-b');
  await page.getByRole('button', { name: 'Select node Planning', exact: true }).click();
  await page.getByRole('button', { name: 'Add connection', exact: true }).click();
  expect(await independentSource(page)).toEqual(before);
  await expect(
    page.getByText('Connection input is stale. Reload current values.', { exact: true }),
  ).toBeVisible();
});

test('stored legacy references stay readable and repairable while a malformed record is isolated and exportable', async ({
  page,
}) => {
  const content = createDataGraphFixture();
  content.rows[0].values.related = 'legacy-missing';
  const legacy = {
    ...(await commitVersion(
      createArtifact('data', 'Legacy Data', content),
      'old-host',
      'Legacy version',
    )),
    annotations: [],
  };
  const document = {
    ...createArtifact('document', 'Healthy Document', createDocument()),
    annotations: [],
  };
  const broken = {
    ...createArtifact('data', 'Broken Data', { ...content, rows: 'malformed' }),
    annotations: [],
  };
  await page.goto('/');
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
  await page.evaluate(async (serialized) => {
    const { legacy, document, broken } = JSON.parse(serialized);
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('editor-platform', 1);
      request.onsuccess = () => {
        const db = request.result,
          tx = db.transaction('artifacts', 'readwrite');
        tx.objectStore('artifacts').put(legacy);
        tx.objectStore('artifacts').put(document);
        tx.objectStore('artifacts').put(broken);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
    localStorage.setItem('ep-active-artifact', legacy.id);
  }, JSON.stringify({ legacy, document, broken }));
  await page.reload();
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue('Legacy Data');
  await expect(
    page.getByRole('button', { name: 'Export retained Broken Data', exact: true }),
  ).toBeVisible();
  const unchanged = await nativeArtifact(page);
  expect(unchanged.draft.content).toEqual(legacy.draft.content);
  expect(unchanged.versions).toEqual(legacy.versions);
  await dataProjection(page, 'Graph');
  await expect(page.getByRole('alert').filter({ hasText: 'existing record' })).toBeVisible();
  await dataProjection(page, 'Grid');
  await editCell(page, 'Related', 1, 'planning', true);
  await dataProjection(page, 'Graph');
  await expect(
    page.getByRole('button', { name: 'Select node Research', exact: true }),
  ).toBeVisible();
  expect((await nativeArtifact(page)).versions).toEqual(legacy.versions);
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  expect(
    ((await nativeArtifact(page)).draft.content as StructuredData).rows[0].values.related,
  ).toBe('legacy-missing');
  expect(await downloadJson(page, 'Export retained Broken Data')).toEqual(broken);
  if (!(await page.getByLabel('Artifact type', { exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page.getByRole('button', { name: /Healthy Document/ }).click();
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue('Healthy Document');
  await expect(page.locator('.ProseMirror')).toBeVisible();
});

test('shared Data peers keep graph positions and label metadata atomic with row and field deletion and Undo', async ({
  page,
  browser,
  baseURL,
}) => {
  const content = createDataGraphFixture();
  content.graphView = {
    schemaVersion: 1,
    labelColumnId: 'name',
    positions: { research: { x: 10, y: 20 }, planning: { x: 30, y: 40 } },
  };
  await page.goto('/');
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'shared-layout.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(content)),
  });
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue('shared-layout');
  await artifactMenu(page, 'Open collaboratively');
  await page.keyboard.press('Escape');
  await confirmed(page);
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  const peer = await context.newPage(),
    errors = monitor(peer);
  try {
    await peer.goto(page.url().replace('actor=A', 'actor=B'));
    await confirmed(peer);
    await editCell(peer, 'Name', 1, 'Peer Research');
    await confirmed(peer);
    await expect(page.getByRole('gridcell', { name: 'Name · record 1', exact: true })).toHaveText(
      'Peer Research',
    );
    await page.getByRole('rowheader', { name: 'Select record 2', exact: true }).click();
    await page
      .getByRole('rowheader', { name: 'Select record 2', exact: true })
      .click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete selected records', exact: true }).click();
    await confirmed(page);
    await expect
      .poll(async () => ((await nativeArtifact(peer)).draft.content as StructuredData).rows.length)
      .toBe(2);
    expect(
      ((await nativeArtifact(peer)).draft.content as StructuredData).graphView?.positions.planning,
    ).toBeUndefined();
    await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
    await confirmed(page);
    await expect
      .poll(async () => ((await nativeArtifact(peer)).draft.content as StructuredData).graphView)
      .toEqual(content.graphView);
    expect(((await nativeArtifact(peer)).draft.content as StructuredData).rows[0].values.name).toBe(
      'Peer Research',
    );
    await page.getByRole('button', { name: 'Field Name', exact: true }).click();
    await page.getByRole('button', { name: 'Delete field', exact: true }).click();
    await confirmed(page);
    await expect
      .poll(
        async () =>
          ((await nativeArtifact(peer)).draft.content as StructuredData).graphView?.labelColumnId,
      )
      .toBe('category');
    await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
    await confirmed(page);
    await expect
      .poll(async () => (await nativeArtifact(peer)).draft.content)
      .toEqual((await nativeArtifact(page)).draft.content);
    expect(((await nativeArtifact(peer)).draft.content as StructuredData).graphView).toEqual(
      content.graphView,
    );
    expect(((await nativeArtifact(peer)).draft.content as StructuredData).rows[0].values.name).toBe(
      'Peer Research',
    );
  } finally {
    await context.close();
  }
  expect(errors).toEqual([]);
});

test('Definition object edits preserve hidden children and clearing the object refuses atomically', async ({
  page,
}) => {
  await page.goto('/graph-host.html');
  await page.getByLabel('Graph source', { exact: true }).selectOption('definition');
  await expect(page.getByRole('status').first()).toHaveText('Ready');
  const original = await independentSource(page);
  await graphAttribute(page, 'Check', 'config', '{"note":"Allowed edit"}');
  const changed = (await independentSource(page)) as unknown as { gates: { config: unknown }[] };
  expect(changed.gates[0].config).toEqual({
    note: 'Allowed edit',
    retained: 'Keep unshown nested values',
  });
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  expect(await independentSource(page)).toEqual(original);
  await page.getByRole('button', { name: 'Select node Check', exact: true }).click();
  await page.getByLabel('config', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Apply attributes', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'undeclared child' })).toBeVisible();
  expect(await independentSource(page)).toEqual(original);
  await expect(page.getByRole('button', { name: 'Host Undo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel attributes', exact: true }).click();
  expect(await downloadJson(page, 'Export Definition')).toEqual(original);
});

test('Data field settings can unlock protected Grid, Form and Graph values and Undo restores the setting', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
  await importRelationData(page);
  await page.getByRole('button', { name: 'Field Name', exact: true }).click();
  await page.getByLabel('Read only field', { exact: true }).check();
  await page.getByRole('button', { name: 'Apply field settings', exact: true }).click();
  await expect(page.getByLabel('Read only field', { exact: true })).toBeChecked();
  await page.getByRole('gridcell', { name: 'Name · record 1', exact: true }).dblclick();
  await expect(page.getByLabel('Edit Name', { exact: true })).toHaveCount(0);
  await dataProjection(page, 'Form');
  await expect(page.getByLabel('Record Name', { exact: true })).toBeDisabled();
  await dataProjection(page, 'Graph');
  await page.getByRole('button', { name: 'Select node Research', exact: true }).click();
  await expect(page.getByLabel('Name', { exact: true })).toBeDisabled();
  await dataProjection(page, 'Grid');
  await page.getByRole('button', { name: 'Field Name', exact: true }).click();
  await page.getByLabel('Read only field', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Apply field settings', exact: true }).click();
  await editCell(page, 'Name', 1, 'Unlocked Research');
  expect(((await nativeArtifact(page)).draft.content as StructuredData).rows[0].values.name).toBe(
    'Unlocked Research',
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  const restored = (await nativeArtifact(page)).draft.content as StructuredData;
  expect(restored.rows[0].values.name).toBe('Research');
  expect(restored.columns.find((c) => c.id === 'name')?.readOnly).toBe(true);
});

test('Data imports reject extra layout fields without loss and History Compare describes position-only versions', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
  await importRelationData(page);
  const original = (await nativeArtifact(page)).draft.content as StructuredData;
  const invalid = {
    ...original,
    graphView: {
      schemaVersion: 1,
      labelColumnId: 'name',
      positions: { research: { x: 10, y: 20, metadata: 'unsupported' } },
    },
  };
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'bad-positions.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(invalid)),
  });
  await expect(page.getByRole('alert').filter({ hasText: /invalid|unsupported/i })).toBeVisible();
  expect((await nativeArtifact(page)).draft.content).toEqual(original);
  await dataProjection(page, 'Graph');
  await page.getByRole('button', { name: 'Select node Research', exact: true }).click();
  await page.keyboard.press('ArrowRight');
  await save(page, 1);
  await page.getByRole('button', { name: 'Select node Research', exact: true }).click();
  await page.keyboard.press('ArrowRight');
  await save(page, 2);
  const saved = await nativeArtifact(page);
  expect(saved.versions[0].contentHash).not.toBe(saved.versions[1].contentHash);
  const first = saved.versions[0].content as StructuredData,
    second = saved.versions[1].content as StructuredData;
  expect(first.rows).toEqual(second.rows);
  expect(first.columns).toEqual(second.columns);
  expect(first.graphView?.labelColumnId).toBe(second.graphView?.labelColumnId);
  expect(first.graphView).toBeDefined();
  await artifactView(page, 'Compare');
  const compare = page.locator('.compare-view');
  await expect(compare.getByText('Graph position', { exact: true })).toBeVisible();
  await expect(
    compare.getByText('These versions have identical content.', { exact: true }),
  ).toHaveCount(0);
  await expect(compare.getByText('Graph view settings', { exact: true })).toHaveCount(0);
  await expect(compare.getByText('Graph label field', { exact: true })).toHaveCount(0);
  await expect(compare.getByText('x: 50, y: 40', { exact: true })).toBeVisible();
  await expect(compare.getByText('x: 60, y: 40', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('data-position-compare.png'), fullPage: true });
});

test('independent native import rechecks permission and revision, retains Undo and ignores older completions', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = window as unknown as { importReads: Record<string, () => void> };
    state.importReads = {};
    const read = File.prototype.text;
    File.prototype.text = async function () {
      if (this.name.startsWith('slow-'))
        await new Promise<void>((resolve) => {
          state.importReads[this.name] = resolve;
        });
      return read.call(this);
    };
  });
  await page.goto('/graph-host.html');
  await expect(page.getByRole('status').first()).toHaveText('Ready');
  const original = await independentSource(page);
  const begin = async (name: string, title: string) => {
    const graph = createRelationGraph();
    graph.nodes[0].attributes.name = title;
    const artifact = createArtifact('structured-graph', title, graph);
    await page.getByLabel('Import graph JSON', { exact: true }).setInputFiles({
      name,
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(artifact)),
    });
    await expect
      .poll(() =>
        page.evaluate(
          (name) =>
            typeof (window as unknown as { importReads: Record<string, () => void> }).importReads[
              name
            ],
          name,
        ),
      )
      .toBe('function');
  };
  const release = (name: string) =>
    page.evaluate(
      (name) =>
        (window as unknown as { importReads: Record<string, () => void> }).importReads[name](),
      name,
    );
  await begin('slow-readonly.json', 'Forbidden import');
  await page.getByLabel('Host read only', { exact: true }).check();
  await release('slow-readonly.json');
  await expect(page.getByRole('alert')).toContainText('Host is read only');
  expect(await independentSource(page)).toEqual(original);
  await page.getByLabel('Host read only', { exact: true }).uncheck();
  await begin('slow-edit.json', 'Stale import');
  await graphAttribute(page, 'Research', 'name', 'Accepted during import');
  await release('slow-edit.json');
  await expect(page.getByRole('alert')).toContainText('draft changed while importing');
  expect((await independentSource(page)).nodes[0].attributes.name).toBe('Accepted during import');
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  expect(await independentSource(page)).toEqual(original);
  await begin('slow-undo.json', 'Stale despite same bytes');
  await graphAttribute(page, 'Research', 'name', 'Temporary');
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  await release('slow-undo.json');
  await expect(page.getByRole('alert')).toContainText('draft changed while importing');
  expect(await independentSource(page)).toEqual(original);
  await expect(page.getByRole('button', { name: 'Host Redo', exact: true })).toBeEnabled();
  await begin('slow-first.json', 'Older result');
  await begin('slow-second.json', 'Newest result');
  await release('slow-second.json');
  await expect(page.getByRole('status').first()).toHaveText('Imported; save to retain');
  await release('slow-first.json');
  await expect(
    page.getByRole('button', { name: 'Select node Newest result', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(
    (await downloadJson(page, 'Export native JSON')).draft.content.nodes[0].attributes.name,
  ).toBe('Newest result');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
  await page.reload();
  await expect(page.getByRole('status').first()).toHaveText('Reloaded locally');
  expect((await independentSource(page)).nodes[0].attributes.name).toBe('Newest result');
});

test('protected new records: normal defaults, atomic CSV rejection and Undo', async ({ page }) => {
  await page.goto('/');
  const data = createDataGraphFixture();
  data.columns[0].readOnly = true;
  data.columns.push({ id: 'computed', name: 'Computed', type: 'formula', formula: '1' });
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'protected.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(data)),
  });
  const original = (await nativeArtifact(page)).draft.content as StructuredData;
  if (!(await page.getByRole('button', { name: 'Add records', exact: true }).isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await page.getByRole('button', { name: 'Add records', exact: true }).click();
  await page.getByRole('button', { name: 'Add 1 record', exact: true }).click();
  await page.keyboard.press('Escape');
  const added = (await nativeArtifact(page)).draft.content as StructuredData;
  expect(added.rows.at(-1)?.values.name).toBe('New record');
  expect(added.rows.at(-1)?.values).not.toHaveProperty('computed');
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  expect((await nativeArtifact(page)).draft.content).toEqual(original);
  const importCsv = async (text: string) => {
    await page.getByLabel('Import CSV file', { exact: true }).setInputFiles({
      name: 'records.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(text),
    });
    const dialog = page.getByRole('dialog', { name: 'CSV import preview', exact: true });
    await dialog.getByLabel('Append to matching fields', { exact: true }).check();
    return dialog;
  };
  const refused = await importCsv('Name,Category\nBypass,Topic\nNew record,Topic');
  await expect(
    refused.getByText('Read-only fields cannot be imported; choose an editable target field'),
  ).toBeVisible();
  await expect(refused.getByRole('button', { name: 'Import records', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  expect((await nativeArtifact(page)).draft.content).toEqual(original);
  await expect(page.getByRole('button', { name: 'Undo', exact: true }).first()).toBeDisabled();
  const accepted = await importCsv('Category\nResource');
  await expect(accepted.getByRole('button', { name: 'Import records', exact: true })).toBeEnabled();
  await accepted.getByRole('button', { name: 'Import records', exact: true }).click();
  const imported = (await nativeArtifact(page)).draft.content as StructuredData;
  expect(imported.rows).toHaveLength(original.rows.length + 1);
  expect(imported.rows.at(-1)?.values.name).toBe('New record');
  expect(imported.rows.at(-1)?.values.category).toBe('Resource');
  expect(imported.rows.at(-1)?.values).not.toHaveProperty('computed');
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  expect((await nativeArtifact(page)).draft.content).toEqual(original);
});

test('arbitrary Data column IDs: property, relation, selection and native Undo', async ({
  page,
}, info) => {
  await page.goto('/');
  const longId = '🔥'.repeat(17000);
  const data: StructuredData = {
    schemaVersion: 2,
    columns: [
      { id: '', name: 'Name', type: 'text' },
      { id: 'constructor', name: 'Related', type: 'relation' },
      { id: longId, name: 'Long field', type: 'text' },
      { id: 'field:constructor', name: 'Literal field', type: 'text' },
    ],
    rows: [
      {
        id: 'a',
        values: Object.fromEntries([
          ['', 'Alpha'],
          ['constructor', 'b'],
          [longId, 'Old'],
          ['field:constructor', 'Literal'],
          ['legacy-hidden', 'Keep'],
        ]),
      },
      {
        id: 'b',
        values: Object.fromEntries([
          ['', 'Beta'],
          ['constructor', null],
          [longId, 'Other'],
        ]),
      },
    ],
    graphView: { schemaVersion: 1, labelColumnId: '', positions: {} },
  };
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'column-ids.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(data)),
  });
  const original = (await nativeArtifact(page)).draft.content;
  await dataProjection(page, 'Graph');
  await graphAttribute(page, 'Alpha', 'Long field', 'Changed');
  expect(
    ((await nativeArtifact(page)).draft.content as StructuredData).rows[0].values[longId],
  ).toBe('Changed');
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  expect((await nativeArtifact(page)).draft.content).toEqual(original);
  await page
    .getByRole('button', { name: 'Select connection Related: Alpha to Beta', exact: true })
    .press('Enter');
  await page.getByLabel('Connection to', { exact: true }).selectOption('node:a');
  await page.getByRole('button', { name: 'Retarget connection', exact: true }).click();
  expect(
    ((await nativeArtifact(page)).draft.content as StructuredData).rows[0].values.constructor,
  ).toBe('a');
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  await page.getByRole('button', { name: 'Select node Beta', exact: true }).click();
  await page.getByLabel('Relation type', { exact: true }).selectOption(dataFieldId('constructor'));
  await page.getByLabel('Connection from', { exact: true }).selectOption('node:b');
  await page.getByLabel('Connection to', { exact: true }).selectOption('node:a');
  await page.getByRole('button', { name: 'Add connection', exact: true }).click();
  expect(
    ((await nativeArtifact(page)).draft.content as StructuredData).rows[1].values.constructor,
  ).toBe('a');
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  expect((await nativeArtifact(page)).draft.content).toEqual(original);
  await page.screenshot({ path: info.outputPath('mapped-data-fields.png') });
  await page
    .getByRole('button', { name: 'Select connection Related: Alpha to Beta', exact: true })
    .press('Enter');
  await dataProjection(page, 'Grid');
  await expect(page.getByRole('gridcell', { name: 'Related · record 1', exact: true })).toHaveClass(
    /active/,
  );
  expect((await nativeArtifact(page)).draft.content).toEqual(original);
});

test('bounded public Profile: valid Add draft, correction, Undo and effective readonly UI', async ({
  page,
}, info) => {
  await mountBoundedGraphHost(page);
  const source = async (): Promise<GraphDocument> =>
    JSON.parse((await page.getByTestId('bounded-source').textContent())!);
  const revision = () => page.getByTestId('bounded-revision').textContent();
  const empty = await source();
  await page.getByRole('button', { name: 'Add node', exact: true }).click();
  await page.getByRole('button', { name: 'Select node New', exact: true }).click();
  const added = await source();
  expect(added.nodes[0].attributes).toEqual({
    name: 'New',
    negative: -1,
    bounded: -5,
    positive: 2,
    optional: '',
  });
  await expect(page.getByRole('alert')).toContainText('値が未入力です');
  await expect(page.getByRole('region', { name: 'Graph diagnostics', exact: true })).toContainText(
    'requiredObject',
  );
  const beforeInvalid = await revision();
  await page.getByLabel('negative', { exact: true }).fill('0');
  await page.getByRole('button', { name: 'Apply attributes', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: /range/i })).toBeVisible();
  expect(await source()).toEqual(added);
  expect(await revision()).toBe(beforeInvalid);
  await page.getByRole('button', { name: 'Cancel attributes', exact: true }).click();
  await graphAttribute(page, 'New', 'negative', '-2');
  expect((await source()).nodes[0].attributes.negative).toBe(-2);
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  expect(await source()).toEqual(added);
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  expect(await source()).toEqual(empty);
  await page.getByRole('button', { name: 'Host Redo', exact: true }).click();
  await page.getByLabel('Profile read only', { exact: true }).check();
  await page.getByRole('button', { name: 'Select node New', exact: true }).click();
  for (const name of [
    'Add node',
    'Move node New',
    'Delete selection',
    'Apply attributes',
    'Add connection',
  ])
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  for (const label of [
    'Node type',
    'Relation type',
    'Connection from',
    'Connection to',
    'name',
    'negative',
  ])
    await expect(page.getByLabel(label, { exact: true })).toHaveCount(0);
  const readonlySource = await source(),
    readonlyRevision = await revision();
  await page.getByRole('button', { name: 'Select node New', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Delete');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(page.getByLabel('Graph zoom', { exact: true })).toHaveText('125%');
  expect(await source()).toEqual(readonlySource);
  expect(await revision()).toBe(readonlyRevision);
  await page.screenshot({ path: info.outputPath('profile-readonly-bounded.png') });
  await page.getByLabel('Profile read only', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Select node New', exact: true }).click();
  await page.keyboard.press('ArrowRight');
  expect((await source()).layout).not.toEqual(added.layout);
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  expect(await source()).toEqual(added);
});

test('Definition proposal diagnostics match preview and Reject in both directions', async ({
  page,
}, info) => {
  await page.goto('/graph-host.html');
  await page.getByLabel('Graph source', { exact: true }).selectOption('definition');
  await expect(page.getByRole('status').first()).toHaveText('Ready');
  const original = await independentSource(page);
  const domainProblem = page
    .getByRole('region', { name: 'Graph diagnostics', exact: true })
    .getByRole('button')
    .filter({ hasText: 'Enter a purpose before publishing this Definition' });
  const purposeValue = page
    .locator('.ep-graph-attribute-values > div')
    .filter({ has: page.getByText('purpose', { exact: true }) })
    .locator('dd');
  await graphAttribute(page, 'Research', 'purpose', '');
  await expect(domainProblem).toHaveCount(1);
  const incomplete = await independentSource(page);
  await page.getByRole('button', { name: 'Preview reference proposal', exact: true }).click();
  await expect(domainProblem).toHaveCount(0);
  await expect(purposeValue).toHaveText('Proposal purpose');
  expect(await independentSource(page)).toEqual(incomplete);
  await expect(page.getByRole('button', { name: 'Host Undo', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Reject reference proposal', exact: true }).click();
  await expect(domainProblem).toHaveCount(1);
  await expect(page.getByLabel('purpose', { exact: true })).toHaveValue('');
  expect(await independentSource(page)).toEqual(incomplete);
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  expect(await independentSource(page)).toEqual(original);
  await page.getByLabel('Proposed Research purpose', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Preview reference proposal', exact: true }).click();
  await expect(domainProblem).toHaveCount(1);
  await expect(purposeValue).toHaveText('—');
  expect(await independentSource(page)).toEqual(original);
  await expect(page.getByRole('button', { name: 'Host Undo', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Host Redo', exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath('proposal-current-diagnostics.png') });
  await page.getByRole('button', { name: 'Reject reference proposal', exact: true }).click();
  await expect(domainProblem).toHaveCount(0);
  await expect(page.getByLabel('purpose', { exact: true })).toHaveValue('Collect public facts');
  expect(await independentSource(page)).toEqual(original);
  await expect(page.getByRole('button', { name: 'Host Redo', exact: true })).toBeEnabled();
});

test('saved Data restoration verifies protected history and restores rows with Undo and Redo', async ({
  page,
}, info) => {
  await page.goto('/graph-host.html');
  await page.getByLabel('Graph source', { exact: true }).selectOption('data');
  await expect(page.getByRole('status').first()).toHaveText('Ready');
  await dataProjection(page, 'Graph');
  await graphAttribute(page, 'Research', 'Name', 'Saved Research');
  await dataProjection(page, 'Grid');
  await page.getByRole('button', { name: 'Field Name', exact: true }).click();
  await page.getByLabel('Read only field', { exact: true }).check();
  await page.getByRole('button', { name: 'Apply field settings', exact: true }).click();
  await page.getByRole('button', { name: 'Commit version', exact: true }).click();
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
  const saved = await downloadJson(page, 'Export native JSON');
  await dataProjection(page, 'Graph');
  await page.getByRole('button', { name: 'Select node Saved Research', exact: true }).click();
  await page.keyboard.press('Delete');
  await page.getByRole('button', { name: 'Confirm deletion', exact: true }).click();
  const deleted = await independentSource<StructuredData>(page);
  expect(deleted.rows.some((r) => r.id === 'research')).toBe(false);
  await page.getByText('Saved versions', { exact: true }).click();
  await page.getByLabel('Host read only', { exact: true }).check();
  await expect(page.getByRole('button', { name: 'Restore version 1', exact: true })).toBeDisabled();
  await page.getByLabel('Host read only', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Restore version 1', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Select node Saved Research', exact: true }),
  ).toBeVisible();
  expect(await independentSource(page)).toEqual(saved.versions[0].content);
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  expect(await independentSource(page)).toEqual(deleted);
  await page.getByRole('button', { name: 'Host Redo', exact: true }).click();
  expect(await independentSource(page)).toEqual(saved.versions[0].content);
  expect((await downloadJson(page, 'Export native JSON')).versions).toEqual(saved.versions);
  await page.screenshot({ path: info.outputPath('protected-version-restored.png') });
});

test('native hidden object members survive declared edits and reject overwrite or clear without history changes', async ({
  page,
}, info) => {
  await page.goto('/');
  const graph = createRelationGraph();
  graph.nodes[0].attributes.details = { description: 'Original', retained: 'Keep hidden child' };
  const artifact = createArtifact('structured-graph', 'Hidden native members', graph);
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'hidden-graph.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(artifact)),
  });
  await graphAttribute(page, 'Research', 'details', '{"description":"Updated"}');
  expect(
    ((await nativeArtifact(page)).draft.content as GraphDocument).nodes[0].attributes.details,
  ).toEqual({ description: 'Updated', retained: 'Keep hidden child' });
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  expect((await nativeArtifact(page)).draft.content).toEqual(graph);
  for (const text of ['{"description":"Bypass","retained":"Overwrite"}', '']) {
    await graphAttribute(page, 'Research', 'details', text);
    await expect(page.getByRole('alert').filter({ hasText: 'undeclared child' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Undo', exact: true }).first()).toBeDisabled();
    // Export now preflights retained input too: discard the rejected buffer before reading native.
    await page.getByRole('button', { name: 'Cancel attributes', exact: true }).click();
    expect((await nativeArtifact(page)).draft.content).toEqual(graph);
  }
  await page.screenshot({ path: info.outputPath('native-retained-object.png') });
});

test('duplicate Data options project and edit without mutating native options or hidden values', async ({
  page,
}) => {
  await page.goto('/');
  const data = createDataGraphFixture();
  data.columns.find((c) => c.id === 'category')!.options = ['Resource', 'Topic', 'Topic'];
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'duplicate-options.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(data)),
  });
  const original = (await nativeArtifact(page)).draft.content as StructuredData;
  await dataProjection(page, 'Graph');
  await page.getByRole('button', { name: 'Select node Research', exact: true }).click();
  await expect(
    page
      .getByLabel('Category', { exact: true })
      .getByRole('option', { name: 'Topic', exact: true }),
  ).toHaveCount(1);
  await page.getByLabel('Category', { exact: true }).selectOption('Topic');
  await page.getByRole('button', { name: 'Apply attributes', exact: true }).click();
  const next = (await nativeArtifact(page)).draft.content as StructuredData;
  expect(next.columns).toEqual(original.columns);
  expect(next.rows[0].values.category).toBe('Topic');
  expect(next.rows[0].values['private-note']).toBe(original.rows[0].values['private-note']);
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  expect((await nativeArtifact(page)).draft.content).toEqual(original);
});

test('native import rejects oversized file metadata before reading and retains revision and Undo', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = window as unknown as { readCounts: Record<string, number> };
    state.readCounts = {};
    const size = Object.getOwnPropertyDescriptor(Blob.prototype, 'size')!.get!,
      read = File.prototype.text;
    Object.defineProperty(File.prototype, 'size', {
      get() {
        return this.name === 'oversized.json'
          ? 16_000_001
          : this.name === 'near-limit.json'
            ? 16_000_000
            : size.call(this);
      },
    });
    File.prototype.text = function () {
      state.readCounts[this.name] = (state.readCounts[this.name] ?? 0) + 1;
      return read.call(this);
    };
  });
  await page.goto('/graph-host.html');
  await expect(page.getByRole('status').first()).toHaveText('Ready');
  await graphAttribute(page, 'Research', 'name', 'Keep current draft');
  const original = await independentSource(page),
    revision = await page.getByTestId('graph-revision').textContent();
  const artifact = createArtifact('structured-graph', 'Import boundary', createRelationGraph());
  for (const name of ['oversized.json', 'near-limit.json']) {
    await page.getByLabel('Import graph JSON', { exact: true }).setInputFiles({
      name,
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(artifact)),
    });
    if (name === 'oversized.json') {
      await expect(page.getByRole('alert')).toContainText('exceeds 16 MB');
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { readCounts: Record<string, number> }).readCounts[
              'oversized.json'
            ] ?? 0,
        ),
      ).toBe(0);
      expect(await independentSource(page)).toEqual(original);
      expect(await page.getByTestId('graph-revision').textContent()).toBe(revision);
      await expect(page.getByRole('button', { name: 'Host Undo', exact: true })).toBeEnabled();
    } else {
      await expect(page.getByRole('status').first()).toHaveText('Imported; save to retain');
      expect(await independentSource(page)).toEqual(artifact.draft.content);
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { readCounts: Record<string, number> }).readCounts[
              'near-limit.json'
            ],
        ),
      ).toBe(1);
    }
  }
});

test('Definition projection bounds derived identities and explicitly rejects unresolved references while retaining export', async ({
  page,
}, info) => {
  await page.goto('/graph-host.html');
  await page.getByLabel('Graph source', { exact: true }).selectOption('definition');
  await expect(page.getByRole('status').first()).toHaveText('Ready');
  const initial = await independentSource<ReferenceDefinition>(page),
    longId = 'p'.repeat(512);
  initial.phases[0].id = longId;
  initial.shapes[1].id = 'output:phase-plan';
  initial.phases[1].output = initial.shapes[1].id;
  initial.components.push(
    { id: 'target:gate-check', name: 'Reserved target identity' },
    { id: 'uses:gate-check', name: 'Reserved uses identity' },
  );
  await storeIndependentDefinition(page, initial);
  await page
    .getByRole('button', { name: 'Select connection Output: Research to Notes', exact: true })
    .press('Enter');
  await page.getByLabel('Connection to', { exact: true }).selectOption('output:phase-plan');
  await page.getByRole('button', { name: 'Retarget connection', exact: true }).click();
  expect((await independentSource<ReferenceDefinition>(page)).phases[0].output).toBe(
    'output:phase-plan',
  );
  expect((await independentSource<ReferenceDefinition>(page)).phases[0].id).toBe(longId);
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  expect(await independentSource(page)).toEqual(initial);
  const unresolved = structuredClone(initial);
  unresolved.phases[0].output = 'missing-shape';
  await storeIndependentDefinition(page, unresolved);
  await expect(page.getByRole('alert')).toContainText(
    'Unresolved or unsupported Definition reference',
  );
  await expect(page.getByRole('alert')).toBeInViewport();
  expect(await independentSource(page)).toEqual(unresolved);
  expect(await downloadJson(page, 'Export Definition')).toEqual(unresolved);
  await expect(page.getByRole('button', { name: 'Host Undo', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Structured Graph Editor', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('definition-refusal-retained-source.png') });
});
