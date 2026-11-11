import {
  cadSpotWeldLimits,
  cadToleranceSets,
  emptyCad,
  identityQuaternion,
  mm,
  cadPanelGapDefaultMm,
  position,
  type CadDocument,
  type CadFeature,
  type CadKernelProfile,
  type CadSpotWeld,
  type CadTrimTool,
  type Length,
  type Quaternion,
  type Vec3,
} from './model';
import type { CadProfileKind } from './profile-section';
import { applyCadOperation, type CadNewBody } from './operations';
import { parseExpression, type CadExpression } from './expression';
import {
  splineThrough,
  type CadSketch,
  type CadSketchConstraint,
  type CadSketchRegion,
} from './sketch';
import { edgeName, type CadFaceName, type CadTopologyRef } from './topology';

/** Placeholder evaluator identity for fixtures until the kernel gate pins a real build. */
export const fixtureKernel: Pick<CadKernelProfile, 'id' | 'buildHash'> = {
  id: 'fixture-kernel',
  buildHash: `sha256:${'0'.repeat(64)}`,
};
const grey = { color: '#9aa4b1', opacity: 1 };
const body = (id: string, sourceFeatureId: string): CadNewBody => ({
  id,
  name: id,
  sourceFeatureId,
  placementFeatureId: `${id}-placement`,
  appearance: grey,
});

/** F01: empty document. */
export const f01Empty = (): CadDocument => emptyCad(fixtureKernel);

/**
 * F02: 80×50×5 mm plate with an r=5 through-hole (tool extends 1 mm beyond each face),
 * hole centre y=25 and x bound by `holeX`: centre `0.5W`, edge `W−10`, or literal 40.
 * Result: active body `plate`, consumed body `hole`.
 */
export function f02Plate(holeX: 'center' | 'edge' | 'literal' = 'center'): CadDocument {
  const x: Length =
    holeX === 'center'
      ? { affine: { parameterId: 'W', scale: 0.5, offsetMm: 0 } }
      : holeX === 'edge'
        ? { affine: { parameterId: 'W', scale: 1, offsetMm: -10 } }
        : mm(40);
  let doc = applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    parameters: [
      { id: 'W', name: 'Width', type: 'length', value: 80 },
      { id: 'H', name: 'Depth', type: 'length', value: 50 },
      { id: 'T', name: 'Thickness', type: 'length', value: 5 },
    ],
    profiles: [
      {
        id: 'plate-profile',
        name: 'Plate outline',
        plane: { origin: position(0, 0, 0), orientation: identityQuaternion() },
        shape: { type: 'rectangle', width: { parameterId: 'W' }, height: { parameterId: 'H' } },
      },
    ],
    features: [
      {
        id: 'plate-extrude',
        name: 'Plate',
        type: 'extrude',
        inputFeatureIds: [],
        args: { profileId: 'plate-profile', distance: { parameterId: 'T' }, direction: 1 },
      },
      {
        id: 'hole-cylinder',
        name: 'Hole tool',
        type: 'cylinder',
        inputFeatureIds: [],
        args: {
          radius: mm(5),
          height: { affine: { parameterId: 'T', scale: 1, offsetMm: 2 } },
          origin: [x, mm(25), mm(-1)],
          orientation: identityQuaternion(),
        },
      },
    ],
    bodies: [body('plate', 'plate-extrude'), body('hole', 'hole-cylinder')],
  });
  doc = applyCadOperation(doc, {
    type: 'booleanBodies',
    targetId: 'plate',
    toolId: 'hole',
    mode: 'cut',
    booleanFeatureId: 'plate-cut',
    placementFeatureId: 'plate-cut-placement',
  });
  return doc;
}
export const f02Volume = (width: number) => width * 50 * 5 - Math.PI * 5 * 5 * 5;

/** F03: rectangle r∈[10,15], z∈[0,20] on the XZ plane revolved 2π about Z. Volume 2,500π mm³. */
export const f03Revolve = (): CadDocument =>
  applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    profiles: [
      {
        id: 'ring-profile',
        name: 'Ring section',
        // +90° about X maps plane u/v to world X/Z.
        plane: { origin: position(10, 0, 0), orientation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] },
        shape: { type: 'rectangle', width: mm(5), height: mm(20) },
      },
    ],
    features: [
      {
        id: 'ring-revolve',
        name: 'Ring',
        type: 'revolve',
        inputFeatureIds: [],
        args: {
          profileId: 'ring-profile',
          axisOrigin: [mm(-10), mm(0)],
          axisDirection: [0, 1],
          angle: { literalRad: 2 * Math.PI },
        },
      },
    ],
    bodies: [body('ring', 'ring-revolve')],
  });

/** F05: one parameter drives two profiles/features of two bodies, plus a transform chain of `chain` links. */
export function f05Dependencies(chain = 4): CadDocument {
  const links = Array.from({ length: chain }, (_, i) => ({
    id: `link-${i}`,
    name: `Link ${i}`,
    type: 'transform' as const,
    inputFeatureIds: [i ? `link-${i - 1}` : 'post-a'] as [string],
    args: { translation: position(0, 0, 1), rotation: identityQuaternion() },
  }));
  return applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    parameters: [{ id: 'S', name: 'Size', type: 'length', value: 10 }],
    profiles: ['a', 'b'].map((k, i) => ({
      id: `profile-${k}`,
      name: `Profile ${k}`,
      plane: { origin: position(i * 40, 0, 0), orientation: identityQuaternion() },
      shape: { type: 'circle' as const, radius: { parameterId: 'S' } },
    })),
    features: [
      {
        id: 'post-a',
        name: 'Post A',
        type: 'extrude',
        inputFeatureIds: [],
        args: { profileId: 'profile-a', distance: { parameterId: 'S' }, direction: 1 },
      },
      {
        id: 'post-b',
        name: 'Post B',
        type: 'extrude',
        inputFeatureIds: [],
        args: { profileId: 'profile-b', distance: mm(5), direction: 1 },
      },
      ...links,
    ],
    bodies: [body('a', chain ? `link-${chain - 1}` : 'post-a'), body('b', 'post-b')],
  });
}

/** Expression from text whose names are the fixture's parameter IDs. */
export function fixtureExpression(text: string, ids: readonly string[]): CadExpression {
  const r = parseExpression(text, (name) => (ids.includes(name) ? name : undefined));
  if ('error' in r) throw new Error(`${r.error.code}@${r.error.at}`);
  return r.expression;
}
/**
 * F10 (r1-modeling.md): F02 at W = 100, with thickness `T = W / 20`, the
 * hole centred by `W / 2`, a margin `m = 10mm`, a count `n = 4` and the hole pitch
 * `(W − 2 × m) / (n − 1)`. Thickness 5, pitch 80 / 3; volume `f02Volume(100)`.
 */
export function f10Expressions(): CadDocument {
  let doc = applyCadOperation(f02Plate(), { type: 'setParameter', parameterId: 'W', value: 100 });
  const ids = ['W', 'H', 'T', 'm', 'n', 'pitch'];
  doc = applyCadOperation(doc, {
    type: 'setParameter',
    parameterId: 'T',
    expression: fixtureExpression('W / 20', ids),
  });
  doc = applyCadOperation(doc, {
    type: 'insertFeatures',
    parameters: [
      { id: 'm', name: 'Margin', type: 'length', value: 10 },
      { id: 'n', name: 'Holes', type: 'count', value: 4 },
      {
        id: 'pitch',
        name: 'Pitch',
        type: 'length',
        expression: fixtureExpression('(W − 2 × m) / (n − 1)', ids),
      },
    ],
    features: [],
  });
  const hole = doc.features.find((f) => f.id === 'hole-cylinder')!;
  if (hole.type !== 'cylinder') throw new Error('fixture');
  return applyCadOperation(doc, {
    type: 'updateFeature',
    featureId: hole.id,
    args: {
      ...hole.args,
      origin: [{ expression: fixtureExpression('W / 2', ids) }, mm(25), mm(-1)],
    },
  });
}

/**
 * F12 (r1-modeling.md), the R1b part: a W×60×H block (W = 100, H = 20) with two r = 6 holes cut
 * by two equal cylinders, `cyl-a` at x = 30 and `cyl-b` at x = 70, y = 30, one after the other.
 * `slot: true` adds a 10×20×30 box cut across the top +y edge at x = 45..55, which splits that
 * edge and the +y face in two. The fillets of F12 come with R1c.
 */
export function f12References(options: { slot?: boolean } = {}): CadDocument {
  const cylinder = (id: string, x: number): CadFeature => ({
    id,
    name: id,
    type: 'cylinder',
    inputFeatureIds: [],
    args: {
      radius: mm(6),
      height: { affine: { parameterId: 'H', scale: 1, offsetMm: 2 } },
      origin: [mm(x), mm(30), mm(-1)] as [Length, Length, Length],
      orientation: identityQuaternion(),
    },
  });
  let doc = applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    parameters: [
      { id: 'W', name: 'Width', type: 'length', value: 100 },
      { id: 'H', name: 'Height', type: 'length', value: 20 },
    ],
    features: [
      {
        id: 'block',
        name: 'Block',
        type: 'box',
        inputFeatureIds: [],
        args: {
          size: [{ parameterId: 'W' }, mm(60), { parameterId: 'H' }],
          origin: position(0, 0, 0),
          orientation: identityQuaternion(),
        },
      },
      cylinder('cyl-a', 30),
      cylinder('cyl-b', 70),
      ...(options.slot
        ? [
            {
              id: 'slot',
              name: 'Slot',
              type: 'box' as const,
              inputFeatureIds: [] as [],
              args: {
                size: [mm(10), mm(20), mm(30)] as [Length, Length, Length],
                origin: position(45, 50, 10),
                orientation: identityQuaternion(),
              },
            },
          ]
        : []),
    ],
    bodies: [
      body('part', 'block'),
      body('a', 'cyl-a'),
      body('b', 'cyl-b'),
      ...(options.slot ? [body('s', 'slot')] : []),
    ],
  });
  for (const tool of ['a', 'b', ...(options.slot ? ['s'] : [])])
    doc = applyCadOperation(doc, {
      type: 'booleanBodies',
      targetId: 'part',
      toolId: tool,
      mode: 'cut',
      booleanFeatureId: `cut-${tool}`,
      placementFeatureId: `cut-${tool}-placement`,
    });
  return doc;
}

/** Where the F12 slot cuts the block (`f12Fillet`). */
export type F12Slot = 'below' | 'split' | 'remove';
/**
 * The slot box's args: `below` notches the bottom of the +y side (the top edges stay whole),
 * `split` cuts down through the +y top edge (two edges of one name, ambiguous), `remove` trims
 * the whole +y side away (that face is gone, missing).
 */
export function f12SlotArgs(slot: F12Slot): Extract<CadFeature, { type: 'box' }>['args'] {
  const [size, origin]: [[number, number, number], [number, number, number]] =
    slot === 'below'
      ? [
          [10, 20, 10],
          [45, 50, -5],
        ]
      : slot === 'split'
        ? [
            [10, 20, 30],
            [45, 50, 10],
          ]
        : [
            [110, 20, 40],
            [-5, 50, -5],
          ];
  return {
    size: size.map((x) => mm(x)) as [Length, Length, Length],
    origin: position(...origin),
    orientation: identityQuaternion(),
  };
}
/** A stored edge reference on `featureId`'s output, named by its two faces. */
export const edgeRef = (
  featureId: string,
  a: CadFaceName,
  b: CadFaceName,
  centroid: [number, number, number],
  size: number,
): CadTopologyRef => ({ kind: 'edge', featureId, name: edgeName(a, b), hint: { centroid, size } });
/**
 * F12 (R1c, docs/cad/r1-modeling.md): a W×60×H block (W = 100, H = 20) cut by a slot tool, then
 * an R3 fillet on its four top edges, referenced by name on the cut's placement.
 */
export function f12Fillet(slot: F12Slot = 'below'): CadDocument {
  let doc = applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    parameters: [
      { id: 'W', name: 'Width', type: 'length', value: 100 },
      { id: 'H', name: 'Height', type: 'length', value: 20 },
    ],
    features: [
      {
        id: 'block',
        name: 'Block',
        type: 'box',
        inputFeatureIds: [],
        args: {
          size: [{ parameterId: 'W' }, mm(60), { parameterId: 'H' }],
          origin: position(0, 0, 0),
          orientation: identityQuaternion(),
        },
      },
      { id: 'slot', name: 'Slot', type: 'box', inputFeatureIds: [], args: f12SlotArgs(slot) },
    ],
    bodies: [body('part', 'block'), body('s', 'slot')],
  });
  doc = applyCadOperation(doc, {
    type: 'booleanBodies',
    targetId: 'part',
    toolId: 's',
    mode: 'cut',
    booleanFeatureId: 'cut-s',
    placementFeatureId: 'cut-s-placement',
  });
  const on = 'cut-s-placement';
  return applyCadOperation(doc, {
    type: 'detailBody',
    bodyId: 'part',
    placementFeatureId: 'fillet-placement',
    feature: {
      id: 'fillet',
      name: 'Top fillet',
      type: 'fillet',
      inputFeatureIds: [on],
      args: {
        radius: mm(3),
        edges: [
          edgeRef(on, ['+x'], ['+z'], [100, 30, 20], 60),
          edgeRef(on, ['-x'], ['+z'], [0, 30, 20], 60),
          edgeRef(on, ['+y'], ['+z'], [50, 60, 20], 100),
          edgeRef(on, ['-y'], ['+z'], [50, 0, 20], 100),
        ],
      },
    },
  });
}
/**
 * F12 (R1c): the block with two equal holes cut by one Boolean of two tools, and an R1 fillet on
 * the rim of hole `a` only. `tools` orders the Boolean's tools.
 */
export function f12Holes(tools: ('a' | 'b')[] = ['a', 'b']): CadDocument {
  const cylinder = (id: string, x: number): CadFeature => ({
    id,
    name: id,
    type: 'cylinder',
    inputFeatureIds: [],
    args: {
      radius: mm(6),
      height: { affine: { parameterId: 'H', scale: 1, offsetMm: 2 } },
      origin: [mm(x), mm(30), mm(-1)] as [Length, Length, Length],
      orientation: identityQuaternion(),
    },
  });
  let doc = applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    parameters: [
      { id: 'W', name: 'Width', type: 'length', value: 100 },
      { id: 'H', name: 'Height', type: 'length', value: 20 },
    ],
    features: [
      {
        id: 'block',
        name: 'Block',
        type: 'box',
        inputFeatureIds: [],
        args: {
          size: [{ parameterId: 'W' }, mm(60), { parameterId: 'H' }],
          origin: position(0, 0, 0),
          orientation: identityQuaternion(),
        },
      },
      cylinder('cyl-a', 30),
      cylinder('cyl-b', 70),
    ],
    bodies: [body('part', 'block'), body('a', 'cyl-a'), body('b', 'cyl-b')],
  });
  doc = applyCadOperation(doc, {
    type: 'booleanBodies',
    targetId: 'part',
    toolIds: tools,
    mode: 'cut',
    booleanFeatureId: 'holes',
    placementFeatureId: 'holes-placement',
  });
  const on = 'holes-placement';
  return applyCadOperation(doc, {
    type: 'detailBody',
    bodyId: 'part',
    placementFeatureId: 'rim-placement',
    feature: {
      id: 'rim',
      name: 'Rim fillet',
      type: 'fillet',
      inputFeatureIds: [on],
      args: {
        radius: mm(1),
        edges: [edgeRef(on, ['+z'], ['tool:a-placement', 'side'], [30, 30, 20], 2 * Math.PI * 6)],
      },
    },
  });
}

/** An extruded triangle (polyline v0–v2) with an R1 fillet on the top edge of side v0. */
export function polylineFillet(): CadDocument {
  const doc = applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    profiles: [
      {
        id: 'tri',
        name: 'Triangle',
        plane: { origin: position(0, 0, 0), orientation: identityQuaternion() },
        shape: {
          type: 'polyline',
          vertices: [
            [0, 0],
            [40, 0],
            [0, 30],
          ].map(([u, v], i) => ({ id: `v${i}`, u: mm(u!), v: mm(v!) })),
        },
      },
    ],
    features: [
      {
        id: 'slab-extrude',
        name: 'Slab',
        type: 'extrude',
        inputFeatureIds: [],
        args: { profileId: 'tri', distance: mm(10), direction: 1 },
      },
    ],
    bodies: [
      {
        id: 'slab',
        name: 'slab',
        sourceFeatureId: 'slab-extrude',
        placementFeatureId: 'slab-placement',
        appearance: { color: '#9aa4b1', opacity: 1 },
      },
    ],
  });
  return applyCadOperation(doc, {
    type: 'detailBody',
    bodyId: 'slab',
    placementFeatureId: 'round-placement',
    feature: {
      id: 'round',
      name: 'Round',
      type: 'fillet',
      inputFeatureIds: ['slab-placement'],
      args: {
        radius: mm(1),
        edges: [edgeRef('slab-placement', ['end'], ['side:v:v0'], [20, 0, 10], 40)],
      },
    },
  });
}

/** A stored face reference on `featureId`'s output. */
export const faceRef = (
  featureId: string,
  name: CadFaceName,
  centroid: [number, number, number],
  size: number,
): CadTopologyRef => ({ kind: 'face', featureId, name: [name], hint: { centroid, size } });
/**
 * F13 (R1c, docs/cad/r1-modeling.md): a 100×60×20 block whose four sides are drafted 3° from the
 * bottom face (pull +z), then shelled to a 2 mm wall inside with the top left open. `draft: false`
 * shells the plain block.
 */
