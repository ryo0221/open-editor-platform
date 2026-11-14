import type {
  LadderCoil,
  LadderDocument,
  LadderNode,
  LadderOperand,
  LadderRung,
  LadderVariable,
} from './model';
import { validateLadder, type LadderDiagnostic } from './validate';

/**
 * Editing a ladder program (docs/cad/circuit-simulation.md, SL7): pure operations on the whole
 * program, each validated as a whole, and network helpers that build the changed rung for an
 * `updateRungs` operation. The caller's trusted layer assigns every new ID.
 */

export class LadderOperationError extends Error {
  constructor(
    readonly code: string,
    readonly id?: string,
  ) {
    super(code);
  }
}
/** The program an operation would make has errors (warnings are allowed). */
export class LadderValidationError extends Error {
  constructor(readonly diagnostics: LadderDiagnostic[]) {
    super(diagnostics[0]?.code ?? 'invalid');
  }
}

export type LadderOperation =
  | { type: 'setProgram'; name?: string; scanMs?: number }
  | { type: 'insertRung'; rung: LadderRung; index: number }
  /** Replaces rungs by ID (a move between two rungs changes both at once). */
  | { type: 'updateRungs'; rungs: LadderRung[] }
  | { type: 'deleteRungs'; ids: string[] }
  | { type: 'moveRung'; id: string; index: number }
  | { type: 'insertVariable'; variable: LadderVariable; index?: number }
  /**
   * Replaces the variable `name` (compared without case). A new name renames every reference
   * to it in the rungs.
   */
  | { type: 'updateVariable'; name: string; variable: LadderVariable }
  | { type: 'deleteVariables'; names: string[] }
  /** Several operations applied together; only the end result is validated. */
  | { type: 'batch'; ops: LadderOperation[] };
export type LadderOperationType = LadderOperation['type'];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const operationLimit = 1000;
const nonEmpty = (v: unknown) => Array.isArray(v) && v.length > 0 && v.length <= operationLimit;

/** The operation's own shape, before it touches any program. */
export function assertLadderOperation(op: unknown, nested = false): asserts op is LadderOperation {
  const fail = () => {
    throw new LadderOperationError('operation');
  };
  if (!isRecord(op)) return fail();
  const keys = Object.keys(op);
  const only = (required: string[], optional: string[] = []) => {
    if (required.some((k) => !Object.hasOwn(op, k))) fail();
    if (keys.some((k) => k !== 'type' && !required.includes(k) && !optional.includes(k))) fail();
  };
  const index = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  switch (op.type) {
    case 'setProgram':
      only([], ['name', 'scanMs']);
      if (keys.length === 1) fail();
      return;
    case 'insertRung':
      only(['rung', 'index']);
      if (!isRecord(op.rung) || !index(op.index)) fail();
      return;
    case 'updateRungs':
      only(['rungs']);
      if (!nonEmpty(op.rungs) || !(op.rungs as unknown[]).every(isRecord)) fail();
      return;
    case 'deleteRungs':
      only(['ids']);
      if (!nonEmpty(op.ids) || !(op.ids as unknown[]).every((s) => typeof s === 'string')) fail();
      return;
    case 'moveRung':
      only(['id', 'index']);
      if (typeof op.id !== 'string' || !index(op.index)) fail();
      return;
    case 'insertVariable':
      only(['variable'], ['index']);
      if (!isRecord(op.variable) || (op.index !== undefined && !index(op.index))) fail();
      return;
    case 'updateVariable':
      only(['name', 'variable']);
      if (typeof op.name !== 'string' || !isRecord(op.variable)) fail();
      return;
    case 'deleteVariables':
      only(['names']);
      if (!nonEmpty(op.names) || !(op.names as unknown[]).every((s) => typeof s === 'string'))
        fail();
      return;
    case 'batch':
      only(['ops']);
      if (nested || !nonEmpty(op.ops)) fail();
      for (const o of op.ops as unknown[]) assertLadderOperation(o, true);
      return;
    default:
      fail();
  }
}

const same = (a: string, b: string) => a.toUpperCase() === b.toUpperCase();

