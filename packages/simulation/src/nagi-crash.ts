/**
 * VS8c (docs/cad/vehicle-simulation.md, VS8): 凪's crash and head impact analyses on F101 (F29's
 * simplified BIW with 凪's crash boxes, bumper beam and hood). The documents a crash study of 凪
 * starts from: every sheet with its thickness, the CAD version's spot weld rows, the members'
 * ends on the members they meet as bonds of their rims (VS8c-1 runs them as seams of ties), the
 * powertrain, occupants and fuel as added masses, and the studies (a 56 km/h full frontal into the
 * wall, a 32 km/h side pole on the driver's side, the adult headform on the hood).
 */
import {
  cadContentHash,
  f101NagiCrash,
  f29Groups,
  f29Joints,
  topologyRefOf,
  type CadDocument,
  type CadTopologyTable,
  type Vec3,
} from '@editor-platform/cad-core';
import {
  applySimulationOperation,
  crashStudy,
  emptySimulation,
  freshSimulationId,
  headImpactStudy,
  simulationMaterialPresets,
  type SimulationDocument,
  type SimulationTarget,
} from '@editor-platform/simulation-core';
import { spotWeldOf, type SimulationWeldRow } from './conditions';

/** F101's sheet thicknesses (mm): F29's (CR5f) and 凪's crash boxes, bumper beam and hood. */
export const f101ThicknessMm: Readonly<Record<string, number>> = Object.freeze({
  floor: 0.8,
  dash: 0.8,
  trunk: 0.8,
  roof: 0.8,
  'bow-front': 1.0,
  'bow-rear': 1.0,
  side: 0.8,
  sill: 1.4,
  'pillar-a': 1.4,
  'pillar-b': 1.4,
  'pillar-c': 1.2,
  rail: 1.2,
  'front-member': 1.6,
  'front-closure': 1.6,
  'front-extension': 1.6,
  tower: 1.2,
  apron: 0.8,
  radiator: 1.0,
  'rear-member': 1.6,
  'rear-closure': 1.6,
  wheelhouse: 0.8,
  'cross-rear': 1.2,
  'cross-middle': 1.2,
  'cross-front': 1.2,
  'crash-box': 1.2,
  bumper: 1.8,
  hood: 0.7,
});

/**
 * The added masses (t) and the faces they sit on (the body and a point at the face's centroid):
 * the engine and gearbox on the front side members' closures (half each), two occupants on the
 * floor pan, the fuel and the rear axle on the trunk floor.
 */
export const nagiCrashMasses = Object.freeze([
  {
    id: 'powertrain-l',
    name: 'Powertrain (left half)',
    bodyId: 'front-closure',
    at: [3400, -450, 450],
    mass: 0.09,
  },
  {
    id: 'powertrain-r',
    name: 'Powertrain (right half)',
    bodyId: 'front-closure-r',
    at: [3400, 450, 450],
    mass: 0.09,
  },
  { id: 'occupants', name: 'Occupants', bodyId: 'floor', at: [1950, 0, 250], mass: 0.15 },
  { id: 'fuel', name: 'Fuel and rear axle', bodyId: 'trunk', at: [575, 0, 350], mass: 0.06 },
] as const satisfies readonly {
  id: string;
  name: string;
  bodyId: string;
  at: Vec3;
  mass: number;
}[]);

/** The crash studies' points: the accelerometer on the left sill, the intrusions, the pole. */
export const nagiCrashPoints = Object.freeze({
  accelerometer: [1950, -700, 300] as Vec3,
  intrusions: [
    { name: 'Toe board', point: [2930, -300, 400] as Vec3, reference: [1300, -300, 250] as Vec3 },
    {
      name: 'Dash (steering)',
      point: [2950, -350, 850] as Vec3,
      reference: [1300, -350, 250] as Vec3,
    },
  ],
  /**
   * The pole on the side of the points above (y < 0, F29's left side). The crash study's sides
   * are the solver's (x forward, z up: left is +y), so that side is its `right`.
   */
  pole: { side: 'right' as const, xMm: 2300, zMm: 500 },
  /** The headform's target on the hood: 3/4 of the way forward, off the centre line. */
  head: { target: [3600, -250, 0] as Vec3, holdBeyondMm: 400 },
});

/**
 * The crash studies' end time (ms): long enough for the occupant's 300 mm (OLC) at 56 km/h, and a
 * run of about 130,000 steps (2–3 h on the reference Host's one core at 40 mm).
 */
export const nagiCrashEndMs = 100;
/** The mesh's default size (mm): F101 at 40 mm (20 mm smallest) is some 70,000 shells. */
export const nagiCrashMeshMm = 40;

