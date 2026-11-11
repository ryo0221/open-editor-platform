/**
 * F29 (CR4g, docs/cad/car-design.md, B2の簡略BIW): the simplified body in white B2 is analysed
 * on, as 40 bodies of one CAD document: one body per pressed part (a sheet joined along its edges,
 * or a solid mount), the right-hand parts `mirrorCopy` reflections of the left ones in y = 0.
 *
 * Coordinates as F25: x forward from the tail, y across with the left side at y < 0, z up. The
 * shapes are the simplest the plan's features make (an extruded line or chain, a `trim` of the
 * door openings and the rear wheel arch, `flange` strips on free edges, `profileSweep` hats with
 * flat closures, boxes and cylinders for the mounts); the press shapes of a real BIW are left out.
 * Overlapping flanges are joined by `spotWelds` rows at `pitchMm` (40 by default).
 *
 * Options: `flangeMm` the side outer's roof flange width (80; the roof's edge strip, centred
 * 60 mm in from the side outer, welds onto it), `pitchMm` every row's pitch.
 */
import { cadSpotWeldLimits, identityQuaternion, mm, position, type CadDocument } from './model';
import type { CadFeature, CadSpotWeld, Quaternion, Vec3 } from './model';
import type { CadProfileKind } from './profile-section';
import { applyCadOperation, type CadNewBody } from './operations';
import type { CadSketch } from './sketch';
import { edgeName, type CadFaceName, type CadTopologyRef } from './topology';
import { f01Empty } from './fixtures';

/** u = x, v = z, normal −y. */
const XZ: Quaternion = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
/** u = y, v = z, normal +x. */
const YZ: Quaternion = [0.5, 0.5, 0.5, 0.5];
const XY: Quaternion = identityQuaternion();

const colours = {
  floor: '#8d99a6',
  roof: '#a3adb8',
  side: '#b7a58c',
  front: '#8fa39a',
  rear: '#9c93ad',
  cross: '#7f8a96',
  mount: '#6d7480',
};
type Group = keyof typeof colours;

/**
 * F29's bodies by the plan's groups (docs/cad/car-design.md, B2の簡略BIW); `-r` is a left
 * part's right copy.
 */
export const f29Groups = {
  floor: ['floor', 'dash', 'trunk'],
  roof: ['roof', 'bow-front', 'bow-rear'],
  side: ['side', 'sill', 'pillar-a', 'pillar-b', 'pillar-c', 'rail'].flatMap((b) => [b, `${b}-r`]),
  front: [
    ...['front-member', 'front-closure', 'front-extension', 'tower', 'apron'].flatMap((b) => [
      b,
      `${b}-r`,
    ]),
    'radiator',
  ],
  rear: ['rear-member', 'rear-closure', 'wheelhouse'].flatMap((b) => [b, `${b}-r`]),
  cross: ['cross-rear', 'cross-middle', 'cross-front'],
  mount: ['strut-mount', 'rear-mount'].flatMap((b) => [b, `${b}-r`]),
};
/** The F29 side outer's roof flange width and the rows' pitch, by default. */
export const f29Defaults = { flangeMm: 80, pitchMm: cadSpotWeldLimits.defaultPitchMm };
/**
 * CR5f-7: the front side member's extension: under its closure (top z 450) from `frontX`, a rise
 * of `rise` between two bends of `radius` and a run at `angleDeg`, then under the floor pan (top
 * z 250) from `endX` to `rearX`, the front cross member's front wall. `z` is the path under the
 * floor (the hat's open side; its top is 60 above).
 */
export const f29FrontKick = {
  z: 190,
  rise: 200,
  radius: 100,
  angleDeg: 60,
  endX: 2890,
  rearX: 2740,
  frontX: 3400,
};
/** CR5f-9: the width of the apron's lower flange, from the apron (y −650) to y −480. */
export const f29ApronLowerMm = 170;
/**
 * CR5f-6: where members end on others so the analysis can join their ends (rim bonds): the
 * pillars run from the sill's top wall (z 310) to the roof rail's bottom wall (z 1200), the cross
 * members across to the sills' inner walls (y ±650), and the rear side member to the rear cross
 * member's back wall (x 1260).
 */
export const f29Joints = {
  sillTopZ: 310,
  railBottomZ: 1200,
  sillInnerY: 650,
  crossRearBackX: 1260,
  crossFrontFrontX: 2740,
};
/**
 * CR5f-4: the rear side member's kick under the trunk floor's kick (x 950–1000): its closure at
 * z `z` until the first bend, down `drop` by two bends of `radius` and a run at `angleDeg`,
 * ending at x `endX` (under the floor pan's rear edge), then on to x `frontX`.
 */
export const f29RearKick = {
  z: 290,
  drop: 100,
  radius: 200,
  angleDeg: 30,
  endX: 999.98,
  frontX: 1260,
  flip: false,
};

