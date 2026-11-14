/**
 * F63's body in white (CR7 fit-up, Ryo's C of 2026-11-11): a simple structure laid out from the
 * F28 skin's own sizes, so it sits inside the skin and round its wheels (axles x 955 and 3355,
 * centres z 300, wheels R 288 at a 700 mm half track). F29 (B2) stays the analysed sample: it is
 * a taller, boxier body (its floor 150 mm above its axles) that the skin cannot hold.
 *
 * Its parts (each `L` part has an `R` copy reflected in y = 0): the floor pan (z 230, between the
 * wheel arches), the trunk floor (z 330) and its kick, the dash (its toe board and wall at x
 * 3010), the radiator support (x 3820), two cross members under the floor; on each side the sill
 * (a closed tube), the rear and front wheelhouses (half drums of R 345 round the axles), the front
 * side member (a tube from the dash forward), the strut top mount over the front wheel and the
 * rear suspension bracket under the trunk floor. The skin and its inner panel carry the upper
 * body (pillars, rails and roof are not modelled here). Every sheet is 0.8 mm steel by mass.
 */
import { identityQuaternion, mm, position, type CadDocument } from './model';
import type { CadFeature, Quaternion, Vec3 } from './model';
import { applyCadOperation, type CadNewBody } from './operations';
import type { CadSketch } from './sketch';
import { f01Empty } from './fixtures';

/** Sketch planes: XZ's normal is −y, YZ's +x, XY's +z (an extrusion of 1 runs that way). */
const XZ: Quaternion = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
const YZ: Quaternion = [0.5, 0.5, 0.5, 0.5];
const XY: Quaternion = identityQuaternion();
const grey = { color: '#8d99a6', opacity: 1 };

/**
 * CR7g-1: how much wider than F28 the whole car is laid out (1,440 mm → about 1,700 mm, an AE86
 * is 1,625 mm): every y across the car (skin sections, panel lines, this body, the track, the
 * parts' places) is this times F28's, rounded to the mm. Sizes of parts (a wheel's width) are not.
 */
export const f63WidthScale = 1.18;
/**
 * CR7g-1: each F25 section's own factor, from the tail to the nose: the ends narrower than the
 * middle, so the car tapers in plan. The middle ones are `f63WidthScale`.
 */
export const f63SectionScales = [1.1, 1.18, 1.18, 1.18, 1.18, 1.18, 1.1] as const;
/** CR7g-1: the roof side's point leaned in (F25: 0.55 of the half width). */
export const f63Greenhouse = 0.5;
/** A y across the car, widened (CR7g-1). */
export const f63Y = (y: number) => Math.round(y * f63WidthScale);
const Y = f63Y;

/** The sizes the body is laid out by (mm). */
export const f63BodyLayout = Object.freeze({
  axles: { rear: 955, front: 3355, z: 300 },
  floor: { z: 230, x0: 1320, x1: 2960, y: Y(590) },
  trunk: { z: 330, x0: 250, x1: 1230, y: Y(560) },
  dash: { x: 3010, top: 900, y: Y(570) },
  radiator: { x: 3820, z0: 300, z1: 800, y: Y(560) },
  sill: { x0: 1310, x1: 3000, y0: Y(-700), y1: Y(-600), z0: 210, z1: 320 },
  wheelhouse: { r: 345, y0: Y(-580), depth: 125, fromDeg: 5, toDeg: 175 },
  member: { x0: 3020, x1: 3810, y0: Y(-440), y1: Y(-380), z0: 380, z1: 460 },
  strutMount: { centre: [3355, Y(-650), 675] as Vec3, size: [140, 140, 30] as Vec3 },
  rearMount: { centre: [955, Y(-505), 285] as Vec3, size: [100, 100, 40] as Vec3 },
  cross: { xs: [1700, 2500], width: 60, z0: 170, z1: 225, y: Y(560) },
});

type Entity = CadSketch['entities'][number];
function sketch(
  id: string,
  name: string,
  orientation: Quaternion,
  origin: Vec3,
  points: Record<string, [number, number]>,
  entities: Entity[],
): CadSketch {
  return {
    id,
    name,
    plane: { origin: position(...origin), orientation },
    entities: [...Object.keys(points).map((p) => ({ type: 'point' as const, id: p })), ...entities],
    constraints: [],
    solved: points,
  };
}
/** Lines `s0, s1, …` through the points in order (closed: back to the first). */
function chain(pts: [number, number][], closed = false) {
  const points = Object.fromEntries(pts.map((p, i) => [`p${i}`, p])) as Record<
    string,
    [number, number]
  >;
  const n = closed ? pts.length : pts.length - 1;
  const entities: Entity[] = Array.from({ length: n }, (_, i) => ({
    type: 'line',
    id: `s${i}`,
    start: `p${i}`,
    end: `p${(i + 1) % pts.length}`,
  }));
  return { points, entities, elements: entities.map((e) => e.id) };
}
const rect = (u0: number, v0: number, u1: number, v1: number) =>
  chain(
    [
      [u0, v0],
      [u1, v0],
      [u1, v1],
      [u0, v1],
    ],
    true,
  );

