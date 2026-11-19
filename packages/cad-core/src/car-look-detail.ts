/**
 * CL8a (docs/cad/car-look-process.md, 細部): the openings of 「翔」's air story (CL3, F83) cut
 * into F142, each with a dark duct behind it so it reads as an opening, not a hole. F83 placed
 * them as boxes (x, z, |y| ranges); here each is drawn on the surface it opens in, its shape
 * taken from the lines it sits by (N5):
 *
 * - The nose inlets: two mouths in the nose's face, either side of the centre, above the
 *   splitter (the nose's face starts at the lower edge, 270 mm, so F83's 180 mm floor is lifted
 *   to 305 mm, its duct then held by the face below it).
 * - The fender vents: a crescent behind each front wheel, concentric with the arch and 55 mm
 *   outside the flare's split line (the wheel's air leaves along the arch).
 * - The engine intakes: a NACA-style duct on each flank behind the side window, narrow at its
 *   front and opening rearwards, as the deck slopes there.
 * - The deck outlets: three slots over each radiator, across the deck behind the side intake.
 * - The arch exits: a mouth in the tail's face behind each rear wheel.
 *
 * The side intake (CL6c) and the diffuser's exit (CL7c, under the tail's face) are already open.
 * The cuts come after F142's flares and the body's mirror copy, so the flares are as F142 builds
 * them (#1274); each half is cut by its own trim. Same frame as F82.
 */
import { f142Package } from './car-look-aero';
import { fixtureKernel } from './fixtures';
import { presetLook } from './lamp-fixtures';
import { f82Rules } from './car-look-package';
import { f141BodyLines, f141FlareHeight } from './car-look-skin';
import {
  identityQuaternion,
  mm,
  position,
  type CadAppearance,
  type CadDocument,
  type CadFeature,
  type Quaternion,
  type CadKernelProfile,
} from './model';
import { applyCadOperation, type CadNewBody } from './operations';
import { splineThrough, type CadSketch } from './sketch';

type V2 = readonly [number, number];
type Kernel = Pick<CadKernelProfile, 'id' | 'buildHash'>;

/** Where an opening is drawn: the side view (x, z), the plan (x, y), or a face across x (y, z). */
export type F143View = 'side' | 'plan' | 'nose' | 'tail';

/**
 * One opening of F143, on the right half (mirrored for the left): its outline as segments end
 * to end (two points a line, four or more a spline through them), in its view's coordinates,
 * more than one outline for a row of slots.
 */
export interface F143Opening {
  id: string;
  name: string;
  /** The F83 opening it draws. */
  story: string;
  view: F143View;
  outlines: (readonly V2[])[][];
  /** How far its duct reaches past the outline (mm), when not `f143Duct.margin`. */
  margin?: number;
  /** How deep its duct lies under the skin (mm), when not `f143Duct.depth`. */
  depth?: number;
  /**
   * The largest second coordinate its duct may reach (mm): in the plan, |y| under the lower
   * edge, so the panel's vertical cut meets the deck alone (one piece).
   */
  ductMax?: number;
}

/** An arc of `r` round (cx, cz) from `a0` to `a1` degrees (0 rearwards, up positive), 4 points. */
function arc(cx: number, cz: number, r: number, a0: number, a1: number): V2[] {
  return [0, 1, 2, 3].map((i) => {
    const a = ((a0 + ((a1 - a0) * i) / 3) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cz + r * Math.sin(a)] as V2;
  });
}

/** The front arch's centre (side view) the fender vents are concentric with (F141's arch). */
const frontArch = { x: 0, z: 410 } as const;

export const f143Openings: readonly F143Opening[] = Object.freeze([
  {
    id: 'nose-inlet',
    name: 'Nose inlet',
    story: 'nose',
    view: 'nose',
    outlines: [
      [
        [
          [200, 305],
          [460, 305],
        ],
        [
          [460, 305],
          [490, 400],
        ],
        [
          [490, 400],
          [220, 400],
        ],
        [
          [220, 400],
          [200, 305],
        ],
      ],
    ],
  },
  {
    id: 'fender-vent',
    name: 'Fender vent',
    story: 'fender-vent',
    view: 'side',
    // Clear of the flare's split line, 55 mm inside the vent; shallow, so the narrow margin
    // still hides the inside of the car from the three-quarter views.
    margin: 40,
    depth: 20,
    outlines: [
      (() => {
        const inner = arc(frontArch.x, frontArch.z, 440, -15, 30);
        const outer = arc(frontArch.x, frontArch.z, 530, 30, -15);
        return [inner, [inner[3]!, outer[0]!], outer, [outer[3]!, inner[0]!]];
      })(),
    ],
  },
  {
    id: 'engine-intake',
    name: 'Engine intake',
    story: 'engine-intake',
    view: 'plan',
    ductMax: 785,
    outlines: [
      [
        [
          [1570, 712],
          [1640, 728],
          [1715, 752],
          [1790, 790],
        ],
        [
          [1790, 790],
          [1790, 610],
        ],
        [
          [1790, 610],
          [1715, 648],
          [1640, 672],
          [1570, 688],
        ],
        [
          [1570, 688],
          [1570, 712],
        ],
      ],
    ],
  },
  {
    id: 'deck-outlet',
    name: 'Deck outlet',
    story: 'deck-outlet',
    view: 'plan',
    ductMax: 840,
    outlines: (
      [
        [665, 710],
        [730, 775],
        [795, 840],
      ] as const
    ).map(([y0, y1]) => [
      [
        [2270, y0],
        [2530, y0],
      ],
      [
        [2530, y0],
        [2530, y1],
      ],
      [
        [2530, y1],
        [2270, y1],
      ],
      [
        [2270, y1],
        [2270, y0],
      ],
    ]),
  },
  {
    id: 'arch-exit',
    name: 'Arch exit',
    story: 'arch-exit',
    view: 'tail',
    outlines: [
      [
        [
          [665, 450],
          [765, 450],
        ],
        [
          [765, 450],
          [800, 650],
        ],
        [
          [800, 650],
          [690, 650],
        ],
        [
          [690, 650],
          [665, 450],
        ],
      ],
    ],
  },
] satisfies F143Opening[]);

