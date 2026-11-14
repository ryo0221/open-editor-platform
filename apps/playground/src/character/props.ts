/**
 * The Playground's props for characters (C2b-3): the saved versions of its `cad` Artifacts,
 * kept in the character's record (`cadParts`, as a building keeps its parts) so they travel in
 * its native file, evaluated with the Host's kernel build, and handed to the character Surface
 * as views it can draw for any joint values without a kernel.
 */
import { BimController, WorkerBimKernel, bimViewSolids } from '@editor-platform/bim';
import BimKernelWorker from '@editor-platform/bim/worker?worker';
import type { BimDocument } from '@editor-platform/bim-core';
import { createCadBinding, evaluatedVersions, type CadBinding } from '@editor-platform/cad';
import {
  jointSafetyBound,
  configurationStale,
  isJointAngleKey,
  coupledJointValues,
  interferenceKey,
  jointLimitViolations,
  ownJointValueKeys,
  expandAssembly,
  jointValues,
  parameterValues,
  posesForJointValues,
  type CadAppearance,
  type CadAssemblyEvaluation,
  type CadDocument,
  type CadSolvedPose,
} from '@editor-platform/cad-core';
import type { CadMesh } from '@editor-platform/cad-kernel-occt';
import KernelWorker from '@editor-platform/cad-kernel-occt/worker?worker';
import type {
  CharacterJointValues,
  CharacterMountChoice,
  CharacterPropMount,
  CharacterPropForm,
  CharacterPropInstance,
  CharacterPropSweep,
  CharacterPropSweepSample,
  CharacterPropMesh,
  CharacterPropVersionJoints,
  CharacterPropView,
} from '@editor-platform/character';
import { composeMat4, multiplyMat4, type Mat4 } from '@editor-platform/character-core';
import { EditorSession } from '@editor-platform/editor-core';
import { cadKernel, cadKernels, type StoredArtifact } from '../model';
import { createBimPartSource } from '../bim/parts';
import { partKernel } from '../bim/part-kernel';

const poseMatrix = (p: CadSolvedPose, origin: readonly number[] = [0, 0, 0]): Mat4 =>
  multiplyMat4(
    composeMat4({ translation: [...p.translationMm], rotation: [...p.rotation], scale: [1, 1, 1] }),
    composeMat4({
      translation: [origin[0]!, origin[1]!, origin[2]!],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    }),
  );
const identity = { translationMm: [0, 0, 0], rotation: [0, 0, 0, 1] } as CadSolvedPose;

/** A box over a version's hint bounds (part frame, mm): shown when its meshes were not kept. */
function boundsBox([lo, hi]: readonly [readonly number[], readonly number[]]): CharacterPropMesh {
  const positions: number[] = [],
    normals: number[] = [],
    indices: number[] = [];
  for (let axis = 0; axis < 3; axis++)
    for (const side of [0, 1]) {
      const n = [0, 0, 0];
      n[axis] = side ? 1 : -1;
      const [u, v] = [(axis + 1) % 3, (axis + 2) % 3];
      const base = positions.length / 3;
      for (const [a, b] of [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ]) {
        const p = [0, 0, 0];
        p[axis] = (side ? hi : lo)[axis]!;
        p[u] = (a ? hi : lo)[u]!;
        p[v] = (b ? hi : lo)[v]!;
        positions.push(...p);
        normals.push(...n);
      }
      if (side) indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      else indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    color: '#9aa4b1',
    opacity: 0.5,
  };
}

/**
 * One version shown as a prop: a read-only CAD binding (its own kernel Worker) evaluates it
 * once; joint values then move its components from that solve (`posesForJointValues`).
 */
export class CharacterPropEvaluation {
  private readonly binding: CadBinding;
  private readonly unsubscribe: (() => void)[] = [];
  private readonly converted = new WeakMap<CadMesh, CharacterPropMesh>();
  private readonly boxes = new Map<string, CharacterPropMesh>();
  view: CharacterPropView = { status: 'pending' };

