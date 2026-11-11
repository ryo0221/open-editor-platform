/**
 * F57–F58 (CR6e, docs/cad/car-design.md, CR6の分け方): a headlamp and a tail lamp, each its own
 * CAD document (placing them on the car's body is CR7). Coordinates: x forward (the lamp's axis,
 * the light leaves along +x), y across, z up; the front of the housing is at x = 0.
 *
 * - Housing: a box drafted `draftDeg` from its back face for a pull along +x, shelled 2.5 mm
 *   inside with its front open (moulded black plastic).
 * - Reflector: a paraboloid of revolution about the x axis (a sheet, chrome) with its focus at
 *   (`focusX`, 0, 0). Its section is a quadratic B-spline, which is the parabola exactly; it starts
 *   `r0` from the axis (the bulb's hole) and ends at `rim`.
 * - Bulb: a sphere at the focus (lit, `lamp-white`).
 * - Inner lens (headlamp): a 3 mm plate with a grid of half-sphere lens cuts united on its front
 *   (CR6d rows). Tail lamp: the same plate lit red, its cuts as ribs of the grid.
 * - Outer lens: an arc bulging forward carried up the housing's height, thickened by the parameter
 *   `lens-t` (3 mm) half each way (clear `lamp-lens` on the headlamp, `lamp-red` on the tail lamp).
 */
import { geometryMaterialPreset } from '@editor-platform/geometry-core';
import { faceRef, f01Empty } from './fixtures';
import {
  identityQuaternion,
  mm,
  position,
  type CadAppearance,
  type CadDocument,
  type CadFeature,
} from './model';
import { applyCadOperation, type CadNewBody } from './operations';
import type { CadSketch } from './sketch';

/** A body's look copied from a library preset (as the appearance picker writes it). */
export function presetLook(id: string): CadAppearance {
  const p = geometryMaterialPreset(id);
  if (!p) throw new Error(`No material preset ${id}.`);
  return {
    color: p.color,
    opacity: p.opacity,
    roughness: p.roughness,
    metalness: p.metalness,
    material: p.id,
    ...(p.emission ? { emission: { ...p.emission } } : {}),
    ...(p.transmission !== undefined ? { transmission: p.transmission } : {}),
    ...(p.ior !== undefined ? { ior: p.ior } : {}),
  };
}

const housingLook: CadAppearance = { ...presetLook('plastic-matte'), color: '#1d1f22' };

/** The parameter both lamps' outer lens thickness reads. */
export const lampLensParameter = 'lens-t';

/** The sizes of each lamp (mm). */
export const lampSizes = {
  headlamp: {
    housing: [130, 220, 110] as [number, number, number],
    focusX: -60,
    focal: 25,
    r0: 10,
    rim: 50,
    bulb: 4,
    /** Inner lens plate: its back x, and the grid of cuts (count along y × rows along z). */
    innerX: -20,
    cuts: { radius: 3, count: 10, rows: 5, spacing: 20 },
    bulge: 25,
  },
  tail: {
    housing: [80, 300, 90] as [number, number, number],
    focusX: -40,
    focal: 15,
    r0: 6,
    rim: 35,
    bulb: 3,
    innerX: -12,
    cuts: { radius: 2, count: 14, rows: 4, spacing: 20 },
    bulge: 12,
  },
} as const;

const point = (id: string) => ({ type: 'point' as const, id });

