import { canonicalJson, clone } from '@editor-platform/artifact-core';
import { command, type EditorCommand } from '@editor-platform/editor-core';
import {
  findOwdElement,
  isOwdElementKind,
  owdCollections,
  owdIdTaken,
  owdNamespace,
  validOwdId,
  type OwdElementKind,
  type OwdElementRef,
} from './ids';
import { owdReferrers, walkOwdGateReferences, walkOwdReferences } from './references';
import { newDiagnostic, structureDiagnostics } from './diagnostics';
import { readOwdDefinition } from './read';
import { type OwdDefinition, type OwdJson, type OwdRecord } from './types';

/**
 * One edit of a workflow definition. Every view (flow, lists, matrices) and external proposals use
 * these; a batch becomes one command and one record in the Host's Undo.
 */
export type WorkflowDefinitionIntent =
  /** Adds an element with a new ID at `index` of its list (default: the end). */
  | { type: 'add'; kind: OwdElementKind; id: string; fields?: OwdRecord; index?: number }
  /** Sets fields of an element; `null` removes an optional field. */
  | { type: 'set-fields'; kind: OwdElementKind; id: string; fields: Record<string, OwdJson> }
  /** Sets fields of the definition itself (`id`, `version`, `title`, `purpose`, `strictCites`). */
  | { type: 'set-definition'; fields: Record<string, OwdJson> }
  /**
   * Removes an element. Phases and sections leave every order and membership list. Other elements
   * that are referred to need `cascade: true`, which also removes the references (and acceptance
   * whose target, or rules whose `from`/`of`, is the removed element).
   */
  | { type: 'delete'; kind: OwdElementKind; id: string; cascade?: boolean }
  /** Changes an element's ID and every reference to it. */
  | { type: 'rename-id'; kind: OwdElementKind; id: string; to: string }
  /** Moves an element to `index` of its list (the phase order, for phases). */
  | { type: 'move'; kind: OwdElementKind; id: string; index: number }
  /**
   * Replaces what a rule says, keeping its ID and the acceptance that cite it: `from`, `to`,
   * `min` for cites; `of`, `by`, `exempt` for covered. A rule's target sets are edited as a whole,
   * never split per pair (design §5).
   */
  | { type: 'set-rule'; id: string; rule: OwdRecord };

/** Which fields `set-fields` may change, and whether `null` (remove) is allowed. */
const editable: Record<OwdElementKind, Record<string, 'required' | 'optional'>> = {
  phase: {
    name: 'required',
    purpose: 'required',
    icon: 'optional',
    after: 'required',
    deliverables: 'required',
    acceptance: 'required',
  },
  section: { name: 'required', icon: 'optional', phases: 'required' },
  deliverable: { name: 'required', form: 'required', outline: 'required', uses: 'optional' },
  acceptance: {
    text: 'required',
    checkedBy: 'required',
    target: 'required',
    rules: 'optional',
    approvers: 'optional',
  },
  role: { name: 'required', text: 'optional' },
  item: { name: 'required', idForm: 'required', parent: 'optional' },
  // Rules change with `set-rule`, so their target sets stay one unit.
  rule: {},
};
const definitionFields: Record<string, 'required' | 'optional'> = {
  id: 'required',
  version: 'required',
  title: 'required',
  purpose: 'required',
  strictCites: 'optional',
};
const ruleFields = ['type', 'from', 'to', 'min', 'of', 'by', 'exempt'];
/** The fields a new element starts with; `fields` of `add` replace them. */
const seeds: Record<OwdElementKind, OwdRecord> = {
  phase: { name: '', purpose: '', after: [], deliverables: [], acceptance: [] },
  section: { name: '', phases: [] },
  deliverable: { name: '', form: '', outline: [] },
  acceptance: { text: '', checkedBy: '人', target: '' },
  role: { name: '' },
  item: { name: '', idForm: '' },
  rule: { type: 'cites', from: '', to: [], min: 1 },
};
const plain = (v: unknown): v is OwdRecord => !!v && typeof v === 'object' && !Array.isArray(v);
const name = (ref: OwdElementRef) => `${ref.kind} ${ref.id}`;

