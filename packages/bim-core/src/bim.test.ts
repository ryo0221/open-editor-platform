import { EditorSession } from '@editor-platform/editor-core';
import type { GeometryOp } from '@editor-platform/geometry-core';
import { describe, expect, it } from 'vitest';
import {
  applyBimOperation,
  bimContentHash,
  bimDependents,
  bimEditorCommand,
  bimJoinThrough,
  BimOperationError,
  deriveBim,
  dot,
  bimStarter,
  emptyBim,
  f31BoxBuilding,
  f33Types,
  f37Office,
  f39Roofs,
  f40Lattice,
  f47Taper,
  f48Ramp,
  f49Pipes,
  f50Lean,
  f51Ramps,
  f52LeanOpenings,
  f54LeanJoins,
  f54LeanRoofs,
  f55RampOpenings,
  f55Stairs,
  bimGeometry,
  bimProfileLoops,
  bimSchedule,
  bimSectionAxes,
  entityReferences,
  profileArea,
  loopArea,
  proposeJoins,
  sub,
  validateBim,
  type BimDocument,
  type BimElement,
  type BimLoop,
  type BimOperation,
  type BimShape,
  type BimWall,
  type BimWallJoin,
  type Vec2,
} from './index';

const errors = (doc: unknown) => validateBim(doc).filter((d) => d.severity === 'error');
const codes = (doc: unknown) => errors(doc).map((d) => d.code);
const q = (doc: BimDocument, id: string) => deriveBim(doc).quantities.get(id)!.values;
const shape = <K extends BimShape['kind']>(doc: BimDocument, id: string, kind: K) => {
  const s = deriveBim(doc).shapes.get(id)!;
  expect(s.kind).toBe(kind);
  return s as Extract<BimShape, { kind: K }>;
};
const element = <T extends BimElement>(doc: BimDocument, id: string) =>
  doc.elements.find((e) => e.id === id) as T;
const session = (doc: BimDocument) => new EditorSession(doc);
const exec = (s: EditorSession<BimDocument>, op: BimOperation, canEdit = () => true) =>
  s.execute(bimEditorCommand(op, { expectedHash: bimContentHash(s.content), canEdit }));
const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

/** Two straight walls 200 mm thick (types from the fixtures) on 1F–2F, and one join. */
function twoWalls(
  a: [number[], number[]],
  b: [number[], number[]],
  extra: Partial<BimWall>[] = [],
) {
  const doc = f33Types();
  doc.elements = [a, b].map(([s, e], i) => ({
    id: `w${i + 1}`,
    kind: 'wall',
    typeId: 't-wall-200',
    start: { xy: s as [number, number] },
    end: { xy: e as [number, number] },
    location: 'center',
    base: { level: 'l-1f', offsetMm: 0 },
    top: { level: 'l-2f', offsetMm: 0 },
    ...extra[i],
  }));
  return doc;
}

describe('bim-core document (CAD61)', () => {
  it('accepts an empty document and the fixtures', () => {
    expect(errors(emptyBim())).toEqual([]);
    expect(errors(bimStarter())).toEqual([]);
    expect(errors(f31BoxBuilding())).toEqual([]);
    expect(errors(f33Types())).toEqual([]);
    expect(errors(f37Office())).toEqual([]);
  });
  it('reads schema 1 only and refuses unknown keys, bad IDs and duplicates', () => {
    expect(codes({ ...emptyBim(), schemaVersion: 2 })).toEqual(['unsupported-schema']);
    const { schemaVersion: _, ...noVersion } = emptyBim();
    expect(codes(noVersion)).toEqual(['unsupported-schema']);
    expect(codes({ ...emptyBim(), extra: 1 })).toContain('unknown-key');
    const dup = f31BoxBuilding();
    dup.levels[1].id = 'l-1f';
    const d = errors(dup).find((x) => x.code === 'duplicate-id')!;
    expect(d.firstPath).toBe('$.levels[0].id');
    const cyc: Record<string, unknown> = emptyBim() as never;
    cyc.project = cyc;
    expect(codes(cyc)).toEqual(['json-value']);
    expect(
      codes({ ...emptyBim(), levels: [{ id: 'a', name: 'x', elevationMm: Infinity }] }),
    ).toEqual(['number']);
    // Discriminators that name Object.prototype members are unknown, not lookups.
    const inherited = f31BoxBuilding();
    (inherited.elements[0] as { kind: string }).kind = 'toString';
    expect(codes(inherited)).toContain('element-kind');
    const profile = f37Office();
    (
      profile.types.find((t) => t.kind === 'column') as { profile: { shape: string } }
    ).profile.shape = 'toString';
    expect(codes(profile)).toEqual(['profile']);
  });
  it('checks references and their kinds', () => {
    const doc = f31BoxBuilding();
    element<BimWall>(doc, 'w-south').typeId = 't-slab-200';
    expect(codes(doc)).toEqual(['type-kind']);
    const host = f31BoxBuilding();
    (element(host, 'd-entrance') as { hostId: string }).hostId = 's-1f';
    expect(codes(host)).toEqual(['host-kind']);
    // An opening's payload must be an object.
    for (const [host, key] of [
      ['w-south', 'wall'],
      ['s-2f', 'slab'],
    ] as const) {
      const bad = f31BoxBuilding();
      bad.elements.push({ id: 'o-bad', kind: 'opening', hostId: host, [key]: null } as never);
      expect(codes(bad)).toEqual(['opening-host']);
    }
    // A malformed wall reference is reported, never coerced to a string.
    const coerced = f31BoxBuilding();
    coerced.joins[0].walls = [{ toString: 0 }, 'w-south'] as never;
    expect(() => validateBim(coerced)).not.toThrow();
    expect(codes(coerced).length).toBeGreaterThan(0);
    const missing = f31BoxBuilding();
    element<BimWall>(missing, 'w-south').base.level = 'l-9f';
    expect(codes(missing)).toEqual(['reference-missing']);
  });
  it('limits level spacing, counts and loop vertices', () => {
    const near = f31BoxBuilding();
    near.levels[1].elevationMm = 500;
    expect(codes(near)).toContain('level-spacing');
    // TW0d: a 340 m storey (a tower's first deck) is valid; more than 1,000 m is not.
    const deck = f31BoxBuilding();
    deck.levels[2].elevationMm = 343_000;
    expect(codes(deck)).not.toContain('level-spacing');
    const wide = f31BoxBuilding();
    wide.levels[0].elevationMm = -1_000_000;
    wide.levels[1].elevationMm = 3_000;
    expect(codes(wide)).toContain('level-spacing');
    const many = emptyBim();
    many.levels = Array.from({ length: 65 }, (_, i) => ({
      id: `l${i}`,
      name: `${i}`,
      elevationMm: i * 3000,
    }));
    expect(codes(many)).toEqual(['limit-count']);
    const big = f31BoxBuilding();
    const slab = element<Extract<BimElement, { kind: 'slab' }>>(big, 's-1f');
    slab.boundary = Array.from({ length: 1025 }, (_, i) => {
      const a = (2 * Math.PI * i) / 1025;
      return [5000 * Math.cos(a), 5000 * Math.sin(a)];
    });
    expect(codes(big)).toEqual(['limit-vertices']);
    // Names fit IFC's IfcLabel (255 characters).
    const named = f31BoxBuilding();
    named.levels[0].name = 'x'.repeat(255);
    expect(codes(named)).toEqual([]);
    named.levels[0].name = 'x'.repeat(256);
    expect(codes(named)).toEqual(['name']);
    // A grid intersection far outside the coordinate limit (nearly parallel axes).
    const far = f37Office();
    Object.assign(far.grids.find((g) => g.id === 'g-x1')!, { start: [0, 0], end: [100000, 0.001] });
    expect(codes(far)).toContain('coordinate');
  });
});

describe('derived shapes and quantities (CAD62, F31)', () => {
  const doc = f31BoxBuilding();
  it('joins the box corners with butt joins', () => {
    const south = shape(doc, 'w-south', 'wall');
    const west = shape(doc, 'w-west', 'wall');
    close(loopArea(south.footprint), 10200 * 200);
    close(loopArea(west.footprint), 7800 * 200);
    const total = ['w-south', 'w-east', 'w-north', 'w-west'].reduce(
      (n, id) => n + loopArea(shape(doc, id, 'wall').footprint),
      0,
    );
    // The outer rectangle minus the inner one.
    close(total, 10200 * 8200 - 9800 * 7800);
    expect(Math.min(...south.footprint.map((p) => p[0]))).toBeCloseTo(-100, 9);
    expect(Math.max(...south.footprint.map((p) => p[0]))).toBeCloseTo(10100, 9);
  });
  it('computes wall, slab, roof and space quantities analytically', () => {
    const south = q(doc, 'w-south');
    expect(south.length).toBe(10000);
    expect(south.height).toBe(6000);
    expect(south.width).toBe(200);
    close(south.grossVolume, 10200 * 200 * 6000);
    close(south.netVolume, 10200 * 200 * 6000 - 900 * 2100 * 200);
    close(south.openingArea, 900 * 2100);
    const north = q(doc, 'w-north');
    close(north.netSideArea, 10000 * 6000 - 3 * 1800 * 1500);
    const slab = q(doc, 's-2f');
    close(slab.netArea, 9800 * 7800 - 3000 * 2000);
    close(slab.netVolume, (9800 * 7800 - 3000 * 2000) * 200);
    expect(shape(doc, 's-2f', 'slab').zBottom).toBe(2800);
    const roof = q(doc, 'r-roof');
    close(roof.grossVolume, 10200 * 8200 * 200);
    const space = q(doc, 'sp-hall');
    close(space.netFloorArea, 9800 * 7800);
    expect(space.height).toBe(3000);
    close(space.netVolume, 9800 * 7800 * 3000);
  });
  it('computes column, beam and mono-pitch roof quantities', () => {
    const office = f37Office();
    const col = q(office, 'c-1-1-1');
    expect(col).toEqual({ length: 4000, crossSectionArea: 360000, netVolume: 360000 * 4000 });
    const beam = q(office, 'b-2-x1-1');
    expect(beam.length).toBe(7200);
    expect(beam.netVolume).toBe(400 * 700 * 7200);
    const mono = f31BoxBuilding();
    const roof = element<Extract<BimElement, { kind: 'roof' }>>(mono, 'r-roof');
    roof.shape = { form: 'mono', slopeRad: Math.PI / 6, directionRad: Math.PI / 2 };
    expect(errors(mono)).toEqual([]);
    const v = q(mono, 'r-roof');
    close(v.grossArea, (10200 * 8200) / Math.cos(Math.PI / 6));
    close(v.grossVolume, (10200 * 8200 * 200) / Math.cos(Math.PI / 6));
    const s = shape(mono, 'r-roof', 'roof');
    expect(s.faces[0].origin[1]).toBe(-100);
    close(s.faces[0].slope, Math.tan(Math.PI / 6));
    // An arc boundary is lowest between its vertices: the underside stays at the base there.
    const arc = f31BoxBuilding();
    const r = element<Extract<BimElement, { kind: 'roof' }>>(arc, 'r-roof');
    r.boundary = [
      [5000, 0, 1],
      [-5000, 0],
      [0, -5000],
    ];
    const dir = -Math.PI / 2 + 0.1;
    r.shape = { form: 'mono', slopeRad: Math.PI / 6, directionRad: dir };
    expect(errors(arc)).toEqual([]);
    const a = shape(arc, 'r-roof', 'roof');
    // The circle of radius 5,000 around the origin is lowest along the rise at −direction.
    close(a.faces[0].origin[0], -5000 * Math.cos(dir), 1e-6);
    close(a.faces[0].origin[1], -5000 * Math.sin(dir), 1e-6);
  });
  it('leaves clipped walls and columns to the kernel', () => {
    const clipped = f31BoxBuilding();
    element<BimWall>(clipped, 'w-east').clipBy = 'r-roof';
    expect(errors(clipped)).toEqual([]);
    const qe = deriveBim(clipped).quantities.get('w-east')!;
    expect(qe.source).toBe('kernel');
    expect(qe.values.grossVolume).toBeUndefined();
    expect(shape(clipped, 'w-east', 'wall').clipBy).toBe('r-roof');
    element<BimWall>(clipped, 'w-east').clipBy = 's-1f';
    expect(codes(clipped)).toEqual(['host-kind']);
  });
  it('derives gable and hip roofs over a rectangle, one plane per side (F39)', () => {
    const t = Math.tan(Math.PI / 6);
    for (const form of ['gable', 'hip'] as const) {
      const doc = f39Roofs(form);
      expect(errors(doc)).toEqual([]);
      const v = q(doc, 'r-roof');
      close(v.projectedArea, 10200 * 8200);
      close(v.grossArea, (10200 * 8200) / Math.cos(Math.PI / 6));
      close(v.grossVolume, (10200 * 8200 * 200) / Math.cos(Math.PI / 6));
      const s = shape(doc, 'r-roof', 'roof');
      expect(s.form).toBe(form);
      // Each plane is lowest over its own part, the parts tile the plan, and the underside
      // is at the base along every eave.
      const under = (p: Vec2) =>
        Math.min(...s.faces.map((f) => s.zBase + f.slope * dot(sub(p, f.origin), f.direction)));
      let tiled = 0;
      for (const f of s.faces) {
        tiled += loopArea(f.region!);
        for (const p of f.region!)
          close(s.zBase + f.slope * dot(sub(p, f.origin), f.direction), under(p));
      }
      close(tiled, 10200 * 8200);
      close(under([5000, -100]), 6000);
      close(under([10100, 4000]), form === 'gable' ? 6000 + t * 4100 : 6000);
      // The ridge: 4,100 mm in from the long sides.
      close(under([5000, 4000]), 6000 + t * 4100);
    }
    // A gable has two parts (halves), a hip four (two trapezoids, two triangles).
    expect(shape(f39Roofs('gable'), 'r-roof', 'roof').faces.map((f) => f.region!.length)).toEqual([
      4, 4,
    ]);
    expect(shape(f39Roofs('hip'), 'r-roof', 'roof').faces.map((f) => f.region!.length)).toEqual([
      4, 3, 4, 3,
    ]);
    // A square gives a pyramid: four triangles.
    const square = f39Roofs('hip');
    element<Extract<BimElement, { kind: 'roof' }>>(square, 'r-roof').boundary = [
      [0, 0],
      [8000, 0],
      [8000, 8000],
      [0, 8000],
    ];
    expect(shape(square, 'r-roof', 'roof').faces.map((f) => f.region!.length)).toEqual([
      3, 3, 3, 3,
    ]);
    // Clipped walls and the column go to the kernel.
    expect(deriveBim(f39Roofs('gable')).quantities.get('c-ridge')!.source).toBe('kernel');
    // Refusals: not a rectangle, an arc, a ridge along no side, a missing ridge, a steep slope.
    const roofOf = (doc: BimDocument) =>
      element<Extract<BimElement, { kind: 'roof' }>>(doc, 'r-roof');
    const skew = f39Roofs('gable');
    roofOf(skew).boundary = [
      [0, 0],
      [10000, 0],
      [11000, 8000],
      [0, 8000],
    ];
    expect(codes(skew)).toContain('roof-shape');
    const arc = f39Roofs('hip');
    roofOf(arc).boundary = [
      [-100, -100, 0.2],
      [10100, -100],
      [10100, 8100],
      [-100, 8100],
    ];
    expect(codes(arc)).toContain('roof-shape');
    const ridge = f39Roofs('gable');
    roofOf(ridge).shape = { form: 'gable', slopeRad: Math.PI / 6, ridgeRad: Math.PI / 4 };
    expect(codes(ridge)).toContain('roof-ridge');
    const missing = f39Roofs('gable');
    roofOf(missing).shape = { form: 'gable', slopeRad: Math.PI / 6 } as never;
    expect(codes(missing)).toContain('missing-key');
    const steep = f39Roofs('hip');
    roofOf(steep).shape = { form: 'hip', slopeRad: Math.PI / 2 };
    expect(codes(steep)).toContain('roof-slope');
  });
  it('computes an arc wall exactly', () => {
    const doc = twoWalls(
      [
        [5000, 0],
        [0, 5000],
      ],
      [
        [0, 0],
        [0, -3000],
      ],
    );
    (doc.elements[0] as BimWall).bulge = Math.tan(Math.PI / 8); // a quarter turn, counter-clockwise
    expect(errors(doc)).toEqual([]);
    const v = q(doc, 'w1');
    close(v.length, (5000 * Math.PI) / 2, 1e-6);
    close(v.footprintArea, (Math.PI / 4) * (5100 ** 2 - 4900 ** 2), 1e-3);
  });
  it('refuses arcs too flat to keep their thickness', () => {
    for (const bulge of [1e-15, 1e-320]) {
      const doc = twoWalls(
        [
          [0, 0],
          [10000, 0],
        ],
        [
          [0, 3000],
          [0, 6000],
        ],
      );
      (doc.elements[0] as BimWall).bulge = bulge;
      expect(codes(doc)).toEqual(['arc-too-flat']);
    }
    const slab = f31BoxBuilding();
    element<Extract<BimElement, { kind: 'slab' }>>(slab, 's-1f').boundary[0][2] = 1e-15;
    expect(codes(slab)).toContain('arc-too-flat');
  });
});

