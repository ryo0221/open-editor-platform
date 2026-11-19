import { describe, expect, it } from 'vitest';
import {
  applyFactoryOperation,
  calendarOn,
  newFactory,
  nextCalendarChange,
  runFactory,
  validateFactory,
  type FactoryCalendar,
  type FactoryDocument,
  type FactoryObject,
  type FactoryRunResult,
} from './index';

const H = 3_600_000;
const c = (sec: number) => ({ type: 'const' as const, value: sec * 1000 });
const share = (r: FactoryRunResult, id: string, s: string) => {
  const o = r.objects.find((x) => x.id === id)!;
  return o.states[s as keyof typeof o.states] / (r.endMs - r.startMs);
};
function line(objects: FactoryObject[], hours: number, extra: Partial<FactoryDocument> = {}) {
  const doc = newFactory('t');
  doc.objects = objects;
  doc.links = objects.slice(1).map((o, i) => ({ id: `l${i}`, from: objects[i]!.id, to: o.id }));
  doc.run = { durationMs: hours * H, seed: 5 };
  return { ...doc, ...extra };
}
const source = (sec: number, extra = {}): FactoryObject => ({
  id: 'in',
  name: 'in',
  kind: 'source',
  interval: c(sec),
  mix: [{ productId: 'part', weight: 1 }],
  ...extra,
});
const station = (sec: number, extra = {}): FactoryObject => ({
  id: 'm',
  name: 'm',
  kind: 'station',
  processTime: c(sec),
  ...extra,
});
const drain: FactoryObject = { id: 'out', name: 'out', kind: 'drain' };
const twoShifts: FactoryCalendar = {
  id: 'days',
  name: 'Two shifts',
  cycleMs: 24 * H,
  shifts: [
    { name: 'Early', startMs: 6 * H, endMs: 14 * H },
    { name: 'Late', startMs: 14 * H, endMs: 22 * H },
  ],
};

