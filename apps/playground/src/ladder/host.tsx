import { useEffect, useMemo, useRef } from 'react';
import { canonicalJson } from '@editor-platform/artifact-core';
import { LadderController, LadderSurface } from '@editor-platform/ladder';
import '@editor-platform/ladder/style.css';
import type { LadderDocument } from '@editor-platform/ladder-core';
import type { EditorInputs, EditorSession } from '@editor-platform/editor-core';
import type { StoredArtifact } from '../model';

/**
 * Playground binding for the ladder Surface (SL7c). An edit is one session command applied at
 * once; the Host saves the draft afterwards and owns Undo/Redo.
 */
export default function LadderHost({
  artifact,
  session,
  readOnly,
  inputs,
  persist,
}: {
  artifact: StoredArtifact;
  session: EditorSession<LadderDocument>;
  readOnly: boolean;
  inputs: EditorInputs;
  persist(content: LadderDocument): void;
}) {
  const access = useRef(readOnly);
  access.current = readOnly;
  const persistRef = useRef(persist);
  persistRef.current = persist;
  const applied = useRef<string | undefined>(undefined);
  const controller = useMemo(
    () =>
      new LadderController({
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
  useEffect(() => controller.accessChanged(), [controller, readOnly]);
  // Edits apply at once, so nothing is pending for the Host's export and switch boundaries.
  useEffect(
    () =>
      inputs.register({
        label: 'Ladder',
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
  return <LadderSurface controller={controller} hostHistory name={artifact.name} />;
}
