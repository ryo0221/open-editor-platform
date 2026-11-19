import { describe, expect, it } from 'vitest';
import {
  checkDeliveries,
  deliveriesOnDay,
  f162DeliveredBeams,
  gateCounts,
  liftClock,
  liftMinutes,
  liftTimes,
  scheduleConstruction,
  tripsOnDay,
  validateConstruction,
  type ConstructionDocument,
} from './index';

const firstDay = (doc: ConstructionDocument) => {
  const plan = scheduleConstruction(doc);
  const times = liftTimes(doc, plan);
  const days = doc.site!.lifts!.filter((l) => l.routeId).map((l) => times.get(l.id)!.day);
  return { plan, day: days.sort()[0]!, days: new Set(days) };
};

describe('TT3 trucks that bring the lifted pieces (ST-802, TS-2604)', () => {
  it('makes a truck for each few lifts of the day, at its stop by the first (ST-802#1)', () => {
    const doc = f162DeliveredBeams();
    expect(validateConstruction(doc)).toEqual([]);
    const { plan, day } = firstDay(doc);
    const clock = liftClock(doc, plan, day);
    const lifts = doc
      .site!.lifts!.filter((l) => l.routeId && clock.has(l.id))
      .sort((a, b) => clock.get(a.id)! - clock.get(b.id)!);
    expect(lifts.length).toBe(10);
    // The beams go up one after another from the start of the day (07:30), 20 minutes each.
    expect(clock.get(lifts[0]!.id)).toBe(450);
    expect(clock.get(lifts[1]!.id)).toBe(450 + liftMinutes);
    const trips = deliveriesOnDay(doc, plan, day);
    expect(trips.map((t) => t.loads!.map((l) => l.liftId))).toEqual([
      lifts.slice(0, 3).map((l) => l.id),
      lifts.slice(3, 6).map((l) => l.id),
      lifts.slice(6, 9).map((l) => l.id),
      lifts.slice(9).map((l) => l.id),
    ]);
    const [first] = trips;
    expect(first!.arrives).toBe(450);
    expect(first!.leaves).toBe(450 + 2 * liftMinutes);
    // 51.7 m at 10 km/h each way.
    const drive = 51700 / ((10 * 1e6) / 60);
    expect(first!.start).toBeCloseTo(450 - drive, 9);
    expect(first!.end).toBeCloseTo(450 + 2 * liftMinutes + drive, 9);
    // On the way, at the stop while it is unloaded, and back to the gate.
    expect(first!.at(first!.start)).toEqual([23000, -14700]);
    expect(first!.at(460)).toEqual([52000, 8000]);
    expect(first!.at(first!.end)[0]).toBeCloseTo(23000, 6);
    expect(first!.at(first!.end)[1]).toBeCloseTo(-14700, 6);
    // The deliveries run whether the route's own task runs or not, and pass the gate.
    expect(tripsOnDay(doc, plan, day).filter((t) => t.loads)).toHaveLength(4);
    expect(gateCounts(doc, plan, day).counts).toEqual([{ gateId: 'gate', trucks: 4, workers: 0 }]);
  });

  it('brings the pieces of lifts made on a day off (ST-802#1)', () => {
    const doc = f162DeliveredBeams();
    const { plan, day } = firstDay(doc);
    // The beams' task done, by its actual dates, on a holiday: its lifts and trucks go there.
    const taskId = doc.site!.lifts!.find((l) => l.routeId)!.taskId;
    doc.tasks.find((t) => t.id === taskId)!.actual = { start: day, finish: day };
    doc.calendar.holidays.push(day);
    const trips = tripsOnDay(doc, plan, day);
    expect(trips.length).toBeGreaterThan(0);
    expect(trips.every((t) => t.loads)).toBe(true);
    expect(gateCounts(doc, plan, day).counts[0]!.trucks).toBe(trips.length);
  });

  it('finds trucks that would leave the day before (ST-802#3)', () => {
    const doc = f162DeliveredBeams();
    const { plan, days } = firstDay(doc);
    // 51.7 m at 5 m/h: over ten hours each way.
    doc.site!.routes![2]!.speedKmh = 0.005;
    const late = checkDeliveries(doc, plan);
    expect(late.length).toBeGreaterThanOrEqual(days.size);
    expect(new Set(late.map((d) => d.code))).toEqual(new Set(['delivery-day']));
    expect(late[0]!.message).toMatch(
      /^Beam delivery on \d{4}-\d\d-\d\d: the truck for lift-b-\S+ would leave the day before$/,
    );
  });

  it('rejects deliveries that are not a truck route, or lifts that name none (ST-802#2)', () => {
    const codes = (patch: (d: ConstructionDocument) => void) => {
      const d = f162DeliveredBeams();
      patch(d);
      return validateConstruction(d).map((x) => `${x.code} ${x.path}`);
    };
    const r = (d: ConstructionDocument) => d.site!.routes![2]!;
    expect(codes((d) => (r(d).kind = 'worker'))).toEqual([
      'delivers $.site.routes[2].delivers',
      ...d0(f162DeliveredBeams()).map((i) => `route-delivers $.site.lifts[${i}].routeId`),
    ]);
    expect(codes((d) => (r(d).delivers!.perTrip = 0))).toEqual([
      'delivers $.site.routes[2].delivers.perTrip',
    ]);
    expect(codes((d) => (r(d).delivers!.leadMinutes = -5))).toEqual([
      'delivers $.site.routes[2].delivers.leadMinutes',
    ]);
    expect(codes((d) => Object.assign(r(d).delivers!, { when: 1 }))).toEqual([
      'unknown-key $.site.routes[2].delivers.when',
    ]);
    // A route with no departures must deliver.
    expect(codes((d) => delete r(d).delivers).slice(0, 1)).toEqual([
      'departures $.site.routes[2].departures',
    ]);
    expect(codes((d) => (d.site!.lifts![0]!.routeId = 'no-such'))).toEqual([
      'route-missing $.site.lifts[0].routeId',
    ]);
    expect(codes((d) => (d.site!.lifts![0]!.routeId = 'truck-steel'))).toEqual([
      'route-delivers $.site.lifts[0].routeId',
    ]);
  });

  it('finds trucks due before the day starts, and picks far from the truck (ST-802#3)', () => {
    const doc = f162DeliveredBeams();
    const { plan, days } = firstDay(doc);
    expect(checkDeliveries(doc, plan)).toEqual([]);
    // Half an hour ahead of the first lift of the day: before the site opens, every day.
    doc.site!.routes![2]!.delivers!.leadMinutes = 30;
    const early = checkDeliveries(doc, plan);
    expect(early.map((d) => d.code)).toEqual([...days].map(() => 'delivery-early'));
    expect(early[0]!.message).toMatch(
      /^Beam delivery on \d{4}-\d\d-\d\d: the truck for lift-b-\S+ arrives at 07:00, before the day starts at 07:30$/,
    );
    // A lift picked 10 m from where the truck stops.
    doc.site!.routes![2]!.delivers!.leadMinutes = 0;
    const i = d0(doc)[0]!;
    doc.site!.lifts![i]!.pick = [52000, 18000, 2900];
    expect(checkDeliveries(doc, plan)).toEqual([
      {
        code: 'delivery-pick',
        path: `$.site.lifts[${i}].pick`,
        message: `${doc.site!.lifts![i]!.id} picks 10.0 m from where Beam delivery stops`,
      },
    ]);
  });
});

/** Indexes of the delivered lifts. */
function d0(doc: ConstructionDocument) {
  return doc.site!.lifts!.flatMap((l, i) => (l.routeId ? [i] : []));
}
