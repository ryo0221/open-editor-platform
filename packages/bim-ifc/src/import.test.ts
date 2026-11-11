import { readFileSync } from 'node:fs';
import {
  deriveBim,
  f31BoxBuilding,
  f37Office,
  f40Lattice,
  f47Taper,
  f49Pipes,
  f50Lean,
  f51Ramps,
  f52LeanOpenings,
  f54LeanJoins,
  f55RampOpenings,
  f55Stairs,
  f48Ramp,
  type BimDocument,
  type BimElement,
  type BimLoop,
  type BimWall,
} from '@editor-platform/bim-core';
import { describe, expect, it } from 'vitest';
import { writeIfc } from './export';
import { element, f35Export, f39Export, f54Export, opts } from './fixtures';
import {
  BimIfcImportError,
  fittedMm,
  fittedRad,
  readIfc,
  slabSlopeFromEdge,
  type BimIfcImportOptions,
  type BimIfcImportResult,
} from './import';

const resolveAll: BimIfcImportOptions = { resolvePart: () => true };
const imported = (r: BimIfcImportResult) => {
  if (r.status !== 'imported') throw new Error(`not imported: ${JSON.stringify(r.report.summary)}`);
  return r;
};
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof BimIfcImportError
      ? `${e.code}${e.ids.length ? `:${e.ids.join(',')}` : ''}`
      : String(e);
  }
  return 'none';
};
/** The document as the file holds it: levels by height, elements hosts first, GlobalIds kept. */
function asWritten(doc: BimDocument, globalIds: Map<string, string>): BimDocument {
  const d = structuredClone(doc);
  const hosted = (e: BimElement) =>
    e.kind === 'opening' || e.kind === 'door' || e.kind === 'window';
  d.levels.sort((a, b) => a.elevationMm - b.elevationMm);
  d.elements = [...d.elements.filter((e) => !hosted(e)), ...d.elements.filter(hosted)];
  for (const e of d.elements) e.ifcGlobalId ??= globalIds.get(e.id);
  return d;
}

/** F35 with what only `EP_*` carries: grid follow, views, joins, names and their absence. */
function f35WithFollow() {
  const { doc, options } = f35Export();
  doc.grids = [
    // TW0e: bubble ends only through EP_Grids (IfcGridAxis has none).
    { id: 'g-a', label: 'A', start: [0, -1000], end: [0, 9000], bubbles: 'end' },
    { id: 'g-b', label: 'B', start: [10000, -1000], end: [10000, 9000] },
    { id: 'g-1', label: '1', start: [-1000, 0], end: [11000, 0], bubbles: 'none' },
  ];
  doc.elements.push({
    id: 'c-grid',
    kind: 'column',
    typeId: 't-column-600',
    at: { grid: ['g-b', 'g-1'] },
    rotationRad: 0,
    base: { level: 'l-1f', offsetMm: 0 },
    top: { level: 'l-2f', offsetMm: -200 },
    name: 'c-grid',
  });
  element<BimWall>(doc, 'w-arc').name = 'Curved wall';
  doc.views = [
    {
      id: 'v-1f',
      kind: 'plan',
      name: '1F plan',
      level: 'l-1f',
      cutHeightMm: 1200,
      depthMm: 1500,
      scale: 100,
    },
    {
      id: 'v-a',
      kind: 'section',
      name: 'Section A',
      line: [
        [-1000, 4000],
        [11000, 4000],
      ],
      direction: 'left',
      depthMm: 20000,
      scale: 200,
    },
  ];
  return { doc, options };
}

