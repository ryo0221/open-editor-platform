/**
 * MR3 interference in an assembly (docs/cad/mecha-design.md, MR3（干渉の検査）): the document's
 * explicit allowances, and the bodies and allowances `checkInterference` (geometry-core) reads
 * for the current pose or a form's. Pure: meshes and joint solutions come from the caller.
 */
import {
  checkInterference,
  type InterferenceAllowance,
  type InterferenceBody,
  type InterferenceFinding,
  type InterferenceMesh,
  type InterferenceResult,
} from '@editor-platform/geometry-core/interference';
import {
  composePoses,
  expandAssembly,
  identityPose,
  parseCopyStep,
  stepPose,
  type CadPartLookup,
  type CadSolvedPose,
} from './assembly';
import { configurationStale, type CadConfiguration } from './configurations';
import { parameterValues } from './graph';
import {
  cadJointLimits,
  invertPose,
  jointValues,
  posesForJointValues,
  type CadJointSolution,
  type CadResolvedJointValues,
} from './joints';
import type { CadDocument } from './model';
import { poseGap } from './mount-gaps';
import { inactiveJointIds, mountChoice, type CadMountChoice } from './mounts';

/**
 * An explicit allowance: the pair `a`–`b` (component paths; `[]` is this document's own bodies)
 * may overlap, wholly or only near a joint (inside a sphere around its parent connector's
 * origin). There are none by default: joined parts are checked like any others.
 */
export interface CadInterferenceAllowance {
  id: string;
  a: string[];
  b: string[];
  region: { kind: 'pair' } | { kind: 'joint-sphere'; joint: string; radiusMm: number };
}
export const cadInterferenceLimits = Object.freeze({ allowances: 256 });

export type CadInterferenceOperation =
  | { type: 'insertInterferenceAllowance'; allowance: CadInterferenceAllowance }
  | { type: 'removeInterferenceAllowance'; id: string };

const fail = (code: string): never => {
  throw new Error(code);
};
/** The geometry body ID of a component path. */
export const interferenceKey = (path: readonly string[]) => JSON.stringify(path);
const samePair = (x: CadInterferenceAllowance, a: readonly string[], b: readonly string[]) => {
  const [p, q] = [interferenceKey(x.a), interferenceKey(x.b)];
  const [s, t] = [interferenceKey(a), interferenceKey(b)];
  return (p === s && q === t) || (p === t && q === s);
};

export function applyInterferenceOperation(next: CadDocument, op: CadInterferenceOperation) {
  const list = next.interferenceAllowances ?? [];
  switch (op.type) {
    case 'insertInterferenceAllowance': {
      if (list.length >= cadInterferenceLimits.allowances) fail('limit-interference-allowances');
      const x = op.allowance;
      // One allowance of a kind per pair (and joint): a second would change nothing.
      if (
        list.some(
          (y) =>
            samePair(y, x.a, x.b) &&
            y.region.kind === x.region.kind &&
            (y.region.kind === 'pair' ||
              (x.region.kind === 'joint-sphere' && y.region.joint === x.region.joint)),
        )
      )
        fail('interference-allowance-duplicate');
      next.interferenceAllowances = [...list, structuredClone(x)];
      return next;
    }
    case 'removeInterferenceAllowance': {
      if (!list.some((x) => x.id === op.id)) fail('target-missing');
      const rest = list.filter((x) => x.id !== op.id);
      if (rest.length) next.interferenceAllowances = rest;
      else delete next.interferenceAllowances;
      return next;
    }
  }
}

type Rec = Record<string, unknown>;
const record = (v: unknown): v is Rec =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
export interface InterferenceCheck {
  error(code: string, path: string): boolean;
  keys(v: Rec, required: string[], path: string, optional?: string[]): boolean;
  id(v: unknown, path: string): v is string;
}
/**
 * The shape of `interferenceAllowances` (1–256 when present): IDs, two different paths of
 * component IDs (at most the assembly depth), a pair or a joint sphere with a positive radius.
 * Whether the paths and joint still exist is not checked here: an allowance that no longer
 * names them is shown stale and not applied, as a stale form is.
 */
