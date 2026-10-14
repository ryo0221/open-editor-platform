import { clone, deepFreeze, isDeepFrozen } from '@editor-platform/artifact-core';
import {
  assertReuseJson,
  record,
  rejectReuse,
  reuseDomains,
  reuseLimits,
  stableId,
  nativeAddress,
  type JsonValue,
  type ReuseDomain,
} from './contracts';

export type PropertyType = 'text' | 'rich-text' | 'number' | 'boolean' | 'enum' | 'asset';
export interface PublicProperty {
  id: string;
  label: string;
  type: PropertyType;
  required?: boolean;
  default?: JsonValue;
  min?: number;
  max?: number;
  maxLength?: number;
  options?: string[];
  targets: { partId: string; field: string }[];
}
export interface PublicSlot {
  id: string;
  partId: string;
  label: string;
  domain: ReuseDomain;
  accepts: ('component' | 'body')[];
  min: number;
  max: number;
}
export interface ComponentContract {
  schemaVersion: 1;
  parts: { id: string; nativeId: string }[];
  properties: PublicProperty[];
  slots: PublicSlot[];
  variants: { id: string; label: string; values: Record<string, JsonValue> }[];
  defaultVariant?: string;
}
function valueFor(p: PublicProperty, value: unknown, copyValue = true): JsonValue {
  if (value === undefined || value === null) {
    if (p.required)
      rejectReuse('property-required', 'Required public property is missing', { path: p.id });
    return null;
  }
  let valid = false;
  if (p.type === 'text' || p.type === 'enum')
    valid =
      typeof value === 'string' &&
      value.length <= (p.maxLength ?? 100000) &&
      (!p.required || !!value.trim()) &&
      (p.type !== 'enum' || p.options!.includes(value));
  if (p.type === 'number')
    valid =
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= (p.min ?? -1e6) &&
      value <= (p.max ?? 1e6);
  if (p.type === 'boolean') valid = typeof value === 'boolean';
  if (p.type === 'asset')
    valid =
      typeof value === 'string' &&
      value.length <= 8 * 1024 * 1024 &&
      (/^asset:[A-Za-z0-9_.:/-]+$/.test(value) ||
        /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value));
  if (p.type === 'rich-text') {
    valid =
      Array.isArray(value) &&
      value.length <= 10000 &&
      value.every((span) => {
        if (!record(span) || typeof span.text !== 'string') return false;
        return Object.entries(span).every(([key, field]) => {
          if (key === 'text') return true;
          if (['bold', 'italic', 'underline', 'strike', 'code'].includes(key))
            return typeof field === 'boolean';
          return (
            ['color', 'highlight'].includes(key) &&
            typeof field === 'string' &&
            /^#[a-f0-9]{6}(?:[a-f0-9]{2})?$/i.test(field)
          );
        });
      });
    if (valid) {
      const length = (value as { text: string }[]).reduce((n, span) => n + span.text.length, 0);
      valid = length <= (p.maxLength ?? 100000) && (!p.required || length > 0);
    }
  }
  if (!valid) rejectReuse('property-value', 'Invalid public ' + p.type + ' value', { path: p.id });
  return (copyValue && typeof value === 'object' ? clone(value) : value) as JsonValue;
}
export function validateComponentContract(raw: unknown): ComponentContract {
  return clone(checkedComponentContract(raw));
}
const validatedContracts = new WeakMap<object, ComponentContract>();
/** Internal immutable validation result. Public validation still returns an editable copy. */
export function checkedComponentContract(raw: unknown): ComponentContract {
  if (raw && typeof raw === 'object' && validatedContracts.has(raw))
    return validatedContracts.get(raw)!;
  assertReuseJson(raw);
  if (
    !record(raw) ||
    raw.schemaVersion !== 1 ||
    !Array.isArray(raw.parts) ||
    !raw.parts.length ||
    raw.parts.length > reuseLimits.parts ||
    !Array.isArray(raw.properties) ||
    raw.properties.length > 256 ||
    !Array.isArray(raw.slots) ||
    raw.slots.length > 256 ||
    !Array.isArray(raw.variants) ||
    raw.variants.length > 100
  )
    rejectReuse('component-schema', 'Unsupported component contract');
  const parts = new Set<string>(),
    native = new Set<string>(),
    properties = new Set<string>(),
    slots = new Set<string>(),
    variants = new Set<string>();
  for (const part of raw.parts) {
    if (
      !record(part) ||
      !stableId(part.id) ||
      !nativeAddress(part.nativeId) ||
      parts.has(part.id) ||
      native.has(part.nativeId)
    )
      rejectReuse('part-schema', 'Duplicate or invalid stable part identity');
    parts.add(part.id);
    native.add(part.nativeId);
  }
  for (const property of raw.properties) {
    if (
      !record(property) ||
      !stableId(property.id) ||
      properties.has(property.id) ||
      typeof property.label !== 'string' ||
      !property.label.trim() ||
      typeof property.type !== 'string' ||
      !['text', 'rich-text', 'number', 'boolean', 'enum', 'asset'].includes(property.type) ||
      !Array.isArray(property.targets) ||
      !property.targets.length ||
      property.targets.some(
        (t) =>
          !record(t) ||
          !stableId(t.partId) ||
          !parts.has(t.partId) ||
          typeof t.field !== 'string' ||
          !/^[A-Za-z][A-Za-z0-9.]*$/.test(t.field),
      )
    )
      rejectReuse('property-schema', 'Invalid property identity/type/native target');
    if (property.required !== undefined && typeof property.required !== 'boolean')
      rejectReuse('property-schema', 'Required must be a boolean');
    for (const key of ['min', 'max', 'maxLength'])
      if (
        property[key] !== undefined &&
        (typeof property[key] !== 'number' || !Number.isFinite(property[key]))
      )
        rejectReuse('property-schema', 'Property limits must be finite numbers');
    if (
      Number(property.min ?? -1e6) > Number(property.max ?? 1e6) ||
      Number(property.maxLength ?? 0) < 0 ||
      Number(property.maxLength ?? 0) > 100000
    )
      rejectReuse('property-schema', 'Invalid property limits');
    if (
      property.type === 'enum' &&
      (!Array.isArray(property.options) ||
        !property.options.length ||
        property.options.some((v) => typeof v !== 'string' || !v) ||
        new Set(property.options).size !== property.options.length)
    )
      rejectReuse('property-schema', 'Enum requires unique string options');
    properties.add(property.id);
    if (property.default !== undefined)
      valueFor(property as unknown as PublicProperty, property.default);
  }
  for (const slot of raw.slots) {
    if (
      !record(slot) ||
      !stableId(slot.id) ||
      slots.has(slot.id) ||
      typeof slot.label !== 'string' ||
      !stableId(slot.partId) ||
      !parts.has(slot.partId) ||
      !reuseDomains.includes(slot.domain as ReuseDomain) ||
      !Array.isArray(slot.accepts) ||
      !slot.accepts.length ||
      slot.accepts.some((t) => !['component', 'body'].includes(t)) ||
      !Number.isInteger(slot.min) ||
      !Number.isInteger(slot.max) ||
      Number(slot.min) < 0 ||
      Number(slot.max) < Number(slot.min) ||
      Number(slot.max) > 100
    )
      rejectReuse('slot-schema', 'Invalid typed slot');
    slots.add(slot.id);
  }
  for (const variant of raw.variants) {
    if (
      !record(variant) ||
      !stableId(variant.id) ||
      variants.has(variant.id) ||
      typeof variant.label !== 'string' ||
      !record(variant.values) ||
      Object.keys(variant.values).some((id) => !properties.has(id))
    )
      rejectReuse('variant-schema', 'Invalid variant identity or property');
    variants.add(variant.id);
    for (const [id, value] of Object.entries(variant.values))
      valueFor(
        raw.properties.find((p) => p.id === id),
        value,
      );
  }
  if (
    raw.defaultVariant !== undefined &&
    (!stableId(raw.defaultVariant) || !variants.has(raw.defaultVariant))
  )
    rejectReuse('variant-schema', 'Default variant does not exist');
  const result = deepFreeze(clone(raw)) as unknown as ComponentContract;
  if (isDeepFrozen(raw)) validatedContracts.set(raw, result);
  validatedContracts.set(result, result);
  return result;
}
export function resolveComponentProperties(
  raw: ComponentContract,
  input: unknown,
  variant?: string,
): { values: Record<string, JsonValue>; explicit: string[]; variant?: string } {
  return componentProperties(raw, input, variant, true);
}
const checkedInputs = new WeakMap<ComponentContract, WeakMap<object, Set<string>>>();
/** Internal validation-only path: defaults remain in their immutable contract,
 * and only certified immutable inputs can reuse the same validation result. */
