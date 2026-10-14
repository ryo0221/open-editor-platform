import { describe, expect, it } from 'vitest';
import { brandStyles, brandTokens, tokenScaleFixture } from '../../../tests/fixtures/reuse/brand';
import {
  importDtcg,
  importDtcgResolver,
  exportDtcg,
  resolveTokens,
  resolveStyle,
  validateTokenSet,
  tokenId,
  reuseDomains,
  reuseCapabilities,
  styleCapabilities,
  ReuseError,
  type TokenSet,
} from './index';

describe('R01 token resolution and media contracts', () => {
  it('keeps token paths bounded and rejects reserved or nonportable segments', () => {
    for (const id of ['brand.primary', 'A-0.b_c', 'a'.repeat(160)]) expect(tokenId(id)).toBe(true);
    for (const id of [
      '',
      '.a',
      'a.',
      'a..b',
      '_a',
      'a._b',
      'a/b',
      'a:0',
      'a.prototype',
      'constructor.a',
      '__proto__',
      'a'.repeat(161),
    ])
      expect(tokenId(id)).toBe(false);
  });
  it('resolves one brand into three explicitly different media without modifying the source', () => {
    const before = structuredClone(brandTokens);
    const [design, slide, document] = brandStyles.map((style) => resolveStyle(style, brandTokens));
    expect(design.properties).toMatchObject({
      fill: '#336699',
      'typography.fontSize': 16,
      'layout.gap': 16,
    });
    expect(slide.properties).toMatchObject({ fill: '#336699', 'typography.fontSize': 32 });
    expect(document.properties).toMatchObject({ color: '#336699', fontSize: 12, spaceAfter: 12 });
    expect(document.units).toEqual({ fontSize: 'pt', spaceAfter: 'pt' });
    expect(design.units['typography.fontSize']).toBe('px');
    expect(brandTokens).toEqual(before);
  });
  it('uses instance mode, then artifact mode, then the declared default, never another fallback', () => {
    expect(
      resolveStyle(brandStyles[0], brandTokens, { artifactMode: 'dark' }).properties.fill,
    ).toBe('#99ccff');
    expect(
      resolveStyle(brandStyles[0], brandTokens, { artifactMode: 'dark', instanceMode: 'light' })
        .properties.fill,
    ).toBe('#336699');
    expect(() => resolveTokens(brandTokens, { instanceMode: 'unknown' })).toThrow(ReuseError);
    expect(resolveTokens(brandTokens).tokens['brand.primary'].source).toEqual([
      'brand.primary',
      'palette.brand',
    ]);
  });
  it.each([
    [
      'cycle',
      (s: TokenSet) => {
        s.tokens['palette.brand'].value = { alias: 'brand.primary' };
      },
    ],
    [
      'missing',
      (s: TokenSet) => {
        s.tokens['brand.primary'].value = { alias: 'missing' };
      },
    ],
    [
      'wrong type',
      (s: TokenSet) => {
        s.tokens['brand.primary'].value = { alias: 'space.base' };
      },
    ],
    [
      'undeclared mode',
      (s: TokenSet) => {
        s.tokens['brand.primary'].modes = { missing: { alias: 'palette.brand' } };
      },
    ],
    [
      'cycle in another mode',
      (s: TokenSet) => {
        s.tokens['palette.brand'].modes = { dark: { alias: 'brand.primary' } };
      },
    ],
    [
      'bad color',
      (s: TokenSet) => {
        s.tokens['palette.brand'].value = { colorSpace: 'srgb', components: [2, 0, 0], alpha: 1 };
      },
    ],
    [
      'nonfinite value',
      (s: TokenSet) => {
        s.tokens['space.base'].value = { value: NaN, unit: 'px' };
      },
    ],
    [
      'unknown schema',
      (s: TokenSet) => {
        Object.assign(s, { schemaVersion: 2 });
      },
    ],
  ])('rejects %s before applying a style', (_, change) => {
    const set = structuredClone(brandTokens);
    change(set);
    expect(() => resolveStyle(brandStyles[0], set)).toThrow(ReuseError);
  });
  it('bounds tokens and alias chains even when a shallow token was cached first', () => {
    expect(Object.keys(resolveTokens(tokenScaleFixture()).tokens)).toHaveLength(2048);
    expect(() => validateTokenSet(tokenScaleFixture(2049))).toThrow(ReuseError);
    const tokens: TokenSet['tokens'] = { a0: { type: 'number', value: 1 } };
    for (let i = 1; i < 33; i++)
      tokens['a' + i.toString().padStart(2, '0')] = {
        type: 'number',
        value: { alias: i === 1 ? 'a0' : 'a' + (i - 1).toString().padStart(2, '0') },
      };
    expect(() =>
      validateTokenSet({ schemaVersion: 1, modes: ['default'], defaultMode: 'default', tokens }),
    ).toThrow(ReuseError);
  });
  it('rejects invalid type and excessive alias depth in an unselected mode', () => {
    const set = structuredClone(brandTokens);
    set.tokens['brand.primary'].modes = { dark: { alias: 'space.base' } };
    expect(() => resolveTokens(set, { instanceMode: 'light' })).toThrow(/different type/);
    const tokens: TokenSet['tokens'] = {};
    for (let i = 0; i < 33; i++)
      tokens[`a${i.toString().padStart(2, '0')}`] = {
        type: 'number',
        value: 1,
        ...(i > 0 ? { modes: { dark: { alias: `a${(i - 1).toString().padStart(2, '0')}` } } } : {}),
      };
    expect(() =>
      resolveTokens(
        { schemaVersion: 1, modes: ['light', 'dark'], defaultMode: 'light', tokens },
        { instanceMode: 'light' },
      ),
    ).toThrow(/budget/);
  });
  it('rejects negative padding, schema/formula targets and source identities', () => {
    const set = structuredClone(brandTokens);
    set.tokens['space.base'].value = { value: -1, unit: 'px' };
    expect(() => resolveStyle(brandStyles[0], set)).toThrow(ReuseError);
    for (const domain of ['data', 'review', 'file'] as const)
      expect(() =>
        resolveStyle(
          { schemaVersion: 1, domain, bindings: { formula: { token: 'font.ui' } } },
          brandTokens,
        ),
      ).toThrow(ReuseError);
    expect(Object.keys(reuseCapabilities).sort()).toEqual([...reuseDomains].sort());
    expect(Object.keys(styleCapabilities).sort()).toEqual([...reuseDomains].sort());
    expect(reuseCapabilities.review.update).toBe('private-settings');
    expect(reuseCapabilities.file.export).toBe('bytes-unchanged');
  });
});