describe('IFC import (R2c-4b, CAD67)', () => {
  it('brings its own file back to the same document, and the same bytes', () => {
    for (const { doc, options } of [
      f35WithFollow(),
      { doc: f37Office(), options: { ...opts, artifactId: 'f37' } },
      // F39: gable and hip roofs, and what they cut (R2c-7).
      f39Export('gable'),
      f39Export('hip'),
      // F40: a leaning column, a sloping beam and members (TW2).
      { doc: f40Lattice(), options: opts },
      // F47: tapered columns (TW5).
      { doc: f47Taper(), options: opts },
      // F48: sloped slabs (TW5).
      { doc: f48Ramp(), options: opts },
      // F49: steel pipes (#936).
      { doc: f49Pipes(), options: opts },
      // F50: leaning walls (LR2).
      { doc: f50Lean(), options: opts },
      // F51: spiral ramps (LR3).
      { doc: f51Ramps(), options: opts },
      // F52: windows, doors and openings in leaning walls (FU3).
      { doc: f52LeanOpenings(), options: opts },
      // F54: leaning walls under roofs (LS1) and joined to upright walls (LS2).
      f54Export(),
      { doc: f54LeanJoins(), options: opts },
      // F55: openings in spiral ramps (LS4).
      { doc: f55RampOpenings(), options: opts },
      // F55: straight stairs (LS6), one with a common property beside its steps' (Codex).
      { doc: f55Stairs(), options: opts },
      {
        doc: (() => {
          const d = f55Stairs();
          d.elements.find((e) => e.id === 'st-main')!.common = { fireRating: 'REI 60' };
          return d;
        })(),
        options: opts,
      },
    ]) {
      const out = writeIfc(doc, options);
      const r = imported(readIfc(out.bytes, resolveAll));
      expect(r.report.losses).toEqual([]);
      expect(r.report.withoutFollow).toBe(0);
      expect(r.report.restored).toBe(doc.elements.length);
      expect(r.document).toEqual(asWritten(doc, out.globalIds));
      // Written again (same Artifact, same time): the same bytes.
      const again = writeIfc(r.document, options);
      expect(again.text).toBe(writeIfc(asWritten(doc, out.globalIds), options).text);
      // GlobalIds stay the elements' own in a new Artifact.
      const moved = writeIfc(r.document, { ...options, artifactId: 'another' });
      for (const e of doc.elements) expect(moved.globalIds.get(e.id)).toBe(out.globalIds.get(e.id));
    }
  });

  it('does not take a 22-character type name for a GlobalId (TW0a)', () => {
    const { doc, options } = f35Export();
    const type = doc.types.find((t) => t.id === 't-column-600')!;
    type.name = 'Deck ring box 1000×600';
    expect(type.name).toHaveLength(22);
    const r = imported(readIfc(writeIfc(doc, options).bytes, resolveAll));
    expect(r.report.losses).toEqual([]);
    expect(r.document.types.find((t) => t.id === 't-column-600')?.name).toBe(type.name);
  });

  it('brings materials’ looks back, without their textures (#663)', () => {
    const { doc, options } = f35WithFollow();
    const [first, second] = doc.materials;
    first!.appearance = {
      color: '#a4553d',
      opacity: 0.4,
      roughness: 0.85,
      metalness: 0,
      preset: 'brick',
      textures: {
        maps: { color: 'asset-1' },
        sizeMm: [1200, 600],
        rotationDeg: 0,
        normal: 'gl',
        name: 'Bricks',
      },
    };
    second!.appearance = { color: '#c8ccd0', opacity: 1, roughness: 0.25, metalness: 0.8 };
    doc.assets = [
      {
        id: 'asset-1',
        kind: 'texture-png',
        sha256: `sha256:${'a'.repeat(64)}`,
        byteLength: 4,
        mediaType: 'image/png',
      },
    ];
    const out = writeIfc(doc, options);
    expect(out.losses).toEqual([
      `The texture maps of ${first!.name} are not written: IFC keeps its colour and finish.`,
    ]);
    // A rendering style per material, tied to it for any reader.
    expect(out.text).toMatch(
      /=IFCSURFACESTYLERENDERING\(#\d+,0\.6,\$,\$,\$,\$,#\d+,IFCSPECULARROUGHNESS\(0\.85\),\.PLASTIC\.\);/,
    );
    expect(out.text).toMatch(
      /=IFCSURFACESTYLERENDERING\(#\d+,0\.,\$,\$,\$,\$,IFCNORMALISEDRATIOMEASURE\(1\.\),IFCSPECULARROUGHNESS\(0\.25\),\.METAL\.\);/,
    );
    expect(out.text.match(/=IFCMATERIALDEFINITIONREPRESENTATION\(/g)).toHaveLength(2);
    const back = imported(readIfc(out.bytes, resolveAll)).document;
    const { textures: _, ...look } = first!.appearance;
    expect(back.materials[0]!.appearance).toEqual(look);
    expect(back.materials[1]!.appearance).toEqual(second!.appearance);
    expect(back.materials.slice(2).every((m) => !m.appearance)).toBe(true);
    // Another tool's shading (no rendering, no EP_Constraints): its colour and transparency.
    const foreign = out.text
      .replace(
        /IFCSURFACESTYLERENDERING\((#\d+),([^,]+),[^;]*\);/g,
        'IFCSURFACESTYLESHADING($1,$2);',
      )
      .replace(/'Metalness'|'Preset'/g, "'Other'");
    const read = imported(readIfc(new TextEncoder().encode(foreign), resolveAll)).document;
    expect(read.materials[0]!.appearance).toEqual({
      color: '#a4553d',
      opacity: 0.4,
      roughness: 0.55,
      metalness: 0,
    });
  });

  it('follows the same changes as the original: levels, grids, types', () => {
    const { doc, options } = f35WithFollow();
    // A wall rising to 2F and one fixed at the same height.
    const fixed = structuredClone(element<BimWall>(doc, 'w-arc'));
    fixed.id = 'w-fixed';
    fixed.ifcGlobalId = undefined;
    delete fixed.ifcGlobalId;
    fixed.start = { xy: [13000, 8000] };
    fixed.end = { xy: [18000, 8000] };
    delete fixed.bulge;
    const twoF = doc.levels.find((l) => l.id === 'l-2f')!.elevationMm;
    fixed.top = { heightMm: twoF };
    doc.elements.push(fixed);
    const out = writeIfc(doc, options);
    const back = imported(readIfc(out.bytes, resolveAll)).document;
    const change = (d: BimDocument) => {
      d.levels.find((l) => l.id === 'l-2f')!.elevationMm += 500;
      d.grids.find((a) => a.id === 'g-b')!.start[0] += 250;
      d.grids.find((a) => a.id === 'g-b')!.end[0] += 250;
      const t = d.types.find((x) => x.id === 't-column-600')!;
      if ('profile' in t && t.profile.shape === 'rect') t.profile.widthMm = 700;
      return deriveBim(d);
    };
    const a = change(asWritten(doc, out.globalIds));
    const b = change(back);
    expect(b.shapes).toEqual(a.shapes);
    expect(b.quantities).toEqual(a.quantities);
    // Each wall keeps its own rule: the level-attached one rises with 2F, the fixed one does not.
    const top = (id: string) => (b.shapes.get(id) as { zTop: number }).zTop;
    expect(top('w-arc')).toBe(twoF + 500);
    expect(top('w-fixed')).toBe(twoF);
    // The column at B/1 moved with the axis.
    expect((b.shapes.get('c-grid') as { at: number[] }).at[0]).toBe(10250);
  });

  it('refuses its own file when a shape no longer matches its constraints', () => {
    const { doc, options } = f35WithFollow();
    const out = writeIfc(doc, options);
    // Another program moved the south wall's body without touching EP_Constraints.
    const wallId = out.globalIds.get('w-south')!;
    const lines = out.text.split('\n');
    const wall = lines.find((l) => l.includes(`IFCWALL('${wallId}'`))!;
    const shapeRef = Number(/,#(\d+),\$,\.STANDARD\./.exec(wall)![1]);
    const solidLine = lines.findIndex(
      (l) =>
        l.startsWith('#') &&
        l.includes('=IFCEXTRUDEDAREASOLID(') &&
        l.split('=')[0] === `#${findSolid(lines, shapeRef)}`,
    );
    expect(solidLine).toBeGreaterThan(0);
    lines[solidLine] = lines[solidLine].replace(/,([0-9.E-]+)\);$/, ',123.);');
    const bytes = new TextEncoder().encode(lines.join('\n'));
    expect(code(() => readIfc(bytes, resolveAll))).toBe('constraint-mismatch:w-south');
    // Unchanged, it imports.
    expect(readIfc(out.bytes, resolveAll).status).toBe('imported');
  });

  it('lists parts whose CAD version does not resolve, and imports only when confirmed', () => {
    const { doc, options } = f35Export();
    const out = writeIfc(doc, options);
    const r = readIfc(out.bytes, { resolvePart: (s) => s.versionId !== 'v3' });
    expect(r.status).toBe('needs-confirmation');
    expect(r.report.summary).toEqual([
      { entity: 'IFCBUILDINGELEMENTPROXY', reason: 'part-unresolved', count: 3 },
    ]);
    expect(r.report.losses.map((l) => l.globalId)).toEqual(
      ['p-box', 'p-hollow', 'p-sheet'].map((id) => out.globalIds.get(id)),
    );
    const ok = imported(readIfc(out.bytes, { resolvePart: () => false, acceptLoss: true }));
    expect(ok.document.elements.some((e) => e.kind === 'part')).toBe(false);
    // The part type stays: a later version can be placed again.
    expect(ok.document.types.find((t) => t.id === 't-part')).toEqual(
      doc.types.find((t) => t.id === 't-part'),
    );
  });

  it('lists a property kind it does not read as a loss, rather than drop it silently', () => {
    const own = writeIfc(f35Export().doc, f35Export().options).text;
    // An enumerated value added to the wall type's Pset_WallCommon.
    const set = own.match(
      /^#(\d+)=IFCPROPERTYSET\('[^']*',\$,'Pset_WallCommon',\$,\(([^)]*)\)\);$/m,
    )!;
    const text = own
      .replace(set[0], set[0].replace(`(${set[2]})`, `(${set[2]},#999990)`))
      .replace(
        'ENDSEC;\nEND-ISO',
        "#999991=IFCPROPERTYENUMERATION('Rating',(IFCLABEL('A'),IFCLABEL('B')),$);\n" +
          "#999990=IFCPROPERTYENUMERATEDVALUE('AcousticRating',$,(IFCLABEL('A')),#999991);\n" +
          'ENDSEC;\nEND-ISO',
      );
    const bytes = new TextEncoder().encode(text);
    expect(readIfc(bytes, resolveAll).status).toBe('needs-confirmation');
    const r = imported(readIfc(bytes, { ...resolveAll, acceptLoss: true }));
    expect(r.report.summary).toEqual([
      { entity: 'IFCPROPERTYSET', reason: 'properties-partly-kept', count: 1 },
    ]);
  });

  it('refuses other schemas, broken files and files over the limits', () => {
    const own = writeIfc(f35Export().doc, f35Export().options).text;
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(
      code(() => readIfc(enc(own.replace("FILE_SCHEMA(('IFC4'))", "FILE_SCHEMA(('IFC2X3'))")))),
    ).toBe('ifc-schema-unsupported:IFC2X3');
    expect(
      code(() => readIfc(enc(own.replace("FILE_SCHEMA(('IFC4'))", "FILE_SCHEMA(('IFC4X3'))")))),
    ).toBe('ifc-schema-unsupported:IFC4X3');
    expect(code(() => readIfc(enc(own.slice(0, own.length / 2))))).toMatch(/^ifc-unreadable/);
    expect(code(() => readIfc(enc(own.replace('ENDSEC;\nEND-ISO', 'END-ISO'))))).toMatch(
      /^ifc-unreadable/,
    );
    const big = new Uint8Array(16 * 1024 * 1024 + 1);
    expect(code(() => readIfc(big))).toBe(`ifc-too-large:${big.length}`);
    const deep = own.replace(
      'ENDSEC;\nEND-ISO',
      `#999999=IFCX(${'('.repeat(33)}1${')'.repeat(33)});\nENDSEC;\nEND-ISO`,
    );
    expect(code(() => readIfc(enc(deep)))).toBe('ifc-too-deep:33');
    // Lengths in an unknown unit.
    expect(
      code(() =>
        readIfc(enc(own.replace('.LENGTHUNIT.,.MILLI.,.METRE.', '.LENGTHUNIT.,.MILLI.,.FOOT.'))),
      ),
    ).toBe('ifc-unit-unsupported:LENGTHUNIT,IFCSIUNIT');
  });

  it('keeps a railing on a ramp whose own ID looks like a STEP reference (LS5, Codex)', () => {
    const renamed = JSON.parse(
      JSON.stringify(f55RampOpenings()).replaceAll('"r-spiral"', '"#128"'),
    ) as BimDocument;
    const out = writeIfc(renamed, opts);
    const r = imported(readIfc(out.bytes, resolveAll));
    expect(r.report.losses).toEqual([]);
    expect(r.document).toEqual(asWritten(renamed, out.globalIds));
  });

  it("loses another program's railings, keeping the rest (LS5)", () => {
    const out = writeIfc(f55RampOpenings(), opts);
    const foreign = out.text.replaceAll("'EP_Constraints'", "'XX_Constraints'");
    const r = imported(readIfc(new TextEncoder().encode(foreign), { acceptLoss: true }));
    const railings = r.report.losses.filter((l) => l.reason === 'not-in-subset');
    expect(railings).toHaveLength(3);
    expect(r.document.elements.some((e) => e.kind === 'railing')).toBe(false);
    expect(r.document.elements.filter((e) => e.kind === 'ramp')).toHaveLength(3);
  });

  it('reads leaning columns, sloping beams and members from their shapes alone (TW2)', () => {
    const doc = f40Lattice();
    const out = writeIfc(doc, opts);
    // Without the constraints, the file reads like another program's.
    const foreign = out.text.replaceAll("'EP_Constraints'", "'XX_Constraints'");
    const r = imported(readIfc(new TextEncoder().encode(foreign), { acceptLoss: true }));
    expect(r.report.restored).toBe(0);
    // Only the renamed sets are lost; every shape is kept.
    expect(new Set(r.report.losses.map((l) => l.reason))).toEqual(
      new Set(['property-set-not-kept']),
    );
    const d = r.document;
    const by = (id: string) => d.elements.find((e) => e.ifcGlobalId === out.globalIds.get(id))!;
    const derived = deriveBim(d);
    const original = deriveBim(doc);
    for (const id of ['c-lean', 'b-slope', 'm-diag', 'm-vert', 'm-flat', 'm-grid']) {
      const e = by(id);
      expect(e, id).toBeDefined();
      expect(e.kind).toBe(doc.elements.find((x) => x.id === id)!.kind);
      const a = original.quantities.get(id)!.values;
      const b = derived.quantities.get(e.id)!.values;
      expect(Math.abs(b.length! - a.length!), id).toBeLessThan(1e-6);
      expect(Math.abs(b.netVolume! - a.netVolume!), id).toBeLessThan(1e-3);
    }
    const diag = by('m-diag');
    if (diag.kind !== 'member') throw new Error();
    expect(diag.rotationRad).toBeCloseTo(0.3, 9);
    const lean = by('c-lean');
    if (lean.kind !== 'column') throw new Error();
    expect(lean.topAt).toBeDefined();
    const slope = by('b-slope');
    if (slope.kind !== 'beam') throw new Error();
    expect(slope.endTop).toBeDefined();
  });

  it('reads tapered columns from their shapes alone, and refuses other tapers (TW5)', () => {
    const doc = f47Taper();
    const out = writeIfc(doc, opts);
    const foreign = out.text.replaceAll("'EP_Constraints'", "'XX_Constraints'");
    const r = imported(readIfc(new TextEncoder().encode(foreign), { acceptLoss: true }));
    expect(new Set(r.report.losses.map((l) => l.reason))).toEqual(
      new Set(['property-set-not-kept']),
    );
    const derived = deriveBim(r.document);
    const original = deriveBim(doc);
    for (const id of ['c-square', 'c-round', 'c-box', 'c-lean']) {
      const e = r.document.elements.find((x) => x.ifcGlobalId === out.globalIds.get(id))!;
      if (e?.kind !== 'column') throw new Error(id);
      expect(e.topScale, id).toBeCloseTo(
        (doc.elements.find((x) => x.id === id) as { topScale: number }).topScale,
        12,
      );
      const a = original.quantities.get(id)!.values;
      const b = derived.quantities.get(e.id)!.values;
      expect(Math.abs(b.netVolume! - a.netVolume!), id).toBeLessThan(1e-3);
    }
    // The derived end IFC4 also allows: the swept profile scaled by a plain 2D operator.
    const round = /^(#\d+)=IFCEXTRUDEDAREASOLIDTAPERED\((#\d+),(.*),(#\d+)\);$/m;
    const roundEnd = foreign.match(/^(#\d+)=IFCCIRCLEPROFILEDEF\(\.AREA\.,\$,\$,150\.\);$/m)![1]!;
    const lines = foreign.split('\n');
    const at = lines.findIndex((l) => round.test(l) && l.endsWith(`,${roundEnd});`));
    const [, id, swept, mid] = lines[at]!.match(round)!;
    lines.splice(
      at,
      1,
      `#90001=IFCCARTESIANPOINT((0.,0.));`,
      `#90002=IFCCARTESIANTRANSFORMATIONOPERATOR2D($,$,#90001,0.25);`,
      `#90003=IFCDERIVEDPROFILEDEF(.AREA.,$,${swept},#90002,$);`,
      `${id}=IFCEXTRUDEDAREASOLIDTAPERED(${swept},${mid},#90003);`,
    );
    const derivedFile = imported(
      readIfc(new TextEncoder().encode(lines.join('\n')), { acceptLoss: true }),
    );
    const roundCol = derivedFile.document.elements.find(
      (x) => x.ifcGlobalId === out.globalIds.get('c-round'),
    );
    expect(roundCol).toMatchObject({ kind: 'column', topScale: 0.25 });
    // An end in other proportions, or scaled past 1, is no column's taper: not supported.
    for (const end of [
      'IFCCIRCLEPROFILEDEF(.AREA.,$,$,1200.)',
      'IFCRECTANGLEPROFILEDEF(.AREA.,$,$,150.,150.)',
    ]) {
      const bad = foreign.replace('IFCCIRCLEPROFILEDEF(.AREA.,$,$,150.)', end);
      expect(bad).not.toBe(foreign);
      const b = imported(readIfc(new TextEncoder().encode(bad), { acceptLoss: true }));
      expect(
        b.report.losses.map((l) => l.reason),
        end,
      ).toContain('shape-unsupported');
    }
  });

  it('reads foreign circular hollow sections as pipes, tapered ones too (#936)', () => {
    const doc = f49Pipes();
    const out = writeIfc(doc, opts);
    const foreign = out.text.replaceAll("'EP_Constraints'", "'XX_Constraints'");
    const r = imported(readIfc(new TextEncoder().encode(foreign), { acceptLoss: true }));
    expect(new Set(r.report.losses.map((l) => l.reason))).toEqual(
      new Set(['property-set-not-kept']),
    );
    const derived = deriveBim(r.document);
    const original = deriveBim(doc);
    for (const id of ['c-pipe', 'c-pipe-taper', 'b-pipe', 'm-pipe']) {
      const e = r.document.elements.find((x) => x.ifcGlobalId === out.globalIds.get(id))!;
      expect(e, id).toBeDefined();
      const type = r.document.types.find((t) => 'typeId' in e && t.id === e.typeId)!;
      expect('profile' in type && type.profile.shape, id).toBe('pipe');
      const a = original.quantities.get(id)!.values;
      const b = derived.quantities.get(e.id)!.values;
      expect(Math.abs(b.netVolume! - a.netVolume!), id).toBeLessThan(1e-3);
    }
    const taper = r.document.elements.find(
      (x) => x.ifcGlobalId === out.globalIds.get('c-pipe-taper'),
    );
    expect(taper).toMatchObject({ kind: 'column', topScale: 0.5 });
    // An end whose wall is not scaled with its radius is no column's taper.
    const bad = foreign.replace(
      'IFCCIRCLEHOLLOWPROFILEDEF(.AREA.,$,$,150.,12.5)',
      'IFCCIRCLEHOLLOWPROFILEDEF(.AREA.,$,$,150.,25.)',
    );
    expect(bad).not.toBe(foreign);
    const b = imported(readIfc(new TextEncoder().encode(bad), { acceptLoss: true }));
    expect(b.report.losses.map((l) => l.reason)).toContain('shape-unsupported');
  });

  it('reads a foreign slanted wall as a leaning one, and other leaning shapes as losses (LR2b)', () => {
    const doc = f50Lean();
    const out = writeIfc(doc, opts);
    const foreign = out.text.replaceAll("'EP_Constraints'", "'XX_Constraints'");
    const r = imported(readIfc(new TextEncoder().encode(foreign), { acceptLoss: true }));
    const free = r.document.elements.find((x) => x.ifcGlobalId === out.globalIds.get('w-free'));
    if (free?.kind !== 'wall') throw new Error('w-free');
    expect(free.lean).toBeCloseTo(Math.PI / 12, 12);
    const a = deriveBim(doc).quantities.get('w-free')!.values;
    const b = deriveBim(r.document).quantities.get(free.id)!.values;
    expect(Math.abs(b.netVolume! - a.netVolume!)).toBeLessThan(1e-3);
    expect(b.width).toBeCloseTo(200, 9);
    // The cones and the triangulated walls carry no parameters to read: losses.
    const lost = r.report.losses.filter((l) => l.entity === 'IFCWALL');
    expect(lost.map((l) => l.reason)).toEqual(Array(10).fill('shape-unsupported'));
  });

  it('reads the openings of a foreign leaning wall along its face (FU3b)', () => {
    const doc = f52LeanOpenings();
    const out = writeIfc(doc, opts);
    const foreign = out.text.replaceAll("'EP_Constraints'", "'XX_Constraints'");
    const r = imported(readIfc(new TextEncoder().encode(foreign), { acceptLoss: true }));
    const free = r.document.elements.find((x) => x.ifcGlobalId === out.globalIds.get('w-free'))!;
    // The window and the door are not read from another program's file; the openings they
    // fill are, swept along the lean, their sills and heights along the face (FU-U4).
    const openings = r.document.elements.filter(
      (e) => e.kind === 'opening' && e.hostId === free.id,
    );
    expect(openings.map((e) => (e as { wall: object }).wall)).toEqual([
      { alongMm: 800, sillMm: 900, widthMm: 1800, heightMm: 1500 },
      { alongMm: 4000, sillMm: 0, widthMm: 900, heightMm: 2100 },
    ]);
    expect(deriveBim(r.document).diagnostics).toEqual([]);
  });

  it('finds a short leaning wall’s axis by its slant, and checks a join at the top (LR2b)', () => {
    type Wall = Extract<BimElement, { kind: 'wall' }>;
    const foreignOf = (doc: BimDocument, edit = (t: string) => t) => {
      const out = writeIfc(doc, opts);
      const text = edit(out.text.replaceAll("'EP_Constraints'", "'XX_Constraints'"));
      return { out, r: imported(readIfc(new TextEncoder().encode(text), { acceptLoss: true })) };
    };
    // A 100 mm run, 200 mm thick at 15°: its plan width (207 mm) is the longer side.
    const short = f50Lean();
    short.elements = [{ ...element<Wall>(short, 'w-free'), end: { xy: [100, 0] } }];
    short.joins = [];
    // No Axis representation to follow.
    const a = foreignOf(short, (t) => t.replaceAll("'Axis'", "'Sketch'"));
    const w = a.r.document.elements.find((x) => x.kind === 'wall') as Wall;
    expect(a.r.report.losses.filter((l) => l.entity === 'IFCWALL')).toEqual([]);
    expect(w.start).toEqual({ xy: [0, 0] });
    expect(w.end).toEqual({ xy: [100, 0] });
    expect(w.lean).toBeCloseTo(Math.PI / 12, 12);
    // Two leaning walls, read without their join, whose bases match it but whose tops do not.
    const pair = f50Lean();
    const hw = (lean: number) => 100 / Math.cos(lean);
    pair.elements = [
      { ...element<Wall>(pair, 'w-l-1'), end: { xy: [18000 + hw(0.25), 10000] } },
      { ...element<Wall>(pair, 'w-l-2'), start: { xy: [18000, 10000 + hw(0.1)] } },
    ];
    pair.joins = [];
    const ids = writeIfc(pair, opts).globalIds;
    const b = foreignOf(pair, (t) => {
      const ref = (id: string) => t.match(new RegExp(`(#\\d+)=IFCWALL\\('${ids.get(id)}'`))![1];
      return t.replace(
        /\nENDSEC;\nEND-ISO/,
        `\n#99990=IFCRELCONNECTSPATHELEMENTS('0j${'_'.repeat(20)}',$,'butt',$,$,${ref('w-l-1')},${ref('w-l-2')},(1),(0),.ATEND.,.ATSTART.);\nENDSEC;\nEND-ISO`,
      );
    });
    expect(b.r.report.summary).toContainEqual({
      entity: 'IFCRELCONNECTSPATHELEMENTS',
      reason: 'join-reshapes',
      count: 1,
    });
    expect(b.r.document.joins).toEqual([]);
  });

  it("reads another program's spiral ramp back from its faces, within 1 mm (FU2a)", () => {
    const doc = f51Ramps();
    const out = writeIfc(doc, opts);
    const foreign = out.text.replaceAll("'EP_Constraints'", "'XX_Constraints'");
    const r = imported(readIfc(new TextEncoder().encode(foreign), { acceptLoss: true }));
    expect(r.report.losses.filter((l) => l.entity === 'IFCRAMP')).toEqual([]);
    const ev = deriveBim(doc);
    const back = deriveBim(r.document);
    const ramps = doc.elements.filter((e) => e.kind === 'ramp');
    const read = r.document.elements.filter((e) => e.kind === 'ramp');
    expect(read).toHaveLength(ramps.length);
    ramps.forEach((e, i) => {
      const a = ev.shapes.get(e.id)!;
      const b = back.shapes.get(read[i]!.id)!;
      if (a.kind !== 'ramp' || b.kind !== 'ramp') throw new Error('not a ramp');
      // The same helicoid, perhaps described from its other end.
      const rising =
        a.zEnd > a.zStart
          ? a
          : {
              ...a,
              startAngle: a.startAngle + a.sweep,
              sweep: -a.sweep,
              zStart: a.zEnd,
              zEnd: a.zStart,
            };
      const turn = (x: number) => x - 2 * Math.PI * Math.round(x / (2 * Math.PI));
      expect(Math.hypot(b.center[0] - a.center[0], b.center[1] - a.center[1])).toBeLessThan(1);
      expect(Math.abs(b.innerRadius - a.innerRadius)).toBeLessThan(1);
      expect(Math.abs(b.outerRadius - a.outerRadius)).toBeLessThan(1);
      expect(Math.abs(turn(b.startAngle - rising.startAngle)) * a.outerRadius).toBeLessThan(1);
      expect(Math.abs(b.sweep - rising.sweep) * a.outerRadius).toBeLessThan(1);
      expect(Math.abs(b.zStart - rising.zStart)).toBeLessThan(1);
      expect(Math.abs(b.zEnd - rising.zEnd)).toBeLessThan(1);
      expect(Math.abs(b.thickness - a.thickness)).toBeLessThan(1);
    });
  });

  it("reads another program's spiral ramps and flights from faceted bodies (FU2a, FU2b, F53)", () => {
    const bytes = readFileSync(new URL('../fixtures/f53-foreign-ramps.ifc', import.meta.url));
    const r = imported(readIfc(bytes, { acceptLoss: true }));
    // The ramp made of flights is read as its flights, none of it lost.
    expect(r.report.summary).toEqual([]);
    const d = deriveBim(r.document);
    const ramps = r.document.elements.filter((e) => e.kind === 'ramp');
    expect(ramps.map((e) => e.name)).toEqual(['Spiral flight', 'Car park ramp']);
    const shape = (i: number) => {
      const s = d.shapes.get(ramps[i]!.id)!;
      if (s.kind !== 'ramp') throw new Error('not a ramp');
      return s;
    };
    const close = (a: number, b: number, tol = 1e-3) => expect(Math.abs(a - b)).toBeLessThan(tol);
    const spiral = shape(0);
    close(spiral.center[0], 10000);
    close(spiral.center[1], 5000);
    close(spiral.innerRadius, 2000);
    close(spiral.outerRadius, 5000);
    close(spiral.startAngle, 0, 1e-6);
    close(spiral.sweep, 1.5 * Math.PI, 1e-6);
    close(spiral.zStart, 0);
    close(spiral.zEnd, 3000);
    close(spiral.thickness, 250);
    // Its layer set gives the slab type.
    const type = r.document.types.find((t) => t.id === ramps[0]!.typeId)!;
    expect(type.kind).toBe('slab');
    expect(
      (type as { layers: { thicknessMm: number }[] }).layers.map((l) => l.thicknessMm),
    ).toEqual([250]);
    // Rising clockwise, 1.5 turns, on the first storey.
    const park = shape(1);
    close(park.center[0], -10000);
    close(park.center[1], 0);
    close(park.innerRadius, 1500);
    close(park.outerRadius, 3000);
    close(park.startAngle, Math.PI / 2, 1e-6);
    close(park.sweep, -3 * Math.PI, 1e-6);
    close(park.zStart, 3000);
    close(park.zEnd, 6000);
    close(park.thickness, 200);
    expect((ramps[1] as { base: { level: string } }).base.level).toBe(
      r.document.levels.find((l) => l.name === 'First')!.id,
    );
    // FU2b: the straight flight is a sloped slab, 1.5 m by 6 m, rising 1 m north.
    const flight = r.document.elements.find((e) => e.name === 'Straight flight')!;
    expect(flight.kind).toBe('slab');
    const slab = d.shapes.get(flight.id)!;
    if (slab.kind !== 'slab' || !slab.slope) throw new Error('not a sloped slab');
    const xs = slab.boundary.map((p) => p[0]);
    const ys = slab.boundary.map((p) => p[1]);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([
      16500, 18000, 5000, 11000,
    ]);
    close(slab.zTop, 0);
    close(slab.zTop - slab.zBottom, 250);
    close(slab.slope.grade * 6000, 1000);
    expect(slab.slope.direction.map((c) => Math.round(c * 1e9) / 1e9 + 0)).toEqual([0, 1]);
    expect((flight as { typeId: string }).typeId).toBe(ramps[0]!.typeId);
    // A sloped slab as a faceted B-rep, one top face reversed by its bound's orientation, and
    // the opening near its high end that reaches only through the slab there (Codex).
    const landing = r.document.elements.find((e) => e.name === 'Sloped landing')!;
    const ls = d.shapes.get(landing.id)!;
    if (ls.kind !== 'slab' || !ls.slope) throw new Error('not a sloped slab');
    close(ls.slope.grade * 6000, 1000);
    close(ls.zTop - ls.zBottom, 200);
    const opening = r.document.elements.find((e) => e.name === 'Landing opening')!;
    expect(opening).toMatchObject({ kind: 'opening', hostId: landing.id });
    // An opening in the straight flight goes with the slab it became (Codex).
    expect(r.document.elements.find((e) => e.name === 'Flight opening')).toMatchObject({
      kind: 'opening',
      hostId: flight.id,
    });
    expect(d.diagnostics).toEqual([]);
  });

  it("fits another program's straight flights as stairs, a landing lost (LS7, F56)", () => {
    const bytes = readFileSync(new URL('../fixtures/f56-foreign-stairs.ifc', import.meta.url));
    const r = imported(readIfc(bytes, { acceptLoss: true }));
    // Stair B's landing is not one straight flight: lost as its shape; Stair A is read as its
    // flight, none of it lost.
    expect(r.report.summary).toEqual([
      { entity: 'IFCSTAIR', reason: 'shape-unsupported', count: 1 },
    ]);
    expect(r.report.losses.map((l) => l.name)).toEqual(['Stair B']);
    const d = deriveBim(r.document);
    expect(d.diagnostics).toEqual([]);
    const stairs = r.document.elements.filter((e) => e.kind === 'stair');
    expect(stairs.map((e) => e.name)).toEqual(['Flight A', 'Flight C']);
    const [ground, first] = ['Ground', 'First'].map(
      (n) => r.document.levels.find((l) => l.name === n)!.id,
    );
    // A: 18 risers from Ground to First, turned 30° at (2 m, 1 m).
    expect(stairs[0]).toMatchObject({
      start: { xy: [2000, 1000] },
      directionRad: Math.PI / 6,
      widthMm: 1100,
      risers: 18,
      treadMm: 280,
      base: { level: ground, offsetMm: 0 },
      top: { level: first, offsetMm: 0 },
    });
    expect((stairs[0] as { directionRad: number }).directionRad).toBeCloseTo(Math.PI / 6, 6);
    const waist = (e: (typeof stairs)[number]) => {
      const t = r.document.types.find((x) => x.id === (e as { typeId: string }).typeId)!;
      expect(t.kind).toBe('slab');
      return (t as { layers: { thicknessMm: number }[] }).layers.map((l) => l.thicknessMm);
    };
    expect(waist(stairs[0]!)).toEqual([180]);
    // C: triangles, 10 risers of 180 mm facing −y on First, its top 1,800 mm up from there.
    expect(stairs[1]).toMatchObject({
      widthMm: 1000,
      risers: 10,
      treadMm: 300,
      base: { level: first, offsetMm: 0 },
      top: { level: first, offsetMm: 1800 },
    });
    expect((stairs[1] as { directionRad: number }).directionRad).toBeCloseTo(-Math.PI / 2, 6);
    expect((stairs[1] as { start: { xy: number[] } }).start.xy.map((c) => c + 0)).toEqual([
      0, 10000,
    ]);
    expect(waist(stairs[1]!)).toEqual([200]);
    // The volumes IfcOpenShell measures for the two flights.
    const vol = (e: (typeof stairs)[number]) => d.quantities.get(e.id)!.values.netVolume!;
    expect(Math.abs(vol(stairs[0]!) - 658_782_224)).toBeLessThan(2);
    expect(Math.abs(vol(stairs[1]!) - 384_380_894)).toBeLessThan(2);
    // Stair A with a body of its own, the same as its flight's: read once, as the flight (Codex).
    const both = new TextDecoder()
      .decode(bytes)
      .replace("'Stair A',$,$,#1005,$,", "'Stair A',$,$,#1005,#1205,");
    expect(both).not.toBe(new TextDecoder().decode(bytes));
    const once = imported(readIfc(new TextEncoder().encode(both), { acceptLoss: true }));
    expect(once.document.elements.filter((e) => e.kind === 'stair').map((e) => e.name)).toEqual([
      'Flight A',
      'Flight C',
    ]);
    // Stair A with its body, its parts only a railing: read as the stair, not dropped (Codex).
    const railed = both.replace(
      "#104=IFCRELAGGREGATES('0agg4_________________',$,$,$,#100,(#110));",
      "#104=IFCRELAGGREGATES('0agg4_________________',$,$,$,#100,(#111));\n" +
        "#111=IFCRAILING('0railA________________',$,'Rail A',$,$,#1010,$,$,$);",
    );
    expect(railed).not.toBe(both);
    const kept = imported(readIfc(new TextEncoder().encode(railed), { acceptLoss: true }));
    expect(
      kept.document.elements
        .filter((e) => e.kind === 'stair')
        .map((e) => e.name)
        .sort(),
    ).toEqual(['Flight A', 'Flight C', 'Stair A']);
  });

  it('rounds what it fits to 0.001 mm and 1e-6° (FU6, F53)', () => {
    const bytes = readFileSync(new URL('../fixtures/f53-foreign-ramps.ifc', import.meta.url));
    const r = imported(readIfc(bytes, { acceptLoss: true }));
    const park = r.document.elements.find((e) => e.name === 'Car park ramp')!;
    if (park.kind !== 'ramp') throw new Error('not a ramp');
    // Exactly as drawn, no tiny remainders.
    expect(park.center).toEqual({ xy: [-10000, 0] });
    expect([park.innerRadiusMm, park.outerRadiusMm]).toEqual([1500, 3000]);
    expect([park.base.offsetMm, park.top.offsetMm]).toEqual([0, 3000]);
    expect((park.startAngleRad * 180) / Math.PI).toBeCloseTo(90, 12);
    expect((park.sweepRad * 180) / Math.PI).toBeCloseTo(-540, 12);
    const type = r.document.types.find((t) => t.id === park.typeId)!;
    expect((type as { layers: { thicknessMm: number }[] }).layers[0]!.thicknessMm).toBe(200);
    const flight = r.document.elements.find((e) => e.name === 'Straight flight')!;
    if (flight.kind !== 'slab' || !flight.slope) throw new Error('not a sloped slab');
    for (const v of flight.boundary)
      for (const c of v.slice(0, 2)) expect(Math.round(c * 1000) / 1000).toBe(c);
    expect(flight.top.offsetMm).toBe(Math.round(flight.top.offsetMm * 1000) / 1000);
    expect(flight.slope.endTop.offsetMm).toBe(
      Math.round(flight.slope.endTop.offsetMm * 1000) / 1000,
    );
    // Rounded values never leave a remainder of their own.
    expect(fittedMm(1500.000011514387)).toBe(1500);
    expect(fittedMm(0.000001)).toBe(0);
    expect(Object.is(fittedMm(-0.0001), 0)).toBe(true);
    expect(fittedMm(12.3456)).toBe(12.346);
    expect((fittedRad(-3 * Math.PI + 1e-12) * 180) / Math.PI).toBeCloseTo(-540, 12);
  });

  it('matches material layers before rounding a fitted thickness (FU6, Codex)', () => {
    const text = readFileSync(
      new URL('../fixtures/f53-foreign-ramps.ifc', import.meta.url),
      'utf8',
    );
    // The straight flight 250.0004 mm thick, as its layer set.
    const thick = text
      .replace('IFCMATERIALLAYER(#40,0.25,', 'IFCMATERIALLAYER(#40,0.2500004,')
      .replace(
        '(0.,0.,-0.25),(6.,0.,0.75),(6.,1.5,0.75),(0.,1.5,-0.25)',
        '(0.,0.,-0.2500004),(6.,0.,0.7499996),(6.,1.5,0.7499996),(0.,1.5,-0.2500004)',
      );
    expect(thick).not.toBe(text);
    const r = imported(readIfc(new TextEncoder().encode(thick), { acceptLoss: true }));
    const flight = r.document.elements.find((e) => e.name === 'Straight flight')!;
    const type = r.document.types.find((t) => t.id === (flight as { typeId: string }).typeId)!;
    const layers = (type as { layers: { materialId: string; thicknessMm: number }[] }).layers;
    expect(layers.map((l) => l.thicknessMm)).toEqual([250.0004]);
    expect(r.document.materials.find((m) => m.id === layers[0]!.materialId)?.name).toBe('Concrete');
  });

  it('keeps a through-opening of a slab whose heights it rounds (FU6, Codex)', () => {
    const text = readFileSync(
      new URL('../fixtures/f53-foreign-ramps.ifc', import.meta.url),
      'utf8',
    );
    // The flight's opening from 3 to 4.5 m along it, from 250 to 750 mm up: exactly from the
    // underside at its low end to the top at its high end. Then the flight 0.0004 mm up, so the
    // slab's heights round down by that and the opening's ends stand 0.0004 mm past them.
    const exact = text
      .replace('#2971=IFCCARTESIANPOINT((2.,0.25));', '#2971=IFCCARTESIANPOINT((3.,0.25));')
      .replace('#2972=IFCCARTESIANPOINT((3.,0.25));', '#2972=IFCCARTESIANPOINT((4.5,0.25));')
      .replace('#2973=IFCCARTESIANPOINT((3.,1.25));', '#2973=IFCCARTESIANPOINT((4.5,1.25));')
      .replace('#2974=IFCCARTESIANPOINT((2.,1.25));', '#2974=IFCCARTESIANPOINT((3.,1.25));')
      .replace('#2975=IFCCARTESIANPOINT((2.,0.25));', '#2975=IFCCARTESIANPOINT((3.,0.25));')
      .replace(
        '#2978=IFCEXTRUDEDAREASOLID(#2977,$,#16,0.6);',
        '#2990=IFCCARTESIANPOINT((0.,0.,0.25));\n#2991=IFCAXIS2PLACEMENT3D(#2990,$,$);\n#2978=IFCEXTRUDEDAREASOLID(#2977,#2991,#16,0.5);',
      );
    const read = (t: string) =>
      imported(readIfc(new TextEncoder().encode(t), { acceptLoss: true }));
    expect(read(exact).report.summary).toEqual([]);
    const up = exact.replace(
      '#123=IFCCARTESIANPOINT((8.,0.,0.));',
      '#123=IFCCARTESIANPOINT((8.,0.,0.0000004));',
    );
    expect(up).not.toBe(exact);
    const r = read(up);
    expect(r.report.summary).toEqual([]);
    const flight = r.document.elements.find((e) => e.name === 'Straight flight')!;
    expect(r.document.elements.find((e) => e.name === 'Flight opening')).toMatchObject({
      kind: 'opening',
      hostId: flight.id,
    });
  });

  it('keeps the corners unrounded when rounding would turn a short slope edge (FU6, Codex)', () => {
    const text = readFileSync(
      new URL('../fixtures/f53-foreign-ramps.ifc', import.meta.url),
      'utf8',
    );
    // A planar trapezoid whose level edge is 1.001 mm long, turned 30°, rising 5,000 mm.
    const [c, s] = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];
    const local = [
      [0, 0],
      [1.001, 0],
      [10000, 10000],
      [-10000, 10000],
    ];
    const at = (x: number, y: number, z: number) =>
      `(${((c * x - s * y) / 1000).toPrecision(17)},${((s * x + c * y) / 1000).toPrecision(17)},${(z / 1000).toPrecision(17)})`;
    const top = local.map(([x, y]) => at(x!, y!, y! / 2));
    const under = local.map(([x, y]) => at(x!, y!, y! / 2 - 250));
    const shape = text.replace(
      '((0.,0.,0.),(6.,0.,1.),(6.,1.5,1.),(0.,1.5,0.),(0.,0.,-0.25),(6.,0.,0.75),(6.,1.5,0.75),(0.,1.5,-0.25))',
      `(${[...top, ...under].join(',')})`,
    );
    expect(shape).not.toBe(text);
    const r = imported(readIfc(new TextEncoder().encode(shape), { acceptLoss: true }));
    expect(r.report.losses.filter((l) => l.entity === 'IFCRAMPFLIGHT')).toEqual([]);
    const flight = r.document.elements.find((e) => e.name === 'Straight flight')!;
    const d = deriveBim(r.document).shapes.get(flight.id)!;
    if (d.kind !== 'slab' || !d.slope) throw new Error('not a sloped slab');
    // The tops at the corners: two on the level edge, two 5,000 mm up, each within 1 mm.
    const [ax, ay] = d.slope.origin;
    const tops = d.boundary
      .map(
        (p) =>
          d.zTop +
          d.slope!.grade *
            ((p[0] - ax) * d.slope!.direction[0] + (p[1] - ay) * d.slope!.direction[1]),
      )
      .sort((a, b) => a - b);
    const low = tops[0]!;
    for (const [k, want] of [0, 0, 5000, 5000].entries())
      expect(Math.abs(tops[k]! - low - want)).toBeLessThan(1);
  });

  it('fits only the corners a face uses (FU2a, Codex)', () => {
    const text = readFileSync(
      new URL('../fixtures/f53-foreign-ramps.ifc', import.meta.url),
      'utf8',
    );
    // A point list shared with something else: a coordinate no face of the ramp uses.
    const shared = text.replace(/(IFCCARTESIANPOINTLIST3D\(\(.*?)\),\$\);/s, '$1,(0.,0.,0.)),$);');
    expect(shared).not.toBe(text);
    const r = imported(readIfc(new TextEncoder().encode(shared), { acceptLoss: true }));
    expect(r.document.elements.filter((e) => e.kind === 'ramp').map((e) => e.name)).toEqual([
      'Spiral flight',
      'Car park ramp',
    ]);
  });

  it('puts a flight in the storey its ramp is in (FU2a, Codex)', () => {
    const text = readFileSync(
      new URL('../fixtures/f53-foreign-ramps.ifc', import.meta.url),
      'utf8',
    );
    const level = (t: string) => {
      const r = imported(readIfc(new TextEncoder().encode(t), { acceptLoss: true }));
      const flight = r.document.elements.find((e) => e.name === 'Spiral flight')!;
      const id = (flight as { base: { level: string } }).base.level;
      return r.document.levels.find((l) => l.id === id)!.name;
    };
    // The flight has no containment of its own: Ground through its ramp, at its own height.
    expect(level(text)).toBe('Ground');
    // Its ramp contained in First: the flight is on First, though it starts below it.
    const first = text.replace(
      /(#300=IFCRELCONTAINEDINSPATIALSTRUCTURE\([^;]*),#24\);/,
      '$1,#26);',
    );
    expect(first).not.toBe(text);
    expect(level(first)).toBe('First');
  });

  it('reads a straight flight whose corners are up to 1 mm off its plane (FU2b, Codex)', () => {
    const text = readFileSync(
      new URL('../fixtures/f53-foreign-ramps.ifc', import.meta.url),
      'utf8',
    );
    // One top corner 0.4 mm high: the fitted grade turns slightly along the level edges.
    const noisy = text.replace('(6.,0.,1.),(6.,1.5,1.)', '(6.,0.,1.0004),(6.,1.5,1.)');
    expect(noisy).not.toBe(text);
    const r = imported(readIfc(new TextEncoder().encode(noisy), { acceptLoss: true }));
    expect(r.report.losses.filter((l) => l.entity === 'IFCRAMPFLIGHT')).toEqual([]);
    const flight = r.document.elements.find((e) => e.name === 'Straight flight')!;
    expect(flight.kind).toBe('slab');
    const s = deriveBim(r.document).shapes.get(flight.id)!;
    if (s.kind !== 'slab' || !s.slope) throw new Error('not a sloped slab');
    expect(Math.abs(s.slope.grade * 6000 - 1000)).toBeLessThan(1);
    // 3 mm off is not the same plane (2 mm is within 1 mm of the plane through the middle).
    const off = text.replace('(6.,0.,1.),(6.,1.5,1.)', '(6.,0.,1.003),(6.,1.5,1.)');
    const q = imported(readIfc(new TextEncoder().encode(off), { acceptLoss: true }));
    expect(q.report.losses.filter((l) => l.entity === 'IFCRAMPFLIGHT')).toHaveLength(1);
  });

  it('checks a sloped slab against its plane along arcs too, not only at corners (FU2b, Codex)', () => {
    // A semicircle bulging 3,000 mm east: the plane z = 0.005x + y/6 read from the short south
    // edge is z = 0.25 + y/6, within 0.25 mm at every corner but 15.25 mm off at the arc's middle.
    const outer: BimLoop = [
      [0, 0],
      [100, 0, 1],
      [100, 6000],
      [0, 6000],
    ];
    expect(slabSlopeFromEdge(outer, [], [0.005, 1 / 6], 0, 0)).toBeUndefined();
    expect(slabSlopeFromEdge(outer, [], [0.005, 1 / 6], 0, 2)).toBeUndefined();
    // Without the cross grade it fits.
    expect(slabSlopeFromEdge(outer, [], [0, 1 / 6], 0, 0)).toEqual({ zTop: 0, zEnd: 1000 });
  });

  it("reads another program's sloped slab back from its cut prism (FU2b)", () => {
    const doc = f48Ramp();
    const out = writeIfc(doc, opts);
    const foreign = out.text.replaceAll("'EP_Constraints'", "'XX_Constraints'");
    const r = imported(readIfc(new TextEncoder().encode(foreign), { acceptLoss: true }));
    // The opening through it is read too (the renamed constraints are the only loss).
    expect(r.report.summary.filter((l) => l.entity !== 'IFCPROPERTYSET')).toEqual([]);
    expect(r.document.elements.filter((e) => e.kind === 'opening')).toHaveLength(1);
    const ev = deriveBim(doc);
    const back = deriveBim(r.document);
    expect(back.diagnostics).toEqual([]);
    const slabs = r.document.elements.filter((e) => e.kind === 'slab');
    expect(slabs.map((e) => e.name)).toEqual(['s-ramp', 's-half']);
    for (const [i, id] of ['s-ramp', 's-half'].entries()) {
      const a = ev.shapes.get(id)!;
      const b = back.shapes.get(slabs[i]!.id)!;
      if (a.kind !== 'slab' || b.kind !== 'slab' || !a.slope || !b.slope) throw new Error(id);
      // The same top plane: the same heights at every boundary corner, the same thickness.
      const z = (s: typeof a, p: readonly number[]) =>
        s.zTop +
        s.slope!.grade *
          ((p[0]! - s.slope!.origin[0]) * s.slope!.direction[0] +
            (p[1]! - s.slope!.origin[1]) * s.slope!.direction[1]);
      for (const p of a.boundary) expect(Math.abs(z(b, p) - z(a, p))).toBeLessThan(1e-3);
      expect(Math.abs(b.zTop - b.zBottom - (a.zTop - a.zBottom))).toBeLessThan(1e-6);
      expect(
        Math.abs(
          back.quantities.get(slabs[i]!.id)!.values.netVolume! -
            ev.quantities.get(id)!.values.netVolume!,
        ) / ev.quantities.get(id)!.values.netVolume!,
      ).toBeLessThan(1e-6);
    }
  });

  it("imports another program's IFC4: the subset at fixed heights, the rest listed (F35)", () => {
    const bytes = readFileSync(new URL('../fixtures/f35-foreign.ifc', import.meta.url));
    const first = readIfc(bytes);
    expect(first.status).toBe('needs-confirmation');
    const r = imported(readIfc(bytes, { acceptLoss: true }));
    expect(r.report.summary).toEqual([
      { entity: 'IFCPROPERTYSET', reason: 'properties-partly-kept', count: 1 },
      { entity: 'IFCPROPERTYSET', reason: 'property-set-not-kept', count: 1 },
      { entity: 'IFCWALL', reason: 'clip-not-roof', count: 1 },
      { entity: 'IFCBUILDINGELEMENTPROXY', reason: 'shape-only', count: 1 },
      { entity: 'IFCDOOR', reason: 'not-in-subset', count: 1 },
      { entity: 'IFCFURNISHINGELEMENT', reason: 'not-in-subset', count: 1 },
    ]);
    expect(first.report).toEqual(r.report);
    expect(r.report.losses.find((l) => l.reason === 'clip-not-roof')).toEqual({
      entity: 'IFCWALL',
      reason: 'clip-not-roof',
      globalId: '0w4___________________',
      name: 'W4',
    });
    expect(r.report.restored).toBe(0);
    expect(r.report.withoutFollow).toBe(11);
    const d = r.document;
    const g = (s: string) => `ifc-0${s}${'_'.repeat(21 - s.length)}`;
    // Metres to mm, storeys from their placements.
    expect(d.levels).toEqual([
      { id: g('ground'), name: 'Ground', elevationMm: 0 },
      { id: g('first'), name: 'First', elevationMm: 3000 },
    ]);
    expect(d.project).toEqual({ name: 'Foreign house', trueNorthRad: 0, siteElevationMm: 12500 });
    const el = (s: string) => d.elements.find((e) => e.id === g(s))!;
    // W1 from a rectangle profile, keeping its Axis's direction, common properties kept.
    expect(el('w1')).toMatchObject({
      kind: 'wall',
      typeId: g('walltype'),
      start: { xy: [0, 0] },
      end: { xy: [5000, 0] },
      location: 'center',
      base: { level: g('ground'), offsetMm: 0 },
      top: { heightMm: 2800 },
      common: { isExternal: true },
    });
    expect(d.types.find((t) => t.id === g('walltype'))).toEqual({
      id: g('walltype'),
      kind: 'wall',
      name: 'Basic 200',
      layers: [{ materialId: 'ifc-material-40', thicknessMm: 200 }],
    });
    // W2 from a closed polyline, with a type made from its brick and thickness.
    expect(el('w2')).toMatchObject({ start: { xy: [5000, 0] }, end: { xy: [5000, 4000] } });
    expect(d.types.find((t) => t.id === (el('w2') as BimWall).typeId)).toMatchObject({
      layers: [{ materialId: 'ifc-material-41', thicknessMm: 200 }],
    });
    // A vertical rectangle swept through W1, and the opening D1 filled (the door is lost).
    expect(el('o1')).toMatchObject({
      hostId: g('w1'),
      wall: { alongMm: 1500, sillMm: 400, widthMm: 1000, heightMm: 1200 },
    });
    expect(el('o2')).toMatchObject({
      hostId: g('w2'),
      wall: { alongMm: 1000, sillMm: 0, widthMm: 900, heightMm: 2100 },
    });
    expect(el('s1')).toMatchObject({
      top: { level: g('first'), offsetMm: 0 },
      boundary: [
        [0, 0],
        [5000, 0],
        [5000, 4000],
        [0, 4000],
      ],
      holes: [
        [
          [1000, 1000],
          [1000, 2000],
          [2000, 2000],
          [2000, 1000],
        ],
      ],
    });
    expect(el('o3')).toMatchObject({ hostId: g('s1') });
    // IfcGridPlacement: the column follows the grid.
    expect(d.grids.map((a) => a.label)).toEqual(['A', '1']);
    expect(el('c1')).toMatchObject({
      at: { grid: ['ifc-grid-A', 'ifc-grid-1'] },
      // No reference direction: X along the first axis (A, northwards).
      rotationRad: Math.PI / 2,
      top: { heightMm: 2800 },
    });
    expect(d.types.find((t) => t.id === (el('c1') as { typeId: string }).typeId)).toMatchObject({
      profile: { shape: 'h', widthMm: 200, depthMm: 190, webMm: 6.5, flangeMm: 10 },
      materialId: 'ifc-material-42',
    });
    expect(el('b1')).toMatchObject({
      start: { xy: [0, 3000] },
      end: { xy: [5000, 3000] },
      top: { level: g('ground'), offsetMm: 2800 },
    });
    // W3 is cut by the flat roof's underside: clipBy comes back.
    expect(el('r1')).toMatchObject({
      base: { level: g('first'), offsetMm: 3000 },
      shape: { form: 'flat' },
    });
    expect(el('w3')).toMatchObject({ clipBy: g('r1'), top: { heightMm: 4000 } });
    expect(el('sp1')).toMatchObject({ kind: 'space', number: '101', name: 'Office' });
    // The join comes back from IfcRelConnectsPathElements: the axes meet at the corner, and the
    // joined walls cover what the bodies did (W1 to W2's far face, W2 from W1's face).
    expect(d.joins).toEqual([{ id: g('join1'), walls: [g('w1'), g('w2')], kind: 'butt' }]);
    const xs = (id: string) =>
      (deriveBim(d).shapes.get(g(id)) as { footprint: number[][] }).footprint.map((v) => [
        v[0],
        v[1],
      ]);
    expect(Math.max(...xs('w1').map((v) => v[0]))).toBe(5100);
    expect(Math.min(...xs('w2').map((v) => v[1]))).toBe(100);
    expect(d.elements.map((e) => e.ifcGlobalId)).toEqual(
      d.elements.map((e) => e.id.slice('ifc-'.length)),
    );
    // Shapes come out of the document as the file drew them.
    const q = deriveBim(d).quantities;
    expect(q.get(g('w1'))!.values).toMatchObject({ length: 5000, width: 200 });
    expect(q.get(g('s1'))!.values).toMatchObject({ grossArea: 20e6, netArea: 18e6 });
    // Written again, the GlobalIds are the file's.
    const out = writeIfc(d, { ...opts, kernelQuantities: new Map([[g('w3'), {}]]) });
    expect(out.globalIds.get(g('w1'))).toBe('0w1___________________');
  });

  it('imports an IFC4 written by IfcOpenShell (F35)', () => {
    const bytes = readFileSync(new URL('../fixtures/f35-ifcopenshell.ifc', import.meta.url));
    const r = imported(readIfc(bytes, { acceptLoss: true }));
    expect(r.report.summary).toEqual([
      { entity: 'IFCDOOR', reason: 'not-in-subset', count: 1 },
      { entity: 'IFCFURNITURE', reason: 'not-in-subset', count: 1 },
    ]);
    const d = r.document;
    expect(d.elements.map((e) => [e.kind, e.name])).toEqual([
      ['wall', 'South'],
      ['wall', 'East'],
      ['opening', 'Window hole'],
      ['slab', 'Floor'],
      ['column', 'C1'],
      ['opening', 'Door hole'],
    ]);
    const by = (name: string) => d.elements.find((e) => e.name === name)!;
    // IfcOpenShell draws a wall on one side of its placement: the axis is the middle.
    expect(by('South')).toMatchObject({ start: { xy: [0, 100] }, end: { xy: [6000, 100] } });
    expect(by('East')).toMatchObject({ start: { xy: [5900, 0] }, end: { xy: [5900, 4000] } });
    // Both walls share the one type (each has its own layer set usage).
    expect(
      new Set(d.elements.filter((e) => e.kind === 'wall').map((e) => (e as BimWall).typeId)).size,
    ).toBe(1);
    expect(by('Window hole')).toMatchObject({
      wall: { alongMm: 2000, sillMm: 900, widthMm: 1200, heightMm: 1000 },
    });
    expect(by('Door hole')).toMatchObject({
      wall: { alongMm: 1000, sillMm: 0, widthMm: 900, heightMm: 2100 },
    });
    expect(by('Floor')).toMatchObject({ top: { offsetMm: 0 } });
    expect(by('C1')).toMatchObject({ at: { xy: [3000, 2000] }, top: { heightMm: 2700 } });
    // Its units are mm and rad, but a described template is not this product's: listed.
    const text = new TextDecoder().decode(bytes);
    const described = text.replace(
      'ENDSEC;\nEND-ISO',
      [
        "#9040=IFCPROPERTYSETTEMPLATE('0tpl__________________',$,'Pset_WallCommon','Common',.PSET_TYPEDRIVENOVERRIDE.,'IfcWall',(#9041));",
        "#9041=IFCSIMPLEPROPERTYTEMPLATE('0tplp_________________',$,'IsExternal',$,.P_SINGLEVALUE.,'IfcBoolean',$,$,$,$,$,.READWRITE.);",
        'ENDSEC;\nEND-ISO',
      ].join('\n'),
    );
    const t = imported(readIfc(new TextEncoder().encode(described), { acceptLoss: true }));
    expect(t.report.summary).toContainEqual({
      entity: 'IFCPROPERTYSETTEMPLATE',
      reason: 'property-template',
      count: 1,
    });
    expect(t.document.propertySets).toEqual([]);
  });

  it('lists foreign shapes it cannot keep exactly, rather than change them (F35)', () => {
    const base = readFileSync(new URL('../fixtures/f35-foreign.ifc', import.meta.url), 'utf8');
    const read = (edit: (s: string) => string) =>
      imported(readIfc(new TextEncoder().encode(edit(base)), { acceptLoss: true }));
    const plain = read((s) => s);
    const added = (s: string, lines: string) =>
      s.replace('ENDSEC;\nEND-ISO', `${lines}\nENDSEC;\nEND-ISO`);
    const lost = (r: BimIfcImportResult) =>
      r.report.summary.filter((l) => !plain.report.summary.some((p) => p.reason === l.reason));
    // A slab opening 50 mm deep in a 200 mm slab is a recess, not a hole through it.
    const recess = read((s) =>
      s.replace(
        '#424=IFCEXTRUDEDAREASOLID(#425,#426,#16,0.22);',
        '#424=IFCEXTRUDEDAREASOLID(#425,#426,#16,0.05);',
      ),
    );
    expect(lost(recess)).toEqual([
      { entity: 'IFCOPENINGELEMENT', reason: 'opening-shape', count: 1 },
    ]);
    // A column's profile 500 mm off the grid intersection stays where it is.
    const offset = read((s) =>
      added(
        s.replace(
          "#516=IFCISHAPEPROFILEDEF(.AREA.,'HEA 200',$,",
          "#516=IFCISHAPEPROFILEDEF(.AREA.,'HEA 200',#9002,",
        ),
        '#9001=IFCCARTESIANPOINT((0.5,0.));\n#9002=IFCAXIS2PLACEMENT2D(#9001,$);',
      ),
    );
    const at = (r: BimIfcImportResult & { status: 'imported' }, name: string) => {
      const c = r.document.elements.find((e) => e.name === name)!;
      return [(c as { at: object }).at, deriveBim(r.document).shapes.get(c.id)] as const;
    };
    const [gridAt, gridShape] = at(plain, 'C1');
    const [offAt, offShape] = at(offset, 'C1');
    expect(gridAt).toHaveProperty('grid');
    expect(offAt).toHaveProperty('xy');
    const xy = (sh: unknown) => (sh as { at: number[] }).at;
    // The profile's X runs along axis A (north).
    expect(xy(offShape)).toEqual([xy(gridShape)[0], xy(gridShape)[1] + 500]);
    // Offset axes are each moved, then intersected: A 500 mm west, meeting the sloping axis 1.
    const skew = read((s) =>
      s
        .replace('#509=IFCCARTESIANPOINT((6.,2.));', '#509=IFCCARTESIANPOINT((6.,9.));')
        .replace('(#502,#503),(0.,0.,0.)', '(#502,#503),(0.5,0.,0.)'),
    );
    expect(at(skew, 'C1')[0]).toEqual({ xy: [500, 3500] });
    // Axis A against its curve (SameSense false): the offset falls on the other side.
    const against = read((s) =>
      s
        .replace("#502=IFCGRIDAXIS('A',#504,.T.);", "#502=IFCGRIDAXIS('A',#504,.F.);")
        .replace('(#502,#503),(0.,0.,0.)', '(#502,#503),(0.5,0.,0.)'),
    );
    expect(at(against, 'C1')[0]).toEqual({ xy: [1500, 2000] });
    // A 20 m column profile is beyond a type's limits: its columns are listed, the rest kept.
    const wide = read((s) => s.replace("'HEA 200',$,0.2,", "'HEA 200',$,20.,"));
    expect(lost(wide)).toEqual([{ entity: 'IFCCOLUMN', reason: 'dimension', count: 1 }]);
    expect(wide.document.elements.length).toBe(plain.document.elements.length - 1);
    expect(wide.document.types.length).toBe(plain.document.types.length - 1);
    // Walls whose bodies a join would reshape (W1 short of W2's far face): the join is listed.
    const short = read((s) =>
      s
        .replace('#107=IFCCARTESIANPOINT((5.1,0.));', '#107=IFCCARTESIANPOINT((5.,0.));')
        .replace('(.AREA.,$,#110,5.1,0.2)', '(.AREA.,$,#110,5.,0.2)')
        .replace('#111=IFCCARTESIANPOINT((2.55,0.));', '#111=IFCCARTESIANPOINT((2.5,0.));'),
    );
    expect(lost(short)).toEqual([
      { entity: 'IFCRELCONNECTSPATHELEMENTS', reason: 'join-reshapes', count: 1 },
    ]);
    expect(short.document.joins).toEqual([]);
    // A W axis is a grid axis like the others.
    const w = read((s) =>
      added(
        s.replace('(#502),(#503),$,.RECTANGULAR.', '(#502),(#503),(#9010),.RECTANGULAR.'),
        [
          "#9010=IFCGRIDAXIS('W',#9011,.T.);",
          '#9011=IFCPOLYLINE((#9012,#9013));',
          '#9012=IFCCARTESIANPOINT((-1.,-1.));',
          '#9013=IFCCARTESIANPOINT((6.,6.));',
        ].join('\n'),
      ),
    );
    expect(lost(w)).toEqual([]);
    expect(w.document.grids.find((a) => a.label === 'W')).toMatchObject({
      start: [-1000, -1000],
      end: [6000, 6000],
    });
    // A wall shorter than it is thick runs along its Axis representation.
    const stub = read((s) =>
      added(
        s,
        [
          "#9020=IFCWALL('0w9___________________',$,'W9',$,$,#9021,#9022,$,.STANDARD.);",
          '#9021=IFCLOCALPLACEMENT(#25,#9023);',
          '#9023=IFCAXIS2PLACEMENT3D(#9024,$,$);',
          '#9024=IFCCARTESIANPOINT((20.,20.,0.));',
          '#9022=IFCPRODUCTDEFINITIONSHAPE($,$,(#9025,#9026));',
          "#9025=IFCSHAPEREPRESENTATION(#15,'Axis','Curve2D',(#9027));",
          '#9027=IFCPOLYLINE((#9028,#9029));',
          '#9028=IFCCARTESIANPOINT((0.,0.));',
          '#9029=IFCCARTESIANPOINT((0.1,0.));',
          "#9026=IFCSHAPEREPRESENTATION(#14,'Body','SweptSolid',(#9030));",
          '#9030=IFCEXTRUDEDAREASOLID(#9031,$,#16,2.8);',
          '#9031=IFCRECTANGLEPROFILEDEF(.AREA.,$,#9032,0.1,0.2);',
          '#9032=IFCAXIS2PLACEMENT2D(#9033,$);',
          '#9033=IFCCARTESIANPOINT((0.05,0.));',
        ].join('\n'),
      ),
    );
    expect(stub.document.elements.find((e) => e.name === 'W9')).toMatchObject({
      start: { xy: [20000, 20000] },
      end: { xy: [20100, 20000] },
    });
    // A beam swept obliquely is not one `bim` rebuilds.
    const oblique = read((s) =>
      added(
        s.replace(
          '#606=IFCEXTRUDEDAREASOLID(#607,$,#16,5.);',
          '#606=IFCEXTRUDEDAREASOLID(#607,$,#9003,5.);',
        ),
        '#9003=IFCDIRECTION((1.,0.,1.));',
      ),
    );
    expect(lost(oblique)).toEqual([{ entity: 'IFCBEAM', reason: 'beam-orientation', count: 1 }]);
  });

  it('refuses its own door whose filled opening changed, and keeps native IDs as written', () => {
    const doc = f31BoxBuilding();
    const out = writeIfc(doc, opts);
    const lines = out.text.split('\n');
    const fill = lines.find((l) => l.includes('=IFCRELFILLSELEMENT('))!;
    const [openingRef, doorRef] = [...fill.matchAll(/#(\d+)/g)].slice(-2).map((m) => m[1]);
    const opening = lines.find((l) => l.startsWith(`#${openingRef}=`))!;
    const shapeRef = Number(/,#(\d+),\$,\.OPENING\.\);$/.exec(opening)![1]);
    const solid = lines.findIndex((l) => l.startsWith(`#${findSolid(lines, shapeRef)}=`));
    lines[solid] = lines[solid].replace(/,([0-9.E-]+)\);$/, ',100.);');
    const door = lines.find((l) => l.startsWith(`#${doorRef}=`))!;
    const doorId = [...out.globalIds].find(([, gid]) => door.includes(`'${gid}'`))![0];
    expect(code(() => readIfc(new TextEncoder().encode(lines.join('\n'))))).toBe(
      `constraint-mismatch:${doorId}`,
    );
    // A native ID at the 128 code points `bim-core` allows comes back as written.
    const long = 'w'.repeat(127) + '\u{1F600}';
    const renamed = JSON.parse(
      JSON.stringify(doc).replaceAll('"w-south"', JSON.stringify(long)),
    ) as BimDocument;
    const back = imported(readIfc(writeIfc(renamed, opts).bytes));
    expect(back.document.joins).toEqual(renamed.joins);
    expect(back.document.elements.some((e) => e.id === long)).toBe(true);
    // A roof ID starting with `@` is a native ID like any other.
    const f35 = f35Export();
    const at = JSON.parse(JSON.stringify(f35.doc).replaceAll('"r-roof"', '"@roof"')) as BimDocument;
    const clipped = imported(readIfc(writeIfc(at, f35.options).bytes, resolveAll));
    expect(clipped.report.losses).toEqual([]);
    expect(
      clipped.document.elements.filter((e) => e.kind === 'wall' && e.clipBy === '@roof').length,
    ).toBe(at.elements.filter((e) => e.kind === 'wall' && e.clipBy === '@roof').length);
  });
});

/** The extruded solid inside a product shape (through representation and clipping). */
function findSolid(lines: string[], shapeRef: number): number {
  const byId = new Map(
    lines.filter((l) => l.startsWith('#')).map((l) => [Number(l.slice(1, l.indexOf('='))), l]),
  );
  const queue = [shapeRef];
  while (queue.length) {
    const id = queue.shift()!;
    const l = byId.get(id)!;
    if (l.includes('=IFCEXTRUDEDAREASOLID(')) return id;
    if (l.includes('=IFCSHAPEREPRESENTATION(') && !l.includes("'Body'")) continue;
    for (const m of l.slice(l.indexOf('(')).matchAll(/#(\d+)/g)) queue.push(Number(m[1]));
  }
  return -1;
}
