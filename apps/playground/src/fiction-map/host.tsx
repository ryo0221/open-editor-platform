import { FictionMapNativeInput } from '@editor-platform/fiction-map/native-input';
import { FictionMapSavedViews } from '@editor-platform/fiction-map/saved-views';
import { FictionMapWorldPanel } from '@editor-platform/fiction-map/world-panel';
import { FictionMapOutputPanel } from '@editor-platform/fiction-map/output-panel';
import { sameLocalRevision } from '@editor-platform/editor-core';
import { useMemo, useRef } from 'react';
import { FictionMapSurface } from '@editor-platform/fiction-map/surface';
import '@editor-platform/fiction-map/styles.css';
import { adoptFictionMapBase } from '@editor-platform/fiction-map/host';
import {
  commitFictionMapChange,
  undoFictionMap,
  redoFictionMap,
  type FictionMapSession,
  type FictionMapBase,
  type FictionMapResult,
} from '@editor-platform/fiction-map/model';
import type { SurfaceHost } from '../app/editor-surfaces';
import { editedDraft } from '../app/records';
import { playgroundArtifactRefHost } from './artifact-refs';
/** Same Session as the Playground toolbar/history/storage. No second EditorSession. */
export function PlaygroundFictionMap({ host }: { host: SurfaceHost }) {
  const latest = useRef(host);
  latest.current = host;
  const session = host.sessions.current.get(host.active.id)!;
  // The Host pins a native domain at Session creation and validates all commands.
  // This generic narrowing is not the owned snapshot: adopt performs real admission.
  const native = session as unknown as FictionMapSession;
  const revision = session.revision;
  const base = useMemo(
    () => adoptFictionMapBase(native),
    [session, revision.sessionId, revision.sequence],
  );
  function gate() {
    const h = latest.current;
    return (
      !h.readOnly &&
      !h.shared &&
      h.active.id === host.active.id &&
      h.sessions.current.get(h.active.id) === session
    );
  }
  function publish(result: FictionMapResult<FictionMapBase & { changed: boolean }>) {
    if (result.ok && result.value.changed) {
      const h = latest.current,
        a = h.recordsRef.current.find((a) => a.id === h.active.id)!;
      h.persist(editedDraft(a, result.value.content));
      h.setError('');
    }
    return result;
  }
  const saved = host.savedRecords.current.get(host.active.id);
  const artifactRefs = useMemo(
    () =>
      playgroundArtifactRefHost({
        mapId: host.active.id,
        saved: () => latest.current.savedRecords.current,
        activate: (id) => latest.current.activate(id),
        setStatus: (m) => latest.current.setStatus(m),
      }),
    [host.active.id],
  );
  return (
    <>
      <FictionMapSurface
        base={base}
        readOnly={host.readOnly}
        selected={host.selection.addresses
          .filter((a) => a.artifactId === host.active.id)
          .map((a) => a.elementId)}
        onSelectionChange={(ids) => latest.current.select(ids)}
        canUndo={session.canUndo}
        canRedo={session.canRedo}
        onCommit={(prepared) => publish(commitFictionMapChange(native, prepared, gate))}
        onUndo={() => publish(undoFictionMap(native, gate))}
        onRedo={() => publish(redoFictionMap(native, gate))}
        artifactRefs={artifactRefs}
      />
      <FictionMapNativeInput
        base={base}
        readOnly={host.readOnly}
        onCommit={(p) => publish(commitFictionMapChange(native, p, gate))}
        onError={(m) => latest.current.setError(m)}
      />
      <FictionMapSavedViews
        base={base}
        readOnly={host.readOnly}
        onCommit={(p) => publish(commitFictionMapChange(native, p, gate))}
        onError={(m) => latest.current.setError(m)}
      />
      <FictionMapWorldPanel content={base.content} />
      {saved && (
        <FictionMapOutputPanel
          artifact={
            saved as unknown as import('@editor-platform/artifact-core').Artifact<
              import('@editor-platform/fiction-map/model').FictionMapContent
            >
          }
          beforeOutput={() => {
            if (!latest.current.flushInputs()) throw Error('Apply or cancel pending map input.');
          }}
          isCurrent={() => {
            const h = latest.current,
              p = h.inputs.getSnapshot();
            return (
              h.active.id === host.active.id &&
              h.readOnly === host.readOnly &&
              sameLocalRevision(session.revision, revision) &&
              !p.dirty &&
              !p.composing
            );
          }}
          onError={(message) => latest.current.setError(message)}
        />
      )}
    </>
  );
}