const YZ = [0.5, 0.5, 0.5, 0.5] as [number, number, number, number];
const XZ = [Math.SQRT1_2, 0, 0, Math.SQRT1_2] as [number, number, number, number];

/** A view's sketch plane, and how a right-half point is mirrored to the left in it. */
function viewOf(view: F143View): { plane: CadSketch['plane']; mirror: (p: V2) => V2 } {
  switch (view) {
    case 'side':
      // The side view cuts through both halves: the left uses the same outline.
      return { plane: { origin: position(0, 0, 0), orientation: XZ }, mirror: (p) => p };
    case 'plan':
      return {
        plane: { origin: position(0, 0, 0), orientation: identityQuaternion() },
        mirror: ([x, y]) => [x, -y],
      };
    case 'nose':
      return {
        plane: { origin: position(-950, 0, 0), orientation: YZ },
        mirror: ([y, z]) => [-y, z],
      };
    case 'tail':
      return {
        plane: { origin: position(3400, 0, 0), orientation: YZ },
        mirror: ([y, z]) => [-y, z],
      };
  }
}

/**
 * The sketch of `outlines` (closed chains of segments) on `plane`: each segment a line (two
 * points) or a spline through its points, consecutive segments sharing their end point. Returns
 * the chains' element ids.
 */
function outlineSketch(
  id: string,
  name: string,
  plane: CadSketch['plane'],
  outlines: (readonly V2[])[][],
): { sketch: CadSketch; chains: string[][] } {
  const solved: Record<string, [number, number]> = {};
  const entities: CadSketch['entities'] = [];
  const chains = outlines.map((segments, c) => {
    const corner = (s: number) => `c${c}k${s % segments.length}`;
    segments.forEach((seg, s) => (solved[corner(s)] = [seg[0]![0], seg[0]![1]]));
    return segments.map((seg, s) => {
      const element = `c${c}s${s}`;
      if (seg.length === 2) {
        entities.push({ type: 'line', id: element, start: corner(s), end: corner(s + 1) });
      } else {
        const poles = splineThrough(seg, 3, false).map((p, i, all) => {
          if (i === 0) return corner(s);
          if (i === all.length - 1) return corner(s + 1);
          const pole = `${element}p${i}`;
          solved[pole] = [p[0], p[1]];
          return pole;
        });
        entities.push({ type: 'spline', id: element, poles, degree: 3 });
      }
      return element;
    });
  });
  return {
    sketch: {
      id,
      name,
      plane,
      entities: [
        ...Object.keys(solved).map((p) => ({ type: 'point' as const, id: p })),
        ...entities,
      ],
      constraints: [],
      solved,
    },
    chains,
  };
}

const duct: CadAppearance = { color: '#15181c', opacity: 1 };

/**
 * The duct behind an opening: a piece of the skin it opens in, inside the opening's outline
 * grown by `margin` mm (a panel of the uncut skin, never consuming it), offset `depth` mm
 * inwards. A look through the opening at down to about 30° then meets the duct, not the
 * inside of the car.
 */
export const f143Duct = { depth: 40, margin: 80 } as const;

/** Each point moved `by` mm away from the outline's centre (the outline grown, roughly). */
export function f143Grown(segments: readonly (readonly V2[])[], by: number): V2[][] {
  const all = segments.flat();
  const c = [0, 1].map((k) => all.reduce((a, p) => a + p[k]!, 0) / all.length) as [number, number];
  return segments.map((seg) =>
    seg.map(([u, v]) => {
      const d = Math.hypot(u - c[0], v - c[1]) || 1;
      return [u + ((u - c[0]) * by) / d, v + ((v - c[1]) * by) / d] as V2;
    }),
  );
}

/**
 * An opening's duct outline: the rectangle round its outlines grown by its margin (one duct
 * under a row of slots), clipped to `ductMax`; the fender vent's crescent grown as itself, as a
 * rectangle round it would reach into the flare.
 */
