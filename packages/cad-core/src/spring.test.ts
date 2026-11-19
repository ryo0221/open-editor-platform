import { describe, expect, it } from 'vitest';
import { cadBuilder } from './builder';
import { measureDesignTargets, springQuantity } from './design-targets';
import { fixtureKernel } from './fixtures';
import { parameterValues } from './graph';
import type { CadDocument } from './model';
import { applyCadOperation } from './operations';
import { sk01Movement } from './sk01';
import { sketchRegion } from './sketch';
import {
  coilSpringPath,
  resolveSpring,
  spiralSpringSketch,
  spiralStripLength,
  springEstimate,
  springProblem,
  trainHoursPerTurn,
  type CadSpringArgs,
  type CoilSpringSpec,
  type SpiralSpringSpec,
} from './spring';
import { f155Springs, springSteel } from './spring-fixtures';
import { validateCad } from './validation';

// PD5 (docs/cad/product-design.md, PD5 ばね). ST-763..765, TS-2536..2542.
const codes = (doc: unknown) => validateCad(doc).map((d) => `${d.code}@${d.path}`);
const coil = (o: Partial<CoilSpringSpec> = {}): CoilSpringSpec => ({
  form: 'coil',
  use: 'compression',
  wireDiameter: 1,
  meanDiameter: 8,
  pitch: 2,
  coils: 8,
  activeCoils: 6,
  hand: 'right',
  youngsModulusMpa: 206_000,
  shearModulusMpa: 79_000,
  ...o,
});
const spiral = (o: Partial<SpiralSpringSpec> = {}): SpiralSpringSpec => ({
  form: 'spiral',
  use: 'mainspring',
  thickness: 0.1,
  height: 0.55,
  innerRadius: 1.8,
  pitch: 0.24,
  turns: 13,
  youngsModulusMpa: 206_000,
  ...o,
});
/** One spring feature in a document, its args edited by `edit`. */
const withSpring = (
  edit: (a: Record<string, unknown>) => void,
  form: 'coil' | 'spiral' = 'coil',
) => {
  const b = cadBuilder(fixtureKernel);
  if (form === 'coil')
    b.coilSpring('S', {
      use: 'compression',
      wireDiameter: 1,
      meanDiameter: 8,
      pitch: 2,
      coils: 8,
      material: springSteel,
    });
  else
    b.spiralSpring('S', {
      use: 'mainspring',
      thickness: 0.1,
      height: 0.55,
      innerRadius: 1.8,
      pitch: 0.24,
      turns: 13,
      material: { youngsModulusMpa: 206_000 },
      barrel: { innerRadius: 5.1, arborRadius: 1.6 },
    });
  const doc = structuredClone(b.document);
  edit(doc.features.find((f) => f.type === 'spring')!.args as unknown as Record<string, unknown>);
  return doc;
};
const at = (path: string) => `$.features[0].args${path}`;

