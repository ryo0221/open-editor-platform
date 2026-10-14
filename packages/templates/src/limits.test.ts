import { it, expect } from 'vitest';
import { assertTemplateSize } from './limits';

it('counts UTF-8 JSON bytes without charging array indices as serialized object keys', () => {
  const array = Array(10_001).fill(''),
    bytes = new TextEncoder().encode(JSON.stringify(array)).length;
  expect(() => assertTemplateSize(array, bytes)).not.toThrow();
  expect(() => assertTemplateSize(array, bytes - 1)).toThrow(/bytes/);
  const value = { text: '日本語' },
    utf8 = new TextEncoder().encode(JSON.stringify(value)).length;
  expect(() => assertTemplateSize(value, utf8)).not.toThrow();
  expect(() => assertTemplateSize(value, utf8 - 1)).toThrow(/bytes/);
});
