import { useCallback, useEffect, useMemo, useReducer, useState, useSyncExternalStore } from 'react';
import { EditorInputs, type Region } from '@editor-platform/editor-core';
import {
  EditorInputsContext,
  EditorHistoryContext,
  EditorExportGuardContext,
} from '@editor-platform/editor-ui';
import { DocumentSurface } from '@editor-platform/document';
import type { DocumentContent } from '@editor-platform/document/model';
import { DesignSurface } from '@editor-platform/design';
import { guardDesignCommand, type DesignContent } from '@editor-platform/design/model';
import type { CreativeWorkspace } from './model';
import type { WorldReference } from './world-context';

export function WorldSourceEditor({
  workspace,
  editor,
  reference,
  leave,
}: {
  workspace: CreativeWorkspace;
  editor: Awaited<ReturnType<CreativeWorkspace['openWorldSource']>>;
  reference: WorldReference;
  leave(): Promise<void>;
}) {
  const [, refresh] = useReducer((n) => n + 1, 0);
  const [inputs] = useState(() => new EditorInputs());
  const state = useSyncExternalStore(inputs.subscribe, inputs.getSnapshot, inputs.getSnapshot);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const readable = workspace.canReadWorld(editor.id);
  useEffect(() => {
    const release = [editor.attach(refresh), editor.registerInputBoundary(() => inputs.flush())];
    return () => release.forEach((f) => f());
  }, [editor, inputs]);
  const focusAddress = useMemo(
    () =>
      reference.selector.type === 'document-blocks'
        ? { artifactId: editor.id, elementId: reference.selector.blockIds[0] }
        : undefined,
    [editor, reference],
  );
  const focusRequest = useMemo(
    () =>
      reference.selector.type === 'design-frame' ? { id: reference.selector.frameId } : undefined,
    [reference],
  );
  const select = useCallback(
    (ids: string | string[], region?: Region) =>
      editor.select({
        addresses: (typeof ids === 'string' ? [ids] : ids).map((elementId) => ({
          artifactId: editor.id,
          elementId,
          ...(region ? { region } : {}),
        })),
      }),
    [editor],
  );
  const dirty = editor.snapshot.dirty || state.dirty || state.composing || state.settling;
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const run = (action: () => void) => {
    try {
      if (busy || !readable) throw Error('資料の操作が許可されていません。');
      action();
      setError('');
      refresh();
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  };
  const history = (redo = false) =>
    run(() => {
      if (inputs.history(redo ? 'redo' : 'undo')) return;
      inputs.flush();
      if (redo) editor.redo();
      else editor.undo();
    });
  return (
    <div className="world-source">
      <header>
        <h1>元資料 · {readable ? editor.artifact.name : '閲覧権限がありません'}</h1>
        <p>現在の編集用draftです。保存しても作品の採用版は変更しません。</p>
        <button
          disabled={busy || editor.readOnly || !readable}
          onClick={async () => {
            setBusy(true);
            try {
              inputs.flush();
              await workspace.saveWorldSource(editor.id);
              setError('');
            } catch (e) {
              fail(e);
            } finally {
              setBusy(false);
              refresh();
            }
          }}
        >
          元資料を保存
        </button>
        <button
          disabled={busy || !editor.canUndo || editor.readOnly || !readable}
          onClick={() => history()}
        >
          元資料を元に戻す
        </button>
        <button
          disabled={busy || !editor.canRedo || editor.readOnly || !readable}
          onClick={() => history(true)}
        >
          元資料をやり直す
        </button>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              inputs.flush();
              if (editor.snapshot.dirty) throw Error('元資料を保存してから制作へ戻ってください。');
              await leave();
            } catch (e) {
              fail(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          元の制作へ戻る
        </button>
        <p role="status">
          {busy ? '保存・確認中…' : dirty ? '元資料に未保存の変更' : '元資料は保存済み'} ·
          採用版は別途明示更新
        </p>
      </header>
      {error && <p role="alert">{error}</p>}
      {!readable ? (
        <p role="alert">forbidden：閲覧権限を確認してください。本文と見本は表示しません。</p>
      ) : (
        <div className="production-surface">
          <EditorInputsContext.Provider value={inputs}>
            <EditorExportGuardContext.Provider value={() => inputs.flush()}>
              <EditorHistoryContext.Provider
                value={{
                  undo: () => {
                    history();
                  },
                  redo: () => {
                    history(true);
                  },
                }}
              >
                {reference.selector.type === 'document-blocks' ? (
                  <DocumentSurface
                    content={editor.content as DocumentContent}
                    focusAddress={focusAddress}
                    select={select}
                    execute={(cmd) =>
                      run(() => {
                        editor.execute(cmd as never);
                      })
                    }
                    readOnly={editor.readOnly || busy}
                    layout={{ viewKey: 'cw1-source-document', defaultPanels: { right: false } }}
                  />
                ) : (
                  <DesignSurface
                    content={editor.content as DesignContent}
                    focusRequest={focusRequest}
                    select={select}
                    execute={(cmd) =>
                      run(() => {
                        editor.execute(guardDesignCommand(cmd) as never);
                      })
                    }
                    readOnly={editor.readOnly || busy}
                    inkInput
                    layout={{ viewKey: 'cw1-source-design', defaultPanels: { right: false } }}
                  />
                )}
              </EditorHistoryContext.Provider>
            </EditorExportGuardContext.Provider>
          </EditorInputsContext.Provider>
        </div>
      )}
    </div>
  );
}
