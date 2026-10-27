import {
  applyBimOperation,
  arcOf,
  arcPoint,
  BimContext,
  bimWallAxis,
  distance,
  dot,
  lineIntersection,
  proposeJoins,
  sub,
  unit,
  type BimDocument,
  type BimElement,
  type BimLoop,
  type BimOperation,
  type BimPoint,
  type BimTop,
  type BimWall,
  type BimWallJoin,
  type Vec2,
} from '@editor-platform/bim-core';

/**
 * Drawing on a level's plane (docs/cad/r2c-architecture.md, Surface; R2c-3c-2), without React:
 * snapping a plan point, and the one operation each drawing command makes. The caller applies
 * the operation as one command, so a drawing is one Undo step.
 */

export type BimDraftTool =
  | 'select'
  | 'wall'
  | 'slab'
  | 'space'
  | 'column'
  | 'beam'
  | 'door'
  | 'window'
  | 'opening'
  | 'grid'
  | 'part'
  | 'section';

/** The tools that take one point, two points, or a closed polygon. */
export const bimToolPoints: Record<Exclude<BimDraftTool, 'select'>, 'one' | 'two' | 'loop'> = {
  wall: 'two',
  slab: 'loop',
  space: 'loop',
  column: 'one',
  beam: 'two',
  door: 'one',
  window: 'one',
  opening: 'one',
  grid: 'two',
  part: 'one',
  section: 'two',
};

export const bimDraftDefaults = Object.freeze({
  /** Coordinates round to this step when nothing else is near. */
  stepMm: 100,
  /** A grid intersection or a wall end within this distance is taken (a plan with no scale). */
  snapMm: 300,
  /** On screen: a grid intersection or a wall end within this many pixels is taken. */
  snapPx: 10,
  /** Height of a wall or column with no level above. */
  storeyMm: 3000,
  /** Size of an opening without a type. */
  openingMm: { widthMm: 1000, heightMm: 2100 },
  /** Sill of a new window. */
  sillMm: 900,
});

/** A snapped plan point: a grid intersection keeps its grid reference, so it follows the axes. */
export interface BimSnap {
  xy: Vec2;
  point: BimPoint;
  kind: 'grid' | 'end' | 'step';
}

/** The snap radius on a plan where one screen pixel spans `mmPerPx`: the same few pixels at any zoom. */
export function bimSnapRadius(mmPerPx?: number) {
  return mmPerPx && Number.isFinite(mmPerPx) && mmPerPx > 0
    ? bimDraftDefaults.snapPx * mmPerPx
    : bimDraftDefaults.snapMm;
}

/** Snaps `p` to a grid intersection, then a wall end on the level, then the step. */
export function bimSnap(
  doc: BimDocument,
  level: string,
  p: Vec2,
  options: { stepMm?: number; snapMm?: number } = {},
): BimSnap {
  const step = options.stepMm ?? bimDraftDefaults.stepMm;
  const radius = options.snapMm ?? bimDraftDefaults.snapMm;
  let best: BimSnap | undefined;
  let bestD = radius;
  const consider = (snap: BimSnap) => {
    const d = distance(snap.xy, p);
    if (d < bestD) {
      bestD = d;
      best = snap;
    }
  };
  for (let i = 0; i < doc.grids.length; i++)
    for (let j = i + 1; j < doc.grids.length; j++) {
      const a = doc.grids[i]!;
      const b = doc.grids[j]!;
      const hit = lineIntersection(a.start, sub(a.end, a.start), b.start, sub(b.end, b.start));
      if (hit) consider({ xy: hit, point: { grid: [a.id, b.id] }, kind: 'grid' });
    }
  if (best) return best;
  const ctx = new BimContext(doc);
  for (const e of doc.elements)
    if (e.kind === 'wall' && e.base.level === level)
      for (const end of [e.start, e.end]) {
        const xy = ctx.point(end, '');
        consider({ xy, point: 'grid' in end ? end : { xy }, kind: 'end' });
      }
  if (best) return best;
  // `|| 0`: a coordinate never stores -0.
  const xy: Vec2 = [Math.round(p[0] / step) * step || 0, Math.round(p[1] / step) * step || 0];
  return { xy, point: { xy }, kind: 'step' };
}

/** A new ID with `prefix` that the document does not use. */
export function bimNewId(doc: BimDocument, prefix: string, taken: Set<string> = new Set()) {
  const used = new Set([
    ...taken,
    ...doc.levels.map((x) => x.id),
    ...doc.grids.map((x) => x.id),
    ...doc.materials.map((x) => x.id),
    ...doc.types.map((x) => x.id),
    ...doc.elements.map((x) => x.id),
    ...doc.joins.map((x) => x.id),
    ...doc.views.map((x) => x.id),
    ...doc.propertySets.map((x) => x.id),
  ]);
  for (let n = 1; ; n++) if (!used.has(`${prefix}-${n}`)) return `${prefix}-${n}`;
}

