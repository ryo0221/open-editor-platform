import { describe, expect, it } from 'vitest';
import {
  applyPcbOperation,
  generateFootprint,
  pcbCopperGroups,
  pcbImportNetList,
  pcbRatsnest,
  pcbStarter,
  validatePcb,
  type PcbComponent,
  type PcbDocument,
  type PcbTrack,
  type PcbVia,
} from './index';

const codes = (v: unknown) => validatePcb(v).map((d) => d.code);
const part = (id: string, ref: string, at: [number, number], side: 'top' | 'bottom' = 'top') =>
  ({
    id,
    ref,
    value: '',
    footprint: 'r',
    at,
    rotationDeg: 0,
    side,
    locked: false,
  }) satisfies PcbComponent;
const track = (
  id: string,
  from: [number, number],
  to: [number, number],
  layer = 'F.Cu',
  net = 'n1',
): PcbTrack => ({ id, net, layer, widthMm: 0.25, from, to });
const via = (id: string, at: [number, number], net = 'n1'): PcbVia => ({
  id,
  net,
  at,
  diameterMm: 0.6,
  drillMm: 0.3,
});
/** R1 and R2 on top, R3 on the bottom; their pads 2, 1 and 1 form net n1. */
function board(tracks: PcbTrack[] = [], vias: PcbVia[] = []): PcbDocument {
  return {
    ...pcbStarter(),
    footprints: [generateFootprint('r', 'chip')],
    components: [
      part('r1', 'R1', [10, 10]),
      part('r2', 'R2', [30, 10]),
      part('r3', 'R3', [30, 30], 'bottom'),
    ],
    nets: [
      {
        id: 'n1',
        name: 'SIG',
        class: 'nc-default',
        pins: [
          ['r1', '2'],
          ['r2', '1'],
          ['r3', '1'],
        ],
      },
    ],
    tracks,
    vias,
  };
}

