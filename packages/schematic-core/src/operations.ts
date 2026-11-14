import { canonicalJson } from '@editor-platform/artifact-core';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import {
  fromGrid,
  gridKey,
  onGrid,
  partGridPoint,
  simplifyWire,
  toGrid,
  type GridPoint,
} from './geometry';
import type { SchematicDocument, SchematicSheet, Vec2 } from './model';
import { schematicNets } from './nets';
import { assertSchematic, isRecord, schematicId } from './validation';

export const schematicContentHash = (doc: SchematicDocument) =>
  bytesToHex(sha256(new TextEncoder().encode(canonicalJson(doc))));

/** The collections of entities with IDs. */
export const schematicCollections = [
  'symbols',
  'parts',
  'wires',
  'junctions',
  'labels',
  'powers',
] as const;
export type SchematicCollection = (typeof schematicCollections)[number];
type Entity = SchematicDocument[SchematicCollection][number];

/**
 * Pure, atomic operations. The caller's trusted layer assigns every new ID before the operation
 * is built. Each result is validated as a whole; any problem leaves the input untouched.
 */
export type SchematicOperation =
  | {
      type: 'insert';
      entities: Partial<{ [K in SchematicCollection]: SchematicDocument[K] }>;
    }
  /** Replaces one entity by ID. */
  | { type: 'update'; collection: SchematicCollection; entity: Entity }
  | { type: 'delete'; ids: string[] }
  | { type: 'setSheet'; sheet: SchematicSheet }
  /**
   * Moves parts, labels, power ports, junctions and whole wires by `delta` (on the grid). The
   * wires that end on a moved item follow it: their end moves and a corner keeps them square.
   * A move never changes which pins are connected (a dragged wire that slides past a junction,
   * a pin dropped on another wire): such a move is refused with `move-changes-nets`; connect or
   * disconnect by drawing or deleting wires instead. Net names may change (a moved label).
   */
  | { type: 'move'; ids: string[]; delta: Vec2 };
export type SchematicOperationType = SchematicOperation['type'];

export class SchematicOperationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const operationLimit = 10_000;
/** The operation's own shape, before it touches any content. */
export function assertSchematicOperation(op: unknown): asserts op is SchematicOperation {
  if (!isRecord(op)) throw new SchematicOperationError('operation');
  const keys = Object.keys(op).sort().join(',');
  const ids = (v: unknown) =>
    Array.isArray(v) && v.length > 0 && v.length <= operationLimit && v.every(schematicId);
  switch (op.type) {
    case 'insert': {
      if (keys !== 'entities,type' || !isRecord(op.entities))
        throw new SchematicOperationError('operation');
      let count = 0;
      for (const [k, v] of Object.entries(op.entities)) {
        if (!(schematicCollections as readonly string[]).includes(k) || !Array.isArray(v))
          throw new SchematicOperationError('operation');
        count += v.length;
      }
      if (count === 0) throw new SchematicOperationError('operation-empty');
      if (count > operationLimit) throw new SchematicOperationError('limit-count');
      return;
    }
    case 'update':
      if (
        keys !== 'collection,entity,type' ||
        !(schematicCollections as readonly unknown[]).includes(op.collection) ||
        !isRecord(op.entity) ||
        !schematicId(op.entity.id)
      )
        throw new SchematicOperationError('operation');
      return;
    case 'delete':
      if (keys !== 'ids,type' || !ids(op.ids)) throw new SchematicOperationError('operation');
      return;
    case 'setSheet':
      if (keys !== 'sheet,type' || !isRecord(op.sheet))
        throw new SchematicOperationError('operation');
      return;
    case 'move': {
      const d = op.delta;
      if (
        keys !== 'delta,ids,type' ||
        !ids(op.ids) ||
        !Array.isArray(d) ||
        d.length !== 2 ||
        !d.every((v) => typeof v === 'number' && Number.isFinite(v))
      )
        throw new SchematicOperationError('operation');
      if (!onGrid(d[0]) || !onGrid(d[1])) throw new SchematicOperationError('grid-off');
      return;
    }
    default:
      throw new SchematicOperationError('operation');
  }
}

/** Every pin end of `part` on the sheet, in grid steps. */
function partEnds(doc: SchematicDocument, partId: string): GridPoint[] {
  const part = doc.parts.find((p) => p.id === partId);
  const symbol = part && doc.symbols.find((s) => s.id === part.symbol);
  if (!part || !symbol) return [];
  return symbol.pins.map((pin) => partGridPoint(part, toGrid(pin.at)));
}

/**
 * Moves the items `ids` by `delta` (see the `move` operation). Returns a new document, not yet
 * validated; a wire that shrinks to one point is removed.
 */
