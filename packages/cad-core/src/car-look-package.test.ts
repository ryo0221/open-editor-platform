import { describe, expect, it } from 'vitest';
import {
  f82Occupant,
  f82OccupantBoxes,
  f82Package,
  f82Rules,
  steeredTyre,
} from './car-look-package';

type V2 = readonly [number, number];

/** Inside a closed polygon (even-odd), or on it within 1e-9. */
function inside(poly: readonly V2[], [x, y]: V2): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
/** The envelope's top (largest z) above x. */
function top(poly: readonly V2[], x: number): number {
  let best = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    if ((a[0] - x) * (b[0] - x) > 0 || a[0] === b[0]) continue;
    best = Math.max(best, a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]));
  }
  return best;
}
const planHalf = (x: number) =>
  top(
    f82Rules.plan.concat([
      [3400, 0],
      [-950, 0],
    ]),
    x,
  );
const corners = ([a, b]: readonly [readonly number[], readonly number[]]) =>
  [a[0]!, b[0]!].flatMap((x) => [a[2]!, b[2]!].map((z) => [x, z] as V2));
const overlap = (
  [a0, a1]: readonly [readonly number[], readonly number[]],
  [b0, b1]: readonly [readonly number[], readonly number[]],
) => [0, 1, 2].every((k) => a0[k]! < b1[k]! && b0[k]! < a1[k]!);

