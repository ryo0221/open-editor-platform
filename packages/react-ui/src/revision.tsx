import { useState } from 'react';
import { Dialog } from '@editor-platform/editor-ui';
import {
  prepareReactUiRevision,
  type ReactUiRevisionCandidate,
  type ReactUiDocument,
} from '@editor-platform/react-ui-core';
import type { EditorCommand } from '@editor-platform/editor-core';
export function ReactUiRevisionReview({
  document,
  candidate,
  readOnly,
  execute,
  close,
}: {
  document: ReactUiDocument;
  candidate: ReactUiRevisionCandidate;
  readOnly: boolean;
  execute(command: EditorCommand<ReactUiDocument>): void;
  close(): void;
}) {
  const [props, setProps] = useState(JSON.stringify(candidate.propMap));
  const [slots, setSlots] = useState(JSON.stringify(candidate.slotMap));
  const [preview, setPreview] = useState<ReturnType<typeof prepareReactUiRevision>>();
  const [error, setError] = useState('');
  return (
    <Dialog title="Review React revision" onClose={close}>
      <p>
        Adopt a pinned version explicitly. Current props, bindings, slot order and node IDs are
        retained through the reviewed mapping.
      </p>
      <p>
        {candidate.component
          ? `${candidate.component.name} → ${candidate.component.ref.version}`
          : `Environment → ${candidate.environment?.ref.version}`}
      </p>
      <details open>
        <summary>Current nodes and target registration</summary>
        <pre>
          {JSON.stringify(
            {
              nodes: document.nodes.filter((n) => candidate.nodeIds.includes(n.id)),
              target: candidate.component ?? candidate.environment,
            },
            null,
            2,
          )}
        </pre>
      </details>
      <label>
        Prop mapping JSON
        <input
          aria-label="Revision prop mapping"
          disabled={readOnly}
          value={props}
          onChange={(e) => {
            setProps(e.target.value);
            setPreview(undefined);
          }}
        />
      </label>
      <label>
        Slot mapping JSON
        <input
          aria-label="Revision slot mapping"
          disabled={readOnly}
          value={slots}
          onChange={(e) => {
            setSlots(e.target.value);
            setPreview(undefined);
          }}
        />
      </label>
      <button
        disabled={readOnly}
        onClick={() => {
          try {
            setPreview(
              prepareReactUiRevision(document, {
                ...candidate,
                propMap: JSON.parse(props),
                slotMap: JSON.parse(slots),
              }),
            );
            setError('');
          } catch (error) {
            setError(String(error));
          }
        }}
      >
        Preview revision
      </button>
      {preview && (
        <>
          <p role="status">Revision is compatible with the current explicit values.</p>
          <pre>
            {JSON.stringify(
              preview.after.nodes.filter((n) => candidate.nodeIds.includes(n.id)),
              null,
              2,
            )}
          </pre>
          <button
            disabled={readOnly}
            onClick={() => {
              try {
                execute(preview.command);
                close();
              } catch (error) {
                setError(String(error));
                setPreview(undefined);
              }
            }}
          >
            Adopt revision
          </button>
        </>
      )}
      <button onClick={close}>Keep old version</button>
      {error && <p role="alert">{error}</p>}
    </Dialog>
  );
}
