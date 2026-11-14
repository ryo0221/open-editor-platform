import { unzipSync, strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  f75Pi5Board,
  generateFootprint,
  componentPads,
  gerberField,
  loopArea,
  pcbBomCsv,
  pcbFabricationFiles,
  pcbFabricationZip,
  pcbZoneFills,
  roundedRectLoop,
  trapezoidArea,
  validatePcb,
  type PcbComponent,
  type PcbDocument,
} from './index';
import {
  gerberApertureArea,
  gerberContourArea,
  readExcellon,
  readGerber,
  type GerberObject,
} from './gerber-read';

// PB6 fabrication data (ST-466): copper TS-1935, edge/drill/sides TS-1936, CSV/zip TS-1937.

const part = (
  id: string,
  ref: string,
  footprint: string,
  at: [number, number],
  extra: Partial<PcbComponent> = {},
): PcbComponent => ({
  id,
  ref,
  value: '10k',
  footprint,
  at,
  rotationDeg: 0,
  side: 'top',
  locked: false,
  ...extra,
});

/** F75 with two resistors, a 2×3 header, a routed SIG, a via and a GND pour. */
function board(): PcbDocument {
  return {
    ...f75Pi5Board(),
    footprints: [
      generateFootprint('r', 'chip'),
      generateFootprint('h', 'pin-header', { rows: 2, pinsPerRow: 3 }),
    ],
    components: [
      part('r1', 'R1', 'r', [40, 30]),
      part('r2', 'R2', 'r', [50, 30]),
      part('j1', 'J1', 'h', [20, 40], { value: 'HDR' }),
    ],
    nets: [
      {
        id: 'gnd',
        name: 'GND',
        class: 'nc-default',
        pins: [
          ['r1', '1'],
          ['r2', '2'],
          ['j1', '2'],
        ],
      },
      {
        id: 'sig',
        name: 'SIG',
        class: 'nc-default',
        pins: [
          ['r1', '2'],
          ['r2', '1'],
        ],
      },
    ],
    tracks: [
      { id: 't1', net: 'sig', layer: 'F.Cu', widthMm: 0.2, from: [40.8, 30], to: [45, 30] },
      { id: 't2', net: 'sig', layer: 'B.Cu', widthMm: 0.2, from: [45, 30], to: [49.2, 30] },
    ],
    vias: [{ id: 'v1', net: 'sig', at: [45, 30], diameterMm: 0.6, drillMm: 0.3 }],
    zones: [
      {
        id: 'z1',
        net: 'gnd',
        layer: 'F.Cu',
        outline: roundedRectLoop([-2, -2], 89, 60, 0),
        priority: 0,
        clearanceMm: 0.2,
        padConnection: 'thermal',
        thermalGapMm: 0.3,
        spokeWidthMm: 0.3,
      },
    ],
  };
}

const file = (doc: PcbDocument, suffix: string) => {
  const f = pcbFabricationFiles(doc).find((x) => x.name.endsWith(suffix));
  if (!f) throw new Error(suffix);
  return f.text;
};
const flashes = (objs: GerberObject[]) =>
  objs.filter((o): o is Extract<GerberObject, { kind: 'flash' }> => o.kind === 'flash');
const draws = (objs: GerberObject[]) =>
  objs.filter((o): o is Extract<GerberObject, { kind: 'draw' }> => o.kind === 'draw');
const regions = (objs: GerberObject[]) =>
  objs.filter((o): o is Extract<GerberObject, { kind: 'region' }> => o.kind === 'region');
/** Area of one object: a flash's aperture or a region's contour. */
const areaOf = (o: GerberObject) =>
  o.kind === 'flash'
    ? gerberApertureArea(o.aperture)
    : o.kind === 'region'
      ? Math.abs(gerberContourArea(o.contour))
      : 0;