/** Every rung element with a reference renamed from `from` to `to`. */
function renameIn(rung: LadderRung, from: string, to: string) {
  const name = (v: string) => (same(v, from) ? to : v);
  const operand = (o: LadderOperand) => {
    if ('variable' in o) o.variable = name(o.variable);
  };
  const visit = (n: LadderNode) => {
    switch (n.kind) {
      case 'contact':
        n.variable = name(n.variable);
        break;
      case 'series':
        n.items.forEach(visit);
        break;
      case 'parallel':
        n.branches.forEach(visit);
        break;
      case 'timer':
        n.instance = name(n.instance);
        break;
      case 'counter':
        n.instance = name(n.instance);
        if (n.reset !== undefined) n.reset = name(n.reset);
        break;
      case 'compare':
        operand(n.a);
        operand(n.b);
        break;
    }
  };
  visit(rung.network);
  for (const c of rung.coils) c.variable = name(c.variable);
}

function applyOne(doc: LadderDocument, op: LadderOperation) {
  const rungAt = (id: string) => {
    const i = doc.rungs.findIndex((r) => r.id === id);
    if (i < 0) throw new LadderOperationError('not-found', id);
    return i;
  };
  const variableAt = (name: string) => {
    const i = doc.variables.findIndex((v) => same(v.name, name));
    if (i < 0) throw new LadderOperationError('not-found', name);
    return i;
  };
  const clamp = (i: number, length: number) => Math.min(i, length);
  switch (op.type) {
    case 'setProgram':
      if (op.name !== undefined) doc.name = op.name;
      if (op.scanMs !== undefined) doc.scanMs = op.scanMs;
      break;
    case 'insertRung':
      doc.rungs.splice(clamp(op.index, doc.rungs.length), 0, structuredClone(op.rung));
      break;
    case 'updateRungs':
      for (const r of op.rungs) doc.rungs[rungAt(r.id)] = structuredClone(r);
      break;
    case 'deleteRungs': {
      for (const id of op.ids) rungAt(id);
      const gone = new Set(op.ids);
      doc.rungs = doc.rungs.filter((r) => !gone.has(r.id));
      break;
    }
    case 'moveRung': {
      const [r] = doc.rungs.splice(rungAt(op.id), 1);
      doc.rungs.splice(clamp(op.index, doc.rungs.length), 0, r);
      break;
    }
    case 'insertVariable':
      doc.variables.splice(
        clamp(op.index ?? doc.variables.length, doc.variables.length),
        0,
        structuredClone(op.variable),
      );
      break;
    case 'updateVariable': {
      const i = variableAt(op.name);
      const old = doc.variables[i].name;
      doc.variables[i] = structuredClone(op.variable);
      if (typeof op.variable.name === 'string' && op.variable.name !== old)
        for (const r of doc.rungs) renameIn(r, old, op.variable.name);
      break;
    }
    case 'deleteVariables': {
      for (const n of op.names) variableAt(n);
      doc.variables = doc.variables.filter((v) => !op.names.some((n) => same(n, v.name)));
      break;
    }
    case 'batch':
      for (const o of op.ops) applyOne(doc, o);
      break;
  }
}

/**
 * Applies one operation; returns a new program, or throws `LadderOperationError` (the operation)
 * or `LadderValidationError` (the program it would make has errors, such as a deleted variable
 * still in use). The input is untouched.
 */
export function applyLadderOperation(doc: LadderDocument, op: LadderOperation): LadderDocument {
  assertLadderOperation(op);
  const next = structuredClone(doc);
  applyOne(next, structuredClone(op));
  const errors = validateLadder(next).filter((d) => d.severity === 'error');
  if (errors.length) throw new LadderValidationError(errors);
  return next;
}

/** Every rung, node and coil ID in the program. */
export function ladderIds(doc: LadderDocument): Set<string> {
  const ids = new Set<string>();
  const visit = (n: LadderNode) => {
    ids.add(n.id);
    if (n.kind === 'series') n.items.forEach(visit);
    else if (n.kind === 'parallel') n.branches.forEach(visit);
  };
  for (const r of doc.rungs) {
    ids.add(r.id);
    visit(r.network);
    for (const c of r.coils) ids.add(c.id);
  }
  return ids;
}