export function f143DuctOutline(o: F143Opening): V2[][] {
  const max = o.ductMax ?? Infinity;
  return ductOutline(o).map((seg) => seg.map(([u, v]) => [u, Math.min(v, max)] as V2));
}
function ductOutline(o: F143Opening): V2[][] {
  const by = o.margin ?? f143Duct.margin;
  if (o.view === 'side') return f143Grown(o.outlines[0]!, by);
  const all = o.outlines.flatMap((segs) => segs.flat());
  const [u0, u1] = [Math.min(...all.map((p) => p[0])) - by, Math.max(...all.map((p) => p[0])) + by];
  const [v0, v1] = [Math.min(...all.map((p) => p[1])) - by, Math.max(...all.map((p) => p[1])) + by];
  return [
    [
      [u0, v0],
      [u1, v0],
    ],
    [
      [u1, v0],
      [u1, v1],
    ],
    [
      [u1, v1],
      [u0, v1],
    ],
    [
      [u0, v1],
      [u0, v0],
    ],
  ];
}

/**
 * Which side of each skin sheet's normal points into the car (the kernel's sheets carry
 * whichever normal their construction gave them; checked on F143's evaluation).
 */
export const f143Inwards: Record<'body' | 'nose' | 'tail', 'front' | 'back'> = {
  body: 'front',
  nose: 'front',
  tail: 'back',
};

type Half = 'right' | 'left';

/**
 * F143: F142 with the openings (CL8a). On each surface (the body's halves in the side view and
 * the plan, the nose's and tail's faces) the openings are one trim (keep outside), after F142's
 * flares and mirror copy. Each opening's duct is a panel of the uncut right surface inside its
 * grown outline, offset inwards, dark, and its mirror copy on the left.
 */
export function f143Package(
  kernel: Kernel = fixtureKernel,
  openings: readonly F143Opening[] = f143Openings,
) {
  let doc = f142Package(kernel) as CadDocument;
  const result = (bodyId: string) => doc.bodies.find((b) => b.id === bodyId)!.resultFeatureId;
  const surface = (view: F143View, half: Half) =>
    view === 'nose'
      ? { body: 'skin-nose-body', inwards: f143Inwards.nose }
      : view === 'tail'
        ? { body: 'skin-tail-body', inwards: f143Inwards.tail }
        : half === 'right'
          ? { body: 'skin-body-body', inwards: f143Inwards.body }
          : { body: 'skin-body-left-body', inwards: f143Inwards.body };
  const sketches: CadSketch[] = [];
  const features: CadFeature[] = [];
  const bodies: CadNewBody[] = [];
  // The openings cut from each surface at once: the body's halves by view, the faces both halves.
  const cuts = new Map<
    string,
    { body: string; name: string; plane: CadSketch['plane']; outlines: V2[][][] }
  >();
  for (const o of openings) {
    const { plane, mirror } = viewOf(o.view);
    for (const half of ['right', 'left'] as const) {
      // The side view's prism runs through both halves: the left uses the right's outline.
      const flip = (segs: readonly (readonly V2[])[]) =>
        segs.map((s) => s.map((p) => (half === 'left' && o.view !== 'side' ? mirror(p) : p)));
      const { body } = surface(o.view, half);
      const { inwards } = surface(o.view, 'right');
      const key = `${body}:${o.view}`;
      const across = o.view === 'nose' || o.view === 'tail';
      const cut = cuts.get(key) ?? {
        body,
        name: across
          ? `${o.view === 'nose' ? 'Nose' : 'Tail'} openings`
          : `${o.view === 'side' ? 'Side' : 'Deck'} openings ${half}`,
        plane,
        outlines: [],
      };
      cut.outlines.push(...o.outlines.map(flip));
      cuts.set(key, cut);
      const id = `detail-${o.id}-duct-${half}`;
      if (half === 'right') {
        const outline = outlineSketch(`${id}-line`, `${o.name} duct ${half}`, plane, [
          f143DuctOutline(o),
        ]);
        sketches.push(outline.sketch);
        features.push(
          {
            id: `${id}-panel`,
            name: `${o.name} duct ${half} panel`,
            type: 'panel',
            inputFeatureIds: [],
            args: {
              source: { featureId: result(body) },
              tool: { sketchId: outline.sketch.id, elements: outline.chains[0]! },
              keep: 'inside',
              gap: mm(0.5),
            },
          },
          {
            id,
            name: `${o.name} duct ${half}`,
            type: 'offsetSurface',
            inputFeatureIds: [],
            args: {
              source: { featureId: `${id}-panel` },
              distance: mm(o.depth ?? f143Duct.depth),
              side: inwards,
            },
          },
        );
      } else {
        // The left duct is the right's mirror copy (an offset of the mirrored skin failed).
        features.push({
          id,
          name: `${o.name} duct ${half}`,
          type: 'mirrorCopy',
          inputFeatureIds: [],
          args: {
            source: { featureId: `detail-${o.id}-duct-right` },
            plane: { origin: position(0, 0, 0), normal: [0, 1, 0] },
          },
        });
      }
      bodies.push({
        id: `${id}-body`,
        name: `${o.name} duct ${half}`,
        sourceFeatureId: id,
        placementFeatureId: `${id}-placement`,
        appearance: duct,
      });
    }
  }
  const trims = [...cuts.values()].map((c, i) => {
    const sketch = outlineSketch(`detail-openings-${i}-line`, c.name, c.plane, c.outlines);
    sketches.push(sketch.sketch);
    return { ...c, id: `detail-openings-${i}`, sketch };
  });
  doc = applyCadOperation(doc, {
    type: 'insertFeatures',
    parameters: [],
    sketches,
    features,
    bodies,
  });
  for (const t of trims) {
    const on = doc.bodies.find((b) => b.id === t.body)!;
    const [first, ...rest] = t.sketch.chains;
    doc = applyCadOperation(doc, {
      type: 'detailBody',
      bodyId: on.id,
      placementFeatureId: `${t.id}-placement`,
      feature: {
        id: t.id,
        name: t.name,
        type: 'trim',
        inputFeatureIds: [on.resultFeatureId],
        args: {
          tool: { sketchId: t.sketch.sketch.id, elements: first! },
          keep: 'outside',
          ...(rest.length ? { chains: rest } : {}),
        },
      },
    });
  }
  return doc;
}

