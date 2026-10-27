import { describe, expect, it } from 'vitest';
import { applyCadOperation, f02Plate, type CadDocument } from '@editor-platform/cad-core';
import { describeCode } from './controller';
import { readCadInput } from './expression-input';

const schema2 = (): CadDocument =>
  applyCadOperation(f02Plate(), {
    type: 'insertFeatures',
    parameters: [
      { id: 'a', name: 'Tilt', type: 'angle', value: Math.PI / 6 },
      { id: 'w2', name: 'wall thickness', type: 'length', value: 2 },
      { id: 'd1', name: 'dup', type: 'length', value: 1 },
      { id: 'd2', name: 'dup', type: 'length', value: 2 },
    ],
    features: [],
  });
const message = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return 'no-error';
};

describe('Inspector input with expressions (CAD27)', () => {
  it('keeps plain numbers literal and parses expressions by parameter name', () => {
    const doc = schema2();
    expect(readCadInput(' 12.5 ', doc, 'length')).toEqual({ literal: 12.5 });
    expect(readCadInput('-1e2', doc, 'length')).toEqual({ literal: -100 });
    expect(readCadInput('Width / 20', doc, 'length')).toEqual({
      expression: { postfix: [{ parameterId: 'W' }, { number: 20 }, { operator: 'div' }] },
    });
    expect(readCadInput('{wall thickness} × 2', doc, 'length')).toEqual({
      expression: { postfix: [{ parameterId: 'w2' }, { number: 2 }, { operator: 'mul' }] },
    });
    expect(readCadInput('Tilt + 15deg', doc, 'angle')).toMatchObject({ expression: {} });
    expect(readCadInput('Width / Depth', doc, 'scalar')).toMatchObject({ expression: {} });
  });

  it('refuses with a message the field shows, never changing the document', () => {
    const doc = schema2();
    expect(message(() => readCadInput('Width +', doc, 'length'))).toBe(
      '式として読めません（8文字目）。',
    );
    expect(message(() => readCadInput('Width + Gap', doc, 'length'))).toBe(
      'その名前のparameterはありません（9文字目）。',
    );
    expect(message(() => readCadInput('dup * 2', doc, 'length'))).toBe(
      '同じ名前のparameterが複数あります。名前を変えてください（1文字目）。',
    );
    expect(message(() => readCadInput('Tilt', doc, 'length'))).toBe(
      'この欄には長さ（mm・cm・m・in）の式を入れてください。',
    );
    expect(message(() => readCadInput('Width + Tilt', doc, 'length'))).toBe(
      describeCode('expression-type'),
    );
    expect(message(() => readCadInput('Width / (Depth - 50mm)', doc, 'length'))).toBe(
      describeCode('expression-division-by-zero'),
    );
    expect(message(() => readCadInput('  ', doc, 'length'))).toBe('数か式を入力してください。');
  });
});
