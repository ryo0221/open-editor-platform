import { canonicalJson } from '@editor-platform/artifact-core';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { cross, distance, dot, sub, unit } from './geometry';
import { BimContext } from './derive';
import { bimWallAxis } from './solids';
import {
  bimTolerance,
  type BimDocument,
  type BimElement,
  type BimPoint,
  type BimProject,
  type BimTop,
  type BimWallJoin,
  type Vec2,
} from './model';
import { assertBim, bimId, record } from './validation';

export const bimContentHash = (doc: BimDocument) =>
  bytesToHex(sha256(new TextEncoder().encode(canonicalJson(doc))));

export const bimCollections = [
  'levels',
  'grids',
  'materials',
  'types',
  'elements',
  'joins',
  'views',
  'propertySets',
] as const;
export type BimCollection = (typeof bimCollections)[number];
type Entity = BimDocument[BimCollection][number];

/**
 * Pure, atomic operations. The caller's trusted layer assigns every new ID before the operation
 * is built. Each result is validated as a whole; any problem leaves the input untouched.
 */
export type BimOperation =
  | { type: 'insert'; entities: Partial<{ [K in BimCollection]: BimDocument[K] }> }
  /** Replaces one entity by ID; an element or type keeps its kind. */
  | { type: 'update'; collection: BimCollection; entity: Entity }
  /** Without `cascade`, deleting an entity something depends on is refused (`in-use`). */
  | { type: 'delete'; ids: string[]; cascade: boolean }
  | { type: 'setProject'; project: BimProject };
export type BimOperationType = BimOperation['type'];

export class BimOperationError extends Error {
  constructor(
    readonly code: string,
    /** `in-use`: the entities that depend on the deleted ones. */
    readonly dependents: string[] = [],
  ) {
    super(code);
  }
}

const pointRefs = (p: BimPoint | undefined) => (p && 'grid' in p ? p.grid : []);
const topRefs = (t: BimTop | undefined) => (t && 'level' in t ? [t.level] : []);
/** IDs an entity depends on (property sets are listed separately: they never cascade). */
export function entityReferences(collection: BimCollection, e: Entity): string[] {
  switch (collection) {
    case 'types': {
      const t = e as BimDocument['types'][number];
      return 'layers' in t
        ? t.layers.map((l) => l.materialId)
        : 'materialId' in t
          ? [t.materialId]
          : [];
    }
    case 'elements': {
      const el = e as BimElement;
      const refs: string[] = [];
      if ('typeId' in el) refs.push(el.typeId);
      if ('hostId' in el) refs.push(el.hostId);
      if ('clipBy' in el && el.clipBy) refs.push(el.clipBy);
      if ('base' in el) refs.push(el.base.level);
      if (el.kind === 'slab' || el.kind === 'beam') refs.push(el.top.level);
      if (el.kind === 'wall' || el.kind === 'column' || el.kind === 'space')
        refs.push(...topRefs(el.top));
      if (el.kind === 'wall' || el.kind === 'beam')
        refs.push(...pointRefs(el.start), ...pointRefs(el.end));
      if (el.kind === 'column' || el.kind === 'part') refs.push(...pointRefs(el.at));
      return refs;
    }
    case 'joins':
      return [...(e as BimWallJoin).walls];
    case 'views': {
      const v = e as BimDocument['views'][number];
      return v.kind === 'plan' ? [v.level] : [];
    }
    default:
      return [];
  }
}
const propertySetRefs = (e: Entity) =>
  'properties' in e && e.properties && !Array.isArray(e.properties)
    ? Object.keys(e.properties)
    : [];

/** Every entity that depends on `ids`, directly or through others (not including `ids`). */
export function bimDependents(doc: BimDocument, ids: readonly string[]): string[] {
  const gone = new Set(ids);
  const out: string[] = [];
  for (let grew = true; grew; ) {
    grew = false;
    for (const k of bimCollections)
      for (const e of doc[k] as Entity[])
        if (!gone.has(e.id) && entityReferences(k, e).some((r) => gone.has(r))) {
          gone.add(e.id);
          out.push(e.id);
          grew = true;
        }
  }
  return out;
}

