import { useId, type ChangeEvent, type KeyboardEventHandler } from 'react';
/** Neutral controlled buffer. Parsing, validation and commits belong to its caller. */
export interface PropertyInputProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
  type?: 'text' | 'number' | 'date' | 'select' | 'json';
  options?: { value: string; label: string }[];
  /** Select placeholder value; callers can distinguish a legitimate empty option. */
  emptyValue?: string;
  required?: boolean;
  readOnly?: boolean;
  diagnostics?: string[];
  description?: string;
  onBlur?: () => void;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>;
  autoFocus?: boolean;
  showLabel?: boolean;
}
export function PropertyInput({
  value,
  onChange,
  label,
  type = 'text',
  options,
  emptyValue = '',
  required = false,
  readOnly = false,
  diagnostics = [],
  description,
  onBlur,
  onKeyDown,
  autoFocus = false,
  showLabel = false,
}: PropertyInputProps) {
  const id = useId(),
    messages = `${id}-messages`;
  const attrs = {
    id,
    'aria-label': label,
    'aria-describedby': description || diagnostics.length ? messages : undefined,
    'aria-invalid': diagnostics.length > 0 || undefined,
    value,
    disabled: readOnly,
    onBlur,
    onKeyDown,
    autoFocus,
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      onChange(e.target.value),
  };
  const control =
    type === 'select' ? (
      <select {...attrs}>
        <option value={emptyValue}>—</option>
        {options?.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    ) : type === 'json' ? (
      <textarea {...attrs} rows={4} />
    ) : (
      <input
        {...attrs}
        type={type === 'date' ? 'date' : 'text'}
        inputMode={type === 'number' ? 'decimal' : undefined}
        onFocus={(e) => {
          if (autoFocus && type !== 'date') e.currentTarget.select();
        }}
      />
    );
  if (!showLabel && !description && !diagnostics.length) return control;
  return (
    <div className="ep-property-input">
      {showLabel && (
        <label htmlFor={id}>
          {label}
          {required ? ' *' : ''}
        </label>
      )}
      {control}
      <div id={messages}>
        {description && <small>{description}</small>}
        {diagnostics.map((d) => (
          <div role="alert" key={d}>
            {d}
          </div>
        ))}
      </div>
    </div>
  );
}
