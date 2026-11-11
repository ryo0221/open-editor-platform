import { f02Plate, faceRef } from '@editor-platform/cad-core';
import { emptySimulation, simulationMaterialPresets, type SimulationDocument } from './model';

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
