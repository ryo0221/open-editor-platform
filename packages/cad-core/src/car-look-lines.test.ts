import { describe, expect, it } from 'vitest';
import { f83Air } from './car-look-air';
import {
  f84At,
  f84BlockFront,
  f84Colors,
  f84Curve,
  f84Notes,
  f84Package,
  f84Variants,
  f140Package,
  f140Variant,
  type F84Variant,
} from './car-look-lines';
import { f141Variant } from './car-look-skin';
import { validateCad } from './validation';
import { f82OccupantBoxes, f82Rules } from './car-look-package';

type V2 = readonly [number, number];

/** The envelope's top above x, along the closed side envelope. */
function envelopeTop(x: number): number {
  const poly = f82Rules.side;
  let best = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    if ((a[0] - x) * (b[0] - x) > 0 || a[0] === b[0]) continue;
    best = Math.max(best, a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]));
  }
  return best;
}
const r = f82Rules;
const front = -r.overhang.front;
const tail = r.wheelbase + r.overhang.rear;
const range = (a: number, b: number, step = 10) =>
  Array.from({ length: Math.floor((b - a) / step) + 1 }, (_, k) => a + k * step);
const span = (c: readonly V2[]) => [
  Math.min(...c.map((p) => p[0])),
  Math.max(...c.map((p) => p[0])),
];

