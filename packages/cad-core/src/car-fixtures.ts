/**
 * F28 (CR3f, docs/cad/car-design.md, CR3の分け方): the first half of B2 on the B1 car (F25).
 * The left half skin gets a door, a hood and a rear hatch cut out as panels `gap` mm from the
 * skin (CR3b), two side windows with a pillar between them (CR3c), and in `f28B2CarParts` the
 * door and hood made parts (CR3e-1) hung on revolute joints with 0–70° and 0–60° ranges (CR3e-2).
 *
 * Coordinates as F25: x forward from the tail, y across with the left side at y < 0, z up. The
 * side sketches lie on XZ (carried along y onto the left side), the hood's and hatch's on XY
 * (carried along z onto the top); both run past the centreline (y = 0), so those panels end at
 * the skin's own border there.
 */
import type { CadSolvedPose } from './assembly';
import { cadContentHash, applyCadOperation } from './operations';
import { f25B1Car } from './fixtures';
import type { CadJoint } from './joints';
import { bodyPartContent } from './make-part';
import {
  cadPanelGapDefaultMm,
  identityQuaternion,
  position,
  type CadDocument,
  type CadFeature,
  type Quaternion,
} from './model';
import type { CadSketch } from './sketch';

const XZ: Quaternion = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
const grey = { color: '#9aa4b1', opacity: 1 };

/** A rectangle `[u0, u1, v0, v1]`, or a polygon's corners (u, v) in order (CR7g-2). */
export type F28Outline = [number, number, number, number] | readonly (readonly [number, number])[];

/** Closed outlines (rectangles or polygons) as one sketch's lines, one chain each. */
export function outlines(
  id: string,
  name: string,
  orientation: Quaternion,
  boxes: readonly F28Outline[],
): { sketch: CadSketch; chains: string[][] } {
  const solved: Record<string, [number, number]> = {};
  const entities: CadSketch['entities'] = [];
  const chains = boxes.map((box, k) => {
    const points: [number, number][] =
      typeof box[0] === 'number'
        ? (() => {
            const [u0, u1, v0, v1] = box as [number, number, number, number];
            return [
              [u0, v0],
              [u1, v0],
              [u1, v1],
              [u0, v1],
            ];
          })()
        : (box as readonly (readonly [number, number])[]).map(([u, v]) => [u, v]);
    const corners = points.map((p, j) => {
      solved[`b${k}p${j}`] = p;
      return `b${k}p${j}`;
    });
    entities.push(...corners.map((c) => ({ type: 'point' as const, id: c })));
    return corners.map((start, j) => {
      const line = `b${k}s${j}`;
      entities.push({ type: 'line', id: line, start, end: corners[(j + 1) % corners.length]! });
      return line;
    });
  });
  return {
    sketch: {
      id,
      name,
      plane: { origin: position(0, 0, 0), orientation },
      entities,
      constraints: [],
      solved,
    },
    chains,
  };
}

/** Door, hood and hatch outlines (x/z on the side, x/y on top) and the windows'. */
export const f28Outlines = {
  door: [1450, 2550, 300, 860] as [number, number, number, number],
  hood: [3150, 4100, -600, 150] as [number, number, number, number],
  hatch: [40, 560, -560, 150] as [number, number, number, number],
  windows: [
    [1400, 1950, 960, 1200],
    [2050, 2600, 960, 1180],
  ] as [number, number, number, number][],
};

/** The parameter all F28 gaps read. */
export const f28GapParameter = 'panel-gap';

