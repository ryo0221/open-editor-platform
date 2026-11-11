/**
 * WM5 fixture F71 (docs/cad/watch-design.md, WM5): the movement of the sample skeleton watch
 * SK-01, an original 30 mm hand-wound movement. Every part is a version made with the builder
 * (gears as `spurGear`, plates and bridges as one extrude of a sketch with its windows as holes,
 * no Boolean); the assembly places them on revolute joints and meshes the train with gear meshes
 * driven from the escape wheel, so the escapement keys (WM4) turn the whole train and the hands:
 *
 *   escape pinion 7 → fourth wheel 84 (12:1, the fourth wheel turns once a minute)
 *   fourth pinion 8 → third wheel 75, third pinion 10 → centre wheel 64 (60:1, once an hour)
 *   centre pinion 10 → barrel 80; cannon pinion 12 → minute wheel 36, minute pinion 10 →
 *   hour wheel 40 (12:1, once in twelve hours).
 *
 * At 28,800 beats an hour the 20-tooth escape wheel turns 12 times a minute. The pallet stones
 * sit at ±22.5° (2.5 teeth apart) about the line to the pallet arbor, so a half-tooth step
 * brings a gap under the other stone. Layout and z layers are in `sk01Layout`; parts never meet
 * except gears in mesh (checked in `sk01.test.ts`). Nothing here evaluates geometry.
 */
import { fixtureComponent, fixturePart, fixtureVersion } from './assembly-fixtures';
import { cadBuilder, type CadBuilder } from './builder';
import { fixtureKernel } from './fixtures';
import { currentConfigurationValues } from './configurations';
import { applyGearMeshOperation, checkGearMesh, type CadGearMesh } from './gear-mesh';
import { parameterValues } from './graph';
import { fixtureConnector, fixtureJoint } from './joints-fixtures';
import { solveJoints } from './joints';
import {
  position,
  type CadAppearance,
  type CadAssetRef,
  type CadDocument,
  type CadKernelProfile,
  type CadSketchSection,
  type Vec3,
} from './model';
import type { CadSketchEntity } from './sketch';
import { assertCad } from './validation';

type Pt = [number, number];
const rad = Math.PI / 180;
const polar = (c: Pt, d: number, aDeg: number): Pt => [
  c[0] + d * Math.cos(aDeg * rad),
  c[1] + d * Math.sin(aDeg * rad),
];
const rotate = (p: Pt, about: Pt, a: number): Pt => {
  const [x, y] = [p[0] - about[0], p[1] - about[1]];
  return [
    about[0] + x * Math.cos(a) - y * Math.sin(a),
    about[1] + x * Math.sin(a) + y * Math.cos(a),
  ];
};

/** The train's modules (mm) by pair, and the escapement's sizes. */
export const sk01Gears = Object.freeze({
  escapeFourth: { module: 0.08, driver: 7, driven: 84 },
  fourthThird: { module: 0.09, driver: 8, driven: 75 },
  thirdCentre: { module: 0.1, driver: 10, driven: 64 },
  centreBarrel: { module: 0.15, driver: 10, driven: 80 },
  cannonMinute: { module: 0.1, driver: 12, driven: 36 },
  minuteHour: { module: 0.096, driver: 10, driven: 40 },
});
export const sk01Escapement = Object.freeze({
  teeth: 20,
  /** Tip and root radii of the escape wheel (mm). */
  tip: 1.95,
  root: 1.55,
  /** The pallet arbor's distance from the escape arbor, and the balance's beyond it (mm). */
  pallet: 2.6,
  balance: 4.6,
  /** Each stone's angle about the escape arbor from the line to the pallet arbor. */
  stoneAngle: 22.5 * rad,
  /** How deep a stone's tip enters below the teeth's tips when its side is down (mm). */
  dip: 0.12,
  /** The fork's swing to each side (WM4 `forkAngle`). */
  forkAngle: 10 * rad,
  /** The balance's rim (mm) and the impulse pin's radius on the roller. */
  rim: { inner: 3.65, outer: 4.05 },
  impulsePin: 0.5,
});
const centreDistance = (p: { module: number; driver: number; driven: number }) =>
  (p.module * (p.driver + p.driven)) / 2;

/**
 * Arbor positions on the plate (mm, the centre wheel at the origin) and the z layers (mm, the
 * plate's top at 0.8; the dial side below 0).
 */
export const sk01Layout = (() => {
  const g = sk01Gears;
  const centre: Pt = [0, 0];
  const third = polar(centre, centreDistance(g.thirdCentre), 170);
  const fourth = polar(third, centreDistance(g.fourthThird), 280);
  const escape = polar(fourth, centreDistance(g.escapeFourth), 340);
  const pallet = polar(escape, sk01Escapement.pallet, 300);
  const balance = polar(escape, sk01Escapement.balance, 300);
  const barrel = polar(centre, centreDistance(g.centreBarrel), 95);
  const minute = polar(centre, centreDistance(g.cannonMinute), 60);
  return {
    arbors: { centre, third, fourth, escape, pallet, balance, barrel, minute },
    /** The direction from the escape arbor to the pallet arbor (degrees). */
    escapementAxis: 300,
    plate: { radius: 15, z: [0, 0.8] as Pt },
    z: {
      barrel: { drum: [0.9, 1.5] as Pt, gear: [1.0, 1.3] as Pt },
      centre: { pinion: [0.9, 1.5] as Pt, wheel: [1.7, 1.9] as Pt, cannon: [-0.7, -0.3] as Pt },
      third: { pinion: [1.6, 2.0] as Pt, wheel: [2.2, 2.4] as Pt },
      fourth: { pinion: [2.1, 2.5] as Pt, wheel: [2.7, 2.9] as Pt },
      escape: { pinion: [2.6, 3.0] as Pt, wheel: [1.0, 1.2] as Pt },
      pallet: { stones: [0.95, 1.4] as Pt, fork: [1.3, 1.45] as Pt },
      balance: {
        roller: [1.3, 1.45] as Pt,
        spring: [2.5, 2.65] as Pt,
        rim: [3.0, 3.3] as Pt,
        staff: [0.8, 3.6] as Pt,
      },
      minute: { wheel: [-0.7, -0.5] as Pt, pinion: [-1.1, -0.6] as Pt },
      hour: { wheel: [-1.0, -0.8] as Pt },
      /**
       * WM5b: the hands' blades on the dial side, from the plate outwards: small seconds, hour,
       * minute (each 0.06 mm thick). The fourth arbor ends at the seconds hand, 0.09 mm short of
       * the hour hand's sweep; the chapter ring lies just under the plate, outside the hands.
       */
      hands: {
        seconds: [-1.2, -1.14] as Pt,
        hour: [-1.35, -1.29] as Pt,
        minute: [-1.55, -1.49] as Pt,
      },
      chapterRing: [-0.25, -0.05] as Pt,
      arbor: [0.8, 3.4] as Pt,
      bridges: [3.4, 4.0] as Pt,
      cock: [3.6, 4.1] as Pt,
    },
  };
})();

