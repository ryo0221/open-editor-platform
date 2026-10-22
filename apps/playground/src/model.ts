import { emptyGeo, assertGeo, type GeoDocument } from '@editor-platform/geo-core';
import type { SourceClosure } from './geo/geo-source-envelope';
import type { ReferenceSnapshot } from '@editor-platform/artifact-references';
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
import { emptyCad, isCadDocument, type CadDocument } from '@editor-platform/cad-core';
export { isCadDocument };
import cadKernelBuild from 'virtual:cad-kernel-build';
import {
  createDeck,
  isDeck,
  hasLegacySlideAnimations,
  type SlideContent,
} from '@editor-platform/slide';
import { isReactUiDocument, type ReactUiDocument } from '@editor-platform/react-ui-core';
import {
  assertSchedule,
  createSchedule,
  isSchedule,
  looksLikeSchedule,
  type ScheduleDocument,
} from '@editor-platform/schedule/model';
import { createReferenceDocument } from '../../react-ui-reference/src/catalog';
import {
  readAnimationV1,
  SCHEMA_V1,
  TICKS_PER_SECOND_V1,
  type AnimationContentV1,
} from '@editor-platform/animation-core';
import {
  createAnimation2,
  readAnimation2,
  type AnimationContent2,
} from '@editor-platform/animation-core/v2';
export type Content =
  | AnimationContentV1
  | AnimationContent2
  | GeoDocument
  | GraphDocument
  | ReactUiDocument
  | DocumentContent
  | StructuredData
  | ReviewContent
  | FileContent
  | WhiteboardContent
  | DesignContent
  | SlideContent
  | ScheduleDocument
  | CadDocument;
export type Kind =
  | 'animation'
  | 'geo'
  | 'structured-graph'
  | 'document'
  | 'data'
  | 'review'
  | 'file'
  | 'whiteboard'
  | 'design'
  | 'slide'
  | 'react-ui'
  | 'schedule'
  | 'cad';
export interface StoredArtifact extends Artifact<Content> {
  annotations: Annotation[];
  geoResources?: SourceClosure[];
  geoDataInputs?: ReferenceSnapshot[];
  /** Reference Host conversion receipt: an immutable baseline for explicit three-way review. */
  designReactConversion?: { sourceArtifactId: string; sourceHash: string; basis: ReactUiDocument };
}
/** Shared admission includes immutable history, even when the current draft is static. */
export function hasUnsupportedSharedAnimation(artifact: Artifact<Content>): boolean {
  return (
    (artifact.kind === 'animation' &&
      [artifact.draft.content, ...artifact.versions.map((v) => v.content)].some(
        (content) => !validContent('animation', content) || content.schemaVersion !== 2,
      )) ||
    (artifact.kind === 'slide' &&
      [artifact.draft.content, ...artifact.versions.map((v) => v.content)].some(
        (content) => isDeck(content) && hasLegacySlideAnimations(content),
      ))
  );
}
export const kinds: Record<Kind, { label: string; icon: string; description: string }> = {
  animation: {
    label: 'Animation',
    icon: '▶',
    description: 'Create and reuse 2D animation with a timeline',
  },
  geo: { label: 'Geo', icon: '◎', description: 'Map geographic features and pinned Data values' },
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
  schedule: {
    label: 'Schedule',
    icon: '◷',
    description: 'Plan events next to the work they belong to',
  },
  cad: { label: '3D CAD', icon: '⬢', description: 'Model parametric solids in millimetres' },
};
/**
 * The Host-supplied CAD kernel build (development OpenCascade.js while D0 is open). New CAD
 * artifacts are offered only when one is configured; documents always name the build they need.
 */
export const cadKernel = cadKernelBuild;
export const cadKernelProfile = {
  id: 'opencascade.js-2.0.0-beta.b5ff984',
  buildHash: cadKernelBuild?.buildHash ?? `sha256:${'0'.repeat(64)}`,
};
export const creatableKinds = (Object.keys(kinds) as Kind[]).filter(
  (k) => k !== 'cad' || !!cadKernel,
);
export function makeArtifact(kind: Kind, count: number): StoredArtifact {
  const content: Content =
    kind === 'animation'
      ? createAnimation2()
      : kind === 'geo'
        ? emptyGeo()
        : kind === 'structured-graph'
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
                        : kind === 'schedule'
                          ? createSchedule(
                              Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
                            )
                          : kind === 'cad'
                            ? emptyCad(cadKernelProfile)
                            : createFile();
  return {
    ...createArtifact<Content>(kind, `${kinds[kind].label} ${count}`, content),
    annotations: [],
  };
}
export function validContent(kind: string, content: unknown): content is Content {
  if (kind === 'animation') {
    if (
      content &&
      typeof content === 'object' &&
      (content as { schemaVersion?: unknown }).schemaVersion === 2 &&
      (content as { ticksPerSecond?: unknown }).ticksPerSecond === TICKS_PER_SECOND_V1
    ) {
      try {
        readAnimation2(content);
        return true;
      } catch {
        return false;
      }
    }
    // Other native domains must not enter the owning/deep Animation reader during render.
    const candidate = content as Partial<AnimationContentV1> | null;
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      candidate.schemaVersion !== SCHEMA_V1 ||
      candidate.ticksPerSecond !== TICKS_PER_SECOND_V1
    )
      return false;
    try {
      readAnimationV1(content);
      return true;
    } catch {
      return false;
    }
  }
  if (kind === 'geo') {
    try {
      assertGeo(content, {
        actions: 10,
        bytes: 65536,
        depth: 24,
        layers: 10,
        features: 200,
        vertices: 1000,
      });
      return true;
    } catch {
      return false;
    }
  }
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
  if (kind === 'schedule') return isSchedule(content);
  if (kind === 'cad') return isCadDocument(content);
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
        : isSchedule(content)
          ? content.events.map((e) => e.id)
          : [];
  return ids.includes(address.elementId) ? 'Current' : 'Orphan';
}

/** Common local apply boundary, including headless/template/proposal paths. */
export function createLocalSession(content: Content): EditorSession<Content> {
  const data = isStructuredData(content);
  const animation = validContent('animation', content);
  if (data) assertDataReadable(content);
  if (validContent('geo', content))
    assertGeo(content, {
      actions: 10,
      bytes: 65536,
      depth: 24,
      layers: 10,
      features: 200,
      vertices: 1000,
    });
  if (isGraphDocument(content)) assertGraph(content, relationProfile);
  class LocalSession extends EditorSession<Content> {
    override executeView(cmd: EditorCommand<Content>) {
      // Data commands retain the native model and validate both sides at the
      // guarded boundary. Do not clone every cell just to rediscover its domain.
      if (data)
        return super.executeView(
          guardDataCommand(cmd as EditorCommand<StructuredData>) as EditorCommand<Content>,
        );
      const current = this.content;
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
      if (validContent('geo', current))
        return super.executeView({
          ...cmd,
          apply(value) {
            const next = cmd.apply(value);
            if (!validContent('geo', next)) throw Error('Invalid Geo command');
            return next;
          },
        });
      if (looksLikeSchedule(current))
        return super.executeView({
          ...cmd,
          apply(value) {
            const next = cmd.apply(value);
            assertSchedule(next);
            return next;
          },
        });
      const validate = animation
        ? (value: unknown) => validContent('animation', value)
        : isDeck(current)
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