export function schematicMove(
  doc: SchematicDocument,
  ids: readonly string[],
  delta: Vec2,
): SchematicDocument {
  const next = structuredClone(doc);
  const moved = new Set(ids);
  const known = new Set(
    [...doc.parts, ...doc.wires, ...doc.labels, ...doc.powers, ...doc.junctions].map((e) => e.id),
  );
  if (ids.some((id) => !known.has(id))) throw new SchematicOperationError('not-found');
  const d = toGrid(delta);
  if (d[0] === 0 && d[1] === 0) return next;
  const shift = (p: Vec2): Vec2 => {
    const g = toGrid(p);
    return fromGrid([g[0] + d[0], g[1] + d[1]]);
  };
  // The points that move: pin ends of moved parts and the points of moved small items.
  const from = new Set<string>();
  for (const id of ids) for (const e of partEnds(doc, id)) from.add(gridKey(e));
  for (const x of [...doc.labels, ...doc.powers, ...doc.junctions])
    if (moved.has(x.id)) from.add(gridKey(toGrid(x.at)));
  for (const p of next.parts) if (moved.has(p.id)) p.at = shift(p.at);
  for (const x of [...next.labels, ...next.powers, ...next.junctions])
    if (moved.has(x.id)) x.at = shift(x.at);
  next.wires = next.wires.flatMap((w) => {
    if (moved.has(w.id)) return [{ ...w, points: w.points.map(shift) }];
    let g = w.points.map(toGrid);
    const last = g.length - 1;
    const startMoves = from.has(gridKey(g[0]));
    const endMoves = from.has(gridKey(g[last]));
    if (!startMoves && !endMoves) return [w];
    if (startMoves && endMoves && g.length === 2) return [{ ...w, points: w.points.map(shift) }];
    const follow = (pts: GridPoint[]): GridPoint[] => {
      // pts[0] moves; the first segment keeps its direction (a slid or a new corner).
      const [e, n] = [pts[0], pts[1]];
      const m: GridPoint = [e[0] + d[0], e[1] + d[1]];
      if (m[0] === n[0] || m[1] === n[1]) return [m, ...pts.slice(1)];
      const horizontal = e[1] === n[1];
      const after = pts[2];
      // The next segment turns: slide its corner along it, so the wire keeps its shape.
      if (after && (horizontal ? after[0] === n[0] : after[1] === n[1])) {
        const slid: GridPoint = horizontal ? [n[0], m[1]] : [m[0], n[1]];
        return [m, slid, ...pts.slice(2)];
      }
      const corner: GridPoint = horizontal ? [m[0], n[1]] : [n[0], m[1]];
      return [m, corner, ...pts.slice(1)];
    };
    if (startMoves) g = follow(g);
    if (endMoves) g = follow([...g].reverse()).reverse();
    const s = simplifyWire(g);
    return s.length < 2 ? [] : [{ ...w, points: s.map(fromGrid) }];
  });
  return next;
}

/** Which pins are connected to which, as one comparable string (names left out). */
const pinGroups = (doc: SchematicDocument) =>
  schematicNets(doc)
    .map((n) =>
      n.pins
        .map(([part, pin]) => `${part}\u0000${pin}`)
        .sort()
        .join('\u0001'),
    )
    .sort()
    .join('\u0002');

/** Applies one operation; returns a new, validated document or throws. The input is untouched. */
export function applySchematicOperation(
  doc: SchematicDocument,
  op: SchematicOperation,
): SchematicDocument {
  assertSchematicOperation(op);
  let next = structuredClone(doc);
  switch (op.type) {
    case 'insert':
      for (const k of schematicCollections) {
        const add = op.entities[k];
        if (add) (next[k] as Entity[]).push(...structuredClone(add));
      }
      break;
    case 'update': {
      const list = next[op.collection] as Entity[];
      const i = list.findIndex((e) => e.id === op.entity.id);
      if (i < 0) throw new SchematicOperationError('not-found');
      list[i] = structuredClone(op.entity);
      break;
    }
    case 'delete': {
      const gone = new Set(op.ids);
      const known = new Set(schematicCollections.flatMap((k) => next[k].map((e) => e.id)));
      if (op.ids.some((id) => !known.has(id))) throw new SchematicOperationError('not-found');
      for (const k of schematicCollections)
        (next[k] as Entity[]) = (next[k] as Entity[]).filter((e) => !gone.has(e.id));
      break;
    }
    case 'setSheet':
      next.sheet = structuredClone(op.sheet);
      break;
    case 'move':
      next = schematicMove(next, op.ids, op.delta);
      if (pinGroups(next) !== pinGroups(doc))
        throw new SchematicOperationError('move-changes-nets');
      break;
  }
  assertSchematic(next);
  return next;
}
