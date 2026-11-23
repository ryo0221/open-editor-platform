import type { FictionMapContent } from '@editor-platform/fiction-map/model';
import { isPreparedDesignPageCommand } from '@editor-platform/design/page-proposals';
import type { EstimateDocument } from '@editor-platform/estimate-core';
import { isAnalysis, type AnalysisDocument } from '@editor-platform/analysis-core';
import { assertGeo, type GeoDocument } from '@editor-platform/geo-core';
import type { SourceClosure } from './geo/geo-source-envelope';
import type { ReferenceSnapshot } from '@editor-platform/artifact-references';
import { containsEmbeddedReference } from '@editor-platform/artifact-references';
import { EditorSession, type EditorCommand } from '@editor-platform/editor-core';
import { guardDataCommand, assertDataReadable } from '@editor-platform/structured-data/session';
import { graphProfileFor, type GraphTemplateId } from './app/graph-templates';
import { createFmeaData, type FmeaTemplateId } from './app/fmea-templates';
import {
  isGraphDocument,
  relationProfile,
  assertGraph,
  guardGraphCommand,
  type GraphDocument,
} from '@editor-platform/structured-graph/model';
import { createArtifact, type Artifact } from '@editor-platform/artifact-core';
import { isPreparedInkCommand } from './app/design-ink-proposal';
import {
  type Annotation,
  type ElementAddress,
  type ExternalOperationRequest,
  type ProposedCommands,
  command,
} from '@editor-platform/editor-core';
import {
  isDocument,
  resolveDocumentAddress,
  type DocumentContent,
} from '@editor-platform/document';
import { isStructuredData, type StructuredData } from '@editor-platform/structured-data';
import {
  isFile,
  isReview,
  reviewAnchorState,
  originalBytes,
  type FileContent,
  type ReviewContent,
} from '@editor-platform/review-surfaces';
import { isWhiteboard, type WhiteboardContent } from '@editor-platform/whiteboard';
import { isMindmap, type MindmapContent } from '@editor-platform/mindmap-core';
import { isDesignWithPaths, type DesignContent } from '@editor-platform/design';
import { isCadDocument, type CadDocument } from '@editor-platform/cad-core';
import { type BimDocument } from '@editor-platform/bim-core';
import { type PcbDocument } from '@editor-platform/pcb-core';
import { type SchematicDocument } from '@editor-platform/schematic-core';
import { type LadderDocument } from '@editor-platform/ladder-core';
import { type CosimDocument } from '@editor-platform/cosim-core';
import { type FactoryDocument } from '@editor-platform/factory-core';
import { type DrawingDocument } from '@editor-platform/drawing-core';
import { type SimulationDocument } from '@editor-platform/simulation-core';
import { type SimulationSourceChoice } from './simulation/source';
import { type ConstructionDocument } from '@editor-platform/construction-core';
import { type ConstructionSourceChoice } from './construction/source';
import { type CharacterDocument } from '@editor-platform/character-core';
import type { CadResource } from './cad/resources';
import type { CadPartRecord } from './cad/parts';
import type { DrawingSourceRecord } from './drawing/sources';
import type { BimPartRecord } from './character/parts';
export { isCadDocument };
import { cadKernel } from './kinds/kernel';
import { createKindRegistry } from '@editor-platform/artifact-kinds';
import { officeKinds } from './kinds/office';
import { engineeringKinds } from './kinds/engineering';
import { isDeck, hasLegacySlideAnimations, type SlideContent } from '@editor-platform/slide';
import { type ReactUiDocument } from '@editor-platform/react-ui-core';
import {
  assertSchedule,
  isSchedule,
  looksLikeSchedule,
  type ScheduleDocument,
} from '@editor-platform/schedule/model';
import { type AnimationContentV1 } from '@editor-platform/animation-core';
import { type AnimationContent2 } from '@editor-platform/animation-core/v2';
export type Content =
  | FictionMapContent
  | EstimateDocument
  | AnalysisDocument
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
  | MindmapContent
  | DesignContent
  | SlideContent
  | ScheduleDocument
  | CadDocument
  | BimDocument
  | CharacterDocument
  | SimulationDocument
  | ConstructionDocument
  | PcbDocument
  | SchematicDocument
  | LadderDocument
  | CosimDocument
  | DrawingDocument
  | FactoryDocument;
