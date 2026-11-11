import {
  axisAngleQuat,
  clampRotation,
  composeMat4,
  decomposeMat4,
  invertMat4,
  multiplyMat4,
  normalizeQuat,
  type Mat4,
} from './math';
import type {
  CharacterBone,
  CharacterIkChain,
  CharacterSkeleton,
  Quat,
  Transform3,
  Vec3,
} from './model';

/** C5d: solver settings. */
export const ikSolver = Object.freeze({
  /** FABRIK passes per solve. */
  fabrikIterations: 32,
  /** Solves of a chain whose bones have limits (each starts where the last left off). */
  limitedSolves: 8,
  /** How close the tip has to come, in mm. */
  tolerance: 1e-3,
});

/**
 * The bones a chain turns (from the top down) and its tip, or undefined when the tip is not a
 * bone of the skeleton or has fewer than `length` bones above it.
 */
export function ikChainBones(
  skeleton: CharacterSkeleton,
  chain: Pick<CharacterIkChain, 'tipBoneId' | 'length'>,
): { bones: CharacterBone[]; tip: CharacterBone } | undefined {
  const of = new Map(skeleton.bones.map((b) => [b.id, b]));
  const tip = of.get(chain.tipBoneId);
  if (!tip || !Number.isInteger(chain.length) || chain.length < 1) return undefined;
  const bones: CharacterBone[] = [];
  let at = tip;
  for (let k = 0; k < chain.length; k++) {
    const up = at.parentId ? of.get(at.parentId) : undefined;
    if (!up || bones.includes(up)) return undefined;
    bones.unshift(up);
    at = up;
  }
  return { bones, tip };
}

type World = (bones: Map<string, Transform3>) => Map<string, Mat4>;

/**
 * Solves the enabled chains of every skeleton, in order, by changing the local rotations in
 * `bones` (a pose's, already keyed). `world` gives the bones' world matrices for local poses.
 * A chain that cannot be solved (a degenerate bone) is left as it is.
 */
export function solveIk(
  skeletons: readonly CharacterSkeleton[],
  bones: Map<string, Transform3>,
  world: World,
) {
  for (const skeleton of skeletons)
    for (const chain of skeleton.ik ?? []) {
      if (!chain.enabled) continue;
      const found = ikChainBones(skeleton, chain);
      if (!found) continue;
      const limited = found.bones.some((b) => b.limits);
      if (!limited) {
        solveChain(found.bones, found.tip, chain, bones, world, false);
        continue;
      }
      // Limited: clamp and solve again; two bones also try the other bend (the preferred one
      // may lie outside the limits) and keep whichever comes closer.
      const start = new Map(found.bones.map((b) => [b.id, bones.get(b.id)!]));
      let best: { error: number; result: Map<string, Transform3> } | undefined;
      for (const flip of found.bones.length === 2 ? [false, true] : [false]) {
        for (const [id, t] of start) bones.set(id, t);
        let error = Infinity;
        for (let k = 0; k < ikSolver.limitedSolves; k++) {
          solveChain(found.bones, found.tip, chain, bones, world, flip);
          error = distance(head(world(bones).get(found.tip.id)!), chain.target);
          if (error < ikSolver.tolerance) break;
        }
        if (!best || error < best.error - 1e-9)
          best = { error, result: new Map(found.bones.map((b) => [b.id, bones.get(b.id)!])) };
      }
      for (const [id, t] of best!.result) bones.set(id, t);
    }
}

