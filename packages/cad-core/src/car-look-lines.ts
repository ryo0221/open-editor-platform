/**
 * CL4 (docs/cad/car-look-process.md): three variants of 「翔」's main lines on the drawing board
 * (N3), over F82's package and F83's air story. Each line is a spline on its poles (degree 3;
 * two or three poles give a line or a degree-2 curve), in three
 * views: the side (x, z), the plan (x, |y|, mirrored) and the front (|y|, z, mirrored). The
 * variants differ in character, not in the hard points: every one keeps CL1's length, width and
 * height, covers the wheels, holds the occupants' heads under the glass and leaves the side
 * intakes and the radiators room. Same frame as F82.
 */
import { fixtureKernel } from './fixtures';
import { applyCadOperation } from './operations';
import { mm, position, type CadAppearance, type CadDocument, type CadKernelProfile } from './model';
import { splinePoints, type CadSketch, type CadSketchEntity, type CadSketchNote } from './sketch';
import type { CadNewBody } from './operations';
import { f83Package } from './car-look-air';
import { defaultProportions } from './proportions';
import { f82Rules, sidePlane } from './car-look-package';

type V2 = readonly [number, number];

/** One variant's lines (spline poles), by view. */
export interface F84Variant {
  id: 'A' | 'B' | 'C';
  name: string;
  /** What the variant is about, in a few words (Japanese, for the sheet). */
  idea: string;
  side: {
    /** The silhouette's top, nose tip to tail top. */
    profile: V2[];
    /** The tail's face, from the profile's end down. */
    tail: V2[];
    /** The beltline: the side glass's lower edge. */
    belt: V2[];
    /** The side glass's outline above the belt (A-pillar, roof, C-pillar). */
    dlo: V2[];
    /** The shoulder: the body side's highest highlight (fender tops and the line between). */
    shoulder: V2[];
    /** The rocker: the body side's lower edge between the wheels. */
    rocker: V2[];
    /** Other lines (a flying buttress), if any. */
    extra?: V2[];
  };
  plan: {
    /** Half the body's outline. */
    outline: V2[];
    /** Half the glass at the belt. */
    greenhouse: V2[];
    /** Half the roof over the crown. */
    roof: V2[];
  };
  front: {
    /** The body side from the rocker to the belt, in the front view (|y|, z). */
    body: V2[];
    /** The glass from the belt to the roof's centre. */
    greenhouse: V2[];
  };
}

const common = {
  tail: [3400, 380] as V2,
};

