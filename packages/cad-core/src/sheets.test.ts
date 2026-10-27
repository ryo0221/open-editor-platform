import { describe, expect, it } from 'vitest';
import { dependencyOrder, featureKind, featureReads, featureReferenceSources } from './graph';
import { f02Plate, f17Boundaries, f17Sheets, f17Surfaces, f18Hood, f18Sheets } from './fixtures';
import { mm, type CadDocument } from './model';
import {
  applyCadOperation,
  dependencyClosure,
  duplicateClosureOf,
  type CadOperation,
} from './operations';
import { cutBoundaryName, remapTopoName, thickenSideName, formatFaceName } from './topology';
import { validateCad } from './validation';

const codes = (doc: unknown) => validateCad(doc).map((d) => `${d.code}@${d.path}`);
type Loose = Record<string, unknown> & { features: Record<string, unknown>[] };
const changed = (doc: CadDocument, change: (d: Loose) => void) => {
  const out = structuredClone(doc) as unknown as Loose;
  change(out);
  return out;
};

describe('sheet bodies (R2a-1, CAD39)', () => {
  it('admits the surface features as sheet bodies', () => {
    for (const kind of ['extrude', 'closed', 'revolve'] as const) {
      const doc = f17Sheets(kind);
      expect(codes(doc)).toEqual([]);
      expect(doc.bodies[0]).toMatchObject({ kind: 'sheet' });
      expect(featureKind(doc, 'sheet')).toBe('sheet');
      expect(featureKind(doc, 'surface-placement')).toBe('sheet');
    }
    expect(f02Plate().bodies.every((b) => b.kind === 'solid')).toBe(true);
  });

  it('reports a mirror without arguments instead of throwing', () => {
    const doc = changed(f17Sheets('closed'), (d) =>
      d.features.push({
        id: 'm',
        name: 'Mirror',
        type: 'mirror',
        inputFeatureIds: ['surface-placement'],
        args: null,
      }),
    );
    expect(() => validateCad(doc)).not.toThrow();
    expect(codes(doc)).toContain('feature-args@$.features[2].args');
  });

  it('refuses a body whose kind is not its result’s', () => {
    expect(
      codes(changed(f17Sheets('extrude'), (d) => ((d.bodies as Loose[])[0]!.kind = 'solid'))),
    ).toEqual(['body-kind@$.bodies[0].kind']);
    expect(
      codes(changed(f17Sheets('extrude'), (d) => ((d.bodies as Loose[])[0]!.kind = 'shell'))),
    ).toEqual(['body-kind@$.bodies[0].kind']);
  });

  it('refuses a sheet where a solid is needed, and the operation leaves the document', () => {
    const sheet = f17Sheets('extrude');
    const plate = f02Plate();
    // A Boolean of the plate and the sheet: the sheet input is refused.
    const both = applyCadOperation(plate, {
      type: 'insertFeatures',
      sketches: sheet.sketches,
      features: sheet.features
        .filter((f) => f.id === 'sheet')
        .map((f) => ({ ...f, args: { ...f.args, distance: mm(30) } }) as typeof f),
      bodies: [
        {
          id: 'surface',
          name: 'surface',
          sourceFeatureId: 'sheet',
          placementFeatureId: 'surface-placement',
          appearance: { color: '#9aa4b1', opacity: 1 },
        },
      ],
    });
    const before = structuredClone(both);
    expect(() =>
      applyCadOperation(both, {
        type: 'booleanBodies',
        targetId: 'plate',
        toolId: 'surface',
        mode: 'cut',
        booleanFeatureId: 'u',
        placementFeatureId: 'u-placement',
      }),
    ).toThrow();
    expect(both).toEqual(before);
    const fillet = changed(sheet, (d) =>
      d.features.push({
        id: 'round',
        name: 'Round',
        type: 'shell',
        inputFeatureIds: ['surface-placement'],
        args: { openFaces: [], thickness: mm(1), side: 'inside' },
      }),
    );
    expect(codes(fillet)).toContain('sheet-not-solid@$.features[2].inputFeatureIds[0]');
  });

  it('checks the surface features’ chains and axes', () => {
    const gap = changed(f17Sheets('closed'), (d) => {
      const f = d.features[0]!.args as { path: { elements: string[] } };
      f.path.elements = ['l0', 'l2'];
    });
    expect(codes(gap)).toEqual(['sweep-path-gap@$.features[0].args.path.elements[1]']);
    const crossing = changed(f17Sheets('revolve'), (d) => {
      (d.features[0]!.args as { axisOrigin: unknown }).axisOrigin = [mm(5), mm(0)];
    });
    expect(codes(crossing)).toEqual(['revolve-crosses-axis@$.features[0].args']);
    const missing = changed(f17Sheets('extrude'), (d) => {
      (d.features[0]!.args as { path: { sketchId: string } }).path.sketchId = 'nope';
    });
    expect(codes(missing)).toContain('sketch-missing@$.features[0].args.path.sketchId');
  });

  it('refuses an imported feature without a body kind', () => {
    const doc = changed(f17Sheets('closed'), (d) =>
      d.features.push({
        id: 'imp',
        name: 'x',
        type: 'imported',
        inputFeatureIds: [],
        args: { kind: 'surface' },
      }),
    );
    expect(codes(doc)).toContain('body-kind@$.features[2].args.kind');
  });
});

