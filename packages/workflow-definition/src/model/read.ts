import { owdCollections, owdElementKinds } from './ids';
import { type OwdDefinition } from './types';

export const owdDefinitionLimits = { bytes: 4_000_000, depth: 32, entries: 10_000 } as const;
const plain = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
/** Data descriptors only, no cycles, bounded depth and entries: reading never runs code. */
function isJson(value: unknown, depth = 0, seen = new Set<object>()): boolean {
  if (depth > owdDefinitionLimits.depth) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  if (!Array.isArray(value) && !plain(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value),
    keys = Reflect.ownKeys(descriptors);
  if (keys.length > owdDefinitionLimits.entries + 1) return false;
  seen.add(value);
  const ok = keys.every((key) => {
    if (Array.isArray(value) && key === 'length') return true;
    const d = descriptors[key as string];
    return (
      typeof key === 'string' &&
      !['__proto__', 'prototype', 'constructor'].includes(key) &&
      d.enumerable &&
      'value' in d &&
      isJson(d.value, depth + 1, seen)
    );
  });
  seen.delete(value);
  return ok && (!Array.isArray(value) || Object.keys(value).length === value.length);
}
const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');
/**
 * Why a value cannot be opened as an OWD format 1 definition, or undefined when it can. This is
 * only what the Editor needs to project and edit it: element lists of records with string IDs and
 * reference fields of the right JSON type. Incomplete or inconsistent content (empty names, missing
 * references, cycles) opens and is reported by the diagnostics instead.
 */
export function owdDefinitionProblem(value: unknown): string | undefined {
  if (!isJson(value) || !plain(value)) return 'not JSON data within the size limits';
  if (new TextEncoder().encode(JSON.stringify(value)).length > owdDefinitionLimits.bytes)
    return 'larger than 4 MB';
  if (value.format !== 1) return 'format is not 1';
  for (const key of ['id', 'version', 'title', 'purpose'])
    if (typeof value[key] !== 'string') return `${key} is not a string`;
  for (const kind of owdElementKinds) {
    const key = owdCollections[kind],
      items = value[key];
    if (items === undefined && !['phases', 'deliverables', 'acceptance'].includes(key)) continue;
    if (!Array.isArray(items)) return `${key} is not a list`;
    for (const [i, item] of items.entries()) {
      const at = `${key}[${i}]`;
      if (!plain(item) || typeof item.id !== 'string') return `${at} has no string id`;
      const need = (field: string, ok: (v: unknown) => boolean, optional = false) =>
        (optional && item[field] === undefined) || ok(item[field])
          ? undefined
          : `${at}.${field} has the wrong type`;
      const problem =
        kind === 'phase'
          ? (need('after', strings) ?? need('deliverables', strings) ?? need('acceptance', strings))
          : kind === 'section'
            ? need('phases', strings)
            : kind === 'deliverable'
              ? (need('outline', Array.isArray) ?? need('uses', strings, true))
              : kind === 'acceptance'
                ? (need('target', (v) => typeof v === 'string') ??
                  need('rules', strings, true) ??
                  need('approvers', (v) => plain(v) && strings(v.roles), true))
                : kind === 'item'
                  ? need('parent', (v) => typeof v === 'string', true)
                  : kind === 'rule'
                    ? (need('from', (v) => typeof v === 'string', true) ??
                      need('to', strings, true) ??
                      need('of', (v) => typeof v === 'string', true) ??
                      need('by', strings, true))
                    : undefined;
      if (problem) return problem;
    }
  }
  return undefined;
}
export const isOwdDefinition = (value: unknown): value is OwdDefinition =>
  owdDefinitionProblem(value) === undefined;
/** Throws the reason when a value cannot be opened as an OWD format 1 definition. */
export function readOwdDefinition(value: unknown): OwdDefinition {
  const problem = owdDefinitionProblem(value);
  if (problem) throw new Error(`Not a readable workflow definition (format 1): ${problem}`);
  return value as OwdDefinition;
}
