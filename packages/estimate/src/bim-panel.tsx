import { useState, useRef, useEffect } from 'react';
import { newId } from '@editor-platform/artifact-core';
import {
  pinKey,
  type BimQuantityMetric,
  type GeometryQuantitySources,
  type SourceElement,
} from '@editor-platform/calculation-core';
import type { EstimateDocument } from '@editor-platform/estimate-core';
import type { EstimatePort } from './host';
import type { EstimateGeometrySourceOption } from './sources';
import { measuredQuantity } from './geometry-quantities';
import { useStatusProps } from './status-role';
export function EstimateBimPanel({
  port,
  sources,
  geometry,
  edit,
  trial,
}: {
  port: EstimatePort;
  sources: EstimateGeometrySourceOption[];
  geometry: GeometryQuantitySources;
  edit(next: EstimateDocument, label: string): void;
  trial(next: EstimateDocument): Promise<void>;
}) {
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => request.current?.abort(), []);
  const [selected, setSelected] = useState(0),
    [element, setElement] = useState(''),
    [metric, setMetric] = useState<BimQuantityMetric>('netVolume'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const notice = useStatusProps();
  const option = sources[selected];
  const [elements, setElements] = useState<SourceElement[]>();
  useEffect(() => {
    let live = true;
    setElements(undefined);
    if (option)
      void geometry.bimElements(option.content).then(
        (found) => live && setElements(found),
        () => live && setElements(undefined),
      );
    return () => {
      live = false;
    };
  }, [geometry, option]);
  const retain = async (input: EstimateGeometrySourceOption) => {
    const retained = await geometry.retainBim(input);
    if (retained.sources.some((s) => !port.canRead(s.pin))) throw Error('source-access-denied');
    return retained;
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
            const updated = await geometry.measureBim(
              retained.root,
              q.source.identity,
              q.source.metric as BimQuantityMetric,
              abort.signal,
            );
            q.value = updated.value;
            q.unit = updated.unit;
            q.quality = updated.quality;
            q.source = updated.source;
          }
      } else
        next.quantities.push(
          measuredQuantity(
            await geometry.measureBim(retained.root, element, metric, abort.signal),
            newId('quantity'),
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
            {elements?.map((el) => (
              <option key={el.id} value={el.id}>
                {el.name ?? el.id} · {el.kind}
              </option>
            ))}
          </select>
        </label>
        <label>
          数量metric
          <select value={metric} onChange={(e) => setMetric(e.target.value as BimQuantityMetric)}>
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
          <p {...notice}>保存版の数量を検証しています…</p>
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