export const f84Variants: readonly F84Variant[] = Object.freeze([
  {
    id: 'A',
    name: 'Wedge',
    idea: '楔：鼻から屋根まで1本の上がる線、平らな側面と1本の折れ線、切り落とした尾',
    side: {
      profile: [
        [-950, 440],
        [-650, 640],
        [-300, 765],
        [0, 812],
        [420, 818],
        [800, 1000],
        [1060, 1124],
        [1110, 1130],
        [1150, 1130],
        [1300, 1130],
        [1450, 1130],
        [1520, 1128],
        [2000, 1068],
        [2700, 1005],
        [3400, 950],
      ],
      tail: [[3400, 950], common.tail],
      belt: [
        [430, 818],
        [1300, 850],
        [2100, 900],
      ],
      dlo: [
        [440, 822],
        [800, 965],
        [1150, 1105],
        [1450, 1105],
        [1850, 1035],
        [2100, 900],
      ],
      shoulder: [
        [-800, 520],
        [1000, 690],
        [3400, 830],
      ],
      rocker: [
        [400, 160],
        [2250, 160],
      ],
    },
    plan: {
      outline: [
        [-950, 640],
        [-700, 880],
        [-300, 962],
        [0, 975],
        [1300, 975],
        [2650, 975],
        [2950, 975],
        [3200, 950],
        [3400, 880],
      ],
      greenhouse: [
        [450, 600],
        [1150, 700],
        [1700, 700],
        [2150, 600],
      ],
      roof: [
        [1150, 560],
        [1450, 560],
      ],
    },
    front: {
      body: [
        [920, 160],
        [975, 560],
        [960, 830],
      ],
      greenhouse: [
        [670, 860],
        [600, 1040],
        [450, 1125],
        [0, 1130],
      ],
    },
  },
  {
    id: 'B',
    name: 'Flow',
    idea: '流れ：前後のフェンダーが盛り上がり、間がくびれる。涙形の窓、丸い尾',
    side: {
      profile: [
        [-950, 420],
        [-550, 705],
        [-150, 805],
        [150, 805],
        [450, 785],
        [800, 995],
        [1060, 1124],
        [1110, 1130],
        [1150, 1130],
        [1300, 1130],
        [1450, 1130],
        [1520, 1128],
        [1900, 1082],
        [2350, 1015],
        [2700, 1012],
        [3100, 988],
        [3400, 935],
      ],
      tail: [[3400, 935], common.tail],
      belt: [
        [455, 790],
        [1300, 830],
        [2050, 860],
      ],
      dlo: [
        [460, 795],
        [900, 1000],
        [1250, 1110],
        [1600, 1095],
        [1950, 1000],
        [2050, 860],
      ],
      shoulder: [
        [-800, 520],
        [0, 765],
        [700, 700],
        [1700, 700],
        [2650, 885],
        [3350, 800],
      ],
      rocker: [
        [450, 190],
        [1350, 170],
        [2250, 190],
      ],
    },
    plan: {
      outline: [
        [-950, 600],
        [-650, 862],
        [-250, 975],
        [0, 975],
        [250, 975],
        [450, 960],
        [1350, 912],
        [2000, 942],
        [2400, 975],
        [2650, 975],
        [2900, 975],
        [3150, 940],
        [3400, 820],
      ],
      greenhouse: [
        [480, 590],
        [1100, 720],
        [1600, 700],
        [2050, 560],
      ],
      roof: [
        [1150, 540],
        [1450, 540],
      ],
    },
    front: {
      body: [
        [900, 190],
        [965, 520],
        [975, 700],
        [930, 860],
      ],
      greenhouse: [
        [640, 860],
        [595, 1040],
        [440, 1125],
        [0, 1130],
      ],
    },
  },
  {
    id: 'C',
    name: 'Canopy',
    idea: '浮いた操縦席：低い肩の上に細い涙形のキャノピー、後ろへ流れる飛び梁、深くえぐった吸気',
    side: {
      profile: [
        [-950, 420],
        [-600, 665],
        [-200, 792],
        [150, 812],
        [450, 784],
        [750, 960],
        [1060, 1124],
        [1110, 1130],
        [1150, 1130],
        [1300, 1130],
        [1450, 1130],
        [1520, 1128],
        [1850, 1078],
        [2400, 1025],
        [2900, 1004],
        [3400, 960],
      ],
      tail: [[3400, 960], common.tail],
      belt: [
        [455, 772],
        [1200, 760],
        [2000, 800],
      ],
      dlo: [
        [460, 776],
        [850, 1000],
        [1200, 1115],
        [1500, 1110],
        [1800, 1040],
        [2000, 800],
      ],
      shoulder: [
        [-800, 505],
        [0, 800],
        [700, 660],
        [1700, 700],
        [2650, 995],
        [3350, 905],
      ],
      rocker: [
        [450, 170],
        [1300, 150],
        [1800, 230],
      ],
      extra: [
        [1600, 1085],
        [2400, 1012],
        [3200, 962],
      ],
    },
    plan: {
      outline: [
        [-950, 580],
        [-600, 900],
        [-250, 975],
        [0, 975],
        [250, 975],
        [600, 922],
        [1300, 862],
        [1850, 915],
        [2400, 975],
        [2650, 975],
        [2900, 975],
        [3150, 950],
        [3400, 860],
      ],
      greenhouse: [
        [470, 560],
        [1100, 680],
        [1600, 660],
        [2000, 480],
      ],
      roof: [
        [1150, 505],
        [1450, 505],
      ],
    },
    front: {
      body: [
        [880, 170],
        [975, 560],
        [960, 780],
        [780, 840],
      ],
      greenhouse: [
        [625, 850],
        [585, 1040],
        [455, 1125],
        [0, 1130],
      ],
    },
  },
]);