describe('Gerber and drill files (PB6)', () => {
  it('reads back the copper of a layer: tracks, vias, pads and the pour', () => {
    const doc = board();
    expect(validatePcb(doc)).toEqual([]);
    const top = readGerber(file(doc, '-F_Cu.gbr'));
    expect(top.fileAttrs['.FileFunction']).toEqual(['Copper', 'L1', 'Top']);
    expect(top.fileAttrs['.FilePolarity']).toEqual(['Positive']);
    // The track: one draw, its width, ends and net.
    const t = draws(top.objects);
    expect(t).toHaveLength(1);
    expect(t[0].aperture).toEqual({ template: 'C', params: [0.2], function: 'Conductor' });
    expect(t[0].segment.from).toEqual([40.8, 30]);
    expect(t[0].segment.to).toEqual([45, 30]);
    expect(t[0].attrs['.N']).toEqual(['SIG']);
    // The via on every layer.
    for (const layer of ['-F_Cu.gbr', '-B_Cu.gbr']) {
      const v = flashes(readGerber(file(doc, layer)).objects).filter(
        (o) => o.aperture.function === 'ViaPad',
      );
      expect(v.map((o) => [o.at, o.aperture.params, o.attrs['.N']])).toEqual([
        [[45, 30], [0.6], ['SIG']],
      ]);
    }
    // Pads: every pad of the layer once, named by part and pin, with its true area.
    const pads = top.objects.filter((o) => o.attrs['.P']);
    const expected = doc.components.flatMap((c) =>
      componentPads(doc, c).filter((p) => p.layers.includes('F.Cu')),
    );
    expect(pads).toHaveLength(expected.length);
    for (const p of expected) {
      const ref = doc.components.find((c) => c.id === p.component)!.ref;
      const o = pads.find((x) => x.attrs['.P'][0] === ref && x.attrs['.P'][1] === p.pad.number)!;
      expect(o, `${ref}.${p.pad.number}`).toBeDefined();
      expect(areaOf(o)).toBeCloseTo(Math.abs(loopArea(p.loop)), 5);
      expect(o.attrs['.C']).toEqual([ref]);
    }
    const pin = (ref: string, n: string) =>
      pads.find((x) => x.attrs['.P'][0] === ref && x.attrs['.P'][1] === n)!;
    expect(pin('R1', '1').kind).toBe('region');
    expect(pin('R1', '1').attrs['.N']).toEqual(['GND']);
    expect(pin('J1', '1')).toMatchObject({
      kind: 'flash',
      at: [20, 40],
      aperture: { template: 'R', params: [1.7, 1.7], function: 'ComponentPad' },
    });
    // The pour: regions of GND whose area is the fill's.
    const fill = pcbZoneFills(doc)[0];
    const pour = regions(top.objects).filter((o) => o.function === 'Conductor');
    expect(pour.every((o) => o.attrs['.N'][0] === 'GND')).toBe(true);
    const area = pour.reduce((s, o) => s + areaOf(o), 0);
    expect(area).toBeGreaterThan(4000);
    expect(Math.abs(area - trapezoidArea(fill.trapezoids))).toBeLessThan(1e-3);
    // The bottom layer holds the bottom track and through pads, no SMD pads, no pour.
    const bottom = readGerber(file(doc, '-B_Cu.gbr'));
    expect(bottom.fileAttrs['.FileFunction']).toEqual(['Copper', 'L4', 'Bot']);
    expect(draws(bottom.objects).map((o) => o.attrs['.N'])).toEqual([['SIG']]);
    expect(bottom.objects.filter((o) => o.attrs['.P'])).toHaveLength(6);
    expect(regions(bottom.objects).filter((o) => o.function === 'Conductor')).toHaveLength(0);
  });

  it('writes the board edge with its arcs, and the holes to two drill files', () => {
    const doc = board();
    const edge = readGerber(file(doc, '-Edge_Cuts.gbr'));
    expect(edge.fileAttrs['.FileFunction']).toEqual(['Profile', 'NP']);
    const sides = draws(edge.objects);
    expect(sides.some((s) => s.segment.center)).toBe(true);
    expect(sides.every((s) => s.aperture.function === 'Profile')).toBe(true);
    const area = gerberContourArea(sides.map((s) => s.segment));
    expect(area).toBeCloseTo(loopArea(doc.board.outline), 6);
    expect(area).toBeCloseTo(85 * 56 - (4 - Math.PI) * 9, 3);
    // Drill: the via and the header's six holes plated, the four mounting holes not.
    const pth = readExcellon(file(doc, '-PTH.drl'));
    expect(pth.plated).toBe(true);
    expect(pth.hits.map((h) => [h.drillMm, h.at]).sort()).toEqual(
      [[0.3, [45, 30]], ...componentPads(doc, doc.components[2]).map((p) => [1, p.at])].sort(),
    );
    const npth = readExcellon(file(doc, '-NPTH.drl'));
    expect(npth.plated).toBe(false);
    expect(npth.hits.map((h) => h.at)).toEqual(doc.holes.map((h) => h.at));
    expect(new Set(npth.hits.map((h) => h.drillMm))).toEqual(new Set([2.7]));
  });

  it('TS-1965: writes a nearly straight arc of the edge as lines the format can hold', () => {
    // #1108 review: bulge 1e-14 is a valid outline, but its centre is ~1e15 mm away; the
    // offset written as I/J came out in scientific notation, which no Gerber reader takes.
    const base = board();
    for (const outline of [
      [
        [0, 0, 1e-14],
        [40, 0],
        [40, 30],
        [0, 30],
      ],
      // Radius ≈ 2·10⁴ mm: the offset is finite but has more than four integer digits.
      [
        [0, 0, 0.0005],
        [40, 0],
        [40, 30],
        [0, 30],
      ],
    ] as PcbDocument['board']['outline'][]) {
      const doc: PcbDocument = {
        ...base,
        board: { ...base.board, outline },
        components: [],
        tracks: [],
        vias: [],
        zones: [],
        holes: [],
        nets: [],
      };
      expect(validatePcb(doc).filter((d) => d.severity === 'error')).toEqual([]);
      const text = file(doc, '-Edge_Cuts.gbr');
      expect(text).not.toMatch(/\d[eE][+-]?\d/);
      const sides = draws(readGerber(text).objects).map((s) => s.segment);
      expect(sides.every((s) => !s.center)).toBe(true);
      // Lines within 0.5 nm of the arc: the area differs by less than that times the length.
      expect(gerberContourArea(sides)).toBeCloseTo(loopArea(outline), 4);
    }
  });

  it('puts a bottom part on the bottom layers; turned and rounded pads become regions', () => {
    const doc = board();
    const turned = {
      ...doc,
      footprints: [...doc.footprints, generateFootprint('s', 'soic')],
      components: [
        ...doc.components,
        part('u1', 'U1', 's', [60, 20], { side: 'bottom', rotationDeg: 30, value: 'IC' }),
      ],
    };
    expect(validatePcb(turned)).toEqual([]);
    const pads = componentPads(turned, turned.components[3]);
    const bottom = readGerber(file(turned, '-B_Cu.gbr')).objects.filter(
      (o) => o.attrs['.P']?.[0] === 'U1',
    );
    expect(bottom).toHaveLength(pads.length);
    expect(bottom.every((o) => o.kind === 'region')).toBe(true);
    for (const o of bottom) {
      const p = pads.find((x) => x.pad.number === o.attrs['.P'][1])!;
      expect(areaOf(o)).toBeCloseTo(Math.abs(loopArea(p.loop)), 5);
    }
    expect(
      readGerber(file(turned, '-F_Cu.gbr')).objects.some((o) => o.attrs['.P']?.[0] === 'U1'),
    ).toBe(false);
    // Mask: openings (negative) for every pad of the side and the through pads; paste: SMD only.
    const fMask = readGerber(file(turned, '-F_Mask.gbr'));
    expect(fMask.fileAttrs['.FilePolarity']).toEqual(['Negative']);
    const bMask = readGerber(file(turned, '-B_Mask.gbr'));
    const holes = turned.holes.length;
    expect(bMask.objects).toHaveLength(pads.length + 6 + holes);
    expect(fMask.objects).toHaveLength(4 + 6 + holes);
    expect(readGerber(file(turned, '-B_Paste.gbr')).objects).toHaveLength(pads.length);
    expect(readGerber(file(turned, '-F_Paste.gbr')).objects).toHaveLength(4);
    // Silk on its side: the SOIC's outline lines turned with the part.
    const silk = readGerber(file(turned, '-B_SilkS.gbr'));
    expect(silk.fileAttrs['.FileFunction']).toEqual(['Legend', 'Bot']);
    const fp = turned.footprints[2];
    expect(silk.objects).toHaveLength(fp.silk.length);
    const lines = draws(silk.objects);
    const len = (o: (typeof lines)[number]) =>
      Math.hypot(o.segment.to[0] - o.segment.from[0], o.segment.to[1] - o.segment.from[1]);
    const want = fp.silk
      .flatMap((s) =>
        s.kind === 'line' ? [Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1])] : [],
      )
      .sort();
    expect(
      lines
        .map(len)
        .sort()
        .map((v) => Math.round(v * 1e5)),
    ).toEqual(want.map((v) => Math.round(v * 1e5)));
  });
});

