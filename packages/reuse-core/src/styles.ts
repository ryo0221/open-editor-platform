import { assertReuseJson, record, rejectReuse, reuseDomains, type ReuseDomain } from './contracts';
import {
  colorHex,
  dimensionIn,
  resolveTokens,
  type TokenColor,
  type TokenContext,
  type TokenDimension,
  type TokenSet,
  type TokenType,
} from './tokens';

export interface DomainStyle {
  schemaVersion: 1;
  domain: ReuseDomain;
  bindings: Record<string, { token: string }>;
}
interface StyleRule {
  type: TokenType;
  unit?: 'px' | 'pt';
  min?: number;
  max?: number;
}
const color = { type: 'color' } as const;
const size = { type: 'dimension', unit: 'px', min: 1, max: 512 } as const;
const space = { type: 'dimension', unit: 'px', min: 0, max: 10000 } as const;
const typography: Record<string, StyleRule> = {
  'typography.color': color,
  'typography.fontSize': size,
  'typography.fontFamily': { type: 'fontFamily' },
  'typography.fontWeight': { type: 'fontWeight' },
  'typography.lineHeight': { type: 'number', min: 0.5, max: 5 },
};
/** Targets are domain contracts, not arbitrary object paths or a universal node schema. */
export const styleCapabilities: Readonly<Record<ReuseDomain, Readonly<Record<string, StyleRule>>>> =
  {
    design: {
      fill: color,
      stroke: color,
      strokeWidth: space,
      radius: space,
      'layout.gap': space,
      'layout.padding': space,
      ...typography,
    },
    slide: { fill: color, stroke: color, strokeWidth: space, ...typography },
    whiteboard: { color, stroke: color, strokeWidth: space, ...typography },
    document: {
      color,
      highlight: color,
      fontFamily: { type: 'fontFamily' },
      fontSize: { type: 'dimension', unit: 'pt', min: 1, max: 384 },
      fontWeight: { type: 'fontWeight' },
      lineHeight: { type: 'number', min: 0.5, max: 5 },
      spaceBefore: { ...space, unit: 'pt' },
      spaceAfter: { ...space, unit: 'pt' },
    },
    // Data schemas/formulas and source identities are deliberately absent.
    data: { 'view.accent': color },
    review: { 'annotation.color': color },
    file: { 'annotation.color': color },
  };
export interface ResolvedStyle {
  domain: ReuseDomain;
  mode: string;
  properties: Record<string, string | string[] | number>;
  units: Record<string, 'px' | 'pt'>;
}
export function resolveStyle(
  raw: DomainStyle,
  tokens: TokenSet,
  context: TokenContext = {},
): ResolvedStyle {
  assertReuseJson(raw);
  if (
    !record(raw) ||
    raw.schemaVersion !== 1 ||
    !reuseDomains.includes(raw.domain) ||
    !record(raw.bindings)
  )
    rejectReuse('style-schema', 'Unsupported domain style');
  const resolved = resolveTokens(tokens, context),
    properties: ResolvedStyle['properties'] = {},
    units: ResolvedStyle['units'] = {};
  for (const [target, binding] of Object.entries(raw.bindings)) {
    const rule = styleCapabilities[raw.domain][target];
    if (!rule)
      rejectReuse('style-target', 'This domain does not support the style target', {
        path: target,
      });
    if (!record(binding) || typeof binding.token !== 'string' || Object.keys(binding).length !== 1)
      rejectReuse('style-binding', 'Expected an explicit token binding', { path: target });
    const token = resolved.tokens[binding.token];
    if (!token) rejectReuse('token-missing', 'Style token is unavailable', { path: target });
    if (token.type !== rule.type)
      rejectReuse('style-type', 'Style target and token type differ', { path: target });
    const value =
      rule.type === 'color'
        ? colorHex(token.value as TokenColor)
        : rule.unit
          ? dimensionIn(token.value as TokenDimension, rule.unit)
          : (token.value as string | string[] | number);
    if (
      typeof value === 'number' &&
      (value < (rule.min ?? -Infinity) || value > (rule.max ?? Infinity))
    )
      rejectReuse('style-range', 'Resolved value is outside the native target range', {
        path: target,
      });
    properties[target] = value;
    if (rule.unit) units[target] = rule.unit;
  }
  return { domain: raw.domain, mode: resolved.mode, properties, units };
}
export const reuseCapabilities = {
  design: {
    create: 'native-artifact',
    insert: 'frame-local-parts',
    properties: 'typed',
    variants: 'declared',
    slots: 'design-component',
    update: 'native-parts',
    export: 'svg-resolved',
    viewSettings: 'none',
  },
  document: {
    create: 'native-artifact',
    insert: 'semantic-blocks',
    properties: 'typed',
    variants: 'declared',
    slots: 'semantic-body',
    update: 'text-engine-steps',
    export: 'html-docx-resolved',
    viewSettings: 'none',
  },
  slide: {
    create: 'native-artifact',
    insert: 'page-or-in-page',
    properties: 'typed',
    variants: 'declared',
    slots: 'slide-objects',
    update: 'layout-and-parts',
    export: 'svg-pptx-resolved',
    viewSettings: 'none',
  },
  whiteboard: {
    create: 'native-artifact',
    insert: 'world-parts-section',
    properties: 'typed',
    variants: 'declared',
    slots: 'nodes-with-ports',
    update: 'topology-migration',
    export: 'svg-resolved',
    viewSettings: 'none',
  },
  data: {
    create: 'native-artifact',
    insert: 'field-set-or-view',
    properties: 'typed',
    variants: 'view',
    slots: 'field-mapping',
    update: 'record-preserving-migration',
    export: 'native-csv-resolved',
    viewSettings: 'view-widget',
  },
  review: {
    create: 'unsupported-source-copy',
    insert: 'annotation-creation-only',
    properties: 'preset',
    variants: 'none',
    slots: 'explicit-source-anchor',
    update: 'private-settings',
    export: 'source-unchanged',
    viewSettings: 'private-comparison',
  },
  file: {
    create: 'unsupported-source-copy',
    insert: 'annotation-creation-only',
    properties: 'preset',
    variants: 'none',
    slots: 'explicit-source-anchor',
    update: 'private-settings',
    export: 'bytes-unchanged',
    viewSettings: 'private-file-type',
  },
} as const;
