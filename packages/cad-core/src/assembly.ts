/**
 * R2b assembly (docs/cad/r2b-assembly.md, R2b-1): a `cad` document that places saved versions of
 * other `cad` documents. Parts are definitions (which exact version), components are placements
 * of them, and `solvedPoses` holds every component's last solved pose. Joints (R2b-2) place
 * components on each other; component patterns (R2b-3) repeat a component, and their copies are
 * derived from the seed's pose and the pattern, never stored.
 */
import {
  parameterValues,
  resolveAngle,
  resolveCount,
  resolveLength,
  resolvePosition,
  type ParameterValues,
} from './graph';
import type { CadJoint } from './joints';
import type { CadDocument, CadPatternLayout, Position3, Quaternion, Vec3 } from './model';

/** The values this document gives a BOM when another assembly uses it as a part. */
export interface CadPartProperties {
  partNumber: string;
  description: string;
}
/** A saved version of another `cad` Artifact (immutable; never a draft or "latest"). */
export interface CadPartVersionSource {
  kind: 'version';
  artifactId: string;
  versionId: string;
  /** Plain 64-hex SHA-256 of the version's canonical content (the version's `contentHash`). */
  contentHash: string;
}
/**
 * R2b-5 (R2b-U7): one solid or sheet of a product read from a STEP assembly. Its shape is a
 * history-less part document (`importedPartDocument`) kept in the retained closure like a
 * version, named by its content hash; the asset IDs are that document's.
 */
export interface CadPartImportedSource {
  kind: 'imported';
  contentHash: string;
  /** The STEP file the assembly was read from (`source-step`). */
  sourceAssetId: string;
  /** This shape as a normalized BRep (`normalized-brep`). */
  brepAssetId: string;
  /** The STEP product it came from, as the file named it. */
  stepProduct: { id: string; name: string; description: string };
}
export type CadPartSource = CadPartVersionSource | CadPartImportedSource;
/** A saved version's Artifact, or none for a part imported into this document. */
export const partArtifactId = (source: CadPartSource) =>
  source.kind === 'version' ? source.artifactId : undefined;
/** A saved version's ID, or none for a part imported into this document. */
export const partVersionId = (source: CadPartSource) =>
  source.kind === 'version' ? source.versionId : undefined;
export interface CadPartDef {
  id: string;
  name: string;
  source: CadPartSource;
  /** Bounds when inserted: drawn before the part evaluates and when its source cannot be read. */
  hint: { boundsMm: [Vec3, Vec3] };
}
export interface CadComponentPlacement {
  translation: Position3;
  rotation: Quaternion;
}
export interface CadComponent {
  id: string;
  name: string;
  partId: string;
  /** Fixed to the assembly origin; `null` for a joint's child, which its joint places. */
  placement: CadComponentPlacement | null;
  bom: 'include' | 'exclude';
}
/**
 * R2b-3: copies of a direct component, laid out as R1's body patterns are (`count` includes the
 * seed, which is copy 0). Copy `i` is the path step `copy:<pattern ID>:<i>` (1 … count − 1);
 * its pose is the pattern's move `i` applied to the seed's pose in this document.
 */
export interface CadComponentPattern {
  id: string;
  name: string;
  seedComponentId: string;
  layout: CadPatternLayout;
}
export type { CadJoint };
export interface CadSolvedPose {
  translationMm: Vec3;
  rotation: Quaternion;
}

/** Safety limits (docs/cad/r2b-assembly.md, 上限). Not performance claims. */
export const cadAssemblyLimits = Object.freeze({
  parts: 512,
  components: 1_024,
  /** Component occurrences with nested assemblies expanded. */
  instances: 10_000,
  /** Nesting through referenced versions; the assembly's own components are depth 1. */
  depth: 8,
  /** Distinct versions in the retained closure, nested ones included. */
  closureVersions: 512,
  /** Component pattern copies in one document, the seeds included (counts summed). */
  patternCopies: 4_096,
});
/** A stored pose matches its placement within these residuals (R2b-U5). */
export const cadPoseTolerance = Object.freeze({ lengthMm: 1e-6, angleRad: 1e-9 });

