import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { canonicalJson } from '@editor-platform/artifact-core';
import type { CreativeProject } from '../project';
import { CreativeHost } from '../host';
import type { CreativeLayerConnection } from '../generation';
import type { CreativeWorkspace } from './model';
import type { WorldReference } from './world-context';
import { WorldPane, type WorldDrafts } from './world-pane';
import { WorldSourceEditor } from './world-source';
import { MapLocationsPane } from './map-pane';
import { MapLocationEditor } from './map-editor';
import type { CreativeMapLocation } from './map-links';
import './workspace.css';

export function CreativeWorldHost<T>(props: {
  workspace: CreativeWorkspace;
  project: CreativeProject<T>;
  generation?: CreativeLayerConnection;
}) {
  return (
    <WorldCreativeEditor
      key={props.workspace.sessionId + ':' + props.project.source.id}
      {...props}
    />
  );
}
/** Same native CreativeHost session is retained while visiting a source Document/Design. */
function WorldCreativeEditor<T>({
  workspace,
  project,
  generation,
}: {
  workspace: CreativeWorkspace;
  project: CreativeProject<T>;
  generation?: CreativeLayerConnection;
}) {
  const [drafts, setDrafts] = useState<WorldDrafts>({});
  const [revision, refresh] = useReducer((n) => n + 1, 0);
  const [source, setSource] = useState<{
    reference: WorldReference;
    editor: Awaited<ReturnType<CreativeWorkspace['openWorldSource']>>;
  }>();
  const [mapVisit, setMapVisit] = useState<{
    reference: CreativeMapLocation;
    editor: Awaited<ReturnType<CreativeWorkspace['maps']['open']>>;
  }>();
  const [locationVisit, setLocationVisit] = useState<CreativeMapLocation>();
  const [locationItemId, setLocationItemId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [itemId, setItemId] = useState(project.cards[0]?.id ?? '');
  const route = JSON.stringify([
    workspace.sessionId,
    project.source.id,
    itemId,
    locationVisit?.id,
    locationItemId,
  ]);
  const latestRoute = useRef(route);
  latestRoute.current = route;
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  useSyncExternalStore(
    generation?.world?.subscribe ?? (() => () => {}),
    generation?.world?.getSnapshot ?? (() => 0),
    () => 0,
  );
  const recordPending = !!generation?.world?.pending;
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (recordPending || Object.keys(drafts).length || workspace.hasUnsavedWorldSources) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [workspace, drafts, recordPending]);
  const open = async (reference: WorldReference) => {
    if (busy) return;
    setBusy(true);
    try {
      await generation?.world?.assertSettled();
      assertProjectClean();
      setSource({ reference, editor: await workspace.openWorldSource(reference) });
      setError('');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const assertProjectClean = () => {
    for (const p of new Set([project, ...(locationVisit ? [workspace.settings] : [])])) {
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
  const assertReturn = async () => {
    if (!project.cards.some((c) => c.id === itemId))
      throw Error('戻り先の人物・場所が削除されました。推測で復帰しません。');
    const current = await workspace.io.artifacts.get(project.source.id);
    if (!workspace.canReadWorld(project.source.id)) throw Error('戻り先の閲覧権限が失効しました。');
    if (
      !current ||
      JSON.stringify(current.draft.content) !==
        JSON.stringify(project.source.artifact.draft.content)
    )
      throw Error('戻り先の正本が外部で変更されました。');
    if (
      locationVisit &&
      (!workspace.canReadMode('setting') ||
        !workspace.settings.cards.some((c) => c.id === locationItemId))
    )
      throw Error('戻り先の場所が削除されたか閲覧権限が失効しました。');
  };
  const originStamp = () =>
    canonicalJson([
      project.mapping,
      ...[project.source, ...project.designs.values()].map((e) => [
        e.revision,
        e.snapshot.selection,
      ]),
      ...(locationVisit
        ? [
            workspace.settings.mapping,
            workspace.settings.source.revision,
            ...[workspace.settings.source, ...workspace.settings.designs.values()].map((e) => [
              e.revision,
              e.snapshot.selection,
            ]),
          ]
        : []),
    ]);
  const openMap = async (reference: CreativeMapLocation) => {
    if (busy) return;
    const capturedRoute = route,
      capturedOrigin = originStamp();
    setBusy(true);
    try {
      await generation?.world?.assertSettled();
      assertProjectClean();
      const editor = await workspace.maps.open(reference);
      if (latestRoute.current !== capturedRoute || originStamp() !== capturedOrigin)
        throw Error('制作の選択が変わりました。遅い地図読取を表示しません。');
      assertProjectClean();
      setMapVisit({ reference, editor });
      setError('');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const openLocation = async (reference: CreativeMapLocation, check = () => {}) => {
    const capturedRoute = route,
      capturedOrigin = originStamp();
    await generation?.world?.assertSettled();
    assertProjectClean();
    await workspace.maps.editLocation(reference);
    if (latestRoute.current !== capturedRoute || originStamp() !== capturedOrigin)
      throw Error('制作の選択が変わりました。遅い場所読取を表示しません。');
    assertProjectClean();
    check();
    setLocationItemId(reference.itemId);
    setLocationVisit(reference);
    setMapVisit(undefined);
  };
  const pane = (activeItemId: string, mode = project.mode.id) => (
    <>
      {[
        'work',
        workspace.itemContextId(mode === 'character' ? 'character' : 'setting', activeItemId),
      ]
        .filter((id): id is string => !!id)
        .map((id) => (
          <WorldPane
            key={id}
            workspace={workspace}
            contextId={id}
            generationConnected={!!generation?.world}
            revision={revision}
            drafts={drafts}
            changed={refresh}
            fail={fail}
            open={(r) => void open(r)}
            stage={(id, value, completed) =>
              setDrafts((current) => {
                const next = { ...current };
                if (value) next[id] = value;
                else if (!completed || JSON.stringify(next[id]) === JSON.stringify(completed))
                  delete next[id];
                return next;
              })
            }
          />
        ))}
      <MapLocationsPane
        key={'map:' + mode + ':' + activeItemId}
        workspace={workspace}
        itemId={mode === 'setting' ? activeItemId : undefined}
        revision={revision}
        changed={refresh}
        fail={fail}
        open={(r) => void openMap(r)}
        clearError={() => setError('')}
        openLocation={(r) => void openLocation(r).catch(fail)}
      />
    </>
  );
  return (
    <div className="production-host">
      <div hidden={!!source || !!mapVisit || !!locationVisit}>
        <CreativeHost
          project={project}
          onActiveItem={setItemId}
          generation={generation}
          worldContext={(activeItemId) => (
            <>
              {pane(activeItemId)}
              <p>
                作品設定と選択中のCH/LO正本・候補の保存版を参照します。Sceneの状態はScene画面で確認します。
              </p>
            </>
          )}
          canRead={() =>
            workspace.canReadMode(project.mode.id === 'character' ? 'character' : 'setting')
          }
        />
      </div>
      {locationVisit && (
        <div hidden={!!mapVisit || !!source}>
          <CreativeHost
            key={'map-location:' + locationVisit.id}
            project={workspace.settings}
            onActiveItem={setLocationItemId}
            initialItemId={locationVisit.itemId}
            focusArtwork
            generation={generation}
            canRead={() => workspace.canReadMode('setting')}
            worldContext={(id) => pane(id, 'setting')}
            returnToScene={{
              label: '地図から来た制作へ戻る',
              leave: async () => {
                assertProjectClean();
                await assertReturn();
                assertProjectClean();
                setLocationVisit(undefined);
                refresh();
              },
            }}
          />
        </div>
      )}
      {mapVisit && (
        <MapLocationEditor
          workspace={workspace}
          reference={mapVisit.reference}
          editor={mapVisit.editor}
          leave={async (check) => {
            await assertReturn();
            check();
            setMapVisit(undefined);
            refresh();
          }}
          openLocation={(check) => openLocation(mapVisit.reference, check)}
        />
      )}
      {source && (
        <WorldSourceEditor
          workspace={workspace}
          editor={source.editor}
          reference={source.reference}
          leave={async () => {
            const card = project.cards.find((c) => c.id === itemId);
            if (!card)
              throw Error('戻り先の人物・場所が削除されました。別の項目へ付け替えません。');
            const current = await workspace.io.artifacts.get(project.source.id);
            if (!workspace.canReadWorld(project.source.id))
              throw Error('戻り先の閲覧権限が失効しました。');
            if (
              !current ||
              JSON.stringify(current.draft.content) !==
                JSON.stringify(project.source.artifact.draft.content)
            )
              throw Error('戻り先の正本が外部で変更されました。推測で復帰しません。');
            await assertReturn();
            setSource(undefined);
            refresh();
          }}
        />
      )}
      {error && (
        <p role="alert" className="production-error">
          {error}
          <button onClick={() => setError('')}>閉じる</button>
        </p>
      )}
    </div>
  );
}
