import { expect, it } from 'vitest';
import { decimalType, expressionType, evaluateScalar, type Expression } from './scalar';
const environment = {
  fields: { length: decimalType('m'), offset: decimalType('mm') },
  parameters: {},
};
it('converts compatible units before addition and rejects incompatible branches', () => {
  const expression: Expression = {
    op: 'add',
    left: { op: 'field', id: 'length' },
    right: { op: 'field', id: 'offset' },
  };
  expect(evaluateScalar(expression, environment, { length: '1', offset: '500' }, {})).toBe('1.5');
  expect(() =>
    expressionType(expression, {
      ...environment,
      fields: { length: decimalType('m'), offset: decimalType('m2') },
    }),
  ).toThrow('unit-mismatch');
});
it('distinguishes missing, null, zero and empty strings', () => {
  const expression: Expression = { op: 'field', id: 'length' };
  expect(evaluateScalar(expression, environment, { length: null }, {})).toBeNull();
  expect(evaluateScalar(expression, environment, { length: '0' }, {})).toBe('0');
  expect(() => evaluateScalar(expression, environment, {}, {})).toThrow('missing-value');
});
it('checks both branches before selecting and rejects arbitrary calls', () => {
  expect(() =>
    expressionType(
      {
        op: 'if',
        condition: { op: 'literal', type: { kind: 'boolean' }, value: true },
        then: { op: 'field', id: 'length' },
        else: { op: 'field', id: 'missing' },
      },
      environment,
    ),
  ).toThrow('missing-reference');
  expect(() => expressionType({ op: 'fetch', url: 'https://example.org' }, environment)).toThrow(
    'unknown-operation',
  );
});
it('AN03 enforces 256 nodes and depth 16 at the exact boundaries', () => {
  const literal: Expression = { op: 'literal', type: decimalType(), value: '1' };
  const tree = (depth: number): Expression =>
    depth ? { op: 'add', left: tree(depth - 1), right: tree(depth - 1) } : literal;
  const nodes255 = tree(7),
    nodes256: Expression = { op: 'quantize', value: nodes255, scale: 0, rounding: 'half-even' };
  expect(expressionType(nodes256, { fields: {}, parameters: {} })).toEqual(decimalType());
  expect(() =>
    expressionType(
      { op: 'quantize', value: nodes256, scale: 0, rounding: 'half-even' },
      { fields: {}, parameters: {} },
    ),
  ).toThrow('expression-limit');
  let deep: Expression = literal;
  for (let i = 0; i < 15; i++)
    deep = { op: 'quantize', value: deep, scale: 0, rounding: 'half-even' };
  expect(expressionType(deep, { fields: {}, parameters: {} })).toEqual(decimalType());
  expect(() =>
    expressionType(
      { op: 'quantize', value: deep, scale: 0, rounding: 'half-even' },
      { fields: {}, parameters: {} },
    ),
  ).toThrow('expression-limit');
});

it('orders supplementary Unicode characters by scalar value rather than surrogate code units', async () => {
  const { compareText } = await import('./scalar');
  expect(compareText('\uE000', '😀')).toBe(-1);
  expect(compareText('a', 'aa')).toBe(-1);
});
