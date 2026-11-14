import { utcDay } from '@editor-platform/time-axis';
import {
  CONSTRUCTION_SCHEMA,
  constructionActions,
  constructionLimits as L,
  type ConstructionDiagnostic,
  type ConstructionDocument,
} from './model';
import { validateSite } from './site';

type Rec = Record<string, unknown>;
const reservedKeys = ['__proto__', 'constructor', 'prototype', 'toJSON'];
const record = (v: unknown): v is Rec =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const codePoints = (s: string) => [...s].length;

/** Artifact-scoped stable ID: 1–128 code points, no controls, whitespace edges or reserved keys. */
export const constructionId = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  codePoints(v) <= L.idCodePoints &&
  v.trim() === v &&
  !/\p{Cc}/u.test(v) &&
  !reservedKeys.includes(v);
const text = (v: unknown): v is string =>
  typeof v === 'string' && codePoints(v) <= L.nameCodePoints && !/\p{Cc}/u.test(v);
const int = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** A real calendar day YYYY-MM-DD within the kept years. */
export function constructionDate(v: unknown): v is string {
  if (typeof v !== 'string' || utcDay(v) === null) return false;
  const year = Number(v.slice(0, 4));
  return year >= L.minYear && year <= L.maxYear;
}

/** Plain JSON data only, depth-limited before any domain traversal. */
function jsonShape(value: unknown): { code: string; path: string } | undefined {
  const seen = new Set<object>();
  function visit(v: unknown, depth: number, path: string): { code: string; path: string } | void {
    if (depth > L.jsonDepth) return { code: 'json-depth', path };
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number') return Number.isFinite(v) ? undefined : { code: 'number', path };
    if (typeof v !== 'object' || seen.has(v)) return { code: 'json-value', path };
    const isArray = Array.isArray(v);
    if (Object.getPrototypeOf(v) !== (isArray ? Array.prototype : Object.prototype))
      return { code: 'json-value', path };
    seen.add(v);
    if (isArray)
      for (let i = 0; i < v.length; i++)
        if (!Object.prototype.hasOwnProperty.call(v, i))
          return { code: 'json-value', path: `${path}.${i}` };
    for (const key of Reflect.ownKeys(v)) {
      if (isArray && key === 'length') continue;
      if (typeof key !== 'string' || reservedKeys.includes(key)) return { code: 'json-key', path };
      if (isArray && !/^(0|[1-9][0-9]*)$/.test(key)) return { code: 'json-key', path };
      const d = Object.getOwnPropertyDescriptor(v, key)!;
      if (!('value' in d)) return { code: 'json-value', path: `${path}.${key}` };
      const r = visit(d.value, depth + 1, `${path}.${key}`);
      if (r) return r;
    }
    seen.delete(v);
  }
  return visit(value, 0, '$') ?? undefined;
}

function onlyKeys(v: Rec, keys: string[], path: string, out: ConstructionDiagnostic[]) {
  for (const k of Object.keys(v))
    if (!keys.includes(k)) out.push({ code: 'unknown-key', path: `${path}.${k}`, message: k });
}

/**
 * Checks the shape and values of a document; returns every problem found (empty = valid).
 * Whether the element IDs exist in the source BIM version is checked by `checkConstructionSource`.
 */
