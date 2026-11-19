/**
 * PD6 (docs/cad/product-design.md, PD6): a motion's interference check that bounds how far each
 * part moves between neighbouring samples, so the samples are chosen from the motion rather
 * than counted by hand.
 *
 * One joint value (the driver) moves from one value to another; every value that follows it
 * (MR1 couplings, a watch's train) moves with it. Couplings are linear, so each joint value
 * changes by the same amount at every step: the number of steps is first the least that keeps
 * every angle within `stepRad` and every length within `stepMm` per step. A fast part (a second
 * hand turning 720 times in 12 hours) therefore never comes back to the same angle at every
 * sample, as an even split of the time can make it do. Then each moving occurrence's display
 * meshes bound how far its points move: the farthest a point of a box moves under a rigid move
 * is at a corner (the distance is convex in the point), so the corners of the box around its
 * meshes give the longest straight move between two samples, lengthened to the arc of the turn
 * in that step. The steps are added until every part is within `stepMm`.
 *
 * What stays possible: two parts that pass through each other in less than the sum of their
 * steps can still be missed, and a part whose meshes are not at hand is bounded by its joints'
 * steps only (`unmeasured`). Each part's largest step is reported, so the coverage can be read.
 */
import {
  expandAssembly,
  rotateVector,
  stepComponent,
  stepPose,
  type CadSolvedPose,
} from './assembly';
import { parameterValues } from './graph';
import {
  checkCadInterferenceAlong,
  interferenceKey,
  prepareMeshes,
  type CadInterferenceInput,
  type CadInterferenceMesh,
  type CadSweepJump,
  type CadSweepHit,
  type CadSweepSample,
} from './interference';
import {
  cadJointValueKeys,
  coupledJointValues,
  isJointAngleKey,
  jointLimitViolations,
  ownJointValueKeys,
  posesForJointValues,
  type CadJoint,
  type CadJointValueKey,
  type CadResolvedJointValues,
} from './joints';
import type { CadDocument, Vec3 } from './model';
import { poseGap } from './mount-gaps';
import { inactiveJointIds } from './mounts';

/** The driver: one joint value moved from `from` to `to` (radians or mm). */
export interface CadMotionDriver {
  joint: string;
  of: CadJointValueKey;
  from: number;
  to: number;
}
/** The most any point of a part may move (mm), and any joint angle may turn (rad), per step. */
export interface CadMotionBounds {
  stepMm: number;
  stepRad: number;
}
/** Safety limits (proposals; performance is not measured while measurement is paused). */
export const cadCoverageLimits = Object.freeze({
  samples: 4096,
  minStepMm: 0.001,
  minStepRad: 1e-5,
  /**
   * The largest turn per step: a turn of a full revolution (or near it) between two samples
   * would leave the endpoints alike and hide the move between them.
   */
  maxStepRad: Math.PI / 6,
  defaultStepMm: 0.5,
  defaultStepRad: Math.PI / 180,
  /** Rounds of adding steps for the parts' moves (each round re-poses every sample). */
  rounds: 8,
});
/** One joint value's travel over the motion and its change per step. */
export interface CadCoverageJointStep {
  joint: string;
  of: CadJointValueKey;
  travel: number;
  step: number;
}
/** A moving occurrence and the most it moves in one step. */
export interface CadCoveragePart {
  path: string[];
  /** The farthest any of its points moves in one step (mm); absent when its meshes are not at hand. */
  stepMm?: number;
  /** Its largest turn in one step (rad). */
  stepRad: number;
}
export type CadCoveragePlan =
  | {
      status: 'ok';
      steps: number;
      /** The driver's value at each sample, by tick (`steps + 1` of them, both ends included). */
      values: number[];
      samples: CadSweepSample[];
      /** Every joint value that moves, by joint and value. */
      joints: CadCoverageJointStep[];
      /** Every occurrence that moves, in expansion order. */
      parts: CadCoveragePart[];
      /** Moving occurrences without meshes: bounded by their joints' steps only. */
      unmeasured: string[][];
    }
  | {
      status: 'refused';
      code: string;
      /** For `coverage-samples`: the samples the bounds need (at least). */
      needed?: number;
    };
