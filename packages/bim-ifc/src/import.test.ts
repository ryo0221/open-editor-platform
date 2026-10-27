import { readFileSync } from 'node:fs';
import {
  deriveBim,
  f31BoxBuilding,
  f37Office,
  type BimDocument,
  type BimElement,
  type BimWall,
} from '@editor-platform/bim-core';
import { describe, expect, it } from 'vitest';
import { writeIfc } from './export';
import { element, f35Export, f39Export, opts } from './fixtures';
import {
  BimIfcImportError,
  readIfc,
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
    { id: 'g-a', label: 'A', start: [0, -1000], end: [0, 9000] },
    { id: 'g-b', label: 'B', start: [10000, -1000], end: [10000, 9000] },
    { id: 'g-1', label: '1', start: [-1000, 0], end: [11000, 0] },
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
