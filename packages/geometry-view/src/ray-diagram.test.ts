import { BoxGeometry, PlaneGeometry, SphereGeometry, type BufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import {
  rayDiagramSegments,
  rayFanDirections,
  traceRayFan,
  type RayDiagramBody,
  type RayFan,
  type RaySurface,
} from './ray-diagram';

const body = (
  g: BufferGeometry,
  surface: RaySurface,
  origin: [number, number, number] = [0, 0, 0],
): RayDiagramBody => ({
  origin,
  positions: g.getAttribute('position').array as Float32Array,
  normals: g.getAttribute('normal').array as Float32Array,
  indices: Uint32Array.from(g.getIndex()!.array),
  surface,
});

/** A paraboloid reflector z = r²/(4f) (opening along +z), its normals facing in (to the focus). */
function paraboloid(f: number, radius: number, rings = 48, segments = 96) {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const r = (radius * i) / rings;
    for (let j = 0; j < segments; j++) {
      const a = (2 * Math.PI * j) / segments;
      const [x, y] = [r * Math.cos(a), r * Math.sin(a)];
      positions.push(x, y, (r * r) / (4 * f));
      // The gradient of z − r²/4f is (−x/2f, −y/2f, 1): inward, toward the focus.
      const n = [-x / (2 * f), -y / (2 * f), 1];
      const l = Math.hypot(...n);
      normals.push(...n.map((v) => v / l));
    }
  }
  for (let i = 0; i < rings; i++)
    for (let j = 0; j < segments; j++) {
      const a = i * segments + j;
      const b = i * segments + ((j + 1) % segments);
      indices.push(a, a + segments, b, b, a + segments, b + segments);
    }
  return {
    origin: [0, 0, 0] as [number, number, number],
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    indices: Uint32Array.from(indices),
  };
}

const fan = (patch: Partial<RayFan>): RayFan => ({
  focus: [0, 0, 0],
  direction: [0, 0, -1],
  planeNormal: [0, 1, 0],
  spreadDeg: 120,
  count: 9,
  maxBounces: 4,
  exitLength: 500,
  ...patch,
});

