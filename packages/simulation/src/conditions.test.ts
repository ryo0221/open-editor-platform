import { describe, expect, it } from 'vitest';
import { faceRef, type CadTopologyTable } from '@editor-platform/cad-core';
import {
  applySimulationOperation,
  simulationFixture,
  validateSimulation,
  type SimulationDocument,
  type SimulationOperation,
} from '@editor-platform/simulation-core';
import {
  addConditionOps,
  addGravityOps,
  addLocalSizesOp,
  addMassOps,
  addWeightOps,
  standardGravityMmS2,
  defaultModalStudy,
  defaultThermalStudy,
  thermalStudyReady,
  localSizeDefault,
  removeConditionOps,
  retargetOp,
  narrowFaces,
  rimFaces,
  setLocalSizeOp,
  bodyFaceTargets,
  spotWeldOf,
  spotWeldRadiusDefaultMm,
  targetFacesByBody,
  type SimulationWeldRow,
} from './conditions';
import { addedMasses, ConditionRefusal, type TargetsOf } from './run-conditions';

/** TS-1340 (ST-184#1, #2): the edits one add, retarget or remove makes. */
const apply = (doc: SimulationDocument, ops: SimulationOperation[]) =>
  ops.reduce((d, op) => applySimulationOperation(d, op), doc);

function bare() {
  const { doc } = simulationFixture();
  const fixed = doc.constraints[0]!.targets;
  const loaded = (doc.loads[0] as { targets: typeof fixed }).targets;
  const empty: SimulationDocument = { ...doc, loads: [], constraints: [], studies: [] };
  return { empty, fixed, loaded };
}

