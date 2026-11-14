import { describe, expect, it } from 'vitest';
import { f37Office } from '@editor-platform/bim-core';
import {
  elementState,
  f85OfficeSchedule,
  newConstruction,
  scheduleConstruction,
  siteOnDay,
  unscheduledElements,
  WorkingDays,
  type ConstructionDocument,
  type ConstructionTask,
} from './index';

const source = { artifactId: 'bim', versionId: 'v1', contentHash: 'b'.repeat(64) };
const task = (id: string, over: Partial<ConstructionTask> = {}): ConstructionTask => ({
  id,
  name: id,
  durationDays: 1,
  predecessors: [],
  action: 'construct',
  elementIds: [],
  ...over,
});
const after = (...ids: (string | [string, number])[]) =>
  ids.map((a) =>
    typeof a === 'string' ? { taskId: a, lagDays: 0 } : { taskId: a[0], lagDays: a[1] },
  );
// 2027-04-05 is a Monday; Monday–Friday are worked.
const docWith = (...tasks: ConstructionTask[]): ConstructionDocument => ({
  ...newConstruction('S', source, '2027-04-05'),
  calendar: { workWeekdays: [1, 2, 3, 4, 5], holidays: ['2027-04-07'] },
  tasks,
});

describe('CS1b schedule by the critical path method (ST-541, TS-2071)', () => {
  it('counts working days past weekends and holidays (ST-541#1)', () => {
    const days = new WorkingDays({
      startDate: '2027-04-03', // a Saturday
      calendar: { workWeekdays: [1, 2, 3, 4, 5], holidays: ['2027-04-07'] },
    });
    const date = (n: number) => new Date(days.day(n)! * 86_400_000).toISOString().slice(0, 10);
    expect([0, 1, 2, 3, 4, 5].map(date)).toEqual([
      '2027-04-05',
      '2027-04-06',
      '2027-04-08',
      '2027-04-09',
      '2027-04-12',
      '2027-04-13',
    ]);
  });

  it('plans finish-to-start links with lags and finds the critical path (ST-541#1)', () => {
    const s = scheduleConstruction(
      docWith(
        task('a', { durationDays: 3 }),
        task('b', { durationDays: 2, predecessors: after('a') }),
        task('c', { durationDays: 1, predecessors: after(['a', 2]) }),
        task('d', { durationDays: 2, predecessors: after('b', 'c') }),
        task('m', { durationDays: 0, predecessors: after('d') }),
        // A negative lag overlaps; nothing starts before the project start.
        task('e', { durationDays: 1, predecessors: after(['a', -5]) }),
      ),
    );
    const row = (id: string) => {
      const t = s.byId.get(id)!;
      return [t.earlyStart, t.earlyFinish, t.totalFloat, t.critical, t.start, t.finish];
    };
    expect(s.diagnostics).toEqual([]);
    // Working days: 0 Mon 5, 1 Tue 6, (Wed 7 off) 2 Thu 8, 3 Fri 9, 4 Mon 12, 5 Tue 13, 6 Wed 14, 7 Thu 15.
    expect(row('a')).toEqual([0, 3, 0, true, '2027-04-05', '2027-04-08']);
    expect(row('b')).toEqual([3, 5, 1, false, '2027-04-09', '2027-04-12']);
    expect(row('c')).toEqual([5, 6, 0, true, '2027-04-13', '2027-04-13']);
    expect(row('d')).toEqual([6, 8, 0, true, '2027-04-14', '2027-04-15']);
    expect(row('m')).toEqual([8, 8, 0, true, '2027-04-16', '2027-04-16']);
    expect(row('e')).toEqual([0, 1, 7, false, '2027-04-05', '2027-04-05']);
    expect(s.projectStart).toBe('2027-04-05');
    expect(s.projectFinish).toBe('2027-04-15');
    expect(s.workingDays).toBe(8);
  });

  it('moves the finish when a critical task gets longer, not when a floating one does (ST-541#1)', () => {
    const base = docWith(
      task('a', { durationDays: 3 }),
      task('b', { durationDays: 1, predecessors: after('a') }),
      task('x', { durationDays: 2 }),
    );
    expect(scheduleConstruction(base).projectFinish).toBe('2027-04-09');
    const longer = structuredClone(base);
    longer.tasks[2]!.durationDays = 3;
    expect(scheduleConstruction(longer).projectFinish).toBe('2027-04-09');
    longer.tasks[0]!.durationDays = 4;
    expect(scheduleConstruction(longer).projectFinish).toBe('2027-04-12');
  });

  it('gives each element its state on a day, by action (ST-541#2)', () => {
    const doc = docWith(
      task('build', { durationDays: 2, elementIds: ['wall'] }),
      task('prop', { durationDays: 3, action: 'temporary', elementIds: ['shore'] }),
      task('demolish', {
        durationDays: 1,
        action: 'remove',
        elementIds: ['wall', 'old'],
        predecessors: after('build', 'prop'),
      }),
      task('done', { durationDays: 0, elementIds: ['flag'], predecessors: after('demolish') }),
    );
    const s = scheduleConstruction(doc);
    const at = (day: string) => {
      const site = siteOnDay(doc, s, day);
      return {
        wall: elementState(site, 'wall'),
        shore: elementState(site, 'shore'),
        old: elementState(site, 'old'),
        flag: elementState(site, 'flag'),
        other: elementState(site, 'other'),
        running: site.running,
      };
    };
    // build Mon 5–Tue 6, prop Mon 5–Thu 8 (Wed off), demolish Fri 9, done Mon 12.
    expect(at('2027-04-04')).toEqual({
      wall: 'absent',
      shore: 'absent',
      old: 'existing',
      flag: 'absent',
      other: 'existing',
      running: [],
    });
    expect(at('2027-04-06')).toMatchObject({
      wall: 'building',
      shore: 'temporary',
      running: ['build', 'prop'],
    });
    expect(at('2027-04-08')).toMatchObject({
      wall: 'built',
      shore: 'temporary',
      old: 'existing',
      running: ['prop'],
    });
    expect(at('2027-04-09')).toMatchObject({
      wall: 'removing',
      shore: 'absent',
      old: 'removing',
      flag: 'absent',
      running: ['demolish'],
    });
    expect(at('2027-04-12')).toMatchObject({
      wall: 'absent',
      old: 'absent',
      flag: 'built',
      running: [],
    });
  });

  it('uses the actual dates typed in over the plan (ST-541#3)', () => {
    const doc = docWith(
      task('a', {
        durationDays: 2,
        elementIds: ['e'],
        actual: { start: '2027-04-06', finish: '2027-04-09', percent: 100 },
      }),
      task('b', {
        durationDays: 2,
        elementIds: ['f'],
        actual: { start: '2027-04-12', percent: 40 },
      }),
    );
    const s = scheduleConstruction(doc);
    const state = (day: string, id: string) => elementState(siteOnDay(doc, s, day), id);
    expect(state('2027-04-05', 'e')).toBe('absent');
    expect(state('2027-04-09', 'e')).toBe('building');
    expect(state('2027-04-12', 'e')).toBe('built');
    // Started late with no finish: on site from the actual start, at least to the planned finish.
    expect(state('2027-04-06', 'f')).toBe('absent');
    expect(state('2027-04-12', 'f')).toBe('building');
    expect(state('2027-04-13', 'f')).toBe('built');
    // A milestone with actual dates stays instantaneous: never running.
    const m = docWith(
      task('m', {
        durationDays: 0,
        elementIds: ['g'],
        actual: { start: '2027-04-05', finish: '2027-04-05', percent: 100 },
      }),
    );
    const sm = scheduleConstruction(m);
    expect(siteOnDay(m, sm, '2027-04-05').running).toEqual([]);
    expect(elementState(siteOnDay(m, sm, '2027-04-05'), 'g')).toBe('built');
    expect(elementState(siteOnDay(m, sm, '2027-04-03'), 'g')).toBe('absent');
  });

  it('warns when an element is removed before it is built, and refuses an endless plan (ST-541#4)', () => {
    const s = scheduleConstruction(
      docWith(
        task('build', { durationDays: 5, elementIds: ['wall'] }),
        task('demolish', { durationDays: 1, action: 'remove', elementIds: ['wall'] }),
      ),
    );
    expect(s.diagnostics.map((d) => [d.code, d.path])).toEqual([
      ['remove-before-construct', '$.tasks[1].elementIds[0]'],
    ]);
    const long = docWith(
      ...Array.from({ length: 30 }, (_, i) =>
        task(`t${i}`, { durationDays: 3650, predecessors: i ? after(`t${i - 1}`) : [] }),
      ),
    );
    const r = scheduleConstruction(long);
    expect(r.diagnostics.map((d) => d.code)).toEqual(['schedule-too-long']);
    expect(r.tasks).toEqual([]);
    // A milestone the day after the last kept day is past the horizon too.
    const edge: ConstructionDocument = {
      ...newConstruction('S', source, '2200-12-31'),
      calendar: { workWeekdays: [0, 1, 2, 3, 4, 5, 6], holidays: [] },
      tasks: [task('a'), task('m', { durationDays: 0, predecessors: after('a') })],
    };
    expect(scheduleConstruction(edge).diagnostics.map((d) => d.code)).toEqual([
      'schedule-too-long',
    ]);
    edge.tasks.pop();
    expect(scheduleConstruction(edge).tasks.map((t) => t.finish)).toEqual(['2200-12-31']);
  });

  it('plans F85, the five-storey office (ST-541#5)', () => {
    const doc = f85OfficeSchedule();
    const s = scheduleConstruction(doc);
    expect(s.diagnostics).toEqual([]);
    expect(s.projectStart).toBe('2027-04-01');
    const critical = s.tasks.filter((t) => t.critical).map((t) => t.id);
    expect(critical.slice(0, 5)).toEqual(['site', 'ground', 'col-1', 'beam-1', 'slab-2']);
    expect(critical).toContain('roof');
    expect(critical).toContain('openings-5');
    expect(critical.at(-1)).toBe('complete');
    // The completion milestone falls on the working day after the last day worked.
    expect(s.byId.get('complete')!.start > s.projectFinish).toBe(true);
    // Every BIM element but the spaces is scheduled.
    const bim = f37Office();
    const left = unscheduledElements(doc, bim);
    expect(left.length).toBeGreaterThan(0);
    expect(left.every((id) => bim.elements.find((e) => e.id === id)!.kind === 'space')).toBe(true);
    // Mid-way the third storey's frame stands and the roof does not.
    const mid = siteOnDay(doc, s, s.byId.get('col-4')!.start);
    expect(elementState(mid, 'c-3-1-1')).toBe('built');
    expect(elementState(mid, 'c-4-1-1')).toBe('building');
    expect(elementState(mid, 'r-roof')).toBe('absent');
    expect(elementState(mid, 'sp-1-s')).toBe('existing');
  });
});