// TS-2656: FT3a failures, setups and shift calendars.
describe('FT3a failures, setups and shifts (TS-2656)', () => {
  it('applies a shift end before a part created at the same instant', () => {
    const doc = newFactory('t');
    doc.calendars = [
      {
        id: 'c',
        name: 'c',
        cycleMs: 60_000,
        shifts: [{ name: 's', startMs: 10_000, endMs: 20_000 }],
      },
    ];
    doc.objects = [
      {
        id: 'in',
        name: 'in',
        kind: 'source',
        interval: { type: 'const', value: 1000 },
        mix: [{ productId: 'part', weight: 1 }],
        startMs: 20_000,
        limit: 1,
        calendarId: 'c',
      },
      { id: 'out', name: 'out', kind: 'drain' },
    ];
    doc.links = [{ id: 'l', from: 'in', to: 'out' }];
    doc.run = { durationMs: 60_000, seed: 1 };
    expect(runFactory(doc).produced).toBe(0);
    expect(runFactory({ ...doc, run: { durationMs: 71_000, seed: 1 } }).produced).toBe(1);
  });

  it('keeps a source that holds its last part paused outside its shifts', () => {
    const cal = (id: string, startMs: number) => ({
      id,
      name: id,
      cycleMs: 60_000,
      shifts: [{ name: id, startMs, endMs: startMs + 10_000 }],
    });
    const run = (limit: number) =>
      runFactory(
        line([source(1, { limit, calendarId: 'a' }), station(1, { calendarId: 'b' }), drain], 1, {
          calendars: [cal('a', 0), cal('b', 20_000)],
          run: { durationMs: 59_000, seed: 1 },
        }),
      ).objects.find((o) => o.id === 'in')!.states;
    for (const limit of [1, 2]) expect(run(limit).paused).toBe(49_000);
  });

  it('applies every calendar change at an instant before parts move', () => {
    const cal = (id: string, startMs: number) => ({
      id,
      name: id,
      cycleMs: 60_000,
      shifts: [{ name: id, startMs, endMs: startMs + 10_000 }],
    });
    const run = (calendars: FactoryCalendar[]) =>
      runFactory(
        line([source(1, { calendarId: 'a' }), station(1, { calendarId: 'b' }), drain], 1, {
          calendars,
          run: { durationMs: 120_000, seed: 1 },
        }),
      ).produced;
    expect(run([cal('a', 10_000), cal('b', 0)])).toBe(0);
    expect(run([cal('b', 0), cal('a', 10_000)])).toBe(0);
  });

  it('does not count a repair outside the shifts as active', () => {
    const r = runFactory(
      line(
        [
          source(1),
          station(20, {
            calendarId: 'c',
            failures: { uptime: c(5), repair: c(100) },
          }),
          drain,
        ],
        1,
        {
          calendars: [
            {
              id: 'c',
              name: 'c',
              cycleMs: 60_000,
              shifts: [{ name: 's', startMs: 0, endMs: 10_000 }],
            },
          ],
          run: { durationMs: 60_000, seed: 1 },
        },
      ),
    );
    const m = r.bottlenecks.find((b) => b.id === 'm')!;
    expect(m.soleMs + m.shiftingMs).toBeLessThanOrEqual(10_000);
    expect(m.share).toBeLessThanOrEqual(10_000 / 60_000);
  });

  it('starts a repair when the operating uptime runs out at a shift end', () => {
    const doc = line(
      [
        source(1, { limit: 1 }),
        station(15, { calendarId: 'c', failures: { uptime: c(10), repair: c(20) } }),
        drain,
      ],
      1,
      {
        calendars: [
          {
            id: 'c',
            name: 'c',
            cycleMs: 60_000,
            shifts: [{ name: 's', startMs: 0, endMs: 10_000 }],
          },
        ],
        run: { durationMs: 70_000, seed: 1 },
      },
    );
    // Fails at 10 s, repaired at 30 s (off shift), the last 5 s run from 60 s: out at 65 s.
    expect(runFactory(doc).produced).toBe(1);
    expect(runFactory({ ...doc, run: { durationMs: 64_000, seed: 1 } }).produced).toBe(0);
  });

  it('finds the cycle end before a later shift start after a gap', () => {
    const cal = {
      id: 'c',
      name: 'c',
      cycleMs: 60_000,
      shifts: [
        { name: 'a', startMs: 10_000, endMs: 20_000 },
        { name: 'b', startMs: 30_000, endMs: 60_000 },
      ],
    };
    expect(nextCalendarChange(cal, 30_000)).toBe(60_000);
    expect(nextCalendarChange(cal, 0)).toBe(10_000);
    expect(nextCalendarChange(cal, 60_000)).toBe(70_000);
    expect(nextCalendarChange(cal, 75_000)).toBe(80_000);
  });

  it('fails after an operating uptime and stops for the repair', () => {
    // 10 s parts, a failure every 100 s of processing, 20 s repair: 10 parts per 120 s.
    const failures = { uptime: c(100), repair: c(20) };
    const r = runFactory(line([source(1), station(10, { failures }), drain], 1));
    expect(r.produced).toBe(300);
    expect(share(r, 'm', 'failed')).toBeCloseTo(1 / 6, 6);
    expect(share(r, 'm', 'working')).toBeCloseTo(5 / 6, 6);
    // Under repair counts as active: the station is the bottleneck all the time.
    expect(r.bottlenecks[0]).toMatchObject({ id: 'm', share: 1 });
  });

  it('counts a calendar uptime while idle too', () => {
    // One part a minute takes 10 s; the station fails every 120 s of wall-clock time.
    const failures = { uptime: c(100), repair: c(20), basis: 'calendar' as const };
    const r = runFactory(line([source(60), station(10, { failures }), drain], 1));
    expect(share(r, 'm', 'failed')).toBeCloseTo(1 / 6, 6);
    // Without failures the processing times are the same draws (their own random stream).
    const plain = runFactory(line([source(60), station(10), drain], 1));
    expect(r.produced).toBeLessThanOrEqual(plain.produced);
  });

  it('sets up when the product changes, with times per product', () => {
    const doc = line(
      [
        {
          id: 'in',
          name: 'in',
          kind: 'source',
          interval: c(20),
          mix: [
            { productId: 'x', weight: 1 },
            { productId: 'y', weight: 1 },
          ],
        },
        station(10, {
          setup: { time: c(5), productTimes: [{ productId: 'y', time: c(7) }] },
        }),
        drain,
      ],
      2,
    );
    doc.products = [
      { id: 'x', name: 'X' },
      { id: 'y', name: 'Y' },
    ];
    const r = runFactory(doc, { record: true });
    // The products that entered the station, in order, give the setups it needed.
    const moves = r.timeline!.moves;
    const into: number[] = [];
    for (let i = 0; i < moves.length; i += 5) if (moves[i + 4] === 1) into.push(moves[i + 2]!);
    let expected = 0;
    for (let i = 1; i < into.length; i++)
      if (into[i] !== into[i - 1]) expected += into[i] === 1 ? 7000 : 5000;
    // The last part may still be setting up at the end of the run.
    const setup = r.objects.find((o) => o.id === 'm')!.states.setup;
    expect(setup).toBeGreaterThan(0);
    expect(expected - setup).toBeGreaterThanOrEqual(0);
    expect(expected - setup).toBeLessThan(7000);
  });

  it('works only in the shifts of its calendar', () => {
    expect(calendarOn(twoShifts, 5 * H)).toBe(false);
    expect(calendarOn(twoShifts, 6 * H)).toBe(true);
    expect(calendarOn(twoShifts, 14 * H)).toBe(true);
    // The early and late shifts meet: the next change is the end of the late one.
    expect(nextCalendarChange(twoShifts, 0)).toBe(6 * H);
    expect(nextCalendarChange(twoShifts, 6 * H)).toBe(22 * H);
    expect(nextCalendarChange(twoShifts, 23 * H)).toBe(30 * H);
    expect(
      nextCalendarChange({ ...twoShifts, shifts: [{ name: 'All', startMs: 0, endMs: 24 * H }] }, 0),
    ).toBe(Infinity);
    const doc = line(
      [source(60, { calendarId: 'days' }), station(50, { calendarId: 'days' }), drain],
      48,
      { calendars: [twoShifts] },
    );
    const r = runFactory(doc);
    expect(share(r, 'm', 'paused')).toBeCloseTo(8 / 24, 6);
    expect(share(r, 'in', 'paused')).toBeCloseTo(8 / 24, 6);
    // 16 h a day, one part a minute.
    expect(r.produced).toBeGreaterThanOrEqual(2 * 16 * 60 - 2);
    expect(r.produced).toBeLessThanOrEqual(2 * 16 * 60);
  });

  it('pauses a part between shifts and finishes it in the next one', () => {
    const cal: FactoryCalendar = {
      id: 'half',
      name: 'Half',
      cycleMs: 2 * H,
      shifts: [{ name: 'On', startMs: 0, endMs: H }],
    };
    const doc = line(
      [source(1, { limit: 1 }), station(90 * 60, { calendarId: 'half' }), drain],
      4,
      {
        calendars: [cal],
      },
    );
    const r = runFactory(doc);
    expect(r.produced).toBe(1);
    expect(r.leadTime.meanMs).toBe(2.5 * H);
  });

  it('refuses calendars and resources where they do not belong', () => {
    const doc = line([source(60), station(10), drain], 1, { calendars: [twoShifts] });
    const codes = (d: unknown) => validateFactory(d).map((x) => `${x.code}@${x.path}`);
    expect(codes(doc)).toEqual([]);
    const withObj = (i: number, o: Record<string, unknown>) => ({
      ...doc,
      objects: doc.objects.map((x, j) => (j === i ? { ...x, ...o } : x)),
    });
    expect(codes(withObj(2, { calendarId: 'days' }))).toEqual(['calendar@$.objects.2.calendarId']);
    expect(codes(withObj(1, { calendarId: 'nights' }))).toEqual([
      'calendar-missing@$.objects.1.calendarId',
    ]);
    expect(codes(withObj(0, { failures: { uptime: c(1), repair: c(1) } }))).toEqual([
      'unknown-key@$.objects.0.failures',
    ]);
    expect(codes(withObj(1, { failures: { uptime: c(1), repair: c(1), basis: 'shift' } }))).toEqual(
      ['basis@$.objects.1.failures.basis'],
    );
    const overlap = {
      ...twoShifts,
      shifts: [
        { name: 'A', startMs: 0, endMs: 2 * H },
        { name: 'B', startMs: H, endMs: 3 * H },
      ],
    };
    expect(codes({ ...doc, calendars: [overlap] })).toEqual([
      'range@$.calendars.0.shifts.1.startMs',
    ]);
    expect(codes({ ...doc, calendars: [{ ...twoShifts, cycleMs: 20 * H }] })).toEqual([
      'range@$.calendars.0.shifts.1.endMs',
    ]);
    // A calendar in use cannot go; once free it goes and its ID is retired.
    const used = withObj(1, { calendarId: 'days' }) as FactoryDocument;
    expect(() => applyFactoryOperation(used, { type: 'removeCalendar', id: 'days' })).toThrow(
      'works to this calendar',
    );
    const gone = applyFactoryOperation(doc, { type: 'removeCalendar', id: 'days' });
    expect(gone.calendars).toBeUndefined();
    expect(gone.retiredIds).toContain('days');
    expect(() => applyFactoryOperation(gone, { type: 'putCalendar', calendar: twoShifts })).toThrow(
      'was removed before',
    );
  });
});
