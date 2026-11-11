import { faceRef } from '@editor-platform/cad-core';
import { EditorSession } from '@editor-platform/editor-core';
import { describe, expect, it } from 'vitest';
import {
  applySimulationOperation,
  checkSimulationSource,
  freshSimulationId,
  isSimulationDocument,
  simulationContentHash,
  simulationEditorCommand,
  simulationFixture,
  simulationLimits,
  simulationTargets,
  SimulationValidationError,
  validateSimulation,
  type SimulationDocument,
} from './index';

const codes = (v: unknown) => validateSimulation(v).map((d) => d.code);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests write malformed shapes
type Loose = any;
const mutate = (f: (d: Loose) => void) => {
  const { doc } = simulationFixture();
  const d = structuredClone(doc) as Loose;
  f(d);
  return codes(d);
};
const refused = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(SimulationValidationError);
    return (e as SimulationValidationError).diagnostics.map((d) => d.code);
  }
  throw new Error('not refused');
};

describe('simulation documents (R3a, SM10)', () => {
  it('accepts the fixture and survives a JSON round trip unchanged', () => {
    const { doc } = simulationFixture();
    expect(validateSimulation(doc)).toEqual([]);
    const reread = JSON.parse(JSON.stringify(doc)) as SimulationDocument;
    expect(isSimulationDocument(reread)).toBe(true);
    expect(simulationContentHash(reread)).toBe(simulationContentHash(doc));
  });

  it('reads schemas 1 and 2 only and plain JSON only', () => {
    expect(mutate((d) => (d.schemaVersion = 3))).toEqual(['unsupported-schema']);
    expect(mutate((d) => (d.units = 'm-N-Pa'))).toContain('units');
    expect(mutate((d) => (d.extra = 1))).toContain('unknown-key');
    expect(codes({ ...simulationFixture().doc, name: new Date() })).toContain('json-value');
    expect(mutate((d) => (d.loads[0].force[0] = Number.POSITIVE_INFINITY))).toContain('number');
    expect(codes(null)).toEqual(['simulation-document']);
    // A sparse array would pass every() and change on a JSON round trip.
    expect(mutate((d) => (d.loads[0].force = new Array(3)))).toEqual(['json-value']);
    // A non-object entry in any collection is reported, never skipped.
    expect(mutate((d) => d.materials.push(null))).toContain('material');
    expect(mutate((d) => d.loads.push(7))).toContain('load');
    expect(mutate((d) => d.constraints.push('x'))).toContain('constraint');
    expect(mutate((d) => d.studies.push(null))).toContain('study');
    expect(mutate((d) => d.mesh.local.push(null))).toContain('local-size');
    expect(mutate((d) => d.preparation.removeFaces.push(null))).toContain('target');
    expect(mutate((d) => (d.retiredIds = [null]))).toContain('id');
  });

  it('refuses values outside the model', () => {
    expect(mutate((d) => (d.materials[0].poissonsRatio = 0.5))).toContain('value');
    expect(mutate((d) => (d.materials[0].youngsModulus = 0))).toContain('value');
    expect(mutate((d) => (d.materials[0].model = 'plastic'))).toContain('unsupported-material');
    expect(mutate((d) => (d.materialId = 'gold'))).toContain('material-missing');
    expect(mutate((d) => (d.loads[0].force = [0, 0, 0]))).toContain('value-zero');
    expect(mutate((d) => (d.loads[0].targets = []))).toContain('targets-empty');
    expect(
      mutate((d) => d.loads[0].targets.push(structuredClone(d.loads[0].targets[0]))),
    ).toContain('duplicate-target');
    expect(
      mutate((d) =>
        d.loads.push({
          id: 'p',
          name: 'Pressure',
          kind: 'pressure',
          targets: [{ kind: 'edge', ref: { ...d.loads[0].targets[0].ref, kind: 'edge' } }],
          pressure: 1,
        }),
      ),
    ).toContain('target-kind');
    expect(mutate((d) => (d.loads[0].targets[0].ref.kind = 'edge'))).toContain('reference-kind');
    expect(mutate((d) => (d.loads[0].targets[0].ref.name = [[]]))).toContain('reference-name');
    expect(mutate((d) => (d.loads[0].kind = 'moment'))).toContain('unsupported-load');
    expect(mutate((d) => (d.constraints[0].kind = 'spring'))).toContain('unsupported-constraint');
    expect(
      mutate((d) =>
        d.constraints.push({
          ...d.constraints[0],
          id: 'd',
          kind: 'displacement',
          displacement: [null, null, null],
        }),
      ),
    ).toContain('value');
    expect(mutate((d) => (d.mesh.order = 1))).toContain('unsupported-mesh-order');
    expect(mutate((d) => (d.mesh.minSize = 10))).toContain('mesh-size-order');
    expect(mutate((d) => (d.preparation.removeHolesBelow = -3))).toContain('value');
  });

  it('checks studies: kinds, references, solver and convergence settings', () => {
    // R3g-2 (TS-1382, ST-199#1): a modal study names its mode count and takes no loads.
    expect(mutate((d) => (d.studies[0].kind = 'modal'))).toContain('missing-key');
    const modal = (d: Loose, modes: unknown, loadIds: string[] = []) => {
      d.studies[0].kind = 'modal';
      d.studies[0].modes = modes;
      d.studies[0].loadIds = loadIds;
      d.studies[0].convergence.metrics = ['first-frequency'];
    };
    expect(mutate((d) => modal(d, 6))).toEqual([]);
    expect(mutate((d) => modal(d, 0))).toContain('value');
    expect(mutate((d) => modal(d, 21))).toContain('value');
    expect(mutate((d) => modal(d, 2.5))).toContain('value');
    expect(mutate((d) => modal(d, 6, [d.loads[0].id]))).toContain('value');
    // Each kind compares its own metrics: a static study has no frequency, a modal one no stress.
    expect(mutate((d) => (d.studies[0].convergence.metrics = ['first-frequency']))).toContain(
      'value',
    );
    expect(
      mutate((d) => {
        modal(d, 6);
        d.studies[0].convergence.metrics = ['max-von-mises'];
      }),
    ).toContain('value');
    expect(mutate((d) => (d.studies[0].kind = 'cfd'))).toContain('unsupported-analysis');
    expect(mutate((d) => (d.studies[0].loadIds = ['nope']))).toContain('reference-missing');
    expect(mutate((d) => (d.studies[0].constraintIds = []))).toContain('constraints-empty');
    expect(mutate((d) => (d.studies[0].solver.tolerance = 0.1))).toContain('value');
    expect(mutate((d) => (d.studies[0].convergence.levels = 5))).toContain('value');
    expect(mutate((d) => (d.studies[0].convergence.metrics = []))).toContain('value');
    expect(mutate((d) => (d.studies[0].convergence.metrics = ['mass']))).toContain('value');
  });

  it("checks a structural study's idealisation and the pinned constraint (TS-1394, ST-205#1)", () => {
    expect(mutate((d) => (d.studies[0].idealisation = 'shell'))).toEqual([]);
    expect(mutate((d) => (d.studies[0].idealisation = 'solid'))).toEqual([]);
    expect(mutate((d) => (d.studies[0].idealisation = 'beam'))).toContain('value');
    expect(
      mutate((d) => {
        d.studies[0].kind = 'modal';
        d.studies[0].modes = 4;
        d.studies[0].loadIds = [];
        d.studies[0].convergence.metrics = ['first-frequency'];
        d.studies[0].idealisation = 'shell';
      }),
    ).toEqual([]);
    // A thermal study is solid only: the key itself is unknown there.
    expect(
      mutate((d) => {
        d.studies[0].kind = 'thermal';
        d.studies[0].idealisation = 'solid';
      }),
    ).toContain('unknown-key');
    expect(
      mutate((d) => {
        d.constraints[0].kind = 'pinned';
      }),
    ).toEqual([]);
    expect(
      mutate((d) => {
        d.constraints[0].kind = 'pinned';
        d.constraints[0].displacement = [0, 0, 0];
      }),
    ).toContain('unknown-key');
  });

  it('checks thermal items, a thermal study and the conductivity (TS-1387, ST-201#1)', () => {
    const thermal = (d: Loose) => {
      const t = d.loads[0].targets;
      d.materials[0].conductivity = 50;
      d.constraints.push({
        id: 'hot',
        name: 'Hot',
        kind: 'temperature',
        targets: t,
        temperature: 400,
      });
      d.loads.push({ id: 'in', name: 'In', kind: 'heat-flux', targets: t, flux: 2 });
      d.loads.push({
        id: 'air',
        name: 'Air',
        kind: 'convection',
        targets: t,
        coefficient: 0.01,
        ambient: 293.15,
      });
      d.studies.push({
        ...structuredClone(d.studies[0]),
        id: 'thermal',
        name: 'Thermal',
        kind: 'thermal',
        loadIds: ['in', 'air'],
        constraintIds: ['hot'],
        convergence: { levels: 2, metrics: ['max-temperature', 'max-heat-flux'], tolerance: 0.02 },
      });
      return d.studies[1];
    };
    expect(mutate(thermal)).toEqual([]);
    // Held by a convection alone.
    expect(mutate((d) => (thermal(d).constraintIds = []))).toEqual([]);
    expect(
      mutate((d) => {
        const s = thermal(d);
        s.constraintIds = [];
        s.loadIds = ['in'];
      }),
    ).toContain('constraints-empty');
    // Thermal items in thermal studies only, structural ones in the others.
    expect(mutate((d) => thermal(d).loadIds.push(d.loads[0].id))).toContain('study-kind');
    expect(mutate((d) => (thermal(d), d.studies[0].constraintIds.push('hot')))).toContain(
      'study-kind',
    );
    expect(mutate((d) => (thermal(d).convergence.metrics = ['max-von-mises']))).toContain('value');
    // Values.
    expect(mutate((d) => (thermal(d), (d.constraints[1].temperature = -1)))).toContain('value');
    expect(mutate((d) => (thermal(d), (d.loads[1].flux = 0)))).toContain('value');
    expect(mutate((d) => (thermal(d), (d.loads[2].coefficient = 0)))).toContain('value');
    expect(mutate((d) => (thermal(d), (d.loads[2].ambient = 1e6)))).toContain('value');
    expect(mutate((d) => (d.materials[0].conductivity = 0))).toContain('value');
    expect(mutate((d) => delete d.materials[0].conductivity)).toEqual([]);
  });

  it('keeps one ID namespace, and removed IDs stay retired', () => {
    expect(mutate((d) => (d.loads[0].id = 'steel'))).toContain('duplicate-id');
    expect(mutate((d) => (d.retiredIds = ['steel']))).toContain('retired-id-in-use');
    const { doc } = simulationFixture();
    const removed = applySimulationOperation(doc, { type: 'removeLoad', id: 'tip-load' });
    expect(removed.studies[0]!.loadIds).toEqual([]);
    expect(removed.retiredIds).toEqual(['tip-load']);
    expect(
      refused(() => applySimulationOperation(removed, { type: 'addLoad', load: doc.loads[0]! })),
    ).toContain('retired-id-in-use');
    expect(freshSimulationId(removed, 'tip-load')).toBe('tip-load-2');
    const noConstraint = refused(() =>
      applySimulationOperation(doc, { type: 'removeConstraint', id: 'fix-left' }),
    );
    expect(noConstraint).toContain('constraints-empty');
    expect(
      refused(() => applySimulationOperation(doc, { type: 'removeMaterial', id: 'steel' })),
    ).toEqual(['material-in-use']);
    expect(
      refused(() => applySimulationOperation(doc, { type: 'removeStudy', id: 'nope' })),
    ).toEqual(['not-found']);
  });

  it('edits through one EditorSession command with Undo, and refuses stale or unauthorised edits', () => {
    const { doc } = simulationFixture();
    const session = new EditorSession(doc);
    const cmd = (op: Parameters<typeof simulationEditorCommand>[0], canEdit = () => true) =>
      simulationEditorCommand(op, {
        expectedHash: simulationContentHash(session.content),
        canEdit,
      });
    session.execute(
      cmd({
        type: 'updateLoad',
        load: { ...doc.loads[0]!, force: [0, 0, -800] } as SimulationDocument['loads'][number],
      }),
    );
    expect((session.content.loads[0] as { force: number[] }).force).toEqual([0, 0, -800]);
    session.undo();
    expect(session.content).toEqual(doc);
    const stale = simulationEditorCommand(
      { type: 'renameDocument', name: 'x' },
      { expectedHash: 'old', canEdit: () => true },
    );
    expect(() => session.execute(stale)).toThrow('simulation-base-mismatch');
    expect(() => session.execute(cmd({ type: 'renameDocument', name: 'x' }, () => false))).toThrow(
      'permission-denied',
    );
    expect(session.content).toEqual(doc);
    // One user action of several operations is one Undo step; a refused one refuses them all.
    const aluminium = { ...doc.materials[0]!, id: 'al', name: 'Aluminium' };
    session.execute(
      cmd([
        { type: 'addMaterial', material: aluminium },
        { type: 'setBodyMaterial', materialId: 'al' },
      ]),
    );
    expect(session.content.materialId).toBe('al');
    session.undo();
    expect(session.content).toEqual(doc);
    expect(() =>
      session.execute(
        cmd([
          { type: 'addMaterial', material: aluminium },
          { type: 'removeMaterial', id: 'steel' },
        ]),
      ),
    ).toThrow();
    expect(session.content).toEqual(doc);
    expect(() => cmd([])).toThrow('no-operation');
  });

  it('checks the source body and that every target names its result feature', () => {
    const { cad, doc } = simulationFixture();
    expect(checkSimulationSource(doc, cad)).toEqual([]);
    const other = structuredClone(doc);
    const load = other.loads[0]!;
    if (load.kind === 'force') load.targets[0]!.ref.featureId = 'plate-extrude';
    expect(checkSimulationSource(other, cad).map((d) => d.code)).toEqual(['target-feature']);
    const tool = { ...doc, source: { ...doc.source, bodyId: 'hole' } };
    expect(checkSimulationSource(tool, cad).map((d) => d.code)).toContain('source-body-consumed');
    const none = { ...doc, source: { ...doc.source, bodyId: 'gone' } };
    expect(checkSimulationSource(none, cad).map((d) => d.code)).toEqual(['source-body-missing']);
  });

  /** TS-1354 (ST-188#4): a version switch renames every target to the new result feature. */
  it('renames the targets to the chosen version result feature when switching the source', () => {
    const { cad, doc } = simulationFixture();
    const v2 = structuredClone(cad);
    const body = v2.bodies.find((b) => b.id === doc.source.bodyId)!;
    body.resultFeatureId = 'plate-fillet';
    const source = { ...doc.source, versionId: 'v2' };
    const plain = applySimulationOperation(doc, { type: 'setSource', source });
    expect(checkSimulationSource(plain, v2).map((d) => d.code)).toContain('target-feature');
    const next = applySimulationOperation(doc, {
      type: 'setSource',
      source,
      resultFeatureId: 'plate-fillet',
    });
    expect(checkSimulationSource(next, v2)).toEqual([]);
    expect(validateSimulation(next)).toEqual([]);
    // Names are kept: each one still resolves on the new version or is reported there.
    expect(simulationTargets(next).map((t) => t.target.ref.name)).toEqual(
      simulationTargets(doc).map((t) => t.target.ref.name),
    );
  });

  it('enforces list limits', () => {
    const many = mutate((d) => {
      for (let i = 0; i <= simulationLimits.materials; i++)
        d.materials.push({ ...d.materials[0], id: `m${i}` });
    });
    expect(many).toContain('limit-exceeded');
  });
});