describe('DTCG 2025.10 declared exchange subset', () => {
  it('reads inherited and alias-inferred types, and exports the selected mode explicitly', () => {
    const result = importDtcg({
      color: {
        $type: 'color',
        primary: { $value: { colorSpace: 'srgb', components: [0.2, 0.4, 0.6] } },
      },
      brand: { $value: '{color.primary}' },
    });
    expect(result.diagnostics).toEqual([]);
    expect(resolveTokens(result.tokens).tokens.brand.value).toEqual({
      colorSpace: 'srgb',
      components: [0.2, 0.4, 0.6],
      alpha: 1,
    });
    const exported = exportDtcg(brandTokens, 'dark');
    expect(exported.diagnostics.map((d) => d.code)).toEqual(['dtcg-mode-selected']);
    const roundTrip = importDtcg(exported.document);
    expect(roundTrip.diagnostics).toEqual([]);
    expect(resolveStyle(brandStyles[2], roundTrip.tokens!).properties).toEqual(
      resolveStyle(brandStyles[2], brandTokens, { instanceMode: 'dark' }).properties,
    );
  });
  it.each([
    { x: { $type: 'shadow', $value: {} } },
    { x: { $type: 'typography', $value: {} } },
    { x: { $type: 'dimension', $value: { value: 1, unit: 'rem' } } },
    { x: { $type: 'color', $value: { colorSpace: 'display-p3', components: [1, 0, 0] } } },
    { x: { $type: 'number', $value: { $ref: '#/a/$value' } } },
    { x: { $type: 'number', $value: 1, $extensions: { modes: {} } } },
    { x: { $type: 'number', $root: { $value: 1 } } },
  ])('reports unsupported content without producing a partial token set: %j', (raw) => {
    const result = importDtcg(raw);
    expect(result.tokens).toBeUndefined();
    expect(result.diagnostics.some((d) => d.severity === 'error')).toBe(true);
  });
  it('resolves inline resolver sets in order, with aliases to tokens supplied by later sets', () => {
    const result = importDtcgResolver({
      version: '2025.10',
      sets: { base: { sources: [{ a: { $value: '{b}' }, b: { $type: 'number', $value: 1 } }] } },
      resolutionOrder: [
        { $ref: '#/sets/base' },
        { sources: [{ b: { $type: 'number', $value: 2 } }] },
      ],
    });
    expect(result.diagnostics).toEqual([]);
    expect(resolveTokens(result.tokens).tokens.a.value).toBe(2);
  });
  it('does not fetch remote sources or guess unsupported resolver modes', () => {
    for (const document of [
      {
        version: '2025.10',
        resolutionOrder: [{ sources: [{ $ref: 'https://example.com/tokens.json' }] }],
      },
      {
        version: '2025.10',
        modifiers: { theme: { contexts: {} } },
        resolutionOrder: [{ sources: [] }],
      },
    ]) {
      const result = importDtcgResolver(document);
      expect(result.tokens).toBeUndefined();
      expect(result.diagnostics[0].severity).toBe('error');
    }
  });
  it('rejects sparse/unsafe data, cycles and invalid JSON without mutating input', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.a = cyclic;
    expect(importDtcg(cyclic).diagnostics[0].code).toBe('reuse-cycle');
    expect(importDtcg('{').diagnostics[0].code).toBe('dtcg-json');
    expect(importDtcg('{"__proto__":{"x":1}}').diagnostics[0].code).toBe('reuse-key');
    expect(importDtcg({ x: { $value: Array(2) } }).diagnostics[0].code).toBe('reuse-schema');
  });
});
