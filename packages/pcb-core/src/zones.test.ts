import { describe, expect, it } from 'vitest';
import {
  applyPcbOperation,
  componentPads,
  f75Pi5Board,
  generateFootprint,
  pcbLoopPolygon,
  pcbRatsnest,
  pcbZoneFills,
  roundedRectLoop,
  sampleLoop,
  segmentPolygonDistance,
  scanbeamBoolean,
  trapezoidArea,
  trapezoidContains,
  validatePcb,
  type PcbDocument,
  type PcbTrapezoid,
  type PcbZone,
  type Vec2,
} from './index';

// PB4b zones (ST-464, TS-1931): the scanbeam Boolean and zone fills on the Pi 5 board.

const codes = (v: unknown) => validatePcb(v).map((d) => d.code);
const filled = (ts: PcbTrapezoid[], p: Vec2) => ts.some((t) => trapezoidContains(t, p, 0));
const square = (x: number, y: number, s: number): Vec2[] => [
  [x, y],
  [x + s, y],
  [x + s, y + s],
  [x, y + s],
];

describe('scanbeam Boolean', () => {
  it('unites, subtracts and cuts crossing edges exactly', () => {
    const a = { set: 0, points: square(0, 0, 2) };
    const b = { set: 1, points: square(1, 1, 2) };
    const union = scanbeamBoolean([a, b], 2, (k) => k[0] > 0 || k[1] > 0);
    expect(trapezoidArea(union)).toBeCloseTo(7, 12);
    const diff = scanbeamBoolean([a, b], 2, (k) => k[0] > 0 && k[1] <= 0);
    expect(trapezoidArea(diff)).toBeCloseTo(3, 12);
    // Clockwise input counts the same; two triangles whose edges cross mid-beam.
    const t1 = {
      set: 0,
      points: [
        [0, 0],
        [2, 4],
        [4, 0],
      ].reverse() as Vec2[],
    };
    const t2 = {
      set: 1,
      points: [
        [0, 3],
        [4, 3],
        [2, -1],
      ] as Vec2[],
    };
    const both = scanbeamBoolean([t1, t2], 2, (k) => k[0] > 0 && k[1] > 0);
    // The overlap is a hexagon: the big triangle less three corner triangles.
    const overlap = trapezoidArea(both);
    const brute = (() => {
      const inside = (p: Vec2, poly: Vec2[]) => {
        let s = 0;
        for (let i = 0; i < poly.length; i++) {
          const q = poly[i];
          const r = poly[(i + 1) % poly.length];
          s += Math.sign((r[0] - q[0]) * (p[1] - q[1]) - (r[1] - q[1]) * (p[0] - q[0]));
        }
        return Math.abs(s) === poly.length;
      };
      let n = 0;
      const steps = 400;
      for (let i = 0; i < steps; i++)
        for (let j = 0; j < steps; j++) {
          const p: Vec2 = [((i + 0.5) / steps) * 4, -1 + ((j + 0.5) / steps) * 5];
          if (inside(p, t1.points) && inside(p, t2.points)) n++;
        }
      return (n / steps / steps) * 20;
    })();
    expect(overlap).toBeCloseTo(brute, 1);
    expect(overlap).toBeGreaterThan(5);
  });
});

/** F75 with a GND via in the middle and a whole-board GND zone on the given layer. */
function poured(zone: Partial<PcbZone> = {}, extra: Partial<PcbDocument> = {}): PcbDocument {
  const doc = f75Pi5Board();
  return {
    ...doc,
    nets: [
      { id: 'gnd', name: 'GND', class: 'nc-default', pins: [] },
      { id: 'sig', name: 'SIG', class: 'nc-default', pins: [] },
    ],
    vias: [{ id: 'v1', net: 'gnd', at: [40, 30], diameterMm: 0.6, drillMm: 0.3 }],
    zones: [
      {
        id: 'z1',
        net: 'gnd',
        layer: 'B.Cu',
        outline: roundedRectLoop([-5, -5], 95, 66, 0),
        priority: 0,
        clearanceMm: 0.2,
        padConnection: 'thermal',
        thermalGapMm: 0.3,
        spokeWidthMm: 0.4,
        ...zone,
      },
    ],
    ...extra,
  };
}

