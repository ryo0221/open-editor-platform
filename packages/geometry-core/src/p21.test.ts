import { describe, expect, it } from 'vitest';
import { P21ReadError, readP21, type P21Limits } from './p21';

const limits: P21Limits = { bytes: 1 << 20, entities: 100, depth: 8 };
const file = (data: string, header = "FILE_SCHEMA(('IFC4'));") =>
  new TextEncoder().encode(
    `ISO-10303-21;\nHEADER;\n${header}\nENDSEC;\nDATA;\n${data}\nENDSEC;\nEND-ISO-10303-21;\n`,
  );
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof P21ReadError ? e.code : String(e);
  }
  return 'none';
};

describe('readP21', () => {
  it('reads every value form, comments and string escapes', () => {
    const r = readP21(
      file(
        [
          "#1=IFCX($,*,.T.,.ELEMENT.,12,-3.5,1.E-5,2.5E+3,'it''s \\\\ a',\"0FF\");",
          '/* a comment; with #9=X(); inside */',
          "#2 = IFCY ( ( #1 , #1 ) , IFCLABEL ( 'x' ) , ( ) ) ;",
          "#3=IFCZ('\\X2\\65E5672C\\X0\\','\\X\\E9','\\X4\\0001F600\\X0\\','\\PA\\\\S\\i','\\PE\\\\S\\0','\\S\\0');",
          '#4=(IFCA(1)IFCB(#3));',
        ].join('\n'),
      ),
      limits,
    );
    expect(r.header).toEqual([
      { type: 'FILE_SCHEMA', args: [{ t: 'list', v: [{ t: 'str', v: 'IFC4' }] }] },
    ]);
    expect(r.entities.get(1)!.args).toEqual([
      { t: 'unset' },
      { t: 'derived' },
      { t: 'enum', v: 'T' },
      { t: 'enum', v: 'ELEMENT' },
      { t: 'int', v: 12 },
      { t: 'real', v: -3.5 },
      { t: 'real', v: 1e-5 },
      { t: 'real', v: 2500 },
      { t: 'str', v: "it's \\ a" },
      { t: 'binary', v: '0FF' },
    ]);
    expect(r.entities.get(2)).toEqual({
      id: 2,
      type: 'IFCY',
      args: [
        {
          t: 'list',
          v: [
            { t: 'ref', id: 1 },
            { t: 'ref', id: 1 },
          ],
        },
        { t: 'typed', name: 'IFCLABEL', v: { t: 'str', v: 'x' } },
        { t: 'list', v: [] },
      ],
    });
    expect(r.entities.get(3)!.args.map((a) => (a as { v: string }).v)).toEqual([
      '日本',
      'é',
      '😀',
      'é',
      // ISO 8859-5 for the string that selects it; part 1 again at the next.
      'А',
      '°',
    ]);
    expect(r.entities.get(4)).toEqual({
      id: 4,
      type: '',
      args: [],
      parts: [
        { type: 'IFCA', args: [{ t: 'int', v: 1 }] },
        { type: 'IFCB', args: [{ t: 'ref', id: 3 }] },
      ],
    });
    expect([...r.entities.keys()]).toEqual([1, 2, 3, 4]);
  });

  it('refuses broken files and limits', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(code(() => readP21(enc('ISO-10303-21;\nHEADER;'), limits))).toBe('p21-syntax');
    expect(code(() => readP21(file("#1=X('open);"), limits))).toBe('p21-syntax');
    expect(code(() => readP21(file('#1=X(1,);'), limits))).toBe('p21-syntax');
    expect(code(() => readP21(file('#1=X(1)'), limits))).toBe('p21-syntax');
    expect(code(() => readP21(file("#1=X('\\X2\\12\\X0\\');"), limits))).toBe('p21-syntax');
    // ISO 8859-6 leaves 0xA1 undefined: refused, not replaced.
    expect(code(() => readP21(file("#1=X('\\PF\\\\S\\!');"), limits))).toBe('p21-syntax');
    expect(code(() => readP21(file('#1=X(1);\n#1=X(2);'), limits))).toBe('p21-duplicate-id');
    expect(code(() => readP21(file('#1=X(#2);'), limits))).toBe('p21-unresolved-reference');
    // Whitespace and comments may sit between an instance's ID and `=`.
    expect(
      readP21(file(`#1 /* the first */${' '.repeat(64)}= X(1);`), limits).entities.get(1)?.type,
    ).toBe('X');
    // A scan that leaves resolving to another reader keeps the reference as it is.
    expect(
      readP21(file('#1=X(#2);'), limits, { references: 'keep' }).entities.get(1)?.args,
    ).toEqual([{ t: 'ref', id: 2 }]);
    expect(code(() => readP21(file('#1=X(1);'), { ...limits, bytes: 10 }))).toBe('p21-too-large');
    expect(code(() => readP21(file('#1=X(1);\n#2=X(1);'), { ...limits, entities: 1 }))).toBe(
      'p21-too-many-entities',
    );
    expect(code(() => readP21(file('#1=X(((((1)))));'), { ...limits, depth: 3 }))).toBe(
      'p21-too-deep',
    );
    expect(code(() => readP21(file('#1=X(((1)));'), { ...limits, depth: 3 }))).toBe('none');
    expect(code(() => readP21(enc(`${new TextDecoder().decode(file(''))}junk`), limits))).toBe(
      'p21-syntax',
    );
  });

  it('reads raw UTF-8 in strings and falls back to Latin-1', () => {
    const utf8 = readP21(file("#1=X('café');"), limits);
    expect(utf8.entities.get(1)!.args[0]).toEqual({ t: 'str', v: 'café' });
    const bytes = file("#1=X('café');");
    // Re-encode é as a single Latin-1 byte: not valid UTF-8.
    const latin = new Uint8Array(
      [...bytes].flatMap((b, k, a) =>
        b === 0xc3 && a[k + 1] === 0xa9 ? [0xe9] : b === 0xa9 && a[k - 1] === 0xc3 ? [] : [b],
      ),
    );
    expect(readP21(latin, limits).entities.get(1)!.args[0]).toEqual({ t: 'str', v: 'café' });
  });
});