export function assertComponentProperties(
  raw: ComponentContract,
  input: unknown,
  variant?: string,
): void {
  const contract = checkedComponentContract(raw);
  const cache = checkedInputs.get(contract) ?? new WeakMap<object, Set<string>>();
  const key = variant ?? '';
  if (input && typeof input === 'object' && cache.get(input)?.has(key)) return;
  componentProperties(contract, input, variant, false);
  if (input && typeof input === 'object' && isDeepFrozen(input)) {
    const variants = cache.get(input) ?? new Set<string>();
    variants.add(key);
    cache.set(input, variants);
    checkedInputs.set(contract, cache);
  }
}
function componentProperties(
  raw: ComponentContract,
  input: unknown,
  variant: string | undefined,
  copyValues: boolean,
) {
  const contract = checkedComponentContract(raw);
  assertReuseJson(input);
  if (!record(input)) rejectReuse('property-input', 'Public inputs must be an object');
  const known = new Set(contract.properties.map((p) => p.id));
  for (const key of Object.keys(input))
    if (!known.has(key)) rejectReuse('property-unknown', 'Unknown public property', { path: key });
  const selected = variant ?? contract.defaultVariant;
  const overrides = contract.variants.find((v) => v.id === selected)?.values;
  if (selected !== undefined && !overrides)
    rejectReuse('variant-missing', 'The selected variant does not exist');
  const values: Record<string, JsonValue> = {};
  for (const p of contract.properties)
    values[p.id] = valueFor(
      p,
      Object.hasOwn(input, p.id)
        ? input[p.id]
        : Object.hasOwn(overrides ?? {}, p.id)
          ? overrides![p.id]
          : p.default,
      copyValues,
    );
  return {
    values,
    explicit: Object.keys(input).sort(),
    ...(selected !== undefined ? { variant: selected } : {}),
  };
}
export function validateSlotAssignment(
  contract: ComponentContract,
  slotId: string,
  values: { domain: ReuseDomain; kind: 'component' | 'body' }[],
): void {
  const slot = checkedComponentContract(contract).slots.find((s) => s.id === slotId);
  if (!slot) rejectReuse('slot-missing', 'Slot does not exist', { slotId });
  if (
    values.length < slot.min ||
    values.length > slot.max ||
    values.some((v) => v.domain !== slot.domain || !slot.accepts.includes(v.kind))
  )
    rejectReuse('slot-type', 'Slot content type/count is not allowed', { slotId });
}