const steel: Partial<CadAppearance> = { color: '#c9ccd2', metalness: 1, roughness: 0.25 };
const brass: Partial<CadAppearance> = { color: '#d8b46a', metalness: 1, roughness: 0.3 };
const plateGrey: Partial<CadAppearance> = { color: '#a9adb4', metalness: 1, roughness: 0.4 };
/** WM6: synthetic ruby, red and partly clear (its index of refraction, 1.77). */
const ruby: Partial<CadAppearance> = {
  color: '#b0123a',
  metalness: 0,
  roughness: 0.05,
  transmission: 0.6,
  ior: 1.77,
};
const blued: Partial<CadAppearance> = { color: '#24306e', metalness: 1, roughness: 0.3 };

/**
 * A sketch loop: a circle, a closed polygon, or (WM6) the round outline of circles of radius `r`
 * at `centres` (convex, counter-clockwise): an arc on each centre joined by tangent lines.
 */
type Loop =
  | { type: 'circle'; c: Pt; r: number }
  | { type: 'poly'; pts: Pt[] }
  | { type: 'rounded'; centres: Pt[]; r: number };
/** The arcs of a rounded loop: centre, start and end (counter-clockwise), and its turn. */
function roundedArcs(l: Extract<Loop, { type: 'rounded' }>) {
  const c = l.centres;
  const normal = (a: Pt, b: Pt): Pt => {
    const d = dist(a, b);
    return [(b[1] - a[1]) / d, -(b[0] - a[0]) / d];
  };
  return c.map((p, i) => {
    const prev = c[(i + c.length - 1) % c.length]!;
    const next = c[(i + 1) % c.length]!;
    const nIn = normal(prev, p);
    const nOut = normal(p, next);
    let turn = Math.atan2(nOut[1], nOut[0]) - Math.atan2(nIn[1], nIn[0]);
    if (turn <= 0) turn += 2 * Math.PI;
    return {
      c: p,
      start: [p[0] + l.r * nIn[0], p[1] + l.r * nIn[1]] as Pt,
      end: [p[0] + l.r * nOut[0], p[1] + l.r * nOut[1]] as Pt,
      turn,
      mid: Math.atan2(nIn[1], nIn[0]) + turn / 2,
    };
  });
}
/** One sketch of `outer` with `holes` (each a circle or a closed polygon), as a section. */
function region(b: CadBuilder, name: string, z: number, outer: Loop, holes: Loop[]) {
  const points: Record<string, Pt> = {};
  const entities: Exclude<CadSketchEntity, { type: 'point' }>[] = [];
  const solved: Record<string, Pt> = {};
  let n = 0;
  const loop = (l: Loop): string[] => {
    const k = n++;
    if (l.type === 'circle') {
      points[`c${k}`] = l.c;
      entities.push({ type: 'circle', id: `o${k}`, center: `c${k}` });
      solved[`o${k}`] = [l.r, 0];
      return [`o${k}`];
    }
    if (l.type === 'rounded') {
      // Arc a_i on centre i, then line b_i to the next arc's start.
      const arcs = roundedArcs(l);
      const ids: string[] = [];
      arcs.forEach((a, i) => {
        points[`c${k}_${i}`] = a.c;
        points[`s${k}_${i}`] = a.start;
        points[`e${k}_${i}`] = a.end;
      });
      arcs.forEach((_, i) => {
        entities.push({
          type: 'arc',
          id: `a${k}_${i}`,
          center: `c${k}_${i}`,
          start: `s${k}_${i}`,
          end: `e${k}_${i}`,
          clockwise: false,
        });
        entities.push({
          type: 'line',
          id: `b${k}_${i}`,
          start: `e${k}_${i}`,
          end: `s${k}_${(i + 1) % arcs.length}`,
        });
        ids.push(`a${k}_${i}`, `b${k}_${i}`);
      });
      return ids;
    }
    l.pts.forEach((p, i) => (points[`p${k}_${i}`] = p));
    return l.pts.map((_, i) => {
      const id = `l${k}_${i}`;
      entities.push({
        type: 'line',
        id,
        start: `p${k}_${i}`,
        end: `p${k}_${(i + 1) % l.pts.length}`,
      });
      return id;
    });
  };
  const o = loop(outer);
  const h = holes.map(loop);
  const sketchId = b.sketch(name, { origin: [0, 0, z] }, points, entities, { solved });
  return { sketchId, region: { outer: o, holes: h } } satisfies CadSketchSection;
}
/**
 * WM6 (docs/cad/watch-design.md, 仕上げ): the decoration as image maps, each a colour map and an
 * OpenGL normal map (`sk01FinishImages`, PNG assets the caller stores): perlage on the main
 * plate, Côtes de Genève on the bridges. Without it the parts are plain.
 */
export interface Sk01Finish {
  perlage: { color: CadAssetRef; normal: CadAssetRef };
  cotes: { color: CadAssetRef; normal: CadAssetRef };
}
/** The size one image of each decoration covers (mm). */
export const sk01FinishTile = Object.freeze({ perlage: 2.4, cotes: 6 });
function finishBody(
  b: CadBuilder,
  body: string,
  finish: Sk01Finish | undefined,
  kind: keyof Sk01Finish,
) {
  const maps = finish?.[kind];
  if (!maps) return;
  const size = sk01FinishTile[kind];
  b.appearance(
    body,
    {
      color: '#e2e4e8',
      roughness: 0.35,
      textures: {
        maps: { color: maps.color.id, normal: maps.normal.id },
        sizeMm: [size, size],
        rotationDeg: 0,
        normal: 'gl',
        name: kind === 'cotes' ? 'Côtes de Genève' : 'Perlage',
      },
    },
    [maps.color, maps.normal],
  );
}
/**
 * WM6 anglage: a chamfer of `d` on every edge of an extruded region's far face (its `end`):
 * the outline and each window, as the region's sketch elements name its sides.
 */
