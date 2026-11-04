import { FictionMapNativeInput } from './native-input';
import { FictionMapSavedViews } from './saved-views';
import { FictionMapWorldPanel } from './world-panel';
import { useEffect, useMemo, useReducer, useRef } from 'react';
import type { ArtifactEditor } from '@editor-platform/editor-host';
import { EditorInputs, sameLocalRevision } from '@editor-platform/editor-core';
import { EditorInputsContext } from '@editor-platform/editor-ui';
import { adoptFictionMapBase } from './host';
import {
  commitFictionMapChange,
  undoFictionMap,
  redoFictionMap,
  type FictionMapContent,
} from './model';
import { FictionMapSurface } from './surface';
import { FictionMapOutputPanel } from './output-panel';
/** Public Artifact Host adapter over the existing ArtifactEditor Session, never a second Session. */
export function FictionMapArtifactSurface({
  host,
  onError = () => {},
  mayRead = () => true,
}: {
  host: ArtifactEditor<FictionMapContent>;
  onError?: (message: string) => void;
  /** Live read grant for asynchronous output; the Host also masks unauthorized DOM. */
  mayRead?(): boolean;
}) {
  const [, refresh] = useReducer((n) => n + 1, 0),
    inputs = useMemo(() => new EditorInputs(), [host]),
    alive = useRef(true);
  const readGrant = useRef(mayRead);
  readGrant.current = mayRead;
  const allowed = mayRead();
  const access = useRef({ allowed, generation: 0 });
  if (access.current.allowed !== allowed)
    access.current = { allowed, generation: access.current.generation + 1 };
  const accessGeneration = access.current.generation;
  useEffect(() => {
    alive.current = true;
    const off = host.attach(refresh),
      unregister = host.registerInputBoundary(() => inputs.flush());
    return () => {
      alive.current = false;
      off();
      unregister();
    };
  }, [host, inputs]);
  const revision = host.revision,
    base = useMemo(() => adoptFictionMapBase(host), [host, revision.sessionId, revision.sequence]),
    readOnly = host.readOnly;
  const selected = host.snapshot.selection.addresses.map((a) => a.elementId);
  return (
    <EditorInputsContext.Provider value={inputs}>
      <div className="fm-artifact">
        <FictionMapSurface
          base={base}
          readOnly={readOnly}
          selected={selected}
          onSelectionChange={(ids) =>
            host.select({ addresses: ids.map((elementId) => ({ artifactId: host.id, elementId })) })
          }
          canUndo={host.canUndo}
          canRedo={host.canRedo}
          onCommit={(p) => commitFictionMapChange(host, p, () => !host.readOnly)}
          onUndo={() => undoFictionMap(host, () => !host.readOnly)}
          onRedo={() => redoFictionMap(host, () => !host.readOnly)}
        />
        <FictionMapNativeInput
          base={base}
          readOnly={readOnly}
          onCommit={(p) => commitFictionMapChange(host, p, () => !host.readOnly)}
          onError={onError}
        />
        <FictionMapSavedViews
          base={base}
          readOnly={readOnly}
          onCommit={(p) => commitFictionMapChange(host, p, () => !host.readOnly)}
          onError={onError}
        />
        <FictionMapWorldPanel content={base.content} />
        <FictionMapOutputPanel
          artifact={host.artifact}
          beforeOutput={() => host.flushInputs()}
          isCurrent={() => {
            const p = inputs.getSnapshot();
            return (
              alive.current &&
              readGrant.current() &&
              access.current.generation === accessGeneration &&
              sameLocalRevision(host.revision, revision) &&
              host.readOnly === readOnly &&
              !p.dirty &&
              !p.composing
            );
          }}
          onError={onError}
        />
      </div>
    </EditorInputsContext.Provider>
  );
}