describe('wall joins (F32)', () => {
  it('refuses a join that trims a wall past its other end', () => {
    const doc = twoWalls(
      [
        [0, 0],
        [10000, 0],
      ],
      [
        [4000, 0],
        [4000, 50],
      ],
    );
    doc.joins = [{ id: 'j', walls: ['w1', 'w2'], kind: 'butt', through: 'w1' }];
    expect(codes(doc)).toEqual(['join-failed']);
  });
  it('miters an L of equal walls and refuses mismatched ones', () => {
    const doc = twoWalls(
      [
        [0, 0],
        [5000, 0],
      ],
      [
        [5000, 0],
        [5000, 4000],
      ],
    );
    doc.joins = [{ id: 'j', walls: ['w1', 'w2'], kind: 'miter' }];
    expect(errors(doc)).toEqual([]);
    const a = shape(doc, 'w1', 'wall').footprint;
    // Outer corner (5100, −100), inner corner (4900, 100).
    expect(a.some((p) => Math.abs(p[0] - 5100) < 1e-9 && Math.abs(p[1] + 100) < 1e-9)).toBe(true);
    expect(a.some((p) => Math.abs(p[0] - 4900) < 1e-9 && Math.abs(p[1] - 100) < 1e-9)).toBe(true);
    // Mitered: each wall's area is its axis length times its thickness.
    close(loopArea(a) + loopArea(shape(doc, 'w2', 'wall').footprint), 200 * 5000 + 200 * 4000);
    const high = structuredClone(doc);
    (high.elements[1] as BimWall).top = { heightMm: 2500 };
    expect(codes(high)).toEqual(['join-height-mismatch']);
    const thin = structuredClone(doc);
    (thin.elements[1] as BimWall).location = 'left';
    expect(codes(thin)).toEqual(['join-thickness-mismatch']);
  });
  it('butts a T and keeps openings out of the joined stretch', () => {
    const doc = twoWalls(
      [
        [0, 0],
        [10000, 0],
      ],
      [
        [4000, 0],
        [4000, 3000],
      ],
    );
    doc.joins = [{ id: 'j', walls: ['w1', 'w2'], kind: 'butt', through: 'w1' }];
    expect(errors(doc)).toEqual([]);
    close(loopArea(shape(doc, 'w2', 'wall').footprint), 2900 * 200);
    close(loopArea(shape(doc, 'w1', 'wall').footprint), 10000 * 200);
    const win = (alongMm: number): BimElement => ({
      id: `win${alongMm}`,
      kind: 'window',
      typeId: 't-window-600',
      hostId: 'w1',
      alongMm,
      sillMm: 900,
      flipFacing: false,
    });
    doc.elements.push(win(3500));
    expect(codes(doc)).toEqual(['opening-in-join']);
    doc.elements.pop();
    doc.elements.push(win(3300)); // 3300–3900 ends before 3900 (the stopping wall's face)
    expect(errors(doc)).toEqual([]);
    const wrongThrough = structuredClone(doc);
    wrongThrough.joins[0].through = 'w2';
    expect(codes(wrongThrough)).toEqual(['join-through']);
    const tooTall = structuredClone(doc);
    (tooTall.elements[1] as BimWall).top = { level: 'l-2f', offsetMm: 500 };
    expect(codes(tooTall)).toEqual(['join-height-mismatch']);
  });
  it('refuses crossings, a third wall at a joined point, arcs and parallel walls', () => {
    const cross = twoWalls(
      [
        [0, 0],
        [10000, 0],
      ],
      [
        [5000, -2000],
        [5000, 2000],
      ],
    );
    cross.joins = [{ id: 'j', walls: ['w1', 'w2'], kind: 'butt', through: 'w1' }];
    expect(codes(cross)).toEqual(['join-not-touching']);
    const three = twoWalls(
      [
        [0, 0],
        [5000, 0],
      ],
      [
        [5000, 0],
        [5000, 4000],
      ],
    );
    three.elements.push({ ...(three.elements[1] as BimWall), id: 'w3', end: { xy: [9000, 0] } });
    three.joins = [
      { id: 'j1', walls: ['w1', 'w2'], kind: 'butt', through: 'w1' },
      { id: 'j2', walls: ['w3', 'w2'], kind: 'butt', through: 'w3' },
    ];
    expect(codes(three)).toEqual(['join-unsupported']);
    // An arc wall joins only at an end (OH-U3): its end inside a straight wall is no T.
    const arc = twoWalls(
      [
        [0, 0],
        [10000, 0],
      ],
      [
        [5000, 0],
        [5000, 4000],
      ],
    );
    (arc.elements[1] as BimWall).bulge = 0.2;
    arc.joins = [{ id: 'j', walls: ['w1', 'w2'], kind: 'butt' }];
    expect(codes(arc)).toEqual(['join-unsupported']);
    expect(proposeJoins(arc, 'w2')).toEqual([]);
    const parallel = twoWalls(
      [
        [0, 0],
        [5000, 0],
      ],
      [
        [5000, 0],
        [9000, 0],
      ],
    );
    parallel.joins = [{ id: 'j', walls: ['w1', 'w2'], kind: 'butt' }];
    expect(codes(parallel)).toEqual(['join-failed']);
  });
  it('joins arc walls at their ends, corners where the faces meet, butt and miter (OH-U3)', () => {
    /** The centre and radius of each face of an arc wall (200 mm, centred on its axis). */
    const faces = (w: BimWall) => {
      const [s, e] = [w.start, w.end].map((p) => (p as { xy: Vec2 }).xy) as [Vec2, Vec2];
      const sweep = 4 * Math.atan(w.bulge!);
      const c = Math.hypot(e[0] - s[0], e[1] - s[1]);
      const r = c / (2 * Math.abs(Math.sin(sweep / 2)));
      const u = [(e[0] - s[0]) / c, (e[1] - s[1]) / c];
      const h = c / 2 / Math.tan(sweep / 2);
      const centre = [(s[0] + e[0]) / 2 - u[1] * h, (s[1] + e[1]) / 2 + u[0] * h];
      return { centre, radii: [r - 100, r + 100] };
    };
    const onFace = (w: BimWall, p: number[]) => {
      const { centre, radii } = faces(w);
      const d = Math.hypot(p[0]! - centre[0]!, p[1]! - centre[1]!);
      return Math.min(...radii.map((r) => Math.abs(d - r)));
    };
    // A straight wall, then an arc wall turning up from its end: the drawing proposes the L.
    const doc = twoWalls(
      [
        [0, 0],
        [5000, 0],
      ],
      [
        [5000, 0],
        [5000, 4000],
      ],
    );
    const arc = element<BimWall>(doc, 'w2');
    arc.bulge = 0.2;
    expect(proposeJoins(doc, 'w2')).toEqual([{ walls: ['w1', 'w2'], kind: 'butt', through: 'w1' }]);
    doc.joins = [{ id: 'j', walls: ['w1', 'w2'], kind: 'butt', through: 'w1' }];
    expect(errors(doc)).toEqual([]);
    // The arc wall stops on the straight wall's face (y = 100), each point on its own face arc.
    const fa = shape(doc, 'w2', 'wall').footprint;
    const starts = fa.filter((v) => Math.abs(v[1] - 100) < 1e-6);
    expect(starts).toHaveLength(2);
    for (const p of starts) expect(onFace(arc, p)).toBeLessThan(1e-6);
    // Its face arcs run from the cut to the far end; the volume is its footprint's.
    for (const v of fa) expect(Math.abs(v[2] ?? 0)).toBeLessThanOrEqual(1);
    const height = 3000;
    close(q(doc, 'w2').netVolume!, Math.abs(loopArea(fa)) * height, 1e-3);
    // The straight wall runs to the arc wall's far face: its tangent at the end, 100 mm out.
    const fb = shape(doc, 'w1', 'wall').footprint;
    const xEnd = Math.max(...fb.map((v) => v[0]));
    expect(xEnd).toBeGreaterThan(5000);
    expect(xEnd).toBeLessThan(5300);
    const corner = fb.filter((v) => v[0] > 5000);
    expect(corner).toHaveLength(2);
    for (const p of corner) expect(onFace(arc, p)).toBeLessThan(1e-6);
    // A window in the joined corner of the arc wall is in the join; further along it is not.
    const win = (alongMm: number): BimElement => ({
      id: 'win',
      kind: 'window',
      typeId: 't-window-600',
      hostId: 'w2',
      alongMm,
      sillMm: 900,
      flipFacing: false,
    });
    doc.elements.push(win(0));
    expect(codes(doc)).toEqual(['opening-in-join']);
    doc.elements[2] = win(1500);
    expect(errors(doc)).toEqual([]);

    // Two arc walls mitred: both end on one line, each on its own face arcs.
    const two = twoWalls(
      [
        [0, 0],
        [6000, 0],
      ],
      [
        [6000, 0],
        [6000, 6000],
      ],
      [{ bulge: -0.3 }, { bulge: 0.3 }],
    );
    expect(proposeJoins(two, 'w2')).toEqual([{ walls: ['w1', 'w2'], kind: 'butt', through: 'w1' }]);
    two.joins = [{ id: 'j', walls: ['w1', 'w2'], kind: 'miter' }];
    expect(errors(two)).toEqual([]);
    const ends = (id: string) =>
      shape(two, id, 'wall').footprint.filter((v) => Math.hypot(v[0] - 6000, v[1]) < 500);
    const [e1, e2] = [ends('w1'), ends('w2')];
    expect(e1).toHaveLength(2);
    expect(e2).toHaveLength(2);
    for (const [w, ps] of [
      ['w1', e1],
      ['w2', e2],
    ] as const)
      for (const p of ps) expect(onFace(element<BimWall>(two, w), p)).toBeLessThan(1e-6);
    // They share their two corners, where inner faces and outer faces meet.
    const key = (ps: number[][]) => ps.map((p) => `${p[0]!.toFixed(6)},${p[1]!.toFixed(6)}`).sort();
    expect(key(e1)).toEqual(key(e2));

    // Faces that meet twice: the nearest crossings may cross the faces; that join fails.
    const twice = twoWalls(
      [
        [-400, 0],
        [0, 0],
      ],
      [
        [0, 0],
        [0, 700],
      ],
      [{ bulge: 0.2 }, { bulge: 0.6 }],
    );
    twice.joins = [{ id: 'j', walls: ['w1', 'w2'], kind: 'butt', through: 'w1' }];
    expect(codes(twice)).toContain('join-failed');
    for (const e of deriveBim(twice).diagnostics) expect(e.code).toBe('join-failed');

    // Arcs that nearly run on (a shallow corner, here 1.6°): a butt's faces would meet far back,
    // so the drawing proposes a miter, which is clean; the butt fails rather than build crossed.
    const shallow = twoWalls(
      [
        [15000, -62000],
        [52000, 0],
      ],
      [
        [52000, 0],
        [15000, 62000],
      ],
      [{ bulge: 0.2684 }, { bulge: 0.2684 }],
    );
    expect(proposeJoins(shallow, 'w2')).toEqual([{ walls: ['w2', 'w1'], kind: 'miter' }]);
    shallow.joins = [{ id: 'j', walls: ['w2', 'w1'], kind: 'miter' }];
    expect(errors(shallow)).toEqual([]);
    shallow.joins = [{ id: 'j', walls: ['w1', 'w2'], kind: 'butt', through: 'w1' }];
    expect(codes(shallow)).toContain('join-failed');
    // Walls located differently on their axes at a shallow corner are not joined.
    element<BimWall>(shallow, 'w2').location = 'left';
    expect(proposeJoins(shallow, 'w2')).toEqual([]);

    // An arc that runs on from the other wall's end in its direction is no corner.
    const smooth = twoWalls(
      [
        [-5000, 0],
        [5000, 0],
      ],
      [
        [5000, 0],
        [-5000, 0],
      ],
      [{ bulge: 1 }, { bulge: 1 }],
    );
    expect(proposeJoins(smooth, 'w2')).toEqual([]);
    smooth.joins = [{ id: 'j', walls: ['w1', 'w2'], kind: 'butt' }];
    expect(codes(smooth)).toEqual(['join-failed']);
  });

  it('resolves the wall a butt join runs through', () => {
    const doc = twoWalls(
      [
        [0, 0],
        [10000, 0],
      ],
      [
        [4000, 0],
        [4000, 3000],
      ],
    );
    expect(bimJoinThrough(doc, { id: 'j', walls: ['w2', 'w1'], kind: 'butt' })).toBe('w1');
    expect(bimJoinThrough(doc, { id: 'j', walls: ['w1', 'w2'], kind: 'butt' })).toBe('w1');
    expect(bimJoinThrough(doc, { id: 'j', walls: ['w1', 'w2'], kind: 'miter' })).toBeUndefined();
  });
  it('proposes joins for touching walls', () => {
    const doc = twoWalls(
      [
        [0, 0],
        [10000, 0],
      ],
      [
        [4000, 0],
        [4000, 3000],
      ],
    );
    expect(proposeJoins(doc, 'w2')).toEqual([{ walls: ['w1', 'w2'], kind: 'butt', through: 'w1' }]);
    expect(proposeJoins(doc, 'w1')).toEqual([{ walls: ['w1', 'w2'], kind: 'butt', through: 'w1' }]);
    const box = f31BoxBuilding();
    expect(proposeJoins(box, 'w-south')).toEqual([]);
    // Walls on other storeys are not candidates.
    expect(proposeJoins(f37Office(), 'w-s-1')).toEqual([]);
    // A straight continuation needs no join, and none would apply.
    const line = twoWalls(
      [
        [0, 0],
        [5000, 0],
      ],
      [
        [5000, 0],
        [9000, 0],
      ],
    );
    expect(proposeJoins(line, 'w1')).toEqual([]);
    expect(proposeJoins(line, 'w2')).toEqual([]);
    // Of an L with walls of different heights, the taller one runs through.
    const tall = twoWalls(
      [
        [0, 0],
        [5000, 0],
      ],
      [
        [5000, 0],
        [5000, 4000],
      ],
      [{}, { top: { heightMm: 1500 } }],
    );
    const join: Omit<BimWallJoin, 'id'> = { walls: ['w1', 'w2'], kind: 'butt', through: 'w1' };
    expect(proposeJoins(tall, 'w1')).toEqual([join]);
    expect(proposeJoins(tall, 'w2')).toEqual([join]);
    tall.joins = [{ id: 'j', ...join }];
    expect(errors(tall)).toEqual([]);
  });
});

