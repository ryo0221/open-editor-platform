import { canvasEngineDocument } from './canvas-text';
import {
  copy,
  fail,
  type Anchor,
  type Domain,
  type Thread,
} from '@editor-platform/collaboration-core';
import type { Annotation, ElementAddress } from '@editor-platform/editor-core';
import { contentToNode } from '@editor-platform/document/engine';
import type { DocumentContent } from '@editor-platform/document/model';
import {
  reviewRevision,
  type ReviewContent,
  type FileContent,
} from '@editor-platform/review-surfaces/model';
export function editorAnchor(domain: Domain, content: unknown, address: ElementAddress): Anchor {
  const { elementId, region } = address;
  if (domain === 'document') {
    let result: Anchor | undefined;
    contentToNode(content as DocumentContent).descendants((node, pos) => {
      if (node.attrs.id !== elementId || result) return;
      if (node.isTextblock)
        result = {
          type: 'text',
          from: pos + 1 + (region?.type === 'text' ? region.start : 0),
          to: pos + 1 + (region?.type === 'text' ? region.end : node.content.size),
        };
      else result = { type: 'text', from: pos, to: pos + node.nodeSize };
    });
    if (!result) fail('target-deleted', 'Document comment target is missing');
    return result;
  }
  if (domain === 'review') {
    const file = (content as ReviewContent).files.find((f) => f.id === elementId);
    if (!file || region?.type !== 'lines' || !region.side)
      fail('invalid-operation', 'Select a fixed comparison side');
    return {
      type: 'fixed',
      elementId,
      side: region.side,
      versionId: region.revisionId ?? reviewRevision(file, region.side),
      region: copy(region),
    };
  }
  if (domain === 'file')
    return {
      type: 'fixed',
      elementId,
      versionId: (content as FileContent).id,
      ...(region?.type === 'page' ? { page: region.page } : {}),
      ...(region ? { region: copy(region) } : {}),
    };
  if (region?.type === 'text' && ['slide', 'design', 'whiteboard'].includes(domain)) {
    const doc = canvasEngineDocument({ domain }, content, elementId);
    const position = (offset: number) => {
      let plain = 0,
        result = doc.content.size - 1;
      doc.forEach((node, pos) => {
        if (offset >= plain && offset <= plain + node.content.size)
          result = pos + 1 + offset - plain;
        plain += node.content.size + 1;
      });
      return result;
    };
    return {
      type: 'canvas-text',
      elementId,
      from: position(region.start),
      to: position(region.end),
    };
  }
  return { type: 'element', elementId, ...(region ? { region: copy(region) } : {}) };
}
export function annotationsToThreads(
  domain: Domain,
  content: unknown,
  annotations: Annotation[],
): Thread[] {
  return annotations.flatMap((annotation) =>
    annotation.anchor.addresses.map((address, i) => ({
      id: i ? `${annotation.id}-${i}` : annotation.id,
      anchor: (() => {
        try {
          return editorAnchor(domain, content, address);
        } catch {
          return domain === 'document'
            ? { type: 'text' as const, from: 0, to: 0, orphan: true }
            : { type: 'element' as const, elementId: address.elementId, orphan: true };
        }
      })(),
      resolved: annotation.resolved,
      ...(annotation.color ? { color: annotation.color } : {}),
      createdAt: annotation.createdAt,
      replies: annotation.comments.map((c) => ({
        id: c.id,
        actorId: c.author,
        text: c.body,
        createdAt: c.createdAt,
      })),
    })),
  );
}
export function threadsToAnnotations(
  artifactId: string,
  content: unknown,
  threads: Thread[],
  map: (anchor: Anchor) => Anchor = (a) => a,
): Annotation[] {
  return threads.map((thread) => {
    const anchor = map(thread.anchor);
    let address: ElementAddress = { artifactId, elementId: 'orphaned-anchor' };
    if (anchor.type === 'text') {
      const doc = contentToNode(content as DocumentContent);
      doc.descendants((node, pos) => {
        if (
          node.isTextblock &&
          anchor.from >= pos &&
          anchor.from <= pos + node.nodeSize &&
          address.elementId === 'orphaned-anchor'
        )
          address = {
            artifactId,
            elementId: node.attrs.id,
            region: {
              type: 'text',
              start: Math.max(0, anchor.from - pos - 1),
              end: Math.min(node.content.size, Math.max(0, anchor.to - pos - 1)),
              sourceText: node.textContent,
            },
          };
        else if (node.attrs.id && pos === anchor.from && address.elementId === 'orphaned-anchor')
          address = { artifactId, elementId: node.attrs.id };
      });
    } else if (anchor.type === 'canvas-text') {
      const domain =
        content && typeof content === 'object' && 'slides' in content
          ? 'slide'
          : content && typeof content === 'object' && 'elements' in content
            ? 'design'
            : 'whiteboard';
      try {
        const doc = canvasEngineDocument({ domain }, content, anchor.elementId);
        const offset = (position: number) => {
          let plain = 0,
            result = 0;
          doc.forEach((node, pos) => {
            if (position >= pos)
              result = plain + Math.min(node.content.size, Math.max(0, position - pos - 1));
            plain += node.content.size + 1;
          });
          return result;
        };
        address = {
          artifactId,
          elementId: anchor.elementId,
          region: {
            type: 'text',
            start: offset(anchor.from),
            end: offset(anchor.to),
            sourceText: doc.textBetween(0, doc.content.size, '\n'),
          },
        };
      } catch {
        address = { artifactId, elementId: `orphaned:${anchor.elementId}` };
      }
    } else
      address = {
        artifactId,
        elementId: anchor.elementId,
        ...('region' in anchor && anchor.region ? { region: copy(anchor.region) } : {}),
      };
    if (anchor.orphan) address.elementId = `orphaned:${address.elementId}`;
    const createdAt = thread.createdAt ?? '1970-01-01T00:00:00.000Z';
    return {
      id: thread.id,
      anchor: { addresses: [address] },
      resolved: thread.resolved,
      ...(thread.color ? { color: thread.color } : {}),
      createdAt,
      comments: thread.replies.map((r) => ({
        id: r.id,
        body: r.text,
        author: r.actorId,
        createdAt: r.createdAt ?? createdAt,
      })),
    };
  });
}
