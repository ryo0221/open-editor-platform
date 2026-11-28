import {
  owdElementKinds,
  owdElements,
  owdNamespace,
  validOwdId,
  findOwdElement,
  type OwdElementRef,
} from './ids';
import { owdReferences } from './references';
import { type OwdDefinition, type OwdRecord } from './types';

export interface WorkflowDefinitionDiagnostic {
  /** The element it is about; absent for the definition as a whole. */
  target?: OwdElementRef;
  /** Field path inside the element (or the definition), when known. */
  path: (string | number)[];
  code: string;
  /** Stable parameters; Hosts choose the presentation language. */
  args?: Record<string, string | number>;
  message: string;
  /** `structure`: this Editor's own checks. `check`: the Host's injected OWD `check`. */
  source: 'structure' | 'check';
  /**
   * Structure problems are blocking: an edit may not add one (existing ones stay and can be fixed).
   * Everything else, including every `check` result and cycles, is an incomplete draft.
   */
  blocking: boolean;
}
const at = (target: OwdElementRef | undefined, path: (string | number)[]) =>
  `${target ? `${target.kind}:${target.id}` : 'definition'}/${path.join('/')}`;

/**
 * A key that names the same problem in two versions of a definition (for "new problem" checks).
 * List indices are left out, so a problem keeps its key when an entry before it is removed or
 * moved; compare keys with their counts (see {@link newDiagnostic}).
 */
export const diagnosticKey = (d: WorkflowDefinitionDiagnostic) =>
  `${d.code}|${at(
    d.target,
    d.path.map((p) => (typeof p === 'number' ? '*' : p)),
  )}|${JSON.stringify(d.args ?? {})}`;
/** The first problem of `after` that `before` did not have, counting repeated keys. */
export function newDiagnostic(
  before: readonly WorkflowDefinitionDiagnostic[],
  after: readonly WorkflowDefinitionDiagnostic[],
) {
  const had = new Map<string, number>();
  for (const d of before) had.set(diagnosticKey(d), (had.get(diagnosticKey(d)) ?? 0) + 1);
  for (const d of after) {
    const key = diagnosticKey(d),
      left = had.get(key) ?? 0;
    if (!left) return d;
    had.set(key, left - 1);
  }
  return undefined;
}

const isString = (v: unknown) => typeof v === 'string';
/** Fields of each kind that must be strings (when present, for optional ones). */
const stringFields: Record<string, { required: string[]; optional: string[] }> = {
  phase: { required: ['name', 'purpose'], optional: ['icon'] },
  section: { required: ['name'], optional: ['icon'] },
  deliverable: { required: ['name', 'form'], optional: [] },
  acceptance: { required: ['text'], optional: [] },
  role: { required: ['name'], optional: ['text'] },
  item: { required: ['name', 'idForm'], optional: [] },
  rule: { required: [], optional: [] },
};

function outlineProblems(
  target: OwdElementRef,
  entries: unknown,
  path: (string | number)[],
  depth: number,
  out: WorkflowDefinitionDiagnostic[],
) {
  if (!Array.isArray(entries)) return;
  if (depth > 4)
    out.push({
      target,
      path,
      code: 'outline-depth',
      message: `Deliverable ${target.id}: headings nest more than 4 levels`,
      source: 'structure',
      blocking: true,
    });
  entries.forEach((entry, i) => {
    const p = [...path, i];
    const e = entry as OwdRecord;
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      !isString(e.heading) ||
      !isString(e.describe) ||
      (e.repeat !== undefined && e.repeat !== true) ||
      (e.children !== undefined && !Array.isArray(e.children))
    )
      out.push({
        target,
        path: p,
        code: 'outline-entry',
        message: `Deliverable ${target.id}: a heading needs text heading and describe`,
        source: 'structure',
        blocking: true,
      });
    else outlineProblems(target, e.children, [...p, 'children'], depth + 1, out);
  });
}
/**
 * This Editor's structure checks (design §6.1): ID forms, duplicate IDs per OWD namespace,
 * references to missing elements, field types, outline depth and two `cites` rules allowing the
 * same pair. They are blocking, so an edit that adds one is refused; existing ones stay readable.
 */