function chamferTop(
  b: CadBuilder,
  body: string,
  section: CadSketchSection,
  zTop: number,
  d: number,
  outer: Loop,
  holes: Loop[],
) {
  const edges: Parameters<CadBuilder['chamfer']>[1] = [];
  const add = (ids: string[], l: Loop) => {
    if (l.type === 'circle')
      edges.push({
        faces: [[`side:e:${ids[0]}`], ['end']],
        centroid: [l.c[0], l.c[1], zTop],
        length: 2 * Math.PI * l.r,
      });
    else if (l.type === 'rounded')
      roundedArcs(l).forEach((a, i) => {
        const next = roundedArcs(l)[(i + 1) % l.centres.length]!;
        edges.push({
          faces: [[`side:e:${ids[2 * i]}`], ['end']],
          centroid: [a.c[0] + l.r * Math.cos(a.mid), a.c[1] + l.r * Math.sin(a.mid), zTop],
          length: l.r * a.turn,
        });
        edges.push({
          faces: [[`side:e:${ids[2 * i + 1]}`], ['end']],
          centroid: [(a.end[0] + next.start[0]) / 2, (a.end[1] + next.start[1]) / 2, zTop],
          length: dist(a.end, next.start),
        });
      });
    else
      ids.forEach((id, i) => {
        const p = l.pts[i]!;
        const q = l.pts[(i + 1) % l.pts.length]!;
        edges.push({
          faces: [[`side:e:${id}`], ['end']],
          centroid: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, zTop],
          length: dist(p, q),
        });
      });
  };
  add(section.region.outer, outer);
  holes.forEach((l, i) => add(section.region.holes[i]!, l));
  b.chamfer(body, edges, d, 'Anglage');
}
const ring = (c: Pt, r: number, n = 40): Pt[] =>
  Array.from({ length: n }, (_, i) => polar(c, r, (360 * i) / n));
/** The convex hull of the points (counter-clockwise, no repeats). */
function hull(points: Pt[]): Pt[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Pt, a: Pt, b: Pt) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: Pt[]) => {
    const h: Pt[] = [];
    for (const q of list) {
      while (h.length >= 2 && cross(h[h.length - 2]!, h[h.length - 1]!, q) <= 1e-12) h.pop();
      h.push(q);
    }
    h.pop();
    return h;
  };
  return [...half(p), ...half([...p].reverse())];
}
/** A rounded outline around circles of radius `r` at the points (their convex hull). */
const around = (pts: Pt[], r: number) => hull(pts.flatMap((p) => ring(p, r, 24)));
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const inside = (p: Pt, poly: Pt[]) => {
  let n = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [a, b] = [poly[i]!, poly[j]!];
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      n++;
  }
  return n % 2 === 1;
};
const edgeDistance = (p: Pt, poly: Pt[]) => {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [a, b] = [poly[i]!, poly[(i + 1) % poly.length]!];
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const t = Math.max(
      0,
      Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)),
    );
    best = Math.min(best, dist(p, [a[0] + t * dx, a[1] + t * dy]));
  }
  return best;
};
/**
 * Round windows in an outline (the skeleton look): the largest circles, at most `max` mm in
 * radius and `count` in all, leaving a `web` of metal to the outline, to each keep-out circle and
 * to each other. Deterministic (a grid, largest first).
 */
export function sk01Windows(
  outline: Exclude<Loop, { type: 'rounded' }>,
  keep: { c: Pt; r: number }[],
  o: { web: number; max: number; min: number; count: number },
): { c: Pt; r: number }[] {
  const edge = (p: Pt) =>
    outline.type === 'circle'
      ? outline.r - dist(p, outline.c)
      : inside(p, outline.pts)
        ? edgeDistance(p, outline.pts)
        : -1;
  const pts = outline.type === 'circle' ? ring(outline.c, outline.r, 4) : outline.pts;
  const [x0, x1] = [Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[0]))];
  const [y0, y1] = [Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[1]))];
  const chosen: { c: Pt; r: number }[] = [];
  const step = 0.25;
  while (chosen.length < o.count) {
    let best: { c: Pt; r: number } | undefined;
    for (let x = x0; x <= x1; x += step)
      for (let y = y0; y <= y1; y += step) {
        const p: Pt = [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000];
        let r = Math.min(o.max, edge(p) - o.web);
        for (const k of [...keep, ...chosen]) r = Math.min(r, dist(p, k.c) - k.r - o.web);
        if (r >= o.min && (!best || r > best.r + 1e-9)) best = { c: p, r };
      }
    if (!best) break;
    chosen.push({ c: best.c, r: Math.round(best.r * 1000) / 1000 });
  }
  return chosen;
}

/** The escape wheel's outline: 20 club teeth (each leans forward, counter-clockwise). */
export function sk01EscapeOutline(): Pt[] {
  const { teeth, tip, root } = sk01Escapement;
  const pitch = (2 * Math.PI) / teeth;
  const pts: Pt[] = [];
  for (let k = 0; k < teeth; k++) {
    const a = k * pitch;
    const at = (r: number, f: number): Pt => [
      r * Math.cos(a + f * pitch),
      r * Math.sin(a + f * pitch),
    ];
    pts.push(at(root, -0.1), at(tip, 0.05), at(tip, 0.1), at(root, 0.15));
    // The root between teeth, as a few chords.
    for (const f of [0.4, 0.65]) pts.push(at(root, f));
  }
  return pts;
}
/**
 * The pallet stones in the fork's own frame (the fork at 0, the escape arbor at the origin, the
 * pallet arbor on +x): each tip lies `dip` inside the tips' circle at ±`stoneAngle` when its side
 * is down (the entry stone at −`forkAngle`, the exit at +), and the stone runs outward 0.6 mm,
 * 0.07 mm wide.
 */
export function sk01Stones(): { entry: Pt[]; exit: Pt[] } {
  const e = sk01Escapement;
  const pivot: Pt = [e.pallet, 0];
  const stone = (sign: 1 | -1, forkAt: number) => {
    const a = sign * e.stoneAngle;
    const tip: Pt = [(e.tip - e.dip) * Math.cos(a), (e.tip - e.dip) * Math.sin(a)];
    const out: Pt = [Math.cos(a), Math.sin(a)];
    const side: Pt = [-out[1] * 0.035, out[0] * 0.035];
    const quad: Pt[] = [
      [tip[0] - side[0], tip[1] - side[1]],
      [tip[0] + side[0], tip[1] + side[1]],
      [tip[0] + side[0] + out[0] * 0.6, tip[1] + side[1] + out[1] * 0.6],
      [tip[0] - side[0] + out[0] * 0.6, tip[1] - side[1] + out[1] * 0.6],
    ];
    // Into the fork's own frame: undo the fork's turn at which this stone is down.
    return quad.map((p) => rotate(p, pivot, -forkAt));
  };
  return { entry: stone(-1, -e.forkAngle), exit: stone(1, e.forkAngle) };
}
/**
 * The escape wheel's angle at which a gap is centred under the entry stone (the WM4 start: the
 * fork at −`forkAngle`), so the joint's 0 is that pose.
 */
