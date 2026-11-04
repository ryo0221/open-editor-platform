import { useEffect, useReducer, useRef, useState } from 'react';
import { newId } from '@editor-platform/artifact-core';
import { Section, useEditorInput } from '@editor-platform/editor-ui';
import type { CreativeWorkspace } from './model';
import type { CreativeMapLocation } from './map-links';
import type { CreativeMapLocationView } from './map-locations';
import type { FictionMapContent } from '@editor-platform/fiction-map/model';

type Sources = Awaited<ReturnType<CreativeWorkspace['maps']['sources']>>;
type Draft = {
  id: string;
  expected: number;
  itemId: string;
  scene: boolean;
  artifactId: string;
  versionId: string;
  viewId: string;
  featureIds: string[];
  dirty: boolean;
};
export function MapLocationsPane({
  workspace,
  sceneId,
  itemId,
  revision,
  changed,
  fail,
  clearError,
  open,
  openLocation,
}: {
  workspace: CreativeWorkspace;
  sceneId?: string;
  itemId?: string;
  revision: number;
  changed(): void;
  fail(e: unknown): void;
  clearError(): void;
  open(reference: CreativeMapLocation): void;
  openLocation(reference: CreativeMapLocation): void;
}) {
  const [, refresh] = useReducer((n) => n + 1, 0);
  const refs = workspace.maps.mapping.locations.filter(
    (r) => (!r.sceneId || r.sceneId === sceneId) && (!itemId || r.itemId === itemId),
  );
  const key = JSON.stringify([workspace.sessionId, sceneId, itemId, revision, refs]);
  const [loaded, setLoaded] = useState<{ key: string; views: CreativeMapLocationView[] }>();
  const [sources, setSources] = useState<Sources>([]);
  const [draft, setDraft] = useState<Draft>();
  const [native, setNative] = useState<{ key: string; content: FictionMapContent; hash: string }>();
  const [busy, setBusy] = useState(false);
  const liveDraft = useRef(draft);
  liveDraft.current = draft;
  const pendingNative = useRef<
    | {
        key: string;
        editor: Awaited<ReturnType<CreativeWorkspace['maps']['openUnbound']>>;
        assigned: boolean;
      }
    | undefined
  >(undefined);
  const formElement = useRef<HTMLFormElement>(null);
  const input = useEditorInput({
    label: '地図参照の選択',
    read: () => ({
      dirty: !!liveDraft.current?.dirty || !!pendingNative.current,
      composing: false,
    }),
    prepare: () => {
      throw Error('地図参照の選択を保存または取消してから移動してください。');
    },
    focus: () => formElement.current?.querySelector('select')?.focus(),
  });
  const writable = workspace.canEditWorld;
  const readable = workspace.modeAvailable('setting') && workspace.canReadMode('setting');
  const nativeKey = JSON.stringify([draft?.artifactId, draft?.versionId]);
  const savedNative =
    native?.key === nativeKey && workspace.canReadWorld(draft?.artifactId ?? '')
      ? native
      : undefined;
  useEffect(() => {
    input?.changed();
  }, [draft]);
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (draft?.dirty || workspace.maps.hasUnsavedSources) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [workspace, draft]);
  useEffect(() => {
    let live = true;
    void Promise.all(refs.map((r) => workspace.maps.read(r))).then((views) => {
      if (live) setLoaded({ key, views });
    }, fail);
    return () => {
      live = false;
    };
  }, [key]);
  useEffect(() => {
    let live = true;
    setNative(undefined);
    if (draft?.artifactId && draft.versionId)
      void workspace.maps.readMapVersion(draft.artifactId, draft.versionId).then(
        ({ version }) => {
          if (live)
            setNative({ key: nativeKey, content: version.content, hash: version.contentHash });
        },
        (e) => {
          if (live) fail(e);
        },
      );
    return () => {
      live = false;
    };
  }, [nativeKey, revision]);
  const change = (value: Partial<Draft>) => {
    if (pendingNative.current) {
      fail(Error('前回の地図native保存を再試行してから選択を変更してください。'));
      return;
    }
    setDraft((d) => (d ? { ...d, ...value, dirty: true } : d));
  };
  const begin = async (r?: CreativeMapLocation) => {
    if (draft?.dirty || pendingNative.current) {
      fail(Error('先に地図参照の選択を保存または取消してください。'));
      return;
    }
    try {
      const available = await workspace.maps.sources();
      setSources(available);
      setDraft({
        id: r?.id ?? newId('map-location'),
        expected: workspace.maps.mapping.revision,
        itemId: r?.itemId ?? itemId ?? workspace.settings.cards[0]?.id ?? '',
        scene: !!r?.sceneId || (!r && !!sceneId),
        artifactId: r?.map.artifactId ?? '',
        versionId: r?.map.versionId ?? '',
        viewId: r?.map.view.kind === 'named' ? r.map.view.id : '',
        featureIds: r?.map.featureIds ?? [],
        dirty: false,
      });
    } catch (e) {
      fail(e);
    }
  };
  const perform = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      clearError();
      changed();
      refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
      input?.changed();
    }
  };
  const source = sources.find((s) => s.id === draft?.artifactId);
  return (
    <Section title="場所と地図">
      <div className="world-context map-locations">
        <p>
          地図は位置関係、設定画は外観の資料です。地図版から年代・高さ・3D景観は推定しません。地図のAI入力への送信は未接続です。
        </p>
        {!readable ? (
          <p role="status">場所の閲覧権限を確認してください。</p>
        ) : (
          <>
            {refs.length === 0 && <p>固定地図の接続はありません。</p>}
            {loaded?.key !== key && refs.length > 0 && (
              <p role="status">固定地図を確認しています…</p>
            )}
            {loaded?.key === key &&
              loaded.views.map((view) => {
                const r = view.reference;
                const allowed =
                  workspace.canReadWorld(r.map.artifactId) &&
                  workspace.canReadWorld(r.source.artifactId);
                const v = allowed
                  ? view
                  : {
                      reference: r,
                      state: 'forbidden' as const,
                      reason: '地図・場所の閲覧権限が失効しました。',
                    };
                const ready = ['current', 'stale'].includes(v.state);
                return (
                  <article
                    key={r.id}
                    aria-label={'固定地図 ' + r.itemId + ' ' + (r.sceneId ?? '作品共通')}
                    data-map-state={v.state}
                  >
                    <h4>
                      {r.itemId} · {v.name ?? '参照できません'} · {r.sceneId ?? '作品共通'}
                    </h4>
                    <p role="status">{v.reason ?? '採用済みの固定地図です。'}</p>
                    {v.svg && (
                      <img
                        alt={r.itemId + 'の採用地図'}
                        src={'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(v.svg)}
                      />
                    )}
                    <p>{v.features?.map((f) => f.name).join(' / ')}</p>
                    {v.overviewSvg && (
                      <details>
                        <summary>保存版の地図全体を見る</summary>
                        <p>
                          地図画像の範囲と、上のLOに対応する地物は別です。全体図も同じ採用版・viewから表示します。
                        </p>
                        <img
                          alt={r.itemId + 'の採用地図全体'}
                          src={
                            'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(v.overviewSvg)
                          }
                        />
                      </details>
                    )}
                    <details>
                      <summary>固定版・参照ID</summary>
                      <p>
                        場所：{r.source.artifactId} / {r.source.versionId} / {r.source.elementId}
                      </p>
                      <p>
                        地図：{r.map.artifactId} / {r.map.versionId}
                      </p>
                      <p>hash：{r.map.contentHash}</p>
                      <p>
                        view：{r.map.view.kind === 'named' ? r.map.view.id : 'document'} / 地物：
                        {r.map.featureIds.join(', ')}
                      </p>
                      {v.latestVersionId && <p>現在の保存版：{v.latestVersionId}</p>}
                    </details>
                    <button disabled={busy || !ready} onClick={() => open(r)}>
                      地図を開く · {r.itemId}
                    </button>
                    <button disabled={busy || !ready} onClick={() => openLocation(r)}>
                      場所設定・設定画を開く · {r.itemId}
                    </button>
                    <button disabled={busy || !writable} onClick={() => void begin(r)}>
                      地図の採用版を選び直す · {r.itemId}
                    </button>
                    <button
                      disabled={busy || !writable}
                      onClick={() =>
                        void perform(() =>
                          workspace.maps.remove(r.id, workspace.maps.mapping.revision),
                        )
                      }
                    >
                      地図参照を解除 · {r.itemId}
                    </button>
                  </article>
                );
              })}
            <button disabled={busy || !writable} onClick={() => void begin()}>
              地図を接続
            </button>
            <button disabled={busy} onClick={changed}>
              地図参照を再確認
            </button>
            {draft && (
              <form
                ref={formElement}
                aria-label="固定地図の選択"
                onSubmit={(e) => {
                  e.preventDefault();
                  const captured = draft;
                  void perform(async () => {
                    if (!savedNative) throw Error('許可された保存版を選んでください。');
                    const location = await workspace.maps.location(
                      captured.itemId,
                      captured.scene ? sceneId : undefined,
                    );
                    await workspace.maps.save(
                      {
                        id: captured.id,
                        ...location,
                        map: {
                          artifactId: captured.artifactId,
                          versionId: captured.versionId,
                          contentHash: savedNative.hash,
                          view: captured.viewId
                            ? { kind: 'named', id: captured.viewId }
                            : { kind: 'document' },
                          featureIds: captured.featureIds,
                        },
                      },
                      captured.expected,
                    );
                    setDraft((current) => (current === captured ? undefined : current));
                  });
                }}
              >
                <fieldset disabled={busy || !writable}>
                  <legend>保存した版と地物を明示選択</legend>
                  <label>
                    場所
                    <select
                      aria-label="地図の場所"
                      value={draft.itemId}
                      disabled={!!itemId || refs.some((r) => r.id === draft.id)}
                      onChange={(e) => change({ itemId: e.target.value })}
                    >
                      {workspace.settings.cards.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.id} · {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {sceneId && (
                    <label>
                      <input
                        type="checkbox"
                        checked={draft.scene}
                        disabled={refs.some((r) => r.id === draft.id)}
                        onChange={(e) => change({ scene: e.target.checked })}
                      />
                      このSceneだけに対応する（時点は自動推定しない）
                    </label>
                  )}
                  <label>
                    地図
                    <select
                      aria-label="地図Artifact"
                      value={draft.artifactId}
                      onChange={(e) =>
                        change({
                          artifactId: e.target.value,
                          versionId: '',
                          featureIds: [],
                          viewId: '',
                        })
                      }
                    >
                      <option value="">地図を選択</option>
                      {sources
                        .filter((s) => workspace.canReadWorld(s.id))
                        .map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    保存版
                    <select
                      aria-label="地図保存版"
                      value={draft.versionId}
                      onChange={(e) =>
                        change({ versionId: e.target.value, featureIds: [], viewId: '' })
                      }
                    >
                      <option value="">保存版を選択</option>
                      {source &&
                        workspace.canReadWorld(source.id) &&
                        source.versions.map((v) => (
                          <option key={v.versionId} value={v.versionId}>
                            {v.versionId}
                          </option>
                        ))}
                    </select>
                  </label>
                  {savedNative && (
                    <>
                      <label>
                        表示範囲
                        <select
                          aria-label="地図ビュー"
                          value={draft.viewId}
                          onChange={(e) => change({ viewId: e.target.value })}
                        >
                          <option value="">文書全体</option>
                          {savedNative.content.namedViews.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.name} ({v.id})
                            </option>
                          ))}
                        </select>
                      </label>
                      <fieldset>
                        <legend>地物（複数選択可）</legend>
                        {savedNative.content.features.map((f) => (
                          <label key={f.id}>
                            <input
                              type="checkbox"
                              aria-label={'地物 ' + f.id}
                              checked={draft.featureIds.includes(f.id)}
                              onChange={(e) =>
                                change({
                                  featureIds: e.target.checked
                                    ? [...draft.featureIds, f.id]
                                    : draft.featureIds.filter((id) => id !== f.id),
                                })
                              }
                            />
                            {f.name} · {f.id} ·{' '}
                            {f.worldEntityRef
                              ? f.worldEntityRef.namespace + '/' + f.worldEntityRef.entityId
                              : '参照なし'}
                          </label>
                        ))}
                      </fieldset>
                      <button
                        type="button"
                        disabled={!draft.featureIds.length}
                        onClick={() =>
                          void perform(async () => {
                            const key = JSON.stringify([
                              workspace.sessionId,
                              draft.id,
                              draft.artifactId,
                              draft.versionId,
                              draft.itemId,
                              draft.featureIds,
                            ]);
                            let pending = pendingNative.current;
                            if (pending && pending.key !== key)
                              throw Error('前回の地図native保存を再試行してください。');
                            if (!pending) {
                              const editor = await workspace.maps.openUnbound(
                                draft.artifactId,
                                draft.versionId,
                              );
                              pending = { key, editor, assigned: false };
                            }
                            if (!pending.assigned) {
                              workspace.maps.assign(pending.editor, draft.featureIds, draft.itemId);
                              pending.assigned = true;
                              pendingNative.current = pending;
                            }
                            await workspace.maps.saveSource(pending.editor);
                            const available = await workspace.maps.sources();
                            setSources(available);
                            pendingNative.current = undefined;
                            change({ versionId: pending.editor.artifact.draft.baseVersionId! });
                          })
                        }
                      >
                        参照なしの選択地物へ場所を明示付与して地図を保存
                      </button>
                    </>
                  )}
                  <p role="status">
                    {draft.dirty ? '地図参照の選択は未保存です。' : '採用版を選択できます。'}{' '}
                    native保存と参照表保存は別です。
                  </p>
                  <button
                    type="submit"
                    disabled={!savedNative || !draft.featureIds.length || !!pendingNative.current}
                  >
                    この地図版を明示採用して参照を保存
                  </button>
                </fieldset>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (pendingNative.current) {
                      fail(Error('前回の地図native保存を再試行してから取消してください。'));
                      return;
                    }
                    setDraft(undefined);
                    clearError();
                  }}
                >
                  地図の選択を取消
                </button>
              </form>
            )}
          </>
        )}
      </div>
    </Section>
  );
}
