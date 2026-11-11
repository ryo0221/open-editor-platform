import { describe, expect, it } from 'vitest';
import type { CadSolvedPose } from './assembly';
import { resolveSpurGear, spurGearFlankEnd, spurGearHalfAngle, spurGearRadii } from './gear';
import {
  checkGearMesh,
  gearMeshProblems,
  gearTrainRatios,
  type CadGearMeshSide,
} from './gear-mesh';
import { parameterValues } from './graph';
import { coupledJointValues } from './joints';
import { position, type CadDocument } from './model';
import { cadBuilder } from './builder';
import { fixtureKernel } from './fixtures';
import { applyCadOperation } from './operations';
import { compareCad } from './diff';
import { validateCad } from './validation';
import { f70GearTrain } from './watch-fixtures';
import { fixtureComponent } from './assembly-fixtures';
import { fixtureConnector, fixtureJoint } from './joints-fixtures';

describe('F70 gear train in mesh (WM2b, ST-443, TS-1888)', () => {
  it('turns the fourth wheel sixty times for one turn of the centre wheel', () => {
    const { assembly } = f70GearTrain();
    const third = assembly.joints.find((j) => j.id === 'j-third')!;
    const fourth = assembly.joints.find((j) => j.id === 'j-fourth')!;
    expect(third.couplings![0]!.ratio).toBeCloseTo(-8, 12);
    expect(fourth.couplings![0]!.ratio).toBeCloseTo(-7.5, 12);
    expect(third.values.angle).toBeUndefined();
    const doc = structuredClone(assembly);
    doc.joints[0]!.values = { angle: { literalRad: 2 * Math.PI } };
    const v = coupledJointValues(doc, parameterValues(doc));
    // Two external meshes: the fourth wheel turns the centre wheel's way, 60 times.
    const start = coupledJointValues(assembly, parameterValues(assembly));
    const moved = (id: string) => (v.get(id)!.angle! - start.get(id)!.angle!) / (2 * Math.PI);
    expect(moved('j-third')).toBeCloseTo(-8, 9);
    expect(moved('j-fourth')).toBeCloseTo(60, 9);
  });

  it('keeps every tooth facing a gap after many turns of the centre wheel', () => {
    const { assembly, solve, lookup } = f70GearTrain();
    for (const turns of [0, 0.37, 10.25, 123.456]) {
      const doc = structuredClone(assembly);
      doc.joints[0]!.values = { angle: { literalRad: turns * 2 * Math.PI } };
      const solved = solve(doc);
      doc.solvedPoses = solved.poses;
      expect(gearMeshProblems(doc, solved, lookup)).toEqual(new Map());
      // Registering again where they stand gives the stored coupling: no turn is needed.
      for (const mesh of doc.gearMeshes!) {
        const check = checkGearMesh(doc, mesh, solved, lookup);
        if (check.status !== 'ok') throw new Error(JSON.stringify(check));
        const stored = doc.joints.find((j) => j.id === mesh.driven.joint)!.couplings![0]!;
        expect(check.coupling.ratio).toBeCloseTo(stored.ratio, 12);
        expect(check.coupling.offset).toBeCloseTo(stored.offset, 6);
      }
    }
  });

  it('never puts a tooth of one gear inside the other, turned on and on', () => {
    const { assembly, solve, versions } = f70GearTrain();
    // Each gear's centre, tooth-0 angle and spec in the plate's plane (all axes are +z).
    const gear = (
      doc: CadDocument,
      poses: Record<string, CadSolvedPose>,
      side: CadGearMeshSide,
    ) => {
      const joint = doc.joints.find((j) => j.id === side.joint)!;
      const content = [...Object.values(versions)].find((v) =>
        v.content.features.some((f) => f.id === side.feature),
      )!.content;
      const f = content.features.find((x) => x.id === side.feature)!;
      if (f.type !== 'spurGear') throw new Error('no gear');
      const pose = poses[joint.child.componentId]!;
      const q = pose.rotation;
      return {
        spec: resolveSpurGear(f.args, parameterValues(content)),
        c: [pose.translationMm[0], pose.translationMm[1]] as const,
        a: 2 * Math.atan2(q[2], q[3]),
      };
    };
    type G = ReturnType<typeof gear>;
    // Inside the tooth material, from the profile's own half angle at each radius.
    const inside = (g: G, x: number, y: number) => {
      const r = Math.hypot(x - g.c[0], y - g.c[1]);
      const { root } = spurGearRadii(g.spec);
      const end = spurGearFlankEnd(g.spec).radius;
      if (r <= root) return true;
      if (r >= end) return false;
      const pitch = (2 * Math.PI) / g.spec.teeth;
      const t = Math.atan2(y - g.c[1], x - g.c[0]) - g.a;
      const off = Math.abs(t - pitch * Math.round(t / pitch));
      return off < spurGearHalfAngle(g.spec, r) - 1e-4 / r;
    };
    const flankPoints = (g: G) => {
      const { root } = spurGearRadii(g.spec);
      const end = spurGearFlankEnd(g.spec).radius;
      const pts: [number, number][] = [];
      for (let k = 0; k < g.spec.teeth; k++)
        for (let i = 1; i < 40; i++) {
          const r = root + ((end - root) * i) / 40;
          const h = spurGearHalfAngle(g.spec, r);
          for (const s of [-1, 1]) {
            const t = g.a + (2 * Math.PI * k) / g.spec.teeth + s * h;
            pts.push([g.c[0] + r * Math.cos(t), g.c[1] + r * Math.sin(t)]);
          }
        }
      return pts;
    };
    for (const turns of [0, 0.013, 0.37, 10.25, 77.7]) {
      const doc = structuredClone(assembly);
      doc.joints[0]!.values = { angle: { literalRad: turns * 2 * Math.PI } };
      const { poses } = solve(doc);
      for (const mesh of doc.gearMeshes!) {
        const a = gear(doc, poses, mesh.driver);
        const b = gear(doc, poses, mesh.driven);
        const into = [
          ...flankPoints(b).filter(([x, y]) => inside(a, x, y)),
          ...flankPoints(a).filter(([x, y]) => inside(b, x, y)),
        ];
        expect({ mesh: mesh.id, turns, into: into.length }).toEqual({
          mesh: mesh.id,
          turns,
          into: 0,
        });
      }
    }
    // Half a pitch off, the same pinion's teeth would cut into the wheel.
    const off = structuredClone(assembly);
    off.joints.find((j) => j.id === 'j-third')!.couplings![0]!.offset += Math.PI / 10;
    const { poses } = solve(off);
    const mesh = off.gearMeshes![0]!;
    const a = gear(off, poses, mesh.driver);
    expect(flankPoints(gear(off, poses, mesh.driven)).some(([x, y]) => inside(a, x, y))).toBe(true);
  });

  it('meshes a pinion half a pitch from where it stands', () => {
    const { assembly, solve, lookup } = f70GearTrain();
    const mesh = assembly.gearMeshes![0]!;
    const check = checkGearMesh(assembly, mesh, solve(assembly), lookup);
    if (check.status !== 'ok') throw new Error('no mesh');
    // With the centre wheel's tooth 0 on the line of centres, the pinion's gap faces it: tooth 0
    // of the pinion half a leaf from pointing back at the wheel (2π/10 / 2 off π).
    const offset = check.coupling.offset;
    const pitch = (2 * Math.PI) / 10;
    const rel = (((offset - Math.PI) % pitch) + pitch) % pitch;
    expect(Math.min(rel, pitch - rel)).toBeCloseTo(pitch / 2, 9);
  });

  it('lists a wrong centre distance, module, axis or teeth, and never meshes them', () => {
    const { assembly, solve, lookup, versions } = f70GearTrain();
    const moved = structuredClone(assembly);
    const j = moved.joints.find((x) => x.id === 'j-third')!;
    j.parent.offset.translation = [{ literalMm: 4.51 }, { literalMm: 0 }, { literalMm: 0 }];
    let solved = solve(moved);
    moved.solvedPoses = solved.poses;
    expect(gearMeshProblems(moved, solved, lookup).get('mesh-centre-third')).toEqual([
      { code: 'gear-mesh-distance', distanceMm: 4.51, expectedMm: 4.5 },
    ]);
    // A tilted arbor: its axis is not the others'.
    const tilted = structuredClone(assembly);
    tilted.joints.find((x) => x.id === 'j-fourth')!.parent.offset.rotation = [
      Math.sin(0.01),
      0,
      0,
      Math.cos(0.01),
    ];
    solved = solve(tilted);
    expect(
      gearMeshProblems(tilted, solved, lookup)
        .get('mesh-third-fourth')!
        .map((p) => p.code),
    ).toContain('gear-mesh-axes');
    // A pinion of another module, and a stored ratio the teeth no longer give.
    const other = structuredClone(versions.fourth.content);
    const g = other.features.find((f) => f.type === 'spurGear')!;
    if (g.type === 'spurGear') g.args.module = { literalMm: 0.12 };
    const look = (h: string) => (h === versions.fourth.contentHash ? other : lookup(h));
    expect(
      gearMeshProblems(assembly, solve(assembly), look)
        .get('mesh-third-fourth')!
        .map((p) => p.code),
    ).toContain('gear-mesh-module');
    const stale = structuredClone(assembly);
    stale.joints.find((x) => x.id === 'j-fourth')!.couplings![0]!.ratio = -7;
    expect(gearMeshProblems(stale, solve(stale), lookup).get('mesh-third-fourth')).toEqual([
      { code: 'gear-mesh-ratio' },
    ]);
    // A face the other gear does not reach along the axis.
    const high = structuredClone(assembly);
    high.joints.find((x) => x.id === 'j-fourth')!.parent.offset.translation[2] = {
      literalMm: 0.9,
    };
    expect(
      gearMeshProblems(high, solve(high), lookup)
        .get('mesh-third-fourth')!
        .map((p) => p.code),
    ).toEqual(['gear-mesh-face']);
  });

  it('refuses a mesh without its coupling, a joint driven twice, or not revolute; removes and prunes', () => {
    const { assembly } = f70GearTrain();
    const errors = (d: unknown) =>
      validateCad(d)
        .filter((x) => x.severity === 'error')
        .map((x) => [x.code, x.path]);
    expect(errors(assembly)).toEqual([]);
    const bare = structuredClone(assembly);
    delete bare.joints.find((x) => x.id === 'j-third')!.couplings;
    bare.joints.find((x) => x.id === 'j-third')!.values = { angle: { literalRad: 0 } };
    expect(errors(bare)).toEqual([['gear-mesh-coupling', '$.gearMeshes[0].driven.joint']]);
    const twice = structuredClone(assembly);
    twice.gearMeshes!.push({ ...twice.gearMeshes![0]!, id: 'mesh-again' });
    expect(errors(twice)).toContainEqual([
      'gear-mesh-driven-twice',
      '$.gearMeshes[2].driven.joint',
    ]);
    const self = structuredClone(assembly);
    self.gearMeshes![0]!.driven.joint = 'j-centre';
    expect(errors(self).map(([c]) => c)).toContain('gear-mesh-joint');
    // Removed: the pinion keeps the angle it had, as its own value.
    const removed = applyCadOperation(assembly, {
      type: 'removeGearMesh',
      meshId: 'mesh-centre-third',
      angle: 0.5,
    });
    expect(removed.gearMeshes!.map((m) => m.id)).toEqual(['mesh-third-fourth']);
    const third = removed.joints.find((x) => x.id === 'j-third')!;
    expect(third.couplings).toBeUndefined();
    expect(third.values.angle).toEqual({ literalRad: 0.5 });
    expect(errors(removed)).toEqual([]);
    // Deleting a joint takes its meshes.
    const gone = applyCadOperation(assembly, {
      type: 'deleteClosure',
      ids: ['j-fourth'],
      cascade: true,
    });
    expect(gone.gearMeshes!.map((m) => m.id)).toEqual(['mesh-centre-third']);
  });
});