function solveChain(
  chainBones: CharacterBone[],
  tip: CharacterBone,
  chain: CharacterIkChain,
  bones: Map<string, Transform3>,
  world: World,
  /** Two bones: bend the other way (away from the pole or the current middle joint). */
  flip: boolean,
) {
  // #752: solved in the space of the chain's base (the top bone's parent, or the skeleton's
  // base for a root). A non-uniform scale above the chain is then outside it: as long as the
  // chain's own bones scale uniformly, its lengths are rigid there and a turn stays a rotation.
  const top = chainBones[0]!;
  const W0 = world(bones);
  const topWorld = W0.get(top.id)!;
  const base = top.parentId
    ? W0.get(top.parentId)!
    : multiplyMat4(topWorld, invertMat4(composeMat4(bones.get(top.id)!)) ?? topWorld);
  const toBase = invertMat4(base);
  if (!toBase) return;
  const inBase = (m: Mat4) => multiplyMat4(toBase, m);
  const point = (v: Vec3): Vec3 =>
    head(inBase(composeMat4({ translation: v, rotation: [0, 0, 0, 1], scale: [1, 1, 1] })));
  const joints = [...chainBones, tip].map((b) => head(inBase(W0.get(b.id)!)));
  const target = point(chain.target);
  const pole = chain.pole ? point(chain.pole) : null;
  const want =
    chainBones.length === 2 ? twoBone(joints, target, pole, flip) : fabrik(joints, target, pole);
  // Turn each bone, top down, so its next joint points where the solution put it.
  chainBones.forEach((bone, i) => {
    const now = world(bones);
    const m = inBase(now.get(bone.id)!);
    const from = head(m);
    const next = head(inBase(now.get(i + 1 < chainBones.length ? chainBones[i + 1]!.id : tip.id)!));
    const q = fromTo(sub(next, from), sub(want[i + 1]!, from));
    if (!q) return;
    const turned = composeMat4({ translation: [0, 0, 0], rotation: q, scale: [1, 1, 1] });
    const linear = multiplyMat4(turned, m);
    linear[12] = m[12]!;
    linear[13] = m[13]!;
    linear[14] = m[14]!;
    // The parent in the base's space: the base itself (identity) for the top bone.
    const inv =
      i === 0
        ? composeMat4({ translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] })
        : invertMat4(inBase(now.get(bone.parentId!)!));
    // Decomposed with the bone's own scale signs, so the rotation fits the scale it keeps.
    const signs = bones.get(bone.id)!.scale.map((x) => (x < 0 ? -1 : 1));
    const local = inv && decomposeMat4(multiplyMat4(inv, linear), signs);
    if (!local) return;
    let rotation: Quat = normalizeQuat(local.rotation);
    if (bone.limits) rotation = clampRotation(rotation, bone.limits.min, bone.limits.max);
    bones.set(bone.id, { ...bones.get(bone.id)!, rotation });
  });
}

/**
 * #752: why a chain's solution is only approximate: one of the bones it turns is scaled
 * unevenly (its lengths then change as it turns). Scale above the chain is solved exactly.
 */
export function ikChainProblem(
  skeleton: CharacterSkeleton,
  chain: Pick<CharacterIkChain, 'tipBoneId' | 'length'>,
): 'ik-chain-scaled' | undefined {
  const found = ikChainBones(skeleton, chain);
  if (!found) return undefined;
  const uneven = (s: Vec3) => {
    const a = s.map(Math.abs);
    return Math.max(...a) - Math.min(...a) > 1e-9 * Math.max(...a, 1);
  };
  return found.bones.some((b) => uneven(b.rest.scale)) ? 'ik-chain-scaled' : undefined;
}

/** Two bones, exactly: the middle joint in the plane of root, target and pole (or as it was). */
function twoBone(joints: Vec3[], target: Vec3, pole: Vec3 | null, flip = false): Vec3[] {
  const [root, mid, end] = joints as [Vec3, Vec3, Vec3];
  const a = distance(root, mid),
    b = distance(mid, end);
  const toTarget = sub(target, root);
  const reach = length(toTarget);
  if (!(a > 1e-9) || !(b > 1e-9)) return joints;
  // A target on the root folds the chain back along where it points now.
  const along = reach > 1e-9 ? toTarget : sub(end, root);
  const u =
    length(along) > 1e-9
      ? scale(along, 1 / length(along))
      : bendDirection([0, 0, 0], [0, 0, 1], [1, 0, 0]);
  const d = Math.min(Math.max(reach, Math.abs(a - b)), a + b);
  const v = scale(bendDirection(root, u, pole ?? mid), flip ? -1 : 1);
  const cos = d > 1e-9 ? Math.min(Math.max((a * a + d * d - b * b) / (2 * a * d), -1), 1) : 0;
  const sin = Math.sqrt(1 - cos * cos);
  const newMid = add(root, add(scale(u, a * cos), scale(v, a * sin)));
  return [root, newMid, add(root, scale(u, d))];
}

