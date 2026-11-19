import type {
  CadAssemblyPmiAsset,
  CadAssemblyPmiItemState,
  CadStepPlan,
} from '@editor-platform/cad-core';
import { describe, expect, it } from 'vitest';
import type { CadAssemblyStepPmi, CadBrepPmi } from './protocol';
import { assemblyPmiLines } from './step-assembly';
import { noPmiWritten } from './step-pmi-write';

const kinds = { face: 4, edge: 6, vertex: 7 };
const identity = {
  translationMm: [0, 0, 0] as [number, number, number],
  rotation: [0, 0, 0, 1] as [number, number, number, number],
};
/** The root places plate twice (components p1, p2) and block once (b). */
const plan: CadStepPlan = {
  root: 'root',
  instances: 3,
  products: [
    {
      key: 'plate',
      name: 'Plate',
      id: 'P',
      shape: { contentHash: 'plate', bodies: [] },
      instances: [],
    },
    {
      key: 'block',
      name: 'Block',
      id: 'B',
      shape: { contentHash: 'block', bodies: [] },
      instances: [],
    },
    {
      key: 'root',
      name: 'Root',
      id: 'R',
      instances: [
        { product: 'plate', name: 'p1', pose: identity },
        { product: 'plate', name: 'p2', pose: identity },
        { product: 'block', name: 'b', pose: identity },
      ],
    },
  ],
};
/** Each import face i at compound index i + 100. */
const tracked = (featureId: string): CadBrepPmi['bodies'][number]['tracking'][number] => ({
  featureId,
  faces: Array.from({ length: 10 }, (_, i) => [i + 1, i + 101]).flat(),
  edges: [],
  vertices: [],
});
const brep = (pmi?: CadBrepPmi['bodies'][number]['pmi']): CadBrepPmi => ({
  bodies: [
    { bodyId: 'body', tracking: [tracked('imported')], placements: [], ...(pmi ? { pmi } : {}) },
  ],
  report: noPmiWritten(),
  writer: true,
});
const face = (component: string, index: number) => ({ shape: 'face' as const, index, component });
/** The block was placed at x + 100 mm, turned 90° about z, when the file was read. */
const turned = {
  translationMm: [100, 0, 0] as [number, number, number],
  rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] as [number, number, number, number],
};
const asset: CadAssemblyPmiAsset = {
  version: 1,
  parts: {
    p1: { contentHash: 'plate', pose: identity, faces: 10, edges: 0, vertices: 0 },
    p2: { contentHash: 'plate', pose: identity, faces: 10, edges: 0, vertices: 0 },
    b: { contentHash: 'block', pose: turned, faces: 10, edges: 0, vertices: 0 },
  },
  items: [
    { id: 'a-1', kind: 'datum', name: 'A', targets: [face('b', 2)] },
    { id: 'a-2', kind: 'datum', name: 'C', targets: [face('b', 3)] },
    {
      id: 'a-3',
      kind: 'geometric-tolerance',
      type: 'Parallelism',
      value: 0.02,
      modifiers: [],
      references: [{ datums: ['a-2'], modifiers: [] }],
      targets: [face('b', 4)],
      // In the assembly's frame: from (100, 10, 0) to (100, 20, 0).
      presentation: { segments: [100, 10, 0, 100, 20, 0] },
    },
    {
      id: 'a-4',
      kind: 'geometric-tolerance',
      type: 'Flatness',
      value: 0.04,
      modifiers: [],
      references: [],
      targets: [face('p2', 5)],
    },
    {
      id: 'a-5',
      kind: 'dimension',
      type: 'Location_LinearDistance',
      values: [5],
      targets: [face('p1', 5)],
      targets2: [face('b', 6)],
    },
    {
      id: 'a-6',
      kind: 'geometric-tolerance',
      type: 'Flatness',
      value: 0.05,
      modifiers: [],
      references: [],
      targets: [face('b', 7)],
    },
  ],
};
const current = (stale: string[] = []) =>
  asset.items.map((i): [string, CadAssemblyPmiItemState] => [
    i.id,
    stale.includes(i.id) ? { current: false, reason: 'part' } : { current: true },
  ]);
const components = { p1: 'plate', p2: 'plate', b: 'block' };