/**
 * The next free grid label: an axis that runs along x is lettered (A, B, … Z, AA, …), one that
 * runs along y is numbered (1, 2, …), as on a drawing.
 */
export function bimGridLabel(doc: BimDocument, a: Vec2, b: Vec2) {
  const used = new Set(doc.grids.map((g) => g.label));
  const alongX = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]);
  const letters = (n: number): string =>
    (n >= 26 ? letters(Math.floor(n / 26) - 1) : '') + String.fromCharCode(65 + (n % 26));
  for (let n = 0; ; n++) {
    const label = alongX ? letters(n) : String(n + 1);
    if (!used.has(label)) return label;
  }
}

/** A grid axis from `a` to `b`; its ends are plain coordinates (an axis never hangs on another). */
export function draftGrid(doc: BimDocument, a: Vec2, b: Vec2): BimOperation {
  if (distance(a, b) < 1) throw new Error('grid-too-short');
  return {
    type: 'insert',
    entities: {
      grids: [{ id: bimNewId(doc, 'g'), label: bimGridLabel(doc, a, b), start: a, end: b }],
    },
  };
}

/** New views (R2c-5): a plan cut 1,200 mm above its level and seeing down to it, at 1:100. */
export const bimViewDefaults = Object.freeze({
  cutHeightMm: 1200,
  scale: 100 as const,
  /** How far a section sees past its line. */
  sectionDepthMm: 20_000,
});
const freeName = (doc: BimDocument, base: (n: number) => string, first = 1) => {
  const names = new Set(doc.views.map((v) => v.name));
  let n = first;
  while (names.has(base(n))) n++;
  return base(n);
};

/** A plan of a level, named after it. */
export function draftPlanView(doc: BimDocument, level: string): BimOperation {
  const l = doc.levels.find((x) => x.id === level);
  if (!l) throw new Error('level-missing');
  return {
    type: 'insert',
    entities: {
      views: [
        {
          id: bimNewId(doc, 'v'),
          kind: 'plan',
          name: freeName(doc, (n) => (n === 1 ? `${l.name} plan` : `${l.name} plan ${n}`)),
          level,
          cutHeightMm: bimViewDefaults.cutHeightMm,
          depthMm: bimViewDefaults.cutHeightMm,
          scale: bimViewDefaults.scale,
        },
      ],
    },
  };
}

/** A section along a line drawn on the plan, looking to its left. */
export function draftSectionView(doc: BimDocument, a: Vec2, b: Vec2): BimOperation {
  if (distance(a, b) < 1) throw new Error('section-too-short');
  return {
    type: 'insert',
    entities: {
      views: [
        {
          id: bimNewId(doc, 'v'),
          kind: 'section',
          name: freeName(doc, (n) => `Section ${n}`),
          line: [a, b],
          direction: 'left',
          depthMm: bimViewDefaults.sectionDepthMm,
          scale: bimViewDefaults.scale,
        },
      ],
    },
  };
}

/** A level one storey above the highest, named after the count (`3F`, …). */
export function draftLevel(doc: BimDocument): BimOperation {
  // The highest level, below zero too; an empty building starts at 0.
  const top = Math.max(...doc.levels.map((l) => l.elevationMm));
  const names = new Set(doc.levels.map((l) => l.name));
  let n = doc.levels.length + 1;
  while (names.has(`${n}F`)) n++;
  return {
    type: 'insert',
    entities: {
      levels: [
        {
          id: bimNewId(doc, 'l'),
          name: `${n}F`,
          elevationMm: doc.levels.length ? top + bimDraftDefaults.storeyMm : 0,
        },
      ],
    },
  };
}

/** Up to the level above, or a storey's height on the top level. */
function storeyTop(doc: BimDocument, level: string): BimTop {
  const here = doc.levels.find((l) => l.id === level)!;
  const above = doc.levels
    .filter((l) => l.elevationMm > here.elevationMm)
    .sort((a, b) => a.elevationMm - b.elevationMm)[0];
  return above ? { level: above.id, offsetMm: 0 } : { heightMm: bimDraftDefaults.storeyMm };
}
/** The first type of a kind, or the one asked for. */
function typeOf(doc: BimDocument, kind: string, typeId?: string) {
  const t = typeId
    ? doc.types.find((x) => x.id === typeId && x.kind === kind)
    : doc.types.find((x) => x.kind === kind);
  if (!t) throw new Error(`type-missing:${kind}`);
  return t;
}

/**
 * OH-U2: the bulge of the arc from `a` to `b` through `m` (tan of a quarter of the signed sweep,
 * positive counter-clockwise). 0 when `m` lies on the chord's line between them: a straight
 * edge. `m` at an end, or on the line outside the chord, gives no arc; an arc past a half
 * circle (`m` beyond the circle's diameter) is refused, as a building's arcs are.
 */
