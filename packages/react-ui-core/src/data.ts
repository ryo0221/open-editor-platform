import { assertReuseJson, record, reuseHash, stableId } from '@editor-platform/reuse-core';
import { reactUiLimits, type ReactUiDiagnostic } from './types';

export class ReactUiError extends Error {
  constructor(readonly diagnostics: ReactUiDiagnostic[]) {
    super(diagnostics.map((d) => `${d.path}: ${d.message}`).join('\n'));
    this.name = 'ReactUiError';
  }
}
export function diagnostic(code: string, path: string, message: string): ReactUiDiagnostic {
  return {
    code,
    severity: 'error',
    path,
    message,
    recovery:
      'Correct the addressed registration, input or dependency and prepare again; keep the saved composition.',
  };
}
export function reject(code: string, path: string, message: string): never {
  throw new ReactUiError([diagnostic(code, path, message)]);
}
/** Check descriptors BEFORE reading values, hashing, cloning or invoking serialization hooks. */
export function checkData(raw: unknown): void {
  let count = 0;
  const active = new Set<object>();
  const walk = (value: unknown, path: string, depth: number) => {
    if (++count > reactUiLimits.values || depth > reactUiLimits.jsonDepth)
      reject('data-limit', path, 'JSON value/depth limit exceeded');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (!value || typeof value !== 'object' || (!Array.isArray(value) && !record(value)))
      reject('data-json', path, 'Only plain, finite JSON data is supported');
    if (active.has(value)) reject('data-cycle', path, 'Cyclic data is not serializable');
    active.add(value);
    const keys = Reflect.ownKeys(value);
    if (Array.isArray(value) && keys.length !== value.length + 1)
      reject('data-json', path, 'Sparse arrays and named array properties are unsupported');
    for (const key of keys) {
      if (Array.isArray(value) && key === 'length') continue;
      if (
        typeof key !== 'string' ||
        ['__proto__', 'prototype', 'constructor', 'toJSON'].includes(key)
      )
        reject('data-key', path, 'Reserved or symbol property');
      const desc = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in desc) || !desc.enumerable)
        reject('data-json', `${path}.${key}`, 'Accessors and hidden properties are unsupported');
      if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key))
        reject('data-json', path, 'Named array properties are unsupported');
      walk(desc.value, `${path}.${key}`, depth + 1);
    }
    active.delete(value);
  };
  walk(raw, '$', 0);
  try {
    assertReuseJson(raw, reactUiLimits.bytes);
  } catch {
    reject('data-limit', '$', 'JSON byte/value budget exceeded');
  }
}
export function object(raw: unknown, path: string): Record<string, unknown> {
  if (!record(raw)) reject('schema', path, 'Expected a plain object');
  return raw;
}
export function fields(
  raw: Record<string, unknown>,
  required: string[],
  optional: string[],
  path: string,
): void {
  if (
    required.some((key) => !Object.hasOwn(raw, key)) ||
    Object.keys(raw).some((key) => !required.includes(key) && !optional.includes(key))
  )
    reject('schema-fields', path, 'Missing or unsupported field');
}
export function array(raw: unknown, path: string, maximum: number): unknown[] {
  if (!Array.isArray(raw) || raw.length > maximum)
    reject('schema-limit', path, 'Expected a bounded array');
  return raw;
}
export function id(raw: unknown, path: string): asserts raw is string {
  if (!stableId(raw)) reject('identity', path, 'Expected a stable ID');
}
const reservedNames = new Set([
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'let',
  'static',
  'implements',
  'interface',
  'package',
  'private',
  'protected',
  'public',
  'await',
  'arguments',
  'eval',
  '__proto__',
  'prototype',
  'constructor',
  ...Object.getOwnPropertyNames(Object.prototype),
]);
export function identifier(raw: unknown, path: string): asserts raw is string {
  if (
    typeof raw !== 'string' ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(raw) ||
    reservedNames.has(raw)
  )
    reject('identifier', path, 'Expected a supported public prop/export identifier');
}
export function hash(raw: unknown, path: string): void {
  if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/.test(raw))
    reject('hash', path, 'Expected SHA-256');
}
export function version(raw: unknown, path: string, packageVersion = false): void {
  const pattern = packageVersion
    ? /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
    : /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
  if (
    typeof raw !== 'string' ||
    !pattern.test(raw) ||
    ['latest', 'next', 'main', 'head', '*'].includes(raw.toLowerCase())
  )
    reject('version', path, 'An exact immutable version is required');
}
export function finite(
  raw: unknown,
  path: string,
  min: number,
  max: number,
  integer = false,
): asserts raw is number {
  if (
    typeof raw !== 'number' ||
    !Number.isFinite(raw) ||
    raw < min ||
    raw > max ||
    (integer && !Number.isSafeInteger(raw))
  )
    reject('number', path, 'Number exceeds the supported range');
}
export function unique(values: readonly unknown[], path: string): void {
  if (new Set(values).size !== values.length)
    reject('duplicate', path, 'Duplicate identity or entry');
}
export const same = (a: unknown, b: unknown) => reuseHash(a) === reuseHash(b);
