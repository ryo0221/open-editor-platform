import { describe, expect, it } from 'vitest';
import { deriveBim } from '@editor-platform/bim-core';
import { addDays } from '@editor-platform/time-axis';
import {
  applyConstructionOperation,
  approachesOnDay,
  clockMinutes,
  f88Building,
  f89OfficeTraffic,
  gateCounts,
  hazardsOnDay,
  liftTimes,
  liftsPastDayEnd,
  routeTrip,
  scheduleConstruction,
  siteTaskRefs,
  siteTerrain,
  tripsOnDay,
  validateConstruction,
  workingDay,
  type ConstructionDocument,
  type HazardWorld,
  type Plan,
  type Point3,
} from './index';

const bim = f88Building();
const derived = deriveBim(bim);
/** Each column placed at its own axis, 600 × 600. */
const world = (doc: ConstructionDocument): HazardWorld => ({
  terrain: siteTerrain(doc.site),
  place: (id) => {
    const s = derived.shapes.get(id);
    return s?.kind === 'column' ? { centre: [s.at[0], s.at[1]], half: [300, 300] } : undefined;
  },
});

describe('CS5 people and trucks on the site (ST-549, TS-2085)', () => {
  it('keeps routes, zones and hours valid, and edits them (ST-549#1)', () => {
    const doc = f89OfficeTraffic(bim);
    expect(validateConstruction(doc)).toEqual([]);
    const codes = (d: ConstructionDocument) => validateConstruction(d).map((x) => [x.code, x.path]);
    const bad = structuredClone(doc);
    const r = bad.site!.routes![0]!;
    r.path = [[0, 0]];
    r.speedKmh = 0;
    r.departures = ['10:30', '08:00'];
    bad.site!.zones![0]!.hours = ['15:00', '13:00'];
    bad.site!.zones![0]!.id = 'gate';
    bad.site!.hours = { start: '25:00', end: '17:00' };
    expect(codes(bad)).toEqual([
      ['hours', '$.site.hours'],
      ['route', '$.site.routes[0].path'],
      ['speed', '$.site.routes[0].speedKmh'],
      ['departures', '$.site.routes[0].departures'],
      ['duplicate-id', '$.site.zones[0].id'],
      ['hours', '$.site.zones[0].hours'],
    ]);
    // A trip is kept within its day: 1 km at 1 km/h from 23:50 runs past midnight.
    const late = structuredClone(doc);
    late.site!.routes![1]!.path = [
      [0, 0],
      [1000000, 0],
    ];
    late.site!.routes![1]!.speedKmh = 1;
    late.site!.routes![1]!.departures = ['22:50'];
    expect(codes(late)).toEqual([]);
    late.site!.routes![1]!.departures = ['23:50'];
    expect(validateConstruction(late).map((x) => [x.path, x.message])).toEqual([
      ['$.site.routes[1].departures', 'the trip from 23:50 runs past midnight'],
    ]);
    expect(siteTaskRefs(doc.site).has('col-1')).toBe(true);
    let d = applyConstructionOperation(doc, {
      type: 'putRoute',
      route: { ...doc.site!.routes![0]!, speedKmh: 15 },
    });
    expect(d.site!.routes![0]!.speedKmh).toBe(15);
    d = applyConstructionOperation(d, { type: 'removeZone', id: 'rebar-cutting' });
    expect(d.site).not.toHaveProperty('zones');
    expect(() => applyConstructionOperation(d, { type: 'removeRoute', id: 'nope' })).toThrow(
      'no route nope',
    );
    d = applyConstructionOperation(d, { type: 'setSiteHours', hours: undefined });
    expect(d.site).not.toHaveProperty('hours');
    expect(clockMinutes('07:30')).toBe(450);
    expect(clockMinutes('7:30')).toBeUndefined();
  });

  it('follows each trip along its way and back (ST-549#2)', () => {
    const doc = f89OfficeTraffic(bim);
    const truck = doc.site!.routes![0]!;
    const trip = routeTrip(truck, 510);
    // 4.2 + 29 + 13 m out and back at 10 km/h (166.7 m a minute).
    const len = 4200 + 29000 + 13000;
    expect(trip.end - trip.start).toBeCloseTo((2 * len) / (10e6 / 60), 9);
    const half = (trip.start + trip.end) / 2;
    expect(trip.at(half)[0]).toBeCloseTo(52000, 6);
    expect(trip.at(half)[1]).toBeCloseTo(2500, 6);
    const back = trip.at(trip.end);
    expect(back[0]).toBeCloseTo(23000, 6);
    expect(back[1]).toBeCloseTo(-14700, 6);
    const plan = scheduleConstruction(doc);
    const day = plan.byId.get('col-1')!.start;
    expect(tripsOnDay(doc, plan, day).map((t) => [t.routeId, t.start])).toEqual([
      ['truck-steel', 510],
      ['truck-steel', 630],
      ['truck-steel', 810],
      ['walk-office', 460],
      ['walk-office', 770],
    ]);
    // No trips on a day off, or before the task.
    const sunday = '2027-04-18';
    expect(workingDay(doc, sunday)).toBe(false);
    expect(tripsOnDay(doc, plan, sunday)).toEqual([]);
    expect(tripsOnDay(doc, plan, plan.byId.get('site')!.start)).toEqual([]);
  });

  it('finds the dangers of the day: zones, loads, the slewing circle, the pit edge (ST-549#3)', () => {
    const doc = f89OfficeTraffic(bim);
    const plan = scheduleConstruction(doc);
    const day = plan.byId.get('col-1')!.start;
    const hazards = hazardsOnDay(doc, plan, world(doc), day);
    const byKind = (k: string) => hazards.filter((h) => h.kind === k);
    // The rebar area in the afternoon; the day's six lifts of 20 minutes from 07:30.
    expect(byKind('zone').map((h) => [h.id, h.from, h.to])).toEqual([['rebar-cutting', 780, 900]]);
    expect(byKind('load').map((h) => h.from)).toEqual([450, 470, 490, 510, 530, 550]);
    expect(byKind('slew').map((h) => [h.id, h.from, h.to])).toEqual([['tc-1:slew', 450, 570]]);
    // Under the load: on its way from the yard, not beside it.
    const load = byKind('load')[0]!;
    expect(load.distance([52000, 11000])).toBe(0);
    expect(load.distance([52000, 40000])).toBeGreaterThan(20000);
    // The slewing circle: 50 m round the mast.
    const slew = byKind('slew')[0]!;
    expect(slew.distance([21600 + 50000, -6000])).toBeCloseTo(0, 6);
    expect(slew.distance([21600 + 51000, -6000])).toBeCloseTo(1000, 6);
    // The pit's edge: inside the cut and out to the top of its side.
    const edge = byKind('edge')[0]!;
    expect(edge.id).toBe('pit:edge');
    expect(edge.distance([20000, 10000])).toBe(0);
    // Before the pit is dug, no edge; on a day with no lifts, no loads.
    const pit = doc.site!.earthworks.find((w) => w.id === 'pit')!;
    const dig = plan.byId.get(pit.taskId)!.start;
    const before = hazardsOnDay(doc, plan, world(doc), addDays(dig, -1));
    expect(before.filter((h) => h.kind === 'edge')).toEqual([]);
    const late = plan.byId.get('roof')!.start;
    expect(hazardsOnDay(doc, plan, world(doc), late).filter((h) => h.kind === 'load')).toEqual([]);
    // The edge's fence stands on the top of the side, outside the floor's outline.
    const xs = edge.outline.map((p) => p[0]);
    const floor = pit.outline.map((p) => p[0]);
    expect(Math.min(...xs)).toBeLessThan(Math.min(...floor));
    expect(Math.max(...xs)).toBeGreaterThan(Math.max(...floor));
    // A lift straight up (picked where it is placed): its load's footprint still has an area.
    const up = structuredClone(doc);
    const first = up.site!.lifts!.find((l) => l.id === load.id)!;
    const place = world(up).place(first.elementId)!;
    first.pick = [place.centre[0], place.centre[1], 1000];
    const still = hazardsOnDay(up, plan, world(up), day).find((h) => h.id === load.id)!;
    const ys = still.outline.map((p) => p[1]);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(800);
    // A long slew (50 m out, a quarter turn): the load's way is the arc, not chords inside it.
    const arc = structuredClone(doc);
    const base = arc.site!.cranes![0]!.base;
    const lift = arc.site!.lifts!.find((l) => l.id === load.id)!;
    lift.pick = [base[0] + 50000, base[1], 1000];
    const far: HazardWorld = {
      ...world(arc),
      place: () => ({ centre: [base[0], base[1] + 50000], half: [300, 300] }),
    };
    const swing = hazardsOnDay(arc, plan, far, day).find((h) => h.id === load.id)!;
    const out = 50000 + Math.hypot(300, 300) + 990;
    const a = 0.7417;
    const read = swing.distance([base[0] + out * Math.cos(a), base[1] + out * Math.sin(a)]);
    expect(read).toBeLessThanOrEqual(990);
    expect(read).toBeGreaterThan(980);
    // Straight out (10 m to 20 m): the footprints at the pick and the place are in the outline.
    const radial = structuredClone(arc);
    radial.site!.lifts!.find((l) => l.id === load.id)!.pick = [base[0] + 10000, base[1], 1000];
    const outward: HazardWorld = {
      ...world(radial),
      place: () => ({ centre: [base[0] + 20000, base[1]], half: [300, 300] }),
    };
    const straight = hazardsOnDay(radial, plan, outward, day).find((h) => h.id === load.id)!;
    const rx = straight.outline.map((p) => p[0]);
    expect(Math.min(...rx)).toBeLessThan(base[0] + 9700);
    expect(Math.max(...rx)).toBeGreaterThan(base[0] + 20300);
    // Out from 5 m to 50 m while slewing a little: the way is the spiral, not one chord.
    const spiral = structuredClone(arc);
    spiral.site!.lifts!.find((l) => l.id === load.id)!.pick = [base[0] + 5000, base[1], 1000];
    const wide: HazardWorld = {
      ...world(spiral),
      place: () => ({
        centre: [base[0] + 50000 * Math.cos(0.05), base[1] + 50000 * Math.sin(0.05)],
        half: [300, 300],
      }),
    };
    const curl = hazardsOnDay(spiral, plan, wide, day).find((h) => h.id === load.id)!;
    const near = curl.distance([base[0] + 38836.5233, base[1] + 43.1036]);
    expect(near).toBeLessThanOrEqual(990);
    expect(near).toBeGreaterThan(975);
  });

  it('lists every approach by date and time, and counts the gate (ST-549#3, #4)', () => {
    const doc = f89OfficeTraffic(bim);
    const plan = scheduleConstruction(doc);
    const day = plan.byId.get('col-1')!.start;
    const rows = approachesOnDay(doc, plan, world(doc), day).map((a) => [
      a.routeId,
      a.departure,
      a.hazardId,
      a.from,
      a.to,
    ]);
    expect(rows).toEqual([
      ['walk-office', '07:40', 'tc-1:slew', '07:40:00', '07:41:07'],
      ['walk-office', '07:40', 'pit:edge', '07:40:34', '07:41:03'],
      ['walk-office', '07:40', 'lift-c-1-1-1', '07:40:49', '07:40:53'],
      ['truck-steel', '08:30', 'tc-1:slew', '08:30:00', '08:30:33'],
      ['walk-office', '12:50', 'pit:edge', '12:50:34', '12:51:03'],
      ['truck-steel', '13:30', 'rebar-cutting', '13:30:03', '13:30:07'],
      ['truck-steel', '13:30', 'rebar-cutting', '13:30:27', '13:30:30'],
    ]);
    // The truck passes 1.5 m from the rebar area: within its 2 m margin, not inside.
    const rebar = approachesOnDay(doc, plan, world(doc), day).find(
      (a) => a.hazardId === 'rebar-cutting',
    )!;
    expect(rebar.closest).toBe(1000);
    // Workers walking later than the lifts are clear of their loads.
    const later = structuredClone(doc);
    later.site!.routes![1]!.departures = ['10:00'];
    expect(
      approachesOnDay(later, plan, world(later), day).filter((a) => a.hazardKind === 'load'),
    ).toEqual([]);
    expect(gateCounts(doc, plan, day)).toEqual({
      counts: [{ gateId: 'gate', trucks: 3, workers: 2 }],
      notes: [],
    });
    // A truck way that starts and ends away from the gate is named.
    const lost = structuredClone(doc);
    lost.site!.routes![0]!.path = [
      [0, 0],
      [1000, 0],
    ] as Plan[];
    expect(gateCounts(lost, plan, day).notes.map((n) => n.message)).toEqual([
      "Steel delivery: the truck's way starts and ends at no gate",
    ]);
  });

  it("keeps each crane's spells apart, follows rising ground past a cut, counts both gates, catches short spells (ST-549#3, #4)", () => {
    const doc = f89OfficeTraffic(bim);
    const plan = scheduleConstruction(doc);
    const day = plan.byId.get('col-1')!.start;
    // Lifts A, B, A, A, A, A: crane A slews 07:30–07:50 and 08:10–09:30, not between.
    const two = structuredClone(doc);
    const tc1 = two.site!.cranes![0]!;
    two.site!.cranes!.push({ ...structuredClone(tc1), id: 'tc-2', name: 'Tower crane 2' });
    const times = liftTimes(two, plan);
    const today = two
      .site!.lifts!.filter((l) => times.get(l.id)?.day === day)
      .sort((a, b) => times.get(a.id)!.order - times.get(b.id)!.order);
    today[1]!.craneId = 'tc-2';
    const slews = hazardsOnDay(two, plan, world(two), day).filter((h) => h.kind === 'slew');
    expect(slews.map((h) => [h.id, h.from, h.to])).toEqual([
      ['tc-1:slew', 450, 470],
      ['tc-1:slew', 490, 570],
      ['tc-2:slew', 470, 490],
    ]);

    // A cut whose ground rises beyond it (x / 2): its side meets the ground 12 m out, not 6.
    const cut = structuredClone(doc);
    const pit = cut.site!.earthworks.find((w) => w.id === 'pit')!;
    pit.outline = [
      [0, 0],
      [10000, 0],
      [10000, 10000],
      [0, 10000],
    ];
    pit.levelZ = -1000;
    pit.slope = 1;
    const rising: HazardWorld = {
      ...world(cut),
      terrain: { ...siteTerrain(cut.site), heightAt: (p: Plan) => p[0] / 2 },
    };
    const edge = hazardsOnDay(cut, plan, rising, day).find((h) => h.kind === 'edge')!;
    expect(edge.distance([22500, 5000])).toBeCloseTo(500, -1);
    expect(edge.distance([21000, 5000])).toBe(0);
    expect(edge.distance([5000, 5000])).toBe(0);
    // Ground rising along the side (y / 2): the nearest point of the top edge, not the one straight
    // out from the outline (13,720, 5,440 is 984 mm away; straight out 13,500, 5,000 is 1,100).
    const along: HazardWorld = {
      ...world(cut),
      terrain: { ...siteTerrain(cut.site), heightAt: (p: Plan) => p[1] / 2 },
    };
    const side = hazardsOnDay(cut, plan, along, day).find((h) => h.kind === 'edge')!;
    expect(side.distance([14600, 5000])).toBeCloseTo(984, -1);
    expect(side.distance([13000, 5000])).toBe(0);
    // A ridge of the survey between two steps of the outline (the ground 1 m up along y = 5,125,
    // down to 0 at 100 mm either side): the edge follows it out to 12,000.
    const rows = [0, 5025, 5125, 5225, 10000];
    const cols = [-5000, 30000];
    const points: Point3[] = rows.flatMap((y) =>
      cols.map((x): Point3 => [x, y, y === 5125 ? 1000 : 0]),
    );
    const triangles: number[] = [];
    for (let r = 0; r + 1 < rows.length; r++) {
      const [i, j] = [r * 2, (r + 1) * 2];
      triangles.push(i, i + 1, j + 1, i, j + 1, j);
    }
    const ridge: HazardWorld = {
      ...world(cut),
      terrain: {
        bounds: [
          [-5000, 0],
          [30000, 10000],
        ],
        points,
        triangles: Uint32Array.from(triangles),
        heightAt: (p: Plan) => Math.max(0, 1000 * (1 - Math.abs(p[1] - 5125) / 100)),
      },
    };
    const top = hazardsOnDay(cut, plan, ridge, day).find((h) => h.kind === 'edge')!;
    expect(top.distance([12500, 5125])).toBeGreaterThan(490);
    expect(top.distance([12500, 5125])).toBeLessThanOrEqual(500);
    // Ground that dips under the side (12 m out) and rises above it again: cut out to 15 m.
    const xz: [number, number][] = [
      [-5000, 0],
      [10000, 0],
      [11000, 0],
      [12000, -1000],
      [14000, 4000],
      [15000, 4000],
      [30000, 4000],
    ];
    const valley: Point3[] = [-5000, 15000].flatMap((y) => xz.map(([x, z]): Point3 => [x, y, z]));
    const strips: number[] = [];
    for (let k = 0; k + 1 < xz.length; k++) {
      const [i, j] = [k, xz.length + k];
      strips.push(i, i + 1, j + 1, i, j + 1, j);
    }
    const dip: HazardWorld = {
      ...world(cut),
      terrain: {
        bounds: [
          [-5000, -5000],
          [30000, 15000],
        ],
        points: valley,
        triangles: Uint32Array.from(strips),
        heightAt: (p: Plan) => {
          const k = xz.findIndex((_, i) => i + 1 < xz.length && p[0] <= xz[i + 1]![0]);
          const [[x0, z0], [x1, z1]] = [
            xz[k < 0 ? xz.length - 2 : k]!,
            xz[k < 0 ? xz.length - 1 : k + 1]!,
          ];
          return z0 + (z1 - z0) * Math.max(0, Math.min(1, (p[0] - x0) / (x1 - x0)));
        },
      },
    };
    const rim = hazardsOnDay(cut, plan, dip, day).find((h) => h.kind === 'edge')!;
    expect(rim.distance([15500, 5000])).toBeGreaterThan(490);
    expect(rim.distance([15500, 5000])).toBeLessThanOrEqual(500);
    // Round a corner the edge is an arc (flat ground 10 m above the floor: 10 m out); the distance
    // never reads more than the true one, and within the tolerance of it.
    const deep = structuredClone(cut);
    Object.assign(deep.site!.earthworks.find((w) => w.id === 'pit')!, { levelZ: -10000 });
    const flatGround: HazardWorld = {
      ...world(deep),
      terrain: { ...siteTerrain(deep.site), heightAt: () => 0 },
    };
    const corner = hazardsOnDay(deep, plan, flatGround, day).find((h) => h.kind === 'edge')!;
    const out = 10000 + 10000 / Math.SQRT2 + 990 / Math.SQRT2;
    const read = corner.distance([out, out]);
    expect(read).toBeLessThanOrEqual(990);
    expect(read).toBeGreaterThan(980);
    // Round a corner on sloping ground (z = 0.7 (x − 10,000) + 0.7 (y − 10,000)) the edge is no
    // arc: still within the tolerance.
    const slopeGround: HazardWorld = {
      ...world(cut),
      terrain: {
        ...siteTerrain(cut.site),
        heightAt: (p: Plan) => 0.7 * (p[0] - 10000) + 0.7 * (p[1] - 10000),
      },
    };
    const slanted = hazardsOnDay(cut, plan, slopeGround, day).find((h) => h.kind === 'edge')!;
    const far = slanted.distance([81055.375, 81055.375]);
    expect(far).toBeLessThanOrEqual(990);
    expect(far).toBeGreaterThan(980);

    // A way from one gate to another counts at both.
    const gates = structuredClone(doc);
    const g = gates.site!.temporaries.find((t) => t.id === 'gate')!;
    gates.site!.temporaries.push({
      ...structuredClone(g),
      id: 'gate-2',
      name: 'Gate 2',
      outline: [
        [51000, 2000],
        [53000, 2000],
        [53000, 3000],
        [51000, 3000],
      ],
    });
    expect(gateCounts(gates, plan, day).counts).toEqual([
      { gateId: 'gate', trucks: 3, workers: 2 },
      { gateId: 'gate-2', trucks: 3, workers: 0 },
    ]);

    // A slow walk inside a zone in force for one minute: the minute is found.
    const slow = structuredClone(doc);
    slow.site!.routes = [
      {
        id: 'slow',
        name: 'Slow',
        kind: 'worker',
        path: [
          [30000, 40000],
          [30500, 40000],
        ],
        speedKmh: 0.005,
        taskId: 'col-1',
        departures: ['08:00'],
      },
    ];
    slow.site!.zones = [
      {
        id: 'short',
        name: 'Short',
        outline: [
          [29000, 39000],
          [31000, 39000],
          [31000, 41000],
          [29000, 41000],
        ],
        taskId: 'col-1',
        hours: ['08:01', '08:02'],
      },
    ];
    expect(
      approachesOnDay(slow, plan, world(slow), day)
        .filter((a) => a.hazardId === 'short')
        .map((a) => [a.from, a.to, a.closest]),
    ).toEqual([['08:01:00', '08:02:00', 0]]);

    // A short way grazing a zone's corner between its two ends (both 1,004 mm off, 999 mm at the
    // middle): the graze is found.
    const graze = structuredClone(doc);
    graze.site!.routes = [
      {
        id: 'graze',
        name: 'Graze',
        kind: 'worker',
        path: [
          [29222.89, 40635.69],
          [29364.31, 40777.11],
        ],
        speedKmh: 4,
        taskId: 'col-1',
        departures: ['08:00'],
      },
    ];
    graze.site!.zones = [
      {
        id: 'corner',
        name: 'Corner',
        outline: [
          [30000, 30000],
          [40000, 30000],
          [40000, 40000],
          [30000, 40000],
        ],
        taskId: 'col-1',
      },
    ];
    const grazes = approachesOnDay(graze, plan, world(graze), day).filter(
      (a) => a.hazardId === 'corner',
    );
    expect(grazes).toHaveLength(1);
    expect(grazes[0]!.closest).toBeGreaterThanOrEqual(999);
    expect(grazes[0]!.closest).toBeLessThanOrEqual(1000);

    // A slow way coming into a margin between its samples: the time it comes in, to the second.
    const creep = structuredClone(graze);
    creep.site!.routes = [
      {
        id: 'creep',
        name: 'Creep',
        kind: 'worker',
        path: [
          [28900, 35000],
          [29100, 35000],
        ],
        speedKmh: 0.005,
        taskId: 'col-1',
        departures: ['08:00'],
      },
    ];
    const crept = approachesOnDay(creep, plan, world(creep), day).filter(
      (a) => a.hazardId === 'corner',
    );
    expect(crept.map((a) => [a.from, a.to])).toEqual([['08:01:12', '08:02:24']]);

    // A way that turns back just out of the margin between two samples (900, 1,010, 900 mm off):
    // two approaches with the clear spell between them, not one.
    const turn = structuredClone(graze);
    turn.site!.routes = [
      {
        id: 'turn',
        name: 'Turn',
        kind: 'worker',
        path: [
          [29100, 35000],
          [28990, 35000],
          [29100, 35000],
        ],
        speedKmh: 0.005,
        taskId: 'col-1',
        departures: ['08:00'],
      },
    ];
    const turns = approachesOnDay(turn, plan, world(turn), day).filter(
      (a) => a.hazardId === 'corner',
    );
    expect(turns.slice(0, 2).map((a) => [a.from, a.to])).toEqual([
      ['08:00:00', '08:01:12'],
      ['08:01:27', '08:02:38'],
    ]);

    // A short way that touches the zone between its two ends (both 110 mm off): closest 0.
    const touch = structuredClone(graze);
    touch.site!.routes = [
      {
        id: 'touch',
        name: 'Touch',
        kind: 'worker',
        path: [
          [29890, 35000],
          [30000, 35000],
          [29890, 35000],
        ],
        speedKmh: 4,
        taskId: 'col-1',
        departures: ['08:00'],
      },
    ];
    const touched = approachesOnDay(touch, plan, world(touch), day).filter(
      (a) => a.hazardId === 'corner',
    );
    expect(touched.map((a) => a.closest)).toEqual([0]);

    // Two gates side by side: an end inside one counts there, not at the other just beside it.
    const pair = structuredClone(doc);
    const gate = pair.site!.temporaries.find((t) => t.id === 'gate')!;
    const box = (x0: number, x1: number): Plan[] => [
      [x0, 0],
      [x1, 0],
      [x1, 6000],
      [x0, 6000],
    ];
    pair.site!.temporaries = [
      { ...structuredClone(gate), id: 'gate-a', outline: box(-6000, 0) },
      { ...structuredClone(gate), id: 'gate-b', outline: box(100, 6100) },
    ];
    pair.site!.routes = [
      {
        id: 'in',
        name: 'In',
        kind: 'truck',
        path: [
          [400, 3000],
          [20000, 3000],
        ],
        speedKmh: 10,
        taskId: 'col-1',
        departures: ['08:00'],
      },
    ];
    expect(gateCounts(pair, plan, day).counts).toEqual([
      { gateId: 'gate-a', trucks: 0, workers: 0 },
      { gateId: 'gate-b', trucks: 1, workers: 0 },
    ]);
  });

  it('names the lifts that do not fit in the working day and draws no danger for them (ST-549#3)', () => {
    const doc = f89OfficeTraffic(bim);
    const plan = scheduleConstruction(doc);
    const day = plan.byId.get('col-1')!.start;
    expect(liftsPastDayEnd(doc, plan)).toEqual([]);
    // 59 minutes of work: two lifts of 20 minutes; the day's other four are left over.
    doc.site!.hours = { start: '23:00', end: '23:59' };
    const times = liftTimes(doc, plan);
    const today = doc
      .site!.lifts!.filter((l) => times.get(l.id)?.day === day)
      .sort((a, b) => times.get(a.id)!.order - times.get(b.id)!.order);
    const over = liftsPastDayEnd(doc, plan).find((o) => o.day === day)!;
    expect(over.liftIds).toEqual(today.slice(2).map((l) => l.id));
    const loads = hazardsOnDay(doc, plan, world(doc), day).filter((h) => h.kind === 'load');
    expect(loads.map((h) => [h.from, h.to])).toEqual([
      [1380, 1400],
      [1400, 1420],
    ]);
    expect(Math.max(...loads.map((h) => h.to))).toBeLessThanOrEqual(1439);
  });
});