type Entity = CadSketch['entities'][number];
/** A sketch of lines and arcs on `plane` at `origin`; `points` its solved points. */
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
/** A chain of lines `s0, s1, …` through `points` p0, p1, … in order. */
function chain(pts: [number, number][]) {
  const points = Object.fromEntries(pts.map((p, i) => [`p${i}`, p]));
  const entities: Entity[] = pts
    .slice(1)
    .map((_, i) => ({ type: 'line', id: `s${i}`, start: `p${i}`, end: `p${i + 1}` }));
  return { points, entities, elements: entities.map((e) => e.id) };
}

const faceRef = (featureId: string, name: CadFaceName, centroid: Vec3, size: number) =>
  ({ kind: 'face', featureId, name: [name], hint: { centroid, size } }) as CadTopologyRef;
const edgeRef = (featureId: string, a: CadFaceName, b: CadFaceName, centroid: Vec3, size: number) =>
  ({ kind: 'edge', featureId, name: edgeName(a, b), hint: { centroid, size } }) as CadTopologyRef;

/** Hat sizes (height, width at the base, flange width, bend radius), mm. */
type Hat = [number, number, number, number];

/**
 * The F29 document. Its parts, by the plan's groups (each `L` part has an `R` copy):
 * floor and bulkheads (floor pan, dash, trunk floor), roof (panel, front and rear bows), sides
 * (outer, sill, A/B/C pillar inners, roof rail inner), front (side member and its closure, strut
 * tower, apron; radiator support), rear (side member and closure, wheelhouse inner), cross
 * members (under the floor, rear/middle/front) and the solid mounts (strut top, rear bracket).
 */