describe('lofted and swept sheets (R2a-2b, CAD41)', () => {
  type Chain = { sketchId: string; elements: string[] };
  const loftOf = (d: Loose) => d.features[0]!.args as { sections: Chain[] };
  const sweepOf = (d: Loose) => d.features[0]!.args as { profile: Chain; path: Chain };

  it('admits lofts through open or closed chains and sweeps of a chain as sheets', () => {
    for (const kind of ['loft', 'closed', 'sweep'] as const) {
      const doc = f17Surfaces(kind);
      expect(codes(doc)).toEqual([]);
      expect(doc.bodies[0]).toMatchObject({ kind: 'sheet' });
      expect(featureKind(doc, 'sheet')).toBe('sheet');
    }
    // A loft reads each section's sketch; a sweep its profile's and its path's.
    expect(featureReads(f17Surfaces('loft').features[0]!).sketches).toEqual(['curve', 'upper']);
    expect(featureReads(f17Surfaces('sweep').features[0]!).sketches).toEqual(['profile', 'rail']);
  });

  it('refuses a loft that mixes open and closed chains, repeats a sketch or has too few', () => {
    const mixed = changed(f17Surfaces('closed'), (d) => {
      loftOf(d).sections[1]!.elements = ['b-l0', 'b-l1'];
    });
    expect(codes(mixed)).toEqual(['loft-section-closure@$.features[0].args.sections[1].elements']);
    const same = changed(f17Surfaces('closed'), (d) => {
      loftOf(d).sections[1] = { sketchId: 'a', elements: ['a-l0', 'a-l1', 'a-l2', 'a-l3'] };
    });
    expect(codes(same)).toEqual(['loft-same-sketch@$.features[0].args.sections[1].sketchId']);
    const one = changed(f17Surfaces('loft'), (d) => {
      loftOf(d).sections.pop();
    });
    expect(codes(one)).toEqual(['loft-sections@$.features[0].args.sections']);
    const many = changed(f17Surfaces('loft'), (d) => {
      loftOf(d).sections = Array.from({ length: 33 }, () => loftOf(d).sections[0]!);
    });
    expect(codes(many)).toEqual(['limit-loft-sections@$.features[0].args.sections']);
    const gap = changed(f17Surfaces('closed'), (d) => {
      loftOf(d).sections[0]!.elements = ['a-l0', 'a-l2'];
    });
    expect(codes(gap)).toEqual(['sweep-path-gap@$.features[0].args.sections[0].elements[1]']);
  });

  it('refuses a sweep along a closed path or in its profile’s sketch', () => {
    const doc = f17Surfaces('sweep');
    const loop = changed(doc, (d) => {
      const rail = (d.sketches as { id: string; entities: unknown[] }[]).find(
        (s) => s.id === 'rail',
      )!;
      rail.entities.push({ type: 'line', id: 'back', start: 'e', end: 's' });
      sweepOf(d).path.elements = ['turn', 'back'];
    });
    expect(codes(loop)).toEqual(['sweep-path-closed@$.features[0].args.path.elements']);
    const same = changed(doc, (d) => {
      sweepOf(d).path = { sketchId: 'profile', elements: ['l0'] };
    });
    expect(codes(same)).toContain('sweep-same-sketch@$.features[0].args.path.sketchId');
    const orientation = changed(doc, (d) => {
      (d.features[0]!.args as { orientation: string }).orientation = 'twist';
    });
    expect(codes(orientation)).toEqual(['sweep-orientation@$.features[0].args.orientation']);
  });
});