describe('F84: three variants of 「翔」’s lines (CL4, TS-2014)', () => {
  const head = f82OccupantBoxes(r.hPoint).head;
  const headOut = head[1][1];
  // F140 (CL5) is C corrected: it keeps every CL4 rule.
  const checked: [F84Variant, string][] = [
    ...f84Variants.map((x) => [x, ''] as [F84Variant, string]),
    [f140Variant, 'F140 '],
    [f141Variant, 'F141 '],
  ];
  for (const [v, label] of checked)
    describe(`${label}${v.id} ${v.name}`, () => {
      const profile = f84Curve(v.side.profile);
      const outline = f84Curve(v.plan.outline);

      it('keeps CL1’s length and height and stays on or outside the side envelope', () => {
        expect(v.side.profile[0]![0]).toBe(front);
        expect(v.side.profile.at(-1)![0]).toBe(tail);
        const top = Math.max(...profile.map((p) => p[1]));
        expect(top).toBeLessThanOrEqual(r.height + 1);
        expect(top).toBeGreaterThanOrEqual(r.height - 5);
        for (const x of range(front, tail))
          expect(f84At(profile, x)!, `x ${x}`).toBeGreaterThanOrEqual(envelopeTop(x) - 1);
        // The tail's face from the profile's end down to the diffuser's top.
        expect(v.side.tail[0]).toEqual(v.side.profile.at(-1));
        expect(v.side.tail.at(-1)![1]).toBeLessThanOrEqual(f83Air.tunnel.roofExit);
      });

      it('keeps CL1’s width, the tyres 0–20 mm inside the fenders and room for the radiators', () => {
        expect(v.plan.outline[0]![0]).toBe(front);
        expect(v.plan.outline.at(-1)![0]).toBe(tail);
        expect(Math.max(...outline.map((p) => p[1]))).toBeLessThanOrEqual(r.width / 2 + 1);
        for (const [x, tyre, track] of [
          [0, r.tyre.front, r.track.front],
          [r.wheelbase, r.tyre.rear, r.track.rear],
        ] as const) {
          const cover = f84At(outline, x)! - (track / 2 + tyre.width / 2);
          expect(cover, `axle ${x}`).toBeGreaterThanOrEqual(0);
          expect(cover, `axle ${x}`).toBeLessThanOrEqual(20);
        }
        // 30 mm of skin and duct outside the radiators.
        const [lo, hi] = r.boxes.radiatorRight!;
        for (const x of range(lo[0]!, hi[0]!))
          expect(f84At(outline, x)!, `x ${x}`).toBeGreaterThanOrEqual(hi[1]! + 30);
        // The side intake opens at the body's side: the outline there reaches the intake.
        const intake = f83Air.openings.find((o) => o.id === 'side-intake')!;
        expect(f84At(outline, intake.x[0])!).toBeGreaterThanOrEqual(intake.y[0]);
      });

      it('holds the heads under the glass and the roof, with a beltline the driver sees over', () => {
        const glass = f84Curve(v.plan.greenhouse);
        const roof = f84Curve(v.plan.roof);
        for (const x of range(head[0][0], head[1][0])) {
          expect(f84At(glass, x)!, `glass at ${x}`).toBeGreaterThanOrEqual(headOut + 40);
          expect(f84At(outline, x)!).toBeGreaterThan(f84At(glass, x)!);
        }
        expect(Math.min(...roof.map((p) => p[1]))).toBeGreaterThanOrEqual(headOut + 30);
        // The belt at the eye: below the eye, high enough to sit in the car (650–900 mm).
        const eyeX = r.hPoint.x + 90;
        const belt = f84At(f84Curve(v.side.belt), eyeX)!;
        expect(belt).toBeGreaterThanOrEqual(650);
        expect(belt).toBeLessThanOrEqual(900);
        // The glass's top under the profile, its ends on the belt.
        const dlo = f84Curve(v.side.dlo);
        for (const [x, z] of dlo)
          expect(z, `dlo at ${x}`).toBeLessThanOrEqual(f84At(profile, x)! + 1e-6);
        expect(Math.abs(v.side.dlo.at(-1)![0] - v.side.belt.at(-1)![0])).toBeLessThanOrEqual(10);
        expect(Math.abs(v.side.dlo[0]![0] - v.side.belt[0]![0])).toBeLessThanOrEqual(10);
      });

      it('leaves the side intake between the rocker and the shoulder, and the rocker above the floor', () => {
        const intake = f83Air.openings.find((o) => o.id === 'side-intake')!;
        const shoulder = f84Curve(v.side.shoulder);
        const rocker = f84Curve(v.side.rocker);
        const [r0, r1] = span(rocker);
        for (const x of range(intake.x[0], intake.x[1])) {
          expect(f84At(shoulder, x)!, `shoulder at ${x}`).toBeGreaterThanOrEqual(intake.z[1]);
          if (x >= r0! && x <= r1!)
            expect(f84At(rocker, x)!, `rocker at ${x}`).toBeLessThanOrEqual(intake.z[0]);
        }
        for (const [, z] of rocker) expect(z).toBeGreaterThanOrEqual(r.floor + 20);
        // The shoulder under the profile; F141's front fenders stand up to 40 mm over the hood's
        // centre between them (CL6c), so over the front wheel its silhouette is the fender's.
        const over = (x: number) => (v === f141Variant && x > -400 && x < 600 ? 40 : 0);
        for (const [x, z] of shoulder)
          expect(z, `shoulder at ${x}`).toBeLessThanOrEqual(f84At(profile, x)! + over(x) + 1e-6);
      });

      it('draws the front within the width and over the heads, the glass leaning in', () => {
        const body = f84Curve(v.front.body);
        const glass = f84Curve(v.front.greenhouse);
        expect(Math.max(...body.map((p) => p[0]))).toBeLessThanOrEqual(r.width / 2 + 1);
        // The glass at the head's top wider than the head, and its top at the roof.
        const at = glass.find(
          (p, k) =>
            k + 1 < glass.length &&
            p[1] <= r.hPoint.z + 736 &&
            glass[k + 1]![1] >= r.hPoint.z + 736,
        );
        expect(at && at[0]).toBeGreaterThanOrEqual(headOut + 30);
        expect(Math.max(...glass.map((p) => p[1]))).toBeCloseTo(r.height, 0);
        // Tumblehome: the side glass leans inwards, 10–30° from upright.
        const [a, b] = [v.front.greenhouse[0]!, v.front.greenhouse[1]!];
        const lean = (Math.atan2(a[0] - b[0], b[1] - a[1]) * 180) / Math.PI;
        expect(lean).toBeGreaterThanOrEqual(10);
        expect(lean).toBeLessThanOrEqual(30);
      });

      it('is F83 with the three line sketches', () => {
        const doc = f84Package(v);
        expect(doc.sketches.map((s) => s.id).slice(-3)).toEqual([
          `lines-${v.id}-side`,
          `lines-${v.id}-plan`,
          `lines-${v.id}-front`,
        ]);
        expect(doc.bodies).toHaveLength(18);
        // Each line in its kind's colour (CLF9).
        const lines = doc.sketches.find((x) => x.id === `lines-${v.id}-side`)!;
        const color = (id: string) =>
          (lines.entities.find((e) => e.id === id) as { color?: string }).color;
        expect(color('profile')).toBe(f84Colors.outline);
        expect(color('belt')).toBe(f84Colors.glass);
        expect(color('shoulder')).toBe(f84Colors.shoulder);
        expect(color('rocker')).toBe(f84Colors.rocker);
        // The name, idea and numbers as notes (CLF10), on each view's sketch.
        expect(lines.notes!.map((n) => n.text)).toEqual(f84Notes(v).side.map((n) => n.text));
        expect(lines.notes![0]!.text).toBe(`案${v.id} ${v.name}`);
        expect(lines.notes![2]!.text).toContain('全長 4,350');
        for (const view of ['plan', 'front'])
          expect(doc.sketches.find((x) => x.id === `lines-${v.id}-${view}`)!.notes).toHaveLength(1);
        expect(validateCad(doc)).toEqual([]);
      });
    });

  it('makes three different cars', () => {
    // The plan's narrowest between the axles: the slab A, the waisted B and C.
    const waist = f84Variants.map((v) => {
      const o = f84Curve(v.plan.outline);
      return Math.min(...range(300, 2300).map((x) => f84At(o, x)!));
    });
    expect(waist[0]).toBeGreaterThan(waist[1]!);
    expect(waist[1]).toBeGreaterThan(waist[2]!);
  });
});

