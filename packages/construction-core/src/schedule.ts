import { dayString, utcDay } from '@editor-platform/time-axis';
import {
  constructionLimits,
  type ConstructionDiagnostic,
  type ConstructionDocument,
  type ConstructionTask,
} from './model';

/**
 * CS1: the planned dates of every task by the critical path method, in working days of the
 * document's calendar. Links are finish-to-start with a lag; nothing starts before the start date.
 */
export interface ScheduledTask {
  id: string;
  /** Working-day index of the first day worked (0 = the first working day on or after the start date). */
  earlyStart: number;
  /** Working-day index just after the last day worked (= earlyStart for a milestone). */
  earlyFinish: number;
  lateStart: number;
  lateFinish: number;
  /** Working days the task can slip without moving the project finish. */
  totalFloat: number;
  critical: boolean;
  /** Planned first day worked (YYYY-MM-DD). */
  start: string;
  /** Planned last day worked (YYYY-MM-DD); a milestone's own day. */
  finish: string;
}

export interface ConstructionSchedule {
  tasks: ScheduledTask[];
  byId: Map<string, ScheduledTask>;
  /** The first working day on or after the start date. */
  projectStart: string;
  /** The last day worked of the whole schedule (the project start when there are no tasks). */
  projectFinish: string;
  /** Working days from the project start to just after the last day worked. */
  workingDays: number;
  diagnostics: ConstructionDiagnostic[];
}

/** The working days of a calendar, from a start date, generated as far as they are asked for. */
export class WorkingDays {
  private readonly days: number[] = [];
  private next: number;
  private readonly weekdays: Set<number>;
  private readonly holidays: Set<number>;
  private readonly last: number;
  constructor(doc: Pick<ConstructionDocument, 'startDate' | 'calendar'>) {
    const start = utcDay(doc.startDate);
    if (start === null) throw new Error('invalid start date');
    this.next = start;
    this.weekdays = new Set(doc.calendar.workWeekdays);
    this.holidays = new Set(doc.calendar.holidays.map((h) => utcDay(h)!));
    this.last = utcDay(`${constructionLimits.maxYear}-12-31`)!;
  }
  private worked(day: number) {
    // 1970-01-01 (day 0) was a Thursday.
    return this.weekdays.has((((day + 4) % 7) + 7) % 7) && !this.holidays.has(day);
  }
  /** The day number of working day `n` (0-based), or null past the last kept year. */
  day(n: number): number | null {
    while (this.days.length <= n) {
      while (!this.worked(this.next)) {
        if (this.next > this.last) return null;
        this.next++;
      }
      if (this.next > this.last) return null;
      this.days.push(this.next++);
    }
    return this.days[n]!;
  }
}

/**
 * Plans a valid document (`validateConstruction` empty, so no loops). Returns diagnostics instead
 * of dates when the plan runs past the last kept year (`schedule-too-long`).
 */
export function scheduleConstruction(doc: ConstructionDocument): ConstructionSchedule {
  const n = doc.tasks.length;
  const index = new Map(doc.tasks.map((t, i) => [t.id, i]));
  const successors: { to: number; lag: number }[][] = doc.tasks.map(() => []);
  const indegree = new Int32Array(n);
  doc.tasks.forEach((t, i) =>
    t.predecessors.forEach((l) => {
      const p = index.get(l.taskId);
      if (p === undefined) return;
      successors[p]!.push({ to: i, lag: l.lagDays });
      indegree[i]++;
    }),
  );
  // Kahn's order, ties by document order.
  const order: number[] = [];
  const ready: number[] = [];
  for (let i = 0; i < n; i++) if (!indegree[i]) ready.push(i);
  while (ready.length) {
    const i = ready.shift()!;
    order.push(i);
    for (const s of successors[i]!) if (!--indegree[s.to]) ready.push(s.to);
  }
  if (order.length !== n) throw new Error('the predecessors loop: validate first');
  const es = new Float64Array(n);
  const ef = new Float64Array(n);
  for (const i of order) {
    const t = doc.tasks[i]!;
    let start = 0;
    for (const l of t.predecessors) {
      const p = index.get(l.taskId)!;
      start = Math.max(start, ef[p]! + l.lagDays);
    }
    es[i] = start;
    ef[i] = start + t.durationDays;
  }
  let end = 0;
  for (let i = 0; i < n; i++) end = Math.max(end, ef[i]!);
  const lf = new Float64Array(n).fill(end);
  const ls = new Float64Array(n);
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k]!;
    let finish = end;
    for (const s of successors[i]!) finish = Math.min(finish, ls[s.to]! - s.lag);
    lf[i] = finish;
    ls[i] = finish - doc.tasks[i]!.durationDays;
  }
  const days = new WorkingDays(doc);
  const diagnostics: ConstructionDiagnostic[] = [];
  const date = (k: number) => {
    const d = days.day(k);
    return d === null ? null : dayString(d);
  };
  const projectStart = date(0);
  const lastWorked = date(Math.max(0, end - 1));
  // The last day any task needs: a milestone falls on its own day, `end` itself at the latest.
  let needed = 0;
  doc.tasks.forEach((t, i) => {
    needed = Math.max(needed, t.durationDays ? ef[i]! - 1 : es[i]!);
  });
  if (projectStart === null || lastWorked === null || date(needed) === null) {
    return {
      tasks: [],
      byId: new Map(),
      projectStart: doc.startDate,
      projectFinish: doc.startDate,
      workingDays: end,
      diagnostics: [
        {
          code: 'schedule-too-long',
          path: '$.tasks',
          message: `the plan runs past ${constructionLimits.maxYear}`,
        },
      ],
    };
  }
  const tasks = doc.tasks.map((t, i): ScheduledTask => {
    const float = ls[i]! - es[i]!;
    return {
      id: t.id,
      earlyStart: es[i]!,
      earlyFinish: ef[i]!,
      lateStart: ls[i]!,
      lateFinish: lf[i]!,
      totalFloat: float,
      critical: float === 0,
      start: date(es[i]!)!,
      finish: t.durationDays ? date(ef[i]! - 1)! : date(es[i]!)!,
    };
  });
  const byId = new Map(tasks.map((t) => [t.id, t]));
  // An element removed before it is built.
  const built = new Map<string, string>();
  doc.tasks.forEach((t) => {
    if (t.action === 'construct') for (const e of t.elementIds) built.set(e, t.id);
  });
  doc.tasks.forEach((t, i) => {
    if (t.action !== 'remove') return;
    t.elementIds.forEach((e, k) => {
      const c = built.get(e);
      if (c !== undefined && byId.get(c)!.earlyFinish > es[i]!)
        diagnostics.push({
          code: 'remove-before-construct',
          path: `$.tasks[${i}].elementIds[${k}]`,
          message: `${e} is removed before ${c} finishes building it`,
        });
    });
  });
  return {
    tasks,
    byId,
    projectStart,
    projectFinish: end ? lastWorked : projectStart,
    workingDays: end,
    diagnostics,
  };
}