export function f13ShellDraft(options: { draft?: boolean } = {}): CadDocument {
  let doc = applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    parameters: [{ id: 'T', name: 'Wall', type: 'length', value: 2 }],
    features: [
      {
        id: 'block',
        name: 'Block',
        type: 'box',
        inputFeatureIds: [],
        args: {
          size: [mm(100), mm(60), mm(20)],
          origin: position(0, 0, 0),
          orientation: identityQuaternion(),
        },
      },
    ],
    bodies: [body('part', 'block')],
  });
  let on = 'part-placement';
  if (options.draft !== false) {
    doc = applyCadOperation(doc, {
      type: 'detailBody',
      bodyId: 'part',
      placementFeatureId: 'draft-placement',
      feature: {
        id: 'draft',
        name: 'Side draft',
        type: 'draft',
        inputFeatureIds: [on],
        args: {
          faces: [
            faceRef(on, ['+x'], [100, 30, 10], 1200),
            faceRef(on, ['-x'], [0, 30, 10], 1200),
            faceRef(on, ['+y'], [50, 60, 10], 2000),
            faceRef(on, ['-y'], [50, 0, 10], 2000),
          ],
          neutral: faceRef(on, ['-z'], [50, 30, 0], 6000),
          angle: { literalRad: (3 * Math.PI) / 180 },
          direction: [0, 0, 1],
        },
      },
    });
    on = 'draft-placement';
  }
  return applyCadOperation(doc, {
    type: 'detailBody',
    bodyId: 'part',
    placementFeatureId: 'shell-placement',
    feature: {
      id: 'shell',
      name: 'Shell',
      type: 'shell',
      inputFeatureIds: [on],
      args: {
        openFaces: [faceRef(on, ['+z'], [50, 30, 20], 6000)],
        thickness: { parameterId: 'T' },
        side: 'inside',
      },
    },
  });
}

/**
 * F14 (R1c, docs/cad/r1-modeling.md): pattern and mirror. `linear`: a 120×40×5 plate with six
 * r4 holes in a row, count `n` and spacing `(W − 2 × m) / (n − 1)`. `circular`: a 100×100×5
 * plate with eight r3 holes on a 30 mm circle. `twice`: the linear row, then a second row from
 * another cylinder, and an R1 fillet on the rim of the second row's copy 1. `mirror`: a
 * 40×30×10 block mirrored in x = 0 and the result in y = 0, both unioned.
 */
export function f14Patterns(kind: 'linear' | 'circular' | 'twice' | 'mirror'): CadDocument {
  const cylinder = (id: string, radius: number, x: number, y: number): CadFeature => ({
    id,
    name: id,
    type: 'cylinder',
    inputFeatureIds: [],
    args: {
      radius: mm(radius),
      height: mm(7),
      origin: position(x, y, -1),
      orientation: identityQuaternion(),
    },
  });
  const plateBox = (w: Length, d: number, h: number): CadFeature => ({
    id: 'plate',
    name: 'Plate',
    type: 'box',
    inputFeatureIds: [],
    args: {
      size: [w, mm(d), mm(h)],
      origin: position(0, 0, 0),
      orientation: identityQuaternion(),
    },
  });
  if (kind === 'mirror') {
    let doc = applyCadOperation(f01Empty(), {
      type: 'insertFeatures',
      features: [{ ...plateBox(mm(40), 30, 10), id: 'block', name: 'Block' }],
      bodies: [body('part', 'block')],
    });
    for (const [id, on, normal] of [
      ['m1', 'part-placement', [1, 0, 0]],
      ['m2', 'm1-placement', [0, 1, 0]],
    ] as const)
      doc = applyCadOperation(doc, {
        type: 'detailBody',
        bodyId: 'part',
        placementFeatureId: `${id}-placement`,
        feature: {
          id,
          name: id,
          type: 'mirror',
          inputFeatureIds: [on],
          args: { plane: { origin: position(0, 0, 0), normal: [...normal] }, union: true },
        },
      });
    return doc;
  }
  const circular = kind === 'circular';
  let doc = applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    parameters: circular
      ? []
      : [
          { id: 'W', name: 'Width', type: 'length', value: 120 },
          { id: 'm', name: 'Margin', type: 'length', value: 10 },
          { id: 'n', name: 'Holes', type: 'count', value: 6 },
          ...(kind === 'twice'
            ? [{ id: 'n2', name: 'Second row', type: 'count' as const, value: 3 }]
            : []),
        ],
    features: [
      circular ? plateBox(mm(100), 100, 5) : plateBox({ parameterId: 'W' }, 40, 5),
      circular ? cylinder('cyl', 3, 80, 50) : cylinder('cyl', 4, 10, 12),
      ...(kind === 'twice' ? [cylinder('cyl-2', 4, 10, 28)] : []),
    ],
    bodies: [
      body('part', 'plate'),
      body('hole', 'cyl'),
      ...(kind === 'twice' ? [body('hole-2', 'cyl-2')] : []),
    ],
  });
  doc = applyCadOperation(doc, {
    type: 'patternBodies',
    targetId: 'part',
    toolId: 'hole',
    mode: 'cut',
    patternFeatureId: 'row',
    placementFeatureId: 'row-placement',
    layout: circular
      ? {
          type: 'circular',
          axisOrigin: position(50, 50, 0),
          axisDirection: [0, 0, 1],
          count: { literal: 8 },
          angle: { literalRad: Math.PI / 4 },
        }
      : {
          type: 'linear',
          direction: [1, 0, 0],
          count: { parameterId: 'n' },
          spacing: { expression: fixtureExpression('(W - 2 * m) / (n - 1)', ['W', 'm', 'n']) },
        },
  });
  if (kind !== 'twice') return doc;
  doc = applyCadOperation(doc, {
    type: 'patternBodies',
    targetId: 'part',
    toolId: 'hole-2',
    mode: 'cut',
    patternFeatureId: 'row-2',
    placementFeatureId: 'row-2-placement',
    layout: { type: 'linear', direction: [1, 0, 0], count: { parameterId: 'n2' }, spacing: mm(50) },
  });
  const on = 'row-2-placement';
  return applyCadOperation(doc, {
    type: 'detailBody',
    bodyId: 'part',
    placementFeatureId: 'rim-placement',
    feature: {
      id: 'rim',
      name: 'Rim fillet',
      type: 'fillet',
      inputFeatureIds: [on],
      args: {
        radius: mm(1),
        edges: [edgeRef(on, ['+z'], ['copy:row-2:1', 'side'], [60, 28, 5], 2 * Math.PI * 4)],
      },
    },
  });
}

const sketchPoints = (pts: Record<string, [number, number]>) =>
  Object.keys(pts).map((id) => ({ type: 'point' as const, id }));
/**
 * F11 (R1d, docs/cad/r1-modeling.md): the sketch of an L bracket, W × H with legs T thick, an
 * R10 arc in the inner corner and two r4 holes 10 mm in from the leg ends; fully constrained
 * (0 degrees of freedom). `solved` is a rough first guess for the solver. `redundant` adds a
 * width that the others already give, `conflict` the same width with another value.
 */
export function f11Sketch(variant: 'base' | 'redundant' | 'conflict' = 'base'): CadSketch {
  const guess: Record<string, [number, number]> = {
    p0: [0.5, -0.5],
    p1: [96, 2],
    p2: [97, 18],
    p3: [33, 21],
    c: [33, 33],
    p4: [21, 33],
    p5: [22, 77],
    p6: [-1, 78],
    q1: [77, 12],
    q2: [12, 57],
    h1: [3, 0],
    h2: [5, 0],
  };
  const v = (id: string) => ({ parameterId: id });
  const constraints: CadSketchConstraint[] = [
    { id: 'origin', type: 'fix', point: 'p0', at: [mm(0), mm(0)] },
    { id: 'base', type: 'horizontal', line: 'l0' },
    { id: 'end', type: 'vertical', line: 'l1' },
    { id: 'inner-h', type: 'horizontal', line: 'l2' },
    { id: 'inner-v', type: 'vertical', line: 'l3' },
    { id: 'top', type: 'horizontal', line: 'l4' },
    { id: 'back', type: 'vertical', line: 'l5' },
    { id: 'blend-h', type: 'tangent', a: 'l2', b: 'a0' },
    { id: 'blend-v', type: 'tangent', a: 'l3', b: 'a0' },
    { id: 'width', type: 'horizontalDistance', a: 'p0', b: 'p1', value: v('W') },
    { id: 'foot', type: 'verticalDistance', a: 'p1', b: 'p2', value: v('T') },
    { id: 'leg', type: 'horizontalDistance', a: 'p6', b: 'p5', value: v('T') },
    { id: 'height', type: 'verticalDistance', a: 'p0', b: 'p6', value: v('H') },
    { id: 'blend-r', type: 'radius', curve: 'a0', value: mm(10) },
    { id: 'hole-r', type: 'radius', curve: 'h1', value: mm(4) },
    { id: 'holes-equal', type: 'equal', a: 'h2', b: 'h1' },
    { id: 'hole-1-x', type: 'horizontalDistance', a: 'q1', b: 'p1', value: mm(20) },
    { id: 'hole-1-y', type: 'verticalDistance', a: 'p0', b: 'q1', value: mm(10) },
    { id: 'hole-2-x', type: 'horizontalDistance', a: 'p0', b: 'q2', value: mm(10) },
    { id: 'hole-2-y', type: 'verticalDistance', a: 'q2', b: 'p6', value: mm(20) },
  ];
  if (variant !== 'base')
    constraints.push({
      id: 'extra',
      type: 'horizontalDistance',
      a: 'p3',
      b: 'p2',
      value: mm(variant === 'redundant' ? 70 : 60),
    });
  const { h1: _h1, h2: _h2, ...points } = guess;
  return {
    id: 'bracket-sketch',
    name: 'Bracket',
    plane: { origin: position(0, 0, 0), orientation: identityQuaternion() },
    entities: [
      ...sketchPoints(points),
      { type: 'line', id: 'l0', start: 'p0', end: 'p1' },
      { type: 'line', id: 'l1', start: 'p1', end: 'p2' },
      { type: 'line', id: 'l2', start: 'p2', end: 'p3' },
      { type: 'arc', id: 'a0', center: 'c', start: 'p3', end: 'p4', clockwise: true },
      { type: 'line', id: 'l3', start: 'p4', end: 'p5' },
      { type: 'line', id: 'l4', start: 'p5', end: 'p6' },
      { type: 'line', id: 'l5', start: 'p6', end: 'p0' },
      { type: 'circle', id: 'h1', center: 'q1' },
      { type: 'circle', id: 'h2', center: 'q2' },
    ],
    constraints,
    solved: guess,
  };
}
/** F11 solved coordinates (W 100, H 80, T 20). */
export const f11Solution: Readonly<Record<string, [number, number]>> = Object.freeze({
  p0: [0, 0],
  p1: [100, 0],
  p2: [100, 20],
  p3: [30, 20],
  c: [30, 30],
  p4: [20, 30],
  p5: [20, 80],
  p6: [0, 80],
  q1: [80, 10],
  q2: [10, 60],
  h1: [4, 0],
  h2: [4, 0],
});
export const f11Region = (): CadSketchRegion => ({
  outer: ['l0', 'l1', 'l2', 'a0', 'l3', 'l4', 'l5'],
  holes: [['h1'], ['h2']],
});
/** F11 section area: the L, the material the inner arc adds, less the two holes. */
export const f11Area = (w = 100) => w * 20 + 20 * 60 + (100 - 25 * Math.PI) - 2 * 16 * Math.PI;
/**
 * F11 bracket: the sketch extruded 10 mm (`D`) into body `bracket`. `cycle` instead attaches the
 * sketch to the end face of its own extrude (a dependency cycle, refused at every entrance).
 */
export function f11Bracket(options: { cycle?: boolean } = {}): CadDocument {
  const doc = applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    parameters: [
      { id: 'W', name: 'Width', type: 'length', value: 100 },
      { id: 'H', name: 'Height', type: 'length', value: 80 },
      { id: 'T', name: 'Thickness', type: 'length', value: 20 },
      { id: 'D', name: 'Depth', type: 'length', value: 10 },
    ],
    sketches: [f11Sketch()],
    features: [
      {
        id: 'bracket-extrude',
        name: 'Bracket',
        type: 'extrude',
        inputFeatureIds: [],
        args: {
          sketchId: 'bracket-sketch',
          region: f11Region(),
          distance: { parameterId: 'D' },
          direction: 1,
        },
      },
    ],
    bodies: [body('bracket', 'bracket-extrude')],
  });
  if (!options.cycle) return doc;
  const cycle = structuredClone(doc) as CadDocument;
  cycle.sketches[0].plane = {
    face: faceRef('bracket-extrude', ['end'], [40, 30, 10], 3000),
    offset: mm(0),
  };
  return cycle;
}
/**
 * F11 on a plate: the bracket sketch attached to face `face` of a 140×120×`P` mm plate (`P` 10),
 * 0 mm off it, extruded 10 mm (`D`) outward into body `bracket` beside body `plate`.
 */
export function f11OnPlate(face: '+z' | '+y' = '+z'): CadDocument {
  const doc = f11Bracket();
  const plate = applyCadOperation(doc, {
    type: 'insertFeatures',
    parameters: [{ id: 'P', name: 'Plate', type: 'length', value: 10 }],
    features: [
      {
        id: 'plate-box',
        name: 'Plate',
        type: 'box',
        inputFeatureIds: [],
        args: {
          size: [mm(140), mm(120), { parameterId: 'P' }],
          origin: position(0, 0, 0),
          orientation: identityQuaternion(),
        },
      },
    ],
    bodies: [body('plate', 'plate-box')],
  });
  const out = structuredClone(plate) as CadDocument;
  out.sketches[0].plane = {
    face:
      face === '+z'
        ? faceRef('plate-placement', ['+z'], [70, 60, 10], 140 * 120)
        : faceRef('plate-placement', ['+y'], [70, 120, 5], 140 * 10),
    offset: mm(0),
  };
  return out;
}

/**
 * An unconstrained sketch of `entities` at `solved` on a datum plane (F15): every `solved` key
 * that is not an element (a circle's radius) is a point.
 */
function freeSketch(
  id: string,
  origin: [number, number, number],
  orientation: Quaternion,
  entities: CadSketch['entities'],
  solved: Record<string, [number, number]>,
): CadSketch {
  return {
    id,
    name: id,
    plane: { origin: position(...origin), orientation },
    entities: [
      ...sketchPoints(solved).filter((p) => !entities.some((e) => e.id === p.id)),
      ...entities,
    ],
    constraints: [],
    solved,
  };
}
/** A closed polygon of lines `l0…` through points `p0…` (F15). */
const polygon = (pts: [number, number][]) => ({
  entities: pts.map((_, i) => ({
    type: 'line' as const,
    id: `l${i}`,
    start: `p${i}`,
    end: `p${(i + 1) % pts.length}`,
  })),
  solved: Object.fromEntries(pts.map((p, i) => [`p${i}`, p])) as Record<string, [number, number]>,
});
/**
 * F15 loft (R1e, docs/cad/r1-modeling.md): from a 40 × 40 mm square on XY to, 50 mm above, a
 * circle of r15 (`circle`) or a 20 × 20 mm square (`square`, ruled: a frustum of
 * 50/3 × (1600 + 400 + 800) mm³) into body `loft`.
 */
export function f15Loft(top: 'circle' | 'square' = 'circle'): CadDocument {
  const base = polygon([
    [-20, -20],
    [20, -20],
    [20, 20],
    [-20, 20],
  ]);
  const upper =
    top === 'square'
      ? polygon([
          [-10, -10],
          [10, -10],
          [10, 10],
          [-10, 10],
        ])
      : {
          entities: [{ type: 'circle' as const, id: 'c0', center: 'o' }],
          solved: { o: [0, 0], c0: [15, 0] } as Record<string, [number, number]>,
        };
  const sketches = [
    freeSketch('loft-base', [0, 0, 0], identityQuaternion(), base.entities, base.solved),
    freeSketch('loft-top', [0, 0, 50], identityQuaternion(), upper.entities, upper.solved),
  ];
  return applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    sketches,
    features: [
      {
        id: 'loft-feature',
        name: 'Loft',
        type: 'loft',
        inputFeatureIds: [],
        args: {
          sections: [
            { sketchId: 'loft-base', region: { outer: ['l0', 'l1', 'l2', 'l3'], holes: [] } },
            {
              sketchId: 'loft-top',
              region: { outer: top === 'square' ? ['l0', 'l1', 'l2', 'l3'] : ['c0'], holes: [] },
            },
          ],
          ruled: top === 'square',
        },
      },
    ],
    bodies: [body('loft', 'loft-feature')],
  });
}
/**
 * F15 wing (ST-89): a swept wing of closed cubic-spline airfoils on XZ planes (normal −Y), ruled
 * through `five` sections (tip, kink, root, kink, tip at y = ±17,000, ±5,500 and 0 mm) into body
 * `wing`, or one `half` (root, kink, tip towards −Y): the five-section loft is the two halves.
 */
