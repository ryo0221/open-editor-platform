import { expect, it } from 'vitest';
import { deepFreeze, parseImmutableJson } from '@editor-platform/artifact-core';
import { sameContent } from './immutable-content';

it('compares plain data completely without evaluating accessors or conflating non-data objects', () => {
  const left = { rows: [{ value: 3, empty: null }], optional: undefined };
  expect(sameContent(left, structuredClone(left))).toBe(true);
  expect(sameContent(left, { rows: left.rows })).toBe(false);
  expect(sameContent(left, { ...left, rows: [{ value: 4, empty: null }] })).toBe(false);
  expect(sameContent(new Date(0), new Date(1))).toBe(false);
  expect(sameContent(new Map([['value', 1]]), new Map([['value', 2]]))).toBe(false);
  expect(sameContent([undefined], Array(1))).toBe(false);
  expect(sameContent({ value: 0 }, { value: -0 })).toBe(false);
  const hidden = Object.defineProperty({}, 'value', { value: 1, enumerable: false });
  expect(sameContent(hidden, { value: 1 })).toBe(false);
  const accessor = Object.defineProperty({}, 'value', {
    get() {
      throw new Error('Do not read');
    },
  });
  expect(sameContent(accessor, hidden)).toBe(false);
});

it('compares mutable and shallow-frozen branches again after a previous match', () => {
  for (const shallow of [false, true]) {
    const left = { rows: [{ value: 1 }] };
    if (shallow) Object.freeze(left);
    const right = structuredClone(left);
    expect(sameContent(left, right)).toBe(true);
    left.rows[0].value = 2;
    expect(sameContent(left, right)).toBe(false);
    right.rows[0].value = 2;
    expect(sameContent(left, right)).toBe(true);
  }
});

it('retains exact symbols, hidden properties, array holes and incoming accessor checks after caching', () => {
  const key = Symbol('metadata');
  const sparse: (number | undefined)[] = Array(3);
  sparse[0] = undefined;
  sparse[2] = 0;
  const left = deepFreeze(
    Object.defineProperty({ [key]: sparse.slice() }, 'hidden', {
      value: 7,
      enumerable: false,
    }),
  );
  const right = Object.defineProperty({ [key]: sparse.slice() }, 'hidden', {
    value: 7,
    enumerable: false,
    configurable: true,
  });
  expect(sameContent(left, right)).toBe(true);
  right[key][1] = undefined;
  expect(sameContent(left, right)).toBe(false);
  delete right[key][1];
  right[key][2] = -0;
  expect(sameContent(left, right)).toBe(false);
  right[key][2] = 0;
  expect(sameContent(left, right)).toBe(true);
  Object.defineProperty(right, 'hidden', { enumerable: true });
  expect(sameContent(left, right)).toBe(false);
  let reads = 0;
  Object.defineProperty(right, 'hidden', {
    enumerable: false,
    get() {
      reads++;
      return 7;
    },
  });
  expect(sameContent(left, right)).toBe(false);
  expect(reads).toBe(0);
});

it('does not treat untraversed hidden children as immutable when the parent is certified', () => {
  const child = { value: 1 };
  const left = deepFreeze(Object.defineProperty({}, 'hidden', { value: child }));
  const other = { value: 1 };
  const right = Object.defineProperty({}, 'hidden', { value: other });
  expect(Object.isFrozen(child)).toBe(false);
  expect(sameContent(left, right)).toBe(true);
  child.value = 2;
  expect(sameContent(left, right)).toBe(false);
  other.value = 2;
  expect(sameContent(left, right)).toBe(true);
});

it('rechecks hidden and symbolic mutable children even when both roots are certified', () => {
  const symbol = Symbol('child');
  for (const key of ['hidden', symbol]) {
    const leftChild = { value: 1 },
      rightChild = { value: 1 };
    const left = deepFreeze(Object.defineProperty({}, key, { value: leftChild }));
    const right = deepFreeze(Object.defineProperty({}, key, { value: rightChild }));
    expect(sameContent(left, right)).toBe(true);
    expect(sameContent(left, right)).toBe(true);
    rightChild.value = 2;
    expect(sameContent(left, right)).toBe(false);
    leftChild.value = 2;
    expect(sameContent(left, right)).toBe(true);
  }
});

it('keeps later immutable inputs, holes, signed zero and accessors distinct after an equal pair', () => {
  const left = deepFreeze({ rows: [{ value: 0 }], empty: [undefined] });
  const right = deepFreeze(structuredClone(left));
  expect(sameContent(left, right)).toBe(true);
  expect(sameContent(left, right)).toBe(true);
  expect(sameContent(left, deepFreeze({ ...right, rows: [{ value: -0 }] }))).toBe(false);
  expect(sameContent(left, deepFreeze({ ...right, empty: Array(1) }))).toBe(false);
  const accessor = Object.defineProperty({}, 'rows', {
    enumerable: true,
    get() {
      throw Error('Do not read');
    },
  });
  Object.assign(accessor, { empty: right.empty });
  expect(sameContent(left, Object.freeze(accessor))).toBe(false);
});

it('compares every field of owned JSON receipts while preserving non-JSON distinctions', () => {
  const left = deepFreeze({ rows: [{ value: 0, empty: null }], optional: 'present' });
  const receipt = parseImmutableJson(JSON.stringify(left));
  expect(sameContent(left, receipt)).toBe(true);
  expect(sameContent(left, receipt)).toBe(true);
  expect(
    sameContent(
      left,
      parseImmutableJson('{"rows":[{"value":-0,"empty":null}],"optional":"present"}'),
    ),
  ).toBe(false);
  expect(sameContent(left, parseImmutableJson('{"rows":[{"value":0,"empty":null}]}'))).toBe(false);
  expect(
    sameContent(left, parseImmutableJson('{"rows":[{"value":0,"empty":null}],"other":"present"}')),
  ).toBe(false);
  expect(sameContent([undefined], parseImmutableJson('[null]'))).toBe(false);
  expect(sameContent(Array(1), parseImmutableJson('[null]'))).toBe(false);
  expect(sameContent({ value: undefined }, parseImmutableJson('{}'))).toBe(false);
  expect(sameContent(Object.assign([1], { extra: 2 }), parseImmutableJson('[1]'))).toBe(false);
  const hidden = Object.defineProperty({}, 'value', { value: 1, enumerable: false });
  expect(sameContent(hidden, parseImmutableJson('{"value":1}'))).toBe(false);
  expect(sameContent({ [Symbol('value')]: 1 }, parseImmutableJson('{"value":1}'))).toBe(false);
  const accessor = Object.defineProperty({}, 'value', {
    enumerable: true,
    get() {
      throw Error('Do not invoke');
    },
  });
  expect(sameContent(accessor, parseImmutableJson('{"value":1}'))).toBe(false);
  expect(sameContent(Object.create(null), parseImmutableJson('{}'))).toBe(false);
});