export function sk01EscapePhase(): number {
  const { teeth, tip, root, dip, stoneAngle } = sk01Escapement;
  const pitch = (2 * Math.PI) / teeth;
  // At the stone's depth the tooth spans these fractions of a pitch (flanks are straight in r).
  const f = (tip - dip - root) / (tip - root);
  const lead = -0.1 + f * 0.15;
  const trail = 0.15 - f * 0.05;
  const gapCentre = ((trail + 1 + lead) / 2) * pitch;
  return -stoneAngle - gapCentre;
}

type Kernel = Pick<CadKernelProfile, 'id' | 'buildHash'>;
/** A cycloidal gear of a part, its back face at z, centred on the part's origin. */
function gear(
  b: CadBuilder,
  name: string,
  g: { module: number; teeth: number; mating: number; z: Pt; leaf?: boolean; spokes?: number },
  look = brass,
) {
  return b.spurGear(
    name,
    {
      profile: 'cycloidal',
      module: g.module,
      teeth: g.teeth,
      matingTeeth: g.mating,
      // A pinion leaf is 0.4 of the pitch thick, so the pair has backlash (W1).
      ...(g.leaf ? { toothThickness: 0.4 } : {}),
      faceWidth: g.z[1] - g.z[0],
      origin: [0, 0, g.z[0]],
      ...(g.spokes
        ? {
            spokes: {
              count: g.spokes,
              rim: g.module * 3.5,
              hub: Math.max(0.35, g.module * 4),
              width: g.module * 2.5,
            },
          }
        : {}),
    },
    g.leaf ? steel : look,
  );
}
/** WM5b: the hands (mm): blade length from the arbor, width, and tail. */
export const sk01Hands = Object.freeze({
  hour: { length: 6.2, width: 1.0, tail: 1.0 },
  minute: { length: 11.0, width: 0.8, tail: 1.6 },
  seconds: { length: 2.1, width: 0.3, tail: 0.6 },
});
/** A hand's outline pointing +y from its arbor: a lance with a short tail. */
export function sk01HandOutline(h: { length: number; width: number; tail: number }): Pt[] {
  const [L, w, t] = [h.length, h.width, h.tail];
  return [
    [0, L],
    [-w / 2, 0.8 * L],
    [-0.3 * w, 0],
    [-0.4 * w, -t],
    [0.4 * w, -t],
    [0.3 * w, 0],
    [w / 2, 0.8 * L],
  ];
}
function hand(
  b: CadBuilder,
  name: string,
  zz: Pt,
  h: { length: number; width: number; tail: number },
  look = blued,
  bore = 0,
) {
  const hub = Math.max(h.width * 0.45, bore + 0.12);
  b.extrude(
    name,
    region(
      b,
      `${name} outline`,
      zz[0],
      { type: 'poly', pts: sk01HandOutline(h) },
      bore ? [{ type: 'circle', c: [0, 0], r: bore }] : [],
    ),
    zz[1] - zz[0],
    look,
  );
  b.extrude(
    `${name} boss`,
    region(
      b,
      `${name} boss ring`,
      zz[0],
      { type: 'circle', c: [0, 0], r: hub },
      bore ? [{ type: 'circle', c: [0, 0], r: bore }] : [],
    ),
    zz[1] - zz[0],
    look,
  );
}
const arbor = (b: CadBuilder, name: string, z: Pt, r = 0.12) =>
  b.cylinder(name, { radius: r, height: z[1] - z[0], origin: [0, 0, z[0]] }, steel);

export interface Sk01Part {
  key: string;
  name: string;
  content: CadDocument;
  /** Where the part's origin sits (mm), or a joint's arbor. */
  at: Pt;
  bounds: [Vec3, Vec3];
}

