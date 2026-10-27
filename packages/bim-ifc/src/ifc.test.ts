import { mkdirSync, writeFileSync } from 'node:fs';
import {
  deriveBim,
  f31BoxBuilding,
  f37Office,
  type BimDocument,
  type BimLoop,
  type BimWall,
  type Vec2,
} from '@editor-platform/bim-core';
import { describe, expect, it } from 'vitest';
import {
  bimIfcKinds,
  bimQtoNames,
  bimQtoScale,
  BimIfcExportError,
  writeIfc,
  type BimIfcExport,
  type BimIfcExportOptions,
  type BimIfcPartMesh,
} from './export';
import { compressGuid, formatReal, formatString, stableGuid } from './p21';
import {
  arcJoinsExport,
  cube,
  element,
  f35Export,
  f39Export,
  hollow,
  opts,
  sheet,
  solidParts,
} from './fixtures';

/** What an independent reader must find (scripts/bim-ifc/verify.py). */
function expectations(doc: BimDocument, out: BimIfcExport, options: BimIfcExportOptions) {
  const d = deriveBim(doc);
  const elements: Record<
    string,
    {
      kind: string;
      volume?: number;
      curved?: boolean;
      bounds?: number[][];
      qto?: Record<string, number>;
      /** OH-U1: each styled item's colour (0–1) and transparency, in item order. */
      styles?: number[][];
    }
  > = {};
  const box = (loop: BimLoop, z0: number, z1: number) => [
    [Math.min(...loop.map((v) => v[0])), Math.min(...loop.map((v) => v[1])), z0],
    [Math.max(...loop.map((v) => v[0])), Math.max(...loop.map((v) => v[1])), z1],
  ];
  const straight = (loop: BimLoop) => loop.every((v) => !v[2]);
  const types = new Map(doc.types.map((t) => [t.id, t]));
  for (const e of doc.elements) {
    if (e.kind === 'opening') continue;
    const s = d.shapes.get(e.id)!;
    const q = d.quantities.get(e.id)!;
    // Clipped elements keep only the analytic values in plan; the rest come from the kernel.
    const plan = ['length', 'width', 'footprintArea', 'crossSectionArea'].filter(
      (k) => e.kind === 'wall' || k === 'crossSectionArea',
    );
    const analytic =
      q.source === 'kernel'
        ? Object.fromEntries(Object.entries(q.values).filter(([k]) => plan.includes(k)))
        : q.values;
    const values = { ...analytic, ...options.kernelQuantities?.get(e.id) };
    const x: (typeof elements)[string] = { kind: e.kind };
    const names = bimQtoNames[e.kind];
    if (names)
      x.qto = Object.fromEntries(
        Object.entries(names)
          .filter(([k]) => values[k] !== undefined)
          .map(([k, [name, unit]]) => [
            `${bimIfcKinds[e.kind].qto}.${name}`,
            values[k] * bimQtoScale[unit],
          ]),
      );
    if (s.kind === 'wall') {
      x.volume = values.netVolume;
      x.curved = !straight(s.footprint);
      if (!x.curved && !s.clipBy) x.bounds = box(s.footprint, s.zBase, s.zTop);
    } else if (s.kind === 'slab') {
      x.volume = values.netVolume;
      if (straight(s.boundary)) x.bounds = box(s.boundary, s.zBottom, s.zTop);
    } else if (s.kind === 'column') {
      x.volume = values.netVolume;
      x.curved = s.profile.shape === 'circle';
    } else if (s.kind === 'beam') x.volume = values.netVolume;
    else if (s.kind === 'roof') {
      x.volume = values.grossVolume;
      x.curved = !straight(s.boundary);
      if (s.faces[0].slope === 0 && straight(s.boundary))
        x.bounds = box(s.boundary, s.zBase, s.zBase + s.thicknessMm);
    } else if (s.kind === 'space') {
      x.volume = values.netVolume;
      if (straight(s.boundary)) x.bounds = box(s.boundary, s.zBase, s.zTop);
    } else if (e.kind === 'door' || e.kind === 'window') {
      const t = types.get(e.typeId)!;
      if ('widthMm' in t) x.volume = t.widthMm * 50 * t.heightMm;
    } else if (e.kind === 'part') {
      const mesh = options.parts!.get(e.id)!;
      x.volume = solidParts.get(mesh)?.volume;
      // Every fixture part with looks has one look, so one styled item.
      if (mesh.styles?.length)
        x.styles = mesh.styles.map((l) => [
          ...[1, 3, 5].map((i) => parseInt(l.color.slice(i, i + 2), 16) / 255),
          1 - l.opacity,
        ]);
    }
    elements[out.globalIds.get(e.id)!] = x;
  }
  const count = (k: string) => doc.elements.filter((e) => e.kind === k).length;
  return {
    storeys: doc.levels.length,
    counts: {
      IfcWall: count('wall'),
      IfcSlab: count('slab'),
      IfcColumn: count('column'),
      IfcBeam: count('beam'),
      IfcDoor: count('door'),
      IfcWindow: count('window'),
      IfcRoof: count('roof'),
      IfcSpace: count('space'),
      IfcBuildingElementProxy: count('part'),
      IfcOpeningElement: count('opening') + count('door') + count('window'),
      IfcRelConnectsPathElements: doc.joins.length,
      IfcRelDefinesByType: new Set(
        doc.elements.filter((e) => 'typeId' in e).map((e) => (e as { typeId: string }).typeId),
      ).size,
      IfcFacetedBrep: [...(options.parts?.values() ?? [])].reduce(
        (n, p) => n + (solidParts.get(p)?.breps ?? 0),
        0,
      ),
      IfcShellBasedSurfaceModel: [...(options.parts?.values() ?? [])].filter(
        (p) => p.kind === 'sheet',
      ).length,
    },
    elements,
  };
}

