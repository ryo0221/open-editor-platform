import { canonicalJson } from '@editor-platform/artifact-core';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import type { PcbBoard, PcbDocument, PcbNet } from './model';
import { assertPcb, pcbId, record } from './validation';

export const pcbContentHash = (doc: PcbDocument) =>
  bytesToHex(sha256(new TextEncoder().encode(canonicalJson(doc))));

/** The collections of entities with IDs. */
export const pcbCollections = [
  'holes',
  'footprints',
  'components',
  'netClasses',
  'nets',
  'tracks',
  'vias',
  'zones',
  'stack',
] as const;
export type PcbCollection = (typeof pcbCollections)[number];
type Entity = PcbDocument[PcbCollection][number];

/**
 * Pure, atomic operations. The caller's trusted layer assigns every new ID before the operation
 * is built. Each result is validated as a whole; any problem leaves the input untouched.
 */
export type PcbOperation =
  | { type: 'insert'; entities: Partial<{ [K in PcbCollection]: PcbDocument[K] }> }
  /** Replaces one entity by ID. */
  | { type: 'update'; collection: PcbCollection; entity: Entity }
  /** Replaces several entities of one collection by ID, as one edit (moving a selection). */
  | { type: 'updateMany'; collection: PcbCollection; entities: Entity[] }
  | { type: 'delete'; ids: string[] }
  /** Replaces the board (outline, cut-outs, stack and finish) as a whole. */
  | { type: 'setBoard'; board: PcbBoard }
  /** Replaces every net at once (a net list imported or edited as a table). */
  | { type: 'setNets'; nets: PcbNet[] };
export type PcbOperationType = PcbOperation['type'];

export class PcbOperationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const operationLimit = 10_000;
/** The operation's own shape, before it touches any content. */
export function assertPcbOperation(op: unknown): asserts op is PcbOperation {
  if (!record(op)) throw new PcbOperationError('operation');
  const keys = Object.keys(op).sort().join(',');
  switch (op.type) {
    case 'insert': {
      if (keys !== 'entities,type' || !record(op.entities))
        throw new PcbOperationError('operation');
      let count = 0;
      for (const [k, v] of Object.entries(op.entities)) {
        if (!(pcbCollections as readonly string[]).includes(k) || !Array.isArray(v))
          throw new PcbOperationError('operation');
        count += v.length;
      }
      if (count === 0) throw new PcbOperationError('operation-empty');
      if (count > operationLimit) throw new PcbOperationError('limit-count');
      return;
    }
    case 'update':
      if (
        keys !== 'collection,entity,type' ||
        !(pcbCollections as readonly unknown[]).includes(op.collection) ||
        !record(op.entity) ||
        !pcbId(op.entity.id)
      )
        throw new PcbOperationError('operation');
      return;
    case 'updateMany':
      if (
        keys !== 'collection,entities,type' ||
        !(pcbCollections as readonly unknown[]).includes(op.collection) ||
        !Array.isArray(op.entities) ||
        op.entities.length === 0 ||
        op.entities.length > operationLimit ||
        !op.entities.every((e) => record(e) && pcbId(e.id)) ||
        new Set(op.entities.map((e) => (e as Entity).id)).size !== op.entities.length
      )
        throw new PcbOperationError('operation');
      return;
    case 'delete':
      if (
        keys !== 'ids,type' ||
        !Array.isArray(op.ids) ||
        op.ids.length === 0 ||
        op.ids.length > operationLimit ||
        !op.ids.every(pcbId)
      )
        throw new PcbOperationError('operation');
      return;
    case 'setBoard':
      if (keys !== 'board,type' || !record(op.board)) throw new PcbOperationError('operation');
      return;
    case 'setNets':
      if (keys !== 'nets,type' || !Array.isArray(op.nets) || op.nets.length > operationLimit)
        throw new PcbOperationError('operation');
      return;
    default:
      throw new PcbOperationError('operation');
  }
}

/** Applies one operation; returns a new, validated document or throws. The input is untouched. */
export function applyPcbOperation(doc: PcbDocument, op: PcbOperation): PcbDocument {
  const next = applyUnvalidated(doc, op);
  assertPcb(next);
  return next;
}

/**
 * Applies several operations as one: each operation's own checks run (shape, `not-found`,
 * `in-use`), and the result is validated as a whole once at the end, so a step may pass through
 * a state no single edit would leave (one footprint more than the limit while a part changes
 * footprints). Returns a new document or throws; the input is untouched.
 */
export function applyPcbOperations(doc: PcbDocument, ops: readonly PcbOperation[]): PcbDocument {
  if (ops.length === 0) throw new PcbOperationError('operation-empty');
  const next = ops.reduce(applyUnvalidated, doc);
  assertPcb(next);
  return next;
}

function applyUnvalidated(doc: PcbDocument, op: PcbOperation): PcbDocument {
  assertPcbOperation(op);
  const next = structuredClone(doc);
  switch (op.type) {
    case 'insert':
      for (const k of pcbCollections) {
        const add = op.entities[k];
        if (add) (next[k] as Entity[]).push(...structuredClone(add));
      }
      break;
    case 'update': {
      const list = next[op.collection] as Entity[];
      const i = list.findIndex((e) => e.id === op.entity.id);
      if (i < 0) throw new PcbOperationError('not-found');
      list[i] = structuredClone(op.entity);
      break;
    }
    case 'updateMany': {
      const list = next[op.collection] as Entity[];
      for (const entity of op.entities) {
        const i = list.findIndex((e) => e.id === entity.id);
        if (i < 0) throw new PcbOperationError('not-found');
        list[i] = structuredClone(entity);
      }
      break;
    }
    case 'delete': {
      const gone = new Set(op.ids);
      const known = new Set(pcbCollections.flatMap((k) => next[k].map((e) => e.id)));
      if (op.ids.some((id) => !known.has(id))) throw new PcbOperationError('not-found');
      // A footprint stays while a part that is not deleted with it uses it.
      if (next.components.some((c) => !gone.has(c.id) && gone.has(c.footprint)))
        throw new PcbOperationError('in-use');
      // So does a net class while a net that stays names it.
      if (next.nets.some((n) => !gone.has(n.id) && gone.has(n.class)))
        throw new PcbOperationError('in-use');
      // So does a net while copper (tracks, vias, zones) that stays carries it.
      if (
        [...next.tracks, ...next.vias, ...next.zones].some(
          (t) => !gone.has(t.id) && gone.has(t.net),
        )
      )
        throw new PcbOperationError('in-use');
      // A deleted part leaves the nets it was in.
      for (const n of next.nets) n.pins = n.pins.filter(([c]) => !gone.has(c));
      for (const k of pcbCollections)
        (next[k] as Entity[]) = (next[k] as Entity[]).filter((e) => !gone.has(e.id));
      break;
    }
    case 'setBoard':
      next.board = structuredClone(op.board);
      break;
    case 'setNets':
      next.nets = structuredClone(op.nets);
      break;
  }
  return next;
}
