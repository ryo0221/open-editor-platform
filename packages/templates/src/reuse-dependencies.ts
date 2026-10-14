import {
  definitionRef,
  lockClosure,
  refKey,
  rejectReuse,
  reuseLimits,
  type ReusableDefinition,
  type DefinitionRef,
} from '@editor-platform/reuse-core';

/** Select the exact transitive dependencies of an edited root; never fetch latest. */
export async function lockReusableRoot<T>(
  root: ReusableDefinition<T>,
  available: ReusableDefinition<unknown>[] = [],
) {
  const all = new Map<string, ReusableDefinition<unknown>>();
  for (const definition of available) {
    const key = refKey(definition);
    if (key === refKey(root)) continue;
    const old = all.get(key);
    if (old && old.hash !== definition.hash)
      rejectReuse(
        'dependency-mismatch',
        'Available definitions disagree about an immutable version',
        { definitionId: definition.definitionId },
      );
    all.set(key, definition);
  }
  all.set(refKey(root), root);
  const used = new Map<string, ReusableDefinition<unknown>>();
  const visit = (ref: DefinitionRef, depth = 0) => {
    if (depth >= reuseLimits.dependencyDepth)
      rejectReuse('closure-limit', 'Dependency graph exceeds its declared budget');
    const key = refKey(ref);
    const definition = all.get(key);
    if (
      !definition ||
      definition.hash !== ref.hash ||
      definition.kind !== ref.kind ||
      definition.domain !== ref.domain
    )
      rejectReuse('dependency-missing', 'The exact selected dependency is unavailable', {
        definitionId: ref.definitionId,
      });
    if (used.has(key)) return;
    if (used.size >= reuseLimits.definitions)
      rejectReuse('closure-limit', 'Dependency graph exceeds its definition budget');
    used.set(key, definition);
    definition.dependencies.forEach((child) => visit(child, depth + 1));
  };
  visit(definitionRef(root));
  return lockClosure<unknown>([definitionRef(root)], [...used.values()]);
}