/**
 * The curve on the poles `points` as the sketch draws it (clamped uniform B-spline, degree 3 from
 * four poles, a line for two, degree 2 for three), sampled `perSpan` times per knot span. A
 * B-spline stays inside its poles' hull: a flat run of poles is a flat run of curve, and no curve
 * rises above its highest pole.
 */
export function f84Curve(points: readonly V2[], perSpan = 32): [number, number][] {
  const poles = f84Poles(points);
  return splinePoints(poles, Math.min(3, poles.length - 1), false, perSpan);
}

/** The poles as the sketch stores them: three (a quadratic) raised to the same cubic's four. */
export function f84Poles(points: readonly V2[]): [number, number][] {
  if (points.length !== 3) return points.map((p) => [p[0], p[1]]);
  const [a, b, c] = points as [V2, V2, V2];
  const mix = (p: V2, q: V2): [number, number] => [(p[0] + 2 * q[0]) / 3, (p[1] + 2 * q[1]) / 3];
  return [[a[0], a[1]], mix(a, b), mix(c, b), [c[0], c[1]]];
}

/** The curve's highest value of v over u (linear between samples), or undefined off its range. */
export function f84At(
  curve: readonly (readonly [number, number])[],
  u: number,
): number | undefined {
  let best: number | undefined;
  for (let i = 0; i + 1 < curve.length; i++) {
    const [a, b] = [curve[i]!, curve[i + 1]!];
    if ((a[0] - u) * (b[0] - u) > 0) continue;
    const v =
      a[0] === b[0] ? Math.max(a[1], b[1]) : a[1] + ((b[1] - a[1]) * (u - a[0])) / (b[0] - a[0]);
    best = best === undefined ? v : Math.max(best, v);
  }
  return best;
}

/**
 * CL4's line colours (CLF9), by the kind of line: the outline (roof, ends, plan and front body),
 * the glass (beltline, daylight opening, greenhouse), the shoulder, the rocker and C's flying
 * buttress.
 */
export const f84Colors = Object.freeze({
  outline: '#1f2933',
  glass: '#3e7cb1',
  shoulder: '#d1495b',
  rocker: '#00798c',
  extra: '#8e5ea2',
});
const colorOf = (curve: string): string =>
  /^(belt|dlo|greenhouse|roof)/.test(curve)
    ? f84Colors.glass
    : curve === 'shoulder'
      ? f84Colors.shoulder
      : curve === 'rocker'
        ? f84Colors.rocker
        : curve === 'extra'
          ? f84Colors.extra
          : f84Colors.outline;

/**
 * A sketch of curves on poles: a line for two, else a spline (poles `<id>q<k>`), each in its
 * kind's colour (`f84Colors`).
 */
function curvesSketch(
  id: string,
  name: string,
  plane: CadSketch['plane'],
  curves: Record<string, readonly V2[]>,
  notes: CadSketchNote[] = [],
): CadSketch {
  const entities: CadSketchEntity[] = [];
  const solved: Record<string, [number, number]> = {};
  for (const [c, points] of Object.entries(curves)) {
    const poles = f84Poles(points);
    poles.forEach((p, k) => {
      solved[`${c}q${k}`] = p;
      entities.push({ type: 'point', id: `${c}q${k}` });
    });
    entities.push(
      poles.length === 2
        ? { type: 'line', id: c, start: `${c}q0`, end: `${c}q1`, color: colorOf(c) }
        : {
            type: 'spline',
            id: c,
            poles: poles.map((_, k) => `${c}q${k}`),
            degree: 3,
            color: colorOf(c),
          },
    );
  }
  return { id, name, plane, entities, constraints: [], solved, ...(notes.length ? { notes } : {}) };
}

const thousands = (n: number) => Math.round(n).toLocaleString('en-US');