describe('loads and constraints on picked faces', () => {
  it('makes the first study once there is a load and a constraint', () => {
    const { empty, fixed, loaded } = bare();
    const ops1 = addConditionOps(empty, 'force', loaded);
    expect(ops1.map((o) => o.type)).toEqual(['addLoad']);
    const a = apply(empty, ops1);
    expect(a.loads[0]).toMatchObject({ name: 'Force 1', kind: 'force', force: [0, 0, -100] });
    const ops2 = addConditionOps(a, 'fixed', fixed);
    expect(ops2.map((o) => o.type)).toEqual(['addConstraint', 'addStudy']);
    const b = apply(a, ops2);
    expect(b.studies).toHaveLength(1);
    expect(b.studies[0]).toMatchObject({
      kind: 'linear-static',
      loadIds: [a.loads[0]!.id],
      constraintIds: [b.constraints[0]!.id],
    });
    // A later item joins the existing study.
    const c = apply(b, addConditionOps(b, 'pressure', loaded));
    expect(c.loads[1]).toMatchObject({ name: 'Pressure 1', kind: 'pressure', pressure: 1 });
    expect(c.studies[0]!.loadIds).toEqual([c.loads[0]!.id, c.loads[1]!.id]);
    expect(c.loads[0]!.id).not.toBe(c.loads[1]!.id);
  });

  it('adds a modal study of the constraints that takes new constraints but no loads (TS-1382, ST-199#1)', () => {
    const { empty, fixed, loaded } = bare();
    const b = apply(empty, [
      ...addConditionOps(empty, 'force', loaded),
      ...addConditionOps(apply(empty, addConditionOps(empty, 'force', loaded)), 'fixed', fixed),
    ]);
    const modal = defaultModalStudy(b);
    expect(modal).toMatchObject({
      name: 'Modal 1',
      kind: 'modal',
      modes: 6,
      loadIds: [],
      constraintIds: [b.constraints[0]!.id],
      convergence: { metrics: ['first-frequency'] },
    });
    const c = apply(b, [{ type: 'addStudy', study: modal }]);
    expect(defaultModalStudy(c).name).toBe('Modal 2');
    const d = apply(c, addConditionOps(c, 'pressure', loaded));
    expect(d.studies.map((s) => s.loadIds.length)).toEqual([2, 0]);
    const e = apply(d, addConditionOps(d, 'fixed', fixed));
    expect(e.studies.map((s) => s.constraintIds.length)).toEqual([2, 2]);
    // With the static study removed, the next load makes a new one beside the modal study.
    const f = apply(e, [{ type: 'removeStudy', id: e.studies[0]!.id }]);
    const g = apply(f, addConditionOps(f, 'force', loaded));
    expect(g.studies.map((s) => s.kind)).toEqual(['modal', 'linear-static']);
    expect(g.studies[1]!.loadIds).toEqual(g.loads.map((l) => l.id));
  });

  it('keeps thermal items in thermal studies and removes a study left unheld (TS-1387, ST-201#1)', () => {
    const { empty, fixed, loaded } = bare();
    const step = (d: SimulationDocument, kind: Parameters<typeof addConditionOps>[1], t = loaded) =>
      apply(d, addConditionOps(d, kind, t));
    // A force and a support make the static study; a heat flux alone holds nothing.
    const a = step(step(empty, 'force'), 'fixed', fixed);
    const b = step(a, 'heat-flux');
    expect(b.loads.at(-1)).toMatchObject({ name: 'Heat flux 1', kind: 'heat-flux', flux: 1 });
    expect(b.studies[0]!.loadIds).toHaveLength(1);
    expect(thermalStudyReady(b)).toBe(false);
    const c = step(b, 'convection', fixed);
    expect(c.loads.at(-1)).toMatchObject({
      kind: 'convection',
      coefficient: 0.01,
      ambient: 293.15,
    });
    expect(thermalStudyReady(c)).toBe(true);
    const thermal = defaultThermalStudy(c);
    expect(thermal).toMatchObject({
      name: 'Thermal 1',
      kind: 'thermal',
      loadIds: [b.loads[1]!.id, c.loads[2]!.id],
      constraintIds: [],
    });
    const d = apply(c, [{ type: 'addStudy', study: thermal }]);
    // A temperature joins the thermal study only; a support the static one only.
    const e = step(d, 'temperature');
    expect(e.constraints.at(-1)).toMatchObject({ kind: 'temperature', temperature: 293.15 });
    expect(e.studies.map((s) => s.constraintIds.length)).toEqual([1, 1]);
    const f = step(e, 'fixed', fixed);
    expect(f.studies.map((s) => s.constraintIds.length)).toEqual([2, 1]);
    // Without the temperature, the convection still holds it; without both it is removed first.
    const g = apply(f, removeConditionOps(f, 'constraints', e.constraints.at(-1)!.id));
    expect(g.studies).toHaveLength(2);
    const h = apply(g, removeConditionOps(g, 'loads', c.loads[2]!.id));
    expect(h.studies.map((s) => s.kind)).toEqual(['linear-static']);
    expect(defaultModalStudy(f).constraintIds).toEqual(
      f.constraints.filter((x) => x.kind === 'fixed').map((x) => x.id),
    );
  });

  it('names and identifies each new item freshly', () => {
    const { empty, fixed } = bare();
    const a = apply(empty, addConditionOps(empty, 'fixed', fixed));
    const b = apply(a, addConditionOps(a, 'fixed', fixed));
    expect(b.constraints.map((c) => c.name)).toEqual(['Fixed 1', 'Fixed 2']);
    expect(new Set(b.constraints.map((c) => c.id)).size).toBe(2);
  });

  it('removes a study left without a constraint before the constraint', () => {
    const { doc } = simulationFixture();
    const ops = removeConditionOps(doc, 'constraints', 'fix-left');
    expect(ops.map((o) => o.type)).toEqual(['removeStudy', 'removeConstraint']);
    const next = apply(doc, ops);
    expect(next.constraints).toEqual([]);
    expect(next.studies).toEqual([]);
    // Without the step, the core refuses the edit.
    expect(() =>
      applySimulationOperation(doc, { type: 'removeConstraint', id: 'fix-left' }),
    ).toThrow();
    // A load leaves the study (it may have none).
    const noLoad = apply(doc, removeConditionOps(doc, 'loads', 'tip-load'));
    expect(noLoad.studies[0]!.loadIds).toEqual([]);
  });

  it('retargets an item to the selected faces', () => {
    const { doc } = simulationFixture();
    const fixed = doc.constraints[0]!;
    const load = doc.loads[0]!;
    const targets = (load as { targets: typeof fixed.targets }).targets;
    const next = apply(doc, [retargetOp(fixed, targets)!]);
    expect(next.constraints[0]!.targets).toEqual(targets);
    expect(
      retargetOp({ id: 'g', name: 'g', kind: 'gravity', acceleration: [0, 0, -1] }, targets),
    ).toBe(undefined);
  });
});