export function structureDiagnostics(definition: OwdDefinition): WorkflowDefinitionDiagnostic[] {
  const out: WorkflowDefinitionDiagnostic[] = [];
  const push = (d: Omit<WorkflowDefinitionDiagnostic, 'source' | 'blocking'>) =>
    out.push({ ...d, source: 'structure', blocking: true });
  if (!validOwdId(definition.id))
    push({
      path: ['id'],
      code: 'id-form',
      args: { id: definition.id },
      message: `The definition ID ${definition.id} is not an ID (lower-case words, - and .)`,
    });
  if (!/^\d+\.\d+\.\d+$/.test(definition.version))
    push({ path: ['version'], code: 'version-form', message: 'The version is not N.N.N' });
  if (definition.strictCites !== undefined && definition.strictCites !== true)
    push({
      path: ['strictCites'],
      code: 'field-type',
      args: { field: 'strictCites' },
      message: 'strictCites is true or absent',
    });
  const seen = new Map<string, Set<string>>();
  for (const kind of owdElementKinds)
    for (const element of owdElements(definition, kind)) {
      const target = { kind, id: element.id as string };
      if (!validOwdId(target.id))
        push({
          target,
          path: ['id'],
          code: 'id-form',
          args: { id: target.id },
          message: `${kind} ${target.id}: not an ID (lower-case words, - and .)`,
        });
      const space = seen.get(owdNamespace(kind)) ?? new Set<string>();
      seen.set(owdNamespace(kind), space);
      if (space.has(target.id))
        push({
          target,
          path: ['id'],
          code: 'duplicate-id',
          args: { id: target.id },
          message: `${kind} ${target.id}: the ID is already used`,
        });
      space.add(target.id);
      const fields = stringFields[kind];
      for (const field of fields.required)
        if (!isString(element[field]))
          push({
            target,
            path: [field],
            code: 'field-type',
            args: { field },
            message: `${kind} ${target.id}: ${field} is not text`,
          });
      for (const field of fields.optional)
        if (element[field] !== undefined && !isString(element[field]))
          push({
            target,
            path: [field],
            code: 'field-type',
            args: { field },
            message: `${kind} ${target.id}: ${field} is not text`,
          });
      if (kind === 'acceptance') {
        if (element.checkedBy !== '人' && element.checkedBy !== 'AI')
          push({
            target,
            path: ['checkedBy'],
            code: 'field-type',
            args: { field: 'checkedBy' },
            message: `acceptance ${target.id}: checkedBy is 人 or AI`,
          });
        const approvers = element.approvers as OwdRecord | undefined;
        if (
          approvers &&
          approvers.count !== undefined &&
          !(Number.isInteger(approvers.count) && (approvers.count as number) >= 1)
        )
          push({
            target,
            path: ['approvers', 'count'],
            code: 'field-type',
            args: { field: 'approvers.count' },
            message: `acceptance ${target.id}: approvers count is a whole number from 1`,
          });
      }
      if (kind === 'rule') {
        if (element.type !== 'cites' && element.type !== 'covered')
          push({
            target,
            path: ['type'],
            code: 'field-type',
            args: { field: 'type' },
            message: `rule ${target.id}: type is cites or covered`,
          });
        if (
          element.min !== undefined &&
          !(Number.isInteger(element.min) && (element.min as number) >= 0)
        )
          push({
            target,
            path: ['min'],
            code: 'field-type',
            args: { field: 'min' },
            message: `rule ${target.id}: min is a whole number from 0`,
          });
        if (element.exempt !== undefined && element.exempt !== true)
          push({
            target,
            path: ['exempt'],
            code: 'field-type',
            args: { field: 'exempt' },
            message: `rule ${target.id}: exempt is true or absent`,
          });
      }
      if (kind === 'deliverable') outlineProblems(target, element.outline, ['outline'], 1, out);
    }
  for (const reference of owdReferences(definition))
    if (!findOwdElement(definition, reference.target))
      push({
        target: reference.owner,
        path: reference.path,
        code: 'missing-reference',
        args: { kind: reference.target.kind, id: reference.target.id },
        message: `${reference.owner.kind} ${reference.owner.id}: ${reference.target.kind} ${reference.target.id} does not exist`,
      });
  // A citation holds only its from → to pair, not a rule ID, so one pair may have one cites rule.
  const pairs = new Map<string, string>();
  for (const rule of owdElements(definition, 'rule')) {
    if (rule.type !== 'cites' || typeof rule.from !== 'string' || !Array.isArray(rule.to)) continue;
    for (const to of new Set(rule.to)) {
      const key = `${rule.from}\u0000${String(to)}`,
        had = pairs.get(key);
      if (had === undefined) pairs.set(key, rule.id as string);
      else if (had !== rule.id)
        push({
          target: { kind: 'rule', id: rule.id as string },
          path: ['to'],
          code: 'cites-pair',
          args: { rule: had, from: rule.from, to: String(to) },
          message: `rules ${had} and ${String(rule.id)} both allow citing ${rule.from} → ${String(to)} (one rule per pair)`,
        });
    }
  }
  return out;
}
/** Phase order cycles (`after`), as non-blocking diagnostics on each phase in a cycle. */
export function cycleDiagnostics(definition: OwdDefinition): WorkflowDefinitionDiagnostic[] {
  const phases = owdElements(definition, 'phase'),
    after = new Map(phases.map((p) => [p.id as string, (p.after as string[]) ?? []]));
  // Strongly connected components (Tarjan): every phase on some cycle, also where cycles overlap.
  const index = new Map<string, number>(),
    low = new Map<string, number>(),
    stack: string[] = [],
    onStack = new Set<string>(),
    inCycle = new Set<string>();
  let next = 0;
  const visit = (id: string) => {
    index.set(id, next);
    low.set(id, next++);
    stack.push(id);
    onStack.add(id);
    for (const a of after.get(id)!) {
      if (!after.has(a)) continue;
      if (!index.has(a)) {
        visit(a);
        low.set(id, Math.min(low.get(id)!, low.get(a)!));
      } else if (onStack.has(a)) low.set(id, Math.min(low.get(id)!, index.get(a)!));
    }
    if (low.get(id) !== index.get(id)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== id);
    if (component.length > 1 || after.get(id)!.includes(id))
      for (const m of component) inCycle.add(m);
  };
  for (const id of after.keys()) if (!index.has(id)) visit(id);
  return [...inCycle].map((id) => ({
    target: { kind: 'phase' as const, id },
    path: ['after'],
    code: 'phase-cycle',
    message: `phase ${id}: the phase order (after) has a cycle`,
    source: 'structure' as const,
    blocking: false,
  }));
}