describe('zone fills (PB4b)', () => {
  it('keeps clear of the board edge, cut-outs and mounting holes', () => {
    const doc = poured(
      {},
      { board: { ...f75Pi5Board().board, cutouts: [roundedRectLoop([20, 20], 10, 4, 0)] } },
    );
    expect(codes(doc)).toEqual([]);
    const [fill] = pcbZoneFills(doc);
    const ts = fill.trapezoids;
    // Edge clearance 0.3 mm (a straight edge and a rounded corner).
    expect(filled(ts, [0.25, 30])).toBe(false);
    expect(filled(ts, [0.32, 30])).toBe(true);
    expect(filled(ts, [42, 55.75])).toBe(false);
    expect(filled(ts, [42, 55.68])).toBe(true);
    const corner = 3 - 3 / Math.SQRT2; // the R3 corner's arc at 45°
    expect(filled(ts, [corner + 0.2, corner + 0.2])).toBe(false);
    expect(filled(ts, [corner + 0.3, corner + 0.3])).toBe(true);
    // A mounting hole's keep-out (Ø6.2) is larger than drill + hole clearance.
    expect(filled(ts, [3.5 + 3.05, 3.5])).toBe(false);
    expect(filled(ts, [3.5 + 3.12, 3.5])).toBe(true);
    expect(filled(ts, [61.5, 52.5])).toBe(false);
    // The cut-out and its edge clearance.
    expect(filled(ts, [25, 22])).toBe(false);
    expect(filled(ts, [25, 19.75])).toBe(false);
    expect(filled(ts, [25, 19.65])).toBe(true);
    // The area: the board inset by 0.3 mm (84.4 × 55.4, R2.7 corners), less four Ø6.2 keep-outs
    // and the cut-out grown by 0.3 mm. Chords are drawn outside the true curves, so a little less.
    const exact =
      84.4 * 55.4 -
      (4 - Math.PI) * 2.7 ** 2 -
      4 * Math.PI * 3.1 ** 2 -
      (40 + 0.3 * 28 + Math.PI * 0.09);
    expect(fill.areaMm2).toBeLessThanOrEqual(exact);
    expect(fill.areaMm2).toBeGreaterThan(exact - 0.5);
    // The same input fills the same (view, DRC and Gerber read one result).
    expect(pcbZoneFills(doc)).toEqual(pcbZoneFills(doc));
  });

  it('keeps clear of other nets and drops islands cut off from the net', () => {
    // A SIG track across the board on B.Cu splits the pour; the GND via is above it.
    const doc = poured(
      {},
      {
        tracks: [
          {
            id: 't1',
            net: 'sig',
            layer: 'B.Cu',
            widthMm: 0.25,
            from: [-1, 20],
            to: [86, 20],
          },
        ],
      },
    );
    expect(codes(doc)).toEqual([]);
    const [fill] = pcbZoneFills(doc);
    const ts = fill.trapezoids;
    // Half the width plus the clearance: 0.125 + 0.2.
    expect(filled(ts, [40, 20.3])).toBe(false);
    expect(filled(ts, [40, 20.34])).toBe(true);
    // The lower part holds no GND copper: dropped.
    expect(filled(ts, [40, 10])).toBe(false);
    expect(new Set(fill.islands).size).toBe(1);
    // The same track on F.Cu leaves the B.Cu pour whole.
    const top = { ...doc, tracks: [{ ...doc.tracks[0], layer: 'F.Cu' }] };
    expect(filled(pcbZoneFills(top)[0].trapezoids, [40, 20])).toBe(true);
    // A bigger net class clearance wins over the zone's.
    const wide = {
      ...doc,
      netClasses: [
        ...doc.netClasses,
        { ...doc.netClasses[0], id: 'nc-wide', name: 'Wide', clearanceMm: 0.5 },
      ],
      nets: doc.nets.map((n) => (n.id === 'sig' ? { ...n, class: 'nc-wide' } : n)),
    };
    expect(filled(pcbZoneFills(wide)[0].trapezoids, [40, 20.6])).toBe(false);
    expect(filled(pcbZoneFills(wide)[0].trapezoids, [40, 20.64])).toBe(true);
  });

  it('joins pads of its net by spokes and removes their ratsnest line', () => {
    const header = generateFootprint('h', 'pin-header', { rows: 1, pinsPerRow: 2 });
    const base = poured(
      {},
      {
        footprints: [header],
        components: [
          {
            id: 'j1',
            ref: 'J1',
            value: '',
            footprint: 'h',
            at: [20, 40],
            rotationDeg: 0,
            side: 'top',
            locked: false,
          },
          {
            id: 'j2',
            ref: 'J2',
            value: '',
            footprint: 'h',
            at: [60, 40],
            rotationDeg: 0,
            side: 'top',
            locked: false,
          },
        ],
      },
    );
    const doc: PcbDocument = {
      ...base,
      nets: [
        {
          ...base.nets[0],
          pins: [
            ['j1', '1'],
            ['j2', '1'],
          ],
        },
        {
          ...base.nets[1],
          pins: [
            ['j1', '2'],
            ['j2', '2'],
          ],
        },
      ],
    };
    expect(codes(doc)).toEqual([]);
    const pads = componentPads(doc, doc.components[0]);
    const p1 = pads.find((p) => p.pad.number === '1')!;
    const p2 = pads.find((p) => p.pad.number === '2')!;
    const [fill] = pcbZoneFills(doc);
    const ts = fill.trapezoids;
    const half = p1.pad.size[0] / 2;
    // Thermal: the gap ring is empty except on the spokes (along the pad's axes).
    const diag = (half + 0.15) * Math.SQRT1_2 + half * (1 - Math.SQRT1_2);
    expect(filled(ts, [p1.at[0] + diag, p1.at[1] + diag])).toBe(false);
    expect(filled(ts, [p1.at[0], p1.at[1] + half + 0.15])).toBe(true);
    expect(filled(ts, [p1.at[0], p1.at[1]])).toBe(true);
    // The SIG pad keeps its clearance all round.
    expect(filled(ts, [p2.at[0], p2.at[1] - half - 0.15])).toBe(false);
    // GND pins are joined through the pour; SIG still needs a track.
    expect(pcbRatsnest(doc).map((l) => l.net)).toEqual(['sig']);
    expect(pcbRatsnest({ ...doc, zones: [] }).map((l) => l.net)).toEqual(['gnd', 'sig']);
    // Solid pads: no gap at all.
    const solid = pcbZoneFills({ ...doc, zones: [{ ...doc.zones[0], padConnection: 'solid' }] });
    expect(filled(solid[0].trapezoids, [p1.at[0] + diag, p1.at[1] + diag])).toBe(true);
  });

  it('never comes inside a clearance, measured against the same chords', () => {
    // A chip of another net in the pour, on a board with rounded corners.
    const doc = poured(
      { layer: 'F.Cu' },
      {
        footprints: [generateFootprint('r', 'chip')],
        components: [
          {
            id: 'r1',
            ref: 'R1',
            value: '',
            footprint: 'r',
            at: [40, 20],
            rotationDeg: 0,
            side: 'top',
            locked: false,
          },
        ],
      },
    );
    doc.nets[1].pins = [['r1', '2']];
    const [fill] = pcbZoneFills(doc);
    const polys = fill.trapezoids.map((t): Vec2[] => [
      [t.xl0, t.y0],
      [t.xr0, t.y0],
      [t.xr1, t.y1],
      [t.xl1, t.y1],
    ]);
    const board = pcbLoopPolygon(doc.board.outline);
    let edge = Infinity;
    for (const poly of polys)
      for (let i = 0; i < board.length; i++)
        edge = Math.min(
          edge,
          segmentPolygonDistance(board[i], board[(i + 1) % board.length], poly),
        );
    expect(edge).toBeGreaterThanOrEqual(0.3 - 1e-9);
    const pad = sampleLoop(componentPads(doc, doc.components[0])[1].loop);
    let gap = Infinity;
    for (const poly of polys)
      for (let i = 0; i < pad.length; i++)
        gap = Math.min(gap, segmentPolygonDistance(pad[i], pad[(i + 1) % pad.length], poly));
    expect(gap).toBeGreaterThanOrEqual(0.2 - 1e-9);
    expect(gap).toBeLessThan(0.21);
  });

  it('lets a higher zone of another net fill first', () => {
    const doc = poured(
      {},
      {
        vias: [
          { id: 'v1', net: 'gnd', at: [40, 30], diameterMm: 0.6, drillMm: 0.3 },
          { id: 'v2', net: 'sig', at: [70, 30], diameterMm: 0.6, drillMm: 0.3 },
        ],
      },
    );
    doc.zones.push({
      ...doc.zones[0],
      id: 'z2',
      net: 'sig',
      outline: roundedRectLoop([60, 20], 20, 20, 0),
      priority: 1,
    });
    expect(codes(doc)).toEqual([]);
    const fills = pcbZoneFills(doc);
    expect(fills.map((f) => f.zone)).toEqual(['z2', 'z1']);
    expect(filled(fills[0].trapezoids, [70, 35])).toBe(true);
    expect(filled(fills[1].trapezoids, [70, 35])).toBe(false);
    expect(filled(fills[1].trapezoids, [59.85, 35])).toBe(false);
    expect(filled(fills[1].trapezoids, [59.75, 35])).toBe(true);
  });

  it('validates zones and keeps a net a zone uses', () => {
    const doc = poured();
    const bad = (z: Partial<PcbZone>) => codes({ ...doc, zones: [{ ...doc.zones[0], ...z }] });
    expect(bad({ layer: 'In9.Cu' })).toContain('layer');
    expect(bad({ net: 'nope' })).toContain('reference-missing');
    expect(bad({ priority: 1.5 })).toContain('priority');
    expect(bad({ clearanceMm: 0 })).toContain('dimension');
    expect(bad({ padConnection: 'x' as 'solid' })).toContain('enum');
    expect(
      bad({
        outline: [
          [0, 0],
          [10, 10],
          [10, 0],
          [0, 10],
        ],
      }),
    ).toContain('loop-not-simple');
    expect(codes({ ...doc, board: { ...doc.board, edgeClearanceMm: -1 } })).toContain('dimension');
    expect(() => applyPcbOperation({ ...doc, vias: [] }, { type: 'delete', ids: ['gnd'] })).toThrow(
      'in-use',
    );
    const gone = applyPcbOperation({ ...doc, vias: [] }, { type: 'delete', ids: ['z1', 'gnd'] });
    expect(gone.zones).toEqual([]);
  });
});

