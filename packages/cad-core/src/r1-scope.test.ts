import { describe, expect, it } from 'vitest';
import { f11Bracket, f12Fillet, f15Sweep } from './fixtures';
import { applyCadOperation, type CadOperation } from './operations';
import { mm, type CadDocument } from './model';
import { validateCad } from './validation';

const codes = (doc: unknown) => validateCad(doc).map((d) => `${d.code}@${d.path}`);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;
const changed = (doc: CadDocument, change: (d: Loose) => void) => {
  const out = structuredClone(doc) as unknown as Loose;
  change(out);
  return out;
};

/**
 * R1's scope (docs/cad/r1-modeling.md, CAD38): what R1 leaves to later stages is refused on the
 * way in (import, restore, native reading) and by the operations, never reinterpreted.
 */
describe('R1 scope: later capabilities are refused (CAD38)', () => {
  const fillet = f12Fillet();
  const at = fillet.features.findIndex((f) => f.id === 'fillet');
  const sweep = f15Sweep();
  const sweepAt = sweep.features.findIndex((f) => f.type === 'sweep');
  const bracket = f11Bracket();
  const cases: [string, unknown, string][] = [
    [
      'a fillet radius per edge (variable R)',
      changed(fillet, (d) => (d.features[at].args.radius = [mm(3), mm(5)])),
      `length@$.features[${at}].args.radius`,
    ],
    [
      'a fillet with radii along its edges (variable R)',
      changed(fillet, (d) => (d.features[at].args.radii = [mm(3), mm(5)])),
      `unknown-field@$.features[${at}].args.radii`,
    ],
    [
      'a sweep guide curve',
      changed(sweep, (d) => (d.features[sweepAt].args.guide = { sketchId: 'path', elements: [] })),
      `unknown-field@$.features[${sweepAt}].args.guide`,
    ],
    [
      'a sweep twist',
      changed(sweep, (d) => (d.features[sweepAt].args.twist = { literalRad: 1 })),
      `unknown-field@$.features[${sweepAt}].args.twist`,
    ],
    [
      // R2a-2 admits splines, but only by control points (docs/cad/r2a-freeform.md).
      'a spline through points, not control points',
      changed(bracket, (d) =>
        d.sketches[0].entities.push({ type: 'spline', id: 's1', points: ['p1', 'p2'] }),
      ),
      `unknown-field@$.sketches[0].entities[${bracket.sketches[0]!.entities.length}].points`,
    ],
    [
      // R2a-2 admits boundary surfaces and fills, not a fillet between surfaces.
      'a surface fillet feature',
      changed(bracket, (d) => (d.features[0].type = 'surfaceFillet' as never)),
      'feature-type@$.features[0].type',
    ],
    [
      // R2a admits sheets, but only as what a surface feature gives (docs/cad/r2a-freeform.md).
      'a solid result claimed as a sheet body',
      changed(bracket, (d) => (d.bodies[0].kind = 'sheet')),
      'body-kind@$.bodies[0].kind',
    ],
  ];
  it.each(cases)('refuses %s with its place', (_, doc, code) => {
    expect(codes(doc)).toContain(code);
  });

  it('refuses the same through the operations, leaving the document as it was', () => {
    const ops: [CadDocument, CadOperation][] = [
      [
        fillet,
        {
          type: 'updateFeature',
          featureId: 'fillet',
          args: { ...fillet.features[at]!.args, radius: [mm(3), mm(5)] } as never,
        },
      ],
      [
        sweep,
        {
          type: 'updateFeature',
          featureId: sweep.features[sweepAt]!.id,
          args: { ...sweep.features[sweepAt]!.args, guide: {} } as never,
        },
      ],
      [
        bracket,
        {
          type: 'updateSketch',
          sketchId: bracket.sketches[0]!.id,
          plane: bracket.sketches[0]!.plane,
          entities: [
            ...bracket.sketches[0]!.entities,
            { type: 'spline', id: 's1', points: ['p1', 'p2'] } as never,
          ],
          constraints: bracket.sketches[0]!.constraints,
          solved: bracket.sketches[0]!.solved,
        },
      ],
      [
        bracket,
        {
          type: 'insertFeatures',
          features: [
            { id: 'skin', name: 'Skin', type: 'surfaceFillet', inputFeatureIds: [], args: {} },
          ] as never,
        },
      ],
    ];
    for (const [doc, op] of ops) {
      const before = JSON.stringify(doc);
      expect(() => applyCadOperation(doc, op)).toThrow();
      expect(JSON.stringify(doc)).toBe(before);
    }
  });
});
