import {
  record,
  refKey,
  rejectReuse,
  validateRef,
  type DefinitionRef,
  type LockedClosure,
  type ReusableDefinition,
} from './contracts';
import { checkedComponentContract } from './properties';
import { resolveStyle, type DomainStyle } from './styles';
import { validateTokenSet, type TokenSet } from './tokens';

/** Semantic checks at native load/authority boundaries, after exact hash validation.
 * Generic closure locking remains payload-agnostic; retained native styles do not. */
export function validateRetainedStyles(closure: LockedClosure<unknown>): Map<string, string[]> {
  const definitions = new Map(closure.definitions.map((d) => [refKey(d), d]));
  const exact = (owner: ReusableDefinition<unknown>, raw: unknown, kind: string) => {
    validateRef(raw);
    const ref = raw as DefinitionRef,
      definition = definitions.get(refKey(ref));
    if (
      ref.kind !== kind ||
      !definition ||
      definition.hash !== ref.hash ||
      definition.kind !== ref.kind ||
      definition.domain !== ref.domain ||
      !owner.dependencies.some((r) => refKey(r) === refKey(ref) && r.hash === ref.hash)
    )
      rejectReuse(
        'style-dependency',
        'Retained style references must declare their exact dependencies',
        { definitionId: owner.definitionId },
      );
    return definition;
  };
  const sets = new Map<string, TokenSet>(),
    styleModes = new Map<string, string[]>();
  for (const definition of closure.definitions)
    if (definition.kind === 'tokens')
      sets.set(refKey(definition), validateTokenSet(definition.payload));
  for (const definition of closure.definitions) {
    if (definition.kind !== 'style') continue;
    const payload = definition.payload;
    if (
      !record(payload) ||
      !record(payload.style) ||
      Object.keys(payload).some((key) => !['style', 'tokens'].includes(key))
    )
      rejectReuse('style-schema', 'Invalid retained style payload', {
        definitionId: definition.definitionId,
      });
    const tokenDefinition = exact(definition, payload.tokens, 'tokens'),
      set = sets.get(refKey(tokenDefinition))!;
    if (payload.style.domain !== definition.domain)
      rejectReuse('style-domain', 'Retained style and definition domains differ', {
        definitionId: definition.definitionId,
      });
    for (const mode of set.modes)
      resolveStyle(payload.style as unknown as DomainStyle, set, { instanceMode: mode });
    styleModes.set(refKey(definition), set.modes);
  }
  const componentModes = new Map<string, string[]>();
  for (const definition of closure.definitions) {
    if (!record(definition.payload) || definition.payload.contract === undefined) continue;
    const contract = checkedComponentContract(definition.payload.contract),
      bindings = definition.payload.styles ?? [];
    if (!Array.isArray(bindings))
      rejectReuse('style-schema', 'Invalid retained component style bindings', {
        definitionId: definition.definitionId,
      });
    let modes: string[] | undefined;
    for (const binding of bindings) {
      if (
        !record(binding) ||
        typeof binding.partId !== 'string' ||
        !contract.parts.some((part) => part.id === binding.partId) ||
        Object.keys(binding).some((key) => !['partId', 'ref'].includes(key))
      )
        rejectReuse('style-part', 'Retained styles need declared native parts', {
          definitionId: definition.definitionId,
        });
      const style = exact(definition, binding.ref, 'style');
      if (style.domain !== definition.domain)
        rejectReuse('style-domain', 'A retained component style belongs to another domain', {
          definitionId: definition.definitionId,
        });
      const supported = styleModes.get(refKey(style))!;
      modes = modes ? modes.filter((mode) => supported.includes(mode)) : [...supported];
    }
    if (bindings.length) componentModes.set(refKey(definition), modes!);
  }
  return componentModes;
}
