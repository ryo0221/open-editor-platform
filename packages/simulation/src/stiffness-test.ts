/**
 * CR5c (docs/cad/car-design.md, S3・S4・86A7): the torsion and bending stiffness tests. A test is
 * an ordinary linear-static study made in one step from the picked mounts (its supports, its
 * driven displacements or its force) and marked with `test`; its result is summed up from the
 * run's reactions and displacements on the test's own faces. No new solve is added.
 */
import {
  freshSimulationId,
  type SimulationConstraint,
  type SimulationDocument,
  type SimulationLoad,
  type SimulationOperation,
  type SimulationStaticStudy,
  type SimulationTarget,
} from '@editor-platform/simulation-core';
import {
  localFaces,
  nodesPerElement,
  tet10Edges,
  type FemMesh,
} from '@editor-platform/geometry-fem';
import type { ShellMesh } from '@editor-platform/geometry-fem';
import type { StudyRun } from './run';

/** The default driven displacement of a torsion test (mm, each side) and force of a bending one (N). */
export const torsionTestDisplacementMm = 1;
export const bendingTestForceN = 1000;

const numbered = (names: readonly string[], base: string) => {
  for (let n = 1; ; n++) if (!names.includes(`${base} ${n}`)) return `${base} ${n}`;
};
const axisNames = ['x', 'y', 'z'] as const;
export type TestAxis = 0 | 1 | 2;

/** The mounts of a test: the front pair (left, right) and the rear pair. */
export interface StiffnessTestMounts {
  frontLeft: SimulationTarget[];
  frontRight: SimulationTarget[];
  rear: SimulationTarget[];
}

const testStudy = (
  doc: SimulationDocument,
  base: string,
  loadIds: string[],
  constraintIds: string[],
  test: SimulationStaticStudy['test'],
): SimulationStaticStudy => ({
  id: freshSimulationId(doc, base.toLowerCase().replace(/ /g, '-')),
  name: numbered(
    doc.studies.map((s) => s.name),
    base,
  ),
  kind: 'linear-static',
  loadIds,
  constraintIds,
  solver: { tolerance: 1e-8, maxIterations: 10_000 },
  // The stiffness is what the test measures; the largest displacement is the one it gives.
  convergence: { levels: 2, metrics: ['stiffness'], tolerance: 0.05 },
  test,
});

/**
 * S3: a torsion test. The rear mounts are held (fixed); the front left mount is moved
 * `displacementMm` along `up` and the front right one as far the other way, the other directions
 * left free. The study takes these three constraints only (no load, none of the document's
 * other items), so the reactions are the test's.
 */
export function torsionTestOps(
  doc: SimulationDocument,
  mounts: StiffnessTestMounts,
  displacementMm = torsionTestDisplacementMm,
  up: TestAxis = 2,
): SimulationOperation[] {
  if (!Number.isFinite(displacementMm) || displacementMm <= 0)
    throw new RangeError('the displacement must be above 0 mm');
  const names = doc.constraints.map((c) => c.name);
  const label = numbered(
    doc.studies.map((s) => s.name),
    'Torsion test',
  );
  const along = (d: number): [number | null, number | null, number | null] =>
    [0, 1, 2].map((k) => (k === up ? d : null)) as [number | null, number | null, number | null];
  const held: SimulationConstraint = {
    id: freshSimulationId(doc, 'torsion-rear'),
    name: numbered(names, `${label} rear`),
    kind: 'fixed',
    targets: mounts.rear,
  };
  const left: SimulationConstraint = {
    id: freshSimulationId(doc, 'torsion-left'),
    name: numbered(names, `${label} left +${displacementMm} mm ${axisNames[up]}`),
    kind: 'displacement',
    targets: mounts.frontLeft,
    displacement: along(displacementMm),
  };
  const right: SimulationConstraint = {
    id: freshSimulationId(doc, 'torsion-right'),
    name: numbered(names, `${label} right −${displacementMm} mm ${axisNames[up]}`),
    kind: 'displacement',
    targets: mounts.frontRight,
    displacement: along(-displacementMm),
  };
  const study = testStudy(doc, 'Torsion test', [], [held.id, left.id, right.id], {
    kind: 'torsion',
    left: left.id,
    right: right.id,
  });
  return [
    { type: 'addConstraint', constraint: held },
    { type: 'addConstraint', constraint: left },
    { type: 'addConstraint', constraint: right },
    { type: 'addStudy', study },
  ];
}

