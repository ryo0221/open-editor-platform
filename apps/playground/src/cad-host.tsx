/** Independent entry: public CAD packages only, never Playground App, model or CSS. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CadSurface, createCadBinding } from '@editor-platform/cad';
import '@editor-platform/cad/style.css';
import { f02Plate, isCadDocument, type CadDocument } from '@editor-platform/cad-core';
import KernelWorker from '@editor-platform/cad-kernel-occt/worker?worker';
import { EditorSession } from '@editor-platform/editor-core';
import { EditorExportGuardContext, EditorInputsContext } from '@editor-platform/editor-ui';
import '@editor-platform/editor-ui/styles.css';
import kernelBuild from 'virtual:cad-kernel-build';
import './cad-host.css';

// This Host owns storage, permission and the kernel build; the Surface owns editing and history.
const draftKey = 'ep-cad-host:draft';
function initialDocument(): CadDocument {
  const plate = f02Plate();
  const fresh = {
    ...plate,
    kernelProfile: {
      ...plate.kernelProfile,
      id: 'opencascade.js-2.0.0-beta.b5ff984',
      buildHash: kernelBuild?.buildHash ?? `sha256:${'0'.repeat(64)}`,
    },
  };
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(draftKey) ?? 'null');
    return isCadDocument(saved) ? saved : fresh;
  } catch {
    return fresh;
  }
}

/** Mounted only while attached: unmounting releases the kernel Worker, never the session. */
function AttachedSurface({
  session,
  readOnly,
  guard,
  onEvent,
}: {
  session: EditorSession<CadDocument>;
  readOnly: boolean;
  guard: { current: (() => void) | undefined };
  onEvent(message: string): void;
}) {
  const access = useRef({ readOnly, generation: 0 });
  if (access.current.readOnly !== readOnly)
    access.current = { readOnly, generation: access.current.generation + 1 };
  const binding = useMemo(
    () =>
      createCadBinding({
        session,
        build: kernelBuild,
        spawnWorker: () => new KernelWorker() as never,
        canEdit: () => !access.current.readOnly,
        permissionGeneration: () => access.current.generation,
        onApplied: () => onEvent(`Applied revision ${session.revision.sequence}`),
      }),
    [session, onEvent],
  );
  useEffect(() => {
    guard.current = binding.flushInputs;
    return () => {
      guard.current = undefined;
      binding.dispose();
    };
  }, [binding, guard]);
  useEffect(() => binding.controller.accessChanged(), [binding, readOnly]);
  return (
    <EditorInputsContext.Provider value={binding.inputs}>
      <EditorExportGuardContext.Provider value={binding.flushInputs}>
        <CadSurface controller={binding.controller} name="cad-host" />
      </EditorExportGuardContext.Provider>
    </EditorInputsContext.Provider>
  );
}

function CadHost() {
  const [session] = useState(() => new EditorSession(initialDocument()));
  const [readOnly, setReadOnly] = useState(false);
  const [attached, setAttached] = useState(true);
  const [event, setEvent] = useState('');
  const [error, setError] = useState('');
  const guard = useRef<() => void>(undefined);
  /**
   * Save/export/detach boundary: field drafts commit first; an invalid or evaluating input, or a
   * failing action (e.g. full storage), is reported instead of a stale success message.
   */
  function boundary(action: () => void) {
    try {
      guard.current?.();
      action();
      setError('');
    } catch (e) {
      setEvent('');
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <main className="cad-host">
      <header className="cad-host-controls">
        <label>
          <input
            type="checkbox"
            checked={readOnly}
            onChange={(e) => setReadOnly(e.target.checked)}
          />
          Read only
        </label>
        <button
          disabled={readOnly}
          onClick={() =>
            boundary(() => {
              localStorage.setItem(draftKey, JSON.stringify(session.content));
              setEvent(`Saved revision ${session.revision.sequence}`);
            })
          }
        >
          Save draft
        </button>
        <button
          onClick={() =>
            boundary(() => {
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(session.content, null, 2)], {
                  type: 'application/json',
                }),
              );
              Object.assign(document.createElement('a'), {
                href: url,
                download: 'cad-host.json',
              }).click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            })
          }
        >
          Export JSON
        </button>
        <button onClick={() => boundary(() => setAttached(!attached))}>
          {attached ? 'Detach editor' : 'Attach editor'}
        </button>
        <output aria-label="Host event">{event}</output>
        {error && <p role="alert">{error}</p>}
      </header>
      <section className="cad-host-boundary">
        {attached ? (
          <AttachedSurface session={session} readOnly={readOnly} guard={guard} onEvent={setEvent} />
        ) : (
          <p>Editor detached. The draft and its history stay in this Host.</p>
        )}
      </section>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<CadHost />);
