/**
 * GV4b (docs/cad/gulliver-world.md): Brobdingnag's furniture and Gulliver's boxes in CAD, at true
 * size (Gulliver's mm), from the English text (Project Gutenberg #829, Part II).
 *
 * - F111 the farmer's dinner table (第2篇第1章): "the table, which was thirty feet high from the
 *   floor". The rest is our table (750 mm high, 1,800 × 900) twelve times over (創作).
 * - F112 the bedchamber box (第2篇第3章): "a wooden chamber of sixteen feet square, and twelve
 *   high, with sash-windows, a door, and two closets ... The board, that made the ceiling, was to
 *   be lifted up and down by two hinges". An assembly of the box and its ceiling board, with a
 *   revolute joint on the hinges' line.
 * - F113 the travelling box (第2篇第4章・第8章): "about twelve feet square, and ten high ... with a
 *   window in the middle of three of the squares, and each window was latticed with iron wire on
 *   the outside ... On the fourth side, which had no window, two strong staples were fixed"; a
 *   ring "fastened at the top of my box for the conveniency of carriage" (the eagle's hold); "a
 *   hole of a foot square" in the roof, "not directly over the middle", shut "with a board that
 *   drew backward and forward through a groove". Boards are two inches ("within a two-inch
 *   board", 第2篇第8章).
 *
 * Window, door and closet sizes are the author's (創作). Every function takes the kernel profile of
 * the build that will evaluate it, since content hashes include it.
 */
import {
  applyCadOperation,
  emptyCad,
  fixtureComponent,
  fixturePart,
  fixtureVersion,
  identityQuaternion,
  mm,
  parameterValues,
  position,
  solveJoints,
  type CadAppearance,
  type CadDocument,
  type CadFeature,
  type CadJoint,
  type CadKernelProfile,
  type CadNewBody,
  type CadSketch,
  type Quaternion,
} from '@editor-platform/cad-core';

type Kernel = Pick<CadKernelProfile, 'id' | 'buildHash'>;
type V3 = [number, number, number];
const inch = 25.4;
const foot = 304.8;

const oak: CadAppearance = { color: '#9a6b3c', opacity: 1, roughness: 0.75, metalness: 0 };
const paint: CadAppearance = { color: '#d9cdb2', opacity: 1, roughness: 0.8, metalness: 0 };
const iron: CadAppearance = { color: '#3f4246', opacity: 1, roughness: 0.45, metalness: 0.85 };

const newBody = (id: string, name: string, source: string, look: CadAppearance): CadNewBody => ({
  id,
  name,
  sourceFeatureId: source,
  placementFeatureId: `${id}-placement`,
  appearance: look,
});
function box(id: string, size: V3, at: V3): CadFeature {
  return {
    id,
    name: id,
    type: 'box',
    inputFeatureIds: [],
    args: {
      size: [mm(size[0]), mm(size[1]), mm(size[2])],
      origin: position(...at),
      orientation: identityQuaternion(),
    },
  };
}
/** A box from one corner to the other. */
const span = (id: string, a: V3, b: V3) =>
  box(
    id,
    [Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), Math.abs(b[2] - a[2])],
    [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
  );
function cylinder(
  id: string,
  radius: number,
  height: number,
  at: V3,
  orientation: Quaternion = identityQuaternion(),
): CadFeature {
  return {
    id,
    name: id,
    type: 'cylinder',
    inputFeatureIds: [],
    args: { radius: mm(radius), height: mm(height), origin: position(...at), orientation },
  };
}
const boolean = (id: string, mode: 'union' | 'cut', inputs: [string, ...string[]]): CadFeature => ({
  id,
  name: id,
  type: 'boolean',
  inputFeatureIds: inputs,
  args: { mode },
});
/** z along +y (a quarter turn about x). */
const zAlongY: Quaternion = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
/** z along +x (a quarter turn about y). */
const zAlongX: Quaternion = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
/** z along −x: the hinge frame, so that a positive angle lifts the board's free (−y) edge. */
const zAlongMinusX: Quaternion = [0, -Math.SQRT1_2, 0, Math.SQRT1_2];

/** The farmer's table (F111). */
export const tableSizes = {
  /** 本文: "thirty feet high from the floor". */
  height: 30 * foot,
  /** 創作: our 1,800 × 900 table top 40 mm thick and 60 mm legs, twelve times over. */
  length: 1_800 * 12,
  width: 900 * 12,
  top: 40 * 12,
  leg: 60 * 12,
} as const;

