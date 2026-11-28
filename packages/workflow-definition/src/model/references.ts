import { owdElements, type OwdElementKind, type OwdElementRef } from './ids';
import { type OwdDefinition, type OwdJson, type OwdRecord } from './types';

/** One reference from an element's field to another element. */
export interface OwdReference {
  owner: OwdElementRef;
  /** JSON path inside the owner, such as `['after', 0]` or `['approvers', 'roles', 1]`. */
  path: (string | number)[];
  target: OwdElementRef;
}
/**
 * Visits each reference. `edit` returns the ID to write, `null` to remove the reference (an entry
 * of a list, or an optional single field), or `undefined` to keep it. Lists are compacted after.
 */
type Edit = (reference: OwdReference) => string | null | undefined;
const isRecord = (v: unknown): v is OwdRecord => !!v && typeof v === 'object' && !Array.isArray(v);

function list(
  owner: OwdElementRef,
  record: OwdRecord,
  path: string[],
  target: OwdElementKind,
  edit: Edit,
) {
  let parent: OwdRecord = record;
  for (const key of path.slice(0, -1)) {
    const next = parent[key];
    if (!isRecord(next)) return;
    parent = next;
  }
  const key = path[path.length - 1],
    values = parent[key];
  if (!Array.isArray(values)) return;
  const kept: OwdJson[] = [];
  values.forEach((value, index) => {
    if (typeof value !== 'string' || value === '') return void kept.push(value);
    const next = edit({ owner, path: [...path, index], target: { kind: target, id: value } });
    if (next !== null) kept.push(next ?? value);
  });
  if (kept.length !== values.length || kept.some((v, i) => v !== values[i])) parent[key] = kept;
}
function single(
  owner: OwdElementRef,
  record: OwdRecord,
  key: string,
  target: OwdElementKind,
  edit: Edit,
) {
  const value = record[key];
  // An empty value is an unset reference (an incomplete draft), not a reference to nothing.
  if (typeof value !== 'string' || value === '') return;
  const next = edit({ owner, path: [key], target: { kind: target, id: value } });
  if (next === null) delete record[key];
  else if (next !== undefined) record[key] = next;
}
function outline(owner: OwdElementRef, entries: OwdJson, path: (string | number)[], edit: Edit) {
  if (!Array.isArray(entries)) return;
  entries.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    const at = [...path, index];
    if (typeof entry.item === 'string' && entry.item) {
      const next = edit({ owner, path: [...at, 'item'], target: { kind: 'item', id: entry.item } });
      if (next === null) delete entry.item;
      else if (next !== undefined) entry.item = next;
    }
    outline(owner, entry.children, [...at, 'children'], edit);
  });
}
/** A graph view names item kinds in lists; the other views in one field each. */
const viewLists = ['nodes', 'edges', 'sections'];
/**
 * References from a deliverable's `view` (one view or a list) to item kinds. A view that loses an
 * item kind it needs (a single field, or every node of a graph) is removed with it; an emptied
 * list of views removes the field.
 */
function views(owner: OwdElementRef, record: OwdRecord, edit: Edit) {
  const value = record.view;
  const many = Array.isArray(value);
  const list = (many ? value : [value]) as OwdJson[];
  if (!list.some(isRecord)) return;
  const kept = list.filter((view, index) => {
    if (!isRecord(view)) return true;
    const at: (string | number)[] = many ? ['view', index] : ['view'];
    // The graph view's `edges` are a field name in a table view; only read lists for a graph.
    const keys = view.as === 'graph' ? [] : view.as === 'matrix' ? ['rows', 'columns'] : ['items'];
    for (const key of keys) {
      const id = view[key];
      if (typeof id !== 'string' || id === '') continue;
      const next = edit({ owner, path: [...at, key], target: { kind: 'item', id } });
      if (next === null) return false;
      if (next !== undefined) view[key] = next;
    }
    if (view.as === 'graph')
      for (const key of viewLists) {
        const ids = view[key];
        if (!Array.isArray(ids)) continue;
        const after: OwdJson[] = [];
        ids.forEach((id, i) => {
          if (typeof id !== 'string' || id === '') return void after.push(id);
          const next = edit({ owner, path: [...at, key, i], target: { kind: 'item', id } });
          if (next !== null) after.push(next ?? id);
        });
        if (after.length !== ids.length || after.some((v, i) => v !== ids[i])) view[key] = after;
        if (key === 'nodes' && !after.length) return false;
      }
    return true;
  });
  if (kept.length === list.length) return;
  if (!kept.length) delete record.view;
  else record.view = many ? kept : kept[0];
}
/**
 * Walks every reference of the definition in a fixed order. With an `edit`, the definition is
 * changed in place, so callers pass a clone.
 */