describe('gear train ratios (WM2c, ST-444, TS-1889)', () => {
  it('lists the turns each wheel makes for one turn of the centre wheel', () => {
    const { assembly } = f70GearTrain();
    expect(
      gearTrainRatios(assembly, 'j-centre').map((r) => [r.joint, Math.round(r.ratio * 1e9) / 1e9]),
    ).toEqual([
      ['j-third', -8],
      ['j-fourth', 60],
    ]);
    expect(gearTrainRatios(assembly, 'j-third').map((r) => r.joint)).toEqual(['j-fourth']);
    expect(gearTrainRatios(assembly, 'j-fourth')).toEqual([]);
  });

  it('follows a chain through a second angle of a universal joint', () => {
    const joint = (id: string, couplings?: unknown) =>
      ({ id, ...(couplings ? { couplings } : {}) }) as CadDocument['joints'][number];
    const doc = {
      joints: [
        joint('driver'),
        joint('mid', [
          { of: 'angle2', from: { joint: 'driver', of: 'angle' }, ratio: 2, offset: 0 },
        ]),
        joint('follower', [
          { of: 'angle', from: { joint: 'mid', of: 'angle2' }, ratio: 3, offset: 0 },
        ]),
      ],
    };
    expect(gearTrainRatios(doc, 'driver')).toEqual([
      { joint: 'mid', of: 'angle2', ratio: 2 },
      { joint: 'follower', of: 'angle', ratio: 6 },
    ]);
  });
});

