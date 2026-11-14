import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { importStep, pmiReadable, scanStep } from './step-import';
import { comparePmi, pmiCensus, pmiSemantics, type CadPmiSemantics } from './step-pmi';
import { readP21 } from '@editor-platform/geometry-core';
import { cadLimits } from '@editor-platform/cad-core';

const corpus = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/f07/${name}`, import.meta.url)));
const text = (s: string) => new TextEncoder().encode(s);
/** The scan's refusal, or `step-pmi` when it found PMI for the kernel to read (PMI-1). */
const scanCode = (bytes: Uint8Array) => {
  try {
    return scanStep(bytes).pmi ? 'step-pmi' : 'ok';
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
    expect(scanCode(corpus('reject-ap209.step'))).toBe('step-schema-unsupported');
    // #811: one part as AP242 is read as AP214 is.
    expect(scanStep(corpus('normal-ap242.step')).schema).toBe('AP242');
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
    // #810: a conversion-based unit is named by its factor, so 1 SI mm called MILLIMETRE is mm.
    expect(scanStep(corpus('normal-millimetre-plate.step')).sourceUnit).toBe('mm');
    const converted = (name: string, factor: string, si = '.MILLI.') =>
      unit(
        `#6 = LENGTH_MEASURE_WITH_UNIT(${factor},#5);\n#5 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(${si},.METRE.) );\n#7 = ( CONVERSION_BASED_UNIT('${name}',#6) LENGTH_UNIT() NAMED_UNIT(#4) );\n${context('#7')}`,
      );
    expect(converted('MILLIMETRE', 'LENGTH_MEASURE(1.)')).toBe('mm');
    expect(converted('MILLIMETRE', '1.')).toBe('mm');
    expect(converted('INCH', '25.4')).toBe('in');
    expect(converted('MILLIMETRE', 'LENGTH_MEASURE(0.001)', '$')).toBe('mm');
    // The factor, not the name, is what the reader scales by.
    expect(converted('MILLIMETRE', 'LENGTH_MEASURE(2.)')).toBe('step-unit-unknown');
    expect(converted('INCH', 'LENGTH_MEASURE(1.)')).toBe('mm');
    // A kilometre is no CAD unit: the factor cannot be read, so the name decides.
    expect(converted('MILLIMETRE', 'LENGTH_MEASURE(1.)', '.KILO.')).toBe('step-unit-unknown');
    expect(converted('INCH', 'LENGTH_MEASURE(1.)', '.KILO.')).toBe('in');
    // A complex measure keeps its value and unit in the MEASURE_WITH_UNIT partial entity.
    expect(
      unit(
        `#6 = ( LENGTH_MEASURE_WITH_UNIT() MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),#5) );\n#5 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );\n#7 = ( CONVERSION_BASED_UNIT('INCH',#6) LENGTH_UNIT() NAMED_UNIT(#4) );\n${context('#7')}`,
      ),
    ).toBe('in');
    expect(
      unit(
        `#6 = ( LENGTH_MEASURE_WITH_UNIT() MEASURE_WITH_UNIT(LENGTH_MEASURE(1.),#5) );\n#5 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );\n#7 = ( CONVERSION_BASED_UNIT('MILLIMETRE',#6) LENGTH_UNIT() NAMED_UNIT(#4) );\n${context('#7')}`,
      ),
    ).toBe('mm');
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

  it('counts the PMI families of a file, each instance once (PMI-1)', () => {
    const census = (body: string) =>
      pmiCensus(readP21(file(body), { bytes: 1 << 20, entities: 1 << 20, depth: 64 }));
    expect(census('#1 = DIMENSIONAL_EXPONENTS(1.,0.,0.,0.,0.,0.,0.);')).toBeUndefined();
    expect(
      census(
        [
          "#21 = DIMENSIONAL_SIZE(#9,'d');",
          "#22 = DIMENSIONAL_LOCATION('l','',#9,#9);",
          "#23 = (GEOMETRIC_TOLERANCE('a','',#9,#9) GEOMETRIC_TOLERANCE_WITH_DATUM_REFERENCE((#9)) PARALLELISM_TOLERANCE());",
          "#24 = FLATNESS_TOLERANCE('f','',#9,#9);",
          '#25 = PLUS_MINUS_TOLERANCE(#9,#21);',
          "#26 = DATUM('','',#9,.F.,'A');",
          "#27 = DATUM_REFERENCE_COMPARTMENT('','',#9,.F.,#26,$);",
          "#28 = CAMERA_MODEL_D3('v',#9);",
          "#30 = COMPONENT_PATH_SHAPE_ASPECT('','',#9,.F.,#9,#9);",
        ].join('\n'),
      ),
    ).toEqual({
      dimension: 2,
      'geometric-tolerance': 2,
      datum: 1,
      view: 1,
      'component-path': 1,
    });
    // Only parts of items (a datum reference without its tolerance) is still PMI.
    expect(census('#21 = DATUM_REFERENCE(1,#9);')).toEqual({});
  });

  it('compares the census with the reader on separate axes, and lists what it does not know', () => {
    const face = { label: '0:1:1:1:1', shape: 4, product: '0:1:1:1', index: 3 };
    const item = { label: 'x', object: true, targets: [face], targets2: [] };
    const dimension = { ...item, type: 2, values: [5], targets2: [face] };
    const semantics: CadPmiSemantics = {
      dimensions: ['Location_LinearDistance|5|', 'Location_LinearDistance|5|'],
      tolerances: [],
      datums: ['A'],
      datumTargets: [],
      systems: [],
      // Each end's count of attached items: a location has two ends.
      targets: {
        dimension: ['Location_LinearDistance|5||1,1', 'Location_LinearDistance|5||1,1'],
        'geometric-tolerance': [],
        datum: ['A|1'],
        'datum-target': [],
      },
      datumFeatures: [{ datum: 'A|1', features: 1 }],
      entities: { dimension: [1, 2], 'geometric-tolerance': [], datum: [3], 'datum-target': [] },
    };
    const report = comparePmi(
      { dimension: 2, datum: 1, 'datum-feature': 1, view: 1, callout: 2, 'component-path': 4 },
      {
        dimensions: [dimension, { ...dimension, targets: [{ label: 'y', shape: 4 }] }],
        tolerances: [],
        datums: [{ ...item, name: 'A', target: null }],
        views: [],
      },
      semantics,
    );
    expect(report.complete).toBe(false);
    // Kept on the import's bodies only (PMI-2): nothing before the import resolves targets.
    expect(report.kept).toEqual({
      dimension: 0,
      'geometric-tolerance': 0,
      datum: 0,
      'datum-target': 0,
      callout: 0,
      view: 0,
    });
    expect(report.lossless).toBe(false);
    expect(report.axes).toEqual([
      { axis: 'semantic', family: 'dimension', inFile: 2, read: 2, unread: 0 },
      // The second dimension's face is no product's sub-shape.
      { axis: 'target', family: 'dimension', inFile: 2, read: 1, unread: 1 },
      { axis: 'semantic', family: 'datum', inFile: 1, read: 1, unread: 0 },
      { axis: 'target', family: 'datum', inFile: 1, read: 1, unread: 0 },
      // A datum feature is checked as its datum's face.
      { axis: 'target', family: 'datum-feature', inFile: 1, read: 1, unread: 0 },
      // PMI-3a: a callout is read with its presentation, none without the text's.
      { axis: 'presentation', family: 'callout', inFile: 2, read: 0, unread: 2 },
      { axis: 'view', family: 'view', inFile: 1, read: 0, unread: 1 },
      // Families no axis checks are listed, never dropped (assembly paths).
      { axis: 'unsupported', family: 'component-path', inFile: 4, read: 0, unread: 4 },
    ]);
    // A family the reader gives nothing for is not complete, even with no other axis (#837).
    const callout = comparePmi(
      { callout: 1 },
      { dimensions: [], tolerances: [], datums: [], views: [] },
      { ...semantics, dimensions: [], datums: [] },
    );
    expect(callout.complete).toBe(false);
    expect(callout.axes).toEqual([
      { axis: 'presentation', family: 'callout', inFile: 1, read: 0, unread: 1 },
    ]);
    // A two-ended location whose second end the reader did not attach is not on its target,
    // though its meaning matches (#837).
    const oneEnd = comparePmi(
      { dimension: 2 },
      {
        dimensions: [dimension, { ...dimension, targets2: [] }],
        tolerances: [],
        datums: [],
        views: [],
      },
      semantics,
    );
    expect(oneEnd.axes).toEqual([
      { axis: 'semantic', family: 'dimension', inFile: 2, read: 2, unread: 0 },
      { axis: 'target', family: 'dimension', inFile: 2, read: 1, unread: 1 },
    ]);
    expect(oneEnd.complete).toBe(false);
    // An item is read only when its meaning matches the file's, not because it exists (#837).
    const other = comparePmi(
      { dimension: 2, datum: 1 },
      {
        dimensions: [dimension, { ...dimension, values: [6] }],
        tolerances: [],
        datums: [{ ...item, name: 'B', target: null }],
        views: [],
      },
      semantics,
    );
    expect(other.axes.filter((a) => a.axis === 'semantic')).toEqual([
      { axis: 'semantic', family: 'dimension', inFile: 2, read: 1, unread: 1 },
      { axis: 'semantic', family: 'datum', inFile: 1, read: 0, unread: 1 },
    ]);
    expect(other.complete).toBe(false);
    // A build without the PMI helper refuses PMI as before.
    expect(() => pmiReadable({} as never, { pmi: { dimension: 1 } })).toThrow('step-pmi');
    expect(pmiReadable({} as never, {})).toBe(false);
  });

  it('leaves a dimension with a modifier unverified: a theoretical diameter is not a plain one (#837)', () => {
    const semantics = pmiSemantics(
      readP21(
        file(
          [
            "#21 = DIMENSIONAL_SIZE(#99,'diameter');",
            '#22 = DIMENSIONAL_CHARACTERISTIC_REPRESENTATION(#21,#23);',
            "#23 = SHAPE_DIMENSION_REPRESENTATION('',(#24,#25),#8);",
            "#24 = ( LENGTH_MEASURE_WITH_UNIT() MEASURE_REPRESENTATION_ITEM() MEASURE_WITH_UNIT(LENGTH_MEASURE(5.),#9) REPRESENTATION_ITEM('') );",
            "#25 = DESCRIPTIVE_REPRESENTATION_ITEM('dimensional note','theoretical');",
          ].join('\n'),
        ),
        { bytes: 1 << 20, entities: 1 << 20, depth: 64 },
        { references: 'keep' },
      ),
    );
    expect(semantics.dimensions).toEqual(['Size_Diameter|5||modifiers?']);
    const face = { label: 'f', shape: 4, product: 'p', index: 1 };
    const report = comparePmi(
      { dimension: 1 },
      {
        dimensions: [{ label: 'd', object: true, type: 15, values: [5], targets: [face] }],
        tolerances: [],
        datums: [],
        views: [],
      },
      semantics,
    );
    expect(report.axes.find((a) => a.axis === 'semantic')).toEqual({
      axis: 'semantic',
      family: 'dimension',
      inFile: 1,
      read: 0,
      unread: 1,
    });
    expect(report.complete).toBe(false);
  });

  it('checks the datum features of one datum together: two features on one face each are read by a datum on two faces (#837)', () => {
    const semantics = pmiSemantics(
      readP21(
        file(
          [
            "#41 = DATUM('','',#99,.F.,'A');",
            "#71 = DATUM_FEATURE('','',#99,.T.);",
            "#72 = DATUM_FEATURE('','',#99,.T.);",
            "#73 = SHAPE_ASPECT_RELATIONSHIP('',$,#71,#41);",
            "#74 = SHAPE_ASPECT_RELATIONSHIP('',$,#72,#41);",
            "#75 = GEOMETRIC_ITEM_SPECIFIC_USAGE('','',#71,#99,#98);",
            "#76 = GEOMETRIC_ITEM_SPECIFIC_USAGE('','',#72,#99,#97);",
          ].join('\n'),
        ),
        { bytes: 1 << 20, entities: 1 << 20, depth: 64 },
        { references: 'keep' },
      ),
    );
    expect(semantics.targets.datum).toEqual(['A|2']);
    expect(semantics.datumFeatures).toEqual([{ datum: 'A|2', features: 2 }]);
    const face = (index: number) => ({ label: `f${index}`, shape: 4, product: 'p', index });
    const read = (targets: ReturnType<typeof face>[]) =>
      comparePmi(
        { datum: 1, 'datum-feature': 2 },
        {
          dimensions: [],
          tolerances: [],
          datums: [{ label: 'a', name: 'A', object: true, target: null, targets }],
          views: [],
        },
        semantics,
      ).axes.find((a) => a.family === 'datum-feature');
    expect(read([face(1), face(2)])).toEqual({
      axis: 'target',
      family: 'datum-feature',
      inFile: 2,
      read: 2,
      unread: 0,
    });
    // A datum on one face only does not read either feature.
    expect(read([face(1)])).toMatchObject({ read: 0, unread: 2 });
  });

  it('compares a tolerance zone form and datum reference modifiers (#837)', () => {
    const semanticsOf = (form: string, modifiers: string, definition = '') =>
      pmiSemantics(
        readP21(
          file(
            [
              "#41 = DATUM('','',#99,.F.,'A');",
              `#43 = DATUM_REFERENCE_COMPARTMENT('','',#99,.F.,#41,${modifiers});`,
              "#47 = DATUM_SYSTEM('','',#99,.F.,(#43));",
              '#48 = LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(0.1),#9);',
              "#49 = ( GEOMETRIC_TOLERANCE('','',#48,#99) GEOMETRIC_TOLERANCE_WITH_DATUM_REFERENCE((#47)) POSITION_TOLERANCE() );",
              `#50 = TOLERANCE_ZONE_FORM('${form}');`,
              "#51 = TOLERANCE_ZONE('','',#99,.T.,(#49),#50);",
              definition,
            ].join('\n'),
          ),
          { bytes: 1 << 20, entities: 1 << 20, depth: 64 },
          { references: 'keep' },
        ),
      );
    const mmr = '(SIMPLE_DATUM_REFERENCE_MODIFIER(.MAXIMUM_MATERIAL_REQUIREMENT.))';
    expect(semanticsOf('cylindrical or circular', '$').tolerances[0].signature).toBe(
      'Position|0.1|||A|zone:D',
    );
    expect(semanticsOf('spherical', mmr).tolerances[0].signature).toBe(
      'Position|0.1|||A(MAXIMUM_MATERIAL_REQUIREMENT)|zone:SD',
    );
    // OCCT 8's empty runout definition adds nothing; a projected zone is not compared.
    expect(
      semanticsOf('cylindrical or circular', '$', '#52 = RUNOUT_ZONE_DEFINITION(#51,());')
        .tolerances[0].signature,
    ).toBe('Position|0.1|||A|zone:D');
    expect(
      semanticsOf(
        'cylindrical or circular',
        '$',
        '#52 = PROJECTED_ZONE_DEFINITION(#51,(),#99,#48);',
      ).tolerances[0].signature,
    ).toBe('Position|0.1|||A|zone:?');
    // A form the reader has no value for is not compared.
    expect(semanticsOf('within a circle', '$').tolerances[0].signature).toBe(
      'Position|0.1|||A|zone:?',
    );
    const read = (
      semantics: ReturnType<typeof semanticsOf>,
      typeOfValue: number,
      datumModifiers: number[],
    ) =>
      comparePmi(
        { 'geometric-tolerance': 1, 'datum-system': 1 },
        {
          dimensions: [],
          tolerances: [
            {
              label: 't',
              object: true,
              type: 10,
              value: 0.1,
              typeOfValue,
              zone: 0,
              modifiers: [],
              material: 0,
              datums: ['a'],
              targets: [],
            },
          ],
          datums: [
            {
              label: 'a',
              name: 'A',
              position: 1,
              modifiers: datumModifiers,
              object: true,
              target: null,
              targets: [],
            },
          ],
          views: [],
        },
        semantics,
      ).axes.find((a) => a.axis === 'semantic' && a.family === 'geometric-tolerance')?.read;
    expect(read(semanticsOf('cylindrical or circular', '$'), 1, [])).toBe(1);
    // A spherical zone is not the reader's diameter zone; a datum's MMR is not a plain datum.
    expect(read(semanticsOf('spherical', '$'), 1, [])).toBe(0);
    expect(read(semanticsOf('cylindrical or circular', mmr), 1, [])).toBe(0);
    expect(read(semanticsOf('cylindrical or circular', mmr), 1, [15])).toBe(1);
    expect(read(semanticsOf('within a circle', '$'), 0, [])).toBe(0);
  });

  it('compares a maximum tolerance and measure qualifiers, and counts a repeated datum once (#837)', () => {
    const semantics = pmiSemantics(
      readP21(
        file(
          [
            '#48 = LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(0.1),#9);',
            '#47 = LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(0.2),#9);',
            "#49 = ( GEOMETRIC_TOLERANCE('','',#48,#99) GEOMETRIC_TOLERANCE_WITH_MAXIMUM_TOLERANCE(#47) GEOMETRIC_TOLERANCE_WITH_MODIFIERS((.MAXIMUM_MATERIAL_REQUIREMENT.)) POSITION_TOLERANCE() );",
            "#21 = DIMENSIONAL_SIZE(#99,'diameter');",
            '#22 = DIMENSIONAL_CHARACTERISTIC_REPRESENTATION(#21,#23);',
            "#23 = SHAPE_DIMENSION_REPRESENTATION('',(#24),#8);",
            "#24 = ( LENGTH_MEASURE_WITH_UNIT() MEASURE_REPRESENTATION_ITEM() MEASURE_WITH_UNIT(LENGTH_MEASURE(5.),#9) QUALIFIED_REPRESENTATION_ITEM((#25)) REPRESENTATION_ITEM('') );",
            "#25 = TYPE_QUALIFIER('maximum');",
          ].join('\n'),
        ),
        { bytes: 1 << 20, entities: 1 << 20, depth: 64 },
        { references: 'keep' },
      ),
    );
    expect(semantics.tolerances[0].signature).toBe('Position|0.1||M||max:0.2');
    expect(semantics.dimensions).toEqual(['Size_Diameter|5||q:max']);
    const face = { label: 'f', shape: 4, product: 'p', index: 1 };
    const tolerance = (maxValue: number) => ({
      label: 't',
      object: true,
      type: 10,
      value: 0.1,
      maxValue,
      modifiers: [],
      material: 1,
      datums: [],
      targets: [],
    });
    const semantic = (maxValue: number) =>
      comparePmi(
        { 'geometric-tolerance': 1, dimension: 1 },
        {
          dimensions: [{ label: 'd', object: true, type: 15, values: [5], targets: [face] }],
          tolerances: [tolerance(maxValue)],
          datums: [],
          views: [],
        },
        semantics,
      ).axes.filter((a) => a.axis === 'semantic');
    // The file's 'maximum' diameter is not the reader's plain one.
    expect(semantic(0.2)).toEqual([
      { axis: 'semantic', family: 'dimension', inFile: 1, read: 0, unread: 1 },
      { axis: 'semantic', family: 'geometric-tolerance', inFile: 1, read: 1, unread: 0 },
    ]);
    expect(semantic(0)[1]).toMatchObject({ read: 0, unread: 1 });
    const qualified = comparePmi(
      { dimension: 1 },
      {
        dimensions: [
          { label: 'd', object: true, type: 15, values: [5], qualifier: 2, targets: [face] },
        ],
        tolerances: [],
        datums: [],
        views: [],
      },
      semantics,
    );
    expect(qualified.axes[0]).toMatchObject({ family: 'dimension', read: 1, unread: 0 });
    // A value format is presentation (PMI-3); an unknown qualifier is not compared.
    const format = (q: string) =>
      pmiSemantics(
        readP21(
          file(
            [
              "#21 = DIMENSIONAL_SIZE(#99,'diameter');",
              '#22 = DIMENSIONAL_CHARACTERISTIC_REPRESENTATION(#21,#23);',
              "#23 = SHAPE_DIMENSION_REPRESENTATION('',(#24),#8);",
              "#24 = ( LENGTH_MEASURE_WITH_UNIT() MEASURE_REPRESENTATION_ITEM() MEASURE_WITH_UNIT(LENGTH_MEASURE(5.),#9) QUALIFIED_REPRESENTATION_ITEM((#25)) REPRESENTATION_ITEM('') );",
              `#25 = ${q};`,
            ].join('\n'),
          ),
          { bytes: 1 << 20, entities: 1 << 20, depth: 64 },
          { references: 'keep' },
        ),
      ).dimensions[0];
    expect(format("VALUE_FORMAT_TYPE_QUALIFIER('NR2 2.1')")).toBe('Size_Diameter|5|');
    expect(format('PRECISION_QUALIFIER(3)')).toBe('Size_Diameter|5||q:?');
    // An unknown qualifier stays unknown whatever comes after it (#837).
    const both = (first: string, second: string) =>
      pmiSemantics(
        readP21(
          file(
            [
              "#21 = DIMENSIONAL_SIZE(#99,'diameter');",
              '#22 = DIMENSIONAL_CHARACTERISTIC_REPRESENTATION(#21,#23);',
              "#23 = SHAPE_DIMENSION_REPRESENTATION('',(#24),#8);",
              "#24 = ( LENGTH_MEASURE_WITH_UNIT() MEASURE_REPRESENTATION_ITEM() MEASURE_WITH_UNIT(LENGTH_MEASURE(5.),#9) QUALIFIED_REPRESENTATION_ITEM((#25,#26)) REPRESENTATION_ITEM('') );",
              `#25 = ${first};`,
              `#26 = ${second};`,
            ].join('\n'),
          ),
          { bytes: 1 << 20, entities: 1 << 20, depth: 64 },
          { references: 'keep' },
        ),
      ).dimensions[0];
    expect(both('PRECISION_QUALIFIER(2)', "TYPE_QUALIFIER('maximum')")).toBe(
      'Size_Diameter|5||q:?',
    );
    expect(both("TYPE_QUALIFIER('maximum')", 'PRECISION_QUALIFIER(2)')).toBe(
      'Size_Diameter|5||q:?',
    );
    expect(both("TYPE_QUALIFIER('maximum')", "TYPE_QUALIFIER('minimum')")).toBe(
      'Size_Diameter|5||q:?',
    );
    expect(both("VALUE_FORMAT_TYPE_QUALIFIER('NR2 1.1')", "TYPE_QUALIFIER('maximum')")).toBe(
      'Size_Diameter|5||q:max',
    );
    // PMI-3a: the presentation XDE read is not counted; the text's is (`pmiPresentation`), so
    // without it no annotation is read.
    const presentation = { edges: 1, faces: 0, segments: [2] };
    const datum = (label: string) => ({
      label,
      name: 'A',
      position: 1,
      object: true,
      target: null,
      targets: [face],
      presentation,
    });
    const shown = comparePmi(
      { datum: 1, annotation: 2 },
      { dimensions: [], tolerances: [], datums: [datum('a1'), datum('a2')], views: [] },
      { ...semantics, datums: ['A'] },
    );
    expect(shown.axes.find((a) => a.axis === 'presentation')).toEqual({
      axis: 'presentation',
      family: 'annotation',
      inFile: 2,
      read: 0,
      unread: 2,
    });
    expect(shown.complete).toBe(false);
  });

  it('compares a datum target type (#837)', () => {
    const semantics = pmiSemantics(
      readP21(
        file(
          [
            "#41 = DATUM('','',#99,.F.,'A');",
            "#51 = PLACED_DATUM_TARGET_FEATURE('','point',#99,.T.,'2');",
            "#52 = SHAPE_ASPECT_RELATIONSHIP('',$,#51,#41);",
          ].join('\n'),
        ),
        { bytes: 1 << 20, entities: 1 << 20, depth: 64 },
        { references: 'keep' },
      ),
    );
    expect(semantics.datumTargets).toEqual(['A2|point']);
    const read = (type: number) =>
      comparePmi(
        { 'datum-target': 1 },
        {
          dimensions: [],
          tolerances: [],
          datums: [
            {
              label: 't',
              name: 'A',
              position: 0,
              object: true,
              target: { type, number: 2 },
              targets: [],
            },
          ],
          views: [],
        },
        semantics,
      ).axes.find((a) => a.axis === 'semantic')?.read;
    expect(read(0)).toBe(1);
    // A point target read as a circle is not the file's target.
    expect(read(3)).toBe(0);
  });

  it('reads the meaning of PMI items from the text: values in mm or degrees, signed deviations, datums in order', () => {
    const units = [
      mm,
      "#7 = ( CONVERSION_BASED_UNIT('DEGREE',#6) NAMED_UNIT(*) PLANE_ANGLE_UNIT() );",
      '#6 = PLANE_ANGLE_MEASURE_WITH_UNIT(PLANE_ANGLE_MEASURE(0.0174532925199433),#5);',
      '#5 = ( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) );',
      "#4 = ( CONVERSION_BASED_UNIT('INCH',#3) LENGTH_UNIT() NAMED_UNIT(*) );",
      '#3 = LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),#9);',
      context('#9'),
    ].join('\n');
    const semantics = pmiSemantics(
      readP21(
        file(
          [
            "#21 = DIMENSIONAL_SIZE(#99,'diameter');",
            '#22 = DIMENSIONAL_CHARACTERISTIC_REPRESENTATION(#21,#23);',
            "#23 = SHAPE_DIMENSION_REPRESENTATION('',(#24,#25),#8);",
            "#24 = ( LENGTH_MEASURE_WITH_UNIT() MEASURE_REPRESENTATION_ITEM() MEASURE_WITH_UNIT(LENGTH_MEASURE(0.5),#4) REPRESENTATION_ITEM('') );",
            "#25 = DESCRIPTIVE_REPRESENTATION_ITEM('dimensional note','theoretical');",
            '#26 = PLUS_MINUS_TOLERANCE(#27,#21);',
            '#27 = TOLERANCE_VALUE(#28,#29);',
            '#28 = MEASURE_WITH_UNIT(0.1,#9);',
            '#29 = MEASURE_WITH_UNIT(0.2,#9);',
            "#31 = ANGULAR_LOCATION('',$,#99,#99,.EQUAL.);",
            '#32 = DIMENSIONAL_CHARACTERISTIC_REPRESENTATION(#31,#33);',
            "#33 = SHAPE_DIMENSION_REPRESENTATION('',(#34),#8);",
            "#34 = ( MEASURE_REPRESENTATION_ITEM() MEASURE_WITH_UNIT(PLANE_ANGLE_MEASURE(30.),#7) PLANE_ANGLE_MEASURE_WITH_UNIT() REPRESENTATION_ITEM('') );",
            "#41 = DATUM('','',#99,.F.,'A');",
            "#42 = DATUM('','',#99,.F.,'B');",
            "#43 = DATUM_REFERENCE_COMPARTMENT('','',#99,.F.,#41,$);",
            "#44 = DATUM_REFERENCE_ELEMENT('','',#99,.F.,#42,$);",
            "#45 = DATUM_REFERENCE_ELEMENT('','',#99,.F.,#41,$);",
            "#46 = DATUM_REFERENCE_COMPARTMENT('','',#99,.F.,COMMON_DATUM_LIST((#44,#45)),$);",
            "#47 = DATUM_SYSTEM('','',#99,.F.,(#43,#46));",
            '#48 = LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(0.1),#9);',
            "#49 = ( GEOMETRIC_TOLERANCE('','',#48,#99) GEOMETRIC_TOLERANCE_WITH_DATUM_REFERENCE((#47)) GEOMETRIC_TOLERANCE_WITH_MODIFIERS((.MAXIMUM_MATERIAL_REQUIREMENT.,.COMMON_ZONE.)) POSITION_TOLERANCE() );",
            "#50 = FLATNESS_TOLERANCE('','',#48,#99);",
            // AP214: datum references in precedence order, one compartment each (#837).
            '#53 = DATUM_REFERENCE(2,#42);',
            '#54 = DATUM_REFERENCE(1,#41);',
            "#55 = PARALLELISM_TOLERANCE('','',#48,#99,(#53,#54));",
            "#51 = PLACED_DATUM_TARGET_FEATURE('','circle',#99,.T.,'2');",
            "#52 = SHAPE_ASPECT_RELATIONSHIP('',$,#51,#42);",
            // What the items are on: the diameter on two faces of a composite aspect, the
            // angle's second end on nothing.
            "#61 = COMPOSITE_SHAPE_ASPECT('','',#99,.T.);",
            "#62 = SHAPE_ASPECT('','',#99,.T.);",
            "#63 = SHAPE_ASPECT('','',#99,.T.);",
            "#64 = SHAPE_ASPECT_RELATIONSHIP('',$,#61,#62);",
            "#65 = SHAPE_ASPECT_RELATIONSHIP('',$,#61,#63);",
            "#66 = GEOMETRIC_ITEM_SPECIFIC_USAGE('','',#62,#99,#98);",
            "#67 = GEOMETRIC_ITEM_SPECIFIC_USAGE('','',#63,#99,#97);",
            "#68 = DIMENSIONAL_SIZE(#61,'radius');",
            "#69 = ANGULAR_LOCATION('',$,#62,#70,.EQUAL.);",
            "#70 = SHAPE_ASPECT('','',#99,.T.);",
            "#71 = DATUM_FEATURE('','',#99,.T.);",
            "#72 = SHAPE_ASPECT_RELATIONSHIP('',$,#71,#41);",
            "#73 = ITEM_IDENTIFIED_REPRESENTATION_USAGE('',$,#71,#99,SET_REPRESENTATION_ITEM((#98,#97)));",
            // A complex angle has its ends in the dimensional location's partial entity; a
            // second part's datum A is on its own feature, not on the first part's (#837).
            "#74 = ( ANGULAR_LOCATION(.EQUAL.) DIMENSIONAL_LOCATION('angle',$,#62,#63) );",
            "#75 = DATUM('','',#99,.F.,'A');",
            "#76 = DATUM_FEATURE('','',#99,.T.);",
            "#77 = SHAPE_ASPECT_RELATIONSHIP('',$,#76,#75);",
            "#78 = GEOMETRIC_ITEM_SPECIFIC_USAGE('','',#76,#99,#96);",
          ].join('\n'),
          units,
        ),
        { bytes: 1 << 20, entities: 1 << 20, depth: 64 },
        { references: 'keep' },
      ),
    );
    expect(semantics).toEqual({
      // 0.5 in is 12.7 mm; the 'theoretical' note is a modifier, which is not compared, so the
      // dimension never matches (#837). A lower bound above the nominal stays positive.
      dimensions: [
        'Size_Diameter|12.7|0.1,0.2|modifiers?',
        // An angle's selection is the reader's qualifier (.EQUAL. is average).
        'Location_Angular|30||q:avg',
        'Size_Radius||',
        'Location_Angular|||q:avg',
        'Location_Angular|||q:avg',
      ],
      tolerances: [
        { signature: 'Position|0.1|COMMON_ZONE|M|A,B-A', systems: [47] },
        { signature: 'Flatness|0.1|||', systems: [] },
        { signature: 'Parallelism|0.1|||A,B', systems: [53, 54] },
      ],
      datums: ['A', 'B', 'A'],
      // A circle's diameter is a parameter the reader's JSON does not return: not compared.
      datumTargets: ['B2|circle|size?'],
      systems: [47],
      targets: {
        dimension: [
          'Size_Diameter|12.7|0.1,0.2|modifiers?|0',
          'Location_Angular|30||q:avg|0,0',
          'Size_Radius|||2',
          'Location_Angular|||q:avg|1,0',
          'Location_Angular|||q:avg|1,1',
        ],
        'geometric-tolerance': [
          'Position|0.1|COMMON_ZONE|M|A,B-A|0',
          'Flatness|0.1||||0',
          'Parallelism|0.1|||A,B|0',
        ],
        datum: ['A|2', 'B|0', 'A|1'],
        'datum-target': ['B2|circle|size?|0'],
      },
      datumFeatures: [
        { datum: 'A|2', features: 1 },
        { datum: 'A|1', features: 1 },
      ],
      // PMI-3a: each signature's entity, to link a presentation to the item.
      entities: {
        dimension: [21, 31, 68, 69, 74],
        'geometric-tolerance': [49, 50, 55],
        datum: [41, 42, 75],
        'datum-target': [51],
      },
    });
    // The reader's diameter, with OCCT 7.6's lower deviation as a magnitude, is a different item.
    const face = { label: 'f', shape: 4, product: 'p', index: 1 };
    const report = comparePmi(
      { dimension: 4 },
      {
        dimensions: [
          {
            label: 'd',
            object: true,
            type: 15,
            values: [12.7, 0.1, 0.2],
            plusMinus: true,
            lowerTol: 0.1,
            upperTol: 0.2,
            targets: [face],
          },
          { label: 'a', object: true, type: 11, values: [30], qualifier: 3, targets: [face] },
        ],
        tolerances: [],
        datums: [],
        views: [],
      },
      semantics,
    );
    expect(report.axes[0]).toEqual({
      axis: 'semantic',
      family: 'dimension',
      inFile: 4,
      read: 1,
      unread: 3,
    });
    // The reader's AP214 tolerance: datums by precedence, matched with the file's order.
    const datum = (label: string, name: string, position: number) => ({
      label,
      name,
      position,
      object: true,
      target: null,
      targets: [],
    });
    const ap214 = comparePmi(
      { 'geometric-tolerance': 3 },
      {
        dimensions: [],
        tolerances: [
          {
            label: 't',
            object: true,
            type: 8,
            value: 0.1,
            modifiers: [],
            material: 0,
            datums: ['a', 'b'],
            targets: [face],
          },
        ],
        datums: [datum('a', 'A', 1), datum('b', 'B', 2)],
        views: [],
      },
      semantics,
    );
    expect(ap214.axes[0]).toMatchObject({ axis: 'semantic', read: 1 });
  });

  it('refuses a file over the STEP limit (64 MiB) before the kernel reads it', () => {
    // No kernel needed: the size is checked first.
    expect(importStep({}, new Uint8Array(cadLimits.stepBytes + 1), '')).toEqual({
      status: 'rejected',
      code: 'step-too-large',
      detail: String(cadLimits.stepBytes + 1),
    });
  });
});