export function f15Wing(kind: 'five' | 'half' = 'five'): CadDocument {
  const airfoil = (chord: number, t: number, x0: number, z0: number) =>
    (
      [
        [1, 0],
        [0.7, 0.55 * t],
        [0.35, 0.8 * t],
        [0.08, 0.6 * t],
        [0, 0],
        [0.08, -0.45 * t],
        [0.35, -0.5 * t],
        [0.7, -0.25 * t],
      ] as const
    ).map(([u, v]) => [x0 + u * chord, z0 + v * chord] as [number, number]);
  // An airliner's wing in millimetres: the matching fails at this size, not at a hundredth of it.
  const root = airfoil(7000, 0.14, 0, 0);
  const kink = airfoil(4600, 0.12, 5500 * Math.tan(0.44), 5500 * 0.09);
  const tip = airfoil(1600, 0.1, 17000 * Math.tan((25 * Math.PI) / 180), 17000 * 0.09);
  const rows: [number, [number, number][]][] =
    kind === 'five'
      ? [
          [17000, tip],
          [5500, kink],
          [0, root],
          [-5500, kink],
          [-17000, tip],
        ]
      : [
          [0, root],
          [-5500, kink],
          [-17000, tip],
        ];
  const xz: Quaternion = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
  const sketches = rows.map(([y, pts], i) => {
    const solved = Object.fromEntries(pts.map((p, k) => [`p${k}`, p]));
    return freeSketch(
      `wing-s${i}`,
      [0, y, 0],
      xz,
      [{ type: 'spline', id: 's', poles: Object.keys(solved), degree: 3, closed: true }],
      solved,
    );
  });
  return applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    sketches,
    features: [
      {
        id: 'wing-loft',
        name: 'Wing loft',
        type: 'loft',
        inputFeatureIds: [],
        args: {
          sections: sketches.map((x) => ({ sketchId: x.id, region: { outer: ['s'], holes: [] } })),
          ruled: true,
        },
      },
    ],
    bodies: [body('wing', 'wing-loft')],
  });
}
/**
 * F15 canopy (ST-89#2): a car's glass canopy through five closed cubic spline sections on YZ
 * planes (u = Y, v = Z, normal +X), the first one flat (40 mm high, 1,600 mm wide). OCCT's wire
 * matching throws `BRepFill :: profiles are inconsistent` for it. `front`/`back`: sections 1–3 or
 * 3–5 only; ruled by default (then `five` is the two of them exactly).
 */
export function f15Canopy(kind: 'five' | 'front' | 'back' = 'five', ruled = true): CadDocument {
  // [x, half width, bottom, top, top width ratio] → eight poles around the section.
  const rows: [number, number, number, number, number][] = [
    [1500, 800, 760, 800, 0.9],
    [1900, 770, 760, 1080, 0.78],
    [2400, 700, 760, 1170, 0.72],
    [2950, 640, 760, 1040, 0.72],
    [3250, 560, 760, 880, 0.75],
  ];
  const section = ([, w, z0, z1, top]: (typeof rows)[number]): [number, number][] => [
    [0, z0],
    [w * 0.85, z0],
    [w, z0 + (z1 - z0) * 0.4],
    [w * top, z1],
    [0, z1 + (z1 - z0) * 0.04],
    [-w * top, z1],
    [-w, z0 + (z1 - z0) * 0.4],
    [-w * 0.85, z0],
  ];
  const chosen = kind === 'front' ? rows.slice(0, 3) : kind === 'back' ? rows.slice(2) : rows;
  const yz: Quaternion = [0.5, 0.5, 0.5, 0.5];
  const sketches = chosen.map((row, i) => {
    const solved = Object.fromEntries(section(row).map((p, k) => [`p${k}`, p]));
    return freeSketch(
      `canopy-s${i}`,
      [row[0], 0, 0],
      yz,
      [{ type: 'spline', id: 's', poles: Object.keys(solved), degree: 3, closed: true }],
      solved,
    );
  });
  return applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    sketches,
    features: [
      {
        id: 'canopy-loft',
        name: 'Canopy loft',
        type: 'loft',
        inputFeatureIds: [],
        args: {
          sections: sketches.map((x) => ({ sketchId: x.id, region: { outer: ['s'], holes: [] } })),
          ruled,
        },
      },
    ],
    bodies: [body('canopy', 'canopy-loft')],
  });
}
/**
 * F15 sweep: a circle of r5 on YZ (u = Y, v = Z, normal +X) carried along a path on XY, 50 mm
 * along +X and then a quarter turn of r30 about (50, 30), into body `pipe`. Volume by Pappus:
 * 25π × (50 + 15π) mm³.
 */
export function f15Sweep(orientation: 'frenet' | 'fixed' = 'frenet'): CadDocument {
  const profile: CadSketch = {
    id: 'pipe-profile',
    name: 'Profile',
    plane: { origin: position(0, 0, 0), orientation: [0.5, 0.5, 0.5, 0.5] },
    entities: [
      { type: 'point', id: 'o' },
      { type: 'circle', id: 'c0', center: 'o' },
    ],
    constraints: [],
    solved: { o: [0, 0], c0: [5, 0] },
  };
  const path: CadSketch = {
    id: 'pipe-path',
    name: 'Path',
    plane: { origin: position(0, 0, 0), orientation: identityQuaternion() },
    entities: [
      ...sketchPoints({ p0: [0, 0], p1: [50, 0], c: [50, 30], p2: [80, 30] }),
      { type: 'line', id: 'l0', start: 'p0', end: 'p1' },
      { type: 'arc', id: 'a0', center: 'c', start: 'p1', end: 'p2', clockwise: false },
    ],
    constraints: [],
    solved: { p0: [0, 0], p1: [50, 0], c: [50, 30], p2: [80, 30] },
  };
  return applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    sketches: [profile, path],
    features: [
      {
        id: 'pipe-sweep',
        name: 'Pipe',
        type: 'sweep',
        inputFeatureIds: [],
        args: {
          profile: { sketchId: 'pipe-profile', region: { outer: ['c0'], holes: [] } },
          path: { sketchId: 'pipe-path', elements: ['l0', 'a0'] },
          orientation,
        },
      },
    ],
    bodies: [body('pipe', 'pipe-sweep')],
  });
}

/**
 * The R1 housing (docs/cad/r1-modeling.md, 代表操作2; R1 acceptance, CAD37): a W×60×20 block
 * (W = 100), an R3 fillet on its four top edges, then a shell open at the bottom with the wall
 * `T = W / 50` (2 mm at W = 100). Changing W moves the fillet and the shell with it.
 */
export function r1Housing(): CadDocument {
  let doc = applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    parameters: [
      { id: 'W', name: 'Width', type: 'length', value: 100 },
      { id: 'T', name: 'Wall', type: 'length', expression: fixtureExpression('W / 50', ['W']) },
    ],
    features: [
      {
        id: 'block',
        name: 'Block',
        type: 'box',
        inputFeatureIds: [],
        args: {
          size: [{ parameterId: 'W' }, mm(60), mm(20)],
          origin: position(0, 0, 0),
          orientation: identityQuaternion(),
        },
      },
    ],
    bodies: [body('part', 'block')],
  });
  const on = 'part-placement';
  doc = applyCadOperation(doc, {
    type: 'detailBody',
    bodyId: 'part',
    placementFeatureId: 'fillet-placement',
    feature: {
      id: 'fillet',
      name: 'Top fillet',
      type: 'fillet',
      inputFeatureIds: [on],
      args: {
        radius: mm(3),
        edges: [
          edgeRef(on, ['+x'], ['+z'], [100, 30, 20], 60),
          edgeRef(on, ['-x'], ['+z'], [0, 30, 20], 60),
          edgeRef(on, ['+y'], ['+z'], [50, 60, 20], 100),
          edgeRef(on, ['-y'], ['+z'], [50, 0, 20], 100),
        ],
      },
    },
  });
  return applyCadOperation(doc, {
    type: 'detailBody',
    bodyId: 'part',
    placementFeatureId: 'shell-placement',
    feature: {
      id: 'shell',
      name: 'Shell',
      type: 'shell',
      inputFeatureIds: ['fillet-placement'],
      args: {
        openFaces: [faceRef('fillet-placement', ['-z'], [50, 30, 0], 6000)],
        thickness: { parameterId: 'T' },
        side: 'inside',
      },
    },
  });
}

/**
 * F17 sheets for R2a-1 (docs/cad/r2a-freeform.md, Fixture): `extrude` carries an open line and
 * quarter arc (40 mm and r = 20 mm) up by the parameter H = 30 mm, area (40 + 10π) × H;
 * `closed` carries a closed 40 × 40 mm square up by 20 mm (an open-ended tube, area 3,200 mm²);
 * `revolve` turns a 30 mm line at r = 10 mm and a quarter arc reaching the axis a full turn
 * about the v axis, a cylinder with a hemispherical cap (area 600π + 200π mm²).
 */
export function f17Sheets(kind: 'extrude' | 'closed' | 'revolve'): CadDocument {
  const points: Record<string, [number, number]> =
    kind === 'extrude'
      ? { p0: [0, 0], p1: [40, 0], c: [40, 20], p2: [60, 20] }
      : kind === 'closed'
        ? { p0: [0, 0], p1: [40, 0], p2: [40, 40], p3: [0, 40] }
        : { p0: [10, 0], p1: [10, 30], c: [0, 30], p2: [0, 40] };
  const entities: CadSketch['entities'] =
    kind === 'closed'
      ? [
          { type: 'line', id: 'l0', start: 'p0', end: 'p1' },
          { type: 'line', id: 'l1', start: 'p1', end: 'p2' },
          { type: 'line', id: 'l2', start: 'p2', end: 'p3' },
          { type: 'line', id: 'l3', start: 'p3', end: 'p0' },
        ]
      : [
          { type: 'line', id: 'l0', start: 'p0', end: 'p1' },
          { type: 'arc', id: 'a0', center: 'c', start: 'p1', end: 'p2', clockwise: false },
        ];
  const chain: CadSketch = {
    id: 'chain',
    name: 'Chain',
    plane: { origin: position(0, 0, 0), orientation: identityQuaternion() },
    entities: [...sketchPoints(points), ...entities],
    constraints: [],
    solved: points,
  };
  const elements = entities.map((e) => e.id);
  const feature: CadFeature =
    kind === 'revolve'
      ? {
          id: 'sheet',
          name: 'Dome',
          type: 'revolveSurface',
          inputFeatureIds: [],
          args: {
            path: { sketchId: 'chain', elements },
            axisOrigin: [mm(0), mm(0)],
            axisDirection: [0, 1],
            angle: { literalRad: 2 * Math.PI },
          },
        }
      : {
          id: 'sheet',
          name: kind === 'closed' ? 'Tube' : 'Wall',
          type: 'extrudeSurface',
          inputFeatureIds: [],
          args: {
            path: { sketchId: 'chain', elements },
            distance: kind === 'extrude' ? { parameterId: 'H' } : mm(20),
            direction: 1,
          },
        };
  return applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    parameters: kind === 'extrude' ? [{ id: 'H', name: 'Height', type: 'length', value: 30 }] : [],
    sketches: [chain],
    features: [feature],
    bodies: [body('surface', 'sheet')],
  });
}

/**
 * F17 surfaces for R2a-2b (docs/cad/r2a-freeform.md, Fixture). `loft` passes a sheet through the
 * F16 spline (`curve`, elements `sp`) and a lower hump (`upper`, element `sq`) on a plane the
 * parameter H = 40 mm above it, both from (0, 0) to (80, 0) (area `f17LoftReference`); `closed`
 * rules a sheet from a 40 mm square to a centred 20 mm square 30 mm above (four trapezoids,
 * 120√1000 mm²); `sweep` carries an open chain in the XZ plane, 20 mm up from (50, 0, 0) and
 * 10 mm out, a quarter turn about the Z axis along an arc of r = 50 mm with `frenet` (a cylinder
 * piece and an annulus piece, 500π + 275π mm²).
 */
export function f17Surfaces(kind: 'loft' | 'closed' | 'sweep'): CadDocument {
  const xz: Quaternion = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
  const sketch = (
    id: string,
    points: Record<string, [number, number]>,
    entities: CadSketch['entities'],
    plane: CadSketch['plane'] = { origin: position(0, 0, 0), orientation: identityQuaternion() },
  ): CadSketch => ({
    id,
    name: id,
    plane,
    entities: [...sketchPoints(points), ...entities],
    constraints: [],
    solved: points,
  });
  const square = (id: string, a: number, b: number, z: number) =>
    sketch(
      id,
      { [`${id}0`]: [a, a], [`${id}1`]: [b, a], [`${id}2`]: [b, b], [`${id}3`]: [a, b] },
      [0, 1, 2, 3].map((i) => ({
        type: 'line' as const,
        id: `${id}-l${i}`,
        start: `${id}${i}`,
        end: `${id}${(i + 1) % 4}`,
      })),
      { origin: position(0, 0, z), orientation: identityQuaternion() },
    );
  let sketches: CadSketch[];
  let feature: CadFeature;
  if (kind === 'loft') {
    const upper = sketch(
      'upper',
      { q0: [0, 0], q1: [20, 10], q2: [40, 10], q3: [60, 10], q4: [80, 0] },
      [{ type: 'spline', id: 'sq', poles: ['q0', 'q1', 'q2', 'q3', 'q4'], degree: 3 }],
      { origin: [mm(0), mm(0), { parameterId: 'H' }], orientation: identityQuaternion() },
    );
    sketches = [f16Sketch(), upper];
    feature = {
      id: 'sheet',
      name: 'Hood',
      type: 'surfaceLoft',
      inputFeatureIds: [],
      args: {
        sections: [
          { sketchId: 'curve', elements: ['sp'] },
          { sketchId: 'upper', elements: ['sq'] },
        ],
        ruled: false,
      },
    };
  } else if (kind === 'closed') {
    sketches = [square('a', 0, 40, 0), square('b', 10, 30, 30)];
    feature = {
      id: 'sheet',
      name: 'Funnel',
      type: 'surfaceLoft',
      inputFeatureIds: [],
      args: {
        sections: [
          { sketchId: 'a', elements: ['a-l0', 'a-l1', 'a-l2', 'a-l3'] },
          { sketchId: 'b', elements: ['b-l0', 'b-l1', 'b-l2', 'b-l3'] },
        ],
        ruled: true,
      },
    };
  } else {
    sketches = [
      sketch(
        'profile',
        { p0: [50, 0], p1: [50, 20], p2: [60, 20] },
        [
          { type: 'line', id: 'l0', start: 'p0', end: 'p1' },
          { type: 'line', id: 'l1', start: 'p1', end: 'p2' },
        ],
        { origin: position(0, 0, 0), orientation: xz },
      ),
      sketch('rail', { o: [0, 0], s: [50, 0], e: [0, 50] }, [
        { type: 'arc', id: 'turn', center: 'o', start: 's', end: 'e', clockwise: false },
      ]),
    ];
    feature = {
      id: 'sheet',
      name: 'Gutter',
      type: 'surfaceSweep',
      inputFeatureIds: [],
      args: {
        profile: { sketchId: 'profile', elements: ['l0', 'l1'] },
        path: { sketchId: 'rail', elements: ['turn'] },
        orientation: 'frenet',
      },
    };
  }
  return applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    parameters:
      kind === 'loft'
        ? [
            { id: 'L', name: 'Reach', type: 'length', value: 20 },
            { id: 'H', name: 'Height', type: 'length', value: 40 },
          ]
        : [],
    sketches,
    features: [feature],
    bodies: [body('surface', 'sheet')],
  });
}
/**
 * The F17 loft's reference values for height `h`, apart from the kernel: the sheet joins the two
 * curves straight across at equal parameters (a loft through two sections), so its area is
 * ∫∫ |S_t × S_v| by Gauss–Legendre (128 pieces along, 8 across); `lengths` are the two curves'.
 */
export function f17LoftReference(h = 40): { area: number; lengths: [number, number] } {
  const a = cubicCurve([
    [0, 0],
    [20, 0],
    [40, 30],
    [60, 0],
    [80, 0],
  ]);
  const b = cubicCurve([
    [0, 0],
    [20, 10],
    [40, 10],
    [60, 10],
    [80, 0],
  ]);
  let area = 0;
  const lengths: [number, number] = [0, 0];
  for (const [t, w] of gaussPieces(0, 2, 128)) {
    const [pa, pb, da, db] = [a.point(t), b.point(t), a.tangent(t), b.tangent(t)];
    lengths[0] += w * Math.hypot(...da);
    lengths[1] += w * Math.hypot(...db);
    const sv = [pb[0] - pa[0], pb[1] - pa[1], h];
    for (const [v, wv] of gaussPieces(0, 1, 8)) {
      const st = [(1 - v) * da[0] + v * db[0], (1 - v) * da[1] + v * db[1], 0];
      const n = [
        st[1]! * sv[2]! - st[2]! * sv[1]!,
        st[2]! * sv[0]! - st[0]! * sv[2]!,
        st[0]! * sv[1]! - st[1]! * sv[0]!,
      ];
      area += w * wv * Math.hypot(...n);
    }
  }
  return { area, lengths };
}

