import { record, stableId } from '@editor-platform/reuse-core';
import { array, checkData, fields, finite, identifier, object, reject, unique, same } from './data';
import {
  reactUiLimits,
  type ReactValueSchema,
  type ReactFieldSchema,
  type JsonValue,
} from './types';

export function checkValueSchema(
  raw: unknown,
  path: string,
  depth = 0,
): asserts raw is ReactValueSchema {
  if (depth > reactUiLimits.schemaDepth)
    reject('schema-depth', path, 'Value schema exceeds nesting limit');
  const s = object(raw, path);
  if (s.nullable !== undefined && typeof s.nullable !== 'boolean')
    reject('schema', path, 'Invalid nullable flag');
  switch (s.type) {
    case 'string':
      fields(s, ['type'], ['nullable', 'maxLength'], path);
      if (s.maxLength !== undefined) finite(s.maxLength, path, 0, reactUiLimits.bytes, true);
      break;
    case 'number':
      fields(s, ['type'], ['nullable', 'minimum', 'maximum'], path);
      for (const k of ['minimum', 'maximum'])
        if (s[k] !== undefined) finite(s[k], `${path}.${k}`, -1e12, 1e12);
      if (
        s.minimum !== undefined &&
        s.maximum !== undefined &&
        Number(s.minimum) > Number(s.maximum)
      )
        reject('schema', path, 'Minimum exceeds maximum');
      break;
    case 'boolean':
    case 'asset':
      fields(s, ['type'], ['nullable'], path);
      break;
    case 'enum':
      fields(s, ['type', 'values'], ['nullable'], path);
      {
        const values = array(s.values, path, reactUiLimits.fields);
        if (!values.length || values.some((v) => typeof v !== 'string' || v.length > 1000))
          reject('schema', path, 'Expected nonempty string enum');
        unique(values, path);
      }
      break;
    case 'object':
      fields(s, ['type', 'fields'], ['nullable'], path);
      checkFieldMap(s.fields, `${path}.fields`, depth + 1);
      break;
    case 'array':
      fields(s, ['type', 'items', 'maxItems'], ['nullable'], path);
      finite(s.maxItems, path, 0, 2000, true);
      checkValueSchema(s.items, `${path}.items`, depth + 1);
      break;
    default:
      reject(
        'schema-type',
        path,
        'Unsupported prop value type; functions/ReactNode belong to event/slot contracts',
      );
  }
}
export function checkFieldMap(
  raw: unknown,
  path: string,
  depth = 0,
): asserts raw is Record<string, ReactFieldSchema> {
  const map = object(raw, path);
  if (Object.keys(map).length > reactUiLimits.fields)
    reject('schema-limit', path, 'Too many fields');
  for (const [key, field] of Object.entries(map)) {
    identifier(key, `${path}.${key}`);
    const f = object(field, `${path}.${key}`);
    fields(f, ['schema', 'required'], ['default'], `${path}.${key}`);
    if (typeof f.required !== 'boolean')
      reject('schema', `${path}.${key}`, 'Expected required flag');
    if (depth > 0 && Object.hasOwn(f, 'default'))
      reject('schema-default', `${path}.${key}`, 'Nested object fields do not synthesize defaults');
    checkValueSchema(f.schema, `${path}.${key}.schema`, depth);
    if (Object.hasOwn(f, 'default') && !valueMatches(f.schema, f.default))
      reject('prop-default', `${path}.${key}`, 'Default does not match its declared schema');
  }
}
export function valueMatches(schema: ReactValueSchema, value: unknown): value is JsonValue {
  try {
    checkData(value);
  } catch {
    return false;
  }
  return matches(schema, value);
}
function matches(schema: ReactValueSchema, value: unknown): value is JsonValue {
  if (value === null) return schema.nullable === true;
  switch (schema.type) {
    case 'string':
      return typeof value === 'string' && value.length <= (schema.maxLength ?? 100000);
    case 'number':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= (schema.minimum ?? -1e12) &&
        value <= (schema.maximum ?? 1e12)
      );
    case 'boolean':
      return typeof value === 'boolean';
    case 'asset':
      return stableId(value);
    case 'enum':
      return typeof value === 'string' && schema.values.includes(value);
    case 'array':
      return (
        Array.isArray(value) &&
        value.length <= schema.maxItems &&
        value.every((v) => matches(schema.items, v))
      );
    case 'object':
      return (
        record(value) &&
        Object.keys(value).every((key) => Object.hasOwn(schema.fields, key)) &&
        Object.entries(schema.fields).every(([key, f]) =>
          Object.hasOwn(value, key) ? matches(f.schema, value[key]) : !f.required,
        )
      );
  }
}
/** Assignability across nullable, enum, numeric bounds, objects and arrays; no type string evaluation. */
export function schemaAssignable(source: ReactValueSchema, target: ReactValueSchema): boolean {
  if (source.nullable && !target.nullable) return false;
  if (source.type === 'enum' && target.type === 'string')
    return source.values.every((v) => v.length <= (target.maxLength ?? 100000));
  if (source.type !== target.type) return false;
  switch (source.type) {
    case 'string':
      return (
        target.type === 'string' && (source.maxLength ?? 100000) <= (target.maxLength ?? 100000)
      );
    case 'number':
      return (
        target.type === 'number' &&
        (source.minimum ?? -1e12) >= (target.minimum ?? -1e12) &&
        (source.maximum ?? 1e12) <= (target.maximum ?? 1e12)
      );
    case 'boolean':
    case 'asset':
      return true;
    case 'enum':
      return target.type === 'enum' && source.values.every((v) => target.values.includes(v));
    case 'array':
      return (
        target.type === 'array' &&
        source.maxItems <= target.maxItems &&
        schemaAssignable(source.items, target.items)
      );
    case 'object':
      return (
        target.type === 'object' &&
        Object.keys(source.fields).every((key) => Object.hasOwn(target.fields, key)) &&
        Object.entries(target.fields).every(([key, f]) => {
          const input = source.fields[key];
          return input
            ? (!f.required || input.required) && schemaAssignable(input.schema, f.schema)
            : !f.required;
        })
      );
  }
}
export function schemaAtPath(
  source: ReactValueSchema,
  path: string[],
): ReactValueSchema | undefined {
  let current = source;
  for (const key of path) {
    // Nullable/optional traversal would require an expression/fallback engine; unsupported in W1.
    if (
      current.type !== 'object' ||
      current.nullable ||
      !Object.hasOwn(current.fields, key) ||
      !current.fields[key].required
    )
      return;
    current = current.fields[key].schema;
  }
  return current;
}
export function sameSchema(a: ReactValueSchema, b: ReactValueSchema): boolean {
  return same(a, b);
}
