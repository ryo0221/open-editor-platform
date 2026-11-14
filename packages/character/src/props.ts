import {
  composeMat4,
  multiplyMat4,
  type CharacterDocument,
  type CharacterKey,
  type CharacterJointValueKey,
  type CharacterPose,
  type Mat4,
  type PropFormValues,
} from '@editor-platform/character-core';

/** A triangle mesh of a prop, in its version's coordinates (mm, Z-up), drawn as it is. */
export interface CharacterPropMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  color: string;
  opacity: number;
  /** CR7d: a sheet's surface (no volume), so a check does not read it as a solid with holes. */
  sheet?: boolean;
  /**
   * CR7g-3: the look's finish and light (as the CAD view draws them), used by the realistic
   * lighting; the standard lighting keeps the props' plain finish.
   */
  finish?: CharacterPropFinish;
}
/** CR7g-3: a prop look's finish (glTF metal/roughness) and light (emission, transmission). */
export interface CharacterPropFinish {
  roughness?: number;
  metalness?: number;
  emission?: { color: string; strength: number };
  transmission?: number;
  ior?: number;
}
/** One drawn copy of a mesh: where it lies in the prop's own space (column-major 4×4). */
export interface CharacterPropInstance {
  mesh: CharacterPropMesh;
  matrix: Mat4;
  /**
   * CR7d: the part occurrence it draws (a stable id and the name the Host gives it); `box` when
   * it is a stand-in box (the version's meshes are not at hand), which no check reads.
   */
  piece?: {
    id: string;
    name: string;
    box?: boolean;
    /** The occurrence's own frame (its pose), in the same space as `matrix`. */
    frame?: Mat4;
    /** Not material (a building's room space, its air): drawn, but never an obstacle. */
    air?: boolean;
  };
  /** CR7d: the solid body it draws within its piece (a check reads each body as its own solid). */
  body?: string;
}
/** One value a joint can be keyed by, with its bounds and the value its version saved. */
export interface CharacterPropJointValue {
  key: CharacterJointValueKey;
  /** Radians for `angle`, millimetres otherwise, as the joint keys store them. */
  saved: number;
  min?: number;
  max?: number;
}
export interface CharacterPropJoint {
  id: string;
  name: string;
  /** The values that may be keyed: a value that follows another joint (MR1) is not listed. */
  values: CharacterPropJointValue[];
}
/**
 * MR4: a form (configuration) of the prop's version, with each moving joint's own values
 * (radians for angles, mm otherwise). A form that no longer fits the joints, or puts a value
 * past its limits, is listed with its problem and cannot be a transform's end.
 */
export interface CharacterPropForm {
  id: string;
  name: string;
  values: PropFormValues;
  /** MR7: each mount's joint in effect in this form. */
  mounts?: Readonly<Record<string, string>>;
  problem?: 'configuration-stale' | 'joint-limit';
}
/**
 * MR7: a part of the prop with candidate joints (a rifle in the hand or on the back), one in
 * effect; a `prop-mount` key switches it.
 */
export interface CharacterPropMount {
  id: string;
  name: string;
  joints: { id: string; name: string }[];
  /** The joint in effect in the version. */
  active: string;
}
/** MR7: the keyed joint in effect of a prop's mounts (mount ID to joint ID). */
export type CharacterMountChoice = ReadonlyMap<string, string>;
export type CharacterJointValues = ReadonlyMap<
  string,
  Partial<Record<CharacterJointValueKey, number>>
>;
/**
 * What the Host made of a prop's version (C2b): the character package never reads a CAD
 * document. `draw` places the version's meshes for joint values (keyed ones; a joint left out
 * keeps its saved value) without a kernel, so playback can call it every frame.
 */
export type CharacterPropView =
  | { status: 'pending' }
  | { status: 'failed'; message: string }
  | {
      status: 'ready';
      joints: CharacterPropJoint[];
      draw(values: CharacterJointValues, mounts?: CharacterMountChoice): CharacterPropInstance[];
      /** MR7: the version's mounts. */
      mounts?: CharacterPropMount[];
      /**
       * MR1: a value that follows a keyed one (a coupling) and would leave its own limits, or
       * undefined. A key that makes one is refused like a key past its own limits.
       */
      limitViolation?(
        values: CharacterJointValues,
      ): { joint: string; key: CharacterJointValueKey } | undefined;
      /** MR4: the version's forms, the ends a transform is made between. */
      forms?: CharacterPropForm[];
      /**
       * MR5: the version's interference at each sampled time (joint values as keyed), checked by
       * the Host on the meshes it has.
       */
      checkInterferenceAlong?(samples: CharacterPropSweepSample[]): Promise<CharacterPropSweep>;
    };
