import { sampleNumber, type CharacterKey } from '@editor-platform/character-core';
import type { MadeTransform } from './prop-transform-panel';
import type { CharacterJointValues, CharacterPropView } from './props';

export type LimitViolation = Extract<CharacterPropView, { status: 'ready' }>['limitViolation'];

/**
 * The first value that follows the made keys' joints (MR1 coupling, WM2 gear mesh) and would
 * leave its own limits at the time of one of the keys, with that time, or undefined (MR4
 * transforms, WM4 escapements). Each keyed value is sampled at every key's time; between two such
 * times each moves one way only (its easing is a Bezier with y in [0, 1], or linear, or held), so
 * a follower of one value is past its limits only at one of them. Joints the keys leave out keep
 * their saved values, as for `limitViolation`.
 */
export function followerViolation(made: MadeTransform, violation: LimitViolation) {
  if (!violation) return undefined;
  // By joint, then by value key, in a fixed order (IDs are never joined into one string).
  const byValue = new Map<string, Map<string, CharacterKey[]>>();
  for (const k of made.keys) {
    if (k.target.kind !== 'prop-joint') continue;
    const joint = byValue.get(k.target.joint) ?? new Map<string, CharacterKey[]>();
    byValue.set(k.target.joint, joint);
    const list = joint.get(k.target.property) ?? [];
    joint.set(k.target.property, list);
    list.push({ id: String(list.length), tick: k.tick, value: k.value, easing: k.easing });
  }
  for (const joint of byValue.values())
    for (const keys of joint.values()) keys.sort((a, b) => a.tick - b.tick);
  const ticks = [...new Set(made.keys.map((k) => k.tick))].sort((a, b) => a - b);
  const at = new Map<CharacterKey[], number>();
  for (const tick of ticks) {
    const values = new Map<string, Record<string, number>>();
    for (const [joint, byKey] of byValue) {
      const v: Record<string, number> = {};
      for (const [key, keys] of byKey) {
        let i = at.get(keys) ?? 0;
        while (i + 1 < keys.length && keys[i + 1]!.tick <= tick) i++;
        at.set(keys, i);
        v[key] = sampleNumber(keys.slice(i, i + 2), tick);
      }
      values.set(joint, v);
    }
    const past = violation(values as CharacterJointValues);
    if (past) return { ...past, tick };
  }
  return undefined;
}