describe('openings (CAD62)', () => {
  it('refuses openings outside the host, overlapping or in a corner join', () => {
    const out = f31BoxBuilding();
    (element(out, 'win-e1') as { alongMm: number }).alongMm = 7000;
    expect(codes(out)).toEqual(['opening-outside-host']);
    const over = f31BoxBuilding();
    (element(over, 'win-n2') as { alongMm: number }).alongMm = 2000;
    expect(codes(over)).toEqual(['opening-overlap']);
    const corner = f31BoxBuilding();
    (element(corner, 'win-n1') as { alongMm: number }).alongMm = 0;
    expect(codes(corner)).toEqual(['opening-in-join']);
    const tall = f31BoxBuilding();
    (element(tall, 'win-e1') as { sillMm: number }).sillMm = 5000;
    expect(codes(tall)).toEqual(['opening-outside-host']);
  });
  it('cuts slab openings and refuses overlapping or escaping ones', () => {
    const doc = f31BoxBuilding();
    const opening = (id: string, x: number): BimElement => ({
      id,
      kind: 'opening',
      hostId: 's-2f',
      slab: {
        boundary: [
          [x, 1000],
          [x + 1000, 1000],
          [x + 1000, 2000],
          [x, 2000],
        ],
      },
    });
    doc.elements.push(opening('o1', 1000));
    expect(errors(doc)).toEqual([]);
    close(q(doc, 's-2f').netArea, 9800 * 7800 - 3000 * 2000 - 1000 * 1000);
    doc.elements.push(opening('o2', 1500));
    expect(codes(doc)).toEqual(['opening-overlap']);
    doc.elements.pop();
    doc.elements.push(opening('o3', 9500));
    expect(codes(doc)).toEqual(['opening-outside-host']);
  });
  it("leaves a space's holes out of its area and volume, and refuses escaping ones (TW1)", () => {
    const doc = f31BoxBuilding();
    const hall = doc.elements.find((e) => e.id === 'sp-hall') as Extract<
      BimElement,
      { kind: 'space' }
    >;
    const square = (x: number, y: number, side: number): BimLoop => [
      [x, y],
      [x + side, y],
      [x + side, y + side],
      [x, y + side],
    ];
    hall.holes = [square(4000, 3000, 2000)];
    expect(errors(doc)).toEqual([]);
    close(q(doc, 'sp-hall').netFloorArea, 9800 * 7800 - 2000 * 2000);
    close(q(doc, 'sp-hall').netVolume, (9800 * 7800 - 2000 * 2000) * 3000);
    expect(shape(doc, 'sp-hall', 'space').holes).toHaveLength(1);
    hall.holes.push(square(5000, 4000, 2000));
    expect(codes(doc)).toEqual(['hole-overlap']);
    hall.holes = [square(9000, 3000, 2000)];
    expect(codes(doc)).toEqual(['hole-outside']);
    hall.holes = Array.from({ length: 17 }, (_, i) => square(200 + i * 500, 200, 100));
    expect(codes(doc)).toEqual(['holes']);
  });
  it('checks slab openings against the exact arcs', () => {
    const doc = f31BoxBuilding();
    element<Extract<BimElement, { kind: 'slab' }>>(doc, 's-1f').boundary = [
      [5000, 0, 1],
      [-5000, 0],
      [0, -5000],
    ];
    const square = (x: number, y: number): BimElement => ({
      id: 'o-near',
      kind: 'opening',
      hostId: 's-1f',
      slab: {
        boundary: [
          [x - 5, y - 5],
          [x + 5, y - 5],
          [x + 5, y + 5],
          [x - 5, y + 5],
        ],
      },
    });
    // Inside the semicircle, outside its 16-piece polygon.
    doc.elements.push(square(4965.97, 489.11));
    expect(errors(doc)).toEqual([]);
    doc.elements.pop();
    doc.elements.push(square(4995, 489.11));
    expect(codes(doc)).toEqual(['opening-outside-host']);
    // An opening with an arc side, inside the slab.
    doc.elements.pop();
    doc.elements.push({
      id: 'o-arc',
      kind: 'opening',
      hostId: 's-1f',
      slab: {
        boundary: [
          [4000, 0, 1],
          [3000, 0],
          [3500, -300],
        ],
      },
    });
    expect(errors(doc)).toEqual([]);
  });
  it('refuses a self-intersecting slab', () => {
    const doc = f31BoxBuilding();
    element<Extract<BimElement, { kind: 'slab' }>>(doc, 's-1f').boundary = [
      [0, 0],
      [1000, 1000],
      [1000, 0],
      [0, 1000],
    ];
    expect(codes(doc)).toEqual(['loop-self-intersection']);
    // A side that crosses an arc between its 16 samples.
    const arc = f31BoxBuilding();
    const slab = element<Extract<BimElement, { kind: 'slab' }>>(arc, 's-1f');
    slab.boundary = [
      [5000, 0, 1],
      [-5000, 0],
      [-6000, 6000],
      [-788.151, 4941.543],
      [-191.04, 5000.353],
      [6000, 6000],
    ];
    slab.holes = [];
    expect(codes(arc)).toEqual(['loop-self-intersection']);
    // Consecutive sides that fold back, and a side tangent to the next arc, which is fine.
    slab.boundary = [
      [0, 0],
      [4000, 0],
      [2000, 0],
      [2000, 3000],
    ];
    expect(codes(arc)).toEqual(['loop-self-intersection']);
    slab.boundary = [
      [-4000, -4000],
      [4000, -4000],
      [4000, 0, 1],
      [-4000, 0],
    ];
    expect(errors(arc)).toEqual([]);
  });
  it('keeps resolved elevations within the coordinate limit', () => {
    const doc = f31BoxBuilding();
    const wall = element<BimWall>(doc, 'w-south');
    wall.base.offsetMm = 1_000_000;
    wall.top = { heightMm: 1_000_000 };
    expect(codes(doc)).toContain('coordinate');
    // A slab's underside, below its top by the thickness.
    const low = f31BoxBuilding();
    element<Extract<BimElement, { kind: 'slab' }>>(low, 's-1f').top = {
      level: 'l-1f',
      offsetMm: -1_000_000,
    };
    expect(codes(low)).toContain('coordinate');
    // A mono-pitch roof's rise.
    const roof = f31BoxBuilding();
    const r = element<Extract<BimElement, { kind: 'roof' }>>(roof, 'r-roof');
    r.base.offsetMm = 993_000;
    r.shape = { form: 'mono', slopeRad: Math.PI / 6, directionRad: 0 };
    expect(codes(roof)).toContain('coordinate');
    // A beam's underside, below its top by the section's depth.
    const office = f37Office();
    const beam = office.elements.find((x) => x.kind === 'beam')!;
    (beam as { top: { level: string; offsetMm: number } }).top = {
      level: 'l-1f',
      offsetMm: -1_000_000,
    };
    expect(codes(office)).toContain('coordinate');
    // A slab boundary whose arc reaches past the limit between vertices.
    const arc = f31BoxBuilding();
    const slab = element<Extract<BimElement, { kind: 'slab' }>>(arc, 's-1f');
    slab.boundary = [
      [-500_000, 1_000_000, -1],
      [500_000, 1_000_000],
      [0, 500_000],
    ];
    slab.holes = [];
    expect(codes(arc)).toContain('coordinate');
  });
});

describe('types, levels and grids follow (CAD63)', () => {
  it('changes every window of a type in one edit', () => {
    const s = session(f33Types());
    const before = s.content;
    expect(q(before, 'w-long').openingArea).toBe(40 * 600 * 1200);
    const t = structuredClone(before.types.find((x) => x.id === 't-window-600')!);
    (t as { widthMm: number }).widthMm = 800;
    exec(s, { type: 'update', collection: 'types', entity: t });
    expect(q(s.content, 'w-long').openingArea).toBe(40 * 800 * 1200);
    (t as { widthMm: number }).widthMm = 1100; // now the windows overlap
    expect(() => exec(s, { type: 'update', collection: 'types', entity: t })).toThrow(
      /opening-overlap/,
    );
    s.undo();
    expect(s.content).toEqual(before);
  });
  it('follows a storey height change and a grid move', () => {
    const doc = f37Office();
    const derived = deriveBim(doc);
    expect(derived.diagnostics).toEqual([]);
    expect(doc.elements.filter((e) => e.kind === 'window')).toHaveLength(200);
    expect(doc.elements.filter((e) => e.kind === 'door')).toHaveLength(60);
    const raised = applyBimOperation(doc, {
      type: 'update',
      collection: 'levels',
      entity: { id: 'l-3f', name: '3F', elevationMm: 8500 },
    });
    expect(q(raised, 'c-2-1-1').length).toBe(4500);
    expect(shape(raised, 'c-3-1-1', 'column').zBase).toBe(8500);
    expect(q(raised, 'c-3-1-1').length).toBe(3500);
    expect(q(raised, 'w-s-2').height).toBe(4500);
    expect(q(raised, 'sp-2-s').height).toBe(4500);
    const moved = applyBimOperation(doc, {
      type: 'update',
      collection: 'grids',
      entity: { id: 'g-x2', label: 'X2', start: [7500, -3000], end: [7500, 31800] },
    });
    expect(shape(moved, 'c-1-2-3', 'column').at).toEqual([7500, 14400]);
    expect(q(moved, 'b-2-x1-1').length).toBe(7500);
    const skew = structuredClone(doc);
    skew.grids.find((g) => g.id === 'g-x2')!.end = [7200, 31800];
    skew.grids.find((g) => g.id === 'g-x2')!.start = [7200, -3000];
    (skew.elements.find((e) => e.id === 'c-1-1-1') as { at: unknown }).at = {
      grid: ['g-x1', 'g-x2'],
    };
    expect(codes(skew)).toEqual(['grid-no-intersection']);
  });
  it('refuses a top below the base', () => {
    const doc = f31BoxBuilding();
    element<BimWall>(doc, 'w-south').top = { level: 'l-1f', offsetMm: -10 };
    expect(codes(doc)).toContain('level-order');
  });
});

