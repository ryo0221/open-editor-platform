import { expect, it } from 'vitest';
import { clone, deepFreeze } from '@editor-platform/artifact-core';
import { brandTokens } from '../../../tests/fixtures/reuse/brand';
import {
  assertReuseJson,
  definitionRef,
  lockClosure,
  readReuseState,
  resolveTokens,
  sealReusableDefinition,
  validateClosure,
  validateReusableDefinition,
  validateReuseState,
  reuseLimits,
} from './index';
async function instanceFixture() {
  const definition = await sealReusableDefinition({
    schemaVersion: 1,
    libraryId: 'test',
    definitionId: 'shape-cache',
    version: 1,
    kind: 'tokens',
    domain: 'shared',
    name: 'Shape validation',
    dependencies: [],
    payload: brandTokens,
  });
  const closure = await lockClosure([definitionRef(definition)], [definition]);
  return {
    closure,
    instance: {
      id: 'one',
      ref: definitionRef(definition),
      closureHash: closure.hash,
      inputs: {},
      overrides: {},
      parts: { root: 'native-one' },
      slots: {} as Record<string, string[]>,
    },
  };
}

it('checks cached instances in their new state and rechecks mutable children', async () => {
  const { closure, instance } = await instanceFixture();
  const one = deepFreeze({ ...instance, slots: { body: ['native-two'] } });
  const two = deepFreeze({
    ...instance,
    id: 'two',
    parts: { root: 'native-two' },
    slots: { body: ['native-one'] },
  });
  const state = { schemaVersion: 1, closures: [closure], instances: [one] };
  await validateReuseState(state);
  await validateReuseState({ ...state, instances: [two] });
  await expect(validateReuseState({ ...state, instances: [one, one] })).rejects.toMatchObject({
    code: 'instance-schema',
  });
  await expect(validateReuseState({ ...state, closures: [] })).rejects.toMatchObject({
    code: 'instance-dependency',
  });
  await expect(validateReuseState({ ...state, instances: [one, two] })).rejects.toMatchObject({
    code: 'slot-cycle',
  });
  const shallow = Object.freeze(clone(instance));
  await validateReuseState({ ...state, instances: [shallow] });
  Object.assign(shallow.parts, { alias: 'native-one' });
  await expect(validateReuseState({ ...state, instances: [shallow] })).rejects.toMatchObject({
    code: 'part-map',
  });
});

it('charges every cached occurrence against expansion limits even without slot edges', async () => {
  const { closure, instance } = await instanceFixture();
  const parts = deepFreeze(
    Object.fromEntries(Array.from({ length: 200 }, (_, i) => ['part' + i, 'native' + i])),
  );
  const instances = deepFreeze(
    Array.from({ length: 101 }, (_, i) => ({ ...instance, id: 'i' + i, parts })),
  );
  const state = { schemaVersion: 1, closures: [closure], instances: instances.slice(0, 100) };
  await validateReuseState(state);
  await expect(validateReuseState({ ...state, instances })).rejects.toMatchObject({
    code: 'expanded-limit',
  });
});

it('revalidates mutable and shallow-frozen definitions, closures and hidden token modes', async () => {
  const definition = await sealReusableDefinition({
    schemaVersion: 1,
    libraryId: 'test',
    definitionId: 'tokens',
    version: 1,
    kind: 'tokens',
    domain: 'shared',
    name: 'Tokens',
    dependencies: [],
    payload: brandTokens,
  });
  const mutable = Object.freeze(clone(definition));
  const accepted = await validateReusableDefinition(mutable);
  mutable.payload.tokens['brand.primary'].value = { alias: 'missing' };
  await expect(validateReusableDefinition(mutable)).rejects.toMatchObject({
    code: 'definition-hash',
  });
  expect(accepted).toEqual(definition);
  const closure = Object.freeze(
    clone(await lockClosure([definitionRef(definition)], [definition])),
  );
  await validateClosure(closure);
  closure.definitions[0].name = 'Changed';
  await expect(validateClosure(closure)).rejects.toMatchObject({ code: 'definition-hash' });
  const tokens = Object.freeze(clone(brandTokens));
  const light = resolveTokens(tokens, { instanceMode: 'light' });
  tokens.tokens['brand.primary'].modes = { dark: { alias: 'missing' } };
  expect(() => resolveTokens(tokens, { instanceMode: 'light' })).toThrow(/missing/i);
  expect(resolveTokens(deepFreeze(clone(brandTokens)), { instanceMode: 'light' })).toEqual(light);
});

it('charges cached immutable subtrees at each occurrence and at their enclosing depth', () => {
  const shared = deepFreeze(Array.from({ length: 1000 }, () => '日本語'));
  assertReuseJson(shared);
  expect(() => assertReuseJson(Array.from({ length: 200 }, () => shared))).toThrow(
    /value\/depth budget/,
  );
  let nested: unknown = deepFreeze({ text: 'deep' });
  assertReuseJson(nested);
  for (let i = 0; i < reuseLimits.jsonDepth; i++) nested = { child: nested };
  expect(() => assertReuseJson(nested)).toThrow(/value\/depth budget/);
  const shallow = Object.freeze({ child: { value: 'before' } });
  assertReuseJson(shallow);
  Object.assign(shallow.child, { executable: () => 1 });
  expect(() => assertReuseJson(shallow)).toThrow(/Non-JSON/);
});

it('keeps public state reads editable and accounts for UTF-8 and escaped JSON bytes', async () => {
  const state = { schemaVersion: 1 as const, instances: [], closures: [] };
  const validated = await validateReuseState(state);
  const read = readReuseState(validated)!;
  read.artifactMode = 'dark';
  expect(validated!.artifactMode).toBeUndefined();
  for (const value of ['日本語', 'A😀B', '\ud800', '\u0001']) {
    const size = new TextEncoder().encode(JSON.stringify(value)).length;
    expect(() => assertReuseJson(value, size)).not.toThrow();
    expect(() => assertReuseJson(value, size - 1)).toThrow(/byte budget/);
  }
});
it('charges exact escaped JSON bytes for keys, values, numbers and repeated cached subtrees', () => {
  const value = {
    '日本語"\\\ud800': '\u0001\n"\\'.repeat(200),
    values: [-0, 1e-7, 1e21, null, true, false, { absent: undefined }],
    omitted: undefined,
  };
  for (const candidate of [value, deepFreeze(clone(value))]) {
    assertReuseJson(candidate);
    for (const wrapped of [
      candidate,
      [candidate, candidate],
      { left: candidate, right: candidate },
    ]) {
      const exact = new TextEncoder().encode(JSON.stringify(wrapped)).length;
      expect(() => assertReuseJson(wrapped, exact)).not.toThrow();
      expect(() => assertReuseJson(wrapped, exact - 1)).toThrow(/JSON exceeds the byte budget/);
    }
  }
});
it('rejects hidden serialization hooks without invoking them', () => {
  let called = false;
  const value = Object.defineProperty({ text: 'body' }, 'toJSON', {
    get() {
      called = true;
      return () => 'hidden';
    },
  });
  expect(() => assertReuseJson(value)).toThrow(/serialization is not portable/);
  expect(called).toBe(false);
  class CustomArray extends Array<number> {
    toJSON() {
      called = true;
      return 'hidden';
    }
  }
  expect(() => assertReuseJson(new CustomArray())).toThrow(/serialization is not portable/);
  expect(called).toBe(false);
  expect(() => assertReuseJson({ toJSON: 'ordinary JSON value' })).not.toThrow();
});