export function walkOwdReferences(definition: OwdDefinition, edit: Edit) {
  const each = (kind: OwdElementKind, visit: (owner: OwdElementRef, record: OwdRecord) => void) => {
    for (const record of owdElements(definition, kind))
      if (isRecord(record) && typeof record.id === 'string') visit({ kind, id: record.id }, record);
  };
  each('phase', (owner, r) => {
    list(owner, r, ['after'], 'phase', edit);
    list(owner, r, ['deliverables'], 'deliverable', edit);
    list(owner, r, ['acceptance'], 'acceptance', edit);
  });
  each('section', (owner, r) => list(owner, r, ['phases'], 'phase', edit));
  each('deliverable', (owner, r) => {
    list(owner, r, ['uses'], 'deliverable', edit);
    outline(owner, r.outline, ['outline'], edit);
    views(owner, r, edit);
  });
  each('acceptance', (owner, r) => {
    single(owner, r, 'target', 'deliverable', edit);
    list(owner, r, ['rules'], 'rule', edit);
    list(owner, r, ['approvers', 'roles'], 'role', edit);
  });
  each('item', (owner, r) => single(owner, r, 'parent', 'item', edit));
  each('rule', (owner, r) => {
    single(owner, r, 'from', 'item', edit);
    list(owner, r, ['to'], 'item', edit);
    single(owner, r, 'of', 'item', edit);
    list(owner, r, ['by'], 'item', edit);
  });
}
export function owdReferences(definition: OwdDefinition): OwdReference[] {
  const out: OwdReference[] = [];
  walkOwdReferences(definition, (reference) => void out.push(reference));
  return out;
}
/** References that point at `target`. */
export const owdReferrers = (definition: OwdDefinition, target: OwdElementRef) =>
  owdReferences(definition).filter(
    (r) => r.target.kind === target.kind && r.target.id === target.id,
  );
/**
 * References from the parts the Editor shows read only: `gates[].phases`,
 * `placements[].gates[].phases` and the deliverable keys of `placements[].paths`. A rename or a
 * delete follows them so that it never leaves them dangling. `edit` works as in
 * {@link walkOwdReferences}; a gate left with no phases is removed (an empty list would widen it to
 * every phase), and a removed path key goes with its path.
 */
export function walkOwdGateReferences(
  definition: OwdDefinition,
  edit: (target: OwdElementRef) => string | null | undefined,
) {
  const gates = (holder: OwdRecord, key: string) => {
    const values = holder[key];
    if (!Array.isArray(values)) return;
    const kept = values.filter((gate) => {
      if (!isRecord(gate) || !Array.isArray(gate.phases)) return true;
      const before = gate.phases;
      if (!before.length) return true;
      const after: OwdJson[] = [];
      for (const id of before) {
        if (typeof id !== 'string' || id === '') {
          after.push(id);
          continue;
        }
        const next = edit({ kind: 'phase', id });
        if (next !== null) after.push(next ?? id);
      }
      if (after.length !== before.length || after.some((v, i) => v !== before[i]))
        gate.phases = after;
      return after.length > 0;
    });
    if (kept.length !== values.length) holder[key] = kept;
  };
  gates(definition as OwdRecord, 'gates');
  const placements = definition.placements;
  if (!Array.isArray(placements)) return;
  for (const placement of placements) {
    if (!isRecord(placement)) continue;
    gates(placement, 'gates');
    const paths = placement.paths;
    if (!isRecord(paths)) continue;
    const entries = Object.entries(paths);
    let changed = false;
    const next: OwdRecord = {};
    for (const [id, path] of entries) {
      const to = id === '' ? undefined : edit({ kind: 'deliverable', id });
      if (to === null) changed = true;
      else {
        if (to !== undefined && to !== id) changed = true;
        next[to ?? id] = path;
      }
    }
    // Rebuilt in the same key order, so a rename does not move the entry.
    if (changed) placement.paths = next;
  }
}
