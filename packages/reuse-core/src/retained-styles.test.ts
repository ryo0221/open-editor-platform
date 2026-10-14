import { expect, it } from 'vitest';
import { clone, deepFreeze } from '@editor-platform/artifact-core';
import {
  definitionRef,
  lockClosure,
  sealReusableDefinition,
  validateReuseStateSync,
  validNativeReuse,
  type ReuseState,
} from './contracts';
import type { ComponentContract } from './properties';
import type { TokenSet } from './tokens';
import { brandTokens } from '../../../tests/fixtures/reuse/brand';

const contract: ComponentContract = {
  schemaVersion: 1,
  parts: [{ id: 'body', nativeId: 'paragraph' }],
  properties: [],
  slots: [
    {
      id: 'details',
      label: '補足',
      partId: 'body',
      domain: 'document',
      accepts: ['body'],
      min: 0,
      max: 20,
    },
  ],
  variants: [],
};
async function retained(
  options: { tokens?: TokenSet; style?: object; bindings?: object[] } = {},
): Promise<ReuseState> {
  const tokens = await sealReusableDefinition({
    schemaVersion: 1,
    libraryId: 'brand',
    definitionId: 'tokens',
    version: 1,
    kind: 'tokens',
    domain: 'shared',
    name: 'Brand',
    dependencies: [],
    payload: options.tokens ?? brandTokens,
  });
  const style = await sealReusableDefinition({
    schemaVersion: 1,
    libraryId: 'brand',
    definitionId: 'style',
    version: 1,
    kind: 'style',
    domain: 'document',
    name: '本文',
    dependencies: [definitionRef(tokens)],
    payload: {
      tokens: definitionRef(tokens),
      style: options.style ?? {
        schemaVersion: 1,
        domain: 'document',
        bindings: { color: { token: 'brand.primary' } },
      },
    },
  });
  const component = await sealReusableDefinition({
    schemaVersion: 1,
    libraryId: 'brand',
    definitionId: 'component',
    version: 1,
    kind: 'component',
    domain: 'document',
    name: '注意書き',
    dependencies: [definitionRef(style)],
    payload: {
      contract,
      styles: options.bindings ?? [{ partId: 'body', ref: definitionRef(style) }],
    },
  });
  const closure = await lockClosure<unknown>(
    [definitionRef(component)],
    [component, style, tokens],
  );
  return {
    schemaVersion: 1,
    closures: [closure],
    instances: [
      {
        id: 'adopted',
        ref: definitionRef(component),
        closureHash: closure.hash,
        inputs: {},
        overrides: {},
        parts: { body: 'case/body' },
        slots: {},
      },
    ],
  };
}

it('validates semantically hash-valid retained token payloads, including unselected modes, before native acceptance', async () => {
  for (const mutate of [
    (tokens: TokenSet) => {
      tokens.schemaVersion = 99 as 1;
    },
    (tokens: TokenSet) => {
      tokens.tokens['brand.primary'].modes = { dark: { alias: 'missing' } };
    },
    (tokens: TokenSet) => {
      tokens.tokens['brand.primary'].modes = { dark: { alias: 'brand.primary' } };
    },
    (tokens: TokenSet) => {
      tokens.tokens['font.prose'].value = { value: 12, unit: 'cm' as 'pt' };
    },
  ]) {
    const tokens = clone(brandTokens);
    mutate(tokens);
    const state = await retained({ tokens });
    expect(() => validateReuseStateSync(state)).toThrow();
    expect(validNativeReuse(state, 'document')).toBe(false);
  }
  const valid = await retained();
  expect(validNativeReuse(JSON.parse(JSON.stringify(valid)), 'document')).toBe(true);
});

it('rejects retained style capability/type/domain/part errors even with matching cryptographic hashes', async () => {
  for (const style of [
    { schemaVersion: 99, domain: 'document', bindings: { color: { token: 'brand.primary' } } },
    {
      schemaVersion: 1,
      domain: 'document',
      bindings: { 'arbitrary.script': { token: 'brand.primary' } },
    },
    { schemaVersion: 1, domain: 'document', bindings: { fontSize: { token: 'brand.primary' } } },
    { schemaVersion: 1, domain: 'slide', bindings: { fill: { token: 'brand.primary' } } },
  ])
    expect(validNativeReuse(await retained({ style }), 'document')).toBe(false);
  const state = await retained();
  const styles = state.closures[0].definitions.find((d) => d.kind === 'component')!.payload as {
    styles: object[];
  };
  expect(
    validNativeReuse(
      await retained({ bindings: [{ ...styles.styles[0], partId: 'missing' }] }),
      'document',
    ),
  ).toBe(false);
});

it('checks explicit/inherited modes without losing valid detached artifact context or trusting shallow-frozen mutations', async () => {
  const state = await retained();
  state.artifactMode = 'dark';
  expect(validateReuseStateSync(deepFreeze(clone(state)))).toEqual(state);
  const invalid = clone(state);
  invalid.instances[0].mode = 'missing';
  expect(() => validateReuseStateSync(invalid)).toThrow(/mode/);
  invalid.instances[0].mode = 'light';
  invalid.artifactMode = 'missing';
  expect(() => validateReuseStateSync(invalid)).not.toThrow();
  delete invalid.instances[0].mode;
  expect(() => validateReuseStateSync(invalid)).toThrow(/mode/);
  const mutable = Object.freeze(clone(state));
  validateReuseStateSync(mutable);
  mutable.instances[0].mode = 'missing';
  expect(() => validateReuseStateSync(mutable)).toThrow(/mode/);
  expect(
    validateReuseStateSync({ schemaVersion: 1, artifactMode: 'dark', closures: [], instances: [] }),
  ).toMatchObject({ artifactMode: 'dark' });
});

it('treats slashes in a Document native ID as one identifier when checking adopted slot cycles', async () => {
  const state = await retained();
  state.instances[0].parts.body = 'node/one';
  state.instances[0].slots.details = ['node'];
  expect(() => validateReuseStateSync(state)).not.toThrow();
  state.instances[0].slots.details = ['node/one'];
  expect(() => validateReuseStateSync(state)).toThrow(/cycle/);
});
