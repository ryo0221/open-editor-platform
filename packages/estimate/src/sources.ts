import type { Artifact } from '@editor-platform/artifact-core';
import { isStructuredData } from '@editor-platform/structured-data/model';
import type { SourcePin } from '@editor-platform/calculation-core';
export { retainPriceData, priceValue } from '@editor-platform/estimate-core';
export interface EstimateSourceOption {
  label: string;
  pin: SourcePin;
  content: unknown;
  latest: boolean;
}
export function estimateSources(artifacts: readonly Artifact<unknown>[]): EstimateSourceOption[] {
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
/** Host-owned saved CAD closure; no live geometry or kernel instance enters the Estimate model. */
export interface EstimateGeometrySourceOption extends EstimateSourceOption {
  closure: { contentHash: string; content: unknown }[];
}
export function estimateCadSources(
  artifacts: readonly (Artifact<unknown> & {
    cadParts?: { contentHash: string; content: unknown }[];
  })[],
): EstimateGeometrySourceOption[] {
  const saved = artifacts
    .filter((a) => a.kind === 'cad')
    .flatMap((a) => a.versions.map((v) => ({ contentHash: v.contentHash, content: v.content })));
  return artifacts
    .filter((a) => a.kind === 'cad')
    .flatMap((a) =>
      a.versions.map((v, i) => ({
        label: `${a.name} · 版 ${i + 1}`,
        pin: {
          artifactId: a.id,
          domain: 'cad' as const,
          versionId: v.versionId,
          contentHash: v.contentHash,
        },
        content: v.content,
        latest: i === a.versions.length - 1,
        closure: [...saved, ...(a.cadParts ?? [])],
      })),
    );
}
export function estimateBimSources(
  artifacts: readonly (Artifact<unknown> & {
    cadParts?: { contentHash: string; content: unknown }[];
  })[],
): EstimateGeometrySourceOption[] {
  const saved = artifacts
    .filter((a) => a.kind === 'cad')
    .flatMap((a) => a.versions.map((v) => ({ contentHash: v.contentHash, content: v.content })));
  return artifacts
    .filter((a) => a.kind === 'bim')
    .flatMap((a) =>
      a.versions.map((v, i) => ({
        label: `${a.name} · 版 ${i + 1}`,
        pin: {
          artifactId: a.id,
          domain: 'bim' as const,
          versionId: v.versionId,
          contentHash: v.contentHash,
        },
        content: v.content,
        latest: i === a.versions.length - 1,
        closure: [...saved, ...(a.cadParts ?? [])],
      })),
    );
}
