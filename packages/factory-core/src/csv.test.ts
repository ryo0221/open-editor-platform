import { describe, expect, it } from 'vitest';
import { applyFactoryOperation } from './operations';
import { f170SmallLine } from './fixtures';
import { parseFactoryCsvRows, readFactoryTimesCsv, writeFactoryTimesCsv } from './csv';
import { validateFactory } from './validation';
import type { FactoryDocument } from './model';

const apply = (doc: FactoryDocument, text: string) =>
  readFactoryTimesCsv(doc, text).reduce((d, op) => applyFactoryOperation(d, op), doc);

// TS-2654: times CSV and floor-plan placement in the model.
describe('factory times CSV and placement (TS-2654)', () => {
  it('parses RFC 4180 rows and reports where a quote breaks', () => {
    expect(parseFactoryCsvRows('﻿a,"b,""c"""\r\n"d\ne",f\n\n')).toEqual([
      ['a', 'b,"c"'],
      ['d\ne', 'f'],
    ]);
    expect(parseFactoryCsvRows('a\n"b')).toEqual({
      error: 'a quoted field is not closed',
      line: 2,
    });
    expect(parseFactoryCsvRows('a,b"c')).toEqual({
      error: 'a quote inside an unquoted field',
      line: 1,
    });
  });

  it('writes every time in seconds and reads it back unchanged', () => {
    const doc = f170SmallLine();
    const text = writeFactoryTimesCsv(doc);
    expect(text.split('\r\n').slice(0, 3)).toEqual([
      'object,product,type,value,min,mode,max,mean,sd',
      'in-housing,,const,60,,,,,',
      'machining,,triangular,,100,110,130,,',
    ]);
    expect(apply(doc, text)).toEqual(doc);
  });

  it('keeps the bounds of a normal distribution through a round trip', () => {
    const doc = f170SmallLine();
    const test = doc.objects.find((o) => o.id === 'test')!;
    if (test.kind !== 'station') throw new Error('fixture');
    test.processTime = { type: 'normal', mean: 60_000, sd: 10_000, min: 59_000, max: 61_000 };
    const text = writeFactoryTimesCsv(doc);
    expect(text).toContain('test,,normal,,59,,61,60,10');
    expect(apply(doc, text)).toEqual(doc);
    // Bounds stay optional; mode is still refused.
    expect(readFactoryTimesCsv(doc, 'object,type,mean,sd,min\ntest,normal,60,10,\n')).toHaveLength(
      1,
    );
    expect(() =>
      readFactoryTimesCsv(doc, 'object,type,mean,sd,mode\ntest,normal,60,10,5\n'),
    ).toThrow('mode is not a value of normal');
  });

  it('changes only the rows given, with columns in any order', () => {
    const doc = {
      ...f170SmallLine(),
    };
    const next = apply(
      doc,
      'TYPE,mean,Object,sd\nnormal,58.5,test,4\nexponential,70,in-housing,\n',
    );
    const test = next.objects.find((o) => o.id === 'test')!;
    expect(test.kind === 'station' && test.processTime).toEqual({
      type: 'normal',
      mean: 58500,
      sd: 4000,
    });
    const housing = next.objects.find((o) => o.id === 'in-housing')!;
    expect(housing.kind === 'source' && housing.interval).toEqual({
      type: 'exponential',
      mean: 70000,
    });
    expect(readFactoryTimesCsv(doc, 'object,type,mean,sd\ntest,normal,58,4\n')).toHaveLength(1);
  });

  it('refuses the whole file with the line of the first bad row', () => {
    const doc = f170SmallLine();
    const cases: [string, string][] = [
      ['object,type,value\nnope,const,1', 'line 2: no object nope'],
      ['object,type,value\ntest,const,1\ntest,const,2', 'line 3: the same time twice'],
      ['object,type,value\ntest,gamma,1', 'line 2: unknown type gamma'],
      ['object,type,value\ntest,const,-1', 'line 2: value is not seconds'],
      ['object,type,value,mean\ntest,const,1,2', 'line 2: mean is not a value of const'],
      ['object,type,mean\ntest,normal,1', 'line 2: sd is required for normal'],
      ['object,type,value\nout,const,1', 'line 2: out has no time'],
      [
        'object,product,type,value\nassembly,eaxle,const,1',
        'line 2: assembly has no product times',
      ],
      ['object,colour\ntest,red', 'line 1: unknown column colour'],
      ['object,value\ntest,1', 'line 1: no type column'],
    ];
    for (const [text, message] of cases)
      expect(() => readFactoryTimesCsv(doc, text), message).toThrow(message);
  });

  it('sets a time for one product on a station', () => {
    const doc = f170SmallLine();
    const next = apply(doc, 'object,product,type,value\ntest,eaxle,const,61.25\n');
    const test = next.objects.find((o) => o.id === 'test')!;
    expect(test.kind === 'station' && test.productTimes).toEqual([
      { productId: 'eaxle', time: { type: 'const', value: 61250 } },
    ]);
    expect(writeFactoryTimesCsv(next)).toContain('test,eaxle,const,61.25,,,,,');
  });

  it('checks placements as whole millimetres within the limits', () => {
    const doc = f170SmallLine();
    const at = (a: unknown) => ({
      ...doc,
      objects: doc.objects.map((o, i) => (i ? o : { ...o, at: a })),
    });
    expect(validateFactory(at({ x: 1000, y: -2000, angle: 90 }))).toEqual([]);
    expect(validateFactory(at({ x: 0.5, y: 0 })).map((d) => d.path)).toEqual(['$.objects.0.at.x']);
    expect(validateFactory(at({ x: 0, y: 0, angle: 400 })).map((d) => d.path)).toEqual([
      '$.objects.0.at.angle',
    ]);
    expect(validateFactory(at({ x: 0 })).length).toBeGreaterThan(0);
  });
});