/** The paraboloid's section x = vertex + r² / 4f from r0 to rim, a quadratic B-spline (exact). */
function parabolaSketch(focusX: number, f: number, r0: number, rim: number): CadSketch {
  const vertex = focusX - f;
  const x = (r: number) => vertex + (r * r) / (4 * f);
  // The parabola's Bézier: its ends and where their tangents meet. A sketch spline has 4 poles
  // or more, so it is split at its middle (uniform knots: the poles halfway along each leg).
  const p0: [number, number] = [x(r0), r0];
  const p1: [number, number] = [x(r0) + ((rim - r0) / 2) * (r0 / (2 * f)), (r0 + rim) / 2];
  const p2: [number, number] = [x(rim), rim];
  const half = (a: [number, number], b: [number, number]): [number, number] => [
    (a[0] + b[0]) / 2,
    (a[1] + b[1]) / 2,
  ];
  const solved: Record<string, [number, number]> = {
    q0: p0,
    q1: half(p0, p1),
    q2: half(p1, p2),
    q3: p2,
  };
  return {
    id: 'reflector-section',
    name: 'Reflector section',
    plane: { origin: position(0, 0, 0), orientation: identityQuaternion() },
    entities: [
      ...Object.keys(solved).map(point),
      { type: 'spline', id: 'parabola', poles: ['q0', 'q1', 'q2', 'q3'], degree: 2 },
    ],
    constraints: [],
    solved,
  };
}

/** The outer lens's arc on the plane z = −h/2: from (0, −w/2) through (bulge, 0) to (0, w/2). */
function lensSketch(width: number, height: number, bulge: number): CadSketch {
  const c = width / 2;
  const radius = (c * c + bulge * bulge) / (2 * bulge);
  const solved: Record<string, [number, number]> = {
    centre: [bulge - radius, 0],
    l0: [0, -c],
    l1: [0, c],
  };
  return {
    id: 'lens-line',
    name: 'Lens line',
    plane: { origin: position(0, 0, -height / 2), orientation: identityQuaternion() },
    entities: [
      ...Object.keys(solved).map(point),
      { type: 'arc', id: 'lens-arc', center: 'centre', start: 'l0', end: 'l1', clockwise: false },
    ],
    constraints: [],
    solved,
  };
}

function newBody(id: string, name: string, source: string, appearance: CadAppearance): CadNewBody {
  return { id, name, sourceFeatureId: source, placementFeatureId: `${id}-placement`, appearance };
}

/**
 * F57 (`headlamp`) and F58 (`tail`). `lensMm` is the outer lens's thickness parameter's value;
 * `draftDeg` the housing's draft (0 leaves its walls along the pull, for the draft check).
 */
