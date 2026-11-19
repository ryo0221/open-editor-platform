/**
 * F156 (docs/cad/product-design.md, PD6): three watch hands on one arbor over a dial, and a pin
 * the second hand sweeps into once a turn. The minute hand follows the hour hand × 12 and the
 * second hand × 720 (MR1 couplings), so 12 hours split evenly into 48 samples put the second
 * hand at the same angle every time and never meet the pin. Content and box meshes only: no
 * kernel geometry is asserted here.
 */
import { fixtureComponent, fixturePart, fixtureVersion } from './assembly-fixtures';
import { fixtureKernel } from './fixtures';
import { parameterValues } from './graph';
import type { CadInterferenceMesh } from './interference';
import { solveJoints, type CadJoint } from './joints';
import {
  emptyCad,
  identityQuaternion,
  mm,
  position,
  type CadDocument,
  type CadKernelProfile,
  type Vec3,
} from './model';
import { applyCadOperation } from './operations';

/** A closed box mesh from the origin to `size` (each face an 8 × 8 grid). */
function boxMesh(bodyId: string, size: Vec3): CadInterferenceMesh[] {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let axis = 0; axis < 3; axis++)
    for (const side of [0, 1]) {
      const u = (axis + 1) % 3;
      const v = (axis + 2) % 3;
      const n = 8;
      const base = positions.length / 3;
      for (let i = 0; i <= n; i++)
        for (let j = 0; j <= n; j++) {
          const p = [0, 0, 0];
          p[axis] = side ? size[axis] : 0;
          p[u] = (size[u]! * i) / n;
          p[v] = (size[v]! * j) / n;
          positions.push(...p);
        }
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++) {
          const a = base + i * (n + 1) + j;
          const b = a + n + 1;
          if (side) indices.push(a, b, b + 1, a, b + 1, a + 1);
          else indices.push(a, b + 1, b, a, a + 1, b + 1);
        }
    }
  return [
    {
      bodyId,
      origin: [0, 0, 0],
      positions: Float32Array.from(positions),
      indices: Uint32Array.from(indices),
    },
  ];
}

/** A box from its origin to `size` (W × H × T mm, an extruded rectangle), a version of its own. */
function plateOf(id: string, size: Vec3, kernel: Pick<CadKernelProfile, 'id' | 'buildHash'>) {
  const [W, H, T] = size;
  const doc = applyCadOperation(emptyCad(kernel), {
    type: 'insertFeatures',
    profiles: [
      {
        id: 'box-profile',
        name: 'Outline',
        plane: { origin: position(0, 0, 0), orientation: identityQuaternion() },
        shape: { type: 'rectangle', width: mm(W), height: mm(H) },
      },
    ],
    features: [
      {
        id: 'box-extrude',
        name: id,
        type: 'extrude',
        inputFeatureIds: [],
        args: { profileId: 'box-profile', distance: mm(T), direction: 1 },
      },
    ],
    bodies: [
      {
        id: 'box',
        name: id,
        sourceFeatureId: 'box-extrude',
        placementFeatureId: 'box-placement',
        appearance: { color: '#9aa4b1', opacity: 1 },
      },
    ],
  });
  return { version: fixtureVersion(id, 'v1', doc), mesh: boxMesh('box', size) };
}

/** Hand lengths, the width they share and the height each lies at (mm). */
export const f156Hands = Object.freeze({
  hour: { length: 8, z: 1.2 },
  minute: { length: 12, z: 1.6 },
  second: { length: 16, z: 2.0 },
  width: 1,
  thickness: 0.3,
});

/**
 * Joints `hour-arbor` (the driver), `minute-arbor` and `second-arbor`. The dial (40 × 40 × 1 mm, centred on the arbor at the origin), the hands on continuous
 * revolute joints about z through the arbor (0 rad points along +x), and a 2 × 2 × 1.5 mm pin at
 * x −1…1, y 13.5…15.5, z 1.5…3: only the second hand (z 2.0–2.3, 16 mm long) reaches it, near
 * 90°.
 */
export function f156HandsOnDial(
  kernel: Pick<CadKernelProfile, 'id' | 'buildHash'> = fixtureKernel,
) {
  const dial = plateOf('dial', [40, 40, 1], kernel);
  const pin = plateOf('pin', [2, 2, 1.5], kernel);
  const hands = (['hour', 'minute', 'second'] as const).map((k) => ({
    k,
    ...plateOf(k, [f156Hands[k].length, f156Hands.width, f156Hands.thickness], kernel),
  }));
  let doc = emptyCad(kernel);
  doc = applyCadOperation(doc, {
    type: 'insertComponents',
    parts: [
      fixturePart('p-dial', 'Dial', dial.version),
      fixturePart('p-pin', 'Pin', pin.version),
      ...hands.map((h) => fixturePart(`p-${h.k}`, `${h.k} hand`, h.version)),
    ],
    components: [
      fixtureComponent('dial', 'p-dial', [-20, -20, 0]),
      fixtureComponent('pin', 'p-pin', [-1, 13.5, 1.5]),
      ...hands.map((h) => fixtureComponent(h.k, `p-${h.k}`, [0, -0.5, f156Hands[h.k].z])),
    ],
  });
  const ratio = { hour: 1, minute: 12, second: 720 } as const;
  for (const h of hands) {
    const joint: CadJoint = {
      id: `${h.k}-arbor`,
      name: `${h.k} arbor`,
      type: 'revolute',
      continuous: true,
      parent: {
        componentPath: ['dial'],
        ref: { origin: true },
        flip: false,
        offset: { translation: position(20, 20, f156Hands[h.k].z), rotation: identityQuaternion() },
      },
      child: {
        componentId: h.k,
        connector: {
          componentPath: [],
          ref: { origin: true },
          flip: false,
          offset: {
            translation: position(0, f156Hands.width / 2, 0),
            rotation: identityQuaternion(),
          },
        },
      },
      values: h.k === 'hour' ? { angle: { literalRad: 0 } } : {},
      limits: [],
      ...(h.k === 'hour'
        ? {}
        : {
            couplings: [
              {
                of: 'angle' as const,
                from: { joint: 'hour-arbor', of: 'angle' as const },
                ratio: ratio[h.k],
                offset: 0,
              },
            ],
          }),
    };
    doc = applyCadOperation(doc, { type: 'insertJoint', joint });
  }
  const versions = [dial, pin, ...hands];
  const closure = new Map<string, CadDocument>(
    versions.map((v) => [v.version.contentHash, v.version.content]),
  );
  const meshes = new Map(versions.map((v) => [v.version.contentHash, v.mesh]));
  const lookup = (hash: string) => closure.get(hash);
  const { joints, mismatch } = solveJoints(
    doc,
    parameterValues(doc),
    lookup,
    () => undefined,
    () => true,
  );
  if (mismatch.length) throw new Error(`F156 joints: ${mismatch.join(', ')}`);
  return {
    doc,
    closure,
    lookup,
    joints,
    meshesOf: (hash: string) => meshes.get(hash),
    hashOf: Object.fromEntries(versions.map((v) => [v.version.artifactId, v.version.contentHash])),
  };
}