describe('PD5 spring shape and validation (ST-763)', () => {
  it('validates coil and spiral springs and refuses what cannot be a spring (TS-2536)', () => {
    expect(codes(withSpring(() => {}))).toEqual([]);
    expect(codes(withSpring(() => {}, 'spiral'))).toEqual([]);
    const refused: [(a: Record<string, unknown>) => void, string, ('coil' | 'spiral')?][] = [
      [(a) => (a.form = 'leaf'), `spring-form@${at('.form')}`],
      [(a) => (a.use = 'mainspring'), `spring-use@${at('.use')}`],
      [(a) => (a.meanDiameter = { literalMm: 1.5 }), `spring-index@${at('.meanDiameter')}`],
      [(a) => (a.pitch = { literalMm: 1 }), `spring-coils-touch@${at('.pitch')}`],
      [(a) => (a.activeCoils = 9), `spring-active-coils@${at('.activeCoils')}`],
      [(a) => (a.activeCoils = 0), `spring-active-coils@${at('.activeCoils')}`],
      [(a) => (a.coils = 0.5), `spring-coils@${at('.coils')}`],
      [(a) => (a.hand = 'up'), `spring-hand@${at('.hand')}`],
      [
        (a) => (a.material = { youngsModulusMpa: 206_000 }),
        `spring-modulus@${at('.material.shearModulusMpa')}`,
      ],
      [
        (a) => (a.material = { youngsModulusMpa: 1, shearModulusMpa: 79_000 }),
        `spring-modulus@${at('.material.youngsModulusMpa')}`,
      ],
      // Free length 17 mm, solid 9 mm: 8 mm reaches solid.
      [(a) => (a.deflection = { literalMm: 8 }), `spring-deflection-solid@${at('.deflection')}`],
      [(a) => (a.angle = { literalRad: 1 }), `unknown-field@${at('.angle')}`],
      [(a) => (a.initialTensionN = 1), `unknown-field@${at('.initialTensionN')}`],
      [(a) => (a.pitch = { literalMm: 0.101 }), `spring-coils-touch@${at('.pitch')}`, 'spiral'],
      [(a) => (a.turns = 31), `spring-turns@${at('.turns')}`, 'spiral'],
      [
        (a) => (a.barrel = { innerRadius: { literalMm: 2 }, arborRadius: { literalMm: 3 } }),
        `spring-barrel@${at('.barrel.arborRadius')}`,
        'spiral',
      ],
      // 278 mm of 0.1 mm strip needs more than a 3.3 mm drum around a 1.6 mm arbor.
      [
        (a) => (a.barrel = { innerRadius: { literalMm: 3.3 }, arborRadius: { literalMm: 1.6 } }),
        `spring-barrel-full@${at('.barrel.innerRadius')}`,
        'spiral',
      ],
      [
        (a) =>
          (a.barrel = {
            innerRadius: { literalMm: 5.1 },
            arborRadius: { literalMm: 1.6 },
            hoursPerTurn: 0,
          }),
        `spring-hours-per-turn@${at('.barrel.hoursPerTurn')}`,
        'spiral',
      ],
      [
        (a) => {
          a.use = 'hairspring';
        },
        `unknown-field@${at('.barrel')}`,
        'spiral',
      ],
      [(a) => (a.angle = { literalRad: -1 }), `spring-angle@${at('.angle')}`, 'spiral'],
      [(a) => (a.angle = { literalRad: 201 * Math.PI }), `spring-angle@${at('.angle')}`, 'spiral'],
      [(a) => (a.deflection = { literalMm: 1 }), `unknown-field@${at('.deflection')}`, 'spiral'],
    ];
    for (const [edit, code, form] of refused) expect(codes(withSpring(edit, form))).toContain(code);
    // A torsion coil needs no shear modulus (and may not carry one) but may have a working angle.
    expect(
      codes(
        withSpring((a) => {
          a.use = 'torsion';
          a.material = { youngsModulusMpa: 206_000 };
          a.angle = { literalRad: Math.PI / 2 };
        }),
      ),
    ).toEqual([]);
    // A mainspring without a barrel wound two turns from rest.
    expect(
      codes(
        withSpring((a) => {
          delete a.barrel;
          a.angle = { literalRad: 4 * Math.PI };
        }, 'spiral'),
      ),
    ).toEqual([]);
  });

  it('draws the helix and the spiral close to their exact curves (TS-2537)', () => {
    for (const s of [coil(), coil({ hand: 'left', coils: 5.3, pitch: 1.2 })]) {
      const path = coilSpringPath(s);
      const R = s.meanDiameter / 2;
      const hand = s.hand === 'right' ? 1 : -1;
      // Piece ends lie on the helix; points between stay within 3e-4·R across and 1e-3·pitch along.
      const pieces = path.knots.length - 1;
      expect(path.poles).toHaveLength(3 * pieces + 1);
      const bezier = (i: number, u: number) => {
        const [p0, p1, p2, p3] = path.poles.slice(3 * i, 3 * i + 4);
        const w = [(1 - u) ** 3, 3 * u * (1 - u) ** 2, 3 * u * u * (1 - u), u ** 3];
        return [0, 1, 2].map(
          (k) => w[0]! * p0![k]! + w[1]! * p1![k]! + w[2]! * p2![k]! + w[3]! * p3![k]!,
        );
      };
      let worst = 0;
      for (let i = 0; i < pieces; i++)
        for (let u = 0; u <= 1; u += 0.05) {
          const [x, y, z] = bezier(i, u);
          // The angle turned, unwrapped near the piece's start (quarter turns).
          const base = (i * Math.PI) / 2;
          const raw = Math.atan2(hand * y!, x!) - base;
          const t = base + Math.atan2(Math.sin(raw), Math.cos(raw));
          worst = Math.max(worst, Math.abs(Math.hypot(x!, y!) - R));
          const exact = s.wireDiameter / 2 + (s.pitch * t) / (2 * Math.PI);
          expect(Math.abs(z! - exact)).toBeLessThan(1e-3 * s.pitch);
        }
      expect(worst).toBeLessThan(3e-4 * R);
      expect(path.poles.at(-1)![2]).toBeCloseTo(s.wireDiameter / 2 + s.pitch * s.coils, 9);
      // The start tangent leans by the helix angle and turns the way of the hand.
      expect(path.tangent[1] * hand).toBeGreaterThan(0);
      expect(path.tangent[2]).toBeCloseTo(
        s.pitch / Math.hypot(Math.PI * s.meanDiameter, s.pitch),
        9,
      );
    }
    for (const s of [spiral(), spiral({ turns: 0.5 }), spiral({ turns: 30, pitch: 0.3 })]) {
      const { sketch, region } = spiralSpringSketch(s);
      expect('code' in sketchRegion(sketch, region)).toBe(false);
      // The strip is t thick at every piece end.
      const r = (id: string) => Math.hypot(...sketch.solved[id]!);
      const n = Math.ceil(s.turns * 8);
      for (let i = 0; i <= n; i++)
        expect(r(`outerp${i}`) - r(`innerp${i}`)).toBeCloseTo(s.thickness, 9);
      expect(region.outer).toHaveLength(2 * n + 2);
    }
    // The strip length against a fine polygon of the centre line.
    const s = spiral();
    let poly = 0;
    const N = 200_000;
    let prev = [s.innerRadius + s.thickness / 2, 0];
    for (let i = 1; i <= N; i++) {
      const t = (2 * Math.PI * s.turns * i) / N;
      const rr = s.innerRadius + s.thickness / 2 + (s.pitch * t) / (2 * Math.PI);
      const p = [rr * Math.cos(t), rr * Math.sin(t)];
      poly += Math.hypot(p[0]! - prev[0]!, p[1]! - prev[1]!);
      prev = p;
    }
    expect(spiralStripLength(s)).toBeCloseTo(poly, 4);
  });
});

