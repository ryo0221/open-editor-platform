import { describe, expect, it } from 'vitest';
import { cadPmiLimits, type CadPmiAsset } from '@editor-platform/cad-core';
import type { OcModule } from '@editor-platform/geometry-kernel-occt';
import { keepPmi, type PmiProduct } from './step-pmi-keep';
import { pmiAssetFiles, Rejected } from './step-import';
import { pmiDimensionTypes, pmiToleranceTypes, type PmiItemJson } from './step-pmi';

/** A stand-in for the OCCT maps: a shape lists its faces, a sub-shape is its name. */
const FACE = 4;
const fakeOc = {
  TopAbs_ShapeEnum: {
    TopAbs_FACE: { value: FACE },
    TopAbs_EDGE: { value: 6 },
    TopAbs_VERTEX: { value: 7 },
  },
  TopTools_IndexedMapOfShape_1: class {
    keys: string[] = [];
    FindKey(i: number) {
      return this.keys[i - 1];
    }
    FindIndex(s: string) {
      return this.keys.indexOf(s) + 1;
    }
    Extent() {
      return this.keys.length;
    }
  },
  TopExp: {
    MapShapes_1: (shape: { faces: string[] }, kind: { value: number }, map: { keys: string[] }) => {
      if (kind.value === FACE) map.keys.push(...shape.faces);
    },
  },
} as unknown as OcModule;

const face = (product: string, index: number) => ({ label: 'l', shape: FACE, product, index });
const distance = (from: number, to: number): PmiItemJson =>
  ({
    label: 'd',
    type: pmiDimensionTypes.indexOf('Location_LinearDistance'),
    values: [5],
    targets: [face('p', from)],
    targets2: [face('p', to)],
  }) as PmiItemJson;
const keep = (
  bodies: PmiProduct['bodies'],
  dimensions: PmiItemJson[],
  tolerances: PmiItemJson[] = [],
  datums: PmiItemJson[] = [],
) =>
  keepPmi(
    fakeOc,
    (x) => x,
    { dimensions, tolerances, datums, datumTargets: [], entityOf: new Map() },
    new Map([['p', { shape: { faces: ['a', 'b', 'c'] }, bodies }]]),
    new Map(datums.map((d) => [d.label, d])),
  );

describe('keeping verified PMI on the bodies of a product (PMI-2)', () => {
  it('keeps an item on the body that holds all its targets, whichever comes first', () => {
    // Bodies split from one product share face a; b is only on body 1.
    const shared = { index: 0, shape: { faces: ['a', 'c'] } };
    const other = { index: 1, shape: { faces: ['b', 'a'] } };
    for (const bodies of [
      [shared, other],
      [other, shared],
    ]) {
      const kept = keep(bodies, [distance(1, 2)]);
      expect(kept.kept.dimension).toBe(1);
      expect([...kept.assets.keys()]).toEqual([1]);
      expect(kept.assets.get(1)!.items[0]).toMatchObject({
        targets: [{ shape: 'face', index: 2 }],
        targets2: [{ shape: 'face', index: 1 }],
      });
    }
    // On no single body: not kept.
    expect(keep([shared, other], [distance(2, 3)]).kept.dimension).toBe(0);
  });

  it('keeps a tolerance with its datums on the body that holds them all', () => {
    const shared = { index: 0, shape: { faces: ['a', 'c'] } };
    const other = { index: 1, shape: { faces: ['b', 'a'] } };
    // Datum A on the shared face a; a parallelism on face b, only on body 1, to A.
    const datum = { label: 'dA', name: 'A', targets: [face('p', 1)] } as PmiItemJson;
    const parallel = {
      label: 't',
      type: pmiToleranceTypes.indexOf('Parallelism'),
      value: 0.05,
      datums: ['dA'],
      targets: [face('p', 2)],
    } as PmiItemJson;
    for (const bodies of [
      [shared, other],
      [other, shared],
    ]) {
      const kept = keep(bodies, [], [parallel], [datum]);
      // The datum counts once, although body 1 holds its own copy for the tolerance.
      expect(kept.kept).toMatchObject({ datum: 1, 'geometric-tolerance': 1 });
      const items = kept.assets.get(1)!.items;
      const tolerance = items.find((i) => i.kind === 'geometric-tolerance')!;
      const datumOn1 = items.find((i) => i.kind === 'datum')!;
      expect(datumOn1).toMatchObject({ name: 'A', targets: [{ shape: 'face', index: 2 }] });
      expect(tolerance).toMatchObject({
        type: 'Parallelism',
        targets: [{ shape: 'face', index: 1 }],
        references: [{ datums: [datumOn1.id] }],
      });
    }
  });
});

describe('pmi asset files (PMI-2)', () => {
  const asset = (targets: number): CadPmiAsset => ({
    version: 1,
    items: [
      {
        id: 'pmi-1',
        kind: 'datum',
        name: 'A',
        targets: Array.from({ length: targets }, () => ({ shape: 'face' as const, index: 1 })),
      },
    ],
  });
  it('refuses an asset its evaluation would refuse, as too large', () => {
    expect(pmiAssetFiles(new Map([[0, asset(cadPmiLimits.targets)]])).size).toBe(1);
    let refused: unknown;
    try {
      pmiAssetFiles(new Map([[0, asset(cadPmiLimits.targets + 1)]]));
    } catch (e) {
      refused = e;
    }
    expect(refused).toBeInstanceOf(Rejected);
    expect(refused).toMatchObject({ code: 'step-too-large', detail: 'pmi' });
  });
});