/**
 * CL8b: one lamp of F144 on the right half (mirrored for the left, or both halves at once on a
 * face across x): its outline (the clear lens, flush in the skin), the lit graphic behind the
 * lens (a thinner outline), and its light's colour.
 */
export interface F144Lamp {
  id: string;
  name: string;
  view: F143View;
  outline: (readonly V2[])[];
  graphic: (readonly V2[])[];
  light: 'lamp-white' | 'lamp-red';
}

/** A closed outline from an upper edge and a lower edge, both from front to back (or left to right). */
function band(upper: readonly V2[], lower: readonly V2[]): V2[][] {
  return [[...upper], [upper.at(-1)!, lower.at(-1)!], [...lower].reverse(), [lower[0]!, upper[0]!]];
}

export const f144Lamps: readonly F144Lamp[] = Object.freeze([
  {
    // An almond on the hood's slope along the fender's shoulder (CL4's shoulder line, N5),
    // narrow at the nose and widening back up the fender; a blade of light along its outer edge.
    id: 'headlamp',
    name: 'Headlamp',
    view: 'plan',
    outline: [
      [
        [-840, 575],
        [-740, 650],
        [-640, 715],
        [-560, 750],
      ],
      [
        [-560, 750],
        [-590, 640],
      ],
      [
        [-590, 640],
        [-680, 612],
        [-770, 588],
        [-840, 575],
      ],
    ],
    graphic: band(
      [
        [-805, 595],
        [-735, 640],
        [-660, 688],
        [-600, 716],
      ],
      [
        [-800, 583],
        [-732, 626],
        [-658, 673],
        [-602, 701],
      ],
    ),
    light: 'lamp-white',
  },
  {
    // A bar of light across the tail's face under the deck's edge, its ends swept up to the
    // shoulders (the tail's CL4 line).
    id: 'tail-lamp',
    name: 'Tail lamp',
    view: 'tail',
    outline: [
      [
        [-740, 862],
        [740, 862],
      ],
      [
        [740, 862],
        [770, 888],
      ],
      [
        [770, 888],
        [-770, 888],
      ],
      [
        [-770, 888],
        [-740, 862],
      ],
    ],
    graphic: [
      [
        [-728, 867],
        [728, 867],
      ],
      [
        [728, 867],
        [752, 883],
      ],
      [
        [752, 883],
        [-752, 883],
      ],
      [
        [-752, 883],
        [-728, 867],
      ],
    ],
    light: 'lamp-red',
  },
] satisfies F144Lamp[]);

/** How far behind the lens the lit graphic and the lamp's dark housing lie (mm). */
export const f144LampDepth = { graphic: 12, housing: 45 } as const;

const housing: CadAppearance = { ...presetLook('plastic-matte'), color: '#1d1f22' };

/**
 * F144: F143 with the lamps (CL8b). Each lamp is cut from its skin (keep outside); its clear
 * lens is a panel of the skin inside the outline, flush in the cut; behind it lie its lit
 * graphic (a panel inside the graphic's outline, moved in) and a dark housing (the lens moved
 * further in). A plan lamp is made on the right and mirror-copied; a face's lamp spans both.
 */
