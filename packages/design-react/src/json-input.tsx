import { useState } from 'react';

/** JSON editor for explicit Web metadata; parse errors stay local until applied. */
export function JsonInput({
  label,
  value,
  onApply,
}: {
  label: string;
  value: unknown;
  onApply(value: unknown): void;
}) {
  const [buffer, setBuffer] = useState<string>(),
    [error, setError] = useState('');
  return (
    <div className="ep-field">
      <label>
        {label}
        <textarea
          aria-label={label}
          rows={5}
          value={buffer ?? JSON.stringify(value, null, 2)}
          onChange={(e) => setBuffer(e.target.value)}
        />
      </label>
      <button
        onClick={() => {
          try {
            onApply(JSON.parse(buffer ?? JSON.stringify(value)));
            setBuffer(undefined);
            setError('');
          } catch (e) {
            setError(String(e));
          }
        }}
      >
        Apply {label}
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
