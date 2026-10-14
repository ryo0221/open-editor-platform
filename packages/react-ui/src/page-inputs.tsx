import { useEffect, useState } from 'react';
import { checkedReactUiCommand } from './inspector';
import type { ReactUiDocument } from '@editor-platform/react-ui-core';
import type { EditorCommand } from '@editor-platform/editor-core';
export function ReactUiPageInputs({
  document,
  readOnly,
  execute,
}: {
  document: ReactUiDocument;
  readOnly: boolean;
  execute(command: EditorCommand<ReactUiDocument>): void;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
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
    <details>
      <summary>Page data, callbacks & breakpoints</summary>
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
            execute(
              checkedReactUiCommand('Edit page contracts and preview fixture', (document) => ({
                ...document,
                ...raw,
              })),
            );
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