/** TS-1398 (ST-208#1, #2): other bodies analysed with the source body (schema 2, R3j-2). */
describe('other analysed bodies (R3j-2)', () => {
  const withRib = () => {
    const { cad, doc } = simulationFixture();
    const v = structuredClone(cad);
    const plate = v.bodies.find((b) => b.id === 'plate')!;
    v.bodies.push({ ...structuredClone(plate), id: 'rib', resultFeatureId: 'rib-extrude' });
    const ribFace = (name: string) => ({
      kind: 'face' as const,
      body: 'rib',
      ref: faceRef('rib-extrude', ['rib-extrude', name], [0, 25, 2.5], 250),
    });
    return { cad: v, doc, ribFace };
  };
  it('adds a body with its material and idealisation, as schema 2, and checks it on the source', () => {
    const { cad, doc, ribFace } = withRib();
    const two = applySimulationOperation(doc, {
      type: 'addBody',
      body: { bodyId: 'rib', materialId: null },
    });
    expect(two.schemaVersion).toBe(2);
    expect(two.bodies).toEqual([{ bodyId: 'rib', materialId: null }]);
    const set = [
      { type: 'setBodyMaterial', bodyId: 'rib', materialId: 'steel' },
      { type: 'setBodyIdealisation', bodyId: 'rib', idealisation: 'shell' },
    ] as const;
    const held = set.reduce(applySimulationOperation, two);
    expect(held.bodies).toEqual([{ bodyId: 'rib', materialId: 'steel', idealisation: 'shell' }]);
    expect(
      applySimulationOperation(held, {
        type: 'setBodyIdealisation',
        bodyId: 'rib',
        idealisation: null,
      }).bodies,
    ).toEqual([{ bodyId: 'rib', materialId: 'steel' }]);
    // A target on the rib names the rib's result feature.
    const pinned = applySimulationOperation(held, {
      type: 'addConstraint',
      constraint: { id: 'rib-pin', name: 'Rib', kind: 'pinned', targets: [ribFace('side:1')] },
    });
    expect(checkSimulationSource(pinned, cad)).toEqual([]);
    const wrong = structuredClone(pinned);
    wrong.constraints[1]!.targets[0]!.ref.featureId = 'plate-extrude';
    expect(checkSimulationSource(wrong, cad).map((d) => [d.code, d.path])).toEqual([
      ['target-feature', '$.constraints[1].targets[0].ref.featureId'],
    ]);
    const gone = { ...pinned, bodies: [{ bodyId: 'gone', materialId: null }] };
    expect(checkSimulationSource(gone, cad).map((d) => [d.code, d.path])).toEqual([
      ['source-body-missing', '$.bodies[0].bodyId'],
    ]);
    expect(
      checkSimulationSource({ ...pinned, bodies: [{ bodyId: 'hole', materialId: null }] }, cad).map(
        (d) => d.code,
      ),
    ).toContain('source-body-consumed');
    // In use: the body while a target is on it, a material while a body uses it.
    expect(
      refused(() => applySimulationOperation(pinned, { type: 'removeBody', bodyId: 'rib' })),
    ).toEqual(['body-in-use']);
    expect(
      refused(() =>
        applySimulationOperation(
          applySimulationOperation(held, { type: 'setBodyMaterial', materialId: null }),
          { type: 'removeMaterial', id: 'steel' },
        ),
      ),
    ).toEqual(['material-in-use']);
    const alone = applySimulationOperation(held, { type: 'removeBody', bodyId: 'rib' });
    expect(alone.bodies).toBeUndefined();
    expect(
      refused(() => applySimulationOperation(alone, { type: 'removeBody', bodyId: 'rib' })),
    ).toEqual(['not-found']);
    // A version switch renames each body's targets to its own result feature.
    const next = applySimulationOperation(pinned, {
      type: 'setSource',
      source: { ...pinned.source, versionId: 'v2' },
      resultFeatureId: 'plate-v2',
      bodyResultFeatureIds: [{ bodyId: 'rib', featureId: 'rib-v2' }],
    });
    expect(next.constraints.map((c) => c.targets[0]!.ref.featureId)).toEqual([
      'plate-v2',
      'rib-v2',
    ]);
  });
  it('refuses bodies in schema 1 and malformed bodies and target bodies in schema 2', () => {
    expect(mutate((d) => (d.bodies = [{ bodyId: 'rib', materialId: null }]))).toEqual([
      'unknown-key',
    ]);
    expect(mutate((d) => (d.constraints[0].targets[0].body = 'rib'))).toContain('unknown-key');
    const two = (f: (d: Loose) => void) =>
      mutate((d) => {
        d.schemaVersion = 2;
        f(d);
      });
    expect(two(() => {})).toEqual([]);
    expect(two((d) => (d.bodies = []))).toEqual(['bodies-empty']);
    expect(two((d) => (d.bodies = [{ bodyId: 'plate', materialId: null }]))).toEqual([
      'body-is-source',
    ]);
    expect(
      two(
        (d) =>
          (d.bodies = [
            { bodyId: 'rib', materialId: null },
            { bodyId: 'rib', materialId: null },
          ]),
      ),
    ).toEqual(['duplicate-body']);
    expect(two((d) => (d.bodies = [{ bodyId: 'rib', materialId: 'nope' }]))).toEqual([
      'material-missing',
    ]);
    expect(
      two((d) => (d.bodies = [{ bodyId: 'rib', materialId: null, idealisation: 'beam' }])),
    ).toEqual(['value']);
    expect(two((d) => (d.bodies = [{ bodyId: 'rib', materialId: null, colour: 1 }]))).toContain(
      'unknown-key',
    );
    expect(two((d) => (d.constraints[0].targets[0].body = 'rib'))).toEqual(['target-body']);
    expect(
      two((d) => {
        d.bodies = [{ bodyId: 'rib', materialId: null }];
        d.constraints[0].targets[0].body = 'rib';
      }),
    ).toEqual([]);
    expect(
      two(
        (d) =>
          (d.bodies = Array.from({ length: 64 }, (_, i) => ({
            bodyId: `b${i}`,
            materialId: null,
          }))),
      ),
    ).toEqual(['limit-exceeded']);
  });
});

