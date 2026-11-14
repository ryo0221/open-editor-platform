import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WorkerBimKernel } from '@editor-platform/bim';
import KernelWorker from '@editor-platform/bim/worker?worker';
import { bimContentHash } from '@editor-platform/bim-core';
import computeHost from 'virtual:simulation-compute-host';
import { ConstructionSurface, type FrameSolver } from '@editor-platform/construction';
import '@editor-platform/construction/style.css';
import {
  constructionContentHash,
  constructionEditorCommand,
  type ConstructionDocument,
  type ConstructionOperation,
} from '@editor-platform/construction-core';
import type {
  EditorInputBoundary,
  EditorInputs,
  EditorSession,
} from '@editor-platform/editor-core';
import { cadKernel, type StoredArtifact } from '../model';
import {
  constructionSourceOf,
  constructionVersionChoices,
  stageConstructionSource,
} from './source';

/**
 * CS4b: the frame of a construction stage is solved on the Reference Host (CalculiX) when the
 * dev server has one; the solver is loaded only when a frame is sent.
 */
function hostSolver(host: NonNullable<typeof computeHost>): FrameSolver {
  return {
    label: host.label,
    destination: host.destination,
    solve: async (frame, signal) =>
      (await import('@editor-platform/simulation')).solveFrameOnHost(host, frame, { signal }),
  };
}
const frameSolver = computeHost ? hostSolver(computeHost) : undefined;

/**
 * CS1b: Playground binding for the construction schedule Surface. An edit is one session command
 * applied at once; the Host saves the draft afterwards and owns Undo/Redo. The scheduled BIM
 * version is kept in the record and evaluated by its own BIM kernel Worker (the Host's build).
 */
export default function ConstructionHost({
  session,
  readOnly,
  inputs,
  record,
  records,
  persist,
  persistRecord,
}: {
  session: EditorSession<ConstructionDocument>;
  readOnly: boolean;
  inputs: EditorInputs;
  record(): StoredArtifact | undefined;
  /** Every stored record: names the scheduled Building Artifact and its other versions. */
  records(): StoredArtifact[];
  persist(content: ConstructionDocument): void;
  /** Saves the whole record (a new source version is kept before the edit names it). */
  persistRecord(record: StoredArtifact): Promise<boolean>;
}) {
  // Re-read on every session revision (Host Undo/Redo, restore).
  const [, setTick] = useState(0);
  const doc = session.content;
  const bim = constructionSourceOf(record(), doc);
  const building = records().find((r) => r.id === doc.source.artifactId);
  const at = building?.versions.findIndex((v) => v.versionId === doc.source.versionId) ?? -1;
  const sourceLabel =
    building && at >= 0 ? `${building.name} · v${at + 1}` : 'A saved Building version';
  const kernel = useMemo(
    () =>
      cadKernel
        ? new WorkerBimKernel({ spawn: () => new KernelWorker() as never, build: cadKernel })
        : undefined,
    [],
  );
  useEffect(() => () => kernel?.dispose(), [kernel]);
  // The task and calendar forms report unsaved changes to the Host's save/export/switch boundary.
  const registerInput = useCallback(
    (boundary: EditorInputBoundary) => inputs.register(boundary),
    [inputs],
  );
  // Read at the commit, so an edit that resumes after an await sees the current permission.
  const readOnlyNow = useRef(readOnly);
  readOnlyNow.current = readOnly;
  const apply = (ops: ConstructionOperation | ConstructionOperation[]) => {
    try {
      session.execute(
        constructionEditorCommand(ops, {
          expectedHash: constructionContentHash(session.content),
          canEdit: () => !readOnlyNow.current,
        }),
      );
      persist(session.content);
      setTick((n) => n + 1);
      return undefined;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  const choices = building ? constructionVersionChoices([building], doc) : [];
  const switchVersion = async (versionId: string) => {
    const choice = choices.find((c) => c.versionId === versionId);
    const latest = record();
    if (!choice || !latest) return 'The version is no longer available.';
    if (readOnlyNow.current) return 'The schedule is read only.';
    // Kept first, so the edit that names it is never saved without it.
    if (!(await persistRecord(stageConstructionSource(latest, choice.content))))
      return 'The version could not be kept with the schedule.';
    return apply({
      type: 'setSource',
      source: {
        artifactId: choice.artifactId,
        versionId: choice.versionId,
        contentHash: bimContentHash(choice.content),
      },
    });
  };
  return (
    <ConstructionSurface
      doc={doc}
      bim={bim}
      sourceLabel={sourceLabel}
      kernel={kernel}
      readOnly={readOnly}
      apply={apply}
      versions={choices.map((c) => ({
        versionId: c.versionId,
        label: c.label,
      }))}
      switchVersion={switchVersion}
      registerInput={registerInput}
      inputsChanged={inputs.changed}
      frameSolver={frameSolver}
      artifactId={record()?.id}
    />
  );
}
