import { describe, expect, it } from 'vitest';
import {
  f75Pi5Board,
  generateFootprint,
  pcbDrc,
  pcbZoneFills,
  polygonDistance,
  roundedRectLoop,
  trapezoidPolygon,
  validatePcb,
  type PcbComponent,
  type PcbDocument,
  type PcbTrack,
  type PcbVia,
  type PcbZoneFill,
} from './index';

// PB5 DRC (ST-465, TS-1933).

const part = (id: string, ref: string, footprint: string, at: [number, number]): PcbComponent => ({
  id,
  ref,
  value: '',
  footprint,
  at,
  rotationDeg: 0,
  side: 'top',
  locked: false,
});
const sig = (
  id: string,
  from: [number, number],
  to: [number, number],
  widthMm = 0.15,
): PcbTrack => ({
  id,
  net: 'sig',
  layer: 'F.Cu',
  widthMm,
  from,
  to,
});

/** F75: R1 (40, 30) and R2 (50, 30); SIG R1.2–R2.1 routed; GND R1.1 + R2.2 by a pour. */
function clean(): PcbDocument {
  return {
    ...f75Pi5Board(),
    footprints: [generateFootprint('r', 'chip')],
    components: [part('r1', 'R1', 'r', [40, 30]), part('r2', 'R2', 'r', [50, 30])],
    nets: [
      {
        id: 'gnd',
        name: 'GND',
        class: 'nc-default',
        pins: [
          ['r1', '1'],
          ['r2', '2'],
        ],
      },
      {
        id: 'sig',
        name: 'SIG',
        class: 'nc-default',
        pins: [
          ['r1', '2'],
          ['r2', '1'],
        ],
      },
    ],
    tracks: [sig('t1', [40.8, 30], [49.2, 30])],
    zones: [
      {
        id: 'z1',
        net: 'gnd',
        layer: 'F.Cu',
        outline: roundedRectLoop([-2, -2], 89, 60, 0),
        priority: 0,
        clearanceMm: 0.2,
        padConnection: 'thermal',
        thermalGapMm: 0.3,
        spokeWidthMm: 0.3,
      },
    ],
  };
}
const rules = (doc: PcbDocument) => pcbDrc(doc).violations.map((v) => v.rule);