export interface NagiCrashInput {
  cad: CadDocument;
  /** Each body's topology table (the CAD version's evaluation). */
  tables: ReadonlyMap<string, CadTopologyTable>;
  /** The CAD version's placed spot weld rows: their point counts by row ID (absent: not placed). */
  weldPoints: ReadonlyMap<string, number>;
  /** Thickness overrides by body ID (a left part's ID also covers its right copy). */
  thicknessMm?: Readonly<Record<string, number>>;
  /** The mesh's global size (mm, default `nagiCrashMeshMm`). */
  meshMm?: number;
  /** The mesh's smallest size (mm, default half the global size). */
  minMeshMm?: number;
}

/** The face of `bodyId` whose centroid is nearest `at`. */
function faceNear(
  tables: ReadonlyMap<string, CadTopologyTable>,
  cad: CadDocument,
  bodyId: string,
  at: Vec3,
  source: string,
): SimulationTarget {
  const t = tables.get(bodyId);
  const body = cad.bodies.find((b) => b.id === bodyId);
  if (!t || !body) throw new Error(`F101 has no body ${bodyId}`);
  const d = (c: Vec3) => Math.hypot(c[0] - at[0], c[1] - at[1], c[2] - at[2]);
  let best = 0;
  t.faces.forEach((f, i) => {
    if (d(f.centroid) < d(t.faces[best]!.centroid)) best = i;
  });
  const ref = topologyRefOf(t, 'face', best, body.resultFeatureId);
  // A target on the source body names no body.
  return bodyId === source ? { kind: 'face', ref } : { kind: 'face', ref, body: bodyId };
}

/** The study document's frame: the source, the crash steel, the mesh. */
function start(input: NagiCrashInput, name: string, source: string) {
  const { cad } = input;
  let doc: SimulationDocument = emptySimulation(
    { artifactId: 'f101', versionId: 'v1', contentHash: cadContentHash(input.cad), bodyId: source },
    name,
  );
  const steel = simulationMaterialPresets.find((m) => m.name === 'Mild steel SPCC (crash)')!;
  doc.materials.push({ id: 'steel', ...steel });
  doc.materialId = 'steel';
  const size = input.meshMm ?? nagiCrashMeshMm;
  doc.mesh = { ...doc.mesh, size, minSize: Math.min(size, input.minMeshMm ?? size / 2) };
  const thickness = (id: string) => {
    // The body's own override, then its left part's (which covers the right copy), then F101's.
    const key = id.replace(/-r$/, '');
    const t = input.thicknessMm?.[id] ?? input.thicknessMm?.[key] ?? f101ThicknessMm[key];
    if (t === undefined) throw new Error(`no thickness for ${id}`);
    return t;
  };
  const add = (bodyId: string) => {
    if (bodyId !== source)
      doc = applySimulationOperation(doc, {
        type: 'addBody',
        body: { bodyId, materialId: 'steel' },
      });
    doc = applySimulationOperation(doc, {
      type: 'setSheetThickness',
      bodyId,
      thicknessMm: thickness(bodyId),
    });
  };
  return {
    get doc() {
      return doc;
    },
    set doc(d: SimulationDocument) {
      doc = d;
    },
    add,
    cad,
  };
}

/**
 * 凪's crash analysis: every F101 sheet but the hood (the solid mounts are left out: a crash study
 * solves shells), the welds between them, the rim bonds, the masses, and the frontal and pole
 * studies (`front`, `pole`), each `nagiCrashEndMs` without gravity.
 */
