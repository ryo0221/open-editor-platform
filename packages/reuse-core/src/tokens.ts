import { clone, deepFreeze, isDeepFrozen } from '@editor-platform/artifact-core';
import { assertReuseJson, record, rejectReuse, reuseLimits, stableId } from './contracts';

export const tokenTypes = ['color', 'dimension', 'fontFamily', 'fontWeight', 'number'] as const;
export type TokenType = (typeof tokenTypes)[number];
export interface TokenColor {
  colorSpace: 'srgb';
  components: [number, number, number];
  alpha: number;
}
export interface TokenDimension {
  value: number;
  unit: 'px' | 'pt';
}
export type TokenLiteral = TokenColor | TokenDimension | string | string[] | number;
export interface TokenAlias {
  alias: string;
}
export interface DesignToken {
  type: TokenType;
  value: TokenLiteral | TokenAlias;
  modes?: Record<string, TokenLiteral | TokenAlias>;
  description?: string;
}
export interface TokenSet {
  schemaVersion: 1;
  modes: string[];
  defaultMode: string;
  tokens: Record<string, DesignToken>;
}
export interface TokenContext {
  instanceMode?: string;
  artifactMode?: string;
}
export interface ResolvedToken {
  type: TokenType;
  value: TokenLiteral;
  source: string[];
}
export interface ResolvedTokens {
  mode: string;
  tokens: Record<string, ResolvedToken>;
}
export const tokenId = (id: unknown): id is string =>
  typeof id === 'string' &&
  id.length <= 160 &&
  /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)*$/.test(id) &&
  id.split('.').every((part) => part !== 'prototype' && part !== 'constructor');
export const isAlias = (v: unknown): v is TokenAlias => record(v) && Object.hasOwn(v, 'alias');
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const family = (v: unknown): v is string =>
  typeof v === 'string' &&
  !!v.trim() &&
  v.length <= 128 &&
  !/[;<>{}]/.test(v) &&
  ![...v].some((c) => c.charCodeAt(0) < 32);
export function validateTokenValue(
  type: TokenType,
  value: unknown,
  path: string,
): asserts value is TokenLiteral | TokenAlias {
  if (isAlias(value)) {
    if (Object.keys(value).length !== 1 || !tokenId(value.alias))
      rejectReuse('token-alias', 'Invalid token alias', { path });
    return;
  }
  let valid = false;
  if (type === 'color')
    valid =
      record(value) &&
      value.colorSpace === 'srgb' &&
      Array.isArray(value.components) &&
      value.components.length === 3 &&
      value.components.every((v) => finite(v) && v >= 0 && v <= 1) &&
      finite(value.alpha) &&
      value.alpha >= 0 &&
      value.alpha <= 1 &&
      Object.keys(value).every((k) => ['colorSpace', 'components', 'alpha'].includes(k));
  if (type === 'dimension')
    valid =
      record(value) &&
      finite(value.value) &&
      Math.abs(value.value) <= 100000 &&
      ['px', 'pt'].includes(String(value.unit)) &&
      Object.keys(value).length === 2;
  if (type === 'fontFamily')
    valid =
      family(value) ||
      (Array.isArray(value) && value.length > 0 && value.length <= 8 && value.every(family));
  if (type === 'fontWeight') valid = finite(value) && value >= 1 && value <= 1000;
  if (type === 'number') valid = finite(value) && Math.abs(value) <= 100000;
  if (!valid) rejectReuse('token-value', 'Invalid or unsupported ' + type + ' value', { path });
}
function checkTokenSet(raw: unknown): asserts raw is TokenSet {
  assertReuseJson(raw);
  if (
    !record(raw) ||
    raw.schemaVersion !== 1 ||
    !Array.isArray(raw.modes) ||
    !raw.modes.length ||
    raw.modes.length > reuseLimits.modes ||
    raw.modes.some((m) => !stableId(m)) ||
    new Set(raw.modes).size !== raw.modes.length ||
    !raw.modes.includes(raw.defaultMode) ||
    !record(raw.tokens) ||
    Object.keys(raw.tokens).length > reuseLimits.tokens
  )
    rejectReuse('token-schema', 'Unsupported token set, modes or token count');
  for (const [id, token] of Object.entries(raw.tokens)) {
    if (
      !tokenId(id) ||
      !record(token) ||
      !tokenTypes.includes(token.type as TokenType) ||
      !Object.hasOwn(token, 'value') ||
      (token.description !== undefined && typeof token.description !== 'string')
    )
      rejectReuse('token-schema', 'Invalid token identity/type', { path: id });
    validateTokenValue(token.type as TokenType, token.value, id);
    if (token.modes !== undefined) {
      if (!record(token.modes))
        rejectReuse('token-mode', 'Mode values must be an object', { path: id });
      for (const [mode, value] of Object.entries(token.modes)) {
        if (!raw.modes.includes(mode))
          rejectReuse('token-mode', 'Token uses an undeclared mode', {
            path: id + '.modes.' + mode,
          });
        validateTokenValue(token.type as TokenType, value, id + '.modes.' + mode);
      }
    }
  }
}
function resolveMode(set: TokenSet, mode: string): ResolvedTokens {
  if (!set.modes.includes(mode))
    rejectReuse('token-mode', 'The selected mode does not exist', { path: mode });
  const output = Object.create(null) as Record<string, ResolvedToken>,
    active = new Set<string>();
  const resolve = (id: string): ResolvedToken => {
    if (output[id]) return output[id];
    const token = set.tokens[id];
    if (!token) rejectReuse('token-missing', 'Alias target is missing', { path: id });
    if (active.has(id)) rejectReuse('token-cycle', 'Cyclic token alias', { path: id });
    if (active.size >= reuseLimits.aliasDepth)
      rejectReuse('token-depth', 'Token alias chain exceeds its budget', { path: id });
    active.add(id);
    const value = Object.hasOwn(token.modes ?? {}, mode) ? token.modes![mode] : token.value;
    let resolved: ResolvedToken;
    if (isAlias(value)) {
      const target = resolve(value.alias);
      if (target.type !== token.type)
        rejectReuse('token-type', 'Alias target has a different type', { path: id });
      resolved = { type: token.type, value: target.value, source: [id, ...target.source] };
    } else resolved = { type: token.type, value: clone(value), source: [id] };
    if (resolved.source.length > reuseLimits.aliasDepth)
      rejectReuse('token-depth', 'Token alias chain exceeds its budget', { path: id });
    active.delete(id);
    output[id] = resolved;
    return resolved;
  };
  Object.keys(set.tokens).sort().forEach(resolve);
  return { mode, tokens: output };
}
const validatedSets = new WeakMap<object, TokenSet>();
const checkedSets = new WeakSet<object>();
const resolvedModes = new WeakMap<object, Map<string, ResolvedTokens>>();
/** Validate an unselected mode without allocating its literal copies or source
 * paths. Hidden aliases still have the same type/cycle/missing/depth checks. */
