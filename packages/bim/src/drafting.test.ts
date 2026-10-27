import {
  applyBimOperation,
  BimContext,
  bimStarter,
  deriveBim,
  f31BoxBuilding,
  type BimDocument,
  type BimOperation,
  arcOf,
  distance,
} from '@editor-platform/bim-core';
import { describe, expect, it } from 'vitest';
import {
  bimBulgeThrough,
  bimEdgePoints,
  bimGridLabel,
  bimLoopOfEdges,
  bimSnap,
  bimSnapRadius,
  bimWallAt,
  draftBeam,
  draftColumn,
  draftGrid,
  draftHosted,
  draftLevel,
  draftRegion,
  draftWall,
} from './drafting';

const apply = (doc: BimDocument, op: BimOperation) => applyBimOperation(doc, op);
const xy = (x: number, y: number) => ({
  xy: [x, y] as [number, number],
  point: { xy: [x, y] as [number, number] },
  kind: 'step' as const,
});

describe('bim drafting (R2c-3c-2)', () => {
  it('snaps to grid intersections, then wall ends, then the step', () => {
    const doc = f31BoxBuilding();
    expect(bimSnap(doc, 'l-1f', [130, -40])).toMatchObject({ kind: 'end', xy: [0, 0] });
    expect(bimSnap(doc, 'l-1f', [5_049, 2_951])).toMatchObject({
      kind: 'step',
      xy: [5_000, 3_000],
    });
    doc.grids = [
      { id: 'g-a', label: 'A', start: [2_000, -1_000], end: [2_000, 9_000] },
      { id: 'g-1', label: '1', start: [-1_000, 4_000], end: [11_000, 4_000] },
    ];
    expect(bimSnap(doc, 'l-1f', [2_100, 3_900])).toEqual({
      xy: [2_000, 4_000],
      point: { grid: ['g-a', 'g-1'] },
      kind: 'grid',
    });
  });

  it('snaps within the same few pixels at any zoom of the plan', () => {
    const doc = f31BoxBuilding();
    doc.grids = [
      { id: 'g-a', label: 'A', start: [2_000, -1_000], end: [2_000, 9_000] },
      { id: 'g-1', label: '1', start: [-1_000, 4_000], end: [11_000, 4_000] },
    ];
    // A 190 m site fitted on 800 px: one pixel spans about 240 mm, so 300 mm was ~1 px.
    const far = bimSnapRadius(240);
    expect(far).toBe(2_400);
    const off: [number, number] = [2_000 + 5 * 240, 4_000 - 3 * 240];
    expect(bimSnap(doc, 'l-1f', off).kind).toBe('step');
    expect(bimSnap(doc, 'l-1f', off, { snapMm: far })).toMatchObject({
      kind: 'grid',
      point: { grid: ['g-a', 'g-1'] },
    });
    // Zoomed in to 5 mm a pixel: 50 mm, so nearby points keep their own place.
    expect(bimSnapRadius(5)).toBe(50);
    expect(bimSnap(doc, 'l-1f', [2_100, 3_900], { snapMm: bimSnapRadius(5) }).kind).toBe('step');
    // No scale (a plan not yet laid out): the fixed distance.
    expect(bimSnapRadius(undefined)).toBe(300);
    expect(bimSnapRadius(0)).toBe(300);
  });

  it('draws a room of walls whose corners join, a slab and a space', () => {
    let doc = bimStarter();
    const corners = [xy(0, 0), xy(8_000, 0), xy(8_000, 6_000), xy(0, 6_000)];
    for (let i = 0; i < 4; i++) {
      // Each corner snaps to the previous wall's end, as the Surface does.
      const a = bimSnap(doc, 'l-1f', corners[i]!.xy);
      const b = bimSnap(doc, 'l-1f', corners[(i + 1) % 4]!.xy);
      doc = apply(doc, draftWall(doc, 'l-1f', a, b));
    }
    expect(doc.elements.filter((e) => e.kind === 'wall')).toHaveLength(4);
    // Every corner is an L joint: four joins.
    expect(doc.joins).toHaveLength(4);
    expect(doc.elements[0]).toMatchObject({ top: { level: 'l-2f', offsetMm: 0 } });
    doc = apply(
      doc,
      draftRegion(
        doc,
        'l-1f',
        'slab',
        corners.map((c) => c.xy),
      ),
    );
    doc = apply(
      doc,
      draftRegion(
        doc,
        'l-1f',
        'space',
        corners.map((c) => c.xy),
      ),
    );
    const q = deriveBim(doc).quantities;
    expect(q.get('s-1')!.values.netArea).toBeCloseTo(48e6, 3);
    expect(q.get('sp-1')!.values.netVolume).toBeCloseTo(48e6 * 3_000, 1);
    // On the top level a space has a fixed height.
    doc = apply(
      doc,
      draftRegion(
        doc,
        'l-rf',
        'space',
        corners.map((c) => c.xy),
      ),
    );
    expect(doc.elements.at(-1)).toMatchObject({ top: { heightMm: 3_000 } });
  });

  it('places doors, windows and openings on the wall under the pointer', () => {
    let doc = f31BoxBuilding();
    const host = bimWallAt(doc, 'l-1f', [7_000, 60])!;
    expect(host.wall.id).toBe('w-south');
    expect(host.alongMm).toBeCloseTo(7_000, 6);
    doc = apply(doc, draftHosted(doc, 'window', host));
    expect(doc.elements.at(-1)).toMatchObject({
      kind: 'window',
      hostId: 'w-south',
      alongMm: 6_100,
    });
    // Near the end the opening is kept inside the wall.
    const end = bimWallAt(doc, 'l-1f', [9_990, 0])!;
    const op = draftHosted(doc, 'opening', end);
    expect(
      (op as { entities: { elements: { wall: { alongMm: number } }[] } }).entities.elements[0]!.wall
        .alongMm,
    ).toBe(9_000);
    expect(bimWallAt(doc, 'l-1f', [5_000, 4_000])).toBeUndefined();
  });

  it('keeps a door inside a diagonal wall at its end, after rounding', () => {
    let doc = bimStarter();
    doc = apply(doc, draftWall(doc, 'l-1f', xy(0, 0), xy(4_000, 4_000)));
    const host = bimWallAt(doc, 'l-1f', [4_000, 4_000])!;
    expect(host.lengthMm).toBeCloseTo(5_656.854, 3);
    // Valid: the door ends inside the 5,656.854 mm wall, not at 5,657 mm.
    doc = apply(doc, draftHosted(doc, 'door', host));
    const door = doc.elements.at(-1) as { alongMm: number };
    expect(door.alongMm).toBe(Math.floor(host.lengthMm - 900));
  });

  it('finds a long arc wall anywhere along it', () => {
    let doc = bimStarter();
    const wall = (
      draftWall(doc, 'l-1f', xy(0, 0), xy(100_000, 0)) as {
        entities: { elements: object[] };
      }
    ).entities.elements[0]!;
    doc = apply(doc, {
      type: 'insert',
      entities: { elements: [{ ...wall, bulge: 1 } as never] },
    });
    // A semicircle of radius 50 m: its far point and a point between the old samples.
    for (const angle of [Math.PI / 2, Math.PI * (1 - 32.5 / 64)]) {
      const p: [number, number] = [50_000 + 50_000 * Math.cos(angle), 50_000 * Math.sin(angle)];
      const at = (q: [number, number]) => bimWallAt(doc, 'l-1f', q);
      const hit = at(p) ?? at([p[0], -p[1]]);
      expect(hit?.d).toBeLessThan(1);
    }
    // Past the ends, the nearer end.
    expect(bimWallAt(doc, 'l-1f', [-100, 50])?.alongMm).toBe(0);
  });

  it('draws columns and beams, and refuses what validation refuses', () => {
    let doc = bimStarter();
    doc = apply(doc, draftColumn(doc, 'l-1f', xy(0, 0)));
    doc = apply(doc, draftBeam(doc, 'l-2f', xy(0, 0), xy(6_000, 0)));
    expect(doc.elements.map((e) => e.id)).toEqual(['c-1', 'b-1']);
    expect(() => draftWall(doc, 'l-1f', xy(0, 0), xy(0, 0))).toThrow('wall-too-short');
    // A door wider than its wall.
    doc = apply(doc, draftWall(doc, 'l-1f', xy(0, 0), xy(500, 0)));
    const host = bimWallAt(doc, 'l-1f', [250, 0])!;
    expect(() => apply(doc, draftHosted(doc, 'door', host))).toThrow('opening-outside-host');
  });
});

