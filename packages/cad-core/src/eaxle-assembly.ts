/**
 * DW7d fixture F130 (docs/cad/drawing-editor.md, 動力系): the e-Axle assembled from the F131–F135
 * parts. The frame is the reducer case's: the input axis (the motor's) is +Z through the origin,
 * the counter and output axes along +X. The input gear shaft turns on a continuous revolute
 * joint (the motor's speed), the counter and final gears are driven through gear meshes, and
 * everything else is fastened: the rotor and its magnets to the input shaft, the differential
 * (case, gears, pinion shaft) and both drive shafts to the final gear, the motor and inverter
 * to the case. Bearings and the seal are fastened to their seats.
 */
import { fixtureComponent, fixturePart, fixtureVersion } from './assembly-fixtures';
import { cadBuilder } from './builder';
import {
  eaxleBevelCone,
  eaxleGears,
  eaxleLayout,
  eaxleParts,
  eaxlePitchRadius,
} from './eaxle-parts';
import { fixtureKernel } from './fixtures';
import { applyGearMeshOperation, checkGearMesh, type CadGearMesh } from './gear-mesh';
import { parameterValues } from './graph';
import { fixtureConnector, fixtureJoint } from './joints-fixtures';
import { solveJoints, type CadConnector } from './joints';
import { position, type CadDocument, type CadKernelProfile, type Quaternion } from './model';
import { assertCad } from './validation';

type V3 = [number, number, number];
const s = Math.SQRT1_2;
/** Quarter and half turns used to place parts (x, y, z, w). */
const turn = {
  none: [0, 0, 0, 1] as Quaternion,
  /** +Z → −Z about Y (the motor faces the case). */
  flipY: [0, 1, 0, 0] as Quaternion,
  /** +Z → −Z about X. */
  flipX: [1, 0, 0, 0] as Quaternion,
  /** +Z → +X and +Z → −X. */
  toX: [0, s, 0, s] as Quaternion,
  toMinusX: [0, -s, 0, s] as Quaternion,
  /** +Z → +Y (−90° about X). */
  toY: [-s, 0, 0, s] as Quaternion,
};
const aboutZ = (a: number): Quaternion => [0, 0, Math.sin(a / 2), Math.cos(a / 2)];

/** Rough part bounds (mm, part frame) for the views that fit them before evaluating. */
const bounds: Record<string, [V3, V3]> = {
  'motor-housing': [
    [-142, -142, 0],
    [142, 142, 235],
  ],
  'motor-cover': [
    [-122, -122, -5],
    [122, 122, 20],
  ],
  'motor-stator': [
    [-110, -110, 12],
    [110, 110, 208],
  ],
  'motor-rotor': [
    [-69, -69, -50],
    [69, 69, 235],
  ],
  magnet: [
    [0, 0, 0],
    [6, 26, 158],
  ],
  'case-left': [
    [-61, -102, -8],
    [275, 102, 36],
  ],
  'case-right': [
    [-61, -102, 36],
    [275, 102, 90],
  ],
  'drive-shaft': [
    [-48, -48, -40],
    [48, 48, 600],
  ],
  'inverter-case': [
    [-130, -102, -18],
    [130, 102, 80],
  ],
  'inverter-lid': [
    [-130, -90, 80],
    [130, 90, 86],
  ],
};
const defaultBounds: [V3, V3] = [
  [-80, -80, -60],
  [80, 80, 90],
];

