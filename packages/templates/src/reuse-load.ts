import { isStructureInstance, validateStructureInstance } from './structure';
import { clone } from '@editor-platform/artifact-core';
import { validateReuseStateSync } from '@editor-platform/reuse-core';
import { nativeValid } from './native';
import { validateReusableClosure } from './reuse-catalog';
import { materializeComponent, type ComponentDefinition } from './reuse-definition';
import { problem, type Domain, type NativeContent } from './types';

/** Run before exposing an untrusted native import or writing it to Host storage.
 * Validate retained recipes without replacing the user's edited native content. */
export async function validateNativeReusableDefinitions(domain: Domain, content: NativeContent) {
  const state = validateReuseStateSync('reuse' in content ? clone(content.reuse) : undefined);
  if (!state) return;
  if (!nativeValid(domain, content)) problem('domain-schema', 'Invalid native reusable content');
  for (const closure of state.closures) await validateReusableClosure(closure);
  for (const instance of state.instances) {
    if (isStructureInstance(instance)) {
      validateStructureInstance(content, instance.id);
      continue;
    }
    const closure = state.closures.find((value) => value.hash === instance.closureHash)!;
    const definition = closure.definitions.find(
      (d) =>
        d.libraryId === instance.ref.libraryId &&
        d.definitionId === instance.ref.definitionId &&
        d.version === instance.ref.version,
    )! as ComponentDefinition;
    await materializeComponent(
      definition,
      closure,
      instance.inputs,
      instance.variant,
      instance.mode,
      state.artifactMode,
    );
  }
}