/**
 * F17 boundary surfaces and fills for R2a-2c (docs/cad/r2a-freeform.md, Fixture). `hypar` spans
 * four lines of three sketches, (0, 0, 0) → (40, 0, 0) → (40, 40, 40) → (0, 40, 0) → back, by a
 * Coons patch: z = xy / 40 (area `f17HyparArea`). `quarter` spans a 40 mm line, a quarter arc of
 * r = 40 and a line back (400π mm²). `fill` fills a 40 mm square of lines (1,600 mm²). `cap`
 * adds the R2a-1 tube (`f17Sheets('closed')`) and fills its top opening from its four top edges
 * (`G0`, a 40 mm square at z = 20). `dome` rules a cone from a circle of four arcs (r = 20, z = 0)
 * to r = 10 at z = 10 (30π√200 mm²) and fills its top opening `G1` to it. `edgeLoft` lofts from
 * the tube's top edges to a centred 20 mm square 30 mm above (ruled, 120√1000 mm²).
 */
export function f17Boundaries(
  kind: 'hypar' | 'quarter' | 'fill' | 'cap' | 'dome' | 'edgeLoft',
): CadDocument {
  const plane = (origin: [number, number, number], orientation: Quaternion) => ({
    origin: position(...origin),
    orientation,
  });
  const lines = (
    id: string,
    points: Record<string, [number, number]>,
    segments: [string, string, string][],
    at: CadSketch['plane'],
  ): CadSketch => ({
    id,
    name: id,
    plane: at,
    entities: [
      ...sketchPoints(points),
      ...segments.map(([lid, a, b]) => ({ type: 'line' as const, id: lid, start: a, end: b })),
    ],
    constraints: [],
    solved: points,
  });
  const xy = plane([0, 0, 0], identityQuaternion());
  if (kind === 'dome') {
    // A circle of four quarter arcs about (20, 20), r = 20 at z = 0 and r = 10 at z = 10; each
    // arc has its own centre point (one shared centre would close a loop of equal radii).
    const ring = (id: string, r: number, z: number): CadSketch => {
      const points: Record<string, [number, number]> = {
        o0: [20, 20],
        o1: [20, 20],
        o2: [20, 20],
        o3: [20, 20],
        p0: [20 + r, 20],
        p1: [20, 20 + r],
        p2: [20 - r, 20],
        p3: [20, 20 - r],
      };
      return {
        id,
        name: id,
        plane: plane([0, 0, z], identityQuaternion()),
        entities: [
          ...sketchPoints(points),
          ...[0, 1, 2, 3].map((i) => ({
            type: 'arc' as const,
            id: `a${i}`,
            center: `o${i}`,
            start: `p${i}`,
            end: `p${(i + 1) % 4}`,
            clockwise: false,
          })),
        ],
        constraints: [],
        solved: points,
      };
    };
    const arcs = ['a0', 'a1', 'a2', 'a3'];
    const top = (i: number) => {
      const t = (Math.PI / 2) * (i + 0.5);
      const c = (2 * Math.SQRT2 * 10) / Math.PI;
      return edgeRef(
        'cone',
        [`side:e:a${i}`],
        ['end'],
        [20 + c * Math.cos(t), 20 + c * Math.sin(t), 10],
        5 * Math.PI,
      );
    };
    return applyCadOperation(f01Empty(), {
      type: 'insertFeatures',
      parameters: [],
      sketches: [ring('base', 20, 0), ring('top', 10, 10)],
      features: [
        {
          id: 'cone',
          name: 'Cone',
          type: 'surfaceLoft',
          inputFeatureIds: [],
          args: {
            sections: [
              { sketchId: 'base', elements: arcs },
              { sketchId: 'top', elements: arcs },
            ],
            ruled: true,
          },
        },
        {
          id: 'cap',
          name: 'Dome',
          type: 'fill',
          inputFeatureIds: [],
          args: {
            boundary: [0, 1, 2, 3].map((i) => ({
              curve: { edge: top(i) },
              continuity: 'G1' as const,
            })),
          },
        },
      ],
      bodies: [body('surface', 'cone'), body('cap-body', 'cap')],
    });
  }
  if (kind === 'cap' || kind === 'edgeLoft') {
    const tube = f17Sheets('closed');
    // The tube's top edges, each between its wall and the end it was swept to.
    const top = (i: number, centroid: [number, number, number]) =>
      edgeRef('surface-placement', [`side:e:l${i}`], ['end'], centroid, 40);
    const edges = [
      top(0, [20, 0, 20]),
      top(1, [40, 20, 20]),
      top(2, [20, 40, 20]),
      top(3, [0, 20, 20]),
    ];
    const feature: CadFeature =
      kind === 'edgeLoft'
        ? {
            id: 'cap',
            name: 'Funnel',
            type: 'surfaceLoft',
            inputFeatureIds: [],
            args: {
              sections: [{ edges }, { sketchId: 'small', elements: ['s0', 's1', 's2', 's3'] }],
              ruled: true,
            },
          }
        : {
            id: 'cap',
            name: 'Cap',
            type: 'fill',
            inputFeatureIds: [],
            args: {
              boundary: edges.map((edge) => ({
                curve: { edge },
                continuity: 'G0',
              })),
            },
          };
    return applyCadOperation(tube, {
      type: 'insertFeatures',
      sketches:
        kind === 'edgeLoft'
          ? [
              lines(
                'small',
                { q0: [10, 10], q1: [30, 10], q2: [30, 30], q3: [10, 30] },
                [
                  ['s0', 'q0', 'q1'],
                  ['s1', 'q1', 'q2'],
                  ['s2', 'q2', 'q3'],
                  ['s3', 'q3', 'q0'],
                ],
                plane([0, 0, 50], identityQuaternion()),
              ),
            ]
          : [],
      features: [feature],
      bodies: [body('cap-body', 'cap')],
    });
  }
  let sketches: CadSketch[];
  let feature: CadFeature;
  if (kind === 'hypar') {
    sketches = [
      lines(
        'floor',
        { a: [0, 0], b: [40, 0], d: [0, 40] },
        [
          ['ab', 'a', 'b'],
          ['da', 'd', 'a'],
        ],
        xy,
      ),
      // u along Y and v along Z on x = 40; u along X and v along Z on y = 40.
      lines(
        'east',
        { b: [0, 0], c: [40, 40] },
        [['bc', 'b', 'c']],
        plane([40, 0, 0], [0.5, 0.5, 0.5, 0.5]),
      ),
      lines(
        'north',
        { c: [40, 40], d: [0, 0] },
        [['cd', 'c', 'd']],
        plane([0, 40, 0], [Math.SQRT1_2, 0, 0, Math.SQRT1_2]),
      ),
    ];
    feature = {
      id: 'sheet',
      name: 'Saddle',
      type: 'boundarySurface',
      inputFeatureIds: [],
      args: {
        curves: [
          { sketchId: 'floor', element: 'ab' },
          { sketchId: 'east', element: 'bc' },
          { sketchId: 'north', element: 'cd' },
          { sketchId: 'floor', element: 'da' },
        ],
      },
    };
  } else if (kind === 'quarter') {
    sketches = [
      {
        id: 'floor',
        name: 'floor',
        plane: xy,
        entities: [
          ...sketchPoints({ o: [0, 0], a: [40, 0], b: [0, 40] }),
          { type: 'line', id: 'oa', start: 'o', end: 'a' },
          { type: 'arc', id: 'ab', center: 'o', start: 'a', end: 'b', clockwise: false },
          { type: 'line', id: 'bo', start: 'b', end: 'o' },
        ],
        constraints: [],
        solved: { o: [0, 0], a: [40, 0], b: [0, 40] },
      },
    ];
    feature = {
      id: 'sheet',
      name: 'Quarter',
      type: 'boundarySurface',
      inputFeatureIds: [],
      args: {
        curves: ['oa', 'ab', 'bo'].map((element) => ({ sketchId: 'floor', element })),
      },
    };
  } else {
    sketches = [
      lines(
        'floor',
        { a: [0, 0], b: [40, 0], c: [40, 40], d: [0, 40] },
        [
          ['ab', 'a', 'b'],
          ['bc', 'b', 'c'],
          ['cd', 'c', 'd'],
          ['da', 'd', 'a'],
        ],
        xy,
      ),
    ];
    feature = {
      id: 'sheet',
      name: 'Patch',
      type: 'fill',
      inputFeatureIds: [],
      args: {
        boundary: ['ab', 'bc', 'cd', 'da'].map((element) => ({
          curve: { sketchId: 'floor', element },
          continuity: 'G0' as const,
        })),
      },
    };
  }
  return applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    parameters: [],
    sketches,
    features: [feature],
    bodies: [body('surface', 'sheet')],
  });
}
/** The F17 hypar's area, ∫∫ √(1 + (x/40)² + (y/40)²) over the 40 mm square by Gauss–Legendre. */
export function f17HyparArea(): number {
  let area = 0;
  for (const [x, wx] of gaussPieces(0, 40, 32))
    for (const [y, wy] of gaussPieces(0, 40, 32))
      area += wx * wy * Math.sqrt(1 + (x / 40) ** 2 + (y / 40) ** 2);
  return area;
}

/**
 * F16 sketch for R2a-2 (docs/cad/r2a-freeform.md, Fixture): a cubic spline through five control
 * points from (0, 0) to (80, 0) over (40, 30), its ends held level by horizontal construction
 * lines to the second and fourth points (each `L` = 20 mm long, a parameter), fully constrained,
 * and a line `base` closing it. `crossing` moves the middle control points so the curve crosses
 * itself; `few` keeps three control points, too few for a cubic.
 */
export function f16Sketch(variant: 'base' | 'crossing' | 'few' = 'base'): CadSketch {
  // `crossing`: the curve runs right past its end, back over its start and down to the end.
  const pts: Record<string, [number, number]> =
    variant === 'crossing'
      ? { p0: [0, 0], p1: [120, 0], p2: [120, 60], p3: [-40, 60], p4: [40, 0] }
      : { p0: [0, 0], p1: [20, 0], p2: [40, 30], p3: [60, 0], p4: [80, 0] };
  const poles = variant === 'few' ? ['p0', 'p2', 'p4'] : ['p0', 'p1', 'p2', 'p3', 'p4'];
  const constraints: CadSketchConstraint[] =
    variant === 'base'
      ? [
          { id: 'start', type: 'fix', point: 'p0', at: [mm(0), mm(0)] },
          { id: 'top', type: 'fix', point: 'p2', at: [mm(40), mm(30)] },
          { id: 'end', type: 'fix', point: 'p4', at: [mm(80), mm(0)] },
          { id: 'level-start', type: 'horizontal', line: 't0' },
          { id: 'level-end', type: 'horizontal', line: 't1' },
          {
            id: 'reach-start',
            type: 'horizontalDistance',
            a: 'p0',
            b: 'p1',
            value: { parameterId: 'L' },
          },
          {
            id: 'reach-end',
            type: 'horizontalDistance',
            a: 'p3',
            b: 'p4',
            value: { parameterId: 'L' },
          },
        ]
      : [];
  return {
    id: 'curve',
    name: 'Curve',
    plane: { origin: position(0, 0, 0), orientation: identityQuaternion() },
    entities: [
      ...sketchPoints(pts),
      { type: 'spline', id: 'sp', poles, degree: 3 },
      { type: 'line', id: 'base', start: 'p4', end: 'p0' },
      { type: 'line', id: 't0', start: 'p0', end: 'p1', construction: true },
      { type: 'line', id: 't1', start: 'p3', end: 'p4', construction: true },
    ],
    constraints,
    solved: pts,
  };
}
/**
 * F16 document: the spline and `base` extruded 10 mm into the solid `hump`, and the spline alone
 * carried up 20 mm into the sheet `ribbon` (area: the curve's length × 20 mm).
 */
export function f16Spline(): CadDocument {
  return applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    parameters: [{ id: 'L', name: 'Reach', type: 'length', value: 20 }],
    sketches: [f16Sketch()],
    features: [
      {
        id: 'hump-extrude',
        name: 'Hump',
        type: 'extrude',
        inputFeatureIds: [],
        args: {
          sketchId: 'curve',
          region: { outer: ['sp', 'base'], holes: [] },
          distance: mm(10),
          direction: 1,
        },
      },
      {
        id: 'ribbon-surface',
        name: 'Ribbon',
        type: 'extrudeSurface',
        inputFeatureIds: [],
        args: { path: { sketchId: 'curve', elements: ['sp'] }, distance: mm(20), direction: 1 },
      },
    ],
    bodies: [body('hump', 'hump-extrude'), body('ribbon', 'ribbon-surface')],
  });
}
/**
 * F16 reference values for reach `L`, computed apart from the sketch code: the clamped cubic's
 * basis by the Cox–de Boor recursion, its derivative from the difference poles, and integrals by
 * 5-point Gauss–Legendre on 64 pieces per knot span. `length` is the curve's length, `area` what
 * it closes with `base`, and `tangents` its unit directions at the start and end.
 */
export function f16Reference(reach = 20): { length: number; area: number; tangents: [Pt2, Pt2] } {
  const curve = cubicCurve([
    [0, 0],
    [reach, 0],
    [40, 30],
    [80 - reach, 0],
    [80, 0],
  ]);
  let length = 0;
  let area = 0;
  for (const [t, w] of gaussPieces(0, 2, 128)) {
    const d = curve.tangent(t);
    length += w * Math.hypot(d[0], d[1]);
    // Green: the area is ∮ x dy, and base (on v = 0) adds nothing.
    area += w * curve.point(t)[0] * d[1];
  }
  const unit = (v: Pt2): Pt2 => [v[0] / Math.hypot(...v), v[1] / Math.hypot(...v)];
  return {
    length,
    area: Math.abs(area),
    tangents: [unit(curve.tangent(0)), unit(curve.tangent(2))],
  };
}
/**
 * A clamped cubic through five poles on the knots 0, 0, 0, 0, 1, 2, 2, 2, 2, apart from the sketch
 * code: its basis by the Cox–de Boor recursion, and its derivative from the difference poles.
 */
function cubicCurve(poles: Pt2[]): { point(t: number): Pt2; tangent(t: number): Pt2 } {
  const p = 3;
  const knots = [0, 0, 0, 0, 1, 2, 2, 2, 2];
  const basis = (i: number, k: number, t: number, u: number[]): number => {
    if (k === 0) {
      const last = t === u[u.length - 1] && u[i]! < t && u[i + 1] === t;
      return (u[i]! <= t && t < u[i + 1]!) || last ? 1 : 0;
    }
    const a = u[i + k]! - u[i]!;
    const b = u[i + k + 1]! - u[i + 1]!;
    return (
      (a ? ((t - u[i]!) / a) * basis(i, k - 1, t, u) : 0) +
      (b ? ((u[i + k + 1]! - t) / b) * basis(i + 1, k - 1, t, u) : 0)
    );
  };
  // C'(t) = Σ Q_i N_{i,p−1}(t) on the knots without their ends, Q_i = p (P_{i+1} − P_i) / Δ.
  const q = poles.slice(1).map((b, i): Pt2 => {
    const d = (p / (knots[i + p + 1]! - knots[i + 1]!)) as number;
    return [d * (b[0] - poles[i]![0]), d * (b[1] - poles[i]![1])];
  });
  const inner = knots.slice(1, -1);
  const at = (pts: Pt2[], k: number, u: number[], t: number): Pt2 =>
    pts.reduce<Pt2>(
      (s, c, i) => {
        const n = basis(i, k, t, u);
        return [s[0] + n * c[0], s[1] + n * c[1]];
      },
      [0, 0],
    );
  return { point: (t) => at(poles, p, knots, t), tangent: (t) => at(q, p - 1, inner, t) };
}
/** 5-point Gauss–Legendre nodes and weights on `pieces` equal pieces of [a, b]. */
function gaussPieces(a: number, b: number, pieces: number): [number, number][] {
  const rule = [
    [0, 128 / 225],
    [Math.sqrt(5 - 2 * Math.sqrt(10 / 7)) / 3, (322 + 13 * Math.sqrt(70)) / 900],
    [Math.sqrt(5 + 2 * Math.sqrt(10 / 7)) / 3, (322 - 13 * Math.sqrt(70)) / 900],
  ].flatMap(([x, w]) =>
    x
      ? [
          [-x!, w!],
          [x!, w!],
        ]
      : [[x!, w!]],
  );
  const out: [number, number][] = [];
  for (let j = 0; j < pieces; j++) {
    const [t0, t1] = [a + ((b - a) * j) / pieces, a + ((b - a) * (j + 1)) / pieces];
    for (const [x, w] of rule)
      out.push([(t0 + t1) / 2 + ((t1 - t0) / 2) * x!, ((t1 - t0) / 2) * w!]);
  }
  return out;
}
type Pt2 = [number, number];

/**
 * F18 hood (R2a-3, docs/cad/r2a-freeform.md, Fixture): a strip of the cylinder r = 100 about the
 * Y axis, 60°–120° and 80 mm long, in three sheets: two boundary surfaces (`left` 100°–120°,
 * `right` 60°–80°, each from two arcs of the front and back sketches and two lines along Y) and
 * the `crown` between them, a fill G1 to both panels. `stage` adds, in order, the sew of the
 * three (tolerance 0.0001 mm), a window trim (the rectangle x ∈ [-15, 15], y ∈ [25, 55] of a
 * sketch at z = 0 cut along Z, keeping the outside) and a 1.5 mm thicken of the result towards its normal (`front`), which
 * faces the axis: the skin lies inside r = 100.
 */