export const isAssembly = (doc: Pick<CadDocument, 'components'>) => doc.components.length > 0;

/** The pose a fixed placement solves to with these parameter values. */
export function solvePlacement(
  placement: CadComponentPlacement,
  params: ParameterValues,
): CadSolvedPose {
  return {
    translationMm: resolvePosition(placement.translation, params),
    rotation: [...placement.rotation],
  };
}
/**
 * Re-solves `solvedPoses` in place for every component fixed by its placement. Operations call
 * it after each edit, so a stored pose follows the parameters its placement reads. A joint's
 * child keeps its stored pose: its joint is solved from part evaluations, which the
 * coordinator writes into the same edit (`withSolvedPoses`).
 */
export function solveAssemblyPoses(doc: CadDocument, params: ParameterValues) {
  const poses: Record<string, CadSolvedPose> = {};
  for (const c of doc.components)
    poses[c.id] = c.placement
      ? solvePlacement(c.placement, params)
      : (poseOf(doc.solvedPoses, c.id) ?? identityPose());
  doc.solvedPoses = poses;
}

const normalize = (q: Quaternion): Quaternion => {
  const n = Math.hypot(...q);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
};
/** Hamilton product `a·b` of `[x, y, z, w]` quaternions. */
export function multiplyQuaternions(a: Quaternion, b: Quaternion): Quaternion {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}
export function rotateVector(q: Quaternion, v: Vec3): Vec3 {
  const [x, y, z, w] = normalize(q);
  // v + 2w(q×v) + 2q×(q×v)
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}
/** `parent ∘ child`: the child's pose expressed in the parent's frame, moved into the world. */
export function composePoses(parent: CadSolvedPose, child: CadSolvedPose): CadSolvedPose {
  const t = rotateVector(parent.rotation, child.translationMm);
  return {
    translationMm: [
      parent.translationMm[0] + t[0],
      parent.translationMm[1] + t[1],
      parent.translationMm[2] + t[2],
    ],
    rotation: normalize(multiplyQuaternions(normalize(parent.rotation), normalize(child.rotation))),
  };
}
export const identityPose = (): CadSolvedPose => ({
  translationMm: [0, 0, 0],
  rotation: [0, 0, 0, 1],
});
/** A component's pose by ID: own entries only, so an ID such as `toString` is never inherited. */
export const poseOf = (poses: Record<string, CadSolvedPose>, id: string) =>
  Object.hasOwn(poses, id) ? poses[id] : undefined;
/** The path step naming copy `index` of a component pattern. */
export const copyStep = (patternId: string, index: number) => `copy:${patternId}:${index}`;
/** A `copy:<pattern ID>:<i>` step's pattern and index (i ≥ 1), or undefined for any other step. */
export function parseCopyStep(step: string): { patternId: string; index: number } | undefined {
  if (!step.startsWith('copy:')) return undefined;
  const at = step.lastIndexOf(':');
  const index = step.slice(at + 1);
  if (at <= 5 || !/^[1-9][0-9]{0,3}$/.test(index)) return undefined;
  return { patternId: step.slice(5, at), index: Number(index) };
}
/** The move of a pattern's copy `index`, in the frame its seed is placed in. */
export function patternMove(
  layout: CadPatternLayout,
  index: number,
  params: ParameterValues,
): CadSolvedPose {
  if (layout.type === 'linear') {
    const d = resolveLength(layout.spacing, params) * index;
    const [x, y, z] = layout.direction;
    return { translationMm: [x * d, y * d, z * d], rotation: [0, 0, 0, 1] };
  }
  const half = (resolveAngle(layout.angle, params) * index) / 2;
  const [ax, ay, az] = layout.axisDirection;
  const n = Math.hypot(ax, ay, az);
  const s = Math.sin(half) / n;
  const rotation: Quaternion = [ax * s, ay * s, az * s, Math.cos(half)];
  // A turn about the axis through `axisOrigin`: o − R·o moves the turned origin back onto it.
  const o = resolvePosition(layout.axisOrigin, params);
  const r = rotateVector(rotation, o);
  return { translationMm: [o[0] - r[0], o[1] - r[1], o[2] - r[2]], rotation };
}
/** How many components a pattern lays out, its seed included. */
export const patternCount = (pattern: CadComponentPattern, params: ParameterValues) =>
  resolveCount(pattern.layout.count, params);
