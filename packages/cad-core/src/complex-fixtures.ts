/**
 * F40–F42 (docs/cad/complex-models.md): the car, bridge and airliner of the 2026-10-25 demo,
 * written with the O1 builder. Sizes in mm; X forward (car, airliner) or along the span (bridge),
 * Z up. Each part that the kernel gives as one connected solid is one body (CM-5 not yet in).
 */
import { cadBuilder, cadBuildPlanes, type CadBuilder } from './builder';
import { fixtureComponent, fixturePart, fixtureVersion } from './assembly-fixtures';
import { fixtureKernel } from './fixtures';
import { applyCadOperation } from './operations';
import type { CadDocument, CadKernelProfile, CadToleranceSet, Quaternion } from './model';

type Kernel = Pick<CadKernelProfile, 'id' | 'buildHash'>;
type Pt = [number, number];
const { XY, XZ, YZ } = cadBuildPlanes;
const qAxis = (axis: [number, number, number], angle: number): Quaternion => {
  const s = Math.sin(angle / 2) / Math.hypot(...axis);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
};
/** Cylinder axis (+Z) turned onto +Y or +X. */
const alongY = qAxis([1, 0, 0], -Math.PI / 2);
const alongX = qAxis([0, 1, 0], Math.PI / 2);

/** A rounded section of half width `w` from `z0` to `z1`, the top `top` × as wide. */
const roundedSection = (w: number, z0: number, z1: number, top: number): Pt[] => [
  [0, z0],
  [w * 0.9, z0],
  [w, z0 + (z1 - z0) * 0.35],
  [w * top, z1],
  [0, z1],
  [-w * top, z1],
  [-w, z0 + (z1 - z0) * 0.35],
  [-w * 0.9, z0],
];
/** Sections on YZ planes at x: `[x, half width, z bottom, z top]`. */
const lofted = (b: CadBuilder, name: string, rows: [number, number, number, number][]) =>
  rows.map(([x, w, z0, z1], i) =>
    b.closedSpline(
      `${name} section ${i + 1}`,
      { origin: [x, 0, 0], orientation: YZ },
      roundedSection(w, z0, z1, 0.9),
    ),
  );

// Tyre section in the XY plane through the axle: u radial along X, v across the car along Y.
const tyre: Pt[] = [
  [215, 10],
  [290, 0],
  [318, 4],
  [330, 30],
  [330, 60],
  [330, 170],
  [330, 200],
  [318, 226],
  [290, 230],
  [215, 220],
];
/** One F40 wheel at `origin`: a revolved tyre joined with its rim. */
function wheel(b: CadBuilder, n: string, [x, y, z]: [number | string, number, number]) {
  const points = Object.fromEntries(tyre.map((p, k) => [`p${k}`, p] as const));
  const sketchId = b.sketch(`Tyre ${n}`, { origin: [x, y, z], orientation: XY }, points, [
    { type: 'line', id: 'l0', start: 'p0', end: 'p1' },
    { type: 'spline', id: 's0', poles: ['p1', 'p2', 'p3', 'p4'], degree: 3 },
    { type: 'line', id: 'l1', start: 'p4', end: 'p5' },
    { type: 'spline', id: 's1', poles: ['p5', 'p6', 'p7', 'p8'], degree: 3 },
    { type: 'line', id: 'l2', start: 'p8', end: 'p9' },
    { type: 'line', id: 'l3', start: 'p9', end: 'p0' },
  ]);
  const revolved = b.revolve(
    `Wheel ${n}`,
    { sketchId, region: { outer: ['l0', 's0', 'l1', 's1', 'l2', 'l3'], holes: [] } },
    { axisDirection: [0, 1] },
    { color: '#1b1b1b' },
  );
  const rim = b.cylinder(
    `Rim ${n}`,
    { radius: 220, height: 190, origin: [x, y + 20, z], orientation: alongY },
    { color: '#d5d8dc' },
  );
  b.boolean(revolved, [rim], 'union', `Rim ${n} joined`);
}
/** F40's wheel centres: front and rear axle, left and right (the tyre's inner side). */
const f40Axles = [900, '{Rear axle X}'] as const;
const f40Sides = [700, -930] as const;
const f40WheelName = (i: number, j: number) => `${'FR'[i]}${'LR'[j]}`;