describe('PD5 spring estimates (ST-764)', () => {
  it('gives the textbook rate, force, torque and stress (TS-2538)', () => {
    // Compression: k = G d⁴ / (8 D³ n) = 79000 / (8 · 512 · 6) N/mm; C = 8.
    const c = springEstimate(coil({ deflection: 3 }));
    expect(c.rate).toBeCloseTo(79_000 / 24_576, 12);
    expect(c.rateUnit).toBe('N/mm');
    const Kw = (4 * 8 - 1) / (4 * 8 - 4) + 0.615 / 8;
    expect(c.stressFactor).toBeCloseTo(Kw, 12);
    expect(c.working!.forceN).toBeCloseTo(3 * c.rate, 12);
    expect(c.working!.stressMpa).toBeCloseTo((Kw * 8 * c.working!.forceN! * 8) / Math.PI, 9);
    expect(c.freeLengthMm).toBe(17);
    expect(c.solidLengthMm).toBe(9);
    expect(c.maxDeflectionMm).toBe(8);
    expect(c.solid!.forceN).toBeCloseTo(8 * c.rate, 12);
    // Extension: the initial tension adds to the force; no solid length.
    const x = springEstimate(coil({ use: 'extension', deflection: 2, initialTensionN: 1.5 }));
    expect(x.working!.forceN).toBeCloseTo(1.5 + 2 * x.rate, 12);
    expect(x.solid).toBeUndefined();
    // Torsion: k = E d⁴ / (64 D n) per radian; σ = K_i · 32 M / (π d³).
    const t = springEstimate(
      coil({ use: 'torsion', shearModulusMpa: undefined, angle: Math.PI / 2 }),
    );
    expect(t.rate).toBeCloseTo(206_000 / (64 * 8 * 6), 12);
    expect(t.rateUnit).toBe('N·mm/rad');
    const Ki = (4 * 64 - 8 - 1) / (4 * 8 * 7);
    expect(t.working!.torqueNmm).toBeCloseTo((t.rate * Math.PI) / 2, 12);
    expect(t.working!.stressMpa).toBeCloseTo((Ki * 32 * t.working!.torqueNmm!) / Math.PI, 9);
    // Spiral: k = E b t³ / (12 L); σ = 6 M / (b t²).
    const h = spiral({
      use: 'hairspring',
      thickness: 0.03,
      height: 0.2,
      innerRadius: 0.5,
      pitch: 0.1,
      turns: 12,
      angle: 1,
    });
    const e = springEstimate(h);
    const L = spiralStripLength(h);
    expect(e.rate).toBeCloseTo((206_000 * 0.2 * 0.03 ** 3) / (12 * L), 15);
    expect(e.working!.stressMpa).toBeCloseTo((6 * e.rate) / (0.2 * 0.03 ** 2), 9);
    expect(e.barrel).toBeUndefined();
  });

  it('turns a mainspring in its barrel and times it by the train: SK-01 runs 65 h (TS-2539)', () => {
    // SK-01's train: centre pinion 10 → barrel 80, so a barrel turn is 8 centre-wheel hours.
    const { assembly } = sk01Movement();
    expect(trainHoursPerTurn(assembly, 'j-barrel', 'j-centre')).toBeCloseTo(8, 12);
    expect(trainHoursPerTurn(assembly, 'j-centre', 'j-barrel')).toBeCloseTo(1 / 8, 12);
    expect(trainHoursPerTurn(assembly, 'j-barrel', 'j-balance')).toBeUndefined();
    // Two followers of one driver are joined through it (barrel = driver / 8, reference = driver).
    const shared = {
      joints: [
        { id: 'drv' },
        {
          id: 'bar',
          couplings: [
            { of: 'angle', from: { joint: 'drv', of: 'angle' }, ratio: 1 / 8, offset: 0 },
          ],
        },
        {
          id: 'ref',
          couplings: [{ of: 'angle', from: { joint: 'drv', of: 'angle' }, ratio: -1, offset: 0 }],
        },
      ],
    } as unknown as Parameters<typeof trainHoursPerTurn>[0];
    expect(trainHoursPerTurn(shared, 'bar', 'ref')).toBeCloseTo(8, 12);
    expect(trainHoursPerTurn(shared, 'ref', 'bar')).toBeCloseTo(1 / 8, 12);
    const s = spiral({ barrel: { innerRadius: 5.1, arborRadius: 1.6 } });
    const L = spiralStripLength(s);
    const a = (L * 0.1) / Math.PI;
    const wound = (Math.sqrt(1.6 ** 2 + a) - 1.6) / 0.1;
    const down = (5.1 - Math.sqrt(5.1 ** 2 - a)) / 0.1;
    const e = springEstimate(s, trainHoursPerTurn(assembly, 'j-barrel', 'j-centre'));
    expect(e.barrel!.woundTurns).toBeCloseTo(wound, 12);
    expect(e.barrel!.letDownTurns).toBeCloseTo(down, 12);
    expect(e.barrel!.usableTurns).toBeCloseTo(wound - down, 12);
    expect(e.barrel!.usableTurns).toBeCloseTo(8.21, 2);
    expect(e.barrel!.runHours).toBeCloseTo(8 * (wound - down), 9);
    expect(e.barrel!.runHours).toBeGreaterThan(40);
    expect(e.barrel!.fullTorqueNmm).toBeCloseTo(e.rate * 2 * Math.PI * (wound - down), 12);
    // Without the hours, no running time.
    expect(springEstimate(s).barrel!.runHours).toBeUndefined();
    expect(springQuantity(springEstimate(s), 'runHours')).toBeUndefined();
  });
});