/** The F63 body in white. */
export function f63Body(): CadDocument {
  const L = f63BodyLayout;
  const sketches: CadSketch[] = [];
  const features: CadFeature[] = [];
  const bodies: CadNewBody[] = [];
  const left: { id: string; name: string }[] = [];
  const add = (id: string, name: string, feature: CadFeature, mirrored = false) => {
    features.push(feature);
    bodies.push({
      id,
      name: mirrored ? `${name} L` : name,
      sourceFeatureId: feature.id,
      placementFeatureId: `${id}-placement`,
      appearance: grey,
    });
    if (mirrored) left.push({ id, name });
  };
  const sheet = (
    id: string,
    name: string,
    plane: Quaternion,
    origin: Vec3,
    c: ReturnType<typeof chain>,
    distance: number,
    mirrored = false,
  ) => {
    sketches.push(sketch(`${id}-line`, name, plane, origin, c.points, c.entities));
    add(
      id,
      name,
      {
        id: `${id}-sheet`,
        name,
        type: 'extrudeSurface',
        inputFeatureIds: [],
        args: {
          path: { sketchId: `${id}-line`, elements: c.elements },
          distance: mm(distance),
          direction: 1,
        },
      },
      mirrored,
    );
  };
  const box = (id: string, name: string, centre: Vec3, size: Vec3) =>
    add(
      id,
      name,
      {
        id: `${id}-solid`,
        name,
        type: 'box',
        inputFeatureIds: [],
        args: {
          size: size.map((v) => mm(v)) as [
            ReturnType<typeof mm>,
            ReturnType<typeof mm>,
            ReturnType<typeof mm>,
          ],
          origin: position(
            centre[0] - size[0] / 2,
            centre[1] - size[1] / 2,
            centre[2] - size[2] / 2,
          ),
          orientation: XY,
        },
      },
      true,
    );

  // Floor and bulkheads (across the car, one part each).
  sheet(
    'floor',
    'Floor pan',
    YZ,
    [L.floor.x0, 0, 0],
    chain([
      [-L.floor.y, L.floor.z],
      [L.floor.y, L.floor.z],
    ]),
    L.floor.x1 - L.floor.x0,
  );
  sheet(
    'trunk',
    'Trunk floor',
    XZ,
    [0, L.trunk.y, 0],
    chain([
      [L.trunk.x0, L.trunk.z],
      [L.trunk.x1, L.trunk.z],
      [L.floor.x0 - 20, L.floor.z + 10],
    ]),
    2 * L.trunk.y,
  );
  sheet(
    'dash',
    'Dash panel',
    XZ,
    [0, L.dash.y, 0],
    chain([
      [L.floor.x1 + 10, L.floor.z + 10],
      [L.dash.x, 420],
      [L.dash.x, L.dash.top],
    ]),
    2 * L.dash.y,
  );
  sheet(
    'radiator',
    'Radiator support',
    XZ,
    [0, L.radiator.y, 0],
    chain([
      [L.radiator.x, L.radiator.z0],
      [L.radiator.x, L.radiator.z1],
    ]),
    2 * L.radiator.y,
  );
  for (const [i, x] of L.cross.xs.entries())
    sheet(
      `cross-${i}`,
      `Cross member ${i + 1}`,
      XZ,
      [0, L.cross.y, 0],
      rect(x, L.cross.z0, x + L.cross.width, L.cross.z1),
      2 * L.cross.y,
    );

  // Each side (left; reflected at the end).
  sheet(
    'sill',
    'Sill',
    YZ,
    [L.sill.x0, 0, 0],
    rect(L.sill.y0, L.sill.z0, L.sill.y1, L.sill.z1),
    L.sill.x1 - L.sill.x0,
    true,
  );
  for (const [end, x] of [
    ['rear', L.axles.rear],
    ['front', L.axles.front],
  ] as const) {
    const W = L.wheelhouse;
    const at = (deg: number): [number, number] => [
      x + W.r * Math.cos((deg * Math.PI) / 180),
      L.axles.z + W.r * Math.sin((deg * Math.PI) / 180),
    ];
    const id = `wheelhouse-${end}`;
    const name = `${end === 'rear' ? 'Rear' : 'Front'} wheelhouse`;
    sketches.push(
      sketch(
        `${id}-line`,
        name,
        XZ,
        [0, W.y0, 0],
        { c: [x, L.axles.z], a: at(W.fromDeg), b: at(W.toDeg) },
        [{ type: 'arc', id: 'a0', center: 'c', start: 'a', end: 'b', clockwise: false }],
      ),
    );
    add(
      id,
      name,
      {
        id: `${id}-sheet`,
        name,
        type: 'extrudeSurface',
        inputFeatureIds: [],
        args: {
          path: { sketchId: `${id}-line`, elements: ['a0'] },
          distance: mm(W.depth),
          direction: 1,
        },
      },
      true,
    );
  }
  sheet(
    'member',
    'Front side member',
    YZ,
    [L.member.x0, 0, 0],
    rect(L.member.y0, L.member.z0, L.member.y1, L.member.z1),
    L.member.x1 - L.member.x0,
    true,
  );
  box('strut-mount', 'Strut top mount', L.strutMount.centre, L.strutMount.size);
  box('rear-mount', 'Rear suspension bracket', L.rearMount.centre, L.rearMount.size);

  let doc = applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    parameters: [],
    sketches,
    features,
    bodies,
  });
  const result = (id: string) => doc.bodies.find((b) => b.id === id)!.resultFeatureId;
  doc = applyCadOperation(doc, {
    type: 'insertFeatures',
    parameters: [],
    sketches: [],
    features: left.map(({ id, name }) => ({
      id: `${id}-r-copy`,
      name: `${name} R`,
      type: 'mirrorCopy',
      inputFeatureIds: [],
      args: {
        source: { featureId: result(id) },
        plane: { origin: position(0, 0, 0), normal: [0, 1, 0] },
      },
    })),
    bodies: left.map(({ id, name }) => ({
      id: `${id}-r`,
      name: `${name} R`,
      sourceFeatureId: `${id}-r-copy`,
      placementFeatureId: `${id}-r-placement`,
      appearance: grey,
    })),
  });
  return doc;
}