/**
 * S4: a bending test. The rear mounts are held (fixed), the front ones held along `up` only (so
 * the body is not clamped at both ends), and `forceN` pushes the loaded faces (the seats) against
 * `up`. The study takes these items only.
 */
export function bendingTestOps(
  doc: SimulationDocument,
  mounts: StiffnessTestMounts & { loaded: SimulationTarget[] },
  forceN = bendingTestForceN,
  up: TestAxis = 2,
): SimulationOperation[] {
  if (!Number.isFinite(forceN) || forceN <= 0) throw new RangeError('the force must be above 0 N');
  const label = numbered(
    doc.studies.map((s) => s.name),
    'Bending test',
  );
  const names = doc.constraints.map((c) => c.name);
  const held: SimulationConstraint = {
    id: freshSimulationId(doc, 'bending-rear'),
    name: numbered(names, `${label} rear`),
    kind: 'fixed',
    targets: mounts.rear,
  };
  const front: SimulationConstraint = {
    id: freshSimulationId(doc, 'bending-front'),
    name: numbered(names, `${label} front`),
    kind: 'displacement',
    targets: [...mounts.frontLeft, ...mounts.frontRight],
    displacement: [0, 1, 2].map((k) => (k === up ? 0 : null)) as [
      number | null,
      number | null,
      number | null,
    ],
  };
  const load: SimulationLoad = {
    id: freshSimulationId(doc, 'bending-load'),
    name: numbered(
      doc.loads.map((l) => l.name),
      `${label} ${forceN} N`,
    ),
    kind: 'force',
    targets: mounts.loaded,
    force: [0, 1, 2].map((k) => (k === up ? -forceN : 0)) as [number, number, number],
  };
  const study = testStudy(doc, 'Bending test', [load.id], [held.id, front.id], {
    kind: 'bending',
    load: load.id,
  });
  return [
    { type: 'addConstraint', constraint: held },
    { type: 'addConstraint', constraint: front },
    { type: 'addLoad', load },
    { type: 'addStudy', study },
  ];
}

export interface TorsionTestResult {
  kind: 'torsion';
  /** The reactions' moment about the twist axis on the driven mounts (N·m). */
  momentNm: number;
  /** The front's twist against the held rear (degrees). */
  angleDeg: number;
  /** N·m/deg. */
  stiffness: number;
  /** The distance between the driven mounts across the axis (mm). */
  trackMm: number;
}
export interface BendingTestResult {
  kind: 'bending';
  forceN: number;
  /** The loaded faces' mean displacement along the force over their area (mm). */
  deflectionMm: number;
  /** N/mm. */
  stiffness: number;
}
export type StiffnessTestResult =
  | TorsionTestResult
  | BendingTestResult
  | { kind: 'refused'; reason: string };

/** Each analysed body's mesh, displacements and reactions in a static run. */
type TestRun = Pick<StudyRun, 'studyId' | 'mapping' | 'fields'>;
function staticBodies(doc: SimulationDocument, run: TestRun) {
  const f = run.fields;
  if (!f) return undefined;
  if (f.kind === 'bonded-static') return f.bodies;
  if (f.kind === undefined || f.kind === 'linear-static' || f.kind === 'shell-static')
    return [{ bodyId: doc.source.bodyId, fields: f }];
  return undefined;
}

/**
 * The nodes of an owner's faces (and edges) on each body, from the run's mapping table, each with
 * its share of the faces' area (the edges' length): the integral of a nodal field over them is
 * the sum of the values times the shares (linear triangles and edges a third and a half to each
 * corner, a quadratic triangle a third to each mid-edge node and none to its corners).
 */