export function bimBulgeThrough(a: Vec2, b: Vec2, m: Vec2): number {
  const chord = distance(a, b);
  if (chord < 1 || distance(a, m) < 1 || distance(b, m) < 1) throw new Error('arc-degenerate');
  const ma = sub(a, m);
  const mb = sub(b, m);
  const side = ma[0] * mb[1] - ma[1] * mb[0];
  // The angle at `m` between the ends; the arc's sweep is twice its supplement.
  const angle = Math.atan2(Math.abs(side), dot(ma, mb));
  if (Math.abs(side) <= 1e-9 * chord * chord) {
    if (angle > Math.PI / 2) return 0;
    throw new Error('arc-degenerate');
  }
  // `m` to the right of a→b (a negative turn from m's view) makes a counter-clockwise arc.
  const bulge = Math.tan((Math.PI - angle) / 2);
  // A building's arcs sweep at most a half circle (|bulge| ≤ 1).
  if (bulge > 1 + 1e-9) throw new Error('arc-over-half-circle');
  return -Math.sign(side) * Math.min(bulge, 1);
}

/** Points along a plan edge with `bulge`, `a` excluded and `b` included, for the draft marks. */
export function bimEdgePoints(a: Vec2, b: Vec2, bulge: number, per = 24): Vec2[] {
  if (!bulge) return [b];
  const arc = arcOf(a, b, bulge);
  return Array.from({ length: per }, (_, i) => (i === per - 1 ? b : arcPoint(arc, (i + 1) / per)));
}

/**
 * A loop from its corners and the bulge of the edge from each to the next. With fewer than three
 * corners, each arc edge is split at its middle (half the sweep each side), so two corners joined
 * by an arc and a line, or by two arcs, make a loop of three or four corners.
 */
export function bimLoopOfEdges(corners: Vec2[], bulges: readonly number[]): BimLoop {
  const loop: BimLoop = [];
  corners.forEach((p, i) => {
    const b = bulges[i] ?? 0;
    if (!b || corners.length >= 3) return void loop.push(b ? [...p, b] : p);
    const q = corners[(i + 1) % corners.length]!;
    const half = Math.tan(Math.atan(b) / 2);
    loop.push([...p, half], [...arcPoint(arcOf(p, q, b), 0.5), half]);
  });
  return loop;
}

/** A wall from `a` to `b`, with the joins its ends make with walls already drawn (R2c-U3). */
export function draftWall(
  doc: BimDocument,
  level: string,
  a: BimSnap,
  b: BimSnap,
  typeId?: string,
  /** OH-U2: an arc wall's bulge (see `bimBulgeThrough`). */
  bulge = 0,
): BimOperation {
  if (distance(a.xy, b.xy) < 1) throw new Error('wall-too-short');
  const wall: BimWall = {
    id: bimNewId(doc, 'w'),
    kind: 'wall',
    typeId: typeOf(doc, 'wall', typeId).id,
    start: a.point,
    end: b.point,
    ...(bulge ? { bulge } : {}),
    location: 'center',
    base: { level, offsetMm: 0 },
    top: storeyTop(doc, level),
  };
  // The joins are proposed against the document with the wall in it; a join that cannot be
  // made refuses the whole drawing, which then names it.
  const withWall = applyBimOperation(doc, { type: 'insert', entities: { elements: [wall] } });
  const taken = new Set<string>();
  const joins: BimWallJoin[] = proposeJoins(withWall, wall.id).map((j) => {
    const id = bimNewId(withWall, 'j', taken);
    taken.add(id);
    return { id, ...j };
  });
  return {
    type: 'insert',
    entities: { elements: [wall], ...(joins.length ? { joins } : {}) },
  };
}

/** A slab whose top is at the level, or a space from the level up to the level above. */
export function draftRegion(
  doc: BimDocument,
  level: string,
  kind: 'slab' | 'space',
  /** Corners; a corner's third value is the bulge of the edge to the next (OH-U2). */
  loop: BimLoop,
  typeId?: string,
): BimOperation {
  if (loop.length < 3) throw new Error('loop-too-short');
  const element: BimElement =
    kind === 'slab'
      ? {
          id: bimNewId(doc, 's'),
          kind: 'slab',
          typeId: typeOf(doc, 'slab', typeId).id,
          top: { level, offsetMm: 0 },
          boundary: loop,
          holes: [],
        }
      : {
          id: bimNewId(doc, 'sp'),
          kind: 'space',
          number: String(doc.elements.filter((e) => e.kind === 'space').length + 1),
          base: { level, offsetMm: 0 },
          ...('heightMm' in storeyTop(doc, level) ? { top: storeyTop(doc, level) } : {}),
          boundary: loop,
        };
  return { type: 'insert', entities: { elements: [element] } };
}