describe('operations', () => {
  it('refuses deleting what is used unless cascading', () => {
    const doc = f31BoxBuilding();
    let err: unknown;
    try {
      applyBimOperation(doc, { type: 'delete', ids: ['w-north'], cascade: false });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BimOperationError);
    expect((err as BimOperationError).code).toBe('in-use');
    expect(new Set((err as BimOperationError).dependents)).toEqual(
      new Set(['win-n1', 'win-n2', 'win-n3', 'j-ne', 'j-nw']),
    );
    const next = applyBimOperation(doc, { type: 'delete', ids: ['w-north'], cascade: true });
    expect(next.elements.some((e) => e.id === 'win-n1')).toBe(false);
    expect(next.joins.map((j) => j.id)).toEqual(['j-se', 'j-sw']);
    expect(bimDependents(doc, ['l-2f'])).toEqual(['s-2f']);
    expect(doc.elements.some((e) => e.id === 'w-north')).toBe(true);
  });
  it('keeps the element kind on update and validates atomically', () => {
    const doc = f31BoxBuilding();
    expect(() =>
      applyBimOperation(doc, {
        type: 'update',
        collection: 'elements',
        entity: { ...element<BimElement>(doc, 'r-roof'), kind: 'space' } as never,
      }),
    ).toThrow('update-kind');
    expect(() =>
      applyBimOperation(doc, {
        type: 'insert',
        entities: { levels: [{ id: 'w-south', name: 'x', elevationMm: 9000 }] },
      }),
    ).toThrow(/duplicate-id/);
  });
  it('runs as editor commands with base and authority checks', () => {
    const s = session(f31BoxBuilding());
    const before = s.content;
    exec(s, {
      type: 'setProject',
      project: { name: 'Box', trueNorthRad: 0.1, siteElevationMm: 12 },
    });
    expect(s.content.project.name).toBe('Box');
    expect(() => exec(s, { type: 'setProject', project: before.project }, () => false)).toThrow(
      'permission-denied',
    );
    const stale = bimEditorCommand(
      { type: 'setProject', project: before.project },
      { expectedHash: bimContentHash(before), canEdit: () => true },
    );
    expect(() => s.execute(stale)).toThrow('bim-base-mismatch');
    expect(() =>
      bimEditorCommand({ type: 'delete', ids: [], cascade: false } as never, {
        expectedHash: '',
        canEdit: () => true,
      }),
    ).toThrow('operation-schema');
    expect(() =>
      bimEditorCommand({ type: 'eval' } as never, { expectedHash: '', canEdit: () => true }),
    ).toThrow('unsupported-operation');
    s.undo();
    expect(s.content).toEqual(before);
  });
});

describe('properties (R2c-U8)', () => {
  it('checks property values against their sets and refuses reserved names', () => {
    const doc = f31BoxBuilding();
    doc.propertySets = [
      {
        id: 'ps-finish',
        name: 'Finish',
        properties: [
          { name: 'Code', type: 'string' },
          { name: 'Thickness', type: 'length' },
        ],
      },
    ];
    element<BimWall>(doc, 'w-south').properties = { 'ps-finish': { Code: 'W-1', Thickness: 20 } };
    expect(errors(doc)).toEqual([]);
    element<BimWall>(doc, 'w-south').properties = { 'ps-finish': { Code: 3 } };
    expect(codes(doc)).toEqual(['property-value']);
    element<BimWall>(doc, 'w-south').properties = { 'ps-finish': { Colour: 'red' } };
    expect(codes(doc)).toEqual(['property-unknown']);
    for (const name of ['EP_Constraints', 'Pset_WallCommon', 'Qto_WallBaseQuantities']) {
      const r = structuredClone(doc);
      r.propertySets[0].name = name;
      element<BimWall>(r, 'w-south').properties = undefined as never;
      delete element<BimWall>(r, 'w-south').properties;
      expect(codes(r)).toEqual(['property-name-reserved']);
    }
    // Empty records are refused, not kept: IFC holds no empty property set (R2c-4b).
    element<BimWall>(doc, 'w-south').properties = { 'ps-finish': {} };
    expect(codes(doc)).toEqual(['properties']);
    element<BimWall>(doc, 'w-south').properties = {};
    expect(codes(doc)).toEqual(['properties']);
    delete element<BimWall>(doc, 'w-south').properties;
    element<BimWall>(doc, 'w-south').common = {};
    expect(codes(doc)).toEqual(['common-properties']);
    delete element<BimWall>(doc, 'w-south').common;
    doc.propertySets[0].properties = [];
    expect(codes(doc)).toEqual(['property-set']);
  });
  it('drops a deleted property set’s values only when cascading', () => {
    const doc = f31BoxBuilding();
    doc.propertySets = [
      { id: 'ps', name: 'Finish', properties: [{ name: 'Code', type: 'string' }] },
    ];
    element<BimWall>(doc, 'w-south').properties = { ps: { Code: 'W-1' } };
    expect(() => applyBimOperation(doc, { type: 'delete', ids: ['ps'], cascade: false })).toThrow(
      'in-use',
    );
    const next = applyBimOperation(doc, { type: 'delete', ids: ['ps'], cascade: true });
    expect(element<BimWall>(next, 'w-south').properties).toBeUndefined();
    expect(next.elements).toHaveLength(doc.elements.length);
  });
  it('deletes a property set together with everything that uses it', () => {
    const doc = f33Types();
    doc.propertySets = [
      { id: 'ps', name: 'Finish', properties: [{ name: 'Code', type: 'string' }] },
    ];
    const door = doc.types.find((t) => t.kind === 'door')!;
    door.properties = { ps: { Code: 'D-1' } };
    const next = applyBimOperation(doc, { type: 'delete', ids: ['ps', door.id], cascade: false });
    expect(next.propertySets).toEqual([]);
    expect(next.types.some((t) => t.id === door.id)).toBe(false);
  });
});

describe('inclined members (TW2, F40)', () => {
  const doc = f40Lattice();
  const box = 300 * 300 - 276 * 276;
  const round = Math.PI * 200 * 200;
  it('validates the leaning column, the sloping beam and the members', () => {
    expect(errors(doc)).toEqual([]);
    expect(deriveBim(doc).diagnostics).toEqual([]);
  });
  it('refuses bad member ends, keys and types', () => {
    const bad = structuredClone(doc);
    const m = element<Extract<BimElement, { kind: 'member' }>>(bad, 'm-diag');
    (m.start as unknown as Record<string, unknown>).extra = 1;
    expect(codes(bad)).toContain('member-end');
    const wrongType = structuredClone(doc);
    element<Extract<BimElement, { kind: 'member' }>>(wrongType, 'm-diag').typeId = 't-column-600';
    expect(codes(wrongType).length).toBeGreaterThan(0);
    const extraKey = structuredClone(doc);
    (element(extraKey, 'm-vert') as unknown as Record<string, unknown>).base = {
      level: 'l-gl',
      offsetMm: 0,
    };
    expect(codes(extraKey).length).toBeGreaterThan(0);
    const column = structuredClone(doc);
    (element(column, 'c-lean') as unknown as Record<string, unknown>).topAt = { xy: [1, 2, 3] };
    expect(codes(column).length).toBeGreaterThan(0);
    const beam = structuredClone(doc);
    (element(beam, 'b-slope') as unknown as Record<string, unknown>).endTop = {
      level: 'l-x',
      offsetMm: 0,
    };
    expect(codes(beam).length).toBeGreaterThan(0);
  });
  it('refuses a member of zero length, and keeps horizontal ones', () => {
    const zero = structuredClone(doc);
    const m = element<Extract<BimElement, { kind: 'member' }>>(zero, 'm-diag');
    m.end = structuredClone(m.start);
    expect(deriveBim(zero).diagnostics.map((d) => d.code)).toContain('member-degenerate');
    expect(deriveBim(doc).shapes.get('m-flat')!.kind).toBe('member');
  });
  it('computes lengths and volumes along the axes', () => {
    close(profileArea({ shape: 'box', depthMm: 300, widthMm: 300, wallMm: 12 }), box);
    const lean = q(doc, 'c-lean');
    close(lean.length, Math.hypot(2000, 6000));
    close(lean.netVolume, 600 * 600 * Math.hypot(2000, 6000));
    const slope = q(doc, 'b-slope');
    close(slope.length, Math.hypot(6000, 1500));
    close(slope.netVolume, 400 * 700 * Math.hypot(6000, 1500));
    const diag = q(doc, 'm-diag');
    close(diag.length, Math.hypot(4000, 3000, 6000));
    close(diag.crossSectionArea, box);
    close(diag.netVolume, box * Math.hypot(4000, 3000, 6000), 1e-3);
    close(q(doc, 'm-vert').netVolume, round * 6000, 1e-3);
    close(q(doc, 'm-flat').length, 6000);
    close(q(doc, 'm-grid').length, Math.hypot(2000, 3000, 6000));
    expect(shape(doc, 'm-grid', 'member').start).toEqual([10000, 0, 0]);
    // A level column and a level beam keep their shapes as before.
    const level = structuredClone(doc);
    delete element<Extract<BimElement, { kind: 'column' }>>(level, 'c-lean').topAt;
    delete element<Extract<BimElement, { kind: 'beam' }>>(level, 'b-slope').endTop;
    expect(shape(level, 'c-lean', 'column').topAt).toBeUndefined();
    expect(shape(level, 'b-slope', 'beam').zTopEnd).toBeUndefined();
  });
  it('places sections on orthonormal axes', () => {
    const derived = deriveBim(doc);
    const d3 = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
    for (const id of ['c-lean', 'b-slope', 'm-diag', 'm-vert', 'm-flat', 'm-grid']) {
      const s = derived.shapes.get(id)! as Extract<
        BimShape,
        { kind: 'column' | 'beam' | 'member' }
      >;
      const a = bimSectionAxes(s);
      for (const v of [a.x, a.y, a.z]) close(d3(v, v), 1);
      close(d3(a.x, a.y), 0);
      close(d3(a.y, a.z), 0);
      close(d3(a.x, a.z), 0);
    }
    const flat = bimSectionAxes(shape(doc, 'm-flat', 'member'));
    // A horizontal member: width level, depth upright.
    close(flat.x[2], 0);
    close(flat.y[2], 1);
    const beam = bimSectionAxes(shape(doc, 'b-slope', 'beam'));
    close(beam.origin[2], 6000 - 350);
    close(beam.length, Math.hypot(6000, 1500));
    close(beam.x[2], 0);
    const diag = bimSectionAxes(shape(doc, 'm-diag', 'member'));
    // Turned 0.3 rad about the axis from the level direction square to it.
    const lv = [-diag.z[1], diag.z[0], 0];
    const n = Math.hypot(lv[0]!, lv[1]!);
    close(d3(diag.x, [lv[0]! / n, lv[1]! / n, 0]), Math.cos(0.3));
    expect(diag.x[2]).toBeGreaterThan(0);
  });
});

describe('tapered columns (TW5, F47)', () => {
  const doc = f47Taper();
  // Similar sections scaled linearly by k: V = A·L·(1 + k + k²)/3.
  const frustum = (a: number, l: number, k: number) => (a * l * (1 + k + k * k)) / 3;
  it('validates them and refuses a top scale out of 0.1–1', () => {
    expect(errors(doc)).toEqual([]);
    expect(deriveBim(doc).diagnostics).toEqual([]);
    // A value that is no number at all is refused as such (`number`) first.
    for (const bad of [0.05, 1.2, '0.5']) {
      const d = structuredClone(doc);
      (element(d, 'c-square') as unknown as Record<string, unknown>).topScale = bad;
      expect(codes(d), String(bad)).toContain('column-scale');
    }
  });
  it('computes the volume of the scaled section along the axis', () => {
    close(q(doc, 'c-square').netVolume, frustum(600 * 600, 6000, 0.5));
    close(q(doc, 'c-square').crossSectionArea, 600 * 600);
    close(q(doc, 'c-round').netVolume, frustum(Math.PI * 600 * 600, 6000, 0.25));
    close(q(doc, 'c-box').netVolume, frustum(800 * 800 - 720 * 720, 6000, 0.75));
    const L = Math.hypot(1500, 6000);
    close(q(doc, 'c-lean').length, L);
    close(q(doc, 'c-lean').netVolume, frustum(600 * 600, L, 0.6));
    expect(shape(doc, 'c-lean', 'column')).toMatchObject({ topScale: 0.6, topAt: [1500, 4000] });
    // A top scale of 1 is no taper.
    const one = structuredClone(doc);
    element<Extract<BimElement, { kind: 'column' }>>(one, 'c-square').topScale = 1;
    expect(shape(one, 'c-square', 'column').topScale).toBeUndefined();
    close(q(one, 'c-square').netVolume, 600 * 600 * 6000);
  });
});

