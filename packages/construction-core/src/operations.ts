import { canonicalJson } from '@editor-platform/artifact-core';
import {
  immutableCommand,
  withCommandReads,
  type EditorCommand,
  type LocalCommandContext,
} from '@editor-platform/editor-core';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import {
  ConstructionValidationError,
  constructionLimits,
  type ConstructionCalendar,
  type ConstructionDocument,
  type ConstructionTask,
} from './model';
import {
  emptySite,
  siteTaskRefs,
  type ConstructionSite,
  type Earthwork,
  type TemporaryWork,
} from './site';
import { validateConstruction } from './validation';
import type { Crane, Lift } from './crane';
import type { SiteLoad } from './frame';
import type { SiteHours, SiteRoute, SiteZone } from './traffic';

/** The SHA-256 (hex) of a document's canonical JSON, the base an operation is prepared against. */
export const constructionContentHash = (doc: ConstructionDocument) =>
  bytesToHex(sha256(new TextEncoder().encode(canonicalJson(doc))));

export type ConstructionOperation =
  | { type: 'renameDocument'; name: string }
  /** Points the schedule at another BIM version; element IDs are kept and checked again. */
  | { type: 'setSource'; source: ConstructionDocument['source'] }
  | { type: 'setStartDate'; startDate: string }
  | { type: 'setCalendar'; calendar: ConstructionCalendar }
  /** Added at `index` (default: the end). */
  | { type: 'addTask'; task: ConstructionTask; index?: number }
  | { type: 'updateTask'; task: ConstructionTask }
  /** Refused while another task follows it (`task-in-use`). */
  | { type: 'removeTask'; id: string }
  /**
   * Replaces every task (a CSV import). Old IDs that are not kept are retired; a kept ID must not
   * be a retired one.
   */
  | { type: 'replaceTasks'; tasks: ConstructionTask[] }
  /** CS2: the boundary and the surveyed ground (the earthworks and temporary works are kept). */
  | {
      type: 'setSiteGround';
      boundary: ConstructionSite['boundary'];
      terrain: ConstructionSite['terrain'];
    }
  /** Adds an earthwork, or replaces the one with its ID. */
  | { type: 'putEarthwork'; earthwork: Earthwork }
  | { type: 'removeEarthwork'; id: string }
  /** Adds a temporary work, or replaces the one with its ID. */
  | { type: 'putTemporary'; temporary: TemporaryWork }
  | { type: 'removeTemporary'; id: string }
  /** CS3: adds a crane, or replaces the one with its ID. */
  | { type: 'putCrane'; crane: Crane }
  /** Refused while a lift uses it (`crane-in-use`). */
  | { type: 'removeCrane'; id: string }
  /** CS3: adds a lift, or replaces the one with its ID. */
  | { type: 'putLift'; lift: Lift }
  | { type: 'removeLift'; id: string }
  /** CS4: adds a site load, or replaces the one with its ID. */
  | { type: 'putSiteLoad'; load: SiteLoad }
  | { type: 'removeSiteLoad'; id: string }
  | { type: 'putRoute'; route: SiteRoute }
  | { type: 'removeRoute'; id: string }
  | { type: 'putZone'; zone: SiteZone }
  | { type: 'removeZone'; id: string }
  | { type: 'setSiteHours'; hours: SiteHours | undefined };
export type ConstructionOperationType = ConstructionOperation['type'];

const fail = (code: string, message: string): never => {
  throw new ConstructionValidationError(code, message);
};