/** TS-1346 (ST-187#1): a finer mesh on picked faces, sized and removed as one edit each. */
describe('finer mesh sizes on picked faces', () => {
  it('adds each face once at half the element size, then sizes and removes it', () => {
    const { doc } = simulationFixture();
    const plain: SimulationDocument = { ...doc, mesh: { ...doc.mesh, local: [] } };
    const targets = (
      doc.loads[0] as { targets: SimulationDocument['mesh']['local'][number]['target'][] }
    ).targets;
    const op = addLocalSizesOp(plain, targets)!;
    const a = apply(plain, [op]);
    expect(a.mesh.local).toEqual(
      targets.map((target) => ({
        target,
        size: Math.max(plain.mesh.minSize, plain.mesh.size / 2),
      })),
    );
    // Already sized: nothing to add, whatever the order of the target's properties.
    expect(addLocalSizesOp(a, targets)).toBe(undefined);
    const reordered = targets.map((t) => JSON.parse(JSON.stringify({ ref: t.ref, kind: t.kind })));
    expect(addLocalSizesOp(a, reordered)).toBe(undefined);
    // The same face picked twice is added once.
    expect(
      (addLocalSizesOp(plain, [targets[0]!, targets[0]!]) as { mesh: { local: unknown[] } }).mesh
        .local,
    ).toHaveLength(1);
    const b = apply(a, [setLocalSizeOp(a, 0, a.mesh.minSize)]);
    expect(b.mesh.local[0]!.size).toBe(a.mesh.minSize);
    // Below the smallest size the core refuses it.
    expect(() => apply(b, [setLocalSizeOp(b, 0, b.mesh.minSize / 2)])).toThrow();
    const c = apply(b, [setLocalSizeOp(b, 0, undefined)]);
    expect(c.mesh.local).toHaveLength(targets.length - 1);
    expect(localSizeDefault(plain)).toBe(Math.max(plain.mesh.minSize, plain.mesh.size / 2));
  });
});

/**
 * TS-1396 (ST-207#1): the rims of a picked plate face. A 200 × 100 × 1 mm plate: face 0 the top,
 * 1 the bottom, 2–5 the 1 mm rims (two 200 mm long, two 100 mm long).
 */
function plate(): CadTopologyTable {
  const face = (area: number) => ({
    name: null,
    centroid: [0, 0, 0] as [number, number, number],
    area,
  });
  const edge = (faces: number[], length: number) => ({
    faces,
    vertices: [],
    centroid: [0, 0, 0] as [number, number, number],
    length,
  });
  const lengths = [200, 100, 200, 100];
  return {
    faces: [face(20_000), face(20_000), ...lengths.map((l) => face(l))],
    edges: [
      ...lengths.map((l, i) => edge([0, 2 + i], l)),
      ...lengths.map((l, i) => edge([1, 2 + i], l)),
      // The 1 mm corner edges between neighbouring rims.
      ...lengths.map((_, i) => edge([2 + i, 2 + ((i + 1) % 4)], 1)),
    ],
    vertices: [],
  };
}
describe('rim faces next to the selection (R3j-1)', () => {
  it('lists the narrow faces next to a picked plate face, with their length and width', () => {
    const rims = rimFaces(plate(), [0]);
    expect(rims.map((r) => r.face)).toEqual([2, 3, 4, 5]);
    expect(rims.map((r) => [r.length, r.width])).toEqual([
      [200, 1],
      [100, 1],
      [200, 1],
      [100, 1],
    ]);
  });
  it('leaves out selected faces and wide neighbours, and lists nothing without a selection', () => {
    expect(rimFaces(plate(), [])).toEqual([]);
    // From a rim: its neighbouring rims, not the plate's faces (wide) or itself.
    expect(rimFaces(plate(), [2]).map((r) => r.face)).toEqual([3, 5]);
    expect(rimFaces(plate(), [0, 2, 4]).map((r) => r.face)).toEqual([3, 5]);
    expect([...narrowFaces(plate()).keys()]).toEqual([2, 3, 4, 5]);
  });
});

/** TS-1464 (ST-236#1): faces picked on several analysed bodies, as targets and back. */
describe('faces picked on several bodies (R3j-6a)', () => {
  const named = (names: string[]): CadTopologyTable => ({
    faces: names.map((n, i) => ({
      name: [n],
      centroid: [i, 0, 0] as [number, number, number],
      area: 1,
    })),
    edges: [],
    vertices: [],
  });
  const bodies = new Map([
    ['hood', { table: named(['top', 'bottom']), featureId: 'f-hood' }],
    ['roof', { table: named(['outer', 'inner', 'rim']), featureId: 'f-roof' }],
  ]);
  it('names the body of a face off the source body, and reads the faces back per body', () => {
    const targets = bodyFaceTargets('hood', bodies, [
      { bodyId: 'hood', face: 1 },
      { bodyId: 'roof', face: 2 },
    ]);
    expect(targets.map((t) => [t.body, t.ref.featureId, t.ref.name])).toEqual([
      [undefined, 'f-hood', [['bottom']]],
      ['roof', 'f-roof', [['rim']]],
    ]);
    expect(targetFacesByBody('hood', bodies, targets)).toEqual({
      faces: [
        { bodyId: 'hood', face: 1 },
        { bodyId: 'roof', face: 2 },
      ],
      unresolved: 0,
    });
  });
  it('refuses a face of a body not analysed, and counts a target on one as unresolved', () => {
    expect(() => bodyFaceTargets('hood', bodies, [{ bodyId: 'floor', face: 0 }])).toThrow(
      'not analysed',
    );
    const [t] = bodyFaceTargets('hood', bodies, [{ bodyId: 'roof', face: 0 }]);
    expect(targetFacesByBody('hood', new Map([...bodies].slice(0, 1)), [t!])).toEqual({
      faces: [],
      unresolved: 1,
    });
  });
});

