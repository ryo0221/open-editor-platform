import { useEffect, useRef, useState, type ReactNode } from 'react';
import { canonicalJson } from '@editor-platform/artifact-core';
import {
  compareLiveReference,
  deferLiveReference,
  formatLiveValue,
  prepareLiveReferenceUpdate,
  projectLiveFigure,
  ReferenceError,
  type LiveReference,
  type LiveReferenceProvider,
  type PreparedLiveReference,
  type ReferenceSnapshot,
} from './index';

export interface LiveReviewItem {
  id: string;
  location: string;
  reference: LiveReference;
}

/** The editor owns the native command and checks the expected reference at commit. */
export interface LiveReviewProps {
  items: LiveReviewItem[];
  provider: LiveReferenceProvider;
  latest(reference: LiveReference): Promise<ReferenceSnapshot>;
  update(item: LiveReviewItem, replacement: LiveReference): void | Promise<void>;
  propose?(item: LiveReviewItem, replacement: LiveReference): void;
  readOnly?: boolean;
  destinationArtifactId?: string;
  actions?: ReactNode;
  onNewer?(ids: ReadonlySet<string>): void;
}

type Comparison = {
  item: LiveReviewItem;
  latest: ReferenceSnapshot;
  beforeSrc?: string;
  after?: PreparedLiveReference;
  error?: string;
};

export function liveReferenceMessage(error: unknown, missing?: 'value' | 'figure') {
  if (error instanceof ReferenceError) {
    if (error.status === 'forbidden')
      return 'この引用元を閲覧する権限がありません。管理者に確認してください。';
    if (error.status === 'missing-target' && missing)
      return `新しい版にこの${missing === 'value' ? '値' : '図'}がありません。現在の引用はそのままです。`;
  }
  return error instanceof Error ? error.message : String(error);
}

export function liveReferenceText(reference: LiveReference) {
  return reference.presentation.kind === 'value'
    ? formatLiveValue(reference.presentation)
    : reference.presentation.label;
}

export function LiveReferenceDetails({ reference }: { reference: LiveReference }) {
  const { target, artifactId } = reference.source;
  return (
    <p className="ep-live-details">
      {artifactId} · {reference.snapshot.versionId} ·{' '}
      {target.kind === 'value' ? `${target.targetId} · ${target.metricId}` : target.figureId}
    </p>
  );
}

export function LiveReferencePreview({
  reference,
  figureSrc,
}: {
  reference: LiveReference;
  figureSrc?: string;
}) {
  return figureSrc ? (
    <img src={figureSrc} alt={liveReferenceText(reference)} />
  ) : (
    <strong className="ep-live-quote">引用 {liveReferenceText(reference)}</strong>
  );
}

export function useLiveFigure(
  reference: LiveReference,
  provider?: LiveReferenceProvider,
  destinationArtifactId?: string,
) {
  const [projection, setProjection] = useState<{
    reference: LiveReference;
    provider: LiveReferenceProvider;
    destinationArtifactId?: string;
    src?: string;
    error?: string;
  }>();
  useEffect(() => {
    if (!provider || reference.presentation.kind !== 'figure') return;
    let active = true;
    const basis = { reference, provider, destinationArtifactId };
    void projectLiveFigure(reference, provider, destinationArtifactId).then(
      (src) => {
        if (active) setProjection({ ...basis, src });
      },
      (error: unknown) => {
        if (active) setProjection({ ...basis, error: liveReferenceMessage(error) });
      },
    );
    return () => {
      active = false;
    };
  }, [reference, provider, destinationArtifactId]);
  return projection?.reference === reference &&
    projection.provider === provider &&
    projection.destinationArtifactId === destinationArtifactId
    ? projection
    : undefined;
}

async function findComparisons({
  items,
  latest,
  provider,
  destinationArtifactId,
}: LiveReviewProps) {
  const rows: Comparison[] = [];
  const failures: string[] = [];
  for (const item of items) {
    try {
      const snapshot = await latest(item.reference);
      if (
        (await compareLiveReference(item.reference, snapshot, provider, destinationArtifactId)) ===
        'same'
      )
        continue;
      try {
        const beforeSrc =
          item.reference.presentation.kind === 'figure'
            ? await projectLiveFigure(item.reference, provider, destinationArtifactId)
            : undefined;
        const after = await prepareLiveReferenceUpdate(
          item.reference,
          snapshot,
          provider,
          destinationArtifactId,
        );
        rows.push({ item, latest: snapshot, beforeSrc, after });
      } catch (error) {
        rows.push({
          item,
          latest: snapshot,
          error: liveReferenceMessage(error, item.reference.presentation.kind),
        });
      }
    } catch (error) {
      failures.push(`${item.location} · ${liveReferenceMessage(error)}`);
    }
  }
  return { rows, failures };
}

