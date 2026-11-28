import { canonicalJson } from '@editor-platform/artifact-core';
import { owdElementKinds, owdElements, type OwdElementRef } from './ids';
import { type OwdDefinition } from './types';

export interface WorkflowDefinitionChange {
  /** Absent for a field of the definition itself. */
  target?: OwdElementRef;
  field?: string;
  change: 'added' | 'removed' | 'changed' | 'moved';
}
/**
 * What changed from `before` (the current version) to `after` (the draft), by element ID: added,
 * removed, changed (any field) and moved (same content, another place in its list). Definition
 * fields are listed by name; fields this Editor does not edit count as changed too.
 */
export function workflowDefinitionDiff(
  before: OwdDefinition,
  after: OwdDefinition,
): WorkflowDefinitionChange[] {
  const out: WorkflowDefinitionChange[] = [];
  const lists = new Set<string>(
    owdElementKinds.map(
      (k) =>
        ({
          phase: 'phases',
          section: 'sections',
          deliverable: 'deliverables',
          acceptance: 'acceptance',
          role: 'roles',
          item: 'items',
          rule: 'rules',
        })[k],
    ),
  );
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)]))
    if (!lists.has(key) && canonicalJson(before[key] ?? null) !== canonicalJson(after[key] ?? null))
      out.push({
        field: key,
        change:
          before[key] === undefined ? 'added' : after[key] === undefined ? 'removed' : 'changed',
      });
  for (const kind of owdElementKinds) {
    const a = owdElements(before, kind),
      b = owdElements(after, kind);
    const ids = (l: typeof a) => l.map((e) => e.id as string);
    const beforeIds = ids(a),
      afterIds = ids(b);
    for (const id of beforeIds)
      if (!afterIds.includes(id)) out.push({ target: { kind, id }, change: 'removed' });
    const kept = afterIds.filter((id) => beforeIds.includes(id));
    const order = beforeIds.filter((id) => afterIds.includes(id));
    for (const [index, id] of afterIds.entries()) {
      const old = a.find((e) => e.id === id),
        now = b[index];
      if (!old) out.push({ target: { kind, id }, change: 'added' });
      else if (canonicalJson(old) !== canonicalJson(now))
        out.push({ target: { kind, id }, change: 'changed' });
      else if (kept.indexOf(id) !== order.indexOf(id))
        out.push({ target: { kind, id }, change: 'moved' });
    }
  }
  return out;
}
