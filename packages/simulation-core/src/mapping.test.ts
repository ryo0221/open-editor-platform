import type { CadTopologyTable } from '@editor-platform/cad-core';
import { describe, expect, it } from 'vitest';
import {
  applySimulationOperation,
  buildMapping,
  checkLoadApplication,
  freshSimulationId,
  mappingReady,
  simulationFixture,
  SimulationValidationError,
  validateSimulation,
  type MeshPresence,
  type PreparationHistory,
  type SimulationDocument,
  type SimulationOverride,
} from './index';

const face = (name: string, x: number) => ({
  name: ['plate-extrude', name],
  centroid: [x, 25, 2.5] as [number, number, number],
  area: 250,
});
const table = (names = ['side:0', 'side:2', 'top']): CadTopologyTable => ({
  faces: names.map((n, i) => face(n, i * 40)),
  edges: [],
  vertices: [],
});
const identity = (n = 3): PreparationHistory => ({
  faces: Array.from({ length: n }, (_, i) => ({ deleted: false, images: [i] })),
  edges: [],
  analysisFaces: n,
  analysisEdges: 0,
});
const everything: MeshPresence = { faces: () => true, edges: () => true };
const context = { versionId: 'v1', preparationHash: 'prep-a', kernelBuild: 'kernel-1' };
const rowsOf = (doc: SimulationDocument, t = table(), h = identity(), mesh = everything) =>
  buildMapping(doc, t, h, mesh, context).map((r) => ({
    owner: r.owner,
    status: r.status,
    stage: r.stage,
    reason: r.reason,
    analysis: r.analysis,
    overridden: r.overridden,
  }));

