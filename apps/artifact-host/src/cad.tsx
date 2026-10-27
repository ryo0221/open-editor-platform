import { useEffect, useMemo } from 'react';
import { canonicalJson } from '@editor-platform/artifact-core';
import { CadSurface, createCadBinding } from '@editor-platform/cad';
import '@editor-platform/cad/style.css';
import type { CadDocument, CadSession } from '@editor-platform/cad-core';
import type { CadCatalogBuild, CadKernelCatalog } from '@editor-platform/cad-kernel-occt';
import KernelWorker from '@editor-platform/cad-kernel-occt/worker?worker';
import type { EditorCommand } from '@editor-platform/editor-core';
import type { ArtifactEditor } from '@editor-platform/editor-host';
import { EditorHistoryContext, EditorInputsContext } from '@editor-platform/editor-ui';
import type { HostContent } from './model';

/**
 * CAD inside the reference artifact Host. The Host's ArtifactEditor stays the only session:
 * the controller applies each confirmed edit through it, so permission, validation, history,
 * save and close keep their Host semantics. Undo/Redo stay with the Host: its toolbar, and
 * Ctrl/Cmd+Z on the Surface through the same guarded methods.
 */
export default function CadArtifactView({
  host,
  kernel,
  kernels,
  onError,
}: {
  host: ArtifactEditor<HostContent>;
  kernel: CadCatalogBuild | null;
  kernels?: Omit<CadKernelCatalog, 'current'>;
  onError(error: unknown): void;
}) {
  const binding = useMemo(() => {
    const session: CadSession = {
      get content() {
        return host.content as CadDocument;
      },
      get revision() {
        return host.revision;
      },
      get canUndo() {
        return host.canUndo;
      },
      get canRedo() {
        return host.canRedo;
      },
      execute: (cmd) => host.execute(cmd as EditorCommand<HostContent>) as CadDocument,
      undo: () => host.undo() as CadDocument,
      redo: () => host.redo() as CadDocument,
    };
    let generation = 0;
    let readOnly = host.readOnly;
    let applied = canonicalJson(host.revision);
    const binding = createCadBinding({
      session,
      build: kernel,
      kernels,
      spawnWorker: () => new KernelWorker() as never,
      canEdit: () => !host.readOnly,
      permissionGeneration: () => generation,
      onApplied: () => (applied = canonicalJson(host.revision)),
    });
    // Host notifications: a permission change refreshes the Surface; a revision this view did
    // not apply (Host Undo/Redo, import) re-evaluates.
    const observe = () => {
      if (readOnly !== host.readOnly) {
        readOnly = host.readOnly;
        generation++;
        binding.controller.accessChanged();
      }
      const revision = canonicalJson(host.revision);
      if (revision !== applied) {
        applied = revision;
        void binding.controller.sync();
      }
    };
    return { ...binding, observe };
  }, [host, kernel, kernels]);
  useEffect(() => {
    const detach = host.attach(binding.observe);
    // Save, export, close and Host Undo flush inputs first: field drafts commit or refuse, and
    // an evaluating edit refuses them.
    const release = host.registerInputBoundary(() => binding.flushInputs());
    return () => {
      release();
      detach();
      binding.dispose();
    };
  }, [host, binding]);
  const name = host.artifact.name;
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
        <CadSurface
          controller={binding.controller}
          hostHistory
          name={name}
          onExportPng={(png, { background }) => {
            const url = URL.createObjectURL(png);
            const link = Object.assign(document.createElement('a'), {
              href: url,
              download: background ? `${name}.png` : `${name}-transparent.png`,
            });
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        />
      </EditorHistoryContext.Provider>
    </EditorInputsContext.Provider>
  );
}