export function validateConstruction(value: unknown): ConstructionDiagnostic[] {
  const out: ConstructionDiagnostic[] = [];
  const bad = (code: string, path: string, message = code) => out.push({ code, path, message });
  const shape = jsonShape(value);
  if (shape) return [{ ...shape, message: 'not plain JSON data' }];
  if (!record(value)) return [{ code: 'not-object', path: '$', message: 'not an object' }];
  if (value.schemaVersion !== CONSTRUCTION_SCHEMA)
    return [{ code: 'unsupported-schema', path: '$.schemaVersion', message: 'schema 1 only' }];
  onlyKeys(
    value,
    ['schemaVersion', 'name', 'source', 'startDate', 'calendar', 'tasks', 'retiredIds', 'site'],
    '$',
    out,
  );
  if (!text(value.name)) bad('name', '$.name');
  const source = value.source;
  if (!record(source)) bad('source', '$.source');
  else {
    onlyKeys(source, ['artifactId', 'versionId', 'contentHash'], '$.source', out);
    for (const k of ['artifactId', 'versionId'])
      if (!constructionId(source[k])) bad('source', `$.source.${k}`);
    if (typeof source.contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(source.contentHash))
      bad('source', '$.source.contentHash');
  }
  if (!constructionDate(value.startDate)) bad('date', '$.startDate');
  const cal = value.calendar;
  if (!record(cal)) bad('calendar', '$.calendar');
  else {
    onlyKeys(cal, ['workWeekdays', 'holidays'], '$.calendar', out);
    const days = cal.workWeekdays;
    if (
      !Array.isArray(days) ||
      days.length === 0 ||
      !days.every((d, i) => int(d, 0, 6) && (i === 0 || (days[i - 1] as number) < d))
    )
      bad('calendar', '$.calendar.workWeekdays', 'ascending days 0–6, at least one');
    const hol = cal.holidays;
    if (!Array.isArray(hol) || hol.length > L.holidays)
      bad('limit-exceeded', '$.calendar.holidays');
    else
      hol.forEach((h, i) => {
        if (!constructionDate(h)) bad('date', `$.calendar.holidays[${i}]`);
        else if (i > 0 && !((hol[i - 1] as string) < h))
          bad('calendar', `$.calendar.holidays[${i}]`, 'ascending, no repeats');
      });
  }
  const retired = new Set<string>();
  if (value.retiredIds !== undefined) {
    const r = value.retiredIds;
    if (!Array.isArray(r) || r.length > L.retiredIds || !r.every(constructionId))
      bad('retired-ids', '$.retiredIds');
    else r.forEach((id) => retired.add(id));
  }
  const tasks = value.tasks;
  if (!Array.isArray(tasks)) {
    bad('tasks', '$.tasks');
    return out;
  }
  if (tasks.length > L.tasks) {
    bad('limit-exceeded', '$.tasks', `at most ${L.tasks} tasks`);
    return out;
  }
  const ids = new Set<string>();
  tasks.forEach((t, i) => {
    if (record(t) && constructionId(t.id)) {
      if (ids.has(t.id)) bad('duplicate-id', `$.tasks[${i}].id`, `${t.id} is used twice`);
      if (retired.has(t.id))
        bad('retired-id-in-use', `$.tasks[${i}].id`, `${t.id} was removed and is not reused`);
      ids.add(t.id);
    }
  });
  // element → the action of each task that holds it
  const holders = new Map<string, { action: string; path: string }[]>();
  tasks.forEach((t, i) => {
    const p = `$.tasks[${i}]`;
    if (!record(t)) return bad('task', p);
    onlyKeys(
      t,
      ['id', 'name', 'durationDays', 'predecessors', 'action', 'elementIds', 'actual'],
      p,
      out,
    );
    if (!constructionId(t.id)) bad('id', `${p}.id`);
    if (!text(t.name)) bad('name', `${p}.name`);
    if (!int(t.durationDays, 0, L.durationDays)) bad('duration', `${p}.durationDays`);
    if (!constructionActions.includes(t.action as never)) bad('action', `${p}.action`);
    const preds = t.predecessors;
    if (!Array.isArray(preds) || preds.length > L.predecessors)
      bad('predecessors', `${p}.predecessors`);
    else {
      const seen = new Set<string>();
      preds.forEach((l, k) => {
        const lp = `${p}.predecessors[${k}]`;
        if (!record(l)) return bad('link', lp);
        onlyKeys(l, ['taskId', 'lagDays'], lp, out);
        if (!int(l.lagDays, -L.lagDays, L.lagDays)) bad('lag', `${lp}.lagDays`);
        if (!constructionId(l.taskId)) return bad('link', `${lp}.taskId`);
        if (l.taskId === t.id) bad('self-link', `${lp}.taskId`);
        else if (!ids.has(l.taskId)) bad('task-missing', `${lp}.taskId`, l.taskId);
        if (seen.has(l.taskId)) bad('duplicate-link', `${lp}.taskId`, l.taskId);
        seen.add(l.taskId);
      });
    }
    const els = t.elementIds;
    if (!Array.isArray(els) || els.length > L.elementsPerTask)
      bad('elements', `${p}.elementIds`, `at most ${L.elementsPerTask} elements`);
    else {
      const seen = new Set<string>();
      els.forEach((e, k) => {
        if (!constructionId(e)) return bad('element-id', `${p}.elementIds[${k}]`);
        if (seen.has(e)) return bad('duplicate-element', `${p}.elementIds[${k}]`, e);
        seen.add(e);
        if (typeof t.action === 'string') {
          const list = holders.get(e) ?? [];
          list.push({ action: t.action, path: `${p}.elementIds[${k}]` });
          holders.set(e, list);
        }
      });
    }
    if (t.actual !== undefined) {
      const a = t.actual;
      if (!record(a)) bad('actual', `${p}.actual`);
      else {
        onlyKeys(a, ['start', 'finish', 'percent'], `${p}.actual`, out);
        if (a.start !== undefined && !constructionDate(a.start)) bad('date', `${p}.actual.start`);
        if (a.finish !== undefined && !constructionDate(a.finish))
          bad('date', `${p}.actual.finish`);
        if (
          constructionDate(a.start) &&
          constructionDate(a.finish) &&
          (a.finish as string) < (a.start as string)
        )
          bad('actual-order', `${p}.actual.finish`, 'finish before start');
        if (a.finish !== undefined && a.start === undefined)
          bad('actual-order', `${p}.actual.finish`, 'a finish needs a start');
        if (
          a.percent !== undefined &&
          !(typeof a.percent === 'number' && a.percent >= 0 && a.percent <= 100)
        )
          bad('percent', `${p}.actual.percent`);
      }
    }
  });
  if (value.site !== undefined) {
    // CS3: lifts name a task that builds and one of its elements.
    const tasks = new Map<string, { action: string; elementIds: readonly string[] }>();
    if (Array.isArray(value.tasks))
      for (const t of value.tasks)
        if (record(t) && typeof t.id === 'string')
          tasks.set(t.id, {
            // Only a string: an invalid action is reported above, never coerced here.
            action: typeof t.action === 'string' ? t.action : '',
            elementIds: Array.isArray(t.elementIds)
              ? t.elementIds.filter((e) => typeof e === 'string')
              : [],
          });
    out.push(...validateSite(value.site, ids, constructionId, text, tasks));
  }
  // One element: at most one construct, at most one remove; temporary works stand alone.
  for (const [element, list] of holders) {
    const count = (a: string) => list.filter((h) => h.action === a).length;
    for (const a of ['construct', 'remove', 'temporary'])
      if (count(a) > 1)
        bad(
          'element-twice',
          list.filter((h) => h.action === a)[1]!.path,
          `${element}: two ${a} tasks`,
        );
    if (count('temporary') && list.length > count('temporary'))
      bad(
        'element-twice',
        list.find((h) => h.action === 'temporary')!.path,
        `${element}: temporary works cannot also be built or removed`,
      );
  }
  if (!out.length) {
    const cycle = findCycle(value as unknown as ConstructionDocument);
    if (cycle)
      bad(
        'cycle',
        `$.tasks[${cycle.index}].predecessors`,
        `the predecessors loop: ${cycle.ids.join(' → ')}`,
      );
  }
  return out;
}

