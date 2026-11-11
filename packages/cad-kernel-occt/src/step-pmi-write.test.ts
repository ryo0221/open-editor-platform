import type { CadPmiAsset, CadPmiItemState } from '@editor-platform/cad-core';
import { describe, expect, it } from 'vitest';
import { noPmiWritten, pmiWriteSpec } from './step-pmi-write';
import { stepReport } from './formats';

const kinds = { face: 4, edge: 6, vertex: 7 };
const asset: CadPmiAsset = {
  version: 1,
  items: [
    { id: 'pmi-1', kind: 'datum', name: 'A', targets: [{ shape: 'face', index: 1 }] },
    { id: 'pmi-2', kind: 'datum', name: 'B', targets: [{ shape: 'face', index: 3 }] },
    {
      id: 'pmi-3',
      kind: 'dimension',
      type: 'Size_Diameter',
      values: [10],
      deviation: { lower: -0.05, upper: 0.05 },
      targets: [{ shape: 'face', index: 7 }],
    },
    {
      id: 'pmi-4',
      kind: 'dimension',
      type: 'Location_LinearDistance',
      values: [5],
      targets: [{ shape: 'face', index: 1 }],
      targets2: [{ shape: 'edge', index: 2 }],
    },
    {
      id: 'pmi-5',
      kind: 'geometric-tolerance',
      type: 'Position',
      value: 0.1,
      zone: 'D',
      modifiers: ['MAXIMUM_MATERIAL_REQUIREMENT'],
      references: [
        { datums: ['pmi-1'], modifiers: [] },
        { datums: ['pmi-2'], modifiers: ['FREE_STATE'] },
      ],
      targets: [{ shape: 'face', index: 7 }],
    },
  ],
};
const all = (a: CadPmiAsset, current = () => true) =>
  new Map<string, CadPmiItemState>(
    a.items.map((i) => [
      i.id,
      current() ? { current: true } : { current: false, reason: 'target' as const },
    ]),
  );
/** Shape indices: the import's index plus 10 (the written shape's map). */
const plus10 = (t: { index: number }) => t.index + 10;