export function draftColumn(
  doc: BimDocument,
  level: string,
  at: BimSnap,
  typeId?: string,
): BimOperation {
  return {
    type: 'insert',
    entities: {
      elements: [
        {
          id: bimNewId(doc, 'c'),
          kind: 'column',
          typeId: typeOf(doc, 'column', typeId).id,
          at: at.point,
          rotationRad: 0,
          base: { level, offsetMm: 0 },
          top: storeyTop(doc, level),
        },
      ],
    },
  };
}

/** A part (a CAD version's shape) standing on the level, unturned. */
export function draftPart(
  doc: BimDocument,
  level: string,
  at: BimSnap,
  typeId?: string,
): BimOperation {
  return {
    type: 'insert',
    entities: {
      elements: [
        {
          id: bimNewId(doc, 'p'),
          kind: 'part',
          typeId: typeOf(doc, 'part', typeId).id,
          at: at.point,
          base: { level, offsetMm: 0 },
          rotationRad: 0,
        },
      ],
    },
  };
}

/** A beam whose top is at the level (it carries that level's floor). */
export function draftBeam(
  doc: BimDocument,
  level: string,
  a: BimSnap,
  b: BimSnap,
  typeId?: string,
): BimOperation {
  if (distance(a.xy, b.xy) < 1) throw new Error('beam-too-short');
  return {
    type: 'insert',
    entities: {
      elements: [
        {
          id: bimNewId(doc, 'b'),
          kind: 'beam',
          typeId: typeOf(doc, 'beam', typeId).id,
          start: a.point,
          end: b.point,
          top: { level, offsetMm: 0 },
        },
      ],
    },
  };
}

/** The straight or arc wall on the level whose body `p` is in or nearest to, within `reachMm`. */
export function bimWallAt(doc: BimDocument, level: string, p: Vec2, reachMm = 300) {
  const ctx = new BimContext(doc);
  let best: { wall: BimWall; alongMm: number; lengthMm: number; d: number } | undefined;
  for (const e of doc.elements) {
    if (e.kind !== 'wall' || e.base.level !== level) continue;
    let axis;
    try {
      axis = bimWallAxis(ctx, e);
    } catch {
      continue;
    }
    let along: number;
    if (!axis.arc) along = dot(sub(p, axis.s), unit(sub(axis.e, axis.s)));
    else {
      // The angle from the start, in the arc's direction; past the arc, the nearer end.
      const { center, startAngle, sweep, radius } = axis.arc;
      const turn = Math.PI * 2;
      const t =
        ((((Math.atan2(p[1] - center[1], p[0] - center[0]) - startAngle) * Math.sign(sweep)) %
          turn) +
          turn) %
        turn;
      along = t <= Math.abs(sweep) ? t * radius : t - Math.abs(sweep) < turn - t ? axis.length : 0;
    }
    along = Math.min(Math.max(along, 0), axis.length);
    const d = distance(axis.at(along)[0], p);
    if (d <= reachMm && (!best || d < best.d))
      best = { wall: e, alongMm: along, lengthMm: axis.length, d };
  }
  return best;
}

/**
 * A door, window or opening centred at the clicked point of a wall, kept inside the wall when
 * it fits; a wall too short for it is refused by validation (`opening-outside-host`).
 */
export function draftHosted(
  doc: BimDocument,
  kind: 'door' | 'window' | 'opening',
  host: { wall: BimWall; alongMm: number; lengthMm: number },
  typeId?: string,
): BimOperation {
  const t = kind === 'opening' ? undefined : typeOf(doc, kind, typeId);
  const width = t && 'widthMm' in t ? t.widthMm : bimDraftDefaults.openingMm.widthMm;
  // Rounded first, then kept inside: rounding never pushes a fitting opening past the end.
  const start = Math.min(
    Math.max(Math.round(host.alongMm - width / 2), 0),
    Math.max(Math.floor(host.lengthMm - width), 0),
  );
  const base = { id: bimNewId(doc, kind === 'opening' ? 'o' : kind === 'door' ? 'd' : 'win') };
  const element: BimElement =
    kind === 'door'
      ? {
          ...base,
          kind,
          typeId: t!.id,
          hostId: host.wall.id,
          alongMm: start,
          flipFacing: false,
          flipHand: false,
        }
      : kind === 'window'
        ? {
            ...base,
            kind,
            typeId: t!.id,
            hostId: host.wall.id,
            alongMm: start,
            sillMm: bimDraftDefaults.sillMm,
            flipFacing: false,
          }
        : {
            ...base,
            kind: 'opening',
            hostId: host.wall.id,
            wall: { alongMm: start, sillMm: 0, ...bimDraftDefaults.openingMm },
          };
  return { type: 'insert', entities: { elements: [element] } };
}
