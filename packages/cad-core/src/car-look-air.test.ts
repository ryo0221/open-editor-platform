import { describe, expect, it } from 'vitest';
import { f83Air, f83DiffuserDegrees, f83Package, f83TunnelRoof } from './car-look-air';
import { f82OccupantBoxes, f82Rules, steeredTyre } from './car-look-package';

type V2 = readonly [number, number];
type Box = readonly [readonly number[], readonly number[]];

/** The envelope's top (largest v) above u, along a closed polygon. */
function top(poly: readonly V2[], u: number): number {
  let best = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    if ((a[0] - u) * (b[0] - u) > 0 || a[0] === b[0]) continue;
    best = Math.max(best, a[1] + ((b[1] - a[1]) * (u - a[0])) / (b[0] - a[0]));
  }
  return best;
}
const r = f82Rules;
const front = -r.overhang.front;
const tail = r.wheelbase + r.overhang.rear;
const planHalf = (x: number) =>
  top(
    r.plan.concat([
      [tail, 0],
      [front, 0],
    ]),
    x,
  );
/** Inside the car: within the side envelope's top and the plan's half width, above the ground. */
const inCar = (x: number, y: number, z: number) =>
  x >= front && x <= tail && z >= r.clearance && z <= top(r.side, x) && Math.abs(y) <= planHalf(x);

describe('F83: the air story of 「翔」 (CL3, TS-2013)', () => {
  const a = f83Air;
  const t = a.tunnel;

  it('runs a flat floor into a 10° diffuser in two tunnels', () => {
    expect(a.floor.z).toBe(r.clearance);
    expect(a.floor.to).toBe(t.start);
    expect(f83DiffuserDegrees()).toBeGreaterThanOrEqual(7);
    expect(f83DiffuserDegrees()).toBeLessThanOrEqual(12);
    expect(f83TunnelRoof(t.start)).toBe(t.roofStart);
    expect(f83TunnelRoof(t.exit)).toBe(t.roofExit);
    // The exit opens in the tail below the deck.
    expect(t.exit).toBe(tail);
    expect(t.roofExit).toBeLessThan(top(r.side, tail));
  });

  it('keeps the tunnels clear of the machinery, the occupants and the wheels', () => {
    const occupants = [r.hPoint.y, -r.hPoint.y].flatMap((y) => {
      const b = f82OccupantBoxes({ ...r.hPoint, y });
      return [b.head, b.thighs, b.shins];
    });
    const wheels: Box[] = [1, -1].flatMap((s) =>
      [
        [0, r.tyre.front, r.track.front, r.steerDegrees],
        [r.wheelbase, r.tyre.rear, r.track.rear, 0],
      ].map(([x, tyre, track, steer]) => {
        const ty = tyre as { diameter: number; width: number };
        const p = steeredTyre(
          x as number,
          (s * (track as number)) / 2,
          ty.diameter,
          ty.width,
          steer as number,
        );
        return [
          [Math.min(...p.map((q) => q[0])), Math.min(...p.map((q) => q[1])), 0],
          [Math.max(...p.map((q) => q[0])), Math.max(...p.map((q) => q[1])), ty.diameter + r.bump],
        ] as const;
      }),
    );
    const boxes: [string, Box][] = [
      ...Object.entries(r.boxes),
      ...occupants.map((b, k) => [`occupant ${k}`, b] as [string, Box]),
      ...wheels.map((b, k) => [`wheel ${k}`, b] as [string, Box]),
    ];
    for (const [name, [lo, hi]] of boxes)
      for (const [y0, y1] of [
        [t.inner, t.outer],
        [-t.outer, -t.inner],
      ] as const) {
        const acrossOverlap = lo[1]! < y1 && y0 < hi[1]!;
        const alongOverlap = lo[0]! < t.exit && t.start < hi[0]!;
        if (!acrossOverlap || !alongOverlap) continue;
        // The roof is highest at the box's rear end within the tunnel.
        const roof = f83TunnelRoof(Math.min(hi[0]!, t.exit));
        expect(lo[2]!, `${name} over the tunnel`).toBeGreaterThanOrEqual(roof);
      }
  });

  it('puts every opening on the skin, and starts and ends the paths where they belong', () => {
    for (const o of a.openings) {
      const x = (o.x[0] + o.x[1]) / 2;
      // The opening's outer edge within 80 mm of the envelope: an end face, the side or the top.
      const gaps = [
        Math.abs(o.x[0] - front),
        Math.abs(o.x[1] - tail),
        planHalf(x) - o.y[1],
        top(r.side, x) - o.z[1],
      ];
      expect(Math.min(...gaps), o.id).toBeLessThanOrEqual(80);
      expect(Math.min(...gaps), o.id).toBeGreaterThanOrEqual(-1e-9);
    }
    for (const p of a.paths) {
      // One path in both views: the same x at its start and its end.
      expect(p.side[0]![0], p.id).toBe(p.plan[0]![0]);
      expect(p.side.at(-1)![0], p.id).toBe(p.plan.at(-1)![0]);
      const at = (k: 0 | -1) => {
        const s = k === 0 ? p.side[0]! : p.side.at(-1)!;
        const q = k === 0 ? p.plan[0]! : p.plan.at(-1)!;
        return [s[0], q[1], s[1]] as const;
      };
      const [start, end] = [at(0), at(-1)];
      if (p.id === 'wake') expect(inCar(...start), p.id).toBe(true);
      else expect(inCar(...start), `${p.id} start`).toBe(false);
      if (p.id === 'engine') {
        const [lo, hi] = r.boxes.engine!;
        expect(end[0] >= lo[0]! && end[0] <= hi[0]! && end[2] <= hi[2]! && end[1] <= hi[1]!).toBe(
          true,
        );
      } else expect(inCar(...end), `${p.id} end`).toBe(false);
    }
  });

  it('sizes the side intakes to the radiators', () => {
    const intake = a.openings.find((o) => o.id === 'side-intake')!;
    const [lo, hi] = r.boxes.radiatorRight!;
    const face = (hi[0]! - lo[0]!) * (hi[2]! - lo[2]!);
    const opening = (intake.x[1] - intake.x[0]) * (intake.z[1] - intake.z[0]);
    // The intake's face 0.8–1.5 times the radiator's: it slows the air onto the core.
    expect(opening / face).toBeGreaterThanOrEqual(0.8);
    expect(opening / face).toBeLessThanOrEqual(1.5);
  });

  it('is F82 with the two air sketches', () => {
    const doc = f83Package();
    expect(doc.sketches.map((s) => s.id)).toEqual([
      'package-side',
      'package-plan',
      'air-side',
      'air-plan',
    ]);
    expect(doc.bodies).toHaveLength(18);
    const side = doc.sketches[2]!;
    // Each arrow: the path's lines and the head's three.
    for (const p of a.paths)
      expect(
        side.entities.filter((e) => e.type === 'line' && e.id.startsWith(`f-${p.id}l`)),
      ).toHaveLength(p.side.length - 1 + 3);
  });
});
