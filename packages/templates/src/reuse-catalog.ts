import { clone } from '@editor-platform/artifact-core';
import {
  definitionRef,
  lockClosure,
  record,
  refKey,
  rejectReuse,
  resolveStyle,
  sealReusableDefinition,
  validateClosure,
  validateTokenSet,
  type DefinitionRef,
  type LockedClosure,
  type TokenSet,
} from '@editor-platform/reuse-core';
import {
  closureDefinition,
  materializeComponent,
  validateComponentDefinition,
  type ComponentDefinition,
  type ReusableStylePayload,
} from './reuse-definition';
import { sealDefinition, validateDefinition } from './engine';
import { validateReusableViewDefinition, materializeReusableView } from './reuse-view';
import { decodeStructureRecipe } from './structure';
import { validateCompositionDefinition } from './reuse-composition';

/** Publication checks all adopted payloads and modes, before a catalog can expose any member. */
export async function validateReusableClosure(raw: LockedClosure<unknown>) {
  const closure = await validateClosure<unknown>(raw);
  for (const d of closure.definitions) {
    if (d.kind === 'tokens') validateTokenSet(d.payload);
    else if (d.kind === 'style') {
      if (!record(d.payload) || !record(d.payload.tokens) || !record(d.payload.style))
        rejectReuse('style-schema', 'Invalid reusable style payload');
      const payload = d.payload as unknown as ReusableStylePayload;
      if (
        payload.style.domain !== d.domain ||
        payload.tokens.kind !== 'tokens' ||
        !d.dependencies.some(
          (ref) => refKey(ref) === refKey(payload.tokens) && ref.hash === payload.tokens.hash,
        )
      )
        rejectReuse('style-dependency', 'Style must declare its exact token dependency');
      const tokens = validateTokenSet(closureDefinition<TokenSet>(closure, payload.tokens).payload);
      for (const mode of tokens.modes) resolveStyle(payload.style, tokens, { instanceMode: mode });
    } else if (d.kind === 'view-preset') {
      const preset = await validateReusableViewDefinition(d);
      const modes = new Set<string | undefined>([undefined]);
      if (preset.payload.style) {
        const style = closureDefinition<ReusableStylePayload>(closure, preset.payload.style);
        const tokens = validateTokenSet(
          closureDefinition<TokenSet>(closure, style.payload.tokens).payload,
        );
        tokens.modes.forEach((mode) => modes.add(mode));
      }
      for (const mode of modes) await materializeReusableView(preset, closure, {}, mode);
    } else if (
      d.libraryId === 'native-template-layouts' &&
      record(d.payload) &&
      d.payload.variableTemplate
    ) {
      const template = await validateDefinition(decodeStructureRecipe(d.payload.variableTemplate));
      if (
        !template.structure ||
        d.definitionId !== template.templateId ||
        d.version !== template.templateVersion ||
        d.domain !== template.domain ||
        d.kind !== 'pattern' ||
        d.dependencies.length
      )
        rejectReuse('structure-schema', 'Invalid variable native definition identity');
    } else if (
      ['pattern', 'template'].includes(d.kind) &&
      record(d.payload) &&
      !d.payload.contract
    ) {
      await validateCompositionDefinition(d);
    } else {
      const component = await validateComponentDefinition(d);
      const modes = new Set<string | undefined>([undefined]);
      for (const binding of component.payload.styles ?? []) {
        const style = closureDefinition<ReusableStylePayload>(closure, binding.ref);
        const tokens = validateTokenSet(
          closureDefinition<TokenSet>(closure, style.payload.tokens).payload,
        );
        tokens.modes.forEach((mode) => modes.add(mode));
      }
      for (const variant of [undefined, ...component.payload.contract.variants.map((v) => v.id)])
        for (const mode of modes) await materializeComponent(component, closure, {}, variant, mode);
    }
  }
  return closure;
}
export async function createReusableVersion(
  old: ComponentDefinition,
  changes: Partial<Pick<ComponentDefinition, 'name' | 'payload' | 'dependencies'>>,
  dependencies: LockedClosure<unknown>['definitions'] = [],
) {
  const value = { ...clone(old), ...clone(changes), version: old.version + 1 };
  value.payload.template = await sealDefinition(value.payload.template);
  const definition = await sealReusableDefinition(value);
  const root: DefinitionRef = definitionRef(definition);
  const closure = await lockClosure<unknown>(
    [root],
    [definition, ...dependencies.filter((d) => refKey(d) !== refKey(root))],
  );
  await validateReusableClosure(closure);
  return { definition, closure };
}