/** TS-1450 (ST-230#1, #2): bonds between the analysed bodies (R3j-4). */
describe('bonds between analysed bodies (R3j-4)', () => {
  const ribFace = (name: string) => ({
    kind: 'face' as const,
    body: 'rib',
    ref: faceRef('rib-extrude', ['rib-extrude', name], [0, 25, 2.5], 250),
  });
  const plateFace = () => structuredClone(simulationFixture().doc.constraints[0]!.targets[0]!);
  const bonded = () => {
    const { doc } = simulationFixture();
    const two = applySimulationOperation(doc, {
      type: 'addBody',
      body: { bodyId: 'rib', materialId: 'steel' },
    });
    return applySimulationOperation(two, {
      type: 'addBond',
      bond: {
        id: 'rib-bond',
        name: 'Rib to plate',
        follower: [ribFace('side:0')],
        on: [plateFace()],
        tolerance: 0.1,
      },
    });
  };
  it('adds, edits and removes a bond, whose targets hold the bodies and follow a version switch', () => {
    const doc = bonded();
    expect(doc.schemaVersion).toBe(2);
    expect(doc.bonds).toHaveLength(1);
    expect(freshSimulationId(doc, 'rib-bond')).toBe('rib-bond-2');
    expect(
      refused(() => applySimulationOperation(doc, { type: 'removeBody', bodyId: 'rib' })),
    ).toEqual(['body-in-use']);
    const edited = applySimulationOperation(doc, {
      type: 'updateBond',
      bond: { ...doc.bonds![0]!, tolerance: 0.5 },
    });
    expect(edited.bonds![0]!.tolerance).toBe(0.5);
    const renamed = applySimulationOperation(doc, {
      type: 'rename',
      collection: 'bonds',
      id: 'rib-bond',
      name: 'Rib',
    });
    expect(renamed.bonds![0]!.name).toBe('Rib');
    const next = applySimulationOperation(doc, {
      type: 'setSource',
      source: { ...doc.source, versionId: 'v2' },
      resultFeatureId: 'plate-v2',
      bodyResultFeatureIds: [{ bodyId: 'rib', featureId: 'rib-v2' }],
    });
    expect(next.bonds![0]!.follower[0]!.ref.featureId).toBe('rib-v2');
    expect(next.bonds![0]!.on[0]!.ref.featureId).toBe('plate-v2');
    const gone = applySimulationOperation(doc, { type: 'removeBond', id: 'rib-bond' });
    expect(gone.bonds).toBeUndefined();
    expect(gone.retiredIds).toContain('rib-bond');
    expect(
      applySimulationOperation(gone, { type: 'removeBody', bodyId: 'rib' }).bodies,
    ).toBeUndefined();
    // A re-selection may name a bond's target.
    const override = {
      owner: 'rib-bond',
      target: doc.bonds![0]!.on[0]!,
      versionId: 'v1',
      preparationHash: 'p',
      kernelBuild: 'k',
      chosen: [0],
    };
    expect(applySimulationOperation(doc, { type: 'setOverride', override }).overrides).toHaveLength(
      1,
    );
  });
  it('refuses bonds in schema 1, an empty list, a side on two bodies and a bad tolerance', () => {
    const doc = bonded();
    const check = (f: (d: Loose) => void) => {
      const d = structuredClone(doc) as Loose;
      f(d);
      return codes(d);
    };
    expect(check(() => {})).toEqual([]);
    expect(check((d) => (d.schemaVersion = 1))).toContain('unknown-key');
    expect(check((d) => (d.bonds = []))).toEqual(['bonds-empty']);
    expect(check((d) => d.bonds[0].follower.push(plateFace()))).toEqual(['bond-side-body']);
    expect(check((d) => (d.bonds[0].on = []))).toEqual(['targets-empty']);
    expect(check((d) => (d.bonds[0].tolerance = 0))).toEqual(['value']);
    expect(check((d) => (d.bonds[0].id = 'steel'))).toEqual(['duplicate-id']);
    expect(check((d) => (d.bonds[0].colour = 1))).toContain('unknown-key');
  });
});

