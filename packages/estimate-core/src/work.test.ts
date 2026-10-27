import { expect, it } from 'vitest';
import { calculateWork, type WorkRule, type WorkPlan } from './work';
import { estimateFixture } from './fixtures';
import { evaluateEstimate, makeEstimateBasis } from './evaluate';
const lines = () => evaluateEstimate(makeEstimateBasis(estimateFixture())).lines;
const rules: WorkRule[] = [
  {
    id: 'crew',
    name: 'Assembly',
    setupHours: '2',
    hoursPerUnit: '1',
    perUnit: 'count',
    crewCount: 1,
    hoursPerDay: '4',
  },
];
const plan = (): WorkPlan => ({
  projectStartDate: '2026-10-30',
  calendar: { weekdays: [1, 2, 3, 4, 5], exceptions: [] },
  tasks: [{ id: 'assembly', name: 'Assembly', lineId: 'line-bolt', ruleId: 'crew' }],
  dependencies: [],
});
it('ES22 uses exact effort, working days and exclusive calendar boundary', () => {
  const result = calculateWork(rules, plan(), lines())[0];
  expect(result).toMatchObject({
    effortHours: '8',
    durationWorkdays: 2,
    start: '2026-10-30',
    lastWorkingDate: '2026-11-02',
    finishExclusive: '2026-11-03',
    kind: 'task',
  });
  const holiday = plan();
  holiday.calendar.exceptions.push({ date: '2026-11-02', working: false });
  expect(calculateWork(rules, holiday, lines())[0].lastWorkingDate).toBe('2026-11-03');
});
it('ES22 zero effort is a milestone and partial day rounds up exactly', () => {
  const zero = [{ ...rules[0], setupHours: '0', hoursPerUnit: '0' }];
  expect(calculateWork(zero, plan(), lines())[0]).toMatchObject({
    kind: 'milestone',
    durationWorkdays: 0,
    start: '2026-10-30',
    finishExclusive: '2026-10-30',
    lastWorkingDate: '2026-10-30',
  });
  expect(
    calculateWork([{ ...rules[0], setupHours: '2.000000000001' }], plan(), lines())[0]
      .durationWorkdays,
  ).toBe(3);
});
it('ES23 FS lag counts working dates, cycles and unavailable calendars reject boundedly', () => {
  const p = plan();
  p.tasks.push({ ...p.tasks[0], id: 'followup' });
  p.dependencies = [{ before: 'assembly', after: 'followup', kind: 'FS', lag: 1 }];
  expect(calculateWork(rules, p, lines()).find((t) => t.id === 'followup')!.start).toBe(
    '2026-11-04',
  );
  p.dependencies.push({ before: 'followup', after: 'assembly', kind: 'FS', lag: 0 });
  expect(() => calculateWork(rules, p, lines())).toThrow('work-cycle');
  const holidays = plan();
  holidays.calendar.weekdays = [];
  expect(() => calculateWork(rules, holidays, lines())).toThrow('work-period-limit');
  expect(() => calculateWork([{ ...rules[0], crewCount: 0 }], plan(), lines())).toThrow(
    'invalid-work-capacity',
  );
  const beyond = plan();
  beyond.tasks[0].releaseDate = '2037-01-01';
  expect(() => calculateWork(rules, beyond, lines())).toThrow('work-period-limit');
});
it('ES22 scenarios retain explicit crew conditions without changing base effort or cost', () => {
  const doc = estimateFixture();
  doc.workRules = structuredClone(rules);
  doc.workPlan = plan();
  doc.scenarios = [
    {
      id: 'two-crew',
      name: '二人作業',
      quantities: [],
      rates: [],
      waste: [],
      workRules: [{ ...rules[0], crewCount: 2 }],
    },
  ];
  const original = structuredClone(doc);
  const base = evaluateEstimate(makeEstimateBasis(doc));
  const alternative = evaluateEstimate(makeEstimateBasis(doc, 'two-crew'));
  expect(base.work![0].durationWorkdays).toBe(2);
  expect(alternative.work![0]).toMatchObject({ effortHours: '8', durationWorkdays: 1 });
  expect(alternative.total).toBe(base.total);
  expect(doc).toEqual(original);
  doc.scenarios[0].workRules[0].crewCount = 0;
  expect(() => makeEstimateBasis(doc, 'two-crew')).toThrow('invalid-work-capacity');
});