export function f144Package(
  kernel: Kernel = fixtureKernel,
  openings: readonly F143Opening[] = f143Openings,
) {
  let doc = f143Package(kernel, openings);
  const sketches: CadSketch[] = [];
  const features: CadFeature[] = [];
  const bodies: CadNewBody[] = [];
  const cuts: { body: string; id: string; name: string; sketch: CadSketch; chain: string[] }[] = [];
  const surfaceOf = (view: F143View, half: 'right' | 'left') =>
    view === 'nose'
      ? { body: 'skin-nose-body', inwards: f143Inwards.nose }
      : view === 'tail'
        ? { body: 'skin-tail-body', inwards: f143Inwards.tail }
        : {
            body: half === 'right' ? 'skin-body-body' : 'skin-body-left-body',
            inwards: f143Inwards.body,
          };
  const result = (bodyId: string) => doc.bodies.find((b) => b.id === bodyId)!.resultFeatureId;
  const add = (
    id: string,
    name: string,
    feature: CadFeature['args'] & object,
    type: string,
    look: CadAppearance,
  ) => {
    features.push({ id, name, type, inputFeatureIds: [], args: feature } as CadFeature);
    bodies.push({
      id: `${id}-body`,
      name,
      sourceFeatureId: id,
      placementFeatureId: `${id}-placement`,
      appearance: look,
    });
  };
  for (const l of f144Lamps) {
    const { plane, mirror } = viewOf(l.view);
    const across = l.view === 'nose' || l.view === 'tail';
    const { body, inwards } = surfaceOf(l.view, 'right');
    const outline = outlineSketch(`lamp-${l.id}-line`, l.name, plane, [l.outline]);
    const graphic = outlineSketch(`lamp-${l.id}-graphic-line`, `${l.name} graphic`, plane, [
      l.graphic,
    ]);
    sketches.push(outline.sketch, graphic.sketch);
    const right = across ? '' : '-right';
    const panel = (id: string, name: string, sketch: { sketch: CadSketch; chains: string[][] }) =>
      features.push({
        id,
        name,
        type: 'panel',
        inputFeatureIds: [],
        args: {
          source: { featureId: result(body) },
          tool: { sketchId: sketch.sketch.id, elements: sketch.chains[0]! },
          keep: 'inside',
          gap: mm(0.5),
        },
      });
    const lens = `lamp-${l.id}-lens${right}`;
    panel(lens, `${l.name} lens${right ? ' right' : ''}`, outline);
    bodies.push({
      id: `${lens}-body`,
      name: `${l.name} lens${right ? ' right' : ''}`,
      sourceFeatureId: lens,
      placementFeatureId: `${lens}-placement`,
      appearance: presetLook('lamp-lens'),
    });
    panel(`lamp-${l.id}-graphic-panel${right}`, `${l.name} graphic panel`, graphic);
    add(
      `lamp-${l.id}-light${right}`,
      `${l.name} light${right ? ' right' : ''}`,
      {
        source: { featureId: `lamp-${l.id}-graphic-panel${right}` },
        distance: mm(f144LampDepth.graphic),
        side: inwards,
      },
      'offsetSurface',
      presetLook(l.light),
    );
    add(
      `lamp-${l.id}-housing${right}`,
      `${l.name} housing${right ? ' right' : ''}`,
      { source: { featureId: lens }, distance: mm(f144LampDepth.housing), side: inwards },
      'offsetSurface',
      housing,
    );
    cuts.push({
      body,
      id: `lamp-${l.id}-cut${right}`,
      name: `${l.name} cut${right ? ' right' : ''}`,
      sketch: outline.sketch,
      chain: outline.chains[0]!,
    });
    if (across) continue;
    // The left: the skin cut by the mirrored outline, the lamp's parts mirror-copied.
    const left = outlineSketch(`lamp-${l.id}-left-line`, `${l.name} left`, plane, [
      l.outline.map((s) => s.map(mirror)),
    ]);
    sketches.push(left.sketch);
    cuts.push({
      body: surfaceOf(l.view, 'left').body,
      id: `lamp-${l.id}-cut-left`,
      name: `${l.name} cut left`,
      sketch: left.sketch,
      chain: left.chains[0]!,
    });
    const looks: [string, CadAppearance][] = [
      ['lens', presetLook('lamp-lens')],
      ['light', presetLook(l.light)],
      ['housing', housing],
    ];
    for (const [part, look] of looks)
      add(
        `lamp-${l.id}-${part}-left`,
        `${l.name} ${part} left`,
        {
          source: { featureId: `lamp-${l.id}-${part}-right` },
          plane: { origin: position(0, 0, 0), normal: [0, 1, 0] },
        },
        'mirrorCopy',
        look,
      );
  }
  doc = applyCadOperation(doc, {
    type: 'insertFeatures',
    parameters: [],
    sketches,
    features,
    bodies,
  });
  for (const c of cuts) {
    const on = doc.bodies.find((b) => b.id === c.body)!;
    doc = applyCadOperation(doc, {
      type: 'detailBody',
      bodyId: on.id,
      placementFeatureId: `${c.id}-placement`,
      feature: {
        id: c.id,
        name: c.name,
        type: 'trim',
        inputFeatureIds: [on.resultFeatureId],
        args: { tool: { sketchId: c.sketch.id, elements: c.chain }, keep: 'outside' },
      },
    });
  }
  return doc;
}

/**
 * CL8c: one panel of F145 cut from the body along its shut line: drawn in the side view (the
 * door) or the plan (the hood, the engine cover; whole across y = 0), as a closed outline.
 */
export interface F145Panel {
  id: string;
  name: string;
  view: 'side' | 'plan';
  outline: (readonly V2[])[];
}

/** A plan outline symmetric across y = 0 from its right edge (front to back), x at both ends. */
function acrossY(edge: readonly V2[]): V2[][] {
  const left = edge.map(([x, y]) => [x, -y] as V2);
  return [[left[0]!, edge[0]!], [...edge], [edge.at(-1)!, left.at(-1)!], [...left].reverse()];
}