const cases = () =>
  [
    ['f31', f31BoxBuilding(), opts],
    ['f37', f37Office(), opts],
    ['f35', ...Object.values(f35Export())],
    ['f39-gable', ...Object.values(f39Export('gable'))],
    ['f39-hip', ...Object.values(f39Export('hip'))],
    ['arc-joins', ...Object.values(arcJoinsExport())],
  ] as [string, BimDocument, BimIfcExportOptions][];

describe('IFC export (R2c-4a, CAD66)', () => {
  it('writes F31, F35, F37 and F39 for the independent reader', () => {
    const dir = process.env.BIM_IFC_OUT;
    for (const [name, doc, options] of cases()) {
      const out = writeIfc(doc, options);
      expect(out.text.startsWith('ISO-10303-21;\nHEADER;\n')).toBe(true);
      expect(out.text).toContain("FILE_SCHEMA(('IFC4'));");
      expect(out.text).toContain("'2026-10-24T12:00:00'");
      if (dir) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(`${dir}/${name}.ifc`, out.bytes);
        writeFileSync(
          `${dir}/${name}.expected.json`,
          JSON.stringify(expectations(doc, out, options)),
        );
      }
    }
  });

  it('gives the same bytes and GlobalIds for the same content', () => {
    for (const [, doc, options] of cases()) {
      const a = writeIfc(doc, options);
      const b = writeIfc(structuredClone(doc), options);
      expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
      expect([...a.globalIds]).toEqual([...b.globalIds]);
    }
    const doc = f31BoxBuilding();
    const first = writeIfc(doc, opts).globalIds.get('w-south');
    // Another Artifact gets other IDs; an edit keeps them; a kept IFC GlobalId wins.
    expect(writeIfc(doc, { ...opts, artifactId: 'art-2' }).globalIds.get('w-south')).not.toBe(
      first,
    );
    element<BimWall>(doc, 'w-south').name = 'South';
    expect(writeIfc(doc, opts).globalIds.get('w-south')).toBe(first);
    element<BimWall>(doc, 'w-south').ifcGlobalId = '2O2Fr$t4X7Zf8NOew3FLOH';
    const kept = writeIfc(doc, opts);
    expect(kept.globalIds.get('w-south')).toBe('2O2Fr$t4X7Zf8NOew3FLOH');
    expect(kept.text).toContain("IFCWALL('2O2Fr$t4X7Zf8NOew3FLOH'");
    const ids = [
      ...writeIfc(f37Office(), opts).text.matchAll(/^#\d+=IFC\w+\('([0-9A-Za-z_$]{22})'/gm),
    ].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('maps types, joins, properties and constraints', () => {
    const { doc, options } = f35Export();
    const t = writeIfc(doc, options).text;
    expect(t).toMatch(/IFCWALLTYPE\('[^']+',\$,'RC 180 \+ plaster 20'/);
    expect(t).toContain("IFCPROPERTYSET('");
    expect(t).toContain("'Fire safety'");
    expect(t).toContain("IFCPROPERTYSINGLEVALUE('Minutes',$,IFCREAL(60.),$)");
    expect(t).toContain("IFCPROPERTYSINGLEVALUE('Tested',$,IFCBOOLEAN(.T.),$)");
    expect(t).toContain("IFCPROPERTYSINGLEVALUE('Cover',$,IFCLENGTHMEASURE(30.),$)");
    expect(t).toContain("IFCPROPERTYSINGLEVALUE('Reference',$,IFCIDENTIFIER('EW-1'),$)");
    expect(t).toContain("IFCPROPERTYSINGLEVALUE('TopHeight',$,IFCLENGTHMEASURE(9000.),$)");
    expect(t).toContain("IFCPROPERTYSINGLEVALUE('ClipBy',$,IFCIDENTIFIER('r-roof'),$)");
    expect(t).toContain(
      `IFCPROPERTYSINGLEVALUE('ContentHash',$,IFCIDENTIFIER('${'c0ffee'.repeat(10)}c0ff'),$)`,
    );
    expect(t).toContain("'EP_PartReference'");
    expect(t).toMatch(
      /IFCRELCONNECTSPATHELEMENTS\('[^']+',\$,'butt','j-se',\$,#\d+,#\d+,\(1\),\(0\),\.ATSTART\.,\.ATEND\.\)/,
    );
    expect(t).toContain('IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.');
    expect(t).toContain('IFCARCINDEX((');
    expect(t).toContain("'Clipping'");
    for (const k of [
      'IFCISHAPEPROFILEDEF',
      'IFCLSHAPEPROFILEDEF',
      'IFCUSHAPEPROFILEDEF',
      'IFCRECTANGLEHOLLOWPROFILEDEF',
      'IFCCIRCLEPROFILEDEF',
    ])
      expect(t).toContain(`=${k}(`);
    // Units: mm, m², m³, rad; quantities in them.
    expect(t).toContain('IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)');
    expect(t).toContain("IFCQUANTITYLENGTH('Length',$,$,10000.,$)");
  });

  it('keeps GlobalIds unique and texts within their IFC types', () => {
    const doc = f31BoxBuilding();
    // Entity IDs that look like the writer's own keys.
    element(doc, 'd-entrance').id = '~site';
    const renamed: Record<string, string> = {
      'l-1f': 'project',
      'l-2f': 'agg:project',
      'l-rf': 'w-south:constraints',
    };
    for (const l of doc.levels) l.id = renamed[l.id];
    for (const e of doc.elements)
      for (const k of ['base', 'top'] as const) {
        const h = (e as unknown as Record<string, { level?: string } | undefined>)[k];
        if (h?.level) h.level = renamed[h.level];
      }
    doc.propertySets.push({
      id: 'ps-note',
      name: 'Notes',
      properties: [{ name: 'Text', type: 'string' }],
    });
    // Another definition with the same name, on the same element.
    doc.propertySets.push({
      id: 'ps-note-2',
      name: 'Notes',
      properties: [{ name: 'Text', type: 'string' }],
    });
    element<BimWall>(doc, 'w-south').properties = {
      'ps-note': { Text: 'n'.repeat(1000) },
      'ps-note-2': { Text: 'second' },
    };
    const t = writeIfc(doc, opts).text;
    const ids = [...t.matchAll(/^#\d+=IFC\w+\('([0-9A-Za-z_$]{22})'/gm)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(t).toContain(`IFCTEXT('${'n'.repeat(1000)}')`);
    // Two sets and their two templates.
    expect(t.match(/'Notes'/g)).toHaveLength(4);
    // A set with no values is refused, not dropped (IfcPropertySet needs one property).
    element<BimWall>(doc, 'w-north').properties = { 'ps-note': {} };
    expect(() => writeIfc(doc, opts)).toThrow('invalid-document');
    // A grid's constraint set and an element named `grid`.
    const grid = f31BoxBuilding();
    grid.grids = [
      { id: 'g-a', label: 'A', start: [0, -1000], end: [0, 9000] },
      { id: 'g-1', label: '1', start: [-1000, 0], end: [11000, 0] },
    ];
    element(grid, 'win-e1').id = 'grid';
    const gt = writeIfc(grid, opts).text;
    expect(gt).toContain('IFCGRID(');
    const gids = [...gt.matchAll(/^#\d+=IFC\w+\('([0-9A-Za-z_$]{22})'/gm)].map((m) => m[1]);
    expect(new Set(gids).size).toBe(gids.length);
    // Two long grid-axis IDs are kept whole.
    const axis = (c: string) => c.repeat(128);
    for (const a of grid.grids) a.id = axis(a.label === 'A' ? 'a' : 'b');
    grid.elements.push({
      id: 'c-long',
      kind: 'column',
      typeId: 't-column-600',
      at: { grid: [axis('a'), axis('b')] },
      rotationRad: 0,
      base: { level: 'l-1f', offsetMm: 0 },
      top: { level: 'l-2f', offsetMm: 0 },
    });
    const long = writeIfc(grid, opts).text;
    for (const c of ['a', 'b']) expect(long).toContain(`IFCIDENTIFIER('${axis(c)}')`);
    // Axes 30° apart are two directions: the grid is written.
    const skew = f31BoxBuilding();
    skew.grids = [
      { id: 'g,a', label: 'A', start: [0, 0], end: [10000, 0] },
      { id: 'g', label: '1', start: [0, 0], end: [10000 * Math.cos(Math.PI / 6), 5000] },
    ];
    expect(writeIfc(skew, opts).text.match(/=IFCGRIDAXIS\(/g)).toHaveLength(2);
    // A GlobalId kept from an import must stay unique.
    const kept = f31BoxBuilding();
    element(kept, 'w-south').ifcGlobalId = '0123456789012345678901';
    element(kept, 'w-north').ifcGlobalId = '0123456789012345678901';
    expect(() => writeIfc(kept, opts)).toThrow('global-id-duplicate');
    // A door's opening is named after it, within IfcLabel's 255 characters.
    const door = f31BoxBuilding();
    element(door, 'd-entrance').name = 'd'.repeat(255);
    expect(writeIfc(door, opts).text).toContain(`'${'d'.repeat(247)} opening'`);
  });

  it('keeps an opening in a tight arc wall clear of the centre', () => {
    const doc = f31BoxBuilding();
    const wall: BimWall = {
      ...element<BimWall>(doc, 'w-south'),
      start: { xy: [0, 0] },
      end: { xy: [210, 0] },
      bulge: 1,
    };
    // A 200 mm wall on a 105 mm radius: the inner face's radius is 5 mm.
    doc.elements = [
      wall,
      {
        id: 'o-tight',
        kind: 'opening',
        hostId: wall.id,
        wall: { alongMm: 50, sillMm: 0, widthMm: 100, heightMm: 1000 },
      },
    ];
    doc.joins = [];
    const t = writeIfc(doc, opts).text;
    const lists = [...t.matchAll(/IFCCARTESIANPOINTLIST2D\(\((.*)\)\)/g)].map((m) =>
      [...m[1].matchAll(/\(([-\d.E]+),([-\d.E]+)\)/g)].map((p) => [+p[1], +p[2]] as Vec2),
    );
    // The wall turns through y < 0; a negative inner radius would put points on the other side.
    expect(lists.length).toBeGreaterThanOrEqual(2);
    for (const points of lists) for (const [, y] of points) expect(y).toBeLessThan(1e-9);
  });

  it('writes each body of a part mesh as its own shell', () => {
    const { doc, options } = f35Export();
    const twoCubes: BimIfcPartMesh = {
      ...cube,
      positions: [...cube.positions, ...cube.positions.map((v, i) => (i % 3 === 0 ? v + 3000 : v))],
      triangles: [...cube.triangles, ...cube.triangles.map((v) => v + 8)],
    };
    const one = writeIfc(doc, options).text;
    const two = writeIfc(doc, {
      ...options,
      parts: new Map([...options.parts!, ['p-box', twoCubes]]),
    }).text;
    const breps = (t: string) => t.match(/=IFCFACETEDBREP\(/g)?.length ?? 0;
    expect(breps(two)).toBe(breps(one) + 1);
    // Cubes touching at a corner are still two bodies.
    const corner: BimIfcPartMesh = {
      ...cube,
      positions: [...cube.positions, ...cube.positions.map((v) => v + 1000)],
      triangles: twoCubes.triangles,
    };
    const c = writeIfc(doc, {
      ...options,
      parts: new Map([...options.parts!, ['p-box', corner]]),
    }).text;
    expect(breps(c)).toBe(breps(one) + 1);
    // F35's hollow part is the cube with its cavity cut out.
    expect(one).toMatch(/=IFCBOOLEANRESULT\(\.DIFFERENCE\.,#\d+,#\d+\)/);
    // A cavity goes to the body it lies inside, not to a ring whose bounds merely contain it.
    const box = (lo: number[], hi: number[], inward = false): BimIfcPartMesh => ({
      ...cube,
      positions: cube.positions.map((v, i) => lo[i % 3] + (v / 1000) * (hi[i % 3] - lo[i % 3])),
      triangles: inward ? hollow.triangles.slice(36).map((v) => v - 8) : cube.triangles,
    });
    const join = (...meshes: BimIfcPartMesh[]): BimIfcPartMesh => ({
      ...cube,
      positions: meshes.flatMap((m) => [...m.positions]),
      triangles: meshes.flatMap((m, i) => m.triangles.map((v) => v + 8 * i)),
    });
    const ringed = join(
      box([0, 0, 0], [1000, 50, 1000]),
      box([0, 950, 0], [1000, 1000, 1000]),
      box([0, 50, 0], [50, 950, 1000]),
      box([950, 50, 0], [1000, 950, 1000]),
      box([100, 100, 100], [900, 900, 900]),
      box([300, 300, 300], [700, 700, 700], true),
    );
    const r = writeIfc(doc, {
      ...options,
      parts: new Map([...options.parts!, ['p-box', ringed]]),
    }).text;
    const entity = (ref: string) => r.match(new RegExp(`^${ref}=(\\w+)\\((.*)\\);$`, 'm'))!;
    const differences = [...r.matchAll(/=IFCBOOLEANRESULT\(\.DIFFERENCE\.,(#\d+),#\d+\)/g)];
    const cut = differences
      .map((m) => entity(entity(m[1])[2])[2])
      .map((shell) => shell.split(',').length);
    // F35's hollow cube, and the 800 mm cube here: both outer shells of 12 triangles.
    expect(cut).toEqual([12, 12]);
    // A cavity outside every body is refused.
    const stray: BimIfcPartMesh = {
      ...cube,
      positions: [...cube.positions, ...cube.positions.map((v) => v + 5000)],
      triangles: hollow.triangles,
    };
    expect(() =>
      writeIfc(doc, { ...options, parts: new Map([...options.parts!, ['p-box', stray]]) }),
    ).toThrow('part-cavity');
  });

  it("colours a part's items by its CAD bodies' looks (OH-U1)", () => {
    const { doc, options } = f35Export();
    const count = (t: string, name: string) => t.match(new RegExp(`=${name}\\(`, 'g'))?.length ?? 0;
    // Two sheets apart, each its own look: a surface model each, styled apart.
    const glass = { color: '#38bdf8', opacity: 0.4 };
    const tile = { color: '#F2EFE6', opacity: 1 };
    const two: BimIfcPartMesh = {
      ...sheet,
      positions: [...sheet.positions, ...sheet.positions.map((v, i) => (i % 3 === 2 ? 500 : v))],
      triangles: [...sheet.triangles, ...sheet.triangles.map((v) => v + 4)],
      styles: [glass, tile],
      triangleStyles: [0, 0, 1, 1],
    };
    const out = writeIfc(doc, {
      ...options,
      parts: new Map([...options.parts!, ['p-sheet', two]]),
    }).text;
    expect(count(out, 'IFCSHELLBASEDSURFACEMODEL')).toBe(2);
    expect(out).toContain("IFCSURFACESTYLE('#f2efe6',.BOTH.,");
    expect(out).toMatch(/=IFCSURFACESTYLESHADING\(#\d+,0\.6\);/);
    // The same look on both: one surface model; a look already written is shared.
    const same = writeIfc(doc, {
      ...options,
      parts: new Map([
        ...options.parts!,
        ['p-sheet', { ...two, styles: [glass, glass] }],
        ['p-box', { ...cube, styles: [glass], triangleStyles: Array<number>(12).fill(0) }],
      ]),
    }).text;
    expect(count(same, 'IFCSHELLBASEDSURFACEMODEL')).toBe(1);
    expect(count(same, 'IFCSURFACESTYLE')).toBe(2);
    expect(count(same, 'IFCSTYLEDITEM')).toBe(3);
    // Without looks (or with a colour that is not #rrggbb), no style.
    const plain = writeIfc(doc, {
      ...options,
      parts: new Map([
        ['p-box', cube],
        ['p-hollow', { ...hollow, styles: undefined }],
        ['p-sheet', { ...sheet, styles: [{ color: 'white', opacity: 1 }] }],
      ]),
    }).text;
    expect(count(plain, 'IFCSTYLEDITEM')).toBe(0);
  });

  it('relates a butt join through the wall derivation runs through', () => {
    const doc = f31BoxBuilding();
    // A T without `through`: the stopping wall listed first.
    doc.elements.push({
      ...element<BimWall>(doc, 'w-south'),
      id: 'w-inner',
      start: { xy: [4000, 0] },
      end: { xy: [4000, 3000] },
    });
    doc.joins.push({ id: 'j-tee', walls: ['w-inner', 'w-south'], kind: 'butt' });
    const out = writeIfc(doc, opts);
    const line = (start: string) => out.text.split('\n').find((l) => l.includes(start))!;
    const rel = line(`IFCRELCONNECTSPATHELEMENTS('${out.globalIds.get('j-tee')}'`);
    const ref = (id: string) => line(`=IFCWALL('${out.globalIds.get(id)}'`).split('=')[0];
    expect(rel).toContain(`,${ref('w-south')},${ref('w-inner')},(1),(0),`);
  });

  it('keeps only plan quantities of clipped elements from the analysis', () => {
    const { doc, options } = f35Export();
    const t = writeIfc(doc, options).text;
    const south = deriveBim(doc).quantities.get('w-south')!;
    expect(south.source).toBe('kernel');
    // The unclipped height would be 9,000 mm; the clipped one is the kernel's to report.
    expect(t).not.toContain("IFCQUANTITYLENGTH('Height',$,$,9000.,$)");
    expect(t).toContain(`IFCQUANTITYLENGTH('Length',$,$,${south.values.length}`);
  });

  it('refuses what it cannot write faithfully', () => {
    const code = (f: () => unknown) => {
      try {
        f();
      } catch (err) {
        expect(err).toBeInstanceOf(BimIfcExportError);
        return [(err as BimIfcExportError).code, (err as BimIfcExportError).ids];
      }
      return undefined;
    };
    const { doc, options } = f35Export();
    expect(code(() => writeIfc(doc, { ...options, kernelQuantities: undefined }))).toEqual([
      'evaluation-required',
      ['w-south', 'w-east', 'w-north', 'w-west', 'c-clip'],
    ]);
    expect(code(() => writeIfc(doc, { ...options, parts: new Map([['p-box', cube]]) }))).toEqual([
      'evaluation-required',
      ['p-hollow', 'p-sheet'],
    ]);
    expect(
      code(() =>
        writeIfc(doc, {
          ...options,
          parts: new Map([
            ['p-box', { ...cube, kind: 'mixed' }],
            ['p-hollow', hollow],
            ['p-sheet', sheet],
          ]),
        }),
      ),
    ).toEqual(['part-mixed-kinds', ['p-box']]);
    const broken = f31BoxBuilding();
    element<BimWall>(broken, 'w-east').top = { level: 'l-1f', offsetMm: 0 };
    expect(code(() => writeIfc(broken, opts))?.[0]).toBe('invalid-document');
  });
});

describe('P21 values', () => {
  it('writes reals, strings and GUIDs in the exchange form', () => {
    expect(formatReal(4000)).toBe('4000.');
    expect(formatReal(-0)).toBe('0.');
    expect(formatReal(0.1 + 0.2)).toBe('0.30000000000000004');
    expect(formatReal(1e-7)).toBe('1.E-7');
    expect(formatReal(1.5e21)).toBe('1.5E21');
    expect(() => formatReal(Number.NaN)).toThrow();
    expect(formatString("it's a\\b")).toBe("'it''s a\\\\b'");
    expect(formatString('壁 A')).toBe("'\\X2\\58C1\\X0\\ A'");
    // Reference values from IfcOpenShell's ifcopenshell.guid.compress.
    const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
    expect(compressGuid(hex('00000000000000000000000000000000'))).toBe('0000000000000000000000');
    expect(compressGuid(hex('ffffffffffffffffffffffffffffffff'))).toBe('3$$$$$$$$$$$$$$$$$$$$$');
    expect(compressGuid(hex('3a1b2c3d4e5f60718293a4b5c6d7e8f9'))).toBe('0w6omzJbzWSOAJfBN6r_Zv');
    expect(stableGuid('x')).toBe(stableGuid('x'));
    expect(stableGuid('x')).not.toBe(stableGuid('y'));
  });
});
