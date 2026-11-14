import { describe, expect, it } from 'vitest';
import { routeTrip, type Hazard, type SiteRoute } from '@editor-platform/construction-core';
import {
  hazardLooks,
  hazardSolid,
  moverSolids,
  newRoutePath,
  clockInDay,
  playStep,
  routeSolid,
  siteHazardId,
  siteMoverId,
  siteRouteId,
  sitePickPrefix,
  tripHeading,
  walkerMesh,
} from './index';

const flat = () => 1000;
const walk: SiteRoute = {
  id: 'walk',
  name: 'Walk',
  kind: 'worker',
  path: [
    [0, 0],
    [10000, 0],
    [10000, 10000],
  ],
  speedKmh: 4,
  taskId: 't',
  departures: ['08:00'],
  returns: true,
};
const truck: SiteRoute = { ...walk, id: 'truck', kind: 'truck', speedKmh: 10, returns: undefined };

const span = (positions: Float32Array, axis: number) => {
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = axis; k < positions.length; k += 3) {
    lo = Math.min(lo, positions[k]!);
    hi = Math.max(hi, positions[k]!);
  }
  return [lo, hi];
};

describe('CS5b people and trucks in the view (ST-550, TS-2086)', () => {
  it('draws a danger as a fence, tall while in force, and a route as a strip (ST-550#1)', () => {
    const h: Hazard = {
      id: 'z',
      kind: 'zone',
      name: 'Zone',
      from: 0,
      to: 60,
      distance: () => 0,
      outline: [
        [0, 0],
        [4000, 0],
        [4000, 4000],
        [0, 4000],
      ],
    };
    const now = hazardSolid(h, flat, true, true)!;
    expect(now.instances[0]).toMatchObject({ path: [siteHazardId('z')], selected: true });
    expect(now.meshes![0]!.color).toBe(hazardLooks.zone);
    expect(now.bounds[0][2]).toBeCloseTo(1000, 6);
    expect(now.bounds[1][2]).toBeCloseTo(2200, 6);
    // Closed: four sides round the outline, each of 4 m in two pieces.
    expect(now.meshes![0]!.mesh.indices.length).toBe(4 * 2 * 36);
    const later = hazardSolid(h, flat, false)!;
    expect(later.bounds[1][2]).toBeCloseTo(1400, 6);
    expect(later.meshes![0]!.opacity).toBeLessThan(now.meshes![0]!.opacity);
    const strip = routeSolid(walk, flat)!;
    expect(strip.instances[0]!.path).toEqual([siteRouteId('walk')]);
    // Open: two legs of 10 m, not back to the start, each in pieces of 2 m.
    expect(strip.meshes![0]!.mesh.indices.length).toBe(2 * 5 * 36);
    // Over a pit between its points the strip goes down into it, not across.
    const pit = (p: readonly [number, number]) => (p[0] > 3000 && p[0] < 7000 ? -1000 : 1000);
    const down = routeSolid(walk, pit)!;
    expect(down.bounds[0][2]).toBeCloseTo(-1000, 6);
    // A truck way is 600 wide: 300 either side of its first leg along +x.
    expect(routeSolid(truck, flat)!.bounds[0][1]).toBeCloseTo(-300, 6);
    expect(siteRouteId('a').startsWith(sitePickPrefix)).toBe(true);
  });

  it('puts walkers and trucks where their trips are, facing their way (ST-550#2)', () => {
    const out = routeTrip(walk, 480);
    const t = 480 + (out.end - out.start) / 8; // On the first leg, going +x.
    expect(tripHeading(out, t)).toBeCloseTo(0, 6);
    const back = 480 + ((out.end - out.start) * 7) / 8; // Coming back along the first leg.
    expect(Math.abs(tripHeading(out, back))).toBeCloseTo(Math.PI, 6);
    const lorry = routeTrip(truck, 480);
    const [w, k] = moverSolids([out, lorry], t, flat, 0.25);
    expect(w!.instances[0]!.path).toEqual([siteMoverId(0)]);
    const p = out.at(t);
    const m = w!.instances[0]!.matrix;
    expect([m[12], m[13], m[14]]).toEqual([p[0], p[1], 1000]);
    // Heading +x: the figure's own −y turns to +x.
    expect(m[0]).toBeCloseTo(0, 9);
    expect(m[1]).toBeCloseTo(1, 9);
    expect(k!.meshes![0]!.mesh.positions.length).toBeGreaterThan(0);
    expect(k!.bounds[1][2]).toBeCloseTo(1000 + 1600 + 1300, 6);
    // Before and after their trips, no one.
    expect(moverSolids([out, lorry], 470, flat)).toEqual([]);
    expect(moverSolids([out], out.end + 1, flat)).toEqual([]);
  });

  it('walks the blocky figure: its legs move with the stride (ST-550#2)', () => {
    const a = walkerMesh(0);
    const b = walkerMesh(0.25);
    // A person's height, standing on its own ground.
    const [zlo, zhi] = span(a.positions, 2);
    expect(zlo).toBeGreaterThanOrEqual(-50);
    expect(zhi).toBeGreaterThan(1500);
    expect(zhi).toBeLessThan(2100);
    expect(Array.from(b.positions)).not.toEqual(Array.from(a.positions));
    // One stride a second.
    expect(Array.from(walkerMesh(1).positions)).toEqual(Array.from(a.positions));
  });

  it("plays on through trips, skips idle minutes, and stops at the day's end (ST-550#2)", () => {
    const trips = [
      { start: 480, end: 490 },
      { start: 600, end: 1100 },
    ];
    expect(playStep(481, 0.5, trips, 1050)).toEqual({ clock: 481.5, done: false });
    // Nothing moves at 491: on to the next departure.
    expect(playStep(490.5, 0.5, trips, 1050)).toEqual({ clock: 600, done: false });
    // A trip running past the day's end stops there.
    expect(playStep(1049.8, 0.5, trips, 1050)).toEqual({ clock: 1050, done: true });
    // A clock left past the end by shorter hours goes back to the end.
    expect(playStep(1100, 0.5, trips, 1050)).toEqual({ clock: 1050, done: true });
    expect(clockInDay(1100, [450, 1050])).toBe(1050);
    expect(clockInDay(400, [450, 1050])).toBe(450);
    expect(clockInDay(600, [450, 1050])).toBe(600);
    // A departure after the end is not jumped to.
    expect(
      playStep(
        491,
        0.5,
        [
          { start: 480, end: 490 },
          { start: 1080, end: 1090 },
        ],
        1050,
      ),
    ).toEqual({ clock: 1050, done: true });
    // No trip left: stop where it is.
    expect(playStep(700, 0.5, [{ start: 480, end: 490 }], 1050)).toEqual({
      clock: 700.5,
      done: true,
    });
  });

  it('gives a new route a way with a length (ST-550#1)', () => {
    expect(newRoutePath([0, 0], [0, 0])).toEqual([
      [0, 0],
      [10000, 0],
    ]);
    expect(newRoutePath([0, 0], [5, 5])).toEqual([
      [0, 0],
      [5, 5],
    ]);
  });
});