/** Review never changes content until the editor accepts an individual update. */
export function LiveReferenceReview(props: LiveReviewProps) {
  const { items, latest, provider, destinationArtifactId, readOnly, onNewer } = props;
  const currentProps = useRef(props);
  currentProps.current = props;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [result, setResult] = useState<Awaited<ReturnType<typeof findComparisons>>>();
  const [selected, setSelected] = useState<Comparison>();
  const [deferred, setDeferred] = useState<Comparison[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setResult(undefined);
    setSelected(undefined);
    setDeferred([]);
    if (items.length) {
      void findComparisons(currentProps.current).then((next) => {
        if (active) setResult(next);
      });
    }
    return () => {
      active = false;
    };
  }, [items, latest, provider, destinationArtifactId, refresh]);
  useEffect(() => {
    onNewer?.(new Set(result?.rows.map(({ item }) => item.id)));
  }, [result, onNewer]);

  const rows = result?.rows.filter((row) => !deferred.includes(row)) ?? [];
  const current = selected && rows.includes(selected) ? selected : undefined;
  function defer(row: Comparison) {
    try {
      deferLiveReference(currentProps.current.items, row.item.id, row.item.reference);
      setDeferred((previous) => [...previous, row]);
      setSelected(undefined);
      setMessage('');
    } catch (error) {
      setMessage(liveReferenceMessage(error));
    }
  }
  async function apply(row: Comparison, propose = false) {
    if (busy || readOnly || !row.after) return;
    setBusy(true);
    setMessage('');
    try {
      // Resolve again at commit so changed access or target cannot silently apply.
      const snapshot = await latest(row.item.reference);
      if (canonicalJson(snapshot) !== canonicalJson(row.latest))
        throw new Error('新しい版が変わりました。もう一度確認してください。');
      const after = await prepareLiveReferenceUpdate(
        row.item.reference,
        snapshot,
        provider,
        destinationArtifactId,
      );
      if (!mounted.current) return;
      const active = currentProps.current;
      if (
        active.readOnly ||
        active.provider !== provider ||
        active.destinationArtifactId !== destinationArtifactId ||
        active.latest !== latest ||
        canonicalJson(after) !== canonicalJson(row.after)
      )
        throw new Error('引用の状態が変わりました。もう一度確認してください。');
      if (propose) {
        if (!active.propose) throw new Error('引用を提案できません。');
        active.propose(row.item, after.reference);
      } else await active.update(row.item, after.reference);
      setSelected(undefined);
    } catch (error) {
      if (mounted.current) {
        const detail = liveReferenceMessage(error, row.item.reference.presentation.kind);
        const missing = error instanceof ReferenceError && error.status === 'missing-target';
        if (missing) {
          setSelected(undefined);
          setRefresh((previous) => previous + 1);
        }
        setMessage(missing ? `${detail}「古い引用を確認」でもう一度確認してください。` : detail);
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section aria-label="古い引用">
      <div className="ep-live-actions">
        {props.actions}
        <button
          type="button"
          disabled={!items.length || busy}
          onClick={() => {
            setOpen(true);
            setMessage('');
            setRefresh((previous) => previous + 1);
          }}
        >
          古い引用を確認
        </button>
        {open && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              setSelected(undefined);
              setMessage('');
            }}
          >
            一覧を閉じる
          </button>
        )}
      </div>
      {readOnly && !props.actions && <p>読み取り専用では更新できません。</p>}
      {message && <p role="status">{message}</p>}
      {open && (
        <div className="ep-live-review">
          <h2>古い引用 {rows.length}件</h2>
          {result?.failures.map((failure, i) => (
            <p key={i} role="status">
              {failure}
            </p>
          ))}
          {!result && !!items.length && <p role="status">保存済み版を確認しています。</p>}
          {result && !result.rows.length && !result.failures.length && (
            <p role="status">更新なし</p>
          )}
          {!!rows.length && (
            <ul>
              {rows.map((row) => (
                <li key={row.item.id}>
                  {liveReferenceText(row.item.reference)} · {row.item.reference.source.artifactId} ·{' '}
                  {row.item.reference.snapshot.versionId} → {row.latest.versionId} ·{' '}
                  {row.item.location}{' '}
                  <button type="button" disabled={busy} onClick={() => setSelected(row)}>
                    比較
                  </button>{' '}
                  <button type="button" disabled={busy} onClick={() => defer(row)}>
                    見送る
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {current && (
        <div className="ep-live-review">
          <h2>更新を確認</h2>
          <LiveReferenceDetails reference={current.item.reference} />
          {current.error && <p role="status">{current.error}</p>}
          {current.after && (
            <div className="ep-live-compare">
              <div>
                <p>現在 · {current.item.reference.snapshot.versionId}</p>
                <LiveReferencePreview
                  reference={current.item.reference}
                  figureSrc={current.beforeSrc}
                />
              </div>
              <div>
                <p>新しい版 · {current.latest.versionId}</p>
                <LiveReferencePreview
                  reference={current.after.reference}
                  figureSrc={current.after.figureSrc}
                />
              </div>
            </div>
          )}
          <p>更新はこの引用だけに適用されます。</p>
          <button
            type="button"
            disabled={busy || readOnly || !current.after}
            onClick={() => void apply(current)}
          >
            更新する
          </button>{' '}
          {props.propose && (
            <button
              type="button"
              disabled={busy || readOnly || !current.after}
              onClick={() => void apply(current, true)}
            >
              更新を提案
            </button>
          )}{' '}
          <button type="button" disabled={busy} onClick={() => defer(current)}>
            見送る
          </button>
        </div>
      )}
    </section>
  );
}
