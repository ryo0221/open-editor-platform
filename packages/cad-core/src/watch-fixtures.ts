/**
 * WM2 fixture F70 (docs/cad/watch-design.md): a three-wheel watch train in mesh. The centre wheel
 * (80 teeth, m 0.1, cycloidal) drives the third wheel's 10-leaf pinion; the third wheel (75)
 * drives the fourth wheel's 10-leaf pinion: 8 × 7.5 = 60, so the fourth wheel turns once a minute
 * while the centre wheel turns once an hour. Each wheel is a part version (a wheel and its pinion
 * as two gears of one part), turned by a continuous revolute joint on this document's axes.
 */
import { fixtureComponent, fixturePart, fixtureVersion } from './assembly-fixtures';
import { cadBuilder } from './builder';
import { fixtureKernel } from './fixtures';
import { applyGearMeshOperation, checkGearMesh, type CadGearMesh } from './gear-mesh';
import { parameterValues } from './graph';
import { fixtureConnector, fixtureJoint } from './joints-fixtures';
import { solveJoints } from './joints';
import { position, type CadDocument, type CadKernelProfile } from './model';
import { assertCad } from './validation';

export const f70Module = 0.1;
/**
 * W1: a pinion leaf is 0.4 of the circular pitch thick (the wheel tooth 0.5), as watch pinions
 * are, so the pair has backlash: with both at 0.5 the flanks touch and the display meshes, a
 * chord off the exact flank, overlap.
 */
export const f70PinionLeaf = 0.4;
const pinionLeaf = f70PinionLeaf;
const m = f70Module;
/** Arbor positions on the plate (mm): centre, third, fourth. */
export const f70Arbors = (() => {
  const third: [number, number] = [(m * (80 + 10)) / 2, 0];
  const d = (m * (75 + 10)) / 2;
  const fourth: [number, number] = [third[0] + d / 2, (d * Math.sqrt(3)) / 2];
  return { centre: [0, 0] as [number, number], third, fourth };
})();

function wheel(
  kernel: Pick<CadKernelProfile, 'id' | 'buildHash'>,
  name: string,
  gears: {
    name: string;
    teeth: number;
    mating: number;
    z: number;
    width: number;
    thickness?: number;
  }[],
) {
  const b = cadBuilder(kernel);
  for (const g of gears)
    b.spurGear(g.name, {
      profile: 'cycloidal',
      module: m,
      teeth: g.teeth,
      matingTeeth: g.mating,
      ...(g.thickness !== undefined ? { toothThickness: g.thickness } : {}),
      faceWidth: g.width,
      bore: 0.2,
      origin: [0, 0, g.z],
      ...(g.teeth >= 40 ? { spokes: { count: 5, rim: 0.4, hub: 0.4, width: 0.3 } } : {}),
    });
  return fixtureVersion(name, 'v1', b.build().document);
}
/** The `spurGear` feature of a part version by its body's name. */
const gearOf = (doc: CadDocument, name: string) =>
  doc.features.find((f) => f.type === 'spurGear' && f.name === name)!.id;

export function f70GearTrain(kernel: Pick<CadKernelProfile, 'id' | 'buildHash'> = fixtureKernel) {
  const centre = wheel(kernel, 'centre-wheel', [
    { name: 'Centre wheel', teeth: 80, mating: 10, z: 0, width: 0.3 },
  ]);
  const third = wheel(kernel, 'third-wheel', [
    { name: 'Third pinion', teeth: 10, mating: 80, z: 0, width: 0.5, thickness: pinionLeaf },
    { name: 'Third wheel', teeth: 75, mating: 10, z: 0.5, width: 0.3 },
  ]);
  const fourth = wheel(kernel, 'fourth-wheel', [
    { name: 'Fourth pinion', teeth: 10, mating: 75, z: 0, width: 1.0, thickness: pinionLeaf },
  ]);
  const doc: CadDocument = cadBuilder(kernel).build().document;
  doc.parts = [
    fixturePart('part-centre', 'Centre wheel', centre, [
      [-4.2, -4.2, 0],
      [4.2, 4.2, 0.3],
    ]),
    fixturePart('part-third', 'Third wheel', third, [
      [-3.9, -3.9, 0],
      [3.9, 3.9, 0.8],
    ]),
    fixturePart('part-fourth', 'Fourth wheel', fourth, [
      [-0.7, -0.7, 0],
      [0.7, 0.7, 1],
    ]),
  ];
  const free = (id: string, partId: string) => ({
    ...fixtureComponent(id, partId),
    placement: null,
  });
  doc.components = [
    free('c-centre', 'part-centre'),
    free('c-third', 'part-third'),
    free('c-fourth', 'part-fourth'),
  ];
  const arbor = (id: string, componentId: string, at: [number, number], z: number) => ({
    ...fixtureJoint(
      id,
      'revolute',
      {
        ...fixtureConnector(),
        offset: { translation: position(at[0], at[1], z), rotation: [0, 0, 0, 1] },
      },
      componentId,
      fixtureConnector(),
      { angle: { literalRad: 0 } },
    ),
    continuous: true as const,
  });
  // The centre wheel sits level with the third pinion; the third wheel with the fourth pinion.
  doc.joints = [
    arbor('j-centre', 'c-centre', f70Arbors.centre, 0),
    arbor('j-third', 'c-third', f70Arbors.third, 0),
    arbor('j-fourth', 'c-fourth', f70Arbors.fourth, 0.4),
  ];
  const closure = new Map([centre, third, fourth].map((v) => [v.contentHash, v.content] as const));
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
  const meshes: CadGearMesh[] = [
    {
      id: 'mesh-centre-third',
      name: 'Centre → third',
      driver: { joint: 'j-centre', feature: gearOf(centre.content, 'Centre wheel') },
      driven: { joint: 'j-third', feature: gearOf(third.content, 'Third pinion') },
    },
    {
      id: 'mesh-third-fourth',
      name: 'Third → fourth',
      driver: { joint: 'j-third', feature: gearOf(third.content, 'Third wheel') },
      driven: { joint: 'j-fourth', feature: gearOf(fourth.content, 'Fourth pinion') },
    },
  ];
  for (const mesh of meshes) {
    const check = checkGearMesh(doc, mesh, solve(doc), lookup);
    if (check.status !== 'ok') throw new Error(`F70 ${mesh.id}: ${JSON.stringify(check)}`);
    const { ratio, offset } = check.coupling;
    applyGearMeshOperation(doc, { type: 'insertGearMesh', mesh, coupling: { ratio, offset } });
    doc.solvedPoses = solve(doc).poses;
  }
  assertCad(doc);
  return { assembly: doc, closure, lookup, solve, versions: { centre, third, fourth } };
}
