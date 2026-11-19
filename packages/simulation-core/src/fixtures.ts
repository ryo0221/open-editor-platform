import {
  f02Plate,
  f95NagiWater,
  f95WaterHinges,
  f95WaterNames,
  f95WaterOpenings,
  f98GapBox,
  f98GapBoxDoc,
  faceRef,
  waterSealRefs,
  type CadDocument,
  type F95WaterOpening,
  type F95WaterOptions,
} from '@editor-platform/cad-core';
import {
  emptySimulation,
  sealStudy,
  simulationMaterialPresets,
  simulationSealSectionDefault,
  type SimulationDocument,
  type SimulationSeal,
  type SimulationSealSection,
} from './model';

/**
 * The F02 plate (80×50×5 mm with a 10 mm hole) as an analysis: steel, one end face fixed, 500 N
 * down on the other, one linear static study. Face names are fixture names; R3c checks them on
 * the evaluated shape.
 */
export function simulationFixture(): { cad: ReturnType<typeof f02Plate>; doc: SimulationDocument } {
  const cad = f02Plate();
  const body = cad.bodies.find((b) => b.id === 'plate')!;
  const doc = emptySimulation(
    { artifactId: 'cad-plate', versionId: 'v1', contentHash: 'sha256-fixture', bodyId: 'plate' },
    'Plate bending',
  );
  const f = body.resultFeatureId;
  doc.materials.push({ id: 'steel', ...simulationMaterialPresets[0]! });
  doc.materialId = 'steel';
  doc.constraints.push({
    id: 'fix-left',
    name: 'Fixed end',
    kind: 'fixed',
    targets: [{ kind: 'face', ref: faceRef(f, ['plate-extrude', 'side:0'], [0, 25, 2.5], 250) }],
  });
  doc.loads.push({
    id: 'tip-load',
    name: 'Tip load',
    kind: 'force',
    targets: [{ kind: 'face', ref: faceRef(f, ['plate-extrude', 'side:2'], [80, 25, 2.5], 250) }],
    force: [0, 0, -500],
  });
  doc.studies.push({
    id: 'static',
    name: 'Static',
    kind: 'linear-static',
    loadIds: ['tip-load'],
    constraintIds: ['fix-left'],
    solver: { tolerance: 1e-8, maxIterations: 10_000 },
    convergence: { levels: 3, metrics: ['max-displacement', 'max-von-mises'], tolerance: 0.02 },
  });
  return { cad, doc };
}

/** VS9: what the water fixtures' seals take: their section, inset and hinge angle. */
export interface WaterSealOptions {
  section?: SimulationSealSection;
  /** How far into the pocket floor the seal runs from the pocket's walls (mm, default 12). */
  insetMm?: number;
  /** The hinge angle (degrees, default 0: shut). */
  angleDeg?: number;
}

/** One seal of a water model's `waterSealRefs`, the closure body `closure` turned by `hinge`. */
function waterSeal(
  cad: CadDocument,
  id: string,
  name: string,
  body: string,
  closure: string,
  centre: [number, number, number],
  hinge: { origin: [number, number, number]; axis: [number, number, number] },
  options: WaterSealOptions,
): SimulationSeal {
  const feature = (b: string) => cad.bodies.find((x) => x.id === b)!.resultFeatureId;
  const refs = waterSealRefs(name, feature(body), feature(closure), centre);
  return {
    id,
    name: `${name} seal`,
    line: refs.line.map((ref) => ({ kind: 'edge', ref })),
    base: [{ kind: 'face', ref: refs.base }],
    mating: [{ kind: 'face', ref: refs.mating, body: closure }],
    insetMm: options.insetMm ?? 12,
    section: structuredClone(options.section ?? simulationSealSectionDefault),
    hinge: { ...structuredClone(hinge), angleDeg: options.angleDeg ?? 0 },
  };
}

/**
 * VS9 (docs/cad/vehicle-simulation.md, V3): F98 (the gap box) as a seal analysis: the box with
 * its lid as a second body and one seal round the lid's pocket, 12 mm in from its walls, hinged
 * on the lid's back edge (y = +122, at the top). A 16 mm bulb under a 10 mm clearance is pressed
 * 37.5 %. One seal study.
 */
export function f98SealSimulation(
  options: WaterSealOptions & { gap?: number; clearance?: number } = {},
): { cad: CadDocument; doc: SimulationDocument } {
  const cad = f98GapBoxDoc({
    ...(options.gap !== undefined ? { gap: options.gap } : {}),
    ...(options.clearance !== undefined ? { clearance: options.clearance } : {}),
  });
  const doc = emptySimulation(
    { artifactId: 'cad-f98', versionId: 'v1', contentHash: 'sha256-fixture', bodyId: 'box' },
    'Gap box seal',
  );
  doc.schemaVersion = 2;
  doc.bodies = [{ bodyId: 'lid', materialId: null }];
  const top = f98GapBox.size[2];
  doc.seals = [
    waterSeal(
      cad,
      'lid-seal',
      'Lid',
      'box',
      'lid',
      [0, 0, top - f98GapBox.depth],
      { origin: [0, f98GapBox.outline.v[1] + 2, top], axis: [-1, 0, 0] },
      options,
    ),
  ];
  doc.studies.push(sealStudy('seals'));
  return { cad, doc };
}

/**
 * VS9 (docs/cad/vehicle-simulation.md, V3): 凪's water model (F95 water, `f95NagiWater`) as a
 * seal analysis: the body with the hard top and each closure as other bodies, one seal round each
 * opening's pocket, each hinged as `f95WaterHinges` gives. One seal study over them all.
 */
export function nagiWaterSimulation(
  options: WaterSealOptions &
    F95WaterOptions & { angles?: Partial<Record<F95WaterOpening, number>> } = {},
): { cad: CadDocument; doc: SimulationDocument } {
  const openings = options.openings ?? (['door-l', 'door-r', 'hood', 'lid'] as const);
  const cad = f95NagiWater({
    ...(options.gap !== undefined ? { gap: options.gap } : {}),
    ...(options.clearance !== undefined ? { clearance: options.clearance } : {}),
    openings,
  });
  const doc = emptySimulation(
    {
      artifactId: 'cad-nagi-water',
      versionId: 'v1',
      contentHash: 'sha256-fixture',
      bodyId: 'body',
    },
    '凪 seals',
  );
  doc.schemaVersion = 2;
  doc.bodies = [
    { bodyId: 'hard-top', materialId: null },
    ...openings.map((id) => ({ bodyId: id, materialId: null })),
  ];
  doc.seals = openings.map((id) => {
    const o = f95WaterOpenings[id];
    return waterSeal(
      cad,
      `${id}-seal`,
      f95WaterNames[id],
      'body',
      id,
      o.origin,
      f95WaterHinges[id],
      {
        ...options,
        angleDeg: options.angles?.[id] ?? options.angleDeg ?? 0,
      },
    );
  });
  doc.studies.push(sealStudy('seals'));
  return { cad, doc };
}
