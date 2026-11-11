import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readP21 } from '@editor-platform/geometry-core';
import {
  keptView,
  linkedCallouts,
  presentationOfItems,
  presentedVertices,
  verifiedPmi,
  viewsOfItems,
  type CadPmiSemantics,
  type CadPmiVerified,
  type PmiItemJson,
} from './step-pmi';
import { pmiPresentation, type PmiFileCallout, type PmiFileView } from './step-pmi-presentation';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/f43/${name}`, import.meta.url)));
const read = (bytes: Uint8Array) =>
  readP21(bytes, { bytes: 1 << 24, entities: 1 << 20, depth: 64 }, { references: 'keep' });
const text = (body: string) =>
  new TextEncoder().encode(
    `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF'));\nENDSEC;\nDATA;\n${body}\nENDSEC;\nEND-ISO-10303-21;\n`,
  );
interface Expected {
  presentations: Record<
    string,
    { polylines: number[][][]; plane: { origin: number[]; z: number[]; x: number[] } }
  >;
  views: {
    name: string;
    eye: number[];
    direction: number[];
    up: number[];
    width: number;
    height: number;
    members: string[];
  }[];
}
const c0 = (p: { callouts: PmiFileCallout[] }) => p.callouts[0];
const expected = JSON.parse(new TextDecoder().decode(fixture('presented.json'))) as Expected;
/** A polyline's segments as the reader gives them. */
const segments = (lines: number[][][]) =>
  lines.flatMap((line) => line.slice(1).flatMap((p, i) => [...line[i], ...p]));
/** The callout of each name in the fixture (`DRAUGHTING_CALLOUT('name', …)`). */
const byName = (bytes: Uint8Array, callouts: PmiFileCallout[]) => {
  const file = read(bytes);
  return new Map(
    callouts.map((c) => {
      const name = file.entities.get(c.id)!.args[0];
      return [name?.t === 'str' ? name.v : '', c];
    }),
  );
};
/** The leaf type of an entity the callout presents. */
const presented = (bytes: Uint8Array, c: PmiFileCallout) => {
  const file = read(bytes);
  return c.presents.map((id) => {
    const e = file.entities.get(id)!;
    return (e.parts ?? [e]).map((p) => p.type).join(' ');
  });
};

