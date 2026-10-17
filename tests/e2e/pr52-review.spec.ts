import { test, expect, nativeArtifact, save } from './fixtures';
import { importUsability, selectConnection, graphSourceAction } from './usability-fixtures';
import { independentSource, dataProjection, downloadJson } from './structured-graph-fixtures';
import { auditData } from './audit-fixtures';
import { authorDesignReact, layer } from './design-react-fixtures';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createArtifact, clone } from '@editor-platform/artifact-core';
import { addAnnotation } from '@editor-platform/editor-core';
import { createReview, reviewRevision } from '@editor-platform/review-surfaces/model';
import {
  createDesign,
  makeDesignElement,
  layoutDesign,
  designDrawings,
  type DesignContent,
} from '@editor-platform/design/model';
import { createRelationGraph, type GraphDocument } from '@editor-platform/structured-graph/model';
import type { StructuredData } from '@editor-platform/structured-data';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { sharedFormSave, replacementEncoding } from './pr52-followup-fixtures';
import { auditDocument } from './audit-fixtures';
import { makeWhiteboardNode, type WhiteboardContent } from '@editor-platform/whiteboard/model';
import type { GraphDefinitionSource } from '@editor-platform/structured-graph/model';
import {
  type ReferenceDefinition,
  projectDefinition,
} from '../../apps/graph-reference/src/definition';
import { unzipSync, strFromU8 } from 'fflate';

test('PR #52 shared Form drafts save before version creation and validation/composition failures retain the buffer', async ({
  page,
}, info) => {
  await sharedFormSave(page);
  await page.screenshot({ path: info.outputPath('shared-form-version.png') });
});

test('PR #52 replacement encoding changes re-decode the selected original bytes before commit', async ({
  page,
}) => {
  await replacementEncoding(page);
});

test('PR #52 tabbed code exports a searchable Japanese PDF without changing native text', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  await page.goto('/');
  const document = auditDocument();
  document.blocks = [{ id: 'code', type: 'code', text: '日本語\tコード\n\t検索する本文' }];
  await importUsability(page, 'document', document);
  await page.getByRole('button', { name: 'Export document', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  const pdfPath = info.outputPath('tabbed-code.pdf');
  await (await pending).saveAs(pdfPath);
  const text = execFileSync('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8' });
  expect(text).toMatch(/日本語\s+コード/);
  expect(text).toContain('検索する本文');
  expect((await nativeArtifact(page)).draft.content).toEqual(document);
});

test('PR #52 filtered Data Graph ignores an invisible node overlapping the visible endpoint', async ({
  page,
}, info) => {
  await page.goto('/');
  const data = auditData();
  data.graphView = {
    schemaVersion: 1,
    labelColumnId: 'title',
    positions: {
      first: { x: 40, y: 40 },
      second: { x: 440, y: 40 },
      third: { x: 40, y: 40 },
    },
  };
  await importUsability(page, 'data', data);
  await dataProjection(page, 'Graph');
  await page.getByRole('button', { name: 'Add filter', exact: true }).click();
  await page.getByLabel('Filter 1 field', { exact: true }).selectOption('state');
  await page.getByLabel('Filter 1 operator', { exact: true }).selectOption('equals');
  await page.getByLabel('Filter 1 value', { exact: true }).fill('Plan');
  await expect(
    page.getByRole('button', { name: 'Select node Third period', exact: true }),
  ).toHaveCount(0);
  const connection = page.getByRole('button', {
    name: 'Select connection Related: Second period to First period',
    exact: true,
  });
  await expect(connection).toHaveAttribute('d', /M.*L/);
  await expect(page.getByText('ノードの重なりを解消してください', { exact: true })).toHaveCount(0);
  expect(((await nativeArtifact(page)).draft.content as StructuredData).graphView).toEqual(
    data.graphView,
  );
  await page.screenshot({ path: info.outputPath('filtered-visible-route.png') });
});

