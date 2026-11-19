import { describe, expect, it } from 'vitest';
import { cadBuilder } from './builder';
import { fixtureKernel } from './fixtures';
import { bearingSeries02 } from './machine-elements';
import {
  ballBearings,
  bearingBalls,
  iso3601InnerDiameters,
  iso4762,
  oRingGland,
  oRingGroove,
  parseStandardDesignation,
  standardPart,
  standardPartNames,
  type CadStandardPartSpec,
} from './standard-parts';
import { f153CaseBack, f153Sizes, f154Specs, f154StandardParts } from './standard-parts-fixtures';
import { validateCad } from './validation';

const codes = (doc: unknown) => validateCad(doc).map((d) => `${d.code}@${d.path}`);
const refusal = (spec: CadStandardPartSpec) => {
  try {
    standardPart(spec, fixtureKernel);
  } catch (e) {
    return (e as Error).message;
  }
  return 'made';
};

describe('PD4 standard parts (ST-759, TS-2526)', () => {
  it('makes every F154 part as a valid part version with its number and description', () => {
    const parts = f154StandardParts();
    expect(parts).toHaveLength(f154Specs.length);
    for (const p of parts) {
      expect(codes(p.content), p.designation).toEqual([]);
      expect(p.content.partProperties).toEqual({
        partNumber: p.partNumber,
        description: p.description,
        sourcing: 'standard',
      });
      expect(p.kind).toBe('standard');
      expect(
        p.content.bodies.filter((b) => b.state === 'active'),
        p.designation,
      ).toHaveLength(1);
    }
    expect(parts.map((p) => p.partNumber)).toEqual([
      'WS-M1x2',
      'ISO1207-M1.6x3',
      'JWL-H-0.1-1-0.2',
      'JWL-C-1.2-0.15',
      'SB-16x1.8',
      'BRG-681',
      'ISO4762-M6x20',
      'ISO4762-M8x25',
      'ISO7045-M4x10',
      'ISO8734-6x20',
      'BRG-6204',
      'BRG-6002',
      'BRG-6805',
      'ISO3601-20x2.65',
    ]);
    expect(new Set(parts.map((p) => p.partNumber)).size).toBe(parts.length);
    // ISO sizes say so; the watch parts are not ISO.
    expect(parts.filter((p) => !p.iso).map((p) => p.partNumber)).toEqual([
      'WS-M1x2',
      'JWL-H-0.1-1-0.2',
      'JWL-C-1.2-0.15',
      'SB-16x1.8',
    ]);
  });

  it('replays its operations to the same document', () => {
    const p = standardPart(
      { family: 'screw', standard: 'ISO 4762', size: 'M3', length: 8 },
      fixtureKernel,
    );
    expect(p.operations.at(-2)).toEqual({
      type: 'setPartProperties',
      partNumber: 'ISO4762-M3x8',
      description: 'Hexagon socket head cap screw ISO 4762 M3×8',
    });
    // PD2: the sourcing class is "standard".
    expect(p.operations.at(-1)).toEqual({ type: 'setPartBomProperties', sourcing: 'standard' });
    expect(p.content.partProperties.sourcing).toBe('standard');
    expect(p.dimensions).toMatchObject({ d: 3, dk: 5.5, k: 3, drive: 2.5, t: 1.3, length: 8 });
    // The socket is a cut, so the screw is one body.
    expect(p.content.features.some((f) => f.name === `${p.description} socket cut`)).toBe(true);
  });

  it('keeps the series-02 bearings of DW7c and the boundary sizes of each series', () => {
    for (const [code, dims] of Object.entries(bearingSeries02))
      expect(ballBearings[code]).toEqual(dims);
    expect(ballBearings['608']).toEqual([8, 22, 7]);
    expect(ballBearings['6804']).toEqual([20, 32, 7]);
    expect(ballBearings['6000']).toEqual([10, 26, 8]);
    for (const [code, [d, D]] of Object.entries(ballBearings)) {
      const { ball, pitch, count, innerOuter, outerInner } = bearingBalls(d, D);
      // The balls fit between the races and do not touch each other.
      expect(2 * pitch * Math.sin(Math.PI / count), code).toBeGreaterThan(2 * ball);
      expect(innerOuter).toBeLessThan(outerInner);
      expect(count, code).toBeGreaterThanOrEqual(3);
    }
  });

  it('refuses sizes and lengths it does not keep (TS-2527)', () => {
    expect(refusal({ family: 'screw', standard: 'ISO 4762', size: 'M7', length: 10 })).toBe(
      'standard-size:ISO 4762 M7',
    );
    expect(refusal({ family: 'screw', standard: 'ISO 4762', size: 'M3', length: 7 })).toBe(
      'standard-length:ISO 4762 M3×7',
    );
    expect(refusal({ family: 'screw', standard: 'ISO 4762', size: 'M3', length: 40 })).toBe(
      'standard-length:ISO 4762 M3×40',
    );
    expect(refusal({ family: 'screw', standard: 'ISO 1207', size: 'M1', length: 2 })).toBe(
      'standard-size:ISO 1207 M1',
    );
    expect(refusal({ family: 'o-ring', innerDiameter: 28.5, section: 0.7 })).toBe(
      'standard-size:ISO 3601 section 0.7',
    );
    expect(refusal({ family: 'o-ring', innerDiameter: 21, section: 2.65 })).toBe(
      'standard-size:ISO 3601 21×2.65',
    );
    expect(refusal({ family: 'o-ring', innerDiameter: 28.5, section: 0.7, custom: true })).toBe(
      'made',
    );
    expect(refusal({ family: 'parallel-pin', diameter: 7, length: 20 })).toBe(
      'standard-size:ISO 8734 7',
    );
    expect(refusal({ family: 'parallel-pin', diameter: 3, length: 40 })).toBe(
      'standard-length:ISO 8734 3×40',
    );
    expect(refusal({ family: 'ball-bearing', code: '6213' })).toBe('standard-size:bearing 6213');
    expect(refusal({ family: 'hole-jewel', hole: 0.9, diameter: 1, height: 0.2 })).toBe(
      'standard-size:jewel hole',
    );
    expect(refusal({ family: 'hole-jewel', hole: 0, diameter: 1, height: 0.2 })).toBe(
      'standard-size:jewel hole',
    );
    expect(refusal({ family: 'spring-bar', length: 16, diameter: 1.6 })).toBe(
      'standard-size:spring bar 1.6',
    );
    expect(iso3601InnerDiameters).toContain(20);
    expect(iso4762.M12!.lengths).toEqual([20, 120]);
  });

  it('reads a designation back to the spec that writes it', () => {
    for (const spec of f154Specs) {
      const { designation } = standardPartNames(spec);
      expect(parseStandardDesignation(designation), designation).toEqual(spec);
    }
    expect(parseStandardDesignation('ISO 4762 M3x8')).toEqual({
      family: 'screw',
      standard: 'ISO 4762',
      size: 'M3',
      length: 8,
    });
    expect(parseStandardDesignation('O-ring 28.5×0.7')).toEqual({
      family: 'o-ring',
      innerDiameter: 28.5,
      section: 0.7,
      custom: true,
    });
    expect(parseStandardDesignation('M3 bolt')).toBeUndefined();
  });
});

