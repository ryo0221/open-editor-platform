import { useEffect, useMemo, useRef } from 'react';
import { canonicalJson } from '@editor-platform/artifact-core';
import { PcbController, PcbSurface, WorkerPcbKernel } from '@editor-platform/pcb';
import '@editor-platform/pcb/style.css';
import KernelWorker from '@editor-platform/pcb/worker?worker';
import type { PcbDocument } from '@editor-platform/pcb-core';
import type { EditorInputs, EditorSession } from '@editor-platform/editor-core';
import { cadKernel, type StoredArtifact } from '../model';
import { createPcbBoardSource, createPcbSchematicSource } from './boards';

/**
 * Playground binding for the circuit board Surface (PB1). An edit is one session command applied
 * at once; the Host saves the draft afterwards and owns Undo/Redo. The 3D view (PB7b) runs the
 * shared geometry kernel in its own Worker with the Host's kernel build, started on first use.
 */
export default function PcbHost({
  artifact,
  session,
  readOnly,
  inputs,
  persist,
  records,
}: {
  artifact: StoredArtifact;
  session: EditorSession<PcbDocument>;
  readOnly: boolean;
  inputs: EditorInputs;
  persist(content: PcbDocument): void;
  /** Every stored record: the other boards to stack (PB8) and the schematics to send (SL3). */
  records(): StoredArtifact[];
}) {
  const recordsRef = useRef(records);
  recordsRef.current = records;
  const boards = useMemo(
    () => createPcbBoardSource({ records: () => recordsRef.current(), self: artifact.id }),
    [artifact.id],
  );
  const schematics = useMemo(
    () => createPcbSchematicSource({ records: () => recordsRef.current() }),
    [],
  );
  const access = useRef(readOnly);
  access.current = readOnly;
  const persistRef = useRef(persist);
  persistRef.current = persist;
  const applied = useRef<string | undefined>(undefined);
  const controller = useMemo(
    () =>
      new PcbController({
        session,
        canEdit: () => !access.current,
        onApplied: (content) => {
          applied.current = canonicalJson(session.revision);
          persistRef.current(content);
        },
      }),
    // One controller per artifact: the Surface is keyed by it (editor-surfaces).
    [session],
  );
  const kernel = useMemo(
    () =>
      new WorkerPcbKernel({
        spawn: () => new KernelWorker() as never,
        build: cadKernel ?? undefined,
      }),
    [session],
  );
  useEffect(() => () => kernel.dispose(), [kernel]);
  useEffect(() => controller.accessChanged(), [controller, readOnly]);
  // Edits apply at once, so nothing is pending for the Host's export and switch boundaries.
  useEffect(
    () =>
      inputs.register({
        label: 'Circuit board',
        read: () => ({ dirty: false, composing: false }),
        prepare: () => () => {},
        focus: () => {},
      }),
    [inputs],
  );
  // Host Undo/Redo or restore changed the session: show it.
  const revision = canonicalJson(session.revision);
  useEffect(() => {
    if (revision !== applied.current) controller.sync();
  }, [controller, revision]);
  return (
    <PcbSurface
      controller={controller}
      hostHistory
      name={artifact.name}
      kernel={kernel}
      boards={boards}
      schematics={schematics}
    />
  );
}
