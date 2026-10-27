import { EstimateCadUpdates } from './cad-updates';
import { useState } from 'react';
import { newId } from '@editor-platform/artifact-core';
import { pinKey } from '@editor-platform/calculation-core';
import type { RetainedSource, Quantity, EstimateDocument } from '@editor-platform/estimate-core';
import type { EstimatePort } from './host';
import type { EstimateGeometrySourceOption } from './sources';
import { retainCadSource, cadSourceProjection, cadQuantity } from './cad-source';
interface Review {
  base: EstimateDocument;
  revision: string;
  generation: number;
  sources: RetainedSource[];
  root: RetainedSource;
  rows: ReturnType<typeof cadSourceProjection>['rows'];
}
export function EstimateCadPanel({
  port,
  sources,
  edit,
  trial,
}: {
  port: EstimatePort;
  sources: EstimateGeometrySourceOption[];
  edit(next: EstimateDocument, label: string): void;
  trial(next: EstimateDocument): Promise<void>;
}) {
  const [selected, setSelected] = useState(0),
    [review, setReview] = useState<Review>(),
    [modes, setModes] = useState<Record<string, string>>({}),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const guard = () => {
    port.flush();
    if (!port.canEdit() || !port.inputsReady())
      throw Error('編集権限または入力状態を確認してください。');
  };
  const prepare = async () => {
    setError('');
    setBusy(true);
    try {
      guard();
      const option = sources[selected];
      if (!option) throw Error('保存CADを選択してください。');
      const revision = port.revision(),
        generation = port.generation(),
        base = structuredClone(port.read());
      if (!port.canRead(option.pin)) throw Error('source-access-denied');
      const retained = await retainCadSource(
        option.pin,
        option.content,
        (hash) => option.closure.find((s) => s.contentHash === hash)?.content,
      );
      guard();
      if (revision !== port.revision() || generation !== port.generation())
        throw Error('数量取得中に見積または権限が変わりました。');
      if (retained.some((s) => !port.canRead(s.pin))) throw Error('source-access-denied');
      const root = retained.find((s) => s.key === pinKey(option.pin))!;
      setReview({
        base,
        revision,
        generation,
        sources: retained,
        root,
        rows: cadSourceProjection(root, retained).rows,
      });
      setModes({});
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const apply = () => {
    setError('');
    try {
      guard();
      if (!review) throw Error('数量を確認してください。');
      if (review.revision !== port.revision() || review.generation !== port.generation())
        throw Error('stale-quantity-proposal');
      if (review.sources.some((s) => !port.canRead(s.pin))) throw Error('source-access-denied');
      const assemblies = review.rows.filter((r) => r.kind === 'assembly' && !r.excluded);
      if (assemblies.some((r) => !['buy', 'make'].includes(modes[r.identity])))
        throw Error('各assemblyの購入/製作を明示してください。');
      const prefix = (parent: string[], child: string[]) =>
        parent.length < child.length && parent.every((x, i) => x === child[i]);
      const quantities: Quantity[] = review.rows.map((row) => {
        const q = cadQuantity(review.root, review.sources, row.identity, newId('quantity'));
        const covered = review.rows.some((parent) => {
          if (parent.kind === 'body') return false;
          const purchased = parent.kind === 'part' || modes[parent.identity] === 'buy';
          return (
            purchased &&
            (prefix(parent.path, row.path) ||
              (row.kind === 'body' &&
                parent.path.length === row.path.length &&
                parent.path.every((x, i) => row.path[i] === x)))
          );
        });
        if (covered || (row.kind === 'assembly' && modes[row.identity] === 'make')) {
          q.inclusion = 'exclude';
          q.exclusionReason = covered ? '親の購入数量に含む' : '製作: 本体材料と子部品を計上';
        }
        return q;
      });
      const merged = new Map(review.base.retainedSources.map((s) => [s.key, s]));
      for (const s of review.sources) merged.set(s.key, s);
      edit(
        {
          ...review.base,
          quantities: [...review.base.quantities, ...quantities],
          retainedSources: [...merged.values()],
        },
        'Adopt CAD quantities',
      );
      setReview(undefined);
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <section aria-label="CAD数量の取得">
      <EstimateCadUpdates port={port} sources={sources} trial={trial} />
      <h3>保存CADから数量を取得</h3>
      <p>countのみ。購入/製作と除外を確認してから追加し、費目・単価へ対応付けます。</p>
      <fieldset disabled={!port.canEdit() || busy}>
        <label>
          数量CADの保存版
          <select
            value={selected}
            onChange={(e) => {
              setSelected(Number(e.target.value));
              setReview(undefined);
            }}
          >
            {!sources.length && <option>保存CADなし</option>}
            {sources.map((s, i) => (
              <option key={pinKey(s.pin)} value={i}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => void prepare()}>CAD数量を確認</button>
      </fieldset>
      {error && <p role="alert">{error}</p>}
      {review && (
        <>
          <p>{review.rows.length}行。追加前の見積は変更していません。</p>
          {review.rows
            .filter((r) => r.kind === 'assembly' && !r.excluded)
            .map((row) => (
              <label key={row.identity}>
                {row.name} · {row.path.join(' / ')}
                <select
                  aria-label={`購入/製作 ${row.identity}`}
                  value={modes[row.identity] ?? ''}
                  onChange={(e) => setModes({ ...modes, [row.identity]: e.target.value })}
                >
                  <option value="">選択</option>
                  <option value="buy">購入（親を計上）</option>
                  <option value="make">製作（本体・子部品を計上）</option>
                </select>
              </label>
            ))}
          <ul>
            {review.rows.map((row) => (
              <li key={row.identity}>
                {row.name} · {row.kind} · {row.count}個 · {row.excluded ? 'CADで除外' : '対象'} ·{' '}
                {row.path.join(' / ') || row.bodyId}
              </li>
            ))}
          </ul>
          <button disabled={!port.canEdit()} onClick={apply}>
            CAD数量を追加
          </button>
          <button onClick={() => setReview(undefined)}>数量提案を破棄</button>
        </>
      )}
    </section>
  );
}