export function f18Hood(stage: 'sheets' | 'sew' | 'trim' | 'thicken' = 'thicken'): CadDocument {
  const r = 100;
  const at = (deg: number): [number, number] => [
    r * Math.cos((deg * Math.PI) / 180),
    r * Math.sin((deg * Math.PI) / 180),
  ];
  // u along X and v along Z on y = 0 and y = 80.
  const xz = (y: number) => ({
    origin: position(0, y, 0),
    orientation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] as Quaternion,
  });
  const ring = (id: string, y: number): CadSketch => {
    const points: Record<string, [number, number]> = {
      oR: [0, 0],
      oC: [0, 0],
      oL: [0, 0],
      q60: at(60),
      q80: at(80),
      q100: at(100),
      q120: at(120),
    };
    const arc = (aid: string, center: string, start: string, end: string) => ({
      type: 'arc' as const,
      id: aid,
      center,
      start,
      end,
      clockwise: false,
    });
    return {
      id,
      name: id,
      plane: xz(y),
      entities: [
        ...sketchPoints(points),
        arc('aR', 'oR', 'q60', 'q80'),
        arc('aC', 'oC', 'q80', 'q100'),
        arc('aL', 'oL', 'q100', 'q120'),
      ],
      constraints: [],
      solved: points,
    };
  };
  // A line along Y at angle `deg`: u along Y and v along Z on x = r cos(deg).
  const rail = (deg: number): CadSketch => {
    const [x, z] = at(deg);
    const points: Record<string, [number, number]> = { s: [0, z], e: [80, z] };
    return {
      id: `rail${deg}`,
      name: `rail${deg}`,
      plane: { origin: position(x, 0, 0), orientation: [0.5, 0.5, 0.5, 0.5] },
      entities: [...sketchPoints(points), { type: 'line', id: 'l', start: 's', end: 'e' }],
      constraints: [],
      solved: points,
    };
  };
  const panel = (id: string, arc: string, a: number, b: number): CadFeature => ({
    id,
    name: id,
    type: 'boundarySurface',
    inputFeatureIds: [],
    args: {
      curves: [
        { sketchId: 'front', element: arc },
        { sketchId: `rail${b}`, element: 'l' },
        { sketchId: 'back', element: arc },
        { sketchId: `rail${a}`, element: 'l' },
      ],
    },
  });
  // The panel's edge along the rail at `deg`, between its face and that rail's boundary.
  const railEdge = (panelId: string, deg: number) => {
    const [x, z] = at(deg);
    return edgeRef(
      `${panelId}-placement`,
      ['surface'],
      [`sketch:rail${deg}`, 'boundary:e:l'],
      [x, 40, z],
      80,
    );
  };
  let doc = applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    sketches: [ring('front', 0), ring('back', 80), rail(60), rail(80), rail(100), rail(120)],
    features: [
      panel('left-panel', 'aL', 100, 120),
      panel('right-panel', 'aR', 60, 80),
      {
        id: 'crown-fill',
        name: 'crown',
        type: 'fill',
        inputFeatureIds: [],
        args: {
          boundary: [
            { curve: { sketchId: 'front', element: 'aC' }, continuity: 'G0' },
            { curve: { edge: railEdge('left', 100) }, continuity: 'G1' },
            { curve: { sketchId: 'back', element: 'aC' }, continuity: 'G0' },
            { curve: { edge: railEdge('right', 80) }, continuity: 'G1' },
          ],
        },
      },
    ],
    bodies: [body('left', 'left-panel'), body('right', 'right-panel'), body('crown', 'crown-fill')],
  });
  if (stage === 'sheets') return doc;
  doc = applyCadOperation(doc, {
    type: 'sewBodies',
    targetId: 'left',
    toolIds: ['crown', 'right'],
    toleranceMm: 0.0001,
    solid: false,
    sewFeatureId: 'sew',
    placementFeatureId: 'sew-placement',
  });
  if (stage === 'sew') return doc;
  const corners: Record<string, [number, number]> = {
    w0: [-15, 25],
    w1: [15, 25],
    w2: [15, 55],
    w3: [-15, 55],
  };
  doc = applyCadOperation(doc, {
    type: 'insertFeatures',
    features: [],
    sketches: [
      {
        id: 'window',
        name: 'Window',
        plane: { origin: position(0, 0, 0), orientation: identityQuaternion() },
        entities: [
          ...sketchPoints(corners),
          ...[0, 1, 2, 3].map((i) => ({
            type: 'line' as const,
            id: `e${i}`,
            start: `w${i}`,
            end: `w${(i + 1) % 4}`,
          })),
        ],
        constraints: [],
        solved: corners,
      },
    ],
  });
  doc = applyCadOperation(doc, {
    type: 'detailBody',
    bodyId: 'left',
    placementFeatureId: 'window-placement',
    feature: {
      id: 'window-cut',
      name: 'Window',
      type: 'trim',
      inputFeatureIds: ['sew-placement'],
      args: { tool: { sketchId: 'window', elements: ['e0', 'e1', 'e2', 'e3'] }, keep: 'outside' },
    },
  });
  if (stage === 'trim') return doc;
  return applyCadOperation(doc, {
    type: 'detailBody',
    bodyId: 'left',
    placementFeatureId: 'skin-placement',
    feature: {
      id: 'skin',
      name: 'Skin',
      type: 'thicken',
      inputFeatureIds: ['window-placement'],
      args: { thickness: mm(1.5), side: 'front' },
    },
  });
}
/** The F18 hood's area before the window: r × π/3 × 80 mm². */
export const f18HoodArea = (100 * Math.PI * 80) / 3;
/** The window's area on the cylinder: 2 r asin(15 / r) × 30 mm². */
export const f18WindowArea = 2 * 100 * Math.asin(15 / 100) * 30;
/**
 * The skin's volume: the 1.5 mm wall inside r = 100 over the hood's angle, less the window's
 * (its walls run along the normals, so the window keeps its angle 2 asin(0.15) at every radius).
 */
export const f18SkinVolume =
  ((100 ** 2 - 98.5 ** 2) / 2) * ((Math.PI / 3) * 80 - 2 * Math.asin(15 / 100) * 30);

/**
 * R3i-5 (docs/cad/r3-analysis.md, FX7): a sports car's bonnet skin, the sample of a shell study.
 * x runs forward from the windscreen (x = 0) to the nose (x = 1000), y across (±650) and z up.
 * The sheet is a boundary surface of four arcs: the rear edge crowned 60 mm above its ends at
 * z = 0, the nose 40 mm above its ends at z = −190, and each side bowed 40 mm up between them; it
 * is thickened `thicknessMm` (default 1, aluminium sheet) downward. Body `bonnet`.
 */
export function sportsCarBonnet(thicknessMm = 1): CadDocument {
  const half = 650;
  /** The arc through three points (u, v): its centre, and the points as given. */
  const through = (a: [number, number], m: [number, number], b: [number, number]) => {
    const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
    const sq = (p: [number, number]) => p[0] ** 2 + p[1] ** 2;
    const c: [number, number] = [
      (sq(a) * (m[1] - b[1]) + sq(m) * (b[1] - a[1]) + sq(b) * (a[1] - m[1])) / d,
      (sq(a) * (b[0] - m[0]) + sq(m) * (a[0] - b[0]) + sq(b) * (m[0] - a[0])) / d,
    ];
    return c;
  };
  // Each arc runs counter-clockwise in its sketch from `start` over the top to `end`.
  const arc = (
    id: string,
    plane: { origin: ReturnType<typeof position>; orientation: Quaternion },
    start: [number, number],
    top: [number, number],
    end: [number, number],
  ): CadSketch => {
    const points: Record<string, [number, number]> = {
      c: through(start, top, end),
      s: start,
      e: end,
    };
    return {
      id,
      name: id,
      plane,
      entities: [
        ...sketchPoints(points),
        { type: 'arc', id: 'a', center: 'c', start: 's', end: 'e', clockwise: false },
      ],
      constraints: [],
      solved: points,
    };
  };
  // u along Y and v along Z on x = const; u along X and v along Z on y = const.
  const across = (x: number) => ({
    origin: position(x, 0, 0),
    orientation: [0.5, 0.5, 0.5, 0.5] as Quaternion,
  });
  const along = (y: number) => ({
    origin: position(0, y, 0),
    orientation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] as Quaternion,
  });
  const nose = -190;
  const doc = applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    sketches: [
      arc('rear', across(0), [half, 0], [0, 60], [-half, 0]),
      arc('front', across(1000), [half, nose], [0, nose + 40], [-half, nose]),
      arc('left', along(-half), [1000, nose], [500, nose / 2 + 40], [0, 0]),
      arc('right', along(half), [1000, nose], [500, nose / 2 + 40], [0, 0]),
    ],
    features: [
      {
        id: 'skin-sheet',
        name: 'Bonnet sheet',
        type: 'boundarySurface',
        inputFeatureIds: [],
        args: {
          curves: ['rear', 'right', 'front', 'left'].map((sketchId) => ({
            sketchId,
            element: 'a',
          })),
        },
      },
    ],
    bodies: [{ ...body('bonnet', 'skin-sheet'), name: 'Bonnet' }],
  });
  return applyCadOperation(doc, {
    type: 'detailBody',
    bodyId: 'bonnet',
    placementFeatureId: 'skin-placement',
    feature: {
      id: 'skin',
      name: 'Skin',
      type: 'thicken',
      inputFeatureIds: ['bonnet-placement'],
      args: { thickness: mm(thicknessMm), side: 'back' },
    },
  });
}

/**
 * R3j-6 (docs/cad/r3-analysis.md, FX9): a sports car's body as plates and mounts, the sample of a
 * bonded study. x runs forward (0 to 2000), y across (±600) and z up. Each plate is a thin
 * extrude, its own body: the left and right fenders (side panels 2000 × 400, 1.2 mm, their inner
 * walls at y = ±598.8), and between them the floor (1.5 mm at z = 100), the roof (1.0 mm at
 * z = 398, x 300–1300) and the bonnet (0.8 mm at z = 300, x 1500–2000), whose side rims lie on
 * the fenders' inner walls. Four solid mounts (100 × 100 × 440) take the fenders' end rims at
 * x = 0 and x = 2000. Nothing overlaps; every joint is a rim on a face, so each is offered as a
 * bond. The roof is the first body.
 */
export function sportsCarBody(): CadDocument {
  const inner = 598.8;
  const plates: {
    id: string;
    name: string;
    origin: [number, number, number];
    size: [number, number];
    thickness: number;
    side?: boolean;
  }[] = [
    { id: 'roof', name: 'Roof', origin: [300, -inner, 398], size: [1000, 2 * inner], thickness: 1 },
    {
      id: 'bonnet',
      name: 'Bonnet',
      origin: [1500, -inner, 300],
      size: [500, 2 * inner],
      thickness: 0.8,
    },
    {
      id: 'floor',
      name: 'Floor',
      origin: [0, -inner, 100],
      size: [2000, 2 * inner],
      thickness: 1.5,
    },
    // u along X and v along Z; the extrude runs along −y.
    {
      id: 'fender-left',
      name: 'Left fender',
      origin: [0, -inner, 0],
      size: [2000, 400],
      thickness: 1.2,
      side: true,
    },
    {
      id: 'fender-right',
      name: 'Right fender',
      origin: [0, 600, 0],
      size: [2000, 400],
      thickness: 1.2,
      side: true,
    },
  ];
  const mounts: { id: string; name: string; x: number; y: number }[] = [
    { id: 'mount-rear-left', name: 'Rear left mount', x: -100, y: -650 },
    { id: 'mount-rear-right', name: 'Rear right mount', x: -100, y: 550 },
    { id: 'mount-front-left', name: 'Front left mount', x: 2000, y: -650 },
    { id: 'mount-front-right', name: 'Front right mount', x: 2000, y: 550 },
  ];
  const part = (
    id: string,
    name: string,
    origin: [number, number, number],
    size: [number, number],
    distance: number,
    orientation: Quaternion,
  ) => ({
    profile: {
      id: `${id}-profile`,
      name: `${name} outline`,
      plane: { origin: position(...origin), orientation },
      shape: { type: 'rectangle' as const, width: mm(size[0]), height: mm(size[1]) },
    },
    feature: {
      id: `${id}-extrude`,
      name,
      type: 'extrude' as const,
      inputFeatureIds: [] as [],
      args: { profileId: `${id}-profile`, distance: mm(distance), direction: 1 as const },
    },
    body: { ...body(id, `${id}-extrude`), name },
  });
  const parts = [
    ...plates.map((p) =>
      part(
        p.id,
        p.name,
        p.origin,
        p.size,
        p.thickness,
        p.side ? [Math.SQRT1_2, 0, 0, Math.SQRT1_2] : identityQuaternion(),
      ),
    ),
    ...mounts.map((m) =>
      part(m.id, m.name, [m.x, m.y, -20], [100, 100], 440, identityQuaternion()),
    ),
  ];
  return applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    profiles: parts.map((p) => p.profile),
    features: parts.map((p) => p.feature),
    bodies: parts.map((p) => p.body),
  });
}

/**
 * F18 sheets for R2a-3's refusals and exact values (docs/cad/r2a-freeform.md, CAD42). A `plate`
 * is the 40 mm square fill at z = 0 (f17Boundaries('fill')).
 * - `gap`: two 40 × 20 walls in the plane y = 0, the second `gap` mm past the first's end at
 *   x = 40, sewn with `toleranceMm` (the gap far past 1 mm: sheets apart).
 * - `box`: the 40 × 40 × 20 tube (f17Sheets('closed')) with fills over both ends, sewn into a
 *   solid; `open` leaves out the bottom fill.
 * - `trim`: the plate cut by `tool`: a circle r = 10 about (20, 20) (`circle`), the plane x = 20
 *   (`plane`), a wall across it at x = 20 (`wall`), a wall half across it (`partial`), the plane
 *   x = 100 (`miss`); kept on `keep`.
 * - `thicken`: the plate or the tube (`tube`, creased) thickened `side`.
 */
export function f18Sheets(
  kind:
    | { kind: 'gap'; gap: number; toleranceMm: number }
    | { kind: 'box'; open?: boolean }
    | {
        kind: 'trim';
        tool: 'circle' | 'plane' | 'wall' | 'partial' | 'miss';
        keep: 'inside' | 'outside' | 'front' | 'back';
      }
    | { kind: 'thicken'; sheet: 'plate' | 'tube'; side: 'front' | 'back' | 'both' },
): CadDocument {
  const xy = (z: number) => ({ origin: position(0, 0, z), orientation: identityQuaternion() });
  const chain = (
    id: string,
    points: Record<string, [number, number]>,
    lines: [string, string, string][],
    z = 0,
  ): CadSketch => ({
    id,
    name: id,
    plane: xy(z),
    entities: [
      ...sketchPoints(points),
      ...lines.map(([lid, a, b]) => ({ type: 'line' as const, id: lid, start: a, end: b })),
    ],
    constraints: [],
    solved: points,
  });
  const wall = (id: string, sketchId: string, height: number): CadFeature => ({
    id,
    name: id,
    type: 'extrudeSurface',
    inputFeatureIds: [],
    args: { path: { sketchId, elements: ['l'] }, distance: mm(height), direction: 1 },
  });
  if (kind.kind === 'gap') {
    const g = kind.gap;
    const doc = applyCadOperation(f01Empty(), {
      type: 'insertFeatures',
      sketches: [
        chain('sa', { s: [0, 0], e: [40, 0] }, [['l', 's', 'e']]),
        chain('sb', { s: [40 + g, 0], e: [80, 0] }, [['l', 's', 'e']]),
      ],
      features: [wall('wa', 'sa', 20), wall('wb', 'sb', 20)],
      bodies: [body('a', 'wa'), body('b', 'wb')],
    });
    return applyCadOperation(doc, {
      type: 'sewBodies',
      targetId: 'a',
      toolIds: ['b'],
      toleranceMm: kind.toleranceMm,
      solid: false,
      sewFeatureId: 'sew',
      placementFeatureId: 'sew-placement',
    });
  }
  if (kind.kind === 'box') {
    let doc = f17Boundaries('cap');
    const bottom = (i: number, centroid: [number, number, number]) =>
      edgeRef('surface-placement', [`side:e:l${i}`], ['start'], centroid, 40);
    if (!kind.open)
      doc = applyCadOperation(doc, {
        type: 'insertFeatures',
        features: [
          {
            id: 'floor',
            name: 'Floor',
            type: 'fill',
            inputFeatureIds: [],
            args: {
              boundary: [
                bottom(0, [20, 0, 0]),
                bottom(1, [40, 20, 0]),
                bottom(2, [20, 40, 0]),
                bottom(3, [0, 20, 0]),
              ].map((edge) => ({ curve: { edge }, continuity: 'G0' as const })),
            },
          },
        ],
        bodies: [body('floor-body', 'floor')],
      });
    return applyCadOperation(doc, {
      type: 'sewBodies',
      targetId: 'surface',
      toolIds: kind.open ? ['cap-body'] : ['cap-body', 'floor-body'],
      toleranceMm: 0.0001,
      solid: true,
      sewFeatureId: 'sew',
      placementFeatureId: 'sew-placement',
    });
  }
  if (kind.kind === 'thicken') {
    const doc = kind.sheet === 'plate' ? f17Boundaries('fill') : f17Sheets('closed');
    return applyCadOperation(doc, {
      type: 'detailBody',
      bodyId: 'surface',
      placementFeatureId: 'skin-placement',
      feature: {
        id: 'skin',
        name: 'Skin',
        type: 'thicken',
        inputFeatureIds: ['surface-placement'],
        args: { thickness: mm(1.5), side: kind.side },
      },
    });
  }
  let doc = f17Boundaries('fill');
  const sketches: CadSketch[] = [];
  const features: CadFeature[] = [];
  const bodies: CadNewBody[] = [];
  let tool: CadTrimTool;
  if (kind.tool === 'circle') {
    const points: Record<string, [number, number]> = { o: [20, 20], p: [30, 20], q: [10, 20] };
    sketches.push({
      id: 'hole',
      name: 'hole',
      plane: xy(5),
      entities: [
        ...sketchPoints(points),
        { type: 'arc', id: 'a0', center: 'o', start: 'p', end: 'q', clockwise: false },
        { type: 'arc', id: 'a1', center: 'o', start: 'q', end: 'p', clockwise: false },
      ],
      constraints: [],
      solved: points,
    });
    tool = { sketchId: 'hole', elements: ['a0', 'a1'] };
  } else if (kind.tool === 'wall' || kind.tool === 'partial') {
    const end = kind.tool === 'wall' ? 50 : 20;
    sketches.push(chain('cutter', { s: [20, -10], e: [20, end] }, [['l', 's', 'e']], -10));
    features.push(wall('blade-wall', 'cutter', 20));
    bodies.push(body('blade', 'blade-wall'));
    tool = { featureId: 'blade-placement' };
  } else
    tool = {
      plane: { origin: position(kind.tool === 'miss' ? 100 : 20, 0, 0), normal: [1, 0, 0] },
    };
  if (sketches.length || features.length)
    doc = applyCadOperation(doc, { type: 'insertFeatures', sketches, features, bodies });
  return applyCadOperation(doc, {
    type: 'detailBody',
    bodyId: 'surface',
    placementFeatureId: 'cut-placement',
    feature: {
      id: 'cut',
      name: 'Cut',
      type: 'trim',
      inputFeatureIds: ['surface-placement'],
      args: { tool, keep: kind.keep },
    },
  });
}