describe('steel pipes (#936, F49)', () => {
  const doc = f49Pipes();
  const ring = (d: number, t: number) => (Math.PI * (d * d - (d - 2 * t) * (d - 2 * t))) / 4;
  it('validates them and refuses a wall of half the diameter or more', () => {
    expect(errors(doc)).toEqual([]);
    expect(deriveBim(doc).diagnostics).toEqual([]);
    for (const wall of [300, 400]) {
      const d = structuredClone(doc);
      (d.types.find((t) => t.id === 't-column-pipe') as { profile: object }).profile = {
        shape: 'pipe',
        diameterMm: 600,
        wallMm: wall,
      };
      expect(codes(d), String(wall)).toContain('profile-proportion');
    }
    const missing = structuredClone(doc);
    (missing.types.find((t) => t.id === 't-member-pipe') as { profile: object }).profile = {
      shape: 'pipe',
      diameterMm: 300,
    };
    expect(codes(missing).length).toBeGreaterThan(0);
  });
  it('gives the ring area and volume, a tapered one with its wall scaled too', () => {
    close(q(doc, 'c-pipe').crossSectionArea, ring(600, 25));
    close(q(doc, 'c-pipe').netVolume, ring(600, 25) * 6000);
    // Every size scales by k, so the area by k²: V = A·L·(1 + k + k²)/3.
    close(q(doc, 'c-pipe-taper').netVolume, (ring(600, 25) * 6000 * (1 + 0.5 + 0.25)) / 3);
    close(q(doc, 'm-pipe').netVolume, ring(300, 12) * Math.hypot(6000, 6000));
    expect(q(doc, 'b-pipe').netVolume).toBeGreaterThan(0);
  });
  it('makes the section an outer circle with a circular hole', () => {
    const { outer, holes } = bimProfileLoops({ shape: 'pipe', diameterMm: 600, wallMm: 25 });
    expect(outer).toEqual([
      [300, 0, 1],
      [-300, 0, 1],
    ]);
    expect(holes).toEqual([
      [
        [275, 0, 1],
        [-275, 0, 1],
      ],
    ]);
  });
});

describe('leaning walls (LR2, F50)', () => {
  const doc = f50Lean();
  type Wall = Extract<BimElement, { kind: 'wall' }>;
  const h = 4000;
  it('validates them and refuses a lean past 60°', () => {
    expect(errors(doc)).toEqual([]);
    expect(deriveBim(doc).diagnostics).toEqual([]);
    for (const bad of [1.2, -1.1, '0.2']) {
      const d = structuredClone(doc);
      (element(d, 'w-free') as unknown as Record<string, unknown>).lean = bad;
      expect(codes(d), String(bad)).toContain('wall-lean');
    }
    // LS1: a roof cuts a leaning wall (F54); its volume is then the kernel's.
    const roofed = f54LeanRoofs();
    expect(errors(roofed)).toEqual([]);
    const derived = deriveBim(roofed);
    expect(derived.diagnostics).toEqual([]);
    for (const id of ['w-sq-1', 'w-ring-1']) {
      const s = derived.shapes.get(id);
      expect(s?.kind === 'wall' && s.footprintTop && s.clipBy).toBeTruthy();
      expect(derived.quantities.get(id)?.source).toBe('kernel');
    }
    const graph = bimGeometry(roofed, derived);
    // The ruled loft, cut once by the mono roof's one plane.
    const sq = graph.elements.get('w-sq-1')!;
    expect(graph.graph.nodes[sq.node]).toMatchObject({ op: 'halfSpace', keep: 'below' });
    // LS2: an upright wall joined to a leaning one is ruled too (more in F54's joins).
    const mixed = structuredClone(doc);
    delete element<Wall>(mixed, 'w-l-2').lean;
    expect(deriveBim(mixed).diagnostics).toEqual([]);
    expect(shape(mixed, 'w-l-2', 'wall').footprintTop).toBeDefined();
    // A straight wall butting a leaning arc: the arc's end angle would change with the height.
    const arc = structuredClone(doc);
    arc.elements.push({
      ...element<Wall>(arc, 'w-free'),
      id: 'w-stub',
      start: { xy: [30000, 0] },
      end: { xy: [25000, 0] },
      lean: 0.3,
    });
    arc.joins.push({
      id: 'j-stub',
      walls: ['w-stub', 'w-ring-1'],
      kind: 'butt',
      through: 'w-ring-1',
    });
    expect(deriveBim(arc).diagnostics.map((d) => d.code)).toContain('wall-lean-join');
    // A T found at the base whose stop leans off the through wall's end by the top.
    const offEnd = structuredClone(doc);
    offEnd.elements.push({
      ...element<Wall>(offEnd, 'w-free'),
      id: 'w-tee',
      start: { xy: [5000, 0] },
      end: { xy: [5000, 4000] },
      lean: 0.6,
    });
    offEnd.joins.push({ id: 'j-tee', walls: ['w-free', 'w-tee'], kind: 'butt', through: 'w-free' });
    expect(deriveBim(offEnd).diagnostics.map((d) => [d.code, d.id])).toContainEqual([
      'wall-lean-join',
      'w-tee',
    ]);
    // A join that trims a short wall past its other end at the top only.
    const inverts = structuredClone(doc);
    element<Wall>(inverts, 'w-l-1').start = { xy: [17000, 10000] };
    element<Wall>(inverts, 'w-l-2').lean = -0.6;
    expect(deriveBim(inverts).diagnostics.map((d) => [d.code, d.id])).toContainEqual([
      'join-failed',
      'w-l-1',
    ]);
    // Upright (0) is no lean.
    const zero = structuredClone(doc);
    element<Wall>(zero, 'w-free').lean = 0;
    expect(shape(zero, 'w-free', 'wall').footprintTop).toBeUndefined();
  });
  it('moves the top across by height × tan, with the thickness square to the faces', () => {
    const t = Math.PI / 12;
    const free = shape(doc, 'w-free', 'wall');
    expect(free.lean).toBe(t);
    // Right of travel along +x is −y; the horizontal width is 200 / cos.
    const ys = (l: BimLoop) => l.map((v) => v[1]).sort((a, b) => a - b);
    const w = 200 / Math.cos(t);
    close(ys(free.footprint)[0]!, -w / 2);
    close(ys(free.footprintTop!)[0]!, -w / 2 - h * Math.tan(t));
    close(q(doc, 'w-free').netVolume, 6000 * w * h);
    close(q(doc, 'w-free').width, 200);
    close(q(doc, 'w-free').grossSideArea, (6000 * h) / Math.cos(t));
    // The mitred square leaning out: each side's centreline is 6,000 + 2·z·tan 0.2 long at z,
    // so its side area is its length at mid-height × the slant height.
    close(q(doc, 'w-sq-1').grossSideArea, ((6000 + h * Math.tan(0.2)) * h) / Math.cos(0.2), 1e-3);
    // The ring's quarter cones: a quarter of the circumference at mid-height × the slant.
    close(
      q(doc, 'w-ring-1').grossSideArea,
      ((Math.PI / 2) * (5000 + (h / 2) * Math.tan(0.3)) * h) / Math.cos(0.3),
      1e-3,
    );
  });
  it('gives the cone and the frustum their exact volumes', () => {
    // The ring: an annulus 2πr·w at radius r = 5,000 + z·tan 0.3.
    const w = 80 / Math.cos(0.3);
    const ring = [1, 2, 3, 4].reduce((n, i) => n + q(doc, `w-ring-${i}`).netVolume!, 0);
    close(ring, 2 * Math.PI * w * h * (5000 + (h * Math.tan(0.3)) / 2), 1e-3);
    // Each quarter's arcs keep their centre and angles (the square ends stay radial).
    const r1 = shape(doc, 'w-ring-1', 'wall');
    expect(r1.footprintTop!.map((v) => !!v[2])).toEqual(r1.footprint.map((v) => !!v[2]));
    // The square: a ring 8·a·w at half side a = 3,000 + z·tan 0.2.
    const ws = 200 / Math.cos(0.2);
    const sq = [1, 2, 3, 4].reduce((n, i) => n + q(doc, `w-sq-${i}`).netVolume!, 0);
    close(sq, 8 * ws * h * (3000 + (h * Math.tan(0.2)) / 2), 1e-3);
  });
});

describe('leaning walls joined to upright walls (LS2, F54)', () => {
  type Wall = Extract<BimElement, { kind: 'wall' }>;
  const t = Math.tan(0.2);
  // The leaning wall's north face: 100 ÷ cos 0.2 north of its axis at the base, then south.
  const face = (z: number) => 100 / Math.cos(0.2) - z * t;

  it('rules each upright wall between its ends at the base and the top, exactly', () => {
    const doc = f54LeanJoins();
    expect(errors(doc)).toEqual([]);
    const d = deriveBim(doc);
    expect(d.diagnostics).toEqual([]);
    for (const id of ['w-up-m', 'w-up-t', 'w-up-l']) {
      const s = shape(doc, id, 'wall');
      expect(s.lean).toBeUndefined();
      // Its end on the leaning face (the mitre's inner corner too), lower down the wall at the top.
      const ys = (l: BimLoop) => l.map((v) => v[1]).filter((y) => y < 1000);
      for (const y of ys(s.footprint)) expect(Math.abs(y)).toBeCloseTo(face(0), 6);
      expect(Math.max(...ys(s.footprintTop!))).toBeCloseTo(face(4000), 6);
      expect(d.quantities.get(id)?.source).toBe('analytic');
    }
    // The T: 200 wide, from the face up to y = 5,000, less its window.
    const q = d.quantities.get('w-up-t')!.values;
    expect(q.grossVolume).toBeCloseTo(200 * 4000 * (5000 - face(2000)), 0);
    expect(q.netVolume).toBeCloseTo(q.grossVolume! - 1800 * 200 * 1500, 0);
    // The T's window is cut from its ruled solid.
    const g = bimGeometry(doc, d);
    expect(g.graph.nodes[g.elements.get('w-up-t')!.node]).toMatchObject({ op: 'boolean' });
  });

  it('keeps an opening out of the join at every height of it', () => {
    const doc = f54LeanJoins();
    // At the base the join reaches 102 mm along the T; above, less.
    element<Extract<BimElement, { kind: 'window' }>>(doc, 'win-t').alongMm = 50;
    element<Extract<BimElement, { kind: 'window' }>>(doc, 'win-t').sillMm = 0;
    expect(deriveBim(doc).diagnostics.map((x) => [x.code, x.id])).toContainEqual([
      'opening-in-join',
      'win-t',
    ]);
  });

  it('joins a cone to an upright wall within 1 mm, measured by the kernel (LS-U1)', () => {
    const lean = f50Lean();
    const ring = element<Wall>(lean, 'w-ring-1');
    const up: Wall = {
      ...ring,
      id: 'w-up',
      typeId: 't-wall-200',
      start: { xy: [20000, 5000] },
      end: { xy: [20000, 9000] },
    };
    delete up.bulge;
    delete up.lean;
    lean.elements = [ring, up];
    lean.joins = [{ id: 'j', walls: ['w-ring-1', 'w-up'], kind: 'butt', through: 'w-ring-1' }];
    const d = deriveBim(lean);
    expect(d.diagnostics).toEqual([]);
    // A plane meets a cone in a curve: ruled to within 1 mm, not exactly.
    for (const id of ['w-ring-1', 'w-up']) expect(d.quantities.get(id)?.source).toBe('kernel');
    // Its uncut solid is measured for the gross volume too (Codex).
    for (const id of ['w-ring-1', 'w-up'])
      expect(bimGeometry(lean, d).elements.get(id)?.gross).toBeDefined();
    // An upright arc of 8,000 mm whose end follows a straight wall leaning 0.1 rad: 2.5 mm off.
    const far = f54LeanJoins();
    const base = element<Wall>(far, 'w-lean');
    far.elements = [
      {
        ...base,
        id: 'w-arc',
        start: { xy: [8000, 0] },
        end: { xy: [0, 8000] },
        bulge: Math.tan(Math.PI / 8),
        lean: undefined,
      },
      { ...base, id: 'w-st', start: { xy: [0, 8000] }, end: { xy: [0, 12000] }, lean: 0.1 },
    ] as Wall[];
    far.joins = [{ id: 'j', walls: ['w-arc', 'w-st'], kind: 'butt', through: 'w-st' }];
    expect(deriveBim(far).diagnostics.map((x) => [x.code, x.id])).toContainEqual([
      'wall-lean-join',
      'w-arc',
    ]);
    // An upright half circle whose end follows a through wall leaning −0.03 rad: its top
    // footprint's arcs pass a half circle (|bulge| > 1), which no loft takes (Codex).
    const half = f54LeanJoins();
    const hb = element<Wall>(half, 'w-lean');
    half.elements = [
      {
        ...hb,
        id: 'w-half',
        start: { xy: [8000, 0] },
        end: { xy: [-8000, 0] },
        bulge: 1,
        lean: undefined,
      },
      { ...hb, id: 'w-through', start: { xy: [-8000, 0] }, end: { xy: [-12000, 0] }, lean: -0.03 },
    ] as Wall[];
    half.joins = [{ id: 'j', walls: ['w-half', 'w-through'], kind: 'butt', through: 'w-through' }];
    expect(deriveBim(half).diagnostics.map((x) => [x.code, x.id])).toContainEqual([
      'join-failed',
      'w-half',
    ]);
    // An upright through wall 4,000 mm high and a 1,000 mm stop leaning 0.2 rad 500 mm from
    // its end: the stop's contact stays on it over its own height; the stop's extension above
    // it is not asked (Codex).
    const low = f54LeanJoins();
    const lb = element<Wall>(low, 'w-lean');
    low.elements = [
      { ...lb, id: 'w-up', lean: undefined },
      {
        ...lb,
        id: 'w-stop',
        start: { xy: [7500, 0] },
        end: { xy: [7500, 5000] },
        top: { level: 'l-gl', offsetMm: 1000 },
      },
    ] as Wall[];
    low.joins = [{ id: 'j', walls: ['w-up', 'w-stop'], kind: 'butt', through: 'w-up' }];
    expect(deriveBim(low).diagnostics).toEqual([]);
  });
});