export type TaskPhase = 'before' | 'running' | 'after';

/** The first and last day a task is on site: the actual dates where typed in, else the plan. */
export function taskSpan(
  task: ConstructionTask,
  planned: ScheduledTask,
): { start: string; finish: string; milestone: boolean } {
  const start = task.actual?.start ?? planned.start;
  const finish = task.actual?.finish ?? (planned.finish >= start ? planned.finish : start);
  // A milestone stays instantaneous, actual dates or not: it is never running.
  return { start, finish, milestone: task.durationDays === 0 };
}

/** Where a task is on a day (YYYY-MM-DD). A milestone is never running. */
export function taskPhase(task: ConstructionTask, planned: ScheduledTask, day: string): TaskPhase {
  const span = taskSpan(task, planned);
  if (day < span.start) return 'before';
  if (span.milestone) return 'after';
  return day <= span.finish ? 'running' : 'after';
}

/**
 * The state of an element on a day.
 * - `existing`: no task holds it (it stands throughout)
 * - `absent`: not built yet, removed, or temporary works not standing
 * - `building`, `built`, `removing`, `temporary`
 */
export type ElementState = 'existing' | 'absent' | 'building' | 'built' | 'removing' | 'temporary';

export interface SiteDay {
  day: string;
  /** Elements some task holds, by state (elements no task holds are `existing`). */
  states: Map<string, Exclude<ElementState, 'existing'>>;
  /** Tasks running on the day, in document order. */
  running: string[];
}

/** What stands on site on one day. */
export function siteOnDay(
  doc: ConstructionDocument,
  schedule: ConstructionSchedule,
  day: string,
): SiteDay {
  const phase = new Map<string, TaskPhase>();
  const running: string[] = [];
  for (const t of doc.tasks) {
    const planned = schedule.byId.get(t.id);
    if (!planned) continue;
    const p = taskPhase(t, planned, day);
    phase.set(t.id, p);
    if (p === 'running') running.push(t.id);
  }
  const construct = new Map<string, TaskPhase>();
  const remove = new Map<string, TaskPhase>();
  const temporary = new Map<string, TaskPhase>();
  for (const t of doc.tasks) {
    const p = phase.get(t.id);
    if (!p) continue;
    const into = t.action === 'construct' ? construct : t.action === 'remove' ? remove : temporary;
    for (const e of t.elementIds) into.set(e, p);
  }
  const states = new Map<string, Exclude<ElementState, 'existing'>>();
  for (const [e, p] of temporary) states.set(e, p === 'running' ? 'temporary' : 'absent');
  const held = new Set([...construct.keys(), ...remove.keys()]);
  for (const e of held) {
    const r = remove.get(e);
    const c = construct.get(e);
    if (r === 'after') states.set(e, 'absent');
    else if (r === 'running') states.set(e, 'removing');
    else if (c === undefined)
      continue; // removed later: standing as it is
    else if (c === 'before') states.set(e, 'absent');
    else if (c === 'running') states.set(e, 'building');
    else states.set(e, 'built');
  }
  return { day, states, running };
}

/** The state of one element on a day, `existing` when no task holds it. */
export const elementState = (site: SiteDay, elementId: string): ElementState =>
  site.states.get(elementId) ?? 'existing';