export function applyBimOperation(doc: BimDocument, op: BimOperation): BimDocument {
  const next = structuredClone(doc);
  switch (op.type) {
    case 'insert':
      for (const k of bimCollections) {
        const list = op.entities[k];
        if (list) (next[k] as Entity[]).push(...structuredClone(list));
      }
      break;
    case 'update': {
      const list = next[op.collection] as Entity[];
      const i = list.findIndex((e) => e.id === op.entity.id);
      if (i < 0) throw new BimOperationError('not-found');
      const old = list[i] as { kind?: string };
      if (old.kind !== (op.entity as { kind?: string }).kind)
        throw new BimOperationError('update-kind');
      list[i] = structuredClone(op.entity);
      break;
    }
    case 'delete': {
      const all = new Set(bimCollections.flatMap((k) => (next[k] as Entity[]).map((e) => e.id)));
      if (op.ids.some((id) => !all.has(id))) throw new BimOperationError('not-found');
      const dependents = bimDependents(next, op.ids);
      const sets = new Set(op.ids.filter((id) => next.propertySets.some((s) => s.id === id)));
      const valued = bimCollections.flatMap((k) =>
        (next[k] as Entity[])
          .filter((e) => !op.ids.includes(e.id) && propertySetRefs(e).some((r) => sets.has(r)))
          .map((e) => e.id),
      );
      if (!op.cascade && (dependents.length || valued.length))
        throw new BimOperationError('in-use', [...new Set([...dependents, ...valued])]);
      const gone = new Set([...op.ids, ...dependents]);
      for (const k of bimCollections) {
        const lists = next as unknown as Record<BimCollection, Entity[]>;
        lists[k] = lists[k].filter((e) => !gone.has(e.id));
        // A deleted property set takes its values with it; the entities stay.
        if (k === 'propertySets') continue;
        for (const e of next[k] as { properties?: Record<string, unknown> }[])
          if (e.properties) {
            for (const s of sets) delete e.properties[s];
            if (Object.keys(e.properties).length === 0) delete e.properties;
          }
      }
      break;
    }
    case 'setProject':
      next.project = structuredClone(op.project);
      break;
  }
  assertBim(next);
  return next;
}

/** Shape gate for operation data from UI, headless callers or proposals. */
export function assertBimOperation(op: unknown): asserts op is BimOperation {
  if (!record(op) || typeof op.type !== 'string') throw new Error('unsupported-operation');
  const keys = Object.keys(op).sort().join(',');
  const ok =
    op.type === 'insert'
      ? keys === 'entities,type' &&
        record(op.entities) &&
        Object.entries(op.entities).every(
          ([k, v]) => (bimCollections as readonly string[]).includes(k) && Array.isArray(v),
        )
      : op.type === 'update'
        ? keys === 'collection,entity,type' &&
          (bimCollections as readonly unknown[]).includes(op.collection) &&
          record(op.entity) &&
          bimId(op.entity.id)
        : op.type === 'delete'
          ? keys === 'cascade,ids,type' &&
            Array.isArray(op.ids) &&
            op.ids.length > 0 &&
            op.ids.every(bimId) &&
            typeof op.cascade === 'boolean'
          : op.type === 'setProject'
            ? keys === 'project,type' && record(op.project)
            : undefined;
  if (ok === undefined) throw new Error('unsupported-operation');
  if (!ok) throw new Error('operation-schema');
}

/**
 * Joins a drawing command would add for `wallId`: an end of it at an end of another wall (L,
 * `butt` with the other wall running through; an arc wall too, OH-U3, but at a shallow corner
 * a `miter` or nothing) or, for straight walls, on another wall's axis (T). The caller assigns
 * IDs and may change the kind; nothing is joined implicitly.
 */
/** |sin| of the turn below which an arc wall's corner is shallow (about 15°). */
const shallowTurn = 0.25;