/**
 * CL4's notes on the line sketches (CLF10): the variant's name and idea and its main numbers
 * on the side, the width on the plan, the view's name on the front; each in the sketch's own
 * coordinates, clear of the car.
 */
export function f84Notes(v: F84Variant): Record<'side' | 'plan' | 'front', CadSketchNote[]> {
  const r = f82Rules;
  const length = r.overhang.front + r.wheelbase + r.overhang.rear;
  const belt = f84At(f84Curve(v.side.belt), r.hPoint.x + 90)!;
  const ink = f84Colors.outline;
  return {
    side: [
      { id: 'title', at: [-950, 1300], text: `案${v.id} ${v.name}`, size: 140, color: ink },
      { id: 'idea', at: [-950, -180], text: v.idea, size: 75, color: ink },
      {
        id: 'numbers',
        at: [-950, -330],
        text: `全長 ${thousands(length)}・全高 ${thousands(r.height)}・ホイールベース ${thousands(r.wheelbase)}・目の位置のベルトライン ${thousands(belt)} mm`,
        size: 65,
        color: ink,
      },
    ],
    plan: [
      {
        id: 'numbers',
        at: [-950, -1250],
        text: `平面 案${v.id}：全幅 ${thousands(r.width)} mm`,
        size: 90,
        color: ink,
      },
    ],
    front: [{ id: 'title', at: [-950, 1300], text: `正面 案${v.id}`, size: 90, color: ink }],
  };
}

/**
 * A sketch of one closed loop made of `segments` in order, each ending where the next starts
 * (and the last where the first starts): a line for two points, else a spline on its poles.
 * Its elements are `s<k>`; the loop is its only region.
 */
function loopSketch(
  id: string,
  name: string,
  plane: CadSketch['plane'],
  segments: readonly (readonly V2[])[],
) {
  const entities: CadSketchEntity[] = [];
  const solved: Record<string, [number, number]> = {};
  const ids: string[] = [];
  let point = 0;
  const add = (p: readonly [number, number]) => {
    const pid = `p${point++}`;
    solved[pid] = [p[0], p[1]];
    entities.push({ type: 'point', id: pid });
    return pid;
  };
  const first = add(f84Poles(segments[0]!)[0]!);
  let start = first;
  segments.forEach((seg, k) => {
    const poles = f84Poles(seg);
    const last = k === segments.length - 1;
    const inner = poles.slice(1, -1).map(add);
    const end = last ? first : add(poles.at(-1)!);
    const eid = `s${k}`;
    ids.push(eid);
    entities.push(
      poles.length === 2
        ? { type: 'line', id: eid, start, end }
        : { type: 'spline', id: eid, poles: [start, ...inner, end], degree: 3 },
    );
    start = end;
  });
  return {
    sketch: { id, name, plane, entities, constraints: [], solved } as CadSketch,
    region: { outer: ids, holes: [] },
  };
}

/** The block's bottom: the floor at the clearance, rising to the tail's foot. */
const blockFloor = 110;
const overrun = 30;

/** A front-view (y, z) curve on the other side: y negated, z kept, run backwards. */
const mirrorY = (pts: readonly V2[]) => pts.map(([y, z]) => [-y, z] as V2).reverse();

/**
 * The front outline the block is pushed from: scaled about its foot so its widest point is 15 mm
 * outside the plan's half-width and its top 60 mm over the side's (at least 2% larger; at 15 mm the roof met the glass's flat top at too shallow an angle). The side
 * and the plan then set the width and the height, and the front's widest and highest points
 * never just touch their faces (#1227 review: C's front at 2% was narrower than its plan).
 */
export function f84BlockFront(v: F84Variant): { body: V2[]; greenhouse: V2[] } {
  const foot = v.front.body[0]![1];
  const front = [...f84Curve(v.front.body), ...f84Curve(v.front.greenhouse)];
  const wide = Math.max(...f84Curve(v.plan.outline).map((p) => p[1]));
  const high = Math.max(...f84Curve(v.side.profile).map((p) => p[1]));
  const ky = Math.max(1.02, (wide + 15) / Math.max(...front.map((p) => p[0])));
  const kz = Math.max(1.02, (high + 60 - foot) / (Math.max(...front.map((p) => p[1])) - foot));
  const grow = (pts: readonly V2[]) => pts.map(([y, z]) => [y * ky, foot + (z - foot) * kz] as V2);
  return { body: grow(v.front.body), greenhouse: grow(v.front.greenhouse) };
}

