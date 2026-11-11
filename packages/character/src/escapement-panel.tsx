import { useState } from 'react';
import {
  escapementKeys,
  escapementLimits,
  sampleNumber,
  type CharacterAction,
  type EscapementProblem,
} from '@editor-platform/character-core';
import { Section } from '@editor-platform/editor-ui';
import { formatTicks, ticksPerSecond } from './playback';
import { replacedKeys, type MadeTransform } from './prop-transform-panel';
import { followerViolation, type LimitViolation } from './follower-limits';
import type { CharacterPropJoint } from './props';

const deg = Math.PI / 180;
interface Draft {
  balance: string;
  fork: string;
  escape: string;
  beatsPerHour: string;
  amplitude: string;
  liftAngle: string;
  forkAngle: string;
  escapeTeeth: string;
  escapeDirection: '1' | '-1';
  /** Degrees; blank for the wheel's angle at the start as the action (or the version) has it. */
  escapeStart: string;
  start: string;
  /** Seconds; blank for the rest of the action. */
  length: string;
}

const problemText = (p: EscapementProblem, joint: (id: string) => string, end: string) => {
  switch (p.code) {
    case 'escapement-joints':
      return 'Choose three different joints for the balance, the fork and the escape wheel.';
    case 'escapement-rate':
      return `Beats per hour must be from ${escapementLimits.beatsPerHour.min} to ${escapementLimits.beatsPerHour.max}.`;
    case 'escapement-amplitude':
      return 'The amplitude must be more than 0° and less than 360°.';
    case 'escapement-lift':
      return 'The lift angle must be more than 0° and less than twice the amplitude, with time left for the lock.';
    case 'escapement-fork':
      return 'The fork angle must be more than 0° and less than 90°.';
    case 'escapement-teeth':
      return `The escape wheel needs a whole number of teeth from ${escapementLimits.escapeTeeth.min} to ${escapementLimits.escapeTeeth.max}.`;
    case 'escapement-time':
      return `The motion must start at 0 s or later, hold at least one beat and end by ${end}.`;
    case 'escapement-beats':
      return `${p.beats} beats is more than ${escapementLimits.beats}; make a shorter motion.`;
    case 'escapement-joint-limit':
      return `${joint(p.joint)} cannot turn that far within its limits.`;
  }
};

/**
 * WM4 (docs/cad/watch-design.md): makes the look of a watch's lever escapement as plain joint
 * keys: the balance swings, the fork switches sides and the escape wheel advances half a tooth at
 * each beat. The keys of those three joints within the motion's span are replaced (after a
 * confirmation). The train and hands follow the escape wheel through the version's gear meshes.
 */