describe('gear mesh review fixes (WM2b, TS-1888)', () => {
  // The third wheel as one body: pinion and wheel joined, then the joined body turned.
  const joinedThird = (turnDeg: number) => {
    const b = cadBuilder(fixtureKernel);
    const gear = (name: string, teeth: number, mating: number, z: number, width: number) =>
      b.spurGear(name, {
        profile: 'cycloidal',
        module: 0.1,
        teeth,
        matingTeeth: mating,
        faceWidth: width,
        bore: 0.2,
        origin: [0, 0, z],
      });
    const pinion = gear('Third pinion', 10, 80, 0, 0.5);
    const wheel = gear('Third wheel', 75, 10, 0.5, 0.3);
    b.boolean(pinion, [wheel], 'union', 'Third');
    const half = (turnDeg * Math.PI) / 360;
    return applyCadOperation(b.build().document, {
      type: 'transformBody',
      bodyId: pinion,
      translation: position(0, 0, 0),
      rotation: [0, 0, Math.sin(half), Math.cos(half)],
    });
  };
  const withThird = (content: CadDocument) => {
    const f70 = f70GearTrain();
    const old = f70.versions.third;
    const doc = structuredClone(f70.assembly);
    // Same feature IDs: the meshes keep naming them.
    const lookup = (h: string) => (h === old.contentHash ? content : f70.lookup(h));
    for (const m of doc.gearMeshes!)
      for (const side of [m.driver, m.driven])
        if (old.content.features.some((f) => f.id === side.feature))
          side.feature = content.features.find(
            (f) =>
              f.type === 'spurGear' &&
              f.name === old.content.features.find((x) => x.id === side.feature)!.name,
          )!.id;
    return { doc, lookup, solve: f70.solve };
  };

  it('follows a Boolean and the joined body’s placement, and reports a phase turned out of mesh', () => {
    // Two leaves (72°) is fifteen wheel teeth too: still in mesh.
    for (const [turn, phase] of [
      [0, false],
      [72, false],
      [18, true],
    ] as const) {
      const { doc, lookup, solve } = withThird(joinedThird(turn));
      const problems = gearMeshProblems(doc, solve(doc), lookup);
      expect([turn, [...problems.values()].flat().map((p) => p.code)]).toEqual([
        turn,
        phase ? ['gear-mesh-phase', 'gear-mesh-phase'] : [],
      ]);
    }
  });

  it('refuses tips reaching the other root, and cycloidal teeth too thick for each other', () => {
    const { assembly, solve, lookup, versions } = f70GearTrain();
    const swap = (edit: (args: Record<string, unknown>) => void) => {
      const other = structuredClone(versions.fourth.content);
      const g = other.features.find((f) => f.type === 'spurGear')!;
      if (g.type === 'spurGear') edit(g.args as unknown as Record<string, unknown>);
      return (h: string) => (h === versions.fourth.contentHash ? other : lookup(h));
    };
    const codes = (look: (h: string) => CadDocument | undefined) =>
      gearMeshProblems(assembly, solve(assembly), look)
        .get('mesh-third-fourth')
        ?.map((p) => p.code);
    // A full-thickness leaf (F70's are 0.4 of the pitch) keeps its land up to a long addendum.
    expect(codes(swap((a) => ((a.addendum = 2), (a.toothThickness = 0.5))))).toContain(
      'gear-mesh-clearance',
    );
    // 0.5 + 0.55 of the pitch: the teeth cannot pass each other.
    expect(codes(swap((a) => (a.toothThickness = 0.55)))).toEqual(['gear-mesh-backlash']);
    const thick = f70GearTrain();
    const wheel = thick.versions.third.content.features.find((f) => f.name === 'Third wheel')!;
    if (wheel.type === 'spurGear') wheel.args.toothThickness = 0.6;
    expect(codes(swap((a) => (a.toothThickness = 0.4)))).toBeUndefined();
    const both = (h: string) => {
      if (h === thick.versions.third.contentHash) return thick.versions.third.content;
      return swap((a) => (a.toothThickness = 0.45))(h);
    };
    expect(
      gearMeshProblems(thick.assembly, thick.solve(thick.assembly), both)
        .get('mesh-third-fourth')
        ?.map((p) => p.code),
    ).toContain('gear-mesh-backlash');
  });

  it('lets both sides of a mesh name one feature of a shared part version', () => {
    const { assembly } = f70GearTrain();
    const shared = structuredClone(assembly);
    shared.gearMeshes![1]!.driven.feature = shared.gearMeshes![1]!.driver.feature;
    expect(validateCad(shared).filter((d) => d.code === 'duplicate-id')).toEqual([]);
  });
});