function ownerNodes(doc: SimulationDocument, run: TestRun, owner: string) {
  const out = new Map<string, Map<number, number>>();
  const bodies = staticBodies(doc, run) ?? [];
  for (const row of run.mapping) {
    if (row.owner !== owner || row.status !== 'resolved') continue;
    const bodyId = row.body ?? doc.source.bodyId;
    const body = bodies.find((b) => b.bodyId === bodyId);
    if (!body) continue;
    const shares = out.get(bodyId) ?? new Map<number, number>();
    out.set(bodyId, shares);
    const add = (n: number, w: number) => shares.set(n, (shares.get(n) ?? 0) + w);
    const tags = new Set(row.analysis);
    const mesh = body.fields.mesh as FemMesh | ShellMesh;
    const at = (n: number) => [0, 1, 2].map((k) => mesh.nodes[3 * n + k]!);
    const area = (a: number, b: number, c: number) =>
      Math.hypot(...cross(sub(at(b), at(a)), sub(at(c), at(a)))) / 2;
    const chains = row.kind === 'edge' || row.as === 'edge';
    if (chains) {
      for (const k of tags) {
        const from = mesh.edges.offsets[k]!,
          to = mesh.edges.offsets[k + 1]!;
        if (to - from === 1) add(mesh.edges.nodes[from]!, 0);
        for (let j = from; j + 1 < to; j++) {
          const a = mesh.edges.nodes[j]!,
            b = mesh.edges.nodes[j + 1]!;
          const half = Math.hypot(...sub(at(b), at(a))) / 2;
          add(a, half);
          add(b, half);
        }
      }
    } else if ('triangles' in mesh) {
      for (let t = 0; t < mesh.faces.length; t++)
        if (tags.has(mesh.faces[t]!)) {
          const [a, b, c] = [0, 1, 2].map((k) => mesh.triangles[3 * t + k]!) as [
            number,
            number,
            number,
          ];
          const third = area(a, b, c) / 3;
          for (const n of [a, b, c]) add(n, third);
        }
    } else {
      const npe = nodesPerElement(mesh.type);
      for (let i = 0; i < mesh.boundary.tags.length; i++) {
        if (!tags.has(mesh.boundary.tags[i]!)) continue;
        const e = mesh.boundary.elements[i]!;
        const face = localFaces[mesh.boundary.localFaces[i]!]!;
        const corners = face.map((c) => mesh.elements[e * npe + c]!) as [number, number, number];
        const third = area(...corners) / 3;
        if (mesh.type !== 'tet10') {
          for (const n of corners) add(n, third);
          continue;
        }
        for (const n of corners) add(n, 0);
        for (let k = 0; k < 3; k++) {
          const a = face[k]!,
            b = face[(k + 1) % 3]!;
          const m = tet10Edges.findIndex(([p, q]) => (p === a && q === b) || (p === b && q === a));
          add(mesh.elements[e * npe + 4 + m]!, third);
        }
      }
    }
  }
  return out;
}

const sub = (a: number[], b: number[]) => a.map((x, i) => x - b[i]!);
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
const cross = (u: number[], v: number[]) => [
  u[1]! * v[2]! - u[2]! * v[1]!,
  u[2]! * v[0]! - u[0]! * v[2]!,
  u[0]! * v[1]! - u[1]! * v[0]!,
];
const unit = (v: number[]) => {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};

/**
 * The summary of a stiffness test's run: undefined for a study that is no test; `refused` with
 * the reason when the run has no static result or the test's faces hold no node.
 */
