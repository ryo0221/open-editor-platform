/**
 * R2b-2 fixture F20 (docs/cad/r2b-assembly.md, Fixtureと受け入れscenario), the part of it
 * R2b-2a covers: this document's own plate (F02) as the base, the R2b-1 plate, shaft and pair
 * versions, and one joint of each type. The shaft turns on the base plate's top face (revolute,
 * by parameter `A`), a plate slides up the shaft, a third plate is fastened to it with an offset,
 * plate 1 moves on the assembly's origin plane (planar) and the pair sub-assembly rides on plate
 * 1 by its inner plate `pair-b` (cylindrical). Poses are solved from the analytic frames below,
 * which a kernel must reproduce within the stored-pose residuals.
 */
import { identityPose, type CadSolvedPose } from './assembly';
import { fixtureComponent, fixturePart, r2bParts } from './assembly-fixtures';
import { fixtureKernel } from './fixtures';
import { parameterValues } from './graph';
import {
  connectorRefKey,
  solveJoints,
  type CadConnector,
  type CadConnectorFrame,
  type CadJoint,
} from './joints';
import { f02Plate } from './fixtures';
import { identityQuaternion, mm, position, type CadDocument, type CadKernelProfile } from './model';
import { cadContentHash } from './operations';
import { assertCad } from './validation';
import type { CadTopologyRef } from './topology';

/** The base plate's top face (z = 5, outward +z) on its result. */
export const f20TopFace: CadTopologyRef = {
  kind: 'face',
  featureId: 'plate-cut-placement',
  name: [['end']],
  hint: { centroid: [40, 25, 5], normal: [0, 0, 1], size: 80 * 50 - 25 * Math.PI },
};
/** Its frame: the face's centroid (the hole is centred) with the world axes (x = X on a Z face). */
export const f20TopFrame: CadSolvedPose = { translationMm: [40, 25, 5], rotation: [0, 0, 0, 1] };

/** An origin connector on `componentPath` (this document's origin when empty). */
export const fixtureConnector = (componentPath: string[] = [], flip = false): CadConnector => ({
  componentPath,
  ref: { origin: true },
  flip,
  offset: { translation: position(0, 0, 0), rotation: identityQuaternion() },
});
export const fixtureJoint = (
  id: string,
  type: CadJoint['type'],
  parent: CadConnector,
  componentId: string,
  connector: CadConnector,
  values: CadJoint['values'] = {},
  limits: CadJoint['limits'] = [],
): CadJoint => ({ id, name: id, type, parent, child: { componentId, connector }, values, limits });

export function r2bJoints(kernel: Pick<CadKernelProfile, 'id' | 'buildHash'> = fixtureKernel) {
  const parts = r2bParts(kernel);
  const { plate, shaft, pair, closure } = parts;
  const doc: CadDocument = structuredClone(f02Plate());
  doc.kernelProfile = { ...doc.kernelProfile, ...kernel };
  doc.parameters.push({ id: 'A', name: 'Arm angle', type: 'angle', value: Math.PI / 6 });
  doc.parts = [
    fixturePart('part-plate', 'Plate', plate),
    fixturePart('part-shaft', 'Shaft', shaft, [
      [-15, -15, 0],
      [15, 15, 20],
    ]),
    fixturePart('part-pair', 'Pair', pair, [
      [0, 0, 0],
      [80, 50, 25],
    ]),
  ];
  const free = (id: string, partId: string) => ({
    ...fixtureComponent(id, partId),
    placement: null,
  });
  doc.components = [
    free('c-shaft', 'part-shaft'),
    free('c-plate-1', 'part-plate'),
    free('c-plate-2', 'part-plate'),
    free('c-plate-3', 'part-plate'),
    free('c-pair', 'part-pair'),
  ];
  doc.joints = [
    fixtureJoint(
      'j-turn',
      'revolute',
      { ...fixtureConnector(), ref: f20TopFace },
      'c-shaft',
      fixtureConnector(),
      { angle: { parameterId: 'A' } },
      [{ of: 'angle', min: -Math.PI, max: Math.PI }],
    ),
    fixtureJoint(
      'j-slide',
      'slider',
      fixtureConnector(['c-shaft']),
      'c-plate-2',
      fixtureConnector(),
      { distance: mm(12) },
      [{ of: 'distance', min: 0, max: 20 }],
    ),
    fixtureJoint(
      'j-fasten',
      'fastened',
      {
        ...fixtureConnector(['c-plate-2']),
        offset: { translation: position(0, 0, 5), rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] },
      },
      'c-plate-3',
      fixtureConnector(),
    ),
    fixtureJoint('j-plane', 'planar', fixtureConnector(), 'c-plate-1', fixtureConnector(), {
      u: mm(-120),
      v: mm(10),
      angle: { literalRad: Math.PI / 2 },
    }),
    // The pair is placed by its inner plate `pair-b` (z = 20 inside it), flipped onto plate 1.
    fixtureJoint(
      'j-ride',
      'cylindrical',
      fixtureConnector(['c-plate-1']),
      'c-pair',
      fixtureConnector(['pair-b'], true),
      {
        distance: mm(5),
        angle: { literalRad: 0 },
      },
    ),
  ];
  doc.solvedPoses = Object.fromEntries(doc.components.map((c) => [c.id, identityPose()]));
  const frames = f20Frames();
  const solved = solveJoints(
    doc,
    parameterValues(doc),
    (h) => closure.get(h),
    (at, ref) => frames.get(`${at} ${connectorRefKey(ref)}`),
    () => true,
  );
  doc.solvedPoses = solved.poses;
  assertCad(doc);
  return { ...parts, assembly: doc, frames, hash: cadContentHash(doc) };
}
/** Analytic connector frames by `<'own' | content hash> <connectorRefKey>`. */
export function f20Frames() {
  return new Map<string, CadConnectorFrame>([
    [`own ${connectorRefKey(f20TopFace)}`, { status: 'resolved', frame: f20TopFrame }],
  ]);
}