export function lampFixture(
  kind: 'headlamp' | 'tail',
  options: { lensMm?: number; draftDeg?: number } = {},
): CadDocument {
  const s = lampSizes[kind];
  const [depth, width, height] = s.housing;
  const tail = kind === 'tail';
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
  const inner: [number, number, number] = [3, width - 20, height - 10];
  let doc = applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    parameters: [
      { id: lampLensParameter, name: 'Lens thickness', type: 'length', value: options.lensMm ?? 3 },
    ],
    sketches: [parabolaSketch(s.focusX, s.focal, s.r0, s.rim), lensSketch(width, height, s.bulge)],
    features: [
      box('housing-box', 'Housing', [depth, width, height], [-depth, -width / 2, -height / 2]),
      {
        id: 'reflector',
        name: 'Reflector',
        type: 'revolveSurface',
        inputFeatureIds: [],
        args: {
          path: { sketchId: 'reflector-section', elements: ['parabola'] },
          axisOrigin: [mm(0), mm(0)],
          axisDirection: [1, 0],
          angle: { literalRad: 2 * Math.PI },
        },
      },
      {
        id: 'bulb',
        name: 'Bulb',
        type: 'sphere',
        inputFeatureIds: [],
        args: {
          radius: mm(s.bulb),
          origin: position(s.focusX, 0, 0),
          orientation: identityQuaternion(),
        },
      },
      box('inner-plate', 'Inner lens', inner, [s.innerX, -inner[1] / 2, -inner[2] / 2]),
      {
        id: 'cut',
        name: 'Lens cut',
        type: 'sphere',
        inputFeatureIds: [],
        args: {
          radius: mm(s.cuts.radius),
          origin: position(
            s.innerX + inner[0],
            (-(s.cuts.count - 1) * s.cuts.spacing) / 2,
            (-(s.cuts.rows - 1) * s.cuts.spacing) / 2,
          ),
          orientation: identityQuaternion(),
        },
      },
      {
        id: 'lens-sheet',
        name: 'Outer lens surface',
        type: 'extrudeSurface',
        inputFeatureIds: [],
        args: {
          path: { sketchId: 'lens-line', elements: ['lens-arc'] },
          distance: mm(height),
          direction: 1,
        },
      },
    ],
    bodies: [
      newBody('housing', 'Housing', 'housing-box', housingLook),
      newBody('reflector-body', 'Reflector', 'reflector', presetLook('chrome')),
      newBody('bulb-body', 'Bulb', 'bulb', presetLook('lamp-white')),
      newBody(
        'inner-lens',
        'Inner lens',
        'inner-plate',
        presetLook(tail ? 'lamp-red' : 'lamp-lens'),
      ),
      newBody('cut-body', 'Lens cut', 'cut', presetLook('lamp-lens')),
      newBody(
        'outer-lens',
        'Outer lens',
        'lens-sheet',
        presetLook(tail ? 'lamp-red' : 'lamp-lens'),
      ),
    ],
  });
  // The housing: drafted from its back for a pull along +x, then hollowed with its front open.
  let on = 'housing-placement';
  const draftDeg = options.draftDeg ?? 2;
  const area = { x: width * height, y: depth * height, z: depth * width };
  if (draftDeg > 0) {
    doc = applyCadOperation(doc, {
      type: 'detailBody',
      bodyId: 'housing',
      placementFeatureId: 'housing-draft-placement',
      feature: {
        id: 'housing-draft',
        name: 'Housing draft',
        type: 'draft',
        inputFeatureIds: [on],
        args: {
          faces: [
            faceRef(on, ['+y'], [-depth / 2, width / 2, 0], area.y),
            faceRef(on, ['-y'], [-depth / 2, -width / 2, 0], area.y),
            faceRef(on, ['+z'], [-depth / 2, 0, height / 2], area.z),
            faceRef(on, ['-z'], [-depth / 2, 0, -height / 2], area.z),
          ],
          neutral: faceRef(on, ['-x'], [-depth, 0, 0], area.x),
          angle: { literalRad: (draftDeg * Math.PI) / 180 },
          direction: [1, 0, 0],
        },
      },
    });
    on = 'housing-draft-placement';
  }
  doc = applyCadOperation(doc, {
    type: 'detailBody',
    bodyId: 'housing',
    placementFeatureId: 'housing-shell-placement',
    feature: {
      id: 'housing-shell',
      name: 'Housing wall',
      type: 'shell',
      inputFeatureIds: [on],
      args: {
        openFaces: [faceRef(on, ['+x'], [0, 0, 0], area.x)],
        thickness: mm(2.5),
        side: 'inside',
      },
    },
  });
  // The lens cuts: a grid on the inner lens's front (CR6d rows).
  doc = applyCadOperation(doc, {
    type: 'patternBodies',
    targetId: 'inner-lens',
    toolId: 'cut-body',
    mode: 'union',
    patternFeatureId: 'lens-cuts',
    placementFeatureId: 'lens-cuts-placement',
    layout: {
      type: 'linear',
      direction: [0, 1, 0],
      count: { literal: s.cuts.count },
      spacing: mm(s.cuts.spacing),
      rows: { direction: [0, 0, 1], count: { literal: s.cuts.rows }, spacing: mm(s.cuts.spacing) },
    },
  });
  // The outer lens: the arc's sheet given the lens thickness, half each way.
  return applyCadOperation(doc, {
    type: 'detailBody',
    bodyId: 'outer-lens',
    placementFeatureId: 'outer-lens-thick-placement',
    feature: {
      id: 'outer-lens-thick',
      name: 'Outer lens',
      type: 'thicken',
      inputFeatureIds: ['outer-lens-placement'],
      args: { thickness: { parameterId: lampLensParameter }, side: 'both' },
    },
  });
}