describe("PMI-5c the assembly STEP writer's PMI lines (CAD86, ST-217)", () => {
  it("writes the items of a component placed once on its product, in its part's frame", () => {
    const pmi: CadAssemblyStepPmi = {
      products: { plate: brep(), block: brep() },
      assembly: { asset, states: current(['a-6']), components },
    };
    const { lines, report } = assemblyPmiLines(plan, pmi, kinds);
    expect(lines.get('plate')).toBeUndefined();
    // One spec: the block's own items, its datums numbered from 0.
    expect(lines.get('block')).toHaveLength(1);
    const block = lines.get('block')![0]!;
    expect(block.map((l) => l.split(' ')[0])).toEqual(['dat', 'dat', 'tol']);
    // Datum A on face 2, now face 102 of the block's compound.
    expect(block[0]).toBe('dat 41 1 4 102');
    // The line moved into the block's frame: x - 100 mm, then turned back by -90° about z.
    const tol = block[2]!.split(' prs ')[1]!.split(' ').map(Number);
    expect(tol.slice(0, 2)).toEqual([0, 1]);
    expect(tol.slice(2).map((v) => Math.round(v * 1e9) / 1e9 + 0)).toEqual([10, 0, 0, 20, 0, 0]);
    expect(report.assembly).toEqual({ written: 3, shared: 1, across: 1, stale: 1, unwritable: 0 });
    // The assembly's items are not counted as the bodies'.
    expect(report.written).toEqual({
      dimension: 0,
      'geometric-tolerance': 0,
      datum: 0,
      'datum-target': 0,
    });
    expect(report.presented).toBe(1);
  });

  it('leaves out a datum whose name a part already wrote, and what references it', () => {
    const plateA = {
      featureId: 'imported',
      asset: {
        version: 1 as const,
        items: [
          {
            id: 'pmi-1',
            kind: 'datum' as const,
            name: 'C',
            targets: [{ shape: 'face' as const, index: 1 }],
          },
        ],
      },
      states: [['pmi-1', { current: true }]] as [string, { current: true }][],
    };
    const { lines, report } = assemblyPmiLines(
      plan,
      {
        products: { plate: brep(plateA), block: brep() },
        assembly: { asset, states: current(), components },
      },
      kinds,
    );
    expect(lines.get('plate')).toEqual([['dat 43 1 4 101']]);
    // A is written; C and the parallelism on C are not; the flatness (7) on the block is.
    expect(lines.get('block')![0]!.map((l) => l.split(' ').slice(0, 2).join(' '))).toEqual([
      'dat 41',
      'tol 7',
    ]);
    expect(report.written.datum).toBe(1);
    expect(report.assembly).toEqual({ written: 2, shared: 1, across: 1, stale: 0, unwritable: 2 });
  });

  it("writes a body's PMI and the assembly's on one product as separate specs, each datum numbered in its own", () => {
    const blockD = {
      featureId: 'imported',
      asset: {
        version: 1 as const,
        items: [
          {
            id: 'pmi-1',
            kind: 'datum' as const,
            name: 'D',
            targets: [{ shape: 'face' as const, index: 8 }],
          },
          {
            id: 'pmi-2',
            kind: 'geometric-tolerance' as const,
            type: 'Perpendicularity',
            value: 0.1,
            modifiers: [],
            references: [{ datums: ['pmi-1'], modifiers: [] }],
            targets: [{ shape: 'face' as const, index: 9 }],
          },
        ],
      },
      states: [
        ['pmi-1', { current: true }],
        ['pmi-2', { current: true }],
      ] as [string, { current: true }][],
    };
    const { lines } = assemblyPmiLines(
      plan,
      {
        products: { plate: brep(), block: brep(blockD) },
        assembly: { asset, states: current(), components },
      },
      kinds,
    );
    const [own, assembly] = lines.get('block')!;
    // D is ordinal 0 of the body's spec; the assembly's A and C are 0 and 1 of its own.
    expect(own!.map((l) => l.split(' ')[0])).toEqual(['dat', 'tol']);
    expect(own![1]).toMatch(/ 1 1 0 0$/);
    expect(assembly!.map((l) => l.split(' ')[0])).toEqual(['dat', 'dat', 'tol', 'tol']);
    expect(assembly![2]!.split(' prs ')[0]).toMatch(/ 1 1 1 0$/);
  });

  it("writes no presentation lines when the PMI is on several products (the writer's one frame)", () => {
    const plateFlat = {
      featureId: 'imported',
      asset: {
        version: 1 as const,
        items: [
          {
            id: 'pmi-1',
            kind: 'geometric-tolerance' as const,
            type: 'Flatness',
            value: 0.1,
            modifiers: [],
            references: [],
            targets: [{ shape: 'face' as const, index: 1 }],
            presentation: { segments: [0, 0, 0, 1, 0, 0] },
          },
        ],
      },
      states: [['pmi-1', { current: true }]] as [string, { current: true }][],
      placements: [],
    };
    const { lines, report } = assemblyPmiLines(
      plan,
      {
        products: { plate: brep(plateFlat), block: brep() },
        assembly: { asset, states: current(), components },
      },
      kinds,
    );
    // The plate's flatness and the block's parallelism: neither line is written.
    expect([...lines.values()].flat(2).some((l) => l.includes(' prs '))).toBe(false);
    expect(lines.get('plate')![0]![0]).toMatch(/^tol /);
    expect(report.presented).toBe(0);
    expect(report.presentationOneFrame).toBe(2);
  });

  it('writes none on a version that does not track its import once', () => {
    const untracked: CadBrepPmi = { bodies: [], report: noPmiWritten(), writer: true };
    const { lines, report } = assemblyPmiLines(
      plan,
      {
        products: { plate: brep(), block: untracked },
        assembly: { asset, states: current(), components },
      },
      kinds,
    );
    expect(lines.size).toBe(0);
    expect(report.assembly).toEqual({ written: 0, shared: 1, across: 1, stale: 0, unwritable: 4 });
  });
});