/** F111: the table, its top's upper face 30 ft up, centred on the origin. */
export function f111FarmerTable(kernel: Kernel): CadDocument {
  const t = tableSizes;
  const legH = t.height - t.top;
  const features: CadFeature[] = [
    box('table-top', [t.length, t.width, t.top], [-t.length / 2, -t.width / 2, legH]),
  ];
  const inset = 600;
  const legs: string[] = [];
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const) {
    const id = `leg-${legs.length}`;
    features.push(
      box(
        id,
        [t.leg, t.leg, legH + 1],
        [
          sx < 0 ? -t.length / 2 + inset : t.length / 2 - inset - t.leg,
          sy < 0 ? -t.width / 2 + inset : t.width / 2 - inset - t.leg,
          0,
        ],
      ),
    );
    legs.push(id);
  }
  features.push(boolean('table', 'union', ['table-top', ...legs]));
  return applyCadOperation(emptyCad(kernel), {
    type: 'insertFeatures',
    parameters: [],
    sketches: [],
    features,
    bodies: [newBody('table-body', 'Table', 'table', oak)],
  });
}

/** The bedchamber box (F112). */
export const bedchamberSizes = {
  /** 本文: "sixteen feet square, and twelve high". */
  side: 16 * foot,
  height: 12 * foot,
  /** 本文 (第2篇第8章): "a two-inch board". */
  board: 2 * inch,
  /** 創作: a door 3 × 6.5 ft in the front (−y) wall, a sash window 3 × 4 ft in each side wall. */
  door: [3 * foot, 6.5 * foot] as const,
  window: [3 * foot, 4 * foot] as const,
  sill: 3 * foot,
  /** 創作: two closets 4 ft square in the back corners, behind 1 in partitions. */
  closet: 4 * foot,
  partition: 1 * inch,
  /** 本文: "two hinges", on the back wall's top edge (創作: where). */
  hinges: [0.25, 0.75] as const,
} as const;

/** The hinge line: along x on the back wall's top edge. */
const hingeAt = (): V3 => {
  const s = bedchamberSizes;
  return [s.side / 2, s.side - s.board / 2, s.height - s.board];
};

/** The bedchamber's box without its ceiling: floor, walls with door and windows, closets, hinges. */
export function bedchamberBox(kernel: Kernel): CadDocument {
  const s = bedchamberSizes;
  const W = s.side,
    b = s.board,
    top = s.height - b;
  const [dw, dh] = s.door;
  const [ww, wh] = s.window;
  const c = s.closet,
    p = s.partition;
  const features: CadFeature[] = [
    span('floor', [0, 0, 0], [W, W, b]),
    span('wall-s', [0, 0, b], [W, b, top]),
    span('wall-n', [0, W - b, b], [W, W, top]),
    span('wall-w', [0, b, b], [b, W - b, top]),
    span('wall-e', [W - b, b, b], [W, W - b, top]),
    // The closets: an L of partitions in each back corner, each with a 2 ft doorway.
    span('closet-w-front', [b, W - b - c, b], [b + c, W - b - c + p, top]),
    span('closet-w-side', [b + c - p, W - b - c, b], [b + c, W - b, top]),
    span('closet-e-front', [W - b - c, W - b - c, b], [W - b, W - b - c + p, top]),
    span('closet-e-side', [W - b - c, W - b - c, b], [W - b - c + p, W - b, top]),
    boolean('walls', 'union', [
      'floor',
      'wall-s',
      'wall-n',
      'wall-w',
      'wall-e',
      'closet-w-front',
      'closet-w-side',
      'closet-e-front',
      'closet-e-side',
    ]),
    span('door-cut', [W / 2 - dw / 2, -10, b], [W / 2 + dw / 2, b + 10, b + dh]),
    span('window-w-cut', [-10, W / 2 - ww / 2, s.sill], [b + 10, W / 2 + ww / 2, s.sill + wh]),
    span(
      'window-e-cut',
      [W - b - 10, W / 2 - ww / 2, s.sill],
      [W + 10, W / 2 + ww / 2, s.sill + wh],
    ),
    span(
      'closet-w-door',
      [b + 0.75 * foot, W - b - c - 10, b],
      [b + 2.75 * foot, W - b - c + p + 10, b + 6 * foot],
    ),
    span(
      'closet-e-door',
      [W - b - 2.75 * foot, W - b - c - 10, b],
      [W - b - 0.75 * foot, W - b - c + p + 10, b + 6 * foot],
    ),
    boolean('chamber', 'cut', [
      'walls',
      'door-cut',
      'window-w-cut',
      'window-e-cut',
      'closet-w-door',
      'closet-e-door',
    ]),
  ];
  // The hinges' knuckles on the back wall's top edge.
  const [, hy, hz] = hingeAt();
  const knuckles: string[] = [];
  for (const f of s.hinges) {
    const id = `hinge-${knuckles.length}`;
    features.push(cylinder(id, 0.75 * inch, 6 * inch, [W * f - 3 * inch, hy, hz], zAlongX));
    knuckles.push(id);
  }
  return applyCadOperation(emptyCad(kernel), {
    type: 'insertFeatures',
    parameters: [],
    sketches: [],
    features,
    bodies: [
      newBody('chamber-body', 'Chamber', 'chamber', paint),
      ...knuckles.map((k, i) => newBody(`${k}-body`, `Hinge ${i + 1}`, k, iron)),
    ],
  });
}