export const f145Panels: readonly F145Panel[] = Object.freeze([
  {
    // The door between the fender vent and the side intake: its front edge raked as the
    // windscreen, its top under the shoulder, its rear edge leaning as the intake's point, its
    // bottom along the rocker (CL7a's lower edge), 80 mm up.
    id: 'door',
    name: 'Door',
    view: 'side',
    outline: [
      [
        [640, 252],
        [900, 248],
        [1300, 246],
        [1650, 262],
      ],
      [
        [1650, 262],
        [1600, 700],
      ],
      [
        [1600, 700],
        [560, 690],
      ],
      [
        [560, 690],
        [640, 252],
      ],
    ],
  },
  {
    // The hood between the raised fenders (CL6c's valley), from the nose to the cowl.
    id: 'hood',
    name: 'Hood',
    view: 'plan',
    outline: acrossY([
      [-780, 430],
      [-480, 500],
      [-100, 525],
      [300, 490],
    ]),
  },
  {
    // The engine cover over the deck, from behind the canopy to the tail, inside the intakes
    // and outlets.
    id: 'engine-cover',
    name: 'Engine cover',
    view: 'plan',
    outline: acrossY([
      [2020, 520],
      [2400, 580],
      [2900, 570],
      [3320, 500],
    ]),
  },
] satisfies F145Panel[]);

/** The shut lines' gap (mm), as a production car's. */
export const f145Gap = 4;

const bodyPaint: CadAppearance = { color: '#c9ccd1', opacity: 1 };

/**
 * F145: F144 with the shut lines (CL8c). Each panel is cut out of both halves of the body
 * along its outline with the gap (a trim keeping outside), and made as a panel of the right
 * half inside the same outline with the same gap, mirror-copied for the left; the gap between
 * them is the shut line.
 */
export function f145Package(
  kernel: Kernel = fixtureKernel,
  openings: readonly F143Opening[] = f143Openings,
) {
  let doc = f144Package(kernel, openings);
  const sketches: CadSketch[] = [];
  const features: CadFeature[] = [];
  const bodies: CadNewBody[] = [];
  const right = doc.bodies.find((b) => b.id === 'skin-body-body')!.resultFeatureId;
  const lines = f145Panels.map((p) => {
    const s = outlineSketch(`shut-${p.id}-line`, `${p.name} shut line`, viewOf(p.view).plane, [
      p.outline,
    ]);
    sketches.push(s.sketch);
    const id = `shut-${p.id}`;
    features.push(
      {
        id: `${id}-right`,
        name: `${p.name} right`,
        type: 'panel',
        inputFeatureIds: [],
        args: {
          source: { featureId: right },
          tool: { sketchId: s.sketch.id, elements: s.chains[0]! },
          keep: 'inside',
          gap: mm(f145Gap),
        },
      },
      {
        id: `${id}-left`,
        name: `${p.name} left`,
        type: 'mirrorCopy',
        inputFeatureIds: [],
        args: {
          source: { featureId: `${id}-right` },
          plane: { origin: position(0, 0, 0), normal: [0, 1, 0] },
        },
      },
    );
    for (const half of ['right', 'left'])
      bodies.push({
        id: `${id}-${half}-body`,
        name: `${p.name} ${half}`,
        sourceFeatureId: `${id}-${half}`,
        placementFeatureId: `${id}-${half}-placement`,
        appearance: bodyPaint,
      });
    return { p, s };
  });
  doc = applyCadOperation(doc, {
    type: 'insertFeatures',
    parameters: [],
    sketches,
    features,
    bodies,
  });
  for (const { p, s } of lines)
    for (const [half, bodyId] of [
      ['right', 'skin-body-body'],
      ['left', 'skin-body-left-body'],
    ] as const) {
      const on = doc.bodies.find((b) => b.id === bodyId)!;
      const id = `shut-${p.id}-cut-${half}`;
      doc = applyCadOperation(doc, {
        type: 'detailBody',
        bodyId: on.id,
        placementFeatureId: `${id}-placement`,
        feature: {
          id,
          name: `${p.name} shut line ${half}`,
          type: 'trim',
          inputFeatureIds: [on.resultFeatureId],
          args: {
            tool: { sketchId: s.sketch.id, elements: s.chains[0]! },
            keep: 'outside',
            gap: mm(f145Gap),
          },
        },
      });
    }
  return doc;
}

/**
 * CL8d: 「翔」's wheels (rim diameters from the tyres' sizes, 20" front and 21" rear) and its
 * mirrors. Each wheel's face: a lip round the rim and seven straight spokes to a centre cap,
 * proud of the tyre's (dark) outer face; the mirror a teardrop housing on a stalk from the
 * shoulder above the door, its glass facing back.
 */
export const f146Wheel = Object.freeze({
  rim: { front: 254, rear: 266.7 },
  spokes: 7,
  spoke: { from: 60, width: 38, depth: 10 },
  lip: { width: 16, depth: 8 },
  cap: { radius: 70, depth: 14 },
});
export const f146Mirror = Object.freeze({
  /** The housing's sections (x, half-width across y, half-height), about (y, z). */
  centre: [1000, 845] as V2,
  sections: [
    { x: 740, a: 25, b: 18 },
    { x: 800, a: 70, b: 40 },
    { x: 860, a: 80, b: 46 },
  ],
  stalk: { origin: [800, 790, 775] as const, size: [35, 210, 40] as const },
});

/**
 * CLF8's procedure for 「翔」 (the wheels pulled out to the fenders): per axle, how far the
 * fender (the widest line plus the flare) stands outside the tyre's outer face (the stance),
 * the arch's gap over the tyre at full bump, and how far the inner tread corner swings past the
 * arch's radius through the steering's lock (a wheelhouse matter: the outer corner swings in).
 */