export function nagiCrashAnalysis(input: NagiCrashInput): SimulationDocument {
  const { cad, tables } = input;
  const mounts = new Set<string>(f29Groups.mount);
  const bodies = cad.bodies.map((b) => b.id).filter((id) => !mounts.has(id) && id !== 'hood');
  const s = start(input, '凪 crash', 'floor');
  for (const id of bodies) s.add(id);
  const named = new Map(
    cad.bodies.map((b) => [
      b.id,
      { table: tables.get(b.id)!, featureId: b.resultFeatureId, name: b.name },
    ]),
  );
  // The CAD version's rows between analysed sheets.
  const analysed = new Set(bodies);
  for (const w of cad.spotWelds ?? []) {
    if (!w.flanges.every((f) => analysed.has(f.bodyId))) continue;
    const points = input.weldPoints.get(w.id);
    const row: SimulationWeldRow = {
      id: w.id,
      name: w.name,
      flanges: [
        { bodyId: w.flanges[0].bodyId, face: w.flanges[0].face },
        { bodyId: w.flanges[1].bodyId, face: w.flanges[1].face },
      ],
      maxGapMm: w.maxGapMm,
      ...(points !== undefined ? { points } : {}),
    };
    s.doc = applySimulationOperation(s.doc, {
      type: 'addSpotWeld',
      weld: spotWeldOf(s.doc, row, named),
    });
  }
  // The members' ends on the members they meet (CR5f-6, as F29's analyses): the follower's edges
  // in the plane of its end, the other body's faces in that plane (or the one given).
  const { box, bumper } = f101NagiCrash;
  const rims: [string, string, 0 | 1 | 2, number, (0 | 1 | 2)?, number?][] = [];
  for (const r of ['', '-r']) {
    const y = r ? 1 : -1;
    for (const p of ['pillar-a', 'pillar-b', 'pillar-c']) {
      rims.push([p + r, 'sill' + r, 2, f29Joints.sillTopZ]);
      rims.push([p + r, 'rail' + r, 2, f29Joints.railBottomZ]);
    }
    for (const c of ['cross-rear', 'cross-middle', 'cross-front'])
      rims.push([c, 'sill' + r, 1, y * f29Joints.sillInnerY]);
    rims.push(['rear-member' + r, 'cross-rear', 0, f29Joints.crossRearBackX]);
    rims.push(['front-extension' + r, 'cross-front', 0, f29Joints.crossFrontFrontX]);
    rims.push(['apron' + r, 'front-closure' + r, 1, y * 480, 2, 450]);
    rims.push(['tower' + r, 'apron' + r, 2, 450]);
    // 凪's front end: the crash boxes' back ends on the radiator support, the bumper beam's back
    // wall on the boxes' front ends.
    rims.push(['crash-box' + r, 'radiator', 0, box.fromX]);
    rims.push(['crash-box' + r, 'bumper', 0, bumper.backX]);
  }
  for (const [follower, on, axis, at, faceAxis = axis, faceAt = at] of rims) {
    const ft = tables.get(follower)!;
    const ot = tables.get(on)!;
    const edges = ft.edges.flatMap((e, i) => (Math.abs(e.centroid[axis] - at) < 0.5 ? [i] : []));
    const faces = ot.faces.flatMap((f, i) =>
      Math.abs(f.centroid[faceAxis] - faceAt) < 2 ? [i] : [],
    );
    if (!edges.length || !faces.length)
      throw new Error(`rim ${follower} → ${on}: ${edges.length} edges, ${faces.length} faces`);
    s.doc = applySimulationOperation(s.doc, {
      type: 'addBond',
      bond: {
        id: freshSimulationId(s.doc, 'bond'),
        name: `${named.get(follower)!.name} end on ${named.get(on)!.name}`,
        follower: edges.map((i) => ({
          kind: 'edge' as const,
          ref: topologyRefOf(ft, 'edge', i, named.get(follower)!.featureId),
          body: follower,
        })),
        on: faces.map((i) => ({
          kind: 'face' as const,
          ref: topologyRefOf(ot, 'face', i, named.get(on)!.featureId),
          body: on,
        })),
        tolerance: 1,
        contact: true,
      },
    });
  }
  for (const m of nagiCrashMasses)
    s.doc = applySimulationOperation(s.doc, {
      type: 'addMass',
      mass: {
        id: m.id,
        name: m.name,
        targets: [faceNear(tables, cad, m.bodyId, m.at, 'floor')],
        mass: m.mass,
      },
    });
  const p = nagiCrashPoints;
  const front = crashStudy('front', p.accelerometer, undefined, 'Full frontal 56 km/h');
  const pole = crashStudy('pole', p.accelerometer, p.pole, 'Side pole 32 km/h');
  for (const study of [front, pole]) {
    study.crash.gravity = false;
    study.crash.endTimeMs = nagiCrashEndMs;
    study.crash.intrusions = p.intrusions.map((i) => ({ ...i }));
  }
  s.doc = { ...s.doc, studies: [...s.doc.studies, front, pole] };
  return s.doc;
}

/**
 * 凪's head impact analysis: the hood alone (its far edges held, as its hinges and latch hold it:
 * the nodes beyond `holdBeyondMm` of the target), struck by the adult headform (`head`).
 */
export function nagiHeadAnalysis(input: NagiCrashInput): SimulationDocument {
  const s = start(input, '凪 head impact', 'hood');
  s.add('hood');
  const { target, holdBeyondMm } = nagiCrashPoints.head;
  // The target on the hood's top: its line's height at the target's x.
  const line = f101NagiCrash.hood.line;
  const k = line.findIndex(([x]) => x >= target[0]);
  const [a, b] = [line[Math.max(0, k - 1)]!, line[Math.max(1, k)]!];
  const z = a[1] + ((b[1] - a[1]) * (target[0] - a[0])) / (b[0] - a[0]);
  const thickness = input.thicknessMm?.hood ?? f101ThicknessMm.hood!;
  const study = headImpactStudy('head', [target[0], target[1], z + thickness / 2], holdBeyondMm);
  return { ...s.doc, studies: [...s.doc.studies, study] };
}
