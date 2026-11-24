import { useMemo, useRef } from 'react';
import type { EditorCommand, EditorSession, LocalDraftRevision } from '@editor-platform/editor-core';
import type { Content } from '../model';
import type { SurfaceHost } from './surface-host';

export type EditorDraftPort<T> = Pick<EditorSession<T>, 'content' | 'revision' | 'execute'>;

/** Bind prepared native UI input to its current projected draft. Shared history stays on the Host. */
export function useEditorDraftPort<T extends Content>(host: SurfaceHost): EditorDraftPort<T> {
  const latest = useRef(host);
  latest.current = host;
  const shared = host.sharedSession;
  const local = host.sessions.current.get(host.active.id);
  return useMemo(() => {
    if (!shared) return local as unknown as EditorDraftPort<T>;
    let basis: Content | undefined;
    let revision: LocalDraftRevision = {
      kind: 'local-draft',
      sessionId: shared.adapter.identity.sessionId,
      sequence: 0,
    };
    return {
      get content() {
        return shared.viewContent as T;
      },
      get revision() {
        const next = shared.viewContent;
        if (basis !== next) {
          basis = next;
          revision = { ...revision, sequence: revision.sequence + 1 };
        }
        return revision;
      },
      execute(command: EditorCommand<T>) {
        if (latest.current.sharedSession !== shared || !latest.current.execute(command))
          throw Error('共同編集の変更を適用できませんでした。');
        return shared.viewContent as T;
      },
    };
  }, [local, shared]);
}
