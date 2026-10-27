import { isEstimate, makeEstimateBasis } from '@editor-platform/estimate-core';
import { isAnalysis, makeBasis } from '@editor-platform/analysis-core';
import type { MutableRefObject } from 'react';
import { contentHash, canonicalJson } from '@editor-platform/artifact-core';
import {
  ReferenceError,
  type ReferenceOption,
  type ReferenceResolver,
} from '@editor-platform/artifact-references';
import type { GeoDocument } from '@editor-platform/geo-core';
import { isStructuredData } from '@editor-platform/structured-data';
import {
  isGraphDocument,
  relationProfile,
  type GraphProfile,
} from '@editor-platform/structured-graph';
import { graphProfileFor } from './graph-templates';

/** The saved Graph's Profile, pinned as the reference's one dependency. */
const graphProfileDependency = async (profile: GraphProfile) => [
  {
    id: `profile:${profile.id}:${profile.version}`,
    content: profile,
    contentHash: await contentHash(profile),
  },
];
import { validContent, type StoredArtifact } from '../model';

type ReferenceSource = ConstructorParameters<typeof ReferenceResolver>[0];

/**
 * Exposes the latest saved version of data, Geo and Graph artifacts as embeddable
 * reference sources. Drafts are never referenced.
 */
export function savedRecordReferences(context: {
  saved: MutableRefObject<Map<string, StoredArtifact>>;
  notifications: MutableRefObject<Set<(id: string) => void>>;
  navigation: MutableRefObject<(sourceId: string, elementId: string, pageId?: string) => boolean>;
}): ReferenceSource {
  return {
    async list() {
      const options: ReferenceOption[] = [];
      for (const a of context.saved.current.values()) {
        const content = a.versions.at(-1)?.content;
        if (isEstimate(content)) {
          const add = (id: string | null, baseline: string | null, label: string) => {
            for (const kind of ['table', 'chart'])
              options.push({
                label: `${a.name} · ${label} · ${kind}`,
                source: {
                  artifactId: a.id,
                  domain: 'estimate',
                  target: { kind, viewId: JSON.stringify([id, baseline]) },
                },
              });
          };
          if (
            content.calculations.some((c) => {
              try {
                return (
                  canonicalJson(c.basis) ===
                  canonicalJson(makeEstimateBasis(content, c.basis.scenarioId))
                );
              } catch {
                return false;
              }
            })
          )
            add(null, null, '現在の見積');
          for (const c of content.calculations) add(c.id, null, `計算 ${c.id}`);
          // Explicit views, never implicit truncation. Selected stable row IDs stay fixed on follow.
          for (const id of [null, ...content.calculations.map((c) => c.id)]) {
            const c =
              id === null
                ? [...content.calculations].reverse().find((c) => {
                    try {
                      return (
                        canonicalJson(c.basis) ===
                        canonicalJson(makeEstimateBasis(content, c.basis.scenarioId))
                      );
                    } catch {
                      return false;
                    }
                  })
                : content.calculations.find((c) => c.id === id);
            if (!c) continue;
            const label = id === null ? '現在の見積' : `計算 ${id}`;
            for (const kind of ['table', 'chart'])
              options.push({
                label: `${a.name} · ${label} · 区分別集計・調整・合計 · ${kind}`,
                source: {
                  artifactId: a.id,
                  domain: 'estimate',
                  target: { kind, viewId: JSON.stringify([id, null, 'summary']) },
                },
              });
            if (c.result.lines.length > 100) {
              const ids = c.basis.lines
                .filter((l) => c.result.lines.some((r) => r.id === l.id))
                .map((l) => JSON.stringify(['line', l.id]));
              for (let start = 0; start < ids.length; start += 100)
                options.push({
                  label: `${a.name} · ${label} · 分割明細 ${start + 1}〜${Math.min(start + 100, ids.length)} / ${ids.length}費目（合計別） · table`,
                  source: {
                    artifactId: a.id,
                    domain: 'estimate',
                    target: {
                      kind: 'table',
                      viewId: JSON.stringify([id, null]),
                      rowIds: ids.slice(start, start + 100),
                    },
                  },
                });
            }
          }
          for (let i = 1; i < content.calculations.length; i++)
            add(content.calculations[i].id, content.calculations[i - 1].id, `比較 ${i}→${i + 1}`);
        } else if (isAnalysis(content)) {
          for (const output of content.outputs)
            if (
              content.runs.some(
                (r) =>
                  r.results[output.id] &&
                  canonicalJson(r.basis) === canonicalJson(makeBasis(content, r.basis.scenarioId)),
              )
            )
              for (const kind of ['table', 'chart'])
                options.push({
                  label: `${a.name} · 現在の結果 · ${output.id} · ${kind}`,
                  source: {
                    artifactId: a.id,
                    domain: 'analysis',
                    target: { kind, viewId: JSON.stringify([null, output.id]) },
                  },
                });
          for (const run of content.runs)
            for (const outputId of Object.keys(run.results))
              for (const kind of ['table', 'chart'])
                options.push({
                  label: `${a.name} · ${run.id} · ${outputId} · ${kind}`,
                  source: {
                    artifactId: a.id,
                    domain: 'analysis',
                    target: { kind, viewId: JSON.stringify([run.id, outputId]) },
                  },
                });
        } else if (isStructuredData(content)) {
          const views = [{ id: 'default', name: 'Default view' }, ...(content.views ?? [])];
          for (const view of views)
            for (const kind of ['table', 'chart'])
              options.push({
                label: `${a.name} · ${view.name} · ${kind}`,
                source: {
                  artifactId: a.id,
                  domain: 'data',
                  target: { kind, viewId: view.id },
                },
              });
        } else if (a.kind === 'geo' && validContent('geo', content)) {
          for (const view of [
            { id: 'default', name: 'Current map' },
            ...((content as GeoDocument).workspace?.views ?? []),
          ])
            options.push({
              label: `${a.name} · ${view.name} · Map`,
              source: {
                artifactId: a.id,
                domain: 'geo',
                target: { kind: 'map', viewId: view.id },
              },
            });
        } else if (isGraphDocument(content))
          options.push({
            label: `${a.name} · Graph`,
            source: {
              artifactId: a.id,
              domain: 'structured-graph',
              target: { kind: 'graph', viewId: content.id },
            },
          });
      }
      return options;
    },
    async read(source) {
      const a = context.saved.current.get(source.artifactId);
      if (!a || a.kind !== source.domain)
        throw new ReferenceError('missing-source', '保存済みの参照元が見つかりません。');
      const version = a.versions.at(-1);
      if (!version)
        throw new ReferenceError('missing-source', '参照元をversionとして保存してください。');
      return {
        artifactId: a.id,
        domain: a.kind,
        versionId: version.versionId,
        revision: a.versions.length,
        contentHash: version.contentHash,
        content: version.content,
        dependencies: isGraphDocument(version.content)
          ? await graphProfileDependency(graphProfileFor(version.content) ?? relationProfile)
          : [],
      };
    },
    subscribe(listener) {
      context.notifications.current.add(listener);
      return () => {
        context.notifications.current.delete(listener);
      };
    },
    open(source, elementId, pageId) {
      context.navigation.current(source.artifactId, elementId, pageId);
    },
  };
}