function checkModeAliases(set: TokenSet, mode: string) {
  const depths = new Map<string, number>(),
    active = new Set<string>();
  const visit = (id: string): number => {
    const known = depths.get(id);
    if (known !== undefined) return known;
    const token = set.tokens[id];
    if (!token) rejectReuse('token-missing', 'Alias target is missing', { path: id });
    if (active.has(id)) rejectReuse('token-cycle', 'Cyclic token alias', { path: id });
    if (active.size >= reuseLimits.aliasDepth)
      rejectReuse('token-depth', 'Token alias chain exceeds its budget', { path: id });
    active.add(id);
    const value = Object.hasOwn(token.modes ?? {}, mode) ? token.modes![mode] : token.value;
    let depth = 1;
    if (isAlias(value)) {
      depth += visit(value.alias);
      if (set.tokens[value.alias].type !== token.type)
        rejectReuse('token-type', 'Alias target has a different type', { path: id });
    }
    if (depth > reuseLimits.aliasDepth)
      rejectReuse('token-depth', 'Token alias chain exceeds its budget', { path: id });
    active.delete(id);
    depths.set(id, depth);
    return depth;
  };
  Object.keys(set.tokens).sort().forEach(visit);
}
function checkedSet(raw: unknown): TokenSet {
  if (raw && typeof raw === 'object' && checkedSets.has(raw)) return raw as TokenSet;
  checkTokenSet(raw);
  // Every mode is validated even when the caller requests only one mode.
  raw.modes.forEach((mode) => checkModeAliases(raw, mode));
  if (isDeepFrozen(raw)) checkedSets.add(raw);
  return raw;
}
export function validateTokenSet(raw: unknown): TokenSet {
  if (raw && typeof raw === 'object' && validatedSets.has(raw)) return validatedSets.get(raw)!;
  const checked = checkedSet(raw);
  const set = deepFreeze(clone(checked));
  if (isDeepFrozen(checked)) validatedSets.set(checked, set);
  validatedSets.set(set, set);
  checkedSets.add(set);
  return set;
}
export function resolveTokens(raw: unknown, context: TokenContext = {}): ResolvedTokens {
  const checked = !!raw && typeof raw === 'object' && checkedSets.has(raw);
  if (!checked) checkTokenSet(raw);
  const set = raw as TokenSet;
  const mode = context.instanceMode ?? context.artifactMode ?? set.defaultMode;
  let modes = resolvedModes.get(set);
  const cached = modes?.get(mode);
  if (cached) return cached;
  let selected: ResolvedTokens | undefined;
  if (!checked)
    // The selected mode's resolution also validates its aliases. Every other
    // mode is still checked, in declaration order, before returning or caching.
    for (const candidate of set.modes)
      if (candidate === mode) selected = resolveMode(set, mode);
      else checkModeAliases(set, candidate);
  const resolved = deepFreeze(selected ?? resolveMode(set, mode));
  if (isDeepFrozen(set)) {
    checkedSets.add(set);
    if (!modes) resolvedModes.set(set, (modes = new Map()));
    modes.set(mode, resolved);
  }
  return resolved;
}
export function colorHex(value: TokenColor): string {
  const hex = (n: number) =>
    Math.round(n * 255)
      .toString(16)
      .padStart(2, '0');
  return '#' + value.components.map(hex).join('') + (value.alpha === 1 ? '' : hex(value.alpha));
}
export function dimensionIn(value: TokenDimension, unit: 'px' | 'pt'): number {
  return value.unit === unit ? value.value : value.value * (unit === 'pt' ? 3 / 4 : 4 / 3);
}
