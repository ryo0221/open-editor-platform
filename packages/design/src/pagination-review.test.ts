import { expect, it } from 'vitest';
import { canonicalJson, commitVersion, createArtifact } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import {
  createDesign,
  insertElement,
  arrangeDesign,
  patchDesign,
  updateElement,
  isDesignWithPaths,
  type DesignContent,
} from '@editor-platform/design/model';
import {
  insertDesignPage,
  insertDesignPanel,
  setDesignPagination,
  captureDesignPages,
  designPageEditCommand,
} from '@editor-platform/design/pagination';

function fixture() {
  let d = insertDesignPage({ x: 0, y: 0, width: 600, height: 800 }, 'page').apply(createDesign());
  for (const [i, id] of ['panel-a', 'panel-b'].entries())
    d = insertDesignPanel('page', { x: 20, y: 20 + i * 380, width: 560, height: 350 }, id).apply(d);
  d = insertElement('image', {
    id: 'asset',
    parentId: 'panel-a',
    src: 'data:image/png;base64,AA==',
    bounds: { x: 40, y: 40, width: 100, height: 100 },
  }).apply(d);
  d = insertElement('text', {
    id: 'dialogue',
    parentId: 'panel-a',
    bounds: { x: 40, y: 160, width: 350, height: 80 },
  }).apply(d);
  return setDesignPagination({
    ...d.pagination!,
    images: [{ elementId: 'asset', source: 'Owned fixture', license: 'CC0-1.0' }],
  }).apply(d);
}
for (const target of ['asset', 'panel-a', 'page'])
  it(`Duplicate ${target} remaps source/read-order metadata atomically and still captures`, async () => {
    const base = fixture();
    const before = canonicalJson(base);
    const session = new EditorSession(base);
    session.execute(arrangeDesign([target], 'duplicate'));
    const after = session.content;
    expect(isDesignWithPaths(after)).toBe(true);
    const originals = new Set(base.elements.map((e) => e.id));
    const copies = after.elements.filter((e) => !originals.has(e.id));
    const asset = copies.find((e) => e.type === 'image')!;
    expect(after.pagination!.images).toEqual([
      ...base.pagination!.images,
      { elementId: asset.id, source: 'Owned fixture', license: 'CC0-1.0' },
    ]);
    if (target === 'page') {
      const page = copies.find((e) => e.type === 'frame' && !e.parentId)!;
      const panels = copies.filter((e) => e.type === 'frame' && e.parentId === page.id);
      expect(after.pagination!.pages).toEqual([
        ...base.pagination!.pages,
        { frameId: page.id, panelIds: panels.map((e) => e.id) },
      ]);
      expect(asset.parentId).toBe(panels[0].id);
    } else if (target === 'panel-a') {
      const panel = copies.find((e) => e.type === 'frame')!;
      expect(after.pagination!.pages[0].panelIds).toEqual(['panel-a', panel.id, 'panel-b']);
      expect(asset.parentId).toBe(panel.id);
    } else expect(after.pagination!.pages).toEqual(base.pagination!.pages);
    const saved = await commitVersion(createArtifact('design', 'Duplicate', after), null, 'copy');
    const capture = await captureDesignPages(saved, saved.versions[0].versionId);
    expect(capture.ok).toBe(true);
    expect(capture.manifest.images).toEqual(after.pagination!.images);
    expect(capture.pages.map((p) => p.frameId)).toEqual(
      after.pagination!.pages.map((p) => p.frameId),
    );
    session.undo();
    expect(session.content).toEqual(base);
    session.redo();
    expect(session.content).toEqual(after);
    expect(canonicalJson(base)).toBe(before);
  });
