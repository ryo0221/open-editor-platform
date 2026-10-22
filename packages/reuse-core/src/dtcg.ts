import { clone } from '@editor-platform/artifact-core';
import {
  assertReuseJson,
  record,
  rejectReuse,
  ReuseError,
  reuseLimits,
  type ReuseDiagnostic,
} from './contracts';
import {
  colorHex,
  dimensionIn,
  isAlias,
  tokenId,
  tokenTypes,
  validateTokenSet,
  validateTokenValue,
  type DesignToken,
  type TokenColor,
  type TokenDimension,
  type TokenSet,
  type TokenType,
} from './tokens';

export interface DtcgResult {
  tokens?: TokenSet;
  diagnostics: ReuseDiagnostic[];
}
const diag = (
  code: string,
  path: string,
  message: string,
  severity: ReuseDiagnostic['severity'] = 'error',
): ReuseDiagnostic => ({
  code,
  severity,
  address: { path },
  message,
  recovery: 'Use the documented DTCG 2025.10 exchange subset or keep the native token set.',
});
export const dtcgSubset = Object.freeze({
  version: '2025.10',
  format: [
    'srgb-color',
    'px-dimension',
    'fontFamily',
    'numeric-fontWeight',
    'number',
    'whole-token-alias',
    'nested-groups',
    'inherited-type',
  ],
  unsupported: [
    'JSON-Pointer-$ref',
    'group-$extends',
    '$root',
    'composite-types',
    'non-srgb-color',
    'none-color-components',
    'rem-dimension',
    'extensions',
    'external-resolver-sources',
    'resolver-modifiers',
  ],
  resolver: 'inline-sets-in-explicit-order',
});
function parse(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  if (new TextEncoder().encode(input).length > reuseLimits.bytes)
    rejectReuse('reuse-limit', 'DTCG document exceeds byte budget');
  try {
    return JSON.parse(input);
  } catch {
    rejectReuse('dtcg-json', 'Invalid DTCG JSON');
  }
}
/** No file/network access. Unsupported constructs produce addressed errors, never silent loss. */
export function importDtcg(input: unknown): DtcgResult {
  const diagnostics: ReuseDiagnostic[] = [];
  try {
    const raw = parse(input);
    assertReuseJson(raw);
    if (!record(raw)) rejectReuse('dtcg-schema', 'DTCG format root must be an object');
    if ('resolutionOrder' in raw || 'modifiers' in raw)
      rejectReuse('dtcg-resolver', 'Use the resolver importer for resolver documents');
    const collected = new Map<string, { type: unknown; value: unknown; description?: string }>();
    const walk = (
      group: Record<string, unknown>,
      path: string[],
      inherited: unknown,
      depth: number,
    ) => {
      if (depth > reuseLimits.aliasDepth)
        rejectReuse('dtcg-depth', 'DTCG group nesting exceeds the budget');
      const hasValue = Object.hasOwn(group, '$value'),
        type = group.$type ?? inherited;
      for (const key of Object.keys(group)) {
        if (
          key.startsWith('$') &&
          !['$type', '$description', ...(hasValue ? ['$value'] : [])].includes(key)
        )
          diagnostics.push(
            diag('dtcg-unsupported', [...path, key].join('.'), 'Unsupported DTCG property: ' + key),
          );
      }
      if (group.$description !== undefined && typeof group.$description !== 'string')
        diagnostics.push(diag('dtcg-description', path.join('.'), 'Description must be a string'));
      if (hasValue) {
        const id = path.join('.');
        if (!tokenId(id))
          diagnostics.push(
            diag('dtcg-id', id, 'Token path is outside the portable identifier subset'),
          );
        if (Object.keys(group).some((key) => !key.startsWith('$')))
          diagnostics.push(diag('dtcg-schema', id, 'A token cannot also contain child tokens'));
        collected.set(id, {
          type,
          value: group.$value,
          description: typeof group.$description === 'string' ? group.$description : undefined,
        });
      } else
        for (const [key, value] of Object.entries(group)) {
          if (key.startsWith('$')) continue;
          if (!tokenId(key) || key.includes('.'))
            diagnostics.push(
              diag('dtcg-id', [...path, key].join('.'), 'Unsupported group/token name'),
            );
          if (!record(value))
            diagnostics.push(
              diag(
                'dtcg-schema',
                [...path, key].join('.'),
                'Group members must be tokens or groups',
              ),
            );
          else walk(value, [...path, key], type, depth + 1);
        }
      if (collected.size > reuseLimits.tokens) rejectReuse('reuse-limit', 'Too many design tokens');
    };
    walk(raw, [], undefined, 0);
    const tokens: TokenSet['tokens'] = Object.create(null),
      active = new Set<string>();
    const convert = (id: string): DesignToken => {
      if (tokens[id]) return tokens[id];
      const source = collected.get(id);
      if (!source) rejectReuse('token-missing', 'Alias target is missing', { path: id });
      if (active.has(id)) rejectReuse('token-cycle', 'Cyclic DTCG alias', { path: id });
      if (active.size >= reuseLimits.aliasDepth)
        rejectReuse('token-depth', 'DTCG alias nesting exceeds the budget', { path: id });
      active.add(id);
      let type = source.type,
        value = source.value;
      const alias = typeof value === 'string' ? /^\{([^{}]+)\}$/.exec(value) : null;
      if (alias) {
        const target = convert(alias[1]);
        type ??= target.type;
        if (target.type !== type)
          rejectReuse('token-type', 'Alias and referenced token types differ', { path: id });
        value = { alias: alias[1] };
      }
      if (!tokenTypes.includes(type as TokenType))
        rejectReuse('dtcg-type', 'Unsupported or missing DTCG token type', { path: id });
      if (type === 'dimension' && !alias && (!record(value) || value.unit !== 'px'))
        rejectReuse(
          'dtcg-unit',
          'DTCG dimension import supports explicit px; rem requires an external context',
          { path: id },
        );
      if (type === 'color' && !alias && record(value)) {
        const { hex, ...color } = value;
        color.alpha ??= 1;
        validateTokenValue('color', color, id);
        if (hex !== undefined && (typeof hex !== 'string' || !/^#[a-f0-9]{6}$/i.test(hex)))
          rejectReuse('dtcg-color', 'Invalid sRGB hex fallback', { path: id });
        if (
          hex !== undefined &&
          hex.toLowerCase() !== colorHex({ ...(color as unknown as TokenColor), alpha: 1 })
        )
          diagnostics.push(
            diag(
              'dtcg-color-fallback',
              id,
              'The informational hex fallback differs from the authoritative sRGB components',
              'warning',
            ),
          );
        value = color;
      }
      validateTokenValue(type as TokenType, value, id);
      const token: DesignToken = { type: type as TokenType, value };
      if (source.description !== undefined) token.description = source.description;
      active.delete(id);
      tokens[id] = token;
      return token;
    };
    for (const id of [...collected.keys()].sort()) {
      try {
        convert(id);
      } catch (error) {
        if (!(error instanceof ReuseError)) throw error;
        diagnostics.push(...error.diagnostics);
        active.clear();
      }
    }
    if (diagnostics.some((d) => d.severity === 'error')) return { diagnostics };
    return {
      tokens: validateTokenSet({
        schemaVersion: 1,
        modes: ['default'],
        defaultMode: 'default',
        tokens,
      }),
      diagnostics,
    };
  } catch (error) {
    if (!(error instanceof ReuseError)) throw error;
    return { diagnostics: [...diagnostics, ...error.diagnostics] };
  }
}
export function exportDtcg(
  raw: TokenSet,
  mode: string,
): { document: Record<string, unknown>; diagnostics: ReuseDiagnostic[] } {
  const set = validateTokenSet(raw),
    document: Record<string, unknown> = {},
    diagnostics: ReuseDiagnostic[] = [];
  if (!set.modes.includes(mode))
    rejectReuse('token-mode', 'Export mode does not exist', { path: mode });
  if (set.modes.length > 1)
    diagnostics.push(
      diag(
        'dtcg-mode-selected',
        mode,
        'The selected mode is exported as one Format document; native mode switching is not encoded',
        'info',
      ),
    );
  for (const id of Object.keys(set.tokens).sort()) {
    const token = set.tokens[id],
      selected = Object.hasOwn(token.modes ?? {}, mode) ? token.modes![mode] : token.value;
    let value: unknown = clone(selected);
    if (isAlias(selected)) value = '{' + selected.alias + '}';
    else if (token.type === 'dimension' && (selected as TokenDimension).unit === 'pt')
      value = { value: dimensionIn(selected as TokenDimension, 'px'), unit: 'px' };
    const path = id.split('.');
    let parent = document;
    for (const key of path.slice(0, -1)) {
      if (!parent[key]) parent[key] = {};
      if (!record(parent[key]) || '$value' in parent[key])
        rejectReuse('dtcg-path-conflict', 'A token path is also a group', { path: id });
      parent = parent[key] as Record<string, unknown>;
    }
    const leaf = path.at(-1)!;
    if (parent[leaf])
      rejectReuse('dtcg-path-conflict', 'A token path is also a group', { path: id });
    parent[leaf] = {
      $type: token.type,
      $value: value,
      ...(token.description !== undefined ? { $description: token.description } : {}),
    };
  }
  return { document, diagnostics };
}
/** Resolver subset: inline named sets and local set references in resolutionOrder. */
export function importDtcgResolver(input: unknown): DtcgResult {
  try {
    const raw = parse(input);
    assertReuseJson(raw);
    checkResolverRoot(raw);
    const merged: TokenSet['tokens'] = Object.create(null),
      diagnostics: ReuseDiagnostic[] = [];
    // Merge format trees before resolving aliases, including aliases into a later source.
    const flat: ResolverTokens = new Map();
    for (const entry of raw.resolutionOrder) {
      const set = resolverSet(raw, entry);
      for (const source of set.sources) {
        if (!record(source) || '$ref' in source)
          rejectReuse(
            'dtcg-resolver-source',
            'External/ref sources are not fetched; supply inline tokens',
          );
        collectResolverTokens(flat, source, [], undefined);
      }
    }
    const result = importDtcg(resolverDocument(flat));
    diagnostics.push(...result.diagnostics);
    if (!result.tokens) return { diagnostics };
    Object.assign(merged, result.tokens.tokens);
    return { tokens: validateTokenSet({ ...result.tokens, tokens: merged }), diagnostics };
  } catch (error) {
    if (!(error instanceof ReuseError)) throw error;
    return { diagnostics: error.diagnostics };
  }
}
type ResolverInput = Record<string, unknown> & { resolutionOrder: unknown[] };
type ResolverTokens = Map<string, { value: Record<string, unknown>; inherited: unknown }>;
const resolverRootKeys = [
  'version',
  'name',
  'description',
  '$schema',
  'sets',
  'modifiers',
  'resolutionOrder',
];
function checkResolverRoot(raw: unknown): asserts raw is ResolverInput {
  if (
    !record(raw) ||
    raw.version !== '2025.10' ||
    !Array.isArray(raw.resolutionOrder) ||
    !raw.resolutionOrder.length
  )
    rejectReuse('dtcg-resolver-schema', 'Expected DTCG 2025.10 resolutionOrder');
  if (
    Object.keys(raw).some((key) => !resolverRootKeys.includes(key)) ||
    (raw.modifiers !== undefined && (!record(raw.modifiers) || Object.keys(raw.modifiers).length))
  )
    rejectReuse(
      'dtcg-resolver-unsupported',
      'Resolver modifiers and unknown root properties are outside the exchange subset',
    );
  if (
    raw.resolutionOrder.length > reuseLimits.definitions ||
    (raw.sets !== undefined && !record(raw.sets))
  )
    rejectReuse('dtcg-resolver-limit', 'Invalid or excessive resolver sets');
}
/** An inline set or the declared local set it references, checked to the supported subset. */
function resolverSet(raw: ResolverInput, entry: unknown) {
  if (!record(entry))
    rejectReuse('dtcg-resolver-schema', 'Expected an inline set or local set reference');
  let set = entry;
  if ('$ref' in entry) {
    const match = typeof entry.$ref === 'string' && /^#\/sets\/([A-Za-z0-9_-]+)$/.exec(entry.$ref);
    if (
      !match ||
      Object.keys(entry).length !== 1 ||
      !record(raw.sets) ||
      !record(raw.sets[match[1]])
    )
      rejectReuse('dtcg-resolver-reference', 'Only declared local set references are supported');
    set = raw.sets[match[1]] as Record<string, unknown>;
  }
  if (
    !Array.isArray(set.sources) ||
    set.sources.length > reuseLimits.definitions ||
    Object.keys(set).some((key) => !['sources', 'description'].includes(key))
  )
    rejectReuse('dtcg-resolver-set', 'Unsupported resolver set');
  return set as Record<string, unknown> & { sources: unknown[] };
}
function collectResolverTokens(
  flat: ResolverTokens,
  node: Record<string, unknown>,
  path: string[],
  inherited: unknown,
): void {
  const type = node.$type ?? inherited;
  if ('$value' in node)
    flat.set(path.join('.'), {
      value: { ...node, ...(type !== undefined ? { $type: type } : {}) },
      inherited: type,
    });
  else
    for (const [key, value] of Object.entries(node)) {
      if (['$type', '$description'].includes(key)) continue;
      if (key.startsWith('$') || !record(value))
        rejectReuse('dtcg-resolver-unsupported', 'Unsupported inline set group', {
          path: path.concat(key).join('.'),
        });
      collectResolverTokens(flat, value, [...path, key], type);
    }
}
function resolverDocument(flat: ResolverTokens) {
  const document: Record<string, unknown> = {};
  for (const [id, item] of flat) {
    const parts = id.split('.');
    let parent = document;
    for (const key of parts.slice(0, -1)) {
      if (!tokenId(key) || (parent[key] && (!record(parent[key]) || '$value' in parent[key])))
        rejectReuse('dtcg-resolver-path', 'Conflicting or unsupported token path');
      parent[key] ??= {};
      parent = parent[key] as Record<string, unknown>;
    }
    const key = parts.at(-1)!;
    if (!tokenId(key) || parent[key])
      rejectReuse('dtcg-resolver-path', 'Conflicting or unsupported token path');
    parent[key] = item.value;
  }
  return document;
}