/** FABRIK (Aristidou & Lasenby 2011), the interior joints first turned toward the pole. */
function fabrik(joints: Vec3[], target: Vec3, pole: Vec3 | null): Vec3[] {
  const p = joints.map((j) => [...j] as Vec3);
  const n = p.length - 1;
  const len = p.slice(1).map((q, i) => distance(q, p[i]!));
  const root = p[0]!;
  const total = len.reduce((s, x) => s + x, 0);
  const toTarget = sub(target, root);
  if (!(total > 1e-9)) return joints;
  if (length(toTarget) >= total) {
    // Out of reach: straight at the target.
    const u = scale(toTarget, 1 / length(toTarget));
    let at = root;
    return [root, ...len.map((l) => (at = add(at, scale(u, l))))];
  }
  const axis = length(toTarget) > 1e-9 ? scale(toTarget, 1 / length(toTarget)) : undefined;
  if (axis && n > 1) {
    // A chain on the root → target line (straight or folded) cannot bend by itself, and near
    // it FABRIK crawls: start it straight out at 45° toward the pole (or any side) instead.
    if (p.slice(1, n).every((q) => !perpendicular(sub(q, root), axis))) {
      const side = bendDirection(root, axis, pole ?? add(root, [1, 0, 0]));
      const out = scale(add(axis, side), Math.SQRT1_2);
      for (let i = 1; i <= n; i++) p[i] = add(p[i - 1]!, scale(out, len[i - 1]!));
    }
    // Turn the chain about root → target so its first interior joint off that line leans
    // toward the pole.
    const was = p
      .slice(1, n)
      .map((q) => perpendicular(sub(q, root), axis))
      .find((w) => w);
    const goal = pole ? perpendicular(sub(pole, root), axis) : undefined;
    // About the axis itself (fromTo would pick any axis for opposite directions).
    if (was && goal) {
      const angle = Math.atan2(dot(cross(was, goal), axis), dot(was, goal));
      const q = axisAngleQuat(axis, angle);
      for (let i = 1; i < n; i++) p[i] = add(root, rotate(q, sub(p[i]!, root)));
    }
  }
  for (let it = 0; it < ikSolver.fabrikIterations; it++) {
    if (distance(p[n]!, target) < ikSolver.tolerance) break;
    p[n] = [...target];
    for (let i = n - 1; i >= 0; i--) p[i] = toward(p[i + 1]!, p[i]!, len[i]!);
    p[0] = [...root];
    for (let i = 0; i < n; i++) p[i + 1] = toward(p[i]!, p[i + 1]!, len[i]!);
  }
  return p;
}

const head = (m: Mat4): Vec3 => [m[12]!, m[13]!, m[14]!];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length = (a: Vec3) => Math.hypot(...a);
const distance = (a: Vec3, b: Vec3) => length(sub(a, b));
/** The point `l` from `from` on the way to `to`. */
const toward = (from: Vec3, to: Vec3, l: number): Vec3 => {
  const d = sub(to, from);
  const k = length(d);
  return k > 1e-12 ? add(from, scale(d, l / k)) : add(from, [0, 0, l]);
};
/** `v` without its part along unit `axis`, normalized; undefined when nothing is left. */
const perpendicular = (v: Vec3, axis: Vec3): Vec3 | undefined => {
  const w = sub(v, scale(axis, dot(v, axis)));
  const k = length(w);
  return k > 1e-9 ? scale(w, 1 / k) : undefined;
};
/** Unit, perpendicular to `u`, toward `hint` (any perpendicular when the hint is on the line). */
function bendDirection(root: Vec3, u: Vec3, hint: Vec3): Vec3 {
  const w = perpendicular(sub(hint, root), u);
  if (w) return w;
  const other: Vec3 = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return perpendicular(other, u)!;
}
/** The shortest rotation taking direction `a` to direction `b`; undefined for a zero vector. */
function fromTo(a: Vec3, b: Vec3): Quat | undefined {
  const la = length(a),
    lb = length(b);
  if (!(la > 1e-9) || !(lb > 1e-9)) return undefined;
  const x = scale(a, 1 / la),
    y = scale(b, 1 / lb);
  const c = dot(x, y);
  if (c < -1 + 1e-9) {
    const axis = bendDirection([0, 0, 0], x, [0, 0, 0]);
    return [axis[0], axis[1], axis[2], 0];
  }
  const v = cross(x, y);
  return normalizeQuat([v[0], v[1], v[2], 1 + c]);
}
function rotate(q: Quat, v: Vec3): Vec3 {
  const m = composeMat4({ translation: [0, 0, 0], rotation: q, scale: [1, 1, 1] });
  return [
    m[0]! * v[0] + m[4]! * v[1] + m[8]! * v[2],
    m[1]! * v[0] + m[5]! * v[1] + m[9]! * v[2],
    m[2]! * v[0] + m[6]! * v[1] + m[10]! * v[2],
  ];
}