describe('F82: the package of 「翔」 (CL2, TS-2011)', () => {
  const r = f82Rules;
  const h = r.hPoint;
  const o = f82Occupant;
  const driver = f82OccupantBoxes(h);
  const front = r.tyre.front;
  const rear = r.tyre.rear;

  it('holds the occupants: headroom, the back before the firewall, the heels on the floor', () => {
    const head = h.z + o.headTop[1];
    expect(head).toBe(1036);
    // 30 mm at least under the roof's inner surface, above the head's top.
    expect(r.roofInner - head).toBeGreaterThanOrEqual(30);
    expect(top(r.side, h.x + o.headTop[0])).toBe(r.roof);
    expect(h.x + o.backX + 60).toBeLessThanOrEqual(r.firewall);
    expect(h.z + o.heelZ).toBeGreaterThanOrEqual(r.floor);
    // The toes behind the front tyre at full lock (its plan outline ends ahead of them).
    const steered = steeredTyre(0, r.track.front / 2, front.diameter, front.width, r.steerDegrees);
    const tyreRear = Math.max(...steered.map((p) => p[0]));
    const feetOut = h.y + o.foot.y + o.foot.half;
    const tyreIn = Math.min(...steered.map((p) => p[1]));
    expect(h.x + o.toeX > tyreRear || feetOut < tyreIn).toBe(true);
    // Every occupant box inside the side envelope.
    for (const box of [driver.head, driver.thighs, driver.shins])
      for (const c of corners(box)) expect(inside(r.side, c), `${c}`).toBe(true);
    for (const c of driver.torso.side) expect(inside(r.side, c), `${c}`).toBe(true);
  });

  it('keeps the windscreen ahead of the head, raked 25–35°, and the road in view', () => {
    const [[bx, bz], [tx, tz]] = [r.screen.base, r.screen.header];
    const rake = (Math.atan2(tz - bz, tx - bx) * 180) / Math.PI;
    expect(rake).toBeGreaterThan(25);
    expect(rake).toBeLessThan(35);
    // At the head's top the glass is 100 mm or more ahead of the head's front.
    const head = h.z + o.headTop[1];
    const glassX = bx + ((head - bz) * (tx - bx)) / (tz - bz);
    expect(h.x + o.headFrontX - glassX).toBeGreaterThanOrEqual(100);
    // Down vision: over the front fenders' top and over the cowl, 5° or more below level.
    const eye: V2 = [h.x + o.eye[0], h.z + o.eye[1]];
    const down = ([x, z]: V2) => (Math.atan2(eye[1] - z, eye[0] - x) * 180) / Math.PI;
    expect(down([0, top(r.side, 0)])).toBeGreaterThanOrEqual(5);
    expect(down(r.screen.base)).toBeGreaterThanOrEqual(5);
    // The glass below the envelope's line.
    expect(top(r.side, tx)).toBeGreaterThanOrEqual(tz);
  });

  it('covers the wheels at full bump in side and plan, within CL1’s 0–20 mm', () => {
    for (const [x, d] of [
      [0, front.diameter],
      [r.wheelbase, rear.diameter],
    ] as const)
      expect(top(r.side, x)).toBeGreaterThanOrEqual(d + r.bump + r.archGap);
    for (const [x, tyre, track] of [
      [0, front, r.track.front],
      [r.wheelbase, rear, r.track.rear],
    ] as const) {
      const cover = planHalf(x) - (track / 2 + tyre.width / 2);
      expect(cover).toBeGreaterThanOrEqual(0);
      expect(cover).toBeLessThanOrEqual(20);
    }
    // Steered, the tyre swings inwards (towards the luggage and the feet, checked below) and its
    // corners outwards past the plan outline, as any car's at full lock: the arch, not the plan,
    // covers them.
  });

  it('places the machinery inside the envelope, clear of each other, the occupants and the wheels', () => {
    const boxes = Object.entries(r.boxes);
    // The reclined torso by its bounds (larger than the box itself: a conservative check).
    const torsoBounds = (b: ReturnType<typeof f82OccupantBoxes>) => {
      const xs = b.torso.side.map((p) => p[0]);
      const zs = b.torso.side.map((p) => p[1]);
      const [, y0] = b.torso.origin;
      return [
        [Math.min(...xs), y0, Math.min(...zs)],
        [Math.max(...xs), y0 + b.torso.size[1], Math.max(...zs)],
      ] as const;
    };
    const mirrored = f82OccupantBoxes({ ...h, y: -h.y });
    const occupants = [driver, mirrored].flatMap((b) => [
      torsoBounds(b),
      b.head,
      b.thighs,
      b.shins,
    ]);
    // The wheels' boxes at full bump (and the front ones steered).
    // The swept plan outline's bounds, up to full bump.
    const wheel = (x: number, d: number, w: number, track: number, side: 1 | -1, steer: number) => {
      const p = steeredTyre(x, (side * track) / 2, d, w, steer);
      const xs = p.map((q) => q[0]);
      const ys = p.map((q) => q[1]);
      return [
        [Math.min(...xs), Math.min(...ys), 0],
        [Math.max(...xs), Math.max(...ys), d + r.bump],
      ] as const;
    };
    const wheels = [1, -1].flatMap((s) => [
      wheel(0, front.diameter, front.width, r.track.front, s as 1 | -1, r.steerDegrees),
      wheel(r.wheelbase, rear.diameter, rear.width, r.track.rear, s as 1 | -1, 0),
    ]);
    for (const [name, box] of boxes) {
      for (const c of corners(box)) expect(inside(r.side, c), `${name} ${c}`).toBe(true);
      for (const y of [box[0][1], box[1][1]])
        for (const x of [box[0][0], box[1][0]])
          expect(Math.abs(y), `${name} plan`).toBeLessThanOrEqual(planHalf(x));
      for (const [other, b] of boxes)
        if (other !== name) expect(overlap(box, b), `${name} ${other}`).toBe(false);
      for (const b of occupants) expect(overlap(box, b), `${name} occupant`).toBe(false);
      for (const b of wheels) expect(overlap(box, b), `${name} wheel`).toBe(false);
    }
    // The engine behind the firewall, the rear axle through the gearbox.
    expect(r.boxes.engine![0][0]).toBeGreaterThanOrEqual(r.firewall);
    const g = r.boxes.gearbox!;
    expect(g[0][0] < r.wheelbase && r.wheelbase < g[1][0]).toBe(true);
    expect(g[0][2] < rear.diameter / 2 && rear.diameter / 2 < g[1][2]).toBe(true);
    // 50 L of fuel.
    const f = r.boxes.fuel!;
    expect(((f[1][0] - f[0][0]) * (f[1][1] - f[0][1]) * (f[1][2] - f[0][2])) / 1e6).toBeCloseTo(
      49.5,
      1,
    );
  });

  it('is a document: wheels, occupants and machinery as bodies, the envelopes as sketches', () => {
    const doc = f82Package();
    expect(doc.bodies.map((b) => b.name)).toEqual([
      'Front right wheel',
      'Front left wheel',
      'Rear right wheel',
      'Rear left wheel',
      'Driver torso',
      'Driver head',
      'Driver thighs',
      'Driver shins',
      'Passenger torso',
      'Passenger head',
      'Passenger thighs',
      'Passenger shins',
      'Engine',
      'Gearbox',
      'Fuel tank',
      'Right radiator',
      'Left radiator',
      'Front luggage',
    ]);
    expect(doc.sketches.map((s) => s.id)).toEqual(['package-side', 'package-plan']);
    const side = doc.sketches[0]!;
    expect(side.entities.filter((e) => e.type === 'line')).toHaveLength(r.side.length + 1);
    expect(side.entities.filter((e) => e.type === 'circle').map((e) => e.id)).toEqual([
      'archF',
      'archR',
    ]);
  });
});
