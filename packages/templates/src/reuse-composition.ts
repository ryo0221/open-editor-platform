import { canonicalJson, clone } from '@editor-platform/artifact-core';
import {
  definitionRef,
  refKey,
  rejectReuse,
  sealReusableDefinition,
  validateReusableDefinition,
  type DefinitionRef,
  type ReusableDefinition,
} from '@editor-platform/reuse-core';
import { saveAsTemplate } from './author';
import { validateDefinition } from './engine';
import { lockReusableRoot } from './reuse-dependencies';
import type { TemplateDefinition } from './types';
import type { CompositionCapture } from './reuse-composition-inputs';

export type CompositionDefinition = ReusableDefinition<{ template: TemplateDefinition }>;
function dependencies(template: TemplateDefinition): DefinitionRef[] {
  const state =
    template.content && 'reuse' in template.content ? template.content.reuse : undefined;
  return [
    ...new Map((state?.instances ?? []).map((i) => [refKey(i.ref), definitionRef(i.ref)])).values(),
  ].sort((a, b) => (refKey(a) < refKey(b) ? -1 : refKey(a) > refKey(b) ? 1 : 0));
}
/** Derive the common exact-ref envelope from the existing native template recipe.
 * It is a creation recipe, not another instance owning its children's native parts. */
export async function compositionBundle(raw: TemplateDefinition) {
  const template = await validateDefinition(raw);
  if (!template.composition || !template.content || !('reuse' in template.content))
    rejectReuse('composition-schema', 'Expected an explicit native composition');
  const definition = await sealReusableDefinition({
    schemaVersion: 1,
    libraryId: template.composition.libraryId,
    definitionId: template.templateId,
    version: template.templateVersion,
    kind: template.kind === 'whole' ? 'template' : 'pattern',
    domain: template.domain,
    name: template.name,
    dependencies: dependencies(template),
    payload: { template },
  });
  const closure = await lockReusableRoot(
    definition,
    template.content.reuse!.closures.flatMap((c) => c.definitions),
  );
  return { template, definition, closure };
}
export async function authorReusableComposition(
  options: Omit<Parameters<typeof saveAsTemplate>[0], 'composition'> & {
    composition: CompositionCapture;
  },
) {
  return compositionBundle(await saveAsTemplate(clone(options)));
}
export async function validateCompositionDefinition(raw: unknown): Promise<CompositionDefinition> {
  const d = await validateReusableDefinition<{ template: TemplateDefinition }>(raw);
  if (
    !['pattern', 'template'].includes(d.kind) ||
    !d.payload?.template ||
    Object.keys(d.payload).some((k) => k !== 'template')
  )
    rejectReuse('composition-schema', 'Expected a native pattern/template creation recipe');
  const t = await validateDefinition(d.payload.template);
  if (
    !t.composition ||
    d.libraryId !== t.composition.libraryId ||
    d.definitionId !== t.templateId ||
    d.version !== t.templateVersion ||
    d.domain !== t.domain ||
    (d.kind === 'pattern' ? t.kind !== 'fragment' : t.kind !== 'whole') ||
    canonicalJson(d.dependencies) !== canonicalJson(dependencies(t))
  )
    rejectReuse(
      'composition-dependency',
      'Composition identity or exact member dependencies differ',
    );
  return d;
}