/** One operation on a copy; the whole result is validated, so nothing is half-applied. */
export function applyConstructionOperation(
  doc: ConstructionDocument,
  op: ConstructionOperation,
): ConstructionDocument {
  const next = structuredClone(doc);
  const at = (id: string) => {
    const i = next.tasks.findIndex((t) => t.id === id);
    if (i < 0) fail('not-found', `no task ${id}`);
    return i;
  };
  const retire = (ids: string[]) => {
    if (!ids.length) return;
    const r = new Set(next.retiredIds ?? []);
    ids.forEach((id) => r.add(id));
    if (r.size > constructionLimits.retiredIds) fail('limit-exceeded', 'retired IDs');
    next.retiredIds = [...r];
  };
  switch (op.type) {
    case 'renameDocument':
      next.name = op.name;
      break;
    case 'setSource':
      next.source = structuredClone(op.source);
      break;
    case 'setStartDate':
      next.startDate = op.startDate;
      break;
    case 'setCalendar':
      next.calendar = structuredClone(op.calendar);
      break;
    case 'addTask': {
      const index = op.index ?? next.tasks.length;
      if (!Number.isInteger(index) || index < 0 || index > next.tasks.length)
        fail('index', 'no such position');
      next.tasks.splice(index, 0, structuredClone(op.task));
      break;
    }
    case 'updateTask':
      next.tasks[at(op.task.id)] = structuredClone(op.task);
      break;
    case 'removeTask': {
      const i = at(op.id);
      const follower = next.tasks.find((t) => t.predecessors.some((l) => l.taskId === op.id));
      if (follower) fail('task-in-use', `${follower.name || follower.id} follows this task`);
      if (siteTaskRefs(next.site).has(op.id))
        fail(
          'task-in-use',
          'an earthwork, temporary work, crane, lift or site load on the site names this task',
        );
      next.tasks.splice(i, 1);
      retire([op.id]);
      break;
    }
    case 'replaceTasks': {
      const kept = new Set(op.tasks.map((t) => t.id));
      const gone = next.tasks.map((t) => t.id).filter((id) => !kept.has(id));
      next.tasks = structuredClone(op.tasks);
      retire(gone);
      break;
    }
    case 'setSiteGround':
      next.site = {
        ...(next.site ?? emptySite()),
        boundary: structuredClone(op.boundary),
        terrain: structuredClone(op.terrain),
      };
      break;
    case 'putEarthwork':
    case 'putTemporary': {
      const site = (next.site ??= emptySite());
      const list: { id: string }[] =
        op.type === 'putEarthwork' ? site.earthworks : site.temporaries;
      const item = structuredClone(op.type === 'putEarthwork' ? op.earthwork : op.temporary);
      const taken =
        op.type === 'putEarthwork'
          ? site.temporaries.some((t) => t.id === item.id)
          : site.earthworks.some((w) => w.id === item.id);
      if (taken) fail('duplicate-id', `${item.id} is used twice`);
      const i = list.findIndex((x) => x.id === item.id);
      if (i < 0) list.push(item);
      else list[i] = item;
      break;
    }
    case 'removeEarthwork':
    case 'removeTemporary': {
      const site = next.site;
      const list: { id: string }[] =
        (op.type === 'removeEarthwork' ? site?.earthworks : site?.temporaries) ?? [];
      const i = list.findIndex((x) => x.id === op.id);
      if (i < 0)
        fail(
          'not-found',
          `no ${op.type === 'removeEarthwork' ? 'earthwork' : 'temporary work'} ${op.id}`,
        );
      list.splice(i, 1);
      break;
    }
    case 'putRoute':
    case 'putZone': {
      const site = (next.site ??= emptySite());
      const list: { id: string }[] =
        op.type === 'putRoute' ? (site.routes ??= []) : (site.zones ??= []);
      const item = structuredClone(op.type === 'putRoute' ? op.route : op.zone);
      const i = list.findIndex((x) => x.id === item.id);
      if (i < 0) list.push(item);
      else list[i] = item;
      break;
    }
    case 'removeRoute':
    case 'removeZone': {
      const site = next.site;
      const key = op.type === 'removeRoute' ? 'routes' : 'zones';
      const list: { id: string }[] = site?.[key] ?? [];
      const i = list.findIndex((x) => x.id === op.id);
      if (i < 0) fail('not-found', `no ${key === 'routes' ? 'route' : 'zone'} ${op.id}`);
      list.splice(i, 1);
      if (!list.length) delete site![key];
      break;
    }
    case 'setSiteHours': {
      const site = (next.site ??= emptySite());
      if (op.hours) site.hours = { ...op.hours };
      else delete site.hours;
      break;
    }
    case 'putCrane':
    case 'putLift':
    case 'putSiteLoad': {
      const site = (next.site ??= emptySite());
      const list: { id: string }[] =
        op.type === 'putCrane'
          ? (site.cranes ??= [])
          : op.type === 'putLift'
            ? (site.lifts ??= [])
            : (site.loads ??= []);
      const item = structuredClone(
        op.type === 'putCrane' ? op.crane : op.type === 'putLift' ? op.lift : op.load,
      );
      const i = list.findIndex((x) => x.id === item.id);
      if (i < 0) list.push(item);
      else list[i] = item;
      break;
    }
    case 'removeCrane':
    case 'removeLift':
    case 'removeSiteLoad': {
      const site = next.site;
      const key =
        op.type === 'removeCrane' ? 'cranes' : op.type === 'removeLift' ? 'lifts' : 'loads';
      const list: { id: string }[] = site?.[key] ?? [];
      const i = list.findIndex((x) => x.id === op.id);
      if (i < 0)
        fail(
          'not-found',
          `no ${{ cranes: 'crane', lifts: 'lift', loads: 'site load' }[key]} ${op.id}`,
        );
      if (op.type === 'removeCrane' && site?.lifts?.some((l) => l.craneId === op.id))
        fail('crane-in-use', 'a lift uses this crane');
      list.splice(i, 1);
      // An empty list is left out, as in a document made before cranes.
      if (!list.length) delete site![key];
      break;
    }
  }
  const problems = validateConstruction(next);
  if (problems.length)
    throw new ConstructionValidationError(problems[0]!.code, problems[0]!.message, problems);
  return next;
}