/** TS-1563 (ST-268#4): a CAD spot weld row taken as the analysis's weld. */
describe('spot weld rows taken into the analysis (CR5b)', () => {
  const named = (names: string[]): CadTopologyTable => ({
    faces: names.map((n, i) => ({
      name: [n],
      centroid: [i, 0, 0] as [number, number, number],
      area: 1,
    })),
    edges: [],
    vertices: [],
  });
  const bodies = new Map([
    ['hat', { table: named(['web', 'flange']), featureId: 'f-hat' }],
    ['plate', { table: named(['top', 'bottom']), featureId: 'f-plate' }],
  ]);
  // The CAD row names its faces on the sheets' own features, not the bodies' result features.
  const flange = (bodyId: string, name: string) => ({
    bodyId,
    face: faceRef('sheet', [name], [0, 0, 0], 1),
  });
  const row: SimulationWeldRow = {
    id: 'welds-l',
    name: 'Spot welds left',
    flanges: [flange('hat', 'flange'), flange('plate', 'top')],
    maxGapMm: 2.1,
    points: 5,
  };
  it('takes each flange on its body result feature, radius 3 mm and the row gap', () => {
    const { doc } = simulationFixture();
    const source = { ...doc, source: { ...doc.source, bodyId: 'hat' } };
    const weld = spotWeldOf(source, row, bodies);
    expect(weld).toMatchObject({
      name: 'Spot welds left',
      weldId: 'welds-l',
      radiusMm: spotWeldRadiusDefaultMm,
      tolerance: 2.1,
    });
    expect(spotWeldRadiusDefaultMm).toBe(3);
    expect(weld.follower.map((t) => [t.body, t.ref.featureId, t.ref.name])).toEqual([
      [undefined, 'f-hat', [['flange']]],
    ]);
    expect(weld.on.map((t) => [t.body, t.ref.featureId, t.ref.name])).toEqual([
      ['plate', 'f-plate', [['top']]],
    ]);
  });
  it('refuses a body not analysed, one body twice and a flange its body does not have', () => {
    const { doc } = simulationFixture();
    const source = { ...doc, source: { ...doc.source, bodyId: 'hat' } };
    expect(() =>
      spotWeldOf(
        source,
        { ...row, flanges: [flange('hat', 'flange'), flange('floor', 'top')] },
        bodies,
      ),
    ).toThrow('not analysed');
    expect(() =>
      spotWeldOf(
        source,
        { ...row, flanges: [flange('hat', 'flange'), flange('hat', 'web')] },
        bodies,
      ),
    ).toThrow('one body');
    expect(() =>
      spotWeldOf(
        source,
        { ...row, flanges: [flange('hat', 'gone'), flange('plate', 'top')] },
        bodies,
      ),
    ).toThrow('not found');
  });
});

/**
 * TS-1471 (ST-240#1): the body's own weight and a part's weight as an equivalent static load
 * (docs/cad/car-design.md, CR0 S2a). Gravity enters the static studies, never a modal one; a
 * weight is a force of m g along the gravity, so it leaves the modal study and its mass alone.
 */