/**
 * A variant's block (CL4's silhouette, CLF6): its side, plan and front outlines each pushed
 * through the whole car and kept where all three overlap (boolean `common`). Its shadow in each
 * view is that view's outline.
 */
function blockOf(v: F84Variant) {
  const s = v.side;
  const front = s.profile[0]!;
  const end = s.tail.at(-1)!;
  const side = loopSketch(
    `block-${v.id}-side`,
    `Block ${v.id} side`,
    // y = +1100, pushed 2200 towards −y (the side plane's normal).
    { origin: position(0, 1100, 0), orientation: sidePlane },
    [
      s.profile,
      s.tail,
      [end, [end[0] - 450, blockFloor]],
      [
        [end[0] - 450, blockFloor],
        [front[0] + 50, blockFloor],
      ],
      [[front[0] + 50, blockFloor], front],
    ],
  );
  const o = v.plan.outline;
  const mirror = (pts: readonly V2[]) => pts.map(([a, b]) => [a, -b] as V2).reverse();
  const plan = loopSketch(
    `block-${v.id}-plan`,
    `Block ${v.id} plan`,
    { origin: position(0, 0, 0), orientation: [0, 0, 0, 1] },
    (() => {
      // The ends pushed 30 mm past the side's, so no face of the two lies on another's.
      const [a, z] = [o[0]!, o.at(-1)!];
      const a0: V2 = [a[0] - overrun, a[1]];
      const z0: V2 = [z[0] + overrun, z[1]];
      const flip = ([x, y]: V2): V2 => [x, -y];
      return [
        [a0, a],
        o,
        [z, z0],
        [z0, flip(z0)],
        [flip(z0), flip(z)],
        mirror(o),
        [flip(a), flip(a0)],
        [flip(a0), a0],
      ];
    })(),
  );
  const f = f84BlockFront(v);
  // Down past the side's floor at the foot's width, so the front never trims the floor away
  // (#1227 review: its foot was 50–80 mm above `blockFloor`).
  const [y0, z0] = f.body[0]!;
  const low = blockFloor - overrun;
  const half: (readonly V2[])[] = [
    [
      [y0, low],
      [y0, z0],
    ],
    f.body,
    [f.body.at(-1)!, f.greenhouse[0]!],
    f.greenhouse,
  ];
  // The front is (y, z): mirrored across y, each segment reversed so the loop runs on.
  const back = half.map(mirrorY).reverse();
  const bottom: V2[] = [
    [-y0, low],
    [y0, low],
  ];
  const front3 = loopSketch(
    `block-${v.id}-front`,
    `Block ${v.id} front`,
    // x = −1100, pushed 4600 towards +x (the front plane's normal).
    { origin: position(-1100, 0, 0), orientation: frontPlane },
    [...half, ...back, bottom],
  );
  return { side, plan, front: front3 };
}

/** The front view's sketch plane: u along +Y, v along +Z (a third of a turn about (1, 1, 1)). */
const frontPlane = [0.5, 0.5, 0.5, 0.5] as [number, number, number, number];

/**
 * F84: F83 with one variant's lines as three sketches, `lines-<id>-side`, `-plan` and `-front`
 * (the plan and front mirrored to both sides; the front drawn ahead of the nose). With `block`,
 * also the variant's block: its three outlines pushed through the car and kept in common.
 */