describe('PD4 O-ring groove (ST-760, TS-2528)', () => {
  it('sizes the gland from squeeze and fill', () => {
    const g = oRingGland({
      kind: 'radial-outer',
      ring: { innerDiameter: 20, section: 2.65 },
      diameter: 25,
    });
    expect(g.depth).toBeCloseTo(2.12, 6);
    // The ring's section is 0.8 of the groove's.
    expect((Math.PI * 2.65 ** 2) / 4 / (g.depth * g.width)).toBeCloseTo(0.8, 9);
    expect(g.inner).toBeCloseTo(20.76, 6);
    expect(g.stretch).toBeCloseTo(0.038, 6);
    expect(g.warnings).toEqual([]);
    // A ring too small for the shaft is stretched past the rule of thumb.
    expect(
      oRingGland({ kind: 'radial-outer', ring: { innerDiameter: 18, section: 2.65 }, diameter: 25 })
        .warnings,
    ).toEqual(['stretch']);
    const face = oRingGland({
      kind: 'axial',
      ring: { innerDiameter: 20, section: 2.65 },
      diameter: 25.3,
    });
    expect(face.depth).toBeCloseTo(2.65 * 0.75, 9);
    expect(face.outer - face.inner).toBeCloseTo(2 * face.width, 9);
    const bore = oRingGland({
      kind: 'radial-inner',
      ring: { innerDiameter: 20, section: 2.65 },
      diameter: 20,
    });
    expect(bore.inner).toBe(20);
    expect(bore.outer).toBeCloseTo(24.24, 6);
    expect(() =>
      oRingGland({
        kind: 'axial',
        ring: { innerDiameter: 20, section: 2.65 },
        diameter: 25,
        squeeze: 0.6,
      }),
    ).toThrow('o-ring-gland');
  });

  it('cuts F153: the case back with its gasket groove, and the gasket', () => {
    const { back, gland, gasket } = f153CaseBack();
    expect(codes(back)).toEqual([]);
    expect(codes(gasket.content)).toEqual([]);
    expect(back.bodies.filter((b) => b.state === 'active')).toHaveLength(1);
    expect(back.features.find((f) => f.id === gland.featureId)?.name).toBe('Gasket groove cut');
    expect(gland.inner).toBeCloseTo(f153Sizes.bore - 2 * 0.56, 9);
    expect(gland.warnings).toEqual([]);
    // The groove lies inside the spigot's height.
    expect(gland.width).toBeLessThan(f153Sizes.spigotHeight);
    expect(gasket.partNumber).toBe('OR-28.5x0.7');
  });

  it('cuts a face groove about a turned axis with ordinary features', () => {
    const b = cadBuilder(fixtureKernel);
    const plate = b.box('Cover', { size: [40, 40, 5], origin: [-20, -20, 0] });
    // The axis +Z turned to +X: the face is the box's +X side.
    const g = oRingGroove(b, plate, {
      kind: 'axial',
      ring: { innerDiameter: 20, section: 2.65 },
      diameter: 25.3,
      z: 20,
      origin: [0, 0, 2.5],
      orientation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
    });
    const doc = b.build().document;
    expect(codes(doc)).toEqual([]);
    const cut = doc.features.find((f) => f.id === g.featureId);
    expect(cut?.type).toBe('boolean');
    expect(doc.features.filter((f) => f.type === 'revolve')).toHaveLength(1);
  });
});
