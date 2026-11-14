/**
 * CS6a (docs/cad/construction-site.md, CS-U2): the schedule in IFC4, added to the building's own
 * IFC file (`bim-ifc`'s `writeIfc`). One `IfcWorkSchedule` declared in the project; each task an
 * `IfcTask` with its `IfcTaskTime` (planned and actual dates, float, critical), assigned to the
 * schedule (`IfcRelAssignsToControl`); each link an `IfcRelSequence` (finish to start, its lag an
 * `IfcLagTime` in working days); each element an `IfcRelAssignsToProduct` naming the tasks that
 * build, remove or stand it; each temporary work (CS6b) an `IfcBuildingElementProxy` on the site,
 * its footprint extruded, assigned to the tasks that put it up and take it down. Reading back is only for files written here (`readConstructionIfc`).
 */
import { readP21, type P21Instance, type P21Value } from '@editor-platform/geometry-core';
import { formatReal, formatString, stableGuid } from '@editor-platform/bim-ifc';
import { dayString } from '@editor-platform/time-axis';
import type { ConstructionAction, ConstructionDocument } from './model';
import { WorkingDays, type ConstructionSchedule } from './schedule';
import { siteTerrain } from './site';
import { clockText, siteHours } from './traffic';

/** The building's IFC as `writeIfc` returns it: its text and each element's GlobalId. */
export interface BuildingIfc {
  text: string;
  globalIds: ReadonlyMap<string, string>;
}

export interface ConstructionIfcOptions {
  /** The schedule Artifact's ID: with each task's ID it makes the stable GlobalIds. */
  artifactId: string;
}

export interface ConstructionIfc {
  text: string;
  /** GlobalId by task ID. */
  taskGlobalIds: Map<string, string>;
  /** Elements a task names that the building's file does not carry (rooms, openings, …). */
  notes: string[];
  /** CS6b: GlobalId by temporary work ID (`IfcBuildingElementProxy`). */
  temporaryGlobalIds: Map<string, string>;
}

/** IfcTask.WorkMethod for each action: read back as the action. */
export const ifcWorkMethods: Record<ConstructionAction, string> = {
  construct: 'CONSTRUCT',
  remove: 'REMOVE',
  temporary: 'TEMPORARY',
};

const predefinedTypes: Record<ConstructionAction, string> = {
  construct: 'CONSTRUCTION',
  remove: 'DEMOLITION',
  temporary: 'CONSTRUCTION',
};

/** One value in P21 form (only what this writer needs). */
function p21(v: P21Value): string {
  switch (v.t) {
    case 'ref':
      return `#${v.id}`;
    case 'enum':
      return `.${v.v}.`;
    case 'typed':
      return `${v.name}(${p21(v.v)})`;
    case 'real':
      return formatReal(v.v);
    case 'int':
      return String(v.v);
    case 'str':
      return formatString(v.v);
    case 'bool':
      return v.v ? '.T.' : '.F.';
    case 'list':
      return `(${v.v.map(p21).join(',')})`;
    case 'unset':
      return '$';
    default:
      return '$';
  }
}

const $: P21Value = { t: 'unset' };
const str = (v: string): P21Value => ({ t: 'str', v });
const enumOf = (v: string): P21Value => ({ t: 'enum', v });
const bool = (v: boolean): P21Value => ({ t: 'bool', v });
const list = (v: P21Value[]): P21Value => ({ t: 'list', v });
const typed = (name: string, v: P21Value): P21Value => ({ t: 'typed', name, v });
const real = (v: number): P21Value => ({ t: 'real', v });

/** Working days as an IfcDuration ("P5D"; a negative lag "-P2D", as ISO 8601 allows). */
const days = (n: number) => str(n < 0 ? `-P${-n}D` : `P${n}D`);
/** A day and a time of it as an IfcDateTime. */
const at = (day: string, minutes: number) => str(`${day}T${clockText(minutes)}:00`);

/**
 * The building's IFC with the schedule added. Every task is written, planned by `schedule`
 * (which must be the document's own, with dates for every task: otherwise it throws); an element a task names but the file does not carry is
 * left out of the assignments and named in `notes`.
 */
