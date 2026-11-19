import { topologyRefOf, type CadDocument, type CadTopologyTable } from '@editor-platform/cad-core';
import type { FemMesh } from '@editor-platform/geometry-fem';
import {
  emptySimulation,
  simulationMaterialPresets,
  transientStudy,
  type SimulationAmplitude,
  type SimulationDocument,
  type SimulationTarget,
  type SimulationTransientStudy,
} from '@editor-platform/simulation-core';
import { brakeAir, kmh, stillFilm } from './brake';

/**
 * VS12b (docs/cad/vehicle-simulation.md, VS12): the exhaust's heat into the floor and the fuel
 * tank. The pipe is held at the gas temperature; it radiates to the floor (and the shield, when
 * there is one) through `enclosure` radiation from its top and sides, the air under the car cools floor and shield, and
 * the floor conducts into the tank standing on it. Units mm–t–s, K.
 */

/** Air's Prandtl number near 300 K. */
const prandtl = 0.71;

/**
 * A flat plate's mean film coefficient (mW/(mm²·K)) in air at `speed` (mm/s) over `length` (mm):
 * Nu = 0.664 Re^½ Pr^⅓ laminar (Re < 5 × 10⁵), 0.037 Re^0.8 Pr^⅓ turbulent from the edge
 * (Incropera, §7.2); never below still air's `stillFilm`.
 */
export function plateFilm(speed: number, length: number): number {
  if (!(length > 0)) throw new RangeError('plate length must be > 0');
  const re = (Math.max(speed, 0) * length) / brakeAir.viscosity;
  const nu = (re < 5e5 ? 0.664 * re ** 0.5 : 0.037 * re ** 0.8) * prandtl ** (1 / 3);
  return Math.max((nu * brakeAir.conductivity) / length, stillFilm);
}

/** A box of the scene: [min, size] (mm). */
export interface ExhaustBox {
  min: readonly number[];
  size: readonly number[];
}
export interface ExhaustScene {
  floor: ExhaustBox;
  tank: ExhaustBox;
  /** A square duct `side` across, its axis along x at height `axisZ`. */
  pipe: { side: number; axisZ: number; length: number };
  shield: ExhaustBox;
}

const inside = (p: readonly number[], b: ExhaustBox, pad: number) =>
  [0, 1, 2].every((k) => p[k]! >= b.min[k]! - pad && p[k]! <= b.min[k]! + b.size[k]! + pad);

/** The pipe's bounding box. */
const pipeBox = (s: ExhaustScene): ExhaustBox => ({
  min: [0, -s.pipe.side / 2, s.pipe.axisZ - s.pipe.side / 2],
  size: [s.pipe.length, s.pipe.side, s.pipe.side],
});

/** The scene's faces by the part they are on, from their centroids (mm). */
export function exhaustFaces(
  table: CadTopologyTable,
  scene: ExhaustScene,
  shield: boolean,
): {
  pipe: number[];
  /** The pipe's faces towards the floor: its top and sides (not its underside or cut ends). */
  pipeUp: number[];
  shield: number[];
  floorUnder: number[];
  /** The floor's other faces and the tank's (the car's inside). */
  above: number[];
  /**
   * The section's cut ends (x = 0 and x = the floor's length) of the floor, tank and shield:
   * no heat passes there, so they take no condition (Codex on #1282).
   */
  cut: number[];
} {
  const pipe: number[] = [];
  const pipeUp: number[] = [];
  const shieldFaces: number[] = [];
  const floorUnder: number[] = [];
  const above: number[] = [];
  const cut: number[] = [];
  const length = scene.floor.size[0]!;
  table.faces.forEach((f, i) => {
    const c = f.centroid;
    if (inside(c, pipeBox(scene), 0.5)) {
      pipe.push(i);
      if (c[0] > 0.5 && c[0] < scene.pipe.length - 0.5 && c[2] > scene.pipe.axisZ - 0.5)
        pipeUp.push(i);
    } else if (
      (Math.abs(c[0] - scene.floor.min[0]!) < 0.5 ||
        Math.abs(c[0] - scene.floor.min[0]! - length) < 0.5) &&
      (inside(c, scene.floor, 0.5) ||
        inside(c, scene.tank, 0.5) ||
        (shield && inside(c, scene.shield, 0.5)))
    )
      cut.push(i);
    else if (shield && inside(c, scene.shield, 0.5)) shieldFaces.push(i);
    else if (Math.abs(c[2]) < 0.5) floorUnder.push(i);
    else if (inside(c, scene.floor, 0.5) || inside(c, scene.tank, 0.5)) above.push(i);
    else throw new RangeError(`face ${i} at ${c.join(', ')} is on no part of the scene`);
  });
  return { pipe, pipeUp, shield: shieldFaces, floorUnder, above, cut };
}