export function proposeJoins(doc: BimDocument, wallId: string): Omit<BimWallJoin, 'id'>[] {
  const ctx = new BimContext(doc);
  const walls = doc.elements.filter(
    (e): e is Extract<BimElement, { kind: 'wall' }> => e.kind === 'wall',
  );
  const me = walls.find((w) => w.id === wallId);
  if (!me) return [];
  const joined = new Set(
    doc.joins.filter((j) => j.walls.includes(wallId)).map((j) => j.walls.find((w) => w !== wallId)),
  );
  /** Each end's point and direction of travel there (an arc wall's tangent, OH-U3). */
  const ends = (w: typeof me): [Vec2, Vec2][] => {
    const a = bimWallAxis(ctx, w);
    return [
      [a.s, a.at(0)[1]],
      [a.e, a.at(a.length)[1]],
    ];
  };
  const heights = (w: typeof me) => {
    const z = ctx.height(w.base);
    return [z, ctx.top(z, w.top)];
  };
  const mine = ends(me);
  const [myBase, myTop] = heights(me);
  const out: Omit<BimWallJoin, 'id'>[] = [];
  for (const other of walls) {
    if (other.id === wallId || joined.has(other.id)) continue;
    // Walls on other storeys meet only in plan.
    const [base, top] = heights(other);
    if (Math.min(top, myTop) - Math.max(base, myBase) <= bimTolerance) continue;
    const theirs = ends(other);
    const [s, e] = theirs.map(([p]) => p) as [Vec2, Vec2];
    // The wall that runs through must span the other's full height.
    const otherThrough = base <= myBase + bimTolerance && top >= myTop - bimTolerance;
    const meThrough = myBase <= base + bimTolerance && myTop >= top - bimTolerance;
    const touches = (p: Vec2, q: Vec2) => distance(p, q) <= bimTolerance;
    const corner = mine
      .flatMap((m, i) => theirs.map((t, k) => [m, t, i, k] as const))
      .find(([m, t]) => touches(m[0], t[0]));
    if (corner) {
      // Walls that run on in one direction continue each other; no join kind applies.
      const turn = Math.abs(cross(corner[0][1], corner[1][1]));
      if (turn < 1e-9) continue;
      // An arc wall at a shallow corner: a butt's faces would meet far back along the other
      // wall, so the walls meet in a miter (same height, thickness and location) or not at all.
      if ((me.bulge || other.bulge) && turn < shallowTurn) {
        // Directions from the corner into each wall: opposite ones run on, alike ones fold back.
        const into = (d: Vec2, end: number) => (end === 0 ? d : ([-d[0], -d[1]] as Vec2));
        const fold = dot(into(corner[0][1], corner[2]), into(corner[1][1], corner[3])) > 0;
        if (
          !fold &&
          Math.abs(base - myBase) <= bimTolerance &&
          Math.abs(top - myTop) <= bimTolerance &&
          me.typeId === other.typeId &&
          me.location === other.location
        )
          out.push({ walls: [wallId, other.id], kind: 'miter' });
        continue;
      }
      if (otherThrough) out.push({ walls: [other.id, wallId], kind: 'butt', through: other.id });
      else if (meThrough) out.push({ walls: [wallId, other.id], kind: 'butt', through: wallId });
      continue;
    }
    // A T needs straight walls: an arc wall joins only at an end.
    if (me.bulge || other.bulge) continue;
    if (Math.abs(cross(unit(sub(e, s)), unit(sub(mine[1][0], mine[0][0])))) < 1e-9) continue;
    const onAxis = (a: Vec2, b: Vec2) => (p: Vec2) => {
      const u = unit(sub(b, a));
      const t = dot(sub(p, a), u);
      const off = Math.abs(dot(sub(p, a), [-u[1], u[0]]));
      return off <= bimTolerance && t > bimTolerance && t < distance(a, b) - bimTolerance;
    };
    if (mine.some(([p]) => onAxis(s, e)(p))) {
      if (otherThrough) out.push({ walls: [other.id, wallId], kind: 'butt', through: other.id });
    } else if ([s, e].some(onAxis(mine[0][0], mine[1][0])) && meThrough)
      out.push({ walls: [wallId, other.id], kind: 'butt', through: wallId });
  }
  return out;
}
