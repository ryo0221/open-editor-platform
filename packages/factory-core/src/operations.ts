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
  FactoryValidationError,
  factoryLimits,
  type FactoryBuildingRef,
  type FactoryCalendar,
  type FactoryControl,
  type FactoryDocument,
  type FactoryExperiment,
  type FactoryFleet,
  type FactoryPaths,
  type FactoryWorkerPool,
  type FactoryLink,
  type FactoryObject,
  type FactoryProduct,
  type FactoryRunSettings,
} from './model';
import { validateFactory } from './validation';

/** The SHA-256 (hex) of a document's canonical JSON, the base an operation is prepared against. */
export const factoryContentHash = (doc: FactoryDocument) =>
  bytesToHex(sha256(new TextEncoder().encode(canonicalJson(doc))));

export type FactoryOperation =
  | { type: 'renameDocument'; name: string }
  /** Adds a product type, or replaces the one with its ID. */
  | { type: 'putProduct'; product: FactoryProduct }
  /** Refused while an object or link names it (`product-in-use`). */
  | { type: 'removeProduct'; id: string }
  /** Adds an object (at `index`, default the end), or replaces the one with its ID in place. */
  | { type: 'putObject'; object: FactoryObject; index?: number }
  /** Also removes the links to and from it. */
  | { type: 'removeObject'; id: string }
  /** Adds a link (at the end: the exit order), or replaces the one with its ID in place. */
  | { type: 'putLink'; link: FactoryLink }
  | { type: 'removeLink'; id: string }
  /** FT3: adds or replaces a shift calendar. */
  | { type: 'putCalendar'; calendar: FactoryCalendar }
  /** Refused (`calendar-in-use`) while an object works to it. */
  | { type: 'removeCalendar'; id: string }
  /** FT3b: adds or replaces a worker pool; removing one an object still needs is refused. */
  | { type: 'putWorkerPool'; pool: FactoryWorkerPool }
  | { type: 'removeWorkerPool'; id: string }
  /**
   * FT3c: replaces the whole path network (or removes it); IDs that leave it are retired.
   * Fleets and objects still referring to a point that is gone refuse it.
   */
  | { type: 'setPaths'; paths: FactoryPaths | null }
  | { type: 'putFleet'; fleet: FactoryFleet }
  | { type: 'removeFleet'; id: string }
  /**
   * FT6: replaces the PLC control (program and wiring), or removes it; signal IDs that leave it
   * are retired.
   */
  | { type: 'setControl'; control: FactoryControl | null }
  | { type: 'setRun'; run: FactoryRunSettings }
  /** FT4: the Building version the factory stands in (null: none). */
  | { type: 'setBuilding'; building: FactoryBuildingRef | null }
  /**
   * FT5: sets (or with null removes) the experiment. Removing an object, fleet or pool, or
   * changing an object's kind, drops the factors that no longer fit it.
   */
  | { type: 'setExperiment'; experiment: FactoryExperiment | null };
export type FactoryOperationType = FactoryOperation['type'];

const fail = (code: string, message: string): never => {
  throw new FactoryValidationError(code, message);
};

/** Product IDs an object refers to. */
function objectProducts(o: FactoryObject): string[] {
  switch (o.kind) {
    case 'source':
      return o.mix.map((m) => m.productId);
    case 'station':
    case 'parallel':
      return [
        ...(o.productTimes ?? []).map((t) => t.productId),
        ...(o.setup?.productTimes ?? []).map((t) => t.productId),
      ];
    case 'assembly':
      return [
        ...(o.setup?.productTimes ?? []).map((t) => t.productId),
        o.mainProductId,
        ...o.components.map((c) => c.productId),
        ...(o.outputProductId ? [o.outputProductId] : []),
      ];
    default:
      return [];
  }
}

