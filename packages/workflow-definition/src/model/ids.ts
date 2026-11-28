import { type OwdDefinition, type OwdRecord } from './types';

/** The OWD ID form, shared by every element kind. */
export const owdIdPattern = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/;
export const validOwdId = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 128 && owdIdPattern.test(value);
export const owdElementKinds = [
  'phase',
  'section',
  'deliverable',
  'acceptance',
  'role',
  'item',
  'rule',
] as const;
export type OwdElementKind = (typeof owdElementKinds)[number];
export const isOwdElementKind = (value: unknown): value is OwdElementKind =>
  owdElementKinds.includes(value as OwdElementKind);
/** Where each kind lives in the definition. */
export const owdCollections = {
  phase: 'phases',
  section: 'sections',
  deliverable: 'deliverables',
  acceptance: 'acceptance',
  role: 'roles',
  item: 'items',
  rule: 'rules',
} as const satisfies Record<OwdElementKind, string>;
/**
 * The ID namespaces OWD's `check` uses: phases, sections, deliverables and acceptance share one;
 * item kinds, rules and roles each have their own. A real definition has `concept` both as a phase
 * and as an item kind, so one namespace for everything would refuse it.
 */
export const owdNamespace = (kind: OwdElementKind) =>
  kind === 'item' || kind === 'rule' || kind === 'role' ? kind : 'element';
export interface OwdElementRef {
  kind: OwdElementKind;
  id: string;
}
/**
 * The ID an element has outside OWD, in the Graph projection and in mind map links: the kind and
 * the OWD ID (`phase:concept`), so the same OWD ID in two namespaces names two elements.
 */
export const owdElementKey = (ref: OwdElementRef) => `${ref.kind}:${ref.id}`;
export function parseOwdElementKey(key: unknown): OwdElementRef | undefined {
  if (typeof key !== 'string') return undefined;
  const at = key.indexOf(':');
  const kind = key.slice(0, at),
    id = key.slice(at + 1);
  return at > 0 && isOwdElementKind(kind) && validOwdId(id) ? { kind, id } : undefined;
}
/** The elements of one kind; an absent optional collection reads as empty. */
export function owdElements(definition: OwdDefinition, kind: OwdElementKind): OwdRecord[] {
  const list = definition[owdCollections[kind]];
  return Array.isArray(list) ? (list as OwdRecord[]) : [];
}
export const findOwdElement = (definition: OwdDefinition, ref: OwdElementRef) =>
  owdElements(definition, ref.kind).find((e) => e.id === ref.id);
/** Whether an ID is already taken in the namespace of `kind`. */
export function owdIdTaken(definition: OwdDefinition, kind: OwdElementKind, id: string) {
  const space = owdNamespace(kind);
  return owdElementKinds.some(
    (k) => owdNamespace(k) === space && owdElements(definition, k).some((e) => e.id === id),
  );
}
