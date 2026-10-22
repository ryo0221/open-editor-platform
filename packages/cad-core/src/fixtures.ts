import {
  emptyCad,
  identityQuaternion,
  mm,
  position,
  type CadDocument,
  type CadKernelProfile,
  type Length,
} from './model';
import { applyCadOperation, type CadNewBody } from './operations';

/** Placeholder evaluator identity for fixtures until the kernel gate pins a real build. */
export const fixtureKernel: Pick<CadKernelProfile, 'id' | 'buildHash'> = {
  id: 'fixture-kernel',
  buildHash: `sha256:${'0'.repeat(64)}`,
};
const grey = { color: '#9aa4b1', opacity: 1 };
const body = (id: string, sourceFeatureId: string): CadNewBody => ({
  id,
  name: id,
  sourceFeatureId,
  placementFeatureId: `${id}-placement`,
  appearance: grey,
});

/** F01: empty document. */
export const f01Empty = (): CadDocument => emptyCad(fixtureKernel);

/**
 * F02: 80×50×5 mm plate with an r=5 through-hole (tool extends 1 mm beyond each face),
 * hole centre y=25 and x bound by `holeX`: centre `0.5W`, edge `W−10`, or literal 40.
 * Result: active body `plate`, consumed body `hole`.
 */
export function f02Plate(holeX: 'center' | 'edge' | 'literal' = 'center'): CadDocument {
  const x: Length =
    holeX === 'center'
      ? { affine: { parameterId: 'W', scale: 0.5, offsetMm: 0 } }
      : holeX === 'edge'
        ? { affine: { parameterId: 'W', scale: 1, offsetMm: -10 } }
        : mm(40);
  let doc = applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    parameters: [
      { id: 'W', name: 'Width', type: 'length', value: 80 },
      { id: 'H', name: 'Depth', type: 'length', value: 50 },
      { id: 'T', name: 'Thickness', type: 'length', value: 5 },
    ],
    profiles: [
      {
        id: 'plate-profile',
        name: 'Plate outline',
        plane: { origin: position(0, 0, 0), orientation: identityQuaternion() },
        shape: { type: 'rectangle', width: { parameterId: 'W' }, height: { parameterId: 'H' } },
      },
    ],
    features: [
      {
        id: 'plate-extrude',
        name: 'Plate',
        type: 'extrude',
        inputFeatureIds: [],
        args: { profileId: 'plate-profile', distance: { parameterId: 'T' }, direction: 1 },
      },
      {
        id: 'hole-cylinder',
        name: 'Hole tool',
        type: 'cylinder',
        inputFeatureIds: [],
        args: {
          radius: mm(5),
          height: { affine: { parameterId: 'T', scale: 1, offsetMm: 2 } },
          origin: [x, mm(25), mm(-1)],
          orientation: identityQuaternion(),
        },
      },
    ],
    bodies: [body('plate', 'plate-extrude'), body('hole', 'hole-cylinder')],
  });
  doc = applyCadOperation(doc, {
    type: 'booleanBodies',
    targetId: 'plate',
    toolId: 'hole',
    mode: 'cut',
    booleanFeatureId: 'plate-cut',
    placementFeatureId: 'plate-cut-placement',
  });
  return doc;
}
export const f02Volume = (width: number) => width * 50 * 5 - Math.PI * 5 * 5 * 5;

/** F03: rectangle r∈[10,15], z∈[0,20] on the XZ plane revolved 2π about Z. Volume 2,500π mm³. */
export const f03Revolve = (): CadDocument =>
  applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    profiles: [
      {
        id: 'ring-profile',
        name: 'Ring section',
        // +90° about X maps plane u/v to world X/Z.
        plane: { origin: position(10, 0, 0), orientation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] },
        shape: { type: 'rectangle', width: mm(5), height: mm(20) },
      },
    ],
    features: [
      {
        id: 'ring-revolve',
        name: 'Ring',
        type: 'revolve',
        inputFeatureIds: [],
        args: {
          profileId: 'ring-profile',
          axisOrigin: [mm(-10), mm(0)],
          axisDirection: [0, 1],
          angle: { literalRad: 2 * Math.PI },
        },
      },
    ],
    bodies: [body('ring', 'ring-revolve')],
  });

/** F05: one parameter drives two profiles/features of two bodies, plus a transform chain of `chain` links. */
export function f05Dependencies(chain = 4): CadDocument {
  const links = Array.from({ length: chain }, (_, i) => ({
    id: `link-${i}`,
    name: `Link ${i}`,
    type: 'transform' as const,
    inputFeatureIds: [i ? `link-${i - 1}` : 'post-a'] as [string],
    args: { translation: position(0, 0, 1), rotation: identityQuaternion() },
  }));
  return applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    parameters: [{ id: 'S', name: 'Size', type: 'length', value: 10 }],
    profiles: ['a', 'b'].map((k, i) => ({
      id: `profile-${k}`,
      name: `Profile ${k}`,
      plane: { origin: position(i * 40, 0, 0), orientation: identityQuaternion() },
      shape: { type: 'circle' as const, radius: { parameterId: 'S' } },
    })),
    features: [
      {
        id: 'post-a',
        name: 'Post A',
        type: 'extrude',
        inputFeatureIds: [],
        args: { profileId: 'profile-a', distance: { parameterId: 'S' }, direction: 1 },
      },
      {
        id: 'post-b',
        name: 'Post B',
        type: 'extrude',
        inputFeatureIds: [],
        args: { profileId: 'profile-b', distance: mm(5), direction: 1 },
      },
      ...links,
    ],
    bodies: [body('a', chain ? `link-${chain - 1}` : 'post-a'), body('b', 'post-b')],
  });
}