export function f146WheelFit() {
  const r = f82Rules;
  const lines = f141BodyLines();
  return (
    [
      ['front', 0, r.tyre.front, r.track.front, r.steerDegrees],
      ['rear', r.wheelbase, r.tyre.rear, r.track.rear, 0],
    ] as const
  ).map(([axle, x, tyre, track, lock]) => {
    const radius = tyre.diameter / 2;
    const archR = radius + r.archGap;
    let swing = radius;
    for (let a = 0; a <= lock; a += 0.5) {
      const t = (a * Math.PI) / 180;
      swing = Math.max(swing, radius * Math.cos(t) + (tyre.width / 2) * Math.sin(t));
    }
    return {
      axle,
      stanceMm: lines(x).widest[0] + f141FlareHeight - (track / 2 + tyre.width / 2),
      archGapMm: archR - radius,
      lockDeg: lock,
      innerSwingPastArchMm: swing - archR,
    };
  });
}

/** A closed spline round an ellipse of half-widths a (u), b (v) about `c`, on `plane`. */
function ellipseSketch(
  id: string,
  name: string,
  plane: CadSketch['plane'],
  c: V2,
  a: number,
  b: number,
) {
  const points = Array.from({ length: 12 }, (_, k) => {
    const t = (2 * Math.PI * k) / 12;
    return [c[0] + a * Math.cos(t), c[1] + b * Math.sin(t)] as V2;
  });
  const poles = splineThrough(points, 3, true);
  const solved = Object.fromEntries(poles.map((p, i) => [`p${i}`, [p[0], p[1]]])) as Record<
    string,
    [number, number]
  >;
  return {
    id,
    name,
    plane,
    entities: [
      ...Object.keys(solved).map((p) => ({ type: 'point' as const, id: p })),
      { type: 'spline' as const, id: 'e', poles: Object.keys(solved), degree: 3, closed: true },
    ],
    constraints: [],
    solved,
  } satisfies CadSketch;
}

/**
 * F146: F145 with the wheels' faces and the mirrors (CL8d). The tyres stay F82's cylinders; each
 * wheel adds one silver body (lip, spokes and cap united) on the tyre's outer face. The mirror
 * (housing with its stalk, and glass) is made on the right and mirror-copied. The part then has
 * 64 bodies, the limit of active bodies.
 */
