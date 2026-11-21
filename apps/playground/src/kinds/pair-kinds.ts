import type { KindDefinition } from '@editor-platform/artifact-kinds';

/**
 * One Host entry per registered kind, made from the same definition object the registry lists.
 * A kind without an entry, a second entry or an entry made from another definition is an error
 * at start-up, like a kind registered twice.
 */
export function pairKinds<E extends { readonly kind: string; readonly definition: unknown }>(
  definitions: readonly KindDefinition<unknown>[],
  entries: readonly E[],
  what: string,
): ReadonlyMap<string, E> {
  const byKind = new Map<string, E>();
  for (const entry of entries) {
    if (byKind.has(entry.kind)) throw new Error(`${what} registered twice: ${entry.kind}`);
    byKind.set(entry.kind, entry);
  }
  for (const definition of definitions) {
    const entry = byKind.get(definition.kind);
    if (!entry) throw new Error(`No ${what} for kind: ${definition.kind}`);
    if (entry.definition !== definition)
      throw new Error(`${what} for ${definition.kind} uses another definition`);
  }
  if (byKind.size !== definitions.length)
    throw new Error(
      `${what} without a registered kind: ${[...byKind.keys()]
        .filter((kind) => !definitions.some((definition) => definition.kind === kind))
        .join(', ')}`,
    );
  return byKind;
}
