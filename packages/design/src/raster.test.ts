import { expect, it } from 'vitest';
import { canonicalJson, commitVersion, createArtifact } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import {
  createDesign,
  insertElement,
  updateElement,
  replaceDesignRaster,
  designPngInfo,
  editableDesignRaster,
  assertRasterRegion,
} from './model';
const WHITE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAD0lEQVR4AWL6DwVMDFAAAAAA//8tCooDAAAABklEQVQDAGvcB/1Sm89eAAAAAElFTkSuQmCC';
const BLACK =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4AWJiYGD4D8IgBpBmYAAAAAD//7vS9wEAAAAGSURBVAMAGDACA6ybwrYAAAAASUVORK5CYII=';
function fixture() {
  return insertElement('image', {
    id: 'image',
    src: WHITE,
    bounds: { x: 0, y: 0, width: 2, height: 2 },
  }).apply(createDesign());
}
it('pixel replacement uses the existing command/history and preserves immutable versions', async () => {
  const original = fixture(),
    artifact = await commitVersion(createArtifact('design', 'Pixels', original), null, 'original'),
    snapshot = canonicalJson(artifact),
    session = new EditorSession(original);
  session.execute(replaceDesignRaster(original, 'image', BLACK, 'paint'));
  expect(session.content.elements[0].src).toBe(BLACK);
  session.undo();
  expect(session.content).toEqual(original);
  session.redo();
  expect(session.content.elements[0].src).toBe(BLACK);
  expect(canonicalJson(artifact)).toBe(snapshot);
});
it('rejects readonly, stale, hidden/locked ancestry and unchanged PNG replacement', () => {
  const base = fixture();
  let writable = true;
  const c = replaceDesignRaster(base, 'image', BLACK, 'erase', () => writable);
  writable = false;
  expect(() => c.apply(base)).toThrow(/閲覧専用/);
  writable = true;
  expect(() => c.apply(updateElement('image', { name: 'changed' }).apply(base))).toThrow(
    /変わりました/,
  );
  for (const key of ['hidden', 'locked'] as const)
    expect(() =>
      editableDesignRaster(updateElement('image', { [key]: true }).apply(base), 'image'),
    ).toThrow();
  const parent = insertElement('group', { id: 'parent' }).apply(createDesign()),
    nested = insertElement('image', { id: 'child', parentId: 'parent', src: WHITE }).apply(parent);
  expect(() =>
    editableDesignRaster(updateElement('parent', { locked: true }).apply(nested), 'child'),
  ).toThrow();
  expect(() => replaceDesignRaster(base, 'image', WHITE, 'paint')).toThrow(/変更がありません/);
});
it('bounds PNG admission and explicit integer rectangles before browser decode', () => {
  expect(designPngInfo(WHITE)).toMatchObject({ width: 2, height: 2 });
  expect(() => designPngInfo('https://example.org/image.png')).toThrow();
  expect(() => designPngInfo(WHITE.slice(0, -4))).toThrow();
  const bytes = Uint8Array.from(atob(WHITE.split(',')[1]), (c) => c.charCodeAt(0));
  bytes[35] ^= 1;
  expect(() =>
    designPngInfo('data:image/png;base64,' + btoa(String.fromCharCode(...bytes))),
  ).toThrow();
  for (const region of [
    { x: -1, y: 0, width: 1, height: 1 },
    { x: 0, y: 0, width: 0, height: 1 },
    { x: 0.5, y: 0, width: 1, height: 1 },
    { x: 1, y: 1, width: 2, height: 1 },
  ])
    expect(() => assertRasterRegion(region, 2, 2)).toThrow();
  assertRasterRegion({ x: 0, y: 0, width: 2, height: 2 }, 2, 2);
});
