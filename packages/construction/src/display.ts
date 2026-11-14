import type { BimLook } from '@editor-platform/bim';
import {
  siteTaskRefs,
  taskSpan,
  type ConstructionDocument,
  type ConstructionLink,
  type ConstructionSchedule,
  type ElementState,
} from '@editor-platform/construction-core';
import { addDays } from '@editor-platform/time-axis';

/** CS1b: how each element state is drawn over the building (the 4D view). */
export const stateLooks: Record<Exclude<ElementState, 'existing' | 'built' | 'absent'>, BimLook> = {
  building: { color: '#f59e0b', opacity: 1 },
  removing: { color: '#dc2626', opacity: 0.85 },
  temporary: { color: '#8b5cf6', opacity: 0.9 },
};
/** Not built yet, shown faintly when the view shows what is still to come. */
export const ghostLook: BimLook = { color: '#94a3b8', opacity: 0.12 };

/**
 * The look of an element in a state: `undefined` keeps its own (standing), `null` leaves it out
 * (absent), unless `ghost` shows absent elements faintly.
 */
export function stateLook(state: ElementState, ghost: boolean): BimLook | null | undefined {
  if (state === 'existing' || state === 'built') return undefined;
  if (state === 'absent') return ghost ? ghostLook : null;
  return stateLooks[state];
}

/** The days the slider runs over: the day before the start to the day after the finish. */
export function sliderDays(projectStart: string, projectFinish: string) {
  return { first: addDays(projectStart, -1), last: addDays(projectFinish, 1) };
}

/**
 * The slider's days for a schedule: the planned project, widened to every task's actual dates
 * (typed in by hand, they may fall before the start or after the planned finish).
 */
export function playbackDays(doc: ConstructionDocument, schedule: ConstructionSchedule) {
  let start = schedule.projectStart;
  let finish = schedule.projectFinish;
  const onSite = siteTaskRefs(doc.site);
  for (const task of doc.tasks) {
    const planned = schedule.byId.get(task.id);
    if (!planned) continue;
    const span = taskSpan(task, planned);
    // A planned milestone without elements changes nothing on site: it does not widen the slider,
    // unless an earthwork or temporary work is done or taken down by it (CS2b).
    if (span.milestone && !task.actual?.start && !task.elementIds.length && !onSite.has(task.id))
      continue;
    if (span.start < start) start = span.start;
    if (span.finish > finish) finish = span.finish;
  }
  return sliderDays(start, finish);
}

/** Predecessors as typed in the task form, the CSV form: `a;b(2);c(-1)`. */
export function formatLinks(links: readonly ConstructionLink[]) {
  return links.map((l) => (l.lagDays ? `${l.taskId}(${l.lagDays})` : l.taskId)).join('; ');
}
/** Reads the task form's predecessors; the reason when it cannot. */
export function parseLinks(text: string): ConstructionLink[] | string {
  const out: ConstructionLink[] = [];
  for (const raw of text.split(';')) {
    const p = raw.trim();
    if (!p) continue;
    const m = /^(.*?)\s*\(\s*([+-]?\d+)\s*\)$/.exec(p);
    const taskId = (m ? m[1]! : p).trim();
    if (!taskId) return `"${p}" names no task`;
    out.push({ taskId, lagDays: m ? Number(m[2]) : 0 });
  }
  return out;
}

/** CS2b: plan points as typed in the site forms, one `x, y` (mm) a line. */
export function formatPlanList(points: readonly (readonly [number, number])[]) {
  return points.map(([x, y]) => `${x}, ${y}`).join('\n');
}
/** Reads plan points (one `x, y` in mm a line, or `;` between them); the reason when it cannot. */
export function parsePlanList(text: string): [number, number][] | string {
  const out: [number, number][] = [];
  for (const raw of text.split(/[\n;]/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([+-]?\d+(?:\.\d+)?)\s*[, ]\s*([+-]?\d+(?:\.\d+)?)$/.exec(line);
    if (!m) return `"${line}" is not "x, y" in mm`;
    out.push([Number(m[1]), Number(m[2])]);
  }
  return out;
}
/** A volume in m³ for the site panel: whole cubic metres, one decimal under 10. */
export function formatVolume(m3: number) {
  return m3 < 10 ? m3.toFixed(1) : Math.round(m3).toLocaleString('en-US');
}

/** CS3b: a load chart as typed in the crane form, one `radius, kg` a line (radius in mm). */
export function formatLoadChart(rows: readonly { radius: number; capacityKg: number }[]) {
  return rows.map((r) => `${r.radius}, ${r.capacityKg}`).join('\n');
}
/** Reads a load chart (one `radius, kg` a line); the reason when it cannot. */
export function parseLoadChart(text: string): { radius: number; capacityKg: number }[] | string {
  const points = parsePlanList(text);
  if (typeof points === 'string') return points.replace('"x, y" in mm', '"radius, kg"');
  return points.map(([radius, capacityKg]) => ({ radius, capacityKg }));
}
/** Reads one point `x, y, z` (mm); the reason when it cannot. */
export function parsePoint3(text: string): [number, number, number] | string {
  const m =
    /^\s*([+-]?\d+(?:\.\d+)?)\s*[, ]\s*([+-]?\d+(?:\.\d+)?)\s*[, ]\s*([+-]?\d+(?:\.\d+)?)\s*$/.exec(
      text,
    );
  if (!m) return `"${text.trim()}" is not "x, y, z" in mm`;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
/** A mass for the crane panel: tonnes to one decimal. */
export const formatTonnes = (kg: number) => `${(kg / 1000).toFixed(1)} t`;

/**
 * CS3b: an ID for the lift of `elementId` not in `taken` (which it joins): `lift-<element>`, the
 * element ID cut so the whole stays within 128 code points, `-2`, `-3` … on a clash.
 */
export function nextLiftId(elementId: string, taken: Set<string>): string {
  const stem = Array.from(elementId)
    .slice(0, 128 - 'lift-'.length - 6)
    .join('')
    .trimEnd();
  let id = `lift-${stem}`;
  for (let k = 2; taken.has(id); k++) id = `lift-${stem}-${k}`;
  taken.add(id);
  return id;
}
