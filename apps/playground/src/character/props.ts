/**
 * The Playground's props for characters (C2b-3): the saved versions of its `cad` Artifacts,
 * kept in the character's record (`cadParts`, as a building keeps its parts) so they travel in
 * its native file, evaluated with the Host's kernel build, and handed to the character Surface
 * as views it can draw for any joint values without a kernel.
 */
import { createCadBinding, evaluatedVersions, type CadBinding } from '@editor-platform/cad';
import {
  cadJointValueKeys,
  expandAssembly,
  jointValues,
  parameterValues,
  posesForJointValues,
  type CadAssemblyEvaluation,
  type CadDocument,
  type CadSolvedPose,
} from '@editor-platform/cad-core';
import type { CadMesh } from '@editor-platform/cad-kernel-occt';
import KernelWorker from '@editor-platform/cad-kernel-occt/worker?worker';
import type {
  CharacterJointValues,
  CharacterPropInstance,
  CharacterPropMesh,
  CharacterPropView,
} from '@editor-platform/character';
import { composeMat4, multiplyMat4, type Mat4 } from '@editor-platform/character-core';
import { EditorSession } from '@editor-platform/editor-core';
import { cadKernel, cadKernels } from '../model';

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
  private mesh(mesh: CadMesh, color: string, opacity: number): CharacterPropMesh {
    let out = this.converted.get(mesh);
    if (!out) {
      out = {
        positions: mesh.positions,
        normals: mesh.normals,
        indices: mesh.indices,
        color,
        opacity,
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
    const joints = doc.joints
      .filter((j) => cadJointValueKeys[j.type].length)
      .map((j) => {
        const saved = jointValues(j, params);
        return {
          id: j.id,
          name: j.name,
          values: cadJointValueKeys[j.type].map((key) => {
            const limit = j.limits.find((l) => l.of === key);
            return {
              key,
              saved: saved[key] ?? 0,
              ...(limit ? { min: limit.min, max: limit.max } : {}),
            };
          }),
        };
      });
    const solved =
      assembly?.poses && assembly.joints
        ? { poses: assembly.poses, joints: assembly.joints }
        : undefined;
    const draw = (values: CharacterJointValues): CharacterPropInstance[] => {
      const out: CharacterPropInstance[] = [];
      for (const m of own) {
        const look = ownLooks.get(m.bodyId);
        out.push({
          mesh: this.mesh(m, look?.color ?? '#9aa4b1', look?.opacity ?? 1),
          matrix: poseMatrix(identity, m.origin),
        });
      }
      const poses = solved
        ? posesForJointValues(doc, solved, values, params)
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
          out.push({ mesh: box, matrix: poseMatrix(o.pose) });
          continue;
        }
        const partLooks = looks(o.content);
        for (const m of meshes) {
          const look = partLooks.get(m.bodyId);
          out.push({
            mesh: this.mesh(m, look?.color ?? '#9aa4b1', look?.opacity ?? 1),
            matrix: poseMatrix(o.pose, m.origin),
          });
        }
      }
      return out;
    };
    return { status: 'ready', joints, draw };
  }
  dispose() {
    for (const u of this.unsubscribe.splice(0)) u();
    this.binding.dispose();
  }
}