describe('gravity and added weight (CR0b)', () => {
  it('adds gravity to the static studies only, and makes the static study once held', () => {
    const { empty, fixed } = bare();
    const a = apply(empty, addConditionOps(empty, 'fixed', fixed));
    expect(a.studies).toEqual([]);
    const ops = addGravityOps(a);
    expect(ops.map((o) => o.type)).toEqual(['addLoad', 'addStudy']);
    const b = apply(a, ops);
    expect(b.loads[0]).toMatchObject({
      name: 'Gravity 1',
      kind: 'gravity',
      acceleration: [0, 0, -standardGravityMmS2],
    });
    expect(b.studies[0]).toMatchObject({ kind: 'linear-static', loadIds: [b.loads[0]!.id] });
    // A modal study takes no loads: gravity added later does not enter it.
    const c = apply(b, [{ type: 'addStudy', study: defaultModalStudy(b) }]);
    const d = apply(c, addGravityOps(c));
    expect(d.loads.map((l) => l.name)).toEqual(['Gravity 1', 'Gravity 2']);
    expect(d.studies.map((s) => [s.kind, s.loadIds.length])).toEqual([
      ['linear-static', 2],
      ['modal', 0],
    ]);
  });

  it('adds a weight as a force of m g along the gravity, in static studies only', () => {
    const { empty, fixed, loaded } = bare();
    const held = apply(empty, addConditionOps(empty, 'fixed', fixed));
    const a = apply(held, addWeightOps(held, loaded, 80));
    expect(a.loads[0]).toMatchObject({
      name: 'Weight 80 kg',
      kind: 'force',
      targets: loaded,
    });
    // 80 kg × 9.80665 m/s² = 784.532 N, straight down without a gravity load.
    const f = (a.loads[0] as { force: number[] }).force;
    expect(f[0]).toBe(0);
    expect(f[1]).toBe(0);
    expect(f[2]).toBeCloseTo(-784.532, 9);
    expect(a.studies[0]).toMatchObject({ kind: 'linear-static', loadIds: [a.loads[0]!.id] });
    const modal = apply(a, [{ type: 'addStudy', study: defaultModalStudy(a) }]);
    const b = apply(modal, addWeightOps(modal, loaded, 80));
    expect(b.loads[1]!.name).toBe('Weight 80 kg 1');
    expect(b.studies.map((s) => s.loadIds.length)).toEqual([2, 0]);
  });

  it('follows the gravity load’s direction and size, and refuses a mass that is not above 0', () => {
    const { empty, fixed, loaded } = bare();
    const held = apply(empty, addConditionOps(empty, 'fixed', fixed));
    const g = apply(held, addGravityOps(held));
    const tilted = apply(g, [
      { type: 'updateLoad', load: { ...g.loads[0]!, acceleration: [0, -3000, -4000] } as never },
    ]);
    const a = apply(tilted, addWeightOps(tilted, loaded, 10));
    // 10 kg × 5 m/s² = 50 N along (0, −0.6, −0.8).
    const f = (a.loads[1] as { force: number[] }).force;
    expect(f[0]).toBe(0);
    expect(f[1]).toBeCloseTo(-30, 9);
    expect(f[2]).toBeCloseTo(-40, 9);
    for (const m of [0, -1, Number.NaN, Infinity])
      expect(() => addWeightOps(held, loaded, m)).toThrow(RangeError);
  });

  it('CR5a: adds a mass in tonnes, in no study list, removable, and the document stays valid', () => {
    const { empty, fixed, loaded } = bare();
    const held = apply(empty, addConditionOps(empty, 'fixed', fixed));
    const a = apply(held, addMassOps(held, loaded, 80));
    expect(a.schemaVersion).toBe(2);
    expect(a.masses).toEqual([
      { id: expect.any(String), name: 'Mass 80 kg', targets: loaded, mass: 0.08 },
    ]);
    expect(validateSimulation(a)).toEqual([]);
    // Studies list loads and constraints; a mass is in every study.
    expect(a.studies.map((s) => s.loadIds.length)).toEqual(
      held.studies.map((s) => s.loadIds.length),
    );
    const b = apply(a, addMassOps(a, loaded, 80));
    expect(b.masses!.map((m) => m.name)).toEqual(['Mass 80 kg', 'Mass 80 kg 1']);
    expect(b.masses![0]!.id).not.toBe(b.masses![1]!.id);
    const c = apply(b, [
      { type: 'removeMass', id: b.masses![0]!.id },
      { type: 'removeMass', id: b.masses![1]!.id },
    ]);
    expect(c.masses).toBeUndefined();
    for (const m of [0, -1, Number.NaN, Infinity])
      expect(() => addMassOps(held, loaded, m)).toThrow(RangeError);
  });
});

describe('added masses on a body’s mesh (CR5a, Codex on #975)', () => {
  const mass = { id: 'engine', name: 'Engine', targets: [], mass: 0.1 };
  it('takes the faces its targets map to', () => {
    const of: TargetsOf = (_, kind) => (kind === 'face' ? [2, 5] : []);
    expect(addedMasses([mass], of)).toEqual([{ faces: [2, 5], mass: 0.1 }]);
  });
  it('refuses a mass on a wall’s side face rather than move it onto the other faces', () => {
    const of: TargetsOf = (_, kind) => (kind === 'face' ? [2] : [7]);
    expect(() => addedMasses([mass], of)).toThrow(ConditionRefusal);
  });
});
