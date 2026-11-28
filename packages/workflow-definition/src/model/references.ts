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
