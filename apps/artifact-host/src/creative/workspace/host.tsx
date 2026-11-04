import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { EditorInputs, type ElementAddress, type Region } from '@editor-platform/editor-core';
import { canonicalJson } from '@editor-platform/artifact-core';
import {
  EditorInputsContext,
  EditorHistoryContext,
  EditorExportGuardContext,
  Section,
} from '@editor-platform/editor-ui';
import { DocumentSurface } from '@editor-platform/document';
import type { DocumentContent } from '@editor-platform/document/model';
import { DesignSurface } from '@editor-platform/design';
import {
  exportDesignSvg,
  guardDesignCommand,
  type DesignContent,
} from '@editor-platform/design/model';
import type { CreativeLayerConnection } from '../generation';
import { CreativeHost } from '../host';
import {
  CreativeWorkspace,
  type CreativeScene,
  type SceneItemReference,
  type ReferenceView,
} from './model';
import { WorldPane, type WorldDrafts } from './world-pane';
import { WorldSourceEditor } from './world-source';
import { MapLocationsPane } from './map-pane';
import { MapLocationEditor } from './map-editor';
import type { CreativeMapLocation } from './map-links';
import type { WorldReference } from './world-context';
import './workspace.css';

function References({
  workspace,
  scene,
  revision,
  open,
  changed,
  fail,
}: {
  workspace: CreativeWorkspace;
  scene: CreativeScene;
  revision: number;
  open(ref: SceneItemReference, artwork?: boolean): void;
  changed(): void;
  fail(e: unknown): void;
}) {
  const [views, setViews] = useState<ReferenceView[]>([]);
  useEffect(() => {
    let live = true;
    setViews([]);
    void Promise.all(
      scene.items.map((i) => workspace.readReference(scene.id, i.mode, i.itemId)),
    ).then(
      (v) => {
        if (live) setViews(v);
      },
      (e) => {
        if (live) fail(e);
      },
    );
    return () => {
      live = false;
    };
  }, [workspace, scene.id, revision]);
  return (
    <Section title="参照：人物・場所">
      <div className="production-references">
        <p>このSceneの設定。参照版は明示的に更新します。</p>
        {!views.length && <p>参照を確認しています…</p>}
        {views.map((view) => {
          const v: ReferenceView = [view.reference.source, view.reference.artwork].every((r) =>
            workspace.canReadWorld(r.artifactId),
          )
            ? view
            : { reference: view.reference, state: 'forbidden', reason: '参照権限が失効しました。' };
          return (
            <article
              key={`${v.reference.mode}:${v.reference.itemId}`}
              data-reference-state={v.state}
            >
              <strong>
                {v.reference.itemId} · {v.name ?? '参照できません'}
              </strong>
              <p>{v.summary}</p>
              {workspace.modeProblem(v.reference.mode) && (
                <p>設定への接続：{workspace.modeProblem(v.reference.mode)}</p>
              )}
              <p role="status">{v.state === 'current' ? '参照版は現在の保存版です' : v.reason}</p>
              {v.artworkContent && (
                <img
                  alt={`${v.reference.itemId}の参照中の設定画`}
                  src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(exportDesignSvg(v.artworkContent, [v.reference.artwork.elementId]))}`}
                />
              )}
              <details>
                <summary>Artifact・exact version</summary>
                <p>
                  正本：{v.reference.source.artifactId}
                  <br />
                  <code>{v.reference.source.versionId}</code>
                </p>
                <p>
                  設定画：{v.reference.artwork.artifactId}
                  <br />
                  <code>{v.reference.artwork.versionId}</code>
                  <br />
                  候補：{v.reference.artwork.elementId}
                </p>
                {v.state === 'stale' && (
                  <p>
                    新しい保存版：<code>{v.currentSourceVersion}</code>
                    <br />
                    <code>{v.currentArtworkVersion}</code>
                  </p>
                )}
              </details>
              <button
                disabled={
                  !['current', 'stale'].includes(v.state) ||
                  !workspace.modeAvailable(v.reference.mode) ||
                  !workspace.canReadMode(v.reference.mode)
                }
                onClick={() => open(v.reference)}
              >
                {v.reference.mode === 'character' ? 'Character Modeを開く' : 'Setting Modeを開く'} ·{' '}
                {v.reference.itemId}
              </button>
              <button
                disabled={
                  !['current', 'stale'].includes(v.state) ||
                  !workspace.modeAvailable(v.reference.mode) ||
                  !workspace.canReadMode(v.reference.mode)
                }
                onClick={() => open(v.reference, true)}
              >
                設定画へ · {v.reference.itemId}
              </button>
              {v.state === 'stale' && (
                <button
                  disabled={!workspace.canUpdateReferences(v.reference.mode)}
                  onClick={async () => {
                    try {
                      await workspace.refreshReference(
                        scene.id,
                        v.reference.mode,
                        v.reference.itemId,
                        v.reference,
                      );
                      changed();
                    } catch (e) {
                      fail(e);
                    }
                  }}
                >
                  このSceneの参照版を更新 · {v.reference.itemId}
                </button>
              )}
            </article>
          );
        })}
        <button onClick={changed}>参照状態を再確認</button>
      </div>
    </Section>
  );
}
function download(value: string, name: string) {
  const url = URL.createObjectURL(new Blob([value], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
/** Novel/Comic are the existing native workspaces. Only their reference inputs belong here. */
export function CreativeProductionHost({
  workspace,
  generation,
}: {
  workspace: CreativeWorkspace;
  generation?: CreativeLayerConnection;
}) {
  if (!workspace.mapping.scenes.length)
    return <p role="status">Scene対応がありません。Hostで既存原稿のSceneを登録してください。</p>;
  return (
    <ProductionEditor key={workspace.sessionId} workspace={workspace} generation={generation} />
  );
}
function ProductionEditor({
  workspace,
  generation,
}: {
  workspace: CreativeWorkspace;
  generation?: CreativeLayerConnection;
}) {
  const [drafts, setDrafts] = useState<WorldDrafts>({});
  const [worldSource, setWorldSource] = useState<{
    reference: WorldReference;
    editor: Awaited<ReturnType<CreativeWorkspace['openWorldSource']>>;
  }>();
  const [mapVisit, setMapVisit] = useState<{
    reference: CreativeMapLocation;
    editor: Awaited<ReturnType<CreativeWorkspace['maps']['open']>>;
    returnTo: CreativeWorkspace['mapping']['returnTo'];
  }>();
  const [revision, refresh] = useReducer((n: number) => n + 1, 0);
  const [sceneId, setSceneId] = useState(
    workspace.mapping.returnTo?.sceneId ?? workspace.mapping.scenes[0]?.id ?? '',
  );
  const [editor, setEditor] = useState<Awaited<ReturnType<CreativeWorkspace['openScene']>>>();
  const [focus, setFocus] = useState<ElementAddress>();
  const [artworkFocus, setArtworkFocus] = useState(false);
  const [drill, setDrill] = useState<SceneItemReference>();
  const [activeItemId, setActiveItemId] = useState('');
  const route = JSON.stringify([workspace.sessionId, sceneId, drill?.mode, activeItemId]);
  const latestRoute = useRef(route);
  latestRoute.current = route;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [documentWorkspace, setDocumentWorkspace] = useState<'novel' | 'document'>('novel');
  const [designWorkspace, setDesignWorkspace] = useState<'manga' | 'design'>('manga');
  const [inputs] = useState(() => new EditorInputs());
  const inputState = useSyncExternalStore(inputs.subscribe, inputs.getSnapshot, inputs.getSnapshot);
  useSyncExternalStore(
    generation?.world?.subscribe ?? (() => () => {}),
    generation?.world?.getSnapshot ?? (() => 0),
    () => 0,
  );
  const dirty =
    !!generation?.world?.pending ||
    Object.keys(drafts).length > 0 ||
    workspace.hasUnsavedWorldSources ||
    workspace.hasUnsavedManuscripts ||
    !!inputState.dirty ||
    !!inputState.composing ||
    !!inputState.settling;
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
  const fail = useCallback(
    (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    [],
  );
  const scene = useMemo(() => workspace.scene(sceneId), [workspace, sceneId, revision]);
  const run = (fn: () => unknown) => {
    try {
      fn();
      setError('');
      refresh();
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  };
  const activate = async (id: string, returnAddress?: ElementAddress) => {
    if (busy) return;
    setBusy(true);
    try {
      inputs.flush();
      await generation?.world?.assertSettled();
      const current = await workspace.openScene(id);
      setEditor(current);
      setSceneId(id);
      setFocus(
        returnAddress ?? {
          artifactId: current.id,
          elementId: workspace.scene(id).origin.elementId,
        },
      );
      setDrill(undefined);
      setError('');
      refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (workspace.mapping.returnTo)
      void workspace
        .returnToScene()
        .then((result) => activate(result.scene.id, result.address), fail);
    else void activate(sceneId);
  }, [workspace]);
  useEffect(() => {
    if (!editor) return;
    const release = [editor.attach(refresh), editor.registerInputBoundary(() => inputs.flush())];
    return () => release.forEach((f) => f());
  }, [editor, inputs]);
  const select = useCallback(
    (ids: string | string[], region?: Region) => {
      if (!editor) return;
      const list = typeof ids === 'string' ? [ids] : ids;
      editor.select({
        addresses: list.map((elementId) => ({
          artifactId: editor.id,
          elementId,
          ...(region ? { region } : {}),
        })),
      });
      if (list[0]) {
        try {
          const found = workspace.sceneForAddress({ artifactId: editor.id, elementId: list[0] });
          if (found) setSceneId(found.id);
        } catch (error) {
          fail(error);
        }
      }
    },
    [workspace, editor],
  );
  const open = async (ref: SceneItemReference, artwork = false) => {
    try {
      inputs.flush();
      await generation?.world?.assertSettled();
      await workspace.editTarget(sceneId, ref.mode, ref.itemId);
      await workspace.captureReturn(sceneId);
      setActiveItemId(ref.itemId);
      setArtworkFocus(artwork);
      setDrill(ref);
      setError('');
      refresh();
    } catch (e) {
      fail(e);
    }
  };
  const leave = async () => {
    try {
      await generation?.world?.assertSettled();
      const result = await workspace.returnToScene();
      if (drill) {
        const p = workspace.project(drill.mode);
        if (
          p.mappingDirty ||
          p.source.snapshot.dirty ||
          [...p.designs.values()].some((e) => e.snapshot.dirty)
        )
          throw Error('設定が更新されました。保存してから戻ってください。');
      }
      await activate(result.scene.id, result.address);
    } catch (e) {
      fail(e);
    }
  };
  const designFocus = useMemo(() => (focus ? { id: focus.elementId } : undefined), [focus]);
  const openWorld = async (reference: WorldReference) => {
    if (busy) return;
    setBusy(true);
    try {
      inputs.flush();
      await generation?.world?.assertSettled();
      if (drill) {
        const p = workspace.project(drill.mode);
        p.source.flushInputs();
        for (const e of p.designs.values()) e.flushInputs();
        if (
          p.mappingDirty ||
          p.source.snapshot.dirty ||
          [...p.designs.values()].some((e) => e.snapshot.dirty)
        )
          throw Error('設定と設定画を保存してから元資料へ移動してください。');
      } else await workspace.captureReturn(sceneId);
      const source = await workspace.openWorldSource(reference);
      setWorldSource({ reference, editor: source });
      setError('');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const flushMapOrigin = () => {
    inputs.flush();
    if (drill) {
      const p = workspace.project(drill.mode);
      p.source.flushInputs();
      for (const e of p.designs.values()) e.flushInputs();
      if (
        p.mappingDirty ||
        p.source.snapshot.dirty ||
        [...p.designs.values()].some((e) => e.snapshot.dirty)
      )
        throw Error('設定と設定画を保存してから地図へ移動してください。');
    }
  };
  const openMap = async (reference: CreativeMapLocation) => {
    if (busy) return;
    const capturedRoute = route;
    const capturedOrigin = mapOriginStamp();
    setBusy(true);
    try {
      await generation?.world?.assertSettled();
      flushMapOrigin();
      if (!drill) await workspace.captureReturn(sceneId);
      const editor = await workspace.maps.open(reference);
      if (latestRoute.current !== capturedRoute || mapOriginStamp() !== capturedOrigin)
        throw Error('移動先が変わりました。遅い地図読取を表示しません。');
      flushMapOrigin();
      setMapVisit({ reference, editor, returnTo: workspace.mapping.returnTo });
      setError('');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const mapOriginStamp = () =>
    canonicalJson([
      editor?.revision ?? null,
      editor?.snapshot.selection ?? null,
      ...(drill
        ? [
            workspace.project(drill.mode).mapping,
            ...[
              workspace.project(drill.mode).source,
              ...workspace.project(drill.mode).designs.values(),
            ].map((e) => [e.revision, e.snapshot.selection]),
          ]
        : []),
    ]);
  const mapLocation = async (reference: CreativeMapLocation, check = () => {}) => {
    const capturedRoute = route,
      capturedOrigin = mapOriginStamp();
    if (mapVisit && canonicalJson(workspace.mapping.returnTo) !== canonicalJson(mapVisit.returnTo))
      throw Error('戻り先ticketが変わりました。別Sceneへ付け替えません。');
    flushMapOrigin();
    await generation?.world?.assertSettled();
    const target = await workspace.maps.editLocation(reference);
    if (!drill && !mapVisit) await workspace.captureReturn(sceneId);
    if (latestRoute.current !== capturedRoute || mapOriginStamp() !== capturedOrigin)
      throw Error('移動先が変わりました。古い場所へ移動しません。');
    if (mapVisit && canonicalJson(workspace.mapping.returnTo) !== canonicalJson(mapVisit.returnTo))
      throw Error('戻り先ticketが変わりました。別Sceneへ付け替えません。');
    flushMapOrigin();
    check();
    setActiveItemId(reference.itemId);
    setArtworkFocus(true);
    setDrill(target);
    setMapVisit(undefined);
    setError('');
    refresh();
  };
  const worldPane = (targetItemId = activeItemId) => (
    <>
      {[
        'work',
        sceneId,
        ...(drill
          ? [workspace.itemContextId(drill.mode, targetItemId)].filter((id): id is string => !!id)
          : []),
      ].map((id) => (
        <WorldPane
          key={id}
          workspace={workspace}
          contextId={id}
          generationConnected={!!generation?.world}
          drafts={drafts}
          stage={(id, value, completed) =>
            setDrafts((current) => {
              const next = { ...current };
              if (value) next[id] = value;
              else if (!completed || JSON.stringify(next[id]) === JSON.stringify(completed))
                delete next[id];
              return next;
            })
          }
          revision={revision}
          changed={refresh}
          fail={fail}
          open={(r) => void openWorld(r)}
        />
      ))}
      <MapLocationsPane
        key={'map:' + sceneId + ':' + (drill?.mode ?? '') + ':' + targetItemId}
        workspace={workspace}
        sceneId={sceneId}
        itemId={drill?.mode === 'setting' ? targetItemId : undefined}
        revision={revision}
        changed={refresh}
        fail={fail}
        open={(r) => void openMap(r)}
        clearError={() => setError('')}
        openLocation={(r) => void mapLocation(r).catch(fail)}
      />
    </>
  );
  const pane = (
    <>
      {worldPane()}
      <References
        workspace={workspace}
        scene={scene}
        revision={revision}
        open={(r, a) => void open(r, a)}
        changed={refresh}
        fail={fail}
      />
    </>
  );
  const history = (redo = false) =>
    run(() => {
      if (busy) throw Error('保存中です。');
      if (inputs.history(redo ? 'redo' : 'undo')) return;
      inputs.flush();
      if (redo) editor?.redo();
      else editor?.undo();
    });
  return (
    <div className="production-host">
      <div hidden={!!drill || !!worldSource || !!mapVisit}>
        <header>
          <div>
            <a href="/">Editor Platform</a>
            <h1>港町の物語 · 小説と漫画</h1>
          </div>
          <div>
            <button
              disabled={busy || editor?.readOnly || !editor?.canUndo}
              onClick={() => history()}
            >
              原稿を元に戻す
            </button>
            <button
              disabled={busy || editor?.readOnly || !editor?.canRedo}
              onClick={() => history(true)}
            >
              原稿をやり直す
            </button>
            <button
              disabled={busy || !editor || editor.readOnly}
              onClick={async () => {
                setBusy(true);
                try {
                  inputs.flush();
                  await workspace.saveScene(sceneId);
                  refresh();
                  setError('');
                } catch (e) {
                  fail(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              原稿を保存・Scene参照版を確認
            </button>
            <span role="status">
              {busy ? '保存中…' : dirty ? '原稿に未保存の変更' : '原稿は保存済み'}
            </span>
          </div>
        </header>
        <nav aria-label="制作Scene">
          {workspace.mapping.scenes.map((s) => (
            <button key={s.id} aria-pressed={s.id === sceneId} onClick={() => void activate(s.id)}>
              {s.id} · {s.kind === 'document' ? '小説' : '漫画'}
            </button>
          ))}
        </nav>
        {editor && (
          <p className="production-scene">
            現在：{scene.id} / {editor.artifact.name} / <code>{scene.origin.versionId}</code>
          </p>
        )}
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
                {editor && scene.kind === 'document' && (
                  <DocumentSurface
                    content={editor.content as DocumentContent}
                    workspace={documentWorkspace}
                    onWorkspaceRequest={setDocumentWorkspace}
                    novel={{ references: pane }}
                    focusAddress={focus}
                    execute={(cmd) => run(() => editor.execute(cmd as never))}
                    select={select}
                    readOnly={editor.readOnly || busy}
                    layout={{
                      viewKey: 'creative-production-novel',
                      defaultPanels: { right: window.innerWidth > 900 },
                    }}
                  />
                )}
                {editor && scene.kind === 'design' && (
                  <DesignSurface
                    content={editor.content as DesignContent}
                    workspace={designWorkspace}
                    onWorkspaceRequest={setDesignWorkspace}
                    inkInput
                    focusRequest={designFocus}
                    extension={{ workspaceReferences: () => pane }}
                    execute={(cmd) => run(() => editor.execute(guardDesignCommand(cmd) as never))}
                    select={select}
                    readOnly={editor.readOnly || busy}
                    layout={{
                      viewKey: 'creative-production-comic',
                      defaultPanels: { right: window.innerWidth > 900 },
                    }}
                  />
                )}
              </EditorHistoryContext.Provider>
            </EditorExportGuardContext.Provider>
          </EditorInputsContext.Provider>
        </div>
        <details className="production-export">
          <summary>原稿・参照表のnativeデータ</summary>
          <button
            onClick={async () => {
              try {
                if (editor)
                  download((await editor.export('native-json')) as string, 'manuscript.json');
              } catch (e) {
                fail(e);
              }
            }}
          >
            原稿native JSON
          </button>
          <button
            onClick={() =>
              download(JSON.stringify(workspace.mapping, null, 2), 'scene-references.json')
            }
          >
            Scene参照JSON
          </button>
        </details>
      </div>
      {drill && (
        <div className="production-drill" hidden={!!worldSource || !!mapVisit}>
          <p>
            元のScene：{workspace.mapping.returnTo?.sceneId}
            。参照版は更新せず、現在の編集用draftを開いています。
          </p>
          {drill.mode === 'character' ? (
            <CreativeHost
              worldContext={worldPane}
              onActiveItem={setActiveItemId}
              generation={generation ? { ...generation, sceneId } : undefined}
              key={`character:${drill.itemId}`}
              project={workspace.characters}
              canRead={() => workspace.canReadMode('character')}
              initialItemId={drill.itemId}
              focusArtwork={artworkFocus}
              returnToScene={{ label: '元のSceneへ戻る', leave: () => leave() }}
            />
          ) : (
            <CreativeHost
              worldContext={worldPane}
              onActiveItem={setActiveItemId}
              generation={generation ? { ...generation, sceneId } : undefined}
              key={`setting:${drill.itemId}`}
              project={workspace.settings}
              canRead={() => workspace.canReadMode('setting')}
              initialItemId={drill.itemId}
              focusArtwork={artworkFocus}
              returnToScene={{ label: '元のSceneへ戻る', leave: () => leave() }}
            />
          )}
        </div>
      )}
      {mapVisit && (
        <MapLocationEditor
          workspace={workspace}
          reference={mapVisit.reference}
          editor={mapVisit.editor}
          leave={async (check) => {
            const capturedRoute = route;
            if (canonicalJson(workspace.mapping.returnTo) !== canonicalJson(mapVisit.returnTo))
              throw Error('戻り先ticketが変わりました。別Sceneへ付け替えません。');
            await workspace.returnToScene();
            if (latestRoute.current !== capturedRoute) throw Error('戻り先が変わりました。');
            if (drill && !workspace.project(drill.mode).cards.some((c) => c.id === activeItemId))
              throw Error('戻り先が削除されました。推測で復帰しません。');
            check();
            setMapVisit(undefined);
            refresh();
          }}
          openLocation={(check) => mapLocation(mapVisit.reference, check)}
        />
      )}
      {worldSource && (
        <WorldSourceEditor
          key={worldSource.editor.id}
          workspace={workspace}
          editor={worldSource.editor}
          reference={worldSource.reference}
          leave={async () => {
            // Scene ticket is revalidated; never guess a replacement address on deletion.
            await workspace.returnToScene();
            if (drill && !workspace.project(drill.mode).cards.some((c) => c.id === activeItemId))
              throw Error('戻り先の人物・場所が削除されました。別の項目へ移動しません。');
            setWorldSource(undefined);
            refresh();
          }}
        />
      )}
      {error && (
        <p className="production-error" role="alert">
          {error}
          <button onClick={() => setError('')}>閉じる</button>
        </p>
      )}
    </div>
  );
}