test('PR #52 Whiteboard endpoint preview and commit use the visible grouped paint order', async ({
  page,
}, info) => {
  await page.goto('/');
  const node = (id: string, x: number, y: number) => ({
    ...makeWhiteboardNode('sticky'),
    id,
    text: id,
    bounds: { x, y, width: 180, height: 140 },
  });
  const front = node('front', 330, 300);
  const board: WhiteboardContent = {
    schemaVersion: 3,
    nodes: [
      node('first', 50, 100),
      node('second', 330, 100),
      { ...makeWhiteboardNode('group'), id: 'group', bounds: front.bounds },
      front,
      { ...node('behind-child', 330, 300), groupId: 'group' },
      { ...node('hidden', 330, 300), hidden: true },
    ],
    connectors: [
      {
        id: 'edge',
        from: 'first',
        to: 'second',
        label: 'Connection',
        fromPort: 'right',
        toPort: 'left',
      },
    ],
  };
  await importUsability(page, 'whiteboard', board);
  const point = await page
    .locator('[data-testid="board-connector"] path')
    .last()
    .evaluate((element) => {
      const path = element as SVGPathElement;
      const p = path.getPointAtLength(path.getTotalLength() / 2);
      const screen = new DOMPoint(p.x, p.y).matrixTransform(path.getScreenCTM()!);
      return { x: screen.x, y: screen.y };
    });
  await page.mouse.click(point.x, point.y);
  const handle = page.getByRole('button', { name: 'Move connector to', exact: true });
  const target = page.locator('[data-canvas-target="front"]');
  const start = (await handle.boundingBox())!,
    to = (await target.boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await expect(page.getByTestId('connector-candidate')).toHaveAttribute('data-target-id', 'front');
  await page.mouse.up();
  const moved = (await nativeArtifact(page)).draft.content as WhiteboardContent;
  expect(moved.connectors[0].to).toBe('front');
  expect(moved.nodes).toEqual(board.nodes);
  await page.screenshot({ path: info.outputPath('visible-whiteboard-target.png') });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(board);
});

test('PR #52 definition schema and connection JSON errors remain independent at UI and Host save boundaries', async ({
  page,
}) => {
  await page.goto('/graph-host.html');
  await page.getByLabel('Graph source', { exact: true }).selectOption('profile');
  await expect(page.getByRole('status').first()).toHaveText('Ready');
  const original = await independentSource<GraphDefinitionSource>(page);
  await selectConnection(page, 'Select connection Related: Research to Planning');
  await graphSourceAction(page, 'データ定義');
  await page.getByLabel('New definition field ID').fill('note');
  await page.getByRole('button', { name: '属性を追加', exact: true }).click();
  const schema = page.getByLabel('Definition field schema', { exact: true });
  const connection = page.getByLabel('Connection constraints', { exact: true });
  const saveDefinition = page.getByRole('button', { name: '定義と値の移行を保存', exact: true });
  const connectionValue = await connection.inputValue();
  await schema.fill('{broken');
  await connection.fill('{}');
  await expect(saveDefinition).toBeDisabled();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '属性の制約' }).first()).toBeVisible();
  expect(await independentSource(page)).toEqual(original);
  await expect(schema).toHaveValue('{broken');
  await schema.fill('{"type":"string"}');
  await connection.fill('{broken');
  await page.getByLabel('Definition required').check();
  await expect(saveDefinition).toBeDisabled();
  await expect(page.getByRole('alert').filter({ hasText: '接続制約' })).toBeVisible();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  expect(await independentSource(page)).toEqual(original);
  await expect(connection).toHaveValue('{broken');
  await connection.fill(connectionValue);
  await saveDefinition.click();
  const changed = await independentSource<GraphDefinitionSource>(page);
  expect(changed.profile.edges.related.schema.note).toEqual({ type: 'string', required: true });
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  expect(await independentSource(page)).toEqual(original);
});

test('PR #40 added Definition relationships keep canonical IDs through native commit, reload and Undo', async ({
  page,
}) => {
  await page.goto('/graph-host.html');
  await page.getByLabel('Graph source', { exact: true }).selectOption('definition');
  await expect(page.getByRole('status').first()).toHaveText('Ready');
  const initial = await independentSource<ReferenceDefinition>(page);
  await selectConnection(page, 'Select connection Output: Research to Notes');
  await page.getByRole('button', { name: 'Delete selection', exact: true }).click();
  const disconnected = await independentSource<ReferenceDefinition>(page);
  await page.getByRole('button', { name: 'Select node Research', exact: true }).click();
  await page.getByLabel('Relation type', { exact: true }).selectOption('output');
  await page.getByLabel('Connection from', { exact: true }).selectOption('phase-research');
  await page.getByLabel('Connection to', { exact: true }).selectOption(initial.shapes[0].id);
  await page.getByRole('button', { name: 'Add connection', exact: true }).click();
  expect(await independentSource(page)).toEqual(initial);
  const edge = page.getByRole('button', {
    name: 'Select connection Output: Research to Notes',
    exact: true,
  });
  await expect(edge).toBeVisible();
  expect(
    projectDefinition(await independentSource<ReferenceDefinition>(page)).edges.find(
      (e) => e.type === 'output',
    )?.id,
  ).toBe('output:phase-research');
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  expect(await independentSource(page)).toEqual(disconnected);
  await page.getByRole('button', { name: 'Host Redo', exact: true }).click();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
  await page.reload();
  await page.getByLabel('Graph source', { exact: true }).selectOption('definition');
  await expect(page.getByRole('status').first()).toHaveText('Reloaded locally');
  expect(await independentSource(page)).toEqual(initial);
});

