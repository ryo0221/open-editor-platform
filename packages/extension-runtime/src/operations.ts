/**
 * Data-only checks for the optional `operations@0-draft` add-on. Nothing here runs package code,
 * so a Host server can check a provider's proposal against a frozen declaration before any
 * browser loads the package. Limits bound the declaration (manifest complexity) separately from
 * one input (provider output).
 */
import { canonicalJson } from '@editor-platform/artifact-core';
import {
  OPERATIONS_ADDON,
  type ManifestAddons,
  type OperationDeclaration,
  type OperationSchema,
} from '@editor-platform/extension-contract';

export const OPERATION_LIMITS = Object.freeze({
  /** Operations one package may declare. */
  operations: 16,
  /** Canonical JSON bytes of all declarations together. */
  declarationBytes: 32 * 1024,
  /** Nesting depth of one input schema (the top schema is depth 1). */
  depth: 8,
  /** Properties of one object schema. */
  properties: 64,
  /** Values of one enum. */
  enumValues: 64,
  /** Largest maxLength / maxItems a schema may state. */
  maxLength: 20000,
  maxItems: 1000,
  /** Description and title length. */
  text: 500,
  /** Canonical JSON bytes of one input. */
  inputBytes: 20 * 1024,
});

const ID = /^[a-z][a-z0-9.-]{0,63}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
const PROPERTY = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const KEYS: Record<string, readonly string[]> = {
  object: ['type', 'properties', 'required', 'additionalProperties', 'description'],
  array: ['type', 'items', 'maxItems', 'minItems', 'description'],
  string: ['type', 'maxLength', 'minLength', 'enum', 'description'],
  number: ['type', 'minimum', 'maximum', 'enum', 'description'],
  integer: ['type', 'minimum', 'maximum', 'enum', 'description'],
  boolean: ['type', 'description'],
  null: ['type', 'description'],
};
const plain = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const bytes = (v: unknown) => new TextEncoder().encode(canonicalJson(v)).length;
/** JSON Schema string lengths count Unicode code points, not UTF-16 code units. */
const codePoints = (text: string) => {
  let n = 0;
  for (const _ of text) n++;
  return n;
};
const count = (v: unknown, max: number) =>
  Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;

function schemaProblems(s: unknown, path: string, depth: number, out: string[]) {
  if (depth > OPERATION_LIMITS.depth) return void out.push(`${path}: schema is nested too deeply`);
  // Own keys only: a type such as "constructor" or "__proto__" must not reach Object.prototype.
  if (!plain(s) || typeof s.type !== 'string' || !Object.hasOwn(KEYS, s.type))
    return void out.push(`${path}: unsupported schema type`);
  const unknown = Object.keys(s).filter((k) => !KEYS[s.type as string].includes(k));
  if (unknown.length) return void out.push(`${path}: unsupported keyword ${unknown[0]}`);
  if (
    s.description !== undefined &&
    (typeof s.description !== 'string' || codePoints(s.description) > OPERATION_LIMITS.text)
  )
    out.push(`${path}: invalid description`);
  switch (s.type) {
    case 'object': {
      if (s.additionalProperties !== false)
        out.push(`${path}: objects must set additionalProperties: false`);
      if (!plain(s.properties)) return void out.push(`${path}: properties must be an object`);
      const names = Object.keys(s.properties);
      if (names.length > OPERATION_LIMITS.properties) out.push(`${path}: too many properties`);
      for (const name of names) {
        if (!PROPERTY.test(name))
          out.push(`${path}: invalid property name ${JSON.stringify(name)}`);
        else schemaProblems(s.properties[name], `${path}.${name}`, depth + 1, out);
      }
      if (s.required !== undefined) {
        const r = s.required;
        if (
          !Array.isArray(r) ||
          new Set(r).size !== r.length ||
          !r.every((x) => typeof x === 'string' && names.includes(x))
        )
          out.push(`${path}: required must list declared properties once`);
      }
      return;
    }
    case 'array':
      if (!count(s.maxItems, OPERATION_LIMITS.maxItems))
        out.push(`${path}: maxItems is required (0-${OPERATION_LIMITS.maxItems})`);
      if (
        s.minItems !== undefined &&
        (!count(s.minItems, OPERATION_LIMITS.maxItems) ||
          (s.minItems as number) > (s.maxItems as number))
      )
        out.push(`${path}: invalid minItems`);
      return schemaProblems(s.items, `${path}[]`, depth + 1, out);
    case 'string':
      if (!count(s.maxLength, OPERATION_LIMITS.maxLength))
        out.push(`${path}: maxLength is required (0-${OPERATION_LIMITS.maxLength})`);
      if (
        s.minLength !== undefined &&
        (!count(s.minLength, OPERATION_LIMITS.maxLength) ||
          (s.minLength as number) > (s.maxLength as number))
      )
        out.push(`${path}: invalid minLength`);
      return enumProblems(
        s.enum,
        (v) => typeof v === 'string' && codePoints(v) <= (s.maxLength as number),
        path,
        out,
      );
    case 'number':
    case 'integer':
      for (const k of ['minimum', 'maximum'] as const)
        if (s[k] !== undefined && (typeof s[k] !== 'number' || !Number.isFinite(s[k])))
          out.push(`${path}: invalid ${k}`);
      if (typeof s.minimum === 'number' && typeof s.maximum === 'number' && s.minimum > s.maximum)
        out.push(`${path}: minimum exceeds maximum`);
      return enumProblems(
        s.enum,
        (v) =>
          typeof v === 'number' &&
          Number.isFinite(v) &&
          (s.type === 'number' || Number.isSafeInteger(v)),
        path,
        out,
      );
  }
}
function enumProblems(values: unknown, ok: (v: unknown) => boolean, path: string, out: string[]) {
  if (values === undefined) return;
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.length > OPERATION_LIMITS.enumValues ||
    new Set(values).size !== values.length ||
    !values.every(ok)
  )
    out.push(`${path}: invalid enum`);
}