function setFields(
  record: OwdRecord,
  fields: unknown,
  allowed: Record<string, 'required' | 'optional'>,
  what: string,
) {
  if (!plain(fields) || !Object.keys(fields).length) throw new Error(`${what}: no fields to set`);
  for (const [key, value] of Object.entries(fields)) {
    if (!Object.hasOwn(allowed, key)) throw new Error(`${what}: ${key} cannot be set here`);
    if (value === null) {
      if (allowed[key] === 'required') throw new Error(`${what}: ${key} cannot be removed`);
      delete record[key];
    } else record[key] = clone(value as OwdJson);
  }
}
function listOf(definition: OwdDefinition, kind: OwdElementKind): OwdRecord[] {
  const key = owdCollections[kind];
  if (!Array.isArray(definition[key])) (definition as OwdRecord)[key] = [];
  return definition[key] as OwdRecord[];
}
function element(definition: OwdDefinition, ref: OwdElementRef) {
  const found = findOwdElement(definition, ref);
  if (!found) throw new Error(`${name(ref)} does not exist`);
  return found;
}
const indexIn = (index: unknown, length: number) => {
  if (index === undefined) return length;
  if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) > length)
    throw new Error('Index out of range');
  return index as number;
};
function remove(definition: OwdDefinition, ref: OwdElementRef, cascade: boolean) {
  const list = listOf(definition, ref.kind),
    at = list.findIndex((e) => e.id === ref.id);
  if (at < 0) throw new Error(`${name(ref)} does not exist`);
  // Order and membership lists follow a removed phase or section without a confirmation.
  const free = ref.kind === 'phase' || ref.kind === 'section';
  const referrers = owdReferrers(definition, ref).filter(
    (r) => !(r.owner.kind === ref.kind && r.owner.id === ref.id),
  );
  if (referrers.length && !free && !cascade)
    throw new Error(
      `${name(ref)} is used by ${[...new Set(referrers.map((r) => name(r.owner)))].join(', ')}; delete with cascade to remove those references`,
    );
  list.splice(at, 1);
  // Elements that cannot exist without the removed one go too, with their own references.
  const dependents: OwdElementRef[] = [];
  for (const r of referrers)
    if (
      (r.owner.kind === 'acceptance' && r.path[0] === 'target') ||
      (r.owner.kind === 'rule' && (r.path[0] === 'from' || r.path[0] === 'of'))
    )
      dependents.push(r.owner);
  walkOwdReferences(definition, (r) =>
    r.target.kind === ref.kind && r.target.id === ref.id ? null : undefined,
  );
  walkOwdGateReferences(definition, (t) =>
    t.kind === ref.kind && t.id === ref.id ? null : undefined,
  );
  for (const d of dependents) if (findOwdElement(definition, d)) remove(definition, d, true);
}
function rename(definition: OwdDefinition, ref: OwdElementRef, to: unknown) {
  if (!validOwdId(to)) throw new Error(`${String(to)} is not an ID (lower-case words, - and .)`);
  const found = element(definition, ref);
  if (to === ref.id) return;
  if (owdIdTaken(definition, ref.kind, to))
    throw new Error(`The ID ${to} is already used (${owdNamespace(ref.kind)} IDs)`);
  walkOwdReferences(definition, (r) =>
    r.target.kind === ref.kind && r.target.id === ref.id ? to : undefined,
  );
  walkOwdGateReferences(definition, (t) =>
    t.kind === ref.kind && t.id === ref.id ? to : undefined,
  );
  found.id = to;
}
function applyIntent(definition: OwdDefinition, intent: WorkflowDefinitionIntent) {
  if (!plain(intent)) throw new Error('Invalid workflow definition intent');
  if (intent.type === 'set-definition') {
    setFields(definition, intent.fields, definitionFields, 'definition');
    return;
  }
  if (intent.type === 'set-rule') {
    const rule = element(definition, { kind: 'rule', id: String(intent.id) });
    if (!plain(intent.rule)) throw new Error('rule: a rule is required');
    for (const key of Object.keys(intent.rule))
      if (!ruleFields.includes(key)) throw new Error(`rule: ${key} cannot be set here`);
    for (const key of ruleFields) delete rule[key];
    Object.assign(rule, clone(intent.rule));
    return;
  }
  if (!isOwdElementKind(intent.kind) || typeof intent.id !== 'string')
    throw new Error('Invalid workflow definition intent');
  const ref = { kind: intent.kind, id: intent.id };
  switch (intent.type) {
    case 'add': {
      if (!validOwdId(ref.id))
        throw new Error(`${ref.id || 'An empty ID'} is not an ID (lower-case words, - and .)`);
      if (owdIdTaken(definition, ref.kind, ref.id))
        throw new Error(`The ID ${ref.id} is already used (${owdNamespace(ref.kind)} IDs)`);
      // A rule's fields name its type, so given fields replace the whole seed.
      const seed = ref.kind === 'rule' && plain(intent.fields) ? {} : seeds[ref.kind];
      const record: OwdRecord = { id: ref.id, ...clone(seed) };
      if (intent.fields !== undefined) {
        const allowed =
          ref.kind === 'rule'
            ? Object.fromEntries(ruleFields.map((k) => [k, 'optional' as const]))
            : editable[ref.kind];
        if (plain(intent.fields) && Object.keys(intent.fields).length)
          setFields(record, intent.fields, allowed, name(ref));
      }
      const list = listOf(definition, ref.kind);
      list.splice(indexIn(intent.index, list.length), 0, record);
      return;
    }
    case 'set-fields':
      setFields(element(definition, ref), intent.fields, editable[ref.kind], name(ref));
      return;
    case 'delete':
      remove(definition, ref, intent.cascade === true);
      return;
    case 'rename-id':
      rename(definition, ref, intent.to);
      return;
    case 'move': {
      const list = listOf(definition, ref.kind),
        at = list.findIndex((e) => e.id === ref.id);
      if (at < 0) throw new Error(`${name(ref)} does not exist`);
      const [moved] = list.splice(at, 1);
      list.splice(indexIn(intent.index, list.length), 0, moved);
      return;
    }
    default:
      throw new Error('Invalid workflow definition intent');
  }
}
/**
 * Applies a batch to a copy of the definition, all or nothing. A batch that adds a structure
 * problem (an invalid or duplicate ID, a reference to a missing element, a field of the wrong type,
 * two cites rules for one pair) is refused with that problem; problems the definition already had
 * are kept and do not block unrelated edits.
 */
