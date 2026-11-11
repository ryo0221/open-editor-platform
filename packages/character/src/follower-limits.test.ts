import { describe, expect, it } from 'vitest';
import { escapementKeys } from '@editor-platform/character-core';
import { followerViolation } from './follower-limits';

const second = 240_000;
const deg = Math.PI / 180;
const made = (escapeStart: number) => {
  const r = escapementKeys({
    propId: 'watch',
    duration: second,
    balance: 'b',
    fork: 'f',
    escape: 'e',
    beatsPerHour: 28_800,
    amplitude: 280 * deg,
    liftAngle: 52 * deg,
    forkAngle: 10 * deg,
    escapeTeeth: 20,
    escapeDirection: 1,
    escapeStart,
    start: 0,
    length: second,
  });
  if (r.status !== 'ok') throw new Error(r.problem.code);
  return r;
};

describe('WM4 escapement against follower limits (TS-1894)', () => {
  it('finds the first key time at which a follower of the joints leaves its limits', () => {
    // A hand at 1/12 of the wheel within ±180°; a fork follower within ±5°.
    const hand = (v: ReadonlyMap<string, Partial<Record<string, number>>>) =>
      Math.abs((v.get('e')?.angle ?? 0) / 12) > Math.PI
        ? { joint: 'hand', key: 'angle' as const }
        : undefined;
    expect(followerViolation(made(0), hand)).toBeUndefined();
    expect(followerViolation(made(0), undefined)).toBeUndefined();
    // From 2,150° the wheel passes 2,160° during the second impulse (9° each): first seen at the
    // balance's key as it crosses its centre (1.5 beats).
    expect(followerViolation(made(2150 * deg), hand)).toEqual({
      joint: 'hand',
      key: 'angle',
      tick: (second / 8) * 1.5,
    });
    // The balance's own swing is sampled too (at its extremes).
    const lever = (v: ReadonlyMap<string, Partial<Record<string, number>>>) =>
      (v.get('b')?.angle ?? 0) > 279 * deg ? { joint: 'lever', key: 'angle' as const } : undefined;
    expect(followerViolation(made(0), lever)).toEqual({
      joint: 'lever',
      key: 'angle',
      tick: second / 8,
    });
  });
  it('samples every keyed value of a transform, each joint by its own keys', () => {
    // A slider (distance) and a turn keyed apart; the follower is past when both are high.
    const key = (joint: string, property: 'angle' | 'distance', tick: number, value: number) => ({
      target: { kind: 'prop-joint' as const, id: 'p', joint, property },
      tick,
      value,
      easing: { type: 'linear' as const },
    });
    const made = {
      from: 0,
      to: 100,
      keys: [
        key('a', 'angle', 0, 0),
        key('a', 'angle', 100, 1),
        key('s', 'distance', 50, 0),
        key('s', 'distance', 100, 10),
      ],
    };
    const both = (v: ReadonlyMap<string, Partial<Record<string, number>>>) =>
      (v.get('a')?.angle ?? 0) > 0.7 && (v.get('s')?.distance ?? 0) > 5
        ? { joint: 'f', key: 'angle' as const }
        : undefined;
    expect(followerViolation(made, both)).toEqual({ joint: 'f', key: 'angle', tick: 100 });
    expect(followerViolation({ ...made, keys: made.keys.slice(0, 3) }, both)).toBeUndefined();
  });
});