/** One operation on a copy; the whole result is validated, so nothing is half-applied. */
export function applyFactoryOperation(doc: FactoryDocument, op: FactoryOperation): FactoryDocument {
  const next = structuredClone(doc);
  const retire = (ids: string[]) => {
    if (!ids.length) return;
    const r = new Set(next.retiredIds ?? []);
    ids.forEach((id) => r.add(id));
    if (r.size > factoryLimits.retiredIds) fail('limit-exceeded', 'retired IDs');
    next.retiredIds = [...r];
  };
  const put = <T extends { id: string }>(list: T[], item: T, index?: number) => {
    const i = list.findIndex((x) => x.id === item.id);
    if (i >= 0) return void (list[i] = structuredClone(item));
    const at = index ?? list.length;
    if (!Number.isInteger(at) || at < 0 || at > list.length) fail('index', 'no such position');
    list.splice(at, 0, structuredClone(item));
  };
  const take = <T extends { id: string }>(list: T[], id: string, what: string) => {
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) fail('not-found', `no ${what} ${id}`);
    list.splice(i, 1);
    retire([id]);
  };
  switch (op.type) {
    case 'renameDocument':
      next.name = op.name;
      break;
    case 'putProduct':
      put(next.products, op.product);
      break;
    case 'removeProduct': {
      const user =
        next.objects.find((o) => objectProducts(o).includes(op.id)) ??
        next.links.find((l) => l.productIds?.includes(op.id));
      if (user) fail('product-in-use', `${user.id} uses this product`);
      take(next.products, op.id, 'product');
      break;
    }
    case 'putObject': {
      const old = next.objects.find((o) => o.id === op.object.id);
      if (old && old.kind !== op.object.kind) {
        // A new kind may not keep links it cannot have.
        if (op.object.kind === 'source' && next.links.some((l) => l.to === old.id))
          fail('object-in-use', 'a source cannot have links in');
        if (op.object.kind === 'drain' && next.links.some((l) => l.from === old.id))
          fail('object-in-use', 'a drain cannot have links out');
      }
      put(next.objects, op.object, op.index);
      break;
    }
    case 'removeObject': {
      const gone = next.links.filter((l) => l.from === op.id || l.to === op.id).map((l) => l.id);
      take(next.objects, op.id, 'object');
      next.links = next.links.filter((l) => !gone.includes(l.id));
      retire(gone);
      // FT6: its wired signals go with it.
      if (next.control) {
        const c = next.control;
        const wired = [...c.sensors, ...c.actuators].filter((w) => w.objectId === op.id);
        c.sensors = c.sensors.filter((w) => w.objectId !== op.id);
        c.actuators = c.actuators.filter((w) => w.objectId !== op.id);
        retire(wired.map((w) => w.id));
      }
      break;
    }
    case 'setControl': {
      const ids = (c: FactoryControl | undefined) =>
        c ? [...c.sensors, ...c.actuators].map((w) => w.id) : [];
      const before = ids(next.control);
      if (op.control) next.control = structuredClone(op.control);
      else delete next.control;
      const now = new Set(ids(next.control));
      retire(before.filter((id) => !now.has(id)));
      break;
    }
    case 'putLink':
      put(next.links, op.link);
      break;
    case 'removeLink':
      take(next.links, op.id, 'link');
      break;
    case 'setRun':
      next.run = { ...op.run };
      break;
    case 'setBuilding':
      if (op.building) next.building = { ...op.building };
      else delete next.building;
      break;
    case 'setExperiment':
      if (op.experiment) next.experiment = structuredClone(op.experiment);
      else delete next.experiment;
      break;
    case 'putCalendar':
      put((next.calendars ??= []), op.calendar);
      break;
    case 'removeCalendar': {
      const user = next.objects.find((o) => o.calendarId === op.id);
      if (user) fail('calendar-in-use', `${user.id} works to this calendar`);
      take((next.calendars ??= []), op.id, 'calendar');
      if (!next.calendars.length) delete next.calendars;
      break;
    }
    case 'putWorkerPool':
      put((next.workerPools ??= []), op.pool);
      break;
    case 'setPaths': {
      const before = [
        ...(next.paths?.nodes ?? []).map((n) => n.id),
        ...(next.paths?.segments ?? []).map((g) => g.id),
      ];
      if (op.paths) next.paths = structuredClone(op.paths);
      else delete next.paths;
      const now = new Set([
        ...(next.paths?.nodes ?? []).map((n) => n.id),
        ...(next.paths?.segments ?? []).map((g) => g.id),
      ]);
      retire(before.filter((id) => !now.has(id)));
      break;
    }
    case 'putFleet':
      put((next.fleets ??= []), op.fleet);
      break;
    case 'removeFleet': {
      const user = next.links.find((l) => l.transport?.fleetId === op.id);
      if (user) fail('fleet-in-use', `${user.id} is carried by this fleet`);
      take((next.fleets ??= []), op.id, 'fleet');
      if (!next.fleets.length) delete next.fleets;
      break;
    }
    case 'removeWorkerPool':
      // Validation refuses objects whose workers no pool can bring any more.
      take((next.workerPools ??= []), op.id, 'worker pool');
      if (!next.workerPools.length) delete next.workerPools;
      break;
  }
  if (op.type !== 'setExperiment') dropUnfitFactors(next);
  const problems = validateFactory(next);
  if (problems.length)
    throw new FactoryValidationError(problems[0]!.code, problems[0]!.message, problems);
  return next;
}