/**
 * F18 seams for R2a-4's continuity check (docs/cad/r2a-freeform.md, CAD43): one sheet, an open
 * chain on the XY plane extruded 20 mm up (body `surface`), whose two faces meet at the edge
 * `[side:e:<first>, side:e:<second>]`. `bend` turns the second line by `angleDeg` at x = 40 (two
 * planes; 90° is a crease); `tangent` continues the line (0, 0)–(40, 0) into a quarter arc of
 * r = 20 (a plane meets a cylinder: G1, curvature 0 against 1/20); `smooth` is a half circle of
 * r = 20 in two quarter arcs (G2).
 */
export function f18Seams(
  kind: { kind: 'bend'; angleDeg: number } | { kind: 'tangent' } | { kind: 'smooth' },
): CadDocument {
  let points: Record<string, [number, number]>;
  let entities: CadSketch['entities'];
  if (kind.kind === 'bend') {
    const a = (kind.angleDeg * Math.PI) / 180;
    points = { p0: [0, 0], p1: [40, 0], p2: [40 + 40 * Math.cos(a), 40 * Math.sin(a)] };
    entities = [
      { type: 'line', id: 'l0', start: 'p0', end: 'p1' },
      { type: 'line', id: 'l1', start: 'p1', end: 'p2' },
    ];
  } else if (kind.kind === 'tangent') {
    points = { p0: [0, 0], p1: [40, 0], p2: [60, 20], c: [40, 20] };
    entities = [
      { type: 'line', id: 'l0', start: 'p0', end: 'p1' },
      { type: 'arc', id: 'a1', center: 'c', start: 'p1', end: 'p2', clockwise: false },
    ];
  } else {
    points = { p0: [20, 0], p1: [0, 20], p2: [-20, 0], c: [0, 0] };
    entities = [
      { type: 'arc', id: 'a0', center: 'c', start: 'p0', end: 'p1', clockwise: false },
      { type: 'arc', id: 'a1', center: 'c', start: 'p1', end: 'p2', clockwise: false },
    ];
  }
  const sketch: CadSketch = {
    id: 'seam',
    name: 'Seam',
    plane: { origin: position(0, 0, 0), orientation: identityQuaternion() },
    entities: [...sketchPoints(points), ...entities],
    constraints: [],
    solved: points,
  };
  return applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    sketches: [sketch],
    features: [
      {
        id: 'wall',
        name: 'Wall',
        type: 'extrudeSurface',
        inputFeatureIds: [],
        args: {
          path: { sketchId: 'seam', elements: entities.map((e) => e.id) },
          distance: mm(20),
          direction: 1,
        },
      },
    ],
    bodies: [body('surface', 'wall')],
  });
}

/**
 * F19 curve network for CR1d (docs/cad/car-design.md, CR1の分け方): a sphere of R = 100 about
 * (40, 40, −60) cut by the planes y = 0, 40, 80 (`u` arcs) and x = 0, 40, 80 (`v` arcs), each
 * arc from one side of the 80 mm square to the other over the top. The arcs cross exactly on the
 * sphere, so a Gordon surface through them stays near it (area `f19NetworkArea`). `gap` lifts
 * the middle `v` arc by 1 mm, so it misses the `u` arcs.
 */
export const f19NetworkSphere = { radius: 100, centre: [40, 40, -60] as const };
export function f19Network(
  kind: 'sphere' | 'gap' | 'thin' = 'sphere',
  toleranceMm = 0.01,
): CadDocument {
  if (kind === 'thin') return f19ThinNetwork(toleranceMm);
  const { radius: R, centre } = f19NetworkSphere;
  const arc = (id: string, offset: number, across: 'x' | 'y', lift: number): CadSketch => {
    // In its plane: u along the square's side, v up; the circle's centre is at (40, −60).
    const d = offset - 40;
    const r = Math.sqrt(R * R - d * d);
    const z = centre[2] + Math.sqrt(r * r - 40 * 40) + lift;
    const points: Record<string, [number, number]> = {
      o: [40, centre[2] + lift],
      a: [0, z],
      b: [80, z],
    };
    return {
      id,
      name: id,
      // y = offset: u → x, v → z. x = offset: u → y, v → z.
      plane:
        across === 'y'
          ? {
              origin: position(0, offset, 0),
              orientation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] as Quaternion,
            }
          : { origin: position(offset, 0, 0), orientation: [0.5, 0.5, 0.5, 0.5] as Quaternion },
      entities: [
        ...sketchPoints(points),
        { type: 'arc' as const, id: 'arc', center: 'o', start: 'a', end: 'b', clockwise: true },
      ],
      constraints: [],
      solved: points,
    };
  };
  const offsets = [0, 40, 80];
  const sketches = [
    ...offsets.map((y, i) => arc(`u${i}`, y, 'y', 0)),
    ...offsets.map((x, j) => arc(`v${j}`, x, 'x', kind === 'gap' && j === 1 ? 1 : 0)),
  ];
  return applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    parameters: [],
    sketches,
    features: [
      {
        id: 'net',
        name: 'Roof',
        type: 'curveNetwork',
        inputFeatureIds: [],
        args: {
          u: offsets.map((_, i) => ({ sketchId: `u${i}`, element: 'arc' })),
          v: offsets.map((_, j) => ({ sketchId: `v${j}`, element: 'arc' })),
          toleranceMm,
        },
      },
    ],
    bodies: [body('roof', 'net')],
  });
}

/**
 * F19 thin: a flat 100 × 0.02 mm strip spanned by two lines each way, its long sides closer than
 * four times the tolerance (each border must still keep its own name).
 */
function f19ThinNetwork(toleranceMm: number): CadDocument {
  const points: Record<string, [number, number]> = {
    a: [0, 0],
    b: [100, 0],
    c: [100, 0.02],
    d: [0, 0.02],
  };
  const sketch: CadSketch = {
    id: 'strip',
    name: 'strip',
    plane: { origin: position(0, 0, 0), orientation: identityQuaternion() },
    entities: [
      ...sketchPoints(points),
      { type: 'line', id: 'u0', start: 'a', end: 'b' },
      { type: 'line', id: 'u1', start: 'd', end: 'c' },
      { type: 'line', id: 'v0', start: 'a', end: 'd' },
      { type: 'line', id: 'v1', start: 'b', end: 'c' },
    ],
    constraints: [],
    solved: points,
  };
  return applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    parameters: [],
    sketches: [sketch],
    features: [
      {
        id: 'net',
        name: 'Strip',
        type: 'curveNetwork',
        inputFeatureIds: [],
        args: {
          u: ['u0', 'u1'].map((element) => ({ sketchId: 'strip', element })),
          v: ['v0', 'v1'].map((element) => ({ sketchId: 'strip', element })),
          toleranceMm,
        },
      },
    ],
    bodies: [body('roof', 'net')],
  });
}

/** The area of the F19 sphere over the 80 mm square (mm²), by Gauss–Legendre. */
export function f19NetworkArea(): number {
  const { radius: R, centre } = f19NetworkSphere;
  let area = 0;
  for (const [x, wx] of gaussPieces(0, 80, 64))
    for (const [y, wy] of gaussPieces(0, 80, 64)) {
      const dx = x - centre[0],
        dy = y - centre[1];
      area += (wx * wy * R) / Math.sqrt(R * R - dx * dx - dy * dy);
    }
  return area;
}

/**
 * F20 (CR1e): an L of two walls, a sheet of lines (0, 0)–(40, 0)–(40, 40) carried up 30 mm, and
 * a fillet of the corner between them: `constant` R 5, `linear` R 5 at the bottom to 10 at the
 * top, `points` R 5, 9 at a quarter of the way up, 5 at the top. `free` picks the wall's top
 * border, which has one face only.
 */
export function f20SheetFillet(kind: 'constant' | 'linear' | 'points' | 'free'): CadDocument {
  const points: Record<string, [number, number]> = { p0: [0, 0], p1: [40, 0], p2: [40, 40] };
  const chain: CadSketch = {
    id: 'ell-sketch',
    name: 'Ell',
    plane: { origin: position(0, 0, 0), orientation: identityQuaternion() },
    entities: [
      ...sketchPoints(points),
      { type: 'line', id: 'l0', start: 'p0', end: 'p1' },
      { type: 'line', id: 'l1', start: 'p1', end: 'p2' },
    ],
    constraints: [],
    solved: points,
  };
  const doc = applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    parameters: [],
    sketches: [chain],
    features: [
      {
        id: 'walls',
        name: 'Walls',
        type: 'extrudeSurface',
        inputFeatureIds: [],
        args: {
          path: { sketchId: 'ell-sketch', elements: ['l0', 'l1'] },
          distance: mm(30),
          direction: 1,
        },
      },
    ],
    bodies: [body('ell', 'walls')],
  });
  const on = doc.bodies[0]!.resultFeatureId;
  const corner = edgeRef(on, ['side:e:l0'], ['side:e:l1'], [40, 0, 15], 30);
  const rim = edgeRef(on, ['side:e:l0'], ['end'], [20, 0, 30], 40);
  const vary =
    kind === 'linear'
      ? { radiusEnd: mm(10) }
      : kind === 'points'
        ? { radiusEnd: mm(5), radii: [{ at: 0.25, radius: mm(9) }] }
        : {};
  return applyCadOperation(doc, {
    type: 'detailBody',
    bodyId: 'ell',
    placementFeatureId: 'fillet-placement',
    feature: {
      id: 'fillet',
      name: 'Corner',
      type: 'fillet',
      inputFeatureIds: [on],
      args: { edges: [kind === 'free' ? rim : corner], radius: mm(5), ...vary },
    },
  });
}

/**
 * F21 (CR2b): the F17 `extrude` sheet (a 40 mm line and an r = 20 mm quarter arc carried up
 * 30 mm) and a copy of it `distance` mm to its `side`, a second sheet body `inner`. The line's part
 * keeps its area; the arc's grows or shrinks by π/2 × distance × 30.
 */
export function f21OffsetSurface(side: 'front' | 'back' = 'front', distance = 2): CadDocument {
  const doc = f17Sheets('extrude');
  return applyCadOperation(doc, {
    type: 'insertFeatures',
    parameters: [],
    features: [
      {
        id: 'inner',
        name: 'Inner',
        type: 'offsetSurface',
        inputFeatureIds: [],
        args: {
          source: { featureId: doc.bodies[0]!.resultFeatureId },
          distance: mm(distance),
          side,
        },
      },
    ],
    bodies: [body('inner-body', 'inner')],
  });
}

/**
 * F22 (CR2a): a flat 100 × 60 mm sheet (a line on the XZ plane carried 60 mm along its normal,
 * −y) divided by a chain on the XY plane: `open` the line x = 30 upwards across it (left
 * 30 × 60, right 70 × 60), `closed` the square 40–60 × −40…−20 inside it, `missed` a line past it.
 * Without `split`, the panel and the chain's sketch only.
 */
export function f22Split(kind: 'open' | 'closed' | 'missed' | 'arc', split = true): CadDocument {
  // `arc`: a 0.2 mm strip across a 1 m circle (two half arcs), so a sampled circle would be
  // 0.3 mm off it (Codex on #919).
  const strip: Record<string, [number, number]> =
    kind === 'arc' ? { a: [999.9, 0], b: [1000.1, 0] } : { a: [0, 0], b: [100, 0] };
  const sheet: CadSketch = {
    id: 'edge-line',
    name: 'Edge',
    plane: {
      origin: position(0, 0, 0),
      orientation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] as Quaternion,
    },
    entities: [...sketchPoints(strip), { type: 'line', id: 'l', start: 'a', end: 'b' }],
    constraints: [],
    solved: strip,
  };
  const points: Record<string, [number, number]> =
    kind === 'arc'
      ? { c: [0, -30], p0: [1000, -30], p1: [-1000, -30] }
      : kind === 'closed'
        ? { p0: [40, -40], p1: [60, -40], p2: [60, -20], p3: [40, -20] }
        : kind === 'open'
          ? { p0: [30, -100], p1: [30, 100] }
          : { p0: [200, -100], p1: [200, 100] };
  const entities: CadSketch['entities'] =
    kind === 'arc'
      ? [
          { type: 'arc', id: 's0', center: 'c', start: 'p0', end: 'p1', clockwise: false },
          { type: 'arc', id: 's1', center: 'c', start: 'p1', end: 'p0', clockwise: false },
        ]
      : kind === 'closed'
        ? [
            { type: 'line', id: 's0', start: 'p0', end: 'p1' },
            { type: 'line', id: 's1', start: 'p1', end: 'p2' },
            { type: 'line', id: 's2', start: 'p2', end: 'p3' },
            { type: 'line', id: 's3', start: 'p3', end: 'p0' },
          ]
        : [{ type: 'line', id: 's0', start: 'p0', end: 'p1' }];
  const cutter: CadSketch = {
    id: 'cutter',
    name: 'Cutter',
    plane: { origin: position(0, 0, 0), orientation: identityQuaternion() },
    entities: [...sketchPoints(points), ...entities],
    constraints: [],
    solved: points,
  };
  const doc = applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    parameters: [],
    sketches: [sheet, cutter],
    features: [
      {
        id: 'panel',
        name: 'Panel',
        type: 'extrudeSurface',
        inputFeatureIds: [],
        args: { path: { sketchId: 'edge-line', elements: ['l'] }, distance: mm(60), direction: 1 },
      },
    ],
    bodies: [body('panel-body', 'panel')],
  });
  if (!split) return doc;
  return applyCadOperation(doc, {
    type: 'detailBody',
    bodyId: 'panel-body',
    placementFeatureId: 'split-placement',
    feature: {
      id: 'split',
      name: 'Split',
      type: 'split',
      inputFeatureIds: [doc.bodies[0]!.resultFeatureId],
      args: { tool: { sketchId: 'cutter', elements: entities.map((e) => e.id) } },
    },
  });
}

/**
 * F26 (CR3b): a door cut out of a panel along the F22 square (40–60 × −40…−20 on the XY plane),
 * `gap` mm between them in one edit: the panel trimmed outside the square, the door the inside.
 * `flat`: the F22 100 × 60 sheet in z = 0. `channel`: a U of two plates at z = ±10 joined at
 * x = 0, so the square cuts the top (in front of the XY plane) and the bottom (behind it) along
 * the same elements (86M2); only the trim, as the door would be two pieces.
 */
export function f26Panel(kind: 'flat' | 'channel' = 'flat', gap = cadPanelGapDefaultMm) {
  let doc = f22Split('closed', false);
  if (kind === 'channel') {
    const pts: Record<string, [number, number]> = {
      a: [100, 10],
      b: [0, 10],
      c: [0, -10],
      d: [100, -10],
    };
    doc = {
      ...doc,
      sketches: doc.sketches.map((s) =>
        s.id === 'edge-line'
          ? {
              ...s,
              entities: [
                ...sketchPoints(pts),
                { type: 'line', id: 'top', start: 'a', end: 'b' },
                { type: 'line', id: 'web', start: 'b', end: 'c' },
                { type: 'line', id: 'bottom', start: 'c', end: 'd' },
              ],
              solved: pts,
            }
          : s,
      ),
      features: doc.features.map((f) =>
        f.id === 'panel' && f.type === 'extrudeSurface'
          ? {
              ...f,
              args: {
                ...f.args,
                path: { sketchId: 'edge-line', elements: ['top', 'web', 'bottom'] },
              },
            }
          : f,
      ),
    };
  }
  const tool = { sketchId: 'cutter', elements: ['s0', 's1', 's2', 's3'] };
  const source = doc.bodies[0]!.resultFeatureId;
  return applyCadOperation(doc, {
    type: 'detailBody',
    bodyId: 'panel-body',
    placementFeatureId: 'trim-placement',
    feature: {
      id: 'trim',
      name: 'Trim',
      type: 'trim',
      inputFeatureIds: [source],
      args: { tool, keep: 'outside', gap: mm(gap) },
    },
    ...(kind === 'flat' && {
      panel: {
        feature: {
          id: 'door',
          name: 'Door',
          type: 'panel',
          inputFeatureIds: [],
          args: {
            source: { featureId: source },
            tool: { ...tool, elements: [...tool.elements] },
            keep: 'inside',
            gap: mm(gap),
          },
        },
        body: body('door-body', 'door'),
      },
    }),
  });
}