export function f84Package(
  variant: F84Variant['id'] | F84Variant = 'A',
  kernel: Pick<CadKernelProfile, 'id' | 'buildHash'> = fixtureKernel,
  block = false,
): CadDocument {
  const v = typeof variant === 'string' ? f84Variants.find((x) => x.id === variant)! : variant;
  const notes = f84Notes(v);
  const mirror = (pts: readonly V2[]) => pts.map(([a, b]) => [a, -b] as V2);
  const s = v.side;
  const side = curvesSketch(
    `lines-${v.id}-side`,
    `Lines ${v.id} side`,
    { origin: position(0, 0, 0), orientation: sidePlane },
    {
      profile: s.profile,
      tail: s.tail,
      belt: s.belt,
      dlo: s.dlo,
      shoulder: s.shoulder,
      rocker: s.rocker,
      ...(s.extra ? { extra: s.extra } : {}),
    },
    notes.side,
  );
  const p = v.plan;
  const plan = curvesSketch(
    `lines-${v.id}-plan`,
    `Lines ${v.id} plan`,
    { origin: position(0, 0, 0), orientation: [0, 0, 0, 1] },
    {
      outlineR: p.outline,
      outlineL: mirror(p.outline),
      greenhouseR: p.greenhouse,
      greenhouseL: mirror(p.greenhouse),
      roofR: p.roof,
      roofL: mirror(p.roof),
    },
    notes.plan,
  );
  const f = v.front;
  const front = curvesSketch(
    `lines-${v.id}-front`,
    `Lines ${v.id} front`,
    { origin: position(-1200, 0, 0), orientation: frontPlane },
    {
      bodyR: f.body,
      bodyL: mirrorY(f.body),
      greenhouseR: f.greenhouse,
      greenhouseL: mirrorY(f.greenhouse),
    },
    notes.front,
  );
  const doc = applyCadOperation(f83Package(kernel), {
    type: 'insertFeatures',
    parameters: [],
    sketches: [side, plan, front],
    features: [],
    bodies: [],
  });
  if (!block) return doc;
  const b = blockOf(v);
  // The block's three spline pushes meet at shallow angles along the whole body, so its
  // document is made with the large tolerance set from the start (a choice at creation).
  const large = applyCadOperation(doc, { type: 'setToleranceSet', set: 'large' });
  const push = (key: 'side' | 'plan' | 'front', distance: number) => ({
    id: `block-${v.id}-${key}-push`,
    name: `Block ${v.id} ${key}`,
    type: 'extrude' as const,
    inputFeatureIds: [] as [],
    args: {
      sketchId: b[key].sketch.id,
      region: b[key].region,
      distance: mm(distance),
      direction: 1 as const,
    },
  });
  const body: CadNewBody = {
    id: `block-${v.id}-body`,
    name: `Block ${v.id}`,
    sourceFeatureId: `block-${v.id}`,
    placementFeatureId: `block-${v.id}-placement`,
    appearance: blockLook,
  };
  return applyCadOperation(large, {
    type: 'insertFeatures',
    parameters: [],
    sketches: [b.side.sketch, b.plan.sketch, b.front.sketch],
    features: [
      push('side', 2200),
      push('plan', 1300),
      push('front', 4600),
      // Two commons in a row: a common with several tools keeps what lies inside any of them
      // (OCCT takes the tools as one group), so the third outline is cut in a second step.
      {
        id: `block-${v.id}-side-plan`,
        name: `Block ${v.id} side and plan`,
        type: 'boolean',
        inputFeatureIds: [`block-${v.id}-side-push`, `block-${v.id}-plan-push`],
        args: { mode: 'common' },
      },
      {
        id: `block-${v.id}`,
        name: `Block ${v.id}`,
        type: 'boolean',
        inputFeatureIds: [`block-${v.id}-side-plan`, `block-${v.id}-front-push`],
        args: { mode: 'common' },
      },
    ],
    bodies: [body],
  });
}

const blockLook: CadAppearance = { color: '#c8ccd2', opacity: 1 };

/**
 * CL5 (docs/cad/car-look-process.md, 比率): the chosen variant C 「Canopy」 (Ryo, 2026-11-14) as
 * F140, measured by the proportion indicators (CLF3) and corrected where it falls outside them.
 */