  constructor(
    private readonly content: CadDocument,
    lookup: (hash: string) => CadDocument | undefined,
    private readonly changed: () => void,
  ) {
    this.binding = createCadBinding({
      session: new EditorSession(content),
      build: cadKernel,
      kernels: cadKernels,
      spawnWorker: () => new KernelWorker() as never,
      canEdit: () => false,
      permissionGeneration: () => 0,
      parts: {
        get: lookup,
        stage: async () => {
          throw new Error('read-only');
        },
      },
    });
    const update = () => this.update();
    this.unsubscribe.push(
      this.binding.controller.subscribe(update),
      this.binding.assembly.subscribe(update),
    );
    void this.binding.controller.sync();
  }
  private mesh(mesh: CadMesh, look: CadAppearance | undefined, sheet = false): CharacterPropMesh {
    let out = this.converted.get(mesh);
    if (!out) {
      // CR7g-3: the look's finish and light, for the view's realistic lighting.
      const finish = look && {
        ...(look.roughness !== undefined ? { roughness: look.roughness } : {}),
        ...(look.metalness !== undefined ? { metalness: look.metalness } : {}),
        ...(look.emission ? { emission: look.emission } : {}),
        ...(look.transmission !== undefined ? { transmission: look.transmission } : {}),
        ...(look.ior !== undefined ? { ior: look.ior } : {}),
      };
      out = {
        positions: mesh.positions,
        normals: mesh.normals,
        indices: mesh.indices,
        color: look?.color ?? '#9aa4b1',
        opacity: look?.opacity ?? 1,
        ...(sheet ? { sheet: true } : {}),
        ...(finish && Object.keys(finish).length ? { finish } : {}),
      };
      this.converted.set(mesh, out);
    }
    return out;
  }
  private update() {
    const s = this.binding.controller.getSnapshot();
    const evaluation = s.evaluation;
    const before = this.view;
    if (!cadKernel) this.view = { status: 'failed', message: 'kernel-build-unavailable' };
    else if (s.busy) this.view = before.status === 'ready' ? before : { status: 'pending' };
    // A retryable failure (the Worker could not start) is kept apart from `evaluation`.
    else if (s.geometryState === 'geometry-error' && evaluation?.status !== 'ok')
      this.view = {
        status: 'failed',
        message: s.geometryFailure ?? (evaluation ? evaluation.code : 'kernel-unavailable'),
      };
    else if (!evaluation) this.view = before.status === 'ready' ? before : { status: 'pending' };
    else if (evaluation.status !== 'ok')
      this.view = { status: 'failed', message: s.geometryFailure ?? evaluation.code };
    // Ready only once every component can be drawn, so the Surface's first fit sees it whole:
    // versions evaluated in the background (R2b-4) and their meshes arriving later stay pending.
    else if (before.status !== 'ready' && !this.complete(evaluation))
      this.view = { status: 'pending' };
    else
      this.view = this.ready(
        evaluation.assembly,
        s.meshes?.current ? s.meshes.meshes : [],
        evaluatedVersions(evaluation, this.binding.assembly.later) ?? {},
      );
    this.changed();
  }
  /** Every placed version is evaluated and has meshes, coarse meshes or a reason for none. */
  private complete(evaluation: Parameters<typeof evaluatedVersions>[0]) {
    const assembly = this.binding.assembly;
    const versions = evaluatedVersions(evaluation, assembly.later) ?? {};
    const { simplified } = assembly.getSnapshot();
    for (const o of expandAssembly(this.content, assembly.lookup).occurrences) {
      const hash = o.part.source.contentHash;
      const state = versions[hash]?.state;
      if (!state) return false;
      if (state !== 'available' && state !== 'substitute') continue;
      if (!assembly.meshes(hash) && !assembly.coarseMeshes(hash) && !simplified.has(hash))
        return false;
    }
    return true;
  }
  private ready(
    assembly: CadAssemblyEvaluation | undefined,
    own: CadMesh[],
    versions: CadAssemblyEvaluation['versions'],
  ): CharacterPropView {
    const doc = this.content;
    const params = parameterValues(doc);
    const looks = (content: CadDocument | undefined) =>
      new Map((content?.bodies ?? []).map((b) => [b.id, b.appearance]));
    const ownLooks = looks(doc);
    const { joints } = propVersionJoints(doc);
    const solved =
      assembly?.poses && assembly.joints
        ? { poses: assembly.poses, joints: assembly.joints }
        : undefined;
    // MR5: the parts by the names of the components on their paths, read from their owners.
    const names = new Map<string, string>([[interferenceKey([]), 'Own shape']]);
    const contents = new Map<string, CadDocument | undefined>([[interferenceKey([]), doc]]);
    for (const o of expandAssembly(doc, this.binding.assembly.lookup).occurrences) {
      const up = interferenceKey(o.path.slice(0, -1));
      const step = o.path.at(-1)!;
      const label = contents.get(up)?.components.find((c) => c.id === step)?.name ?? step;
      const parent = o.path.length > 1 ? names.get(up) : undefined;
      names.set(interferenceKey(o.path), parent ? `${parent} / ${label}` : label);
      contents.set(interferenceKey(o.path), o.content);
    }
    const nameOf = (path: readonly string[]) =>
      names.get(interferenceKey(path)) ?? path.join(' / ');
    const draw = (
      values: CharacterJointValues,
      mounts?: CharacterMountChoice,
    ): CharacterPropInstance[] => {
      const out: CharacterPropInstance[] = [];
      const ownSheets = sheetsOf(doc);
      const ownPiece = { id: interferenceKey([]), name: nameOf([]), frame: poseMatrix(identity) };
      for (const m of own) {
        const look = ownLooks.get(m.bodyId);
        out.push({
          mesh: this.mesh(m, look, ownSheets.has(m.bodyId)),
          matrix: poseMatrix(identity, m.origin),
          piece: ownPiece,
          body: m.bodyId,
        });
      }
      const poses = solved
        ? posesForJointValues(doc, solved, values, params, mounts)
        : (assembly?.poses ?? doc.solvedPoses);
      const shown = { ...doc, solvedPoses: { ...doc.solvedPoses, ...poses } };
      for (const o of expandAssembly(shown, this.binding.assembly.lookup).occurrences) {
        const hash = o.part.source.contentHash;
        const state = versions[hash]?.state;
        // Meshes delivered before a version failed its checks (a broken joint, a pose that
        // disagrees) are not drawn: like the CAD view, the version is a box.
        const usable = state === 'available' || state === 'substitute';
        // Beyond the main-thread budget a version keeps its coarse meshes, else is a box (R2b-4).
        const meshes = usable
          ? (this.binding.assembly.meshes(hash) ?? this.binding.assembly.coarseMeshes(hash))
          : undefined;
        if (!meshes) {
          const boxed =
            (state !== undefined && !usable) ||
            this.binding.assembly.getSnapshot().simplified.has(hash);
          // A sub-assembly without bodies of its own is drawn by its parts alone.
          if (!boxed || !o.content?.bodies.some((b) => b.state === 'active')) continue;
          let box = this.boxes.get(hash);
          if (!box) this.boxes.set(hash, (box = boundsBox(o.part.hint.boundsMm)));
          out.push({
            mesh: box,
            matrix: poseMatrix(o.pose),
            piece: { id: interferenceKey(o.path), name: nameOf(o.path), box: true },
          });
          continue;
        }
        const partLooks = looks(o.content);
        const sheets = sheetsOf(o.content);
        const piece = {
          id: interferenceKey(o.path),
          name: nameOf(o.path),
          frame: poseMatrix(o.pose),
        };
        for (const m of meshes) {
          const look = partLooks.get(m.bodyId);
          out.push({
            mesh: this.mesh(m, look, sheets.has(m.bodyId)),
            matrix: poseMatrix(o.pose, m.origin),
            piece,
            body: m.bodyId,
          });
        }
      }
      return out;
    };
    const limitViolation = (values: CharacterJointValues) => {
      const past = jointLimitViolations(doc, coupledJointValues(doc, params, values))[0];
      return past && { joint: past.joint, key: past.of };
    };
    // MR4: each form's own values (radians, mm), as the transform panel keys them.
    const forms = (doc.configurations ?? []).map((f): CharacterPropForm => {
      if (configurationStale(doc, f))
        return { id: f.id, name: f.name, values: {}, problem: 'configuration-stale' };
      const values: Record<string, Record<string, number>> = {};
      for (const j of doc.joints) {
        const v = f.values[j.id];
        if (!v) continue;
        const resolved = jointValues({ type: j.type, values: v }, params);
        values[j.id] = Object.fromEntries(ownJointValueKeys(j).map((k) => [k, resolved[k] ?? 0]));
      }
      const past = limitViolation(new Map(Object.entries(values)));
      return {
        id: f.id,
        name: f.name,
        values,
        ...(f.mounts ? { mounts: { ...f.mounts } } : {}),
        ...(past ? { problem: 'joint-limit' as const } : {}),
      };
    });
    const checkInterferenceAlong = async (
      samples: CharacterPropSweepSample[],
    ): Promise<CharacterPropSweep> => {
      const r = await this.binding.assembly.checkInterferenceAlong(
        samples.map((s) => ({
          tick: s.tick,
          values: Object.fromEntries(s.values),
          ...(s.mounts ? { mounts: Object.fromEntries(s.mounts) } : {}),
        })),
      );
      if ('error' in r) return { status: 'refused', code: r.error };
      if (r.report.status === 'refused') return r.report;
      return {
        status: 'ok',
        samples: r.report.samples,
        hits: r.report.hits.map((h) => ({
          tick: h.tick,
          overlaps: h.findings.map((f) => ({
            a: nameOf(f.a),
            b: nameOf(f.b),
            aId: interferenceKey(f.a),
            bId: interferenceKey(f.b),
            kind: f.kind,
            depthMm: f.depthMm,
          })),
        })),
        unchecked: r.report.unchecked.map(nameOf),
        jumps: r.report.jumps.map((j) => ({ ...j })),
      };
    };
    // MR7: the parts with candidate joints, by the names the version gives them.
    const jointName = (id: string) => doc.joints.find((j) => j.id === id)?.name ?? id;
    const mounts = (doc.mounts ?? []).map(
      (m): CharacterPropMount => ({
        id: m.id,
        name: m.name,
        joints: m.joints.map((id) => ({ id, name: jointName(id) })),
        active: m.active,
      }),
    );
    return {
      status: 'ready',
      joints,
      draw,
      limitViolation,
      forms,
      checkInterferenceAlong,
      ...(mounts.length ? { mounts } : {}),
    };
  }
  dispose() {
    for (const u of this.unsubscribe.splice(0)) u();
    this.binding.dispose();
  }
}

