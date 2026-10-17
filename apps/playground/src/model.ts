import { containsEmbeddedReference } from '@editor-platform/artifact-references';
import { EditorSession, type EditorCommand } from '@editor-platform/editor-core';
import { guardDataCommand, assertDataReadable } from '@editor-platform/structured-data/session';
import {
  createRelationGraph,
  isGraphDocument,
  relationProfile,
  assertGraph,
  guardGraphCommand,
  type GraphDocument,
} from '@editor-platform/structured-graph/model';
import { createArtifact, type Artifact } from '@editor-platform/artifact-core';
import {
  type Annotation,
  type ElementAddress,
  type ExternalOperationRequest,
  type ProposedCommands,
  command,
} from '@editor-platform/editor-core';
import {
  createDocument,
  isDocument,
  resolveDocumentAddress,
  type DocumentContent,
} from '@editor-platform/document';
import {
  createData,
  isStructuredData,
  type StructuredData,
} from '@editor-platform/structured-data';
import {
  createFile,
  createReview,
  isFile,
  isReview,
  reviewAnchorState,
  originalBytes,
  type FileContent,
  type ReviewContent,
} from '@editor-platform/review-surfaces';
import {
  createWhiteboard,
  isWhiteboard,
  type WhiteboardContent,
} from '@editor-platform/whiteboard';
import { createDesign, isDesign, type DesignContent } from '@editor-platform/design';
import { createDeck, isDeck, type SlideContent } from '@editor-platform/slide';
import { isReactUiDocument, type ReactUiDocument } from '@editor-platform/react-ui-core';
import { createReferenceDocument } from '../../react-ui-reference/src/catalog';
export type Content =
  | GraphDocument
  | ReactUiDocument
  | DocumentContent
  | StructuredData
  | ReviewContent
  | FileContent
  | WhiteboardContent
  | DesignContent
  | SlideContent;
export type Kind =
  | 'structured-graph'
  | 'document'
  | 'data'
  | 'review'
  | 'file'
  | 'whiteboard'
  | 'design'
  | 'slide'
  | 'react-ui';
