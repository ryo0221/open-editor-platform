import type { FictionMapContent } from '@editor-platform/fiction-map/model';
import { isEstimate, makeEstimateBasis } from '@editor-platform/estimate-core';
import { isAnalysis, makeBasis } from '@editor-platform/analysis-core';
import type { MutableRefObject } from 'react';
import { contentHash, canonicalJson, deepFreeze } from '@editor-platform/artifact-core';
import {
  ReferenceError,
  type ReferenceOption,
  type ReferenceResolver,
  type ReferenceSnapshot,
} from '@editor-platform/artifact-references';
import type { LiveReferenceConnection } from '@editor-platform/artifact-references/react';
import { ExtensionRegistry } from '@editor-platform/extension-runtime';
import { counterReferenceExtension } from '@editor-platform/extension-sample';
import counterEntrySource from '@editor-platform/extension-sample?raw';
import type { GeoDocument } from '@editor-platform/geo-core';
import { isStructuredData } from '@editor-platform/structured-data';
import { isMindmap } from '@editor-platform/mindmap-core';
import {
  upgradeGraphDocument,
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

const counterArtifactId = 'playground.sample-counter';
let counterSource: ReturnType<typeof loadCounterSource> | undefined;

async function loadCounterSource() {
  // The Editor is a trusted static import. This pin fingerprints its bundled entry source.
  const packageHash = `sha256:${await contentHash(counterEntrySource)}`;
  const registration = new ExtensionRegistry().install(counterReferenceExtension(packageHash), {
    trust: 'trusted',
    verifiedPackageHash: packageHash,
  });
  const domain = registration.manifest.artifactKind;
  const adapter = registration.references;
  if (!adapter) throw new Error('引用元 Editor の引用機能が見つかりません。');
  const artifact = { artifactId: counterArtifactId, domain, label: 'Counter サンプル' };
  const versions = await Promise.all(
    [20, 60].map(async (value, index): Promise<ReferenceSnapshot> => {
      const revision = index + 1;
      const content = { id: 'counter', value };
      return deepFreeze({
        artifactId: artifact.artifactId,
        domain,
        versionId: `counter-v${revision}`,
        revision,
        content,
        contentHash: await contentHash(content),
        dependencies: [],
      });
    }),
  );
  return { artifact, versions, adapter };
}

/** A local catalog of the bundled external Editor's immutable example versions. */
export function savedExtensionReferences(destinationArtifactId: string): LiveReferenceConnection {
  const load = () => (counterSource ??= loadCounterSource());
  async function accessibleSource(source: { artifactId: string; domain: string }) {
    const catalog = await load();
    if (source.artifactId === destinationArtifactId)
      throw new ReferenceError('forbidden', '同じ成果物からは引用できません。');
    if (
      source.artifactId !== catalog.artifact.artifactId ||
      source.domain !== catalog.artifact.domain
    )
      throw new ReferenceError('missing-source', '保存済みの引用元が見つかりません。');
    return catalog;
  }
  async function retainedVersion(snapshot: ReferenceSnapshot) {
    const { versions, adapter } = await accessibleSource(snapshot);
    const retained = versions.find((version) => version.versionId === snapshot.versionId);
    if (!retained)
      throw new ReferenceError('missing-target', '引用元の保存済み版が見つかりません。');
    if (canonicalJson(retained) !== canonicalJson(snapshot))
      throw new ReferenceError('stale', '引用元の保存済み版と内容が一致しません。');
    return { retained, adapter };
  }
  return {
    destinationArtifactId,
    async listArtifacts() {
      const { artifact } = await load();
      return artifact.artifactId === destinationArtifactId ? [] : [{ ...artifact }];
    },
    async listVersions(artifact) {
      return [...(await accessibleSource(artifact)).versions];
    },
    async latest(reference) {
      const { versions } = await accessibleSource(reference.source);
      return versions[versions.length - 1];
    },
    provider: {
      async checkAccess(source) {
        await accessibleSource(source);
      },
      async checkSnapshot(source, snapshot) {
        if (source.artifactId !== snapshot.artifactId || source.domain !== snapshot.domain)
          throw new ReferenceError('stale', '引用元と保存済み版が一致しません。');
        await retainedVersion(snapshot);
      },
      async list(snapshot) {
        const { retained, adapter } = await retainedVersion(snapshot);
        return [...adapter.list(retained)];
      },
      async resolve(snapshot, target) {
        const { retained, adapter } = await retainedVersion(snapshot);
        return adapter.resolve(retained, target);
      },
    },
  };
}

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
    async checkSnapshot(source, snapshot) {
      if (source.domain !== 'fiction-map') return;
      const artifact = context.saved.current.get(source.artifactId);
      if (!artifact || artifact.kind !== 'fiction-map')
        throw new ReferenceError('missing-source', 'Saved Fiction Map is missing');
      const version = artifact.versions.find((v) => v.versionId === snapshot.versionId);
      if (!version)
        throw new ReferenceError('missing-target', 'Saved Fiction Map version is missing');
      if (
        version.contentHash !== snapshot.contentHash ||
        canonicalJson(version.content) !== canonicalJson(snapshot.content) ||
        (await contentHash(version.content)) !== snapshot.contentHash
      )
        throw new ReferenceError(
          'stale',
          'Saved Fiction Map version/hash contradicts the reference',
        );
      // Hashing may yield while a saved source is removed/replaced. Never accept that old read.
      const current = context.saved.current.get(source.artifactId);
      if (!current || current.kind !== 'fiction-map')
        throw new ReferenceError('missing-source', 'Saved Fiction Map is missing');
      const retained = current.versions.find((v) => v.versionId === snapshot.versionId);
      if (!retained)
        throw new ReferenceError('missing-target', 'Saved Fiction Map version is missing');
      if (
        retained.contentHash !== snapshot.contentHash ||
        canonicalJson(retained.content) !== canonicalJson(snapshot.content)
      )
        throw new ReferenceError('stale', 'Saved Fiction Map changed during verification');
    },
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
        } else if (a.kind === 'fiction-map' && validContent('fiction-map', content)) {
          options.push({
            label: `${a.name} · Document bounds · Fiction Map`,
            source: {
              artifactId: a.id,
              domain: 'fiction-map',
              target: { kind: 'fiction-map-document', viewId: 'document' },
            },
          });
          for (const view of (content as FictionMapContent).namedViews)
            options.push({
              label: `${a.name} · ${view.name} · Fiction Map`,
              source: {
                artifactId: a.id,
                domain: 'fiction-map',
                target: { kind: 'fiction-map-view', viewId: view.id },
              },
            });
        } else if (a.kind === 'mindmap' && isMindmap(content)) {
          options.push({
            label: `${a.name} · 地図全体 · Mind Map`,
            source: {
              artifactId: a.id,
              domain: 'mindmap',
              target: { kind: 'mindmap', viewId: 'map' },
            },
          });
          for (const id of content.nodes[content.rootId].children)
            options.push({
              label: `${a.name} · ${content.nodes[id].text || '（無題）'} · 枝`,
              source: {
                artifactId: a.id,
                domain: 'mindmap',
                target: { kind: 'mindmap-branch', viewId: 'map', nodeIds: [id] },
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
        } else if (upgradeGraphDocument(content))
          options.push({
            label: `${a.name} · Graph`,
            source: {
              artifactId: a.id,
              domain: 'structured-graph',
              target: { kind: 'graph', viewId: upgradeGraphDocument(content)!.id },
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
        dependencies: upgradeGraphDocument(version.content)
          ? await graphProfileDependency(
              graphProfileFor(upgradeGraphDocument(version.content)!) ?? relationProfile,
            )
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
