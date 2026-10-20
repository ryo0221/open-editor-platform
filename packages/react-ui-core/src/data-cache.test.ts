import { expect, it } from 'vitest';
import { deepFreeze } from '@editor-platform/artifact-core';
import { checkData, ReactUiError } from './data';
import { reactUiLimits } from './types';

it('charges every occurrence and nested depth of descriptor-certified immutable data', () => {
  const shared = deepFreeze({ values: Array(1000).fill(null) });
  checkData(shared);
  expect(() => checkData(Array(100).fill(shared))).toThrow(/value\/depth limit/);
  let wrapped: unknown = shared;
  for (let i = 0; i < reactUiLimits.jsonDepth; i++) wrapped = { nested: wrapped };
  expect(() => checkData(wrapped)).toThrow(/value\/depth limit/);
});

it('retains byte limits when the immutable descriptor budget was already cached', () => {
  const shared = deepFreeze({ text: 'x'.repeat(100000) });
  checkData(shared);
  expect(() => checkData(Array(100).fill(shared))).toThrow(/byte\/value budget/);
});

it('never certifies hidden properties or accessors on externally frozen trees', () => {
  for (const accessor of [false, true]) {
    let reads = 0;
    const input = {};
    Object.defineProperty(
      input,
      'hidden',
      accessor
        ? {
            enumerable: true,
            get() {
              reads++;
              return 'execution';
            },
          }
        : { value: 'hidden', enumerable: false },
    );
    Object.freeze(input);
    expect(() => checkData(input)).toThrow(/Accessors and hidden properties/);
    expect(() => checkData(input)).toThrow(/Accessors and hidden properties/);
    expect(reads).toBe(0);
  }
});

it('reports the exact nested path without reading an accessor after valid siblings', () => {
  let reads = 0;
  const invalid = Object.defineProperty({}, 'secret', {
    enumerable: true,
    get() {
      reads++;
      return 'execution';
    },
  });
  try {
    checkData({ first: { valid: true }, second: [invalid] });
    throw Error('Expected descriptor rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(ReactUiError);
    expect((error as ReactUiError).diagnostics[0].path).toBe('$.second.0.secret');
  }
  expect(reads).toBe(0);
});