/** The first loop in the predecessors, by task order, or undefined. */
export function findCycle(doc: ConstructionDocument): { index: number; ids: string[] } | undefined {
  const byId = new Map(doc.tasks.map((t, i) => [t.id, i]));
  const state = new Uint8Array(doc.tasks.length); // 0 new, 1 on the stack, 2 done
  for (let root = 0; root < doc.tasks.length; root++) {
    if (state[root]) continue;
    // Iterative depth-first search: [task index, next predecessor].
    const stack: [number, number][] = [[root, 0]];
    state[root] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const preds = doc.tasks[top[0]]!.predecessors;
      if (top[1] >= preds.length) {
        state[top[0]] = 2;
        stack.pop();
        continue;
      }
      const next = byId.get(preds[top[1]++]!.taskId);
      if (next === undefined || state[next] === 2) continue;
      if (state[next] === 1) {
        const from = stack.findIndex(([i]) => i === next);
        const ids = stack.slice(from).map(([i]) => doc.tasks[i]!.id);
        return { index: next, ids: [...ids, doc.tasks[next]!.id] };
      }
      state[next] = 1;
      stack.push([next, 0]);
    }
  }
  return undefined;
}

export function isConstructionDocument(value: unknown): value is ConstructionDocument {
  return validateConstruction(value).length === 0;
}