export function validateInterferenceAllowances(
  c: InterferenceCheck,
  list: unknown,
  isId: (v: unknown) => boolean,
) {
  const path = '$.interferenceAllowances';
  if (!Array.isArray(list) || list.length === 0) return c.error('interference-allowances', path);
  if (list.length > cadInterferenceLimits.allowances)
    c.error('limit-interference-allowances', path);
  list.forEach((x, i) => {
    const at = `${path}[${i}]`;
    if (!record(x) || !c.keys(x, ['id', 'a', 'b', 'region'], at))
      return c.error('interference-allowance', at);
    c.id(x.id, `${at}.id`);
    // A step is a component ID, or a pattern copy whose pattern ID is one (the step may be
    // longer than an ID).
    const step = (s: unknown) => typeof s === 'string' && isId(parseCopyStep(s)?.patternId ?? s);
    const steps = (v: unknown) =>
      Array.isArray(v) && v.length <= cadJointLimits.path && v.every(step);
    if (!steps(x.a)) c.error('interference-allowance-path', `${at}.a`);
    if (!steps(x.b)) c.error('interference-allowance-path', `${at}.b`);
    if (
      steps(x.a) &&
      steps(x.b) &&
      interferenceKey(x.a as string[]) === interferenceKey(x.b as string[])
    )
      c.error('interference-allowance-same', `${at}.b`);
    const r = x.region;
    const rp = `${at}.region`;
    if (!record(r)) return c.error('interference-allowance-region', rp);
    if (r.kind === 'pair') c.keys(r, ['kind'], rp);
    else if (r.kind === 'joint-sphere') {
      c.keys(r, ['kind', 'joint', 'radiusMm'], rp);
      if (!isId(r.joint)) c.error('interference-allowance-joint', `${rp}.joint`);
      if (
        typeof r.radiusMm !== 'number' ||
        !(r.radiusMm > 0 && r.radiusMm <= cadJointLimits.lengthMm)
      )
        c.error('interference-allowance-radius', `${rp}.radiusMm`);
    } else c.error('interference-allowance-region', `${rp}.kind`);
  });
}

/** A mesh as the kernel gives it: positions relative to `origin`, in the part's coordinates. */
export interface CadInterferenceMesh {
  bodyId: string;
  origin: [number, number, number];
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  /** A simplified alternative of the body's standard mesh (the kernel's `coarse` output). */
  lod?: 'coarse';
  /** The body as it was before a failed feature (the kernel's display fallback): not checked. */
  beforeFailure?: string;
}
/**
 * The meshes to check: a body's shape before a failed feature is not its result, so it is
 * dropped (the body is then uncovered), and each body keeps its standard meshes, or its coarse
 * ones when only those are given, never both (two copies of a surface cancel containment).
 */
export function checkedMeshes(meshes: readonly CadInterferenceMesh[]) {
  const usable = meshes.filter((m) => m.beforeFailure === undefined);
  const standard = new Set(usable.filter((m) => !m.lod).map((m) => m.bodyId));
  return usable.filter((m) => !m.lod || !standard.has(m.bodyId));
}
export interface CadInterferenceInput {
  doc: CadDocument;
  lookup: CadPartLookup;
  /** A version's meshes by content hash; undefined when they are not at hand. */
  meshesOf: (contentHash: string) => readonly CadInterferenceMesh[] | undefined;
  /** This document's own bodies' meshes; when it has active bodies and none are given, they
   * are listed unchecked. */
  ownMeshes?: readonly CadInterferenceMesh[];
  /** The current joint solutions (where each parent connector is), for joint spheres. */
  joints: Record<string, CadJointSolution>;
  /** A form to check in instead of the current pose. */
  form?: CadConfiguration;
  /**
   * MR5: joint values to check in instead (radians, mm; a joint left out keeps its own, a
   * coupled value follows). Not with `form`.
   */
  values?: ReadonlyMap<string, CadResolvedJointValues>;
  /** MR7: the candidate in effect for each mount with `values` (the document's own if not given). */
  mounts?: CadMountChoice;
}
export interface CadInterferenceFinding
  extends Omit<InterferenceFinding, 'a' | 'b' | 'unknownBody'> {
  a: string[];
  b: string[];
  unknown?: string[];
}
export type CadInterferenceReport =
  | {
      status: 'ok';
      findings: CadInterferenceFinding[];
      /** Occurrences not checked: their meshes are not at hand (never reported clear). */
      unchecked: string[][];
      /** Allowances that name a path or joint no longer there, or a joint not solved. */
      stale: string[];
      pairs: number;
      triangles: number;
    }
  | { status: 'refused'; code: string };

/**
 * A mesh list as geometry reads it: the checked meshes (see `checkedMeshes`) moved to one origin
 * and grouped by body. Cached per given array, so repeated occurrences of a part and rechecks
 * reuse the same arrays (and geometry-core's prepared BVHs).
 */