export function writeConstructionIfc(
  doc: ConstructionDocument,
  schedule: ConstructionSchedule,
  building: BuildingIfc,
  options: ConstructionIfcOptions,
): ConstructionIfc {
  const lines = building.text.split('\n');
  const end = lines.lastIndexOf('ENDSEC;');
  if (end < 0 || !lines.includes('DATA;')) throw new Error('not an IFC file');
  let next = 0;
  let project: number | undefined;
  let site: number | undefined;
  let body: number | undefined;
  for (const l of lines) {
    const m = /^#(\d+)=(\w+)\(/.exec(l);
    if (!m) continue;
    next = Math.max(next, Number(m[1]));
    if (m[2] === 'IFCPROJECT') project = Number(m[1]);
    else if (m[2] === 'IFCSITE') site ??= Number(m[1]);
    else if (m[2] === 'IFCGEOMETRICREPRESENTATIONSUBCONTEXT' && l.includes("('Body',"))
      body ??= Number(m[1]);
  }
  if (project === undefined) throw new Error('the IFC file has no IfcProject');
  // A plan without every task's dates (one that runs past the kept years) is not written.
  const unplanned = doc.tasks.filter((t) => !schedule.byId.has(t.id));
  if (unplanned.length)
    throw new Error(
      schedule.diagnostics[0]?.message ??
        `the schedule has no dates for ${unplanned.length} tasks: ${unplanned.map((t) => t.id).join(', ')}`,
    );
  const added: string[] = [];
  const add = (name: string, ...args: P21Value[]): P21Value => {
    const id = ++next;
    added.push(`#${id}=${name}(${args.map(p21).join(',')});`);
    return { t: 'ref', id };
  };
  const guid = (key: string) => str(stableGuid(`${options.artifactId}\u0000schedule\u0000${key}`));
  const [dayStart, dayEnd] = siteHours(doc);
  const working = new WorkingDays(doc);
  const dayOf = (n: number) => {
    const d = working.day(n);
    return d === null ? undefined : dayString(d);
  };

  const workSchedule = add(
    'IFCWORKSCHEDULE',
    guid('work-schedule'),
    $,
    str(doc.name),
    $,
    $,
    $,
    at(doc.startDate, 0),
    $,
    $,
    days(schedule.workingDays),
    $,
    at(schedule.projectStart, dayStart),
    at(schedule.projectFinish, dayEnd),
    enumOf('PLANNED'),
  );
  add('IFCRELDECLARES', guid('declares'), $, $, $, { t: 'ref', id: project }, list([workSchedule]));

  const taskGlobalIds = new Map<string, string>();
  const tasks = new Map<string, P21Value>();
  for (const t of doc.tasks) {
    const p = schedule.byId.get(t.id);
    if (!p) continue;
    const milestone = t.durationDays === 0;
    const lateStart = dayOf(p.lateStart);
    const lateFinish = milestone ? lateStart : dayOf(p.lateFinish - 1);
    const a = t.actual;
    const time = add(
      'IFCTASKTIME',
      $,
      $,
      $,
      enumOf('WORKTIME'),
      days(t.durationDays),
      at(p.start, dayStart),
      at(p.finish, milestone ? dayStart : dayEnd),
      at(p.start, dayStart),
      at(p.finish, milestone ? dayStart : dayEnd),
      lateStart ? at(lateStart, dayStart) : $,
      lateFinish ? at(lateFinish, milestone ? dayStart : dayEnd) : $,
      $,
      days(p.totalFloat),
      bool(p.critical),
      $,
      $,
      a?.start ? at(a.start, dayStart) : $,
      a?.finish ? at(a.finish, dayEnd) : $,
      $,
      a?.percent !== undefined ? real(a.percent / 100) : $,
    );
    const g = stableGuid(`${options.artifactId}\u0000schedule\u0000task\u0000${t.id}`);
    taskGlobalIds.set(t.id, g);
    tasks.set(
      t.id,
      add(
        'IFCTASK',
        str(g),
        $,
        str(t.name),
        $,
        $,
        str(t.id),
        $,
        $,
        str(ifcWorkMethods[t.action]),
        bool(milestone),
        $,
        time,
        enumOf(predefinedTypes[t.action]),
      ),
    );
  }
  if (tasks.size)
    add(
      'IFCRELASSIGNSTOCONTROL',
      guid('tasks'),
      $,
      $,
      $,
      list([...tasks.values()]),
      $,
      workSchedule,
    );
  for (const t of doc.tasks)
    t.predecessors.forEach((l, k) => {
      const from = tasks.get(l.taskId);
      const to = tasks.get(t.id);
      if (!from || !to) return;
      const lag = add(
        'IFCLAGTIME',
        $,
        $,
        $,
        typed('IFCDURATION', days(l.lagDays)),
        enumOf('WORKTIME'),
      );
      add(
        'IFCRELSEQUENCE',
        guid(`sequence\u0000${t.id}\u0000${k}`),
        $,
        $,
        $,
        from,
        to,
        lag,
        enumOf('FINISH_START'),
        $,
      );
    });
  // Each element: the tasks that act on it, in the document's order.
  const byElement = new Map<string, P21Value[]>();
  const missing = new Set<string>();
  for (const t of doc.tasks) {
    const task = tasks.get(t.id);
    if (!task) continue;
    for (const id of t.elementIds) {
      if (!building.globalIds.has(id)) {
        missing.add(id);
        continue;
      }
      const l = byElement.get(id) ?? [];
      l.push(task);
      byElement.set(id, l);
    }
  }
  // CS6b: temporary works as proxies on the site (an extruded footprint), each assigned to the
  // task that puts it up and the one that takes it down.
  const proxies = new Map<string, P21Value>();
  const temporaries = doc.site?.temporaries ?? [];
  if (temporaries.length && site !== undefined && body !== undefined) {
    const terrain = siteTerrain(doc.site);
    const up = add('IFCDIRECTION', list([real(0), real(0), real(1)]));
    for (const w of temporaries) {
      // As the site view stands it: on the lowest ground under its outline.
      const base = w.baseZ ?? Math.min(...w.outline.map((p) => terrain.heightAt(p)));
      const pts = [...w.outline, w.outline[0]!].map((p) =>
        add('IFCCARTESIANPOINT', list([real(p[0]), real(p[1])])),
      );
      const profile = add(
        'IFCARBITRARYCLOSEDPROFILEDEF',
        enumOf('AREA'),
        $,
        add('IFCPOLYLINE', list(pts)),
      );
      const solid = add(
        'IFCEXTRUDEDAREASOLID',
        profile,
        add(
          'IFCAXIS2PLACEMENT3D',
          add('IFCCARTESIANPOINT', list([real(0), real(0), real(0)])),
          $,
          $,
        ),
        up,
        real(w.height),
      );
      const shape = add(
        'IFCPRODUCTDEFINITIONSHAPE',
        $,
        $,
        list([
          add(
            'IFCSHAPEREPRESENTATION',
            { t: 'ref', id: body },
            str('Body'),
            str('SweptSolid'),
            list([solid]),
          ),
        ]),
      );
      const placement = add(
        'IFCLOCALPLACEMENT',
        $,
        add(
          'IFCAXIS2PLACEMENT3D',
          add('IFCCARTESIANPOINT', list([real(0), real(0), real(base)])),
          $,
          $,
        ),
      );
      proxies.set(
        w.id,
        add(
          'IFCBUILDINGELEMENTPROXY',
          guid(`temporary\u0000${w.id}`),
          $,
          str(w.name || w.id),
          $,
          str(w.kind),
          placement,
          shape,
          str(w.id),
          enumOf('USERDEFINED'),
        ),
      );
      // Each task once (put up and taken down in the same task: a SET holds it once).
      const by = [...new Set([w.fromTaskId, w.untilTaskId])]
        .filter((t): t is string => !!t)
        .map((t) => tasks.get(t))
        .filter((t): t is P21Value => !!t);
      if (by.length)
        add(
          'IFCRELASSIGNSTOPRODUCT',
          guid(`temporary-task\u0000${w.id}`),
          $,
          $,
          $,
          list(by),
          $,
          proxies.get(w.id)!,
        );
    }
    add(
      'IFCRELCONTAINEDINSPATIALSTRUCTURE',
      guid('temporaries'),
      $,
      str('Temporary works'),
      $,
      list([...proxies.values()]),
      { t: 'ref', id: site },
    );
  }
  const products = new Map<string, number>();
  for (const l of lines) {
    const m = /^#(\d+)=\w+\('([^']{22})'/.exec(l);
    if (m) products.set(m[2]!, Number(m[1]));
  }
  const notes: string[] = [];
  for (const [id, list_] of byElement) {
    const ref = products.get(building.globalIds.get(id)!);
    if (ref === undefined) {
      missing.add(id);
      continue;
    }
    add('IFCRELASSIGNSTOPRODUCT', guid(`product\u0000${id}`), $, $, $, list(list_), $, {
      t: 'ref',
      id: ref,
    });
  }
  if (missing.size)
    notes.push(
      `${missing.size} element${missing.size === 1 ? '' : 's'} named by tasks ${missing.size === 1 ? 'is' : 'are'} not in the building's file and ${missing.size === 1 ? 'is' : 'are'} left out of the schedule: ${[...missing].slice(0, 10).join(', ')}${missing.size > 10 ? ', …' : ''}`,
    );
  const text = [...lines.slice(0, end), ...added, ...lines.slice(end)].join('\n');
  const temporaryGlobalIds = new Map(
    [...proxies.keys()].map((id) => [
      id,
      stableGuid(`${options.artifactId}\u0000schedule\u0000temporary\u0000${id}`),
    ]),
  );
  return { text, taskGlobalIds, notes, temporaryGlobalIds };
}