describe('ray diagram (CR6c, TS-1596)', () => {
  it('spreads the fan evenly in its plane', () => {
    const dirs = rayFanDirections(fan({ count: 3, spreadDeg: 90 }));
    expect(dirs.map((d) => d.toArray().map((v) => +v.toFixed(6)))).toEqual([
      [0.707107, 0, -0.707107],
      [0, 0, -1],
      [-0.707107, 0, -0.707107],
    ]);
    expect(rayFanDirections(fan({ count: 1 }))[0]!.toArray()).toEqual([0, 0, -1]);
    expect(() => rayFanDirections(fan({ planeNormal: [0, 0, 1] }))).toThrow(/plane/);
  });

  it('sends the rays from a paraboloid’s focus out parallel to its axis', () => {
    const f = 25;
    const reflector = { ...paraboloid(f, 60), surface: { kind: 'mirror' } as const };
    const rays = traceRayFan([reflector], fan({ focus: [0, 0, f], spreadDeg: 140, count: 15 }));
    for (const r of rays) {
      expect(r.events).toEqual(['mirror']);
      expect(r.end).toBe('escaped');
      const [hit, end] = [r.points[1]!, r.points[2]!];
      const dir = end.map((v, i) => v - hit[i]!);
      const l = Math.hypot(...dir);
      // Within a quarter of a degree of the axis on the 48×96 mesh.
      expect(dir[2]! / l).toBeGreaterThan(Math.cos((0.25 * Math.PI) / 180));
      // The hit is on the surface: z = r²/4f.
      expect(hit[2]).toBeCloseTo((hit[0]! ** 2 + hit[1]! ** 2) / (4 * f), 1);
    }
  });

  it('refracts through a slab and comes out parallel, offset; total reflection inside a ball', () => {
    // A 10 mm slab of PMMA (1.49) across the ray at 30° from its normal.
    const slab = body(new BoxGeometry(200, 200, 10), { kind: 'refract', ior: 1.49 }, [0, 0, 50]);
    const a = (30 * Math.PI) / 180;
    const [r] = traceRayFan(
      [slab],
      fan({ direction: [Math.sin(a), 0, Math.cos(a)], count: 1, spreadDeg: 0 }),
    );
    expect(r!.events).toEqual(['refract', 'refract']);
    const [, enter, leave, end] = r!.points;
    const inside = leave!.map((v, i) => v - enter![i]!);
    // Snell: sin 30° = 1.49 sin θ.
    expect(Math.atan2(inside[0]!, inside[2]!)).toBeCloseTo(Math.asin(Math.sin(a) / 1.49), 3);
    const outside = end!.map((v, i) => v - leave![i]!);
    expect(Math.atan2(outside[0]!, outside[2]!)).toBeCloseTo(a, 3);
    // From inside a glass ball at a steep angle to its wall: reflected back in.
    const ball = body(new SphereGeometry(50, 96, 64), { kind: 'refract', ior: 1.5 });
    const [inner] = traceRayFan(
      [ball],
      fan({ focus: [0, 0, 45], direction: [1, 0, 0], count: 1, spreadDeg: 0, maxBounces: 1 }),
    );
    expect(inner!.events).toEqual(['internal']);
  });

  it('keeps a thin lens far from the model origin apart (traced from the focus)', () => {
    // A 0.02 mm slab at x = 1,000,000: in Float32 model coordinates both faces would round to
    // the same place; relative to the focus they stay 0.02 mm apart.
    const far = 1_000_000;
    const slab = body(new BoxGeometry(10, 10, 0.02), { kind: 'refract', ior: 1.5 }, [far, 0, 5]);
    const a = (30 * Math.PI) / 180;
    const [r] = traceRayFan(
      [slab],
      fan({ focus: [far, 0, 0], direction: [Math.sin(a), 0, Math.cos(a)], count: 1, spreadDeg: 0 }),
    );
    expect(r!.events).toEqual(['refract', 'refract']);
    const [focus, enter, leave] = r!.points;
    expect(focus).toEqual([far, 0, 0]);
    expect(enter![2]).toBeCloseTo(4.99, 4);
    expect(leave![2]).toBeCloseTo(5.01, 4);
    expect(enter![0]).toBeCloseTo(far + 4.99 * Math.tan(a), 3);
    // The segments keep doubles: the view takes its origin off before the Float32 rounding.
    const segments = rayDiagramSegments([r!]);
    expect(segments[3]! - segments[0]!).toBeCloseTo(4.99 * Math.tan(a), 4);
  });

  it('meets both faces of a 0.001 mm lens (the smallest CAD dimension)', () => {
    const film = body(new BoxGeometry(10, 10, 0.001), { kind: 'refract', ior: 1.5 }, [0, 0, 5]);
    const a = (40 * Math.PI) / 180;
    const [r] = traceRayFan(
      [film],
      fan({ direction: [Math.sin(a), 0, Math.cos(a)], count: 1, spreadDeg: 0 }),
    );
    expect(r!.events).toEqual(['refract', 'refract']);
    // Out in air again: parallel to the ray that came in.
    const [, , leave, end] = r!.points;
    const out = end!.map((v, i) => v - leave![i]!);
    expect(Math.atan2(out[0]!, out[2]!)).toBeCloseTo(a, 3);
  });

  it('stops at an opaque surface and at the bounce limit, and passes the lit source', () => {
    const wall = body(new PlaneGeometry(100, 100), { kind: 'opaque' }, [0, 0, -30]);
    const bulb = body(new SphereGeometry(5, 16, 12), { kind: 'pass' });
    const [r] = traceRayFan([bulb, wall], fan({ count: 1 }));
    expect(r!.end).toBe('absorbed');
    expect(r!.points).toHaveLength(2);
    expect(r!.points[1]![2]).toBeCloseTo(-30, 6);
    // Two facing mirrors: the ray goes back and forth until the limit.
    const top = body(new PlaneGeometry(100, 100), { kind: 'mirror' }, [0, 0, 10]);
    const bottom = body(new PlaneGeometry(100, 100), { kind: 'mirror' }, [0, 0, -10]);
    const [trapped] = traceRayFan([top, bottom], fan({ count: 1, maxBounces: 3 }));
    expect(trapped!.events).toEqual(['mirror', 'mirror', 'mirror']);
    expect(trapped!.end).toBe('bounces');
    expect(rayDiagramSegments([trapped!])).toHaveLength((trapped!.points.length - 1) * 6);
    // Nothing to meet.
    const [free] = traceRayFan([], fan({ count: 1, exitLength: 70 }));
    expect(free).toEqual({
      points: [
        [0, 0, 0],
        [0, 0, -70],
      ],
      events: [],
      end: 'escaped',
    });
  });
});
