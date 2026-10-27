import { clone } from '@editor-platform/artifact-core';
import { type ReferenceItem, type ReferenceResolver } from '@editor-platform/artifact-references';
import { isDeck } from '@editor-platform/slide/model';
import { isDocument } from '@editor-platform/document/model';
import { isDesignWithPaths } from '@editor-platform/design/model';
import { isWhiteboard } from '@editor-platform/whiteboard/model';
import { assertSchedule, isSchedule } from '@editor-platform/schedule/model';
import type { Content, StoredArtifact } from './model';

/** Check a retained history in one identity scope, without resolving live sources. */
export async function validateArtifactReferenceHistory(
  artifact: Pick<StoredArtifact, 'id' | 'draft' | 'versions'>,
  resolver: ReferenceResolver,
): Promise<void> {
  const scoped = resolver.forDestination(artifact.id);
  await captureArtifactReferences(artifact.draft.content, scoped, false);
  for (const version of artifact.versions)
    await captureArtifactReferences(version.content, scoped, false);
}

export function artifactReferenceItems(content: Content): ReferenceItem[] {
  if (isDeck(content)) return content.slides.flatMap((s) => s.objects);
  if (isDocument(content)) return content.blocks;
  if (isDesignWithPaths(content)) return content.elements;
  if (isWhiteboard(content)) return content.nodes;
  if (isSchedule(content)) return content.lanes;
  return [];
}
/** A Host composes each native model with the common capture API; no universal content schema. */
export async function captureArtifactReferences(
  content: Content,
  resolver: ReferenceResolver,
  live = true,
): Promise<Content> {
  const items = artifactReferenceItems(content);
  if (!items.some((i) => i.reference)) return content;
  const captured = await resolver.capture(items, live);
  const result = clone(content);
  if (isDeck(result)) {
    let offset = 0;
    for (const page of result.slides) {
      page.objects = captured.slice(offset, offset + page.objects.length) as typeof page.objects;
      offset += page.objects.length;
    }
  } else if (isDocument(result)) result.blocks = captured as typeof result.blocks;
  else if (isDesignWithPaths(result)) result.elements = captured as typeof result.elements;
  else if (isWhiteboard(result)) result.nodes = captured as typeof result.nodes;
  // Lanes keep only their reference; the projection image is not Schedule content.
  else if (isSchedule(result)) {
    result.lanes = captured.map((item) => ({ id: item.id, reference: item.reference! }));
    // Newer captured snapshots can grow past Schedule's own limits: refuse here, not on reopen.
    assertSchedule(result);
  }
  return result;
}
