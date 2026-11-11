import { describe, expect, it } from 'vitest';
import {
  applyCharacterOperation,
  balanceAngle,
  blockyFigure,
  escapementKeys,
  freshCharacterId,
  poseAt,
  type CharacterDocument,
  type EscapementInput,
} from './index';

const second = 240_000;
const deg = Math.PI / 180;
const watch = {
  id: 'watch',
  name: 'Watch',
  source: {
    kind: 'cad' as const,
    artifactId: 'art-watch',
    versionId: 'v-1',
    contentHash: 'b'.repeat(64),
  },
  placement: {
    translation: [0, 0, 0] as [number, number, number],
    rotation: [0, 0, 0, 1] as [number, number, number, number],
  },
  visible: true,
};
/** The figure with the watch, its first action 70 s long. */
function withWatch(): CharacterDocument {
  const doc = structuredClone(blockyFigure().doc);
  doc.actions[0]!.duration = 70 * second;
  return applyCharacterOperation(doc, { type: 'addProp', prop: watch });
}
const input = (over: Partial<EscapementInput> = {}): EscapementInput => ({
  propId: 'watch',
  duration: 70 * second,
  balance: 'j-balance',
  fork: 'j-fork',
  escape: 'j-escape',
  beatsPerHour: 28_800,
  amplitude: 270 * deg,
  liftAngle: 52 * deg,
  forkAngle: 10 * deg,
  escapeTeeth: 20,
  escapeDirection: 1,
  escapeStart: 0,
  start: 0,
  length: 60 * second,
  ...over,
});
function put(doc: CharacterDocument, i = input()) {
  const r = escapementKeys(i);
  if (r.status !== 'ok') throw new Error(r.problem.code);
  const action = doc.actions[0]!;
  const taken = new Set<string>();
  const fresh = (base: string) => {
    const id = freshCharacterId(doc, base, new Set([...taken]));
    taken.add(id);
    return id;
  };
  return applyCharacterOperation(doc, {
    type: 'putPropTransform',
    actionId: action.id,
    propId: 'watch',
    from: r.from,
    to: r.to,
    keys: r.keys.map((k) => {
      const joint = k.target.kind === 'prop-joint' ? k.target.joint : k.target.mount;
      const trackId = fresh(`${action.id}/watch/${joint}`);
      return { ...k, trackId, keyId: fresh(`${trackId}#${k.tick}`) };
    }),
  });
}
const angleAt = (doc: CharacterDocument, joint: string, tick: number) =>
  poseAt(doc, doc.actions[0]!, tick).joints.get('watch')!.get(joint)!.angle!;

