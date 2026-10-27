import { useEffect, useMemo } from 'react';
import { canonicalJson } from '@editor-platform/artifact-core';
import { BimController, BimSurface, WorkerBimKernel, type BimSession } from '@editor-platform/bim';
import '@editor-platform/bim/style.css';
import KernelWorker from '@editor-platform/bim/worker?worker';
import type { BimDocument } from '@editor-platform/bim-core';
import type { CadCatalogBuild } from '@editor-platform/cad-kernel-occt';
import { EditorInputs, type EditorCommand } from '@editor-platform/editor-core';
import type { ArtifactEditor } from '@editor-platform/editor-host';
import { EditorHistoryContext, EditorInputsContext } from '@editor-platform/editor-ui';
import type { HostContent } from './model';

/**
 * The building Surface inside the reference artifact Host. The Host's ArtifactEditor is the only
 * session: each edit is one Host command, so permission, validation, history, save and close
 * keep their Host semantics. A field draft that was refused or is invalid stays in its field:
 * the Host's input boundary flushes it first, so save, close and Host Undo refuse until it is
 * confirmed or cancelled.
 * Undo/Redo stay with the Host: its toolbar, and Ctrl/Cmd+Z on the Surface through the same
 * guarded methods. The kernel runs in its own Worker with the Host's build (the CAD build).
 */
export default function BimArtifactView({
  host,
  kernel,
  onError,
}: {
  host: ArtifactEditor<HostContent>;
  kernel: CadCatalogBuild | null;
  onError(error: unknown): void;
}) {
  const binding = useMemo(() => {
    const session: BimSession = {
      get content() {
        return host.content as BimDocument;
      },
      execute: (cmd) => host.execute(cmd as EditorCommand<HostContent>) as BimDocument,
    };
    const worker = new WorkerBimKernel({
      spawn: () => new KernelWorker() as never,
      build: kernel ?? undefined,
    });
    let readOnly = host.readOnly;
    let applied = canonicalJson(host.revision);
    const controller = new BimController({
      session,
      kernel: worker,
      canEdit: () => !host.readOnly,
      onApplied: () => (applied = canonicalJson(host.revision)),
    });
    // Host notifications: a permission change refreshes the Surface; a revision this view did
    // not apply (Host Undo/Redo, import) is shown and evaluated.
    const observe = () => {
      if (readOnly !== host.readOnly) {
        readOnly = host.readOnly;
        controller.accessChanged();
      }
      const revision = canonicalJson(host.revision);
      if (revision !== applied) {
        applied = revision;
        controller.sync();
      }
    };
    const inputs = new EditorInputs();
    const dispose = () => {
      controller.dispose();
      worker.dispose();
    };
    return { controller, inputs, observe, dispose };
  }, [host, kernel]);
  useEffect(() => {
    const detach = host.attach(binding.observe);
    const release = host.registerInputBoundary(() => binding.inputs.flush());
    return () => {
      release();
      detach();
      binding.dispose();
    };
  }, [host, binding]);
  const history = useMemo(() => {
    const guarded = (action: () => unknown) => () => {
      // Like the disabled toolbar buttons: no history in view mode.
      if (host.readOnly) return;
      try {
        action();
      } catch (error) {
        onError(error);
      }
    };
    return { undo: guarded(() => host.undo()), redo: guarded(() => host.redo()) };
  }, [host, onError]);
  return (
    <EditorInputsContext.Provider value={binding.inputs}>
      <EditorHistoryContext.Provider value={history}>
        <BimSurface
          controller={binding.controller}
          hostHistory
          name={host.artifact.name}
          ifc={() => ({ artifactId: host.artifact.id, timeStamp: host.artifact.draft.updatedAt })}
        />
      </EditorHistoryContext.Provider>
    </EditorInputsContext.Provider>
  );
}