describe('load and constraint mapping (R3c-1, FE30)', () => {
  const { doc } = simulationFixture();

  it('resolves through untouched preparation and the mesh', () => {
    const rows = rowsOf(doc);
    expect(rows).toEqual([
      {
        owner: 'tip-load',
        status: 'resolved',
        stage: 'mesh',
        reason: undefined,
        analysis: [1],
        overridden: undefined,
      },
      {
        owner: 'fix-left',
        status: 'resolved',
        stage: 'mesh',
        reason: undefined,
        analysis: [0],
        overridden: undefined,
      },
    ]);
    expect(mappingReady(buildMapping(doc, table(), identity(), everything, context))).toBe(true);
  });

  it('stops at the CAD stage when F1 does not resolve, never picking the nearest face', () => {
    expect(rowsOf(doc, table(['side:0', 'top']))[0]).toMatchObject({
      status: 'missing',
      stage: 'cad',
      reason: 'cad-missing',
    });
    const twin = rowsOf(doc, table(['side:0', 'side:2', 'side:2']), identity(3));
    expect(twin[0]).toMatchObject({ status: 'ambiguous', stage: 'cad', reason: 'cad-ambiguous' });
  });

  it('classifies removed, split and merged faces by the preparation history', () => {
    const removed = identity();
    removed.faces[1] = { deleted: true, images: [] };
    expect(rowsOf(doc, table(), removed)[0]).toMatchObject({
      status: 'missing',
      stage: 'preparation',
      reason: 'removed-by-preparation',
    });
    const split = { ...identity(), analysisFaces: 4 };
    split.faces[1] = { deleted: false, images: [3, 1] };
    expect(rowsOf(doc, table(), split)[0]).toMatchObject({
      status: 'ambiguous',
      reason: 'split-by-preparation',
      analysis: [1, 3],
    });
    const merged = identity();
    merged.faces[2] = { deleted: false, images: [0] };
    const rows = rowsOf(doc, table(), merged);
    expect(rows[1]).toMatchObject({
      owner: 'fix-left',
      status: 'ambiguous',
      reason: 'merged-by-preparation',
      analysis: [0],
    });
    expect(mappingReady(buildMapping(doc, table(), merged, everything, context))).toBe(false);
  });

  it('reports a target the mesh lost as missing', () => {
    const rows = rowsOf(doc, table(), identity(), { faces: (t) => t !== 1, edges: () => true });
    expect(rows[0]).toMatchObject({ status: 'missing', stage: 'mesh', reason: 'not-meshed' });
  });

  it('applies a re-selection only for the same version, preparation and build, among the candidates', () => {
    const split = { ...identity(), analysisFaces: 4 };
    split.faces[1] = { deleted: false, images: [1, 3] };
    const load = doc.loads[0]!;
    if (load.kind !== 'force') throw new Error('fixture');
    const override: SimulationOverride = {
      owner: 'tip-load',
      target: load.targets[0]!,
      ...context,
      chosen: [3],
    };
    const chosen = applySimulationOperation(doc, { type: 'setOverride', override });
    expect(rowsOf(chosen, table(), split)[0]).toMatchObject({
      status: 'resolved',
      analysis: [3],
      overridden: true,
    });
    // Another version, preparation or kernel build: ambiguous again.
    for (const k of ['versionId', 'preparationHash', 'kernelBuild'] as const)
      expect(
        buildMapping(chosen, table(), split, everything, { ...context, [k]: 'other' })[0],
      ).toMatchObject({ status: 'ambiguous' });
    // A choice outside the candidates does not decide it.
    const outside = applySimulationOperation(doc, {
      type: 'setOverride',
      override: { ...override, chosen: [2] },
    });
    expect(rowsOf(outside, table(), split)[0]).toMatchObject({ status: 'ambiguous' });
    // Replacing keeps one per key; clearing removes it; removing the load drops it too.
    const twice = applySimulationOperation(chosen, {
      type: 'setOverride',
      override: { ...override, chosen: [1, 3] },
    });
    expect(twice.overrides).toHaveLength(1);
    expect(
      applySimulationOperation(twice, {
        type: 'clearOverrides',
        owner: 'tip-load',
        target: load.targets[0]!,
      }).overrides,
    ).toBeUndefined();
    expect(
      applySimulationOperation(twice, { type: 'removeLoad', id: 'tip-load' }).overrides,
    ).toBeUndefined();
  });

  it('maps bond targets under their bond and applies a re-selection saved for it (R3j-4a)', () => {
    const split = { ...identity(), analysisFaces: 4 };
    split.faces[1] = { deleted: false, images: [1, 3] };
    const load = doc.loads[0]!;
    if (load.kind !== 'force') throw new Error('fixture');
    const target = load.targets[0]!;
    const bonded = applySimulationOperation(doc, {
      type: 'addBond',
      bond: { id: 'bond-a', name: 'A', follower: [target], on: [target], tolerance: 0.1 },
    });
    const bondRows = () => rowsOf(bonded, table(), split).filter((r) => r.owner === 'bond-a');
    expect(bondRows()).toHaveLength(2);
    const chosen = applySimulationOperation(bonded, {
      type: 'setOverride',
      override: { owner: 'bond-a', target, ...context, chosen: [3] },
    });
    expect(rowsOf(chosen, table(), split).filter((r) => r.owner === 'bond-a')).toMatchObject([
      { status: 'resolved', analysis: [3], overridden: true },
      { status: 'resolved', analysis: [3], overridden: true },
    ]);
  });

  it('maps mass targets under their mass and keeps a re-selection saved for it (CR5a, Codex on #975)', () => {
    const split = { ...identity(), analysisFaces: 4 };
    split.faces[1] = { deleted: false, images: [1, 3] };
    const load = doc.loads[0]!;
    if (load.kind !== 'force') throw new Error('fixture');
    const target = load.targets[0]!;
    const massed = applySimulationOperation(doc, {
      type: 'addMass',
      mass: { id: 'engine', name: 'Engine', targets: [target], mass: 0.1 },
    });
    const chosen = applySimulationOperation(massed, {
      type: 'setOverride',
      override: { owner: 'engine', target, ...context, chosen: [3] },
    });
    const massRows = (d: typeof doc) =>
      rowsOf(d, table(), split).filter((r) => r.owner === 'engine');
    expect(massRows(chosen)).toMatchObject([
      { status: 'resolved', analysis: [3], overridden: true },
    ]);
    // A later edit keeps it; removing the mass drops it.
    const renamed = applySimulationOperation(chosen, {
      type: 'updateMass',
      mass: { id: 'engine', name: 'Engine 2', targets: [target], mass: 0.2 },
    });
    expect(renamed.overrides).toHaveLength(1);
    expect(
      applySimulationOperation(renamed, { type: 'removeMass', id: 'engine' }).overrides,
    ).toBeUndefined();
  });

  it('refuses re-selections of targets the owner does not hold, or with bad choices', () => {
    const load = doc.loads[0]!;
    if (load.kind !== 'force') throw new Error('fixture');
    const bad = (o: Partial<SimulationOverride>) => {
      try {
        applySimulationOperation(doc, {
          type: 'setOverride',
          override: { owner: 'tip-load', target: load.targets[0]!, ...context, chosen: [1], ...o },
        });
      } catch (e) {
        return (e as SimulationValidationError).diagnostics.map((d) => d.code);
      }
      return [];
    };
    expect(bad({ owner: 'fix-left' })).toContain('override-target');
    expect(bad({ chosen: [] })).toContain('override');
    expect(bad({ chosen: [1, 1] })).toContain('override');
    expect(bad({ chosen: [-1] })).toContain('override');
    expect(validateSimulation({ ...doc, overrides: [null] }).map((d) => d.code)).toContain(
      'override',
    );
  });

  it('only checks a removal instruction against the CAD body, never against the preparation', () => {
    const load = doc.loads[0]!;
    if (load.kind !== 'force') throw new Error('fixture');
    const top = structuredClone(load.targets[0]!);
    top.ref.name = [['plate-extrude', 'top']];
    const removing = structuredClone(doc);
    removing.preparation.removeFaces = [top];
    expect(validateSimulation(removing)).toEqual([]);
    const h = identity();
    h.faces[2] = { deleted: true, images: [] };
    const rows = buildMapping(removing, table(), h, everything, context);
    expect(rows.find((r) => r.owner === 'preparation')).toMatchObject({
      status: 'resolved',
      stage: 'cad',
      cad: 2,
      analysis: [],
    });
    expect(mappingReady(rows)).toBe(true);
    // A removal of a face the body lacks still stops the run.
    expect(
      mappingReady(buildMapping(removing, table(['side:0', 'side:2']), h, everything, context)),
    ).toBe(false);
  });

  it('keeps setting owners out of the element IDs, and bounds choices by target kind', () => {
    const load = doc.loads[0]!;
    if (load.kind !== 'force') throw new Error('fixture');
    for (const id of ['mesh', 'preparation'])
      expect(validateSimulation({ ...doc, loads: [{ ...load, id }] }).map((d) => d.code)).toContain(
        'reserved-id',
      );
    expect(freshSimulationId(doc, 'mesh')).toBe('mesh-2');
    const edge = {
      kind: 'edge' as const,
      ref: {
        ...load.targets[0]!.ref,
        kind: 'edge' as const,
        name: [
          ['plate-extrude', 'side:0'],
          ['plate-extrude', 'top'],
        ],
      },
    };
    const withEdge: SimulationDocument = { ...doc, loads: [{ ...load, targets: [edge] }] };
    expect(validateSimulation(withEdge)).toEqual([]);
    const choose = (
      target: typeof edge | (typeof load.targets)[0],
      chosen: number[],
      d = withEdge,
    ) =>
      validateSimulation({
        ...d,
        overrides: [{ owner: 'tip-load', target, ...context, chosen }],
      }).map((x) => x.code);
    expect(choose(edge, [70_000])).toEqual([]);
    expect(choose(edge, [262_144])).toContain('override');
    expect(choose(load.targets[0]!, [70_000], doc)).toContain('override');
  });

  it('checks what each load put on the mesh against the request', () => {
    const checks = checkLoadApplication({
      loads: [
        {
          owner: 'tip-load',
          kind: 'force',
          requested: [0, 0, -500],
          applied: [0, 0, -500],
          gross: 500,
          meshMeasure: 250.4,
          shapeMeasure: 250,
          measure: 'area',
        },
        {
          owner: 'edge',
          kind: 'force',
          requested: [10, 0, 0],
          applied: [9.9, 0, 0],
          gross: 10,
          meshMeasure: 40,
          shapeMeasure: 40,
          measure: 'length',
        },
        {
          owner: 'pressure',
          kind: 'pressure',
          requested: [0, 0, -1],
          applied: [0, 0, -1],
          gross: 250,
          meshMeasure: 200,
          shapeMeasure: 250,
          measure: 'area',
        },
        // FX3's quarter cylinder: ∫ p n dA = (100 000, 100 000, 0), not p × area (157 080).
        {
          owner: 'cylinder',
          kind: 'pressure',
          requested: [100_000, 100_000, 0],
          applied: [100_200, 99_900, 0],
          gross: 157_080,
          meshMeasure: 1570.9,
          shapeMeasure: 1570.8,
          measure: 'area',
        },
        // Opposed faces: a net-zero resultant applied correctly passes.
        {
          owner: 'opposed',
          kind: 'pressure',
          requested: [0, 0, 0],
          applied: [1e-9, 0, 0],
          gross: 500,
          meshMeasure: 500,
          shapeMeasure: 500,
          measure: 'area',
        },
        // A small component is checked on its own: one omitted next to a large one fails.
        {
          owner: 'small',
          kind: 'force',
          requested: [1e9, 0.1, 0],
          applied: [1e9, 0, 0],
          gross: 1e9,
          meshMeasure: 10,
          shapeMeasure: 10,
          measure: 'area',
        },
        // Matching areas do not certify a pressure that put no force (or reversed it).
        {
          owner: 'lost',
          kind: 'pressure',
          requested: [100_000, 100_000, 0],
          applied: [0, 0, 0],
          gross: 157_080,
          meshMeasure: 1570.8,
          shapeMeasure: 1570.8,
          measure: 'area',
        },
      ],
      constraints: [
        { owner: 'fix-left', nodes: 21 },
        { owner: 'empty', nodes: 0 },
      ],
    });
    expect(checks.map((c) => `${c.owner}:${c.quantity}:${c.ok}`)).toEqual([
      'tip-load:force:true',
      'tip-load:area:true',
      'edge:force:false',
      'edge:length:true',
      'pressure:force:true',
      'pressure:area:false',
      'cylinder:force:true',
      'cylinder:area:true',
      'opposed:force:true',
      'opposed:area:true',
      'small:force:false',
      'small:area:true',
      'lost:force:false',
      'lost:area:true',
      'fix-left:nodes:true',
      'empty:nodes:false',
    ]);
  });

  it('maps through a midsurface: both wall faces onto one face, a side onto edges (TS-1394, ST-205#2)', () => {
    // Faces 0 (side:0) and 1 (side:2) are sides of the wall, 2 (top) a wall face on the far side.
    const midsurface: PreparationHistory = {
      faces: [
        { deleted: true, images: [], edges: [3] },
        { deleted: true, images: [], edges: [1, 2] },
        { deleted: false, images: [0], reversed: true },
      ],
      edges: [],
      analysisFaces: 1,
      analysisEdges: 4,
      midsurface: true,
    };
    const d = structuredClone(doc);
    const tip = d.loads[0]! as { targets: { kind: 'face'; ref: { name: unknown } }[] };
    d.loads.push({
      id: 'press',
      name: 'Press',
      kind: 'pressure',
      targets: [
        {
          ...tip.targets[0]!,
          ref: { ...tip.targets[0]!.ref, name: [['plate-extrude', 'top']] },
        } as never,
      ],
      pressure: 0.1,
    });
    const rows = buildMapping(d, table(), midsurface, everything, context);
    const of = (owner: string) => rows.find((r) => r.owner === owner)!;
    expect(of('tip-load')).toMatchObject({ status: 'resolved', as: 'edge', analysis: [1, 2] });
    expect(of('fix-left')).toMatchObject({ status: 'resolved', as: 'edge', analysis: [3] });
    expect(of('press')).toMatchObject({ status: 'resolved', reversed: true, analysis: [0] });
    expect(of('press').as).toBeUndefined();
    expect(mappingReady(rows)).toBe(true);
    // An edge not meshed is missing; a face with no image is off the midsurface.
    expect(
      buildMapping(
        d,
        table(),
        midsurface,
        { faces: () => true, edges: (e) => e !== 3 },
        context,
      ).find((r) => r.owner === 'fix-left'),
    ).toMatchObject({ status: 'missing', reason: 'not-meshed' });
    const off = {
      ...midsurface,
      faces: [{ deleted: true, images: [] }, ...midsurface.faces.slice(1)],
    };
    expect(
      buildMapping(d, table(), off, everything, context).find((r) => r.owner === 'fix-left'),
    ).toMatchObject({ status: 'missing', reason: 'off-midsurface' });
  });
});
