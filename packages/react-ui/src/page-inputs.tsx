import { useEffect, useRef, useState } from 'react';
import { CommitInput } from '@editor-platform/editor-ui';
import { checkedReactUiCommand } from './inspector';
import type { ReactUiDocument } from '@editor-platform/react-ui-core';
import type { EditorCommand } from '@editor-platform/editor-core';
export function ReactUiPageInputs({
  document,
  readOnly,
  execute,
  focusInput,
}: {
  document: ReactUiDocument;
  readOnly: boolean;
  execute(command: EditorCommand<ReactUiDocument>): boolean | void;
  focusInput?: { name: string; request: number };
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!focusInput || !details.current) return;
    details.current.open = true;
    const input =
      [...details.current.querySelectorAll<HTMLElement>('input,textarea')].find(
        (element) => element.getAttribute('aria-label') === `Preview input ${focusInput.name}`,
      ) ?? details.current.querySelector<HTMLElement>('textarea');
    input?.focus();
  }, [focusInput]);
  const setPreview = (name: string, value: string | number | boolean) => {
    try {
      if (readOnly) throw new Error('Read only');
      const accepted = execute(
        checkedReactUiCommand('Edit preview input', (document) => ({
          ...document,
          fixture: { ...document.fixture, [name]: value },
        })),
      );
      if (accepted === false) {
        setError('Preview input change was rejected.');
        return false;
      }
      setError('');
      return true;
    } catch (error) {
      setError(String(error));
      return false;
    }
  };
  useEffect(
    () =>
      setValue(
        JSON.stringify(
          {
            inputs: document.inputs,
            callbacks: document.callbacks,
            fixture: document.fixture,
            breakpoints: document.breakpoints,
          },
          null,
          2,
        ),
      ),
    [document.inputs, document.callbacks, document.fixture, document.breakpoints],
  );
  return (
    <details ref={details}>
      <summary>Page data, callbacks & breakpoints</summary>
      <fieldset disabled={readOnly}>
        <legend>Preview inputs</legend>
        {Object.entries(document.inputs).map(([name, field]) => {
          const value = Object.hasOwn(document.fixture, name)
            ? document.fixture[name]
            : field.default;
          return field.schema.type === 'string' || field.schema.type === 'number' ? (
            <CommitInput
              key={name}
              label={`Preview input ${name}`}
              value={typeof value === 'string' || typeof value === 'number' ? value : ''}
              type={field.schema.type === 'number' ? 'number' : 'text'}
              onCommit={(raw) =>
                setPreview(name, field.schema.type === 'number' ? Number(raw) : raw)
              }
            />
          ) : field.schema.type === 'boolean' ? (
            <label key={name}>
              {name}
              <input
                type="checkbox"
                aria-label={`Preview input ${name}`}
                disabled={readOnly}
                checked={value === true}
                onChange={(event) => setPreview(name, event.target.checked)}
              />
            </label>
          ) : null;
        })}
      </fieldset>
      <label>
        Published contracts and preview fixture
        <textarea
          aria-label="Page contract JSON"
          disabled={readOnly}
          rows={12}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <button
        disabled={readOnly}
        onClick={() => {
          try {
            const raw = JSON.parse(value) as Pick<
              ReactUiDocument,
              'inputs' | 'callbacks' | 'fixture' | 'breakpoints'
            >;
            if (Object.keys(raw).sort().join(',') !== 'breakpoints,callbacks,fixture,inputs')
              throw new Error('Expected inputs/callbacks/fixture/breakpoints');
            const accepted = execute(
              checkedReactUiCommand('Edit page contracts and preview fixture', (document) => ({
                ...document,
                ...raw,
              })),
            );
            if (accepted === false) throw new Error('Page contract change was rejected.');
            setError('');
          } catch (error) {
            setError(String(error));
          }
        }}
      >
        Apply page contract
      </button>
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