async function mountDesignHost(page: import('@playwright/test').Page, component = false) {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../fixtures/pr52/design-host.tsx', import.meta.url))],
    bundle: true,
    write: false,
    outdir: '/tmp/pr52-design-host',
    format: 'iife',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  await page.route('**/pr52-design-host.html*', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><title>Design rejection Host</title></head><body style="margin:0"><div id="root"></div></body></html>',
    }),
  );
  await page.goto(`/pr52-design-host.html${component ? '?component=1' : ''}`);
  for (const file of bundle.outputFiles!) {
    if (file.path.endsWith('.css')) await page.addStyleTag({ content: file.text });
    if (file.path.endsWith('.js')) await page.addScriptTag({ content: file.text });
  }
  await expect(page.getByRole('application', { name: 'Design canvas', exact: true })).toBeVisible();
}
async function designSource(page: import('@playwright/test').Page): Promise<DesignContent> {
  return JSON.parse((await page.getByTestId('design-source').textContent())!);
}
for (const component of [false, true])
  test(`PR #52 rejected Design ${component ? 'component-part' : 'root'} text retains draft and retries with inherited formatting`, async ({
    page,
  }) => {
    await mountDesignHost(page, component);
    const before = await designSource(page);
    await page
      .getByRole('application', { name: 'Design canvas', exact: true })
      .getByRole('button')
      .filter({ has: page.locator('text') })
      .first()
      .dblclick();
    const editor = page.getByRole('textbox', { name: 'Edit canvas text', exact: true });
    await expect(editor).toHaveText('Hello');
    await editor.press('Control+End');
    await page.keyboard.type('!');
    await expect(page.getByLabel('Pending input count')).toHaveText('1');
    await page.getByRole('button', { name: 'Host flush', exact: true }).click();
    await expect(page.getByLabel('Flush status')).toHaveText('Rejected; buffer retained');
    await expect(editor).toHaveText('Hello!');
    await expect(page.getByLabel('Pending input count')).toHaveText('1');
    expect(await designSource(page)).toEqual(before);
    await page.getByLabel('Host accepts commands').check();
    await page.getByRole('button', { name: 'Host flush', exact: true }).click();
    await expect(page.getByLabel('Flush status')).toHaveText('Accepted');
    await expect(editor).toHaveCount(0);
    await expect(page.getByLabel('Pending input count')).toHaveText('0');
    const next = await designSource(page);
    const drawing = designDrawings(next, next.elements[0])[0];
    expect(drawing.text).toBe('Hello!');
    expect(drawing.typography).toMatchObject({
      bold: true,
      italic: true,
      underline: true,
      strike: true,
    });
    expect(drawing.runs?.some((run) => Object.values(run.style ?? {}).includes(false))).toBeFalsy();
  });

test('PR #52 inherited boolean styles can be removed only from the selected text and survive reopening', async ({
  page,
}) => {
  await mountDesignHost(page);
  await page.getByLabel('Host accepts commands').check();
  const object = page
    .getByRole('application', { name: 'Design canvas', exact: true })
    .getByRole('button')
    .filter({ has: page.locator('text') })
    .first();
  await object.dblclick();
  const editor = page.getByRole('textbox', { name: 'Edit canvas text', exact: true });
  await editor.press('Control+Home');
  await editor.press('ArrowRight');
  await editor.press('Shift+ArrowRight');
  await editor.press('Shift+ArrowRight');
  for (const name of ['bold', 'italic', 'underline', 'strike'])
    await page.getByRole('button', { name: `Selected text ${name}`, exact: true }).click();
  await page.getByRole('button', { name: 'Host flush', exact: true }).click();
  const next = await designSource(page);
  expect(next.elements[0].runs).toEqual([
    { text: 'H' },
    { text: 'el', style: { bold: false, italic: false, underline: false, strike: false } },
    { text: 'lo' },
  ]);
  await object.dblclick();
  await expect(editor.locator('strong')).toHaveText(['H', 'lo']);
  await expect(editor.locator('em')).toHaveText(['H', 'lo']);
  await expect(editor.locator('u')).toHaveText(['H', 'lo']);
  await expect(editor.locator('s')).toHaveText(['H', 'lo']);
});

