import { useEffect, useMemo, useRef } from 'react';
import { canonicalJson } from '@editor-platform/artifact-core';
import { BimController, BimSurface, WorkerBimKernel } from '@editor-platform/bim';
import '@editor-platform/bim/style.css';
import KernelWorker from '@editor-platform/bim/worker?worker';
import type { BimDocument } from '@editor-platform/bim-core';
import { WorkerKernelPort } from '@editor-platform/cad-kernel-occt';
import CadKernelWorker from '@editor-platform/cad-kernel-occt/worker?worker';
import type { EditorInputs, EditorSession } from '@editor-platform/editor-core';
import { cadKernel, type StoredArtifact } from '../model';
import { createBimPartSource, type BimPartKernel } from './parts';

/**
 * Playground binding for the building Surface. An edit is one session command applied at once;
 * the Host saves the draft afterwards and owns Undo/Redo. The kernel runs in its own Worker with
 * the Host's kernel build (the same build as 3D CAD). Parts are saved versions of the
 * Playground's 3D CAD Artifacts: their shapes come from a CAD kernel Worker started on first
 * use, and each placed version is kept in the building's record.
 */
export default function BimHost({
  artifact,
  session,
  readOnly,
  inputs,
  persist,
  record,
  persistRecord,
  records,
}: {
  artifact: StoredArtifact;
  session: EditorSession<BimDocument>;
  readOnly: boolean;
  inputs: EditorInputs;
  persist(content: BimDocument): void;
  /** The latest stored record of this building, and its whole-record save. */
  record(): StoredArtifact | undefined;
  persistRecord(record: StoredArtifact): Promise<boolean>;
  /** Every stored record: the 3D CAD Artifacts whose versions can be placed. */
  records(): StoredArtifact[];
}) {
  const access = useRef(readOnly);
  access.current = readOnly;
  const persistRef = useRef(persist);
  persistRef.current = persist;
  const applied = useRef<string | undefined>(undefined);
  const storage = useRef({ record, persistRecord, records });
  storage.current = { record, persistRecord, records };
  const { controller, kernel, parts } = useMemo(() => {
    const kernel = new WorkerBimKernel({
      spawn: () => new KernelWorker() as never,
      build: cadKernel ?? undefined,
    });
    const parts = cadKernel ? partKernel(cadKernel) : undefined;
    const controller = new BimController({
      session,
      kernel,
      parts: createBimPartSource({
        records: () => storage.current.records(),
        record: () => storage.current.record(),
        persist: (r) => storage.current.persistRecord(r),
        kernel: parts,
      }),
      canEdit: () => !access.current,
      onApplied: (content) => {
        applied.current = canonicalJson(session.revision);
        persistRef.current(content);
      },
    });
    return { controller, kernel, parts };
    // One controller per artifact: the Surface is keyed by it (editor-surfaces).
  }, [session]);
  useEffect(
    () => () => {
      controller.dispose();
      kernel.dispose();
      parts?.dispose();
    },
    [controller, kernel, parts],
  );
  useEffect(() => controller.accessChanged(), [controller, readOnly]);
  // Edits apply at once, so nothing is pending for the Host's export and switch boundaries.
  useEffect(
    () =>
      inputs.register({
        label: 'Building',
        read: () => ({ dirty: false, composing: false }),
        prepare: () => () => {},
        focus: () => {},
      }),
    [inputs],
  );
  // Host Undo/Redo or restore changed the session: show and evaluate it.
  const revision = canonicalJson(session.revision);
  useEffect(() => {
    if (revision !== applied.current) controller.sync();
  }, [controller, revision]);
  return (
    <BimSurface
      controller={controller}
      hostHistory
      name={artifact.name}
      ifc={() => ({
        artifactId: artifact.id,
        // The time of the content the file holds: the stored draft's.
        timeStamp: (storage.current.record() ?? artifact).draft.updatedAt,
      })}
    />
  );
}

/** A CAD kernel Worker for part shapes, started on first use; one export at a time. */
function partKernel(build: NonNullable<typeof cadKernel>): BimPartKernel & { dispose(): void } {
  let port: WorkerKernelPort | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let n = 0;
  return {
    buildHash: build.buildHash,
    exportBrep(document, contentHash) {
      port ??= new WorkerKernelPort({ spawn: () => new CadKernelWorker() as never, build });
      const p = port;
      // The port's export slot keeps only the newest waiting export: send them one by one.
      const job = queue.then(async () => {
        const { evaluation, brep } = await p.exportBrep({
          requestId: `bim-part-${++n}`,
          generation: n,
          baseHash: '',
          candidateHash: contentHash,
          document,
        });
        if (evaluation.status !== 'ok') throw new Error(evaluation.code);
        if (!brep) throw new Error('brep-unavailable');
        return brep;
      });
      queue = job.catch(() => undefined);
      return job;
    },
    dispose: () => port?.dispose(),
  };
}