/**
 * The component a direct path step of `owner` names: a component by ID, or a pattern copy
 * (whose component is its seed). Undefined when nothing has that ID, the pattern is gone, or
 * its count no longer reaches the copy.
 */
export function stepComponent(
  owner: Pick<CadDocument, 'components' | 'componentPatterns' | 'parameters'>,
  step: string,
  params: ParameterValues = parameterValues(owner),
): { component: CadComponent; pattern?: CadComponentPattern; index: number } | undefined {
  const copy = parseCopyStep(step);
  if (!copy) {
    const component = owner.components.find((c) => c.id === step);
    return component && { component, index: 0 };
  }
  const pattern = owner.componentPatterns.find((p) => p.id === copy.patternId);
  if (!pattern || copy.index >= patternCount(pattern, params)) return undefined;
  const component = owner.components.find((c) => c.id === pattern.seedComponentId);
  return component && { component, pattern, index: copy.index };
}
/** A direct path step's pose in `owner` from these component poses (a copy from its seed's). */
export function stepPose(
  owner: Pick<CadDocument, 'components' | 'componentPatterns' | 'parameters'>,
  poses: Record<string, CadSolvedPose>,
  step: string,
  params: ParameterValues = parameterValues(owner),
): CadSolvedPose | undefined {
  const at = stepComponent(owner, step, params);
  const pose = at && poseOf(poses, at.component.id);
  if (!at?.pattern || !pose) return pose;
  return composePoses(patternMove(at.pattern.layout, at.index, params), pose);
}
/** Each component's copies in `owner`, in pattern order: the step, the seed and the pattern. */
export function componentCopies(
  owner: Pick<CadDocument, 'components' | 'componentPatterns'>,
  params: ParameterValues,
) {
  const copies = new Map<string, { step: string; pattern: CadComponentPattern; index: number }[]>();
  for (const pattern of owner.componentPatterns) {
    const list = copies.get(pattern.seedComponentId) ?? [];
    for (let i = 1; i < patternCount(pattern, params); i++)
      list.push({ step: copyStep(pattern.id, i), pattern, index: i });
    copies.set(pattern.seedComponentId, list);
  }
  return copies;
}
/** Rotation angle between two orientations, stable near zero. */
export function quaternionAngle(a: Quaternion, b: Quaternion): number {
  const [x, y, z, w] = normalize(a);
  const d = multiplyQuaternions([-x, -y, -z, w], normalize(b));
  return 2 * Math.atan2(Math.hypot(d[0], d[1], d[2]), Math.abs(d[3]));
}
/** Whether two poses differ by more than the stored-pose residuals. */
export function posesDiffer(a: CadSolvedPose, b: CadSolvedPose): boolean {
  const dt = Math.hypot(
    a.translationMm[0] - b.translationMm[0],
    a.translationMm[1] - b.translationMm[1],
    a.translationMm[2] - b.translationMm[2],
  );
  return (
    !(dt <= cadPoseTolerance.lengthMm) ||
    !(quaternionAngle(a.rotation, b.rotation) <= cadPoseTolerance.angleRad)
  );
}
/** Column-major 4×4 matrix of a pose (mm), as three.js `Matrix4.fromArray` reads it. */
export function poseMatrix(pose: CadSolvedPose): number[] {
  const [x, y, z, w] = normalize(pose.rotation);
  const [tx, ty, tz] = pose.translationMm;
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y + z * w),
    2 * (x * z - y * w),
    0,
    2 * (x * y - z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z + x * w),
    0,
    2 * (x * z + y * w),
    2 * (y * z - x * w),
    1 - 2 * (x * x + y * y),
    0,
    tx,
    ty,
    tz,
    1,
  ];
}