/** The ceiling board, lying on the walls (its top at 12 ft). */
export function bedchamberCeiling(kernel: Kernel): CadDocument {
  const s = bedchamberSizes;
  return applyCadOperation(emptyCad(kernel), {
    type: 'insertFeatures',
    parameters: [],
    sketches: [],
    features: [span('ceiling', [0, 0, s.height - s.board], [s.side, s.side, s.height])],
    bodies: [newBody('ceiling-body', 'Ceiling board', 'ceiling', paint)],
  });
}

const placed = (doc: CadDocument, lookup: Map<string, CadDocument>) => {
  doc.solvedPoses = solveJoints(
    doc,
    parameterValues(doc),
    (h) => lookup.get(h),
    () => undefined,
    () => true,
  ).poses;
  return doc;
};

/**
 * F112 as an assembly: the box and its ceiling board, the board on a revolute joint along the
 * hinges' line (0 shut, up to 100° open; a positive angle lifts the front edge).
 */
export function f112Bedchamber(kernel: Kernel, openRad = 0) {
  const s = bedchamberSizes;
  const chamber = fixtureVersion('gv-bedchamber-box', 'v1', bedchamberBox(kernel));
  const ceiling = fixtureVersion('gv-bedchamber-ceiling', 'v1', bedchamberCeiling(kernel));
  let doc = emptyCad(kernel);
  doc.parts = [
    fixturePart('part-chamber', 'Bedchamber', chamber, [
      [0, 0, 0],
      [s.side, s.side + inch, s.height],
    ]),
    fixturePart('part-ceiling', 'Ceiling board', ceiling, [
      [0, 0, s.height - s.board],
      [s.side, s.side, s.height],
    ]),
  ];
  doc.components = [
    fixtureComponent('c-chamber', 'part-chamber'),
    fixtureComponent('c-ceiling', 'part-ceiling'),
  ];
  const hinge = {
    ref: { origin: true as const },
    flip: false,
    offset: { translation: position(...hingeAt()), rotation: zAlongMinusX },
  };
  const joint: CadJoint = {
    id: 'j-ceiling',
    name: 'Ceiling hinges',
    type: 'revolute',
    parent: { componentPath: ['c-chamber'], ...hinge },
    child: { componentId: 'c-ceiling', connector: { componentPath: [], ...hinge } },
    values: { angle: { literalRad: openRad } },
    limits: [{ of: 'angle', min: 0, max: (100 * Math.PI) / 180 }],
  };
  doc = applyCadOperation(doc, { type: 'insertJoint', joint });
  const closure = new Map<string, CadDocument>([
    [chamber.contentHash, chamber.content],
    [ceiling.contentHash, ceiling.content],
  ]);
  return { assembly: placed(doc, closure), versions: [chamber, ceiling], closure };
}

/** The travelling box (F113). */
export const travellingSizes = {
  /** 本文: "about twelve feet square, and ten high". */
  side: 12 * foot,
  height: 10 * foot,
  board: 2 * inch,
  /** 創作: a window 2 × 2.5 ft in the middle of the front (−y), east and back walls. */
  window: [2 * foot, 2.5 * foot] as const,
  sill: 3.5 * foot,
  /** 創作: iron wire 6 mm thick every 3 in, in a frame 1 in wide on the outside. */
  wire: 3,
  pitch: 3 * inch,
  /** 本文: "a hole of a foot square", "not directly over the middle" (創作: where). */
  hole: 1 * foot,
  holeAt: [0.32, 0.5] as const,
  /** 創作: the ring 2 ft across, of iron 2 in thick, standing on the roof's middle. */
  ring: 1 * foot,
  ringBar: 1 * inch,
} as const;

