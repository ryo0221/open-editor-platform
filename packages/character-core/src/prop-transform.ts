import type { Easing } from '@editor-platform/animation-core';
import {
  characterJointValueKeys,
  type CharacterJointValueKey,
  type CharacterTrackTarget,
} from './model';

/** A form's joint values (radians for angles, mm otherwise), by CAD joint ID. */
export type PropFormValues = Readonly<
  Record<string, Readonly<Partial<Record<CharacterJointValueKey, number>>>>
>;
/** MR4: joints that move together, from `start` for `length` ticks, eased from the first key. */
export interface PropTransformGroup {
  joints: readonly string[];
  start: number;
  length: number;
  easing: Easing;
}
export interface PropTransformInput {
  propId: string;
  /** The action's length in ticks: every group must end within it. */
  duration: number;
  from: PropFormValues;
  to: PropFormValues;
  groups: readonly PropTransformGroup[];
  /**
   * MR7: each form's mounts (mount ID to the joint in effect), and the tick each mount whose
   * joint differs switches at (within the transform; the start when not given).
   */
  mounts?: {
    from: Readonly<Record<string, string>>;
    to: Readonly<Record<string, string>>;
    switches?: Readonly<Record<string, number>>;
  };
}
export type PropTransformKey =
  | {
      target: Extract<CharacterTrackTarget, { kind: 'prop-joint' }>;
      tick: number;
      value: number;
      easing: Easing;
    }
  /** MR7: a mount switch, held. */
  | {
      target: Extract<CharacterTrackTarget, { kind: 'prop-mount' }>;
      tick: number;
      value: string;
      easing: { type: 'hold' };
    };
/** Why a transform cannot be made from these forms and groups. */
export type PropTransformProblem =
  | { code: 'transform-groups' }
  | { code: 'transform-group-empty'; group: number }
  | { code: 'transform-time'; group: number }
  | { code: 'transform-joint-twice'; joint: string }
  | { code: 'transform-joint-ungrouped'; joint: string }
  | { code: 'transform-values'; joint: string }
  /** MR7: the forms name different mounts, or a switch lies outside the transform. */
  | { code: 'transform-mounts' }
  | { code: 'transform-switch-time'; mount: string };
export type PropTransformResult =
  | { status: 'ok'; keys: PropTransformKey[]; from: number; to: number }
  | { status: 'refused'; problem: PropTransformProblem };

/** MR7: the mounts whose joint in effect differs between two forms. */
export function changedMounts(
  from: Readonly<Record<string, string>>,
  to: Readonly<Record<string, string>>,
): string[] {
  return Object.keys(from).filter((m) => Object.hasOwn(to, m) && from[m] !== to[m]);
}

/** The joint values that differ between two forms (0 tolerance: the forms store exact values). */
export function changedJoints(from: PropFormValues, to: PropFormValues): string[] {
  return [...new Set([...Object.keys(from), ...Object.keys(to)])].filter((id) =>
    characterJointValueKeys.some((k) => from[id]?.[k] !== to[id]?.[k]),
  );
}

/**
 * MR4 (docs/cad/mecha-design.md): the keys that move a prop from form `from` to form `to`.
 * Every value of a group's changing joints gets a key at the group's start (its form-A value, with the
 * group's easing) and one at its end (the form-B value). Both forms must name the same values of
 * each grouped joint; every joint that changes must be in exactly one group. The keys are plain
 * `prop-joint` keys, edited in the dope sheet afterwards like any other. When only the mounts
 * differ, a group may name no joint: it gives the span the switches lie in. MR7: each mount whose
 * joint differs gets a held `prop-mount` key at its switch tick (form B's joint), and one at the
 * transform's start (form A's) when it switches later.
 */
export function propTransformKeys(input: PropTransformInput): PropTransformResult {
  const refuse = (problem: PropTransformProblem): PropTransformResult => ({
    status: 'refused',
    problem,
  });
  if (!input.groups.length) return refuse({ code: 'transform-groups' });
  const seen = new Set<string>();
  const keys: PropTransformKey[] = [];
  let lo = Infinity;
  let hi = -Infinity;
  // MR7: forms that differ only in their mounts: the groups give the switches' time span alone.
  const mountsOnly =
    !changedJoints(input.from, input.to).length &&
    !!input.mounts &&
    changedMounts(input.mounts.from, input.mounts.to).length > 0;
  for (const [i, g] of input.groups.entries()) {
    if (!g.joints.length && !mountsOnly) return refuse({ code: 'transform-group-empty', group: i });
    const end = g.start + g.length;
    if (
      !Number.isSafeInteger(g.start) ||
      !Number.isSafeInteger(g.length) ||
      g.start < 0 ||
      g.length <= 0 ||
      end > input.duration
    )
      return refuse({ code: 'transform-time', group: i });
    lo = Math.min(lo, g.start);
    hi = Math.max(hi, end);
    for (const joint of g.joints) {
      if (seen.has(joint)) return refuse({ code: 'transform-joint-twice', joint });
      seen.add(joint);
      const a = input.from[joint];
      const b = input.to[joint];
      const names = characterJointValueKeys.filter((k) => a?.[k] !== undefined);
      if (
        !a ||
        !b ||
        !names.length ||
        characterJointValueKeys.some((k) => (a[k] === undefined) !== (b[k] === undefined))
      )
        return refuse({ code: 'transform-values', joint });
      // A joint that does not change gets no keys, even in a group: its own keys stay.
      if (names.every((k) => a[k] === b[k])) continue;
      for (const property of names) {
        const target = { kind: 'prop-joint' as const, id: input.propId, joint, property };
        keys.push({ target, tick: g.start, value: a[property]!, easing: g.easing });
        keys.push({ target, tick: end, value: b[property]!, easing: { type: 'linear' } });
      }
    }
  }
  for (const joint of changedJoints(input.from, input.to))
    if (!seen.has(joint)) return refuse({ code: 'transform-joint-ungrouped', joint });
  if (input.mounts) {
    const { from, to, switches = {} } = input.mounts;
    const names = Object.keys(from);
    if (names.length !== Object.keys(to).length || names.some((m) => !Object.hasOwn(to, m)))
      return refuse({ code: 'transform-mounts' });
    for (const mount of changedMounts(from, to)) {
      const at = Object.hasOwn(switches, mount) ? switches[mount]! : lo;
      if (!Number.isSafeInteger(at) || at < lo || at > hi)
        return refuse({ code: 'transform-switch-time', mount });
      const target = {
        kind: 'prop-mount' as const,
        id: input.propId,
        mount,
        property: 'joint' as const,
      };
      const hold = { type: 'hold' as const };
      if (at > lo) keys.push({ target, tick: lo, value: from[mount]!, easing: hold });
      keys.push({ target, tick: at, value: to[mount]!, easing: hold });
    }
  }
  return { status: 'ok', keys, from: lo, to: hi };
}