export const f140Variant: F84Variant = (() => {
  const c = f84Variants.find((v) => v.id === 'C')!;
  // F84 C reads 0.44 on the glass (band 0.35–0.45, aim about 0.4): the belt and the opening's
  // foot raised 20 mm bring it to the aim, the roof and the other indicators unchanged.
  const up = (p: V2): V2 => [p[0], p[1] + 20];
  return Object.freeze({
    ...c,
    side: {
      ...c.side,
      belt: c.side.belt.map(up),
      dlo: c.side.dlo.map((p, k, all) => (k === 0 || k === all.length - 1 ? up(p) : p)),
    },
  });
})();

/**
 * F140: F84's lines and block of `v` with the glass as a body (the side's daylight opening, from
 * the belt up, pushed across and kept inside the block's front greenhouse) and the proportion
 * setup (CLF3): the four wheels, the block as the body, the glass as the windows.
 */
export function f140Package(
  v: F84Variant = f140Variant,
  kernel: Pick<CadKernelProfile, 'id' | 'buildHash'> = fixtureKernel,
): CadDocument {
  const doc = f84Package(v, kernel, true);
  const s = v.side;
  const near = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;
  const dlo = [...s.dlo].reverse();
  const loop: V2[][] = [[...s.belt]];
  if (!near(s.belt.at(-1)!, dlo[0]!)) loop.push([s.belt.at(-1)!, dlo[0]!]);
  loop.push(dlo);
  if (!near(dlo.at(-1)!, s.belt[0]!)) loop.push([dlo.at(-1)!, s.belt[0]!]);
  const side = loopSketch(
    `glass-${v.id}-side`,
    `Glass ${v.id} side`,
    { origin: position(0, 1100, 0), orientation: sidePlane },
    loop,
  );
  // The front's greenhouse (as the block's), its sides run straight down past the belt so the
  // side's opening sets the glass's bottom.
  const g = f84BlockFront(v).greenhouse;
  const [y0, z0] = g[0]!;
  const low = Math.min(...f84Curve(s.belt).map((p) => p[1])) - 100;
  const front = loopSketch(
    `glass-${v.id}-front`,
    `Glass ${v.id} front`,
    { origin: position(-1100, 0, 0), orientation: frontPlane },
    [
      [
        [y0, low],
        [y0, z0],
      ],
      g,
      mirrorY(g),
      [
        [-y0, z0],
        [-y0, low],
      ],
      [
        [-y0, low],
        [y0, low],
      ],
    ],
  );
  const push = (key: 'side' | 'front', sketch: ReturnType<typeof loopSketch>, d: number) => ({
    id: `glass-${v.id}-${key}-push`,
    name: `Glass ${v.id} ${key}`,
    type: 'extrude' as const,
    inputFeatureIds: [] as [],
    args: {
      sketchId: sketch.sketch.id,
      region: sketch.region,
      distance: mm(d),
      direction: 1 as const,
    },
  });
  const withGlass = applyCadOperation(doc, {
    type: 'insertFeatures',
    parameters: [],
    sketches: [side.sketch, front.sketch],
    features: [
      push('side', side, 2200),
      push('front', front, 4600),
      {
        id: `glass-${v.id}`,
        name: `Glass ${v.id}`,
        type: 'boolean',
        inputFeatureIds: [`glass-${v.id}-side-push`, `glass-${v.id}-front-push`],
        args: { mode: 'common' },
      },
    ],
    bodies: [
      {
        id: `glass-${v.id}-body`,
        name: `Glass ${v.id}`,
        sourceFeatureId: `glass-${v.id}`,
        placementFeatureId: `glass-${v.id}-placement`,
        appearance: glassLook,
      },
    ],
  });
  return applyCadOperation(withGlass, {
    type: 'setProportions',
    proportions: defaultProportions({
      frontWheels: ['front-left-body', 'front-right-body'],
      rearWheels: ['rear-left-body', 'rear-right-body'],
      body: [`block-${v.id}-body`],
      windows: [`glass-${v.id}-body`],
    }),
  });
}

const glassLook: CadAppearance = { color: '#5b7086', opacity: 0.6 };