/** MR5: a time of an action and the prop's joint values then. */
export interface CharacterPropSweepSample {
  tick: number;
  values: CharacterJointValues;
  /** MR7: the mounts as keyed then (the version's own where not keyed). */
  mounts?: CharacterMountChoice;
}
/** MR7: a mount switch that moves its part (more than 0.5 mm or 0.5°): the part jumps. */
export interface CharacterPropJump {
  tick: number;
  mount: string;
  from: string;
  to: string;
  mm: number;
  rad: number;
}
/** Two parts of a prop that overlap at a time, by the names the Host gives them. */
export interface CharacterPropOverlap {
  /** Display names; two occurrences may share one. */
  a: string;
  b: string;
  /** Stable occurrence ids: the pair is told apart by these. */
  aId: string;
  bId: string;
  kind: 'intersect' | 'contain' | 'unknown';
  depthMm: number;
}
export type CharacterPropSweep =
  | {
      status: 'ok';
      samples: number;
      /** Each sampled time with an overlap, in time order. */
      hits: { tick: number; overlaps: CharacterPropOverlap[] }[];
      /** Parts not checked (their meshes are not at hand): never reported clear. */
      unchecked: string[];
      /** MR7: switches that move their part, in time order. */
      jumps?: CharacterPropJump[];
    }
  | { status: 'refused'; code: string; tick?: number };
/** A saved version the Host offers to place as a prop. */
export interface CharacterPropChoice {
  /** A CAD version (the default) or a building (C8p). */
  kind?: 'cad' | 'bim';
  artifactId: string;
  versionId: string;
  contentHash: string;
  /** The Artifact's name and the version, as the picker lists it. */
  label: string;
}

/** A prop's meshes at one pose, in character space. */
export interface PropFrame {
  propId: string;
  visible: boolean;
  instances: CharacterPropInstance[];
}

/** Every ready prop at a pose: its version's meshes for the keyed joints, then its (keyed) placement. */
export function propFrames(
  doc: CharacterDocument,
  views: ReadonlyMap<string, CharacterPropView>,
  pose: CharacterPose,
): PropFrame[] {
  const out: PropFrame[] = [];
  for (const prop of doc.props) {
    const view = views.get(prop.id);
    if (view?.status !== 'ready') continue;
    // MR4: a keyed placement (flying, landing) moves the prop.
    const placement = pose.props.get(prop.id) ?? prop.placement;
    const place = composeMat4({ ...placement, scale: [1, 1, 1] });
    out.push({
      propId: prop.id,
      visible: prop.visible,
      instances: view
        .draw(pose.joints.get(prop.id) ?? new Map(), pose.mounts.get(prop.id))
        .map((i) => ({
          ...i,
          matrix: multiplyMat4(place, i.matrix),
          ...(i.piece?.frame
            ? { piece: { ...i.piece, frame: multiplyMat4(place, i.piece.frame) } }
            : {}),
        })),
    });
  }
  return out;
}

/** Joints a prop's tracks key that its version does not have (shown, never drawn). */
export function missingJoints(
  doc: CharacterDocument,
  propId: string,
  view: CharacterPropView | undefined,
): string[] {
  if (view?.status !== 'ready') return [];
  const has = new Set(view.joints.map((j) => j.id));
  const out = new Set<string>();
  for (const a of doc.actions)
    for (const t of a.tracks)
      if (t.target.kind === 'prop-joint' && t.target.id === propId && !has.has(t.target.joint))
        out.add(t.target.joint);
  return [...out];
}

/** An axis-aligned box: min corner, max corner (mm). */
export type PropBounds = [[number, number, number], [number, number, number]];

/** The box around instances (each mesh where its matrix puts it), or undefined if empty. */
export function instanceBounds(
  instances: readonly CharacterPropInstance[],
): PropBounds | undefined {
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const { mesh, matrix: m } of instances) {
    const p = mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i]!,
        y = p[i + 1]!,
        z = p[i + 2]!;
      for (let k = 0; k < 3; k++) {
        const v = m[k]! * x + m[4 + k]! * y + m[8 + k]! * z + m[12 + k]!;
        if (v < lo[k]) lo[k] = v;
        if (v > hi[k]) hi[k] = v;
      }
    }
  }
  return lo[0] <= hi[0] ? [lo, hi] : undefined;
}

