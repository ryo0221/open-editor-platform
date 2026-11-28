import { findOwdElement, owdCollections, owdElementKinds, type OwdElementKind } from './ids';
import { type WorkflowDefinitionDiagnostic } from './diagnostics';
import { type OwdDefinition } from './types';

/** The Host's OWD check (`check(definition): string[]` of open-workflow-definitions). */
export type WorkflowDefinitionCheck = (definition: OwdDefinition) => readonly string[];

/** The leading word of an OWD check sentence and the element kind it names. */
const words: [string, OwdElementKind][] = [
  ['達成条件', 'acceptance'],
  ['まとまり', 'section'],
  ['成果物', 'deliverable'],
  ['工程', 'phase'],
  ['規則', 'rule'],
  ['役割', 'role'],
  ['項目', 'item'],
];
const sentence =
  /^(達成条件|まとまり|成果物|工程|規則|役割|項目) ([a-z][a-z0-9.-]*)(?: と [a-z][a-z0-9.-]*)?: /;
const pointer = /^(\/[^:]*): /;
const collectionKinds = new Map(owdElementKinds.map((k) => [owdCollections[k], k] as const));

/**
 * Maps OWD `check` sentences to elements (design §6, U4, provisional). A sentence that starts with
 * an element word and ID (`工程 concept: 成果物が無い`) goes to that element; a schema failure
 * (`/phases/0/after: must be array`) goes to the element at that JSON Pointer. A sentence this
 * cannot read, or that names an element the definition does not have, stays a diagnostic of the
 * whole definition; nothing is dropped. The wording is pinned by the OWD fixture tests.
 */
export function mapCheckResults(
  definition: OwdDefinition,
  results: readonly string[],
): WorkflowDefinitionDiagnostic[] {
  return results.map((message) => {
    const base = { message, code: 'owd-check', source: 'check' as const, blocking: false };
    const named = sentence.exec(message);
    if (named) {
      const kind = words.find(([w]) => w === named[1])![1],
        target = { kind, id: named[2] };
      if (findOwdElement(definition, target)) return { ...base, target, path: [] };
    }
    const at = pointer.exec(message);
    if (at) {
      const parts = at[1]
        .split('/')
        .slice(1)
        .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
      const kind = collectionKinds.get(parts[0] as (typeof owdCollections)[OwdElementKind]);
      const list = kind && definition[owdCollections[kind]];
      const index = Number(parts[1]);
      if (kind && Array.isArray(list) && Number.isSafeInteger(index) && list[index]) {
        const id = (list[index] as { id?: unknown }).id;
        if (typeof id === 'string')
          return {
            ...base,
            target: { kind, id },
            path: parts.slice(2).map((p) => (/^\d+$/.test(p) ? Number(p) : p)),
          };
      }
      return { ...base, path: parts };
    }
    return { ...base, path: [] };
  });
}