export function f28B2Car(
  options: {
    gap?: number;
    upTo?: 'door' | 'panels';
    /** CR7g-1: the skin (F25) and the hood and hatch outlines widened by this across the car. */
    widthScale?: number | readonly number[];
    /** CR7g-1: the roof side's point, as a part of the half width (F25's 0.55 when not given). */
    greenhouse?: number;
    /** The wheel arches' flares' continuity (F25's, G2 when not given). */
    flareContinuity?: 'G1' | 'G2';
    /** CR7g-2: the side windows' outlines (x/z), `f28Outlines.windows` when not given. */
    windows?: readonly F28Outline[];
  } = {},
): CadDocument {
  // The hood and hatch lines run across the middle sections: the widest factor.
  const scale = options.widthScale ?? 1;
  const k = typeof scale === 'number' ? scale : Math.max(...scale);
  const across = ([u0, u1, v0, v1]: [number, number, number, number]): [
    number,
    number,
    number,
    number,
  ] => [u0, u1, Math.round(v0 * k), v1];
  // One parameter for every opening's and panel's gap: one edit changes them all (CR3f).
  const gap = { parameterId: f28GapParameter };
  const door = outlines('door-line', 'Door line', XZ, [f28Outlines.door]);
  const hood = outlines('hood-line', 'Hood line', identityQuaternion(), [across(f28Outlines.hood)]);
  const hatch = outlines('hatch-line', 'Hatch line', identityQuaternion(), [
    across(f28Outlines.hatch),
  ]);
  const windows = outlines(
    'window-line',
    'Window line',
    XZ,
    options.windows ?? f28Outlines.windows,
  );
  let doc = applyCadOperation(
    f25B1Car({
      widthScale: scale,
      ...(options.greenhouse ? { greenhouse: options.greenhouse } : {}),
      ...(options.flareContinuity ? { flareContinuity: options.flareContinuity } : {}),
    }),
    {
      type: 'insertFeatures',
      parameters: [
        {
          id: f28GapParameter,
          name: 'Panel gap',
          type: 'length',
          value: options.gap ?? cadPanelGapDefaultMm,
        },
      ],
      sketches: [door.sketch, hood.sketch, hatch.sketch, windows.sketch],
      features: [],
      bodies: [],
    },
  );
  // Each panel is cut out of the skin as it stands then, in one edit with its opening (CR3b).
  const cut = (id: string, name: string, line: { sketch: CadSketch; chains: string[][] }) => {
    const source = doc.bodies.find((b) => b.id === 'skin-body')!.resultFeatureId;
    const tool = { sketchId: line.sketch.id, elements: line.chains[0]! };
    doc = applyCadOperation(doc, {
      type: 'detailBody',
      bodyId: 'skin-body',
      placementFeatureId: `${id}-opening-placement`,
      feature: {
        id: `${id}-opening`,
        name: `${name} opening`,
        type: 'trim',
        inputFeatureIds: [source],
        args: { tool, keep: 'outside', gap },
      } as Extract<CadFeature, { type: 'trim' }>,
      panel: {
        feature: {
          id,
          name,
          type: 'panel',
          inputFeatureIds: [],
          args: { source: { featureId: source }, tool: { ...tool }, keep: 'inside', gap },
        },
        body: {
          id: `${id}-body`,
          name,
          sourceFeatureId: id,
          placementFeatureId: `${id}-body-placement`,
          appearance: grey,
        },
      },
    });
  };
  cut('door', 'Door', door);
  if (options.upTo === 'door') return doc;
  cut('hood', 'Hood', hood);
  cut('hatch', 'Rear hatch', hatch);
  if (options.upTo === 'panels') return doc;
  // The side windows in one trim, the B-pillar left between them (CR3c).
  const source = doc.bodies.find((b) => b.id === 'skin-body')!.resultFeatureId;
  return applyCadOperation(doc, {
    type: 'detailBody',
    bodyId: 'skin-body',
    placementFeatureId: 'windows-placement',
    feature: {
      id: 'windows',
      name: 'Side windows',
      type: 'trim',
      inputFeatureIds: [source],
      args: {
        tool: { sketchId: 'window-line', elements: windows.chains[0]! },
        keep: 'outside',
        chains: windows.chains.slice(1),
      },
    } as Extract<CadFeature, { type: 'trim' }>,
  });
}

/** A hinge: a frame on the axis, z along it (an angle turns the child about z). */
const hinge = (at: [number, number, number], rotation: Quaternion) => ({
  translation: position(...at),
  rotation,
});

/** The door's hinge (vertical, at its front edge) and the hood's (across, at its back edge). */
export const f28Hinges = {
  // z up: a positive angle swings the door's rear outwards (towards −y).
  door: hinge([f28Outlines.door[1], -810, 580], identityQuaternion()),
  // z along −y (a quarter turn about x): a positive angle lifts the hood's front.
  hood: hinge([f28Outlines.hood[0], -300, 1000], [Math.SQRT1_2, 0, 0, Math.SQRT1_2]),
};

/**
 * F28 with the door and hood made parts (their closures as versions `b2-door` and `b2-hood` v1,
 * placed where they were cut) and each hung on a revolute joint about its hinge. Both connectors
 * are origins moved onto the hinge, so the parts stand where they were at 0°.
 */