describe('sloped slabs (TW5, F48)', () => {
  const doc = f48Ramp();
  type Slab = Extract<BimElement, { kind: 'slab' }>;
  it('validates them and refuses a slope on no straight edge', () => {
    expect(errors(doc)).toEqual([]);
    expect(deriveBim(doc).diagnostics).toEqual([]);
    for (const edge of [4, -1, 0.5, '1']) {
      const d = structuredClone(doc);
      (element<Slab>(d, 's-ramp').slope as unknown as Record<string, unknown>).edge = edge;
      expect(codes(d), String(edge)).toContain('slab-slope');
    }
    // The half-round slab's edge 0 is its arc.
    const arc = structuredClone(doc);
    element<Slab>(arc, 's-half').slope!.edge = 0;
    expect(codes(arc)).toContain('slab-slope');
    const extra = structuredClone(doc);
    (element<Slab>(extra, 's-ramp').slope as unknown as Record<string, unknown>).grade = 1;
    expect(codes(extra)).toContain('slab-slope');
  });
  it('rises square to its edge to the farthest point, exact on arcs', () => {
    const ramp = shape(doc, 's-ramp', 'slab');
    expect(ramp.slope!.origin).toEqual([0, 3000]);
    close(ramp.slope!.direction[0], 1);
    close(ramp.slope!.direction[1], 0);
    close(ramp.slope!.grade, 2800 / 12000);
    close(ramp.zTop, 200);
    close(ramp.zBottom, 0);
    const half = shape(doc, 's-half', 'slab');
    close(half.slope!.direction[0], 0);
    close(half.slope!.direction[1], 1);
    close(half.slope!.grade, -1000 / 3000);
    // Plan areas and the vertical thickness; the top face's own area over the cosine.
    // The hole and the opening come off the plan area.
    const area = 12000 * 3000 - 2000 * 1000 - 1000 * 1000;
    close(q(doc, 's-ramp').netArea, area);
    close(q(doc, 's-ramp').netVolume, area * 200);
    close(q(doc, 's-ramp').slopedArea, area * Math.hypot(1, 2800 / 12000));
    close(q(doc, 's-half').netVolume, ((Math.PI * 3000 * 3000) / 2) * 200);
    // An end top at the same height is no slope.
    const flat = structuredClone(doc);
    element<Slab>(flat, 's-ramp').slope!.endTop = { level: 'l-gl', offsetMm: 200 };
    expect(shape(flat, 's-ramp', 'slab').slope).toBeUndefined();
    expect(q(flat, 's-ramp').slopedArea).toBeUndefined();
  });
  it('keeps the plane within the limit behind the edge of a concave boundary', () => {
    const d = structuredClone(doc);
    const ramp = element<Slab>(d, 's-ramp');
    // Reaches 100 mm behind edge 0's line, 100 mm ahead of it: 2,700 km at the far corner.
    ramp.boundary = [
      [0, 0],
      [100, 0],
      [100, 100],
      [-100, 100],
      [-100, -100],
      [0, -100],
    ];
    ramp.holes = [];
    d.elements = d.elements.filter((e) => e.id !== 'o-ramp');
    ramp.top = { level: 'l-gl', offsetMm: 900_000 };
    ramp.slope = { edge: 0, endTop: { level: 'l-gl', offsetMm: -900_000 } };
    expect(deriveBim(d).diagnostics.map((x) => x.code)).toContain('coordinate');
    ramp.slope.endTop.offsetMm = 899_000;
    expect(deriveBim(d).diagnostics).toEqual([]);
  });
  it('keeps the level its end top names', () => {
    const d = structuredClone(doc);
    element<Slab>(d, 's-half').slope!.endTop = { level: 'l-missing', offsetMm: 0 };
    expect(codes(d)).toContain('reference-missing');
  });
});

describe('domain boundary (CAD60)', () => {
  it('imports no CAD package', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = new URL('.', import.meta.url);
    const pkg = JSON.parse(readFileSync(new URL('../package.json', dir), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).filter((d) => d.includes('/cad'))).toEqual([]);
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts')))
      expect(readFileSync(new URL(f, dir), 'utf8')).not.toMatch(/from '@editor-platform\/cad/);
  });
});

describe('openings in leaning walls (FU3a, F52)', () => {
  const doc = f52LeanOpenings();
  it('places windows, doors and openings, their sills and heights along the face', () => {
    expect(errors(doc)).toEqual([]);
    expect(deriveBim(doc).diagnostics).toEqual([]);
    // The free wall leans 15°: its face is 4,000 ÷ cos 15° ≈ 4,141 mm high. A window up to
    // 4,100 mm along it fits (higher than the wall stands), one up to 4,200 does not.
    const at = (sill: number) => {
      const d = structuredClone(doc);
      const w = d.elements.find((e) => e.id === 'win-free') as Extract<
        BimElement,
        { kind: 'window' }
      >;
      w.sillMm = sill;
      return deriveBim(d).diagnostics.map((x) => [x.code, x.id]);
    };
    expect(at(2600)).toEqual([]);
    expect(at(2700)).toEqual([['opening-outside-host', 'win-free']]);
  });
  it('keeps an opening out of a join at its sill and head, where the join has moved (Codex)', () => {
    // The square leaning in: its mitred ends reach further into each wall as it rises.
    const d = f50Lean();
    for (const e of d.elements) if (e.id.startsWith('w-sq-')) (e as BimWall).lean = -0.2;
    d.elements.push({
      id: 'o-end',
      kind: 'opening',
      hostId: 'w-sq-1',
      wall: { alongMm: 150, sillMm: 2000, widthMm: 1000, heightMm: 1000 },
    });
    expect(deriveBim(d).diagnostics.map((x) => [x.code, x.id])).toEqual([
      ['opening-in-join', 'o-end'],
    ]);
    // Clear of the join at the base, and at the sill and head too a little further along.
    (d.elements.at(-1) as { wall: { alongMm: number } }).wall.alongMm = 1200;
    expect(deriveBim(d).diagnostics).toEqual([]);
  });
  it('keeps an opening out of the span a leaning T-join sweeps between its sill and head (Codex)', () => {
    // The stopping wall leans further than the through wall, so its contact crosses the opening
    // between the sill and the head while lying clear of it at both.
    const d = f50Lean();
    const base = d.elements.find((e) => e.id === 'w-l-1') as BimWall;
    d.elements = [
      { ...base, id: 'w-t-1', start: { xy: [0, 0] }, end: { xy: [10000, 0] }, lean: 0.1 },
      { ...base, id: 'w-t-2', start: { xy: [2000, 0] }, end: { xy: [2000, 6000] }, lean: 0.6 },
    ];
    d.joins = [{ id: 'j-t', walls: ['w-t-1', 'w-t-2'], kind: 'butt', through: 'w-t-1' }];
    d.elements.push({
      id: 'o-t',
      kind: 'opening',
      hostId: 'w-t-1',
      wall: { alongMm: 3000, sillMm: 500, widthMm: 400, heightMm: 3000 },
    });
    expect(deriveBim(d).diagnostics.map((x) => [x.code, x.id])).toEqual([
      ['opening-in-join', 'o-t'],
    ]);
    // Moved past where the contact reaches at the head, it is accepted.
    (d.elements.at(-1) as { wall: { alongMm: number } }).wall.alongMm = 6000;
    expect(deriveBim(d).diagnostics).toEqual([]);
    // Over the join at the base but high up, where the contact has moved away, too (Codex).
    (d.elements.at(-1) as { wall: object }).wall = {
      alongMm: 1900,
      sillMm: 2000,
      widthMm: 200,
      heightMm: 1000,
    };
    expect(deriveBim(d).diagnostics).toEqual([]);
  });
  it('counts a shorter stopping wall only up to its top (Codex)', () => {
    const d = f50Lean();
    const base = d.elements.find((e) => e.id === 'w-l-1') as BimWall;
    d.elements = [
      { ...base, id: 'w-t-1', start: { xy: [0, 0] }, end: { xy: [10000, 0] }, lean: 0.1 },
      {
        ...base,
        id: 'w-t-2',
        start: { xy: [2000, 0] },
        end: { xy: [2000, 6000] },
        lean: 0.6,
        top: { level: 'l-gl', offsetMm: 1000 },
      },
    ];
    d.joins = [{ id: 'j-t', walls: ['w-t-1', 'w-t-2'], kind: 'butt', through: 'w-t-1' }];
    expect(deriveBim(d).diagnostics).toEqual([]);
    const opening = (wall: {
      alongMm: number;
      sillMm: number;
      widthMm: number;
      heightMm: number;
    }) => ({
      id: 'o-s',
      kind: 'opening' as const,
      hostId: 'w-t-1',
      wall,
    });
    // Wholly above the short wall: clear.
    d.elements.push(opening({ alongMm: 3400, widthMm: 300, sillMm: 2500, heightMm: 500 }));
    expect(deriveBim(d).diagnostics).toEqual([]);
    // Reaching down into it where it meets the through wall: refused.
    d.elements[2] = opening({ alongMm: 1900, widthMm: 300, sillMm: 0, heightMm: 3000 });
    expect(deriveBim(d).diagnostics.map((x) => [x.code, x.id])).toEqual([
      ['opening-in-join', 'o-s'],
    ]);
  });
  it('sweeps each T-join with itself when two cross between heights (Codex)', () => {
    const d = f50Lean();
    const base = d.elements.find((e) => e.id === 'w-l-1') as BimWall;
    d.elements = [
      { ...base, id: 'w-t-1', start: { xy: [0, 0] }, end: { xy: [20000, 0] }, lean: 0.1 },
      { ...base, id: 'w-t-2', start: { xy: [6000, 0] }, end: { xy: [6000, 6000] }, lean: 1 },
      { ...base, id: 'w-t-3', start: { xy: [6800, 0] }, end: { xy: [6800, 6000] }, lean: -1 },
    ];
    d.joins = [
      { id: 'j-2', walls: ['w-t-1', 'w-t-2'], kind: 'butt', through: 'w-t-1' },
      { id: 'j-3', walls: ['w-t-1', 'w-t-3'], kind: 'butt', through: 'w-t-1' },
    ];
    d.elements.push({
      id: 'o-x',
      kind: 'opening',
      hostId: 'w-t-1',
      wall: { alongMm: 6300, sillMm: 0, widthMm: 200, heightMm: 4000 / Math.cos(0.1) },
    });
    expect(deriveBim(d).diagnostics.map((x) => [x.code, x.id])).toEqual([
      ['opening-in-join', 'o-x'],
    ]);
  });
  it('keeps a panel in a leaning arc wall between the angles of its cut (Codex)', () => {
    // The ring leaning in hard: its radius shrinks up the wall, the opening keeps its angles.
    const d = f50Lean();
    d.types.push({ id: 't-window-900', kind: 'window', name: 'W', widthMm: 900, heightMm: 1500 });
    const ring = { ...(d.elements.find((e) => e.id === 'w-ring-1') as BimWall) };
    d.elements = [{ ...ring, typeId: 't-wall-200', lean: -0.6 }];
    d.joins = [];
    d.elements.push({
      id: 'win-ring',
      kind: 'window',
      typeId: 't-window-900',
      hostId: 'w-ring-1',
      alongMm: 1000,
      sillMm: 1000,
      flipFacing: false,
    });
    expect(deriveBim(d).diagnostics).toEqual([]);
    const g = bimGeometry(d);
    type Loft = Extract<GeometryOp, { op: 'loft' }>;
    const cut = g.graph.nodes['w-ring-1\u0000opening:win-ring'] as Loft;
    const panel = g.graph.nodes['win-ring\u0000base'] as Loft;
    expect(panel.op).toBe('loft');
    expect(g.elements.get('win-ring')!.placement).toBeUndefined();
    const polar = (v: readonly number[]) => [
      Math.atan2(v[1]! - 0, v[0]! - 20000),
      Math.hypot(v[0]! - 20000, v[1]!),
    ];
    for (const k of [0, 1]) {
      expect(panel.sections[k]!.frame.origin[2]).toBe(cut.sections[k]!.frame.origin[2]);
      const c = cut.sections[k]!.outer.map(polar);
      const p = panel.sections[k]!.outer.map(polar);
      const [lo, hi] = [Math.min(...c.map((x) => x[0]!)), Math.max(...c.map((x) => x[0]!))];
      const [rIn, rOut] = [Math.min(...c.map((x) => x[1]!)), Math.max(...c.map((x) => x[1]!))];
      for (const [ang, r] of p) {
        expect(ang!).toBeGreaterThanOrEqual(lo - 1e-9);
        expect(ang!).toBeLessThanOrEqual(hi + 1e-9);
        expect(r!).toBeGreaterThan(rIn);
        expect(r!).toBeLessThan(rOut);
      }
      // 50 mm thick square to the face.
      const rs = p.map((x) => x[1]!);
      close(Math.max(...rs) - Math.min(...rs), 50 / Math.cos(0.6));
    }
  });
  it('takes the openings out of the face area and the volume, exactly on the cone', () => {
    const base = f50Lean();
    const free = q(doc, 'w-free');
    close(free.openingArea!, 1800 * 1500 + 900 * 2100);
    close(free.netSideArea!, q(base, 'w-free').grossSideArea! - free.openingArea!, 1e-6);
    // Square to the faces the cut is the wall's 200 mm thick.
    close(free.netVolume!, q(base, 'w-free').netVolume! - 200 * (1800 * 1500 + 900 * 2100), 1e-3);
    // The ring's opening: 1,500 mm of the axis at the base (radius 5,000) is 0.3 rad, taken at
    // the radius where its middle stands, 2,000 mm up the face.
    const ring = q(doc, 'w-ring-1');
    const mid = 5000 + 2000 * Math.cos(0.3) * Math.tan(0.3);
    close(ring.netVolume!, q(base, 'w-ring-1').netVolume! - (1500 / 5000) * 80 * mid * 2000, 1e-3);
  });
  it('cuts each with a loft between its plan regions at the sill and the head', () => {
    const g = bimGeometry(doc);
    const node = g.graph.nodes['w-free\u0000opening:win-free'] as Extract<
      GeometryOp,
      { op: 'loft' }
    >;
    expect(node.op).toBe('loft');
    const lean = Math.PI / 12;
    const [z0, z1] = [900 * Math.cos(lean), 2400 * Math.cos(lean)];
    expect(node.sections.map((s) => s.frame.origin[2])).toEqual([z0, z1]);
    // The free wall runs along +x and leans to −y: each region is the base one moved by
    // rise·tan(lean), 200 ÷ cos(lean) + 20 mm across.
    for (const [k, z] of [z0, z1].entries()) {
      const ys = node.sections[k]!.outer.map((v) => v[1]);
      close(Math.min(...ys), -100 / Math.cos(lean) - 10 - z * Math.tan(lean));
      close(Math.max(...ys), 100 / Math.cos(lean) + 10 - z * Math.tan(lean));
      expect(node.sections[k]!.outer.map((v) => v[0])).toEqual([800, 2600, 2600, 800]);
    }
    expect(g.graph.nodes['w-ring-1\u0000opening:o-ring']!.op).toBe('loft');
    // The window's panel leans with the wall, its sill 900 mm up the face, and fits inside the
    // cut: its ends level with the cut's, every corner within the cut's region at its height
    // (Codex), 50 mm thick square to the face.
    const panel = g.elements.get('win-free')!.placement!;
    const prism = g.graph.nodes['win-free\u0000base'] as Extract<GeometryOp, { op: 'prism' }>;
    const r = panel.rotation;
    const corners = prism.outer.flatMap(([u, v]) =>
      [0, 1].map((k) => {
        const l = [u + prism.vector[0] * k, v + prism.vector[1] * k, prism.vector[2] * k];
        return [0, 1, 2].map(
          (i) =>
            r[i * 3]! * l[0]! +
            r[i * 3 + 1]! * l[1]! +
            r[i * 3 + 2]! * l[2]! +
            panel.translation[i]!,
        );
      }),
    );
    const zs = corners.map((c) => c[2]!);
    close(Math.min(...zs), z0);
    close(Math.max(...zs), z1);
    for (const [x, y, z] of corners) {
      expect(x!).toBeGreaterThanOrEqual(800 - 1e-6);
      expect(x!).toBeLessThanOrEqual(2600 + 1e-6);
      const centre = -z! * Math.tan(lean);
      expect(Math.abs(y! - centre)).toBeLessThanOrEqual(25 / Math.cos(lean) + 1e-6);
    }
    close(panel.translation[2], 900 * Math.cos(lean));
    close(panel.translation[1], -900 * Math.sin(lean));
  });
});