describe('DRC (PB5)', () => {
  it('passes a clean board, its pour included', () => {
    const doc = clean();
    expect(validatePcb(doc)).toEqual([]);
    const result = pcbDrc(doc);
    expect(result.violations).toEqual([]);
    expect(result.errors).toBe(0);
    // Without the pour GND is open: one unconnected line.
    expect(rules({ ...doc, zones: [] })).toEqual(['unconnected']);
    // The same fills can be passed in (the screen computes them once).
    expect(pcbDrc(doc, pcbZoneFills(doc))).toEqual(result);
  });

  it('finds clearances, shorts, sizes, edge and hole clearances', () => {
    const doc = clean();
    // A SIG track 0.1 mm from the edge of R1's GND pad (pad 0.95 tall, so its edge at y 30.475).
    const near = {
      ...doc,
      zones: [],
      tracks: [...doc.tracks, sig('t2', [38, 30.475 + 0.075 + 0.1], [42, 30.65])],
    };
    const close = pcbDrc(near).violations.filter((v) => v.rule === 'clearance');
    expect(close).toHaveLength(1);
    expect(close[0]).toMatchObject({ items: ['r1', 't2'], layer: 'F.Cu', requiredMm: 0.15 });
    expect(close[0].distanceMm).toBeCloseTo(0.1, 3);
    // Across the pad: a short.
    const across = {
      ...doc,
      zones: [],
      tracks: [...doc.tracks, sig('t2', [39.2, 28], [39.2, 32])],
    };
    expect(rules(across)).toContain('short');
    // Thin track, small via, near the edge, near a mounting hole.
    const via: PcbVia = { id: 'v1', net: 'sig', at: [45, 20], diameterMm: 0.45, drillMm: 0.25 };
    const sized = {
      ...doc,
      tracks: [
        ...doc.tracks,
        sig('t3', [45, 30], [45, 20], 0.1),
        sig('t4', [20, 0.3], [30, 0.3]),
        sig('t5', [3.5 + 3.1, 3.5], [3.5 + 3.1, 8]),
      ],
      vias: [via],
    };
    const found = pcbDrc(sized).violations;
    const of = (rule: string) => found.filter((v) => v.rule === rule);
    expect(of('track-width').map((v) => v.items)).toEqual([['t3']]);
    expect(of('drill-size').map((v) => [v.items, v.distanceMm])).toEqual([[['v1'], 0.25]]);
    expect(of('annular-ring').map((v) => [v.items, v.distanceMm])).toEqual([[['v1'], 0.1]]);
    expect(of('edge-clearance').map((v) => v.items)).toEqual([['t4']]);
    expect(of('edge-clearance')[0].distanceMm).toBeCloseTo(0.3 - 0.075, 3);
    // The mounting hole's keep-out (Ø6.2) asks for 1.75 mm from the Ø2.7 drill.
    const hole = of('hole-clearance');
    expect(hole.map((v) => v.items)).toEqual([['mh-1', 't5']]);
    expect(hole[0].requiredMm).toBe(1.75);
    // The pour stayed clear of every one of them (no zone in any finding).
    expect(found.some((v) => v.items.includes('z1'))).toBe(false);
  });

  it('follows the net class: a wider clearance turns a gap into a finding', () => {
    const doc = clean();
    const tracks = [...doc.tracks, sig('t2', [38, 31], [42, 31])];
    const near = { ...doc, zones: [], tracks };
    // GND has no pour here, so it is open either way.
    expect(rules(near)).toEqual(['unconnected']);
    const wide = {
      ...near,
      netClasses: [{ ...doc.netClasses[0], clearanceMm: 0.6 }],
    };
    const v = pcbDrc(wide).violations;
    expect(v.map((x) => x.rule)).toEqual(['clearance', 'unconnected']);
    expect(v[0].requiredMm).toBe(0.6);
  });

  it('warns about silkscreen over pads and placement', () => {
    const doc = clean();
    // R2 slid onto R1: courtyards overlap, R1's silk crosses R2's pads; SIG pads now touch GND.
    const piled = {
      ...doc,
      zones: [],
      tracks: [],
      components: [
        doc.components[0],
        { ...doc.components[1], at: [40.4, 30.6] as [number, number] },
      ],
    };
    const found = pcbDrc(piled).violations;
    expect(
      found
        .filter((v) => v.severity === 'warning')
        .map((v) => v.rule)
        .sort(),
    ).toEqual(['courtyard-overlap', 'silk-over-pad', 'silk-over-pad']);
    expect(found.some((v) => v.rule === 'short')).toBe(true);
  });
});

