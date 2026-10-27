import { useState, useRef, useEffect } from 'react';
import { newId } from '@editor-platform/artifact-core';
import { isBimDocument } from '@editor-platform/bim-core';
import { pinKey } from '@editor-platform/calculation-core';
import type { EstimateDocument, RetainedSource } from '@editor-platform/estimate-core';
import type { EstimatePort } from './host';
import type { EstimateGeometrySourceOption } from './sources';
import {
  retainBimSource,
  bimQuantity,
  type EstimateBimMetric,
  type EstimateBimEvaluator,
} from './bim-source';
import { retainCadSource } from './cad-source';
export function EstimateBimPanel({
  port,
  sources,
  evaluate,
  edit,
  trial,
}: {
  port: EstimatePort;
  sources: EstimateGeometrySourceOption[];
  evaluate?: EstimateBimEvaluator;
  edit(next: EstimateDocument, label: string): void;
  trial(next: EstimateDocument): Promise<void>;
}) {
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => request.current?.abort(), []);
  const [selected, setSelected] = useState(0),
    [element, setElement] = useState(''),
    [metric, setMetric] = useState<EstimateBimMetric>('netVolume'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const option = sources[selected],
    native = option && isBimDocument(option.content) ? option.content : undefined;
  const retain = async (input: EstimateGeometrySourceOption) => {
    if (!isBimDocument(input.content)) throw Error('invalid-bim-source');
    const collected = new Map<string, RetainedSource>();
    for (const type of input.content.types)
      if (type.kind === 'part') {
        const content = input.closure.find(
          (c) => c.contentHash === type.source.contentHash,
        )?.content;
        if (!content) throw Error('missing-bim-cad-closure');
        for (const source of await retainCadSource(
          { domain: 'cad', ...type.source },
          content,
          (h) => input.closure.find((c) => c.contentHash === h)?.content,
        ))
          collected.set(source.key, source);
      }
    const root = await retainBimSource(input.pin, input.content, [...collected.values()]);
    collected.set(root.key, root);
    const sources = [...collected.values()];
    if (sources.some((s) => !port.canRead(s.pin))) throw Error('source-access-denied');
    return { root, sources };
  };
  const prepare = async (oldKey?: string) => {
    request.current?.abort();
    const abort = new AbortController();
    request.current = abort;
    setBusy(true);
    setError('');
    try {
      port.flush();
      if (!port.canEdit() || !port.inputsReady()) throw Error('read-only-or-input-pending');
      const revision = port.revision(),
        generation = port.generation(),
        base = structuredClone(port.read());
      const old = oldKey ? base.retainedSources.find((s) => s.key === oldKey) : undefined;
      const input = old
        ? sources.find(
            (s) =>
              s.latest &&
              s.pin.artifactId === old.pin.artifactId &&
              s.pin.versionId !== old.pin.versionId,
          )
        : option;
      if (!input) throw Error('保存版を選択してください。新版がない場合は更新しません。');
      if (!port.canRead(input.pin)) throw Error('source-access-denied');
      const retained = await retain(input);
      const merged = new Map(base.retainedSources.map((s) => [s.key, s]));
      for (const source of retained.sources) merged.set(source.key, source);
      const next = { ...base, retainedSources: [...merged.values()] };
      if (oldKey) {
        for (const q of next.quantities)
          if (q.source?.snapshotKey === oldKey) {
            const updated = await bimQuantity(
              retained.root,
              q.source.identity,
              q.source.metric as EstimateBimMetric,
              q.id,
              evaluate,
              abort.signal,
            );
            q.value = updated.value;
            q.unit = updated.unit;
            q.quality = updated.quality;
            q.source = updated.source;
          }
      } else
        next.quantities.push(
          await bimQuantity(
            retained.root,
            element,
            metric,
            newId('quantity'),
            evaluate,
            abort.signal,
          ),
        );
      if (abort.signal.aborted) throw Error('cancelled');
      port.flush();
      if (revision !== port.revision() || generation !== port.generation() || !port.canEdit())
        throw Error('stale-bim-evaluation');
      if (retained.sources.some((s) => !port.canRead(s.pin))) throw Error('source-access-denied');
      if (oldKey) await trial(next);
      else edit(next, 'Adopt BIM quantity');
    } catch (e) {
      if (request.current === abort) setError(String(e));
    } finally {
      if (request.current === abort) setBusy(false);
    }
  };
  const oldKeys = [
    ...new Set(
      port
        .read()
        .quantities.filter((q) => q.quality === 'analytic' || q.quality === 'kernel')
        .map((q) => q.source!.snapshotKey),
    ),
  ];
  return (
    <section aria-label="BIM数量の取得">
      <h3>保存BIMから数量を取得</h3>
      <p>
        要素IDとmetricを明示選択します。提供されないmetric、未計算、古いkernel結果は拒否します。grossとnetを代用しません。
      </p>
      <fieldset disabled={!port.canEdit() || busy}>
        <label>
          数量BIMの保存版
          <select
            value={selected}
            onChange={(e) => {
              setSelected(Number(e.target.value));
              setElement('');
            }}
          >
            {!sources.length && <option>保存BIMなし</option>}
            {sources.map((s, i) => (
              <option key={pinKey(s.pin)} value={i}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          BIM要素
          <select value={element} onChange={(e) => setElement(e.target.value)}>
            <option value="">選択</option>
            {native?.elements.map((el) => (
              <option key={el.id} value={el.id}>
                {el.name ?? el.id} · {el.kind}
              </option>
            ))}
          </select>
        </label>
        <label>
          数量metric
          <select value={metric} onChange={(e) => setMetric(e.target.value as EstimateBimMetric)}>
            {['length', 'grossArea', 'netArea', 'grossVolume', 'netVolume'].map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <button onClick={() => void prepare()}>BIM数量を取得・追加</button>
        {oldKeys.map((key) => {
          const old = port.read().retainedSources.find((s) => s.key === key)!;
          return (
            sources.some(
              (s) =>
                s.latest &&
                s.pin.artifactId === old.pin.artifactId &&
                s.pin.versionId !== old.pin.versionId,
            ) && (
              <button key={key} onClick={() => void prepare(key)}>
                BIM新版で試算（旧版 {old.pin.versionId}）
              </button>
            )
          );
        })}
      </fieldset>
      {busy && (
        <>
          <p role="status">保存版の数量を検証しています…</p>
          <button
            onClick={() => {
              request.current?.abort();
              setBusy(false);
            }}
          >
            BIM数量取得を取消
          </button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