export function EscapementPanel({
  propId,
  joints,
  action,
  canKey,
  reason,
  limitViolation,
  onMake,
}: {
  propId: string;
  joints: readonly CharacterPropJoint[];
  /** MR1: a value that follows the keyed ones and would leave its own limits (the view's). */
  limitViolation?: LimitViolation;
  action: CharacterAction | undefined;
  canKey: boolean;
  reason: string;
  /** False when the edit was refused (shown by the Surface). */
  onMake(made: MadeTransform): boolean;
}) {
  const turning = joints.filter((j) => j.values.some((v) => v.key === 'angle'));
  const [draft, setDraft] = useState<Draft>({
    balance: turning[0]?.id ?? '',
    fork: turning[1]?.id ?? '',
    escape: turning[2]?.id ?? '',
    beatsPerHour: '28800',
    amplitude: '280',
    liftAngle: '52',
    forkAngle: '10',
    escapeTeeth: '20',
    escapeDirection: '1',
    escapeStart: '',
    start: '0',
    length: '',
  });
  const [problem, setProblem] = useState<string>();
  const [made, setMade] = useState<string>();
  // As in the transform panel: a confirmation holds for the action as it was when asked.
  const [asked, setConfirm] = useState<{
    made: MadeTransform;
    count: number;
    beats: number;
    action: CharacterAction;
  }>();
  const confirm = asked && asked.action === action ? asked : undefined;
  const name = (id: string) => joints.find((j) => j.id === id)?.name ?? id;
  const set = (patch: Partial<Draft>) => {
    setProblem(undefined);
    setMade(undefined);
    setConfirm(undefined);
    setDraft({ ...draft, ...patch });
  };
  const angleOf = (id: string) =>
    joints.find((j) => j.id === id)?.values.find((v) => v.key === 'angle');
  const report = (m: MadeTransform, beats: number) =>
    setMade(`Made ${beats} beats from ${formatTicks(m.from)} to ${formatTicks(m.to)}.`);
  const make = () => {
    if (!action) return;
    const number = (t: string) => (t.trim() === '' ? NaN : Number(t));
    const start = Math.round(number(draft.start) * ticksPerSecond);
    const length =
      draft.length.trim() === ''
        ? action.duration - start
        : Math.round(number(draft.length) * ticksPerSecond);
    // Blank: the wheel goes on from where the action has it at the start, so the train and the
    // hands do not jump.
    const track = action.tracks.find(
      (t) =>
        t.target.kind === 'prop-joint' &&
        t.target.id === propId &&
        t.target.joint === draft.escape &&
        t.target.property === 'angle',
    );
    const escapeStart =
      draft.escapeStart.trim() === ''
        ? track?.keys.length
          ? sampleNumber(track.keys, start)
          : (angleOf(draft.escape)?.saved ?? 0)
        : number(draft.escapeStart) * deg;
    const limits = Object.fromEntries(
      [draft.balance, draft.fork, draft.escape].map((id) => {
        const v = angleOf(id);
        return [
          id,
          {
            ...(v?.min !== undefined ? { min: v.min } : {}),
            ...(v?.max !== undefined ? { max: v.max } : {}),
          },
        ];
      }),
    );
    const r = escapementKeys({
      propId,
      duration: action.duration,
      balance: draft.balance,
      fork: draft.fork,
      escape: draft.escape,
      beatsPerHour: number(draft.beatsPerHour),
      amplitude: number(draft.amplitude) * deg,
      liftAngle: number(draft.liftAngle) * deg,
      forkAngle: number(draft.forkAngle) * deg,
      escapeTeeth: number(draft.escapeTeeth),
      escapeDirection: draft.escapeDirection === '-1' ? -1 : 1,
      escapeStart,
      start,
      length,
      limits,
    });
    if (r.status === 'refused') {
      setProblem(
        `${r.problem.code}: ${problemText(r.problem, name, formatTicks(action.duration))}`,
      );
      return;
    }
    const m = { keys: r.keys, from: r.from, to: r.to };
    // As a key past a follower's limits is refused, so is a motion that drives one past them.
    const past = followerViolation(m, limitViolation);
    if (past) {
      setProblem(
        `escapement-follower-limit: ${name(past.joint)} ${past.key} follows these joints and would pass its limits at ${formatTicks(past.tick)}.`,
      );
      return;
    }
    const count = replacedKeys(action, m);
    if (count && !confirm) {
      setConfirm({ made: m, count, beats: r.beats, action });
      return;
    }
    if (onMake(m)) {
      setConfirm(undefined);
      report(m, r.beats);
    }
  };
  const roles = [
    ['Balance', 'balance'],
    ['Pallet fork', 'fork'],
    ['Escape wheel', 'escape'],
  ] as const;
  const fields = [
    ['Beats per hour', 'beatsPerHour'],
    ['Amplitude (°)', 'amplitude'],
    ['Lift angle (°)', 'liftAngle'],
    ['Fork angle (°)', 'forkAngle'],
    ['Escape teeth', 'escapeTeeth'],
    ['Escape start (°)', 'escapeStart'],
    ['Escapement start (s)', 'start'],
    ['Escapement length (s)', 'length'],
  ] as const;
  return (
    <Section title="Escapement">
      {turning.length < 3 ? (
        <p className="character-hint">This version needs three turning joints for an escapement.</p>
      ) : (
        <div data-testid="character-prop-escapement">
          <p className="character-hint">
            {canKey
              ? 'Swings the balance and steps the fork and the escape wheel at each beat in this action.'
              : reason}
          </p>
          <div className="character-fields">
            {roles.map(([label, field]) => (
              <label key={field}>
                {label}
                <select
                  aria-label={label}
                  value={draft[field]}
                  onChange={(e) => set({ [field]: e.target.value })}
                >
                  <option value="">—</option>
                  {turning.map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            {fields.map(([label, field]) => (
              <label key={field}>
                {label}
                <input
                  aria-label={label}
                  inputMode="decimal"
                  placeholder={
                    field === 'escapeStart' ? 'as keyed' : field === 'length' ? 'to the end' : ''
                  }
                  value={draft[field]}
                  onChange={(e) => set({ [field]: e.target.value })}
                />
              </label>
            ))}
            <label>
              Escape direction
              <select
                aria-label="Escape direction"
                value={draft.escapeDirection}
                onChange={(e) => set({ escapeDirection: e.target.value as '1' | '-1' })}
              >
                <option value="1">Counter-clockwise</option>
                <option value="-1">Clockwise</option>
              </select>
            </label>
          </div>
          {problem && (
            <p className="character-hint" role="alert">
              {problem}
            </p>
          )}
          {made && (
            <p className="character-hint" role="status">
              {made}
            </p>
          )}
          {confirm ? (
            <div role="alertdialog" aria-label="Replace keys">
              <p className="character-hint">
                Replaces {confirm.count} key{confirm.count === 1 ? '' : 's'} of these joints between{' '}
                {formatTicks(confirm.made.from)} and {formatTicks(confirm.made.to)}.
              </p>
              <button
                type="button"
                onClick={() => {
                  if (!onMake(confirm.made)) return;
                  setConfirm(undefined);
                  report(confirm.made, confirm.beats);
                }}
              >
                Replace keys
              </button>
              <button type="button" onClick={() => setConfirm(undefined)}>
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" disabled={!canKey || !action} onClick={make}>
              Make escapement
            </button>
          )}
        </div>
      )}
    </Section>
  );
}
