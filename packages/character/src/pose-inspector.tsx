import { useEffect, useRef, useState } from 'react';
import {
  eulerXyzToQuat,
  quatToEulerXyz,
  type Transform3,
  type Vec3,
} from '@editor-platform/character-core';
import { Section, useEditorInput } from '@editor-platform/editor-ui';
import { formatTicks } from './playback';

const round = (x: number, digits: number) => {
  const f = 10 ** digits;
  const r = Math.round(x * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

/** One number field: shows the posed value, commits on Enter or leaving the field. */
export function Field({
  label,
  value,
  unit,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  unit: string;
  disabled: boolean;
  /** False when the value was refused: a Host's flush then refuses the save. */
  onCommit(value: number): boolean | void;
}) {
  const [text, setTextState] = useState(String(value));
  // The buffer as of now (not as of the last render): a Host reads it right after a flush.
  const buffer = useRef(text);
  const setText = (t: string) => {
    buffer.current = t;
    setTextState(t);
  };
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setText(String(value)), [value]);
  /** A finite number typed, or undefined for empty or unparsable text. */
  const parsed = (t: string) => {
    const n = Number(t);
    return t.trim() === '' || !Number.isFinite(n) ? undefined : n;
  };
  // A value typed and not yet committed is the Host's to commit (or refuse) before a save.
  useEditorInput({
    label,
    read: () => ({ dirty: !disabled && buffer.current !== String(value) }),
    prepare: () => {
      if (disabled) return () => {};
      const n = parsed(buffer.current);
      if (n === undefined) throw new Error(`${label}: not a number`);
      // Accepted (or the same number spelled otherwise): the field shows the value again.
      return () => {
        const ok = n === value || onCommit(n) !== false;
        if (ok) setText(String(value));
        return ok;
      };
    },
    focus: () => input.current?.focus(),
  });
  /** Enter commits the value even when unchanged (a key that holds it); leaving only a change. */
  const commit = (explicit: boolean) => {
    const n = parsed(buffer.current);
    if (n === undefined) return setText(String(value));
    if ((explicit || n !== value) && onCommit(n) === false) return;
    setText(String(value));
  };
  return (
    <label className="character-field">
      <span>{label}</span>
      <input
        ref={input}
        type="number"
        inputMode="decimal"
        aria-label={label}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commit(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit(true);
          } else if (e.key === 'Escape') setText(String(value));
        }}
      />
      <span className="character-field-unit">{unit}</span>
    </label>
  );
}

/**
 * Pose mode for one bone (C2a): its local rotation (XYZ degrees) and translation (mm) at the
 * playhead. Changing a value keys it at the playhead in the chosen action, one edit each.
 */
export function PoseInspector({
  boneName,
  pose,
  tick,
  canKey,
  reason,
  onKey,
}: {
  boneName: string;
  /** The bone's local transform at the playhead, from the action's keys and the rest pose. */
  pose: Transform3;
  tick: number;
  canKey: boolean;
  /** Why keys cannot be set now, shown instead of the hint. */
  reason: string;
  /** False when refused, so a pending value is not lost by a save. */
  onKey(property: 'rotation' | 'translation', value: Vec3 | Transform3['rotation']): boolean | void;
}) {
  const euler = quatToEulerXyz(pose.rotation).map((x) => round(x, 2)) as Vec3;
  const at = pose.translation.map((x) => round(x, 2)) as Vec3;
  return (
    <Section title={`Pose · ${boneName}`}>
      <p className="character-hint">
        {canKey ? `A change keys this bone at ${formatTicks(tick)}.` : reason}
      </p>
      <fieldset className="character-fields" aria-label="Rotation" disabled={!canKey}>
        <legend>Rotation</legend>
        {(['X', 'Y', 'Z'] as const).map((axis, k) => (
          <Field
            key={axis}
            label={`Rotation ${axis}`}
            unit="°"
            value={euler[k]!}
            disabled={!canKey}
            onCommit={(v) => {
              const next = [...euler] as Vec3;
              next[k] = v;
              return onKey('rotation', eulerXyzToQuat(next));
            }}
          />
        ))}
      </fieldset>
      <fieldset className="character-fields" aria-label="Translation" disabled={!canKey}>
        <legend>Translation</legend>
        {(['X', 'Y', 'Z'] as const).map((axis, k) => (
          <Field
            key={axis}
            label={`Translation ${axis}`}
            unit="mm"
            value={at[k]!}
            disabled={!canKey}
            onCommit={(v) => {
              const next = [...pose.translation] as Vec3;
              next[k] = v;
              return onKey('translation', next);
            }}
          />
        ))}
      </fieldset>
    </Section>
  );
}