/** The box around two boxes, either of which may be missing. */
export function unionBounds(a: PropBounds | undefined, b: PropBounds | undefined) {
  if (!a || !b) return a ?? b;
  return [
    [0, 1, 2].map((k) => Math.min(a[0][k]!, b[0][k]!)),
    [0, 1, 2].map((k) => Math.max(a[1][k]!, b[1][k]!)),
  ] as PropBounds;
}

/**
 * Where a new prop's origin goes (#718): beside `scene` (the character and the props shown) on
 * its +X side with a gap, centred on its depth (Y) and standing on its floor (lowest Z). The
 * prop keeps its size and turn. `prop` is its box at its own origin; unknown (its version is not
 * shown), its origin stands there instead. Without a scene the prop stays at the origin.
 */
export function besidePlacement(
  scene: PropBounds | undefined,
  prop: PropBounds | undefined,
): [number, number, number] {
  if (!scene) return [0, 0, 0];
  const own = prop ?? [
    [0, 0, 0],
    [0, 0, 0],
  ];
  const gap = Math.max(100, 0.1 * Math.max(scene[1][0] - scene[0][0], own[1][0] - own[0][0]));
  const at = (x: number) => (Object.is(x, -0) ? 0 : x);
  return [
    at(scene[1][0] + gap - own[0][0]),
    at((scene[0][1] + scene[1][1]) / 2 - (own[0][1] + own[1][1]) / 2),
    at(scene[0][2] - own[0][2]),
  ];
}

/** MR4: the joints of a version a prop may be updated to, as the Host read them. */
export interface CharacterPropVersionJoints {
  /** The joints and the values that may be keyed, with their limits. */
  joints: CharacterPropJoint[];
  /**
   * Values that follow another joint (MR1 couplings, `ratio × from + offset`): a key of one is
   * never played, and the values a key of `from` gives one must stay within its limits, which
   * include the safety bounds every joint value keeps (one turn for an angle). A follower may
   * itself drive another.
   */
  followers: {
    joint: string;
    key: CharacterJointValueKey;
    from: { joint: string; key: CharacterJointValueKey };
    ratio: number;
    offset: number;
    min?: number;
    max?: number;
  }[];
  /** MR7: the version's mounts and their candidate joints. */
  mounts?: { id: string; joints: string[] }[];
}
/**
 * Why a joint or mount track of a prop cannot be played by another version
 * (`prop-source-incompatible`).
 */
export type PropSourceProblem =
  | JointSourceProblem
  /** MR7: the version has no such mount, or `joint` (a key's) is not one of its candidates. */
  | { actionId: string; trackId: string; code: 'mount-missing'; mount: string; joint?: string };
type JointSourceProblem = {
  actionId: string;
  trackId: string;
  joint: string;
  key: CharacterJointValueKey;
} & (
  | { code: 'joint-missing' }
  | { code: 'value-missing' }
  | { code: 'value-coupled' }
  | { code: 'key-out-of-limits'; tick: number }
  /** A key of this track moves a value that follows it past that value's limits. */
  | {
      code: 'follower-out-of-limits';
      tick: number;
      follower: { joint: string; key: CharacterJointValueKey };
    }
);

/**
 * The values a number track reaches, each with a tick it reaches it at: its keys, and where a
 * Bézier easing overshoots between two keys (its y controls may pass 0–1). Between those the
 * value lies between them, so limits checked here hold for the whole track.
 */