/**
 * F27 (CR3c): a row of windows cut out of the F22 sheet (100 × 60 in z = 0, y −60…0) by one
 * trim, keeping the outside: three 20 mm squares at x 10–30, 40–60 and 70–90, y −40…−20, so
 * 10 mm pillars stand between them. `missed`: a fourth square at x 200–220, off the sheet
 * (`ifMissed` as given). `apart`: the middle window runs y −70…10, through both long sides,
 * so the sheet falls in two. `overlap`: the middle window moved to x 25–45, y −35…−15, into the first.
 */
export function f27Windows(
  kind: 'row' | 'missed' | 'apart' | 'overlap' = 'row',
  ifMissed?: 'skip',
): CadDocument {
  const doc = f22Split('closed', false);
  const boxes: [number, number, number, number][] = [
    [10, 30, -40, -20],
    kind === 'apart'
      ? [40, 60, -70, 10]
      : kind === 'overlap'
        ? [25, 45, -35, -15]
        : [40, 60, -40, -20],
    [70, 90, -40, -20],
    ...(kind === 'missed' ? [[200, 220, -40, -20] as [number, number, number, number]] : []),
  ];
  const solved: Record<string, [number, number]> = {};
  const entities: CadSketch['entities'] = [];
  const chains = boxes.map(([x0, x1, y0, y1], k) => {
    const corner = ['a', 'b', 'c', 'd'].map((c) => `w${k}${c}`);
    [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ].forEach((p, j) => (solved[corner[j]!] = p as [number, number]));
    const lines = corner.map((start, j) => {
      const id = `w${k}s${j}`;
      entities.push({ type: 'line', id, start, end: corner[(j + 1) % 4]! });
      return id;
    });
    return lines;
  });
  const windows: CadSketch = {
    id: 'windows',
    name: 'Windows',
    plane: { origin: position(0, 0, 0), orientation: identityQuaternion() },
    entities: [...sketchPoints(solved), ...entities],
    constraints: [],
    solved,
  };
  const withSketch = applyCadOperation(doc, {
    type: 'insertFeatures',
    parameters: [],
    sketches: [windows],
    features: [],
    bodies: [],
  });
  return applyCadOperation(withSketch, {
    type: 'detailBody',
    bodyId: 'panel-body',
    placementFeatureId: 'trim-placement',
    feature: {
      id: 'windows-trim',
      name: 'Windows',
      type: 'trim',
      inputFeatureIds: [doc.bodies[0]!.resultFeatureId],
      args: {
        tool: { sketchId: 'windows', elements: chains[0]! },
        keep: 'outside',
        chains: chains.slice(1),
        ...(ifMissed && { ifMissed }),
      },
    },
  });
}

/**
 * F47 (CR4c): flanges on the F22 panel (100 × 60 in z = 0, x 0–100, y −60–0). `start`: along its
 * y = 0 border; `tray`: along all four borders, so neighbours meet at the corners; `arch`: along
 * the F24 panel's half-disc arch of R 15 (a curved edge). `width` mm, `angleDeg` from the panel,
 * turning to its `toward` side.
 */
export function f47Flange(
  kind: 'start' | 'tray' | 'arch',
  options: { width?: number; angleDeg?: number; toward?: 'front' | 'back' } = {},
): CadDocument {
  const doc = kind === 'arch' ? f24Flare({ flare: false }) : f22Split('open', false);
  const on = doc.bodies[0]!.resultFeatureId;
  const face = ['side:e:l'];
  const edges =
    kind === 'arch'
      ? [
          edgeRef(
            on,
            ['trim:arch:outside', 'side:e:l'],
            ['sketch:wheel', 'cut:e:a0'],
            [50, -50.45, 0],
            30,
          ),
        ]
      : [
          edgeRef(on, face, ['start'], [50, 0, 0], 100),
          ...(kind === 'tray'
            ? [
                edgeRef(on, face, ['edge:end:e:l'], [100, -30, 0], 60),
                edgeRef(on, face, ['end'], [50, -60, 0], 100),
                edgeRef(on, face, ['edge:start:e:l'], [0, -30, 0], 60),
              ]
            : []),
        ];
  return applyCadOperation(doc, {
    type: 'detailBody',
    bodyId: 'panel-body',
    placementFeatureId: 'flange-placement',
    feature: {
      id: 'flange',
      name: 'Flange',
      type: 'flange',
      inputFeatureIds: [on],
      args: {
        edges,
        width: mm(options.width ?? 10),
        angle: { literalRad: ((options.angleDeg ?? 90) * Math.PI) / 180 },
        toward: options.toward ?? 'front',
      },
    },
  });
}

/**
 * F48 (CR4d): a profile swept along a path on the XY plane: `line` from (0, 0) to (200, 0); `bend`
 * that line then a tangent arc of R `bendRadius` (300) turning 60° left. A hat 30 high, 40 wide
 * with 15 mm flanges and R 3 bends by default; a second sweep `closure` along the same path when
 * given (a flipped hat, or a flat plate), each its own body.
 */
export function f48ProfileSweep(
  options: {
    path?: 'line' | 'bend';
    bendRadius?: number;
    kind?: CadProfileKind;
    radius?: number;
    up?: 'normal' | 'inPlane' | Vec3;
    flip?: boolean;
    closure?: 'hat' | 'flat';
  } = {},
): CadDocument {
  const r = options.bendRadius ?? 300;
  const a = Math.PI / 3;
  const pts: Record<string, [number, number]> = {
    p0: [0, 0],
    p1: [200, 0],
    ...(options.path === 'bend'
      ? { c: [200, r], p2: [200 + r * Math.sin(a), r - r * Math.cos(a)] }
      : {}),
  };
  const path: CadSketch = {
    id: 'member-path',
    name: 'Member path',
    plane: { origin: position(0, 0, 0), orientation: identityQuaternion() },
    entities: [
      ...sketchPoints(pts),
      { type: 'line', id: 'l0', start: 'p0', end: 'p1' },
      ...(options.path === 'bend'
        ? [
            {
              type: 'arc' as const,
              id: 'a0',
              center: 'c',
              start: 'p1',
              end: 'p2',
              clockwise: false,
            },
          ]
        : []),
    ],
    constraints: [],
    solved: pts,
  };
  const elements = options.path === 'bend' ? ['l0', 'a0'] : ['l0'];
  const sweep = (
    id: string,
    kind: CadProfileKind,
    flip: boolean,
  ): CadDocument['features'][number] => ({
    id,
    name: id,
    type: 'profileSweep',
    inputFeatureIds: [],
    args: {
      path: { sketchId: 'member-path', elements },
      profile: {
        kind,
        height: mm(30),
        width: mm(40),
        flange: mm(15),
        radius: mm(options.radius ?? 3),
      },
      up: options.up ?? 'normal',
      flip,
    },
  });
  const features = [sweep('member', options.kind ?? 'hat', options.flip ?? false)];
  const bodies = [body('member-body', 'member')];
  if (options.closure) {
    features.push(sweep('closure', options.closure, true));
    bodies.push(body('closure-body', 'closure'));
  }
  return applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    parameters: [],
    sketches: [path],
    features,
    bodies,
  });
}

/**
 * F49 (CR4e): the F48 hat on a flat closure plate (or, `to: 'top'`, on a flipped hat whose top
 * lies 30 mm below), with a spot weld row from the hat's left flange (y −35…−23, z = 0, x 0…200)
 * to the plate (or the other hat's top). Pitch 40, 10 from the ends, 2.1 mm the largest gap by
 * default; `both` adds a row on the right flange.
 */
export function f49SpotWelds(
  options: {
    pitchMm?: number;
    endDistanceMm?: number;
    maxGapMm?: number;
    to?: 'plate' | 'top';
    both?: boolean;
  } = {},
): CadDocument {
  let doc = f48ProfileSweep({ closure: options.to === 'top' ? 'hat' : 'flat' });
  const on = (featureId: string, side: string, centroid: [number, number, number]) =>
    faceRef(featureId, [`side:p:${side}`, 'path:e:l0'], centroid, 200);
  const row = (id: string, side: 'l' | 'r'): CadSpotWeld => ({
    id,
    name: `Spot welds ${side === 'l' ? 'left' : 'right'}`,
    flanges: [
      {
        bodyId: 'member-body',
        face: on('member', `flange:${side}`, [100, side === 'l' ? -29 : 29, 0]),
      },
      {
        bodyId: 'closure-body',
        face:
          options.to === 'top'
            ? on('closure', 'top', [100, 0, -30])
            : on('closure', 'plate', [100, 0, 0]),
      },
    ],
    pitchMm: options.pitchMm ?? cadSpotWeldLimits.defaultPitchMm,
    endDistanceMm: options.endDistanceMm ?? cadSpotWeldLimits.defaultEndDistanceMm,
    maxGapMm: options.maxGapMm ?? cadSpotWeldLimits.defaultMaxGapMm,
  });
  doc = applyCadOperation(doc, { type: 'setSpotWeld', weld: row('welds-l', 'l') });
  if (options.both)
    doc = applyCadOperation(doc, { type: 'setSpotWeld', weld: row('welds-r', 'r') });
  return doc;
}

/**
 * F23 (CR2c): the F22 panel with a press line along the open line or the closed square: the
 * `side` pieces moved `depth` mm `toward` the panel's normal side, the step rounded by `radius`.
 */
export function f23PressLine(
  kind: 'open' | 'closed',
  options: {
    side?: 'left' | 'right' | 'inside' | 'outside';
    depth?: number;
    radius?: number;
    toward?: 'front' | 'back';
  } = {},
): CadDocument {
  const doc = f22Split(kind, false);
  const cutter = doc.sketches.find((s) => s.id === 'cutter')!;
  return applyCadOperation(doc, {
    type: 'detailBody',
    bodyId: 'panel-body',
    placementFeatureId: 'press-placement',
    feature: {
      id: 'press',
      name: 'Press line',
      type: 'pressLine',
      inputFeatureIds: [doc.bodies[0]!.resultFeatureId],
      args: {
        tool: {
          sketchId: 'cutter',
          elements: cutter.entities.filter((e) => e.type === 'line').map((e) => e.id),
        },
        side: options.side ?? (kind === 'closed' ? 'inside' : 'left'),
        depth: mm(options.depth ?? 2),
        toward: options.toward ?? 'front',
        radius: mm(options.radius ?? 0.5),
      },
    },
  });
}

/**
 * F24 (CR2d): the F22 panel with a wheel arch: a half disc of radius 15 cut from its lower
 * border at x = 50, then a flare along an arc of radius 30 round it, the arch moved `height`
 * mm out along the panel's normal, `continuity` to the panel along the arc.
 */
export function f24Flare(
  options: { height?: number; continuity?: 'G1' | 'G2'; flare?: boolean } = {},
): CadDocument {
  const base = f22Split('open', false);
  const deg = (a: number): [number, number] => [
    50 + 30 * Math.cos((a * Math.PI) / 180),
    -60 + 30 * Math.sin((a * Math.PI) / 180),
  ];
  const wheelPoints: Record<string, [number, number]> = {
    c: [50, -60],
    w0: [65, -60],
    w1: [35, -60],
  };
  const wheel: CadSketch = {
    id: 'wheel',
    name: 'Wheel',
    plane: { origin: position(0, 0, 0), orientation: identityQuaternion() },
    entities: [
      ...sketchPoints(wheelPoints),
      { type: 'arc', id: 'a0', center: 'c', start: 'w0', end: 'w1', clockwise: false },
      { type: 'arc', id: 'a1', center: 'c', start: 'w1', end: 'w0', clockwise: false },
    ],
    constraints: [],
    solved: wheelPoints,
  };
  const flarePoints: Record<string, [number, number]> = {
    c: [50, -60],
    f0: deg(-10),
    f1: deg(190),
  };
  const line: CadSketch = {
    id: 'flare-line',
    name: 'Flare line',
    plane: { origin: position(0, 0, 0), orientation: identityQuaternion() },
    entities: [
      ...sketchPoints(flarePoints),
      { type: 'arc', id: 'f', center: 'c', start: 'f0', end: 'f1', clockwise: false },
    ],
    constraints: [],
    solved: flarePoints,
  };
  let doc = applyCadOperation(base, {
    type: 'insertFeatures',
    parameters: [],
    sketches: [wheel, line],
    features: [],
    bodies: [],
  });
  doc = applyCadOperation(doc, {
    type: 'detailBody',
    bodyId: 'panel-body',
    placementFeatureId: 'arch-placement',
    feature: {
      id: 'arch',
      name: 'Wheel arch',
      type: 'trim',
      inputFeatureIds: [doc.bodies[0]!.resultFeatureId],
      args: { tool: { sketchId: 'wheel', elements: ['a0', 'a1'] }, keep: 'outside' },
    },
  });
  if (options.flare === false) return doc;
  const on = doc.bodies[0]!.resultFeatureId;
  return applyCadOperation(doc, {
    type: 'detailBody',
    bodyId: 'panel-body',
    placementFeatureId: 'flare-placement',
    feature: {
      id: 'flare',
      name: 'Flare',
      type: 'flare',
      inputFeatureIds: [on],
      args: {
        tool: { sketchId: 'flare-line', elements: ['f'] },
        arch: edgeRef(
          on,
          ['trim:arch:outside', 'side:e:l'],
          ['sketch:wheel', 'cut:e:a0'],
          [50, -45, 0],
          30,
        ),
        height: mm(options.height ?? 10),
        continuity: options.continuity ?? 'G1',
      },
    },
  });
}

/**
 * F25 (CR2e, B1): the left half of a three-door hatchback's skin at a real size (4205 mm long,
 * x forward from the tail, y across with the left side at y < 0, z up), the sample B1 is
 * accepted on (docs/cad/car-design.md, CR2の分け方). Parameters `wheelbase` (2400) and `roof`
 * (1335, the cabin's crown height) drive every sketch:
 *
 * - The skin is a curve network (CR1d): 7 sections (YZ, from the crown at y = 0 down to the
 *   rocker) crossed by the centreline (XZ), the shoulder (XY at z = 900) and the rocker (XY at
 *   z = 200). Every curve is a cubic spline through points (`splineThrough`), and each section
 *   and line pass through the same points where they meet, so they still meet when a parameter
 *   moves them: the points move linearly with the parameters, and so do the poles (each pole
 *   coordinate is an affine length of one parameter, fixed by a `fix` constraint).
 * - Lengthwise, the tail stays, the sections between the axles stretch with the wheelbase and
 *   those ahead of the front axle move with it. The roof raises the cabin's crowns.
 * - Wheel arches of R 330 trimmed out at both axles, the rear and front arches flared 25 mm out
 *   along R 390 (CR2d, G2), a press line 2 mm deep with R 0.5 rounds along z = 760 (CR2c), and an
 *   inner panel 20 mm inside the skin (CR2b, its own body).
 *
 * `upTo` stops after a stage, for the tests.
 */