/** F40 without or with its wheels as bodies. */
function f40(kernel: Kernel, wheels: boolean) {
  const b = cadBuilder(kernel);
  b.parameter('Rear axle X', 'length', 3550);
  const body = b.loft(
    'Body',
    lofted(b, 'Body', [
      [0, 760, 320, 700],
      [350, 860, 260, 820],
      [1300, 900, 250, 950],
      [3000, 900, 250, 1000],
      [4150, 870, 280, 1000],
      [4550, 780, 360, 930],
    ]),
    false,
    { color: '#c0392b' },
  );
  b.loft(
    'Glass',
    lofted(b, 'Cabin', [
      [1700, 760, 880, 1150],
      [2000, 740, 880, 1420],
      [3200, 720, 880, 1430],
      [3900, 760, 880, 1040],
    ]),
    false,
    { color: '#1c2833', opacity: 0.85 },
  );
  const arches = f40Axles.map((x, i) =>
    b.cylinder(`Arch ${i + 1}`, {
      radius: 390,
      height: 2000,
      origin: [x, -1000, 340],
      orientation: alongY,
    }),
  );
  b.boolean(body, arches, 'cut', 'Wheel arches');
  if (wheels)
    for (const [i, x] of f40Axles.entries())
      for (const [j, y] of f40Sides.entries()) wheel(b, f40WheelName(i, j), [x, y, 340]);
  for (const [i, y] of [-560, 560].entries())
    b.sphere(`Headlight ${i + 1}`, { radius: 120, origin: [120, y, 650] }, { color: '#f9e79f' });
  b.box('Tail lights', { size: [60, 1300, 90], origin: [4470, -650, 780] }, { color: '#e74c3c' });
  return b.document;
}

/**
 * F40: a 4.55 m sedan. A smooth loft body through six closed-spline sections with both wheel
 * arches cut by one Boolean, a lofted greenhouse, four wheels (a revolved tyre joined with its rim)
 * and the lights. The rear axle is the parameter `Rear axle X`: its arch and wheels follow it.
 */
export function f40Car(kernel: Kernel = fixtureKernel): CadDocument {
  return f40(kernel, true);
}

/**
 * F40's acceptance version (CM-3b): the car's own bodies, and one saved wheel version placed four
 * times as components. A wheel moves by a placement edit, which evaluates nothing again; the rear
 * arch still follows `Rear axle X`, the rear wheels do not (their placements are literal).
 */
export function f40CarAssembly(kernel: Kernel = fixtureKernel) {
  const w = cadBuilder(kernel);
  wheel(w, 'part', [0, 0, 0]);
  const version = fixtureVersion('f40-wheel', 'v1', w.document);
  const assembly = applyCadOperation(f40(kernel, false), {
    type: 'insertComponents',
    parts: [
      fixturePart('part-wheel', 'Wheel', version, [
        [-330, 0, -330],
        [330, 230, 330],
      ]),
    ],
    components: f40Axles.flatMap((x, i) =>
      f40Sides.map((y, j) =>
        fixtureComponent(`wheel-${f40WheelName(i, j)}`, 'part-wheel', [
          typeof x === 'number' ? x : 3550,
          y,
          340,
        ]),
      ),
    ),
  });
  return { wheel: version, assembly, closure: new Map([[version.contentHash, version.content]]) };
}

/** F41 geometry: span, arch springing and crown heights, arch planes, hanger pitch. */
export const f41 = Object.freeze({
  span: 120_000,
  deckHeight: 20_000,
  springing: 14_000,
  crown: 44_000,
  archY: 6500,
  pitch: 8000,
});
/** The arch centre line's height at `x` (a circle through the springings and the crown). */
export function f41ArchTop(x: number) {
  const { span: L, springing, crown } = f41;
  const rise = crown - springing;
  const R = (L * L) / 4 / (2 * rise) + rise / 2;
  return crown - R + Math.sqrt(R * R - (x - L / 2) ** 2);
}
/** Hanger stations: every `pitch` where the arch is at least 3 m above the deck. */
export const f41Hangers = () =>
  Array.from({ length: f41.span / f41.pitch - 1 }, (_, k) => (k + 1) * f41.pitch).filter(
    (x) => f41ArchTop(x) - f41.deckHeight >= 3000,
  );

/**
 * F41: a 120 m through-arch bridge. Two arch ribs (one rib, braced and mirrored), hangers from the
 * deck to the arch joined to it by one union, a deck with approach spans, tie girders, piers and
 * caps joined by one union, railings with a pattern of posts, and the river. The arches spring
 * from fixed abutments; the deck is at the parameter `Deck height`, and the deck, piers, railings
 * and each hanger's length follow it by expressions. More than 55 bodies, most consumed.
 */