test('PR #52 multi-file Review checks the visible address and remaps only that reference', async ({
  page,
}) => {
  const review = createReview(),
    artifact = createArtifact('review', 'Multi-file review', review);
  const [a, b] = review.files;
  const address = (file: typeof a, revisionId: string) => ({
    artifactId: artifact.id,
    elementId: file.id,
    region: { type: 'lines' as const, start: 1, end: 1, side: 'new' as const, revisionId },
  });
  const bAddress = address(b, 'retained-old-B');
  const annotation = addAnnotation(
    {
      addresses: [
        bAddress,
        address(a, reviewRevision(a, 'new')),
        { ...address(a, 'external-source'), artifactId: 'external' },
      ],
    },
    'Multi-file note',
    'Author',
  );
  await page.goto('/');
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'multi.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ ...artifact, annotations: [annotation] })),
  });
  const comment = page
    .locator('.ep-review-info')
    .getByRole('button', { name: 'Multi-file note · Current', exact: true });
  await expect(comment).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Remap annotation to selected current lines', exact: true }),
  ).toHaveCount(0);
  await comment.click();
  await page.getByRole('button', { name: 'Comparison sources', exact: true }).click();
  await page.getByLabel('New text', { exact: true }).fill('Inserted line\n' + a.newText);
  await page.getByRole('button', { name: 'Apply comparison sources', exact: true }).click();
  await expect(
    page
      .locator('.ep-review-info')
      .getByRole('button', { name: 'Multi-file note · Outdated', exact: true }),
  ).toBeVisible();
  const before = await nativeArtifact(page);
  await page
    .getByRole('button', { name: /added new line 1/ })
    .first()
    .click();
  await page
    .getByRole('button', { name: 'Remap annotation to selected current lines', exact: true })
    .click();
  const after = await nativeArtifact(page);
  const addresses = after.annotations[0].anchor.addresses;
  expect(addresses).toHaveLength(3);
  expect(addresses[0]).toEqual(before.annotations[0].anchor.addresses[0]);
  expect(addresses[2]).toEqual(before.annotations[0].anchor.addresses[2]);
  expect(addresses[1].region).toMatchObject({
    start: 1,
    end: 1,
    revisionId: (after.draft.content as typeof review).files[0].newRevision,
  });
  expect(after.annotations[0].comments).toEqual(before.annotations[0].comments);
  await expect(comment).toBeVisible();
  await save(page, 1);
  await page.reload();
  expect((await nativeArtifact(page)).annotations).toEqual(after.annotations);
});

test('PR #52 row Hug frame fitting distributes two children inside the fixed preset and Undo restores geometry', async ({
  page,
}, info) => {
  const frame = {
    ...makeDesignElement('frame'),
    id: 'frame',
    name: 'Row frame',
    bounds: { x: 40, y: 40, width: 1000, height: 1000 },
    layout: {
      direction: 'row' as const,
      gap: 16,
      padding: 16,
      align: 'center' as const,
      sizing: 'hug' as const,
    },
  };
  const children = [0, 1].map((i) => ({
    ...makeDesignElement('rectangle'),
    id: `child-${i}`,
    parentId: frame.id,
    name: `Row child ${i}`,
    bounds: { x: 0, y: 0, width: 600, height: 900 },
  }));
  const native = layoutDesign({ ...createDesign(), elements: [frame, ...children] });
  await page.goto('/');
  await importUsability(page, 'design', native);
  await page.getByRole('button', { name: frame.name, exact: true }).click();
  await page.getByLabel('Frame preset').selectOption('390x844');
  await page.getByRole('button', { name: 'Fit children to fixed frame', exact: true }).click();
  const fitted = (await nativeArtifact(page)).draft.content as DesignContent;
  expect(fitted.elements[1].bounds).toEqual({ x: 56, y: 56, width: 171, height: 812 });
  expect(fitted.elements[2].bounds).toEqual({ x: 243, y: 56, width: 171, height: 812 });
  await page.screenshot({ path: info.outputPath('row-frame-fit.png') });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(native);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(fitted);
});