describe('sheet bodies analysed at a thickness (CR5e)', () => {
  /** The fixture's version with the plate made a sheet and a rib solid beside it. */
  const sheetCad = () => {
    const { cad, doc } = simulationFixture();
    const v = structuredClone(cad);
    const plate = v.bodies.find((b) => b.id === 'plate')!;
    plate.kind = 'sheet';
    v.bodies.push({
      ...structuredClone(plate),
      id: 'rib',
      kind: 'solid',
      resultFeatureId: 'rib-extrude',
    });
    return { cad: v, doc };
  };
  it('sets, edits and takes away a sheet thickness, and the source check asks for one', () => {
    // TS-1572 (ST-269#3).
    const { cad, doc } = sheetCad();
    expect(checkSimulationSource(doc, cad).map((d) => [d.code, d.path])).toEqual([
      ['source-body-kind', '$.source.bodyId'],
    ]);
    const set = applySimulationOperation(doc, {
      type: 'setSheetThickness',
      bodyId: 'plate',
      thicknessMm: 0.8,
    });
    expect(set.schemaVersion).toBe(2);
    expect(set.sheets).toEqual([{ bodyId: 'plate', thicknessMm: 0.8 }]);
    expect(validateSimulation(set)).toEqual([]);
    expect(checkSimulationSource(set, cad)).toEqual([]);
    const edited = applySimulationOperation(set, {
      type: 'setSheetThickness',
      bodyId: 'plate',
      thicknessMm: 1.2,
    });
    expect(edited.sheets).toEqual([{ bodyId: 'plate', thicknessMm: 1.2 }]);
    expect(
      applySimulationOperation(edited, {
        type: 'setSheetThickness',
        bodyId: 'plate',
        thicknessMm: null,
      }).sheets,
    ).toBeUndefined();
    // A thickness for a solid, or for a body not analysed, is refused by the source check.
    const onRib = applySimulationOperation(set, {
      type: 'setSheetThickness',
      bodyId: 'rib',
      thicknessMm: 1,
    });
    expect(checkSimulationSource(onRib, cad).map((d) => [d.code, d.path])).toEqual([
      ['sheet-body', '$.sheets[1].bodyId'],
    ]);
    const analysed = applySimulationOperation(onRib, {
      type: 'addBody',
      body: { bodyId: 'rib', materialId: 'steel' },
    });
    expect(checkSimulationSource(analysed, cad).map((d) => d.message)).toEqual([
      'not a sheet body',
    ]);
    // Removing a body takes its thickness with it.
    expect(
      applySimulationOperation(analysed, { type: 'removeBody', bodyId: 'rib' }).sheets,
    ).toEqual([{ bodyId: 'plate', thicknessMm: 0.8 }]);
  });
  it('refuses sheets in schema 1, an empty list, a body twice and a bad thickness', () => {
    const { doc } = sheetCad();
    const set = applySimulationOperation(doc, {
      type: 'setSheetThickness',
      bodyId: 'plate',
      thicknessMm: 1,
    });
    const check = (f: (d: Loose) => void) => {
      const d = structuredClone(set) as Loose;
      f(d);
      return codes(d);
    };
    expect(check(() => {})).toEqual([]);
    expect(check((d) => (d.schemaVersion = 1))).toContain('unknown-key');
    expect(check((d) => (d.sheets = []))).toEqual(['sheets-empty']);
    expect(check((d) => d.sheets.push({ bodyId: 'plate', thicknessMm: 2 }))).toEqual(['sheet']);
    expect(check((d) => (d.sheets[0].thicknessMm = 0))).toEqual(['value']);
    expect(check((d) => (d.sheets[0].thicknessMm = 101))).toEqual(['value']);
    expect(check((d) => (d.sheets[0].bodyId = ''))).toEqual(['sheet']);
    expect(check((d) => (d.sheets[0].side = 'front'))).toContain('unknown-key');
  });
});

