import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { importStep, scanStep } from './step-import';

const corpus = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/f07/${name}`, import.meta.url)));
const text = (s: string) => new TextEncoder().encode(s);
const scanCode = (bytes: Uint8Array) => {
  try {
    scanStep(bytes);
    return 'ok';
  } catch (e) {
    return (e as { code?: string }).code;
  }
};

describe('STEP text scan before the reader (F07, CAD11)', () => {
  it('names the protocol and the information the import does not keep', () => {
    expect(scanStep(corpus('normal-mm-plate.step'))).toEqual({
      schema: 'AP214',
      fileSchema: 'AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }',
      sourceUnit: 'mm',
      losses: ['product-names', 'source-feature-history'],
      // Each PRODUCT's id, name and description (R2b-5: an assembly import names its parts).
      products: [
        {
          entity: 7,
          id: 'Open CASCADE STEP translator 8.0 1',
          name: 'Open CASCADE STEP translator 8.0 1',
          description: '',
        },
      ],
      usages: [],
    });
    expect(scanStep(corpus('normal-ap203.step')).schema).toBe('AP203');
    expect(scanStep(corpus('normal-colour.step')).losses).toContain('appearance');
  });

  it('refuses other protocols, assemblies, PMI, external references and non-STEP bytes', () => {
    expect(scanCode(corpus('reject-ap242.step'))).toBe('step-schema-unsupported');
    expect(scanCode(corpus('reject-assembly.step'))).toBe('step-assembly');
    // An AP242 assembly (as R2b-5 writes one) is an assembly to the single import, so it goes on
    // to the assembly import; read as an assembly, its schema is accepted.
    const ap242 = text(
      new TextDecoder()
        .decode(corpus('reject-assembly.step'))
        .replace(
          /FILE_SCHEMA\(\('[^']*'\)\)/,
          "FILE_SCHEMA(('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 1 1 4 }'))",
        ),
    );
    expect(scanCode(ap242)).toBe('step-assembly');
    expect(scanStep(ap242, { assembly: true }).schema).toBe('AP242');
    expect(scanCode(corpus('reject-pmi-dimension.step'))).toBe('step-pmi');
    expect(scanCode(corpus('reject-external-reference.step'))).toBe('step-external-reference');
    expect(scanCode(corpus('reject-not-step.step'))).toBe('step-unreadable');
    expect(scanCode(corpus('reject-truncated.step'))).toBe('step-unreadable');
  });

  const mm = '#9 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );';
  const contextAt = (id: number, ...units: string[]) =>
    `#${id} = ( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNIT_ASSIGNED_CONTEXT((${units.join(',')})) REPRESENTATION_CONTEXT('',''));`;
  const context = (...units: string[]) => contextAt(8, ...units);
  const file = (data: string, units = `${mm}\n${context('#9')}`) =>
    text(
      `ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\nENDSEC;\nDATA;\n${units}\n${data}\nENDSEC;\nEND-ISO-10303-21;\n`,
    );

  it('reads the length unit of the representation context (ST-29 #1)', () => {
    expect(scanStep(corpus('normal-inch-block.step')).sourceUnit).toBe('in');
    expect(scanStep(corpus('normal-m-cone.step')).sourceUnit).toBe('m');
    expect(scanCode(corpus('reject-unit-mile.step'))).toBe('step-unit-unknown');
    const unit = (units: string) => {
      try {
        return scanStep(file('', units)).sourceUnit;
      } catch (e) {
        return (e as { code?: string }).code;
      }
    };
    expect(
      unit(`#9 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.CENTI.,.METRE.) );\n${context('#9')}`),
    ).toBe('cm');
    // A quoted name never counts as the unit; the name is read from the original text.
    expect(
      unit(
        `#7 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );\n#9 = ( CONVERSION_BASED_UNIT('foot /* x */',#6) LENGTH_UNIT() NAMED_UNIT(#5) );\n${context('#9')}`,
      ),
    ).toBe('step-unit-unknown');
    expect(
      unit(
        `${mm}\n#7 = ( CONVERSION_BASED_UNIT('FOOT',#6) LENGTH_UNIT() NAMED_UNIT(#5) );\n${context('#7')}`,
      ),
    ).toBe('ft');
    // Two contexts that disagree, or none at all, have no unit to scale by.
    expect(
      unit(
        `${mm}\n#7 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT($,.METRE.) );\n${context('#9')}\n${contextAt(10, '#7')}`,
      ),
    ).toBe('step-unit-unknown');
    expect(unit(mm)).toBe('step-unit-unknown');
    // The scan reads the file as P21 (R2c-1): an instance ID used twice is not a STEP file.
    expect(unit(`${mm}\n${context('#9')}\n${context('#9')}`)).toBe('step-unreadable');
  });

  it('ignores entity names inside strings and comments', () => {
    // Comments and whitespace may sit anywhere a token may (R2c-1, P21 reader).
    expect(scanCode(file(`#1 /* product */ ${' '.repeat(48)}= PRODUCT($,$,$,());`))).toBe('ok');
    expect(scanCode(file("#1 = PRODUCT('NEXT_ASSEMBLY_USAGE_OCCURRENCE(','x','',());"))).toBe('ok');
    expect(scanCode(file('/* DOCUMENT_FILE( */ #1 = PRODUCT($,$,$,());'))).toBe('ok');
    // An apostrophe in a comment opens no string, so the entity after it is still read.
    expect(
      scanCode(file("/* the part's id */ #1 = (DOCUMENT_FILE('a','b',$,$,'','') NAMED_UNIT(*));")),
    ).toBe('step-external-reference');
    // A comment marker inside a string is text.
    expect(
      scanCode(file("#1 = PRODUCT('/*','x','',()); #2 = NEXT_ASSEMBLY_USAGE_OCCURRENCE('*/');")),
    ).toBe('step-assembly');
  });

  it('reads FILE_SCHEMA from the header entity, not from a comment', () => {
    const plate = new TextDecoder().decode(corpus('normal-mm-plate.step'));
    const fake = plate.replace(
      'HEADER;',
      "HEADER;\n/* FILE_SCHEMA(('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF')); */",
    );
    expect(scanStep(text(fake)).fileSchema).toBe(
      scanStep(corpus('normal-mm-plate.step')).fileSchema,
    );
    const data = plate
      .replace(/FILE_SCHEMA\s*\([\s\S]*?\);/, '')
      .replace('DATA;', "DATA;\n#99 = FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));");
    expect(scanCode(text(data))).toBe('step-unreadable');
    // Complex instances list their partial entities in parentheses.
    expect(scanCode(file("#1 = (DOCUMENT_FILE('a','b',$,$,'','') NAMED_UNIT(*));"))).toBe(
      'step-external-reference',
    );
  });

  it('refuses every geometric tolerance and dimension subtype as PMI, keeping unit entities', () => {
    for (const leaf of [
      'CIRCULARITY_TOLERANCE',
      'CYLINDRICITY_TOLERANCE',
      'TOTAL_RUNOUT_TOLERANCE',
      'GEOMETRIC_TOLERANCE_WITH_DATUM_REFERENCE',
      'DATUM_REFERENCE',
      'DIMENSIONAL_SIZE_WITH_PATH',
      'DIMENSIONAL_CHARACTERISTIC_REPRESENTATION',
    ])
      expect(scanCode(file(`#1 = ${leaf}('a',$,#2,#3);`)), leaf).toBe('step-pmi');
    // A complex instance names its partial types the same way.
    expect(
      scanCode(file("#1 = (CYLINDRICITY_TOLERANCE() GEOMETRIC_TOLERANCE('a',$,#2,#3));")),
    ).toBe('step-pmi');
    // Units carry DIMENSIONAL_EXPONENTS; that is not a dimension.
    expect(scanCode(file('#1 = DIMENSIONAL_EXPONENTS(1.,0.,0.,0.,0.,0.,0.);'))).toBe('ok');
  });

  it('refuses a file over 16 MiB before the kernel reads it', () => {
    // No kernel needed: the size is checked first.
    expect(importStep({}, new Uint8Array(16 * 1024 * 1024 + 1), '')).toEqual({
      status: 'rejected',
      code: 'step-too-large',
      detail: String(16 * 1024 * 1024 + 1),
    });
  });
});