/** Reads a retained version by content hash: verified content, or undefined when it is absent. */
export type CadPartLookup = (contentHash: string) => CadDocument | undefined;
/** One placed occurrence: a component of the assembly or of a nested sub-assembly. */
export interface CadAssemblyOccurrence {
  /** Component IDs from the assembly down to this occurrence. */
  path: string[];
  /** The part definition, in the document that owns the component. */
  part: CadPartDef;
  /** World pose of the part's origin. */
  pose: CadSolvedPose;
  /** The part's content when the closure has it. */
  content: CadDocument | undefined;
}
export interface CadAssemblyExpansion {
  occurrences: CadAssemblyOccurrence[];
  /** Every version reached, by content hash, in first-reached order. */
  versions: Map<string, CadDocument>;
  /** Hashes named but not in the closure. */
  missing: Set<string>;
  /** Deepest nesting reached (0 for a document without components). */
  depth: number;
  /** A limit the expansion stopped at: nothing past it is listed. */
  limit?: 'limit-assembly-depth' | 'limit-instances' | 'limit-closure-versions';
}
/**
 * Every occurrence with its world pose, through nested versions (whose own poses stay as they
 * were saved). Pure: reads only `doc` and the lookup.
 */
export function expandAssembly(doc: CadDocument, lookup: CadPartLookup): CadAssemblyExpansion {
  const out: CadAssemblyExpansion = {
    occurrences: [],
    versions: new Map(),
    missing: new Set(),
    depth: 0,
  };
  const walk = (owner: CadDocument, path: string[], base: CadSolvedPose, depth: number) => {
    const parts = new Map(owner.parts.map((p) => [p.id, p]));
    const params: ParameterValues = owner.componentPatterns.length
      ? parameterValues(owner)
      : new Map();
    const copies = componentCopies(owner, params);
    for (const c of owner.components) {
      const part = parts.get(c.partId);
      const seed = poseOf(owner.solvedPoses, c.id);
      if (!part || !seed) continue;
      // The seed, then each of its pattern copies right after it.
      const steps = [
        { step: c.id, local: seed },
        ...(copies.get(c.id) ?? []).map((x) => ({
          step: x.step,
          local: composePoses(patternMove(x.pattern.layout, x.index, params), seed),
        })),
      ];
      for (const { step, local } of steps) {
        if (out.limit) return;
        if (depth > cadAssemblyLimits.depth) return void (out.limit = 'limit-assembly-depth');
        if (out.occurrences.length >= cadAssemblyLimits.instances)
          return void (out.limit = 'limit-instances');
        out.depth = Math.max(out.depth, depth);
        const hash = part.source.contentHash;
        let content = out.versions.get(hash);
        if (!content && !out.missing.has(hash)) {
          content = lookup(hash);
          if (!content) out.missing.add(hash);
          else if (out.versions.size >= cadAssemblyLimits.closureVersions)
            return void (out.limit = 'limit-closure-versions');
          else out.versions.set(hash, content);
        }
        const pose = composePoses(base, local);
        const at = [...path, step];
        out.occurrences.push({ path: at, part, pose, content });
        if (content?.components.length) walk(content, at, pose, depth + 1);
      }
    }
  };
  walk(doc, [], identityPose(), 1);
  return out;
}

/**
 * Whether each occurrence may be shown: its own Artifact and every enclosing sub-assembly's must
 * be readable (a revoked sub-assembly hides what it places). Parallel to `occurrences`, which
 * list a parent before its children.
 */
export function occurrenceAccess(
  occurrences: CadAssemblyOccurrence[],
  access: (artifactId: string) => boolean,
): boolean[] {
  const byPath = new Map<string, boolean>();
  return occurrences.map((o) => {
    const parent = o.path.length > 1 ? byPath.get(o.path.slice(0, -1).join('\u0000')) : true;
    const id = partArtifactId(o.part.source);
    const allowed = parent !== false && (id === undefined || access(id));
    byPath.set(o.path.join('\u0000'), allowed);
    return allowed;
  });
}