const prepared = new WeakMap<
  readonly CadInterferenceMesh[],
  { bodyIds: Set<string>; byBody: Map<string, InterferenceMesh[]> }
>();
export function prepareMeshes(
  meshes: readonly CadInterferenceMesh[],
  content: CadDocument | undefined,
) {
  const hit = prepared.get(meshes);
  if (hit) return hit;
  // A sheet body has no inside; a part's solids are checked for containment.
  const sheets = new Set(content?.bodies.filter((b) => b.kind === 'sheet').map((b) => b.id));
  const byBody = new Map<string, InterferenceMesh[]>();
  for (const m of checkedMeshes(meshes)) {
    const p = new Float64Array(m.positions.length);
    for (let i = 0; i < p.length; i++) p[i] = m.positions[i]! + m.origin[i % 3]!;
    const list = byBody.get(m.bodyId) ?? [];
    list.push({ positions: p, indices: m.indices, sheet: sheets.has(m.bodyId) });
    byBody.set(m.bodyId, list);
  }
  const out = { bodyIds: new Set(byBody.keys()), byBody };
  prepared.set(meshes, out);
  return out;
}

/** The poses a form puts the direct components in (the current solutions moved by its values). */
export function formPoses(
  doc: CadDocument,
  joints: Record<string, CadJointSolution>,
  form: CadConfiguration,
): Record<string, CadSolvedPose> {
  const params = parameterValues(doc);
  const values = new Map<string, CadResolvedJointValues>();
  for (const j of doc.joints) {
    const v = form.values[j.id];
    if (v) values.set(j.id, jointValues({ type: j.type, values: v }, params));
  }
  return posesForJointValues(
    doc,
    { poses: doc.solvedPoses, joints },
    values,
    params,
    mountChoice(form.mounts),
  );
}

/**
 * Checks the assembly in its current pose or a form's: each occurrence (and this document's own
 * bodies) as a body, the allowances the document names, and which could not be used.
 */
