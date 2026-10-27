import { EditorSession } from '@editor-platform/editor-core';
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
  loopArea,
  proposeJoins,
  sub,
  validateBim,
  type BimDocument,
  type BimElement,
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