describe('spot welds taken from the CAD version (CR5b)', () => {
  const ribFace = (name: string) => ({
    kind: 'face' as const,
    body: 'rib',
    ref: faceRef('rib-extrude', ['rib-extrude', name], [0, 25, 2.5], 250),
  });
  const plateFace = () => structuredClone(simulationFixture().doc.constraints[0]!.targets[0]!);
  const welded = () => {
    const { doc } = simulationFixture();
    const two = applySimulationOperation(doc, {
      type: 'addBody',
      body: { bodyId: 'rib', materialId: 'steel' },
    });
    return applySimulationOperation(two, {
      type: 'addSpotWeld',
      weld: {
        id: 'rib-welds',
        name: 'Rib welds',
        weldId: 'row-1',
        follower: [ribFace('side:0')],
        on: [plateFace()],
        radiusMm: 3,
        tolerance: 2.1,
      },
    });
  };
  it('adds, edits and removes a weld, whose flanges hold the bodies and follow a version switch', () => {
    // TS-1562 (ST-268#4).
    const doc = welded();
    expect(doc.schemaVersion).toBe(2);
    expect(validateSimulation(doc)).toEqual([]);
    expect(
      refused(() => applySimulationOperation(doc, { type: 'removeBody', bodyId: 'rib' })),
    ).toEqual(['body-in-use']);
    const edited = applySimulationOperation(doc, {
      type: 'updateSpotWeld',
      weld: { ...doc.spotWelds![0]!, radiusMm: 4 },
    });
    expect(edited.spotWelds![0]!.radiusMm).toBe(4);
    const next = applySimulationOperation(doc, {
      type: 'setSource',
      source: { ...doc.source, versionId: 'v2' },
      resultFeatureId: 'plate-v2',
      bodyResultFeatureIds: [{ bodyId: 'rib', featureId: 'rib-v2' }],
    });
    expect(next.spotWelds![0]!.follower[0]!.ref.featureId).toBe('rib-v2');
    expect(next.spotWelds![0]!.on[0]!.ref.featureId).toBe('plate-v2');
    // Its ID is taken: a load cannot reuse it.
    expect(freshSimulationId(doc, 'rib-welds')).toBe('rib-welds-2');
    const gone = applySimulationOperation(doc, { type: 'removeSpotWeld', id: 'rib-welds' });
    expect(gone.spotWelds).toBeUndefined();
    expect(gone.retiredIds).toContain('rib-welds');
    expect(
      applySimulationOperation(gone, { type: 'removeBody', bodyId: 'rib' }).bodies,
    ).toBeUndefined();
  });
  it('refuses welds in schema 1, an empty list, a row taken twice, two faces and a bad radius', () => {
    const doc = welded();
    const check = (f: (d: Loose) => void) => {
      const d = structuredClone(doc) as Loose;
      f(d);
      return codes(d);
    };
    expect(check(() => {})).toEqual([]);
    expect(check((d) => (d.schemaVersion = 1))).toContain('unknown-key');
    expect(check((d) => (d.spotWelds = []))).toEqual(['spot-welds-empty']);
    expect(
      check((d) => d.spotWelds.push({ ...structuredClone(d.spotWelds[0]), id: 'again' })),
    ).toEqual(['spot-weld-row']);
    expect(check((d) => d.spotWelds[0].on.push(plateFace()))).toContain('spot-weld-flange');
    expect(check((d) => (d.spotWelds[0].radiusMm = 0))).toEqual(['value']);
    expect(check((d) => (d.spotWelds[0].radiusMm = 51))).toEqual(['value']);
    expect(check((d) => (d.spotWelds[0].tolerance = -1))).toEqual(['value']);
    expect(check((d) => (d.spotWelds[0].weldId = ''))).toEqual(['spot-weld-row']);
    expect(check((d) => (d.spotWelds[0].id = 'steel'))).toEqual(['duplicate-id']);
    expect(check((d) => (d.spotWelds[0].pitch = 1))).toContain('unknown-key');
  });
});
