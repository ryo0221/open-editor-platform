import { useEditorDraftPort } from '../kinds/editor-draft-port';
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
  type FictionMapContent,
  type FictionMapBase,
  type FictionMapResult,
} from '@editor-platform/fiction-map/model';
import type { SurfaceHost } from '../kinds/surface-host';
import { editedDraft } from '../app/records';
import { playgroundArtifactRefHost } from './artifact-refs';
/** Same Session as the Playground toolbar/history/storage. No second EditorSession. */
export function PlaygroundFictionMap({ host }: { host: SurfaceHost }) {
  const latest = useRef(host);
  latest.current = host;
  const draft = useEditorDraftPort<FictionMapContent>(host);
  const session = host.sessions.current.get(host.active.id);
  const shared = host.sharedSession;
  // The Host pins a native domain at Session creation and validates all commands.
  // This generic narrowing is not the owned snapshot: adopt performs real admission.
  const native = session as unknown as FictionMapSession;
  const revision = draft.revision;
  const base = useMemo(
    () => adoptFictionMapBase(draft),
    [draft, revision.sessionId, revision.sequence],
  );
  function gate() {
    const h = latest.current;
    return (
      !h.readOnly &&
      h.active.id === host.active.id &&
      (shared ? h.sharedSession === shared : h.sessions.current.get(h.active.id) === session)
    );
  }
  function publish(result: FictionMapResult<FictionMapBase & { changed: boolean }>) {
    if (!shared && result.ok && result.value.changed) {
      const h = latest.current,
        a = h.recordsRef.current.find((a) => a.id === h.active.id)!;
      h.persist(editedDraft(a, result.value.content));
      h.setError('');
    }
    return result;
  }
  const saved = shared ? host.active : host.savedRecords.current.get(host.active.id);
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
  const history = (direction: 'undo' | 'redo') => {
    if (!shared) return publish((direction === 'undo' ? undoFictionMap : redoFictionMap)(native, gate));
    latest.current.history(direction);
    return { ok: true, value: { ...base, changed: false } } as const;
  };
  return (
    <>
      <FictionMapSurface
        base={base}
        readOnly={host.readOnly}
        selected={host.selection.addresses
          .filter((a) => a.artifactId === host.active.id)
          .map((a) => a.elementId)}
        onSelectionChange={(ids) => latest.current.select(ids)}
        canUndo={shared?.canUndo ?? session?.canUndo ?? false}
        canRedo={shared?.canRedo ?? session?.canRedo ?? false}
        onCommit={(prepared) => publish(commitFictionMapChange(draft, prepared, gate))}
        onUndo={() => history('undo')}
        onRedo={() => history('redo')}
        artifactRefs={shared ? undefined : artifactRefs}
      />
      <FictionMapNativeInput
        base={base}
        readOnly={host.readOnly}
        onCommit={(p) => publish(commitFictionMapChange(draft, p, gate))}
        onError={(m) => latest.current.setError(m)}
      />
      <FictionMapSavedViews
        base={base}
        readOnly={host.readOnly}
        onCommit={(p) => publish(commitFictionMapChange(draft, p, gate))}
        onError={(m) => latest.current.setError(m)}
      />
      <FictionMapWorldPanel content={base.content} />
      {saved && (!shared || saved.versions.length > 0) ? (
        <FictionMapOutputPanel
          artifact={
            saved as unknown as import('@editor-platform/artifact-core').Artifact<
              import('@editor-platform/fiction-map/model').FictionMapContent
            >
          }
          beforeOutput={() => {
            latest.current.exportGuard?.();
            if (!latest.current.flushInputs()) throw Error('Apply or cancel pending map input.');
          }}
          isCurrent={() => {
            const h = latest.current,
              p = h.inputs.getSnapshot();
            return (
              h.active.id === host.active.id &&
              h.readOnly === host.readOnly &&
              sameLocalRevision(draft.revision, revision) &&
              !p.dirty &&
              !p.composing
            );
          }}
          onError={(message) => latest.current.setError(message)}
        />
      ) : null}
    </>
  );
}
