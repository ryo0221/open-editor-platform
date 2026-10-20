import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { reuseHash } from './index';

const expected = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
it('keeps exact canonical UTF-8 string digests across repeated reads and bounded-cache turnover', () => {
  const values = [
    '',
    'plain',
    '日本語',
    '😀',
    '\ud800',
    '"\\\n',
    'x'.repeat(8192),
    'x'.repeat(8193),
  ];
  for (const value of values) {
    expect(reuseHash(value)).toBe(expected(value));
    expect(reuseHash(value)).toBe(expected(value));
  }
  for (let i = 0; i < 128; i++) expect(reuseHash('source-' + i)).toBe(expected('source-' + i));
  for (const value of values) expect(reuseHash(value)).toBe(expected(value));
});
it('rechecks changed bytes and mutable objects instead of reusing their earlier digest', () => {
  const input = { value: 'first' };
  const old = reuseHash(input);
  input.value = 'second';
  expect(reuseHash(input)).toBe(expected(input));
  expect(reuseHash(input)).not.toBe(old);
  expect(reuseHash('first')).not.toBe(reuseHash('second'));
});