export interface StoredArtifact extends Artifact<Content> {
  annotations: Annotation[];
  /** Reference Host conversion receipt: an immutable baseline for explicit three-way review. */
  designReactConversion?: { sourceArtifactId: string; sourceHash: string; basis: ReactUiDocument };
}
export const kinds: Record<Kind, { label: string; icon: string; description: string }> = {
  'structured-graph': {
    label: 'Structured Graph',
    icon: '⌘',
    description: 'Edit typed nodes, relations and attributes',
  },
  'react-ui': {
    label: 'React UI',
    icon: '⚛',
    description: 'Compose original registered components',
  },
  document: { label: 'Document', icon: '▤', description: 'Write, diagram and explain' },
  data: { label: 'Structured Data', icon: '▦', description: 'One model, multiple views' },
  review: { label: 'Code Review', icon: '±', description: 'Compare text and annotate' },
  file: { label: 'File Viewer', icon: '▧', description: 'Inspect images, text and PDFs' },
  whiteboard: { label: 'Whiteboard', icon: '◇', description: 'Connect ideas on a canvas' },
  design: { label: 'Design', icon: '▱', description: 'Compose frames and components' },
  slide: { label: 'Slide Deck', icon: '▰', description: 'Tell a visual story' },
};
export function makeArtifact(kind: Kind, count: number): StoredArtifact {
  const content: Content =
    kind === 'structured-graph'
      ? createRelationGraph()
      : kind === 'react-ui'
        ? createReferenceDocument()
        : kind === 'document'
          ? createDocument()
          : kind === 'data'
            ? createData()
            : kind === 'review'
              ? createReview()
              : kind === 'whiteboard'
                ? createWhiteboard()
                : kind === 'design'
                  ? createDesign()
                  : kind === 'slide'
                    ? createDeck()
                    : createFile();
  return {
    ...createArtifact<Content>(kind, `${kinds[kind].label} ${count}`, content),
    annotations: [],
  };
}
export function validContent(kind: string, content: unknown): content is Content {
  if (kind === 'structured-graph') {
    try {
      if (!isGraphDocument(content)) return false;
      assertGraph(content, relationProfile);
      return true;
    } catch {
      return false;
    }
  }
  if (kind === 'data') {
    try {
      assertDataReadable(content);
      return true;
    } catch {
      return false;
    }
  }
  if (kind === 'react-ui') {
    return isReactUiDocument(content);
  }
  return kind === 'document'
    ? isDocument(content)
    : kind === 'data'
      ? isStructuredData(content)
      : kind === 'review'
        ? isReview(content)
        : kind === 'file'
          ? isFile(content)
          : kind === 'whiteboard'
            ? isWhiteboard(content)
            : kind === 'design'
              ? isDesign(content)
              : kind === 'slide'
                ? isDeck(content)
                : false;
}
// The host provides this deterministic runtime. Platform packages never generate a proposal.
export function mockExternalRuntime(
  request: ExternalOperationRequest,
  content: Content,
): ProposedCommands<Content> {
  if (!isDocument(content)) throw new Error('The host demo currently transforms document text');
  const ids = request.selection?.addresses.map((a) => a.elementId) ?? [];
  if (!ids.length) throw new Error('Select a document block first');
  return {
    id: crypto.randomUUID(),
    baseLocalRevision: request.liveRevision,
    source: 'Playground deterministic runtime',
    summary: 'Convert selected block text to uppercase.',
    commands: [
      command('external.uppercase', 'Uppercase selected text', (current) => {
        if (!isDocument(current)) throw new Error('Expected document content');
        return {
          ...current,
          blocks: current.blocks.map((b) => {
            if (!ids.includes(b.id)) return b;
            const address = request.selection?.addresses.find((a) => a.elementId === b.id),
              r = address?.region;
            const start = r?.type === 'text' && r.end > r.start ? r.start : 0,
              end = r?.type === 'text' && r.end > r.start ? r.end : b.text.length;
            const upper = (text: string, offset: number) => {
              const from = Math.max(0, Math.min(text.length, start - offset)),
                to = Math.max(0, Math.min(text.length, end - offset));
              return text.slice(0, from) + text.slice(from, to).toUpperCase() + text.slice(to);
            };
            let offset = 0;
            return {
              ...b,
              text: upper(b.text, 0),
              ...(b.rich
                ? {
                    rich: b.rich.map((span) => {
                      const next = { ...span, text: upper(span.text, offset) };
                      offset += span.text.length;
                      return next;
                    }),
                  }
                : {}),
            };
          }),
        };
      }),
    ],
  };
}
export function downloadText(name: string, text: string, mime = 'text/plain') {
  downloadBlob(name, new Blob([text], { type: mime }));
}
export function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function downloadFile(file: FileContent) {
  downloadBlob(file.name, new Blob([originalBytes(file)], { type: file.mime }));
}
export function anchorState(
  content: Content | undefined,
  address: ElementAddress,
): 'Current' | 'Outdated' | 'Orphan' {
  if (!content) return 'Orphan';
  if (isReview(content)) return reviewAnchorState(content, address);
  if (isFile(content)) return content.id === address.elementId ? 'Current' : 'Orphan';
  if (isDocument(content)) return resolveDocumentAddress(content, address).state;
  if (isStructuredData(content)) {
    const r = address.region;
    return content.rows.some((row) => row.id === address.elementId) &&
      (r?.type !== 'cell' || content.columns.some((c) => c.id === r.columnId))
      ? 'Current'
      : 'Orphan';
  }
  const ids = isDeck(content)
    ? content.slides.flatMap((s) => [s.id, ...s.objects.map((o) => o.id)])
    : isDesign(content)
      ? content.elements.map((e) => e.id)
      : isWhiteboard(content)
        ? [...content.nodes, ...content.connectors, ...(content.sections ?? [])].map((e) => e.id)
        : [];
  return ids.includes(address.elementId) ? 'Current' : 'Orphan';
}

/** Common local apply boundary, including headless/template/proposal paths. */
export function createLocalSession(content: Content): EditorSession<Content> {
  if (isStructuredData(content)) assertDataReadable(content);
  if (isGraphDocument(content)) assertGraph(content, relationProfile);
  class LocalSession extends EditorSession<Content> {
    override executeView(cmd: EditorCommand<Content>) {
      const current = this.content;
      if (isStructuredData(current))
        return super.executeView({
          ...cmd,
          apply: (value) => {
            if (!isStructuredData(value)) throw new Error('Expected Data');
            return guardDataCommand(cmd as EditorCommand<StructuredData>).apply(value);
          },
        });
      if (isGraphDocument(current))
        return super.executeView({
          ...cmd,
          apply: (value) => {
            if (!isGraphDocument(value)) throw new Error('Expected Graph');
            return guardGraphCommand(
              {
                ...cmd,
                apply: (graph) => {
                  const next = cmd.apply(graph);
                  if (!isGraphDocument(next)) throw new Error('Invalid Graph command result');
                  return next;
                },
              },
              relationProfile,
            ).apply(value);
          },
        });
      const validate = isDeck(current)
        ? isDeck
        : isDocument(current)
          ? isDocument
          : isDesign(current)
            ? isDesign
            : isWhiteboard(current)
              ? isWhiteboard
              : undefined;
      return super.executeView({
        ...cmd,
        apply(value) {
          const next = cmd.apply(value);
          if (validate ? !validate(next) : containsEmbeddedReference(next))
            throw new Error('参照埋め込みの形式または資源上限が不正です。');
          return next;
        },
      });
    }
  }
  return new LocalSession(content);
}
