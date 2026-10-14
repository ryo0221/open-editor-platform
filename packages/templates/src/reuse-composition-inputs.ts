import { clone } from '@editor-platform/artifact-core';
import { isDesign } from '@editor-platform/design/model';
import {
  record,
  stableId,
  resolveComponentProperties,
  validateComponentContract,
  validateReuseStateSync,
  type JsonValue,
} from '@editor-platform/reuse-core';
import { retainedComponent } from './reuse-apply';
import { reusablePropertyValue } from './reuse-definition';
import {
  nativePropertyPatch,
  patchReusablePart,
  reusableParts,
  reusablePartRich,
} from './reuse-native';
import { at } from './native';
import {
  problem,
  type NativeContent,
  type TemplateComposition,
  type TemplateDefinition,
  type InputField,
  type InputValue,
  type Path,
} from './types';

export interface CompositionInput {
  key: string;
  label: string;
  instanceId: string;
  propertyId: string;
}
export interface CompositionCapture {
  libraryId?: string;
  members: Record<string, 'copy' | 'linked'>;
  inputs: CompositionInput[];
}
export function compositionOwnsPath(content: NativeContent, path: Path): boolean {
  const state = 'reuse' in content ? content.reuse : undefined;
  const scoped = isDesign(content);
  const ids = new Set(
    (state?.instances ?? [])
      .flatMap((i) => Object.values(i.parts))
      .map((id) => (scoped ? id.split('/').at(-1) : id)),
  );
  for (let n = path.length - 1; n > 0; n--) {
    const owner = at(content, path.slice(0, n));
    if (record(owner) && typeof owner.id === 'string') return ids.has(owner.id);
  }
  return false;
}
function prototypeWithAssets(d: TemplateDefinition): NativeContent {
  const resolve = (value: unknown, key = ''): unknown => {
    if (key === 'reuse') return clone(value);
    if (typeof value === 'string' && value.startsWith('asset://'))
      return (
        d.assets.find((a) => a.id === value.slice(8))?.data ??
        problem('missing-asset', 'Missing composition asset')
      );
    if (Array.isArray(value)) return value.map((v) => resolve(v));
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, k)]));
    return value;
  };
  return resolve(d.content) as NativeContent;
}
export function captureComposition(content: NativeContent, options: CompositionCapture) {
  if (!record(options) || !record(options.members) || !Array.isArray(options.inputs))
    problem('composition-schema', 'Expected member choices and public input bindings');
  const state = 'reuse' in content ? content.reuse : undefined;
  if (!state?.instances.length)
    problem('composition-empty', 'Choose at least one complete reusable member');
  if (options.inputs.length > 256)
    problem('composition-limit', 'Expose at most 256 public composition inputs');
  for (const [id, mode] of Object.entries(options.members))
    if (!['copy', 'linked'].includes(mode) || !state.instances.some((i) => i.id === id))
      problem(
        'composition-member',
        'Select the complete member, including its declared slot content',
        id,
      );
  const composition: TemplateComposition = {
    schemaVersion: 1,
    libraryId: options.libraryId ?? 'personal',
    members: state.instances.map((i) => ({
      instanceId: i.id,
      reuse: options.members[i.id] ?? 'copy',
    })),
    bindings: options.inputs.map((input) => ({
      slot: input.key,
      instanceId: input.instanceId,
      propertyId: input.propertyId,
    })),
  };
  const parts = reusableParts(content);
  const inputs: InputField[] = options.inputs.map((input) => {
    if (!record(input) || !stableId(input.key) || typeof input.label !== 'string')
      problem('composition-input', 'Expected a stable input key and label');
    const { instance, definition } = retainedComponent(content, input.instanceId);
    const property = definition.payload.contract.properties.find((p) => p.id === input.propertyId);
    if (!property) problem('composition-input', 'Unknown public component input', input.key);
    const values = resolveComponentProperties(
      definition.payload.contract,
      instance.inputs,
      instance.variant,
    ).values;
    let value = values[property.id];
    const target = property.targets[0],
      part = target && parts.get(instance.parts[target.partId]);
    if (part && target.field === 'text') value = String(part.text ?? '');
    if (part && target.field === 'rich') value = reusablePartRich(part);
    if (part && target.field === 'src') value = part.src ? String(part.src) : null;
    if (part && target.field === 'visible') value = !part.hidden;
    value = reusablePropertyValue(definition, property, value);
    return {
      key: input.key,
      label: input.label,
      description: property.label,
      type: property.type,
      required: property.required,
      default: value,
      example: value,
      min: property.min,
      max: property.max,
      maxLength: property.maxLength,
      options: property.options,
    };
  });
  return { composition, inputs };
}