/** The code of a kernel that could not run (`kernel-crashed`, `kernel-load-failed`, …), if any. */
export function kernelFailure(evaluation: {
  elements: Map<string, { status: string; code?: string }>;
}) {
  for (const r of evaluation.elements.values())
    if (r.status === 'error' && r.code?.startsWith('kernel-')) return r.code;
  return undefined;
}

/**
 * C8p: one building version shown as a prop. A read-only BIM controller (its own kernel Worker,
 * and a CAD kernel Worker for its part types' shapes, read from the versions the character
 * keeps) evaluates it once; its elements never move, so it has no joints.
 */
export class CharacterBimPropEvaluation {
  private readonly controller: BimController;
  private readonly kernel: WorkerBimKernel;
  private readonly parts: ReturnType<typeof partKernel> | undefined;
  private readonly unsubscribe: () => void;
  /** The same evaluated mesh is the same prop mesh, so the view keeps its GPU buffers. */
  private readonly converted = new WeakMap<object, Map<string, CharacterPropMesh>>();
  private readonly boxes = new Map<string, CharacterPropMesh>();
  view: CharacterPropView = { status: 'pending' };

  constructor(
    private readonly content: BimDocument,
    /** The character's record (its `cadParts` keep the part types' versions). */
    record: () => StoredArtifact | undefined,
    private readonly changed: () => void,
  ) {
    this.kernel = new WorkerBimKernel({
      spawn: () => new BimKernelWorker() as never,
      build: cadKernel ?? undefined,
    });
    this.parts = cadKernel ? partKernel(cadKernel) : undefined;
    this.controller = new BimController({
      session: new EditorSession(content),
      kernel: this.kernel,
      canEdit: () => false,
      parts: createBimPartSource({
        // Only the versions kept with the character: a prop reads nothing else.
        records: () => [],
        record,
        persist: async () => false,
        kernel: this.parts,
      }),
    });
    this.unsubscribe = this.controller.subscribe(() => this.update());
    this.update();
  }
  private update() {
    const s = this.controller.state;
    if (!cadKernel) this.view = { status: 'failed', message: 'kernel-build-unavailable' };
    // Ready once the evaluation of this content is in and no part shape is still being read,
    // so the Surface's first fit sees the whole building.
    else if (
      !s.evaluation ||
      s.evaluating ||
      s.evaluatedHash !== s.hash ||
      [...s.parts.values()].some((p) => p.status === 'loading')
    )
      this.view = this.view.status === 'ready' ? this.view : { status: 'pending' };
    else if (kernelFailure(s.evaluation)) {
      // The kernel could not run (it crashed, or its build did not load): every element fails
      // with that code inside an `ok` evaluation, which would otherwise draw an empty prop.
      this.view = { status: 'failed', message: kernelFailure(s.evaluation)! };
    } else {
      const instances: CharacterPropInstance[] = [];
      const solids = bimViewSolids(this.content, s.evaluation, {
        selection: new Set(),
        parts: s.parts,
        // CR7d: a part's bodies apart, so the occupant check reads each as its own solid.
        bodies: true,
      });
      // CR7d: each instance is its element (its path), named as the building names it.
      const names = new Map(this.content.elements.map((e) => [e.id, e.name]));
      // A space is the room's air (its prism), not material: shown, never an obstacle.
      const spaces = new Set(
        this.content.elements.filter((e) => e.kind === 'space').map((e) => e.id),
      );
      const piece = (path: readonly string[], frame: Mat4, box = false) => ({
        id: path.join('/'),
        name: path.map((id) => names.get(id) ?? id).join(' / '),
        frame,
        ...(box ? { box: true } : {}),
        ...(path.some((id) => spaces.has(id)) ? { air: true } : {}),
      });
      for (const solid of solids) {
        if (!solid.meshes) {
          // A part whose shape could not be read: its type's bounds, as the building view does.
          // A stand-in that no check reads (CR7d).
          const key = JSON.stringify(solid.bounds);
          let box = this.boxes.get(key);
          if (!box) this.boxes.set(key, (box = boundsBox(solid.bounds)));
          for (const inst of solid.instances)
            instances.push({
              mesh: box,
              matrix: inst.matrix as Mat4,
              piece: piece(inst.path, inst.matrix as Mat4, true),
            });
          continue;
        }
        for (const m of solid.meshes) {
          let looks = this.converted.get(m.mesh);
          if (!looks) this.converted.set(m.mesh, (looks = new Map()));
          const look = `${m.color} ${m.opacity} ${m.sheet ? 'sheet' : 'solid'}`;
          let mesh = looks.get(look);
          if (!mesh)
            looks.set(
              look,
              (mesh = {
                positions: m.mesh.positions,
                normals: m.mesh.normals,
                indices: m.mesh.indices,
                color: m.color,
                opacity: m.opacity,
                // CR7d: a sheet has no inside for the occupant check.
                ...(m.sheet ? { sheet: true } : {}),
              }),
            );
          for (const inst of solid.instances)
            instances.push({
              mesh,
              matrix: multiplyMat4(
                inst.matrix as Mat4,
                composeMat4({
                  translation: [...m.mesh.origin],
                  rotation: [0, 0, 0, 1],
                  scale: [1, 1, 1],
                }),
              ),
              piece: piece(inst.path, inst.matrix as Mat4),
              ...(m.body !== undefined ? { body: m.body } : {}),
            });
        }
      }
      this.view = { status: 'ready', joints: [], draw: () => instances };
    }
    this.changed();
  }
  dispose() {
    this.unsubscribe();
    this.controller.dispose();
    this.kernel.dispose();
    this.parts?.dispose();
  }
}

