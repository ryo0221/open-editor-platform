import { useState } from 'react';
import {
  changedJoints,
  changedMounts,
  propJointChannel,
  propTransformKeys,
  type CharacterAction,
  type PropTransformGroup,
  type PropTransformKey,
  type PropTransformProblem,
} from '@editor-platform/character-core';
import { Section } from '@editor-platform/editor-ui';
import { formatTicks, ticksPerSecond } from './playback';
import type { CharacterPropForm, CharacterPropJoint, CharacterPropMount } from './props';

/** The easings a group can start with (the dope sheet edits any key's easing afterwards). */
export const transformEasings = {
  'ease-in-out': { type: 'bezier', x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
  'ease-out': { type: 'bezier', x1: 0, y1: 0, x2: 0.58, y2: 1 },
  'ease-in': { type: 'bezier', x1: 0.42, y1: 0, x2: 1, y2: 1 },
  linear: { type: 'linear' },
} as const satisfies Record<string, PropTransformGroup['easing']>;
type EasingName = keyof typeof transformEasings;
const easingLabels: Record<EasingName, string> = {
  'ease-in-out': 'Ease in and out',
  'ease-out': 'Ease out',
  'ease-in': 'Ease in',
  linear: 'Linear',
};
interface GroupDraft {
  start: string;
  length: string;
  easing: EasingName;
}
export interface MadeTransform {
  keys: PropTransformKey[];
  from: number;
  to: number;
}

const problemText = (p: PropTransformProblem, joint: (id: string) => string, end: string) => {
  switch (p.code) {
    case 'transform-groups':
      return 'Add a group.';
    case 'transform-group-empty':
      return `Group ${p.group + 1} has no joints.`;
    case 'transform-time':
      return `Group ${p.group + 1} must start at 0 s or later, last longer than 0 s and end by ${end}.`;
    case 'transform-joint-twice':
      return `${joint(p.joint)} is in two groups.`;
    case 'transform-joint-ungrouped':
      return `${joint(p.joint)} changes but is in no group.`;
    case 'transform-values':
      return `The two forms do not name the same values of ${joint(p.joint)}.`;
    case 'transform-mounts':
      return 'The two forms do not name the same mounts.';
    case 'transform-switch-time':
      return `The switch of ${p.mount} must lie within the transform.`;
  }
};

/** Keys of `targets` in `action` that a transform over [from, to] replaces. */
/**
 * The group a joint is in: the one chosen for it, else the first, within the `count` groups.
 * Own entries only: a joint ID such as `toString` must not read an inherited function.
 */
export function assignedGroup(assigned: Record<string, number>, joint: string, count: number) {
  return Math.min(Object.hasOwn(assigned, joint) ? assigned[joint]! : 0, count - 1);
}
export function replacedKeys(action: CharacterAction, made: MadeTransform) {
  const targets = new Set(made.keys.map((k) => propJointChannel(k.target)));
  let n = 0;
  for (const t of action.tracks)
    if (propJointChannel(t.target) !== undefined && targets.has(propJointChannel(t.target)))
      n += t.keys.filter((k) => k.tick >= made.from && k.tick <= made.to).length;
  return n;
}

/**
 * MR4 (docs/cad/mecha-design.md): moves a prop from one form of its version to another. The
 * joints that change are put in groups; each group moves from its start for its length with its
 * easing. Making it writes plain joint keys into the action, replacing (after a confirmation)
 * the keys of those values within the transform's span. MR7: a mount whose joint differs
 * between the forms switches at a time within the transform (its start by default), as a held
 * mount key.
 */
export function PropTransformPanel({
  propId,
  joints,
  forms,
  mounts = [],
  action,
  canKey,
  reason,
  onMake,
}: {
  propId: string;
  joints: readonly CharacterPropJoint[];
  forms: readonly CharacterPropForm[];
  /** MR7: the version's mounts, for their names. */
  mounts?: readonly CharacterPropMount[];
  action: CharacterAction | undefined;
  canKey: boolean;
  reason: string;
  /** False when the edit was refused (shown by the Surface). */
  onMake(made: MadeTransform): boolean;
}) {
  const usable = forms.filter((f) => !f.problem);
  const [fromId, setFromId] = useState(usable[0]?.id ?? '');
  const [toId, setToId] = useState(usable[1]?.id ?? '');
  const [groups, setGroups] = useState<GroupDraft[]>([
    { start: '0', length: '1', easing: 'ease-in-out' },
  ]);
  const [assigned, setAssigned] = useState<Record<string, number>>({});
  /** MR7: each switching mount's time (s), blank for the transform's start. */
  const [switches, setSwitches] = useState<Record<string, string>>({});
  // Own entries only: a mount ID such as `toString` must not read an inherited function.
  const switchDraft = (m: string) => (Object.hasOwn(switches, m) ? switches[m]! : '');
  const [problem, setProblem] = useState<string>();
  // A confirmation holds for the action as it was when asked: another action, or an edit of
  // this one, drops it, so "Replace keys" never writes a transform counted against other keys.
  const [asked, setConfirm] = useState<{
    made: MadeTransform;
    count: number;
    action: CharacterAction;
  }>();
  const confirm = asked && asked.action === action ? asked : undefined;
  const from = usable.find((f) => f.id === fromId);
  const to = usable.find((f) => f.id === toId);
  const name = (id: string) => joints.find((j) => j.id === id)?.name ?? id;
  const changed = from && to ? changedJoints(from.values, to.values) : [];
  const switching =
    from?.mounts && to?.mounts ? changedMounts(from.mounts, to.mounts) : ([] as string[]);
  const mountName = (id: string) => mounts.find((m) => m.id === id)?.name ?? id;
  const candidateName = (mount: string, joint: string | undefined) =>
    mounts.find((m) => m.id === mount)?.joints.find((j) => j.id === joint)?.name ?? joint;
  const groupOf = (joint: string) => assignedGroup(assigned, joint, groups.length);
  const forget = () => {
    setProblem(undefined);
    setConfirm(undefined);
  };
  const setGroup = (i: number, patch: Partial<GroupDraft>) => {
    forget();
    setGroups(groups.map((g, k) => (k === i ? { ...g, ...patch } : g)));
  };
  const removeGroup = (i: number) => {
    forget();
    setGroups(groups.filter((_, k) => k !== i));
    // The joints of the removed group go to the first; those after it move down one.
    setAssigned(
      Object.fromEntries(
        Object.entries(assigned).map(([j, g]) => [j, g === i ? 0 : g > i ? g - 1 : g]),
      ),
    );
  };
  const make = () => {
    if (!action || !from || !to) return;
    const seconds = (t: string) => (t.trim() === '' ? NaN : Number(t) * ticksPerSecond);
    const input = {
      propId,
      duration: action.duration,
      from: from.values,
      to: to.values,
      groups: groups.map((g, i) => ({
        joints: changed.filter((j) => groupOf(j) === i),
        start: Math.round(seconds(g.start)),
        length: Math.round(seconds(g.length)),
        easing: transformEasings[g.easing],
      })),
      ...(from.mounts && to.mounts
        ? {
            mounts: {
              from: from.mounts,
              to: to.mounts,
              switches: Object.fromEntries(
                switching
                  .filter((m) => switchDraft(m).trim() !== '')
                  .map((m) => [m, Math.round(seconds(switchDraft(m)))]),
              ),
            },
          }
        : {}),
    };
    const r = propTransformKeys(input);
    if (r.status === 'refused') {
      setProblem(
        `${r.problem.code}: ${problemText(
          r.problem.code === 'transform-switch-time'
            ? { ...r.problem, mount: mountName(r.problem.mount) }
            : r.problem,
          name,
          formatTicks(action.duration),
        )}`,
      );
      return;
    }
    const made = { keys: r.keys, from: r.from, to: r.to };
    const count = replacedKeys(action, made);
    if (count && !confirm) {
      setConfirm({ made, count, action });
      return;
    }
    if (onMake(made)) forget();
  };
  const ready = canKey && !!action && !!from && !!to && from.id !== to.id;
  return (
    <Section title="Transform">
      {forms.length < 2 ? (
        <p className="character-hint">This version needs two forms to make a transform.</p>
      ) : (
        <div data-testid="character-prop-transform">
          <p className="character-hint">
            {canKey ? 'Moves the joints from one form to the other in this action.' : reason}
          </p>
          <div className="character-fields">
            {(
              [
                ['Transform from', fromId, setFromId],
                ['Transform to', toId, setToId],
              ] as const
            ).map(([label, value, set]) => (
              <label key={label}>
                {label}
                <select
                  aria-label={label}
                  value={value}
                  onChange={(e) => {
                    forget();
                    set(e.target.value);
                  }}
                >
                  <option value="">—</option>
                  {forms.map((f) => (
                    <option key={f.id} value={f.id} disabled={!!f.problem}>
                      {f.name}
                      {f.problem === 'configuration-stale'
                        ? ' (does not fit the joints)'
                        : f.problem === 'joint-limit'
                          ? ' (past a joint limit)'
                          : ''}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          {groups.map((g, i) => (
            <fieldset
              key={i}
              className="character-fields"
              aria-label={`Group ${i + 1}`}
              data-testid="character-transform-group"
            >
              <legend>Group {i + 1}</legend>
              <label>
                Start (s)
                <input
                  aria-label={`Group ${i + 1} start (s)`}
                  inputMode="decimal"
                  value={g.start}
                  onChange={(e) => setGroup(i, { start: e.target.value })}
                />
              </label>
              <label>
                Length (s)
                <input
                  aria-label={`Group ${i + 1} length (s)`}
                  inputMode="decimal"
                  value={g.length}
                  onChange={(e) => setGroup(i, { length: e.target.value })}
                />
              </label>
              <select
                aria-label={`Group ${i + 1} easing`}
                value={g.easing}
                onChange={(e) => setGroup(i, { easing: e.target.value as EasingName })}
              >
                {(Object.keys(transformEasings) as EasingName[]).map((k) => (
                  <option key={k} value={k}>
                    {easingLabels[k]}
                  </option>
                ))}
              </select>
              {groups.length > 1 && (
                <button type="button" onClick={() => removeGroup(i)}>
                  Remove group {i + 1}
                </button>
              )}
            </fieldset>
          ))}
          <button
            type="button"
            onClick={() => {
              forget();
              setGroups([...groups, { start: '0', length: '1', easing: 'ease-in-out' }]);
            }}
          >
            Add group
          </button>
          {from && to && (
            <ul aria-label="Joints that change">
              {changed.length === 0 && switching.length === 0 && (
                <li>The two forms are the same.</li>
              )}
              {changed.map((j) => (
                <li key={j} data-testid="character-transform-joint">
                  {name(j)}{' '}
                  <select
                    aria-label={`Group of ${name(j)}`}
                    value={groupOf(j)}
                    onChange={(e) => {
                      forget();
                      setAssigned({ ...assigned, [j]: Number(e.target.value) });
                    }}
                  >
                    {groups.map((_, i) => (
                      <option key={i} value={i}>
                        Group {i + 1}
                      </option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>
          )}
          {switching.length > 0 && (
            <ul aria-label="Mounts that switch">
              {switching.map((m) => (
                <li key={m} data-testid="character-transform-mount">
                  {mountName(m)}: {candidateName(m, from?.mounts?.[m])} →{' '}
                  {candidateName(m, to?.mounts?.[m])}{' '}
                  <label>
                    at (s)
                    <input
                      aria-label={`Switch ${mountName(m)} at (s)`}
                      inputMode="decimal"
                      placeholder="start"
                      value={switchDraft(m)}
                      onChange={(e) => {
                        forget();
                        setSwitches({ ...switches, [m]: e.target.value });
                      }}
                    />
                  </label>
                </li>
              ))}
            </ul>
          )}
          {problem && (
            <p className="character-hint" role="alert">
              {problem}
            </p>
          )}
          {confirm ? (
            <div role="alertdialog" aria-label="Replace keys">
              <p className="character-hint">
                Replaces {confirm.count} key{confirm.count === 1 ? '' : 's'} of these joints between{' '}
                {formatTicks(confirm.made.from)} and {formatTicks(confirm.made.to)}.
              </p>
              <button type="button" onClick={() => onMake(confirm.made) && forget()}>
                Replace keys
              </button>
              <button type="button" onClick={forget}>
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={!ready || changed.length + switching.length === 0}
              onClick={make}
            >
              Make transform
            </button>
          )}
        </div>
      )}
    </Section>
  );
}