describe('reading the presentation and saved views from the text (PMI-3a, ST-210)', () => {
  it.each(['pmi-presented.step', 'pmi-placeholder.step'])(
    'reads every callout of %s with its lines, plane and the item it presents',
    (name) => {
      const bytes = fixture(name);
      const p = pmiPresentation(read(bytes), 1);
      const callouts = byName(bytes, p.callouts);
      expect([...callouts.keys()].sort()).toEqual(Object.keys(expected.presentations).sort());
      for (const [key, want] of Object.entries(expected.presentations)) {
        const c = callouts.get(key)!;
        expect(c.unsupported).toBeUndefined();
        expect(c.segments).toEqual(segments(want.polylines));
        expect(c.plane).toEqual(want.plane);
      }
      // The diameter and the position link with the placeholder association in the second file.
      expect(presented(bytes, callouts.get('diameter')!)).toEqual(['DIMENSIONAL_SIZE']);
      expect(presented(bytes, callouts.get('distance')!)).toEqual(['DIMENSIONAL_LOCATION']);
      expect(presented(bytes, callouts.get('position')!)[0]).toMatch(/POSITION_TOLERANCE/);
      // A datum feature presents its datum.
      expect(presented(bytes, callouts.get('datum A')!)).toEqual(['DATUM']);
      // One product: every callout and the item it presents are placed in it.
      const frames = new Set(p.callouts.map((c) => c.frames.join()));
      expect(frames.size).toBe(1);
      expect(c0(p).frames).toHaveLength(1);
      for (const c of p.callouts)
        expect(c.presents.map((e) => p.itemFrame.get(e))).toEqual(
          c.presents.map(() => c.frames[0]),
        );
      expect(p.views.every((v) => v.frames.join() === c0(p).frames.join())).toBe(true);
      expect(p.placeholders).toBe(name === 'pmi-placeholder.step' ? 2 : 0);
      expect(callouts.get('diameter')!.occurrences).toHaveLength(
        name === 'pmi-placeholder.step' ? 2 : 1,
      );
    },
  );

  it('reads each saved view with its camera and the callouts of its draughting model', () => {
    const bytes = fixture('pmi-presented.step');
    const p = pmiPresentation(read(bytes), 1);
    const names = new Map([...byName(bytes, p.callouts)].map(([k, c]) => [c.id, k]));
    expect(
      p.views.map((v) => ({
        name: v.name,
        eye: v.camera!.eye,
        direction: v.camera!.direction,
        up: v.camera!.up,
        width: v.camera!.width,
        height: v.camera!.height,
        members: v.callouts.map((c) => names.get(c)),
      })),
    ).toEqual(expected.views);
    expect(p.views.every((v) => v.camera!.projection === 'parallel' && !v.camera!.clipping)).toBe(
      true,
    );
  });

  it('keeps no camera past the model’s coordinate range', () => {
    const camera = (eye: string, width: string) =>
      pmiPresentation(
        read(
          text(`#1 = CAMERA_MODEL_D3('v',#2,#4);
#2 = AXIS2_PLACEMENT_3D('',#3,$,$);
#3 = CARTESIAN_POINT('',(${eye}));
#4 = VIEW_VOLUME(.PARALLEL.,#3,0.,0.,.F.,0.,.F.,.F.,#5);
#5 = PLANAR_BOX('',${width},10.,#2);`),
        ),
        1,
      ).views[0]!;
    expect(camera('0.,0.,0.', '10.').camera).toBeDefined();
    expect(camera('1.E40,0.,0.', '10.')).toMatchObject({ unsupported: 'coordinate-range' });
    expect(camera('0.,0.,0.', '1.E40')).toMatchObject({ unsupported: 'coordinate-range' });
  });

  const set = `#1 = DRAUGHTING_CALLOUT('c',(#2));
#2 = TESSELLATED_ANNOTATION_OCCURRENCE('',(),#3);
#4 = COORDINATES_LIST('',3,((0.,0.,0.),(1.,0.,0.),(1.,1.,0.)));
#5 = TESSELLATED_CURVE_SET('',#4,((1,2,3)));`;
  it('places a repositioned set, converts to mm and draws triangles by their edges', () => {
    const p = pmiPresentation(
      read(
        text(`${set}
#3 = ( GEOMETRIC_REPRESENTATION_ITEM() REPOSITIONED_TESSELLATED_ITEM(#10) REPRESENTATION_ITEM('') TESSELLATED_GEOMETRIC_SET((#11,#5,#6)) TESSELLATED_ITEM() );
#6 = COMPLEX_TRIANGULATED_SURFACE_SET('',#4,3,((0.,0.,1.)),(),(),((1,2,3)));
#10 = AXIS2_PLACEMENT_3D('',#12,#13,#14);
#11 = AXIS2_PLACEMENT_3D('',#12,$,$);
#12 = CARTESIAN_POINT('',(10.,0.,0.));
#13 = DIRECTION('',(0.,0.,1.));
#14 = DIRECTION('',(0.,1.,0.));`),
      ),
      25.4,
    );
    const [c] = p.callouts;
    expect(c.unsupported).toBeUndefined();
    // x along the file's y: (1, 0, 0) is at (10, 1, 0) in, each point × 25.4.
    const at = (x: number, y: number) => [(10 - y) * 25.4, x * 25.4, 0];
    const strip = [...at(0, 0), ...at(1, 0), ...at(1, 0), ...at(1, 1)];
    const triangle = [...strip, ...at(1, 1), ...at(0, 0)];
    expect(c.segments.length).toBe(strip.length + triangle.length);
    c.segments.forEach((v, i) => expect(v).toBeCloseTo([...strip, ...triangle][i], 9));
  });

  it('shows no part of a callout it cannot read whole', () => {
    const p = pmiPresentation(
      read(
        text(`#1 = DRAUGHTING_CALLOUT('c',(#2,#7));
#2 = TESSELLATED_ANNOTATION_OCCURRENCE('',(),#3);
#3 = TESSELLATED_GEOMETRIC_SET('',(#5));
#4 = COORDINATES_LIST('',3,((0.,0.,0.),(1.,0.,0.),(1.,1.,0.)));
#5 = TESSELLATED_CURVE_SET('',#4,((1,2,3)));
#7 = ANNOTATION_CURVE_OCCURRENCE('',(),#8);
#8 = POLYLINE('',(#9,#9));
#9 = CARTESIAN_POINT('',(0.,0.,0.));`),
      ),
      1,
    );
    expect(p.callouts[0]).toMatchObject({
      unsupported: 'ANNOTATION_CURVE_OCCURRENCE',
      segments: [],
    });
    // An index past the coordinate list is not a line.
    const bad = pmiPresentation(
      read(
        text(`${set.replace('((1,2,3))', '((1,2,4))')}
#3 = TESSELLATED_GEOMETRIC_SET('',(#5));`),
      ),
      1,
    );
    expect(bad.callouts[0]).toMatchObject({ unsupported: 'TESSELLATED_CURVE_SET', segments: [] });
  });

  it('places a callout in the product of its draughting model and an item in the product of its shape aspect', () => {
    // Products #50 (context #60) and #51 (context #61); the dimension is on #50's shape.
    const products = `#50 = PRODUCT_DEFINITION('a','',#90,#91);
#51 = PRODUCT_DEFINITION('b','',#90,#91);
#52 = PRODUCT_DEFINITION_SHAPE('','',#50);
#53 = PRODUCT_DEFINITION_SHAPE('','',#51);
#54 = SHAPE_REPRESENTATION('',(),#60);
#55 = SHAPE_REPRESENTATION('',(),#61);
#56 = SHAPE_DEFINITION_REPRESENTATION(#52,#54);
#57 = SHAPE_DEFINITION_REPRESENTATION(#53,#55);
#70 = SHAPE_ASPECT('','',#52,.T.);
#71 = DIMENSIONAL_SIZE(#70,'diameter');
#72 = DRAUGHTING_MODEL_ITEM_ASSOCIATION('','',#71,#80,#1);`;
    const at = (context: number) =>
      pmiPresentation(
        read(
          text(`${set}
#3 = TESSELLATED_GEOMETRIC_SET('',(#5));
${products}
#80 = ( DRAUGHTING_MODEL() REPRESENTATION('',(#1),#${context}) );`),
        ),
        1,
      );
    const own = at(60);
    expect(own.callouts[0].frames).toEqual([50]);
    expect(own.itemFrame.get(71)).toBe(50);
    // In the other product's context the lines are not the item's frame.
    const other = at(61);
    expect(other.callouts[0].frames).toEqual([51]);
    expect(other.itemFrame.get(71)).toBe(50);
    // A context of no product places nothing.
    expect(at(62).callouts[0].frames).toEqual([]);
  });

  it('links lines to a verified item only in the item’s own product', () => {
    const item = {} as CadPmiVerified['dimensions'][number];
    const verified = {
      dimensions: [item],
      tolerances: [],
      datums: [],
      datumTargets: [],
      entityOf: new Map([[item, 71]]),
    } as CadPmiVerified;
    const callout = (frames: number[]): PmiFileCallout => ({
      id: 1,
      segments: [0, 0, 0, 1, 0, 0],
      presents: [71],
      occurrences: [2],
      frames,
    });
    const linked = (...frames: number[]) =>
      linkedCallouts(
        {
          callouts: [callout(frames)],
          views: [],
          placeholders: 0,
          relationships: [],
          itemFrame: new Map([[71, 50]]),
        },
        verified,
      ).length;
    // Listed in the part's frame and an assembly's: the part's.
    expect([linked(50), linked(51), linked(), linked(51, 50)]).toEqual([1, 0, 0, 1]);
    // A callout's lines count once for every item it presents (copied to each).
    const three = [item, item, item];
    expect(
      presentedVertices([
        { callout: callout([50]), items: three },
        { callout: { ...callout([50]), segments: new Array(12).fill(0) }, items: [item] },
      ]),
    ).toBe(2 * 3 + 4);
  });

  it('keeps each callout’s views with its own lines when two callouts present one item (PMI-3b)', () => {
    const item = {} as CadPmiVerified['dimensions'][number];
    const verified = { entityOf: new Map([[item, 71]]) } as CadPmiVerified;
    const callout = (id: number, n: number): PmiFileCallout => ({
      id,
      segments: new Array(6 * n).fill(id),
      presents: [71],
      occurrences: [id],
      frames: [50],
    });
    const camera = {
      eye: [0, 0, 0] as [number, number, number],
      direction: [0, 0, -1] as [number, number, number],
      up: [0, 1, 0] as [number, number, number],
      width: 1,
      height: 1,
      projection: 'parallel' as const,
      clipping: false,
    };
    const view = (id: number, callouts: number[], name = 'v'): PmiFileView => ({
      id,
      name,
      callouts,
      frames: [50],
      camera,
    });
    const linked = [
      { callout: callout(1, 1), items: [item] },
      { callout: callout(2, 2), items: [item] },
    ];
    const presentation = (views: PmiFileView[]) => ({
      callouts: linked.map((l) => l.callout),
      views,
      placeholders: 0,
      relationships: [],
      itemFrame: new Map([[71, 50]]),
    });
    const a = view(100, [1]);
    const b = view(101, [2]);
    const of = viewsOfItems(presentation([a, b]), linked, verified);
    if (of === 'too-many') throw new Error('too-many');
    expect(presentationOfItems(linked).get(item)!.segments).toHaveLength(18);
    expect(of.get(item)).toEqual({
      views: [a, b],
      ranges: [
        { end: 6, views: [a] },
        { end: 18, views: [b] },
      ],
    });
    // A callout in more views than one asset holds: refused before the memberships are made.
    const many = Array.from({ length: 257 }, (_, i) => view(200 + i, [1]));
    expect(viewsOfItems(presentation(many), linked, verified)).toBe('too-many');
    // A view whose name is past the limit is not kept (the asset could not hold it).
    expect(keptView(view(1, [1], 'n'.repeat(257)))).toBe(false);
    expect(keptView(view(1, [1], 'n'.repeat(256)))).toBe(true);
  });

  it('names the occurrences two callouts share by entity', () => {
    const p = pmiPresentation(
      read(
        text(`${set}
#9 = DRAUGHTING_CALLOUT('d',(#2));
#3 = TESSELLATED_GEOMETRIC_SET('',(#5));`),
      ),
      1,
    );
    expect(p.callouts.map((c) => c.occurrences)).toEqual([[2], [2]]);
  });

  it('links an association to a shared occurrence with the callouts of its draughting model', () => {
    // Callouts #1 and #9 share occurrence #2; the association names the occurrence.
    const at = (model: string) =>
      pmiPresentation(
        read(
          text(`${set}
#9 = DRAUGHTING_CALLOUT('d',(#2));
#3 = TESSELLATED_GEOMETRIC_SET('',(#5));
#20 = ( DRAUGHTING_MODEL() REPRESENTATION('',(#1),#60) );
#21 = ( DRAUGHTING_MODEL() REPRESENTATION('',(#9),#60) );
#22 = ( DRAUGHTING_MODEL() REPRESENTATION('',(),#60) );
#70 = SHAPE_ASPECT('','',$,.T.);
#71 = DIMENSIONAL_SIZE(#70,'diameter');
#72 = DRAUGHTING_MODEL_ITEM_ASSOCIATION('','',#71,${model},#2);`),
        ),
        1,
      ).callouts.map((c) => c.presents);
    expect(at('#20')).toEqual([[71], []]);
    expect(at('#21')).toEqual([[], [71]]);
    // A model listing neither: both callouts present the item.
    expect(at('#22')).toEqual([[71], [71]]);
  });

  it('stops drawing past the vertex budget while it reads, not after', () => {
    // One 1,000-segment curve shared by 1,001 occurrences: 2,002,000 vertices.
    const points = Array.from({ length: 1001 }, (_, i) => `(${i}.,0.,0.)`).join(',');
    const strip = Array.from({ length: 1001 }, (_, i) => i + 1).join(',');
    const occurrences = Array.from({ length: 1001 }, (_, i) => `#${1000 + i}`);
    const p = pmiPresentation(
      read(
        text(`#1 = DRAUGHTING_CALLOUT('c',(${occurrences.join(',')}));
${occurrences.map((o) => `${o} = TESSELLATED_ANNOTATION_OCCURRENCE('',(),#3);`).join('\n')}
#3 = TESSELLATED_GEOMETRIC_SET('',(#5));
#4 = COORDINATES_LIST('',1001,(${points}));
#5 = TESSELLATED_CURVE_SET('',#4,((${strip})));`),
      ),
      1,
    );
    expect(p.callouts[0]).toMatchObject({ unsupported: 'presentation-budget', segments: [] });
  });

  it('indexes an occurrence shared by many callouts in time linear in the callouts', () => {
    // 30,000 callouts share one placeholder: copying the list for each would be 450 million ids.
    const callouts = Array.from(
      { length: 30_000 },
      (_, i) => `#${1000 + i} = DRAUGHTING_CALLOUT('c',(#2));`,
    );
    const file = read(
      text(`${callouts.join('\n')}
#2 = ANNOTATION_PLACEHOLDER_OCCURRENCE('',(),$,$,$,$);`),
    );
    const start = performance.now();
    const p = pmiPresentation(file, 1);
    expect(performance.now() - start).toBeLessThan(1500);
    expect(p.callouts).toHaveLength(30_000);
  });

  it('resolves a shared model’s product and callouts once, not for each callout and camera', () => {
    // 5,000 callouts and 5,000 cameras in one model whose context holds 5,000 shapes: per
    // callout that is 25 million shape scans, per camera 50 million item reads.
    const n = 5000;
    const ids = (from: number) => Array.from({ length: n }, (_, i) => from + i);
    const callouts = ids(10_000);
    const cameras = ids(20_000);
    const shapes = ids(30_000);
    const file = read(
      text(`${callouts.map((c) => `#${c} = DRAUGHTING_CALLOUT('c',(#2));`).join('\n')}
#2 = ANNOTATION_PLACEHOLDER_OCCURRENCE('',(),$,$,$,$);
${cameras.map((c) => `#${c} = CAMERA_MODEL_D3('v',$,$);`).join('\n')}
${shapes.map((r) => `#${r} = SHAPE_REPRESENTATION('',(),#60);`).join('\n')}
#80 = ( DRAUGHTING_MODEL() REPRESENTATION('',(${[...callouts, ...cameras].map((c) => `#${c}`).join(',')}),#60) );`),
    );
    const start = performance.now();
    const p = pmiPresentation(file, 1);
    expect(performance.now() - start).toBeLessThan(1500);
    expect(p.views).toHaveLength(n);
    expect(p.views[0]!.callouts).toHaveLength(n);
  });

  it('bounds links from an occurrence many callouts share (overrides and associations)', () => {
    // 1,001 callouts share occurrence #2; 1,000 overrides (or associations) name it: 1,001,000
    // links, past the expansion budget, so none of the callouts is drawn.
    const callouts = Array.from(
      { length: 1001 },
      (_, i) => `#${10_000 + i} = DRAUGHTING_CALLOUT('c',(#2));`,
    ).join('\n');
    const shared = (naming: (id: number) => string) =>
      pmiPresentation(
        read(
          text(`${callouts}
#2 = TESSELLATED_ANNOTATION_OCCURRENCE('',(),#3);
#3 = TESSELLATED_GEOMETRIC_SET('',(#5));
#4 = COORDINATES_LIST('',2,((0.,0.,0.),(1.,0.,0.)));
#5 = TESSELLATED_CURVE_SET('',#4,((1,2)));
#70 = SHAPE_ASPECT('','',$,.T.);
#71 = DIMENSIONAL_SIZE(#70,'diameter');
${Array.from({ length: 1000 }, (_, i) => naming(20_000 + i)).join('\n')}`),
        ),
        1,
      );
    const overrides = shared(
      (id) =>
        `#${id} = ( ANNOTATION_OCCURRENCE() GEOMETRIC_REPRESENTATION_ITEM() OVER_RIDING_STYLED_ITEM(#2) REPRESENTATION_ITEM('') STYLED_ITEM((),$) );`,
    );
    const associations = shared(
      (id) => `#${id} = DRAUGHTING_MODEL_ITEM_ASSOCIATION('','',#71,$,#2);`,
    );
    for (const p of [overrides, associations]) {
      expect(p.callouts.every((c) => c.unsupported === 'presentation-budget')).toBe(true);
      expect(p.callouts.every((c) => c.segments.length === 0)).toBe(true);
      expect(
        p.callouts.reduce((n, c) => n + c.occurrences.length + c.presents.length, 0),
      ).toBeLessThan(1_010_000);
    }
    // Below the budget, every callout keeps the override.
    const few = pmiPresentation(
      read(
        text(`${callouts}
#2 = TESSELLATED_ANNOTATION_OCCURRENCE('',(),#3);
#3 = TESSELLATED_GEOMETRIC_SET('',(#5));
#4 = COORDINATES_LIST('',2,((0.,0.,0.),(1.,0.,0.)));
#5 = TESSELLATED_CURVE_SET('',#4,((1,2)));
#20000 = ( ANNOTATION_OCCURRENCE() GEOMETRIC_REPRESENTATION_ITEM() OVER_RIDING_STYLED_ITEM(#2) REPRESENTATION_ITEM('') STYLED_ITEM((),$) );`),
      ),
      1,
    );
    expect(few.callouts.every((c) => !c.unsupported && c.occurrences.join() === '2,20000')).toBe(
      true,
    );
  });

  it('stops at the expansion budget without walking the rest', () => {
    // 20,000 callouts share #2 and 20,000 overrides name it: 400 million links to walk.
    const n = 20_000;
    const file = read(
      text(`${Array.from({ length: n }, (_, i) => `#${100_000 + i} = DRAUGHTING_CALLOUT('c',(#2));`).join('\n')}
#2 = ANNOTATION_PLACEHOLDER_OCCURRENCE('',(),$,$,$,$);
${Array.from({ length: n }, (_, i) => `#${200_000 + i} = ( ANNOTATION_OCCURRENCE() GEOMETRIC_REPRESENTATION_ITEM() OVER_RIDING_STYLED_ITEM(#2) REPRESENTATION_ITEM('') STYLED_ITEM((),$) );`).join('\n')}`),
    );
    const start = performance.now();
    const p = pmiPresentation(file, 1);
    expect(performance.now() - start).toBeLessThan(1500);
    expect(p.callouts).toHaveLength(n);
    expect(p.callouts.every((c) => c.unsupported === 'presentation-budget')).toBe(true);
    expect(p.callouts[0]!.occurrences).toEqual([2]);
  });

  it('makes the callouts of cameras in the same models once', () => {
    // 1,000 cameras in two models that share 1,000 callouts: one union, not one per camera.
    const ids = (from: number) => Array.from({ length: 1000 }, (_, i) => `#${from + i}`);
    const listed = [...ids(10_000), ...ids(20_000)].join(',');
    const p = pmiPresentation(
      read(
        text(`${ids(10_000)
          .map((c) => `${c} = DRAUGHTING_CALLOUT('c',(#2));`)
          .join('\n')}
#2 = ANNOTATION_PLACEHOLDER_OCCURRENCE('',(),$,$,$,$);
${ids(20_000)
  .map((c) => `${c} = CAMERA_MODEL_D3('v',$,$);`)
  .join('\n')}
#80 = ( DRAUGHTING_MODEL() REPRESENTATION('',(${listed}),#60) );
#81 = ( DRAUGHTING_MODEL() REPRESENTATION('',(${listed}),#61) );`),
      ),
      1,
    );
    expect(p.views).toHaveLength(1000);
    expect(p.views[0]!.callouts).toHaveLength(1000);
    expect(p.views.every((v) => v.callouts === p.views[0]!.callouts)).toBe(true);
  });

  it('finds each item’s entity in time linear in the items', () => {
    // 20,000 datums A on different faces, one signature: counting it for each would be
    // 800 million comparisons. A shared signature names no entity.
    const n = 20_000;
    const datums: PmiItemJson[] = Array.from({ length: n }, (_, i) => ({
      label: `d${i}`,
      name: 'A',
      object: true,
      targets: [{ label: `t${i}`, shape: 4, product: 'p', index: i + 1 }],
    }));
    const none = { dimension: [], 'geometric-tolerance': [], datum: [], 'datum-target': [] };
    const semantics = {
      dimensions: [],
      tolerances: [],
      datums: [],
      datumTargets: [],
      datumFeatures: [],
      systems: [],
      targets: { ...none, datum: datums.map(() => 'A|1') },
      entities: { ...none, datum: datums.map((_, i) => 1000 + i) },
    } as CadPmiSemantics;
    const start = performance.now();
    const verified = verifiedPmi({ dimensions: [], tolerances: [], datums, views: [] }, semantics);
    expect(performance.now() - start).toBeLessThan(1500);
    expect(verified.datums).toHaveLength(n);
    expect(verified.entityOf.size).toBe(0);
    // One datum: its entity.
    const one = verifiedPmi(
      { dimensions: [], tolerances: [], datums: datums.slice(0, 1), views: [] },
      { ...semantics, targets: { ...none, datum: ['A|1'] }, entities: { ...none, datum: [7] } },
    );
    expect([...one.entityOf.values()]).toEqual([7]);
  });

  it('reads a placement shared by many cameras once, and no oversized point', () => {
    // 2,000 cameras share one placement whose point lists 100,000 numbers.
    const coords = Array.from({ length: 100_000 }, () => '0.').join(',');
    const file = read(
      text(`${Array.from({ length: 2000 }, (_, i) => `#${10_000 + i} = CAMERA_MODEL_D3('v',#2,#4);`).join('\n')}
#2 = AXIS2_PLACEMENT_3D('',#3,$,$);
#3 = CARTESIAN_POINT('',(${coords}));
#4 = VIEW_VOLUME(.PARALLEL.,#3,0.,0.,.F.,0.,.F.,.F.,#5);
#5 = PLANAR_BOX('',10.,10.,#2);`),
    );
    const start = performance.now();
    const p = pmiPresentation(file, 1);
    expect(performance.now() - start).toBeLessThan(1500);
    expect(p.views.every((v) => v.unsupported === 'view reference system')).toBe(true);
  });

  it('does not read a long shared list whole for every item it places', () => {
    // 5,000 presented tolerances share a datum system of 5,000 compartments: 25 million
    // references if each item read the list whole.
    const n = 5000;
    const ids = (from: number) => Array.from({ length: n }, (_, i) => from + i);
    const file = read(
      text(`${ids(10_000)
        .map((c) => `#${c} = DRAUGHTING_CALLOUT('c',(#2));`)
        .join('\n')}
#2 = ANNOTATION_PLACEHOLDER_OCCURRENCE('',(),$,$,$,$);
#3 = DATUM_SYSTEM('',#70,.T.,(${ids(100_000)
        .map((d) => `#${d}`)
        .join(',')}));
#70 = SHAPE_ASPECT('','',$,.T.);
${ids(20_000)
  .map((t) => `#${t} = FLATNESS_TOLERANCE('','',$,#3);`)
  .join('\n')}
${ids(30_000)
  .map(
    (a, i) => `#${a} = DRAUGHTING_MODEL_ITEM_ASSOCIATION('','',#${20_000 + i},$,#${10_000 + i});`,
  )
  .join('\n')}`),
    );
    const start = performance.now();
    pmiPresentation(file, 1);
    expect(performance.now() - start).toBeLessThan(1500);
  });

  it('does not scan a shared coordinate list again for each triangulated leaf', () => {
    // 5,000 single-triangle sets share a 50,000-point list: 250 million checks if each
    // leaf scanned the list.
    const n = 5000;
    const points = Array.from({ length: 50_000 }, (_, i) => `(${i}.,0.,0.)`).join(',');
    const leaves = Array.from({ length: n }, (_, i) => 10_000 + i);
    const file = read(
      text(`#1 = DRAUGHTING_CALLOUT('c',(#2));
#2 = TESSELLATED_ANNOTATION_OCCURRENCE('',(),#3);
#3 = TESSELLATED_GEOMETRIC_SET('',(${leaves.map((l) => `#${l}`).join(',')}));
#4 = COORDINATES_LIST('',50000,(${points}));
${leaves.map((l) => `#${l} = TRIANGULATED_SURFACE_SET('',#4,0,(),(),((1,2,3)));`).join('\n')}`),
    );
    const start = performance.now();
    const p = pmiPresentation(file, 1);
    expect(performance.now() - start).toBeLessThan(1500);
    expect(p.callouts[0]!.unsupported).toBeUndefined();
    expect(p.callouts[0]!.segments).toHaveLength(n * 3 * 6);
  });

  it('counts every value it reads, not only references, to find an item’s product', () => {
    // 5,000 presented tolerances share a datum system holding 50,000 numbers.
    const n = 5000;
    const ids = (from: number) => Array.from({ length: n }, (_, i) => from + i);
    const numbers = Array.from({ length: 50_000 }, (_, i) => i).join(',');
    const file = read(
      text(`${ids(10_000)
        .map((c) => `#${c} = DRAUGHTING_CALLOUT('c',(#2));`)
        .join('\n')}
#2 = ANNOTATION_PLACEHOLDER_OCCURRENCE('',(),$,$,$,$);
#3 = DATUM_SYSTEM('',#70,.T.,(${numbers}));
#70 = SHAPE_ASPECT('','',$,.T.);
${ids(20_000)
  .map((t) => `#${t} = FLATNESS_TOLERANCE('','',$,#3);`)
  .join('\n')}
${ids(30_000)
  .map(
    (a, i) => `#${a} = DRAUGHTING_MODEL_ITEM_ASSOCIATION('','',#${20_000 + i},$,#${10_000 + i});`,
  )
  .join('\n')}`),
    );
    const start = performance.now();
    pmiPresentation(file, 1);
    expect(performance.now() - start).toBeLessThan(1500);
  });

  it('leaves an item without a frame when its product search stops at a limit', () => {
    // The tolerance reaches product #50 first, then #51 through its datum system's #73 after
    // `filler` numbers. Past the per-item value limit, #51 is never read: #50 is not known
    // to be the only product.
    const at = (filler: number) =>
      pmiPresentation(
        read(
          text(`#1 = DRAUGHTING_CALLOUT('c',(#2));
#2 = ANNOTATION_PLACEHOLDER_OCCURRENCE('',(),$,$,$,$);
#50 = PRODUCT_DEFINITION('a','',#90,#91);
#51 = PRODUCT_DEFINITION('b','',#90,#91);
#52 = PRODUCT_DEFINITION_SHAPE('','',#50);
#53 = PRODUCT_DEFINITION_SHAPE('','',#51);
#3 = DATUM_SYSTEM('',$,.T.,(${[...Array.from({ length: filler }, (_, i) => i), '#73'].join(',')}));
#73 = SHAPE_ASPECT('','',#53,.T.);
#71 = FLATNESS_TOLERANCE('','',#52,#3);
#72 = DRAUGHTING_MODEL_ITEM_ASSOCIATION('','',#71,$,#1);`),
        ),
        1,
      ).itemFrame.get(71);
    // Both products read: ambiguous. Cut short: not the first product found either.
    expect(at(10)).toBeUndefined();
    expect(at(10_000)).toBeUndefined();
    // One product, read whole: its frame.
    const one = pmiPresentation(
      read(
        text(`#1 = DRAUGHTING_CALLOUT('c',(#2));
#2 = ANNOTATION_PLACEHOLDER_OCCURRENCE('',(),$,$,$,$);
#50 = PRODUCT_DEFINITION('a','',#90,#91);
#52 = PRODUCT_DEFINITION_SHAPE('','',#50);
#3 = DATUM_SYSTEM('',#70,.T.,(1,2,3));
#70 = SHAPE_ASPECT('','',#52,.T.);
#71 = FLATNESS_TOLERANCE('','',$,#3);
#72 = DRAUGHTING_MODEL_ITEM_ASSOCIATION('','',#71,$,#1);`),
      ),
      1,
    );
    expect(one.itemFrame.get(71)).toBe(50);
  });

  it('draws no point past the model’s coordinate range', () => {
    const p = pmiPresentation(
      read(
        text(`${set.replace('(1.,0.,0.)', '(1.E40,0.,0.)')}
#3 = TESSELLATED_GEOMETRIC_SET('',(#5));`),
      ),
      1,
    );
    expect(p.callouts[0]).toMatchObject({ unsupported: 'coordinate-range', segments: [] });
    // Nor any line of a callout whose annotation plane is placed past it.
    const plane = pmiPresentation(
      read(
        text(`${set}
#3 = TESSELLATED_GEOMETRIC_SET('',(#5));
#10 = ANNOTATION_PLANE('',(),#11,(#1));
#11 = PLANE('',#12);
#12 = AXIS2_PLACEMENT_3D('',#13,$,$);
#13 = CARTESIAN_POINT('',(1.E40,0.,0.));`),
      ),
      1,
    );
    expect(plane.callouts[0]).toMatchObject({ unsupported: 'coordinate-range', segments: [] });
  });

  it('counts the lines of discarded callouts against the work budget', () => {
    // 201 callouts share a 10,000-segment curve and each has a line it cannot read: each is
    // discarded, but making their lines is 4,020,000 vertices, past the work budget, so the
    // last, readable callout is not drawn either.
    const points = Array.from({ length: 10_001 }, (_, i) => `(${i}.,0.,0.)`).join(',');
    const strip = Array.from({ length: 10_001 }, (_, i) => i + 1).join(',');
    const bad = Array.from(
      { length: 201 },
      (_, i) => `#${1000 + i} = DRAUGHTING_CALLOUT('c',(#2,#7));`,
    );
    const p = pmiPresentation(
      read(
        text(`${bad.join('\n')}
#2 = TESSELLATED_ANNOTATION_OCCURRENCE('',(),#3);
#3 = TESSELLATED_GEOMETRIC_SET('',(#5));
#4 = COORDINATES_LIST('',10001,(${points}));
#5 = TESSELLATED_CURVE_SET('',#4,((${strip})));
#7 = ANNOTATION_CURVE_OCCURRENCE('',(),$);
#9000 = DRAUGHTING_CALLOUT('good',(#9001));
#9001 = TESSELLATED_ANNOTATION_OCCURRENCE('',(),#9003);
#9003 = TESSELLATED_GEOMETRIC_SET('',(#9005));
#9004 = COORDINATES_LIST('',2,((0.,0.,0.),(1.,0.,0.)));
#9005 = TESSELLATED_CURVE_SET('',#9004,((1,2)));`),
      ),
      1,
    );
    const reasons = p.callouts.map((c) => c.unsupported);
    expect(reasons[0]).toBe('ANNOTATION_CURVE_OCCURRENCE');
    expect(reasons.at(-1)).toBe('presentation-budget');
    expect(p.callouts.every((c) => c.segments.length === 0)).toBe(true);
  });

  it('stops walking nested sets past the visit budget, even when they draw nothing', () => {
    // Six layers of sets, each naming ten shared sets of the next layer, ending in anchors:
    // 1,111,111 visits from 63 entities and no lines.
    const layers = 6;
    const id = (layer: number, i: number) => 100 + layer * 10 + i;
    const lines: string[] = [];
    for (let l = 0; l < layers; l++)
      for (let i = 0; i < 10; i++) {
        const children = Array.from({ length: 10 }, (_, j) => `#${id(l + 1, j)}`).join(',');
        lines.push(`#${id(l, i)} = TESSELLATED_GEOMETRIC_SET('',(${children}));`);
      }
    for (let i = 0; i < 10; i++) lines.push(`#${id(layers, i)} = AXIS2_PLACEMENT_3D('',#99,$,$);`);
    const p = pmiPresentation(
      read(
        text(`#1 = DRAUGHTING_CALLOUT('c',(#2));
#2 = TESSELLATED_ANNOTATION_OCCURRENCE('',(),#${id(0, 0)});
#99 = CARTESIAN_POINT('',(0.,0.,0.));
${lines.join('\n')}`),
      ),
      1,
    );
    expect(p.callouts[0]).toMatchObject({ unsupported: 'presentation-budget', segments: [] });
  });

  it('decodes a coordinate list once however many occurrences share it', () => {
    // 1,000 occurrences of a two-point curve on a 50,000-point list: placing the whole list
    // for each would be 50 million points; only the two used points are placed each time.
    const points = Array.from({ length: 50_000 }, (_, i) => `(${i}.,0.,0.)`).join(',');
    const occurrences = Array.from({ length: 1000 }, (_, i) => `#${1000 + i}`);
    const file = read(
      text(`#1 = DRAUGHTING_CALLOUT('c',(${occurrences.join(',')}));
${occurrences.map((o) => `${o} = TESSELLATED_ANNOTATION_OCCURRENCE('',(),#3);`).join('\n')}
#3 = TESSELLATED_GEOMETRIC_SET('',(#5));
#4 = COORDINATES_LIST('',50000,(${points}));
#5 = TESSELLATED_CURVE_SET('',#4,((7,50000)));`),
    );
    const start = performance.now();
    const p = pmiPresentation(file, 1);
    expect(performance.now() - start).toBeLessThan(1500);
    expect(p.callouts[0]!.unsupported).toBeUndefined();
    expect(p.callouts[0]!.segments).toHaveLength(1000 * 6);
    expect(p.callouts[0]!.segments.slice(0, 6)).toEqual([6, 0, 0, 49_999, 0, 0]);
  });
});