describe('boundary surfaces, fills and lofts from edges (R2a-2c, CAD41)', () => {
  const kinds = ['hypar', 'quarter', 'fill', 'cap', 'dome', 'edgeLoft'] as const;
  type Curve = Record<string, unknown>;
  const argsOf = (d: Loose, id: string) =>
    d.features.find((f) => f.id === id)!.args as {
      curves: Curve[];
      boundary: { curve: Curve; continuity: string }[];
      sections: unknown[];
    };

  it('admits every F17 boundary as a sheet that reads the results its edges come from', () => {
    for (const kind of kinds) {
      const doc = f17Boundaries(kind);
      expect(codes(doc)).toEqual([]);
      for (const b of doc.bodies) expect(b).toMatchObject({ kind: 'sheet' });
    }
    const hypar = f17Boundaries('hypar');
    expect(featureKind(hypar, 'sheet')).toBe('sheet');
    expect([...featureReads(hypar.features[0]!).sketches].sort()).toEqual([
      'east',
      'floor',
      'north',
    ]);
    // The cap reads the tube's placement by its edges: after it in order, and removed with it.
    const cap = f17Boundaries('cap');
    const fill = cap.features.find((f) => f.id === 'cap')!;
    expect(featureKind(cap, 'cap')).toBe('sheet');
    expect(featureReferenceSources(fill)).toEqual(['surface-placement']);
    const order = dependencyOrder(cap);
    if (!('order' in order)) throw new Error('cycle');
    expect(order.order.indexOf('surface-placement')).toBeLessThan(order.order.indexOf('cap'));
    expect(dependencyClosure(cap, ['sheet']).features.has('cap')).toBe(true);
    const loft = f17Boundaries('edgeLoft');
    expect(featureReferenceSources(loft.features.find((f) => f.id === 'cap')!)).toEqual([
      'surface-placement',
    ]);
    expect(dependencyClosure(loft, ['surface']).features.has('cap')).toBe(true);
  });

  it('refuses curves that are too few or many, not one curve, repeated or missing', () => {
    const hypar = f17Boundaries('hypar');
    const at = '$.features[0].args';
    const few = changed(hypar, (d) => void argsOf(d, 'sheet').curves.splice(2));
    expect(codes(few)).toEqual([`boundary-curves@${at}.curves`]);
    const many = changed(hypar, (d) => {
      const curves = argsOf(d, 'sheet').curves;
      curves.push(curves[0]!);
    });
    expect(codes(many)).toEqual([`boundary-curves@${at}.curves`]);
    const twice = changed(hypar, (d) => {
      const curves = argsOf(d, 'sheet').curves;
      curves[3] = curves[0]!;
    });
    expect(codes(twice)).toEqual([`boundary-curve-duplicate@${at}.curves[3]`]);
    const point = changed(hypar, (d) => void (argsOf(d, 'sheet').curves[0]!.element = 'a'));
    expect(codes(point)).toEqual([`boundary-curve@${at}.curves[0].element`]);
    const lost = changed(hypar, (d) => void (argsOf(d, 'sheet').curves[1]!.sketchId = 'west'));
    expect(codes(lost)).toEqual([`sketch-missing@${at}.curves[1].sketchId`]);
  });

  it('refuses a fill’s boundary count, its continuity, and G1 where no face is beside', () => {
    const at = '$.features[0].args';
    const fill = f17Boundaries('fill');
    const two = changed(fill, (d) => void argsOf(d, 'sheet').boundary.splice(2));
    expect(codes(two)).toEqual([`fill-boundary@${at}.boundary`]);
    const g2 = changed(fill, (d) => void (argsOf(d, 'sheet').boundary[1]!.continuity = 'G2'));
    expect(codes(g2)).toEqual([`fill-continuity@${at}.boundary[1].continuity`]);
    const g1 = changed(fill, (d) => void (argsOf(d, 'sheet').boundary[0]!.continuity = 'G1'));
    expect(codes(g1)).toEqual([`fill-no-adjacent-face@${at}.boundary[0].continuity`]);
    // A referenced edge reads its feature: one that does not exist is refused at the reference,
    // and the fill's own result is a cycle.
    const cap = f17Boundaries('cap');
    const index = cap.features.findIndex((f) => f.id === 'cap');
    const refTo = (featureId: string) =>
      changed(cap, (d) => {
        const ref = argsOf(d, 'cap').boundary[2]!.curve.edge as { featureId: string };
        ref.featureId = featureId;
      });
    expect(codes(refTo('ghost'))).toEqual([
      `reference-feature@$.features[${index}].args.boundary[2].curve.edge.featureId`,
    ]);
    expect(codes(refTo('cap-body-placement'))).toEqual(['cad-dependency-cycle@$']);
    const loft = f17Boundaries('edgeLoft');
    const empty = changed(loft, (d) => void (argsOf(d, 'cap').sections[0] = { edges: [] }));
    expect(codes(empty)).toEqual([`reference-count@$.features[${index}].args.sections[0].edges`]);
  });
});