describe('PMI-4b semantic PMI for the STEP writer (CAD85, ST-213)', () => {
  it('writes datums first, then dimensions and tolerances, on the written shape', () => {
    const report = noPmiWritten();
    const lines = pmiWriteSpec(asset, all(asset), kinds, plus10, [], report);
    expect(lines).toEqual([
      'dat 41 1 4 11',
      'dat 42 1 4 13',
      // Size_Diameter is 15; XDE keeps the lower deviation as a magnitude.
      'dim 15 -1 1 10 1 0.05 0.05 1 4 17 0',
      'dim 2 -1 1 5 0 0 0 1 4 11 1 6 12',
      // Position 10, zone D, material M; datum A at 1, B at 2 with FREE_STATE (11).
      'tol 10 0.1 1 1 0 0 1 4 17 2 1 0 0 1 1 1 11',
    ]);
    expect(report.written).toEqual({
      dimension: 2,
      'geometric-tolerance': 1,
      datum: 2,
      'datum-target': 0,
    });
    expect(report.stale + report.unwritable).toBe(0);
  });

  it('leaves out stale items, datum targets and what depends on them, and counts them', () => {
    const withTargets: CadPmiAsset = {
      version: 1,
      items: [
        ...asset.items,
        {
          id: 'pmi-6',
          kind: 'datum-target',
          datum: 'C',
          number: 1,
          type: 'area',
          targets: [{ shape: 'face', index: 2 }],
        },
        { id: 'pmi-7', kind: 'datum', name: 'C', targets: [] },
        {
          id: 'pmi-8',
          kind: 'geometric-tolerance',
          type: 'Flatness',
          value: 0.02,
          modifiers: [],
          references: [{ datums: ['pmi-7'], modifiers: [] }],
          targets: [{ shape: 'face', index: 3 }],
        },
        {
          id: 'pmi-9',
          kind: 'geometric-tolerance',
          type: 'Flatness',
          value: 0.02,
          modifiers: ['#99'],
          references: [],
          targets: [{ shape: 'face', index: 3 }],
        },
      ],
    };
    const states = all(withTargets);
    states.set('pmi-3', { current: false, reason: 'target' });
    const report = noPmiWritten();
    const lines = pmiWriteSpec(withTargets, states, kinds, plus10, [], report);
    expect(lines.map((l) => l.split(' ')[0])).toEqual(['dat', 'dat', 'dim', 'tol']);
    expect(report.stale).toBe(1);
    // The datum target, datum C on it, the tolerance on C and the unknown modifier.
    expect(report.unwritable).toBe(4);
  });

  it('writes a target only where the written shape has it', () => {
    const report = noPmiWritten();
    const lines = pmiWriteSpec(
      asset,
      all(asset),
      kinds,
      (t) => (t.shape === 'edge' ? undefined : t.index),
      [],
      report,
    );
    expect(lines.filter((l) => l.startsWith('dim'))).toHaveLength(1);
    expect(report.unwritable).toBe(1);
  });

  it('places presentation lines where the body is, or counts them as not written', () => {
    const presented: CadPmiAsset = {
      version: 1,
      items: [
        {
          id: 'pmi-1',
          kind: 'datum',
          name: 'A',
          targets: [{ shape: 'face', index: 1 }],
          presentation: {
            segments: [0, 0, 0, 1, 0, 0],
            plane: { origin: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0] },
          },
        },
        {
          id: 'pmi-2',
          kind: 'datum',
          name: 'B',
          targets: [{ shape: 'face', index: 2 }],
          presentation: { segments: [0, 0, 0, 0, 0, 0] },
        },
      ],
    };
    const moved = [
      {
        rotation: [0, 0, 0, 1] as [number, number, number, number],
        translation: [5, 0, 0] as [number, number, number],
      },
    ];
    const report = noPmiWritten();
    const lines = pmiWriteSpec(presented, all(presented), kinds, (t) => t.index, moved, report);
    expect(lines).toEqual(['dat 41 1 4 1 prs 1 5 0 0 0 0 1 1 0 0 1 5 0 0 6 0 0', 'dat 42 1 4 2']);
    expect(report.presented).toBe(1);
    expect(report.presentationLost).toBe(1);
    const unplaced = noPmiWritten();
    pmiWriteSpec(presented, all(presented), kinds, (t) => t.index, undefined, unplaced);
    expect(unplaced.presentationLost).toBe(2);
  });

  it('writes a presentation of 30,000 lines (no argument spreading)', () => {
    const segments = Array.from({ length: 30_000 }, (_, i) => [i, 0, 0, i + 0.5, 0, 0]).flat();
    const large: CadPmiAsset = {
      version: 1,
      items: [
        {
          id: 'pmi-1',
          kind: 'datum',
          name: 'A',
          targets: [{ shape: 'face', index: 1 }],
          presentation: { segments },
        },
      ],
    };
    const report = noPmiWritten();
    const [line] = pmiWriteSpec(large, all(large), kinds, (t) => t.index, [], report);
    expect(line!.split(' ')).toHaveLength(5 + 3 + 180_000);
    expect(report.presented).toBe(1);
  });

  it('leaves out a datum whose name another body already wrote, and what references it', () => {
    const names = new Set<string>();
    const first = noPmiWritten();
    pmiWriteSpec(asset, all(asset), kinds, plus10, [], first, names);
    expect([...names].sort()).toEqual(['A', 'B']);
    const other: CadPmiAsset = {
      version: 1,
      items: [
        { id: 'q-1', kind: 'datum', name: 'A', targets: [{ shape: 'face', index: 2 }] },
        { id: 'q-2', kind: 'datum', name: 'C', targets: [{ shape: 'face', index: 4 }] },
        {
          id: 'q-3',
          kind: 'geometric-tolerance',
          type: 'Perpendicularity',
          value: 0.05,
          modifiers: [],
          references: [{ datums: ['q-1'], modifiers: [] }],
          targets: [{ shape: 'face', index: 5 }],
        },
        {
          id: 'q-4',
          kind: 'geometric-tolerance',
          type: 'Perpendicularity',
          value: 0.05,
          modifiers: [],
          references: [{ datums: ['q-2'], modifiers: [] }],
          targets: [{ shape: 'face', index: 5 }],
        },
      ],
    };
    const second = noPmiWritten();
    const lines = pmiWriteSpec(other, all(other), kinds, (t) => t.index, [], second, names);
    expect(lines.map((l) => l.split(' ')[0])).toEqual(['dat', 'tol']);
    expect(lines[0]).toBe('dat 43 1 4 4');
    expect(second.unwritable).toBe(2);
    expect([...names].sort()).toEqual(['A', 'B', 'C']);
  });

  it('leaves out a second datum of the same name in one asset, and what references it', () => {
    const twice: CadPmiAsset = {
      version: 1,
      items: [
        { id: 'pmi-1', kind: 'datum', name: 'A', targets: [{ shape: 'face', index: 1 }] },
        { id: 'pmi-2', kind: 'datum', name: 'A', targets: [{ shape: 'face', index: 2 }] },
        ...(['pmi-1', 'pmi-2'] as const).map((d, i) => ({
          id: `pmi-${3 + i}`,
          kind: 'geometric-tolerance' as const,
          type: 'Perpendicularity',
          value: 0.05,
          modifiers: [],
          references: [{ datums: [d], modifiers: [] }],
          targets: [{ shape: 'face' as const, index: 5 }],
        })),
      ],
    };
    const report = noPmiWritten();
    const lines = pmiWriteSpec(twice, all(twice), kinds, (t) => t.index, [], report);
    expect(lines).toEqual(['dat 41 1 4 1', 'tol 9 0.05 0 0 0 0 1 4 5 1 1 0 0']);
    expect(report.unwritable).toBe(2);
  });

  it('leaves out dimensions along a path', () => {
    const path: CadPmiAsset = {
      version: 1,
      items: (['Location_WithPath', 'Size_WithPath'] as const).map((type, i) => ({
        id: `p-${i}`,
        kind: 'dimension' as const,
        type,
        values: [12],
        targets: [{ shape: 'edge' as const, index: 1 }],
      })),
    };
    const report = noPmiWritten();
    expect(pmiWriteSpec(path, all(path), kinds, (t) => t.index, [], report)).toEqual([]);
    expect(report.unwritable).toBe(2);
  });

  it('counts saved views as not written even when no item is written', () => {
    const viewed: CadPmiAsset = {
      version: 1,
      items: [{ id: 'pmi-1', kind: 'datum', name: 'A', targets: [{ shape: 'face', index: 1 }] }],
      views: [
        {
          id: 'view-1',
          name: 'Front',
          camera: { eye: [0, 0, 10], direction: [0, 0, -1], up: [0, 1, 0], width: 1, height: 1 },
        },
      ],
    };
    const report = noPmiWritten();
    expect(
      pmiWriteSpec(
        viewed,
        all(viewed, () => false),
        kinds,
        plus10,
        [],
        report,
      ),
    ).toEqual([]);
    expect(report.stale).toBe(1);
    expect(report.views).toBe(1);
  });

  it('reports what the file carries and what it does not', () => {
    const bytes = new TextEncoder().encode('ISO-10303-21;\nHEADER;\nENDSEC;\n');
    const meta = { sourceContentHash: 'sha256:x', buildHash: 'sha256:y' };
    const report = noPmiWritten();
    pmiWriteSpec(asset, all(asset), kinds, plus10, [], report);
    report.stale = 2;
    report.views = 1;
    const losses = stepReport(bytes, 1, meta, report).losses;
    expect(losses[0]).toContain('(AP242)');
    expect(losses[0]).not.toContain('PMI');
    expect(losses[1]).toContain('2 dimensions, 1 geometric tolerance, 2 datums');
    expect(losses[2]).toMatch(/^2 PMI items are not written: stale/);
    expect(losses[3]).toMatch(/^1 saved view of the PMI is not written/);
    // Without PMI the report is as before.
    expect(stepReport(bytes, 1, meta).losses[0]).toContain('PMI (dimensions');
  });
});
