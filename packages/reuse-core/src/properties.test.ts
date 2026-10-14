import { expect, it } from 'vitest';
import {
  resolveComponentProperties,
  validateSlotAssignment,
  validateComponentContract,
  type ComponentContract,
} from './index';

const contract: ComponentContract = {
  schemaVersion: 1,
  parts: [
    { id: 'title', nativeId: 'prototype-title' },
    { id: 'body', nativeId: 'prototype-body' },
  ],
  properties: [
    {
      id: 'label',
      label: '案件名',
      type: 'text',
      default: 'Sample',
      required: true,
      targets: [{ partId: 'title', field: 'text' }],
    },
    {
      id: 'visible',
      label: '表示',
      type: 'boolean',
      default: true,
      targets: [{ partId: 'title', field: 'visible' }],
    },
    {
      id: 'tone',
      label: '種類',
      type: 'enum',
      default: 'notice',
      options: ['notice', 'warning'],
      targets: [{ partId: 'body', field: 'tone' }],
    },
    {
      id: 'rich',
      label: '本文',
      type: 'rich-text',
      default: [{ text: '説明', bold: true }],
      targets: [{ partId: 'body', field: 'rich' }],
    },
  ],
  variants: [
    { id: 'normal', label: '通常', values: {} },
    { id: 'quiet', label: '非表示', values: { visible: false } },
  ],
  defaultVariant: 'normal',
  slots: [
    {
      id: 'body',
      partId: 'body',
      label: '本文',
      domain: 'document',
      accepts: ['body', 'component'],
      min: 0,
      max: 2,
    },
  ],
};
it('retains explicit input equal to default and non-target input across variants', () => {
  const first = resolveComponentProperties(contract, { label: 'Sample' });
  expect(first.explicit).toEqual(['label']);
  expect(
    resolveComponentProperties(
      contract,
      { label: '案件A', rich: [{ text: '手書きの本文' }] },
      'quiet',
    ),
  ).toMatchObject({ values: { label: '案件A', visible: false, rich: [{ text: '手書きの本文' }] } });
  expect(resolveComponentProperties(contract, { visible: true }, 'quiet').values.visible).toBe(
    true,
  );
  expect(resolveComponentProperties(contract, {}, 'quiet').values.visible).toBe(false);
});
it.each([
  { label: 1 },
  { visible: 'true' },
  { tone: 'invalid' },
  { label: '' },
  { rich: [{ text: 'text', script: 'eval' }] },
  { unknown: 'x' },
])('rejects invalid public input before native changes: %j', (input) => {
  expect(() => resolveComponentProperties(contract, input)).toThrow();
});
it('validates variant, public part addresses and typed slot count/domain', () => {
  expect(() => validateComponentContract({ ...contract, defaultVariant: 1 })).toThrow();
  expect(() =>
    validateComponentContract({
      ...contract,
      parts: [{ id: '1', nativeId: 'one' }],
      properties: [{ ...contract.properties[0], targets: [{ partId: 1, field: 'text' }] }],
    }),
  ).toThrow();
  expect(() => resolveComponentProperties(contract, {}, 'missing')).toThrow();
  expect(() =>
    validateComponentContract({
      ...contract,
      properties: [{ ...contract.properties[0], targets: [{ partId: 'gone', field: 'text' }] }],
    }),
  ).toThrow();
  validateSlotAssignment(contract, 'body', [{ domain: 'document', kind: 'body' }]);
  expect(() =>
    validateSlotAssignment(contract, 'body', [{ domain: 'design', kind: 'component' }]),
  ).toThrow();
  expect(() =>
    validateSlotAssignment(
      contract,
      'body',
      Array.from({ length: 3 }, () => ({ domain: 'document' as const, kind: 'body' as const })),
    ),
  ).toThrow();
});