describe('WM4 escapement keys (TS-1894)', () => {
  it('swings the balance as a sine, and steps the fork and the escape wheel each beat', () => {
    const r = escapementKeys(input());
    expect(r.status === 'ok' && [r.beats, r.from, r.to]).toEqual([480, 0, 60 * second]);
    if (r.status !== 'ok') return;
    const count = (j: string) =>
      r.keys.filter((k) => k.target.kind === 'prop-joint' && k.target.joint === j).length;
    expect([count('j-balance'), count('j-fork'), count('j-escape')]).toEqual([961, 961, 961]);

    const doc = put(withWatch());
    // The balance follows the sine within 0.44 % of its swing at any time.
    for (const s of [0, 0.01, 0.0437, 0.0625, 0.1, 1.234, 29.99, 45.678, 60]) {
      const got = angleAt(doc, 'j-balance', Math.round(s * second));
      expect(Math.abs(got - balanceAngle(input(), Math.round(s * second) / second))).toBeLessThan(
        0.0044 * 270 * deg,
      );
    }
    // Between impulses the fork rests on one side and the wheel is locked.
    const beat = second / 8;
    for (const k of [0, 1, 2, 3, 479]) {
      const locked = Math.round(beat * (k + 1));
      expect(angleAt(doc, 'j-fork', locked)).toBeCloseTo((k % 2 ? -10 : 10) * deg, 12);
      expect(angleAt(doc, 'j-escape', locked)).toBeCloseTo(((k + 1) * Math.PI) / 20, 12);
      // Just before the impulse it has not moved yet.
      expect(angleAt(doc, 'j-escape', Math.round(beat * (k + 0.5)) - 3000)).toBeCloseTo(
        (k * Math.PI) / 20,
        12,
      );
    }
    // 60 s at 28,800 beats per hour: 480 half teeth of a 20-tooth wheel is 12 turns, unwrapped.
    expect(angleAt(doc, 'j-escape', 60 * second)).toBeCloseTo(24 * Math.PI, 9);
    // While the balance passes its centre the fork and the wheel move together.
    const mid = Math.round(beat * 0.5);
    expect(angleAt(doc, 'j-fork', mid)).toBeCloseTo(0, 6);
    expect(angleAt(doc, 'j-escape', mid)).toBeCloseTo(Math.PI / 40, 6);
  });

  it('replaces only its own joints’ keys within its span, and turns the other way', () => {
    let doc = withWatch();
    for (const [joint, s, value] of [
      ['j-escape', 30, 9],
      ['j-escape', 65, 7],
      ['j-crown', 30, 1],
    ] as const)
      doc = applyCharacterOperation(doc, {
        type: 'setKey',
        actionId: doc.actions[0]!.id,
        target: { kind: 'prop-joint', id: 'watch', joint, property: 'angle' },
        tick: s * second,
        value,
        trackId: `t-${joint}`,
        keyId: `k-${joint}-${s}`,
      });
    doc = put(doc, input({ escapeDirection: -1, escapeStart: 2 }));
    const tracks = doc.actions[0]!.tracks.filter((t) => t.target.kind === 'prop-joint');
    const escape = tracks.find(
      (t) => t.target.kind === 'prop-joint' && t.target.joint === 'j-escape',
    )!;
    // The key at 65 s, past the span, is kept; the one at 30 s is replaced.
    expect(escape.keys.filter((k) => k.tick > 60 * second).map((k) => k.value)).toEqual([7]);
    expect(escape.keys.some((k) => k.value === 9)).toBe(false);
    expect(
      tracks.find((t) => t.target.kind === 'prop-joint' && t.target.joint === 'j-crown')!.keys,
    ).toHaveLength(1);
    expect(angleAt(doc, 'j-escape', 60 * second)).toBeCloseTo(2 - 24 * Math.PI, 9);
  });

  it('covers the whole beats that fit, from its start', () => {
    const r = escapementKeys(input({ beatsPerHour: 21_600, start: second, length: second + 100 }));
    // 21,600 beats per hour: 6 beats a second.
    expect(r.status === 'ok' && [r.beats, r.from, r.to]).toEqual([6, second, 2 * second]);
  });

  it('refuses what it cannot make', () => {
    const code = (over: Partial<EscapementInput>) => {
      const r = escapementKeys(input(over));
      return r.status === 'refused' ? r.problem : 'ok';
    };
    expect(code({ fork: 'j-balance' })).toEqual({ code: 'escapement-joints' });
    expect(code({ escape: '' })).toEqual({ code: 'escapement-joints' });
    expect(code({ beatsPerHour: 3000 })).toEqual({ code: 'escapement-rate' });
    expect(code({ beatsPerHour: NaN })).toEqual({ code: 'escapement-rate' });
    expect(code({ amplitude: 0 })).toEqual({ code: 'escapement-amplitude' });
    expect(code({ amplitude: 2 * Math.PI })).toEqual({ code: 'escapement-amplitude' });
    expect(code({ liftAngle: 540 * deg })).toEqual({ code: 'escapement-lift' });
    // An impulse too short for one tick, or one that leaves no lock.
    expect(code({ liftAngle: 1e-7, beatsPerHour: 72_000 })).toEqual({ code: 'escapement-lift' });
    expect(code({ liftAngle: 540 * deg * (1 - 1e-12) })).toEqual({ code: 'escapement-lift' });
    expect(code({ forkAngle: 90 * deg })).toEqual({ code: 'escapement-fork' });
    expect(code({ escapeTeeth: 15.5 })).toEqual({ code: 'escapement-teeth' });
    expect(code({ escapeTeeth: 61 })).toEqual({ code: 'escapement-teeth' });
    expect(code({ length: 100 })).toEqual({ code: 'escapement-time' });
    expect(code({ start: 20 * second })).toEqual({ code: 'escapement-time' });
    expect(code({ start: -1 })).toEqual({ code: 'escapement-time' });
    expect(code({ escapeDirection: 0 as 1 })).toEqual({ code: 'escapement-time' });
    expect(code({ duration: 3600 * second, length: 3600 * second })).toEqual({
      code: 'escapement-beats',
      beats: 28_800,
    });
    // A joint's own limits: the balance cannot swing past ±180° here, a wheel that keeps one
    // turn cannot turn 12 times.
    expect(code({ limits: { 'j-balance': { min: -Math.PI, max: Math.PI } } })).toEqual({
      code: 'escapement-joint-limit',
      joint: 'j-balance',
    });
    expect(code({ limits: { 'j-fork': { min: 0, max: Math.PI } } })).toEqual({
      code: 'escapement-joint-limit',
      joint: 'j-fork',
    });
    expect(code({ limits: { 'j-escape': { min: -Math.PI, max: Math.PI } } })).toEqual({
      code: 'escapement-joint-limit',
      joint: 'j-escape',
    });
    expect(code({ escapeStart: 999_990 })).toEqual({
      code: 'escapement-joint-limit',
      joint: 'j-escape',
    });
    // Own entries only: a joint named `toString` has no inherited limits.
    expect(code({ balance: 'toString', limits: {} })).toBe('ok');
  });
});
