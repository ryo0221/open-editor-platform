import {
  applyCadOperation,
  f01Empty,
  identityQuaternion,
  mm,
  position,
  type CadDocument,
} from '@editor-platform/cad-core';
import type { SurfaceMeshInput } from './surface';

const grey = { color: '#9aa4b1', opacity: 1 };

/**
 * The CAD documents of the known solutions FX2 and FX3 (docs/cad/r3-analysis.md, 既知解のfixture),
 * made by script as the design asks, and helpers to find their faces on an analysis surface. Test
 * only: not exported from the package.
 */
/** FX2 1/8: 100 × 200 × 1 mm (half width, half length, half thickness), quarter hole r 10 at 0. */
export const fx2 = (): CadDocument => {
  let doc = applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    parameters: [],
    profiles: [
      {
        id: 'p',
        name: 'p',
        plane: { origin: position(0, 0, 0), orientation: identityQuaternion() },
        shape: { type: 'rectangle', width: mm(100), height: mm(200) },
      },
    ],
    features: [
      {
        id: 'x',
        name: 'x',
        type: 'extrude',
        inputFeatureIds: [],
        args: { profileId: 'p', distance: mm(1), direction: 1 },
      },
      {
        id: 'c',
        name: 'c',
        type: 'cylinder',
        inputFeatureIds: [],
        args: {
          radius: mm(10),
          height: mm(3),
          origin: [mm(0), mm(0), mm(-1)],
          orientation: identityQuaternion(),
        },
      },
    ],
    bodies: [
      {
        id: 'plate',
        name: 'plate',
        sourceFeatureId: 'x',
        placementFeatureId: 'plate-pl',
        appearance: grey,
      },
      {
        id: 'hole',
        name: 'hole',
        sourceFeatureId: 'c',
        placementFeatureId: 'hole-pl',
        appearance: grey,
      },
    ],
  });
  doc = applyCadOperation(doc, {
    type: 'booleanBodies',
    targetId: 'plate',
    toolId: 'hole',
    mode: 'cut',
    booleanFeatureId: 'cut',
    placementFeatureId: 'cut-pl',
  });
  return doc;
};

/** Faces whose triangles all lie on axis = value. */
export const facesOn = (s: SurfaceMeshInput, axis: number, value: number) => {
  const all = new Map<number, boolean>();
  for (let t = 0; t < s.faces.length; t++) {
    const on = [0, 1, 2].every(
      (j) => Math.abs(s.points[3 * s.triangles[3 * t + j]! + axis]! - value) < 1e-6,
    );
    all.set(s.faces[t]!, (all.get(s.faces[t]!) ?? true) && on);
  }
  return [...all].filter(([, on]) => on).map(([f]) => f);
};
/** Faces whose triangles all lie at radius r from the z axis. */
export const facesAtRadius = (s: SurfaceMeshInput, r: number) => {
  const all = new Map<number, boolean>();
  for (let t = 0; t < s.faces.length; t++) {
    const on = [0, 1, 2].every((j) => {
      const p = 3 * s.triangles[3 * t + j]!;
      return Math.abs(Math.hypot(s.points[p]!, s.points[p + 1]!) - r) < 1e-6;
    });
    all.set(s.faces[t]!, (all.get(s.faces[t]!) ?? true) && on);
  }
  return [...all].filter(([, on]) => on).map(([f]) => f);
};

/** FX3 1/4: r 50–100, z 0–20, revolved π/2 about z. */
export const fx3 = (): CadDocument =>
  applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    profiles: [
      {
        id: 'p',
        name: 'p',
        plane: { origin: position(50, 0, 0), orientation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] },
        shape: { type: 'rectangle', width: mm(50), height: mm(20) },
      },
    ],
    features: [
      {
        id: 'r',
        name: 'r',
        type: 'revolve',
        inputFeatureIds: [],
        args: {
          profileId: 'p',
          axisOrigin: [mm(-50), mm(0)],
          axisDirection: [0, 1],
          angle: { literalRad: Math.PI / 2 },
        },
      },
    ],
    bodies: [
      {
        id: 'tube',
        name: 'tube',
        sourceFeatureId: 'r',
        placementFeatureId: 'tube-pl',
        appearance: grey,
      },
    ],
  });
