import { useEditorDraftPort } from '../editor-draft-port';
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
import { estimateKind } from '@editor-platform/estimate/kind';
import type { GeometryQuantitySources } from '@editor-platform/calculation-core';
import '@editor-platform/estimate/styles.css';
import { estimateWorkPublication } from '../../app/estimate-publication';
import { storage } from '../../app/records';
import type { StoredArtifact } from '../../model';
import { hostKind } from '../host-kind';
import type { SurfaceHost } from '../surface-host';
function PlaygroundEstimate({
  host,
  geometry,
}: {
  host: SurfaceHost;
  geometry: GeometryQuantitySources | undefined;
}) {
  const draft = useEditorDraftPort(host);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const latest = useRef(host);
  latest.current = host;
  const permission = useRef({ value: host.readOnly, generation: 0 });
  if (permission.current.value !== host.readOnly)
    permission.current = { value: host.readOnly, generation: permission.current.generation + 1 };
  const port = useRef<EstimatePort>({
    quantityVerification: geometry?.verification,
    read: () => {
      const content = latest.current.session!.content;
      if (!isEstimate(content)) throw Error('Not Estimate');
      return content;
    },
    revision: () => canonicalJson(draftRef.current.revision),
    generation: () => permission.current.generation,
    canEdit: () => !latest.current.readOnly,
    canRead: () => true,
    canExport: () => {
      try {
        latest.current.exportGuard?.();
        return true;
      } catch {
        return false;
      }
    },
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
      canAdoptResults={!host.shared}
      publication={host.shared ? undefined : estimateWorkPublication(() => latest.current, port)}
      sources={host.shared ? [] : estimateSources([...host.savedRecords.current.values()])}
      quantitySources={host.shared ? [] : estimateCadSources([...host.savedRecords.current.values()])}
      bimSources={host.shared ? [] : estimateBimSources([...host.savedRecords.current.values()])}
      geometry={host.shared ? undefined : geometry}
      registerInput={registerInput}
      save={async () => {
        const versionCount = () =>
          host.sharedSession?.savedVersions.length ??
          host.savedRecords.current.get(host.active.id)?.versions.length ??
          0;
        const before = versionCount();
        await host.saveVersion();
        if (versionCount() <= before)
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

/**
 * Estimate with the Host's CAD/BIM quantity reading. The office list does not import engineering
 * code: the reading comes from kinds/engineering/surfaces.ts through kinds/surfaces.tsx, and
 * without it the quantity panels are not shown.
 */
export function estimateSurface(geometry: GeometryQuantitySources | undefined) {
  return hostKind(estimateKind, {
    Surface: ({ host }) => <PlaygroundEstimate host={host} geometry={geometry} />,
      hooks: {
        comments: false,
    },
  });
}
