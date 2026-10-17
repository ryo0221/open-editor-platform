import { clone } from '@editor-platform/artifact-core';
import { type ReferenceItem, type ReferenceResolver } from '@editor-platform/artifact-references';
import { isDeck } from '@editor-platform/slide/model';
import { isDocument } from '@editor-platform/document/model';
import { isDesign } from '@editor-platform/design/model';
import { isWhiteboard } from '@editor-platform/whiteboard/model';
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
  if (isDesign(content)) return content.elements;
  if (isWhiteboard(content)) return content.nodes;
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
  else if (isDesign(result)) result.elements = captured as typeof result.elements;
  else if (isWhiteboard(result)) result.nodes = captured as typeof result.nodes;
  return result;
}
