import type { Easing } from '@editor-platform/animation-core';
import { characterLimits } from './model';
import type { PropTransformKey } from './prop-transform';

/**
 * WM4 (docs/cad/watch-design.md): the look of a lever escapement, made as plain joint keys. The
 * balance swings as a sine; each time it passes its centre (one beat) the impulse pin turns the
 * pallet fork to its other side while the escape wheel advances half a tooth, and both then hold
 * (locked) until the next beat. No dynamics are solved (impulse, drop and lock are not modelled).
 * The wheels and hands after the escape wheel follow it through the gear meshes (WM2).
 */
export interface EscapementInput {
  propId: string;
  /** The action's length in ticks: the motion must end within it. */
  duration: number;
  /** CAD joint IDs of the balance, the pallet fork and the escape wheel (their `angle`). */
  balance: string;
  fork: string;
  escape: string;
  /** Beats (half oscillations) per hour, as a watch is rated (28,800 = 4 Hz). */
  beatsPerHour: number;
  /** The balance's swing to each side of its centre, in radians. */
  amplitude: number;
  /**
   * The balance's turn while the impulse pin drives the fork (the lift angle), in radians: the
   * fork and the escape wheel move while the balance is within half of it of its centre.
   */
  liftAngle: number;
  /** The fork's swing to each side of its centre line, in radians. */
  forkAngle: number;
  escapeTeeth: number;
  /** The way the escape wheel turns (+1 counter-clockwise about its joint axis). */
  escapeDirection: 1 | -1;
  /** The escape wheel's angle at the start, in radians, unwrapped (a continuous joint). */
  escapeStart: number;
  /** Start and length in ticks; the motion covers the whole beats that fit in the length. */
  start: number;
  length: number;
  /** Each joint's angle limits as its version gives them (absent: a continuous joint). */
  limits?: Readonly<Record<string, { min?: number; max?: number }>>;
}
export type EscapementProblem =
  | { code: 'escapement-joints' }
  | { code: 'escapement-rate' }
  | { code: 'escapement-amplitude' }
  | { code: 'escapement-lift' }
  | { code: 'escapement-fork' }
  | { code: 'escapement-teeth' }
  | { code: 'escapement-time' }
  | { code: 'escapement-beats'; beats: number }
  | { code: 'escapement-joint-limit'; joint: string };
export type EscapementResult =
  | { status: 'ok'; keys: PropTransformKey[]; from: number; to: number; beats: number }
  | { status: 'refused'; problem: EscapementProblem };

export const escapementLimits = Object.freeze({
  beatsPerHour: { min: 3600, max: 72_000 },
  escapeTeeth: { min: 6, max: 60 },
  /** About 42 minutes at 28,800 beats per hour: two keys per beat on each of three joints. */
  beats: 20_000,
});
const ticksPerSecond = 240_000;

/**
 * A quarter of a sine as a cubic Bezier easing with x evenly spread (x1 = 1/3, x2 = 2/3), so y is
 * a cubic in time. Its inner control value (0.5445, fitted for the least largest error) keeps the
 * curve within 0.44 % of the swing; the sine's own end slope (π/6) would leave 1.1 %.
 */
const sineControl = 0.5445;
const towardsExtreme: Easing = { type: 'bezier', x1: 1 / 3, y1: sineControl, x2: 2 / 3, y2: 1 };
const towardsCentre: Easing = { type: 'bezier', x1: 1 / 3, y1: 0, x2: 2 / 3, y2: 1 - sineControl };

/** The balance's angle `s` seconds after the start: from its −amplitude extreme, as a sine. */
export function balanceAngle(
  input: Pick<EscapementInput, 'beatsPerHour' | 'amplitude'>,
  s: number,
) {
  const omega = (Math.PI * input.beatsPerHour) / 3600;
  return -input.amplitude * Math.cos(omega * s);
}