/** Problems with the add-on declaration in a manifest (empty when it is valid). */
export function operationDeclarationProblems(addon: unknown): string[] {
  const out: string[] = [];
  if (!plain(addon) || Object.keys(addon).some((k) => k !== 'version' && k !== 'declarations'))
    return ['operations add-on must be { version, declarations }'];
  if (addon.version !== OPERATIONS_ADDON)
    return [`unsupported operations add-on version ${String(addon.version)}`];
  const list = addon.declarations;
  if (!Array.isArray(list) || !list.length || list.length > OPERATION_LIMITS.operations)
    return [`declarations must list 1-${OPERATION_LIMITS.operations} operations`];
  if (bytes(list) > OPERATION_LIMITS.declarationBytes)
    return ['operation declarations are too large'];
  const seen = new Set<string>();
  list.forEach((d, i) => {
    const at = `operations[${i}]`;
    if (
      !plain(d) ||
      Object.keys(d).some((k) => !['id', 'version', 'title', 'inputSchema'].includes(k))
    )
      return void out.push(`${at}: must be { id, version, title, inputSchema }`);
    if (typeof d.id !== 'string' || !ID.test(d.id)) out.push(`${at}: invalid id`);
    else if (seen.has(d.id)) out.push(`${at}: duplicate id ${d.id}`);
    else seen.add(d.id);
    if (typeof d.version !== 'string' || !VERSION.test(d.version))
      out.push(`${at}: invalid version`);
    if (typeof d.title !== 'string' || !d.title || codePoints(d.title) > OPERATION_LIMITS.text)
      out.push(`${at}: invalid title`);
    const s = d.inputSchema;
    if (!plain(s) || s.type !== 'object')
      out.push(`${at}.inputSchema: input must be an object schema`);
    else schemaProblems(s, `${at}.inputSchema`, 1, out);
  });
  return out;
}

/** Checked, frozen copy of manifest add-ons. Throws with the first problem. */
export function parseAddons(input: unknown): ManifestAddons {
  if (!plain(input) || Object.keys(input).some((k) => k !== 'operations'))
    throw new Error('Unsupported add-ons');
  if (input.operations === undefined) throw new Error('Unsupported add-ons');
  const problems = operationDeclarationProblems(input.operations);
  if (problems.length) throw new Error(`Invalid operations add-on: ${problems[0]}`);
  const copy = JSON.parse(canonicalJson(input)) as ManifestAddons;
  return deepFreeze(copy);
}
function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const child of Object.values(v)) deepFreeze(child);
    Object.freeze(v);
  }
  return v;
}

function inputProblems(s: OperationSchema, v: unknown, path: string, out: string[]) {
  switch (s.type) {
    case 'object': {
      if (!plain(v)) return void out.push(`${path}: expected an object`);
      for (const k of Object.keys(v))
        if (!Object.hasOwn(s.properties, k)) out.push(`${path}: unknown property ${k}`);
      for (const k of s.required ?? []) if (!Object.hasOwn(v, k)) out.push(`${path}: missing ${k}`);
      for (const [k, child] of Object.entries(s.properties))
        if (Object.hasOwn(v, k)) inputProblems(child, v[k], `${path}.${k}`, out);
      return;
    }
    case 'array':
      if (!Array.isArray(v)) return void out.push(`${path}: expected an array`);
      if (v.length > s.maxItems || v.length < (s.minItems ?? 0))
        out.push(`${path}: wrong number of items`);
      return v.forEach((x, i) => inputProblems(s.items, x, `${path}[${i}]`, out));
    case 'string':
      if (typeof v !== 'string') return void out.push(`${path}: expected a string`);
      if (codePoints(v) > s.maxLength || codePoints(v) < (s.minLength ?? 0))
        out.push(`${path}: wrong length`);
      if (s.enum && !s.enum.includes(v)) out.push(`${path}: not an allowed value`);
      return;
    case 'number':
    case 'integer':
      if (
        typeof v !== 'number' ||
        !Number.isFinite(v) ||
        (s.type === 'integer' && !Number.isSafeInteger(v))
      )
        return void out.push(
          `${path}: expected ${s.type === 'integer' ? 'an integer' : 'a number'}`,
        );
      if ((s.minimum !== undefined && v < s.minimum) || (s.maximum !== undefined && v > s.maximum))
        out.push(`${path}: out of range`);
      if (s.enum && !s.enum.includes(v)) out.push(`${path}: not an allowed value`);
      return;
    case 'boolean':
      if (typeof v !== 'boolean') out.push(`${path}: expected a boolean`);
      return;
    case 'null':
      if (v !== null) out.push(`${path}: expected null`);
  }
}

/**
 * Problems with one input for one declared operation (empty when the data fits the schema).
 * `operation` must name a declaration by exact id and version.
 */
export function operationInputProblems(
  declarations: readonly OperationDeclaration[],
  operation: Readonly<{ id: string; version: string }>,
  input: unknown,
): string[] {
  const d = declarations.find((x) => x.id === operation?.id);
  if (!d) return [`undeclared operation ${String(operation?.id)}`];
  if (d.version !== operation.version)
    return [`operation ${d.id} is ${d.version}, not ${String(operation.version)}`];
  let size: number;
  try {
    size = bytes(input);
  } catch {
    return ['input is not JSON data'];
  }
  if (size > OPERATION_LIMITS.inputBytes) return ['input is too large'];
  const out: string[] = [];
  inputProblems(d.inputSchema, input, 'input', out);
  return out;
}