describe('Assembly files and the archive (PB6)', () => {
  it('writes the BOM and placement CSV, escaped', () => {
    const doc = board();
    const named = {
      ...doc,
      components: [...doc.components, part('r10', 'R10', 'r', [60, 30], { value: '4.7k, 1%' })],
    };
    const files = pcbFabricationFiles(named, 'hat');
    const bom = files.find((f) => f.name === 'hat-bom.csv')!.text;
    expect(bom.split('\n')).toEqual([
      'Designator,Value,Footprint,Footprint ID,Quantity',
      `J1,HDR,${doc.footprints[1].name},h,1`,
      `R1 R2,10k,${doc.footprints[0].name},r,2`,
      `R10,"4.7k, 1%",${doc.footprints[0].name},r,1`,
      '',
    ]);
    const pos = files.find((f) => f.name === 'hat-pos.csv')!.text.split('\n');
    expect(pos[0]).toBe('Designator,Value,Footprint,Mid X,Mid Y,Rotation,Layer');
    expect(pos.slice(1, 5).map((l) => l.split(',')[0])).toEqual(['J1', 'R1', 'R2', 'R10']);
    expect(pos[2]).toBe(`R1,10k,${doc.footprints[0].name},40.0000,30.0000,0.0000,top`);
    // A header's origin is pin 1: its centre is the middle of the 2×3 pins (+2.54, +1.27).
    expect(pos[1]).toBe(`J1,HDR,${doc.footprints[1].name},22.5400,41.2700,0.0000,top`);
    // Two footprints with the same name and value are two BOM lines.
    const twin = {
      ...named,
      footprints: [...named.footprints, { ...named.footprints[0], id: 'r-b' }],
      components: [...named.components, part('r11', 'R11', 'r-b', [60, 40])],
    };
    expect(pcbBomCsv(twin).split('\n')).toContain(`R11,10k,${doc.footprints[0].name},r-b,1`);
    // A net name with a comma survives the Gerber field escape.
    expect(gerberField('A,B*%\\')).toBe('A\\u002CB\\u002A\\u0025\\u005C');
    const odd = {
      ...doc,
      nets: doc.nets.map((n) => (n.id === 'sig' ? { ...n, name: 'S,1*' } : n)),
    };
    const t = draws(readGerber(file(odd, '-F_Cu.gbr')).objects);
    expect(t[0].attrs['.N']).toEqual(['S,1*']);
  });

  it('zips every file, the same board giving the same bytes', () => {
    const doc = board();
    const files = pcbFabricationFiles(doc, 'pi5');
    expect(files.map((f) => f.name)).toEqual([
      'pi5-F_Cu.gbr',
      'pi5-In1_Cu.gbr',
      'pi5-In2_Cu.gbr',
      'pi5-B_Cu.gbr',
      'pi5-F_Mask.gbr',
      'pi5-B_Mask.gbr',
      'pi5-F_Paste.gbr',
      'pi5-B_Paste.gbr',
      'pi5-F_SilkS.gbr',
      'pi5-B_SilkS.gbr',
      'pi5-Edge_Cuts.gbr',
      'pi5-PTH.drl',
      'pi5-NPTH.drl',
      'pi5-bom.csv',
      'pi5-pos.csv',
    ]);
    const zip = pcbFabricationZip(files);
    expect(pcbFabricationZip(pcbFabricationFiles(board(), 'pi5'))).toEqual(zip);
    const back = unzipSync(zip);
    expect(Object.keys(back)).toEqual(files.map((f) => f.name));
    for (const f of files) expect(strFromU8(back[f.name])).toBe(f.text);
    // F75 has four copper layers: inner layers are numbered between; two layers are L1 and L2.
    expect(files.slice(0, 4).map((f) => f.role)).toEqual([
      'Copper,L1,Top',
      'Copper,L2,Inr',
      'Copper,L3,Inr',
      'Copper,L4,Bot',
    ]);
    const two = { ...doc, board: { ...doc.board, copperLayers: 2 as const } };
    expect(
      pcbFabricationFiles(two)
        .slice(0, 2)
        .map((f) => f.role),
    ).toEqual(['Copper,L1,Top', 'Copper,L2,Bot']);
  });
});