export function trackExtremes(keys: readonly CharacterKey[]): { tick: number; value: number }[] {
  const out = keys.map((k) => ({ tick: k.tick, value: k.value as number }));
  for (let i = 0; i + 1 < keys.length; i++) {
    const e = keys[i]!.easing;
    if (e.type !== 'bezier') continue;
    const a = keys[i]!.value as number;
    const b = keys[i + 1]!.value as number;
    const cubic = (s: number, c1: number, c2: number) =>
      3 * (1 - s) ** 2 * s * c1 + 3 * (1 - s) * s * s * c2 + s ** 3;
    // y'(s) ∝ (y1 − 2(y2 − y1) + 1 − y2) s² + 2(y2 − 2 y1) s + y1.
    const q2 = e.y1 - 2 * (e.y2 - e.y1) + (1 - e.y2);
    const q1 = 2 * (e.y2 - e.y1 - e.y1);
    const q0 = e.y1;
    const roots: number[] = [];
    if (Math.abs(q2) < 1e-12) {
      if (Math.abs(q1) > 1e-12) roots.push(-q0 / q1);
    } else {
      const d = q1 * q1 - 4 * q2 * q0;
      if (d >= 0) roots.push((-q1 + Math.sqrt(d)) / (2 * q2), (-q1 - Math.sqrt(d)) / (2 * q2));
    }
    const span = keys[i + 1]!.tick - keys[i]!.tick;
    for (const s of roots)
      if (s > 0 && s < 1)
        out.push({
          tick: keys[i]!.tick + Math.round(span * Math.min(1, Math.max(0, cubic(s, e.x1, e.x2)))),
          value: a + (b - a) * cubic(s, e.y1, e.y2),
        });
  }
  return out;
}

/**
 * MR4 (docs/cad/mecha-design.md): each joint track of the prop that the version `next` could not
 * play: its joint is gone, the joint no longer has that value (its type changed), the value now
 * follows another joint, a key lies past the value's new limits, or a key moves a value that
 * follows it past that value's limits. Keys are never clamped.
 */
export function propSourceProblems(
  doc: CharacterDocument,
  propId: string,
  next: CharacterPropVersionJoints,
): PropSourceProblem[] {
  const out: PropSourceProblem[] = [];
  const joints = new Map(next.joints.map((j) => [j.id, j]));
  const follows = new Set(next.followers.map((f) => `${f.joint} ${f.key}`));
  const mounts = new Map((next.mounts ?? []).map((m) => [m.id, new Set(m.joints)]));
  for (const action of doc.actions)
    for (const t of action.tracks) {
      if (t.target.kind === 'prop-mount' && t.target.id === propId) {
        const candidates = mounts.get(t.target.mount);
        const at = { actionId: action.id, trackId: t.id, code: 'mount-missing' as const };
        if (!candidates) out.push({ ...at, mount: t.target.mount });
        else {
          const off = t.keys.find((k) => !candidates.has(k.value as string));
          if (off) out.push({ ...at, mount: t.target.mount, joint: off.value as string });
        }
        continue;
      }
      if (t.target.kind !== 'prop-joint' || t.target.id !== propId) continue;
      const { joint, property: key } = t.target;
      const at = { actionId: action.id, trackId: t.id, joint, key };
      const j = joints.get(joint);
      const value = j?.values.find((v) => v.key === key);
      if (follows.has(`${joint} ${key}`)) out.push({ ...at, code: 'value-coupled' });
      else if (!j) out.push({ ...at, code: 'joint-missing' });
      else if (!value) out.push({ ...at, code: 'value-missing' });
      else {
        // Every value the track reaches: its keys and any Bézier overshoot between them.
        const reached = trackExtremes(t.keys);
        const past = reached.find(
          ({ value: v }) => v < (value.min ?? -Infinity) || v > (value.max ?? Infinity),
        );
        if (past) {
          out.push({ ...at, code: 'key-out-of-limits', tick: past.tick });
          continue;
        }
        // A follower is linear in its source: it peaks where the source does.
        // Followers of followers too (A → B → C), each value as the chain gives it.
        const chain: { at: string; gives: (v: number) => number }[] = [
          { at: `${joint} ${key}`, gives: (v) => v },
        ];
        const seen = new Set(chain.map((c) => c.at));
        let found: { tick: number; joint: string; key: CharacterJointValueKey } | undefined;
        while (chain.length && !found) {
          const { at: from, gives } = chain.shift()!;
          for (const f of next.followers) {
            if (`${f.from.joint} ${f.from.key}` !== from) continue;
            const value = (v: number) => f.ratio * gives(v) + f.offset;
            const over = reached.find((k) => {
              const v = value(k.value);
              return !(v >= (f.min ?? -Infinity) && v <= (f.max ?? Infinity));
            });
            if (over) {
              found = { tick: over.tick, joint: f.joint, key: f.key };
              break;
            }
            const id = `${f.joint} ${f.key}`;
            if (!seen.has(id)) {
              seen.add(id);
              chain.push({ at: id, gives: value });
            }
          }
        }
        if (found)
          out.push({
            ...at,
            code: 'follower-out-of-limits',
            tick: found.tick,
            follower: { joint: found.joint, key: found.key },
          });
      }
    }
  return out;
}