/** Every task ID of the document, removed ones included (they are never reused). */
export function constructionIds(doc: ConstructionDocument): Set<string> {
  return new Set([...doc.tasks.map((t) => t.id), ...(doc.retiredIds ?? [])]);
}
/** `base`, or `base-2`, `base-3` …: the first that the document does not use yet. */
export function freshConstructionId(doc: ConstructionDocument, base: string) {
  const taken = constructionIds(doc);
  const stem = [...base].slice(0, constructionLimits.idCodePoints - 8).join('');
  if (!taken.has(stem)) return stem;
  for (let n = 2; ; n++) if (!taken.has(`${stem}-${n}`)) return `${stem}-${n}`;
}

export interface ConstructionCommandOptions {
  /** `constructionContentHash` of the base the operation was prepared against. */
  expectedHash: string;
  /** Trusted, current edit authority, re-read on apply. */
  canEdit: () => boolean;
  context?: LocalCommandContext;
}
const labels: Record<ConstructionOperationType, string> = {
  renameDocument: 'Rename schedule',
  setSource: 'Change BIM version',
  setStartDate: 'Set start date',
  setCalendar: 'Set calendar',
  addTask: 'Add task',
  updateTask: 'Edit task',
  removeTask: 'Remove task',
  replaceTasks: 'Import tasks',
  setSiteGround: 'Set site ground',
  putEarthwork: 'Edit earthwork',
  removeEarthwork: 'Remove earthwork',
  putTemporary: 'Edit temporary work',
  removeTemporary: 'Remove temporary work',
  putCrane: 'Edit crane',
  removeCrane: 'Remove crane',
  putLift: 'Edit lift',
  removeLift: 'Remove lift',
  putSiteLoad: 'Edit site load',
  removeSiteLoad: 'Remove site load',
  putRoute: 'Edit route',
  removeRoute: 'Remove route',
  putZone: 'Edit danger zone',
  removeZone: 'Remove danger zone',
  setSiteHours: 'Set working hours',
};
/**
 * One ordinary EditorSession transaction; re-checks base, authority and the whole document.
 * Several operations apply in order as one Undo step; any refused refuses them all.
 */
export function constructionEditorCommand(
  operations: ConstructionOperation | readonly ConstructionOperation[],
  options: ConstructionCommandOptions,
): EditorCommand<ConstructionDocument> {
  const prepared = structuredClone(
    Array.isArray(operations) ? [...operations] : [operations],
  ) as ConstructionOperation[];
  const op = prepared[0];
  if (!op) throw new Error('no-operation');
  const run = (content: ConstructionDocument) => {
    if (!options.canEdit()) throw new Error('permission-denied');
    if (constructionContentHash(content) !== options.expectedHash)
      throw new Error('construction-base-mismatch');
    return prepared.reduce(applyConstructionOperation, content);
  };
  const cmd = options.context
    ? immutableCommand(`construction.${op.type}`, labels[op.type], run, options.context)
    : immutableCommand(`construction.${op.type}`, labels[op.type], run);
  return withCommandReads(cmd, { content: ['*'] });
}
