import { composePoses, identityPose, type CadSolvedPose } from './assembly';
import { f148Package } from './car-look-colour';
import { f82Rules } from './car-look-package';
import { fixtureKernel } from './fixtures';
import { invertPose, type CadConnector, type CadJoint } from './joints';
import { bodyPartContent } from './make-part';
import {
  identityQuaternion,
  position,
  type CadDocument,
  type CadKernelProfile,
  type Quaternion,
  type Vec3,
} from './model';
import { applyCadOperation, cadContentHash } from './operations';

type Kernel = Pick<CadKernelProfile, 'id' | 'buildHash'>;

/** The wheels' faces of F148 (one per wheel), each a part that turns about its axle. */
export const f149Wheels = Object.freeze([
  { key: 'front-right', axle: 'front', side: 1 },
  { key: 'front-left', axle: 'front', side: -1 },
  { key: 'rear-right', axle: 'rear', side: 1 },
  { key: 'rear-left', axle: 'rear', side: -1 },
] as const);

/** A wheel's centre: its axle's x, half the track out, the tyre's radius up. */
export function f149WheelCentre(w: (typeof f149Wheels)[number]): Vec3 {
  const r = f82Rules;
  const x = w.axle === 'front' ? 0 : r.wheelbase;
  const tyre = r.tyre[w.axle];
  return [x, (w.side * r.track[w.axle]) / 2, tyre.diameter / 2];
}

const s = Math.SQRT1_2;
/** z along +y: the axle. */
const alongY: Quaternion = [-s, 0, 0, s];
const connector = (at: CadSolvedPose): CadConnector => {
  const offset = composePoses(invertPose(identityPose()), at);
  return {
    componentPath: [],
    ref: { origin: true },
    flip: false,
    offset: { translation: position(...offset.translationMm), rotation: offset.rotation },
  };
};

/**
 * CL9d: F149 is F148 in the chosen scheme (紅, 2026-11-16) with each wheel's face made a part on
 * a revolute joint about its axle (`j-wheel-<key>`, angle), so a video can turn the spokes as the
 * car drives. The tyres stay plain cylinders in the car (turning them shows nothing).
 * Returns the assembly and the parts' contents by content hash.
 */
export function f149Car(kernel: Kernel = fixtureKernel) {
  let doc: CadDocument = f148Package('rosso', kernel);
  const closure = new Map<string, CadDocument>();
  const joints: CadJoint[] = [];
  for (const w of f149Wheels) {
    const bodyId = `wheel-${w.key}-rim-body`;
    const body = doc.bodies.find((b) => b.id === bodyId)!;
    const content = bodyPartContent(doc, bodyId);
    const hash = cadContentHash(content);
    closure.set(hash, content);
    const centre = f149WheelCentre(w);
    const tyre = f82Rules.tyre[w.axle];
    const R = tyre.diameter / 2;
    doc = applyCadOperation(doc, {
      type: 'makePart',
      bodyId,
      part: {
        id: `part-wheel-${w.key}`,
        name: body.name,
        source: {
          kind: 'version',
          artifactId: `f149-wheel-${w.key}`,
          versionId: 'v1',
          contentHash: hash,
        },
        hint: {
          boundsMm: [
            [centre[0] - R, centre[1] - tyre.width, centre[2] - R],
            [centre[0] + R, centre[1] + tyre.width, centre[2] + R],
          ],
        },
      },
      component: {
        id: `c-wheel-${w.key}`,
        name: body.name,
        partId: `part-wheel-${w.key}`,
        placement: { translation: position(0, 0, 0), rotation: identityQuaternion() },
        bom: 'include',
      },
    });
    const at: CadSolvedPose = { translationMm: centre, rotation: alongY };
    joints.push({
      id: `j-wheel-${w.key}`,
      name: `${body.name} axle`,
      type: 'revolute',
      parent: connector(at),
      child: { componentId: `c-wheel-${w.key}`, connector: connector(at) },
      values: { angle: { literalRad: 0 } },
      limits: [],
      // A wheel turns many times over a drive, so its angle is not held to one turn.
      continuous: true,
    });
  }
  for (const joint of joints) doc = applyCadOperation(doc, { type: 'insertJoint', joint });
  return { assembly: doc, closure };
}
