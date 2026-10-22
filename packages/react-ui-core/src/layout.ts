import { resolveTokens, type TokenType } from '@editor-platform/reuse-core';
import type { ReactEnvironment, ReactUiStyleProperty, ReactUiStyleValue } from './types';

const enums: Partial<Record<ReactUiStyleProperty, string[]>> = {
  display: ['block', 'flex', 'grid', 'inline-flex', 'none'],
  flexDirection: ['row', 'column', 'row-reverse', 'column-reverse'],
  alignItems: ['stretch', 'start', 'end', 'center', 'baseline'],
  justifyContent: ['start', 'end', 'center', 'space-between', 'space-around', 'space-evenly'],
  flexWrap: ['nowrap', 'wrap', 'wrap-reverse'],
  position: ['static', 'relative', 'absolute'],
};
function tokenType(property: ReactUiStyleProperty): TokenType {
  if (property === 'color' || property === 'backgroundColor') return 'color';
  if (property === 'fontFamily') return 'fontFamily';
  if (property === 'fontWeight') return 'fontWeight';
  return 'dimension';
}
/** Semantic value subset used by both later preview/export adapters. No free CSS strings. */
export function styleProblem(
  environment: ReactEnvironment,
  property: ReactUiStyleProperty,
  value: ReactUiStyleValue,
): string | undefined {
  const choices = enums[property];
  if (choices)
    return value.kind === 'literal' &&
      typeof value.value === 'string' &&
      choices.includes(value.value)
      ? undefined
      : 'Unsupported structural layout value';
  if (property === 'gridTemplateColumns')
    return value.kind === 'literal' &&
      typeof value.value === 'string' &&
      /^(?:1fr(?: 1fr){0,11}|repeat\((?:[1-9]|1[0-2]), minmax\(0, 1fr\)\))$/.test(value.value)
      ? undefined
      : 'Only bounded equal fractional grid tracks are supported';
  if (value.kind === 'token') return tokenProblem(environment, property, value.tokenId);
  if (environment.stylePolicy === 'tokens-only')
    return 'Host requires a design token for this visual value';
  return literalProblem(property, value.value);
}
const signedProperties = ['margin', 'top', 'left'];
function tokenProblem(
  environment: ReactEnvironment,
  property: ReactUiStyleProperty,
  tokenId: string,
): string | undefined {
  if (!environment.tokens || !Object.hasOwn(environment.tokenVariables, tokenId))
    return 'Token or its Host CSS variable is missing';
  const token = resolveTokens(environment.tokens.payload, { artifactMode: environment.tokenMode })
    .tokens[tokenId];
  if (!token || token.type !== tokenType(property)) return 'Token type does not match CSS property';
  // Native dimension tokens may be negative. Size/gap/padding/radius cannot be negative.
  if (
    token.type === 'dimension' &&
    typeof token.value === 'object' &&
    !Array.isArray(token.value) &&
    'value' in token.value &&
    typeof token.value.value === 'number' &&
    token.value.value < 0 &&
    !signedProperties.includes(property)
  )
    return 'Negative token dimension is unsupported for this property';
  return;
}
function literalProblem(
  property: ReactUiStyleProperty,
  literal: string | number,
): string | undefined {
  if (property === 'color' || property === 'backgroundColor')
    return typeof literal === 'string' && /^#[a-fA-F0-9]{6}(?:[a-fA-F0-9]{2})?$/.test(literal)
      ? undefined
      : 'Only hex color literals are supported';
  if (property === 'fontFamily')
    return typeof literal === 'string' && /^[A-Za-z][A-Za-z0-9 ,_-]{0,127}$/.test(literal)
      ? undefined
      : 'Unsupported font family literal';
  if (property === 'fontWeight')
    return typeof literal === 'number' &&
      Number.isSafeInteger(literal) &&
      literal >= 1 &&
      literal <= 1000
      ? undefined
      : 'Unsupported font weight literal';
  if (typeof literal === 'number')
    return Number.isFinite(literal) &&
      Math.abs(literal) <= 10000 &&
      (literal >= 0 || signedProperties.includes(property))
      ? undefined
      : 'Unsupported dimension literal';
  return dimensionProblem(property, literal);
}
function dimensionProblem(property: ReactUiStyleProperty, literal: string): string | undefined {
  if (
    ['width', 'height', 'minWidth', 'maxWidth', 'margin', 'top', 'left'].includes(property) &&
    literal === 'auto'
  )
    return;
  if (!/^-?(?:\d+(?:\.\d+)?)(?:px|rem|em|%)$/.test(literal)) return 'Unsupported dimension syntax';
  const dimension = Number.parseFloat(literal);
  if (Math.abs(dimension) > 10000 || (dimension < 0 && !signedProperties.includes(property)))
    return 'Dimension is outside the supported range';
}
