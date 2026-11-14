import { describe, expect, it } from 'vitest';
import { featureSketches } from './graph';
import { f81TwoView } from './fixtures';
import type { CadDocument } from './model';
import { curveBoundaryName, remapTopoName } from './topology';
import { validateCad } from './validation';

const codes = (doc: unknown) => validateCad(doc).map((d) => `${d.code}@${d.path}`);
type Loose = Record<string, unknown> & { features: Record<string, unknown>[] };
type Curve = Record<string, unknown>;
const changed = (doc: CadDocument, change: (u: Curve[]) => void) => {
  const out = structuredClone(doc) as unknown as Loose;
  change((out.features[0]!.args as { u: Curve[] }).u);
  return out;
};
const at = '$.features[0].args.u';

// CLF2 (docs/cad/car-look-process.md, CLF1〜CLF3の分け方). ST-500, TS-2000.
describe('two-view curves (CLF2)', () => {
  it('admits F81: each u curve a side arc and a plan line, reading both sketches', () => {
    const doc = f81TwoView();
    expect(codes(doc)).toEqual([]);
    expect(featureSketches(doc.features[0]!)).toEqual(
      expect.arrayContaining(['u0', 'u1', 'u2', 'v0', 'v1', 'v2', 'plan']),
    );
    // The refusals the kernel makes are not validation's: F81's variants all validate.
    for (const kind of ['plane', 'apart', 'fold'] as const)
      expect(codes(f81TwoView(kind))).toEqual([]);
  });

  it('refuses a malformed two-view curve, one sketch for both views and a curve used twice', () => {
    const doc = f81TwoView();
    const view = (u: Curve[], i: number) => u[i]!.twoView as Record<string, Curve>;
    expect(codes(changed(doc, (u) => void delete view(u, 0).plan))).toEqual([
      `missing-field@${at}[0].twoView.plan`,
    ]);
    expect(codes(changed(doc, (u) => void (u[0]!.twoView = 'belt')))).toEqual([
      `two-view-curve@${at}[0].twoView`,
    ]);
    expect(codes(changed(doc, (u) => void (u[0]!.extra = 1)))).toEqual([
      `unknown-field@${at}[0].extra`,
    ]);
    expect(codes(changed(doc, (u) => void (view(u, 0).plan!.sketchId = 'ghost')))).toEqual([
      `sketch-missing@${at}[0].twoView.plan.sketchId`,
    ]);
    expect(codes(changed(doc, (u) => void (view(u, 1).side!.element = 'o')))).toEqual([
      `boundary-curve@${at}[1].twoView.side.element`,
    ]);
    expect(
      codes(changed(doc, (u) => void (view(u, 0).plan = { sketchId: 'u0', element: 'arc' }))),
    ).toEqual([`two-view-same-sketch@${at}[0].twoView.plan.sketchId`]);
    expect(codes(changed(doc, (u) => void (u[2] = structuredClone(u[0]!))))).toEqual([
      `boundary-curve-duplicate@${at}[2]`,
    ]);
  });

  it('names the boundary by both elements, and remaps both sketches', () => {
    const source = {
      twoView: {
        side: { sketchId: 'side', element: 'belt' },
        plan: { sketchId: 'top', element: 'shoulder' },
      },
    };
    const name = curveBoundaryName(source);
    expect(name).toEqual(['sketch:side', 'sketch:top', 'boundary:tv:["belt","shoulder"]']);
    expect(remapTopoName([name], { side: 'side2', top: 'top2' })).toEqual([
      ['sketch:side2', 'sketch:top2', 'boundary:tv:["belt","shoulder"]'],
    ]);
    // IDs holding `:` never meet: ("a:b", "c") and ("a", "b:c") are two names (#1111 review).
    const pair = (side: string, plan: string) =>
      curveBoundaryName({
        twoView: { side: { sketchId: 's', element: side }, plan: { sketchId: 'p', element: plan } },
      });
    expect(pair('a:b', 'c')).not.toEqual(pair('a', 'b:c'));
  });
});