describe('openings in ramps (LS4, F55)', () => {
  type Opening = Extract<BimElement, { kind: 'opening' }>;
  const square = (x: number, y: number, side: number): BimLoop => [
    [x - side / 2, y - side / 2],
    [x + side / 2, y - side / 2],
    [x + side / 2, y + side / 2],
    [x - side / 2, y + side / 2],
  ];
  const codesOf = (doc: BimDocument) => deriveBim(doc).diagnostics.map((d) => [d.code, d.id]);

  it('cuts each opening through every turn over it, from the exact volume', () => {
    const doc = f55RampOpenings();
    expect(errors(doc)).toEqual([]);
    const d = deriveBim(doc);
    expect(d.diagnostics).toEqual([]);
    const plain = deriveBim(f51Ramps());
    // The north square is over two turns (90° and 450° of 0–540°), the south one over one.
    const v = (x: ReturnType<typeof deriveBim>, id: string) => x.quantities.get(id)!.values;
    expect(v(d, 'r-spiral').openingArea).toBeCloseTo(3e6, 6);
    expect(v(d, 'r-spiral').netVolume).toBeCloseTo(v(plain, 'r-spiral').netVolume! - 3e6 * 200, 3);
    expect(v(d, 'r-spiral').grossVolume).toBeCloseTo(v(plain, 'r-spiral').netVolume!, 3);
    expect(v(d, 'r-quarter').netVolume).toBeCloseTo(
      v(plain, 'r-quarter').netVolume! - 800 * 800 * 200,
      3,
    );
    expect(shape(doc, 'r-spiral', 'ramp').openings).toHaveLength(2);
    // Cut upright in the ramp's frame (its centre).
    const g = bimGeometry(doc, d);
    const el = g.elements.get('r-quarter')!;
    expect(g.graph.nodes[el.node]).toMatchObject({ op: 'boolean', kind: 'cut' });
    expect(el.placement?.translation).toEqual([20000, 0, 0]);
  });

  it("takes each opening's patch of the helicoid from the walking surface (Codex)", () => {
    const d = deriveBim(f55RampOpenings());
    const plain = deriveBim(f51Ramps());
    const v = (x: ReturnType<typeof deriveBim>, id: string) => x.quantities.get(id)!.values;
    expect(v(d, 'r-quarter').grossTopArea).toBeCloseTo(v(plain, 'r-quarter').topArea!, 6);
    // The 800 mm square at 45° round (20,000, 0): √(1 + p²/ρ²) summed over a fine grid.
    const p = 1000 / (Math.PI / 2);
    const c = 3750 * Math.SQRT1_2;
    const n = 400;
    let grid = 0;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const x = c - 400 + ((i + 0.5) * 800) / n;
        const y = c - 400 + ((j + 0.5) * 800) / n;
        grid += Math.sqrt(1 + (p * p) / (x * x + y * y)) * (800 / n) ** 2;
      }
    const removed = v(plain, 'r-quarter').topArea! - v(d, 'r-quarter').topArea!;
    expect(Math.abs(removed / grid - 1)).toBeLessThan(1e-6);
    expect(removed).toBeGreaterThan(800 * 800);
    // The spiral's north square comes off two turns, its south one off one.
    const spiral = v(plain, 'r-spiral').topArea! - v(d, 'r-spiral').topArea!;
    expect(spiral).toBeGreaterThan(3e6);
    // The schedule sums the net walking surface.
    const row = bimSchedule(f55RampOpenings(), d).rows.find((r) => r.kind === 'ramp')!;
    expect(row.areaMm2).toBeCloseTo(v(d, 'r-spiral').topArea! + v(d, 'r-quarter').topArea!, 3);
  });

  it('refuses a round opening reaching past the edge between samples, and a rise too tall to cut (Codex)', () => {
    // A 500 mm circle 4,500.1 mm out at 91.4°: its furthest point 5,000.1 mm from the centre.
    const a = Math.PI / 2 + Math.PI / 128;
    const [cx, cy] = [4500.1 * Math.cos(a), 4500.1 * Math.sin(a)];
    const circle: BimLoop = [
      [cx + 500, cy, 1],
      [cx - 500, cy, Math.tan(Math.PI / 8)],
      [cx, cy - 500, Math.tan(Math.PI / 8)],
    ];
    const doc = f51Ramps();
    doc.elements.push({
      id: 'o-round',
      kind: 'opening',
      hostId: 'r-spiral',
      slab: { boundary: circle },
    });
    expect(codesOf(doc)).toContainEqual(['opening-outside-host', 'r-spiral']);
    // 1 mm further in it fits.
    const inside = f51Ramps();
    inside.elements.push({
      id: 'o-round',
      kind: 'opening',
      hostId: 'r-spiral',
      slab: {
        boundary: circle.map((q) => [q[0] - Math.cos(a), q[1] - Math.sin(a), q[2]] as never),
      },
    });
    expect(codesOf(inside)).toEqual([]);
    // From −600 m to +600 m: one prism through the rise would pass the coordinate limit.
    const tall = f55RampOpenings();
    tall.levels = [
      { id: 'l-gl', name: 'GL', elevationMm: -600_000 },
      { id: 'l-0', name: '0', elevationMm: 0 },
      { id: 'l-1', name: 'L1', elevationMm: 600_000 },
    ];
    expect(codesOf(tall)).toContainEqual(['coordinate', 'r-spiral']);
  });

  it('refuses an opening off the ramp, across its start, round its centre or overlapping', () => {
    const at = (boundary: BimLoop, host = 'r-spiral') => {
      const doc = f51Ramps();
      doc.elements.push({ id: 'o-x', kind: 'opening', hostId: host, slab: { boundary } });
      return doc;
    };
    // Inside the inner radius; past the outer; across the start (0°); round the centre.
    // Like a slab's, the host fails, at the opening's boundary.
    for (const loop of [
      square(0, 1500, 600),
      square(0, 4800, 600),
      square(3500, 0, 600),
      Array.from({ length: 8 }, (_, k): [number, number] => [
        4000 * Math.cos((k * Math.PI) / 4),
        4000 * Math.sin((k * Math.PI) / 4),
      ]),
    ])
      expect(codesOf(at(loop))).toContainEqual(['opening-outside-host', 'r-spiral']);
    // The quarter ramp covers 0–90° round (20,000, 0): its west is off it.
    expect(codesOf(at(square(16000, 0, 600), 'r-quarter'))).toContainEqual([
      'opening-outside-host',
      'r-quarter',
    ]);
    const two = f55RampOpenings();
    (two.elements.find((e) => e.id === 'o-south') as Opening).hostId = 'r-spiral';
    two.elements.push({
      id: 'o-y',
      kind: 'opening',
      hostId: 'r-spiral',
      slab: { boundary: square(300, -3500, 1000) },
    });
    expect(codesOf(two)).toContainEqual(['opening-overlap', 'r-spiral']);
    // A ramp is not a wall's host.
    const wallOpening = f51Ramps();
    wallOpening.elements.push({
      id: 'o-w',
      kind: 'opening',
      hostId: 'r-spiral',
      wall: { alongMm: 0, sillMm: 0, widthMm: 900, heightMm: 2000 },
    });
    expect(errors(wallOpening).map((x) => x.code)).toContain('host-kind');
  });
});