describe('gear mesh review fixes, round 2 (WM2b, TS-1888)', () => {
  it('refuses a cycloidal gear made for another partner', () => {
    const { assembly, solve, lookup, versions } = f70GearTrain();
    const other = structuredClone(versions.fourth.content);
    const g = other.features.find((f) => f.type === 'spurGear')!;
    if (g.type === 'spurGear') g.args.matingTeeth = { literal: 80 };
    const look = (h: string) => (h === versions.fourth.contentHash ? other : lookup(h));
    expect(
      gearMeshProblems(assembly, solve(assembly), look)
        .get('mesh-third-fourth')
        ?.map((p) => p.code),
    ).toEqual(['gear-mesh-mating']);
  });

  it('does not read a gear through a reflection that replaces it', () => {
    const { assembly, solve, lookup, versions } = f70GearTrain();
    const other = structuredClone(versions.fourth.content);
    const body = other.bodies[0]!;
    const placement = body.resultFeatureId;
    other.features.push({
      id: 'flip',
      name: 'Flip',
      type: 'mirror',
      inputFeatureIds: [placement],
      args: { plane: { origin: position(0, 0, 0), normal: [0, 0, 1] }, union: false },
    } as CadDocument['features'][number]);
    body.resultFeatureId = 'flip';
    const look = (h: string) => (h === versions.fourth.contentHash ? other : lookup(h));
    expect(
      gearMeshProblems(assembly, solve(assembly), look)
        .get('mesh-third-fourth')
        ?.map((p) => [p.code, p.side]),
    ).toEqual([['gear-mesh-placement', 'driven']]);
  });

  it('drops a mesh whose driven joint goes with its mount', () => {
    const { assembly } = f70GearTrain();
    const doc = structuredClone(assembly);
    const fourth = doc.joints.find((j) => j.id === 'j-fourth')!;
    const spare = structuredClone(fourth);
    spare.id = 'j-fourth-spare';
    spare.name = 'j-fourth-spare';
    delete spare.couplings;
    spare.values = { angle: { literalRad: 0 } };
    doc.joints.push(spare);
    doc.mounts = [
      {
        id: 'mount-fourth',
        name: 'Fourth',
        component: 'c-fourth',
        joints: ['j-fourth', 'j-fourth-spare'],
        active: 'j-fourth-spare',
      },
    ];
    expect(validateCad(doc).filter((d) => d.severity === 'error')).toEqual([]);
    const next = applyCadOperation(doc, { type: 'removeMount', mountId: 'mount-fourth' });
    expect(next.joints.map((j) => j.id)).not.toContain('j-fourth');
    expect(next.gearMeshes!.map((m) => m.id)).toEqual(['mesh-centre-third']);
  });

  it('does not read a gear that only cuts a hole', () => {
    const { assembly, solve, lookup, versions } = f70GearTrain();
    const b = cadBuilder(fixtureKernel);
    const plate = b.box('Plate', { size: [3, 3, 1], origin: [-1.5, -1.5, 0] });
    const gear = b.spurGear('Fourth pinion', {
      profile: 'cycloidal',
      module: 0.1,
      teeth: 10,
      matingTeeth: 75,
      faceWidth: 1,
      bore: 0.2,
    });
    b.boolean(plate, [gear], 'cut');
    const other = b.build().document;
    const doc = structuredClone(assembly);
    doc.gearMeshes![1]!.driven.feature = other.features.find((f) => f.type === 'spurGear')!.id;
    const look = (h: string) => (h === versions.fourth.contentHash ? other : lookup(h));
    expect(
      gearMeshProblems(doc, solve(doc), look)
        .get('mesh-third-fourth')
        ?.map((p) => [p.code, p.side]),
    ).toEqual([['gear-mesh-gear', 'driven']]);
  });

  it('refuses an inactive mount candidate', () => {
    const { assembly, solve, lookup } = f70GearTrain();
    const doc = structuredClone(assembly);
    const spare = structuredClone(doc.joints.find((j) => j.id === 'j-fourth')!);
    spare.id = 'j-fourth-spare';
    spare.name = 'j-fourth-spare';
    delete spare.couplings;
    spare.values = { angle: { literalRad: 0 } };
    doc.joints.push(spare);
    doc.mounts = [
      {
        id: 'mount-fourth',
        name: 'Fourth',
        component: 'c-fourth',
        joints: ['j-fourth', 'j-fourth-spare'],
        active: 'j-fourth-spare',
      },
    ];
    expect(
      gearMeshProblems(doc, solve(doc), lookup)
        .get('mesh-third-fourth')
        ?.map((p) => [p.code, p.side]),
    ).toEqual([['gear-mesh-inactive', 'driven']]);
  });

  it('refuses a joint whose frame rides on the other gear', () => {
    const { assembly, solve, lookup } = f70GearTrain();
    const doc = structuredClone(assembly);
    const third = doc.joints.find((j) => j.id === 'j-third')!;
    third.parent.componentPath = ['c-centre'];
    const mesh = doc.gearMeshes![0]!;
    expect(checkGearMesh(doc, mesh, solve(doc), lookup)).toEqual({
      status: 'problem',
      problems: [{ code: 'gear-mesh-frame' }],
    });
  });

  it('shows gear mesh changes in the document diff', () => {
    const { assembly } = f70GearTrain();
    const after = structuredClone(assembly);
    after.gearMeshes![0]!.name = 'Renamed';
    after.gearMeshes!.pop();
    const changes = compareCad(assembly, after);
    expect(changes.map((c) => JSON.stringify(c)).join('\n')).toContain('mesh-centre-third');
    expect(changes.map((c) => JSON.stringify(c)).join('\n')).toContain('mesh-third-fourth');
  });

  it('reads only the mount candidate in effect for a carried frame', () => {
    const { assembly, solve, lookup } = f70GearTrain();
    const doc = structuredClone(assembly);
    // A carrier under the third arbor: grounded, or (the other candidate) on the centre wheel.
    doc.components.push({ ...fixtureComponent('c-carrier', 'part-fourth'), placement: null });
    doc.joints.push(
      fixtureJoint('j-carrier', 'fastened', fixtureConnector(), 'c-carrier', fixtureConnector()),
      fixtureJoint(
        'j-carrier-on-centre',
        'fastened',
        fixtureConnector(['c-centre']),
        'c-carrier',
        fixtureConnector(),
      ),
    );
    doc.joints.find((j) => j.id === 'j-third')!.parent.componentPath = ['c-carrier'];
    doc.mounts = [
      {
        id: 'mount-carrier',
        name: 'Carrier',
        component: 'c-carrier',
        joints: ['j-carrier', 'j-carrier-on-centre'],
        active: 'j-carrier',
      },
    ];
    doc.solvedPoses = solve(doc).poses;
    expect(validateCad(doc).filter((d) => d.severity === 'error')).toEqual([]);
    const mesh = doc.gearMeshes![0]!;
    expect(checkGearMesh(doc, mesh, solve(doc), lookup).status).toBe('ok');
    doc.mounts[0]!.active = 'j-carrier-on-centre';
    expect(checkGearMesh(doc, mesh, solve(doc), lookup)).toEqual({
      status: 'problem',
      problems: [{ code: 'gear-mesh-frame' }],
    });
  });
});
