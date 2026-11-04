import { expect, it } from 'vitest';
import {
  createArtifact,
  commitVersion,
  MemoryStorage,
  type Artifact,
} from '@editor-platform/artifact-core';
import { ArtifactEditor, loadHostArtifact } from '@editor-platform/editor-host';
import {
  createDesign,
  insertElement,
  updateElement,
  isDesignWithPaths,
  insertDesignStroke,
  designStrokePath,
  designStrokeParent,
  replaceDesignPath,
  moveDesignPathPoint,
  type DesignContent,
} from './model';
import { insertDesignPage, insertDesignPanel } from './pagination';

it('keeps consecutive strokes in a second page or selected group, rather than the first panel', () => {
  let content = insertDesignPage({ x: 0, y: 0, width: 400, height: 500 }, 'first').apply(
    createDesign(),
  );
  content = insertDesignPanel(
    'first',
    { x: 0, y: 0, width: 400, height: 500 },
    'first-panel',
  ).apply(content);
  content = insertDesignPage({ x: 450, y: 0, width: 400, height: 500 }, 'second').apply(content);
  expect(designStrokeParent(content)).toBe('first-panel');
  for (const owner of ['second', 'second-group']) {
    if (owner === 'second-group')
      content = insertElement('group', { id: owner, parentId: 'second' }).apply(content);
    let selected = owner;
    for (let n = 0; n < 2; n++) {
      const command = insertDesignStroke(
        [
          { x: 500, y: 100 + n * 20 },
          { x: 550, y: 130 + n * 20 },
        ],
        designStrokeParent(content, selected),
      );
      content = command.apply(content);
      selected = command.elementId;
      expect(content.elements.find((e) => e.id === selected)!.parentId).toBe(owner);
    }
  }
});

it('uses ordinary editable paths/history/versions for a sampled stroke and later AI path edits', async () => {
  const parent = insertElement('frame', {
    id: 'page',
    bounds: { x: 0, y: 0, width: 400, height: 500 },
  }).apply(createDesign());
  const artifact = await commitVersion(createArtifact('design', 'stroke', parent), null, 'blank');
  const adapter = {
    kind: 'design',
    validate: isDesignWithPaths,
    capabilities: {
      undo: true,
      nativeJson: true,
      formats: [],
      preview: 'none',
      shared: false,
      proposals: true,
    },
  } as const;
  const editor = new ArtifactEditor(
    artifact,
    adapter,
    new MemoryStorage<Artifact<DesignContent>>(),
  );
  const samples = [
    { x: 35, y: 60 },
    { x: 45, y: 57 },
    { x: 45, y: 57 },
    { x: 65, y: 69 },
    { x: 90, y: 78 },
  ];
  const before = structuredClone(samples),
    command = insertDesignStroke(samples, 'page');
  editor.execute(command);
  expect(samples).toEqual(before);
  const element = editor.content.elements.find((e) => e.id === command.elementId)!;
  expect(element.parentId).toBe('page');
  expect(element.path!.subpaths[0].anchors).toHaveLength(4);
  expect(element.strokeWidth).toBe(2.5);
  editor.undo();
  expect(editor.content).toEqual(parent);
  editor.redo();
  const path = element.path!,
    sub = path.subpaths[0];
  const next = moveDesignPathPoint(
    path,
    { subpathId: sub.id, anchorId: sub.anchors[1].id },
    { x: 49, y: 54 },
  );
  editor.propose({
    id: 'ai-stroke-refine',
    summary: '同じ描線を調整',
    baseLocalRevision: editor.revision,
    commands: [replaceDesignPath(editor.content, element.id, next)],
  });
  editor.acceptProposal('ai-stroke-refine');
  await editor.save({ commitVersion: true, author: 'stroke test' });
  const loaded = await loadHostArtifact(String(await editor.export('native-json')), adapter);
  expect(loaded.draft.content.elements.find((e) => e.id === element.id)!.path).toEqual(next);
  expect(loaded.versions[0]).toEqual(artifact.versions[0]);
});
it('rejects invalid or no-movement strokes and locked/readOnly insertions without changing source', () => {
  for (const samples of [
    [],
    [{ x: 1, y: 1 }],
    [
      { x: 1, y: 1 },
      { x: 1, y: 1 },
    ],
    [
      { x: 0, y: 0 },
      { x: NaN, y: 1 },
    ],
    [
      { x: 0, y: 0 },
      { x: 1_000_001, y: 1 },
    ],
    Array.from({ length: 2049 }, (_, i) => ({ x: i, y: i })),
  ])
    expect(() => designStrokePath(samples)).toThrow();
  const initial = insertElement('frame', { id: 'page' }).apply(createDesign());
  const locked = updateElement('page', { locked: true }).apply(initial),
    copy = structuredClone(locked);
  expect(() =>
    insertDesignStroke(
      [
        { x: 1, y: 1 },
        { x: 2, y: 3 },
      ],
      'page',
    ).apply(locked),
  ).toThrow();
  expect(locked).toEqual(copy);
  expect(() =>
    insertDesignStroke(
      [
        { x: 1, y: 1 },
        { x: 2, y: 3 },
      ],
      'page',
      () => false,
    ).apply(initial),
  ).toThrow('read only');
  expect(initial.elements).toHaveLength(1);
});
