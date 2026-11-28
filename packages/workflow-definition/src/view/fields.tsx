import { useEffect, useState } from 'react';
import { PropertyInput } from '@editor-platform/property-input';

/**
 * A text buffer that commits on blur or Enter and reverts on Escape. A refused commit keeps the
 * typed text and shows the reason, so nothing is lost silently.
 */
export function TextField(props: {
  label: string;
  value: string;
  readOnly: boolean;
  onCommit: (value: string) => string | undefined;
  multiline?: boolean;
  required?: boolean;
}) {
  const [draft, setDraft] = useState(props.value),
    [error, setError] = useState<string>();
  useEffect(() => {
    setDraft(props.value);
    setError(undefined);
  }, [props.value]);
  const commit = () => {
    if (draft === props.value) return setError(undefined);
    setError(props.onCommit(draft));
  };
  return (
    <PropertyInput
      label={props.label}
      value={draft}
      type={props.multiline ? 'json' : 'text'}
      required={props.required}
      readOnly={props.readOnly}
      diagnostics={error ? [error] : []}
      onChange={setDraft}
      onBlur={commit}
      onKeyDown={(e) => {
        // Enter and Escape belong to the IME while a conversion is open.
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter' && !props.multiline) {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          setDraft(props.value);
          setError(undefined);
        }
      }}
    />
  );
}
export interface Choice {
  value: string;
  label: string;
}
/** A list of IDs: each with a remove button, and a chooser that adds one of the candidates. */
export function IdList(props: {
  label: string;
  values: readonly string[];
  choices: readonly Choice[];
  readOnly: boolean;
  onChange: (values: string[]) => void;
}) {
  const known = new Map(props.choices.map((c) => [c.value, c.label]));
  const free = props.choices.filter((c) => !props.values.includes(c.value));
  return (
    <div className="ep-wd-ids" role="group" aria-label={props.label}>
      {props.values.map((id) => (
        <span key={id} className={known.has(id) ? 'ep-wd-chip' : 'ep-wd-chip ep-wd-missing'}>
          {known.get(id) ?? `${id}（無い）`}
          {!props.readOnly && (
            <button
              type="button"
              aria-label={`Remove ${id} from ${props.label}`}
              onClick={() => props.onChange(props.values.filter((v) => v !== id))}
            >
              ×
            </button>
          )}
        </span>
      ))}
      {!props.readOnly && free.length > 0 && (
        <select
          aria-label={`Add to ${props.label}`}
          value=""
          onChange={(e) => e.target.value && props.onChange([...props.values, e.target.value])}
        >
          <option value="">＋</option>
          {free.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
export function SelectField(props: {
  label: string;
  value: string;
  choices: readonly Choice[];
  readOnly: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <PropertyInput
      label={props.label}
      value={props.value}
      type="select"
      options={[...props.choices]}
      readOnly={props.readOnly}
      onChange={props.onChange}
    />
  );
}
