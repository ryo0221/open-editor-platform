import type { DomainStyle, TokenSet } from '@editor-platform/reuse-core';

/** One brand, explicit media sizes, no Editor chrome/theme dependency. */
export const brandTokens: TokenSet = {
  schemaVersion: 1,
  modes: ['light', 'dark'],
  defaultMode: 'light',
  tokens: {
    'palette.brand': {
      type: 'color',
      value: { colorSpace: 'srgb', components: [0.2, 0.4, 0.6], alpha: 1 },
      modes: { dark: { colorSpace: 'srgb', components: [0.6, 0.8, 1], alpha: 1 } },
    },
    'brand.primary': { type: 'color', value: { alias: 'palette.brand' } },
    'font.family': { type: 'fontFamily', value: ['Noto Sans CJK JP', 'sans-serif'] },
    'font.weight': { type: 'fontWeight', value: 700 },
    'font.ui': { type: 'dimension', value: { value: 16, unit: 'px' } },
    'font.slide': { type: 'dimension', value: { value: 32, unit: 'px' } },
    'font.prose': { type: 'dimension', value: { value: 12, unit: 'pt' } },
    'space.base': { type: 'dimension', value: { value: 16, unit: 'px' } },
    'line.body': { type: 'number', value: 1.5 },
  },
};
export const brandStyles: DomainStyle[] = [
  {
    schemaVersion: 1,
    domain: 'design',
    bindings: {
      fill: { token: 'brand.primary' },
      'typography.fontSize': { token: 'font.ui' },
      'typography.fontFamily': { token: 'font.family' },
      'layout.gap': { token: 'space.base' },
    },
  },
  {
    schemaVersion: 1,
    domain: 'slide',
    bindings: {
      fill: { token: 'brand.primary' },
      'typography.fontSize': { token: 'font.slide' },
      'typography.fontFamily': { token: 'font.family' },
    },
  },
  {
    schemaVersion: 1,
    domain: 'document',
    bindings: {
      color: { token: 'brand.primary' },
      fontSize: { token: 'font.prose' },
      fontFamily: { token: 'font.family' },
      spaceAfter: { token: 'space.base' },
    },
  },
];
export function tokenScaleFixture(count = 2048): TokenSet {
  const tokens: TokenSet['tokens'] = {};
  for (let i = 0; i < count; i++)
    tokens['color.t' + i] = {
      type: 'color',
      value:
        i % 16
          ? { alias: 'color.t' + (i - (i % 16)) }
          : { colorSpace: 'srgb', components: [0.2, 0.4, 0.6], alpha: 1 },
    };
  return { schemaVersion: 1, modes: ['default'], defaultMode: 'default', tokens };
}