export function f29Biw(options: { flangeMm?: number; pitchMm?: number } = {}): CadDocument {
  const flangeMm = options.flangeMm ?? f29Defaults.flangeMm;
  const pitchMm = options.pitchMm ?? f29Defaults.pitchMm;
  const sketches: CadSketch[] = [];
  const features: CadFeature[] = [];
  const bodies: CadNewBody[] = [];
  /** Left parts, reflected at the end. */
  const left: string[] = [];
  const names = new Map<string, string>();
  const add = (id: string, name: string, group: Group, feature: CadFeature, mirrored: boolean) => {
    features.push(feature);
    bodies.push({
      id,
      name: mirrored ? `${name} L` : name,
      sourceFeatureId: feature.id,
      placementFeatureId: `${id}-placement`,
      appearance: { color: colours[group], opacity: 1 },
    });
    names.set(id, name);
    if (mirrored) left.push(id);
  };
  const extrudeChain = (
    id: string,
    name: string,
    group: Group,
    s: CadSketch,
    elements: string[],
    distance: number,
    mirrored = false,
  ) => {
    sketches.push(s);
    add(
      id,
      name,
      group,
      {
        id: `${id}-sheet`,
        name,
        type: 'extrudeSurface',
        inputFeatureIds: [],
        args: { path: { sketchId: s.id, elements }, distance: mm(distance), direction: 1 },
      },
      mirrored,
    );
  };
  const sweep = (
    id: string,
    name: string,
    group: Group,
    path: { sketchId: string; elements: string[] },
    kind: CadProfileKind,
    [height, width, flange, radius]: Hat,
    flip: boolean,
    mirrored = false,
    up: 'normal' | 'inPlane' = 'normal',
  ) =>
    add(
      id,
      name,
      group,
      {
        id: `${id}-sweep`,
        name,
        type: 'profileSweep',
        inputFeatureIds: [],
        args: {
          path,
          profile: {
            kind,
            height: mm(height),
            width: mm(width),
            flange: mm(flange),
            radius: mm(radius),
          },
          up,
          flip,
        },
      },
      mirrored,
    );

  // Floor and bulkheads. The floor pan: z = 250, y ±650, x 1000–2900, its long edges flanged
  // 40 up onto the sills' inner faces.
  {
    const c = chain([
      [-650, 250],
      [650, 250],
    ]);
    extrudeChain(
      'floor',
      'Floor pan',
      'floor',
      sketch('floor-line', 'Floor', YZ, [1000, 0, 0], c.points, c.entities),
      c.elements,
      1900,
    );
  }
  // The dash: a strip on the floor (x 2800–2900), the toe board, the wall at x 2950 up to z 950.
  {
    const c = chain([
      [2800, 250],
      [2900, 250],
      [2950, 450],
      [2950, 950],
    ]);
    extrudeChain(
      'dash',
      'Dash panel',
      'floor',
      sketch('dash-line', 'Dash', XZ, [0, 650, 0], c.points, c.entities),
      c.elements,
      1300,
    );
  }
  // The trunk floor at z 350 from the tail, the kick down and a strip on the floor (x 1000–1100).
  {
    const c = chain([
      [200, 350],
      [950, 350],
      [1000, 250],
      [1100, 250],
    ]);
    extrudeChain(
      'trunk',
      'Trunk floor',
      'floor',
      sketch('trunk-line', 'Trunk floor', XZ, [0, 600, 0], c.points, c.entities),
      c.elements,
      1200,
    );
  }
  // Roof: the panel (x 1200–2300) with strips at z 1250 along its sides on the side outers'
  // flanges; the bows under it, hats hanging from z 1300.
  {
    const c = chain([
      [-740, 1250],
      [-640, 1250],
      [-600, 1300],
      [600, 1300],
      [640, 1250],
      [740, 1250],
    ]);
    extrudeChain(
      'roof',
      'Roof panel',
      'roof',
      sketch('roof-line', 'Roof', YZ, [1200, 0, 0], c.points, c.entities),
      c.elements,
      1100,
    );
    const bows = sketch(
      'bow-lines',
      'Roof bows',
      XY,
      [0, 0, 1300],
      { f0: [2230, -600], f1: [2230, 600], r0: [1270, -600], r1: [1270, 600] },
      [
        { type: 'line', id: 'front', start: 'f0', end: 'f1' },
        { type: 'line', id: 'rear', start: 'r0', end: 'r1' },
      ],
    );
    sketches.push(bows);
    sweep(
      'bow-front',
      'Front roof bow',
      'roof',
      { sketchId: 'bow-lines', elements: ['front'] },
      'hat',
      [40, 60, 20, 3],
      true,
    );
    sweep(
      'bow-rear',
      'Rear roof bow',
      'roof',
      { sketchId: 'bow-lines', elements: ['rear'] },
      'hat',
      [40, 60, 20, 3],
      true,
    );
  }
  // Cross members: hats hanging under the floor, across to the sills' inner walls (y ±650).
  {
    const at = { rear: 1300, middle: 2000, front: 2700 };
    sketches.push(
      sketch(
        'cross-lines',
        'Cross members',
        XY,
        [0, 0, 250],
        Object.fromEntries(
          Object.entries(at).flatMap(([k, x]) => [
            [`${k}0`, [x, -f29Joints.sillInnerY]],
            [`${k}1`, [x, f29Joints.sillInnerY]],
          ]),
        ),
        Object.keys(at).map((k) => ({ type: 'line', id: k, start: `${k}0`, end: `${k}1` })),
      ),
    );
    for (const k of Object.keys(at))
      sweep(
        `cross-${k}`,
        `Cross member ${k}`,
        'cross',
        { sketchId: 'cross-lines', elements: [k] },
        'hat',
        [50, 80, 20, 3],
        true,
      );
  }
  // Radiator support: a wall across the front at x 3850, z 400–800.
  {
    const c = chain([
      [3850, -500],
      [3850, 500],
    ]);
    extrudeChain(
      'radiator',
      'Radiator support',
      'front',
      sketch('radiator-line', 'Radiator support', XY, [0, 0, 400], c.points, c.entities),
      c.elements,
      400,
    );
  }

  // Sides (left). The side outer: a sheet in y = −750 (x 150–3000, z 150–1250) with the door
  // openings and the rear wheel arch trimmed out, its top edge flanged inwards (`flangeMm`).
  {
    const c = chain([
      [150, -750],
      [3000, -750],
    ]);
    extrudeChain(
      'side',
      'Side outer',
      'side',
      sketch('side-line', 'Side outer', XY, [0, 0, 150], c.points, c.entities),
      c.elements,
      1100,
      true,
    );
    // The openings (XZ through y = 0, carried onto the side): rear and front door, the arch.
    sketches.push(
      sketch(
        'side-openings',
        'Side openings',
        XZ,
        [0, 0, 0],
        {
          r0: [1200, 350],
          r1: [1900, 350],
          r2: [1900, 1150],
          r3: [1200, 1150],
          f0: [2000, 350],
          f1: [2850, 350],
          f2: [2850, 1150],
          f3: [2000, 1150],
          c: [600, 100],
          w0: [960, 100],
          w1: [240, 100],
        },
        [
          { type: 'line', id: 'r-s0', start: 'r0', end: 'r1' },
          { type: 'line', id: 'r-s1', start: 'r1', end: 'r2' },
          { type: 'line', id: 'r-s2', start: 'r2', end: 'r3' },
          { type: 'line', id: 'r-s3', start: 'r3', end: 'r0' },
          { type: 'line', id: 'f-s0', start: 'f0', end: 'f1' },
          { type: 'line', id: 'f-s1', start: 'f1', end: 'f2' },
          { type: 'line', id: 'f-s2', start: 'f2', end: 'f3' },
          { type: 'line', id: 'f-s3', start: 'f3', end: 'f0' },
          { type: 'arc', id: 'arch', center: 'c', start: 'w0', end: 'w1', clockwise: false },
          { type: 'line', id: 'arch-base', start: 'w1', end: 'w0' },
        ],
      ),
    );
    // The inner members on the side outer: hats rising inwards (+y) from y = −750.
    sketches.push(
      sketch(
        'side-members',
        'Side members',
        XZ,
        [0, -750, 0],
        {
          sill0: [1000, 250],
          sill1: [3000, 250],
          a0: [2925, f29Joints.sillTopZ],
          a1: [2925, f29Joints.railBottomZ],
          b0: [1950, f29Joints.sillTopZ],
          b1: [1950, f29Joints.railBottomZ],
          c0: [1100, f29Joints.sillTopZ],
          c1: [1100, f29Joints.railBottomZ],
          rail0: [1050, 1215],
          rail1: [2950, 1215],
        },
        ['sill', 'a', 'b', 'c', 'rail'].map((k) => ({
          type: 'line' as const,
          id: k,
          start: `${k}0`,
          end: `${k}1`,
        })),
      ),
    );
    const on = (k: string) => ({ sketchId: 'side-members', elements: [k] });
    sweep('sill', 'Sill inner', 'side', on('sill'), 'hat', [100, 120, 20, 3], true, true);
    sweep('pillar-a', 'A-pillar inner', 'side', on('a'), 'hat', [60, 80, 20, 3], true, true);
    sweep('pillar-b', 'B-pillar inner', 'side', on('b'), 'hat', [50, 40, 15, 3], true, true);
    sweep('pillar-c', 'C-pillar inner', 'side', on('c'), 'hat', [50, 60, 20, 3], true, true);
    sweep('rail', 'Roof rail inner', 'side', on('rail'), 'hat', [40, 30, 15, 3], true, true);
  }
  // Front (left): the side member, a hat on its flat closure at z 450 along y = −450 from the
  // dash wall (x 2950) to the radiator support (x 3850); the strut tower, a half drum of R 150
  // round (3300, −650) from z 450 to 850, its ends on the apron in y = −650 (z 450–850).
  {
    sketches.push(
      sketch(
        'front-member-line',
        'Front side member',
        XY,
        [0, 0, 450],
        { p0: [2950, -450], p1: [3850, -450] },
        [{ type: 'line', id: 'l', start: 'p0', end: 'p1' }],
      ),
    );
    const path = { sketchId: 'front-member-line', elements: ['l'] };
    sweep('front-member', 'Front side member', 'front', path, 'hat', [60, 60, 20, 3], false, true);
    sweep(
      'front-closure',
      'Front side member closure',
      'front',
      path,
      'flat',
      [60, 60, 20, 3],
      true,
      true,
    );
    // CR5f-7: the side member's extension, a hat under its closure from x 3400 back past the
    // dash, down under the toe board (two R 100 bends and a 60° run) and on under the floor pan
    // (top z 250) to the front cross member's front wall (x 2740), so the front structure's loads
    // reach the floor and the cross member rather than only the dash's flat wall. Sharp corners
    // (R 0) as the rear member's.
    {
      const k = f29FrontKick;
      const t = (k.angleDeg * Math.PI) / 180;
      const [s, c] = [Math.sin(t), Math.cos(t)];
      const run = (k.rise - 2 * k.radius * (1 - c)) / s;
      const p2: [number, number] = [k.endX + k.radius * s, k.z + k.radius * (1 - c)];
      const p3: [number, number] = [p2[0] + run * c, p2[1] + run * s];
      const x0 = p3[0] + k.radius * s;
      sketches.push(
        sketch(
          'front-extension-line',
          'Front side member extension',
          XZ,
          [0, -450, 0],
          {
            p0: [k.rearX, k.z],
            p1: [k.endX, k.z],
            c0: [k.endX, k.z + k.radius],
            p2,
            p3,
            c1: [x0, k.z + k.rise - k.radius],
            p4: [x0, k.z + k.rise],
            p5: [k.frontX, k.z + k.rise],
          },
          [
            { type: 'line', id: 'f', start: 'p0', end: 'p1' },
            { type: 'arc', id: 'k0', center: 'c0', start: 'p1', end: 'p2', clockwise: false },
            { type: 'line', id: 'k1', start: 'p2', end: 'p3' },
            { type: 'arc', id: 'k2', center: 'c1', start: 'p3', end: 'p4', clockwise: true },
            { type: 'line', id: 'l', start: 'p4', end: 'p5' },
          ],
        ),
      );
      sweep(
        'front-extension',
        'Front side member extension',
        'front',
        { sketchId: 'front-extension-line', elements: ['f', 'k0', 'k1', 'k2', 'l'] },
        'hat',
        [60, 60, 20, 0],
        false,
        true,
        'inPlane',
      );
    }
    sketches.push(
      sketch(
        'tower-line',
        'Strut tower',
        XY,
        [0, 0, 450],
        { c: [3300, -650], t0: [3450, -650], t1: [3150, -650] },
        [{ type: 'arc', id: 'a0', center: 'c', start: 't0', end: 't1', clockwise: false }],
      ),
    );
    add(
      'tower',
      'Strut tower',
      'front',
      {
        id: 'tower-sheet',
        name: 'Strut tower',
        type: 'extrudeSurface',
        inputFeatureIds: [],
        args: {
          path: { sketchId: 'tower-line', elements: ['a0'] },
          distance: mm(400),
          direction: 1,
        },
      },
      true,
    );
    const c = chain([
      [2950, -650],
      [3850, -650],
    ]);
    extrudeChain(
      'apron',
      'Front apron',
      'front',
      sketch('apron-line', 'Front apron', XY, [0, 0, 450], c.points, c.entities),
      c.elements,
      400,
      true,
    );
  }
  // Rear (left): the side member on its closure at z 290 along y = −450 from x 250, its top
  // under the trunk floor (z 350); in front of the rear mount it kicks down 100 mm under the
  // trunk floor's kick (two R 200 bends and a 30° run, CR5f-4) and runs on under the floor pan
  // (top z 250) to x 1260, the rear cross member's back wall (CR5f-6), so the rear mounts' loads
  // reach the cabin through the member rather than through the trunk floor's plate. Its corners
  // are sharp (R 0, CR5f-5): an R 3 corner on the 30° run is triangulated as a fan the Host's
  // shell expansion refuses (over 60° between neighbours). The
  // wheelhouse inner, a drum of R 370 round (600, z 100) from y −750 inwards 200, down to
  // z ≈ 164 each side (10° above the axis) so its outer flange stays on the side outer (which
  // ends at z 150).
  {
    const k = f29RearKick;
    const t = (k.angleDeg * Math.PI) / 180;
    const [s, c] = [Math.sin(t), Math.cos(t)];
    // The run between the bends, so the two bends and the run drop `drop` in all.
    const run = (k.drop - 2 * k.radius * (1 - c)) / s;
    const x0 = k.endX - 2 * k.radius * s - run * c;
    const z0 = k.z;
    const pts: Record<string, [number, number]> = {
      p0: [250, z0],
      p1: [x0, z0],
      c0: [x0, z0 - k.radius],
      p2: [x0 + k.radius * s, z0 - k.radius * (1 - c)],
      p3: [x0 + k.radius * s + run * c, z0 - k.radius * (1 - c) - run * s],
      c1: [k.endX, z0 - k.drop + k.radius],
      p4: [k.endX, z0 - k.drop],
      p5: [k.frontX, z0 - k.drop],
    };
    sketches.push(
      sketch('rear-member-line', 'Rear side member', XZ, [0, -450, 0], pts, [
        { type: 'line', id: 'l', start: 'p0', end: 'p1' },
        { type: 'arc', id: 'k0', center: 'c0', start: 'p1', end: 'p2', clockwise: true },
        { type: 'line', id: 'k1', start: 'p2', end: 'p3' },
        { type: 'arc', id: 'k2', center: 'c1', start: 'p3', end: 'p4', clockwise: false },
        { type: 'line', id: 'f', start: 'p4', end: 'p5' },
      ]),
    );
    const path = { sketchId: 'rear-member-line', elements: ['l', 'k0', 'k1', 'k2', 'f'] };
    sweep(
      'rear-member',
      'Rear side member',
      'rear',
      path,
      'hat',
      [60, 60, 20, 0],
      k.flip,
      true,
      'inPlane',
    );
    sweep(
      'rear-closure',
      'Rear side member closure',
      'rear',
      path,
      'flat',
      [60, 60, 20, 0],
      !k.flip,
      true,
      'inPlane',
    );
    sketches.push(
      sketch(
        'wheelhouse-line',
        'Rear wheelhouse',
        XZ,
        [0, -750, 0],
        { c: [600, 100], h0: [964.378869, 164.249826], h1: [235.621131, 164.249826] },
        [{ type: 'arc', id: 'a0', center: 'c', start: 'h0', end: 'h1', clockwise: false }],
      ),
    );
    add(
      'wheelhouse',
      'Rear wheelhouse inner',
      'rear',
      {
        id: 'wheelhouse-sheet',
        name: 'Rear wheelhouse inner',
        type: 'extrudeSurface',
        inputFeatureIds: [],
        args: {
          path: { sketchId: 'wheelhouse-line', elements: ['a0'] },
          distance: mm(200),
          direction: -1,
        },
      },
      true,
    );
  }
  // Solid mounts (left): the strut top mount on the tower's seat, the rear bracket on the rear
  // side member's top.
  add(
    'strut-mount',
    'Strut top mount',
    'mount',
    {
      id: 'strut-mount-solid',
      name: 'Strut top mount',
      type: 'cylinder',
      inputFeatureIds: [],
      args: { radius: mm(130), height: mm(20), origin: position(3300, -650, 850), orientation: XY },
    },
    true,
  );
  add(
    'rear-mount',
    'Rear suspension bracket',
    'mount',
    {
      id: 'rear-mount-solid',
      name: 'Rear suspension bracket',
      type: 'box',
      inputFeatureIds: [],
      args: { size: [mm(80), mm(80), mm(40)], origin: position(480, -490, 350), orientation: XY },
    },
    true,
  );

  let doc = applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    parameters: [],
    sketches,
    features,
    bodies,
  });

  // Details: trims and flanges, each a feature and a placement on its body.
  const detail = (bodyId: string, feature: CadFeature) => {
    const body = doc.bodies.find((b) => b.id === bodyId)!;
    doc = applyCadOperation(doc, {
      type: 'detailBody',
      bodyId,
      placementFeatureId: `${feature.id}-placement`,
      feature: { ...feature, inputFeatureIds: [body.resultFeatureId] } as Extract<
        CadFeature,
        { type: 'flange' | 'trim' }
      >,
    });
    return body.resultFeatureId;
  };
  const flange = (
    bodyId: string,
    id: string,
    name: string,
    edges: CadTopologyRef[],
    width: number,
    toward: 'front' | 'back',
  ) =>
    detail(bodyId, {
      id,
      name,
      type: 'flange',
      inputFeatureIds: [''],
      args: { edges, width: mm(width), angle: { literalRad: Math.PI / 2 }, toward },
    });
  const result = (bodyId: string) => doc.bodies.find((b) => b.id === bodyId)!.resultFeatureId;
  {
    const on = result('floor');
    flange(
      'floor',
      'floor-flanges',
      'Floor pan flanges',
      [
        edgeRef(on, ['side:e:s0'], ['edge:start:e:s0'], [1950, -650, 250], 1900),
        edgeRef(on, ['side:e:s0'], ['edge:end:e:s0'], [1950, 650, 250], 1900),
      ],
      40,
      'front',
    );
  }
  flange(
    'dash',
    'dash-flange',
    'Dash flange',
    [edgeRef(result('dash'), ['side:e:s2'], ['edge:end:e:s2'], [2950, 0, 950], 1300)],
    40,
    'front',
  );
  flange(
    'radiator',
    'radiator-flange',
    'Radiator support flange',
    [edgeRef(result('radiator'), ['side:e:s0'], ['end'], [3850, 0, 800], 1000)],
    50,
    'front',
  );
  detail('side', {
    id: 'side-openings-trim',
    name: 'Side openings',
    type: 'trim',
    inputFeatureIds: [''],
    args: {
      tool: { sketchId: 'side-openings', elements: ['r-s0', 'r-s1', 'r-s2', 'r-s3'] },
      keep: 'outside',
      chains: [
        ['f-s0', 'f-s1', 'f-s2', 'f-s3'],
        ['arch', 'arch-base'],
      ],
    },
  });
  flange(
    'side',
    'side-roof-flange',
    'Side outer roof flange',
    [
      edgeRef(
        result('side'),
        ['trim:side-openings-trim:outside', 'side:e:s0'],
        ['trim:side-openings-trim:outside', 'end'],
        [1575, -750, 1250],
        2850,
      ),
    ],
    flangeMm,
    'front',
  );
  flange(
    'tower',
    'tower-seat',
    'Strut tower seat',
    [edgeRef(result('tower'), ['side:e:a0'], ['end'], [3300, -500, 850], 471)],
    40,
    'front',
  );
  flange(
    'apron',
    'apron-flange',
    'Front apron flange',
    [edgeRef(result('apron'), ['side:e:s0'], ['end'], [3400, -650, 850], 900)],
    30,
    'front',
  );
  // The joins of the front and rear structures to the cabin (CR5f): the side member closure's
  // ends turned up 40 onto the dash wall and the radiator support, the strut tower's ends turned
  // out 40 onto the apron, the apron's rear end turned in 30 onto the dash wall, the wheelhouse's
  // outer edge turned out 30 onto the side outer.
  flange(
    'front-closure',
    'front-closure-ends',
    'Front side member closure ends',
    [
      edgeRef(
        result('front-closure'),
        ['side:p:plate', 'path:e:l'],
        ['start'],
        [2950, -450, 450],
        100,
      ),
      edgeRef(
        result('front-closure'),
        ['side:p:plate', 'path:e:l'],
        ['end'],
        [3850, -450, 450],
        100,
      ),
    ],
    40,
    'front',
  );
  flange(
    'tower',
    'tower-ends',
    'Strut tower ends',
    [
      edgeRef(
        result('tower'),
        ['flange:tower-seat', 'side:e:a0'],
        ['flange:tower-seat', 'edge:start:e:a0'],
        [3450, -650, 650],
        400,
      ),
      edgeRef(
        result('tower'),
        ['flange:tower-seat', 'side:e:a0'],
        ['flange:tower-seat', 'edge:end:e:a0'],
        [3150, -650, 650],
        400,
      ),
    ],
    40,
    'front',
  );
  flange(
    'apron',
    'apron-end',
    'Front apron rear end',
    [
      edgeRef(
        result('apron'),
        ['flange:apron-flange', 'side:e:s0'],
        ['flange:apron-flange', 'edge:start:e:s0'],
        [2950, -650, 650],
        400,
      ),
    ],
    30,
    'front',
  );
  // CR5f-9: the apron's lower edge turned in 170 at z 450 to y −480, over the front side member's
  // closure, so the strut tower and the apron can be carried by the side member as well as by the
  // dash wall; the tower's lower edge stands on it. (The analysis joins its edge and the tower's
  // to them: the overlap, 20 mm, is too narrow for a row along the flange's centre line.)
  flange(
    'apron',
    'apron-lower',
    'Front apron lower flange',
    [
      edgeRef(
        result('apron'),
        ['flange:apron-end', 'flange:apron-flange', 'side:e:s0'],
        ['flange:apron-end', 'flange:apron-flange', 'start'],
        [3400, -650, 450],
        900,
      ),
    ],
    f29ApronLowerMm,
    'front',
  );
  flange(
    'wheelhouse',
    'wheelhouse-flange',
    'Rear wheelhouse flange',
    [edgeRef(result('wheelhouse'), ['side:e:a0'], ['start'], [600, -750, 340], 1100)],
    30,
    'front',
  );

  // The right-hand parts: each left part's result reflected in y = 0.
  doc = applyCadOperation(doc, {
    type: 'insertFeatures',
    features: left.map((id) => ({
      id: `${id}-r-copy`,
      name: `${names.get(id)} R`,
      type: 'mirrorCopy',
      inputFeatureIds: [],
      args: {
        source: { featureId: result(id) },
        plane: { origin: position(0, 0, 0), normal: [0, 1, 0] },
      },
    })),
    bodies: left.map((id) => ({
      id: `${id}-r`,
      name: `${names.get(id)} R`,
      sourceFeatureId: `${id}-r-copy`,
      placementFeatureId: `${id}-r-placement`,
      appearance: doc.bodies.find((b) => b.id === id)!.appearance,
    })),
  });

  // Spot weld rows: the first flange's centre line, measured to the second.
  type Flange = { bodyId: string; name: CadFaceName; at: Vec3; size: number };
  const own = (bodyId: string, name: CadFaceName, at: Vec3, size: number): Flange => ({
    bodyId,
    name,
    at,
    size,
  });
  /** The same face on a left part's right copy. */
  const right = (f: Flange): Flange => ({
    bodyId: `${f.bodyId}-r`,
    name: [`mirror:${f.bodyId}-r-copy`, ...f.name],
    at: [f.at[0], -f.at[1], f.at[2]],
    size: f.size,
  });
  const welds: CadSpotWeld[] = [];
  const row = (id: string, name: string, a: Flange, b: Flange) =>
    welds.push({
      id,
      name,
      flanges: [a, b].map((f) => ({
        bodyId: f.bodyId,
        face: faceRef(result(f.bodyId), f.name, f.at, f.size),
      })) as CadSpotWeld['flanges'],
      pitchMm,
      endDistanceMm: cadSpotWeldLimits.defaultEndDistanceMm,
      maxGapMm: cadSpotWeldLimits.defaultMaxGapMm,
    });
  const floor = own('floor', ['flange:floor-flanges', 'side:e:s0'], [1950, 0, 250], 1900);
  const roof = own('roof', ['side:e:s2'], [1750, 0, 1300], 1200);
  const hat = (bodyId: string, path: string, side: 'l' | 'r', at: Vec3, size: number) =>
    own(bodyId, [`side:p:flange:${side}`, `path:e:${path}`], at, size);
  row(
    'weld-dash',
    'Dash to floor',
    own('dash', ['flange:dash-flange', 'side:e:s0'], [2850, 0, 250], 1300),
    floor,
  );
  row(
    'weld-trunk',
    'Trunk floor to floor',
    own('trunk', ['side:e:s2'], [1050, 0, 250], 1200),
    floor,
  );
  for (const [bow, x, path] of [
    ['bow-front', 2230, 'front'],
    ['bow-rear', 1270, 'rear'],
  ] as const)
    for (const side of ['l', 'r'] as const)
      row(
        `weld-${bow}-${side}`,
        `${names.get(bow)} ${side}`,
        hat(bow, path, side, [x + (side === 'l' ? -40 : 40), 0, 1300], 1200),
        roof,
      );
  for (const [k, x] of [
    ['rear', 1300],
    ['middle', 2000],
    ['front', 2700],
  ] as const)
    for (const side of ['l', 'r'] as const)
      row(
        `weld-cross-${k}-${side}`,
        `Cross member ${k} ${side}`,
        hat(`cross-${k}`, k, side, [x + (side === 'l' ? -40 : 40), 0, 250], 1200),
        floor,
      );
  // Both sides of the car: the left rows, and the same on the right copies.
  const sides = (id: string, name: string, a: Flange, b: Flange) => {
    row(`weld-l-${id}`, `${name} L`, a, b);
    row(`weld-r-${id}`, `${name} R`, right(a), right(b));
  };
  const outer = own(
    'side',
    ['flange:side-roof-flange', 'trim:side-openings-trim:outside', 'side:e:s0'],
    [1343, -750, 705],
    2850,
  );
  const roofFlange = own('side', ['flange:side-roof-flange:wall', '0'], [1575, -720, 1250], 2850);
  // The roof's edge strips (z 1250) on the side outers' roof flanges.
  row(
    'weld-roof-l',
    'Roof to side outer L',
    own('roof', ['side:e:s0'], [1750, -690, 1250], 1100),
    roofFlange,
  );
  row(
    'weld-roof-r',
    'Roof to side outer R',
    own('roof', ['side:e:s4'], [1750, 690, 1250], 1100),
    right(roofFlange),
  );
  for (const [id, path, x, z, size] of [
    ['sill', 'sill', 2000, 250, 2000],
    ['pillar-a', 'a', 2925, 755, 890],
    ['pillar-b', 'b', 1950, 755, 890],
    ['pillar-c', 'c', 1100, 755, 890],
    ['rail', 'rail', 2000, 1215, 1900],
  ] as const)
    for (const side of ['l', 'r'] as const)
      sides(
        `${id}-${side}`,
        `${names.get(id)} (${side} flange)`,
        hat(id, path, side, [x, -750, z], size),
        outer,
      );
  // The floor pan's flanges on the sills' inner faces.
  row(
    'weld-floor-sill-l',
    'Floor to sill L',
    own('floor', ['flange:floor-flanges:wall', '0'], [1950, -650, 270], 1900),
    own('sill', ['side:p:top', 'path:e:sill'], [2000, -650, 250], 2000),
  );
  row(
    'weld-floor-sill-r',
    'Floor to sill R',
    own('floor', ['flange:floor-flanges:wall', '1'], [1950, 650, 270], 1900),
    right(own('sill', ['side:p:top', 'path:e:sill'], [2000, -650, 250], 2000)),
  );
  // The side members on their closures.
  for (const [id, x, z] of [
    ['front-member', 3400, 450],
    ['rear-member', 485, 290],
  ] as const) {
    const closure = id === 'front-member' ? 'front-closure' : 'rear-closure';
    for (const side of ['l', 'r'] as const)
      sides(
        `${id}-${side}`,
        `${names.get(id)} (${side} flange)`,
        hat(id, 'l', side, [x, -450, z], 900),
        own(
          closure,
          [
            ...(id === 'front-member' ? ['flange:front-closure-ends'] : []),
            'side:p:plate',
            'path:e:l',
          ],
          [x, -450, z],
          900,
        ),
      );
  }
  // The front and rear structures on the cabin (CR5f). A row onto a part both sides share (the
  // dash, the radiator support, the trunk floor) is made on each side with the same part.
  const shared = (id: string, name: string, a: Flange, b: Flange) => {
    row(`weld-l-${id}`, `${name} L`, a, b);
    row(`weld-r-${id}`, `${name} R`, right(a), { ...b, at: [b.at[0], -b.at[1], b.at[2]] });
  };
  const dashWall = (y: number, z: number) =>
    own('dash', ['flange:dash-flange', 'side:e:s2'], [2950, y, z], 1300);
  shared(
    'closure-dash',
    'Front side member closure to dash',
    own('front-closure', ['flange:front-closure-ends:wall', '0'], [2950, -450, 470], 100),
    dashWall(-450, 470),
  );
  shared(
    'closure-radiator',
    'Front side member closure to radiator support',
    own('front-closure', ['flange:front-closure-ends:wall', '1'], [3850, -450, 470], 100),
    own('radiator', ['flange:radiator-flange', 'side:e:s0'], [3850, -450, 470], 1000),
  );
  const apron = own(
    'apron',
    ['flange:apron-lower', 'flange:apron-end', 'flange:apron-flange', 'side:e:s0'],
    [3400, -650, 650],
    900,
  );
  for (const [k, x] of [
    ['0', 3430],
    ['1', 3170],
  ] as const)
    sides(
      `tower-${k}`,
      `Strut tower end ${Number(k) + 1} to apron`,
      own('tower', ['flange:tower-ends:wall', k], [x, -650, 650], 400),
      apron,
    );
  shared(
    'apron-dash',
    'Front apron to dash',
    own('apron', ['flange:apron-lower', 'flange:apron-end:wall', '0'], [2950, -635, 650], 400),
    dashWall(-635, 650),
  );
  shared(
    'rear-member-trunk',
    'Rear side member to trunk floor',
    own('rear-member', ['side:p:top', 'path:e:l'], [485, -450, 350], 470),
    own('trunk', ['side:e:s0'], [485, -450, 350], 1200),
  );
  sides(
    'wheelhouse',
    'Rear wheelhouse to side outer',
    own('wheelhouse', ['flange:wheelhouse-flange:wall', '0'], [600, -750, 372], 1100),
    outer,
  );
  // CR5f-4: the rear side member's run under the floor pan, on its closure and on the floor.
  const under = (y: number, z: number): Vec3 => [(f29RearKick.endX + f29RearKick.frontX) / 2, y, z];
  const run = f29RearKick.frontX - f29RearKick.endX;
  for (const side of ['l', 'r'] as const)
    sides(
      `rear-member-run-${side}`,
      `Rear side member run (${side} flange)`,
      hat('rear-member', 'f', side, under(-450, 190), run),
      own('rear-closure', ['side:p:plate', 'path:e:f'], under(-450, 190), run),
    );
  shared(
    'rear-member-floor',
    'Rear side member to floor pan',
    own('rear-member', ['side:p:top', 'path:e:f'], under(-450, 250), run),
    floor,
  );
  // CR5f-7: the front side member's extension on its closure and on the floor pan.
  sides(
    'front-extension-closure',
    'Front side member extension to closure',
    own('front-extension', ['side:p:top', 'path:e:l'], [3260, -450, 450], 280),
    own(
      'front-closure',
      ['flange:front-closure-ends', 'side:p:plate', 'path:e:l'],
      [3260, -450, 450],
      900,
    ),
  );
  shared(
    'front-extension-floor',
    'Front side member extension to floor pan',
    own('front-extension', ['side:p:top', 'path:e:f'], [2815, -450, 250], 150),
    floor,
  );
  for (const weld of welds) doc = applyCadOperation(doc, { type: 'setSpotWeld', weld });
  return doc;
}