export function f41Bridge(
  kernel: Kernel = fixtureKernel,
  {
    braced = true,
    lamps = false,
  }: {
    braced?: boolean;
    /** K5a (CM-7b): 800 mm lamps patterned along the arch rib's outer curve, turned with it. */
    lamps?: boolean;
  } = {},
): CadDocument {
  const { span: L, springing, crown, archY } = f41;
  const b = cadBuilder(kernel);
  b.parameter('Deck height', 'length', f41.deckHeight);
  b.parameter('Railing posts', 'count', 81);
  const deck = (offset: number) => `{Deck height} ${offset < 0 ? '-' : '+'} ${Math.abs(offset)}mm`;
  // Arch rib: the band between two arcs, on a plane parallel to XZ, extruded 1.2 m.
  const rise = crown - springing;
  const R = (L * L) / 4 / (2 * rise) + rise / 2;
  const cz = crown - R;
  const half = 600;
  const foot = (r: number, s: 1 | -1): Pt => [
    L / 2 + s * Math.sqrt(r * r - (springing - cz) ** 2),
    springing,
  ];
  const ro = R + half;
  const ri = R - half;
  const rib = b.sketch(
    'Arch rib',
    { origin: [0, archY + half, 0], orientation: XZ },
    {
      c: [L / 2, cz],
      o0: foot(ro, -1),
      o1: foot(ro, 1),
      i0: foot(ri, -1),
      i1: foot(ri, 1),
    },
    [
      { type: 'arc', id: 'ao', center: 'c', start: 'o1', end: 'o0', clockwise: false },
      { type: 'line', id: 'l0', start: 'o0', end: 'i0' },
      { type: 'arc', id: 'ai', center: 'c', start: 'i0', end: 'i1', clockwise: true },
      { type: 'line', id: 'l1', start: 'i1', end: 'o1' },
    ],
  );
  const arches = b.extrude(
    'Arches',
    { sketchId: rib, region: { outer: ['ao', 'l0', 'ai', 'l1'], holes: [] } },
    2 * half,
    { color: '#d35400' },
  );
  // Bracing near the crown joins the rib to its mirror image, so the arches stay one solid.
  // Unbraced (K1): the arches are one body of two solids.
  const braces = (braced ? [-3, -2, -1, 0, 1, 2, 3] : []).map((k, i) => {
    const x = L / 2 + k * 9000;
    return b.box(
      `Brace ${i + 1}`,
      { size: [700, archY + 100, 700], origin: [x - 350, -100, f41ArchTop(x) - 350] },
      { color: '#d35400' },
    );
  });
  if (braced) b.boolean(arches, braces, 'union', 'Cross bracing');
  if (lamps) {
    // The rib's outer arc again, on the rib's mid plane, kept 3° from each foot: 15 cube lamps from
    // one end to the other.
    const t = Math.atan2(springing - cz, L / 2 - (foot(ro, -1)[0] as number)) + (3 * Math.PI) / 180;
    const ends = [Math.PI - t, t].map((a): Pt => [L / 2 + ro * Math.cos(a), cz + ro * Math.sin(a)]);
    const line = b.sketch(
      'Lamp line',
      { origin: [0, archY, 0], orientation: XZ },
      { c: [L / 2, cz], e0: ends[0]!, e1: ends[1]! },
      [{ type: 'arc', id: 'ao', center: 'c', start: 'e1', end: 'e0', clockwise: false }],
    );
    const [u, v] = ends[1]!;
    const lamp = b.box(
      'Lamp',
      { size: [800, 800, 800], origin: [u - 400, archY - 400, v - 400] },
      { color: '#f4d03f' },
    );
    b.pattern(
      arches,
      lamp,
      { type: 'curve', path: { sketchId: line, elements: ['ao'] }, count: 15, align: true },
      'union',
      'Lamps',
    );
  }
  b.mirror(arches, { normal: [0, 1, 0] }, 'Mirror arch');
  // Each hanger runs from 0.5 m below the deck top to the arch centre line.
  const hangers = [archY, -archY].flatMap((y, i) =>
    f41Hangers().map((x, k) =>
      b.cylinder(
        `Hanger ${'NS'[i]}${k + 1}`,
        {
          radius: 90,
          height: `${Math.round(f41ArchTop(x))}mm + 500mm - {Deck height}`,
          origin: [x, y, deck(-500)],
        },
        { color: '#566573' },
      ),
    ),
  );
  b.boolean(arches, hangers, 'union', 'Hangers');
  const grey = { color: '#aab7b8' };
  const slab = b.box(
    'Deck',
    { size: [L + 80_000, 15_000, 800], origin: [-40_000, -7500, deck(-800)] },
    grey,
  );
  const ties = [archY, -archY].map((y, i) =>
    b.box(
      `Tie girder ${i + 1}`,
      { size: [L + 2000, 1400, 2200], origin: [-1000, y - 700, deck(-2400)] },
      grey,
    ),
  );
  const girder = b.box(
    'Approach girder',
    { size: [L + 80_000, 9000, 1800], origin: [-40_000, -4500, deck(-2600)] },
    grey,
  );
  const supports = [-20_000, 0, L, L + 20_000].flatMap((x, i) => [
    ...[3500, -3500].map((y, j) =>
      b.cylinder(
        `Pier ${i + 1}${'ab'[j]}`,
        { radius: 1100, height: deck(-3000), origin: [x, y, 0] },
        { color: '#7f8c8d' },
      ),
    ),
    b.box(
      `Pier cap ${i + 1}`,
      { size: [3000, 11_000, 1800], origin: [x - 1500, -5500, deck(-4300)] },
      { color: '#7f8c8d' },
    ),
  ]);
  b.boolean(slab, [...ties, girder, ...supports], 'union', 'Deck and substructure');
  for (const [i, y] of [7300, -7420].entries()) {
    const rail = b.box(
      `Railing ${i + 1}`,
      { size: [L + 80_000, 120, 120], origin: [-40_000, y, deck(1000)] },
      { color: '#2e4053' },
    );
    const post = b.box(
      `Post ${i + 1}`,
      { size: [120, 120, 1060], origin: [-40_000, y, deck(-20)] },
      { color: '#2e4053' },
    );
    b.pattern(
      rail,
      post,
      { type: 'linear', direction: [1, 0, 0], count: '{Railing posts}', spacing: 2500 },
      'union',
      `Posts ${i + 1}`,
    );
  }
  b.box(
    'River',
    { size: [L + 160_000, 120_000, 200], origin: [-80_000, -60_000, 0] },
    { color: '#5dade2', opacity: 0.6 },
  );
  return b.document;
}

