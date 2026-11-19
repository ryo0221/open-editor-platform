/**
 * DW7b fixture F137 (docs/cad/drawing-editor.md, 動力系): gear pairs of the e-Axle's kinds in
 * mesh, each gear a part version turned by a continuous revolute joint. `bevel`: a 17-tooth
 * pinion on +Z driving a 51-tooth ring on −X, shafts at 90° (pitch cones 18.43° and 71.57°, the
 * apexes at one point). `helical`: a 17-tooth right-hand pinion driving a 51-tooth left-hand gear
 * on parallel shafts (normal module 2, 20°).
 */
import { fixtureComponent, fixturePart, fixtureVersion } from './assembly-fixtures';
import { cadBuilder } from './builder';
import { fixtureKernel } from './fixtures';
import { applyGearMeshOperation, checkGearMesh, type CadGearMesh } from './gear-mesh';
import { helicalGear, spurGearRadii, type InvoluteGearSpec } from './gear';
import { parameterValues } from './graph';
import { fixtureConnector, fixtureJoint } from './joints-fixtures';
import { solveJoints } from './joints';
import { position, type CadDocument, type CadKernelProfile, type Quaternion } from './model';
import { assertCad } from './validation';

export const f137Module = 2;
const deg = (d: number) => (d * Math.PI) / 180;
/** Bevel pinion and ring teeth, and their pitch cone angles for shafts at 90°. */
export const f137Bevel = (() => {
  const [z1, z2] = [17, 51];
  const d1 = Math.atan(z1 / z2);
  return { z1, z2, cone1: d1, cone2: Math.PI / 2 - d1, faceWidth: 12 };
})();
export const f137Helical = { z1: 17, z2: 51, helix: deg(20), faceWidth: 20 };

type GearArgs = Parameters<ReturnType<typeof cadBuilder>['spurGear']>[1];
function gearPart(kernel: Pick<CadKernelProfile, 'id' | 'buildHash'>, name: string, a: GearArgs) {
  const b = cadBuilder(kernel);
  b.spurGear(name, a);
  return fixtureVersion(name.toLowerCase().replace(/ /g, '-'), 'v1', b.build().document);
}

export function f137GearPairs(kernel: Pick<CadKernelProfile, 'id' | 'buildHash'> = fixtureKernel) {
  const m = f137Module;
  const B = f137Bevel;
  const H = f137Helical;
  const versions = {
    pinion: gearPart(kernel, 'Bevel pinion', {
      module: m,
      teeth: B.z1,
      faceWidth: B.faceWidth,
      coneAngle: B.cone1,
      bore: 10,
    }),
    ring: gearPart(kernel, 'Ring gear', {
      module: m,
      teeth: B.z2,
      faceWidth: B.faceWidth,
      coneAngle: B.cone2,
      bore: 30,
    }),
    helicalPinion: gearPart(kernel, 'Helical pinion', {
      module: m,
      teeth: H.z1,
      faceWidth: H.faceWidth,
      helixAngle: H.helix,
      bore: 12,
    }),
    helicalGear: gearPart(kernel, 'Helical gear', {
      module: m,
      teeth: H.z2,
      faceWidth: H.faceWidth,
      helixAngle: -H.helix,
      bore: 30,
    }),
  };
  const doc: CadDocument = cadBuilder(kernel).build().document;
  const box: [[number, number, number], [number, number, number]] = [
    [-60, -60, 0],
    [60, 60, 25],
  ];
  doc.parts = [
    fixturePart('part-pinion', 'Bevel pinion', versions.pinion, box),
    fixturePart('part-ring', 'Ring gear', versions.ring, box),
    fixturePart('part-hpinion', 'Helical pinion', versions.helicalPinion, box),
    fixturePart('part-hgear', 'Helical gear', versions.helicalGear, box),
  ];
  doc.components = [
    ['c-pinion', 'part-pinion'],
    ['c-ring', 'part-ring'],
    ['c-hpinion', 'part-hpinion'],
    ['c-hgear', 'part-hgear'],
  ].map(([id, partId]) => ({ ...fixtureComponent(id!, partId!), placement: null }));
  const shaft = (id: string, componentId: string, at: [number, number, number], q: Quaternion) => ({
    ...fixtureJoint(
      id,
      'revolute',
      { ...fixtureConnector(), offset: { translation: position(...at), rotation: q } },
      componentId,
      fixtureConnector(),
      { angle: { literalRad: 0 } },
    ),
    continuous: true as const,
  });
  // The pinion's apex up its axis at r1 / tan δ1; the ring's back face that far back along −X.
  const r1 = (m * B.z1) / 2;
  const r2 = (m * B.z2) / 2;
  const apex = r1 / Math.tan(B.cone1);
  const back = r2 / Math.tan(B.cone2);
  const s = Math.SQRT1_2;
  const t = helicalGear(
    {
      module: m,
      teeth: H.z1,
      pressureAngle: deg(20),
      profileShift: 0,
      addendum: 1,
      dedendum: 1.25,
      bore: 0,
    } satisfies InvoluteGearSpec,
    H.helix,
  );
  const centre = spurGearRadii(t).pitch * (1 + H.z2 / H.z1);
  doc.joints = [
    shaft('j-pinion', 'c-pinion', [0, 0, 0], [0, 0, 0, 1]),
    // +Z turned onto −X: a quarter turn about −Y.
    shaft('j-ring', 'c-ring', [back, 0, apex], [0, -s, 0, s]),
    shaft('j-hpinion', 'c-hpinion', [0, 300, 0], [0, 0, 0, 1]),
    shaft('j-hgear', 'c-hgear', [centre, 300, 0], [0, 0, 0, 1]),
  ];
  const closure = new Map(Object.values(versions).map((v) => [v.contentHash, v.content] as const));
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
  const gearOf = (v: { content: CadDocument }) =>
    v.content.features.find((f) => f.type === 'spurGear')!.id;
  const meshes: CadGearMesh[] = [
    {
      id: 'mesh-bevel',
      name: 'Pinion → ring',
      driver: { joint: 'j-pinion', feature: gearOf(versions.pinion) },
      driven: { joint: 'j-ring', feature: gearOf(versions.ring) },
    },
    {
      id: 'mesh-helical',
      name: 'Helical pinion → gear',
      driver: { joint: 'j-hpinion', feature: gearOf(versions.helicalPinion) },
      driven: { joint: 'j-hgear', feature: gearOf(versions.helicalGear) },
    },
  ];
  for (const mesh of meshes) {
    const check = checkGearMesh(doc, mesh, solve(doc), lookup);
    if (check.status !== 'ok') throw new Error(`F137 ${mesh.id}: ${JSON.stringify(check)}`);
    const { ratio, offset } = check.coupling;
    applyGearMeshOperation(doc, { type: 'insertGearMesh', mesh, coupling: { ratio, offset } });
    doc.solvedPoses = solve(doc).poses;
  }
  assertCad(doc);
  return { assembly: doc, closure, lookup, solve, versions };
}
