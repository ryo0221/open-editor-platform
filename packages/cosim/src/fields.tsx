import { useContext } from 'react';
import { CommitInput, EditorInputsContext } from '@editor-platform/editor-ui';

/** Runs `run` after settling the inputs; does nothing when a draft is refused (AGENTS.md). */
export function useSettle() {
  const inputs = useContext(EditorInputsContext);
  return (run: () => void) => {
    try {
      inputs?.flush();
    } catch {
      return;
    }
    run();
  };
}
/** A content field: a CommitInput when editable, else a read-only text box (text stays selectable). */
export function Field({
  readOnly,
  label,
  value,
  onCommit,
}: {
  readOnly: boolean;
  label: string;
  value: string;
  onCommit: (value: string) => boolean;
}) {
  if (!readOnly) return <CommitInput label={label} value={value} onCommit={onCommit} />;
  return (
    <label className="ep-field">
      {label}
      <input type="text" aria-label={label} value={value} readOnly />
    </label>
  );
}

/** A select whose change is applied at once (callers settle the inputs first). */
export function Choice({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string | number;
  /** Values, or values with their shown text. */
  options: readonly (string | number | { value: string; label: string })[];
  disabled?: boolean;
  onChange(v: string): void;
}) {
  return (
    <label className="ep-field">
      {label}
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => {
          const [v, text] = typeof o === 'object' ? [o.value, o.label] : [String(o), String(o)];
          return (
            <option key={v} value={v}>
              {text}
            </option>
          );
        })}
      </select>
    </label>
  );
}