describe('PB4a tracks, vias and connectivity (ST-463, TS-1928)', () => {
  it('accepts tracks and vias of a net and refuses broken ones by code', () => {
    expect(
      validatePcb(board([track('t1', [10.8, 10], [29.2, 10])], [via('v1', [20, 20])])),
    ).toEqual([]);
    expect(codes(board([track('t1', [10, 10], [20, 10], 'In1.Cu')]))).toEqual(['layer']);
    expect(codes(board([track('t1', [10, 10], [10, 10])]))).toEqual(['track-zero-length']);
    expect(codes(board([track('t1', [10, 10], [20, 10], 'F.Cu', 'nope')]))).toEqual([
      'reference-missing',
    ]);
    expect(codes(board([{ ...track('t1', [10, 10], [20, 10]), widthMm: 0.01 }]))).toEqual([
      'dimension',
    ]);
    expect(codes(board([], [{ ...via('v1', [20, 20]), drillMm: 0.6 }]))).toEqual(['via-drill']);
    // Inner layers exist on a four-layer board only.
    const four = { ...board([track('t1', [10, 10], [20, 10], 'In1.Cu')]) };
    four.board = { ...four.board, copperLayers: 4 };
    expect(validatePcb(four)).toEqual([]);
  });

  it('joins pads by tracks on their layer and across layers by vias', () => {
    // Unrouted: two lines.
    expect(pcbRatsnest(board())).toHaveLength(2);
    // R1.2 → R2.1 on top: one line left (to R3 on the bottom).
    const top = board([track('t1', [10.8, 10], [29.2, 10])]);
    expect(pcbRatsnest(top).map((l) => [l.a.ref, l.b.ref].sort())).toEqual([['R2', 'R3']]);
    // A top track to a via and a bottom track to R3 joins everything.
    const all = board(
      [
        track('t1', [10.8, 10], [29.2, 10]),
        track('t2', [29.2, 10], [29.2, 20]),
        track('t3', [29.2, 20], [30.8, 30], 'B.Cu'),
      ],
      [via('v1', [29.2, 20])],
    );
    expect(pcbRatsnest(all)).toEqual([]);
    const groups = pcbCopperGroups(all);
    expect(new Set(['r1\u00002', 'r3\u00001', 't3', 'v1'].map((k) => groups.get(k))).size).toBe(1);
    // A bottom track does not touch a top pad.
    const wrongSide = board([track('t1', [10.8, 10], [29.2, 10], 'B.Cu')]);
    expect(pcbRatsnest(wrongSide)).toHaveLength(2);
  });

  it('joins overlapping pads, keeps IDs apart on import and checks class drills', () => {
    // R2 moved so its pad 1 overlaps R1's pad 2 (pads 0.9 wide, 1.6 apart): R1.2 and R2.1 are
    // one copper; a track from R2.1 to R3 is not needed for that pair.
    const touching = {
      ...board(),
      components: board().components.map((c) =>
        c.id === 'r2' ? { ...c, at: [11.8, 10] as [number, number] } : c,
      ),
    };
    expect(pcbRatsnest(touching).map((l) => [l.a.ref, l.b.ref].sort())).toEqual([['R2', 'R3']]);
    // Two Ø2 mm round pads 0.002 mm apart are not joined (their enclosing polygons overlap);
    // 0.01 mm into each other, they are.
    const round = {
      ...generateFootprint('o', 'chip'),
      pads: [
        {
          number: '1',
          type: 'smd' as const,
          shape: 'circle' as const,
          at: [0, 0] as [number, number],
          size: [2, 2] as [number, number],
          rotationDeg: 0,
        },
      ],
    };
    const pair = (at: [number, number]): PcbDocument => ({
      ...board(),
      footprints: [round],
      components: [
        { ...part('a', 'A', [20, 20]), footprint: 'o' },
        { ...part('b', 'B', at), footprint: 'o' },
      ],
      nets: [
        {
          id: 'n1',
          name: 'SIG',
          class: 'nc-default',
          pins: [
            ['a', '1'],
            ['b', '1'],
          ],
        },
      ],
    });
    expect(codes(pair([21.992359823, 20.196230315]))).toEqual([]);
    expect(pcbRatsnest(pair([21.992359823, 20.196230315]))).toHaveLength(1);
    expect(pcbRatsnest(pair([21.99, 20]))).toHaveLength(0);
    // Ø0.5 mm pads 0.494 mm apart at 11.25° overlap by 0.006 mm: joined, on the true circles.
    const small = { ...round, pads: [{ ...round.pads[0], size: [0.5, 0.5] as [number, number] }] };
    const a = (11.25 * Math.PI) / 180;
    const near = (d: number): PcbDocument => ({
      ...pair([20 + d * Math.cos(a), 20 + d * Math.sin(a)]),
      footprints: [small],
    });
    expect(codes(near(0.494))).toEqual([]);
    expect(pcbRatsnest(near(0.494))).toHaveLength(0);
    expect(pcbRatsnest(near(0.502))).toHaveLength(1);
    // A track ending 0.003 mm short of a Ø2 mm pad's arc is not joined; 0.003 mm into it is.
    const reach = (x: number) => ({
      ...pair([40, 40]),
      tracks: [{ ...track('t', [x, 20], [26, 20]), widthMm: 0.2 }],
      nets: [
        {
          id: 'n1',
          name: 'SIG',
          class: 'nc-default',
          pins: [
            ['a', '1'],
            ['b', '1'],
          ] as [string, string][],
        },
      ],
    });
    expect(pcbCopperGroups(reach(21.103)).get('t')).not.toBe(
      pcbCopperGroups(reach(21.103)).get('a\u00001'),
    );
    expect(pcbCopperGroups(reach(21.097)).get('t')).toBe(
      pcbCopperGroups(reach(21.097)).get('a\u00001'),
    );
    // A track named like the next free net ID does not block a net list import.
    const named = board([{ ...track('net-1', [10.8, 10], [29.2, 10]) }]);
    let k = 0;
    const nets = pcbImportNetList(named, '{"nets":[{"name":"GND","pins":["R3.2"]}]}', (taken) => {
      while (taken.has(`net-${++k}`));
      return `net-${k}`;
    });
    expect(nets.find((n) => n.name === 'GND')!.id).toBe('net-2');
    // A class's via drill obeys the via limit (0.1 mm).
    const doc = board();
    expect(codes({ ...doc, netClasses: [{ ...doc.netClasses[0], viaDrillMm: 0.05 }] })).toContain(
      'dimension',
    );
  });

  it('keeps a net while copper carries it', () => {
    const doc = board([track('t1', [10.8, 10], [29.2, 10])]);
    expect(() => applyPcbOperation(doc, { type: 'delete', ids: ['n1'] })).toThrow('in-use');
    expect(applyPcbOperation(doc, { type: 'delete', ids: ['n1', 't1'] }).nets).toEqual([]);
  });
});