export function stiffnessTestResult(
  doc: SimulationDocument,
  run: TestRun,
): StiffnessTestResult | undefined {
  const study = doc.studies.find((s) => s.id === run.studyId);
  if (study?.kind !== 'linear-static' || !study.test) return undefined;
  const bodies = staticBodies(doc, run);
  if (!bodies) return { kind: 'refused', reason: 'the run has no static result' };
  const per = (bodyId: string) =>
    bodies.find((b) => b.bodyId === bodyId)!.fields.kind === 'shell-static' ? 6 : 3;
  const points = (owner: string) => {
    const out: { body: (typeof bodies)[number]; n: number; per: number; share: number }[] = [];
    for (const [bodyId, nodes] of ownerNodes(doc, run, owner))
      for (const [n, share] of nodes)
        out.push({ body: bodies.find((b) => b.bodyId === bodyId)!, n, per: per(bodyId), share });
    return out;
  };
  const position = (p: ReturnType<typeof points>[number]) =>
    [0, 1, 2].map((k) => p.body.fields.mesh.nodes[3 * p.n + k]!);
  // A mount's middle over its area (Codex on #982: a node mean leans to where the mesh is finer).
  const centroid = (ps: ReturnType<typeof points>) => {
    const total = ps.reduce((s, p) => s + p.share, 0);
    return [0, 1, 2].map((k) =>
      total > 0
        ? ps.reduce((s, p) => s + p.share * position(p)[k]!, 0) / total
        : ps.reduce((s, p) => s + position(p)[k]!, 0) / ps.length,
    );
  };

  if (study.test.kind === 'bending') {
    const load = doc.loads.find((l) => l.id === (study.test as { load: string }).load);
    if (load?.kind !== 'force') return { kind: 'refused', reason: 'the test has no force' };
    const ps = points(load.id);
    if (!ps.length) return { kind: 'refused', reason: `${load.name} holds no node` };
    const forceN = Math.hypot(...load.force);
    if (!(forceN > 0)) return { kind: 'refused', reason: `${load.name} has no force` };
    const dir = unit(load.force);
    // The faces' mean displacement along the force: its integral over them over their area (the
    // force is spread by area too).
    const measure = ps.reduce((s, p) => s + p.share, 0);
    if (!(measure > 0)) return { kind: 'refused', reason: `${load.name} has no area` };
    const deflectionMm =
      ps.reduce(
        (s, p) =>
          s +
          p.share *
            dot(
              [0, 1, 2].map((k) => p.body.fields.displacement[p.per * p.n + k]!),
              dir,
            ),
        0,
      ) / measure;
    if (!(deflectionMm > 0))
      return { kind: 'refused', reason: 'the loaded faces did not move along the force' };
    return { kind: 'bending', forceN, deflectionMm, stiffness: forceN / deflectionMm };
  }

  const { left: leftId, right: rightId } = study.test;
  const left = doc.constraints.find((c) => c.id === leftId);
  const right = doc.constraints.find((c) => c.id === rightId);
  if (left?.kind !== 'displacement' || right?.kind !== 'displacement')
    return { kind: 'refused', reason: 'the test has no driven mounts' };
  const L = points(left.id),
    R = points(right.id);
  if (!L.length || !R.length)
    return { kind: 'refused', reason: `${(L.length ? right : left).name} holds no node` };
  // The relative drive (free components count as 0) gives the up direction; the twist axis is
  // across the line between the driven mounts and up.
  const drive = sub(
    left.displacement.map((x) => x ?? 0),
    right.displacement.map((x) => x ?? 0),
  );
  const delta = Math.hypot(...drive);
  if (!(delta > 0)) return { kind: 'refused', reason: 'the driven mounts move together' };
  const up = unit(drive);
  const cl = centroid(L),
    cr = centroid(R);
  const across = sub(cl, cr);
  const lateral = sub(
    across,
    up.map((u) => u * dot(across, up)),
  );
  const trackMm = Math.hypot(...lateral);
  if (!(trackMm > 0)) return { kind: 'refused', reason: 'the driven mounts are not side by side' };
  const axis = unit(cross(lateral, up));
  const middle = cl.map((x, k) => (x + cr[k]!) / 2);
  let moment = 0;
  for (const p of [...L, ...R]) {
    const r = p.body.fields.reaction;
    const force = [0, 1, 2].map((k) => r[p.per * p.n + k]!);
    moment += dot(cross(sub(position(p), middle), force), axis);
    if (p.per === 6)
      moment += dot(
        [3, 4, 5].map((k) => r[6 * p.n + k]!),
        axis,
      );
  }
  const angleDeg = (Math.atan2(delta, trackMm) * 180) / Math.PI;
  const momentNm = Math.abs(moment) / 1000;
  return { kind: 'torsion', momentNm, angleDeg, stiffness: momentNm / angleDeg, trackMm };
}
