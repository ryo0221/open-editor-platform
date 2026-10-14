import { useEffect, useState } from 'react';
import { Dialog } from '@editor-platform/editor-ui';
import { definitionRef, refKey } from '@editor-platform/reuse-core';
import {
  applyComponentBatch,
  prepareComponentBatch,
  type ComponentBatchTarget,
  type ComponentBatchResult,
  type ComponentDefinition,
  type ComponentUpdateSelection,
  type Domain,
  type NativeContent,
  type PreparedApplication,
  type PreparedComponentBatch,
  type TemplateCatalog,
} from '@editor-platform/templates';
import { TemplatePreview } from './preview';

export interface ReusableBatchArtifact {
  id: string;
  name: string;
  domain: Domain;
  content: NativeContent;
}
export function ReusableBatchDialog(props: {
  catalog: TemplateCatalog;
  artifacts: ReusableBatchArtifact[];
  readOnly?: boolean;
  basis(id: string): Promise<Pick<ComponentBatchTarget, 'state' | 'identity'>>;
  /** Reuse the Host's per-artifact submission and receipt deduplication boundary. */
  onApply(prepared: PreparedApplication): Promise<void>;
  onClose(): void;
}) {
  const [items, setItems] = useState<ComponentDefinition[]>([]),
    [expanded, setExpanded] = useState<string>(),
    [selected, setSelected] = useState(''),
    [choices, setChoices] = useState<Record<string, ComponentUpdateSelection['choice']>>({}),
    [batch, setBatch] = useState<PreparedComponentBatch>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    void props.catalog
      .listReusable({ kind: 'component' })
      .then((values) => {
        if (!disposed) setItems(values as ComponentDefinition[]);
      })
      .catch((error) => {
        if (!disposed) setError((error as Error).message);
      });
    return () => {
      disposed = true;
    };
  }, [props.catalog]);
  const definition = items.find((d) => refKey(d) === selected);
  const targets = props.artifacts.flatMap((artifact) => {
    const instances =
      'reuse' in artifact.content
        ? (artifact.content.reuse?.instances.filter(
            (i) =>
              i.ref.libraryId === definition?.libraryId &&
              i.ref.definitionId === definition?.definitionId,
          ) ?? [])
        : [];
    return instances.length ? [{ artifact, instances }] : [];
  });
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const labels = {
    prepared: '更新可能',
    unchanged: '変更なし',
    conflict: '要再確認',
    failed: '失敗',
    applied: '適用済み',
  };
  return (
    <Dialog title="複数の成果物の部品を更新" onClose={props.onClose}>
      <div className="tp-author">
        <p>成果物ごとに差分を確認して適用します。取り消す場合は各成果物のUndoを使います。</p>
        {error && <p role="alert">{error}</p>}
        <fieldset disabled={busy}>
          <legend>更新する部品と成果物</legend>
          <label>
            採用する部品の版
            <select
              value={selected}
              onChange={(e) => {
                setSelected(e.target.value);
                setChoices({});
                setBatch(undefined);
              }}
            >
              <option value="">選択</option>
              {items.map((d) => (
                <option key={refKey(d)} value={refKey(d)}>
                  {d.name} v{d.version}（{d.domain}）
                </option>
              ))}
            </select>
          </label>
          {definition && !targets.length && <p>この部品を使う成果物はありません。</p>}
          {targets.map(({ artifact, instances }) => (
            <label key={artifact.id}>
              {artifact.name}（{instances.length}部品・v
              {[...new Set(instances.map((i) => i.ref.version))].join(', ')}）
              <select
                aria-label={`${artifact.name}の更新`}
                value={choices[artifact.id] ?? 'skip'}
                onChange={(e) => {
                  const next = { ...choices };
                  if (e.target.value === 'skip') delete next[artifact.id];
                  else next[artifact.id] = e.target.value as ComponentUpdateSelection['choice'];
                  setChoices(next);
                  setBatch(undefined);
                }}
              >
                <option value="skip">対象外</option>
                <option value="adopt">選んだ版を採用</option>
                <option value="pin">現在の版を維持</option>
                <option value="detach">リンクを解除</option>
              </select>
            </label>
          ))}
        </fieldset>
        <button
          disabled={busy || props.readOnly || !definition || !Object.keys(choices).length}
          onClick={() =>
            void run(async () => {
              const closure = await props.catalog.closure(definitionRef(definition!));
              const selectedTargets: ComponentBatchTarget[] = [];
              const unavailable: ComponentBatchResult[] = [];
              for (const { artifact, instances } of targets) {
                const choice = choices[artifact.id];
                if (!choice) continue;
                try {
                  selectedTargets.push({
                    ...(await props.basis(artifact.id)),
                    name: artifact.name,
                    selections: instances.map((i) => ({ instanceId: i.id, choice })),
                  });
                } catch (error) {
                  unavailable.push({
                    artifactId: artifact.id,
                    name: artifact.name,
                    status: 'failed',
                    changes: [],
                    error: (error as Error).message,
                  });
                }
              }
              const requestId = crypto.randomUUID();
              const next = selectedTargets.length
                ? await prepareComponentBatch({
                    requestId,
                    definition: definition!,
                    closure,
                    targets: selectedTargets,
                  })
                : { requestId, results: [] };
              setBatch({ ...next, results: [...next.results, ...unavailable] });
            })
          }
        >
          成果物ごとの差分をプレビュー
        </button>
        {batch && (
          <>
            <p role="status">
              適用済み {batch.results.filter((r) => r.status === 'applied').length} /{' '}
              {batch.results.length}成果物
            </p>
            {batch.results.map((result) => (
              <section key={result.artifactId} aria-label={`${result.name}の結果`}>
                <h3>
                  {result.name} — {labels[result.status]}
                </h3>
                {result.error && <p role="alert">{result.error}</p>}
                <ul>
                  {result.changes.map((change, index) => (
                    <li key={index}>
                      {change.partId ? `${change.partId} / ` : ''}
                      {change.field}: {change.message}
                      {(change.before !== undefined || change.after !== undefined) && (
                        <div>
                          {JSON.stringify(change.before)?.slice(0, 300) ?? '既定'} →{' '}
                          {JSON.stringify(change.after)?.slice(0, 300) ?? '既定'}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
                {result.prepared && (
                  <>
                    <button
                      onClick={() =>
                        setExpanded(expanded === result.artifactId ? undefined : result.artifactId)
                      }
                    >
                      外観を確認：{result.name}
                    </button>
                    {expanded === result.artifactId && (
                      <TemplatePreview
                        domain={result.prepared.domain}
                        content={result.prepared.preview}
                      />
                    )}
                  </>
                )}
                {result.status === 'conflict' && (
                  <p>
                    この成果物の「部品の入力・表示」で対応先を確認するか、旧版維持を選んでください。
                  </p>
                )}
              </section>
            ))}
            <button
              disabled={
                busy ||
                props.readOnly ||
                !batch.results.some((r) => r.prepared && ['prepared', 'failed'].includes(r.status))
              }
              onClick={() =>
                void run(async () => {
                  setBatch(
                    await applyComponentBatch(batch, props.onApply, (result) => {
                      setBatch(
                        (current) =>
                          current && {
                            ...current,
                            results: current.results.map((r) =>
                              r.artifactId === result.artifactId ? result : r,
                            ),
                          },
                      );
                    }),
                  );
                })
              }
            >
              {batch.results.some((r) => r.status === 'failed')
                ? '未完了の成果物を再試行'
                : 'プレビューした成果物へ適用'}
            </button>
            <p>競合・失敗は成果物ごとに残ります。依存が変わった場合は再プレビューしてください。</p>
          </>
        )}
      </div>
    </Dialog>
  );
}
