import { test, expect, create, nativeArtifact, save } from './fixtures';
import { dataProjection, importRelationData, independentSource } from './structured-graph-fixtures';
import { value } from './practical-fixtures';
import {
  importUsability,
  dragBetween,
  graphSourceAction,
  selectConnection,
} from './usability-fixtures';
import {
  createRelationGraph,
  type GraphDocument,
  type GraphDefinitionSource,
} from '@editor-platform/structured-graph/model';
import { dataEdgeId } from '@editor-platform/structured-data-graph/model';
import { type StructuredData } from '@editor-platform/structured-data/model';
import { createDeck, makeSlideObject, type SlideContent } from '@editor-platform/slide/model';
import { makeWhiteboardNode, type WhiteboardContent } from '@editor-platform/whiteboard/model';
import { type DesignContent } from '@editor-platform/design/model';
import { layoutDrawingText } from '@editor-platform/editor-core';
import { slideDrawing } from '@editor-platform/slide/model';
import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
test('#44 native Graph keeps two node buffers and Host Save flushes them together before reload', async ({
  page,
}) => {
  await page.goto('/');
  await create(page, 'structured-graph');
  await page.getByRole('button', { name: 'Select node Research', exact: true }).click();
  await page.getByLabel('name', { exact: true }).fill('Pending Research');
  await expect(page.locator('.save-status')).toContainText('未確定');
  await page.getByRole('button', { name: 'Select node Planning', exact: true }).click();
  await page.getByLabel('name', { exact: true }).fill('Pending Planning');
  await page.getByRole('button', { name: 'Select node Research', exact: true }).click();
  await expect(page.getByLabel('name', { exact: true })).toHaveValue('Pending Research');
  await page.keyboard.press('Control+s');
  await expect(page.locator('.save-status')).not.toContainText('未確定');
  await expect(
    page.getByRole('button', { name: 'Select node Pending Planning', exact: true }),
  ).toBeVisible();
  const saved = await nativeArtifact(page);
  expect(saved.versions).toHaveLength(1);
  expect(
    (saved.versions[0].content as GraphDocument).nodes.map((node) => node.attributes.name),
  ).toEqual(['Pending Research', 'Pending Planning']);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Select node Research', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Select node Planning', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Select node Pending Research', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Select node Pending Planning', exact: true }),
  ).toBeVisible();
  // Redo updates the canvas before the queued IndexedDB write completes.
  await expect(page.locator('.save-status')).toHaveText('Saved locally');
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Select node Pending Research', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Select node Pending Planning', exact: true }),
  ).toBeVisible();
});
test('#43 #44 #49 Data Graph opens its record and Fields; labels follow renames and Form saves through Host', async ({
  page,
}, info) => {
  await page.goto('/');
  await importRelationData(page);
  await dataProjection(page, 'Graph');
  await page.getByRole('button', { name: 'Select node Research', exact: true }).click();
  await expect(
    page
      .getByLabel('Related', { exact: true })
      .locator('option')
      .filter({ hasText: /^Planning$/ }),
  ).toHaveAttribute('value', 'node:planning');
  await graphSourceAction(page, '元データを開く');
  await expect(page.getByLabel('Record Name', { exact: true })).toHaveValue('Research');
  await page.getByLabel('Record Name', { exact: true }).fill('Form saved by Host');
  await page.keyboard.press('Control+s');
  const committed = await nativeArtifact(page);
  expect(committed.versions).toHaveLength(1);
  expect((committed.versions[0].content as StructuredData).rows[0].values.name).toBe(
    'Form saved by Host',
  );
  await dataProjection(page, 'Graph');
  await page.getByRole('button', { name: 'Select node Planning', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Renamed target');
  await page.getByRole('button', { name: 'Apply attributes', exact: true }).click();
  await page.getByRole('button', { name: 'Select node Form saved by Host', exact: true }).click();
  await expect(
    page
      .getByLabel('Related', { exact: true })
      .locator('option')
      .filter({ hasText: /^Renamed target$/ }),
  ).toHaveAttribute('value', 'node:planning');
  await graphSourceAction(page, 'データ定義');
  const fields = page.getByRole('dialog', { name: 'データ定義 · Field settings', exact: true });
  await fields.getByLabel('Field name', { exact: true }).fill('Display name');
  await fields.getByLabel('Field type', { exact: true }).selectOption('number');
  await expect(
    fields.getByRole('button', { name: 'Apply field settings', exact: true }),
  ).toBeDisabled();
  await expect(fields).toContainText('invalid records');
  await fields.getByLabel('Field type', { exact: true }).selectOption('text');
  await fields.getByRole('button', { name: 'Apply field settings', exact: true }).click();
  await save(page, 2);
  await page.reload();
  await expect(page.getByLabel('Data projection', { exact: true })).toBeVisible();
  await dataProjection(page, 'Graph');
  await page.getByRole('button', { name: 'Select node Form saved by Host', exact: true }).click();
  await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('Form saved by Host');
  await page.screenshot({ path: info.outputPath('data-source-definition-labels.png') });
});
test('#44 invalid Form blocks saving and projection switch; Cancel restores canonical data', async ({
  page,
}) => {
  await page.goto('/');
  await importRelationData(page);
  await dataProjection(page, 'Form');
  await page.getByLabel('Record Name', { exact: true }).fill('');
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('alert').filter({ hasText: /Data Form/ })).toBeVisible();
  await expect(page.getByLabel('Record Name', { exact: true })).toHaveValue('');
  await dataProjection(page, 'Kanban');
  await expect(page.getByLabel('Record Name', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel changes', exact: true }).click();
  await expect(page.getByLabel('Record Name', { exact: true })).toHaveValue('Research');
  const record = await nativeArtifact(page);
  expect(record.versions).toHaveLength(0);
  expect((record.draft.content as StructuredData).rows[0].values.name).toBe('Research');
});
test('#42 #48 native Graph moves the body, retargets both ends, cancels and avoids a middle node', async ({
  page,
}, info) => {
  const graph = createRelationGraph();
  graph.nodes.push({ id: 'third', type: 'entity', attributes: { name: 'Delivery' } });
  graph.layout = {
    'resource-a': { x: 40, y: 120 },
    'resource-b': { x: 370, y: 120 },
    third: { x: 700, y: 120 },
  };
  graph.edges[0].to = 'third';
  await page.goto('/');
  await importUsability(page, 'structured-graph', graph);
  await page.getByRole('button', { name: 'Fit graph', exact: true }).click();
  await selectConnection(page, 'Select connection Related: Research to Delivery');
  await expect(page.locator('[data-node-id="resource-b"]')).not.toHaveClass(/connected/);
  await expect(page.locator('[data-node-id="resource-a"]')).toHaveClass(/connected/);
  await dragBetween(
    page,
    page.getByRole('button', { name: 'Drag connection to: Related', exact: true }),
    page.getByRole('button', { name: 'Select node Planning', exact: true }),
  );
  expect(((await nativeArtifact(page)).draft.content as GraphDocument).edges[0].to).toBe(
    'resource-b',
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await selectConnection(page, 'Select connection Related: Research to Delivery');
  await dragBetween(
    page,
    page.getByRole('button', { name: 'Drag connection from: Related', exact: true }),
    page.getByRole('button', { name: 'Select node Planning', exact: true }),
  );
  expect(((await nativeArtifact(page)).draft.content as GraphDocument).edges[0].from).toBe(
    'resource-b',
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  const body = page.getByRole('button', { name: 'Select node Research', exact: true }),
    box = (await body.boundingBox())!;
  await page.mouse.move(box.x + 25, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 75, box.y + 60, { steps: 5 });
  await page.mouse.up();
  expect(
    ((await nativeArtifact(page)).draft.content as GraphDocument).layout['resource-a'],
  ).not.toEqual(graph.layout['resource-a']);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  const before = (await nativeArtifact(page)).draft.content;
  const mover = page.getByRole('button', { name: 'Select node Research', exact: true }),
    start = (await mover.boundingBox())!;
  await page.mouse.move(start.x + 20, start.y + 20);
  await page.mouse.down();
  await page.mouse.move(start.x + 80, start.y + 40);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect((await nativeArtifact(page)).draft.content).toEqual(before);
  await save(page, 1);
  await page.reload();
  await page.screenshot({ path: info.outputPath('native-graph-routing-endpoints.png') });
});
test('#42 Data Graph moves either endpoint atomically and refuses an occupied source cell', async ({
  page,
}) => {
  await page.goto('/');
  await importRelationData(page);
  await dataProjection(page, 'Graph');
  await page.getByRole('button', { name: 'Fit graph', exact: true }).click();
  await selectConnection(page, 'Select connection Related: Research to Planning');
  await dragBetween(
    page,
    page.getByRole('button', { name: 'Drag connection from: Related', exact: true }),
    page.getByRole('button', { name: 'Select node Delivery', exact: true }),
  );
  const moved = (await nativeArtifact(page)).draft.content as StructuredData;
  expect(moved.rows[0].values.related).toBeNull();
  expect(moved.rows[2].values.related).toBe('planning');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(
    ((await nativeArtifact(page)).draft.content as StructuredData).rows[0].values.related,
  ).toBe('planning');
  await selectConnection(page, 'Select connection Related: Research to Planning');
  await dragBetween(
    page,
    page.getByRole('button', { name: 'Drag connection to: Related', exact: true }),
    page.getByRole('button', { name: 'Select node Delivery', exact: true }),
  );
  expect(
    ((await nativeArtifact(page)).draft.content as StructuredData).rows[0].values.related,
  ).toBe('delivery');
  await save(page, 1);
  await page.reload();
  const reloaded = (await nativeArtifact(page)).draft.content as StructuredData;
  expect(reloaded.rows[0].values.related).toBe('delivery');
  expect(dataEdgeId('research', 'related')).toContain('research');
  await dataProjection(page, 'Graph');
  await page.getByRole('button', { name: 'Select node Planning', exact: true }).click();
  await page.getByLabel('Related', { exact: true }).selectOption('node:research');
  await page.getByRole('button', { name: 'Apply attributes', exact: true }).click();
  const occupied = (await nativeArtifact(page)).draft.content;
  await selectConnection(page, 'Select connection Related: Research to Delivery');
  await dragBetween(
    page,
    page.getByRole('button', { name: 'Drag connection from: Related', exact: true }),
    page.getByRole('button', { name: 'Select node Planning', exact: true }),
  );
  await expect(page.getByRole('alert').filter({ hasText: '接続を解除' })).toContainText('Planning');
  expect((await nativeArtifact(page)).draft.content).toEqual(occupied);
});
test('#43 independent Profile migrates values, preserves history and saves its owned definition', async ({
  page,
}, info) => {
  await page.goto('/graph-host.html');
  await expect(page.getByRole('status').first()).toHaveText('Ready');
  await page.getByLabel('Graph source', { exact: true }).selectOption('profile');
  await expect(page.getByRole('status').first()).toHaveText('Ready');
  await page.getByRole('button', { name: 'Select node Research', exact: true }).click();
  await graphSourceAction(page, 'データ定義');
  await page.getByLabel('Definition field type', { exact: true }).selectOption('number');
  await expect(
    page.getByRole('button', { name: '定義と値の移行を保存', exact: true }),
  ).toBeDisabled();
  await page.getByLabel('Definition field type', { exact: true }).selectOption('string');
  await page.getByLabel('Definition field label', { exact: true }).fill('Entity display name');
  await page.getByRole('button', { name: '定義と値の移行を保存', exact: true }).click();
  await expect(page.getByLabel('Entity display name', { exact: true })).toHaveValue('Research');
  expect((await independentSource<GraphDefinitionSource>(page)).profile.version).toBe(2);
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  expect((await independentSource<GraphDefinitionSource>(page)).profile.version).toBe(1);
  await page.getByRole('button', { name: 'Host Redo', exact: true }).click();
  await page.getByRole('button', { name: 'Commit version', exact: true }).click();
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
  await page.reload();
  await page.getByLabel('Graph source', { exact: true }).selectOption('profile');
  await expect(page.getByRole('status').first()).toHaveText('Reloaded locally');
  expect((await independentSource<GraphDefinitionSource>(page)).profile.version).toBe(2);
  await page.screenshot({ path: info.outputPath('owned-profile-migration.png') });
});
test('#49 independent Profile rejects a self relation with names and a localized corrective action', async ({
  page,
}) => {
  await page.goto('/graph-host.html');
  await page.getByLabel('Graph source', { exact: true }).selectOption('profile');
  await expect(page.getByRole('status').first()).toHaveText('Ready');
  await selectConnection(page, 'Select connection Related: Research to Planning');
  await graphSourceAction(page, 'データ定義');
  await page
    .getByLabel('Connection constraints', { exact: true })
    .fill(JSON.stringify({ allowSelf: false, allowParallel: true, allowCycles: true }));
  await page.getByRole('button', { name: '定義と値の移行を保存', exact: true }).click();
  const original = await independentSource<GraphDefinitionSource>(page);
  await dragBetween(
    page,
    page.getByRole('button', { name: 'Drag connection to: Related', exact: true }),
    page.getByRole('button', { name: 'Select node Research', exact: true }),
  );
  await expect(page.getByRole('alert')).toContainText('Research');
  await expect(page.getByRole('alert')).toContainText('別のノード');
  expect(await independentSource(page)).toEqual(original);
});
for (const kind of ['slide', 'whiteboard', 'design'] as const)
  test(`#44 #45 #47 ${kind} edits in place with input Undo and Host Save, then uses document history`, async ({
    page,
  }, info) => {
    await page.goto('/');
    await create(page, kind);
    await page.getByRole('button', { name: 'Insert text', exact: true }).click();
    const canvas = page.getByRole('application', {
      name: `${kind[0].toUpperCase() + kind.slice(1)} canvas`,
      exact: true,
    });
    await value(page, 'Element width', '190');
    await canvas
      .getByRole('button')
      .filter({ has: page.locator('text') })
      .first()
      .dblclick();
    const editor = page.getByRole('textbox', { name: 'Edit canvas text', exact: true });
    await expect(editor).toBeVisible();
    const foreign = page.locator('.ep-canvas-text-in-place');
    await expect(foreign).toHaveAttribute('width', '190');
    await editor.fill('日本語の直接編集と保存');
    await editor.press('Control+z');
    await editor.press('Control+Shift+z');
    await expect(editor).toContainText('日本語');
    await page.screenshot({ path: info.outputPath(`${kind}-in-place-editor.png`) });
    await editor.press('Control+s');
    await expect(editor).toHaveCount(0);
    const saved = await nativeArtifact(page);
    expect(saved.versions).toHaveLength(1);
    expect(JSON.stringify(saved.versions[0].content)).toContain('日本語の直接編集と保存');
    await canvas.focus();
    await page.keyboard.press('Control+z');
    expect(JSON.stringify((await nativeArtifact(page)).draft.content)).not.toContain('日本語');
    await canvas.focus();
    await page.keyboard.press('Control+Shift+z');
    await page.reload();
    expect(JSON.stringify((await nativeArtifact(page)).draft.content)).toContain(
      '日本語の直接編集と保存',
    );
  });
test('#50 duplicates adjacent to its source, selects the copy and keeps one document undo after reload', async ({
  page,
}) => {
  const deck = createDeck();
  deck.slides[0].title = 'Source';
  deck.slides[0].objects = [makeSlideObject('text', 0)];
  deck.slides.push({
    ...structuredClone(deck.slides[0]),
    id: 'following',
    title: 'Following',
    objects: [],
  });
  await page.goto('/');
  await importUsability(page, 'slide', deck);
  await page.getByRole('button', { name: 'Duplicate slide', exact: true }).click();
  await expect(page.getByLabel('Current page', { exact: true })).toHaveValue('2');
  const copy = (await nativeArtifact(page)).draft.content as SlideContent;
  expect(copy.slides.map((slide) => slide.title)).toEqual(['Source', 'Source copy', 'Following']);
  expect(copy.slides[1].objects[0].id).not.toBe(copy.slides[0].objects[0].id);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(deck);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await save(page, 1);
  await page.reload();
  expect((await nativeArtifact(page)).draft.content).toEqual(copy);
});
test('#51 Whiteboard searches full body, respects explicit names and reveals an offscreen result without changing content', async ({
  page,
}, info) => {
  const note = {
    ...makeWhiteboardNode('sticky'),
    id: 'distant-note',
    bounds: { x: 4000, y: 1800, width: 190, height: 160 },
    text: '本文から探せる付箋 '.repeat(10) + '検索末尾キー',
  };
  const named = {
    ...makeWhiteboardNode('sticky'),
    id: 'named-note',
    name: 'Explicit name',
    text: 'Named body search',
  };
  const board: WhiteboardContent = {
    schemaVersion: 3,
    nodes: [note, named],
    connectors: [],
    sections: [],
  };
  await page.goto('/');
  await importUsability(page, 'whiteboard', board);
  await expect(
    page.getByRole('button', { name: 'Layer Explicit name', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Search layers', { exact: true }).fill('検索末尾キー');
  const result = page.locator('.layer-name');
  await expect(result).toHaveCount(1);
  await result.click();
  await expect(
    page
      .getByRole('application', { name: 'Whiteboard canvas', exact: true })
      .getByRole('button', { name: 'sticky 1', exact: true }),
  ).toBeVisible();
  expect((await nativeArtifact(page)).draft.content).toEqual(board);
  await page.screenshot({ path: info.outputPath('whiteboard-full-body-search.png') });
  await value(page, 'Text', '検索更新後の本文');
  await expect(page.locator('.layer-name')).toHaveCount(0);
  await page.getByLabel('Search layers', { exact: true }).fill('検索更新後');
  await expect(
    page.getByRole('button', { name: 'Layer 検索更新後の本文', exact: true }),
  ).toBeVisible();
  expect(((await nativeArtifact(page)).draft.content as WhiteboardContent).nodes[0].text).toBe(
    '検索更新後の本文',
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.layer-name')).toHaveCount(0);
  await page.getByLabel('Search layers', { exact: true }).fill('検索末尾キー');
  await expect(page.locator('.layer-name')).toHaveCount(1);
});
test('#46 UI Make component → publication wizard → strict React export → preview and React UI reuse', async ({
  page,
}, info) => {
  await page.goto('/');
  await create(page, 'design');
  await page.getByRole('button', { name: 'Enable React Web', exact: true }).click();
  await page.getByRole('button', { name: 'Add frame', exact: true }).click();
  await value(page, 'Layer name', 'Publication page');
  await page.getByLabel('HTML role', { exact: true }).selectOption('main');
  await value(page, 'React page route', '/');
  await page.getByRole('button', { name: 'Insert text', exact: true }).click();
  await value(page, 'Layer name', 'Publishable description');
  await value(page, 'Text', 'Made and published from the UI');
  await page.getByLabel('HTML role', { exact: true }).selectOption('p');
  await page.getByRole('button', { name: 'Make component', exact: true }).click();
  const wizard = page.getByRole('dialog', { name: 'React component publication', exact: true });
  await expect(wizard).toBeVisible();
  await wizard.getByRole('button', { name: 'Cancel publication settings', exact: true }).click();
  await page.getByRole('button', { name: 'Review React export', exact: true }).click();
  await expect(page.locator('.surface-error[role="alert"]')).toContainText(
    'Publish explicit semantics',
  );
  await expect(page.locator('.surface-error[role="alert"]')).not.toContainText('Referenced node');
  await page.getByRole('button', { name: /^Configure React publication/ }).click();
  await expect(wizard).toBeVisible();
  await wizard.getByLabel('Publication symbol', { exact: true }).fill('UiDescription');
  await wizard.getByRole('button', { name: 'Add public prop', exact: true }).click();
  await wizard.getByRole('button', { name: 'Add public slot', exact: true }).click();
  await wizard
    .getByRole('button', { name: 'Save React publication settings', exact: true })
    .click();
  await expect(wizard).toHaveCount(0);
  await save(page, 1);
  const native = (await nativeArtifact(page)).draft.content as DesignContent;
  expect(native.components[0].web!.symbol).toBe('UiDescription');
  expect(native.elements.some((element) => element.type === 'instance')).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: 'Review React export', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review Design React export', exact: true });
  await expect(review).toBeVisible();
  const pending = page.waitForEvent('download');
  await review.getByRole('button', { name: 'Accept reviewed conversion', exact: true }).click();
  await review.getByRole('button', { name: 'Download React bundle', exact: true }).click();
  const download = await pending,
    files = unzipSync(new Uint8Array(await readFile((await download.path())!)));
  expect(
    Object.values(files)
      .map((bytes) => strFromU8(bytes))
      .join('\n'),
  ).toContain('UiDescription');
  await review.getByRole('button', { name: 'Close export review', exact: true }).click();
  await page.getByRole('button', { name: 'Layer Publishable description', exact: true }).click();
  await page.getByRole('button', { name: 'Preview selected Design as React', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'Design React preview', exact: true });
  await expect(
    preview.frameLocator('iframe').getByText('Made and published from the UI'),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath('ui-publication-react-preview.png') });
  await preview.getByRole('button', { name: 'Close preview', exact: true }).click();
  await page
    .getByRole('button', { name: 'Register native components for React UI', exact: true })
    .click();
  await expect(page.locator('.react-ui-surface')).toBeVisible();
});

test('#45 fitted, rotated Japanese text shares its drawing layout, keeps soft wraps private and blocks synthetic IME Save', async ({
  page,
}, info) => {
  const deck = createDeck(),
    object = {
      ...makeSlideObject('text', 0),
      id: 'fit-text',
      bounds: { x: 90, y: 110, width: 180, height: 115 },
      rotation: 18,
      text: '日本語の長い見出しを同じ位置と折り返しで編集する🙂',
      typography: {
        fontSize: 48,
        padding: 9,
        verticalAlign: 'middle' as const,
        overflow: 'fit' as const,
      },
    };
  deck.slides[0].objects = [object];
  const layout = layoutDrawingText(slideDrawing(object));
  await page.goto('/');
  await importUsability(page, 'slide', deck);
  await page.getByLabel('Canvas zoom', { exact: true }).selectOption('0.5');
  const canvas = page.getByRole('application', { name: 'Slide canvas', exact: true });
  await page.screenshot({ path: info.outputPath('slide-fitted-text-before.png') });
  await canvas.getByRole('button', { name: 'text object 1', exact: true }).dblclick();
  const editor = page.getByRole('textbox', { name: 'Edit canvas text', exact: true });
  await expect(page.locator('.ep-canvas-text-in-place')).toHaveAttribute('width', '180');
  expect(
    await page
      .locator('.ep-canvas-text-in-place')
      .evaluate((element) => element.parentElement!.getAttribute('transform')),
  ).toContain('rotate(18');
  expect(
    await editor.evaluate((element) =>
      parseFloat(getComputedStyle(element.parentElement!).fontSize),
    ),
  ).toBe(layout.fontSize);
  expect(
    await editor.evaluate((element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT),
        text = walker.nextNode()!;
      return parseFloat(getComputedStyle(text.parentElement!).fontSize);
    }),
  ).toBe(layout.fontSize);
  expect(
    await editor.evaluate((element) =>
      parseFloat(getComputedStyle(element.parentElement!).paddingTop),
    ),
  ).toBeCloseTo(layout.startY - object.bounds.y, 5);
  // Ancestor font marks must not enlarge fitted line boxes around display-only breaks.
  expect(
    await editor.locator('p').evaluate((element) => (element as HTMLElement).offsetHeight),
  ).toBeCloseTo(layout.totalHeight, 0);
  expect(
    await editor.evaluate((element) => element.contains(window.getSelection()!.anchorNode)),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath('slide-fitted-text-in-place.png') });
  await editor.press('Control+End');
  await page.keyboard.insertText('追加');
  await editor.dispatchEvent('compositionstart', { data: '変換' });
  await editor.press('Control+s');
  await expect(page.getByRole('alert').filter({ hasText: '入力変換' })).toBeVisible();
  await expect(editor).toBeVisible();
  await editor.dispatchEvent('compositionend', { data: '変換' });
  await expect(page.locator('.save-status')).not.toContainText('変換中');
  await editor.press('Control+End');
  await editor.evaluate((element) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', '貼付🙂');
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
    );
  });
  await expect(editor).toContainText('貼付🙂');
  await editor.press('Control+s');
  await expect(editor).toHaveCount(0);
  const saved = await nativeArtifact(page);
  expect(saved.versions).toHaveLength(1);
  expect((saved.draft.content as SlideContent).slides[0].objects[0].text).toBe(
    object.text + '追加貼付🙂',
  );
  await page.reload();
  expect((await nativeArtifact(page)).draft.content).toEqual(saved.draft.content);
});
test('#47 Inspector geometry commits once and canvas shortcut Undo/Redo cannot replay an old browser input', async ({
  page,
}) => {
  await page.goto('/');
  await create(page, 'slide');
  await page.getByRole('button', { name: 'Insert text', exact: true }).click();
  const inserted = (await nativeArtifact(page)).draft.content as SlideContent;
  const field = page.getByLabel('Element width', { exact: true });
  await field.fill('640');
  await field.press('Enter');
  const changed = (await nativeArtifact(page)).draft.content as SlideContent;
  expect(changed.slides[0].objects.at(-1)!.bounds.width).toBe(640);
  const canvas = page.getByRole('application', { name: 'Slide canvas', exact: true });
  await canvas.focus();
  await canvas.press('Control+z');
  await expect(field).toHaveValue(String(inserted.slides[0].objects.at(-1)!.bounds.width));
  await canvas.click({ position: { x: 12, y: 12 } });
  expect((await nativeArtifact(page)).draft.content).toEqual(inserted);
  await canvas.focus();
  await canvas.press('Control+Shift+z');
  expect((await nativeArtifact(page)).draft.content).toEqual(changed);
});
test('#44 Graph composition retains the selected buffer and stops Host Save until committed', async ({
  page,
}) => {
  await page.goto('/');
  await create(page, 'structured-graph');
  await page.getByRole('button', { name: 'Select node Research', exact: true }).click();
  const field = page.getByLabel('name', { exact: true });
  await field.fill('日本語の未確定名');
  await field.dispatchEvent('compositionstart', { data: '入力' });
  await field.press('Control+s');
  await expect(page.getByRole('alert').filter({ hasText: '入力変換' })).toBeVisible();
  await page.getByRole('button', { name: 'Select node Planning', exact: true }).click();
  await expect(field).toHaveValue('日本語の未確定名');
  await field.dispatchEvent('compositionend', { data: '入力' });
  await field.press('Control+s');
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Select node 日本語の未確定名', exact: true }),
  ).toBeVisible();
});

test('#42 read-only changes cancel captured endpoint drags without changing the source or its history', async ({
  page,
}) => {
  await page.goto('/graph-host.html');
  await expect(page.getByRole('status').first()).toHaveText('Ready');
  await selectConnection(page, 'Select connection Related: Research to Planning');
  const original = await independentSource(page),
    handle = page.getByRole('button', { name: 'Drag connection to: Related', exact: true });
  const from = (await handle.boundingBox())!,
    target = (await page
      .getByRole('button', { name: 'Select node Research', exact: true })
      .boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 5 });
  await page
    .getByLabel('Host read only', { exact: true })
    .evaluate((element) => (element as HTMLInputElement).click());
  await page.mouse.up();
  expect(await independentSource(page)).toEqual(original);
  await expect(handle).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Host Undo', exact: true })).toBeDisabled();
  await page.getByLabel('Host read only', { exact: true }).uncheck();
  await expect(handle).toBeVisible();
});

test('#44 Host Save reveals the invalid hidden record while retaining a different valid draft', async ({
  page,
}) => {
  await page.goto('/');
  await importRelationData(page);
  await dataProjection(page, 'Form');
  await page.getByLabel('Record Name', { exact: true }).fill('Retained first record');
  await page.getByRole('button', { name: 'Next record', exact: true }).click();
  await page.getByLabel('Record Name', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Previous record', exact: true }).click();
  await page.keyboard.press('Control+s');
  await expect(page.locator('.ep-record-form h2')).toHaveText('Planning');
  await expect(page.getByLabel('Record Name', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Cancel changes', exact: true }).click();
  await page.getByRole('button', { name: 'Previous record', exact: true }).click();
  await expect(page.getByLabel('Record Name', { exact: true })).toHaveValue(
    'Retained first record',
  );
  await page.keyboard.press('Control+s');
  await page.reload();
  // Reload resolves before the asynchronous local library restores the active artifact.
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue('relations');
  await dataProjection(page, 'Form');
  await expect(page.getByLabel('Record Name', { exact: true })).toHaveValue(
    'Retained first record',
  );
});
