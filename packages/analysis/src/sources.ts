export { retainData, projectData, verifyRetainedSource } from '@editor-platform/analysis-core';
import type { Artifact } from '@editor-platform/artifact-core';
import { isStructuredData } from '@editor-platform/structured-data/model';
import type { SourcePin } from '@editor-platform/calculation-core';
export interface AnalysisSourceOption {
  label: string;
  pin: SourcePin;
  content: unknown;
  latest: boolean;
}
export function analysisSources(artifacts: readonly Artifact<unknown>[]): AnalysisSourceOption[] {
  return artifacts
    .filter((a) => a.kind === 'data')
    .flatMap((a) =>
      a.versions
        .filter((v) => isStructuredData(v.content))
        .map((v, i) => ({
          label: `${a.name} · 版 ${i + 1}`,
          pin: {
            artifactId: a.id,
            domain: 'data' as const,
            versionId: v.versionId,
            contentHash: v.contentHash,
          },
          content: v.content,
          latest: i === a.versions.length - 1,
        })),
    );
}
