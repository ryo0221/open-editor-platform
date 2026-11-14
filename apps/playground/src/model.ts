import {
  createFictionMap,
  validateFictionMap,
  type FictionMapContent,
} from '@editor-platform/fiction-map/model';
import { isPreparedDesignPageCommand } from '@editor-platform/design/page-proposals';
import { createEstimate, isEstimate, type EstimateDocument } from '@editor-platform/estimate-core';
import { createAnalysis, isAnalysis, type AnalysisDocument } from '@editor-platform/analysis-core';
import { emptyGeo, assertGeo, type GeoDocument } from '@editor-platform/geo-core';
import type { SourceClosure } from './geo/geo-source-envelope';
import type { ReferenceSnapshot } from '@editor-platform/artifact-references';
import { containsEmbeddedReference } from '@editor-platform/artifact-references';
import { EditorSession, type EditorCommand } from '@editor-platform/editor-core';
import { guardDataCommand, assertDataReadable } from '@editor-platform/structured-data/session';
import { graphProfileFor, graphTemplates, type GraphTemplateId } from './app/graph-templates';
import {
  isGraphDocument,
  upgradeGraphDocument,
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
import { createDesign, isDesignWithPaths, type DesignContent } from '@editor-platform/design';
import { emptyCad, isCadDocument, type CadDocument } from '@editor-platform/cad-core';
import { bimStarter, isBimDocument, type BimDocument } from '@editor-platform/bim-core';
import {
  f75Pi5Example,
  f76HatBoard,
  isPcbDocument,
  pcbStarter,
  type PcbDocument,
} from '@editor-platform/pcb-core';
import {
  isSchematicDocument,
  schematicStarter,
  type SchematicDocument,
} from '@editor-platform/schematic-core';
import { isLadderDocument, ladderStarter, type LadderDocument } from '@editor-platform/ladder-core';
import { cosimStarter, isCosimDocument, type CosimDocument } from '@editor-platform/cosim-core';
import { isSimulationDocument, type SimulationDocument } from '@editor-platform/simulation-core';
import { newSimulation, type SimulationSourceChoice } from './simulation/source';
import {
  isConstructionDocument,
  type ConstructionDocument,
} from '@editor-platform/construction-core';
import { newConstructionSchedule, type ConstructionSourceChoice } from './construction/source';
import {
  isCharacterDocument,
  validateCharacter,
  type CharacterDocument,
} from '@editor-platform/character-core';
import type { CadResource } from './cad/resources';
import type { CadPartRecord } from './cad/parts';
import type { BimPartRecord } from './character/parts';
export { isCadDocument };
import cadKernelBuild, { kernels as cadKernelCatalog } from 'virtual:cad-kernel-build';
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
import { characterStarter } from './character/starter';
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
  | CosimDocument;
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
  | 'cosim';
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
export const kinds: Record<Kind, { label: string; icon: string; description: string }> = {
  estimate: { label: '見積・積算', icon: '¥', description: '数量・単価・配賦と条件別見積' },
  analysis: { label: '計算・分析ノート', icon: '∑', description: '保存Dataの計算・条件別比較' },
  animation: {
    label: 'Animation',
    icon: '▶',
    description: 'Create and reuse 2D animation with a timeline',
  },
  'fiction-map': {
    label: 'Fiction Map',
    icon: '◇',
    description: 'Edit a bounded fictional plane, independent of Geo',
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
  bim: {
    label: 'Building',
    icon: '⌂',
    description: 'Model a building by levels, elements and types',
  },
  character: {
    label: 'Character',
    icon: '☺',
    description: 'Import, view and play a rigged glTF or VRM character',
  },
  simulation: {
    label: 'Structural analysis',
    icon: 'σ',
    description: 'Load a saved 3D CAD part and solve it for displacement and stress',
  },
  construction: {
    label: 'Construction schedule',
    icon: '⛏',
    description: 'Plan when each element of a saved building is built, day by day in 3D',
  },
  pcb: {
    label: 'Circuit board',
    icon: '▦',
    description: 'Lay out a printed circuit board: outline, layers and holes',
  },
  schematic: {
    label: 'Schematic',
    icon: '⏚',
    description: 'Draw a circuit: symbols, wires, net labels and power ports',
  },
  ladder: {
    label: 'Ladder',
    icon: '⊣⊢',
    description: 'Write a PLC ladder program (IEC 61131-3) and run it scan by scan',
  },
  cosim: {
    label: 'Co-simulation',
    icon: '⇄',
    description: 'Run a saved ladder program against a saved schematic: buttons, LEDs, GPIO',
  },
};
/**
 * The Host-supplied CAD kernel build (the custom development OpenCascade.js while D0 is open).
 * New CAD artifacts are offered only when one is configured; documents always name the build
 * they need.
 */
export const cadKernel = cadKernelBuild;
/** Older kernel builds and approved reference substitutions (scripts/cad-kernel/build.mjs). */
export const cadKernels = cadKernelCatalog;
export const cadKernelProfile = {
  id: cadKernelBuild?.id ?? 'unavailable',
  buildHash: cadKernelBuild?.buildHash ?? `sha256:${'0'.repeat(64)}`,
};
export const creatableKinds = (Object.keys(kinds) as Kind[]).filter(
  // Both 3D domains evaluate with the Host's kernel build.
  (k) => (k !== 'cad' && k !== 'bim' && k !== 'simulation' && k !== 'construction') || !!cadKernel,
);
const isConstructionChoice = (
  c: SimulationSourceChoice | ConstructionSourceChoice | undefined,
): c is ConstructionSourceChoice => !!c && 'kind' in c && c.kind === 'construction';
/** PB8: what a new circuit board starts as. */
export const pcbTemplates = [
  { id: 'empty', label: 'Empty board', name: 'Circuit board' },
  { id: 'pi5', label: 'Raspberry Pi 5 form factor (F75)', name: 'Pi 5 form factor' },
  { id: 'hat', label: 'Sensor HAT+ (F76)', name: 'Sensor HAT+' },
] as const;
export type PcbTemplateId = (typeof pcbTemplates)[number]['id'];

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
): StoredArtifact {
  if (kind === 'construction') {
    if (!isConstructionChoice(source))
      throw new Error('Choose a saved Building version to schedule');
    const { doc, retained } = newConstructionSchedule(source, `${kinds[kind].label} ${count}`);
    return {
      ...createArtifact<Content>(kind, doc.name, doc),
      annotations: [],
      constructionSources: [retained],
    };
  }
  const simulationSource = isConstructionChoice(source) ? undefined : source;
  if (kind === 'simulation') {
    if (!simulationSource) throw new Error('Choose a saved 3D CAD version to analyse');
    const { doc, retained } = newSimulation(simulationSource, `${kinds[kind].label} ${count}`);
    return {
      ...createArtifact<Content>(kind, doc.name, doc),
      annotations: [],
      simulationSources: [retained],
    };
  }
  const content: Content =
    kind === 'fiction-map'
      ? createFictionMap()
      : kind === 'estimate'
        ? createEstimate()
        : kind === 'analysis'
          ? createAnalysis()
          : kind === 'animation'
            ? createAnimation2()
            : kind === 'geo'
              ? emptyGeo()
              : kind === 'structured-graph'
                ? graphTemplates.find((t) => t.id === graphTemplate)!.create()
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
                                  : kind === 'bim'
                                    ? bimStarter()
                                    : kind === 'character'
                                      ? characterStarter().doc
                                      : kind === 'pcb'
                                        ? pcbTemplate === 'pi5'
                                          ? f75Pi5Example()
                                          : pcbTemplate === 'hat'
                                            ? f76HatBoard()
                                            : pcbStarter()
                                        : kind === 'schematic'
                                          ? schematicStarter()
                                          : kind === 'ladder'
                                            ? ladderStarter()
                                            : kind === 'cosim'
                                              ? cosimStarter()
                                              : createFile();
  return {
    ...createArtifact<Content>(
      kind,
      `${kind === 'pcb' ? pcbTemplates.find((t) => t.id === pcbTemplate)!.name : kinds[kind].label} ${count}`,
      content,
    ),
    annotations: [],
    // A new character starts as the sample figure, its mesh bytes kept beside the content.
    ...(kind === 'character'
      ? { cadResources: characterStarter().resources as unknown as CadResource[] }
      : {}),
  };
}
export function validContent(kind: string, content: unknown): content is Content {
  if (kind === 'fiction-map') return validateFictionMap(content).ok;
  if (kind === 'estimate') return isEstimate(content);
  if (kind === 'analysis') return isAnalysis(content);
  if (
    content &&
    typeof content === 'object' &&
    'domain' in content &&
    (content.domain === 'analysis' || content.domain === 'estimate')
  )
    return false;
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
      // A stored draft or version of an older schema is valid if it reads as the current one.
      const graph = upgradeGraphDocument(content);
      if (!graph) return false;
      const profile = graphProfileFor(graph);
      if (!profile) return false;
      assertGraph(graph, profile);
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
  if (kind === 'bim') return isBimDocument(content);
  if (kind === 'simulation') return isSimulationDocument(content);
  if (kind === 'construction') return isConstructionDocument(content);
  if (kind === 'pcb') return isPcbDocument(content);
  if (kind === 'schematic') return isSchematicDocument(content);
  if (kind === 'ladder') return isLadderDocument(content);
  if (kind === 'cosim') return isCosimDocument(content);
  if (kind === 'character')
    return isCharacterDocument(content) && validateCharacter(content).length === 0;
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
              ? isDesignWithPaths(content)
              : kind === 'slide'
                ? isDeck(content)
                : false;
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
