import { useEffect, useState } from 'react';
import { Section } from '@editor-platform/editor-ui';
import { canonicalJson } from '@editor-platform/artifact-core';
import { type CreativeWorkspace } from './model';
import {
  worldRoles,
  type WorldContext,
  type WorldReference,
  type WorldReferenceView,
  type WorldRole,
} from './world-context';

export type WorldDrafts = Record<string, WorldContext>;
const labels: Record<WorldRole, string> = {
  facts: '世界の固定事実',
  identity: '人物・場所の同一性',
  style: '画風の既定',
  sample: '画作りの見本',
  'scene-state': '場面だけの状態',
  instructions: '今回の編集指示',
  exception: '作者が認めた例外・理由',
};
/** Projections are disposable; only the parent Host retains unsaved reference choices. */
export function WorldPane({
  workspace,
  contextId,
  drafts,
  stage,
  changed,
  open,
  fail,
  revision,
  generationConnected = false,
}: {
  workspace: CreativeWorkspace;
  contextId: string;
  drafts: WorldDrafts;
  stage(id: string, value?: WorldContext, completed?: WorldContext): void;
  changed(): void;
  open(ref: WorldReference): void;
  fail(e: unknown): void;
  revision: number;
  generationConnected?: boolean;
}) {
  const adopted = workspace.mapping.world?.contexts.find((c) => c.id === contextId);
  const draft = drafts[contextId];
  const context = draft ?? adopted;
  const [loaded, setLoaded] = useState<{ key: string; views: WorldReferenceView[] }>();
  const [busy, setBusy] = useState(false);
  const [namespace, setNamespace] = useState('');
  const [artifactId, setArtifactId] = useState(''),
    [versionId, setVersionId] = useState(''),
    [hash, setHash] = useState(''),
    [elements, setElements] = useState(''),
    [refId, setRefId] = useState(''),
    [role, setRole] = useState<WorldRole>('facts');
  const key = canonicalJson([context, revision]);
  useEffect(() => {
    let live = true;
    setLoaded(undefined);
    if (adopted)
      void workspace.readWorld(contextId).then((views) => {
        if (live) setLoaded({ key, views });
      }, fail);
    return () => {
      live = false;
    };
  }, [workspace, contextId, key]);
  const edit = (ref: WorldReference) => {
    if (!context) return;
    stage(contextId, {
      ...context,
      references: context.references.map((r) => (r.id === ref.id ? ref : r)),
    });
  };
  return (
    <Section title={contextId === 'work' ? '作品設定' : 'この制作の前提'}>
      <div className="production-references world-context" data-world-context={contextId}>
        {generationConnected ? (
          <p>
            World対応の清書が接続されています。設定画の「生成レイヤー」から前提を確認して依頼・採用してください。漫画ページへの直接生成は行いません。
          </p>
        ) : (
          <>
            <p>AI生成への世界設定継承はCW2未接続です。資料の参照・編集・版選択だけを扱います。</p>
            <button disabled title="World対応Host・認可・実行記録が未接続">
              世界設定を使って生成（未接続）
            </button>
          </>
        )}

        {!workspace.mapping.world && contextId === 'work' && (
          <div>
            <label>
              作品namespace
              <input value={namespace} onChange={(e) => setNamespace(e.target.value)} />
            </label>
            <button
              disabled={busy || !namespace.trim() || !workspace.canEditWorld}
              onClick={async () => {
                setBusy(true);
                try {
                  await workspace.connectWorld({
                    namespace,
                    contexts: [{ id: 'work', revision: 0, references: [] }],
                  });
                  changed();
                } catch (e) {
                  fail(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              作品設定の参照を接続
            </button>
          </div>
        )}
        {!context && workspace.mapping.world && (
          <button
            disabled={busy || !workspace.canEditWorld}
            onClick={async () => {
              setBusy(true);
              try {
                await workspace.connectWorldContext(contextId);
                changed();
              } catch (e) {
                fail(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            この制作の独立前提を接続
          </button>
        )}
        {!context ? (
          <p>この制作の独立した前提は未登録です。作品設定と既存CH/LO参照を確認してください。</p>
        ) : (
          <>
            <p role="status">
              採用前提revision {adopted?.revision} ·{' '}
              {draft ? '採用版の変更は未保存' : '採用版は保存済み'}
            </p>
            {context.references.map((r) => {
              const v =
                loaded?.key === key ? loaded.views.find((v) => v.reference.id === r.id) : undefined;
              const readable = workspace.canReadWorld(r.artifactId);
              const valid = readable && v && ['current', 'stale'].includes(v.state);
              const savedRef = adopted?.references.find((a) => a.id === r.id);
              return (
                <article
                  key={r.id}
                  data-world-reference={r.id}
                  data-reference-state={readable ? v?.state : 'forbidden'}
                >
                  <strong>
                    {labels[r.role]} · {r.id}
                    {r.required ? '（必須）' : ''}
                  </strong>
                  <p>
                    namespace: {r.namespace}
                    <br />
                    Artifact: {r.artifactId}
                    <br />
                    採用済み保存版: <code>{savedRef?.versionId ?? '未採用'}</code>
                    <br />
                    選択中: <code>{r.versionId}</code>
                    <br />
                    hash: <code>{r.contentHash}</code>
                  </p>
                  <p role="status">
                    {!readable
                      ? 'forbidden：閲覧権限を確認してください。'
                      : !v
                        ? '資料を確認しています…'
                        : v.state === 'stale'
                          ? '新版があります。作品の採用版は旧版のままです。'
                          : v.state === 'current'
                            ? '採用済み資料の保存版を参照中'
                            : v.reason}
                  </p>
                  {valid && v.text && <p className="world-projection">{v.text}</p>}
                  {valid && v.svg && (
                    <img
                      alt={`${r.id}の採用済み見本`}
                      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(v.svg)}`}
                    />
                  )}
                  <button disabled={!valid || busy} onClick={() => open(savedRef ?? r)}>
                    元資料を開く · {r.id}
                  </button>
                  {valid && v.latest && v.latest.versionId !== r.versionId && (
                    <button
                      disabled={!workspace.canEditWorld || busy}
                      onClick={() => edit({ ...r, ...v.latest! })}
                    >
                      新版を選択 · {r.id}
                    </button>
                  )}
                  <label>
                    exact保存版 · {r.id}
                    <input
                      disabled={!workspace.canEditWorld || busy}
                      value={r.versionId}
                      onChange={(e) => edit({ ...r, versionId: e.target.value })}
                    />
                  </label>
                  <label>
                    contentHash · {r.id}
                    <input
                      disabled={!workspace.canEditWorld || busy}
                      value={r.contentHash}
                      onChange={(e) => edit({ ...r, contentHash: e.target.value })}
                    />
                  </label>
                </article>
              );
            })}
            <button
              disabled={!draft || busy || !workspace.canEditWorld}
              onClick={async () => {
                if (!draft || !adopted) return;
                setBusy(true);
                try {
                  await workspace.saveWorldContext(draft, draft.revision);
                  stage(contextId, undefined, draft);
                  changed();
                } catch (e) {
                  fail(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              採用版を保存 · {contextId}
            </button>
            <button disabled={!draft || busy} onClick={() => stage(contextId)}>
              未保存の版選択を取り消す · {contextId}
            </button>
            <details>
              <summary>既存資料を接続（本文は元Editorで編集）</summary>
              <p>
                native
                JSONで確認したArtifact・保存版・hash・明示IDを指定します。名称やlatestによる補完はしません。
              </p>
              <label>
                参照ID
                <input value={refId} onChange={(e) => setRefId(e.target.value)} />
              </label>
              <label>
                role
                <select value={role} onChange={(e) => setRole(e.target.value as WorldRole)}>
                  {worldRoles.map((r) => (
                    <option key={r} value={r}>
                      {labels[r]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Artifact ID
                <input value={artifactId} onChange={(e) => setArtifactId(e.target.value)} />
              </label>
              <label>
                保存版ID
                <input value={versionId} onChange={(e) => setVersionId(e.target.value)} />
              </label>
              <label>
                保存版hash
                <input value={hash} onChange={(e) => setHash(e.target.value)} />
              </label>
              <label>
                {role === 'sample' ? 'root Frame ID' : 'root block IDs（カンマ区切り）'}
                <input value={elements} onChange={(e) => setElements(e.target.value)} />
              </label>
              <button
                disabled={
                  !workspace.canEditWorld ||
                  busy ||
                  !refId ||
                  !artifactId ||
                  !versionId ||
                  !hash ||
                  !elements
                }
                onClick={() =>
                  stage(contextId, {
                    ...context,
                    references: [
                      ...context.references,
                      {
                        id: refId,
                        role,
                        namespace: workspace.mapping.world!.namespace,
                        artifactId,
                        versionId,
                        contentHash: hash,
                        required: true,
                        selector:
                          role === 'sample'
                            ? { type: 'design-frame', frameId: elements }
                            : {
                                type: 'document-blocks',
                                blockIds: elements.split(',').map((s) => s.trim()),
                              },
                      },
                    ],
                  })
                }
              >
                資料接続を選択
              </button>
            </details>
          </>
        )}
        <button disabled={busy} onClick={changed}>
          作品設定の状態を再確認
        </button>
      </div>
    </Section>
  );
}
