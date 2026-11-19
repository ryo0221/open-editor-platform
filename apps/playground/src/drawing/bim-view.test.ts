import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { bimDirectKernel, drawBim, type BimKernel } from '@editor-platform/bim';
import { f31BoxBuilding, type BimDocument, type BimView } from '@editor-platform/bim-core';
import { drawingBimViewGraphics, type DrawingBimView } from '@editor-platform/drawing-core';
import type { OcModule } from '@editor-platform/geometry-kernel-occt';
import { cadKernelBuild } from '../../../../scripts/cad-kernel/build.mjs';

// DW5a (docs/cad/drawing-editor.md, 施工図): the building editor's own plan of a kept version, cut
// by the kernel, on a drawing sheet. Against the development build (`CAD_OCCT_DIST`). TS-2432.

const dist = process.env.CAD_OCCT_DIST;
const plan: BimView = {
  id: 'v-1f',
  kind: 'plan',
  name: '1F plan',
  level: 'l-1f',
  cutHeightMm: 1200,
  depthMm: 1200,
  scale: 100,
};
function building(): BimDocument {
  const doc = f31BoxBuilding();
  doc.grids = [
    { id: 'g-a', label: 'A', start: [0, -1000], end: [0, 9000] },
    { id: 'g-b', label: 'B', start: [10000, -1000], end: [10000, 9000] },
  ];
  doc.views = [plan];
  return doc;
}
const view: DrawingBimView = {
  id: 'view-1',
  sheetId: 'sheet-1',
  sourceId: 'src-1',
  kind: 'bim-view',
  name: '1F plan',
  at: [200, 150],
  scale: '1:100',
  label: true,
  bimViewId: 'v-1f',
};

describe.skipIf(!dist)('a building plan on a sheet (DW5a)', { timeout: 120_000 }, () => {
  let kernel: BimKernel;
  beforeAll(async () => {
    globalThis.require ??= createRequire(import.meta.url);
    const { default: factory } = await import(pathToFileURL(`${dist}/${cadKernelBuild.js}`).href);
    const oc: OcModule = await factory({
      wasmBinary: readFileSync(`${dist}/${cadKernelBuild.wasm}`),
    });
    kernel = bimDirectKernel(oc);
  }, 120_000);

  it('draws the cut walls filled and outlined thick, the grids as chain lines, at 1:100 and 1:50', async () => {
    const r = await drawBim(building(), plan, kernel);
    if (r.status !== 'ok') throw new Error(r.code);
    const g = drawingBimViewGraphics(view, r.drawing);
    const areas = g.items.filter((i) => i.type === 'area');
    // The four walls, each one filled cut.
    expect(areas).toHaveLength(4);
    expect(g.items.filter((i) => i.type === 'line' && i.cls === 'center')).toHaveLength(2);
    expect(g.items.some((i) => i.type === 'text' && i.text === 'A')).toBe(true);
    // The 10.2 m outside of the walls is 102 mm on paper.
    const xs = areas.flatMap((a) => (a.type === 'area' ? a.loops.flat().map((p) => p[0]) : []));
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(102, 1);
    const big = await drawBim(building(), { ...plan, scale: 50 }, kernel);
    if (big.status !== 'ok') throw new Error(big.code);
    const g50 = drawingBimViewGraphics({ ...view, scale: '1:50' }, big.drawing);
    const xs50 = g50.items.flatMap((a) =>
      a.type === 'area' ? a.loops.flat().map((p) => p[0]) : [],
    );
    expect(Math.max(...xs50) - Math.min(...xs50)).toBeCloseTo(204, 1);
    expect(r.drawing.failed).toEqual([]);
  });
});
