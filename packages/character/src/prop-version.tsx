import { useEffect, useRef, useState } from 'react';
import type { CharacterDocument, CharacterProp } from '@editor-platform/character-core';
import { Section } from '@editor-platform/editor-ui';
import { formatTicks } from './playback';
import {
  propSourceProblems,
  type CharacterPropChoice,
  type CharacterPropVersionJoints,
  type PropSourceProblem,
} from './props';

const problemText = (doc: CharacterDocument, p: PropSourceProblem) => {
  const action = doc.actions.find((a) => a.id === p.actionId)?.name ?? p.actionId;
  if (p.code === 'mount-missing')
    return p.joint === undefined
      ? `mount ${p.mount} in ${action}: the mount is not in this version`
      : `mount ${p.mount} in ${action}: ${p.joint} is not one of its candidates in this version`;
  const what = `${p.joint} ${p.key} in ${action}`;
  switch (p.code) {
    case 'joint-missing':
      return `${what}: the joint is not in this version`;
    case 'value-missing':
      return `${what}: the joint has no such value in this version`;
    case 'value-coupled':
      return `${what}: the value follows another joint in this version`;
    case 'key-out-of-limits':
      return `${what}: the key at ${formatTicks(p.tick)} is past the joint's limits`;
    case 'follower-out-of-limits':
      return `${what}: the key at ${formatTicks(p.tick)} moves ${p.follower.joint} ${p.follower.key}, which follows it, past its limits`;
  }
};

/**
 * MR4 (docs/cad/mecha-design.md): points a prop at another saved version of its Artifact,
 * keeping its ID, placement and keys. The Host keeps the version with the character and reads
 * its joints; a joint track the version could not play refuses the update
 * (`prop-source-incompatible`) and is listed. Only "Remove unfit tracks and update" removes those
 * tracks, in the same edit; keys are never clamped.
 */
export function PropVersionUpdate({
  doc,
  prop,
  choices,
  readOnly,
  onPrepare,
  onUpdate,
}: {
  doc: CharacterDocument;
  prop: CharacterProp;
  /** Saved versions of the prop's Artifact other than its own. */
  choices: readonly CharacterPropChoice[];
  readOnly: boolean;
  /** The Host keeps the version and reads its joints; rejects with a reason. */
  onPrepare(choice: CharacterPropChoice): Promise<CharacterPropVersionJoints>;
  /** False when the edit was refused (shown by the Surface). */
  onUpdate(choice: CharacterPropChoice, drop: PropSourceProblem[]): boolean;
}) {
  const [chosen, setChosen] = useState('');
  // The document as it is now: an edit made while the Host prepares the version is checked too.
  const latest = useRef(doc);
  latest.current = doc;
  // A request outlives the inspector it started in (another prop selected): when it settles
  // after the inspector is gone, or after the prop's source changed, it is dropped, so an older
  // request never overwrites a newer update.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  // The version's joints, read once: its problems are found again against the document as it
  // is now, so an edit made meanwhile is checked too.
  const [unfit, setUnfit] = useState<{
    choice: CharacterPropChoice;
    joints: CharacterPropVersionJoints;
  }>();
  const problems = unfit ? propSourceProblems(doc, prop.id, unfit.joints) : [];
  const choice = choices.find((c) => c.contentHash === chosen);
  const forget = () => {
    setError(undefined);
    setUnfit(undefined);
  };
  const update = async () => {
    if (!choice) return;
    forget();
    setRunning(true);
    try {
      const from = prop.source.contentHash;
      const joints = await onPrepare(choice);
      if (!mounted.current) return;
      const now = latest.current.props.find((p) => p.id === prop.id);
      if (now?.source.contentHash !== from) {
        setError('Version not updated: the prop changed while the version was read.');
        return;
      }
      if (!propSourceProblems(latest.current, prop.id, joints).length) {
        if (onUpdate(choice, [])) setChosen('');
      } else setUnfit({ choice, joints });
    } catch (e) {
      if (!mounted.current) return;
      setError(`Version not updated: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (mounted.current) setRunning(false);
    }
  };
  return (
    <Section title="Version">
      <div data-testid="character-prop-version">
        <div className="character-fields">
          <select
            aria-label="Update to version"
            value={chosen}
            disabled={readOnly || running}
            onChange={(e) => {
              forget();
              setChosen(e.target.value);
            }}
          >
            <option value="">—</option>
            {choices.map((c) => (
              <option key={c.contentHash} value={c.contentHash}>
                {c.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={readOnly || running || !choice || !!unfit}
            onClick={() => void update()}
          >
            Update version
          </button>
        </div>
        {error && (
          <p className="character-hint" role="alert">
            {error}
          </p>
        )}
        {unfit && (
          <div role="alertdialog" aria-label="Unfit tracks">
            <p className="character-hint" role="alert">
              prop-source-incompatible: {problems.length} track
              {problems.length === 1 ? '' : 's'} of this prop cannot be played by{' '}
              {unfit.choice.label}.
            </p>
            <ul aria-label="Tracks the version cannot play">
              {problems.map((p) => (
                <li key={`${p.actionId} ${p.trackId}`}>{problemText(doc, p)}</li>
              ))}
            </ul>
            <button
              type="button"
              disabled={readOnly}
              onClick={() => {
                if (onUpdate(unfit.choice, problems)) {
                  setChosen('');
                  forget();
                }
              }}
            >
              Remove unfit tracks and update
            </button>
            <button type="button" onClick={forget}>
              Cancel
            </button>
          </div>
        )}
      </div>
    </Section>
  );
}
