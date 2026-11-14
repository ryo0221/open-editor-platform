/**
 * CR7c (docs/cad/car-design.md, CR7c, A2): checks through a joint's range and the clearance
 * between two components.
 *
 * - `jointRangeSamples`: one value of one joint stepped through its limits (2–64 steps, both ends
 *   included), each step a sample for the MR5 sweep (`checkCadInterferenceAlong`), so the first
 *   value that overlaps and its pairs can be listed (a door opening, a front wheel steering, a
 *   seat sliding).
 * - `cadClearance`: the shortest distance between the display meshes of two components (and what
 *   they place), and the two points it runs between, in the current pose or at joint values.
 *   Like the interference check it is as precise as the meshes' tessellation. Parts whose meshes
 *   are not at hand refuse it: a clearance is never measured on part of a component.
 */
import { meshClearance, type ClearancePiece } from '@editor-platform/geometry-core/clearance';
import { expandAssembly, type CadPartLookup } from './assembly';
import { parameterValues } from './graph';
import {
  cadJointValueKeys,
  ownJointValueKeys,
  posesForJointValues,
  type CadJointSolution,
  type CadJointValueKey,
  type CadResolvedJointValues,
} from './joints';
import type { CadDocument, Vec3 } from './model';
import { inactiveJointIds } from './mounts';
import { prepareMeshes, type CadInterferenceMesh, type CadSweepSample } from './interference';

export const cadRangeLimits = Object.freeze({ minSteps: 2, maxSteps: 64 });

/**
 * The samples that step value `of` of joint `jointId` from its lower limit to its upper one in
 * `steps` (the values at each, by tick), or why it cannot be stepped.
 */
export function jointRangeSamples(
  doc: Pick<CadDocument, 'joints' | 'mounts'>,
  jointId: string,
  of: CadJointValueKey,
  steps: number,
): { samples: CadSweepSample[]; values: number[] } | { code: string } {
  const joint = doc.joints.find((j) => j.id === jointId);
  if (!joint) return { code: 'target-missing' };
  // An inactive mount candidate (MR7) is not applied to the pose: stepping it would change nothing.
  if (inactiveJointIds(doc).has(jointId)) return { code: 'joint-inactive' };
  if (!cadJointValueKeys[joint.type].includes(of)) return { code: 'range-value' };
  if (joint.couplings?.some((c) => c.of === of)) return { code: 'range-coupled' };
  if (
    !Number.isInteger(steps) ||
    steps < cadRangeLimits.minSteps ||
    steps > cadRangeLimits.maxSteps
  )
    return { code: 'range-steps' };
  const limit = joint.limits.find((l) => l.of === of);
  if (!limit || !(limit.max > limit.min)) return { code: 'range-no-limits' };
  const values = Array.from(
    { length: steps },
    (_, i) => limit.min + ((limit.max - limit.min) * i) / (steps - 1),
  );
  return {
    samples: values.map((v, tick) => ({ tick, values: new Map([[jointId, { [of]: v }]]) })),
    values,
  };
}

export interface CadClearanceInput {
  doc: CadDocument;
  lookup: CadPartLookup;
  meshesOf: (contentHash: string) => readonly CadInterferenceMesh[] | undefined;
  /** This document's own bodies' meshes (the path `[]`). */
  ownMeshes?: readonly CadInterferenceMesh[];
  /** The current joint solutions, needed with `values`. */
  joints?: Record<string, CadJointSolution>;
  /** Joint values to measure at instead of the current pose (a joint left out keeps its own). */
  values?: ReadonlyMap<string, CadResolvedJointValues>;
}
export type CadClearanceReport =
  | {
      status: 'ok';
      distanceMm: number;
      /** The closest points on `a`'s side and on `b`'s (assembly coordinates, mm). */
      a: Vec3;
      b: Vec3;
    }
  | {
      status: 'refused';
      code: string;
      /** For `clearance-meshes-missing`: the occurrences without meshes. */
      missing?: string[][];
    };

const within = (path: readonly string[], prefix: readonly string[]) =>
  prefix.length > 0 && prefix.every((s, i) => path[i] === s);