/** The part versions of the movement, each built from its own empty document. */
export function sk01Parts(kernel: Kernel = fixtureKernel, finish?: Sk01Finish): Sk01Part[] {
  const L = sk01Layout;
  const A = L.arbors;
  const z = L.z;
  const g = sk01Gears;
  const e = sk01Escapement;
  const parts: Sk01Part[] = [];
  const part = (key: string, name: string, at: Pt, make: (b: CadBuilder) => void) => {
    const b = cadBuilder(kernel);
    make(b);
    const content = b.build().document;
    parts.push({
      key,
      name,
      content,
      at,
      bounds: [
        [-16, -16, -1.7],
        [16, 16, 4.3],
      ],
    });
  };

  // The main plate: a disc with the centre and fourth arbors through it (to the dial side) and
  // round windows away from every pivot.
  const pivots = Object.values(A);
  part('plate', 'Main plate', [0, 0], (b) => {
    const outline: Loop = { type: 'circle', c: [0, 0], r: L.plate.radius };
    const windows = sk01Windows(
      outline,
      [...pivots.map((c) => ({ c, r: 0.9 })), ...sk01ScrewPoints().map((c) => ({ c, r: 0.7 }))],
      { web: 0.55, max: 2.6, min: 0.6, count: 26 },
    );
    const holes: Loop[] = [
      { type: 'circle', c: A.centre, r: 0.2 },
      { type: 'circle', c: A.fourth, r: 0.2 },
      ...windows.map((w) => ({ type: 'circle' as const, c: w.c, r: w.r })),
    ];
    const section = region(b, 'Plate outline', L.plate.z[0], outline, holes);
    const plate = b.extrude('Main plate', section, 0.8, plateGrey);
    chamferTop(b, plate, section, L.plate.z[1], 0.08, outline, holes);
    finishBody(b, plate, finish, 'perlage');
    // Jewels on the plate's top at each pivot above it.
    for (const [k, c] of Object.entries(A))
      if (k !== 'centre' && k !== 'minute')
        b.extrude(
          `Jewel ${k}`,
          region(b, `Jewel ${k} ring`, L.plate.z[1], { type: 'circle', c, r: 0.35 }, [
            { type: 'circle', c, r: 0.15 },
          ]),
          0.08,
          ruby,
        );
  });

  // Bridges: the train bridge over the centre, third, fourth and escape pivots, the barrel
  // bridge over the barrel, and the balance cock reaching over the rim to its foot.
  const bridge = (
    key: string,
    name: string,
    at: Pt[],
    pad: number,
    zz: Pt,
    extra: Pt[] = [],
    jewels = true,
  ) =>
    part(key, name, [0, 0], (b) => {
      const outline = around([...at, ...extra], pad);
      const windows = sk01Windows(
        { type: 'poly', pts: outline },
        [...at.map((c) => ({ c, r: 0.75 })), ...extra.map((c) => ({ c, r: 0.6 }))],
        { web: 0.45, max: 1.8, min: 0.45, count: 12 },
      );
      // The windows are placed in the polygon; the sketch is its round outline (a little larger),
      // whose tangent arcs and lines take the anglage as one chain.
      const outer: Loop = { type: 'rounded', centres: hull([...at, ...extra]), r: pad };
      const holes = windows.map((w) => ({ type: 'circle' as const, c: w.c, r: w.r }));
      const section = region(b, `${name} outline`, zz[0], outer, holes);
      const plate = b.extrude(name, section, zz[1] - zz[0], plateGrey);
      chamferTop(b, plate, section, zz[1], 0.06, outer, holes);
      finishBody(b, plate, finish, 'cotes');
      for (const [i, c] of jewels ? at.entries() : [])
        b.extrude(
          `${name} jewel ${i + 1}`,
          region(b, `${name} jewel ${i + 1} ring`, zz[1], { type: 'circle', c, r: 0.32 }, [
            { type: 'circle', c, r: 0.12 },
          ]),
          0.1,
          ruby,
        );
      for (const [i, c] of extra.entries()) {
        b.cylinder(
          `${name} screw ${i + 1}`,
          { radius: 0.38, height: 0.22, origin: [c[0], c[1], zz[1]] },
          blued,
        );
        b.box(
          `${name} screw ${i + 1} slot`,
          { size: [0.7, 0.08, 0.03], origin: [c[0] - 0.35, c[1] - 0.04, zz[1] + 0.22] },
          { color: '#10142e', metalness: 1, roughness: 0.5 },
        );
      }
    });
  const screws = sk01ScrewPoints();
  bridge('train-bridge', 'Train bridge', [A.centre, A.third, A.fourth, A.escape], 0.9, z.bridges, [
    screws[0]!,
    screws[1]!,
  ]);
  // Under the ratchet wheel: no jewel.
  bridge(
    'barrel-bridge',
    'Barrel bridge',
    [A.barrel],
    4.6,
    z.bridges,
    [screws[2]!, screws[3]!],
    false,
  );
  const foot = polar(A.balance, 5.0, L.escapementAxis);
  bridge('balance-cock', 'Balance cock', [A.balance], 0.9, z.cock, [foot]);

  // The barrel: a drum with its toothed rim.
  part('barrel', 'Barrel', A.barrel, (b) => {
    b.cylinder(
      'Barrel drum',
      {
        radius: 5.6,
        height: z.barrel.drum[1] - z.barrel.drum[0],
        origin: [0, 0, z.barrel.drum[0]],
      },
      brass,
    );
    gear(b, 'Barrel gear', {
      module: g.centreBarrel.module,
      teeth: 80,
      mating: 10,
      z: z.barrel.gear,
    });
    b.cylinder(
      'Barrel arbor',
      { radius: 0.3, height: z.bridges[0] - z.barrel.drum[1], origin: [0, 0, z.barrel.drum[1]] },
      steel,
    );
    b.cylinder(
      'Barrel ratchet',
      { radius: 2.6, height: 0.15, origin: [0, 0, z.bridges[1]] },
      steel,
    );
  });
  part('centre', 'Centre wheel', A.centre, (b) => {
    // WM5b: down through the hour wheel's pipe to the minute hand.
    arbor(b, 'Centre arbor', [z.hands.minute[0], z.arbor[1]]);
    hand(b, 'Minute hand', z.hands.minute, sk01Hands.minute);
    gear(b, 'Centre pinion', {
      module: g.centreBarrel.module,
      teeth: 10,
      mating: 80,
      z: z.centre.pinion,
      leaf: true,
    });
    gear(b, 'Centre wheel', {
      module: g.thirdCentre.module,
      teeth: 64,
      mating: 10,
      z: z.centre.wheel,
      spokes: 5,
    });
    gear(b, 'Cannon pinion', {
      module: g.cannonMinute.module,
      teeth: 12,
      mating: 36,
      z: z.centre.cannon,
      leaf: true,
    });
  });
  part('third', 'Third wheel', A.third, (b) => {
    arbor(b, 'Third arbor', z.arbor);
    gear(b, 'Third pinion', {
      module: g.thirdCentre.module,
      teeth: 10,
      mating: 64,
      z: z.third.pinion,
      leaf: true,
    });
    gear(b, 'Third wheel', {
      module: g.fourthThird.module,
      teeth: 75,
      mating: 8,
      z: z.third.wheel,
      spokes: 5,
    });
  });
  part('fourth', 'Fourth wheel', A.fourth, (b) => {
    // WM5b: the small seconds hand sits nearest the plate, under the hour hand's sweep.
    arbor(b, 'Fourth arbor', [z.hands.seconds[0], z.arbor[1]]);
    hand(b, 'Seconds hand', z.hands.seconds, sk01Hands.seconds, steel);
    gear(b, 'Fourth pinion', {
      module: g.fourthThird.module,
      teeth: 8,
      mating: 75,
      z: z.fourth.pinion,
      leaf: true,
    });
    gear(b, 'Fourth wheel', {
      module: g.escapeFourth.module,
      teeth: 84,
      mating: 7,
      z: z.fourth.wheel,
      spokes: 5,
    });
  });
  part('escape', 'Escape wheel', A.escape, (b) => {
    arbor(b, 'Escape arbor', z.arbor);
    gear(b, 'Escape pinion', {
      module: g.escapeFourth.module,
      teeth: 7,
      mating: 84,
      z: z.escape.pinion,
      leaf: true,
    });
    // The teeth turned to the WM4 start (a gap under the entry stone), about the escapement axis.
    const turn = sk01EscapePhase() + L.escapementAxis * rad;
    const teeth = sk01EscapeOutline().map((p) => rotate(p, [0, 0], turn));
    const windows = Array.from({ length: 5 }, (_, i) => ({
      type: 'poly' as const,
      pts: sectorPts(
        0.42,
        1.25,
        turn + (i * 2 * Math.PI) / 5 + 0.18,
        turn + ((i + 1) * 2 * Math.PI) / 5 - 0.18,
      ),
    }));
    b.extrude(
      'Escape wheel',
      region(b, 'Escape teeth', z.escape.wheel[0], { type: 'poly', pts: teeth }, windows),
      z.escape.wheel[1] - z.escape.wheel[0],
      steel,
    );
  });
  // The pallet fork: its body over the escape wheel, the two stones reaching down to the teeth,
  // and the tail towards the balance's roller. Built about the pallet arbor (its origin).
  part('pallet', 'Pallet fork', A.pallet, (b) => {
    const axis = L.escapementAxis * rad;
    // Fork frame (escape arbor at origin, pallet on +x) → the part's frame (pallet at origin).
    const toPart = (p: Pt): Pt => rotate([p[0] - e.pallet, p[1]], [0, 0], axis);
    const s = sk01Stones();
    arbor(b, 'Pallet arbor', [z.arbor[0], 1.6], 0.1);
    for (const [k, quad] of [
      ['Entry stone', s.entry],
      ['Exit stone', s.exit],
    ] as const)
      b.extrude(
        k,
        region(b, `${k} outline`, z.pallet.stones[0], { type: 'poly', pts: quad.map(toPart) }, []),
        z.pallet.stones[1] - z.pallet.stones[0],
        ruby,
      );
    // The body: from the stones' outer ends to the arbor, and the tail to 0.71 mm short of the
    // balance's staff (the impulse pin's path ends at 0.56 mm).
    const outerEnd = (q: Pt[]): Pt => [(q[2]![0] + q[3]![0]) / 2, (q[2]![1] + q[3]![1]) / 2];
    const tail = e.balance - e.pallet - 0.71;
    const [inEnd, outEnd] = [outerEnd(s.entry), outerEnd(s.exit)];
    const body: Pt[] = [
      inEnd,
      [e.pallet, -0.3],
      [e.pallet + tail - 0.1, -0.1],
      [e.pallet + tail, -0.15],
      [e.pallet + tail, 0.15],
      [e.pallet + tail - 0.1, 0.1],
      [e.pallet, 0.3],
      outEnd,
      [outEnd[0] - 0.1, outEnd[1] - 0.2],
      [e.pallet - 0.25, 0],
      [inEnd[0] - 0.1, inEnd[1] + 0.2],
    ];
    b.extrude(
      'Fork',
      region(b, 'Fork outline', z.pallet.fork[0], { type: 'poly', pts: body.map(toPart) }, []),
      z.pallet.fork[1] - z.pallet.fork[0],
      steel,
    );
  });
  // The balance: staff, roller with its impulse pin (pointing at the fork at 0), hairspring
  // (a flat spiral ribbon, rigid with the balance: WM-U5), rim with three arms.
  part('balance', 'Balance', A.balance, (b) => {
    const toFork = (L.escapementAxis + 180) * rad;
    arbor(b, 'Balance staff', z.balance.staff);
    b.cylinder(
      'Roller',
      {
        radius: 0.4,
        height: z.balance.roller[1] - z.balance.roller[0],
        origin: [0, 0, z.balance.roller[0]],
      },
      steel,
    );
    const pin = polar([0, 0], e.impulsePin, toFork / rad);
    b.cylinder(
      'Impulse pin',
      { radius: 0.06, height: 0.3, origin: [pin[0], pin[1], z.balance.roller[0] - 0.05] },
      ruby,
    );
    b.cylinder(
      'Collet',
      {
        radius: 0.5,
        height: z.balance.spring[1] - z.balance.spring[0],
        origin: [0, 0, z.balance.spring[0]],
      },
      steel,
    );
    b.extrude(
      'Hairspring',
      region(
        b,
        'Hairspring ribbon',
        z.balance.spring[0],
        { type: 'poly', pts: sk01Hairspring() },
        [],
      ),
      z.balance.spring[1] - z.balance.spring[0],
      blued,
    );
    const rimZ = z.balance.rim;
    b.extrude(
      'Balance rim',
      region(b, 'Rim ring', rimZ[0], { type: 'circle', c: [0, 0], r: e.rim.outer }, [
        { type: 'circle', c: [0, 0], r: e.rim.inner },
      ]),
      rimZ[1] - rimZ[0],
      brass,
    );
    const arms: Pt[] = [];
    for (let i = 0; i < 3; i++) {
      const a = toFork + Math.PI / 3 + (i * 2 * Math.PI) / 3;
      const [c, s] = [Math.cos(a), Math.sin(a)];
      const w = 0.16;
      const span = [0.35, e.rim.inner + 0.1];
      arms.push(
        ...[
          [span[0]!, -w],
          [span[1]!, -w],
          [span[1]!, w],
          [span[0]!, w],
        ].map(([u, v]) => [u! * c - v! * s, u! * s + v! * c] as Pt),
      );
    }
    for (let i = 0; i < 3; i++)
      b.extrude(
        `Balance arm ${i + 1}`,
        region(b, `Arm ${i + 1}`, rimZ[0], { type: 'poly', pts: arms.slice(i * 4, i * 4 + 4) }, []),
        0.2,
        brass,
      );
    b.cylinder('Balance hub', { radius: 0.4, height: 0.2, origin: [0, 0, rimZ[0]] }, brass);
  });
  // The motion works on the dial side: the minute wheel (with its pinion) and the hour wheel,
  // which rides on the centre arbor.
  part('minute', 'Minute wheel', A.minute, (b) => {
    arbor(b, 'Minute arbor', [-1.15, 0]);
    gear(b, 'Minute wheel', {
      module: g.cannonMinute.module,
      teeth: 36,
      mating: 12,
      z: z.minute.wheel,
      spokes: 4,
    });
    gear(b, 'Minute pinion', {
      module: g.minuteHour.module,
      teeth: 10,
      mating: 40,
      z: z.minute.pinion,
      leaf: true,
    });
  });
  part('hour', 'Hour wheel', A.centre, (b) => {
    b.spurGear(
      'Hour wheel',
      {
        profile: 'cycloidal',
        module: g.minuteHour.module,
        teeth: 40,
        matingTeeth: 10,
        faceWidth: z.hour.wheel[1] - z.hour.wheel[0],
        origin: [0, 0, z.hour.wheel[0]],
        bore: 0.4,
        spokes: { count: 4, rim: 0.35, hub: 0.4, width: 0.25 },
      },
      brass,
    );
    // WM5b: the hour hand on a pipe round the centre arbor (which carries the minute hand).
    const pipe = z.hands.hour;
    b.extrude(
      'Hour pipe',
      region(b, 'Hour pipe ring', pipe[0], { type: 'circle', c: [0, 0], r: 0.32 }, [
        { type: 'circle', c: [0, 0], r: 0.2 },
      ]),
      z.hour.wheel[0] - pipe[0],
      brass,
    );
    hand(b, 'Hour hand', pipe, sk01Hands.hour, blued, 0.2);
  });
  return parts;
}
/** Screw points: two on the train bridge, two on the barrel bridge (mm). */
export function sk01ScrewPoints(): Pt[] {
  const A = sk01Layout.arbors;
  return [
    polar(A.third, 1.3, 230),
    polar(A.escape, 1.35, 60),
    polar(A.barrel, 4.0, 20),
    polar(A.barrel, 4.0, 170),
  ];
}
function sectorPts(r1: number, r2: number, a0: number, a1: number, n = 8): Pt[] {
  const p: Pt[] = [];
  for (let i = 0; i <= n; i++) p.push(polar([0, 0], r2, (a0 + ((a1 - a0) * i) / n) / rad));
  for (let i = n; i >= 0; i--) p.push(polar([0, 0], r1, (a0 + ((a1 - a0) * i) / n) / rad));
  return p;
}
/**
 * The hairspring: a flat Archimedean spiral ribbon 0.03 mm thick from the collet (0.5 mm) to
 * 1.9 mm in 7 turns, as one closed outline (out along one side, back along the other).
 */
