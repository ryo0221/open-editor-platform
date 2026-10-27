import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  bimDrawingMesh,
  bimStarter,
  f39Roofs,
  type BimDocument,
  type BimOperation,
} from '@editor-platform/bim-core';
import { writeIfc } from '@editor-platform/bim-ifc';
import { EditorSession } from '@editor-platform/editor-core';
import type { GeometryRequest } from '@editor-platform/geometry-core';
import type { OcModule } from '@editor-platform/geometry-kernel-occt';
import { beforeAll, describe, expect, it } from 'vitest';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';
import { BimController } from './controller';
import { draftPart } from './drafting';
import { bimDirectKernel, bimDisplayMesh, BimEvaluator, type BimKernel } from './evaluate';
import { drawBim } from './drawing';
import { bimIfcPartMesh, bimIfcPartMeshFor, exportBimIfc, meshClosed, partStyles } from './ifc';
import { bimKernelLimits } from './port';
import type { BimPartStatus } from './parts';

/** IFC from the app (R2c-6, CAD69): the kernel's part of the file, measured in its own job. */
const H = 'b'.repeat(64);
const file = { artifactId: 'a-building', timeStamp: '2026-10-25T00:00:00.000Z' };

/** A 1,000 mm cube meshed face by face, as the kernel does: each face has its own vertices. */
function faceCube() {
  const corners = [
    [0, 0, 0],
    [1000, 0, 0],
    [1000, 1000, 0],
    [0, 1000, 0],
    [0, 0, 1000],
    [1000, 0, 1000],
    [1000, 1000, 1000],
    [0, 1000, 1000],
  ];
  const faces = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ];
  const positions: number[] = [];
  const indices: number[] = [];
  faces.forEach((f, i) => {
    for (const c of f) positions.push(...corners[c]!);
    indices.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
  });
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/** A building with one placed part of version `H`. */
function withPart(): BimDocument {
  const doc = bimStarter();
  doc.types.push({
    id: 'pt-1',
    kind: 'part',
    name: 'Cube',
    source: { artifactId: 'a-cad', versionId: 'v1', contentHash: H },
    hintBounds: { min: [0, 0, 0], max: [1000, 1000, 1000] },
  });
  doc.elements.push(
    (
      draftPart(doc, 'l-1f', { point: { xy: [2000, 2000] } } as never, 'pt-1') as Extract<
        BimOperation,
        { type: 'insert' }
      >
    ).entities.elements![0]!,
  );
  return doc;
}

/** A kernel that meshes every part as the face-by-face cube and records the requests. */
function cubeKernel(mesh = faceCube()) {
  const requests: GeometryRequest[][] = [];
  const kernel: BimKernel = {
    run: async (_g, r) => {
      requests.push(r);
      return {
        status: 'ok',
        results: r.map((q) => ({
          node: q.node,
          status: 'ok' as const,
          mesh: { ...mesh, normals: new Float32Array(), faceIndices: new Uint32Array() },
          measure: {
            volumeMm3: 1e9,
            areaMm2: 6e6,
            bounds: [
              [0, 0, 0],
              [1000, 1000, 1000],
            ],
          },
        })),
      } as never;
    },
  };
  return { kernel, requests };
}
const available = (kinds: ('solid' | 'sheet')[]): BimPartStatus => ({ status: 'available', kinds });
const partId = (doc: BimDocument) => doc.elements.find((e) => e.kind === 'part')!.id;

