import { describe, expect, it } from 'vitest';
import {
  prepareHostTextReplacement,
  readHostContent,
  readHostElement,
} from '@editor-platform/editor-host';
import type { StructuredData } from './model';
import { dataHostAdapter } from '@editor-platform/structured-data/native-host';
const content = (): StructuredData => ({
  schemaVersion: 2,
  columns: [
    { id: 'quantity', name: 'Quantity', type: 'number' },
    { id: 'total', name: 'Total', type: 'formula', formula: 'Quantity*2' },
  ],
  rows: [{ id: 'row', values: { quantity: 4 } }],
});
describe('Data native Host adapter', () => {
  it('projects one exact row with domain-evaluated values and refuses text proposals', () => {
    const c = content();
    expect(readHostElement(dataHostAdapter, c, 'row')).toMatchObject({
      row: c.rows[0],
      values: { quantity: 4, total: 8 },
    });
    expect(readHostElement(dataHostAdapter, c, 'missing')).toBeNull();
    expect(readHostElement(dataHostAdapter, c, 'whole')).toBeNull();
    expect(() =>
      prepareHostTextReplacement(dataHostAdapter, c, { selector: 'row', before: '4', after: '5' }),
    ).toThrow('unsupported');
    expect(c.rows[0].values.quantity).toBe(4);
    c.rows[0].id = 'whole';
    expect(readHostElement(dataHostAdapter, c, 'whole')).toMatchObject({ row: c.rows[0] });
    const copy = readHostContent(dataHostAdapter, c);
    copy.rows[0].values.quantity = 99;
    expect(c.rows[0].values.quantity).toBe(4);
  });
  it('rejects formula evaluation failure and duplicate IDs rather than claiming a valid projection', () => {
    const bad = content();
    bad.columns[1].formula = 'Missing+1';
    expect(() => readHostElement(dataHostAdapter, bad, 'row')).toThrow();
    const duplicate = content();
    duplicate.rows.push({ ...duplicate.rows[0] });
    expect(() => readHostElement(dataHostAdapter, duplicate, 'row')).toThrow();
  });
});