export type CadCoverageReport =
  | (Omit<Extract<CadCoveragePlan, { status: 'ok' }>, 'samples'> & {
      driver: CadMotionDriver;
      bounds: CadMotionBounds;
      hits: CadSweepHit[];
      jumps: CadSweepJump[];
      unchecked: string[][];
      stale: string[];
    })
  | { status: 'refused'; code: string; needed?: number; tick?: number };

type CoverageInput = Omit<CadInterferenceInput, 'form' | 'values' | 'mounts'>;

/** The eight corners of the box around a version's checked meshes, or undefined without them. */
const cornersOf = new WeakMap<readonly CadInterferenceMesh[], Vec3[] | null>();
function meshCorners(meshes: readonly CadInterferenceMesh[], content: CadDocument | undefined) {
  const hit = cornersOf.get(meshes);
  if (hit !== undefined) return hit ?? undefined;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const list of prepareMeshes(meshes, content).byBody.values())
    for (const m of list)
      for (let i = 0; i < m.positions.length; i++) {
        const v = m.positions[i]!;
        const k = i % 3;
        if (v < lo[k]!) lo[k] = v;
        if (v > hi[k]!) hi[k] = v;
      }
  const corners =
    lo[0]! <= hi[0]!
      ? [0, 1, 2, 3, 4, 5, 6, 7].map(
          (c) =>
            [c & 1 ? hi[0]! : lo[0]!, c & 2 ? hi[1]! : lo[1]!, c & 4 ? hi[2]! : lo[2]!] as Vec3,
        )
      : null;
  cornersOf.set(meshes, corners);
  return corners ?? undefined;
}
const place = (pose: CadSolvedPose, p: Vec3): Vec3 => {
  const r = rotateVector(pose.rotation, p);
  return [r[0] + pose.translationMm[0], r[1] + pose.translationMm[1], r[2] + pose.translationMm[2]];
};
/** The arc of a turn `rad` over its chord: a point turned that far travels this much farther. */
const arc = (rad: number) => (rad > 1e-9 ? rad / 2 / Math.sin(rad / 2) : 1);

/**
 * The samples that move `driver` from `from` to `to` with every part within `bounds` per step,
 * and the steps each joint value and moving occurrence take, or why it cannot be planned.
 */