describe('bim IFC from the app (R2c-6)', () => {
  it('meshes parts at the fixed export tessellation and writes a solid part as a faceted BRep', async () => {
    const doc = withPart();
    const { kernel, requests } = cubeKernel();
    const r = await exportBimIfc(doc, kernel, { ...file, part: () => available(['solid']) });
    if (r.status !== 'ok') throw new Error(r.code);
    // Only the part asks the kernel (the starter has no clipped element), at the fixed mesh.
    expect(requests.flat()).toEqual([
      expect.objectContaining({ mesh: { deflectionMm: 0.5, angularDeflectionRad: 0.1 } }),
    ]);
    expect(r.file.text).toContain('IFCFACETEDBREP');
    expect(r.file.text).toContain("'EP_PartReference'");
    // The same content gives the same file.
    const again = await exportBimIfc(doc, kernel, { ...file, part: () => available(['solid']) });
    expect(again.status === 'ok' && again.file.text).toBe(r.file.text);
  });

  it('meshes a large part no finer than 1/20,000 of its diagonal, in a job with the export limit', async () => {
    // A 1 m cube keeps 0.5 mm; a 120 × 30 × 40 m shell (diagonal 130 m) is meshed at 6.5 mm.
    expect(bimIfcPartMeshFor({ min: [0, 0, 0], max: [1000, 1000, 1000] }).deflectionMm).toBe(0.5);
    const shell: { min: [number, number, number]; max: [number, number, number] } = {
      min: [0, 0, 0],
      max: [120_000, 30_000, 40_000],
    };
    expect(bimIfcPartMeshFor(shell)).toEqual({ deflectionMm: 6.5, angularDeflectionRad: 0.1 });
    const doc = withPart();
    const type = doc.types.find((t) => t.kind === 'part')!;
    if (type.kind !== 'part') throw new Error('part');
    type.hintBounds = shell;
    const { kernel, requests } = cubeKernel();
    const limits: (number | undefined)[] = [];
    const run = kernel.run;
    kernel.run = (g, r, a, s, o) => (limits.push(o?.timeoutMs), run(g, r, a, s, o));
    const r = await exportBimIfc(doc, kernel, { ...file, part: () => available(['solid']) });
    if (r.status !== 'ok') throw new Error(r.code);
    expect(requests.flat()[0]!.mesh).toEqual({ deflectionMm: 6.5, angularDeflectionRad: 0.1 });
    expect(limits).toEqual([bimKernelLimits.exportTimeoutMs]);
    // The file names the deflection it was meshed at.
    expect(r.file.text).toContain('IFCLENGTHMEASURE(6.5)');
  });

  it('writes a sheet part that bounds a volume as a closed shell, and refuses a mixed part', async () => {
    const doc = withPart();
    const { kernel } = cubeKernel();
    const sheet = await exportBimIfc(doc, kernel, { ...file, part: () => available(['sheet']) });
    if (sheet.status !== 'ok') throw new Error(sheet.code);
    expect(sheet.file.text).toContain("'SurfaceModel'");
    expect(sheet.file.text).toContain('IFCCLOSEDSHELL');
    expect(sheet.file.text).not.toContain('IFCOPENSHELL');
    const mixed = await exportBimIfc(doc, kernel, {
      ...file,
      part: () => available(['solid', 'sheet']),
    });
    expect(mixed).toEqual({ status: 'error', code: 'part-mixed-kinds', ids: [partId(doc)] });
  });

  it('names a part whose shape is not read, with the reason the Host gave', async () => {
    const doc = withPart();
    const { kernel, requests } = cubeKernel();
    const unavailable = await exportBimIfc(doc, kernel, {
      ...file,
      part: () => ({ status: 'unavailable', code: 'part-build-mismatch' }),
    });
    expect(unavailable).toEqual({
      status: 'error',
      code: 'part-build-mismatch',
      ids: [partId(doc)],
    });
    const loading = await exportBimIfc(doc, kernel, {
      ...file,
      part: () => ({ status: 'loading' }),
    });
    expect(loading).toEqual({ status: 'error', code: 'part-unavailable', ids: [partId(doc)] });
    expect(requests).toEqual([]);
  });

  it("gives each triangle its CAD body's look, or none when the faces do not add up (OH-U1)", () => {
    const tile = { color: '#f2efe6', opacity: 1 };
    const glass = { color: '#38bdf8', opacity: 0.4 };
    const status = {
      status: 'available' as const,
      kinds: ['solid' as const, 'sheet' as const],
      looks: [tile, glass],
      faces: [2, 1],
    };
    expect(partStyles([0, 0, 1, 2, 2], status)).toEqual({
      styles: [tile, glass],
      triangleStyles: [0, 0, 0, 1, 1],
    });
    expect(partStyles([0, 3], status)).toEqual({});
    expect(partStyles([0], { status: 'available', kinds: ['solid'] })).toEqual({});
  });

  it('tells a closed mesh from an open one with vertices joined by position', () => {
    const cube = faceCube();
    expect(meshClosed(cube.positions, cube.indices)).toBe(true);
    // Without the top face the cube is open.
    const open = [...cube.indices.slice(0, 6), ...cube.indices.slice(12)];
    expect(meshClosed(cube.positions, open)).toBe(false);
    expect(meshClosed([], [])).toBe(false);
  });

  it('draws and writes with fixed tessellations, never the display mesh', async () => {
    // The screen's mesh (and a later LOD or budget) never reaches a drawing or the IFC file.
    const doc = withPart();
    doc.views = [
      {
        id: 'v-1',
        kind: 'plan',
        name: 'Plan',
        level: 'l-1f',
        cutHeightMm: 1200,
        depthMm: 1200,
        scale: 100,
      },
    ];
    const { kernel, requests } = cubeKernel();
    await drawBim(doc, doc.views[0]!, kernel, {});
    await exportBimIfc(doc, kernel, { ...file, part: () => available(['solid']) });
    const meshes = requests.flat().flatMap((r) => [r.mesh, r.projection].filter(Boolean));
    expect(meshes.length).toBeGreaterThan(0);
    for (const m of meshes) {
      expect(m).not.toMatchObject(bimDisplayMesh);
      expect(
        [bimIfcPartMesh, bimDrawingMesh].some(
          (f) =>
            m!.deflectionMm === f.deflectionMm &&
            m!.angularDeflectionRad === f.angularDeflectionRad,
        ),
      ).toBe(true);
    }
  });

  it('exports from the controller, and a refusal is its notice', async () => {
    const doc = withPart();
    const { kernel } = cubeKernel();
    const c = new BimController({
      session: new EditorSession(doc),
      kernel,
      canEdit: () => false,
    });
    // No Host source: the part is unavailable, named, and nothing is written.
    expect(await c.exportIfc(file)).toBeUndefined();
    expect(c.state.notice).toEqual({ code: 'part-source-unavailable', ids: [partId(doc)] });
  });
});

