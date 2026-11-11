import { useState } from 'react';
import {
  poseAt,
  type CharacterAction,
  type CharacterDocument,
  type CharacterProp,
} from '@editor-platform/character-core';
import { Section } from '@editor-platform/editor-ui';
import { formatTicks, ticksPerSecond } from './playback';
import type { CharacterPropSweep, CharacterPropSweepSample } from './props';

/** At most this many sampled times (MR5): with the default 0.1 s, a 60 s action. */
export const propSweepSamples = 600;

/** How many times `sweepTicks` gives, counted without building them. */
export function sweepTickCount(duration: number, step: number): number {
  return Math.ceil(duration / step) + 1;
}

/** The times an action is sampled at: every `step` ticks from 0, and its end. */
export function sweepTicks(duration: number, step: number): number[] {
  const out: number[] = [];
  for (let t = 0; t < duration; t += step) out.push(t);
  out.push(duration);
  return out;
}

/**
 * MR7: the sampled times with the ticks the prop's mounts switch at added, so a switch is
 * measured where it happens.
 */
export function sweepTicksWithSwitches(
  action: CharacterAction,
  propId: string,
  step: number,
): number[] {
  const ticks = new Set(sweepTicks(action.duration, step));
  for (const t of action.tracks)
    if (t.target.kind === 'prop-mount' && t.target.id === propId)
      for (const k of t.keys) ticks.add(k.tick);
  return [...ticks].sort((a, b) => a - b);
}

/**
 * The times a check samples, or how many there would be when more than `propSweepSamples`. The
 * regular times are counted first (a tiny interval on a long action must not build millions);
 * then each switch time is added once, and only where no sample lies already.
 */
export function sweepSampleTicks(
  action: CharacterAction,
  propId: string,
  step: number,
): number[] | { count: number } {
  const regular = sweepTickCount(action.duration, step);
  if (regular > propSweepSamples) return { count: regular };
  const ticks = sweepTicksWithSwitches(action, propId, step);
  return ticks.length > propSweepSamples ? { count: ticks.length } : ticks;
}

/** What a check found, kept with the action and version it was made for. */
export interface PropSweepResult {
  action: CharacterAction;
  propId: string;
  contentHash: string;
  stepTicks: number;
  sweep: CharacterPropSweep;
}

/** Each overlapping pair with the first and last sampled time it overlaps at. */
export function sweepPairs(sweep: Extract<CharacterPropSweep, { status: 'ok' }>) {
  const pairs = new Map<
    string,
    {
      a: string;
      b: string;
      aId: string;
      bId: string;
      first: number;
      last: number;
      kind: string;
      depthMm: number;
    }
  >();
  for (const h of sweep.hits)
    for (const o of h.overlaps) {
      // By occurrence, not by name: two parts may share a name.
      const key = JSON.stringify([o.aId, o.bId]);
      const p = pairs.get(key);
      if (!p) pairs.set(key, { ...o, first: h.tick, last: h.tick });
      else {
        p.last = h.tick;
        p.depthMm = Math.max(p.depthMm, o.depthMm);
      }
    }
  return [...pairs.values()].sort((x, y) => x.first - y.first);
}

/**
 * MR5 (docs/cad/mecha-design.md, MR5（途中の干渉）): checks the prop's parts for overlaps at
 * times through the action (every 0.1 s by default, at most 600 times), each in the pose its keys
 * give then. The times that overlap are marked on the keys' timeline; a mark seeks there. An
 * overlap shorter than the interval can be missed. MR7: each mount switch is checked at its own
 * time too, and one that moves its part (a jump) is listed and marked.
 */