/**
 * K6: the kink and tip of the mirrored wing (root at y = −1500, its sketch's normal −Y) as the
 * root section scaled about the sketch origin and moved: the same leading-edge sweep and dihedral
 * as the drawn sections, the root's thickness ratio. The tip follows `Half span`.
 */
function derivedWing(b: CadBuilder) {
  const at = (chord: number, x0: number, z0: number) => {
    const s = chord / 7000;
    return { s, u: x0 - s * 12_000, v: z0 + s * 1300 };
  };
  const kink = at(4600, 12_000 + 5500 * Math.tan(0.44), -1300 + 5500 * 0.09);
  const tip = at(1600, 12_000, -1300);
  const sweep = Math.tan((25 * Math.PI) / 180);
  return [
    b.derived(0, { offset: [kink.u, kink.v, 4500], scale: kink.s }),
    b.derived(0, {
      offset: [
        `${+tip.u.toFixed(6)}mm + {Half span} * ${+sweep.toFixed(9)}`,
        `${+tip.v.toFixed(6)}mm + {Half span} * 0.09`,
        '{Half span} - 1500mm',
      ],
      scale: +tip.s.toFixed(9),
    }),
  ];
}

/** An airfoil of `chord` and thickness ratio `t` with its leading edge at `(x0, z0)`. */
const airfoil = (chord: number, t: number, x0: number, z0: number): Pt[] =>
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
  ).map(([u, v]) => [x0 + u * chord, z0 + v * chord]);

/**
 * F42: a 38 m airliner. A revolved fuselage; two ruled half-wing lofts (root, kink, tip, swept
 * 25° with dihedral) joined by a union, the tips at ±`Half span`; a stabiliser lofted tip to tip;
 * the fin; two engines (a revolved nacelle joined with its fan and pylon); a row of 40 windows by
 * a pattern on a hidden bar; the windscreen. Wings, tail and fuselage stay separate bodies.
 */