export function planMotionCoverage(
  input: CoverageInput,
  driver: CadMotionDriver,
  bounds: CadMotionBounds,
): CadCoveragePlan {
  const refuse = (code: string, needed?: number): CadCoveragePlan => ({
    status: 'refused',
    code,
    ...(needed === undefined ? {} : { needed }),
  });
  const { doc, lookup, joints } = input;
  const joint = doc.joints.find((j) => j.id === driver.joint);
  if (!joint) return refuse('target-missing');
  const off = inactiveJointIds(doc);
  if (off.has(joint.id)) return refuse('joint-inactive');
  if (!cadJointValueKeys[joint.type].includes(driver.of)) return refuse('range-value');
  if (!ownJointValueKeys(joint).includes(driver.of)) return refuse('range-coupled');
  if (!Number.isFinite(driver.from) || !Number.isFinite(driver.to) || driver.from === driver.to)
    return refuse('coverage-span');
  if (
    !(bounds.stepMm >= cadCoverageLimits.minStepMm) ||
    !(bounds.stepRad >= cadCoverageLimits.minStepRad) ||
    !(bounds.stepRad <= cadCoverageLimits.maxStepRad) ||
    !Number.isFinite(bounds.stepMm) ||
    !Number.isFinite(bounds.stepRad)
  )
    return refuse('coverage-bounds');
  // Every joint in effect must solve: an unsolved follower would stay put (a mixed pose).
  for (const { id } of doc.joints) {
    if (off.has(id)) continue;
    const s = joints[id];
    if (s?.status === 'broken') return refuse('part-joint-broken');
    if (s?.status !== 'solved') return refuse('joint-part-unavailable');
  }
  const params = parameterValues(doc);
  const at = (v: number) => new Map([[driver.joint, { [driver.of]: v } as CadResolvedJointValues]]);
  const first = coupledJointValues(doc, params, at(driver.from));
  const last = coupledJointValues(doc, params, at(driver.to));
  // Linear couplings: the ends within the limits keep every value between them within too.
  if (jointLimitViolations(doc, first).length || jointLimitViolations(doc, last).length)
    return refuse('joint-limit');
  const moving: Omit<CadCoverageJointStep, 'step'>[] = [];
  let steps = 1;
  for (const j of doc.joints) {
    if (off.has(j.id)) continue;
    for (const of of cadJointValueKeys[j.type]) {
      const [a, b] = [first.get(j.id)?.[of], last.get(j.id)?.[of]];
      if (a === undefined || b === undefined || a === b) continue;
      const travel = Math.abs(b - a);
      moving.push({ joint: j.id, of, travel });
      const bound = isJointAngleKey(of) ? bounds.stepRad : bounds.stepMm;
      steps = Math.max(steps, Math.ceil(travel / bound - 1e-9));
    }
  }
  const limit = cadCoverageLimits.samples;
  if (steps + 1 > limit) return refuse('coverage-samples', steps + 1);

  const solved = { poses: doc.solvedPoses, joints };
  const posesAt = (v: number) => {
    const top = posesForJointValues(doc, solved, at(v), params);
    return { expansion: expandAssembly({ ...doc, solvedPoses: top }, lookup), top };
  };
  // The joint that moves each direct component (its child), for the chains of composed motion.
  const jointOf = new Map(
    doc.joints.filter((j) => !off.has(j.id)).map((j) => [j.child.componentId, j] as const),
  );
  // A path step names a component or a pattern copy (`copy:<pattern>:<i>`), which moves with its
  // seed's joint: the copy's pose is the pattern's move after the seed's, so the seed's joint
  // turns it about the pattern's image of the seed's joint centre.
  const chainOf = (step: string | undefined) => {
    const chain: { j: CadJoint; step: string }[] = [];
    const seen = new Set<string>();
    for (let at = step; at !== undefined && !seen.has(at); ) {
      seen.add(at);
      const seed = stepComponent(doc, at, params)?.component.id;
      const j = seed === undefined ? undefined : jointOf.get(seed);
      if (!j) break;
      chain.push({ j, step: at });
      at = j.parent.componentPath[0];
    }
    return chain;
  };
  /** Each joint value's change between two samples: turned (rad) and slid (mm). */
  const valueChange = (
    j: CadJoint,
    a: ReadonlyMap<string, CadResolvedJointValues>,
    b: ReadonlyMap<string, CadResolvedJointValues>,
  ) => {
    let rad = 0;
    let mm = 0;
    let keys = 0;
    for (const of of cadJointValueKeys[j.type]) {
      const d = Math.abs((b.get(j.id)?.[of] ?? 0) - (a.get(j.id)?.[of] ?? 0));
      if (!(d > 0)) continue;
      keys++;
      if (isJointAngleKey(of)) rad += d;
      else mm += d;
    }
    return { rad, mm, keys };
  };
  const valuesFor = (n: number) =>
    Array.from({ length: n + 1 }, (_, i) =>
      i === n ? driver.to : driver.from + ((driver.to - driver.from) * i) / n,
    );
  let parts: CadCoveragePart[] = [];
  let unmeasured: string[][] = [];
  for (let round = 0; ; round++) {
    const values = valuesFor(steps);
    const byKey = new Map<
      string,
      { path: string[]; mm: number; rad: number; moved: boolean; corners?: Vec3[] }
    >();
    const order: string[] = [];
    let before: Map<string, CadSolvedPose> | undefined;
    let beforeTop: Record<string, CadSolvedPose> | undefined;
    let beforeValues: ReadonlyMap<string, CadResolvedJointValues> | undefined;
    for (const v of values) {
      const { expansion, top } = posesAt(v);
      if (expansion.limit) return refuse(expansion.limit);
      const nowValues = coupledJointValues(doc, params, at(v));
      const now = new Map<string, CadSolvedPose>();
      for (const o of expansion.occurrences) {
        const key = interferenceKey(o.path);
        now.set(key, o.pose);
        let entry = byKey.get(key);
        if (!entry) {
          const given = o.content ? input.meshesOf(o.part.source.contentHash) : undefined;
          const corners = given ? meshCorners(given, o.content) : undefined;
          entry = { path: o.path, mm: 0, rad: 0, moved: false, ...(corners ? { corners } : {}) };
          byKey.set(key, entry);
          order.push(key);
        }
        const was = before?.get(key);
        if (!was) continue;
        const gap = poseGap(was, o.pose);
        const rad = gap.rad;
        entry.rad = Math.max(entry.rad, rad);
        // A part without meshes that only slides still moved (listed as unmeasured).
        if (gap.mm > 0 || rad > 0) entry.moved = true;
        if (entry.corners) {
          const corners = entry.corners.map((c) => place(was, c));
          // The joints that move this occurrence, from its own up to the assembly.
          const chain = chainOf(o.path[0])
            .map((x) => ({ ...x, d: valueChange(x.j, beforeValues!, nowValues) }))
            .filter((x) => x.d.keys > 0);
          let mm: number;
          if (chain.length <= 1 && (chain[0]?.d.keys ?? 1) === 1) {
            // One turn about a fixed axis (or one slide): the chord lengthened to the arc is exact.
            let chord = 0;
            for (const [i, c] of entry.corners.entries()) {
              const [p, q] = [corners[i]!, place(o.pose, c)];
              chord = Math.max(chord, Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]));
            }
            mm = chord * arc(rad);
          } else {
            // Composed motion (a joint on a moving parent, or several values of one joint): the
            // net turn says nothing of the path between (a counter-turning child keeps its
            // orientation while its origin swings round). A point's speed is at most the sum of
            // each joint's turn rate times its distance from that joint's centre, plus the slides;
            // that distance changes only by what the joints below it move the point.
            mm = 0;
            for (const { j, step, d } of chain) {
              const childPose = beforeTop && stepPose(doc, beforeTop, step, params);
              const solution = joints[j.id];
              let r = 0;
              if (childPose && solution?.status === 'solved') {
                const c = place(childPose, solution.child.translationMm);
                for (const p of corners)
                  r = Math.max(r, Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]));
              } else r = Infinity;
              mm += d.rad * (r + mm) + d.mm;
            }
          }
          entry.mm = Math.max(entry.mm, mm);
        }
      }
      before = now;
      beforeTop = top;
      beforeValues = nowValues;
    }
    // This document's own bodies never move (they are at its origin).
    const movers = order.map((k) => byKey.get(k)!).filter((e) => e.moved);
    parts = movers.map((e) => ({
      path: e.path,
      ...(e.corners ? { stepMm: e.mm } : {}),
      stepRad: e.rad,
    }));
    unmeasured = movers.filter((e) => !e.corners).map((e) => e.path);
    const worst = Math.max(0, ...parts.map((p) => p.stepMm ?? 0));
    if (worst <= bounds.stepMm * (1 + 1e-9)) {
      return {
        status: 'ok',
        steps,
        values,
        samples: values.map((v, tick) => ({ tick, values: at(v) })),
        joints: moving.map((m) => ({ ...m, step: m.travel / steps })),
        parts,
        unmeasured,
      };
    }
    // A point's move shrinks with the step: scale the count by how far over it is.
    const next = Math.max(steps + 1, Math.ceil(steps * (worst / bounds.stepMm) * 1.001));
    if (next + 1 > limit) return refuse('coverage-samples', next + 1);
    if (round + 1 >= cadCoverageLimits.rounds) return refuse('coverage-converge');
    steps = next;
  }
}

/**
 * PD6: plans the samples for `driver` within `bounds` (`planMotionCoverage`) and runs the MR5
 * check at each, with up to `cadCoverageLimits.samples` samples.
 */
export function checkCadMotionCoverage(
  input: CoverageInput,
  driver: CadMotionDriver,
  bounds: CadMotionBounds = {
    stepMm: cadCoverageLimits.defaultStepMm,
    stepRad: cadCoverageLimits.defaultStepRad,
  },
): CadCoverageReport {
  const plan = planMotionCoverage(input, driver, bounds);
  if (plan.status === 'refused') return plan;
  const sweep = checkCadInterferenceAlong(input, plan.samples, cadCoverageLimits.samples);
  if (sweep.status === 'refused') return sweep;
  const { samples: _samples, ...rest } = plan;
  return {
    ...rest,
    driver,
    bounds,
    hits: sweep.hits,
    jumps: sweep.jumps,
    unchecked: sweep.unchecked,
    stale: sweep.stale,
  };
}
