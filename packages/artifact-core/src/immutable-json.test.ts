import { expect, it } from 'vitest';
import { deepFreeze, isDeepFrozen, isImmutableJson, parseImmutableJson } from './index';

it('owns parsed JSON recursively, including nested arrays and prototype-named data', () => {
  const parsed = parseImmutableJson(
    '{"rows":[{"value":-0,"empty":null}],"__proto__":{"polluted":true}}',
  ) as { rows: { value: number; empty: null }[]; __proto__: { polluted: boolean } };
  expect(isImmutableJson(parsed)).toBe(true);
  expect(isImmutableJson(parsed.rows)).toBe(true);
  expect(isImmutableJson(parsed.rows[0])).toBe(true);
  expect(isDeepFrozen(parsed)).toBe(true);
  expect(Object.is(parsed.rows[0].value, -0)).toBe(true);
  expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
  expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  expect(Object.prototype).not.toHaveProperty('polluted');
  expect(() => (parsed.rows[0].value = 2)).toThrow();
  expect(() => parsed.rows.push({ value: 1, empty: null })).toThrow();
});

it('does not certify caller objects, copies, accessors or shallow freezes as parsed JSON', () => {
  const parsed = parseImmutableJson('{"value":{"count":1}}');
  expect(isImmutableJson(structuredClone(parsed))).toBe(false);
  expect(isImmutableJson(deepFreeze({ value: { count: 1 } }))).toBe(false);
  expect(isImmutableJson(Object.freeze({ value: { count: 1 } }))).toBe(false);
  const getter = Object.defineProperty({}, 'value', {
    get() {
      throw Error('Do not invoke');
    },
  });
  expect(isImmutableJson(getter)).toBe(false);
  expect(isImmutableJson(null)).toBe(false);
  expect(isImmutableJson(1)).toBe(false);
  expect(() => parseImmutableJson('{"value":undefined}')).toThrow(SyntaxError);
});