describe('straight stairs (LS6, F55)', () => {
  type Stair = Extract<BimElement, { kind: 'stair' }>;
  /** The side's area by hand: the steps less what lies below the waist's underside. */
  const sideArea = (n: number, r: number, t: number, w: number) => {
    const m = r / t;
    const drop = w * Math.hypot(1, m);
    const run = (n - 1) * t;
    const foot = (drop - r) / m;
    return (t * r * n * (n - 1)) / 2 - (m * (run - foot) ** 2) / 2;
  };

  it("derives each flight's side, its exact volume and its treads", () => {
    const doc = f55Stairs();
    expect(errors(doc)).toEqual([]);
    const d = deriveBim(doc);
    expect(d.diagnostics).toEqual([]);
    for (const [id, n, h, t, w, width] of [
      ['st-main', 17, 3000, 260, 150, 1200],
      ['st-north', 10, 1800, 280, 200, 1000],
    ] as const) {
      const v = d.quantities.get(id)!.values;
      close(v.netVolume!, sideArea(n, h / n, t, w) * width, 1e-3);
      expect(v.treadArea).toBeCloseTo((n - 1) * t * width, 9);
      expect(v.riserHeight).toBeCloseTo(h / n, 12);
      expect(v.numberOfRisers).toBe(n);
      expect(v.length).toBe((n - 1) * t);
    }
    // The main flight: its underside reaches the floor 7 mm past the first riser and the end
    // 181 mm below the last tread; the steps come back down to the first riser's top.
    const main = shape(doc, 'st-main', 'stair');
    const [r, m] = [3000 / 17, 3000 / 17 / 260];
    const drop = 150 * Math.hypot(1, m);
    expect(main.profile[0]).toEqual([0, 0]);
    expect(main.profile[1]![0]).toBeCloseTo((drop - r) / m, 9);
    expect(main.profile[2]![1]).toBeCloseTo(3000 - drop, 9);
    expect(main.profile[3]).toEqual([16 * 260, 16 * r]);
    expect(main.profile.at(-1)).toEqual([0, r]);
    expect(main.profile).toHaveLength(3 + 2 * 16);
    // Built as one prism of the side swept across, placed at the start and turned.
    const g = bimGeometry(doc, d);
    const el = g.elements.get('st-north')!;
    expect(g.graph.nodes[el.node]).toMatchObject({ op: 'prism', vector: [0, -1000, 0] });
    expect(el.placement?.translation).toEqual([6000, 0, 0]);
    const rows = bimSchedule(doc, d).rows.filter((r) => r.kind === 'stair');
    expect(rows.reduce((n, r) => n + r.count, 0)).toBe(2);
    // With their runs (Codex): 16 × 260 and 9 × 280 mm.
    expect(rows.reduce((n, r) => n + (r.lengthMm ?? 0), 0)).toBeCloseTo(4160 + 2520, 9);
  });

  it('refuses risers, treads and step counts out of range, and a waist that leaves no flight', () => {
    const edit = (f: (s: Stair) => void) => {
      const doc = f55Stairs();
      f(element<Stair>(doc, 'st-main'));
      return doc;
    };
    for (const n of [1, 51, 2.5])
      expect(codes(edit((s) => (s.risers = n)))).toContain('stair-risers');
    for (const t of [149, 501])
      expect(codes(edit((s) => (s.treadMm = t)))).toContain('stair-tread');
    const codesOf = (doc: BimDocument) => deriveBim(doc).diagnostics.map((x) => [x.code, x.id]);
    // 3,000 mm in 12 risers is 250 mm (on a 200 mm waist), in 11 more than 250.
    const steep = (n: number) =>
      edit((s) => {
        s.risers = n;
        s.typeId = 't-slab-200';
      });
    expect(codesOf(steep(12))).toEqual([]);
    expect(codesOf(steep(11))).toEqual([['stair-riser', 'st-main']]);
    expect(codesOf(edit((s) => (s.top = { level: 'l-gl', offsetMm: 80 })))).toEqual([
      ['stair-riser', 'st-main'],
    ]);
    // A waist thinner than a riser square to the pitch would cut each step's inner corner.
    expect(codesOf(edit((s) => (s.typeId = 't-waist-100')))).toEqual([['stair-shape', 'st-main']]);
    // Two 50 mm risers on a 200 mm waist: its underside never leaves the floor before the top.
    expect(
      codesOf(
        edit((s) => {
          s.risers = 2;
          s.typeId = 't-slab-200';
          s.top = { level: 'l-gl', offsetMm: 100 };
        }),
      ),
    ).toEqual([['stair-shape', 'st-main']]);
    expect(codes(edit((s) => (s.typeId = 't-wall-200')))).toContain('type-kind');
    // A waist whose underside passes through every inner corner (a drop of exactly one riser:
    // 15 risers of 200 mm, 200 mm treads, 200/√2 thick) is no simple outline (Codex).
    const touching = (waist: number) => {
      const doc = edit((s) => {
        s.risers = 15;
        s.treadMm = 200;
        s.typeId = 't-touch';
      });
      doc.types.push({
        id: 't-touch',
        kind: 'slab',
        name: 'Touching',
        layers: [{ materialId: doc.materials[0]!.id, thicknessMm: waist }],
      });
      return codesOf(doc);
    };
    expect(touching(200 / Math.SQRT2)).toEqual([['stair-shape', 'st-main']]);
    expect(touching(200 / Math.SQRT2 + 1)).toEqual([]);
  });
});

describe('railings along ramps (LS5, F55)', () => {
  type Railing = Extract<BimElement, { kind: 'railing' }>;
  it('stands a band on the ramp edge, its volume exact, scheduled with the ramps', () => {
    const doc = f55RampOpenings();
    expect(errors(doc)).toEqual([]);
    const d = deriveBim(doc);
    expect(d.diagnostics).toEqual([]);
    const out = shape(doc, 'rail-out', 'railing');
    expect(out).toMatchObject({
      center: [0, 0],
      innerRadius: 4950,
      outerRadius: 5000,
      startAngle: 0,
      zStart: 1100,
      zEnd: 5100,
      thickness: 1100,
    });
    expect(shape(doc, 'rail-in', 'railing')).toMatchObject({
      innerRadius: 2000,
      outerRadius: 2050,
    });
    // The clockwise quarter: its sweep, round its own centre.
    expect(shape(doc, 'rail-quarter', 'railing')).toMatchObject({
      center: [20000, 0],
      innerRadius: 4450,
      sweep: -Math.PI / 2,
    });
    const v = q(doc, 'rail-out');
    close(v.netVolume!, ((3 * Math.PI) / 2) * (5000 ** 2 - 4950 ** 2) * 1100, 1e-3);
    close(v.length!, 3 * Math.PI * Math.hypot(4975, 4000 / (3 * Math.PI)), 1e-6);
    // Its faces are cylinders' strips: sweep × mean radius × height, less than length × height
    // (Codex).
    close(v.sideArea!, 3 * Math.PI * 4975 * 1100, 1e-9);
    expect(v.sideArea!).toBeLessThan(v.length! * 1100 - 1);
    // Built as the ramp is: radial sections lofted, about the ramp's centre.
    const g = bimGeometry(doc, d);
    const el = g.elements.get('rail-out')!;
    expect(g.graph.nodes[el.node]).toMatchObject({ op: 'loft' });
    expect(el.placement?.translation).toEqual([0, 0, 0]);
    const rows = bimSchedule(doc, d).rows.filter((r) => r.kind === 'railing');
    expect(rows.map((r) => [r.level, r.count, r.missing])).toEqual([['l-gl', 3, 0]]);
    // Deleting the ramp takes its railings.
    const next = applyBimOperation(doc, { type: 'delete', ids: ['r-spiral'], cascade: true });
    expect(next.elements.some((e) => e.id === 'rail-in' || e.id === 'rail-out')).toBe(false);
  });

  it('refuses a host that is not a ramp, a bad side or height, and a band as wide as the ramp', () => {
    const edit = (f: (r: Railing, doc: BimDocument) => void) => {
      const doc = f55RampOpenings();
      f(element<Railing>(doc, 'rail-in'), doc);
      return doc;
    };
    expect(codes(edit((r) => (r.hostId = 'o-north')))).toContain('host-kind');
    expect(codes(edit((r) => ((r as { side: string }).side = 'top')))).toContain('railing-side');
    expect(codes(edit((r) => (r.heightMm = 0)))).not.toEqual([]);
    expect(codes(edit((r) => (r.heightMm = 3001)))).not.toEqual([]);
    expect(codes(edit((r) => (r.typeId = 't-slab-200')))).toContain('type-kind');
    const wide = edit((r, doc) => {
      r.hostId = 'r-quarter';
      doc.elements = doc.elements.filter((e) => e.id !== 'o-quarter');
      element<Extract<BimElement, { kind: 'ramp' }>>(doc, 'r-quarter').outerRadiusMm = 3040;
    });
    // Over 1.5 turns rising 750 mm, 500 mm a turn: a 1,100 mm railing meets the turn above
    // (Codex); up to the turn's underside (500 − 200) it fits.
    const low = edit((_, doc) => {
      element<Extract<BimElement, { kind: 'ramp' }>>(doc, 'r-spiral').top = {
        level: 'l-gl',
        offsetMm: 750,
      };
    });
    expect(deriveBim(low).diagnostics.map((x) => [x.code, x.id])).toEqual([
      ['railing-shape', 'rail-in'],
      ['railing-shape', 'rail-out'],
    ]);
    for (const r of low.elements)
      if (r.kind === 'railing' && r.hostId === 'r-spiral') r.heightMm = 290;
    expect(deriveBim(low).diagnostics).toEqual([]);
    // Validation passes; the 40 mm ring cannot take a 50 mm band, on either side.
    expect(
      validateBim(wide).filter((x) => x.code !== 'railing-shape' && x.severity === 'error'),
    ).toEqual([]);
    expect(deriveBim(wide).diagnostics.map((x) => [x.code, x.id])).toEqual([
      ['railing-shape', 'rail-in'],
      ['railing-shape', 'rail-quarter'],
    ]);
  });
});

describe('spiral ramps (LR3, F51)', () => {
  const doc = f51Ramps();
  type Ramp = Extract<BimElement, { kind: 'ramp' }>;
  const ramp = (d: BimDocument, id: string) => element<Ramp>(d, id);
  it('validates them and refuses bad radii, no turn, past 3 turns and a ramp that meets itself', () => {
    expect(errors(doc)).toEqual([]);
    expect(deriveBim(doc).diagnostics).toEqual([]);
    const bad = (edit: (r: Ramp) => void) => {
      const d = structuredClone(doc);
      edit(ramp(d, 'r-spiral'));
      return [...codes(d), ...deriveBim(d).diagnostics.map((x) => x.code)];
    };
    expect(bad((r) => (r.outerRadiusMm = 2000))).toContain('ramp-shape');
    expect(bad((r) => (r.innerRadiusMm = 0))).toContain('dimension');
    expect(bad((r) => (r.sweepRad = 0))).toContain('ramp-shape');
    expect(bad((r) => (r.sweepRad = 6 * Math.PI + 0.01))).toContain('angle');
    // 3 turns rising 600 mm: 200 mm a turn, no more than the slab's 200 mm.
    expect(
      bad((r) => {
        r.sweepRad = 6 * Math.PI;
        r.top = { level: 'l-gl', offsetMm: 600 };
      }),
    ).toContain('ramp-shape');
    // One turn rising 100 mm: its end over its start, overlapping by 100 mm.
    expect(
      bad((r) => {
        r.sweepRad = 2 * Math.PI;
        r.top = { level: 'l-gl', offsetMm: 100 };
      }),
    ).toContain('ramp-shape');
    // Less than one turn never meets itself, however flat.
    expect(
      bad((r) => {
        r.sweepRad = 2 * Math.PI - 0.01;
        r.top = { level: 'l-gl', offsetMm: 0 };
      }),
    ).toEqual([]);
    // A level the ramp uses cannot go while it stands.
    const refs = entityReferences('elements', ramp(doc, 'r-spiral'));
    expect(refs).toEqual(expect.arrayContaining(['t-slab-200', 'l-gl', 'l-1']));
  });
  it('gives the ring sector, the helicoid top and the centreline their exact values', () => {
    const v = q(doc, 'r-spiral');
    const sweep = 3 * Math.PI;
    const p = 4000 / sweep;
    close(v.planArea!, (sweep / 2) * (5000 ** 2 - 2000 ** 2), 1e-3);
    close(v.netVolume!, v.planArea! * 200, 1);
    close(v.length!, sweep * Math.hypot(3500, p), 1e-6);
    close(v.ringWidth!, 3000);
    close(v.rise!, 4000);
    // The top by Simpson's rule over the radius (many strips) against the closed form.
    let top = 0;
    const n = 2000;
    for (let i = 0; i <= n; i++) {
      const rho = 2000 + (3000 * i) / n;
      const w = i === 0 || i === n ? 1 : i % 2 ? 4 : 2;
      top += w * Math.hypot(rho, p);
    }
    top *= ((3000 / n) * sweep) / 3;
    expect(Math.abs(v.topArea! / top - 1)).toBeLessThan(1e-9);
    // Clockwise and going down: positive areas and length, a negative rise.
    const quarter = q(doc, 'r-quarter');
    close(quarter.planArea!, (Math.PI / 4) * (4500 ** 2 - 3000 ** 2), 1e-3);
    const down = q(doc, 'r-down');
    close(down.rise!, -2000);
    close(down.length!, Math.PI * Math.hypot(2000, 2000 / Math.PI), 1e-6);
    expect(shape(doc, 'r-quarter', 'ramp')).toMatchObject({
      center: [20000, 0],
      sweep: -Math.PI / 2,
      zStart: 0,
      zEnd: 1000,
      thickness: 200,
    });
  });
  it('builds a smooth loft of radial sections every 5°', () => {
    const g = bimGeometry(doc);
    const node = g.graph.nodes[g.elements.get('r-spiral')!.node] as Extract<
      GeometryOp,
      { op: 'loft' }
    >;
    expect(node.op).toBe('loft');
    // 540° in 5° steps.
    expect(node.sections.length).toBe(109);
    expect(node.ruled).toBeUndefined();
    const last = node.sections.at(-1)!;
    expect(last.outer.map((v) => v[1])).toEqual([3800, 3800, 4000, 4000]);
    // A quarter turn still takes 8 steps.
    const quarter = g.graph.nodes[g.elements.get('r-quarter')!.node] as typeof node;
    expect(quarter.sections.length).toBe(19);
    const quick = g.graph.nodes[g.elements.get('r-down')!.node] as typeof node;
    expect(quick.sections.length).toBe(37);
  });
  it('lists ramps in the schedule by their walking surface and centreline', () => {
    const rows = bimSchedule(doc, deriveBim(doc)).rows.filter((r) => r.kind === 'ramp');
    expect(rows.map((r) => [r.levelName, r.count])).toEqual([
      ['GL', 2],
      ['L1', 1],
    ]);
    close(rows[0]!.areaMm2!, q(doc, 'r-spiral').topArea! + q(doc, 'r-quarter').topArea!, 1e-3);
    close(rows[0]!.lengthMm!, q(doc, 'r-spiral').length! + q(doc, 'r-quarter').length!, 1e-6);
  });
});