test('PR #52 an ordinary image keeps semantics/alt/fit when made a component and strictly exports React', async ({
  page,
}) => {
  await authorDesignReact(page);
  await layer(page, 'Product');
  await page
    .getByLabel('Insert image file', { exact: true })
    .setInputFiles('tests/fixtures/office/images/quadrants.png');
  await expect(page.getByLabel('Image alt text', { exact: true })).toBeVisible();
  await page.getByLabel('Element HTML meaning').selectOption('img');
  await expect(page.getByLabel('Element HTML meaning')).toHaveValue('img');
  await page.getByLabel('Image alt text', { exact: true }).fill('部品として公開する色の比較');
  await page.getByLabel('Image alt text', { exact: true }).press('Enter');
  const before = (await nativeArtifact(page)).draft.content as DesignContent;
  const image = before.elements.find((element) => element.alt === '部品として公開する色の比較')!;
  expect(image.web?.tag).toBe('img');
  await page.getByRole('button', { name: 'Make component', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'React component publication' });
  await expect(
    dialog.getByRole('button', { name: 'Save React publication settings', exact: true }),
  ).toBeEnabled();
  await dialog
    .getByRole('button', { name: 'Save React publication settings', exact: true })
    .click();
  const native = (await nativeArtifact(page)).draft.content as DesignContent;
  const instance = native.elements.find((element) => element.id === image.id)!;
  const component = native.components.find((component) => component.id === instance.componentId)!;
  expect(component.template).toMatchObject({ alt: image.alt, web: image.web });
  expect(component.template.imageFit).toBe(image.imageFit);
  await save(page, 1);
  await page.reload();
  await page.getByRole('button', { name: 'Review React export', exact: true }).click();
  await page.getByRole('button', { name: 'Accept reviewed conversion', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download React bundle', exact: true }).click();
  const files = unzipSync(await readFile((await (await pending).path())!));
  expect(
    Object.entries(files)
      .filter(([path]) => path.endsWith('.tsx'))
      .map(([, data]) => strFromU8(data))
      .join('\n'),
  ).toContain(image.alt);
});

test('PR #52 Graph endpoint targets the frontmost overlapping node with matching preview, commit and Undo', async ({
  page,
}) => {
  const graph = createRelationGraph();
  const back = graph.nodes.find((node) => node.id === 'resource-b')!;
  graph.nodes.push({
    ...clone(back),
    id: 'front',
    attributes: { ...back.attributes, name: 'Front node' },
  });
  graph.layout.front = clone(graph.layout[back.id]);
  await page.goto('/');
  await importUsability(page, 'structured-graph', graph);
  await selectConnection(page, 'Select connection Related: Research to Planning');
  const handle = page.getByRole('button', { name: 'Drag connection to: Related', exact: true });
  const target = page.getByRole('button', { name: 'Select node Front node', exact: true });
  const from = (await handle.boundingBox())!,
    to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await expect(
    page.getByRole('status').filter({ hasText: 'Front nodeへ接続します' }),
  ).toBeVisible();
  await page.mouse.up();
  expect(((await nativeArtifact(page)).draft.content as GraphDocument).edges[0].to).toBe('front');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(graph);
});

test('PR #52 independent Graph Host consumes Dashboard private Undo/Redo before native Data history', async ({
  page,
}) => {
  await page.goto('/graph-host.html');
  await expect(page.getByRole('status').first()).toHaveText('Ready');
  await page.getByLabel('Graph source', { exact: true }).selectOption('data');
  await expect(page.getByRole('status').first()).toHaveText('Ready');
  // Seed this fictional Data artifact through the Host storage adapter, then reopen it.
  const artifact = {
    ...createArtifact('data', 'Independent dashboard', auditData()),
    id: 'graph-host-data',
  };
  await page.evaluate(async (serialized) => {
    const record = JSON.parse(serialized);
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('independent-graph-host', 1);
      request.onsuccess = () => {
        const db = request.result,
          tx = db.transaction('artifacts', 'readwrite');
        tx.objectStore('artifacts').put(record);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
  }, JSON.stringify(artifact));
  await page.reload();
  await page.getByLabel('Graph source', { exact: true }).selectOption('data');
  await expect(page.getByRole('status').first()).toHaveText('Reloaded locally');
  await dataProjection(page, 'Dashboard');
  await expect(page.locator('.ep-widget')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Host Undo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Delete widget 3', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Host Undo', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  await expect(page.locator('.ep-widget')).toHaveCount(3);
  await page.getByRole('button', { name: 'Host Redo', exact: true }).click();
  await expect(page.locator('.ep-widget')).toHaveCount(2);
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
  const canonical = await independentSource<StructuredData>(page);
  expect(canonical.views![0].widgets).toHaveLength(2);
  await page.getByRole('button', { name: 'Delete widget 2', exact: true }).click();
  await page.getByRole('button', { name: 'Host Undo', exact: true }).focus();
  await page.keyboard.press('Control+z');
  await expect(page.locator('.ep-widget')).toHaveCount(2);
  expect(await independentSource(page)).toEqual(canonical);
  await page.keyboard.press('Control+Shift+z');
  await expect(page.locator('.ep-widget')).toHaveCount(1);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await expect(page.locator('.ep-widget')).toHaveCount(3);
  expect((await independentSource<StructuredData>(page)).views![0].widgets).toHaveLength(3);
});

test('PR #52 CSV formula mapping blocks import until an editable target is selected', async ({
  page,
}) => {
  const data = auditData();
  data.columns.push({ id: 'computed', name: 'Computed', type: 'formula', formula: '[Value] * 2' });
  await page.goto('/');
  await importUsability(page, 'data', data);
  await page.getByLabel('Import CSV file', { exact: true }).setInputFiles({
    name: 'mapped.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('source\n99\n'),
  });
  const dialog = page.getByRole('dialog', { name: 'CSV import preview' });
  await dialog.getByLabel('Append target source', { exact: true }).selectOption('computed');
  await expect(dialog).toContainText(
    'Formula fields are computed; choose an editable target field',
  );
  await expect(dialog.getByRole('button', { name: 'Import records', exact: true })).toBeDisabled();
  // Closing the preview must leave the existing native rows unchanged.
  await page.getByRole('button', { name: 'Close CSV import preview', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(data);
  await page.getByLabel('Import CSV file', { exact: true }).setInputFiles({
    name: 'mapped.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('source\n99\n'),
  });
  await dialog.getByLabel('Append target source', { exact: true }).selectOption('value');
  await expect(dialog.getByRole('button', { name: 'Import records', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Import records', exact: true }).click();
  const appended = (await nativeArtifact(page)).draft.content as StructuredData;
  expect(appended.columns).toEqual(data.columns);
  expect(appended.rows).toHaveLength(4);
  expect(appended.rows[3].values.value).toBe(99);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(data);
});

for (const mode of ['native', 'data'] as const)
  test(`PR #52 independent ${mode} restore retains invalid input and flushes corrected input into Undo history`, async ({
    page,
  }) => {
    await page.goto('/graph-host.html');
    await expect(page.getByRole('status').first()).toHaveText('Ready');
    if (mode === 'data') {
      await page.getByLabel('Graph source', { exact: true }).selectOption('data');
      await expect(page.getByRole('status').first()).toHaveText('Ready');
      await dataProjection(page, 'Form');
    } else {
      await page.getByRole('button', { name: 'Select node Research', exact: true }).click();
    }
    await page.getByRole('button', { name: 'Commit version', exact: true }).click();
    await expect(page.getByRole('status').first()).toHaveText('Saved locally');
    const saved = await downloadJson(page, 'Export native JSON');
    await page.getByText('Saved versions', { exact: true }).click();
    const field = page.getByLabel(mode === 'data' ? 'Record Name' : 'score', { exact: true });
    const invalid = mode === 'data' ? '' : '-1';
    await field.fill(invalid);
    await page.getByRole('button', { name: 'Restore version 1', exact: true }).click();
    await expect(page.getByRole('status').first()).toHaveText('Uncommitted input; restore blocked');
    await expect(page.getByRole('alert').first()).toBeVisible();
    await expect(field).toHaveValue(invalid);
    expect(await independentSource(page)).toEqual(saved.draft.content);
    if (mode === 'native') await field.fill('1');
    await page
      .getByLabel(mode === 'data' ? 'Record Name' : 'name', { exact: true })
      .fill('Retained before restore');
    await page.getByRole('button', { name: 'Restore version 1', exact: true }).click();
    await expect(page.getByRole('status').first()).toHaveText('Unsaved draft');
    expect(await independentSource(page)).toEqual(saved.versions[0].content);
    await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
    const undone = await independentSource<GraphDocument | StructuredData>(page);
    expect(
      mode === 'data'
        ? (undone as StructuredData).rows[0].values.name
        : (undone as GraphDocument).nodes[0].attributes.name,
    ).toBe('Retained before restore');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(page.getByRole('status').first()).toHaveText('Saved locally');
    expect((await downloadJson(page, 'Export native JSON')).versions).toEqual(saved.versions);
  });
