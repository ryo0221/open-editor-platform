import { artifactEstimateQuantities, evaluateEstimateBim } from './estimate-bim';
import { useRef } from 'react';
import {
  canonicalJson,
  createArtifact,
  createArtifactIfAbsent,
  type Artifact,
  type StorageAdapter,
} from '@editor-platform/artifact-core';
import type { ArtifactEditor } from '@editor-platform/editor-host';
import {
  EstimateSurface,
  estimateSources,
  estimateCadSources,
  estimateBimSources,
  type EstimatePort,
} from '@editor-platform/estimate';
import { isEstimate } from '@editor-platform/estimate-core';
import '@editor-platform/estimate/styles.css';
import { domainExecute, type HostContent } from './model';
export function ArtifactEstimate({
  host,
  artifacts,
  storage,
  onCreated,
}: {
  host: ArtifactEditor<HostContent>;
  artifacts: Artifact<HostContent>[];
  storage: StorageAdapter<Artifact<HostContent>>;
  onCreated(a: Artifact<HostContent>): void;
}) {
  const permission = useRef({ value: host.snapshot.readOnly, generation: 0 });
  if (permission.current.value !== host.snapshot.readOnly)
    permission.current = {
      value: host.snapshot.readOnly,
      generation: permission.current.generation + 1,
    };
  const port: EstimatePort = {
    quantityVerification: artifactEstimateQuantities,
    read: () => {
      const c = host.content;
      if (!isEstimate(c)) throw Error('Not Estimate');
      return c;
    },
    revision: () => canonicalJson(host.revision),
    generation: () => permission.current.generation,
    canRead: () => true,
    canEdit: () => !host.snapshot.readOnly,
    canExport: () => true,
    inputsReady: () => true,
    flush: () => host.flushInputs(),
    execute: domainExecute(host, isEstimate),
  };
  return (
    <EstimateSurface
      port={port}
      sources={estimateSources(artifacts)}
      quantitySources={estimateCadSources(artifacts)}
      bimSources={estimateBimSources(artifacts)}
      evaluateBim={evaluateEstimateBim}
      registerInput={(boundary) =>
        host.registerInputBoundary(() => {
          if (boundary.read().composing) throw Error('IME変換を確定してください。');
          boundary.prepare()();
        })
      }
      save={async () => {
        const result = await host.save({ commitVersion: true });
        onCreated(result.artifact);
      }}
      history={(d) => (d === 'undo' ? host.undo() : host.redo())}
      copyData={async (content, id) => {
        const created = await createArtifactIfAbsent(
          storage,
          { ...createArtifact<HostContent>('data', '見積結果（静的コピー）', content), id },
          canonicalJson(content),
          (a) => canonicalJson(a.draft.content),
        );
        onCreated(created);
      }}
    />
  );
}