/** FT5: factors whose target is gone or no longer of a kind they fit. */
function dropUnfitFactors(doc: FactoryDocument) {
  if (!doc.experiment) return;
  const kinds = new Map(doc.objects.map((o) => [o.id, o.kind]));
  const fleets = new Set((doc.fleets ?? []).map((f) => f.id));
  const pools = new Set((doc.workerPools ?? []).map((p) => p.id));
  doc.experiment.factors = doc.experiment.factors.filter((f) => {
    const k = kinds.get(f.targetId);
    switch (f.kind) {
      case 'buffer-capacity':
        return k === 'buffer';
      case 'parallel-count':
        return k === 'parallel';
      case 'time-scale':
        return k === 'station' || k === 'parallel' || k === 'assembly';
      case 'fleet-count':
        return fleets.has(f.targetId);
      case 'pool-count':
        return pools.has(f.targetId);
      default:
        return true;
    }
  });
}

/** Every ID of the document, removed ones included (they are never reused). */
export function factoryIds(doc: FactoryDocument): Set<string> {
  return new Set([
    ...doc.products.map((p) => p.id),
    ...doc.objects.map((o) => o.id),
    ...doc.links.map((l) => l.id),
    ...(doc.calendars ?? []).map((c) => c.id),
    ...(doc.workerPools ?? []).map((w) => w.id),
    ...(doc.paths?.nodes ?? []).map((n) => n.id),
    ...(doc.paths?.segments ?? []).map((g) => g.id),
    ...(doc.fleets ?? []).map((f) => f.id),
    ...(doc.control?.sensors ?? []).map((w) => w.id),
    ...(doc.control?.actuators ?? []).map((w) => w.id),
    ...(doc.retiredIds ?? []),
  ]);
}
/** `base`, or `base-2`, `base-3` …: the first that the document does not use yet. */
export function freshFactoryId(doc: FactoryDocument, base: string) {
  const taken = factoryIds(doc);
  const stem = [...base].slice(0, factoryLimits.idCodePoints - 8).join('');
  if (!taken.has(stem)) return stem;
  for (let n = 2; ; n++) if (!taken.has(`${stem}-${n}`)) return `${stem}-${n}`;
}

export interface FactoryCommandOptions {
  /** `factoryContentHash` of the base the operation was prepared against. */
  expectedHash: string;
  /** Trusted, current edit authority, re-read on apply. */
  canEdit: () => boolean;
  context?: LocalCommandContext;
}
const labels: Record<FactoryOperationType, string> = {
  renameDocument: 'Rename model',
  putProduct: 'Edit product',
  removeProduct: 'Remove product',
  putObject: 'Edit object',
  removeObject: 'Remove object',
  putLink: 'Edit link',
  removeLink: 'Remove link',
  setRun: 'Set run',
  setExperiment: 'Set experiment',
  putCalendar: 'Edit calendar',
  removeCalendar: 'Remove calendar',
  putWorkerPool: 'Edit worker pool',
  removeWorkerPool: 'Remove worker pool',
  setPaths: 'Set paths',
  setBuilding: 'Set building',
  putFleet: 'Edit fleet',
  removeFleet: 'Remove fleet',
  setControl: 'Set PLC control',
};
/**
 * One ordinary EditorSession transaction; re-checks base, authority and the whole document.
 * Several operations apply in order as one Undo step; any refused refuses them all.
 */
export function factoryEditorCommand(
  operations: FactoryOperation | readonly FactoryOperation[],
  options: FactoryCommandOptions,
): EditorCommand<FactoryDocument> {
  const prepared = structuredClone(
    Array.isArray(operations) ? [...operations] : [operations],
  ) as FactoryOperation[];
  const op = prepared[0];
  if (!op) throw new Error('no-operation');
  const run = (content: FactoryDocument) => {
    if (!options.canEdit()) throw new Error('permission-denied');
    if (factoryContentHash(content) !== options.expectedHash)
      throw new Error('factory-base-mismatch');
    return prepared.reduce(applyFactoryOperation, content);
  };
  const cmd = options.context
    ? immutableCommand(`factory.${op.type}`, labels[op.type], run, options.context)
    : immutableCommand(`factory.${op.type}`, labels[op.type], run);
  return withCommandReads(cmd, { content: ['*'] });
}
