import { describe, expect, it } from 'vitest';
import {
  applyPcbOperation,
  componentPads,
  componentTransform,
  generateFootprint,
  loopBounds,
  padLoop,
  pcbGenerators,
  pcbPlacementProblems,
  pcbStarter,
  PcbGeneratorError,
  roundedRectLoop,
  transformLoop,
  validatePcb,
  type PcbComponent,
  type PcbDocument,
  type PcbPad,
} from './index';

const codes = (v: unknown) => validatePcb(v).map((d) => d.code);
const big = (): PcbDocument => ({
  ...pcbStarter(),
  board: { ...pcbStarter().board, outline: roundedRectLoop([0, 0], 200, 200, 0) },
});
const part = (
  id: string,
  footprint: string,
  at: [number, number],
  extra: Partial<PcbComponent> = {},
) =>
  ({
    id,
    ref: id.toUpperCase(),
    value: '',
    footprint,
    at,
    rotationDeg: 0,
    side: 'top',
    locked: false,
    ...extra,
  }) satisfies PcbComponent;

describe('PB2 footprints and parts (ST-461, TS-1923)', () => {
  it('generates every built-in footprint with valid, non-overlapping pads', () => {
    for (const kind of pcbGenerators.keys()) {
      const fp = generateFootprint(`fp-${kind}`, kind);
      const doc: PcbDocument = {
        ...big(),
        footprints: [fp],
        components: [part('p1', fp.id, [100, 100])],
      };
      expect(validatePcb(doc), kind).toEqual([]);
      expect(fp.generator?.kind).toBe(kind);
    }
  });

  it('numbers and places pads as each package expects', () => {
    const header = generateFootprint('h', 'pin-header');
    expect(header.pads).toHaveLength(40);
    expect(header.pads[0]).toMatchObject({ number: '1', at: [0, 0], shape: 'rect', drillMm: 1 });
    expect(header.pads[1]).toMatchObject({ number: '2', at: [0, 2.54] });
    expect(header.pads[39]).toMatchObject({ number: '40', at: [48.26, 2.54] });
    const soic = generateFootprint('s', 'soic');
    expect(soic.pads.map((p) => p.at)).toEqual([
      [-2.7, 1.905],
      [-2.7, 0.635],
      [-2.7, -0.635],
      [-2.7, -1.905],
      [2.7, -1.905],
      [2.7, -0.635],
      [2.7, 0.635],
      [2.7, 1.905],
    ]);
    const qfn = generateFootprint('q', 'qfn');
    expect(qfn.pads).toHaveLength(33);
    expect(qfn.pads.at(-1)).toMatchObject({ number: 'EP', size: [3.2, 3.2] });
    const bga = generateFootprint('b', 'bga', { rows: 20, cols: 20, bodyX: 17, bodyY: 17 });
    expect(bga.pads.map((p) => p.number).slice(0, 2)).toEqual(['A1', 'A2']);
    expect(bga.pads.some((p) => /[IOQSXZ]/.test(p.number))).toBe(false);
    expect(bga.pads.at(-1)!.number).toBe('Y20');
    expect(generateFootprint('c', 'chip', { size: '0402' }).pads.map((p) => p.at)).toEqual([
      [-0.5, 0],
      [0.5, 0],
    ]);
  });

  it('refuses generator parameters that would break the footprint', () => {
    expect(() => generateFootprint('x', 'pin-header', { pinsPerRow: 41 })).toThrow(
      PcbGeneratorError,
    );
    expect(() => generateFootprint('x', 'pin-header', { pad: 2.6 })).toThrow('generator-param:pad');
    expect(() => generateFootprint('x', 'soic', { pins: 7 })).toThrow('generator-param:pins');
    expect(() => generateFootprint('x', 'qfn', { pinsPerSide: 12 })).toThrow(
      'generator-param:pinsPerSide',
    );
    expect(() => generateFootprint('x', 'chip', { size: '0201' })).toThrow('generator-param:size');
    expect(() => generateFootprint('x', 'chip', { colour: 'red' })).toThrow(
      'generator-param:colour',
    );
    expect(() => generateFootprint('x', 'nope')).toThrow('generator-param:kind');
  });

  it('draws pad outlines exactly, arcs included', () => {
    const pad = (p: Partial<PcbPad>): PcbPad => ({
      number: '1',
      type: 'smd',
      shape: 'rect',
      at: [1, 2],
      size: [2, 1],
      rotationDeg: 0,
      ...p,
    });
    expect(loopBounds(padLoop(pad({})))).toEqual([0, 1.5, 2, 2.5]);
    expect(loopBounds(padLoop(pad({ rotationDeg: 90 })))).toEqual([0.5, 1, 1.5, 3]);
    expect(padLoop(pad({ shape: 'oval' }))).toHaveLength(4);
    expect(padLoop(pad({ shape: 'circle', size: [1, 1] }))).toEqual([
      [1.5, 2, 1],
      [0.5, 2, 1],
    ]);
    const rr = padLoop(pad({ shape: 'roundrect', roundness: 0.25 }));
    expect(rr).toHaveLength(8);
    expect(loopBounds(rr).map((v) => Math.round(v * 1e9) / 1e9 + 0)).toEqual([0, 1.5, 2, 2.5]);
  });

  it('places parts on either side, turned', () => {
    const top = componentTransform({ at: [10, 20], rotationDeg: 90, side: 'top' });
    expect(top([1, 0])).toEqual([10, 21]);
    const bottom = componentTransform({ at: [10, 20], rotationDeg: 0, side: 'bottom' });
    expect(bottom([1, 0])).toEqual([9, 20]);
    // A mirrored arc turns the other way.
    expect(
      transformLoop(
        [
          [1, 0, 0.5],
          [0, 1],
        ],
        { at: [0, 0], rotationDeg: 0, side: 'bottom' },
      ),
    ).toEqual([
      [-1, 0, -0.5],
      [0, 1],
    ]);
    const doc = { ...big(), footprints: [generateFootprint('h', 'pin-header')] };
    const c = part('j8', 'h', [8.37, 51.23]);
    const pads = componentPads(doc, c);
    expect(pads[0].at).toEqual([8.37, 51.23]);
    expect(pads[1].at).toEqual([8.37, 53.77]);
    expect(pads[0].layers).toEqual(['F.Cu', 'B.Cu']);
    const chip = { ...doc, footprints: [generateFootprint('r', 'chip')] };
    expect(componentPads(chip, part('r1', 'r', [5, 5], { side: 'bottom' }))[0].layers).toEqual([
      'B.Cu',
    ]);
  });

  it('refuses malformed footprints and parts by code', () => {
    const fp = generateFootprint('r', 'chip');
    const base: PcbDocument = { ...big(), footprints: [fp], components: [part('r1', 'r', [5, 5])] };
    const withPad = (p: Partial<PcbPad>) => {
      const pad: PcbPad = { ...fp.pads[0], ...p };
      if (p.shape && p.shape !== 'roundrect') delete pad.roundness;
      return { ...base, footprints: [{ ...fp, pads: [pad, fp.pads[1]] }] };
    };
    expect(codes(withPad({ number: '2' }))).toEqual(['pad-number-duplicate']);
    expect(codes(withPad({ at: [0.5, 0] }))).toEqual(['pad-overlap']);
    expect(codes(withPad({ rotationDeg: 45 }))).toEqual(['pad-rotation']);
    expect(codes(withPad({ drillMm: 0.3 }))).toEqual(['pad-drill']);
    expect(codes(withPad({ type: 'thru', drillMm: 0.95, shape: 'rect' }))).toEqual(['pad-drill']);
    expect(codes(withPad({ shape: 'circle' }))).toEqual(['pad-circle']);
    expect(codes(withPad({ roundness: 0.8 }))).toEqual(['pad-roundness']);
    expect(codes(withPad({ size: [0.01, 1] }))).toEqual(['dimension']);
    expect(
      codes({ ...base, components: [...base.components, part('r2', 'r', [9, 9], { ref: 'R1' })] }),
    ).toEqual(['ref-duplicate']);
    expect(codes({ ...base, components: [part('r1', 'zz', [5, 5])] })).toEqual([
      'reference-missing',
    ]);
    expect(codes({ ...base, components: [part('r1', 'r', [5, 5], { ref: '1R' })] })).toEqual([
      'ref',
    ]);
    expect(codes({ ...base, components: [part('r1', 'r', [5, 5], { rotationDeg: 360 })] })).toEqual(
      ['rotation'],
    );
    expect(
      codes({ ...base, footprints: [{ ...fp, generator: { kind: 'X', params: {} } }] }),
    ).toEqual(['generator-kind']);
  });

  it('keeps a footprint while a part uses it', () => {
    const fp = generateFootprint('r', 'chip');
    const doc: PcbDocument = { ...big(), footprints: [fp], components: [part('r1', 'r', [5, 5])] };
    expect(() => applyPcbOperation(doc, { type: 'delete', ids: ['r'] })).toThrow('in-use');
    expect(applyPcbOperation(doc, { type: 'delete', ids: ['r', 'r1'] }).footprints).toEqual([]);
  });

  it('moves several parts as one edit, or none', () => {
    const fp = generateFootprint('r', 'chip');
    const doc: PcbDocument = {
      ...big(),
      footprints: [fp],
      components: [part('r1', 'r', [5, 5]), part('r2', 'r', [9, 9])],
    };
    const moved = applyPcbOperation(doc, {
      type: 'updateMany',
      collection: 'components',
      entities: doc.components.map((c) => ({ ...c, at: [c.at[0] + 1, c.at[1]] })),
    });
    expect(moved.components.map((c) => c.at)).toEqual([
      [6, 5],
      [10, 9],
    ]);
    // A duplicate reference in the result refuses the whole edit.
    expect(() =>
      applyPcbOperation(doc, {
        type: 'updateMany',
        collection: 'components',
        entities: [{ ...doc.components[1], ref: 'R1' }],
      }),
    ).toThrow('ref-duplicate');
    expect(() =>
      applyPcbOperation(doc, {
        type: 'updateMany',
        collection: 'components',
        entities: [doc.components[0], doc.components[0]],
      }),
    ).toThrow('operation');
  });

  it('lists placement problems without refusing them', () => {
    const fp = generateFootprint('r', 'chip', { size: '1206' });
    const doc: PcbDocument = {
      ...pcbStarter(),
      holes: [{ id: 'h', name: 'H', at: [50, 50], drillMm: 3, plated: false, keepoutMm: 6 }],
      footprints: [fp],
      components: [
        part('a', 'r', [10, 10]),
        part('b', 'r', [11, 10]),
        part('c', 'r', [11, 10], { side: 'bottom' }),
        part('d', 'r', [99.5, 40]),
        part('e', 'r', [52, 50]),
      ],
    };
    expect(validatePcb(doc)).toEqual([]);
    expect(pcbPlacementProblems(doc)).toEqual([
      { code: 'part-outside-board', ids: ['d'] },
      { code: 'part-over-hole', ids: ['e', 'h'] },
      { code: 'courtyard-overlap', ids: ['a', 'b'] },
    ]);
  });

  it('counts a cut-out as missing board material', () => {
    const fp = generateFootprint('r', 'chip');
    const doc: PcbDocument = {
      ...pcbStarter(),
      board: { ...pcbStarter().board, cutouts: [roundedRectLoop([40, 30], 20, 20, 0)] },
      footprints: [fp],
      components: [
        part('in', 'r', [50, 40]),
        part('edge', 'r', [40, 40]),
        part('ok', 'r', [20, 20]),
      ],
    };
    expect(pcbPlacementProblems(doc)).toEqual([
      { code: 'part-outside-board', ids: ['in'] },
      { code: 'part-outside-board', ids: ['edge'] },
    ]);
  });

  it('limits the pads of every placed part, shared footprints included', () => {
    const fp = generateFootprint('b', 'bga'); // 100 pads
    const components = Array.from({ length: 201 }, (_, i) =>
      part(`p${i}`, 'b', [10 + (i % 20) * 9, 10 + Math.floor(i / 20) * 9]),
    );
    const doc: PcbDocument = {
      ...big(),
      board: { ...big().board, outline: roundedRectLoop([0, 0], 300, 300, 0) },
      footprints: [fp],
      components,
    };
    expect(codes(doc)).toEqual(['limit-count']);
    expect(codes({ ...doc, components: components.slice(0, 150) })).toEqual([]);
  });
});
