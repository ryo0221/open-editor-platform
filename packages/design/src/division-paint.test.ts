import { expect, it } from 'vitest';
import { deepFreeze, commitVersion, createArtifact } from '@editor-platform/artifact-core';
import {
  createDesign,
  insertElement,
  updateElement,
  designDrawingProjector,
  designPaintOrder,
  designExportBounds,
  insertDesignPath,
  presetDesignPath,
  type DesignContent,
} from './model';
import { designDivisionCommand } from './division';
import { insertDesignPage, captureDesignPages } from './pagination';
import { createDesignRenderCache } from './render-cache';
import { designCanvasTargets } from './view-panels';

function fixture() {
  let d = insertDesignPage({ x: 0, y: 0, width: 100, height: 100 }, 'page').apply(createDesign());
  d = designDivisionCommand({
    type: 'startDivision',
    pageId: 'page',
    region: { x: 10, y: 10, width: 80, height: 80 },
    root: { panelId: 'panel' },
  }).apply(d);
  d = updateElement('panel', { stroke: '#111111', strokeWidth: 4 }).apply(d);
  d = insertElement('rectangle', {
    id: 'paint',
    parentId: 'panel',
    bounds: { x: 10, y: 10, width: 80, height: 80 },
  }).apply(d);
  return updateElement('paint', { fill: '#ff0000', strokeWidth: 0 }).apply(d);
}
const drawings = (d: DesignContent) =>
  designPaintOrder(d)
    .filter((e) => !e.hidden)
    .flatMap(designDrawingProjector(d));

it('paints the inside panel border above opaque artwork but before later page siblings', async () => {
  let d = fixture();
  d = insertDesignPage({ x: 0, y: 0, width: 100, height: 100 }, 'cover-page').apply(d);
  const result = drawings(d),
    border = result.findIndex((e) => e.panelBorderOf === 'panel');
  expect(result.find((e) => e.id === 'panel')!.stroke).toBe('none');
  expect(border).toBeGreaterThan(result.findIndex((e) => e.id === 'paint'));
  expect(border).toBeLessThan(result.findIndex((e) => e.id === 'cover-page'));
  expect(result[border]).toMatchObject({
    fill: 'none',
    stroke: '#111111',
    strokeWidth: 4,
    polygon: expect.any(Array),
  });
  const artifact = await commitVersion(createArtifact('design', 'border', d), null, 'fixture');
  const capture = await captureDesignPages(artifact, artifact.versions[0].versionId, {
    mode: 'vector',
  });
  expect(capture.ok).toBe(true);
  const svg = capture.pages[0].svg;
  expect(svg.lastIndexOf('stroke="#111111"')).toBeGreaterThan(svg.indexOf('fill="#ff0000"'));
});
it('keeps native border IDs private and does not export an ancestor border with artwork alone', () => {
  let d = fixture();
  d = insertElement('rectangle', {
    id: 'panel-border',
    parentId: 'panel',
    bounds: { x: 25, y: 25, width: 10, height: 10 },
  }).apply(d);
  const result = drawings(d),
    border = result.find((e) => e.panelBorderOf === 'panel')!;
  expect(border.id).not.toBe('panel-border');
  const onlyArt = designDrawingProjector(d, new Set(['panel-border']))(d.elements.at(-1)!);
  expect(onlyArt.some((e) => e.panelBorderOf)).toBe(false);
});
it('places the border after the last included artwork when a later child is outside the prototype', () => {
  const d = insertElement('rectangle', {
    id: 'outside',
    parentId: 'panel',
    bounds: { x: 120, y: 120, width: 10, height: 10 },
  }).apply(fixture());
  const included = new Set(['page', 'panel', 'paint']);
  const result = designPaintOrder(d)
    .filter((e) => included.has(e.id))
    .flatMap(designDrawingProjector(d, included));
  expect(result.at(-1)).toMatchObject({ panelBorderOf: 'panel', stroke: '#111111' });
});
it('moves the cached border to a new visible child without enlarging its hit bounds', () => {
  const d = deepFreeze(fixture()),
    cache = createDesignRenderCache();
  const paint = d.elements.find((e) => e.id === 'paint')!;
  expect(cache(d)(paint).some((e) => e.panelBorderOf === 'panel')).toBe(true);
  const added = insertDesignPath(
    presetDesignPath('line'),
    { x: 30, y: 40, width: 20, height: 10 },
    'panel',
  );
  const next = deepFreeze(added.apply(d)),
    project = cache(next);
  expect(project(next.elements.find((e) => e.id === 'paint')!).some((e) => e.panelBorderOf)).toBe(
    false,
  );
  const line = next.elements.find((e) => e.id === added.elementId)!;
  expect(project(line).some((e) => e.panelBorderOf === 'panel')).toBe(true);
  const target = designCanvasTargets(next, project, new Map(), new Map(), undefined).find(
    (e) => e.id === line.id,
  )!;
  expect(target.hitBounds!.width).toBeLessThan(80);
  expect(designExportBounds(next, [line.id]).width).toBeLessThan(80);
  const hidden = deepFreeze(updateElement(line.id, { hidden: true }).apply(next));
  expect(
    cache(hidden)(hidden.elements.find((e) => e.id === 'paint')!).some(
      (e) => e.panelBorderOf === 'panel',
    ),
  ).toBe(true);
});