/** A polygon sketch (closed) on a plane. */
function polygon(id: string, plane: CadSketch['plane'], corners: [number, number][]): CadSketch {
  const solved: Record<string, [number, number]> = {};
  const entities: CadSketch['entities'] = [];
  corners.forEach((c, k) => {
    solved[`${id}-p${k}`] = c;
    entities.push({ type: 'point', id: `${id}-p${k}` });
  });
  corners.forEach((_, k) =>
    entities.push({
      type: 'line',
      id: `${id}-l${k}`,
      start: `${id}-p${k}`,
      end: `${id}-p${(k + 1) % corners.length}`,
    }),
  );
  return { id, name: id, plane, entities, constraints: [], solved };
}

/**
 * F113: the travelling box, outside from (0, 0, 0) to (12, 12, 10) ft. Windows with an iron
 * lattice on the front (y = 0), east (x = 12 ft) and back walls; two staples on the west wall (x =
 * 0, the side without a window); the ring on the roof; the air hole and its sliding board.
 */
export function f113TravellingBox(kernel: Kernel): CadDocument {
  const s = travellingSizes;
  const W = s.side,
    H = s.height,
    b = s.board;
  const [ww, wh] = s.window;
  const [hx, hy] = s.holeAt;
  const features: CadFeature[] = [
    span('floor', [0, 0, 0], [W, W, b]),
    span('roof', [0, 0, H - b], [W, W, H]),
    span('wall-s', [0, 0, b], [W, b, H - b]),
    span('wall-n', [0, W - b, b], [W, W, H - b]),
    span('wall-w', [0, b, b], [b, W - b, H - b]),
    span('wall-e', [W - b, b, b], [W, W - b, H - b]),
    boolean('shell', 'union', ['floor', 'roof', 'wall-s', 'wall-n', 'wall-w', 'wall-e']),
    span('win-s', [W / 2 - ww / 2, -10, s.sill], [W / 2 + ww / 2, b + 10, s.sill + wh]),
    span('win-n', [W / 2 - ww / 2, W - b - 10, s.sill], [W / 2 + ww / 2, W + 10, s.sill + wh]),
    span('win-e', [W - b - 10, W / 2 - ww / 2, s.sill], [W + 10, W / 2 + ww / 2, s.sill + wh]),
    span(
      'air-hole',
      [W * hx - s.hole / 2, W * hy - s.hole / 2, H - b - 10],
      [W * hx + s.hole / 2, W * hy + s.hole / 2, H + 10],
    ),
    boolean('closet', 'cut', ['shell', 'win-s', 'win-n', 'win-e', 'air-hole']),
  ];
  const bodies: CadNewBody[] = [newBody('closet-body', 'Travelling closet', 'closet', paint)];

  // The lattices: a frame 1 in wide round each window on the outside, vertical wires 5 mm out
  // and horizontal ones 13 mm out (they do not touch), each row a pattern of one wire.
  const frameW = 1 * inch,
    depth = 20;
  const lattice = (side: 's' | 'n' | 'e') => {
    // In the window's own frame: u along the wall, v up, w outward; to world.
    const to = (u: number, v: number, w: number): V3 =>
      side === 's'
        ? [W / 2 + u, -w, s.sill + v]
        : side === 'n'
          ? [W / 2 - u, W + w, s.sill + v]
          : [W + w, W / 2 + u, s.sill + v];
    const uDir: V3 = side === 's' ? [1, 0, 0] : side === 'n' ? [-1, 0, 0] : [0, 1, 0];
    const corner = (id: string, u0: number, v0: number, u1: number, v1: number) =>
      span(id, to(u0, v0, 0), to(u1, v1, depth));
    const id = (n: string) => `lat-${side}-${n}`;
    const u0 = -ww / 2 - frameW,
      u1 = ww / 2 + frameW;
    features.push(
      corner(id('bottom'), u0, -frameW, u1, 0),
      corner(id('top'), u0, wh, u1, wh + frameW),
      corner(id('left'), u0, 0, -ww / 2, wh),
      corner(id('right'), ww / 2, 0, u1, wh),
      boolean(id('frame'), 'union', [id('bottom'), id('top'), id('left'), id('right')]),
    );
    const nv = Math.floor(ww / s.pitch) - 1,
      nh = Math.floor(wh / s.pitch) - 1;
    // A vertical wire (z along +z) 5 mm out, at the first pitch from the left.
    const vAt = to(-ww / 2 + s.pitch, -frameW / 2, 5);
    features.push(cylinder(id('v'), s.wire, wh + frameW, vAt));
    features.push({
      id: id('verticals'),
      name: id('verticals'),
      type: 'pattern',
      inputFeatureIds: [id('frame'), id('v')],
      args: {
        mode: 'union',
        layout: { type: 'linear', direction: uDir, count: { literal: nv }, spacing: mm(s.pitch) },
      },
    });
    // A horizontal wire along the wall 13 mm out, at the first pitch from the bottom.
    const hStart = to(-ww / 2 - frameW / 2, s.pitch, 13);
    const along: Quaternion = side === 'e' ? zAlongY : side === 's' ? zAlongX : zAlongMinusX;
    features.push(cylinder(id('h'), s.wire, ww + frameW, hStart, along));
    features.push({
      id: id('lattice'),
      name: id('lattice'),
      type: 'pattern',
      inputFeatureIds: [id('verticals'), id('h')],
      args: {
        mode: 'union',
        layout: {
          type: 'linear',
          direction: [0, 0, 1],
          count: { literal: nh },
          spacing: mm(s.pitch),
        },
      },
    });
    bodies.push(newBody(`lattice-${side}`, `Lattice (${side})`, id('lattice'), iron));
  };
  lattice('s');
  lattice('n');
  lattice('e');

  // The two staples on the west wall: an iron loop each, standing 4 in out from the wall.
  for (const [k, f] of [
    [0, 0.3],
    [1, 0.7],
  ] as const) {
    const y = W * f,
      z = H * 0.45,
      out = 4 * inch,
      t = 1 * inch,
      gap = 6 * inch;
    const id = (n: string) => `staple-${k}-${n}`;
    features.push(
      span(id('a'), [-out, y - gap / 2 - t, z], [1, y - gap / 2, z + t]),
      span(id('b'), [-out, y + gap / 2, z], [1, y + gap / 2 + t, z + t]),
      span(id('c'), [-out, y - gap / 2 - t, z], [-out + t, y + gap / 2 + t, z + t]),
      boolean(id('loop'), 'union', [id('a'), id('b'), id('c')]),
    );
    bodies.push(newBody(`staple-${k}`, `Staple ${k + 1}`, id('loop'), iron));
  }

  // The ring on the roof: a twelve-sided bar section turned about an axis along y, standing up
  // in the xz plane; a block on the roof holds it.
  const r = s.ring,
    t = s.ringBar / 2;
  const ringCentre: V3 = [W / 2, W / 2, H + r + t];
  const sides = 12;
  const section = polygon(
    'ring-section',
    { origin: position(...ringCentre), orientation: identityQuaternion() },
    Array.from({ length: sides }, (_, i) => {
      const a = (2 * Math.PI * i) / sides;
      return [r + t * Math.cos(a), t * Math.sin(a)] as [number, number];
    }),
  );
  features.push(
    {
      id: 'ring-turn',
      name: 'Ring',
      type: 'revolve',
      inputFeatureIds: [],
      args: {
        sketchId: section.id,
        region: {
          outer: section.entities.filter((e) => e.type === 'line').map((e) => e.id),
          holes: [],
        },
        axisOrigin: [mm(0), mm(0)],
        axisDirection: [0, 1],
        angle: { literalRad: 2 * Math.PI },
      },
    },
    span(
      'ring-block',
      [W / 2 - 2 * inch, W / 2 - 3 * inch, H - 1],
      [W / 2 + 2 * inch, W / 2 + 3 * inch, H + 2 * t + 10],
    ),
    boolean('ring', 'union', ['ring-turn', 'ring-block']),
  );
  bodies.push(newBody('ring-body', 'Ring', 'ring', iron));

  // The board over the air hole, half drawn back in its groove (two rails on the roof).
  const bx = W * hx,
    by = W * hy,
    half = s.hole / 2 + 2 * inch;
  features.push(
    span(
      'slide-board',
      [bx - half + s.hole / 2, by - half, H],
      [bx + half + s.hole / 2, by + half, H + 1 * inch],
    ),
    span(
      'groove-l',
      [bx - half - 1 * foot, by - half - 1 * inch, H - 1],
      [bx + half + 1.5 * foot, by - half, H + 1.5 * inch],
    ),
    span(
      'groove-r',
      [bx - half - 1 * foot, by + half, H - 1],
      [bx + half + 1.5 * foot, by + half + 1 * inch, H + 1.5 * inch],
    ),
  );
  bodies.push(
    newBody('slide-body', 'Sliding board', 'slide-board', oak),
    newBody('groove-l-body', 'Groove rail', 'groove-l', oak),
    newBody('groove-r-body', 'Groove rail', 'groove-r', oak),
  );

  return applyCadOperation(emptyCad(kernel), {
    type: 'insertFeatures',
    parameters: [],
    sketches: [section],
    features,
    bodies,
  });
}
