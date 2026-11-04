import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  clone,
  commitVersion,
  createArtifact,
} from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import {
  createDesign,
  insertElement,
  insertDesignPath,
  presetDesignPath,
  updateElement,
  transformElements,
  deleteElements,
  duplicateElements,
  isDesign,
  isDesignWithPaths,
  designDrawings,
  designPreview,
} from './model';
import { insertDesignPage, captureDesignPages, setDesignPagination } from './pagination';
import {
  designDivisionCommand,
  clampDividerOffset,
  materializeDivision,
  validDivisionTree,
  type DesignDivisionOperation,
} from './division';

export function divisionFixture() {
  const base = insertDesignPage({ x: 100, y: 200, width: 600, height: 800 }, 'page').apply(
    createDesign(),
  );
  return designDivisionCommand({
    type: 'startDivision',
    pageId: 'page',
    region: { x: 30, y: 40, width: 540, height: 720 },
    root: { panelId: 'panel' },
  }).apply(base);
}
const split: DesignDivisionOperation = {
  type: 'splitPanel',
  pageId: 'page',
  panelId: 'panel',
  newPanelId: 'new',
  dividerId: 'cut',
  line: { nx: 0, ny: 1, offset: 400 },
  gap: 20,
  retain: 'a',
  insert: 'after',
};
describe('Linked manga panels', () => {
  it('rejects malformed style storage without throwing and keeps illegal generic previews unchanged', () => {
    const d = divisionFixture();
    for (const styles of [null, {}, [null], [{ appearance: null }]]) {
      expect(() => isDesignWithPaths({ ...d, styles })).not.toThrow();
      expect(isDesignWithPaths({ ...d, styles })).toBe(false);
    }
    const before = d.elements.find((e) => e.id === 'panel')!;
    expect(
      designPreview(d, ['panel'], { dx: 10, dy: 0, dw: 0, dh: 0 }).get('panel')!.bounds,
    ).toEqual(before.bounds);
  });
  it('migrates only on editing; Undo restores exact old content, Redo retains IDs', () => {
    const old = insertDesignPage({ x: 100, y: 200, width: 600, height: 800 }, 'page').apply(
      createDesign(),
    );
    const session = new EditorSession(old),
      initial = canonicalJson(old),
      revision = session.revision;
    session.execute(
      designDivisionCommand({
        type: 'startDivision',
        pageId: 'page',
        region: { x: 30, y: 40, width: 540, height: 720 },
        root: { panelId: 'panel' },
      }),
    );
    const next = canonicalJson(session.content);
    expect(session.content.schemaVersion).toBe(4);
    expect(isDesign(session.content)).toBe(false);
    session.undo();
    expect(canonicalJson(session.content)).toBe(initial);
    expect(session.revision).not.toEqual(revision);
    session.redo();
    expect(canonicalJson(session.content)).toBe(next);
  });
  it.each(['a', 'b'] as const)(
    'retains side %s, stable art, explicit before/after reading order',
    (retain) => {
      const start = insertElement('text', {
        id: 'art',
        parentId: 'panel',
        bounds: { x: 140, y: 250, width: 100, height: 40 },
      }).apply(divisionFixture());
      for (const insert of ['before', 'after'] as const) {
        const next = designDivisionCommand({ ...split, retain, insert }).apply(start);
        expect(next.pagination!.pages[0].panelIds).toEqual(
          insert === 'after' ? ['panel', 'new'] : ['new', 'panel'],
        );
        expect(next.elements.find((e) => e.id === 'art')).toEqual(
          start.elements.find((e) => e.id === 'art'),
        );
        expect(next.elements.find((e) => e.id === 'panel')!.bounds.y).toBe(
          retain === 'a' ? 240 : 610,
        );
        expect(next.elements.find((e) => e.id === 'new')!.panelGeometry).toBeDefined();
      }
    },
  );
  it('moves an oblique T parent, fixes child lines and artwork world coordinates', () => {
    let d = designDivisionCommand(split).apply(divisionFixture());
    d = designDivisionCommand({
      ...split,
      panelId: 'panel',
      newPanelId: 'top-right',
      dividerId: 'child',
      line: { nx: 1, ny: 0, offset: 300 },
      gap: 12,
    }).apply(d);
    d = insertDesignPath(
      presetDesignPath('cubic'),
      { x: 120, y: 240, width: 250, height: 150 },
      'panel',
    ).apply(d);
    const art = d.elements.find((e) => e.path)!;
    const line = { nx: 0.2, ny: Math.sqrt(0.96), offset: 480 };
    const next = designDivisionCommand({
      type: 'setDivider',
      pageId: 'page',
      dividerId: 'cut',
      line,
      gap: 20,
    }).apply(d);
    expect(next.elements.find((e) => e.id === art.id)).toEqual(art);
    expect(
      materializeDivision(
        next.pagination!.pages[0].division!,
        next.elements[0].bounds,
      ).dividers.find((e) => e.dividerId === 'child')!.line,
    ).toEqual({ nx: 1, ny: 0, offset: 300 });
    expect(isDesignWithPaths(next)).toBe(true);
    expect(next.schemaVersion).toBe(4);
    const svg = designDrawings(next, next.elements.find((e) => e.id === 'panel')!)[0];
    expect(svg.polygon).toBeDefined();
    expect(svg.clipBounds![0].polygon).toEqual(svg.polygon);
  });
  it('clamps pointer movement but rejects the same out-of-range numeric edit', () => {
    const d = designDivisionCommand(split).apply(divisionFixture());
    expect(() =>
      designDivisionCommand({
        type: 'setDivider',
        pageId: 'page',
        dividerId: 'cut',
        line: { nx: 0, ny: 1, offset: 900 },
        gap: 20,
      }).apply(d),
    ).toThrow();
    const preview = clampDividerOffset(d, 'page', 'cut', 900);
    expect(preview.limited).toBe(true);
    expect(preview.operation.type === 'setDivider' && preview.operation.line.offset).toBeLessThan(
      900,
    );
    expect(isDesignWithPaths(preview.content)).toBe(true);
    expect(designDivisionCommand(preview.operation).apply(d)).toEqual(preview.content);
  });
  it('rejects generic panel resize/delete, page resize, shape/style and layout bypasses', () => {
    const d = designDivisionCommand(split).apply(divisionFixture()),
      before = canonicalJson(d);
    for (const cmd of [
      transformElements(['panel'], { dx: 3, dy: 0, dw: 0, dh: 0 }),
      deleteElements(['panel']),
      transformElements(['page'], { dx: 0, dy: 0, dw: 30, dh: 0 }),
      updateElement('panel', { clipContent: false }),
      updateElement('panel', { shape: 'triangle' }),
      updateElement('page', { rotation: 15 }),
    ])
      expect(() => cmd.apply(d)).toThrow();
    const bad = clone(d);
    bad.styles = [{ id: 'bad', name: 'bad', appearance: { shape: 'ellipse' } }];
    bad.elements.find((e) => e.id === 'panel')!.styleId = 'bad';
    expect(isDesignWithPaths(bad)).toBe(false);
    expect(canonicalJson(d)).toBe(before);
    const moved = transformElements(['page'], { dx: 20, dy: 10, dw: 0, dh: 0 }).apply(d);
    expect(moved.pagination).toEqual(d.pagination);
    expect(deleteElements(['page']).apply(d).elements).toHaveLength(0);
  });
  it('merges only sibling leaves, preserving child IDs and world positions, and detaches atomically', () => {
    let d = designDivisionCommand(split).apply(divisionFixture());
    d = insertElement('text', {
      id: 'art',
      parentId: 'new',
      bounds: { x: 150, y: 650, width: 100, height: 40 },
    }).apply(d);
    const merged = designDivisionCommand({
      type: 'mergePanels',
      pageId: 'page',
      dividerId: 'cut',
      retainPanelId: 'panel',
    }).apply(d);
    expect(merged.elements.find((e) => e.id === 'new')).toBeUndefined();
    expect(merged.elements.find((e) => e.id === 'art')).toEqual({
      ...d.elements.find((e) => e.id === 'art'),
      parentId: 'panel',
    });
    const detached = designDivisionCommand({ type: 'detachDivision', pageId: 'page' }).apply(d);
    expect(detached.elements).toEqual(d.elements);
    expect(detached.schemaVersion).toBe(4);
    expect(() =>
      transformElements(['panel'], { dx: 12, dy: 0, dw: 20, dh: 0 }).apply(detached),
    ).not.toThrow();
    expect(() => updateElement('panel', { rotation: 15 }).apply(detached)).toThrow();
    expect(() =>
      setDesignPagination({
        ...d.pagination!,
        pages: d.pagination!.pages.map((p) => ({ frameId: p.frameId, panelIds: p.panelIds })),
      }).apply(d),
    ).toThrow();
  });
  it('duplicates a whole page with all element/divider IDs remapped, rejects single-panel copy', () => {
    const d = designDivisionCommand(split).apply(divisionFixture());
    const next = duplicateElements(['page']).apply(d);
    expect(next.pagination!.pages).toHaveLength(2);
    expect(isDesignWithPaths(next)).toBe(true);
    const a = next.pagination!.pages[0].division!.root,
      b = next.pagination!.pages[1].division!.root;
    expect('dividerId' in a && 'dividerId' in b && a.dividerId === b.dividerId).toBe(false);
    expect(() => duplicateElements(['panel']).apply(d)).toThrow();
  });
  it('rejects forged geometry, old-schema polygon, unknown/cyclic trees and readonly execution', () => {
    const d = designDivisionCommand(split).apply(divisionFixture());
    const bad = clone(d);
    bad.elements.find((e) => e.id === 'panel')!.bounds.x++;
    expect(isDesignWithPaths(bad)).toBe(false);
    expect(isDesignWithPaths({ ...d, schemaVersion: 3 })).toBe(false);
    expect(() => designDivisionCommand({ ...split, unknown: true })).toThrow();
    const cycle: { region: unknown; root: unknown } = {
      region: { x: 0, y: 0, width: 100, height: 100 },
      root: null,
    };
    cycle.root = {
      dividerId: 'x',
      line: { nx: 1, ny: 0, offset: 50 },
      gap: 0,
      a: cycle,
      b: { panelId: 'p' },
    };
    expect(validDivisionTree(cycle)).toBe(false);
    expect(() =>
      designDivisionCommand({ type: 'detachDivision', pageId: 'page' }, () => false).apply(d),
    ).toThrow('read only');
  });
  it('captures the same polygon and inside bevel stroke from an immutable version', async () => {
    const d = designDivisionCommand({
      ...split,
      line: { nx: Math.SQRT1_2, ny: Math.SQRT1_2, offset: 450 },
    }).apply(divisionFixture());
    const artifact = await commitVersion(createArtifact('design', 'Manga', d), null, 'fixture');
    const capture = await captureDesignPages(artifact, artifact.versions[0].versionId, {
      mode: 'vector',
    });
    expect(capture.ok).toBe(true);
    expect(capture.pages[0].svg).toContain('stroke-linejoin="bevel"');
    expect(capture.pages[0].svg).toContain('stroke-width="4"');
    expect(capture.pages[0].svg).toContain('<clipPath');
  });
});
