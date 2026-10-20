import type { MutableRefObject } from 'react';
import { contentHash } from '@editor-platform/artifact-core';
import {
  ReferenceError,
  type ReferenceOption,
  type ReferenceResolver,
} from '@editor-platform/artifact-references';
import type { GeoDocument } from '@editor-platform/geo-core';
import { isStructuredData } from '@editor-platform/structured-data';
import { isGraphDocument, relationProfile } from '@editor-platform/structured-graph';
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
        if (isStructuredData(content)) {
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
          ? [
              {
                id: `profile:${relationProfile.id}:${relationProfile.version}`,
                content: relationProfile,
                contentHash: await contentHash(relationProfile),
              },
            ]
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