/** A task as read back from a file written by `writeConstructionIfc`. */
export interface IfcScheduleTask {
  id: string;
  name: string;
  durationDays: number;
  action: ConstructionAction;
  start: string;
  finish: string;
  predecessors: { taskId: string; lagDays: number }[];
  /** GlobalIds of the products the task is assigned to. */
  products: string[];
}

/** The schedule read back from a file this module wrote: its name and tasks, in file order. */
export function readConstructionIfc(text: string): { name: string; tasks: IfcScheduleTask[] } {
  const file = readP21(new TextEncoder().encode(text), {
    bytes: 512 * 1024 * 1024,
    entities: 20_000_000,
    depth: 16,
  });
  const ents = file.entities;
  const get = (v: P21Value | undefined): P21Instance | undefined =>
    v?.t === 'ref' ? ents.get(v.id) : undefined;
  const s = (v: P21Value | undefined) =>
    v?.t === 'str' ? v.v : v?.t === 'typed' && v.v.t === 'str' ? v.v.v : '';
  const dur = (v: P21Value | undefined) => {
    const m = /^(-?)P(\d+)D$/.exec(s(v));
    return m ? (m[1] ? -1 : 1) * Number(m[2]) : NaN;
  };
  const schedule = [...ents.values()].find((e) => e.type === 'IFCWORKSCHEDULE');
  if (!schedule) throw new Error('the file has no IfcWorkSchedule');
  const byRef = new Map<number, IfcScheduleTask>();
  const methods = new Map(Object.entries(ifcWorkMethods).map(([a, m]) => [m, a]));
  for (const e of ents.values()) {
    if (e.type !== 'IFCTASK') continue;
    const time = get(e.args[11]);
    byRef.set(e.id, {
      id: s(e.args[5]),
      name: s(e.args[2]),
      durationDays: dur(time?.args[4]),
      action: (methods.get(s(e.args[8])) ?? 'construct') as ConstructionAction,
      start: s(time?.args[5]).slice(0, 10),
      finish: s(time?.args[6]).slice(0, 10),
      predecessors: [],
      products: [],
    });
  }
  for (const e of ents.values()) {
    if (e.type === 'IFCRELSEQUENCE') {
      const from = e.args[4]?.t === 'ref' ? byRef.get(e.args[4].id) : undefined;
      const to = e.args[5]?.t === 'ref' ? byRef.get(e.args[5].id) : undefined;
      const lag = get(e.args[6]);
      if (from && to) to.predecessors.push({ taskId: from.id, lagDays: dur(lag?.args[3]) });
    } else if (e.type === 'IFCRELASSIGNSTOPRODUCT') {
      const product = get(e.args[6]);
      const g = s(product?.args[0]);
      const related = e.args[4]?.t === 'list' ? e.args[4].v : [];
      for (const r of related) if (r.t === 'ref') byRef.get(r.id)?.products.push(g);
    }
  }
  return { name: s(schedule.args[2]), tasks: [...byRef.values()] };
}