/** CR7d: the sheet bodies of a document, by ID (their meshes have no inside). */
const sheetsOf = (content: CadDocument | undefined) =>
  new Set((content?.bodies ?? []).filter((b) => b.kind === 'sheet').map((b) => b.id));

/**
 * The joints of a CAD version a prop can key (C2b, MR1): each joint's own values with their
 * limits and saved values; a value that follows another joint (a coupling) is not keyed but
 * listed in `followers` (MR4, for the version update check).
 */
export function propVersionJoints(doc: CadDocument): CharacterPropVersionJoints {
  const params = parameterValues(doc);
  const joints = doc.joints
    .filter((j) => ownJointValueKeys(j).length)
    .map((j) => {
      const saved = jointValues(j, params);
      return {
        id: j.id,
        name: j.name,
        values: ownJointValueKeys(j).map((key) => {
          const limit = j.limits.find((l) => l.of === key);
          // WM2: an angle without a range keeps one turn either way, or a continuous joint's
          // bound (the key's own bound is the widest, characterLimits.jointTurnRad).
          const bound = jointSafetyBound(j, key);
          return {
            key,
            saved: saved[key] ?? 0,
            ...(limit
              ? { min: limit.min, max: limit.max }
              : isJointAngleKey(key)
                ? { min: -bound, max: bound }
                : {}),
          };
        }),
      };
    });
  const followers = doc.joints.flatMap((j) =>
    (j.couplings ?? []).map((c) => {
      const limit = j.limits.find((l) => l.of === c.of);
      // The safety bounds hold without limits too (jointLimitViolations).
      const bound = jointSafetyBound(j, c.of);
      return {
        joint: j.id,
        key: c.of,
        from: { joint: c.from.joint, key: c.from.of },
        ratio: c.ratio,
        offset: c.offset,
        min: Math.max(limit?.min ?? -bound, -bound),
        max: Math.min(limit?.max ?? bound, bound),
      };
    }),
  );
  const mounts = (doc.mounts ?? []).map((m) => ({ id: m.id, joints: [...m.joints] }));
  return { joints, followers, ...(mounts.length ? { mounts } : {}) };
}
