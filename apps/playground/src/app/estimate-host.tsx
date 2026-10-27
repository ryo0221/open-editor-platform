import { playgroundEstimateQuantities, evaluateEstimateBim } from './estimate-bim';
import { estimateWorkPublication } from './estimate-publication';
import { useCallback, useRef } from 'react';
import {
  canonicalJson,
  createArtifact,
  createArtifactIfAbsent,
} from '@editor-platform/artifact-core';
import {
  EstimateSurface,
  estimateSources,
  estimateCadSources,
  estimateBimSources,
  type EstimatePort,
} from '@editor-platform/estimate';
import type { EditorInputBoundary } from '@editor-platform/editor-core';
import { isEstimate } from '@editor-platform/estimate-core';
import '@editor-platform/estimate/styles.css';
import { storage } from './records';
import type { SurfaceHost } from './editor-surfaces';
import type { StoredArtifact } from '../model';
export function PlaygroundEstimate({ host }: { host: SurfaceHost }) {
  const latest = useRef(host);
  latest.current = host;
  const permission = useRef({ value: host.readOnly, generation: 0 });
  if (permission.current.value !== host.readOnly)
    permission.current = { value: host.readOnly, generation: permission.current.generation + 1 };
  const port = useRef<EstimatePort>({
    quantityVerification: playgroundEstimateQuantities,
    read: () => {
      const content = latest.current.session!.content;
      if (!isEstimate(content)) throw Error('Not Estimate');
      return content;
    },
    revision: () =>
      canonicalJson(latest.current.sessions.current.get(latest.current.active.id)!.revision),
    generation: () => permission.current.generation,
    canEdit: () => !latest.current.readOnly && !latest.current.shared,
    canRead: () => true,
    canExport: () => true,
    inputsReady: () => !latest.current.inputs.getSnapshot().composing,
    flush: () => {
      if (!latest.current.flushInputs()) throw Error('入力を確定してください。');
    },
    execute: (command) => {
      if (!latest.current.execute(command)) throw Error('見積の変更を採用できませんでした。');
    },
  }).current;
  // Re-registering a dirty boundary changes the Host snapshot and can loop renders.
  const registerInput = useCallback(
    (boundary: EditorInputBoundary) => host.inputs.register(boundary),
    [host.inputs],
  );
  return (
    <EstimateSurface
      port={port}
      publication={estimateWorkPublication(() => latest.current, port)}
      sources={estimateSources([...host.savedRecords.current.values()])}
      quantitySources={estimateCadSources([...host.savedRecords.current.values()])}
      bimSources={estimateBimSources([...host.savedRecords.current.values()])}
      evaluateBim={evaluateEstimateBim}
      registerInput={registerInput}
      save={async () => {
        const before = host.savedRecords.current.get(host.active.id)?.versions.length ?? 0;
        await host.saveVersion();
        if ((host.savedRecords.current.get(host.active.id)?.versions.length ?? 0) <= before)
          throw Error('保存できませんでした。内容を保持して再試行してください。');
      }}
      history={(direction) => host.history(direction)}
      select={(id) => host.select(id)}
      openSource={(id) => {
        host.activate(id);
      }}
      copyData={async (data, requestId) => {
        const record: StoredArtifact = {
          ...createArtifact('data', '見積結果（静的コピー・decimalはtext）', data),
          id: requestId,
          annotations: [],
        };
        const saved = await createArtifactIfAbsent(storage, record, canonicalJson(data), (stored) =>
          canonicalJson(stored.draft.content),
        );
        if ((await host.persist(saved)) !== true)
          throw Error(
            'Dataは作成済みですが一覧への保存が未完了です。同じ計算で再試行してください。',
          );
        host.setStatus('通常Dataへ静的コピーしました。');
      }}
    />
  );
}