describe('F84 blocks: each variant’s outlines pushed through and kept in common (CL4, TS-2015)', () => {
  for (const v of f84Variants)
    it(`${v.id}: three closed outlines, three pushes and one common body`, () => {
      const doc = f84Package(v.id, undefined, true);
      const ids = doc.sketches.map((s) => s.id).slice(-3);
      expect(ids).toEqual([`block-${v.id}-side`, `block-${v.id}-plan`, `block-${v.id}-front`]);
      const common = doc.features.find((f) => f.id === `block-${v.id}`)!;
      expect(common.type).toBe('boolean');
      expect(common.inputFeatureIds).toEqual([
        `block-${v.id}-side-plan`,
        `block-${v.id}-front-push`,
      ]);
      const first = doc.features.find((f) => f.id === `block-${v.id}-side-plan`)!;
      expect(first.inputFeatureIds).toEqual([`block-${v.id}-side-push`, `block-${v.id}-plan-push`]);
      expect(doc.kernelProfile.maxResultLinearToleranceMm).toBe(0.01);
      expect(doc.bodies.at(-1)!.name).toBe(`Block ${v.id}`);
      // The pushed front is wider than the plan and higher than the side, so the block keeps
      // the plan's width (the rear tyres covered) and the side's height.
      const f = f84BlockFront(v);
      const front = [...f84Curve(f.body), ...f84Curve(f.greenhouse)];
      const plan = Math.max(...f84Curve(v.plan.outline).map((p) => p[1]));
      const side = Math.max(...f84Curve(v.side.profile).map((p) => p[1]));
      expect(Math.max(...front.map((p) => p[0]))).toBeGreaterThanOrEqual(plan + 10);
      expect(Math.max(...front.map((p) => p[1]))).toBeGreaterThanOrEqual(side + 10);
      expect(plan).toBeGreaterThanOrEqual(r.track.rear / 2 + r.tyre.rear.width / 2);
      // The front loop and the front lines run on both sides of the centre, above the ground
      // (#1227 review: mirrored across z, half the block was cut away).
      for (const id of [`block-${v.id}-front`, `lines-${v.id}-front`]) {
        const pts = Object.values(doc.sketches.find((x) => x.id === id)!.solved);
        expect(Math.min(...pts.map((p) => p[0])), id).toBeLessThan(-900);
        expect(Math.max(...pts.map((p) => p[0])), id).toBeGreaterThan(900);
        expect(Math.min(...pts.map((p) => p[1])), id).toBeGreaterThan(0);
      }
      // The front loop reaches below the side's floor, so the block keeps the side's bottom.
      const sideFloor = Math.min(
        ...Object.values(doc.sketches.find((x) => x.id === `block-${v.id}-side`)!.solved).map(
          (p) => p[1],
        ),
      );
      const frontFloor = Math.min(
        ...Object.values(doc.sketches.find((x) => x.id === `block-${v.id}-front`)!.solved).map(
          (p) => p[1],
        ),
      );
      expect(frontFloor).toBeLessThan(sideFloor);
    });
});

describe('F140: 「Canopy」 with its glass and proportion setup (CL5, TS-2022)', () => {
  it('adds the glass body and the setup on the four wheels, the block and the glass', () => {
    const doc = f140Package();
    expect(doc.bodies.at(-1)!.name).toBe('Glass C');
    expect(doc.proportions!.body).toEqual(['block-C-body']);
    expect(doc.proportions!.windows).toEqual(['glass-C-body']);
    expect(doc.proportions!.frontWheels).toHaveLength(2);
    expect(validateCad(doc)).toEqual([]);
  });
});
