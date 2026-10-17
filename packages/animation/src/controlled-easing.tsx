import type { Easing } from '@editor-platform/animation-core';
export function ControlledEasing({
  value,
  change,
  composing,
  problemField,
  problemMessage,
  errorId,
}: {
  value: { type: Easing['type']; points: string[] };
  change(value: { type: Easing['type']; points: string[] }): void;
  composing(id: string, on: boolean): void;
  problemField?: string;
  problemMessage?: string;
  errorId: string;
}) {
  const n = value.points.map(Number);
  const valid = value.points.every(
    (p, i) => p.trim() !== '' && Number.isFinite(n[i]) && n[i] >= 0 && n[i] <= 1,
  );
  const path =
    value.type === 'hold'
      ? 'M0 100 L100 100 L100 0'
      : value.type === 'linear'
        ? 'M0 100 L100 0'
        : valid
          ? `M0 100 C${n[0] * 100} ${100 - n[1] * 100} ${n[2] * 100} ${100 - n[3] * 100} 100 0`
          : '';
  return (
    <fieldset className="ae-easing">
      <legend>Selected key: outgoing easing</legend>
      <label>
        Easing
        <select
          aria-label="Easing"
          value={value.type}
          onChange={(e) => change({ ...value, type: e.target.value as Easing['type'] })}
        >
          <option value="linear">Linear</option>
          <option value="hold">Hold</option>
          <option value="bezier">Cubic Bezier</option>
        </select>
      </label>
      {value.type === 'bezier' && (
        <div className="ac-fields">
          {['x1', 'y1', 'x2', 'y2'].map((p, i) => (
            <label key={p}>
              {p}
              <input
                aria-label={`Bezier ${p}`}
                type="text"
                inputMode="decimal"
                data-dirty="true"
                data-input-field={`easing-${p}`}
                aria-invalid={problemField === `easing-${p}` || undefined}
                aria-describedby={problemField === `easing-${p}` ? errorId : undefined}
                value={value.points[i]}
                onChange={(e) =>
                  change({
                    ...value,
                    points: value.points.map((v, j) => (i === j ? e.target.value : v)),
                  })
                }
                onCompositionStart={() => composing(`easing-${p}`, true)}
                onCompositionEnd={() => composing(`easing-${p}`, false)}
              />
              {problemField === `easing-${p}` && (
                <span id={errorId} role="alert" className="ac-input-error">
                  {problemMessage}
                </span>
              )}
            </label>
          ))}
        </div>
      )}
      <svg viewBox="-5 -5 110 110" role="img" aria-label="Outgoing interpolation curve">
        <path d="M0 0V100H100" fill="none" stroke="#94a3b8" />
        <path d={path} fill="none" stroke="#6366f1" strokeWidth="3" />
      </svg>
      <p>
        Apply inputs or Save to commit the outgoing curve with other pending edits. The final key
        has no outgoing segment.
      </p>
    </fieldset>
  );
}