describe('DRC review cases (PB5)', () => {
  const wide = (doc: PcbDocument, net: string, clearanceMm: number, trackWidthMm = 0.15) => ({
    ...doc,
    netClasses: [
      ...doc.netClasses,
      { ...doc.netClasses[0], id: 'nc-wide', name: 'Wide', clearanceMm, trackWidthMm },
    ],
    nets: doc.nets.map((n) => (n.id === net ? { ...n, class: 'nc-wide' } : n)),
  });
  const fillGap = (a: PcbZoneFill, b: PcbZoneFill) => {
    let best = Infinity;
    for (const t of a.trapezoids)
      for (const u of b.trapezoids)
        best = Math.min(best, polygonDistance(trapezoidPolygon(t), trapezoidPolygon(u)));
    return best;
  };

  it('checks a track against its net class width', () => {
    const doc = wide(clean(), 'sig', 0.15, 0.6);
    const v = pcbDrc(doc).violations.filter((x) => x.rule === 'track-width');
    expect(v.map((x) => [x.items, x.distanceMm, x.requiredMm])).toEqual([[['t1'], 0.15, 0.6]]);
  });

  it('keeps fills of different nets apart by the larger class, and checks them', () => {
    const base = clean();
    const zone = base.zones[0];
    const doc: PcbDocument = wide(
      {
        ...base,
        zones: [
          {
            ...zone,
            outline: roundedRectLoop([-2, -2], 47, 60, 0),
            priority: 1,
            clearanceMm: 0.05,
          },
          {
            ...zone,
            id: 'z2',
            net: 'sig',
            outline: roundedRectLoop([44.9, -2], 42, 60, 0),
            clearanceMm: 0.05,
          },
        ],
      },
      'sig',
      0.6,
    );
    const fills = pcbZoneFills(doc);
    expect(fills.map((f) => f.areaMm2 > 100)).toEqual([true, true]);
    expect(fillGap(fills[0], fills[1])).toBeGreaterThanOrEqual(0.6 - 1e-6);
    const between = (fs: PcbZoneFill[]) =>
      pcbDrc(doc, fs).violations.filter((v) => v.items.includes('z1') && v.items.includes('z2'));
    expect(between(fills)).toEqual([]);
    // Fills that came too close (here forged) are a finding between the two zones.
    const right = Math.max(...fills[0].trapezoids.map((t) => Math.max(t.xr0, t.xr1)));
    const forged = [
      fills[0],
      {
        ...fills[1],
        trapezoids: [
          { y0: 10, y1: 20, xl0: right + 0.1, xr0: right + 1, xl1: right + 0.1, xr1: right + 1 },
        ],
        islands: [0],
      },
    ];
    const found = between(forged);
    expect(found.map((v) => [v.rule, v.distanceMm, v.requiredMm])).toEqual([
      ['clearance', 0.1, 0.6],
    ]);
    expect(found[0].at[0]).toBeCloseTo(right + 0.05, 3);
  });

  it("counts the zone net's own class against other copper", () => {
    const doc = clean();
    // A SIG track 0.3 mm from where the pour reaches under GND's default 0.2 mm zone clearance.
    const withTrack = { ...doc, tracks: [...doc.tracks, sig('t2', [20, 10], [30, 10])] };
    const loose = pcbZoneFills(withTrack);
    const strict = wide(withTrack, 'gnd', 0.6);
    // The fill itself now keeps 0.6 mm from the track.
    expect(pcbDrc(strict).violations.filter((v) => v.items.includes('z1'))).toEqual([]);
    // Fills made under the looser rule are found too close.
    const v = pcbDrc(strict, loose).violations.filter(
      (x) => x.items.includes('z1') && x.items.includes('t2'),
    );
    expect(v.map((x) => [x.rule, x.requiredMm])).toEqual([['clearance', 0.6]]);
    expect(v[0].distanceMm).toBeCloseTo(0.2, 2);
  });

  it('finds a pad under a large silkscreen circle, and marks a short where it is', () => {
    const doc = clean();
    const a = Math.PI / 32;
    const fp = {
      ...generateFootprint('o', 'body'),
      pads: [
        {
          number: '1',
          type: 'smd' as const,
          shape: 'rect' as const,
          at: [10.02 * Math.cos(a), 10.02 * Math.sin(a)] as [number, number],
          size: [0.05, 0.05] as [number, number],
          rotationDeg: 0,
        },
      ],
      silk: [
        {
          kind: 'circle' as const,
          center: [0, 0] as [number, number],
          radiusMm: 10,
          widthMm: 0.01,
          filled: false,
        },
      ],
    };
    const ringed = {
      ...doc,
      zones: [],
      tracks: [],
      footprints: [...doc.footprints, fp],
      components: [part('m1', 'M1', 'o', [42, 28])],
      nets: [],
    };
    expect(rules(ringed)).toContain('silk-over-pad');
    // Two long tracks of different nets crossing far from their middles.
    const crossing = {
      ...doc,
      zones: [],
      components: [],
      nets: [],
      tracks: [{ ...sig('a', [10, 10], [80, 10]), net: 'gnd' }, sig('b', [11, 9], [11, 50])],
    };
    const short = pcbDrc(crossing).violations.find((v) => v.rule === 'short')!;
    expect(short.at).toEqual([11, 10]);
  });
});