export function PropSweepPanel({
  doc,
  prop,
  action,
  result,
  check,
  onResult,
  onSeek,
  mountName = (id) => id,
  jointName = (_, id) => id,
}: {
  doc: CharacterDocument;
  prop: CharacterProp;
  /** MR7: names from the version, for the jumps. */
  mountName?: (mount: string) => string;
  jointName?: (mount: string, joint: string) => string;
  action: CharacterAction | undefined;
  /** The last result for this prop, if any. */
  result: PropSweepResult | undefined;
  check: (samples: CharacterPropSweepSample[]) => Promise<CharacterPropSweep>;
  onResult(result: PropSweepResult | undefined): void;
  onSeek(tick: number): void;
}) {
  const [interval, setEvery] = useState('0.1');
  const [running, setRunning] = useState(false);
  const [problem, setProblem] = useState<string>();
  const seconds = Number(interval);
  const step = Math.round(seconds * ticksPerSecond);
  const run = async () => {
    if (!action) return;
    setProblem(undefined);
    if (!(interval.trim() !== '' && Number.isFinite(seconds) && step > 0)) {
      setProblem('sweep-interval: the interval must be a time longer than 0 s.');
      return;
    }
    const ticks = sweepSampleTicks(action, prop.id, step);
    if (!Array.isArray(ticks)) {
      setProblem(
        `sweep-samples: ${ticks.count} times; at most ${propSweepSamples}. Choose a longer interval.`,
      );
      return;
    }
    const samples = ticks.map((tick) => {
      const pose = poseAt(doc, action, tick);
      const mounts = pose.mounts.get(prop.id);
      return {
        tick,
        values: pose.joints.get(prop.id) ?? new Map(),
        ...(mounts ? { mounts } : {}),
      };
    });
    setRunning(true);
    try {
      const sweep = await check(samples);
      onResult({
        action,
        propId: prop.id,
        contentHash: prop.source.contentHash,
        stepTicks: step,
        sweep,
      });
    } catch (e) {
      setProblem(`Not checked: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(false);
    }
  };
  // A result holds for the action and version it was made for: an edit asks for a new check.
  const current =
    result &&
    result.action === action &&
    result.propId === prop.id &&
    result.contentHash === prop.source.contentHash
      ? result.sweep
      : undefined;
  const ok = current?.status === 'ok' ? current : undefined;
  const pairs = ok ? sweepPairs(ok) : [];
  return (
    <Section title="Interference along the action">
      <div data-testid="character-prop-sweep">
        <div className="character-fields">
          <label>
            Every (s)
            <input
              aria-label="Check every (s)"
              inputMode="decimal"
              value={interval}
              onChange={(e) => setEvery(e.target.value)}
            />
          </label>
          <button type="button" disabled={!action || running} onClick={() => void run()}>
            Check along the action
          </button>
        </div>
        <p className="character-hint" role="status" data-testid="character-prop-sweep-status">
          {!action
            ? 'Choose an action to check.'
            : running
              ? 'Checking…'
              : result && !current
                ? 'The action or version changed since the last check: check again.'
                : !current
                  ? 'Checks the parts at times through the action, each in its keyed pose.'
                  : current.status === 'refused'
                    ? `${current.code}${current.tick !== undefined ? ` at ${formatTicks(current.tick)}` : ''}: not checked.`
                    : (current.hits.length
                        ? `Overlaps at ${current.hits.length} of ${current.samples} times; the first at ${formatTicks(current.hits[0]!.tick)}.`
                        : `No overlap at the ${current.samples} times checked. An overlap shorter than the interval can be missed.`) +
                      ((current.jumps ?? []).length
                        ? ` ${current.jumps!.length} mount switch${current.jumps!.length === 1 ? '' : 'es'} move${current.jumps!.length === 1 ? 's' : ''} the part.`
                        : '')}
        </p>
        {problem && (
          <p className="character-hint" role="alert">
            {problem}
          </p>
        )}
        {pairs.length > 0 && (
          <ul aria-label="Overlapping parts">
            {pairs.map((p) => (
              <li key={`${p.aId} ${p.bId}`} data-testid="character-prop-overlap">
                {p.a} and {p.b}: {formatTicks(p.first)}
                {p.last !== p.first ? ` – ${formatTicks(p.last)}` : ''} ({p.kind}, up to{' '}
                {p.depthMm.toFixed(1)} mm){' '}
                <button type="button" onClick={() => onSeek(p.first)}>
                  Go to {formatTicks(p.first)}
                </button>
              </li>
            ))}
          </ul>
        )}
        {ok && (ok.jumps ?? []).length > 0 && (
          <ul aria-label="Mount switches that jump">
            {ok.jumps!.map((j) => (
              <li key={`${j.tick} ${j.mount}`} data-testid="character-prop-jump">
                {mountName(j.mount)}: {jointName(j.mount, j.from)} → {jointName(j.mount, j.to)} at{' '}
                {formatTicks(j.tick)} moves the part {j.mm.toFixed(1)} mm・
                {((j.rad * 180) / Math.PI).toFixed(1)}°{' '}
                <button type="button" onClick={() => onSeek(j.tick)}>
                  Go to {formatTicks(j.tick)}
                </button>
              </li>
            ))}
          </ul>
        )}
        {ok && ok.unchecked.length > 0 && (
          <p className="character-hint" role="status">
            Not checked (no meshes at hand): {ok.unchecked.join(', ')}
          </p>
        )}
      </div>
    </Section>
  );
}
