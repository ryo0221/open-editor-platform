import { useState } from 'react';
import { newId } from '@editor-platform/artifact-core';
import { pinKey } from '@editor-platform/calculation-core';
import type { EstimateDocument } from '@editor-platform/estimate-core';
import type { EstimatePort } from './host';
import type { EstimateGeometrySourceOption } from './sources';
import { retainCadSource, proposeCadSourceUpdate, type CadUpdateDifference } from './cad-source';
export function EstimateCadUpdates({
  port,
  sources,
  trial,
}: {
  port: EstimatePort;
  sources: EstimateGeometrySourceOption[];
  trial(document: EstimateDocument): Promise<void>;
}) {
  const [proposal, setProposal] = useState<{
      document: EstimateDocument;
      differences: CadUpdateDifference[];
      revision: string;
      generation: number;
    }>(),
    [error, setError] = useState('');
  const keys = [
    ...new Set(port.read().quantities.flatMap((q) => (q.source ? [q.source.snapshotKey] : []))),
  ];
  const prepare = async (key: string) => {
    setError('');
    try {
      port.flush();
      if (!port.canEdit() || !port.inputsReady()) throw Error('read-only-or-input-pending');
      const revision = port.revision(),
        generation = port.generation(),
        base = structuredClone(port.read()),
        old = base.retainedSources.find((s) => s.key === key)!;
      const update = sources.find(
        (s) =>
          s.latest &&
          s.pin.artifactId === old.pin.artifactId &&
          s.pin.versionId !== old.pin.versionId,
      );
      if (!update) throw Error('新しい保存版はありません。');
      if (!port.canRead(old.pin) || !port.canRead(update.pin)) throw Error('source-access-denied');
      const retained = await retainCadSource(
        update.pin,
        update.content,
        (h) => update.closure.find((c) => c.contentHash === h)?.content,
      );
      if (retained.some((s) => !port.canRead(s.pin))) throw Error('source-access-denied');
      const result = await proposeCadSourceUpdate(
        base,
        key,
        retained.find((s) => s.key === pinKey(update.pin))!,
        retained,
        () => newId('quantity'),
      );
      port.flush();
      if (revision !== port.revision() || generation !== port.generation() || !port.canEdit())
        throw Error('stale-quantity-proposal');
      setProposal({ ...result, revision, generation });
    } catch (e) {
      setError(String(e));
    }
  };
  const review = async () => {
    setError('');
    try {
      port.flush();
      if (
        !proposal ||
        proposal.revision !== port.revision() ||
        proposal.generation !== port.generation()
      )
        throw Error('stale-quantity-proposal');
      await trial(proposal.document);
      setProposal(undefined);
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <section aria-label="CAD入力の更新">
      <h3>CAD入力の新版確認</h3>
      {keys.map((key) => {
        const source = port.read().retainedSources.find((s) => s.key === key)!;
        const latest = sources.find(
          (s) =>
            s.latest &&
            s.pin.artifactId === source.pin.artifactId &&
            s.pin.versionId !== source.pin.versionId,
        );
        return (
          latest && (
            <p key={key}>
              版 {source.pin.versionId} → {latest.pin.versionId}
              <button disabled={!port.canEdit()} onClick={() => void prepare(key)}>
                CAD新版の差分を確認
              </button>
            </p>
          )
        );
      })}
      {error && <p role="alert">{error}</p>}
      {proposal && (
        <>
          <p>
            採用前の見積と過去結果は変更していません。新しい数量は明示的に対応付けます。削除/曖昧な行は理由付き除外を選び、新しい数量から対応し直してください。
          </p>
          <ul>
            {proposal.differences.map((d) => (
              <li key={d.id}>
                {d.id}: {d.state} · {d.before ?? 'なし'} → {d.after ?? 'なし'}
              </li>
            ))}
          </ul>
          {proposal.document.quantities
            .filter((q) => q.inclusion === 'pending')
            .map((q) => {
              const difference = proposal.differences.find((d) => d.id === q.id);
              return (
                <label key={q.id}>
                  {q.name} · {q.source?.identity}
                  <select
                    aria-label={`更新数量の対応 ${q.id}`}
                    value=""
                    onChange={(e) => {
                      if (!e.target.value) return;
                      const document = structuredClone(proposal.document),
                        quantity = document.quantities.find((v) => v.id === q.id)!;
                      if (e.target.value === 'exclude') {
                        quantity.inclusion = 'exclude';
                        quantity.exclusionReason = '新版比較で利用者が明示的に対象外を選択';
                      } else {
                        quantity.inclusion = 'include';
                        const line = document.lines.find((l) => l.id === e.target.value)!;
                        if (!line.bindings.some((b) => b.quantityId === q.id))
                          line.bindings.push({ quantityId: q.id, allocationRatio: '1' });
                      }
                      setProposal({ ...proposal, document });
                    }}
                  >
                    <option value="">対応を選択</option>
                    <option value="exclude">対象外とする（理由を記録）</option>
                    {difference?.state === 'added' &&
                      proposal.document.lines.map((l) => (
                        <option key={l.id} value={l.id}>
                          費目: {l.name}
                        </option>
                      ))}
                  </select>
                </label>
              );
            })}
          <button disabled={!port.canEdit()} onClick={() => void review()}>
            新版の見積を試算
          </button>
          <button onClick={() => setProposal(undefined)}>新版提案を破棄</button>
        </>
      )}
    </section>
  );
}