export function f42Airliner(
  kernel: Kernel = fixtureKernel,
  {
    mirrored: half = false,
    derived = false,
    joined = false,
    tolerance = 'standard',
  }: {
    mirrored?: boolean;
    /** K6 (CM-7): the mirrored wing's kink and tip derived from its root section. */
    derived?: boolean;
    joined?: boolean;
    tolerance?: CadToleranceSet;
  } = {},
): CadDocument {
  const mirrored = half || derived;
  const b = cadBuilder(kernel);
  b.parameter('Half span', 'length', 17_000);
  const R = 2000;
  const profile = b.sketch(
    'Fuselage profile',
    { orientation: XZ },
    {
      a0: [0, 0],
      n1: [0, 900],
      n2: [1200, R],
      n3: [4500, R],
      t0: [26_000, R],
      t1: [32_000, R],
      t2: [36_000, 1300],
      t3: [38_000, 700],
      e: [38_000, 0],
    },
    [
      { type: 'spline', id: 'nose', poles: ['a0', 'n1', 'n2', 'n3'], degree: 3 },
      { type: 'line', id: 'barrel', start: 'n3', end: 't0' },
      { type: 'spline', id: 'tail', poles: ['t0', 't1', 't2', 't3'], degree: 3 },
      { type: 'line', id: 'cap', start: 't3', end: 'e' },
      { type: 'line', id: 'axis', start: 'e', end: 'a0' },
    ],
  );
  const airframe = b.revolve(
    'Airframe',
    { sketchId: profile, region: { outer: ['nose', 'barrel', 'tail', 'cap', 'axis'], holes: [] } },
    { axisDirection: [1, 0] },
    { color: '#f4f6f7' },
  );
  const span = 17_000;
  const root = airfoil(7000, 0.14, 12_000, -1300);
  const kink = airfoil(4600, 0.12, 12_000 + 5500 * Math.tan(0.44), -1300 + 5500 * 0.09);
  const tip = airfoil(
    1600,
    0.1,
    12_000 + span * Math.tan((25 * Math.PI) / 180),
    -1300 + span * 0.09,
  );
  const wings = (mirrored ? (['R'] as const) : (['R', 'L'] as const)).map((n, i) => {
    const side = i ? 1 : -1;
    return b.loft(
      i ? 'Wing L' : 'Wing',
      [
        // Mirrored (K1): the root sits inside the fuselage clear of the centreline, so the wing
        // and its mirror image are one body of two solids.
        b.closedSpline(
          `Wing root ${n}`,
          { ...(mirrored ? { origin: [0, -1500, 0] } : {}), orientation: XZ },
          root,
        ),
        ...(derived
          ? derivedWing(b)
          : [
              b.closedSpline(
                `Wing kink ${n}`,
                { origin: [0, side * 6000, 0], orientation: XZ },
                kink,
              ),
              b.closedSpline(
                `Wing tip ${n}`,
                { origin: [0, i ? '{Half span}' : '-{Half span}', 0], orientation: XZ },
                tip,
              ),
            ]),
      ],
      true,
      { color: '#f4f6f7' },
    );
  });
  if (mirrored) b.mirror(wings[0]!, { normal: [0, 1, 0] }, 'Mirror wing');
  else b.boolean(wings[0]!, [wings[1]!], 'union', 'Join wing halves');
  // K2 (CM-6): the wings joined to the fuselage, which needs the `large` tolerances.
  if (tolerance !== 'standard') b.toleranceSet(tolerance);
  if (joined) b.boolean(airframe, [wings[0]!], 'union', 'Join wings to fuselage');
  b.loft(
    'Stabiliser',
    [
      b.closedSpline(
        'Stabiliser tip L',
        { origin: [0, 6200, 0], orientation: XZ },
        airfoil(1400, 0.1, 35_300, 1000),
      ),
      b.closedSpline('Stabiliser root', { orientation: XZ }, airfoil(3600, 0.1, 32_000, 500)),
      b.closedSpline(
        'Stabiliser tip R',
        { origin: [0, -6200, 0], orientation: XZ },
        airfoil(1400, 0.1, 35_300, 1000),
      ),
    ],
    true,
    { color: '#f4f6f7' },
  );
  const fin = (chord: number, x0: number): Pt[] =>
    (
      [
        [1, 0],
        [0.6, 0.06],
        [0.2, 0.06],
        [0, 0],
        [0.2, -0.06],
        [0.6, -0.06],
      ] as const
    ).map(([u, v]) => [x0 + u * chord, v * chord]);
  b.loft(
    'Fin',
    [
      b.closedSpline('Fin root', { origin: [0, 0, 800], orientation: XY }, fin(5200, 30_500)),
      b.closedSpline('Fin tip', { origin: [0, 0, 7200], orientation: XY }, fin(1800, 35_600)),
    ],
    true,
    { color: '#1f618d' },
  );
  const ez = -2300;
  for (const [i, ey] of [-5600, 5600].entries()) {
    const nacelle = b.sketch(
      `Nacelle profile ${i + 1}`,
      { origin: [0, ey, 0], orientation: XZ },
      {
        q0: [9000, ez + 850],
        q1: [9000, ez + 1050],
        q2: [10_000, ez + 1150],
        q3: [12_600, ez + 1050],
        q4: [13_200, ez + 700],
        q5: [13_200, ez + 600],
        q6: [11_000, ez + 850],
      },
      [
        { type: 'line', id: 'l0', start: 'q0', end: 'q1' },
        { type: 'spline', id: 'top', poles: ['q1', 'q2', 'q3', 'q4'], degree: 3 },
        { type: 'line', id: 'l1', start: 'q4', end: 'q5' },
        { type: 'line', id: 'l2', start: 'q5', end: 'q6' },
        { type: 'line', id: 'l3', start: 'q6', end: 'q0' },
      ],
    );
    const engine = b.revolve(
      `Engine ${i + 1}`,
      { sketchId: nacelle, region: { outer: ['l0', 'top', 'l1', 'l2', 'l3'], holes: [] } },
      { axisOrigin: [0, ez], axisDirection: [1, 0] },
      { color: '#aab7b8' },
    );
    const fan = b.cylinder(
      `Fan ${i + 1}`,
      { radius: 860, height: 300, origin: [9400, ey, ez], orientation: alongX },
      { color: '#212f3d' },
    );
    const pylon = b.box(
      `Pylon ${i + 1}`,
      { size: [5600, 300, 1400], origin: [10_400, ey - 150, ez + 900] },
      { color: '#aab7b8' },
    );
    b.boolean(engine, [fan, pylon], 'union', `Engine ${i + 1} parts`);
  }
  // Windows: short cylinders across the fuselage, tied by a hidden bar into one solid.
  const z = 550;
  const yw = Math.sqrt(R * R - z * z) + 15;
  const windows = b.box(
    'Windows',
    { size: [20_400, 2 * yw - 200, 100], origin: [5000, -yw + 100, z - 50] },
    { color: '#17202a' },
  );
  const window = b.cylinder(
    'Window',
    { radius: 140, height: 2 * yw, origin: [5200, -yw, z], orientation: alongY },
    { color: '#17202a' },
  );
  b.pattern(
    windows,
    window,
    { type: 'linear', direction: [1, 0, 0], count: 40, spacing: 500 },
    'union',
    'Window row',
  );
  b.box(
    'Windscreen',
    { size: [700, 1500, 380], origin: [1550, -750, 1250], orientation: qAxis([0, 1, 0], -0.45) },
    { color: '#17202a' },
  );
  return b.document;
}

/**
 * K5a (CM-7b): a 160 × 70 × 4 mm plate and a 10 mm bar along +x at the start of a path (a 100 mm
 * line, then a quarter arc of radius 50 turning to +y) that runs off the plate. With `align`
 * given, the bar is patterned onto the plate along the path in 3 copies, turned with it or not.
 */
export function k5aBars(kernel: Kernel = fixtureKernel, align?: boolean): CadDocument {
  const b = cadBuilder(kernel);
  const path = b.sketch(
    'Path',
    { origin: [0, 0, 0] },
    { p0: [0, 0], p1: [100, 0], c: [100, 50], p2: [150, 50] },
    [
      { type: 'line', id: 'l', start: 'p0', end: 'p1' },
      { type: 'arc', id: 'a', center: 'c', start: 'p1', end: 'p2', clockwise: false },
    ],
  );
  const plate = b.box('Plate', { size: [160, 70, 4], origin: [-20, -20, -4] });
  const bar = b.box('Bar', { size: [10, 4, 4], origin: [-5, -2, 0] });
  if (align !== undefined)
    b.pattern(
      plate,
      bar,
      { type: 'curve', path: { sketchId: path, elements: ['l', 'a'] }, count: 3, align },
      'union',
    );
  return b.document;
}
