import { describe, expect, it } from 'vitest';
import {
  f14Patterns,
  f15Loft,
  f16Sketch,
  type CadDocument,
  type CadSketch,
} from '@editor-platform/cad-core';
import { cadFailureHint, regionCrossing } from './failure-hints';
import { cadFailureReport, describeFailure } from './controller';

/** f15Loft('square') with the top square's loop starting at the opposite corner. */
function turnedTop(): CadDocument {
  const doc = structuredClone(f15Loft('square'));
  const loft = doc.features.find((f) => f.id === 'loft-feature')!;
  if (loft.type !== 'loft') throw new Error('loft');
  const top = loft.args.sections[1]!;
  if (!('sketchId' in top)) throw new Error('sketch section');
  top.region = { outer: ['l2', 'l3', 'l0', 'l1'], holes: [] };
  return doc;
}
/** The loft's base square drawn as a bow tie: l0 crosses l2 at the origin. */
function bowTie(): CadDocument {
  const doc = structuredClone(f15Loft('square'));
  const s = doc.sketches.find((x) => x.id === 'loft-base')!;
  s.solved.p1 = [20, 20];
  s.solved.p2 = [20, -20];
  return doc;
}

describe('#13 shape-evaluation failures as a typed reason, elements and hint', () => {
  it('a loft whose section starts on the other side names that section and says to align the start points', () => {
    const r = cadFailureHint(
      turnedTop(),
      'kernel-exception:Standard_Failure: BRepFill_CompatibleWires',
      'loft-feature',
    );
    expect(r).toMatchObject({ reason: 'loft-section-start', elements: ['sections[1]'] });
    expect(r!.hint).toContain('始点');
    // Same starts: the generic loft hint over all sections.
    expect(
      cadFailureHint(f15Loft('square'), 'kernel-exception:BRepFill', 'loft-feature'),
    ).toMatchObject({ reason: 'loft-sections', elements: ['sections[0]', 'sections[1]'] });
  });

  it('a crossing sketch region names the two elements that cross and where', () => {
    const doc = bowTie();
    const s = doc.sketches.find((x) => x.id === 'loft-base')!;
    expect(regionCrossing(s, { outer: ['l0', 'l1', 'l2', 'l3'], holes: [] })).toEqual({
      a: 'l0',
      b: 'l2',
      at: [0, 0],
    });
    const r = cadFailureHint(
      doc,
      'cad-invalid:region-self-intersection@$.features[0].args.sections[0].region.outer[0]',
      'loft-feature',
    );
    expect(r).toMatchObject({ reason: 'profile-crossing', elements: ['l0', 'l2'] });
    expect(r!.hint).toContain('l0 が l2 と (0, 0) mm 付近で交わっています');
    // A region that does not cross gives no pair.
    expect(
      regionCrossing(f15Loft('square').sketches[0]!, {
        outer: ['l0', 'l1', 'l2', 'l3'],
        holes: [],
      }),
    ).toBeUndefined();
  });

  it('a spline joined to the next element shares its end there: the real crossing is named, not the join', () => {
    const doc = bowTie();
    const s = doc.sketches.find((x) => x.id === 'loft-base')!;
    const i = s.entities.findIndex((e) => e.id === 'l0');
    s.entities[i] = {
      type: 'spline',
      id: 'l0',
      poles: ['p0', 'pm', 'p1'],
      degree: 2,
    } as CadSketch['entities'][number];
    s.solved.pm = [-5, -5];
    expect(regionCrossing(s, { outer: ['l0', 'l1', 'l2', 'l3'], holes: [] })).toMatchObject({
      a: 'l0',
      b: 'l2',
    });
  });

  it('a refused edit names no element: the validator path finds the feature and its crossing', () => {
    const r = cadFailureHint(
      bowTie(),
      'cad-invalid:region-self-intersection@$.features[0].args.sections[0].region.outer[0]',
    );
    expect(r).toMatchObject({ reason: 'profile-crossing', elements: ['l0', 'l2'] });
  });

  it('loft starts are compared in world space: a top sketch turned 180° about Z with its start turned too is aligned', () => {
    const doc = turnedTop();
    const top = doc.sketches.find((x) => x.id === 'loft-top')!;
    if (!('orientation' in top.plane)) throw new Error('plane');
    top.plane.orientation = [0, 0, 1, 0];
    expect(cadFailureHint(doc, 'kernel-exception:BRepFill', 'loft-feature')).toMatchObject({
      reason: 'loft-sections',
    });
  });

  it('a section whose edge is split into many short lines has the same centre: aligned starts are not reported', () => {
    const doc = structuredClone(f15Loft('square'));
    const rect = (s: CadSketch, split: number) => {
      const pts: [number, number][] = [
        [0, 0],
        [100, 0],
        [100, 10],
        [0, 10],
      ];
      for (let i = 1; i < split; i++) pts.push([0, 10 - (10 * i) / split]);
      s.entities = [
        ...pts.map((_, i) => ({ type: 'point', id: `p${i}` })),
        ...pts.map((_, i) => ({
          type: 'line',
          id: `l${i}`,
          start: `p${i}`,
          end: `p${(i + 1) % pts.length}`,
        })),
      ] as CadSketch['entities'];
      s.solved = Object.fromEntries(pts.map((p, i) => [`p${i}`, p]));
      return pts.map((_, i) => `l${i}`);
    };
    const loft = doc.features.find((f) => f.id === 'loft-feature')!;
    if (loft.type !== 'loft') throw new Error('loft');
    const [a, b] = loft.args.sections;
    if (!a || !b || !('sketchId' in a) || !('sketchId' in b)) throw new Error('sections');
    a.region = { outer: rect(doc.sketches[0]!, 1), holes: [] };
    b.region = { outer: rect(doc.sketches[1]!, 100), holes: [] };
    expect(cadFailureHint(doc, 'kernel-exception:BRepFill', 'loft-feature')).toMatchObject({
      reason: 'loft-sections',
    });
  });

  it('a refused draft in an unexpected shape gives no hint instead of an error; limits never get the mirror diagnosis', () => {
    const doc = structuredClone(f15Loft('square'));
    const loft = doc.features.find((f) => f.id === 'loft-feature')!;
    (loft.args as unknown as { sections: null }).sections = null;
    expect(() =>
      cadFailureHint(doc, 'cad-invalid:loft-sections@$.features[0].args.sections'),
    ).not.toThrow();
    const mirrored = f14Patterns('mirror');
    expect(cadFailureHint(mirrored, 'limit-solids', 'm2')).toBeUndefined();
    expect(cadFailureHint(mirrored, 'kernel-exception:BOPAlgo', 'm2')).toMatchObject({
      reason: 'mirrored-part',
    });
  });

  it('a self-crossing spline names the spline', () => {
    const sketch = f16Sketch('crossing');
    const doc = { ...f15Loft(), sketches: [sketch] } as CadDocument;
    const r = cadFailureHint(doc, 'sketch-self-intersection@$.sketches[0].entities[5]', sketch.id);
    expect(r).toMatchObject({ reason: 'spline-self-crossing', elements: [sketch.entities[5]!.id] });
  });

  it('a failure on the mirrored side names the mirror', () => {
    const doc = f14Patterns('mirror');
    const mirror = doc.features.find((f) => f.type === 'mirror')!;
    const r = cadFailureHint(doc, 'kernel-exception:BOPAlgo', mirror.id);
    expect(r).toMatchObject({ reason: 'mirrored-part', elements: [mirror.id] });
    // Two mirrors (m1 then m2): a failure of m2 names m2, not the earlier m1.
    expect(cadFailureHint(doc, 'kernel-exception:BOPAlgo', 'm2')).toMatchObject({
      reason: 'mirrored-part',
      elements: ['m2'],
    });
    // Unknown classes have no hint.
    expect(cadFailureHint(f15Loft(), 'output-limit', 'loft-feature')).toBeUndefined();
  });

  it('the failure report and the feature-tree text carry the reason, elements and hint', () => {
    const doc = turnedTop();
    const report = cadFailureReport(doc, {
      code: 'kernel-exception:BRepFill_CompatibleWires',
      featureId: 'loft-feature',
    });
    expect(report).toMatchObject({
      featureId: 'loft-feature',
      reason: 'loft-section-start',
      elements: ['sections[1]'],
    });
    expect(
      describeFailure(doc, 'kernel-exception:BRepFill_CompatibleWires', 'loft-feature'),
    ).toContain('直し方：');
    expect(describeFailure(f15Loft(), 'output-limit', 'loft-feature')).not.toContain('直し方：');
  });
});