/**
 * The clearance between the occurrences under component path `a` and those under `b` (`[]` is
 * this document's own bodies, e.g. a car's skin, at its origin).
 */
export function cadClearance(
  input: CadClearanceInput,
  a: readonly string[],
  b: readonly string[],
): CadClearanceReport {
  const { doc, lookup } = input;
  const same = a.length === b.length && a.every((s, i) => s === b[i]);
  if (same || within(a, b) || within(b, a)) return { status: 'refused', code: 'clearance-same' };
  let posed = doc;
  if (input.values) {
    // Every joint in effect must solve, not only those given: a coupled follower or a descendant
    // that stayed put would give a clearance on a mixed pose (as checkCadInterference does).
    const off = inactiveJointIds(doc);
    for (const { id } of doc.joints) {
      if (off.has(id)) continue;
      const s = input.joints?.[id];
      if (s?.status === 'broken') return { status: 'refused', code: 'part-joint-broken' };
      if (s?.status !== 'solved') return { status: 'refused', code: 'joint-part-unavailable' };
    }
    // A coupled value follows its driver: it cannot be measured at a value of its own.
    for (const [id, v] of input.values) {
      const joint = doc.joints.find((j) => j.id === id);
      if (!joint) return { status: 'refused', code: 'target-missing' };
      if (off.has(id)) return { status: 'refused', code: 'joint-inactive' };
      const own = ownJointValueKeys(joint);
      if (Object.keys(v).some((k) => !own.includes(k as CadJointValueKey)))
        return { status: 'refused', code: 'range-coupled' };
    }
    posed = {
      ...doc,
      solvedPoses: posesForJointValues(
        doc,
        { poses: doc.solvedPoses, joints: input.joints ?? {} },
        input.values,
        parameterValues(doc),
      ),
    };
  }
  const expansion = expandAssembly(posed, lookup);
  if (expansion.limit) return { status: 'refused', code: expansion.limit };
  const sides: [ClearancePiece[], ClearancePiece[]] = [[], []];
  const missing: string[][] = [];
  // This document's own bodies, when a side names them.
  for (const [k, path] of [a, b].entries()) {
    if (path.length) continue;
    const meshes = input.ownMeshes && prepareMeshes(input.ownMeshes, doc);
    const active = doc.bodies.filter((x) => x.state === 'active');
    if (!active.length) return { status: 'refused', code: 'clearance-empty' };
    if (!meshes || active.some((x) => !meshes.bodyIds.has(x.id))) {
      missing.push([]);
      continue;
    }
    for (const list of meshes.byBody.values())
      sides[k]!.push({ meshes: list, pose: { rotation: [0, 0, 0, 1], translationMm: [0, 0, 0] } });
  }
  for (const o of expansion.occurrences) {
    const side = within(o.path, a) ? sides[0] : within(o.path, b) ? sides[1] : undefined;
    if (!side) continue;
    const given = o.content ? input.meshesOf(o.part.source.contentHash) : undefined;
    const meshes = given && prepareMeshes(given, o.content);
    // Every active body's mesh, or the part is missing (never a clearance to part of it).
    if (
      !o.content ||
      !meshes ||
      o.content.bodies.some((x) => x.state === 'active' && !meshes.bodyIds.has(x.id))
    ) {
      // A sub-assembly's own bodies may be none: it is covered by what it places.
      if (o.content?.bodies.every((x) => x.state !== 'active')) continue;
      missing.push(o.path);
      continue;
    }
    for (const list of meshes.byBody.values())
      side.push({
        meshes: list,
        pose: { rotation: o.pose.rotation, translationMm: o.pose.translationMm },
      });
  }
  if (missing.length) return { status: 'refused', code: 'clearance-meshes-missing', missing };
  let r;
  try {
    r = meshClearance(sides[0], sides[1]);
  } catch (e) {
    return { status: 'refused', code: e instanceof Error ? e.message : 'clearance-limit' };
  }
  if (!r) return { status: 'refused', code: 'clearance-empty' };
  return { status: 'ok', distanceMm: r.distanceMm, a: r.a, b: r.b };
}