export function escapementKeys(input: EscapementInput): EscapementResult {
  const refuse = (problem: EscapementProblem): EscapementResult => ({ status: 'refused', problem });
  const { balance, fork, escape } = input;
  if (!balance || !fork || !escape || new Set([balance, fork, escape]).size !== 3)
    return refuse({ code: 'escapement-joints' });
  const finite = (n: number) => Number.isFinite(n);
  const rate = escapementLimits.beatsPerHour;
  if (!finite(input.beatsPerHour) || input.beatsPerHour < rate.min || input.beatsPerHour > rate.max)
    return refuse({ code: 'escapement-rate' });
  if (!finite(input.amplitude) || input.amplitude <= 0 || input.amplitude >= 2 * Math.PI)
    return refuse({ code: 'escapement-amplitude' });
  if (!finite(input.liftAngle) || input.liftAngle <= 0 || input.liftAngle >= 2 * input.amplitude)
    return refuse({ code: 'escapement-lift' });
  if (!finite(input.forkAngle) || input.forkAngle <= 0 || input.forkAngle >= Math.PI / 2)
    return refuse({ code: 'escapement-fork' });
  const teeth = escapementLimits.escapeTeeth;
  if (
    !Number.isInteger(input.escapeTeeth) ||
    input.escapeTeeth < teeth.min ||
    input.escapeTeeth > teeth.max
  )
    return refuse({ code: 'escapement-teeth' });
  if (
    !Number.isInteger(input.start) ||
    !Number.isInteger(input.length) ||
    input.start < 0 ||
    input.length <= 0 ||
    input.start + input.length > input.duration ||
    !finite(input.escapeStart) ||
    (input.escapeDirection !== 1 && input.escapeDirection !== -1)
  )
    return refuse({ code: 'escapement-time' });

  // In ticks: one beat, and the impulse's half width about each crossing of the centre.
  const beat = (3600 * ticksPerSecond) / input.beatsPerHour;
  const halfImpulse = (Math.asin(input.liftAngle / 2 / input.amplitude) / Math.PI) * beat;
  const beats = Math.floor(input.length / beat + 1e-9);
  if (beats < 1) return refuse({ code: 'escapement-time' });
  if (beats > escapementLimits.beats) return refuse({ code: 'escapement-beats', beats });
  const at = (t: number) => Math.round(input.start + t);

  const step = (input.escapeDirection * Math.PI) / input.escapeTeeth;
  const escapeEnd = input.escapeStart + beats * step;
  const within = (joint: string, lo: number, hi: number) => {
    const l = input.limits && Object.hasOwn(input.limits, joint) ? input.limits[joint] : undefined;
    const bound = characterLimits.jointTurnRad;
    return (
      lo >= Math.max(l?.min ?? -bound, -bound) - 1e-12 &&
      hi <= Math.min(l?.max ?? bound, bound) + 1e-12
    );
  };
  if (!within(balance, -input.amplitude, input.amplitude))
    return refuse({ code: 'escapement-joint-limit', joint: balance });
  if (!within(fork, -input.forkAngle, input.forkAngle))
    return refuse({ code: 'escapement-joint-limit', joint: fork });
  if (
    !within(escape, Math.min(input.escapeStart, escapeEnd), Math.max(input.escapeStart, escapeEnd))
  )
    return refuse({ code: 'escapement-joint-limit', joint: escape });

  const target = (joint: string) =>
    ({ kind: 'prop-joint', id: input.propId, joint, property: 'angle' }) as const;
  const keys: PropTransformKey[] = [];
  // The balance: a key at each extreme and each crossing, eased as the sine between them.
  for (let q = 0; q <= 2 * beats; q++) {
    const value = q % 2 ? 0 : (q / 2) % 2 ? input.amplitude : -input.amplitude;
    keys.push({
      target: target(balance),
      tick: at((q * beat) / 2),
      value,
      easing: q % 2 ? towardsExtreme : towardsCentre,
    });
  }
  // The fork and the escape wheel: held, then moved through each impulse.
  const hold = { type: 'hold' } as const;
  const linear = { type: 'linear' } as const;
  const forkSide = (k: number) => (k % 2 ? input.forkAngle : -input.forkAngle);
  keys.push({ target: target(fork), tick: at(0), value: forkSide(0), easing: hold });
  keys.push({ target: target(escape), tick: at(0), value: input.escapeStart, easing: hold });
  for (let k = 0; k < beats; k++) {
    const centre = beat * (k + 0.5);
    const [a, b] = [at(centre - halfImpulse), at(centre + halfImpulse)];
    keys.push(
      { target: target(fork), tick: a, value: forkSide(k), easing: linear },
      { target: target(fork), tick: b, value: forkSide(k + 1), easing: hold },
      { target: target(escape), tick: a, value: input.escapeStart + k * step, easing: linear },
      { target: target(escape), tick: b, value: input.escapeStart + (k + 1) * step, easing: hold },
    );
  }
  // Each impulse must last at least one tick and leave the fork locked for at least one: on each
  // joint the ticks rise strictly (the wheel's are the fork's, so checking the fork covers it).
  for (const joint of [balance, fork]) {
    const ticks = keys
      .filter((k) => k.target.kind === 'prop-joint' && k.target.joint === joint)
      .map((k) => k.tick);
    if (ticks.some((t, i) => i > 0 && t <= ticks[i - 1]!))
      return refuse({ code: 'escapement-lift' });
  }
  return { status: 'ok', keys, from: at(0), to: at(beats * beat), beats };
}
