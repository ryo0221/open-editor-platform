import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { canonicalJson } from '@editor-platform/artifact-core';
import { EditorInputs, sameLocalRevision } from '@editor-platform/editor-core';
import { FictionMapArtifactSurface } from '@editor-platform/fiction-map/artifact-surface';
import '@editor-platform/fiction-map/styles.css';
import type { CreativeWorkspace } from './model';
import type { CreativeMapLocation } from './map-links';
import { useCreativeNavigationState, type CreativeNavigationState } from '../navigation-state';

export function MapLocationEditor({
  workspace,
  reference,
  editor,
  leave,
  openLocation,
  onNavigationStateChange,
}: {
  onNavigationStateChange?(state: CreativeNavigationState): void;
  workspace: CreativeWorkspace;
  reference: CreativeMapLocation;
  editor: Awaited<ReturnType<CreativeWorkspace['maps']['open']>>;
  leave(check: () => void): Promise<void>;
  openLocation(check: () => void): Promise<void>;
}) {
  const inputs = useMemo(() => new EditorInputs(), [editor]);
  const inputState = useSyncExternalStore(inputs.subscribe, inputs.getSnapshot, inputs.getSnapshot);
  const [, refresh] = useReducer((n) => n + 1, 0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const readable =
    workspace.canReadWorld(editor.id) &&
    workspace.canReadWorld(reference.source.artifactId) &&
    workspace.canReadMode('setting');
  // Detach the private DOM before paint on revocation. Keeping this portal mounted
  // retains native pending inputs and their registered leave/reload guards; no
  // unauthorized canvas, thumbnail or input is left in the visible document.
  const privateSurface = useMemo(() => document.createElement('div'), [editor]);
  const surfaceMount = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (readable) surfaceMount.current?.append(privateSurface);
    else privateSurface.remove();
    return () => privateSurface.remove();
  }, [readable, privateSurface]);
  useEffect(() => editor.attach(refresh), [editor]);
  const dirty =
    editor.snapshot.dirty || !!inputState.dirty || !!inputState.composing || !!inputState.settling;
  useCreativeNavigationState(
    { dirty, busy: busy || editor.snapshot.saving },
    onNavigationStateChange,
  );
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
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const navigate = (action: (check: () => void) => Promise<void>) =>
    run(async () => {
      const revision = editor.revision;
      const selection = canonicalJson(editor.snapshot.selection);
      const check = () => {
        editor.flushInputs();
        if (
          editor.snapshot.dirty ||
          !sameLocalRevision(revision, editor.revision) ||
          selection !== canonicalJson(editor.snapshot.selection)
        )
          throw Error('地図を保存してから戻ってください。未保存編集は保持しています。');
      };
      check();
      await action(check);
    });
  return (
    <div className="world-source map-location-editor">
      <header>
        <h1>地図 · {readable ? editor.artifact.name : '閲覧権限がありません'}</h1>
        <p>現在の編集用draftです。地図を保存しても、場所・他Sceneの採用版は更新しません。</p>
        <button
          disabled={busy || !readable || editor.readOnly}
          onClick={() => void run(() => workspace.maps.saveSource(editor))}
        >
          地図nativeを保存
        </button>
        <button disabled={busy} onClick={() => void navigate(leave)}>
          地図から元の制作へ戻る
        </button>
        <button disabled={busy || !readable} onClick={() => void navigate(openLocation)}>
          この場所の設定画へ
        </button>
        <p role="status">
          {editor.snapshot.dirty ? '地図nativeに未保存の変更' : '地図nativeは保存済み'} ·
          採用版は別途明示更新
        </p>
      </header>
      {error && <p role="alert">{error}</p>}
      {!readable && (
        <p role="alert">
          forbidden：地図・場所の現在権限を確認してください。本文・地図画像を表示しません。
        </p>
      )}
      <div className="production-surface" ref={surfaceMount} />
      {createPortal(
        <FictionMapArtifactSurface
          host={editor}
          inputs={inputs}
          onError={setError}
          mayRead={() =>
            workspace.canReadWorld(editor.id) &&
            workspace.canReadWorld(reference.source.artifactId) &&
            workspace.canReadMode('setting')
          }
        />,
        privateSurface,
      )}
    </div>
  );
}
