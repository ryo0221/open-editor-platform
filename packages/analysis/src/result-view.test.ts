import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { createAnalysis, type Table } from '@editor-platform/analysis-core';
import { DifferenceTable, ResultChart, displayValue } from './result-view';
import { resultSvg } from './references';

it('visible comparison preserves nested cast operands, field/parameter IDs and rounding rules', () => {
  const before = {
    op: 'cast',
    value: { op: 'field', id: 'qty-before' },
    type: { kind: 'decimal', unit: 'm' },
  };
  const after = {
    op: 'cast',
    value: {
      op: 'divide',
      left: { op: 'field', id: 'qty-after' },
      right: { op: 'parameter', id: 'factor-after' },
      scale: 2,
      rounding: 'half-up',
    },
    type: { kind: 'decimal', unit: 'm' },
  };
  const html = renderToStaticMarkup(
    createElement(DifferenceTable, {
      changes: [
        {
          kind: 'steps',
          id: 'derive',
          before: { id: 'derive', expression: before },
          after: { id: 'derive', expression: after },
        },
      ],
      document: createAnalysis(),
      label: '式の差分',
    }),
  );
  const visibleTable = html.slice(0, html.indexOf('</table>'));
  expect(visibleTable).toContain('型・単位変換(列 [qty-before])');
  expect(visibleTable).toContain('列 [qty-after]');
  expect(visibleTable).toContain('Parameter [factor-after]');
  expect(visibleTable).toContain('小数2桁 / half-up');
  expect(visibleTable).not.toContain('[object Object]');
});
it('visible comparison distinguishes text literals from references and keeps parameter values readable', () => {
  const html = renderToStaticMarkup(
    createElement(DifferenceTable, {
      changes: [
        {
          kind: 'steps',
          id: 'filter',
          before: { op: 'literal', type: { kind: 'text' }, value: 'qty' },
          after: { op: 'field', id: 'qty' },
        },
        {
          kind: 'parameters',
          id: 'factor',
          before: {
            label: 'Factor',
            type: { kind: 'decimal', unit: 'dimensionless' },
            value: '1000',
          },
          after: {
            label: 'Factor',
            type: { kind: 'decimal', unit: 'dimensionless' },
            value: '2000',
          },
        },
      ],
      document: createAnalysis(),
      label: '差分',
    }),
  );
  const visibleTable = html.slice(0, html.indexOf('</table>'));
  expect(visibleTable).toContain('定数 qty · text');
  expect(visibleTable).toContain('列 [qty]');
  expect(visibleTable).toContain('Factor: 1,000');
  expect(visibleTable).toContain('Factor: 2,000');
});
it('Chart rendering explains text-only and oversized-column results without weakening reference rejection', () => {
  const text: Table = {
    fields: [{ id: 'label', label: 'Label', type: { kind: 'text' } }],
    rows: [{ id: 'row', values: { label: 'text only' } }],
    diagnostics: [],
  };
  expect(renderToStaticMarkup(createElement(ResultChart, { table: text }))).toContain(
    'Chartにはdecimal列が必要',
  );
  expect(() => resultSvg(text, true)).toThrow('decimal列');
  const wide: Table = {
    fields: Array.from({ length: 31 }, (_, i) => ({
      id: `c${i}`,
      label: `Column ${i}`,
      type: { kind: 'decimal', unit: 'dimensionless' },
    })),
    rows: [
      {
        id: 'row',
        values: Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`c${i}`, '1'])),
      },
    ],
    diagnostics: [],
  };
  expect(renderToStaticMarkup(createElement(ResultChart, { table: wide }))).toContain('30列');
  expect(() => resultSvg(wide, true)).toThrow('30列');
  const supported = { ...wide, fields: wide.fields.slice(0, 1) };
  expect(renderToStaticMarkup(createElement(ResultChart, { table: supported }))).toContain(
    'alt="分析Chart',
  );
});

it('formats decimal strings without binary64 loss and distinguishes null, empty, missing and zero', () => {
  const type = { kind: 'decimal', unit: 'currency:JPY:0' } as const;
  expect(displayValue('79263353441777708', type)).toBe('79,263,353,441,777,708');
  expect(displayValue('-12345.000000000000000001', type)).toBe('-12,345.000000000000000001');
  expect(displayValue('1000', { kind: 'text' })).toBe('1000');
  expect(new Set([null, '', undefined, '0'].map((v) => displayValue(v, type))).size).toBe(4);
});