export function sk01Hairspring(): Pt[] {
  const [r0, r1, turns, half, n] = [0.52, 1.9, 7, 0.015, 7 * 32];
  const side = (s: number) =>
    Array.from({ length: n + 1 }, (_, i) => {
      const t = i / n;
      const a = 2 * Math.PI * turns * t;
      const r = r0 + (r1 - r0) * t + s;
      return [r * Math.cos(a), r * Math.sin(a)] as Pt;
    });
  return [...side(-half), ...side(half).reverse()];
}

const arborJoint = (
  id: string,
  name: string,
  componentId: string,
  at: Pt,
  continuous: boolean,
  limits?: { min: number; max: number },
) => ({
  ...fixtureJoint(
    id,
    'revolute',
    {
      ...fixtureConnector(),
      offset: { translation: position(at[0], at[1], 0), rotation: [0, 0, 0, 1] },
    },
    componentId,
    fixtureConnector(),
    { angle: { literalRad: 0 } },
    limits ? [{ of: 'angle' as const, min: limits.min, max: limits.max }] : [],
  ),
  name,
  ...(continuous ? { continuous: true as const } : {}),
});

/**
 * F71: the SK-01 movement as an assembly: the plate and bridges fixed, every wheel, the fork and
 * the balance on revolute joints at their arbors, and the train meshed from the escape wheel.
 */