describe('bim levels and grid axes (R2c-3c-3)', () => {
  it('labels axes along x with letters and along y with numbers, skipping used labels', () => {
    let doc = bimStarter();
    for (const [a, b] of [
      [
        [0, 0],
        [20_000, 0],
      ],
      [
        [0, 7_200],
        [20_000, 7_200],
      ],
      [
        [0, 0],
        [0, 14_400],
      ],
    ] as [number, number][][])
      doc = apply(doc, draftGrid(doc, a!, b!));
    expect(doc.grids.map((g) => g.label)).toEqual(['A', 'B', '1']);
    expect(bimGridLabel({ ...doc, grids: [] }, [0, 0], [1, 0])).toBe('A');
    const many = {
      ...doc,
      grids: Array.from({ length: 26 }, (_, i) => ({
        id: `x${i}`,
        label: String.fromCharCode(65 + i),
        start: [0, i] as [number, number],
        end: [1, i] as [number, number],
      })),
    };
    expect(bimGridLabel(many, [0, 0], [5, 1])).toBe('AA');
    expect(() => draftGrid(doc, [0, 0], [0.5, 0])).toThrow('grid-too-short');
  });

  it('a column on a crossing follows the axis it stands on', () => {
    let doc = bimStarter();
    doc = apply(doc, draftGrid(doc, [0, 0], [20_000, 0]));
    doc = apply(doc, draftGrid(doc, [3_000, -1_000], [3_000, 10_000]));
    const at = bimSnap(doc, doc.levels[0]!.id, [3_100, 80]);
    expect(at.point).toEqual({ grid: ['g-1', 'g-2'] });
    doc = apply(doc, draftColumn(doc, doc.levels[0]!.id, at));
    const axis = doc.grids.find((g) => g.id === 'g-2')!;
    const moved = apply(doc, {
      type: 'update',
      collection: 'grids',
      entity: { ...axis, start: [4_000, -1_000], end: [4_000, 10_000] },
    });
    const column = moved.elements.find((e) => e.id === 'c-1')!;
    expect(column.kind === 'column' && new BimContext(moved).point(column.at, '')).toEqual([
      4_000, 0,
    ]);
    // The axis is in use: deleting it alone is refused.
    expect(() => apply(moved, { type: 'delete', ids: ['g-2'], cascade: false })).toThrow();
  });

  it('adds a level one storey above the highest', () => {
    const doc = bimStarter();
    const top = Math.max(...doc.levels.map((l) => l.elevationMm));
    const next = apply(doc, draftLevel(doc));
    const added = next.levels.at(-1)!;
    expect(added.elevationMm).toBe(top + 3_000);
    expect(next.levels.map((l) => l.name)).not.toContain(undefined);
    expect(new Set(next.levels.map((l) => l.name)).size).toBe(next.levels.length);
    const first = apply(
      { ...doc, levels: [], elements: [], joins: [], views: [] },
      draftLevel({
        ...doc,
        levels: [],
      }),
    );
    expect(first.levels).toEqual([{ id: 'l-1', name: '1F', elevationMm: 0 }]);
    // Below zero, the new level is still one storey above the highest.
    const basement = { ...doc, levels: [{ id: 'l-b', name: 'B1', elevationMm: -3_000 }] };
    expect(
      apply({ ...basement, elements: [], joins: [], views: [] }, draftLevel(basement)).levels.at(
        -1,
      )!.elevationMm,
    ).toBe(0);
  });

  it('draws an arc wall and an arc slab edge through a third point (OH-U2)', () => {
    // A half circle from east to west over the top is counter-clockwise: bulge 1.
    expect(bimBulgeThrough([1_000, 0], [-1_000, 0], [0, 1_000])).toBeCloseTo(1, 12);
    expect(bimBulgeThrough([1_000, 0], [-1_000, 0], [0, -1_000])).toBeCloseTo(-1, 12);
    // Sagitta 2,000 over a half chord of 4,000, below the chord: counter-clockwise.
    const b = bimBulgeThrough([0, 0], [8_000, 0], [4_000, -2_000]);
    expect(b).toBeCloseTo(0.5, 12);
    // Every arc passes through its third point; past a half circle it is refused.
    for (const m of [
      [3_000, -500],
      [1_000, 2_000],
      [7_000, 2_500],
    ] as [number, number][]) {
      const arc = arcOf([0, 0], [8_000, 0], bimBulgeThrough([0, 0], [8_000, 0], m));
      expect(distance(m, arc.center)).toBeCloseTo(arc.radius, 6);
      const pts = bimEdgePoints([0, 0], [8_000, 0], bimBulgeThrough([0, 0], [8_000, 0], m), 400);
      expect(Math.min(...pts.map((p) => distance(p, m)))).toBeLessThan(80);
    }
    // On the chord between the ends: a straight edge. At an end or beyond: no arc.
    expect(bimBulgeThrough([0, 0], [8_000, 0], [3_000, 0])).toBe(0);
    expect(() => bimBulgeThrough([0, 0], [8_000, 0], [9_000, 0])).toThrow('arc-degenerate');
    expect(() => bimBulgeThrough([0, 0], [8_000, 0], [0, 0])).toThrow('arc-degenerate');
    expect(() => bimBulgeThrough([0, 0], [8_000, 0], [9_000, 1_000])).toThrow(
      'arc-over-half-circle',
    );
    expect(bimBulgeThrough([0, 0], [8_000, 0], [4_000, 4_000])).toBeCloseTo(-1, 12);
    expect(bimEdgePoints([0, 0], [8_000, 0], 0)).toEqual([[8_000, 0]]);

    // Two corners: an arc closed by a line, and a circle of two half arcs, split at the middle.
    expect(
      bimLoopOfEdges(
        [
          [0, 0],
          [8_000, 0],
        ],
        [b, 0],
      ),
    ).toEqual([
      [0, 0, Math.tan(Math.atan(b) / 2)],
      [expect.closeTo(4_000, 6), expect.closeTo(-2_000, 6), Math.tan(Math.atan(b) / 2)],
      [8_000, 0],
    ]);
    const circle = bimLoopOfEdges(
      [
        [0, 0],
        [8_000, 0],
      ],
      [1, 1],
    );
    expect(circle).toHaveLength(4);
    let disc = apply(bimStarter(), draftRegion(bimStarter(), 'l-1f', 'space', circle));
    expect(deriveBim(disc).diagnostics).toEqual([]);
    disc = apply(bimStarter(), draftRegion(bimStarter(), 'l-1f', 'slab', circle));
    const s1 = disc.elements.find((e) => e.kind === 'slab')!;
    expect(deriveBim(disc).quantities.get(s1.id)!.values.grossArea).toBeCloseTo(Math.PI * 16e6, 0);
    expect(
      bimLoopOfEdges(
        [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
        [0.5, 0, 0],
      ),
    ).toEqual([
      [0, 0, 0.5],
      [1, 0],
      [1, 1],
    ]);

    let doc = bimStarter();
    doc = apply(doc, draftWall(doc, 'l-1f', xy(0, 0), xy(8_000, 0), undefined, b));
    const wall = doc.elements.find((e) => e.kind === 'wall')!;
    expect(wall).toMatchObject({ bulge: b });
    doc = apply(
      doc,
      draftRegion(doc, 'l-1f', 'slab', [
        [0, 0, b],
        [8_000, 0],
        [8_000, 6_000],
        [0, 6_000],
      ]),
    );
    const derived = deriveBim(doc);
    expect(derived.diagnostics).toEqual([]);
    // The slab is the rectangle plus the circular segment (radius 5,000, sweep 4·atan 0.5).
    const sweep = 4 * Math.atan(b);
    const segment = (5_000 ** 2 / 2) * (sweep - Math.sin(sweep));
    const slab = doc.elements.find((e) => e.kind === 'slab')!;
    expect(derived.quantities.get(slab.id)!.values.grossArea).toBeCloseTo(48e6 + segment, 0);
  });
});