/**
 * A new ID `prefix-<12 random hex digits>` that neither the program nor `taken` uses. Random,
 * not the lowest free number, so a deleted element's ID is never handed out again.
 */
export function ladderNewId(
  doc: LadderDocument,
  prefix: string,
  taken: ReadonlySet<string> = new Set(),
  random: () => string = () => crypto.randomUUID(),
): string {
  const used = ladderIds(doc);
  for (;;) {
    const id = `${prefix}-${random().replace(/-/g, '').slice(0, 12)}`;
    if (!used.has(id) && !taken.has(id)) return id;
  }
}

// Network helpers. Each returns a new, normalized rung; the given one is untouched.

type Container = Extract<LadderNode, { kind: 'series' | 'parallel' }>;
const children = (c: Container) => (c.kind === 'series' ? c.items : c.branches);
interface Found {
  node: LadderNode;
  parent?: Container;
  index: number;
}
function find(root: LadderNode, id: string): Found | undefined {
  if (root.id === id) return { node: root, index: -1 };
  const walk = (c: Container): Found | undefined => {
    const list = children(c);
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (n.id === id) return { node: n, parent: c, index: i };
      if (n.kind === 'series' || n.kind === 'parallel') {
        const f = walk(n);
        if (f) return f;
      }
    }
    return undefined;
  };
  return root.kind === 'series' || root.kind === 'parallel' ? walk(root) : undefined;
}
function put(rung: LadderRung, f: Found, node: LadderNode) {
  if (f.parent) children(f.parent)[f.index] = node;
  else rung.network = node;
}
const contains = (n: LadderNode, id: string): boolean =>
  n.id === id ||
  (n.kind === 'series' && n.items.some((c) => contains(c, id))) ||
  (n.kind === 'parallel' && n.branches.some((c) => contains(c, id)));

/**
 * Flattens a series in a series and a parallel in a parallel, and replaces a series of one item
 * (except the network itself) and a parallel of one branch by that item.
 */
export function ladderNormalize(node: LadderNode, root = true): LadderNode {
  if (node.kind === 'series') {
    const items = node.items
      .map((c) => ladderNormalize(c, false))
      .flatMap((c) => (c.kind === 'series' && c.items.length > 0 ? c.items : [c]))
      // An empty series in a series is nothing (a bypass is an empty series in a parallel).
      .filter((c) => !(c.kind === 'series' && c.items.length === 0));
    if (!root && items.length === 1) return items[0];
    return { ...node, items };
  }
  if (node.kind === 'parallel') {
    const branches = node.branches
      .map((c) => ladderNormalize(c, false))
      .flatMap((c) => (c.kind === 'parallel' ? c.branches : [c]));
    if (branches.length === 0) return { id: node.id, kind: 'series', items: [] };
    if (branches.length === 1) return root ? ladderNormalize(branches[0], true) : branches[0];
    return { ...node, branches };
  }
  return node;
}
const normalized = (rung: LadderRung): LadderRung => ({
  ...rung,
  network: ladderNormalize(rung.network),
});

function insertSeries(
  rung: LadderRung,
  targetId: string,
  side: 'before' | 'after',
  node: LadderNode,
  newId: () => string,
) {
  const f = find(rung.network, targetId);
  if (!f) throw new LadderOperationError('not-found', targetId);
  const t = f.node;
  if (t.kind === 'series' && (t.items.length === 0 || !f.parent)) {
    // The rail of an empty rung, or the whole network: at its start or end.
    if (side === 'after') t.items.push(node);
    else t.items.unshift(node);
  } else if (f.parent?.kind === 'series') {
    f.parent.items.splice(f.index + (side === 'after' ? 1 : 0), 0, node);
  } else {
    put(rung, f, { id: newId(), kind: 'series', items: side === 'after' ? [t, node] : [node, t] });
  }
}

/**
 * Inserts `node` in series before or after the element `targetId`. On the network itself (the
 * rung's root series, or an empty rung's rail) it goes at the start or the end of the rung.
 * `newId` names a series made to hold the two.
 */