export function f146Package(
  kernel: Kernel = fixtureKernel,
  options: { openings?: readonly F143Opening[]; rim?: CadAppearance } = {},
) {
  let doc = f145Package(kernel, options.openings);
  const r = f82Rules;
  const w = f146Wheel;
  const features: CadFeature[] = [];
  const bodies: CadNewBody[] = [];
  const sketches: CadSketch[] = [];
  const silver: CadAppearance = options.rim ?? { ...presetLook('aluminium'), color: '#8c9198' };
  const body = (id: string, name: string, look: CadAppearance) =>
    bodies.push({
      id: `${id}-body`,
      name,
      sourceFeatureId: id,
      placementFeatureId: `${id}-placement`,
      appearance: look,
    });
  for (const [axle, x, tyre, track] of [
    ['front', 0, r.tyre.front, r.track.front],
    ['rear', r.wheelbase, r.tyre.rear, r.track.rear],
  ] as const)
    for (const out of [1, -1] as const) {
      const side = out > 0 ? 'right' : 'left';
      const id = `wheel-${axle}-${side}`;
      const name = `${axle === 'front' ? 'Front' : 'Rear'} ${side}`;
      const rim = w.rim[axle];
      const zc = tyre.diameter / 2;
      const yo = out * (track / 2 + tyre.width / 2);
      // A cylinder's axis is its local z: turned to ±y (outwards).
      const across: Quaternion = [-out * Math.SQRT1_2, 0, 0, Math.SQRT1_2];
      const cylinder = (
        fid: string,
        fname: string,
        radius: number,
        height: number,
        from: number,
      ) => ({
        id: fid,
        name: fname,
        type: 'cylinder' as const,
        inputFeatureIds: [] as [],
        args: {
          radius: mm(radius),
          height: mm(height),
          origin: position(x, from, zc),
          orientation: across,
        },
      });
      features.push(
        cylinder(`${id}-lip-outer`, `${name} lip outer`, rim, w.lip.depth, yo),
        cylinder(
          `${id}-lip-inner`,
          `${name} lip inner`,
          rim - w.lip.width,
          w.lip.depth + 2,
          yo - out,
        ),
        {
          id: `${id}-lip`,
          name: `${name} lip`,
          type: 'boolean',
          inputFeatureIds: [`${id}-lip-outer`, `${id}-lip-inner`],
          args: { mode: 'cut' },
        },
        cylinder(`${id}-cap`, `${name} cap`, w.cap.radius, w.cap.depth, yo),
      );
      const spokes = Array.from({ length: w.spokes }, (_, k) => {
        const t = (2 * Math.PI * k) / w.spokes;
        // About y: local x radial, local z across the spoke; the box's corner turned with it.
        const q: Quaternion = [0, Math.sin(t / 2), 0, Math.cos(t / 2)];
        const [lx, lz] = [w.spoke.from, -w.spoke.width / 2];
        const corner = [lx * Math.cos(t) + lz * Math.sin(t), -lx * Math.sin(t) + lz * Math.cos(t)];
        const sid = `${id}-spoke-${k}`;
        features.push({
          id: sid,
          name: `${name} spoke ${k + 1}`,
          type: 'box',
          inputFeatureIds: [],
          args: {
            size: [mm(rim - w.lip.width / 2 - w.spoke.from), mm(w.spoke.depth), mm(w.spoke.width)],
            origin: position(x + corner[0]!, out > 0 ? yo : yo - w.spoke.depth, zc + corner[1]!),
            orientation: q,
          },
        });
        return sid;
      });
      features.push({
        id: `${id}-rim`,
        name: `${name} rim`,
        type: 'boolean',
        inputFeatureIds: [`${id}-lip`, ...spokes, `${id}-cap`],
        args: { mode: 'union' },
      });
      body(`${id}-rim`, `${name} rim`, silver);
    }
  // The mirror, right then its copy.
  const m = f146Mirror;
  const YZ = [0.5, 0.5, 0.5, 0.5] as Quaternion;
  const sections = m.sections.map((s, k) =>
    ellipseSketch(
      `mirror-section-${k}`,
      `Mirror section ${k + 1}`,
      { origin: position(s.x, 0, 0), orientation: YZ },
      m.centre,
      s.a,
      s.b,
    ),
  );
  const end = m.sections.at(-1)!;
  const glass = ellipseSketch(
    'mirror-glass-line',
    'Mirror glass',
    { origin: position(end.x - 1, 0, 0), orientation: YZ },
    m.centre,
    end.a - 6,
    end.b - 6,
  );
  sketches.push(...sections, glass);
  const region = (s: CadSketch) => ({ sketchId: s.id, region: { outer: ['e'], holes: [] } });
  features.push(
    {
      id: 'mirror-shell',
      name: 'Mirror shell',
      type: 'loft',
      inputFeatureIds: [],
      args: { sections: sections.map(region), ruled: false },
    },
    {
      id: 'mirror-glass-right',
      name: 'Mirror glass right',
      type: 'extrude',
      inputFeatureIds: [],
      args: { ...region(glass), distance: mm(4), direction: 1 },
    },
    {
      id: 'mirror-stalk',
      name: 'Mirror stalk',
      type: 'box',
      inputFeatureIds: [],
      args: {
        size: [mm(m.stalk.size[0]), mm(m.stalk.size[1]), mm(m.stalk.size[2])],
        origin: position(...m.stalk.origin),
        orientation: identityQuaternion(),
      },
    },
    // The housing and its stalk as one body (the part's body count is near its limit).
    {
      id: 'mirror-housing-right',
      name: 'Mirror housing right',
      type: 'boolean',
      inputFeatureIds: ['mirror-shell', 'mirror-stalk'],
      args: { mode: 'union' },
    },
  );
  const paint: CadAppearance = { color: '#c9ccd1', opacity: 1 };
  const looks: [string, string, CadAppearance][] = [
    ['housing', 'Mirror housing', paint],
    ['glass', 'Mirror glass', presetLook('chrome')],
  ];
  for (const [part, name, look] of looks) {
    features.push({
      id: `mirror-${part}-left`,
      name: `${name} left`,
      type: 'mirrorCopy',
      inputFeatureIds: [],
      args: {
        source: { featureId: `mirror-${part}-right` },
        plane: { origin: position(0, 0, 0), normal: [0, 1, 0] },
      },
    });
    body(`mirror-${part}-right`, `${name} right`, look);
    body(`mirror-${part}-left`, `${name} left`, look);
  }
  doc = applyCadOperation(doc, {
    type: 'insertFeatures',
    parameters: [],
    sketches,
    features,
    bodies,
  });
  return doc;
}

/**
 * CL9a: the fixes the close-ups of CL8e asked for. The nose inlets become slanted trapezoids whose
 * top edge rises outwards with the nose's shoulder (instead of level rectangles), their ducts lie
 * deeper, and the wheels' faces are bright machined aluminium (the dark silver sank in the studio
 * light).
 */
export const f147NoseInlet: F143Opening = Object.freeze({
  ...f143Openings.find((o) => o.id === 'nose-inlet')!,
  depth: 90,
  outlines: [
    [
      [
        [150, 300],
        [500, 290],
      ],
      [
        [500, 290],
        [545, 375],
      ],
      [
        [545, 375],
        [175, 345],
      ],
      [
        [175, 345],
        [150, 300],
      ],
    ],
  ],
} satisfies F143Opening);
export const f147Openings: readonly F143Opening[] = Object.freeze(
  f143Openings.map((o) => (o.id === 'nose-inlet' ? f147NoseInlet : o)),
);
export const f147Rim: CadAppearance = Object.freeze({
  ...presetLook('aluminium'),
  color: '#c9ced4',
  roughness: 0.22,
});

/** F147: F146 with CL9a's nose inlets and bright wheels. */
export function f147Package(kernel: Kernel = fixtureKernel) {
  return f146Package(kernel, { openings: f147Openings, rim: f147Rim });
}
