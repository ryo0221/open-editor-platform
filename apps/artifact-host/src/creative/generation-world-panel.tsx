import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { canonicalJson } from '@editor-platform/artifact-core';
import { downloadBlob, readImage } from '@editor-platform/canvas-ui';
import { exportDesignSvg } from '@editor-platform/design/model';
import type { DesignContent } from '@editor-platform/design/model';
import type { ArtifactEditor } from '@editor-platform/editor-host';
import type { CreativeLayerPreparation } from './generation';
import type {
  CreativeWorldGenerationConnection,
  CreativeWorldGenerationPreparation,
  CreativeWorldHistory,
} from './workspace/generation-execution';

/** A section of the existing native generation panel, not another editor/history. */
export function CreativeWorldRunPanel({
  connection,
  native,
  editor,
  readOnly,
  sceneId,
  restart,
  changed,
  onError,
}: {
  connection: CreativeWorldGenerationConnection;
  native: CreativeLayerPreparation;
  editor: ArtifactEditor<DesignContent>;
  readOnly: boolean;
  sceneId?: string;
  restart(): void;
  changed(): void;
  onError(error: unknown): void;
}) {
  const [session, setSession] = useState<CreativeWorldGenerationPreparation>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [png, setPng] = useState('');
  const [manifest, setManifest] = useState<unknown>();
  const [ready, setReady] = useState(0);
  const active = useRef<AbortController | undefined>(undefined);
  const live = useRef(true);
  const owned = useRef<CreativeWorldGenerationPreparation | undefined>(undefined);
  useEffect(() => {
    live.current = true;
    let display = true;
    setBusy(true);
    setError('');
    void connection
      .prepare(native, {
        sceneId,
        assertActive() {
          if (!live.current) throw Error('制作画面が切り替わりました。');
        },
      })
      .then(
        (value) => {
          owned.current = value;
          if (display && live.current) setSession(value);
          else if (!live.current) value.cancel();
        },
        (e) => {
          if (display) setError(e instanceof Error ? e.message : String(e));
        },
      )
      .finally(() => {
        if (display) setBusy(false);
      });
    return () => {
      display = false;
      live.current = false;
      active.current?.abort();
    };
  }, [connection, native, sceneId, ready]);
  useEffect(
    () => () => {
      owned.current?.cancel();
    },
    [connection, native],
  );
  const run = async (work: (signal: AbortSignal) => Promise<unknown>) => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError('');
    try {
      await work(controller.signal);
      if (live.current && !controller.signal.aborted) changed();
    } catch (e) {
      if (live.current && !controller.signal.aborted) {
        setError(e instanceof Error ? e.message : String(e));
        onError(e);
      }
    } finally {
      if (active.current === controller) {
        active.current = undefined;
        if (live.current) setBusy(false);
      }
    }
  };
  let view;
  try {
    view = session?.view;
  } catch {
    /* Revocation never renders an earlier cached projection. */
  }
  const proposal = view?.proposalId && editor?.proposals.find((p) => p.id === view.proposalId);
  const svg = (content: NonNullable<typeof editor>['content']) =>
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(exportDesignSvg(content, [native.request.frameId], { padding: 0 }))}`;
  return (
    <section aria-label="世界設定を使う清書">
      <p>接続先：{connection.label}。採用資料は送信前・preview前・最終採用前に照合します。</p>
      {!session && (
        <>
          <p>依頼入力と操作IDをHostの実行記録へ保存します。記録できるまで送信しません。</p>
          <button disabled={busy} onClick={() => setReady((n) => n + 1)}>
            入力記録の保存を再試行
          </button>
        </>
      )}
      {session && !view && (
        <p role="alert">
          資料・結果を表示できません。現在権限を確認し、制作前提を再準備してください。
        </p>
      )}
      {view && (
        <>
          <p>
            依頼：<code>{view.identity.requestId}</code>
            <br />
            操作：<code>{view.identity.operationId}</code>
          </p>
          <p>
            前提fingerprint：<code>{view.identity.fingerprint}</code>
            <br />
            入力hash：<code>{view.identity.payloadHash}</code>
          </p>
          <p role="status">
            {view.stale
              ? '前提が変更されています。再準備が必要です。'
              : view.applied
                ? 'nativeへ適用済み。保存版への利用記録は下で別に確認します。'
                : '未適用の生成依頼です。'}
          </p>
          <p role="status">
            {view.dirty
              ? '実行・利用記録が未保存です。再試行してください。'
              : '現在の実行記録は保存済みです。画像の保存版確定とは別です。'}
          </p>
          {view.error && <p role="alert">{view.error}</p>}
          <details>
            <summary>依頼時の編集指示と対象</summary>
            <p>
              対象：<code>{JSON.stringify(view.input.editorRequest.target.address)}</code>
            </p>
            <pre>{view.input.editorRequest.instructions}</pre>
            <pre>{view.input.editorRequest.styleGuide}</pre>
            <p>
              ラフ：<code>{view.input.editorRequest.rough.versionId}</code>
              <br />
              現在画像：<code>{view.input.editorRequest.currentReference.versionId}</code>
            </p>
          </details>
          <details open>
            <summary>この依頼が使う制作前提</summary>
            {view.input.context.adoptions.map((a) => (
              <p key={a.id}>
                {a.id} · 採用revision {a.revision}
              </p>
            ))}
            {view.input.context.references.map((r) => (
              <article key={r.contextId + ':' + r.reference.id}>
                <strong>
                  {r.reference.role} · {r.reference.id}
                </strong>
                <p>
                  {r.reference.artifactId} / <code>{r.reference.versionId}</code>
                </p>
                <p>
                  投影hash：<code>{r.projectionHash}</code>
                </p>
                {r.projection.kind === 'text' ? (
                  <pre>{r.projection.value}</pre>
                ) : (
                  <img
                    className="creative-upload"
                    alt={`生成見本 ${r.reference.id}`}
                    src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(r.projection.value)}`}
                  />
                )}
              </article>
            ))}
          </details>
          <fieldset disabled={busy || view.stale || view.applied || readOnly}>
            <legend>World対応の依頼・結果</legend>
            <button
              disabled={!!proposal || !connection.options.provider}
              onClick={() => void run((signal) => session!.generate(signal))}
            >
              World Hostへ生成を依頼
            </button>
            <button
              onClick={() =>
                void run(async (signal) => {
                  const bundle = await session!.export(signal);
                  downloadBlob(
                    'creative-world-request.json',
                    new Blob([bundle.json], { type: 'application/json' }),
                  );
                })
              }
            >
              World依頼一式を書き出す
            </button>
            <p>
              外部PNGは、この依頼のoperation ID・request ID・前提hashとPNG
              hashを記した結果manifestと一緒に読み込みます。
            </p>
            <label>
              外部結果PNG
              <input
                aria-label="World結果PNG"
                type="file"
                accept="image/png"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file)
                    void run(async (signal) => {
                      const src = await readImage(file);
                      if (!signal.aborted) setPng(src);
                    });
                }}
              />
            </label>
            <label>
              結果manifest JSON
              <input
                aria-label="World結果manifest"
                type="file"
                accept="application/json"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file)
                    void run(async (signal) => {
                      if (file.size > 64 * 1024) throw Error('結果manifestは64KiBまでです。');
                      const raw = JSON.parse(await file.text());
                      if (!signal.aborted) setManifest(raw);
                    });
                }}
              />
            </label>
            <button
              disabled={!png || !manifest || !!proposal}
              onClick={() => void run((signal) => session!.importPng(png, manifest, signal))}
            >
              World結果PNGを照合してプレビュー
            </button>
          </fieldset>
          {proposal && (
            <section aria-label="World結果の比較">
              <p>未適用の案です。対象外の内容・重なり・人物同一性を確認して採用します。</p>
              <div className="creative-proposal-images">
                <figure>
                  <figcaption>変更前</figcaption>
                  <img alt="World清書の変更前" src={svg(proposal.preview.baseContent)} />
                </figure>
                <figure>
                  <figcaption>変更後</figcaption>
                  <img alt="World清書の変更後" src={svg(proposal.preview.content)} />
                </figure>
              </div>
              <button
                disabled={busy || view.stale || readOnly}
                onClick={() => void run((signal) => session!.accept(signal))}
              >
                World結果を明示採用
              </button>
              <button disabled={busy} onClick={() => void run(() => session!.reject())}>
                World結果を却下
              </button>
            </section>
          )}
          {view.applied && (
            <button disabled={busy || readOnly} onClick={() => void run(() => session!.save())}>
              設定画と利用記録を保存
            </button>
          )}
          <button
            disabled={busy || !view.dirty}
            onClick={() => void run(() => session!.retryRecord())}
          >
            利用記録の保存を再試行
          </button>
        </>
      )}
      <button
        disabled={busy}
        onClick={() => {
          session?.cancel();
          restart();
        }}
      >
        制作前提を再準備
      </button>
      {busy && <button onClick={() => active.current?.abort()}>World処理を中止</button>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

/** Saved observations are visible after reload without preparing/sending another request. */
export function CreativeWorldHistoryPanel({
  connection,
  artifactId,
  frameId,
  onError,
}: {
  connection: CreativeWorldGenerationConnection;
  artifactId: string;
  frameId: string;
  onError(error: unknown): void;
}) {
  const revision = useSyncExternalStore(
    connection.subscribe,
    connection.getSnapshot,
    connection.getSnapshot,
  );
  const adoptionKey = canonicalJson(connection.workspace.mapping.world);
  const [recheck, setRecheck] = useState(0);
  const [history, setHistory] = useState<CreativeWorldHistory[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  useEffect(() => {
    let current = true;
    setHistory([]);
    void connection.history(artifactId).then(
      (rows) => {
        if (current) {
          setHistory(rows);
          setProblem('');
        }
      },
      (error) => {
        if (current) setProblem(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      current = false;
    };
  }, [connection, artifactId, revision, adoptionKey, recheck]);
  const safeHistory = history.filter((row) => {
    try {
      connection.assertReadable(row.record);
      return row.record.scope.frameId === frameId;
    } catch {
      return false;
    }
  });
  const reconcile = async () => {
    setBusy(true);
    try {
      await connection.flush();
      setProblem('');
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="World利用記録">
      {problem && <p role="alert">{problem}</p>}
      <details open>
        <summary>保存版への利用記録</summary>
        {!safeHistory.length && <p>保存版への利用記録はまだありません。</p>}
        {safeHistory.map((row) => (
          <article key={row.record.operationId}>
            <p>
              {row.record.requestId} / {row.record.scope.itemId} / {row.record.scope.frameId}
            </p>
            <p role="status">
              {!row.confirmed
                ? '利用記録は未保存'
                : !row.retained
                  ? '保存版の照合が必要'
                  : row.record.usages.length
                    ? '保存済み版への利用記録あり'
                    : '保存版への利用は未確定・再起動後の未採用結果は再準備が必要'}
            </p>
            {row.problem && <p role="alert">{row.problem}</p>}
            {row.impact && (
              <p role="status">
                {row.impact.state === 'current'
                  ? '利用した資料の投影は現在の採用前提と一致'
                  : row.impact.state === 'review'
                    ? '制作前提が変わりました。作画の要確認'
                    : '現在の制作前提は未照合'}
                {row.impact.reasons.map((reason) => (
                  <span key={reason}>
                    <br />
                    {reason}
                  </span>
                ))}
              </p>
            )}
            {row.record.usages.map((u) => (
              <p key={u.versionId}>
                保存版 <code>{u.versionId}</code> / hash <code>{u.contentHash}</code>
                {u.derived ? ' / 手修正の派生を含む' : ''}
              </p>
            ))}
          </article>
        ))}
        <button disabled={busy} onClick={() => setRecheck((n) => n + 1)}>
          利用記録を再確認
        </button>
        <button disabled={busy || !connection.pending} onClick={() => void reconcile()}>
          未保存の利用記録を再照合
        </button>
      </details>
    </section>
  );
}