export function applyWorkflowDefinitionIntents(
  definition: OwdDefinition,
  intents: readonly WorkflowDefinitionIntent[],
): OwdDefinition {
  if (!Array.isArray(intents) || !intents.length) throw new Error('No workflow definition edits');
  const before = readOwdDefinition(definition);
  const next = clone(before);
  for (const intent of intents) applyIntent(next, intent);
  readOwdDefinition(next);
  // A problem the definition had keeps its identity when its element's ID is changed.
  const renames = intents.filter(
    (i): i is Extract<WorkflowDefinitionIntent, { type: 'rename-id' }> => i.type === 'rename-id',
  );
  const had = structureDiagnostics(before).map((d) => {
    let target = d.target;
    for (const r of renames)
      if (target && target.kind === r.kind && target.id === r.id && typeof r.to === 'string')
        target = { kind: target.kind, id: r.to };
    return target === d.target ? d : { ...d, target };
  });
  const added = newDiagnostic(had, structureDiagnostics(next));
  if (added) throw new Error(added.message);
  return next;
}
/**
 * The batch as one command. It re-applies the intents to the content it is given, so a stale or
 * conflicting edit is refused there. `readOnly` refuses the batch here, as every view does.
 */
export function workflowDefinitionCommand(
  intents: readonly WorkflowDefinitionIntent[],
  options: { label?: string; readOnly?: boolean; base?: OwdDefinition } = {},
): EditorCommand<OwdDefinition> {
  if (options.readOnly) throw new Error('The workflow definition is read only');
  const frozen = clone(intents) as WorkflowDefinitionIntent[];
  const base = options.base && canonicalJson(options.base);
  if (options.base) applyWorkflowDefinitionIntents(options.base, frozen);
  return command<OwdDefinition>(
    'workflow-definition.edit',
    options.label ?? 'Edit workflow definition',
    (current) => {
      if (base !== undefined && canonicalJson(current) !== base)
        throw new Error('The workflow definition changed; review the edit again');
      return applyWorkflowDefinitionIntents(current, frozen);
    },
  );
}
/** Elements that refer to `ref`, for a cascade confirmation. */
export function workflowDefinitionReferrers(definition: OwdDefinition, ref: OwdElementRef) {
  const seen = new Set<string>();
  return owdReferrers(definition, ref)
    .filter((r) => !(r.owner.kind === ref.kind && r.owner.id === ref.id))
    .map((r) => r.owner)
    .filter((o) => !seen.has(`${o.kind}:${o.id}`) && !!seen.add(`${o.kind}:${o.id}`));
}