export interface ExhaustOptions {
  scene: ExhaustScene;
  shield: boolean;
  /** The gas temperature over time (K): `gas` × the time table. */
  gas: number;
  gasAmplitude?: SimulationAmplitude;
  /** The air's speed under the car (mm/s, default half of 100 km/h). */
  airSpeed?: number;
  /**
   * VS12c: the film under the car (mW/(mm²·K)) in place of `plateFilm` at `airSpeed`, e.g. a Host
   * wind tunnel's on the floor (`aeroRegionFilm`).
   */
  underFilm?: number;
  /** Film on the car's inside: floor top and tank (default still air). */
  insideFilm?: number;
  /** Emissivity of the pipe, floor and shield (default 0.8, oxidised steel). */
  emissivity?: number;
  ambient?: number;
  endS?: number;
  stepS?: number;
  outputEvery?: number;
  raysPerPatch?: number;
  meshSize?: number;
  /** Mesh size on the shield (mm, default 16). */
  shieldMeshSize?: number;
}

/**
 * VS12b: the exhaust scene (F102, or F103 with `shield`) as one transient analysis of the body
 * `bodyId` of `cad`: structural steel; the pipe held at the gas temperature; enclosure radiation
 * between the pipe, the shield and the floor's underside; the air under the car on floor and
 * shield (`plateFilm` over the floor's length), still air inside.
 */
export function exhaustAnalysis(
  cad: CadDocument,
  contentHash: string,
  bodyId: string,
  table: CadTopologyTable,
  o: ExhaustOptions,
): {
  doc: SimulationDocument;
  study: SimulationTransientStudy;
  faces: ReturnType<typeof exhaustFaces>;
} {
  const body = cad.bodies.find((b) => b.id === bodyId);
  if (!body) throw new RangeError(`no body ${bodyId}`);
  const faces = exhaustFaces(table, o.scene, o.shield);
  const at = (list: number[]): SimulationTarget[] =>
    list.map((i) => ({ kind: 'face', ref: topologyRefOf(table, 'face', i, body.resultFeatureId) }));
  const ambient = o.ambient ?? 293.15;
  const emissivity = o.emissivity ?? 0.8;
  const doc = emptySimulation(
    { artifactId: 'exhaust', versionId: 'v1', contentHash, bodyId },
    o.shield ? 'Exhaust with shield' : 'Exhaust',
  );
  doc.materials.push({ id: 'steel', ...simulationMaterialPresets[0]! });
  doc.materialId = 'steel';
  const size = o.meshSize ?? 24;
  // The thin shield takes elements near its thickness: the global size would leave slivers there.
  const shieldSize = o.shieldMeshSize ?? 16;
  // Its cut ends take no condition but the same size, or they leave a sliver at the rim.
  const shieldMesh = [
    ...faces.shield,
    ...(o.shield
      ? faces.cut.filter((i) => inside(table.faces[i]!.centroid, o.scene.shield, 0.5))
      : []),
  ];
  doc.mesh = {
    ...doc.mesh,
    size,
    minSize: Math.min(0.75 * size, faces.shield.length ? shieldSize : Infinity),
    grading: 1.5,
    local: at(shieldMesh).map((target) => ({ target, size: shieldSize })),
  };
  doc.constraints.push({
    id: 'gas',
    name: 'Exhaust gas',
    kind: 'temperature',
    targets: at(faces.pipe),
    temperature: o.gas,
    ...(o.gasAmplitude ? { amplitude: o.gasAmplitude } : {}),
  });
  const under = [...faces.floorUnder, ...faces.shield];
  doc.loads.push(
    {
      id: 'underbody-air',
      name: 'Air under the car',
      kind: 'convection',
      targets: at(under),
      coefficient: o.underFilm ?? plateFilm(o.airSpeed ?? kmh(50), o.scene.floor.size[0]!),
      ambient,
    },
    {
      id: 'inside-air',
      name: 'Air inside',
      kind: 'convection',
      targets: at(faces.above),
      coefficient: o.insideFilm ?? stillFilm,
      ambient,
    },
    {
      id: 'radiation',
      name: 'Pipe, shield and floor',
      kind: 'enclosure',
      targets: at([...faces.pipeUp, ...under]),
      emissivity,
    },
  );
  const study = transientStudy('exhaust', doc.name);
  study.loadIds = doc.loads.map((l) => l.id);
  study.constraintIds = ['gas'];
  study.transient = {
    ...study.transient,
    endS: o.endS ?? 1800,
    stepS: o.stepS ?? 10,
    initialTemperature: ambient,
    outputEvery: o.outputEvery ?? 30,
    enclosure: { ambient, raysPerPatch: o.raysPerPatch ?? 64 },
  };
  doc.studies.push(study);
  return { doc, study, faces };
}

/** The highest temperature (K) of the nodes inside `box` (mm, `pad` around it). */
export function regionMax(mesh: FemMesh, T: ArrayLike<number>, box: ExhaustBox, pad = 0.5): number {
  let hi = -Infinity;
  for (let n = 0; n < mesh.nodes.length / 3; n++) {
    const p = [mesh.nodes[3 * n]!, mesh.nodes[3 * n + 1]!, mesh.nodes[3 * n + 2]!];
    if (inside(p, box, pad)) hi = Math.max(hi, T[n]!);
  }
  return hi;
}

/** The fuel tank's surface limit (K): 80 °C, this fixture's check value. */
export const tankLimit = 353.15;
