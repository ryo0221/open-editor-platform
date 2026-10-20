import { expect, it } from 'vitest';
import { brandTokens } from '../../../tests/fixtures/reuse/brand';
import {
  definitionRef,
  lockClosure,
  readReuseState,
  sealReusableDefinition,
  validateClosure,
  validateRef,
  validateReusableDefinition,
  validateReuseState,
  validateReuseStateSync,
  reuseLimits,
  type ReusableDefinition,
} from './index';

const tokens = () =>
  sealReusableDefinition({
    schemaVersion: 1,
    libraryId: 'brand',
    definitionId: 'colors',
    version: 1,
    kind: 'tokens',
    domain: 'shared',
    name: 'Brand',
    dependencies: [],
    payload: brandTokens,
  });
it('separates adopted closure count from per-closure definitions and reports state limits', async () => {
  const definitions = await Promise.all(
    Array.from({ length: reuseLimits.closures }, (_, index) =>
      sealReusableDefinition({
        schemaVersion: 1,
        libraryId: 'components',
        definitionId: `component-${index}`,
        version: 1,
        kind: 'component',
        domain: 'design',
        name: 'Component',
        dependencies: [],
        payload: {},
      }),
    ),
  );
  const closures = await Promise.all(definitions.map((d) => lockClosure([definitionRef(d)], [d])));
  for (const count of [100, 101, reuseLimits.closures]) {
    const state = { schemaVersion: 1, closures: closures.slice(0, count), instances: [] };
    expect(readReuseState(state)).toEqual(state);
    expect(validateReuseStateSync(JSON.parse(JSON.stringify(state)))).toEqual(state);
  }
  for (const path of ['closures', 'instances'] as const) {
    const state = { schemaVersion: 1, closures: [], instances: [], [path]: Array(2001).fill({}) };
    for (const validate of [readReuseState, validateReuseStateSync])
      expect(() => validate(state)).toThrowError(
        expect.objectContaining({
          code: 'reuse-limit',
          diagnostics: [
            expect.objectContaining({
              address: { path },
              message: expect.stringContaining('2001'),
            }),
          ],
        }),
      );
  }
  await expect(
    lockClosure(definitions.slice(0, 101).map(definitionRef), definitions.slice(0, 101)),
  ).rejects.toMatchObject({ code: 'closure-limit' });
  expect(
    (await lockClosure(definitions.slice(0, 100).map(definitionRef), definitions.slice(0, 100)))
      .definitions,
  ).toHaveLength(100);
  const tampered = { ...closures[100], hash: '0'.repeat(64) };
  expect(() =>
    validateReuseStateSync({
      schemaVersion: 1,
      closures: [...closures.slice(0, 100), tampered],
      instances: [],
    }),
  ).toThrowError(expect.objectContaining({ code: 'closure-hash' }));
});
it('R03/R04 pins exact immutable definitions and deterministic offline transitive closures', async () => {
  const base = await tokens();
  const style = await sealReusableDefinition({
    schemaVersion: 1,
    libraryId: 'brand',
    definitionId: 'heading',
    version: 1,
    kind: 'style',
    domain: 'document',
    name: 'Heading',
    dependencies: [definitionRef(base)],
    payload: { color: 'brand.primary' },
  });
  const first = await lockClosure([definitionRef(style)], [
    style,
    base,
  ] as ReusableDefinition<unknown>[]);
  const other = await lockClosure([definitionRef(style)], [
    base,
    style,
  ] as ReusableDefinition<unknown>[]);
  expect(other).toEqual(first);
  expect(await validateClosure(first)).toEqual(first);
  expect(Object.isFrozen(first.definitions[0].payload)).toBe(true);
  await expect(
    validateReusableDefinition({ ...base, payload: { changed: true } }),
  ).rejects.toMatchObject({ code: 'definition-hash' });
  expect(() => validateRef({ ...base, hash: 'latest' })).toThrow();
});
it('rejects missing, conflicting, unrelated and wrongly typed dependencies before publication', async () => {
  const base = await tokens(),
    ref = definitionRef(base);
  await expect(lockClosure([ref], [])).rejects.toMatchObject({ code: 'dependency-missing' });
  await expect(lockClosure([ref], [base, base])).rejects.toMatchObject({
    code: 'definition-conflict',
  });
  await expect(
    lockClosure([{ ...ref, kind: 'style', domain: 'document' }], [base]),
  ).rejects.toMatchObject({ code: 'dependency-mismatch' });
  const extra = await sealReusableDefinition({
    schemaVersion: 1,
    libraryId: base.libraryId,
    definitionId: 'unused',
    version: 1,
    domain: 'shared',
    kind: 'tokens',
    name: 'Unused',
    dependencies: [],
    payload: brandTokens,
  });
  await expect(
    lockClosure([ref], [base, extra] as ReusableDefinition<unknown>[]),
  ).rejects.toMatchObject({ code: 'closure-extra' });
  const closure = await lockClosure([ref], [base]);
  await expect(validateClosure({ ...closure, hash: '0'.repeat(64) })).rejects.toMatchObject({
    code: 'closure-hash',
  });
});
it('checks retained instance refs at the untrusted load boundary, not just the structure', async () => {
  const base = await tokens(),
    closure = await lockClosure([definitionRef(base)], [base]);
  const state = {
    schemaVersion: 1,
    closures: [closure],
    instances: [
      {
        id: 'instance',
        ref: definitionRef(base),
        closureHash: closure.hash,
        inputs: {},
        overrides: {},
        parts: {},
        slots: {},
      },
    ],
  };
  expect(await validateReuseState(state)).toEqual(state);
  await expect(validateReuseState({ ...state, closures: [] })).rejects.toMatchObject({
    code: 'instance-dependency',
  });
  await expect(
    validateReuseState({ ...state, closures: [closure, closure] }),
  ).rejects.toMatchObject({ code: 'closure-duplicate' });
});
it('validates dynamic slot cycles and the exact instance depth at untrusted load boundaries', async () => {
  const base = await tokens(),
    closure = await lockClosure([definitionRef(base)], [base]);
  const chain = (length: number) => ({
    schemaVersion: 1,
    closures: [closure],
    instances: Array.from({ length }, (_, i) => ({
      id: 'i' + i,
      ref: definitionRef(base),
      closureHash: closure.hash,
      inputs: {},
      overrides: {},
      parts: { root: 'native' + i },
      slots: i + 1 < length ? { body: ['native' + (i + 1)] } : {},
    })),
  });
  expect((await validateReuseState(chain(16)))?.instances).toHaveLength(16);
  await expect(validateReuseState(chain(17))).rejects.toMatchObject({ code: 'slot-depth' });
  const cycle = chain(3);
  cycle.instances[2].slots = { body: ['native0'] };
  await expect(validateReuseState(cycle)).rejects.toMatchObject({ code: 'slot-cycle' });
  const self = chain(1);
  self.instances[0].slots = { body: ['native0'] };
  await expect(validateReuseState(self)).rejects.toMatchObject({ code: 'slot-cycle' });
});
it('keeps legacy copy data absent and rejects unknown instance schemas and aliased native IDs', () => {
  expect(readReuseState(undefined)).toBeUndefined();
  expect(() => readReuseState({ schemaVersion: 99, closures: [], instances: [] })).toThrow();
  expect(() =>
    readReuseState({
      schemaVersion: 1,
      closures: [],
      instances: [
        {
          id: 'i',
          ref: {
            libraryId: 'l',
            definitionId: 'd',
            version: 1,
            hash: 'a'.repeat(64),
            kind: 'component',
            domain: 'design',
          },
          closureHash: 'b'.repeat(64),
          inputs: {},
          overrides: {},
          slots: {},
          parts: { one: 'same-native', two: 'same-native' },
        },
      ],
    }),
  ).toThrow();
});