it('refuses a duplicated page above the metadata limit without leaving copied elements/history', () => {
  let d = createDesign();
  for (let i = 0; i < 128; i++)
    d = insertDesignPage({ x: i * 620, y: 0, width: 600, height: 800 }, `p-${i}`).apply(d);
  const session = new EditorSession(d);
  const before = canonicalJson(session.content);
  expect(() => session.execute(arrangeDesign(['p-0'], 'duplicate'))).toThrow();
  expect(canonicalJson(session.content)).toBe(before);
  expect(session.canUndo).toBe(false);
});
for (const [name, appearance] of [
  ['writing-mode', { typography: { writingMode: 'vertical-rl' } }],
  ['ruby-run', { runs: [{ text: '漢字', style: { ruby: 'かんじ' } }] }],
  ['rotation', { rotation: 20 }],
] as const)
  it(`refuses inherited ${name} instead of silently flattening it`, async () => {
    const d = fixture();
    d.elements = d.elements.map((e) => (e.id === 'dialogue' ? { ...e, styleId: 'shared' } : e));
    d.styles = [{ id: 'shared', name: name, appearance }] as unknown as DesignContent['styles'];
    expect(isDesignWithPaths(d)).toBe(true);
    const saved = await commitVersion(createArtifact('design', name, d), null, 'fixture');
    const before = canonicalJson(saved);
    const result = await captureDesignPages(saved, saved.versions[0].versionId);
    expect(result.ok).toBe(false);
    expect(result.pages).toEqual([]);
    expect(result.manifest.diagnostics).toContainEqual(
      expect.objectContaining({
        elementId: 'dialogue',
        severity: 'error',
        code: name === 'rotation' ? 'unsupported' : 'text-style',
      }),
    );
    expect(canonicalJson(saved)).toBe(before);
  });

it('refuses dialogue edits whose native runs are inherited from shared styles without losing formatting/history', () => {
  const d = fixture();
  d.elements = d.elements.map((e) =>
    e.id === 'dialogue' ? { ...e, text: 'Bold', styleId: 'bold' } : e,
  );
  d.styles = [
    { id: 'bold', name: 'Bold', appearance: { runs: [{ text: 'Bold', style: { bold: true } }] } },
  ];
  const session = new EditorSession(d);
  const before = canonicalJson(session.content);
  expect(() =>
    session.execute(designPageEditCommand([{ type: 'text', id: 'dialogue', value: 'New' }])),
  ).toThrow(/native text preparation/);
  expect(canonicalJson(session.content)).toBe(before);
  expect(session.canUndo).toBe(false);
});
for (const mode of ['patch', 'update', 'explicit'] as const)
  it(`invalidates stale image provenance on ${mode} replacement, while explicit metadata can restore capture`, async () => {
    const d = fixture();
    const session = new EditorSession(d);
    const src = 'data:image/png;base64,AQ==';
    const cmd =
      mode === 'patch'
        ? patchDesign(['asset'], { src, reference: undefined })
        : mode === 'update'
          ? updateElement('asset', { src })
          : designPageEditCommand([
              {
                type: 'image',
                id: 'asset',
                value: { src, source: 'New owned material', license: 'New license' },
              },
            ]);
    session.execute(cmd);
    const after = session.content;
    expect(after.pagination!.images).toEqual(
      mode === 'explicit'
        ? [{ elementId: 'asset', source: 'New owned material', license: 'New license' }]
        : [],
    );
    const artifact = await commitVersion(
      createArtifact('design', mode, after),
      null,
      'replacement',
    );
    const capture = await captureDesignPages(artifact, artifact.versions[0].versionId);
    expect(capture.ok).toBe(mode === 'explicit');
    if (mode !== 'explicit')
      expect(capture.manifest.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'image-source', elementId: 'asset' }),
      );
    session.undo();
    expect(session.content).toEqual(d);
    session.redo();
    expect(session.content).toEqual(after);
  });
it('preserves attribution when native edits keep the same source bytes', () => {
  const d = fixture();
  const next = patchDesign(['asset'], { imageFit: 'fit', opacity: 0.7 }).apply(d);
  expect(next.pagination!.images).toEqual(d.pagination!.images);
});
