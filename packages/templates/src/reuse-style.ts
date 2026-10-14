import { clone, newId } from '@editor-platform/artifact-core';
import {
  definitionRef,
  sealReusableDefinition,
  validateTokenSet,
  type TokenSet,
  type DomainStyle,
  type DefinitionRef,
  type ReusableDefinition,
} from '@editor-platform/reuse-core';
import { validateReusableClosure } from './reuse-catalog';
import { lockReusableRoot } from './reuse-dependencies';
import type { ReusableStylePayload } from './reuse-definition';

interface AuthorIdentity {
  name: string;
  libraryId?: string;
  definitionId?: string;
  version?: number;
}
/** Shared tokens remain artifact data, independent of the Editor's own UI theme. */
export async function authorReusableTokens(options: AuthorIdentity & { tokens: TokenSet }) {
  options = clone(options);
  const definition = await sealReusableDefinition({
    schemaVersion: 1,
    kind: 'tokens',
    domain: 'shared',
    libraryId: options.libraryId ?? 'personal',
    definitionId: options.definitionId ?? newId('tokens'),
    version: options.version ?? 1,
    name: options.name,
    dependencies: [],
    payload: validateTokenSet(options.tokens),
  });
  return { definition, closure: await lockReusableRoot(definition) };
}

/** Domain-specific mappings retain the exact chosen token revision, including every mode. */
export async function authorReusableStyle(
  options: AuthorIdentity & {
    style: DomainStyle;
    tokens: DefinitionRef;
    dependencies: ReusableDefinition<unknown>[];
  },
) {
  options = clone(options);
  const definition = await sealReusableDefinition<ReusableStylePayload>({
    schemaVersion: 1,
    kind: 'style',
    domain: options.style.domain,
    libraryId: options.libraryId ?? 'personal',
    definitionId: options.definitionId ?? newId('style'),
    version: options.version ?? 1,
    name: options.name,
    dependencies: [definitionRef(options.tokens)],
    payload: { style: options.style, tokens: options.tokens },
  });
  const closure = await lockReusableRoot(definition, options.dependencies);
  await validateReusableClosure(closure);
  return { definition, closure };
}