describe('PD5 spring targets (ST-765)', () => {
  it('reads a spring value as a design target, unknown when it has none, pruned with it (TS-2541)', () => {
    const doc = f155Springs();
    const main = doc.features.find((f) => f.name === 'Mainspring')!.id;
    const crown = doc.features.find((f) => f.name === 'Crown spring')!;
    // Units follow the quantity (and the spring's use for a rate).
    const units = (d: CadDocument) => measureDesignTargets(d, {}).map((r) => r.unit);
    expect(units(doc)).toEqual(['h', 'MPa', 'N·mm/rad', 'N']);
    const odd: CadDocument = {
      ...doc,
      designTargets: [
        {
          id: 'x',
          name: 'Hours of the coil',
          measure: { kind: 'spring', featureId: crown.id, quantity: 'runHours' },
          min: 1,
        },
        {
          id: 'y',
          name: 'Rate of the coil',
          measure: { kind: 'spring', featureId: crown.id, quantity: 'rate' },
          min: 1,
        },
      ],
    };
    expect(codes(odd)).toEqual([]);
    expect(measureDesignTargets(odd, {})).toEqual([
      { id: 'x', unit: 'h', status: 'unknown', reason: 'design-spring-quantity' },
      { id: 'y', unit: 'N/mm', value: expect.closeTo(0.964, 3), status: 'fail' },
    ]);
    // A spring that no longer gives a spring (edited outside validation) is unknown, not a pass.
    const broken = structuredClone(odd);
    const args = broken.features.find((f) => f.id === crown.id)!.args as CadSpringArgs & {
      pitch: unknown;
    };
    args.pitch = { literalMm: 0.1 };
    expect(measureDesignTargets(broken, {})[1]).toMatchObject({
      status: 'unknown',
      reason: 'design-spring-invalid',
    });
    // Refused: a target on a feature that is not a spring, or an unknown quantity.
    const bad = structuredClone(doc);
    bad.designTargets![0]!.measure = { kind: 'spring', featureId: 'nope', quantity: 'rate' };
    bad.designTargets![1]!.measure = {
      kind: 'spring',
      featureId: main,
      quantity: 'lifeCycles' as never,
    };
    expect(codes(bad)).toEqual([
      'design-target-spring@$.designTargets[0].measure.featureId',
      'design-target-spring-quantity@$.designTargets[1].measure.quantity',
    ]);
    // Deleting the crown spring's feature (and its body) takes its target with it.
    const gone = applyCadOperation(doc, { type: 'deleteClosure', ids: [crown.id], cascade: true });
    expect(gone.designTargets?.map((t) => t.id)).toEqual([
      'power-reserve',
      'mainspring-stress',
      'hairspring-rate',
    ]);
    expect(codes(gone)).toEqual([]);
  });

  it('F155 validates and its spring targets pass without an evaluation (TS-2542)', () => {
    const doc = f155Springs();
    expect(codes(doc)).toEqual([]);
    const values = parameterValues(doc);
    for (const f of doc.features)
      if (f.type === 'spring') expect(springProblem(resolveSpring(f.args, values))).toBeUndefined();
    const r = measureDesignTargets(doc, {});
    expect(r.map((x) => [x.id, x.status])).toEqual([
      ['power-reserve', 'pass'],
      ['mainspring-stress', 'pass'],
      ['hairspring-rate', 'pass'],
      ['crown-force', 'pass'],
    ]);
    expect(r[0]!.value).toBeCloseTo(65.7, 1);
  });
});