export function checkCadInterference(input: CadInterferenceInput): CadInterferenceReport {
  const { doc, lookup, joints } = input;
  const params = parameterValues(doc);
  // A stale form cannot be recalled, so its pose is not checked either (not a mixed pose).
  if (input.form && configurationStale(doc, input.form))
    return { status: 'refused', code: 'configuration-stale' };
  // Every joint must solve for a form's pose, not only those it names: a coupled follower or a
  // fastened descendant moves with them, and an unsolved one would stay put (a mixed pose).
  // The candidates in effect for the checked pose (MR7): a joint sphere of another is not used.
  const choice = input.form ? mountChoice(input.form.mounts) : input.mounts;
  const off = inactiveJointIds(doc, choice);
  if (input.form || input.values || input.mounts)
    for (const { id } of doc.joints) {
      if (off.has(id)) continue;
      const s = joints[id];
      if (s?.status === 'broken') return { status: 'refused', code: 'part-joint-broken' };
      if (s?.status !== 'solved') return { status: 'refused', code: 'joint-part-unavailable' };
    }
  const posed: CadDocument = input.form
    ? { ...doc, solvedPoses: formPoses(doc, joints, input.form) }
    : input.values || input.mounts
      ? {
          ...doc,
          solvedPoses: posesForJointValues(
            doc,
            { poses: doc.solvedPoses, joints },
            input.values ?? new Map(),
            params,
            input.mounts,
          ),
        }
      : doc;
  const expansion = expandAssembly(posed, lookup);
  if (expansion.limit) return { status: 'refused', code: expansion.limit };
  const bodies: InterferenceBody[] = [];
  const unchecked: string[][] = [];
  const paths = new Map<string, string[]>();
  const groupOf = new Map<string, string>();
  const add = (path: string[], meshes: ReturnType<typeof prepareMeshes>, pose: CadSolvedPose) => {
    // Each body is its own volume (nested bodies must not cancel as a cavity would), grouped by
    // the occurrence.
    const key = interferenceKey(path);
    paths.set(key, path);
    for (const [bodyId, list] of meshes.byBody) {
      const id = `${key}#${bodyId}`;
      groupOf.set(id, key);
      bodies.push({
        id,
        group: key,
        meshes: list,
        pose: { rotation: pose.rotation, translationMm: pose.translationMm },
      });
    }
  };
  // Checked only with a mesh for every active body: after a failed evaluation the kernel gives
  // meshes for some bodies only, and an omitted one was never tested.
  const covers = (content: CadDocument, meshes: ReturnType<typeof prepareMeshes> | undefined) =>
    !!meshes && content.bodies.every((b) => b.state !== 'active' || meshes.bodyIds.has(b.id));
  // This document's own bodies are one body at its origin; without their meshes, unchecked.
  const own = doc.bodies.some((b) => b.state === 'active');
  const ownMeshes = input.ownMeshes && prepareMeshes(input.ownMeshes, doc);
  if (own && covers(doc, ownMeshes)) add([], ownMeshes!, identityPose());
  else if (own) unchecked.push([]);
  for (const o of expansion.occurrences) {
    const given = o.content ? input.meshesOf(o.part.source.contentHash) : undefined;
    const meshes = given && prepareMeshes(given, o.content);
    if (!o.content || !covers(o.content, meshes)) {
      unchecked.push(o.path);
      continue;
    }
    add(o.path, meshes!, o.pose);
  }
  // Allowances: a joint sphere sits on the joint's parent connector, moved with the component
  // it lies on to the checked pose.
  const stale: string[] = [];
  const allowances: InterferenceAllowance[] = [];
  for (const x of doc.interferenceAllowances ?? []) {
    const [a, b] = [interferenceKey(x.a), interferenceKey(x.b)];
    if (!paths.has(a) && !unchecked.some((p) => interferenceKey(p) === a)) stale.push(x.id);
    else if (!paths.has(b) && !unchecked.some((p) => interferenceKey(p) === b)) stale.push(x.id);
    else if (x.region.kind === 'pair') allowances.push({ a, b, region: { kind: 'pair' } });
    else {
      const jointId = (x.region as { joint: string }).joint;
      // A candidate not in effect places nothing: its sphere is not applied (not stale).
      if (off.has(jointId)) continue;
      const joint = doc.joints.find((j) => j.id === jointId);
      const solution = joint && joints[joint.id];
      // Only a solved joint places the sphere; an unavailable one keeps a parent frame, but the
      // allowance names a joint that did not solve, so it is stale.
      const parent = solution?.status === 'solved' ? solution.parent : undefined;
      if (!joint || !parent) {
        stale.push(x.id);
        continue;
      }
      const [first] = joint.parent.componentPath;
      const before =
        first === undefined ? identityPose() : stepPose(doc, doc.solvedPoses, first, params);
      const after =
        first === undefined ? identityPose() : stepPose(posed, posed.solvedPoses, first, params);
      if (!before || !after) {
        stale.push(x.id);
        continue;
      }
      const center = composePoses(after, composePoses(invertPose(before), parent)).translationMm;
      allowances.push({
        a,
        b,
        region: { kind: 'sphere', centerMm: [...center], radiusMm: x.region.radiusMm },
      });
    }
  }
  const result: InterferenceResult = checkInterference(bodies, allowances);
  if (result.status === 'refused') return { status: 'refused', code: result.code };
  const back = (key: string) => paths.get(key) ?? (JSON.parse(key) as string[]);
  // One finding per occurrence pair from its bodies' findings: the strongest kind (crossing,
  // then containment, then undecidable), the deepest depth, the counts summed.
  const rank = { intersect: 2, contain: 1, unknown: 0 } as const;
  const merged = new Map<string, InterferenceFinding>();
  for (const f of result.findings) {
    const a = groupOf.get(f.a)!;
    const b = groupOf.get(f.b)!;
    const k = a < b ? `${a}\n${b}` : `${b}\n${a}`;
    const g = {
      ...f,
      a,
      b,
      ...(f.unknownBody === undefined ? {} : { unknownBody: groupOf.get(f.unknownBody)! }),
    };
    const m = merged.get(k);
    if (!m) {
      merged.set(k, g);
      continue;
    }
    if (rank[g.kind] > rank[m.kind]) {
      m.kind = g.kind;
      delete m.unknownBody;
    }
    if (m.kind === 'unknown' && m.unknownBody === undefined && g.unknownBody !== undefined)
      m.unknownBody = g.unknownBody;
    m.depthMm = Math.max(m.depthMm, g.depthMm);
    m.crossings += g.crossings;
    m.contained += g.contained;
  }
  return {
    status: 'ok',
    findings: [...merged.values()].map(({ a, b, unknownBody, ...rest }) => ({
      ...rest,
      a: back(a),
      b: back(b),
      ...(unknownBody === undefined ? {} : { unknown: back(unknownBody) }),
    })),
    unchecked,
    stale,
    pairs: result.pairs,
    triangles: result.triangles,
  };
}