export function sk01Movement(kernel: Kernel = fixtureKernel, finish?: Sk01Finish) {
  const parts = sk01Parts(kernel, finish);
  const versions = new Map(
    parts.map((p) => [p.key, fixtureVersion(`sk01-${p.key}`, 'v1', p.content)]),
  );
  const doc: CadDocument = cadBuilder(kernel).build().document;
  doc.parts = parts.map((p) =>
    fixturePart(`part-${p.key}`, p.name, versions.get(p.key)!, p.bounds),
  );
  const fixed = ['plate', 'train-bridge', 'barrel-bridge', 'balance-cock'];
  const moving = parts.filter((p) => !fixed.includes(p.key));
  doc.components = [
    ...fixed.map((k) => ({
      ...fixtureComponent(`c-${k}`, `part-${k}`),
      name: parts.find((p) => p.key === k)!.name,
    })),
    ...moving.map((p) => ({
      ...fixtureComponent(`c-${p.key}`, `part-${p.key}`),
      name: p.name,
      placement: null,
    })),
  ];
  const fork = sk01Escapement.forkAngle;
  doc.joints = moving.map((p) =>
    p.key === 'pallet'
      ? arborJoint('j-pallet', 'Pallet fork', 'c-pallet', p.at, false, {
          min: -2 * fork,
          max: 2 * fork,
        })
      : arborJoint(`j-${p.key}`, p.name, `c-${p.key}`, p.at, true),
  );
  const closure = new Map([...versions.values()].map((v) => [v.contentHash, v.content] as const));
  const lookup = (h: string) => closure.get(h);
  const solve = (d: CadDocument) =>
    solveJoints(
      d,
      parameterValues(d),
      lookup,
      () => undefined,
      () => true,
    );
  doc.solvedPoses = solve(doc).poses;
  const gearOf = (key: string, name: string) =>
    versions.get(key)!.content.features.find((f) => f.type === 'spurGear' && f.name === name)!.id;
  const pair = (
    id: string,
    name: string,
    a: [string, string],
    b: [string, string],
  ): CadGearMesh => ({
    id,
    name,
    driver: { joint: `j-${a[0]}`, feature: gearOf(a[0], a[1]) },
    driven: { joint: `j-${b[0]}`, feature: gearOf(b[0], b[1]) },
  });
  const meshes = [
    pair(
      'mesh-escape-fourth',
      'Escape → fourth',
      ['escape', 'Escape pinion'],
      ['fourth', 'Fourth wheel'],
    ),
    pair(
      'mesh-fourth-third',
      'Fourth → third',
      ['fourth', 'Fourth pinion'],
      ['third', 'Third wheel'],
    ),
    pair(
      'mesh-third-centre',
      'Third → centre',
      ['third', 'Third pinion'],
      ['centre', 'Centre wheel'],
    ),
    pair(
      'mesh-centre-barrel',
      'Centre → barrel',
      ['centre', 'Centre pinion'],
      ['barrel', 'Barrel gear'],
    ),
    pair(
      'mesh-cannon-minute',
      'Cannon → minute',
      ['centre', 'Cannon pinion'],
      ['minute', 'Minute wheel'],
    ),
    pair('mesh-minute-hour', 'Minute → hour', ['minute', 'Minute pinion'], ['hour', 'Hour wheel']),
  ];
  for (const mesh of meshes) {
    const check = checkGearMesh(doc, mesh, solve(doc), lookup);
    if (check.status !== 'ok') throw new Error(`F71 ${mesh.id}: ${JSON.stringify(check)}`);
    const { ratio, offset } = check.coupling;
    applyGearMeshOperation(doc, { type: 'insertGearMesh', mesh, coupling: { ratio, offset } });
    doc.solvedPoses = solve(doc).poses;
  }
  assertCad(doc);
  return { assembly: doc, closure, lookup, solve, versions, parts };
}

const crystal: Partial<CadAppearance> = {
  color: '#f4f8ff',
  opacity: 0.18,
  metalness: 0,
  roughness: 0.02,
  transmission: 1,
  ior: 1.77,
};
const caseSteel: Partial<CadAppearance> = { color: '#d7d9dd', metalness: 1, roughness: 0.18 };

/**
 * WM5b: the case round the movement (mm, the movement's axes): the middle with its lugs and the
 * crown at three o'clock, the front bezel with its sapphire crystal, the screwed back with a
 * display crystal, and the chapter ring under the plate. Each part keeps a gap of at least
 * 0.02 mm to its neighbours, so nothing touches at rest.
 */
export const sk01Case = Object.freeze({
  inner: 15.25,
  outer: 17.6,
  middle: [-0.9, 4.3] as Pt,
  bezel: [-2.5, -0.92] as Pt,
  front: { r: 15.2, z: [-2.4, -2.0] as Pt },
  back: [4.32, 5.0] as Pt,
  backCrystal: { r: 15.2, z: [4.45, 4.8] as Pt },
  chapterRing: { inner: 12.3, outer: 14.9 },
  crown: { r: 1.5, at: 17.7, length: 1.8, z: 1.7 },
});

