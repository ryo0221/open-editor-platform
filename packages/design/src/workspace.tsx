import {
  EditorHistoryContext,
  useEditorWorkspace,
  type EditorWorkspaceProps,
  type EditorWorkspaceTransition,
} from '@editor-platform/editor-ui';
import { useContext } from 'react';
import type { EditorInputs } from '@editor-platform/editor-core';

export type DesignWorkspace = 'design' | 'manga';
export type DesignWorkspaceTransition = EditorWorkspaceTransition<DesignWorkspace>;
export type DesignWorkspaceProps = EditorWorkspaceProps<DesignWorkspace>;
/** View-only transition. The canvas and input owners remain mounted while pending. */
export function useDesignWorkspace(props: DesignWorkspaceProps, inputs: EditorInputs) {
  const history = useContext(EditorHistoryContext);
  const work = useEditorWorkspace<DesignWorkspace>('design', props, inputs, {
    pointerSelector: '.canvas-stage',
  });
  const { displayed, request } = work;
  return {
    displayed,
    request,
    controls: (
      <div className="manga-workspace-switch" role="group" aria-label="Workspace">
        <button
          type="button"
          aria-pressed={displayed === 'manga'}
          onClick={() => request(displayed === 'manga' ? 'design' : 'manga')}
        >
          {displayed === 'manga' ? 'Designで詳細編集' : '漫画ワークスペース'}
        </button>
        {history && (
          <>
            <button onClick={() => history.undo()} aria-label="元に戻す">
              ↶
            </button>
            <button onClick={() => history.redo()} aria-label="やり直す">
              ↷
            </button>
          </>
        )}
        {work.pending && (
          <>
            <span role="status">{work.reason || '画面を切り替えています'}</span>
            <button onClick={() => request(displayed)}>切替を取り消す</button>
          </>
        )}
      </div>
    ),
    events: work.events,
  };
}
