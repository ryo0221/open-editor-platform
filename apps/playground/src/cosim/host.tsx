import { useEffect, useMemo, useRef } from 'react';
import { canonicalJson } from '@editor-platform/artifact-core';
import { CosimController, CosimSurface } from '@editor-platform/cosim';
import '@editor-platform/cosim/style.css';
import type { CosimDocument } from '@editor-platform/cosim-core';
import '@editor-platform/ladder/style.css';
import '@editor-platform/schematic/style.css';
import type { EditorInputs, EditorSession } from '@editor-platform/editor-core';
import type { StoredArtifact } from '../model';
import { createCosimSources } from './sources';

/**
 * Playground binding for the co-simulation Surface (SL8c). It runs saved versions of the
 * Playground's schematics and ladder programs. An edit is one session command applied at once;
 * the Host saves the draft afterwards and owns Undo/Redo.
 */
export default function CosimHost({
  artifact,
  session,
  readOnly,
  inputs,
  persist,
  records,
}: {
  artifact: StoredArtifact;
  session: EditorSession<CosimDocument>;
  readOnly: boolean;
  inputs: EditorInputs;
  persist(content: CosimDocument): void;
  /** Every stored record: the schematics and ladder programs to run. */
  records(): StoredArtifact[];
}) {
  const recordsRef = useRef(records);
  recordsRef.current = records;
  const access = useRef(readOnly);
  access.current = readOnly;
  const persistRef = useRef(persist);
  persistRef.current = persist;
  const applied = useRef<string | undefined>(undefined);
  const controller = useMemo(
    () =>
      new CosimController({
        session,
        canEdit: () => !access.current,
        sources: createCosimSources(() => recordsRef.current()),
        onApplied: (content) => {
          applied.current = canonicalJson(session.revision);
          persistRef.current(content);
        },
      }),
    // One controller per artifact: the Surface is keyed by it (editor-surfaces).
    [session],
  );
  useEffect(() => controller.accessChanged(), [controller, readOnly]);
  // Edits apply at once, so nothing is pending for the Host's export and switch boundaries.
  useEffect(
    () =>
      inputs.register({
        label: 'Co-simulation',
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
  return <CosimSurface controller={controller} hostHistory name={artifact.name} />;
}