export function f25B1Car(
  options: {
    upTo?: 'skin' | 'arches' | 'flares' | 'press';
    flareContinuity?: 'G1' | 'G2';
    wheelbase?: number;
    roof?: number;
  } = {},
): CadDocument {
  const base = { wheelbase: 2400, roof: 1335 };
  const at = { wheelbase: options.wheelbase ?? base.wheelbase, roof: options.roof ?? base.roof };
  const rearAxle = 955;
  // x of a section at x0 (wheelbase 2400): affine in the wheelbase.
  const xOf = (x0: number): [number, number] => {
    if (x0 <= rearAxle) return [0, x0];
    if (x0 < rearAxle + base.wheelbase) {
      const s = (x0 - rearAxle) / base.wheelbase;
      return [s, rearAxle];
    }
    return [1, x0 - base.wheelbase];
  };
  /** An affine length of one parameter (`scale` × it + `offset`), or a literal. */
  const affine = (parameterId: 'wheelbase' | 'roof', scale: number, offset: number): Length =>
    Math.abs(scale) < 1e-12 ? mm(offset) : { affine: { parameterId, scale, offsetMm: offset } };
  // Sections: x0, half width, crown height and how much of the roof's change it takes.
  const rows = [
    { x0: 0, w: 700, top: 980, k: 0 },
    { x0: 450, w: 760, top: 1120, k: 0.5 },
    { x0: 1300, w: 800, top: 1315, k: 1 },
    { x0: 2000, w: 810, top: 1335, k: 1 },
    { x0: 2700, w: 805, top: 1060, k: 0.3 },
    { x0: 3500, w: 780, top: 930, k: 0 },
    { x0: 4205, w: 720, top: 860, k: 0 },
  ];
  const shoulder = 900;
  const rocker = 200;
  const crown = (r: (typeof rows)[number], roof: number) => r.top + r.k * (roof - base.roof);
  // Section points (y, z) from the crown down to the rocker, at a roof height.
  const sectionPoints = (r: (typeof rows)[number], roof: number): [number, number][] => {
    const z = crown(r, roof);
    return [
      [0, z],
      [-0.55 * r.w, 0.9 * z + 0.1 * shoulder],
      [-r.w, shoulder],
      [-r.w, 550],
      [-0.92 * r.w, rocker],
    ];
  };
  /**
   * A spline sketch through points that move linearly with one parameter per coordinate: its
   * poles at two values of each give every pole's coordinates as affine lengths.
   */
  const splineSketch = (
    id: string,
    name: string,
    plane: CadSketch['plane'],
    points: (p: { wheelbase: number; roof: number }) => [number, number][],
    driver: ['wheelbase' | 'roof' | null, 'wheelbase' | 'roof' | null],
  ): CadSketch => {
    const poles0 = splineThrough(points(base), 3, false);
    const bumped = (which: 'wheelbase' | 'roof') =>
      splineThrough(points({ ...base, [which]: base[which] + 1 }), 3, false);
    const slopes = driver.map((d) => (d ? bumped(d) : poles0));
    const solved: Record<string, [number, number]> = {};
    const constraints: CadSketchConstraint[] = [];
    const now = splineThrough(points(at), 3, false);
    poles0.forEach((p, i) => {
      const coord = (axis: 0 | 1): Length => {
        const d = driver[axis];
        const slope = d ? slopes[axis]![i]![axis] - p[axis] : 0;
        return d ? affine(d, slope, p[axis] - slope * base[d]) : mm(p[axis]);
      };
      solved[`p${i}`] = now[i]!;
      constraints.push({ id: `f${i}`, type: 'fix', point: `p${i}`, at: [coord(0), coord(1)] });
    });
    return {
      id,
      name,
      plane,
      entities: [
        ...Object.keys(solved).map((p) => ({ type: 'point' as const, id: p })),
        { type: 'spline', id: 'c', poles: Object.keys(solved), degree: 3 },
      ],
      constraints,
      solved,
    };
  };
  const YZ: Quaternion = [0.5, 0.5, 0.5, 0.5];
  const XZ: Quaternion = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
  const XY = identityQuaternion();
  const sections = rows.map((r, j) => {
    const [s, o] = xOf(r.x0);
    return splineSketch(
      `section-${j}`,
      `Section ${j + 1}`,
      { origin: [affine('wheelbase', s, o), mm(0), mm(0)], orientation: YZ },
      (p) => sectionPoints(r, p.roof),
      [null, 'roof'],
    );
  });
  const xAt = (r: (typeof rows)[number], wheelbase: number) => {
    const [s, o] = xOf(r.x0);
    return s * wheelbase + o;
  };
  const lines = [
    splineSketch(
      'centreline',
      'Centreline',
      { origin: position(0, 0, 0), orientation: XZ },
      (p) => rows.map((r) => [xAt(r, p.wheelbase), crown(r, p.roof)]),
      ['wheelbase', 'roof'],
    ),
    splineSketch(
      'shoulder',
      'Shoulder',
      { origin: position(0, 0, shoulder), orientation: XY },
      (p) => rows.map((r) => [xAt(r, p.wheelbase), -r.w]),
      ['wheelbase', null],
    ),
    splineSketch(
      'rocker',
      'Rocker',
      { origin: position(0, 0, rocker), orientation: XY },
      (p) => rows.map((r) => [xAt(r, p.wheelbase), -0.92 * r.w]),
      ['wheelbase', null],
    ),
  ];
  // Side sketches (XZ: u → x, v → z), carried along y onto the left side.
  const axleX = (front: boolean): Length =>
    front ? affine('wheelbase', 1, rearAxle) : mm(rearAxle);
  // A circle (two arcs) or an arc round an axle at z = 300: the sketch's origin is the axle,
  // so it moves with the wheelbase and the points stay where they are in it. The sketch is the
  // XZ plane turned so its x runs down: an arc's angles (from straight down) then never cross
  // a circle's start, which would split the arch on the skin in two.
  const down: Quaternion = [0.5, 0.5, -0.5, 0.5];
  const circleSketch = (
    id: string,
    name: string,
    front: boolean,
    r: number,
    arc?: [number, number],
  ): CadSketch => {
    // `deg` from +x towards +z, as seen on the side.
    const pt = (deg: number): [number, number] => [
      -r * Math.sin((deg * Math.PI) / 180),
      r * Math.cos((deg * Math.PI) / 180),
    ];
    const [a0, a1] = arc ?? [-20, 200];
    const solved: Record<string, [number, number]> = { c: [0, 0], s: pt(a0), e: pt(a1) };
    return {
      id,
      name,
      plane: { origin: [axleX(front), mm(0), mm(300)], orientation: down },
      entities: [
        ...sketchPoints(solved),
        ...(arc
          ? [{ type: 'arc' as const, id: 'a', center: 'c', start: 's', end: 'e', clockwise: false }]
          : [
              {
                type: 'arc' as const,
                id: 'a0',
                center: 'c',
                start: 's',
                end: 'e',
                clockwise: false,
              },
              {
                type: 'arc' as const,
                id: 'a1',
                center: 'c',
                start: 'e',
                end: 's',
                clockwise: false,
              },
            ]),
      ],
      constraints: [],
      solved,
    };
  };
  const wheels = [
    circleSketch('rear-wheel', 'Rear wheel', false, 330),
    circleSketch('front-wheel', 'Front wheel', true, 330),
  ];
  const flareLines = [
    circleSketch('rear-flare-line', 'Rear flare line', false, 390, [-20, 200]),
    circleSketch('front-flare-line', 'Front flare line', true, 390, [-20, 200]),
  ];
  const pressPoints: Record<string, [number, number]> = {
    a: [-100, 760],
    b: [4305 + at.wheelbase - base.wheelbase, 760],
  };
  const press: CadSketch = {
    id: 'press-line',
    name: 'Press line',
    plane: { origin: position(0, 0, 0), orientation: XZ },
    entities: [
      { type: 'point', id: 'a' },
      { type: 'point', id: 'b' },
      { type: 'line', id: 'l', start: 'a', end: 'b' },
    ],
    constraints: [
      { id: 'fa', type: 'fix', point: 'a', at: [mm(-100), mm(760)] },
      {
        id: 'fb',
        type: 'fix',
        point: 'b',
        at: [affine('wheelbase', 1, 4305 - base.wheelbase), mm(760)],
      },
    ],
    solved: pressPoints,
  };
  // A car is large: the large tolerance set (results within 0.01 mm), as for buildings.
  const empty = f01Empty();
  empty.kernelProfile = { ...empty.kernelProfile, ...cadToleranceSets.large };
  let doc = applyCadOperation(empty, {
    type: 'insertFeatures',
    parameters: [
      { id: 'wheelbase', name: 'Wheelbase', type: 'length', value: at.wheelbase },
      { id: 'roof', name: 'Roof height', type: 'length', value: at.roof },
    ],
    sketches: [...sections, ...lines, ...wheels, ...flareLines, press],
    features: [
      {
        id: 'skin',
        name: 'Skin',
        type: 'curveNetwork',
        inputFeatureIds: [],
        args: {
          u: sections.map((s) => ({ sketchId: s.id, element: 'c' })),
          v: lines.map((s) => ({ sketchId: s.id, element: 'c' })),
          toleranceMm: 0.1,
        },
      },
    ],
    bodies: [body('skin-body', 'skin')],
  });
  if (options.upTo === 'skin') return doc;
  const detail = (feature: CadFeature) => {
    doc = applyCadOperation(doc, {
      type: 'detailBody',
      bodyId: 'skin-body',
      placementFeatureId: `${feature.id}-placement`,
      feature: { ...feature, inputFeatureIds: [doc.bodies[0]!.resultFeatureId] } as never,
    });
  };
  for (const w of wheels)
    detail({
      id: w.id === 'rear-wheel' ? 'rear-arch' : 'front-arch',
      name: w.name.replace('wheel', 'arch'),
      type: 'trim',
      inputFeatureIds: [''],
      args: { tool: { sketchId: w.id, elements: ['a0', 'a1'] }, keep: 'outside' },
    } as CadFeature);
  if (options.upTo === 'arches') return doc;
  const skinFace: CadFaceName = ['trim:front-arch:outside', 'trim:rear-arch:outside', 'surface'];
  for (const [i, end] of (['rear', 'front'] as const).entries()) {
    const on = doc.bodies[0]!.resultFeatureId;
    const kept = i ? ['flare:rear-flare'] : [];
    const axle = rearAxle + (end === 'front' ? at.wheelbase : 0);
    detail({
      id: `${end}-flare`,
      name: `${end === 'rear' ? 'Rear' : 'Front'} flare`,
      type: 'flare',
      inputFeatureIds: [''],
      args: {
        tool: { sketchId: `${end}-flare-line`, elements: ['a'] },
        arch: edgeRef(
          on,
          [...kept, ...skinFace],
          [
            ...kept,
            ...(end === 'front' ? [] : ['trim:front-arch:outside']),
            `sketch:${end}-wheel`,
            'cut:e:a0',
          ],
          [axle, -800, 630],
          1270,
        ),
        height: mm(25),
        continuity: options.flareContinuity ?? 'G2',
      },
    } as CadFeature);
  }
  if (options.upTo === 'flares') return doc;
  detail({
    id: 'press',
    name: 'Press line',
    type: 'pressLine',
    inputFeatureIds: [''],
    args: {
      tool: { sketchId: 'press-line', elements: ['l'] },
      side: 'left',
      depth: mm(2),
      toward: 'front',
      radius: mm(0.5),
    },
  } as CadFeature);
  if (options.upTo === 'press') return doc;
  // The inner panel: the skin as it comes off the network, 20 mm inside, its own body.
  return applyCadOperation(doc, {
    type: 'insertFeatures',
    parameters: [],
    sketches: [],
    features: [
      {
        id: 'inner',
        name: 'Inner panel',
        type: 'offsetSurface',
        inputFeatureIds: [],
        args: { source: { featureId: 'skin' }, distance: mm(20), side: 'back' },
      },
    ],
    bodies: [body('inner-body', 'inner')],
  });
}

const box = (
  id: string,
  name: string,
  size: [number, number, number],
  at: [number, number, number],
): CadFeature => ({
  id,
  name,
  type: 'box',
  inputFeatureIds: [],
  args: {
    size: [mm(size[0]), mm(size[1]), mm(size[2])],
    origin: position(...at),
    orientation: identityQuaternion(),
  },
});
/**
 * CR6d: a 100 × 60 × 20 mm block (z 0–20) with a round groove of `radius` along a chain a sketch
 * draws 30 mm above it: `open` a line across the top (x 10–90 at y 30), `closed` a rectangle (x
 * 20–80, y 10–50), `missed` a line beside the block. `grid`: a 60 × 40 × 4 mm plate with 3 × 2
 * spheres of radius 3 (lens cuts) united on its top, 20 mm apart both ways. `steep`: the block
 * stood up 85° about y (its top face rising 11.4 mm for each 1 mm along x), a line x −18 to −13
 * at y 30 from a sketch at z 150 crossing only that face. `shaded`: the same with a 7 × 20 × 5 mm
 * lid at z 130–135 over x −18 to −11 (on a post into the block), under the sketch but above the
 * low end of the line by more than the line's middle is below the sketch. `far`: `open` moved
 * 200 m along x, the sketch's origin left at (0, 0, 50).
 */
export function cr6dGroove(
  kind:
    | 'open'
    | 'closed'
    | 'missed'
    | 'grid'
    | 'hollow'
    | 'overhang'
    | 'steep'
    | 'shaded'
    | 'far'
    | 'ring',
  radius = 1,
  options: { groove?: boolean } = {},
): CadDocument {
  if (kind === 'grid') {
    const doc = applyCadOperation(f01Empty(), {
      type: 'insertFeatures',
      features: [
        {
          id: 'plate',
          name: 'Lens',
          type: 'box',
          inputFeatureIds: [],
          args: {
            size: [mm(60), mm(40), mm(4)],
            origin: position(0, 0, 0),
            orientation: identityQuaternion(),
          },
        },
        {
          id: 'bump',
          name: 'Cut',
          type: 'sphere',
          inputFeatureIds: [],
          args: { radius: mm(3), origin: position(10, 10, 4), orientation: identityQuaternion() },
        },
      ],
      bodies: [body('lens', 'plate'), body('cut', 'bump')],
    });
    return applyCadOperation(doc, {
      type: 'patternBodies',
      targetId: 'lens',
      toolId: 'cut',
      mode: 'union',
      patternFeatureId: 'cuts',
      placementFeatureId: 'cuts-placement',
      layout: {
        type: 'linear',
        direction: [1, 0, 0],
        count: { literal: 3 },
        spacing: mm(20),
        rows: { direction: [0, 1, 0], count: { literal: 2 }, spacing: mm(20) },
      },
    });
  }
  const points: Record<string, [number, number]> =
    kind === 'closed'
      ? { p0: [20, 10], p1: [80, 10], p2: [80, 50], p3: [20, 50] }
      : kind === 'open' || kind === 'hollow'
        ? { p0: [10, 30], p1: [90, 30] }
        : kind === 'overhang'
          ? { p0: [20, 30], p1: [80, 30] }
          : kind === 'steep' || kind === 'shaded'
            ? { p0: [-18, 30], p1: [-13, 30] }
            : kind === 'far'
              ? { p0: [200_010, 30], p1: [200_090, 30] }
              : kind === 'ring'
                ? // An open arc of r = 20 round to within 0.004 mm of its start.
                  {
                    c: [50, 30],
                    p0: [50 + 20 * Math.cos(0.0002), 30 + 20 * Math.sin(0.0002)],
                    p1: [70, 30],
                  }
                : { p0: [150, 30], p1: [200, 30] };
  const entities: CadSketch['entities'] =
    kind === 'closed'
      ? [
          { type: 'line', id: 's0', start: 'p0', end: 'p1' },
          { type: 'line', id: 's1', start: 'p1', end: 'p2' },
          { type: 'line', id: 's2', start: 'p2', end: 'p3' },
          { type: 'line', id: 's3', start: 'p3', end: 'p0' },
        ]
      : kind === 'ring'
        ? [{ type: 'arc', id: 's0', center: 'c', start: 'p0', end: 'p1', clockwise: false }]
        : [{ type: 'line', id: 's0', start: 'p0', end: 'p1' }];
  const stitch: CadSketch = {
    id: 'stitch',
    name: 'Stitch line',
    plane: {
      origin: position(0, 0, kind === 'steep' || kind === 'shaded' ? 150 : 50),
      orientation: identityQuaternion(),
    },
    entities: [...sketchPoints(points), ...entities],
    constraints: [],
    solved: points,
  };
  let doc = applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    parameters: [],
    sketches: [stitch],
    features:
      kind === 'overhang'
        ? [
            box('slab', 'Slab', [100, 60, 10], [0, 0, 0]),
            box('post', 'Post', [10, 60, 20], [0, 0, 10]),
            box('lid', 'Lid', [40, 60, 10], [0, 0, 20]),
            {
              id: 'block',
              name: 'Cushion',
              type: 'boolean',
              inputFeatureIds: ['slab', 'post', 'lid'],
              args: { mode: 'union' },
            },
          ]
        : kind === 'steep' || kind === 'shaded'
          ? [
              {
                id: kind === 'shaded' ? 'slope' : 'block',
                name: 'Cushion',
                type: 'box',
                inputFeatureIds: [],
                args: {
                  size: [mm(100), mm(60), mm(20)],
                  origin: position(0, 0, 0),
                  orientation: [
                    0,
                    -Math.sin((42.5 * Math.PI) / 180),
                    0,
                    Math.cos((42.5 * Math.PI) / 180),
                  ] as Quaternion,
                },
              },
              ...(kind === 'shaded'
                ? ([
                    box('lid', 'Lid', [7, 20, 5], [-18, 20, 130]),
                    box('post', 'Post', [1, 20, 55], [-12, 20, 80]),
                    {
                      id: 'block',
                      name: 'Cushion',
                      type: 'boolean',
                      inputFeatureIds: ['slope', 'post', 'lid'],
                      args: { mode: 'union' },
                    },
                  ] as CadFeature[])
                : []),
            ]
          : [box('block', 'Cushion', [100, 60, 20], [kind === 'far' ? 200_000 : 0, 0, 0])],
    bodies: [body('cushion', 'block')],
  });
  // `groove: false`: the block and its sketch only, for a groove made in the screen.
  if (options.groove === false) return doc;
  if (kind === 'hollow')
    doc = applyCadOperation(doc, {
      type: 'detailBody',
      bodyId: 'cushion',
      placementFeatureId: 'hollow-placement',
      feature: {
        id: 'hollow',
        name: 'Hollow',
        type: 'shell',
        inputFeatureIds: [doc.bodies[0]!.resultFeatureId],
        args: { openFaces: [], thickness: mm(2), side: 'inside' },
      },
    });
  return applyCadOperation(doc, {
    type: 'detailBody',
    bodyId: 'cushion',
    placementFeatureId: 'groove-placement',
    feature: {
      id: 'groove',
      name: 'Groove',
      type: 'groove',
      inputFeatureIds: [doc.bodies[0]!.resultFeatureId],
      args: {
        tool: { sketchId: 'stitch', elements: entities.map((e) => e.id) },
        radius: mm(radius),
      },
    },
  });
}
