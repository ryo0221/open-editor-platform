import { expect, it } from 'vitest';
import { canonicalEqual, canonicalJson } from './index';

const values: unknown[] = [
  null,
  undefined,
  0,
  -0,
  1,
  Number.NaN,
  Infinity,
  '',
  'a',
  '0',
  'null',
  true,
  false,
  [],
  [null],
  [undefined],
  // Sparse arrays: canonicalJson writes holes as empty slots, undefined as null.
  Array(1),
  Array(2),
  Object.assign(Array(2), { 1: 1 }),
  [undefined, 1],
  [null, 1],
  [1, 2],
  [2, 1],
  {},
  { a: undefined },
  { a: 1 },
  { a: 1, b: undefined },
  { b: 2, a: 1 },
  { a: 1, b: 2 },
  { a: [1, { c: 'x' }] },
  { a: [1, { c: 'y' }] },
  { 0: 1 },
  ['1'],
  Object.assign(Object.create(null), { a: 1 }),
  Object.assign(Object.create({ inherited: 1 }), { a: 1 }),
];

it('agrees with canonical JSON equality for every pair of JSON-like values', () => {
  for (const a of values)
    for (const b of values)
      expect([a, b, canonicalEqual(a, b)]).toEqual([a, b, canonicalJson(a) === canonicalJson(b)]);
});
