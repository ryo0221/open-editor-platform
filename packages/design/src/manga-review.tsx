import { newId } from '@editor-platform/artifact-core';
import { useState } from 'react';
import type { DesignContent } from './model';
import { DesignPageComparison } from './page-comparison';
import {
  checkDesignPageProposal,
  prepareDesignPageProposal,
  readDesignPageProposal,
  type DesignPageProposalContext,
  type DesignPageProposalRequest,
  type PreparedDesignPageProposal,
} from './page-proposals';

export interface DesignPageReviewHost {
  current(): DesignPageProposalContext;
  flushInputs(): void;
  accept(plan: PreparedDesignPageProposal): void;
  requestProposals?(context: DesignPageProposalContext): Promise<unknown>;
}
/** Inline review in the manga workspace. Host owns generation and authority. */
export function MangaReview({
  host,
  content,
}: {
  host?: DesignPageReviewHost;
  content: DesignContent;
}) {
  const [raw, setRaw] = useState(''),
    [request, setRequest] = useState<DesignPageProposalRequest>(),
    [selected, setSelected] = useState<string[]>([]),
    [plan, setPlan] = useState<PreparedDesignPageProposal>(),
    [contextJson, setContextJson] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [comparisonId, setComparisonId] = useState('');
  function load(value: unknown) {
    const next = readDesignPageProposal(value);
    setRequest(next);
    setSelected(next.units.map((u) => u.id));
    setPlan(undefined);
  }
  const run = (f: () => void) => {
    try {
      f();
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  let stale = false;
  if (plan && host)
    try {
      checkDesignPageProposal(plan, host.current());
    } catch {
      stale = true;
    }
  const pages = plan?.after.pagination?.pages ?? content.pagination?.pages ?? [];
  const comparisonIndex = Math.max(
    0,
    pages.findIndex((p) => p.frameId === comparisonId),
  );
  const pair = pages.slice(comparisonIndex, comparisonIndex + 2).map((p) => p.frameId);
  if (content.pagination?.direction === 'rtl') {
    if (pair.length === 1) pair.push('');
    pair.reverse();
  }
  return (
    <section className="manga-review" aria-label="漫画の変更提案">
      <h3>変更提案</h3>
      {!host ? (
        <p>このHostでは提案の採用を接続していません。</p>
      ) : (
        <>
          {host.requestProposals && (
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  host.flushInputs();
                  load(await host.requestProposals!(host.current()));
                  setError('');
                } catch (e) {
                  setError(String(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Hostに提案を依頼
            </button>
          )}
          <details>
            <summary>提案データを読み込む</summary>
            <button
              onClick={() =>
                run(() => {
                  host.flushInputs();
                  const current = host.current();
                  setContextJson(
                    JSON.stringify(
                      {
                        artifactId: current.artifactId,
                        baseLocalRevision: current.revision,
                        reads: {
                          target: { artifactId: current.artifactId, versionId: current.versionId },
                          references: [],
                        },
                        pages: current.content.pagination?.pages ?? [],
                        elements: current.content.elements.map(
                          ({ id, parentId, name, type, text }) => ({
                            id,
                            parentId,
                            name,
                            type,
                            text,
                          }),
                        ),
                      },
                      null,
                      2,
                    ),
                  );
                })
              }
            >
              現在の対象情報を表示
            </button>
            {contextJson && (
              <label>
                提案の対象情報
                <textarea aria-label="提案の対象情報" readOnly value={contextJson} />
              </label>
            )}
            {contextJson && <p>別の資料を参照した提案には、その資料の参照版も記録してください。</p>}
            <label>
              提案JSON
              <textarea
                aria-label="提案JSON"
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
              />
            </label>
            <button onClick={() => run(() => load(JSON.parse(raw)))}>提案を読み込む</button>
          </details>
          {request && (
            <>
              <p>{request.summary}</p>
              <p>
                対象版: {request.reads.target.versionId} / draft{' '}
                {request.baseLocalRevision.sequence}
              </p>
              {request.reads.references.map((r) => (
                <p key={r.artifactId}>
                  参照: {r.artifactId} / {r.versionId}
                </p>
              ))}
              {request.units.map((u) => (
                <label key={u.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(u.id)}
                    onChange={(e) => {
                      setSelected(
                        e.target.checked
                          ? [...selected, u.id]
                          : selected.filter((id) => id !== u.id),
                      );
                      setPlan(undefined);
                    }}
                  />
                  {u.label}
                  {u.requires.length > 0 && `（依存: ${u.requires.join(', ')}）`}
                </label>
              ))}
              <button
                disabled={!selected.length}
                onClick={() =>
                  run(() => {
                    host.flushInputs();
                    setPlan(
                      prepareDesignPageProposal(
                        host.current(),
                        request,
                        selected,
                        newId('page-review'),
                      ),
                    );
                  })
                }
              >
                選択した変更を再プレビュー
              </button>
            </>
          )}
          {plan && (
            <>
              <label>
                比較するページ
                <select
                  aria-label="比較するページ"
                  value={pages[comparisonIndex]?.frameId ?? ''}
                  onChange={(e) => setComparisonId(e.target.value)}
                >
                  {pages.map((p, i) => (
                    <option key={p.frameId} value={p.frameId}>
                      ページ {i + 1}
                    </option>
                  ))}
                </select>
              </label>
              <DesignPageComparison
                content={plan.before}
                leftId={pair[0] ?? ''}
                rightId={pair[1] ?? ''}
                label="採用前"
              />
              <DesignPageComparison
                content={plan.after}
                leftId={pair[0] ?? ''}
                rightId={pair[1] ?? ''}
                label="採用後"
              />
              <ul>
                {plan.diff.changes.map((c, i) => (
                  <li key={i}>
                    {c.elementLabel || c.elementId}: {c.property}
                  </li>
                ))}
              </ul>
              <button
                disabled={stale || host.current().readOnly}
                onClick={() =>
                  run(() => {
                    host.flushInputs();
                    host.accept(plan);
                    setPlan(undefined);
                    setRequest(undefined);
                  })
                }
              >
                選択した変更を採用
              </button>
              {stale && (
                <p role="status">原稿または参照版が変わりました。新しい提案で比較してください。</p>
              )}
            </>
          )}
          {(request || plan) && (
            <button
              onClick={() => {
                setRequest(undefined);
                setPlan(undefined);
                setRaw('');
              }}
            >
              提案を破棄
            </button>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