export function f28B2CarParts(options: { gap?: number } = {}) {
  let doc = f28B2Car(options);
  const closure = new Map<string, CadDocument>();
  const limits = { door: (70 * Math.PI) / 180, hood: (60 * Math.PI) / 180 };
  for (const name of ['door', 'hood'] as const) {
    const content = bodyPartContent(doc, `${name}-body`);
    const hash = cadContentHash(content);
    closure.set(hash, content);
    const box = doc.bodies.find((b) => b.id === `${name}-body`)!;
    doc = applyCadOperation(doc, {
      type: 'makePart',
      bodyId: box.id,
      part: {
        id: `part-${name}`,
        name: box.name,
        source: { kind: 'version', artifactId: `b2-${name}`, versionId: 'v1', contentHash: hash },
        hint: { boundsMm: f28Bounds[name] },
      },
      component: {
        id: `c-${name}`,
        name: `${box.name} 1`,
        partId: `part-${name}`,
        placement: { translation: position(0, 0, 0), rotation: identityQuaternion() },
        bom: 'include',
      },
    });
    const connector = { ref: { origin: true as const }, flip: false, offset: f28Hinges[name] };
    const joint: CadJoint = {
      id: `j-${name}`,
      name: `${box.name} hinge`,
      type: 'revolute',
      parent: { componentPath: [], ...connector },
      child: { componentId: `c-${name}`, connector: { componentPath: [], ...connector } },
      values: { angle: { literalRad: 0 } },
      limits: [{ of: 'angle', min: 0, max: limits[name] }],
    };
    doc = applyCadOperation(doc, { type: 'insertJoint', joint });
  }
  return { assembly: doc, closure };
}

/** Bounds the parts are drawn by before they evaluate (their outlines on the skin, rounded out). */
export const f28Bounds: Record<
  'door' | 'hood',
  [[number, number, number], [number, number, number]]
> = {
  door: [
    [1440, -830, 290],
    [2560, -700, 870],
  ],
  hood: [
    [3140, -620, 850],
    [4110, 0, 1060],
  ],
};

/** Where a hinge turns its part by `angle` (rad): the child pose about the hinge frame. */
export function f28HingePose(name: 'door' | 'hood', angle: number): CadSolvedPose {
  const [x, y, z] = f28Hinges[name].translation.map((l) => ('literalMm' in l ? l.literalMm : 0));
  const [qx, qy, qz, qw] = f28Hinges[name].rotation;
  // Axis: the frame's z in world coordinates.
  const axis: [number, number, number] = [
    2 * (qx * qz + qy * qw),
    2 * (qy * qz - qx * qw),
    1 - 2 * (qx * qx + qy * qy),
  ];
  const s = Math.sin(angle / 2);
  const q: Quaternion = [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
  // p − R p for the hinge point p.
  const rot = (v: [number, number, number]): [number, number, number] => {
    const [a, b, c, d] = q;
    const t = [2 * (b * v[2] - c * v[1]), 2 * (c * v[0] - a * v[2]), 2 * (a * v[1] - b * v[0])];
    return [
      v[0] + d * t[0]! + (b * t[2]! - c * t[1]!),
      v[1] + d * t[1]! + (c * t[0]! - a * t[2]!),
      v[2] + d * t[2]! + (a * t[1]! - b * t[0]!),
    ];
  };
  const r = rot([x!, y!, z!]);
  return { translationMm: [x! - r[0], y! - r[1], z! - r[2]], rotation: q };
}

/**
 * CR4b: `doc` with its first body reflected across x = 0 into a new body `copy-body`. */
export function withMirrorCopy(doc: CadDocument, args?: unknown): CadDocument {
  const source = doc.bodies[0]!.resultFeatureId;
  return applyCadOperation(doc, {
    type: 'insertFeatures',
    features: [
      {
        id: 'copy',
        name: 'Copy',
        type: 'mirrorCopy',
        inputFeatureIds: [],
        args: (args ?? {
          source: { featureId: source },
          plane: { origin: position(0, 0, 0), normal: [1, 0, 0] },
        }) as Extract<CadFeature, { type: 'mirrorCopy' }>['args'],
      },
    ],
    bodies: [
      {
        id: 'copy-body',
        name: 'Copy',
        sourceFeatureId: 'copy',
        placementFeatureId: 'copy-placement',
        appearance: { color: '#9aa4b1', opacity: 1 },
      },
    ],
  });
}