const dist = process.env.CAD_OCCT_DIST;
describe.skipIf(!dist)('bim IFC with the kernel (R2c-6, CAD69)', { timeout: 120_000 }, () => {
  let kernel: BimKernel;
  beforeAll(async () => {
    globalThis.require ??= createRequire(import.meta.url);
    const { default: factory } = await import(pathToFileURL(`${dist}/${cadKernelBuild.js}`).href);
    const oc: OcModule = await factory({
      wasmBinary: readFileSync(`${dist}/${cadKernelBuild.wasm}`),
    });
    kernel = bimDirectKernel(oc);
  }, 120_000);

  it('measures the walls and columns a roof clips as the evaluation does, without one', async () => {
    for (const form of ['gable', 'hip'] as const) {
      const doc = f39Roofs(form);
      const r = await exportBimIfc(doc, kernel, file);
      if (r.status !== 'ok') throw new Error(r.code);
      const evaluation = await new BimEvaluator(kernel).evaluate(doc);
      if (evaluation.status !== 'ok') throw new Error(evaluation.status);
      expect(evaluation.kernelQuantities.size, form).toBeGreaterThan(0);
      // The file the evaluation's volumes would give, byte for byte.
      const expected = writeIfc(doc, { ...file, kernelQuantities: evaluation.kernelQuantities });
      expect(r.file.text, form).toBe(expected.text);
    }
  });
});