export function sk01CaseParts(kernel: Kernel = fixtureKernel): Sk01Part[] {
  const C = sk01Case;
  const parts: Sk01Part[] = [];
  const bounds: [Vec3, Vec3] = [
    [-20, -22, -2.6],
    [20, 22, 5.1],
  ];
  const part = (key: string, name: string, make: (b: CadBuilder) => void) => {
    const b = cadBuilder(kernel);
    make(b);
    parts.push({ key, name, content: b.build().document, at: [0, 0], bounds });
  };
  const annulus = (b: CadBuilder, name: string, zz: Pt, r: Pt, look: Partial<CadAppearance>) =>
    b.extrude(
      name,
      region(b, `${name} ring`, zz[0], { type: 'circle', c: [0, 0], r: r[1] }, [
        { type: 'circle', c: [0, 0], r: r[0] },
      ]),
      zz[1] - zz[0],
      look,
    );
  part('case', 'Case middle', (b) => {
    annulus(b, 'Case middle', C.middle, [C.inner, C.outer], caseSteel);
    // Two pairs of lugs at twelve and six o'clock, for a 16 mm strap.
    for (const [i, [x, y]] of (
      [
        [-8.4, 15.6],
        [5.6, 15.6],
        [-8.4, -21.6],
        [5.6, -21.6],
      ] as Pt[]
    ).entries())
      b.box(`Lug ${i + 1}`, { size: [2.8, 6, 3.2], origin: [x, y, -0.4] }, caseSteel);
    const { r, at, length, z } = C.crown;
    // About +x: the cylinder's +z turned a quarter about y.
    const toX: [number, number, number, number] = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
    b.cylinder(
      'Crown stem',
      { radius: 0.45, height: 0.9, origin: [17.0, 0, z], orientation: toX },
      steel,
    );
    b.cylinder(
      'Crown',
      { radius: r, height: length, origin: [at, 0, z], orientation: toX },
      caseSteel,
    );
  });
  part('bezel', 'Bezel', (b) => {
    annulus(b, 'Bezel', C.bezel, [C.inner, C.outer], caseSteel);
    b.cylinder(
      'Front crystal',
      { radius: C.front.r, height: C.front.z[1] - C.front.z[0], origin: [0, 0, C.front.z[0]] },
      crystal,
    );
  });
  part('case-back', 'Case back', (b) => {
    annulus(b, 'Case back', C.back, [C.inner, C.outer], caseSteel);
    b.cylinder(
      'Back crystal',
      {
        radius: C.backCrystal.r,
        height: C.backCrystal.z[1] - C.backCrystal.z[0],
        origin: [0, 0, C.backCrystal.z[0]],
      },
      crystal,
    );
  });
  part('chapter-ring', 'Chapter ring', (b) => {
    const zz = sk01Layout.z.chapterRing;
    const { inner, outer } = C.chapterRing;
    annulus(b, 'Chapter ring', zz, [inner, outer], {
      color: '#f2efe6',
      metalness: 0.2,
      roughness: 0.5,
    });
    // Twelve raised indices on its face (towards the crystal), the one at twelve doubled.
    for (let h = 0; h < 12; h++) {
      const a = 90 - 30 * h;
      const w = h === 0 ? 0.5 : 0.25;
      const pts = [
        polar(polar([0, 0], inner + 0.3, a), w, a + 90),
        polar(polar([0, 0], outer - 0.4, a), w, a + 90),
        polar(polar([0, 0], outer - 0.4, a), w, a - 90),
        polar(polar([0, 0], inner + 0.3, a), w, a - 90),
      ];
      b.extrude(
        `Index ${h === 0 ? 12 : h}`,
        region(b, `Index ${h === 0 ? 12 : h} outline`, zz[0], { type: 'poly', pts }, []),
        0.05,
        blued,
        -1,
      );
    }
  });
  return parts;
}

/** WM5b: how far each lifted part moves in the exploded form (mm along the movement's axis). */
export const sk01Exploded = Object.freeze({
  'case-back': 14,
  'balance-cock': 8,
  'train-bridge': 6,
  'barrel-bridge': 6,
  bezel: -8,
});

/**
 * F72: the SK-01 watch: the F71 movement in its case, with the hands on the centre, hour and
 * fourth arbors. The bridges, the back and the bezel sit on slider joints along the axis, so the
 * forms 組立 (assembled, all at 0) and 分解 (exploded, `sk01Exploded`) are plain joint values (MR2).
 */
export function sk01Watch(kernel: Kernel = fixtureKernel, finish?: Sk01Finish) {
  const movement = sk01Movement(kernel, finish);
  const caseParts = sk01CaseParts(kernel);
  const versions = new Map(movement.versions);
  for (const p of caseParts) versions.set(p.key, fixtureVersion(`sk01-${p.key}`, 'v1', p.content));
  const doc = structuredClone(movement.assembly);
  doc.parts.push(
    ...caseParts.map((p) => fixturePart(`part-${p.key}`, p.name, versions.get(p.key)!, p.bounds)),
  );
  const lifted = Object.keys(sk01Exploded);
  for (const p of caseParts)
    doc.components.push({
      ...fixtureComponent(`c-${p.key}`, `part-${p.key}`),
      name: p.name,
      ...(lifted.includes(p.key) ? { placement: null } : {}),
    });
  for (const c of doc.components) if (lifted.includes(c.id.slice(2))) c.placement = null;
  const names = new Map(doc.components.map((c) => [c.id, c.name]));
  for (const [key, d] of Object.entries(sk01Exploded))
    doc.joints.push({
      ...fixtureJoint(
        `j-lift-${key}`,
        'slider',
        fixtureConnector(),
        `c-${key}`,
        fixtureConnector(),
        { distance: { literalMm: 0 } },
        [{ of: 'distance', min: Math.min(0, d), max: Math.max(0, d) }],
      ),
      name: `Lift ${names.get(`c-${key}`)!.toLowerCase()}`,
    });
  const closure = new Map([...versions.values()].map((v) => [v.contentHash, v.content] as const));
  const lookup = (h: string) => closure.get(h);
  const solve = (d: CadDocument) =>
    solveJoints(
      d,
      parameterValues(d),
      lookup,
      () => undefined,
      () => true,
    );
  doc.solvedPoses = solve(doc).poses;
  const assembled = currentConfigurationValues(doc);
  const exploded = structuredClone(assembled);
  for (const [key, d] of Object.entries(sk01Exploded))
    exploded[`j-lift-${key}`] = { distance: { literalMm: d } };
  doc.configurations = [
    { id: 'form-assembled', name: '組立', values: assembled },
    { id: 'form-exploded', name: '分解', values: exploded },
  ];
  assertCad(doc);
  return {
    assembly: doc,
    closure,
    lookup,
    solve,
    versions,
    parts: [...movement.parts, ...caseParts],
  };
}