/** MR5: a time of an action and the joint values the assembly has then. */
export interface CadSweepSample {
  tick: number;
  values: ReadonlyMap<string, CadResolvedJointValues>;
  /** MR7: the candidate in effect for each mount then (the document's own if not given). */
  mounts?: CadMountChoice;
}
/** MR7: a mount switched at a sampled time with the part moving more than the tolerance. */
export interface CadSweepJump {
  tick: number;
  mount: string;
  from: string;
  to: string;
  mm: number;
  rad: number;
}
export const cadSweepLimits = Object.freeze({ samples: 600 });
/** The occurrence pairs that overlap at one sampled time. */
export interface CadSweepHit {
  tick: number;
  findings: CadInterferenceFinding[];
}
export type CadSweepReport =
  | {
      status: 'ok';
      samples: number;
      /** Each sampled time with an overlap, in time order. */
      hits: CadSweepHit[];
      /** MR7: each switch of a mount that moves its part ("持ち替えで部品が跳ぶ"), in time order. */
      jumps: CadSweepJump[];
      /** Occurrences not checked (their meshes are not at hand): never reported clear. */
      unchecked: string[][];
      stale: string[];
    }
  | { status: 'refused'; code: string; tick?: number };

/**
 * MR5 (docs/cad/mecha-design.md, MR5（途中の干渉）): the MR3 check at each sampled time of a
 * motion, the joints solved for its values (pure, no kernel) and only the poses changing: the
 * meshes and their BVHs are prepared once. An overlap shorter than the interval between samples
 * can be missed. At most `cadSweepLimits.samples` times.
 */
export function checkCadInterferenceAlong(
  input: Omit<CadInterferenceInput, 'form' | 'values'>,
  samples: readonly CadSweepSample[],
): CadSweepReport {
  if (!samples.length || samples.length > cadSweepLimits.samples)
    return { status: 'refused', code: 'sweep-samples' };
  const hits: CadSweepHit[] = [];
  const jumps: CadSweepJump[] = [];
  let unchecked: string[][] = [];
  let stale: string[] = [];
  const { doc, joints } = input;
  const inEffect = (choice: CadMountChoice | undefined, id: string) => {
    const m = doc.mounts!.find((x) => x.id === id)!;
    const c = choice?.get(id);
    return c !== undefined && m.joints.includes(c) ? c : m.active;
  };
  let before: CadMountChoice | undefined;
  // Each sample's own mounts, or the document's: never a choice the input carries.
  const { mounts: _ignored, ...base } = input as CadInterferenceInput;
  const params = parameterValues(doc);
  const solved = { poses: doc.solvedPoses, joints };
  for (const [i, sample] of [...samples].sort((a, b) => a.tick - b.tick).entries()) {
    const r = checkCadInterference({
      ...base,
      values: sample.values,
      ...(sample.mounts ? { mounts: sample.mounts } : {}),
    });
    if (r.status === 'refused') return { status: 'refused', code: r.code, tick: sample.tick };
    if (i === 0) [unchecked, stale] = [r.unchecked, r.stale];
    if (r.findings.length) hits.push({ tick: sample.tick, findings: r.findings });
    // A switch since the last sample (the first sample against the document's own choice):
    // where each switched part is at this time under all the choices before and all the choices
    // now (a parent switching with it included).
    const switched = (doc.mounts ?? [])
      .map((m) => ({ m, from: inEffect(before, m.id), to: inEffect(sample.mounts, m.id) }))
      .filter((x) => x.from !== x.to);
    if (switched.length) {
      const was = posesForJointValues(doc, solved, sample.values, params, before);
      const now = posesForJointValues(doc, solved, sample.values, params, sample.mounts);
      for (const { m, from, to } of switched) {
        const unsolved = joints[from]?.status !== 'solved' || joints[to]?.status !== 'solved';
        const [a, b] = [was[m.component], now[m.component]];
        const gap =
          unsolved || !a || !b ? { mm: Infinity, rad: Infinity, within: false } : poseGap(a, b);
        if (gap.within) continue;
        jumps.push({ tick: sample.tick, mount: m.id, from, to, mm: gap.mm, rad: gap.rad });
      }
    }
    before = sample.mounts;
  }
  return { status: 'ok', samples: samples.length, hits, jumps, unchecked, stale };
}
