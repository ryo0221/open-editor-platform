import { useCallback, useEffect, useMemo, useRef } from 'react';
import { canonicalJson } from '@editor-platform/artifact-core';
import { CadSurface, cadInputState, createCadBinding } from '@editor-platform/cad';
import '@editor-platform/cad/style.css';
import type { CadDocument } from '@editor-platform/cad-core';
import KernelWorker from '@editor-platform/cad-kernel-occt/worker?worker';
import type { EditorInputs, EditorSession } from '@editor-platform/editor-core';
import { EditorExportGuardContext } from '@editor-platform/editor-ui';
import { cadKernel, cadKernels, downloadBlob, type StoredArtifact } from '../model';
import { cadNativeCounter, type CadSizeReceipt } from './native-size';
import { createCadPartSource, createCadPartStore } from './parts';
import { createCadAssetStore } from './resources';

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
  record,
  persistRecord,
  records,
  openArtifact,
}: {
  artifact: StoredArtifact;
  session: EditorSession<CadDocument>;
  readOnly: boolean;
  inputs: EditorInputs;
  persist(content: CadDocument): void;
  /** The latest stored record, which holds the CAD asset bytes (D2). */
  record(): StoredArtifact | undefined;
  /** Saves a record; resolves false when local storage refused it. */
  persistRecord(record: StoredArtifact): Promise<boolean>;
  /** Every local record: the saved versions of other CAD Artifacts are the parts (R2b). */
  records(): StoredArtifact[];
  /** Opens another Artifact (a part, to edit it and save a new version). */
  openArtifact(id: string): void;
}) {
  const access = useRef({ readOnly, generation: 0 });
  if (access.current.readOnly !== readOnly)
    access.current = { readOnly, generation: access.current.generation + 1 };
  const persistRef = useRef(persist);
  persistRef.current = persist;
  const applied = useRef<string | undefined>(undefined);
  const storage = useRef({ record, persistRecord, records, openArtifact });
  storage.current = { record, persistRecord, records, openArtifact };
  const binding = useMemo(() => {
    const assets = createCadAssetStore({
      record: () => storage.current.record(),
      persist: (r) => storage.current.persistRecord(r),
    });
    return createCadBinding({
      session,
      build: cadKernel,
      kernels: cadKernels,
      spawnWorker: () => new KernelWorker() as never,
      canEdit: () => !access.current.readOnly,
      permissionGeneration: () => access.current.generation,
      onApplied: (content) => {
        applied.current = canonicalJson(session.revision);
        persistRef.current(content);
      },
      // STEP originals and BRep live in the stored record and travel in its native file.
      assets,
      // R2b: placed part versions are kept in the record too (closure), read from other records.
      parts: createCadPartStore({
        record: () => storage.current.record(),
        persist: (r) => storage.current.persistRecord(r),
        stageAssets: (staged) => assets.stage(staged),
      }),
      partSource: createCadPartSource({
        records: () => storage.current.records(),
        currentId: artifact.id,
        open: (id) => storage.current.openArtifact(id),
      }),
      // Each edit must leave a native file the Playground can import again (CAD23). The latest
      // record already holds a version whose save is still being written.
      admission: {
        prepare: (candidate, hash) => cadNativeCounter.prepare(candidate, hash),
        admit: (receipt, candidate) => {
          const latest = storage.current.record();
          if (!latest) return 'native-size-unavailable';
          return cadNativeCounter.admit(receipt as CadSizeReceipt, candidate, latest) === undefined
            ? undefined
            : 'native-too-large';
        },
      },
    });
    // One binding per artifact: the Surface is keyed by it (editor-surfaces).
  }, [session]);
  const { controller } = binding;
  useEffect(() => () => binding.dispose(), [binding]);
  useEffect(() => controller.accessChanged(), [controller, readOnly]);
  // An edit still evaluating is pending work: export and switch boundaries refuse to capture the
  // draft until it is applied or rejected. A version save and a 3D file export keep the editor
  // open, so they capture the committed content and the edit applies afterwards (ST-28 #6,
  // CAD21). Staging assets refuses all of them.
  useEffect(() => {
    const stop = inputs.register({
      label: '3D CAD',
      read: () => cadInputState(controller, binding.assembly),
      prepare: () => {
        throw new Error(binding.pendingInput());
      },
      focus: () => {},
    });
    const unsubscribe = controller.subscribe(inputs.changed);
    const unsubscribeAssembly = binding.assembly.subscribe(inputs.changed);
    return () => {
      unsubscribe();
      unsubscribeAssembly();
      stop();
    };
  }, [binding, controller, inputs]);
  // Host Undo/Redo or restore changed the session: re-evaluate (own edits are already current).
  const revision = canonicalJson(session.revision);
  useEffect(() => {
    if (revision !== applied.current) void controller.sync();
  }, [controller, revision]);
  // Exports flush the same inputs as the Host's other exports. A file export keeps the editor open
  // and captures the confirmed content while an edit evaluates (CAD21).
  const guardExport = useCallback(
    (options?: { keepEditor?: boolean }) => inputs.flush(options),
    [inputs],
  );
  return (
    <EditorExportGuardContext.Provider value={guardExport}>
      <CadSurface
        controller={controller}
        assembly={binding.assembly}
        hostHistory
        name={artifact.name}
        onExportPng={(png, { background }) =>
          downloadBlob(`${artifact.name}${background ? '' : '-transparent'}.png`, png)
        }
        onExportCsv={(csv, { fileName }) => downloadBlob(fileName, csv)}
      />
    </EditorExportGuardContext.Provider>
  );
}
