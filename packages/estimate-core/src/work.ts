import {
  CalculationError,
  record,
  identifier,
  textValue,
  decimal,
  compare,
  multiply,
  add,
  divide,
  quantize,
  formatDecimal,
  convert,
  assertPersistable,
} from '@editor-platform/calculation-core';
import type { LineResult } from './types';
export interface WorkRule {
  id: string;
  name: string;
  setupHours: string;
  hoursPerUnit: string;
  perUnit: string;
  crewCount: number;
  hoursPerDay: string;
}
export interface WorkPlan {
  projectStartDate: string;
  calendar: { weekdays: number[]; exceptions: { date: string; working: boolean }[] };
  tasks: { id: string; name: string; lineId: string; ruleId: string; releaseDate?: string }[];
  dependencies: { before: string; after: string; kind: 'FS'; lag: number }[];
}
export interface WorkResult {
  id: string;
  name: string;
  lineId: string;
  effortHours: string;
  durationWorkdays: number;
  start: string;
  finishExclusive: string;
  lastWorkingDate: string;
  kind: 'task' | 'milestone';
}
const fail = (code: string): never => {
  throw new CalculationError(code);
};
/** ISO calendar dates only. UTC is used solely for ordinal arithmetic, never a timezone instant API. */
const date = (value: unknown): number => {
  if (typeof value !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value))
    return fail('invalid-work-date');
  const ordinal = Date.parse(value + 'T00:00:00Z') / 86400000;
  if (
    !Number.isInteger(ordinal) ||
    new Date(ordinal * 86400000).toISOString().slice(0, 10) !== value
  )
    return fail('invalid-work-date');
  return ordinal;
};
const iso = (ordinal: number) => new Date(ordinal * 86400000).toISOString().slice(0, 10);
const array = (v: unknown, max: number): unknown[] => {
  if (!Array.isArray(v) || v.length > max) return fail('work-limit');
  return v;
};
const nonnegative = (v: unknown) => {
  if (typeof v !== 'string' || compare(decimal(v), decimal('0')) < 0) fail('invalid-work-hours');
};
export function assertWork(rules: unknown, plan: unknown): asserts plan is WorkPlan {
  const ruleIds = new Set<string>();
  for (const value of array(rules, 1000)) {
    const r = record(value, [
      'id',
      'name',
      'setupHours',
      'hoursPerUnit',
      'perUnit',
      'crewCount',
      'hoursPerDay',
    ]);
    identifier(r.id);
    textValue(r.name);
    identifier(r.perUnit);
    if (ruleIds.has(r.id)) fail('duplicate-work-rule');
    ruleIds.add(r.id);
    nonnegative(r.setupHours);
    nonnegative(r.hoursPerUnit);
    nonnegative(r.hoursPerDay);
    if (
      compare(decimal(r.hoursPerDay as string), decimal('0')) <= 0 ||
      compare(decimal(r.hoursPerDay as string), decimal('24')) > 0 ||
      !Number.isInteger(r.crewCount) ||
      Number(r.crewCount) < 1 ||
      Number(r.crewCount) > 100
    )
      fail('invalid-work-capacity');
    convert(decimal('1'), r.perUnit, r.perUnit);
  }
  const p = record(plan, ['projectStartDate', 'calendar', 'tasks', 'dependencies']);
  date(p.projectStartDate);
  const c = record(p.calendar, ['weekdays', 'exceptions']);
  const weekdays = array(c.weekdays, 7);
  if (
    new Set(weekdays).size !== weekdays.length ||
    weekdays.some((v) => !Number.isInteger(v) || Number(v) < 1 || Number(v) > 7)
  )
    fail('invalid-work-calendar');
  const dates = new Set<string>();
  for (const value of array(c.exceptions, 1000)) {
    const x = record(value, ['date', 'working']);
    date(x.date);
    if (typeof x.working !== 'boolean' || dates.has(x.date as string))
      fail('invalid-work-calendar');
    dates.add(x.date as string);
  }
  const ids = new Set<string>();
  for (const value of array(p.tasks, 1000)) {
    const t = record(value, ['id', 'name', 'lineId', 'ruleId'], ['releaseDate']);
    identifier(t.id);
    identifier(t.lineId);
    identifier(t.ruleId);
    textValue(t.name);
    if (ids.has(t.id)) fail('duplicate-work-task');
    ids.add(t.id);
    if (!ruleIds.has(t.ruleId)) fail('missing-work-rule');
    if (t.releaseDate !== undefined) date(t.releaseDate);
  }
  const edges = new Set<string>();
  for (const value of array(p.dependencies, 3000)) {
    const e = record(value, ['before', 'after', 'kind', 'lag']);
    identifier(e.before);
    identifier(e.after);
    if (e.kind !== 'FS' || !Number.isInteger(e.lag) || Number(e.lag) < 0 || Number(e.lag) > 3660)
      fail('unsupported-work-dependency');
    if (!ids.has(e.before) || !ids.has(e.after)) fail('missing-work-task');
    const key = JSON.stringify([e.before, e.after]);
    if (edges.has(key)) fail('duplicate-work-dependency');
    edges.add(key);
  }
}
/** Bounded calendar scheduling; no resource leveling, inferred holidays or external calendars. */
export function calculateWork(
  rules: WorkRule[],
  plan: WorkPlan,
  lines: LineResult[],
): WorkResult[] {
  assertWork(rules, plan);
  const first = date(plan.projectStartDate);
  const year = Number(plan.projectStartDate.slice(0, 4)) + 10;
  if (year > 9999) fail('work-period-limit');
  const endText = String(year) + plan.projectStartDate.slice(4);
  let limit: number;
  try {
    limit = date(endText);
  } catch {
    limit = date(String(year) + '-02-28');
  }
  const exceptions = new Map(plan.calendar.exceptions.map((x) => [date(x.date), x.working]));
  const working = (day: number) =>
    exceptions.get(day) ?? plan.calendar.weekdays.includes(((((day + 3) % 7) + 7) % 7) + 1);
  const next = (day: number): number => {
    while (day <= limit && !working(day)) day++;
    if (day > limit || iso(day).length !== 10) return fail('work-period-limit');
    return day;
  };
  const taskMap = new Map(plan.tasks.map((t) => [t.id, t])),
    result = new Map<string, WorkResult>();
  const visiting = new Set<string>();
  const resolve = (id: string): WorkResult => {
    const known = result.get(id);
    if (known) return known;
    if (visiting.has(id)) return fail('work-cycle');
    visiting.add(id);
    const task = taskMap.get(id)!;
    const rule = rules.find((r) => r.id === task.ruleId)!;
    const line = lines.find((l) => l.id === task.lineId);
    if (!line) return fail('unresolved-work-line');
    const quantity = convert(decimal(line.billableQuantity), line.unit, rule.perUnit);
    const effort = add(decimal(rule.setupHours), multiply(quantity, decimal(rule.hoursPerUnit)));
    assertPersistable(effort);
    const capacity = multiply(decimal(String(rule.crewCount)), decimal(rule.hoursPerDay));
    // Ceiling division must retain any fractional day: use common bounded decimal division.
    const duration = Number(
      formatDecimal(quantize(divide(effort, capacity, 12, 'ceil'), 0, 'ceil')),
    );
    if (!Number.isSafeInteger(duration) || duration > 3653) return fail('work-period-limit');
    let start = Math.max(first, task.releaseDate ? date(task.releaseDate) : first);
    for (const edge of plan.dependencies.filter((e) => e.after === id)) {
      const predecessor = resolve(edge.before);
      let release = date(predecessor.finishExclusive);
      for (let i = 0; i < edge.lag; i++) release = next(release) + 1;
      start = Math.max(start, release);
    }
    start = next(start);
    let last = start;
    for (let n = 1; n < duration; n++) last = next(last + 1);
    if (duration && last + 1 > limit) fail('work-period-limit');
    const output: WorkResult = {
      id,
      name: task.name,
      lineId: task.lineId,
      effortHours: formatDecimal(effort),
      durationWorkdays: duration,
      start: iso(start),
      lastWorkingDate: iso(last),
      finishExclusive: iso(duration ? last + 1 : start),
      kind: duration ? 'task' : 'milestone',
    };
    visiting.delete(id);
    result.set(id, output);
    return output;
  };
  for (const task of plan.tasks) resolve(task.id);
  return [...result.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