export function ladderInsertSeries(
  rung: LadderRung,
  targetId: string,
  side: 'before' | 'after',
  node: LadderNode,
  newId: () => string,
): LadderRung {
  const r = structuredClone(rung);
  insertSeries(r, targetId, side, structuredClone(node), newId);
  return normalized(r);
}

/**
 * Puts `node` in parallel with the element `targetId` (a new branch below it). `newId` names a
 * parallel made to hold the two. The rail of an empty rung takes no branch (`branch-target`).
 */
export function ladderAddBranch(
  rung: LadderRung,
  targetId: string,
  node: LadderNode,
  newId: () => string,
): LadderRung {
  const r = structuredClone(rung);
  const f = find(r.network, targetId);
  if (!f) throw new LadderOperationError('not-found', targetId);
  if (f.node.kind === 'series' && f.node.items.length === 0)
    throw new LadderOperationError('branch-target', targetId);
  if (f.parent?.kind === 'parallel')
    f.parent.branches.splice(f.index + 1, 0, structuredClone(node));
  else put(r, f, { id: newId(), kind: 'parallel', branches: [f.node, structuredClone(node)] });
  return normalized(r);
}

/**
 * Removes the element or coil `id` (with everything inside it). The network itself becomes the
 * empty rail; `newId` names that rail when the network was not a series.
 */
export function ladderRemove(rung: LadderRung, id: string, newId: () => string): LadderRung {
  const r = structuredClone(rung);
  const coil = r.coils.findIndex((c) => c.id === id);
  if (coil >= 0) {
    r.coils.splice(coil, 1);
    return r;
  }
  const f = find(r.network, id);
  if (!f) throw new LadderOperationError('not-found', id);
  if (!f.parent)
    r.network = { id: f.node.kind === 'series' ? f.node.id : newId(), kind: 'series', items: [] };
  else children(f.parent).splice(f.index, 1);
  return normalized(r);
}

/** The element `id` with everything inside it (a copy), or undefined. */
export function ladderNode(rung: LadderRung, id: string): LadderNode | undefined {
  const f = find(rung.network, id);
  return f && structuredClone(f.node);
}

/**
 * Moves the element `id` in series before or after `targetId` in the same rung. Refused
 * (`move-into-self`) when the target is the element or inside it.
 */
export function ladderMove(
  rung: LadderRung,
  id: string,
  targetId: string,
  side: 'before' | 'after',
  newId: () => string,
): LadderRung {
  const r = structuredClone(rung);
  const f = find(r.network, id);
  if (!f) throw new LadderOperationError('not-found', id);
  if (!f.parent) throw new LadderOperationError('move-into-self', id);
  if (contains(f.node, targetId)) throw new LadderOperationError('move-into-self', targetId);
  // Leave a placeholder where it was, so the target and the indices stay as they are.
  const hole: LadderNode = { id: '\u0000moving', kind: 'series', items: [] };
  children(f.parent)[f.index] = hole;
  insertSeries(r, targetId, side, f.node, newId);
  const h = find(r.network, hole.id)!;
  children(h.parent!).splice(h.index, 1);
  return normalized(r);
}

/** Replaces the leaf element (contact, timer, counter, compare) or coil with the same ID. */
export function ladderReplace(rung: LadderRung, element: LadderNode | LadderCoil): LadderRung {
  const r = structuredClone(rung);
  if (!('kind' in element)) {
    const i = r.coils.findIndex((c) => c.id === element.id);
    if (i < 0) throw new LadderOperationError('not-found', element.id);
    r.coils[i] = structuredClone(element);
    return r;
  }
  if (element.kind === 'series' || element.kind === 'parallel')
    throw new LadderOperationError('not-leaf', element.id);
  const f = find(r.network, element.id);
  if (!f) throw new LadderOperationError('not-found', element.id);
  if (f.node.kind === 'series' || f.node.kind === 'parallel')
    throw new LadderOperationError('not-leaf', element.id);
  put(r, f, structuredClone(element));
  return r;
}