export type Kind =
  | 'fiction-map'
  | 'estimate'
  | 'analysis'
  | 'animation'
  | 'geo'
  | 'structured-graph'
  | 'document'
  | 'data'
  | 'review'
  | 'file'
  | 'whiteboard'
  | 'mindmap'
  | 'design'
  | 'slide'
  | 'react-ui'
  | 'schedule'
  | 'cad'
  | 'bim'
  | 'character'
  | 'simulation'
  | 'construction'
  | 'pcb'
  | 'schematic'
  | 'ladder'
  | 'cosim'
  | 'drawing'
  | 'factory';
/** DW6b: one issue of a drawing's sheets, with its PDF as issued. */
export interface DrawingIssueRecord {
  versionId: string;
  issuedAt: string;
  sheets: { sheetId: string; name: string; mark: string }[];
  pdf: {
    sha256: string;
    byteLength: number;
    mediaType: 'application/pdf';
    encoding: 'base64';
    bytes: string;
  };
}
export interface StoredArtifact extends Artifact<Content> {
  annotations: Annotation[];
  geoResources?: SourceClosure[];
  /**
   * CAD D2 asset bytes (STEP originals, normalized BRep, texture images) named by the draft and
   * versions; a building's (`bim`) texture images too (#662), and a character's mesh and texture
   * assets (C1d).
   */
  cadResources?: CadResource[];
  /** R2b part versions (content by hash) placed by the draft and versions, nested ones included. */
  cadParts?: CadPartRecord[];
  /**
   * R3e-4: the CAD versions a structural analysis's draft and versions analyse (content by hash),
   * so the record evaluates on its own, wherever the CAD Artifact goes.
   */
  simulationSources?: CadPartRecord[];
  /**
   * CS1b: the BIM versions a construction schedule's draft and versions plan (content by hash),
   * so the record shows its building on its own, wherever the Building Artifact goes.
   */
  constructionSources?: BimPartRecord[];
  /** FT4a: the BIM versions a factory's draft and versions stand in (content by hash). */
  factorySources?: BimPartRecord[];
  /** FT4c: the CAD versions that give a factory's objects their look (content by hash, nested). */
  factoryLooks?: CadPartRecord[];
  /**
   * DW1: the CAD and building versions a drawing's draft and versions see (content by hash),
   * with the part versions they place, so the drawing shows on its own wherever it goes.
   */
  drawingSources?: DrawingSourceRecord[];
  /**
   * DW3c-2: the asset bytes (STEP originals, normalized BReps, kept PMI) those CAD versions name,
   * in the CAD resources' shape, so imported geometry is drawn from the drawing's own copy.
   */
  drawingAssets?: CadResource[];
  /**
   * DW6b: the drawing's issues (発行), oldest first: each names the saved version it made and
   * keeps the PDF as issued. Never changed once kept.
   */
  drawingIssues?: DrawingIssueRecord[];
  /**
   * C8p: a character's BIM versions placed as props (content by hash); the CAD versions they
   * place are in `cadParts`.
   */
  bimParts?: BimPartRecord[];
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
/** Every kind this Playground knows, from the shared definitions (kinds/office.ts, kinds/engineering.ts). */
export const kindRegistry = createKindRegistry([...officeKinds, ...engineeringKinds]);
export const kinds = Object.fromEntries(
  kindRegistry
    .all()
    .map(({ kind, label, icon, description }) => [kind, { label, icon, description }]),
) as Record<Kind, { label: string; icon: string; description: string }>;
export { cadKernel, cadKernels, cadKernelProfile } from './kinds/kernel';
export const creatableKinds = (Object.keys(kinds) as Kind[]).filter(
  // Both 3D domains evaluate with the Host's kernel build.
  (k) => (k !== 'cad' && k !== 'bim' && k !== 'simulation' && k !== 'construction') || !!cadKernel,
);
export { pcbTemplates, type PcbTemplateId } from '@editor-platform/pcb/kind';
import type { PcbTemplateId } from '@editor-platform/pcb/kind';

export function makeArtifact(
  kind: Kind,
  count: number,
  graphTemplate: GraphTemplateId = 'relations',
  /**
   * A structural analysis needs the saved CAD version and solid body it analyses; a construction
   * schedule the saved BIM version it plans.
   */
  source?: SimulationSourceChoice | ConstructionSourceChoice,
  pcbTemplate: PcbTemplateId = 'empty',
  dataTemplate: FmeaTemplateId = 'blank',
): StoredArtifact {
  if (kind === 'data' && dataTemplate !== 'blank') {
    const name = dataTemplate === 'pfmea' ? 'PFMEA: 製造工程（試作）' : 'DFMEA: 製品設計（試作）';
    return { ...createArtifact<Content>('data', name, createFmeaData(dataTemplate)), annotations: [] };
  }
  const options =
    kind === 'structured-graph'
      ? { template: graphTemplate }
      : kind === 'pcb'
        ? { template: pcbTemplate }
        : source;
  const { name, content, extras } = kindRegistry.get(kind)!.create(count, options);
  return {
    ...createArtifact<Content>(kind, name, content as Content),
    annotations: [],
    ...(extras as Partial<StoredArtifact>),
  };
}
export function validContent(kind: string, content: unknown): content is Content {
  // Calculation documents are only ever their own kinds; other readers never see them.
  if (
    kind !== 'fiction-map' &&
    kind !== 'estimate' &&
    kind !== 'analysis' &&
    content &&
    typeof content === 'object' &&
    'domain' in content &&
    (content.domain === 'analysis' || content.domain === 'estimate')
  )
    return false;
  return kindRegistry.validate(kind, content);
}
// The host provides this deterministic runtime. Platform packages never generate a proposal.
export function mockExternalRuntime(
  request: ExternalOperationRequest,
  content: Content,
): ProposedCommands<Content> {
  if (isAnalysis(content) || !isDocument(content))
    throw new Error('The host demo currently transforms document text');
  const ids = request.selection?.addresses.map((a) => a.elementId) ?? [];
  if (!ids.length) throw new Error('Select a document block first');
  return {
    id: crypto.randomUUID(),
    baseLocalRevision: request.liveRevision,
    source: 'Playground deterministic runtime',
    summary: 'Convert selected block text to uppercase.',
    commands: [
      command('external.uppercase', 'Uppercase selected text', (current) => {
        if (isAnalysis(current) || !isDocument(current))
          throw new Error('Expected document content');
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
  if (isAnalysis(content))
    return content.runs.some((run) =>
      Object.values(run.results).some((table) =>
        table.rows.some((row) => row.id === address.elementId),
      ),
    )
      ? 'Current'
      : 'Orphan';
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
    : isDesignWithPaths(content)
      ? content.elements.map((e) => e.id)
      : isWhiteboard(content)
        ? [...content.nodes, ...content.connectors, ...(content.sections ?? [])].map((e) => e.id)
        : isSchedule(content)
          ? content.events.map((e) => e.id)
          : isMindmap(content)
            ? Object.keys(content.nodes)
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
  if (isGraphDocument(content)) {
    const profile = graphProfileFor(content);
    if (!profile) throw new Error('This Graph uses a Profile this Playground does not register');
    assertGraph(content, profile);
  }
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
              graphProfileFor(value) ?? relationProfile,
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
      const validate = validContent('fiction-map', current)
        ? (value: unknown) => validContent('fiction-map', value)
        : isAnalysis(current)
          ? isAnalysis
          : animation
            ? (value: unknown) => validContent('animation', value)
            : isDeck(current)
              ? isDeck
              : isDocument(current)
                ? isDocument
                : isDesignWithPaths(current)
                  ? isDesignWithPaths
                  : isWhiteboard(current)
                    ? isWhiteboard
                    : isMindmap(current)
                      ? isMindmap
                      : undefined;
      return super.executeView({
        ...cmd,
        apply(value) {
          if (
            isDesignWithPaths(value) &&
            value.schemaVersion >= 3 &&
            cmd.context?.origin === 'proposal' &&
            !isPreparedInkCommand(cmd) &&
            !isPreparedDesignPageCommand(cmd)
          )
            throw new Error('Structured paths/schema3 proposals are not supported');
          const next = cmd.apply(value);
          if (
            isDesignWithPaths(next) &&
            next.schemaVersion >= 3 &&
            cmd.context?.origin === 'proposal' &&
            !isPreparedInkCommand(cmd) &&
            !isPreparedDesignPageCommand(cmd)
          )
            throw new Error('Structured paths/schema3 proposals are not supported');
          if (validate ? !validate(next) : containsEmbeddedReference(next))
            throw new Error('参照埋め込みの形式または資源上限が不正です。');
          return next;
        },
      });
    }
  }
  return new LocalSession(content);
}