/** Validate the recipe separately from its resulting copy/linked native projection. */
export function validateComposition(d: TemplateDefinition) {
  const c = d.composition;
  if (!c) {
    if (d.content && 'reuse' in d.content && d.content.reuse)
      validateReuseStateSync(d.content.reuse);
    return;
  }
  const state = d.content && 'reuse' in d.content ? d.content.reuse : undefined;
  if (
    !record(c) ||
    c.schemaVersion !== 1 ||
    !stableId(c.libraryId) ||
    Object.keys(c).some(
      (k) => !['schemaVersion', 'libraryId', 'members', 'bindings'].includes(k),
    ) ||
    !Array.isArray(c.members) ||
    !Array.isArray(c.bindings) ||
    c.bindings.length > 256 ||
    !state?.instances.length ||
    d.kind === 'preset' ||
    c.members.length !== state.instances.length ||
    new Set(c.members.map((m) => m?.instanceId)).size !== c.members.length
  )
    problem('composition-schema', 'Invalid native composition recipe');
  validateReuseStateSync(state);
  const prototype = prototypeWithAssets(d);
  const parts = reusableParts(prototype);
  for (const member of c.members) {
    if (
      !member ||
      !['copy', 'linked'].includes(member.reuse) ||
      Object.keys(member).some((k) => !['instanceId', 'reuse'].includes(k))
    )
      problem('composition-member', 'Choose copy or linked for each complete member');
    const { instance, definition } = retainedComponent(d.content!, member.instanceId);
    validateComponentContract(definition.payload.contract);
    if (
      [...Object.values(instance.parts), ...Object.values(instance.slots).flat()].some(
        (id) => !parts.has(id),
      )
    )
      problem('composition-member', 'A member or its slot content is missing', member.instanceId);
  }
  const owned = new Set<string>();
  for (const binding of d.bindings) {
    if (compositionOwnsPath(prototype, binding.path))
      problem(
        'composition-input',
        'Bind this reusable member through its declared public property',
        binding.slot,
      );
  }
  for (const b of c.bindings) {
    if (!b || Object.keys(b).some((k) => !['slot', 'instanceId', 'propertyId'].includes(k)))
      problem('composition-input', 'Invalid public input binding');
    const key = JSON.stringify([b.instanceId, b.propertyId]);
    const { definition } = retainedComponent(d.content!, b.instanceId);
    const property = definition.payload.contract.properties.find((p) => p.id === b.propertyId);
    const field = d.inputs.find((f) => f.key === b.slot);
    if (owned.has(key) || !property || !field || field.type !== property.type)
      problem(
        'composition-input',
        'A component property needs one compatible public input',
        b.slot,
      );
    owned.add(key);
  }
  // Repeating linked native nodes needs new instance/slot ownership, not generic record repetition.
  if (d.repeats.length)
    problem('composition-repeat', 'Repeat composed members through separately prepared insertions');
}

export function applyCompositionInputs(
  content: NativeContent,
  c: TemplateComposition,
  values: Record<string, InputValue>,
  assets: TemplateDefinition['assets'],
) {
  for (const binding of c.bindings) {
    const { instance, definition } = retainedComponent(content, binding.instanceId);
    const property = definition.payload.contract.properties.find(
      (p) => p.id === binding.propertyId,
    )!;
    let value = (values[binding.slot] as JsonValue) ?? null;
    if (property.type === 'asset' && typeof value === 'string' && value.startsWith('asset://'))
      value =
        assets.find((a) => a.id === String(value).slice(8))?.data ??
        reusablePropertyValue(definition, property, value);
    const inputs = { ...instance.inputs, [binding.propertyId]: value };
    const resolved = resolveComponentProperties(
      definition.payload.contract,
      inputs,
      instance.variant,
    );
    for (const target of property.targets) {
      const address = instance.parts[target.partId];
      if (
        property.type === 'text' &&
        target.field === 'text' &&
        reusableParts(content).get(address)?.text === resolved.values[property.id]
      )
        continue;
      patchReusablePart(
        content,
        address,
        nativePropertyPatch(
          content,
          address,
          target.field,
          property.type,
          reusablePropertyValue(definition, property, resolved.values[property.id]),
        ),
        isDesign(content),
      );
    }
    instance.inputs = clone(inputs);
  }
}
export function projectCompositionMembers(content: NativeContent, c: TemplateComposition) {
  if (!('reuse' in content) || !content.reuse) return;
  const linked = new Set(c.members.filter((m) => m.reuse === 'linked').map((m) => m.instanceId));
  content.reuse.instances = content.reuse.instances.filter((i) => linked.has(i.id));
  const closures = new Set(content.reuse.instances.map((i) => i.closureHash));
  content.reuse.closures = content.reuse.closures.filter((closure) => closures.has(closure.hash));
  if (!content.reuse.instances.length) delete content.reuse;
}