describe('trim, sew and thicken (R2a-3, CAD42)', () => {
  const index = (doc: CadDocument | Loose, id: string) =>
    (doc.features as { id: string }[]).findIndex((f) => f.id === id);
  const argsOf = (d: Loose, id: string) =>
    d.features[index(d, id)]!.args as Record<string, unknown>;

  it('admits the F18 hood: sew consumes its tools, trim keeps a sheet, thicken gives a solid', () => {
    for (const stage of ['sheets', 'sew', 'trim', 'thicken'] as const)
      expect(codes(f18Hood(stage))).toEqual([]);
    const sew = f18Hood('sew');
    expect(sew.bodies.map((b) => [b.id, b.kind, b.state])).toEqual([
      ['left', 'sheet', 'active'],
      ['right', 'sheet', 'consumed'],
      ['crown', 'sheet', 'consumed'],
    ]);
    expect(featureKind(sew, 'sew')).toBe('sheet');
    const hood = f18Hood('thicken');
    expect(featureKind(hood, 'window-cut')).toBe('sheet');
    expect(featureKind(hood, 'skin')).toBe('solid');
    expect(hood.bodies.find((b) => b.id === 'left')).toMatchObject({ kind: 'solid' });
    // The window's sketch is read like any sketch, and goes with what reads it.
    expect(featureReads(hood.features[index(hood, 'window-cut')]!).sketches).toEqual(['window']);
    expect(dependencyClosure(hood, ['window']).features.has('skin')).toBe(true);
    const box = f18Sheets({ kind: 'box' });
    expect(codes(box)).toEqual([]);
    expect(featureKind(box, 'sew')).toBe('solid');
    expect(box.bodies.find((b) => b.id === 'surface')).toMatchObject({ kind: 'solid' });
    // Turning the sew's `solid` off and on again carries the body's kind with it, one edit each.
    const toggled = (doc: CadDocument, solid: boolean) =>
      applyCadOperation(doc, {
        type: 'updateFeature',
        featureId: 'sew',
        args: { ...(argsOf(doc as unknown as Loose, 'sew') as { toleranceMm: number }), solid },
      } as CadOperation);
    const open = toggled(box, false);
    expect(codes(open)).toEqual([]);
    expect(open.bodies.find((b) => b.id === 'surface')).toMatchObject({ kind: 'sheet' });
    expect(toggled(open, true).bodies.find((b) => b.id === 'surface')).toMatchObject({
      kind: 'solid',
    });
    for (const tool of ['circle', 'plane', 'wall', 'partial', 'miss'] as const)
      expect(
        codes(f18Sheets({ kind: 'trim', tool, keep: tool === 'circle' ? 'inside' : 'front' })),
      ).toEqual([]);
    // Another sheet a trim cuts with is read, not consumed, and removed with what reads it.
    const wall = f18Sheets({ kind: 'trim', tool: 'wall', keep: 'front' });
    expect(featureReferenceSources(wall.features[index(wall, 'cut')]!)).toEqual([
      'blade-placement',
    ]);
    expect(wall.bodies.find((b) => b.id === 'blade')).toMatchObject({ state: 'active' });
    expect(dependencyClosure(wall, ['blade']).features.has('cut')).toBe(true);
  });

  it('refuses a trim’s tool and side, and a trim, sew or thicken of a solid', () => {
    const circle = f18Sheets({ kind: 'trim', tool: 'circle', keep: 'inside' });
    const at = `$.features[${index(circle, 'cut')}].args`;
    const side = changed(circle, (d) => void (argsOf(d, 'cut').keep = 'front'));
    expect(codes(side)).toEqual([`trim-keep@${at}.keep`]);
    const open = changed(circle, (d) => {
      (argsOf(d, 'cut').tool as { elements: string[] }).elements = ['a0'];
    });
    expect(codes(open)).toEqual([`trim-tool-open@${at}.tool.elements`]);
    const plane = f18Sheets({ kind: 'trim', tool: 'plane', keep: 'front' });
    const skew = changed(plane, (d) => {
      (argsOf(d, 'cut').tool as { plane: { normal: number[] } }).plane.normal = [1, 1, 0];
    });
    expect(codes(skew)).toEqual([`trim-normal@${at}.tool.plane.normal`]);
    const odd = changed(plane, (d) => void (argsOf(d, 'cut').keep = 'inside'));
    expect(codes(odd)).toEqual([`trim-keep@${at}.keep`]);
    const nothing = changed(plane, (d) => void (argsOf(d, 'cut').tool = { line: [] }));
    expect(codes(nothing)).toEqual([`trim-tool@${at}.tool`]);
    const wall = f18Sheets({ kind: 'trim', tool: 'wall', keep: 'front' });
    const wat = `$.features[${index(wall, 'cut')}].args`;
    const toolTo = (featureId: string) =>
      changed(wall, (d) => void (argsOf(d, 'cut').tool = { featureId }));
    expect(codes(toolTo('ghost'))).toEqual([`reference-feature@${wat}.tool.featureId`]);
    expect(codes(toolTo('surface-placement'))).toEqual([`trim-tool-self@${wat}.tool.featureId`]);
    expect(codes(toolTo('cut-placement'))).toEqual(['cad-dependency-cycle@$']);
    // A solid is not a sheet: as the trimmed input, as the cutting sheet, sewn or thickened.
    const withBox = changed(wall, (d) => {
      d.features.push({
        id: 'cube',
        name: 'cube',
        type: 'box',
        inputFeatureIds: [],
        args: {
          size: [mm(5), mm(5), mm(5)],
          origin: [mm(0), mm(0), mm(0)],
          orientation: [0, 0, 0, 1],
        },
      });
    });
    const cube = index(withBox, 'cube');
    const asTool = changed(withBox as unknown as CadDocument, (d) => {
      argsOf(d, 'cut').tool = { featureId: 'cube' };
    });
    expect(codes(asTool)).toContain(`solid-not-sheet@${wat}.tool.featureId`);
    const box = f02Plate();
    const plate = box.bodies[0]!;
    const onSolid = (feature: Record<string, unknown>) =>
      changed(
        box,
        (d) => void d.features.push({ ...feature, inputFeatureIds: [plate.resultFeatureId] }),
      );
    const n = box.features.length;
    expect(
      codes(
        onSolid({ id: 'k', name: 'k', type: 'thicken', args: { thickness: mm(1), side: 'front' } }),
      ),
    ).toEqual([`solid-not-sheet@$.features[${n}].inputFeatureIds[0]`]);
    expect(
      codes(
        onSolid({
          id: 'k',
          name: 'k',
          type: 'trim',
          args: {
            tool: { plane: { origin: [mm(0), mm(0), mm(0)], normal: [1, 0, 0] } },
            keep: 'front',
          },
        }),
      ),
    ).toEqual([`solid-not-sheet@$.features[${n}].inputFeatureIds[0]`]);
    expect(cube).toBeGreaterThan(0);
  });

  it('refuses a sew’s distance, a repeated input, a thicken’s side, and sews only sheets', () => {
    const sew = f18Hood('sew');
    const at = `$.features[${index(sew, 'sew')}]`;
    for (const t of [0, 0.0000009, 0.00011, -1])
      expect(codes(changed(sew, (d) => void (argsOf(d, 'sew').toleranceMm = t)))).toEqual([
        `sew-tolerance@${at}.args.toleranceMm`,
      ]);
    expect(codes(changed(sew, (d) => void (argsOf(d, 'sew').solid = 'yes')))).toEqual([
      `sew-solid@${at}.args.solid`,
    ]);
    const twice = changed(sew, (d) => {
      const f = d.features[index(d, 'sew')]! as { inputFeatureIds: string[] };
      f.inputFeatureIds[2] = f.inputFeatureIds[1]!;
    });
    expect(codes(twice)).toContain(`sew-same-input@${at}.inputFeatureIds`);
    const hood = f18Hood('thicken');
    const skin = `$.features[${index(hood, 'skin')}].args.side`;
    expect(codes(changed(hood, (d) => void (argsOf(d, 'skin').side = 'inside')))).toEqual([
      `thicken-side@${skin}`,
    ]);
    // The operation refuses before the document: a body twice, the target among the tools.
    const op = (toolIds: string[]): CadOperation => ({
      type: 'sewBodies',
      targetId: 'left',
      toolIds,
      toleranceMm: 0.0001,
      solid: false,
      sewFeatureId: 's2',
      placementFeatureId: 's2-placement',
    });
    const sheets = f18Hood('sheets');
    expect(() => applyCadOperation(sheets, op(['right', 'right']))).toThrow('sew-inputs');
    expect(() => applyCadOperation(sheets, op(['left']))).toThrow('sew-same-body');
    expect(() => applyCadOperation(sew, op(['right']))).toThrow('body-consumed');
    // A sew of a solid is refused at its input.
    const cube = (id: string) => ({
      id,
      name: id,
      type: 'box' as const,
      inputFeatureIds: [] as [],
      args: {
        size: [mm(5), mm(5), mm(5)] as [
          ReturnType<typeof mm>,
          ReturnType<typeof mm>,
          ReturnType<typeof mm>,
        ],
        origin: [mm(0), mm(0), mm(0)] as [
          ReturnType<typeof mm>,
          ReturnType<typeof mm>,
          ReturnType<typeof mm>,
        ],
        orientation: [0, 0, 0, 1] as [number, number, number, number],
      },
    });
    const solids = applyCadOperation(sheets, {
      type: 'insertFeatures',
      features: [cube('c1'), cube('c2')],
      bodies: ['c1', 'c2'].map((id) => ({
        id: `${id}-body`,
        name: id,
        sourceFeatureId: id,
        placementFeatureId: `${id}-placement`,
        appearance: { color: '#9aa4b1', opacity: 1 },
      })),
    });
    expect(() =>
      applyCadOperation(solids, { ...op(['c2-body']), targetId: 'c1-body' } as CadOperation),
    ).toThrow(/solid-not-sheet/);
  });

  it('names pieces, cuts and sides with the IDs a duplicate maps (命名)', () => {
    expect(formatFaceName(cutBoundaryName({ sketchId: 'window', element: 'e0' }))).toBe(
      'sketch:window/cut:e:e0',
    );
    expect(cutBoundaryName({ plane: true })).toEqual(['cut:plane']);
    const fromSheet = cutBoundaryName({ featureId: 'blade-placement', face: ['side:e:l'] });
    expect(formatFaceName(fromSheet)).toBe('from:blade-placement/cut:(side:e:l)');
    const side = thickenSideName([['sketch:floor', 'boundary:e:ab'], ['surface']]);
    expect(formatFaceName(side)).toBe('side:(sketch:floor/boundary:e:ab | surface)');
    const map = { cut: 'cut2', 'blade-placement': 'b2', window: 'w2', 'left-placement': 'l2' };
    expect(
      remapTopoName([['trim:cut:front', 'sew:left-placement', 'surface'], [...fromSheet]], map),
    ).toEqual([
      ['from:b2', 'cut:[["side:e:l"]]'],
      ['trim:cut2:front', 'sew:l2', 'surface'],
    ]);
    // The whole hood copies, its sew, window and skin included.
    const hood = f18Hood('thicken');
    const { ids } = duplicateClosureOf(hood, ['left']);
    const idMap = Object.fromEntries(ids.map((id) => [id, `${id}-2`]));
    const copy = applyCadOperation(hood, { type: 'duplicateClosure', bodyIds: ['left'], idMap });
    expect(codes(copy)).toEqual([]);
    expect(copy.bodies.filter((b) => b.state === 'consumed')).toHaveLength(4);
  });
});
