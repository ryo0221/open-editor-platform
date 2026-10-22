import { useCallback, useEffect, useMemo, useRef } from 'react';
import { canonicalJson } from '@editor-platform/artifact-core';
import { CadSurface, createCadBinding } from '@editor-platform/cad';
import '@editor-platform/cad/style.css';
import type { CadDocument } from '@editor-platform/cad-core';
import KernelWorker from '@editor-platform/cad-kernel-occt/worker?worker';
import type { EditorInputs, EditorSession } from '@editor-platform/editor-core';
import { EditorExportGuardContext } from '@editor-platform/editor-ui';
import { cadKernel, downloadBlob, type StoredArtifact } from '../model';

/**
 * Playground binding for the CAD Surface. Edits go through the controller (async prepare, one
 * session edit) and the Host persists the draft afterwards; Undo/Redo stay with the Host.
 */
export default function CadHost({
  artifact,
  session,
  readOnly,
  inputs,
  persist,
}: {
  artifact: StoredArtifact;
  session: EditorSession<CadDocument>;
  readOnly: boolean;
  inputs: EditorInputs;
  persist(content: CadDocument): void;
}) {
  const access = useRef({ readOnly, generation: 0 });
  if (access.current.readOnly !== readOnly)
    access.current = { readOnly, generation: access.current.generation + 1 };
  const persistRef = useRef(persist);
  persistRef.current = persist;
  const applied = useRef<string | undefined>(undefined);
  const binding = useMemo(
    () =>
      createCadBinding({
        session,
        build: cadKernel,
        spawnWorker: () => new KernelWorker() as never,
        canEdit: () => !access.current.readOnly,
        permissionGeneration: () => access.current.generation,
        onApplied: (content) => {
          applied.current = canonicalJson(session.revision);
          persistRef.current(content);
        },
      }),
    [session],
  );
  const { controller } = binding;
  useEffect(() => () => binding.dispose(), [binding]);
  useEffect(() => controller.accessChanged(), [controller, readOnly]);
  // An edit still evaluating is pending input: save, export and switch boundaries refuse to
  // capture the draft until it is applied or rejected.
  useEffect(() => {
    const stop = inputs.register({
      label: '3D CAD',
      read: () => ({ dirty: !!binding.pendingInput() }),
      prepare: () => {
        throw new Error(binding.pendingInput());
      },
      focus: () => {},
    });
    const unsubscribe = controller.subscribe(inputs.changed);
    return () => {
      unsubscribe();
      stop();
    };
  }, [binding, controller, inputs]);
  // Host Undo/Redo or restore changed the session: re-evaluate (own edits are already current).
  const revision = canonicalJson(session.revision);
  useEffect(() => {
    if (revision !== applied.current) void controller.sync();
  }, [controller, revision]);
  // PNG export flushes the same inputs as the Host's other exports.
  const guardExport = useCallback(() => inputs.flush(), [inputs]);
  return (
    <EditorExportGuardContext.Provider value={guardExport}>
      <CadSurface
        controller={controller}
        hostHistory
        name={artifact.name}
        onExportPng={(png) => downloadBlob(`${artifact.name}.png`, png)}
      />
    </EditorExportGuardContext.Provider>
  );
}