describe('zone fill review cases (PB4b)', () => {
  const pad = (number: string, at: Vec2, size: Vec2, shape: 'circle' | 'rect') => ({
    number,
    type: 'smd' as const,
    shape,
    at,
    size,
    rotationDeg: 0,
  });
  const custom = (id: string, pads: ReturnType<typeof pad>[]) => ({
    id,
    name: id,
    pads,
    silk: [],
    courtyard: roundedRectLoop([-1, -1], 2, 2, 0),
    heightMm: 1,
  });
  const place = (id: string, footprint: string, at: Vec2) => ({
    id,
    ref: id.toUpperCase(),
    value: '',
    footprint,
    at,
    rotationDeg: 0,
    side: 'top' as const,
    locked: false,
  });
  const nearest = (ts: PcbTrapezoid[], c: Vec2) =>
    Math.min(
      ...ts.map((t) =>
        segmentPolygonDistance(c, c, [
          [t.xl0, t.y0],
          [t.xr0, t.y0],
          [t.xr1, t.y1],
          [t.xl1, t.y1],
        ]),
      ),
    );

  it('subtracts crossing triangles exactly', () => {
    const a = {
      set: 0,
      points: [
        [0, 5],
        [7, 8],
        [3, 7],
      ] as Vec2[],
    };
    const b = {
      set: 1,
      points: [
        [2, 7],
        [6, 5],
        [2, 9],
      ] as Vec2[],
    };
    const diff = scanbeamBoolean([a, b], 2, (k) => k[0] > 0 && k[1] <= 0);
    expect(trapezoidArea(diff)).toBeCloseTo(1.789011, 5);
    expect(filled(diff, [3, 6.6])).toBe(false);
  });

  it('keeps clear of the true curve of a big round pad and a big round cut-out', () => {
    const doc = poured({ layer: 'F.Cu', clearanceMm: 0.05 });
    const big: PcbDocument = {
      ...doc,
      footprints: [custom('o', [pad('1', [0, 0], [50, 50], 'circle')])],
      components: [place('u1', 'o', [42, 28])],
      nets: [doc.nets[0], { ...doc.nets[1], pins: [['u1', '1']] }],
      netClasses: [{ ...doc.netClasses[0], clearanceMm: 0.05 }],
    };
    expect(codes(big)).toEqual([]);
    expect(nearest(pcbZoneFills(big)[0].trapezoids, [42, 28])).toBeGreaterThanOrEqual(25.05 - 1e-9);
    // A 1000 mm board with an R400 cut-out and 0.05 mm edge clearance.
    const wide: PcbDocument = {
      ...doc,
      holes: [],
      board: {
        ...doc.board,
        outline: roundedRectLoop([0, 0], 1000, 1000, 0),
        cutouts: [
          [
            [900, 500, Math.tan(Math.PI / 8)],
            [500, 900, Math.tan(Math.PI / 8)],
            [100, 500, Math.tan(Math.PI / 8)],
            [500, 100, Math.tan(Math.PI / 8)],
          ],
        ],
        edgeClearanceMm: 0.05,
      },
      vias: [{ id: 'v1', net: 'gnd', at: [50, 50], diameterMm: 0.6, drillMm: 0.3 }],
      zones: [{ ...doc.zones[0], outline: roundedRectLoop([-1, -1], 1002, 1002, 0) }],
    };
    expect(codes(wide)).toEqual([]);
    expect(nearest(pcbZoneFills(wide)[0].trapezoids, [500, 500])).toBeGreaterThanOrEqual(
      400.05 - 1e-9,
    );
    // A nearly straight arc (bulge 1e-14) in a zone outline fills like the straight side.
    const flat: PcbDocument = {
      ...doc,
      zones: [
        {
          ...doc.zones[0],
          outline: [
            [10, 10, 1e-14],
            [40, 10],
            [40, 40],
            [10, 40],
          ],
        },
      ],
    };
    expect(codes(flat)).toEqual([]);
    const straight = { ...flat, zones: [{ ...flat.zones[0], outline: square(10, 10, 30) }] };
    expect(pcbZoneFills(flat)[0].areaMm2).toBeGreaterThan(100);
    expect(pcbZoneFills(flat)[0].areaMm2).toBeCloseTo(pcbZoneFills(straight)[0].areaMm2, 6);
    expect(pcbLoopPolygon(flat.zones[0].outline, 'around').length).toBeLessThan(8);
  });

  it('keeps an island a track crosses, and joins overlapping zones of a net', () => {
    const doc = poured();
    const crossing: PcbDocument = {
      ...doc,
      vias: [],
      tracks: [
        { id: 't1', net: 'gnd', layer: 'B.Cu', widthMm: 0.25, from: [10, 30], to: [70, 30] },
      ],
      zones: [{ ...doc.zones[0], outline: roundedRectLoop([25, 20], 30, 20, 0) }],
    };
    expect(pcbZoneFills(crossing)[0].areaMm2).toBeGreaterThan(500);
    // Two GND zones that overlap, each holding one GND pad: the pads are joined.
    const header = generateFootprint('h', 'pin-header', { rows: 1, pinsPerRow: 1 });
    const two: PcbDocument = {
      ...doc,
      vias: [],
      footprints: [header],
      components: [place('j1', 'h', [15, 30]), place('j2', 'h', [65, 30])],
      nets: [
        {
          ...doc.nets[0],
          pins: [
            ['j1', '1'],
            ['j2', '1'],
          ],
        },
        doc.nets[1],
      ],
      zones: [
        { ...doc.zones[0], id: 'za', outline: roundedRectLoop([10, 20], 30, 20, 0) },
        { ...doc.zones[0], id: 'zb', outline: roundedRectLoop([35, 20], 35, 20, 0) },
      ],
    };
    expect(codes(two)).toEqual([]);
    const fills = pcbZoneFills(two);
    expect(fills.every((f) => f.areaMm2 > 100)).toBe(true);
    expect(new Set(fills.flatMap((f) => f.islands)).size).toBe(1);
    expect(pcbRatsnest(two)).toEqual([]);
  });

  it("keeps a higher zone's net-class clearance, and each pad's own relief", () => {
    const doc = poured();
    const classes = [
      doc.netClasses[0],
      { ...doc.netClasses[0], id: 'nc-wide', name: 'Wide', clearanceMm: 1 },
    ];
    const sigZone: PcbDocument = {
      ...doc,
      netClasses: classes,
      nets: [doc.nets[0], { ...doc.nets[1], class: 'nc-wide' }],
      vias: [...doc.vias, { id: 'v2', net: 'sig', at: [70, 30], diameterMm: 0.6, drillMm: 0.3 }],
      zones: [
        doc.zones[0],
        {
          ...doc.zones[0],
          id: 'z2',
          net: 'sig',
          outline: roundedRectLoop([60, 20], 20, 20, 0),
          priority: 1,
        },
      ],
    };
    expect(codes(sigZone)).toEqual([]);
    const gnd = pcbZoneFills(sigZone).find((f) => f.zone === 'z1')!;
    expect(filled(gnd.trapezoids, [59.05, 30])).toBe(false);
    expect(filled(gnd.trapezoids, [58.95, 30])).toBe(true);
    // Two GND pads 2 × 2 mm close together: the first one's spokes do not fill the second's gap.
    const pads: PcbDocument = {
      ...doc,
      vias: [],
      footprints: [custom('s', [pad('1', [0, 0], [2, 2], 'rect')])],
      components: [place('p1', 's', [40, 40]), place('p2', 's', [42.5, 41])],
      nets: [
        {
          ...doc.nets[0],
          pins: [
            ['p1', '1'],
            ['p2', '1'],
          ],
        },
        doc.nets[1],
      ],
      zones: [{ ...doc.zones[0], layer: 'F.Cu', thermalGapMm: 0.3, spokeWidthMm: 0.3 }],
    };
    expect(codes(pads)).toEqual([]);
    const relief = pcbZoneFills(pads)[0].trapezoids;
    expect(filled(relief, [42, 39.9])).toBe(false);
    // Its own spoke (straight down from its centre) is there.
    expect(filled(relief, [42.5, 39.85])).toBe(true);
  });
});
