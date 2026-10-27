import { useRef } from 'react';
import {
  canonicalJson,
  createArtifact,
  createArtifactIfAbsent,
  type Artifact,
  type StorageAdapter,
} from '@editor-platform/artifact-core';
import type { ArtifactEditor } from '@editor-platform/editor-host';
import { AnalysisSurface, analysisSources, type AnalysisPort } from '@editor-platform/analysis';
import { isAnalysis } from '@editor-platform/analysis-core';
import '@editor-platform/analysis/styles.css';
import { domainExecute, type HostContent } from './model';
export function ArtifactAnalysis({
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
  const port: AnalysisPort = {
    read: () => {
      const c = host.content;
      if (!isAnalysis(c)) throw Error('Not Analysis');
      return c;
    },
    revision: () => canonicalJson(host.revision),
    generation: () => permission.current.generation,
    canRead: () => true,
    canEdit: () => !host.snapshot.readOnly,
    canExport: () => true,
    inputsReady: () => true,
    flush: () => host.flushInputs(),
    execute: domainExecute(host, isAnalysis),
  };
  return (
    <AnalysisSurface
      port={port}
      sources={analysisSources(artifacts)}
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
          { ...createArtifact<HostContent>('data', '分析結果（静的コピー）', content), id },
          canonicalJson(content),
          (a) => canonicalJson(a.draft.content),
        );
        onCreated(created);
      }}
    />
  );
}