export function f130Eaxle(kernel: Pick<CadKernelProfile, 'id' | 'buildHash'> = fixtureKernel) {
  const parts = eaxleParts(kernel);
  const versions = new Map(
    parts.map((p) => [p.key, fixtureVersion(`eaxle-${p.key}`, 'v1', p.content)]),
  );
  const doc: CadDocument = cadBuilder(kernel).build().document;
  doc.parts = parts.map((p) =>
    fixturePart(`part-${p.key}`, p.name, versions.get(p.key)!, bounds[p.key] ?? defaultBounds),
  );
  const L = eaxleLayout;
  const G = eaxleGears;
  const comps: CadDocument['components'] = [];
  const joints: CadDocument['joints'] = [];
  const name = (key: string) => parts.find((p) => p.key === key)!.name;
  /** A component placed in the case's frame (it does not move). */
  const fixed = (id: string, key: string, at: V3 = [0, 0, 0], q = turn.none) =>
    comps.push({ ...fixtureComponent(id, `part-${key}`, at, q), name: name(key) });
  const at = (path: string[], t: V3, q = turn.none): CadConnector => ({
    ...fixtureConnector(path),
    offset: { translation: position(...t), rotation: q },
  });
  /** A component fastened to `host` (a component id, or the case's frame when empty). */
  const fasten = (id: string, key: string, host: string, t: V3, q = turn.none, label?: string) => {
    comps.push({
      ...fixtureComponent(id, `part-${key}`),
      name: label ?? name(key),
      placement: null,
    });
    joints.push({
      ...fixtureJoint(
        `j-${id.slice(2)}`,
        'fastened',
        at(host ? [host] : [], t, q),
        id,
        fixtureConnector(),
      ),
      name: `${label ?? name(key)} fastened`,
    });
  };
  const turning = (id: string, key: string, t: V3, label: string) => {
    comps.push({ ...fixtureComponent(id, `part-${key}`), name: name(key), placement: null });
    joints.push({
      ...fixtureJoint(`j-${id.slice(2)}`, 'revolute', at([], t), id, fixtureConnector(), {
        angle: { literalRad: 0 },
      }),
      name: label,
      continuous: true as const,
    });
  };

  // ---- F132 reducer ----
  fixed('c-case-left', 'case-left');
  fixed('c-case-right', 'case-right');
  turning('c-input', 'input-gear', [0, 0, 0], 'Input shaft');
  turning('c-counter', 'counter-gear', [L.counterX, 0, 0], 'Counter shaft');
  turning('c-final', 'final-gear', [L.outputX, 0, 0], 'Final gear');
  const bearing = (id: string, code: string, x: number, z: number) =>
    fasten(id, `bearing-${code}`, '', [x, 0, z], turn.none);
  bearing('c-brg-input-l', '6206', 0, -6);
  bearing('c-brg-input-r', '6206', 0, 72);
  bearing('c-brg-counter-l', '6207', L.counterX, -7);
  bearing('c-brg-counter-r', '6207', L.counterX, 72);
  bearing('c-brg-output-l', '6210', L.outputX, -10);
  bearing('c-brg-output-r', '6210', L.outputX, 72);

  // ---- F133 differential: on the final gear, its centre at z = diffZ ----
  fasten('c-diff', 'diff-case', 'c-final', [0, 0, L.diffZ]);
  // The side gears' and pinions' apexes at the case centre: a gear's back face sits r / tan δ out.
  const sideCone = eaxleBevelCone(G.side.teeth, G.diffPinion.teeth);
  const sideBack = (G.side.module * G.side.teeth) / 2 / Math.tan(sideCone);
  const pinionBack =
    (G.diffPinion.module * G.diffPinion.teeth) / 2 / Math.tan(Math.PI / 2 - sideCone);
  fasten('c-side-r', 'side-gear', 'c-diff', [0, 0, sideBack], turn.flipX, 'Side gear (right)');
  fasten('c-side-l', 'side-gear', 'c-diff', [0, 0, -sideBack], turn.none, 'Side gear (left)');
  fasten(
    'c-pinion-a',
    'diff-pinion',
    'c-diff',
    [pinionBack, 0, 0],
    turn.toMinusX,
    'Differential pinion',
  );
  fasten(
    'c-pinion-b',
    'diff-pinion',
    'c-diff',
    [-pinionBack, 0, 0],
    turn.toX,
    'Differential pinion',
  );
  fasten('c-pinion-shaft', 'pinion-shaft', 'c-diff', [0, 0, 0], turn.toX);

  // ---- F134 drive shafts: their splines in the side gears, out along ±Z ----
  fasten('c-shaft-r', 'drive-shaft', 'c-diff', [0, 0, 60], turn.none, 'Drive shaft (right)');
  fasten('c-shaft-l', 'drive-shaft', 'c-diff', [0, 0, -60], turn.flipX, 'Drive shaft (left)');

  // ---- F131 motor: turned to face the case, its shaft end 2 mm from the input shaft ----
  const motorZ = -82;
  fixed('c-motor', 'motor-housing', [0, 0, motorZ], turn.flipY);
  fasten('c-motor-cover', 'motor-cover', 'c-motor', [0, 0, 0]);
  fasten('c-stator', 'motor-stator', 'c-motor', [0, 0, 0]);
  fasten('c-brg-motor-f', 'bearing-6208', 'c-motor', [0, 0, 1]);
  fasten('c-brg-motor-r', 'bearing-6208', 'c-motor', [0, 0, 210]);
  fasten('c-seal', 'seal-40', 'c-motor', [0, 0, -5]);
  // The rotor turns with the input shaft (a coupling across the 2 mm gap).
  fasten('c-rotor', 'motor-rotor', 'c-input', [0, 0, motorZ], turn.flipY);
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    const [x, y] = [56.1, -12.9];
    fasten(
      `c-magnet-${k + 1}`,
      'magnet',
      'c-rotor',
      [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a), 31.1],
      aboutZ(a),
    );
  }

  // ---- F135 inverter: on top of the motor, its fins down ----
  fixed('c-inverter', 'inverter-case', [0, 152, motorZ - 117], turn.toY);
  fasten('c-inverter-lid', 'inverter-lid', 'c-inverter', [0, 0, 0]);
  [-40, 0, 40].forEach((x, i) =>
    fasten(`c-terminal-${i + 1}`, 'terminal', 'c-inverter', [x, 92, 40], turn.toY),
  );

  doc.components = comps;
  doc.joints = joints;
  const closure = new Map([...versions.values()].map((v) => [v.contentHash, v.content] as const));
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
  const gearOf = (key: string, gear: string) =>
    versions.get(key)!.content.features.find((f) => f.type === 'spurGear' && f.name === gear)!.id;
  const meshes: CadGearMesh[] = [
    {
      id: 'mesh-input-counter',
      name: 'Input → counter',
      driver: { joint: 'j-input', feature: gearOf('input-gear', 'Input gear') },
      driven: { joint: 'j-counter', feature: gearOf('counter-gear', 'Counter gear') },
    },
    {
      id: 'mesh-pinion-final',
      name: 'Final pinion → final gear',
      driver: { joint: 'j-counter', feature: gearOf('counter-gear', 'Final pinion') },
      driven: { joint: 'j-final', feature: gearOf('final-gear', 'Final gear') },
    },
  ];
  for (const mesh of meshes) {
    const check = checkGearMesh(doc, mesh, solve(doc), lookup);
    if (check.status !== 'ok') throw new Error(`F130 ${mesh.id}: ${JSON.stringify(check)}`);
    const { ratio, offset } = check.coupling;
    applyGearMeshOperation(doc, { type: 'insertGearMesh', mesh, coupling: { ratio, offset } });
    doc.solvedPoses = solve(doc).poses;
  }
  assertCad(doc);
  return { parts, versions, assembly: doc, closure, lookup, solve, pitch: eaxlePitchRadius };
}
