import { useContext, useEffect, useId, useRef, useState } from 'react';
import { canonicalJson, newId } from '@editor-platform/artifact-core';
import { type EditorCommand } from '@editor-platform/editor-core';
import { EditorHistoryContext, EditorInputsContext } from '@editor-platform/editor-ui';
import { type GraphAttributeDraft } from './attribute-draft';
import { type GraphCamera, type GraphNodeSize } from './display';
import { type GraphLocale } from './diagnostics';
import { type GraphSourceActions } from './definition';
import {
  type GraphDocument,
  type GraphNode,
  type GraphNodeShape,
  type GraphDiagnostic,
} from './model';
import { validateGraph, type GraphProfile } from './profile';
import { createGraphNode, createGraphSection, graphCommand, type GraphIntent } from './commands';
import { arrangeGraph } from './arrange';
import {
  computeGraphScene,
  defaultGraphPosition,
  graphNeighbors,
  hasComposingDraft,
  graphNodeDropIntents,
  resolveGraphSelection,
  type GraphDefinitionTarget,
  type GraphDeletion,
  type GraphDrag,
  type GraphEndpointGesture,
  type GraphSectionDrag,
} from './view-model';
import { createSectionDragHandlers } from './view-sections';
import { useGraphMeasurements } from './view-measure';
import {
  graphEditErrorMessage,
  useClearGesturesWhenReadOnly,
  useGraphApply,
  useGraphCamera,
  useGraphNodeType,
  useGraphSectionType,
  useSelectionFallback,
} from './view-hooks';
import {
  prepareGraphConnection,
  submitGraphConnection,
  useGraphConnection,
} from './view-connection';
import { useGraphEditorInput } from './view-input';
import {
  createEndpointHandlers,
  createNodeDragHandlers,
  focusGraphCanvas,
  handleGraphKeyDown,
} from './view-gestures';
import { GraphToolbar, GraphViewControls } from './view-toolbar';
import { GraphCanvas } from './view-canvas';
import { GraphInspector } from './view-inspector';
import { GraphDeletionDialog } from './view-dialog';
import './styles.css';
export interface GraphSurfaceProps {
  content: GraphDocument;
  profile: GraphProfile;
  /** Canonical source revision including adapter/Profile pins. */
  stamp: string;
  onEdit: (intents: GraphIntent[], base: string) => void | boolean;
  select: (id: string) => void;
  selectedId?: string;
  readOnly?: boolean;
  diagnostics?: GraphDiagnostic[];
  /** Only rendering is filtered. The complete graph remains the validation source. */
  visibleNodeIds?: string[];
  /** Rendering only; validation and selection continue to use the complete graph. */
  visibleEdgeTypes?: string[];
  /** Show the built-in Inspector. Hosts may supply their own panel using selection notifications. */
  showInspector?: boolean;
  /** Applied once per graph after the canvas has a measurable size. Defaults to origin. */
  initialView?: 'origin' | 'fit' | GraphCamera;
  /** Refit on visibleNodeIds changes, preserving the camera on ordinary content edits. */
  fitOnFilterChange?: boolean;
  /** Emphasize the selected node and its immediate neighbors in the complete graph. */
  highlightAdjacent?: boolean;
  /**
   * Private drawing size in logical pixels. Supplied sizes stay fixed (40–4000 per axis).
   * Omitted: 200px width with measured content height (min 70px).
   */
  nodeSize?: GraphNodeSize | ((node: GraphNode) => GraphNodeSize);
  nodeFactory?: (id: string, type: string) => GraphNode;
  nodeId?: () => string;
  edgeId?: (from: string, type: string) => string;
  /** Runtime status is a Host-owned overlay, never content. */
  overlay?: Record<string, string>;
  onError?: (message: string) => void;
  /** Adapter/Host preflight may reject a source-specific edit without changing content. */
  previewEdit?: (intents: GraphIntent[], base: string) => void;
  locale?: GraphLocale;
  sourceActions?: GraphSourceActions;
  /**
   * Offer node shape and style choices (default true). Set false when the source cannot save
   * node presentation, such as a Data projection; nodes then show their Profile type default.
   */
  shapeEditing?: boolean;
  /**
   * Offer a shape for new nodes (default true), applied in the same edit as the node. Set false
   * when presentation and semantic edits must be separate transactions, as with a presentation
   * sidecar; existing nodes keep their shape and style choices.
   */
  shapeOnCreate?: boolean;
  /**
   * Offer Section editing when the Profile declares Section types (default true). Pass false
   * when the source cannot hold Sections. Collapsing stays available as private view state.
   */
  sectionEditing?: boolean;
  /**
   * With Section editing, a node dropped with its centre inside a Section frame joins the innermost
   * one in the same edit as the move. Dropped outside every frame, it leaves its Section
   * (`'clear'`, the default) or keeps it (`'keep'`).
   */
  sectionDropOutside?: 'clear' | 'keep';
}
export function GraphSurface({
  content: graph,
  profile,
  stamp,
  onEdit,
  select,
  selectedId,
  readOnly: hostReadOnly = false,
  diagnostics = [],
  visibleNodeIds,
  visibleEdgeTypes,
  showInspector = true,
  initialView = 'origin',
  fitOnFilterChange = false,
  highlightAdjacent = false,
  nodeSize,
  edgeId,
  nodeId,
  nodeFactory,
  overlay,
  onError,
  previewEdit,
  locale = 'ja',
  sourceActions,
  shapeEditing = true,
  shapeOnCreate = true,
  sectionEditing = true,
  sectionDropOutside = 'clear',
}: GraphSurfaceProps) {
  const [nodeShape, setNodeShape] = useState<GraphNodeShape | ''>('');
  const [sectionType, setSectionType] = useGraphSectionType(profile);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [sectionDrag, setSectionDrag] = useState<GraphSectionDrag>();
  const history = useContext(EditorHistoryContext);
  const inputs = useContext(EditorInputsContext);
  const [definitionTarget, setDefinitionTarget] = useState<GraphDefinitionTarget>();
  const readOnly = hostReadOnly || !!profile.graph.readOnly;
  const [localSelection, setLocalSelection] = useState(graph.id),
    [error, setError] = useState('');
  const [deletion, setDeletion] = useState<GraphDeletion>();
  const [drag, setDrag] = useState<GraphDrag>();
  const [endpoint, setEndpoint] = useState<GraphEndpointGesture>();
  const { latest, apply } = useGraphApply({
    graph,
    profile,
    stamp,
    readOnly,
    onEdit,
    locale,
    onError,
    setError,
  });
  const root = useRef<HTMLDivElement>(null),
    marker = useId().replaceAll(':', '');
  const canvas = useRef<HTMLDivElement>(null);
  const { nodeHeights, labelSizes, viewport } = useGraphMeasurements(canvas);
  const drafts = useRef(new Map<string, GraphAttributeDraft>());
  const invalidInput = useRef<string | undefined>(undefined);
  const cancelGestures = () => {
    setDrag(undefined);
    setSectionDrag(undefined);
    setEndpoint(undefined);
    setDeletion(undefined);
  };
  useClearGesturesWhenReadOnly(readOnly, cancelGestures);
  const selected = selectedId ?? localSelection;
  const { node, edge, section, type, scope, attributes, id } = resolveGraphSelection(
    graph,
    profile,
    selected,
  );
  const { connection, setConnection, connectionStale, editConnection, resetConnection } =
    useGraphConnection({ stamp, id, edge, profile });
  const problems = [...validateGraph(graph, profile), ...diagnostics];
  const choose = (id: string) => {
    if (id !== selected && hasComposingDraft(drafts.current)) {
      setError('入力変換を確定してから別のノードを選択してください。');
      return false;
    }
    setLocalSelection(id);
    select(id);
    return true;
  };
  useSelectionFallback(graph, selected, setLocalSelection, select);
  const [nodeType, setNodeType] = useGraphNodeType(profile);
  const prepareConnection = () =>
    prepareGraphConnection({ readOnly, connection, stamp, id, graph, profile, edgeId });
  useGraphEditorInput({
    readOnly,
    graph,
    profile,
    stamp,
    drafts,
    invalidInput,
    connection,
    setConnection,
    prepareConnection,
    apply,
    choose,
    root,
  });
  function remove() {
    if (readOnly) return;
    if (node) setDeletion({ id: node.id, base: stamp });
    else if (edge) apply([{ type: 'delete-edge', id: edge.id }]);
  }
  const scene = computeGraphScene({
    graph,
    profile,
    drag,
    sectionDrag,
    collapsed,
    visibleNodeIds,
    visibleEdgeTypes,
    nodeSize,
    nodeHeights,
    labelSizes,
    overlay,
    readOnly,
  });
  const { zoom, setZoom, pan, setPan, fit } = useGraphCamera({
    graphId: graph.id,
    canvas,
    viewport,
    drawingBounds: scene.drawingBounds,
    initialView,
    fitOnFilterChange,
    filterKey: scene.filterKey,
    visibleCount: scene.visible.length + scene.sections.order.length,
    labelsMeasured: scene.labelsMeasured,
    nodesMeasured: scene.nodesMeasured,
  });
  const neighbors = graphNeighbors(graph, node, highlightAdjacent);
  const { positions, label } = scene;
  const sectionsEditable = sectionEditing && !readOnly && Object.keys(profile.sections).length > 0;
  const nodeDrag = createNodeDragHandlers({
    drag,
    setDrag,
    readOnly,
    profile,
    endpoint,
    choose,
    positions,
    stamp,
    zoom,
    apply,
    setError,
    drop: sectionsEditable
      ? (id, position) => {
          const { intents, target, refused } = graphNodeDropIntents({
            graph,
            profile,
            sections: scene.sections,
            id,
            position,
            size: scene.sizeOf(graph.nodes.find((n) => n.id === id)!),
            outside: sectionDropOutside,
          });
          const notice =
            refused === undefined
              ? undefined
              : `${target === null ? label(id) : label(target)}: ${graphEditErrorMessage(refused, profile, locale)}`;
          return { intents, notice };
        }
      : undefined,
  });
  const endpointHandlers = createEndpointHandlers({
    endpoint,
    setEndpoint,
    root,
    zoom,
    visible: scene.visible,
    boxes: scene.boxes,
    graph,
    profile,
    locale,
    latest,
    previewEdit,
    label,
    stamp,
    apply,
    setError,
  });
  const [fitPending, setFitAfterArrange] = useState(false);
  useEffect(() => {
    if (!fitPending) return;
    setFitAfterArrange(false);
    fit();
  }, [fitPending]);
  /**
   * Adds a node of the toolbar's type with its chosen shape, or of a palette type with its type
   * default. With a Section selected, a palette node goes inside it in the same edit.
   */
  const addNode = (paletteType?: string) => {
    const id = nodeId?.() ?? newId('node'),
      type = paletteType ?? nodeType,
      target = paletteType && section && sectionsEditable ? section : undefined;
    const frame = target && graph.presentation.sections[target.id],
      inside = target ? graph.nodes.filter((n) => n.sectionId === target.id).length : 0;
    if (
      apply([
        {
          type: 'add-node',
          node: nodeFactory?.(id, type) ?? createGraphNode(profile, type, id),
          position: frame
            ? { x: frame.x + 30 + 24 * (inside % 5), y: frame.y + 56 + 24 * (inside % 5) }
            : defaultGraphPosition(graph.nodes.length),
        },
        ...(target ? [{ type: 'set-node-section' as const, id, sectionId: target.id }] : []),
        // One batch, so the new node and its chosen shape are a single undoable edit.
        ...(!paletteType && shapeEditing && shapeOnCreate && nodeShape
          ? [{ type: 'set-node-shape' as const, id, shape: nodeShape }]
          : []),
      ])
    )
      choose(id);
  };
  /** Section-aware layout of the whole drawing as one edit, then a Fit to show it. */
  const arrange = readOnly
    ? undefined
    : () => {
        // Hidden nodes (filtered or in a collapsed Section) keep their real size too.
        const byId = new Map(graph.nodes.map((n) => [n.id, n]));
        const intents = arrangeGraph(graph, { nodeSize: (nid) => scene.sizeOf(byId.get(nid)!) });
        if (!intents.length || apply(intents)) setFitAfterArrange(true);
      };
  const sectionDragHandlers = createSectionDragHandlers({
    drag: sectionDrag,
    setDrag: setSectionDrag,
    readOnly,
    graph,
    profile,
    choose,
    stamp,
    zoom,
    apply,
  });
  /** A new Section around the selected node holds it, in one edit; otherwise below the drawing. */
  const addSection = () => {
    // The chosen type is reconciled after a Profile change; never create from a stale one.
    if (!Object.hasOwn(profile.sections, sectionType)) return;
    const sectionId = newId('section'),
      around = node && scene.boxes[node.id];
    const bounds = around
      ? {
          x: around.x - 30,
          y: around.y - 50,
          width: around.width + 60,
          height: around.height + 80,
        }
      : {
          x: 40,
          y: Math.max(0, ...scene.drawingBounds.map((b) => b.y + b.height)) + 40,
          width: 420,
          height: 260,
        };
    const section = createGraphSection(profile, sectionType, sectionId, node?.sectionId);
    if (
      apply([
        { type: 'add-section', section, bounds },
        ...(around ? [{ type: 'set-node-section' as const, id: node.id, sectionId }] : []),
      ])
    )
      choose(sectionId);
  };
  const toggleSection = (sectionId: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(sectionId)) next.add(sectionId);
      return next;
    });
  const confirmDeletion = (deletion: GraphDeletion) => {
    if (apply([{ type: 'delete-node', id: deletion.id, cascade: true }], deletion.base)) {
      setDeletion(undefined);
      choose(graph.id);
      focusGraphCanvas(root);
    }
  };
  return (
    <div
      className="ep-graph"
      ref={root}
      aria-label="Structured Graph Editor"
      onKeyDown={(e) =>
        handleGraphKeyDown(e, {
          root,
          deletion,
          setDeletion,
          history,
          readOnly,
          cancelGestures,
          remove,
          node,
          profile,
          positions,
          apply,
        })
      }
    >
      <GraphToolbar
        readOnly={readOnly}
        profile={profile}
        sourceActions={sourceActions}
        node={node}
        edge={edge}
        section={section}
        id={id}
        scope={scope}
        inputs={inputs}
        hasPendingInput={() => !!drafts.current.size || connection.dirty}
        setDefinitionTarget={setDefinitionTarget}
        setError={setError}
        selectionReadOnly={!!type.readOnly}
        nodeType={nodeType}
        setNodeType={setNodeType}
        nodeShape={nodeShape}
        setNodeShape={shapeEditing && shapeOnCreate ? setNodeShape : undefined}
        onAddNode={() => addNode()}
        onPaletteAdd={(type) => addNode(type)}
        paletteInto={section && sectionsEditable ? scene.label(section.id) : undefined}
        onArrange={arrange}
        sectionType={sectionType}
        setSectionType={sectionsEditable ? setSectionType : undefined}
        onAddSection={sectionsEditable ? addSection : undefined}
        onGraphProperties={() => choose(graph.id)}
        onDelete={remove}
        zoom={zoom}
        setZoom={setZoom}
        setPan={setPan}
      />
      <GraphViewControls setPan={setPan} onFit={() => fit()} />
      <div className="ep-graph-body">
        <GraphCanvas
          canvasRef={canvas}
          scene={scene}
          zoom={zoom}
          pan={pan}
          marker={marker}
          profile={profile}
          selected={selected}
          node={node}
          edge={edge}
          neighbors={neighbors}
          highlightAdjacent={highlightAdjacent}
          readOnly={readOnly}
          autoSize={nodeSize === undefined}
          overlay={overlay}
          endpoint={endpoint}
          choose={choose}
          nodeDrag={nodeDrag}
          endpointHandlers={endpointHandlers}
          graph={graph}
          collapsed={collapsed}
          toggleSection={toggleSection}
          sectionHandlers={sectionDragHandlers}
          sectionsReadOnly={!sectionsEditable}
        />
        <GraphInspector
          showInspector={showInspector}
          graph={graph}
          profile={profile}
          locale={locale}
          sourceActions={sourceActions}
          readOnly={readOnly}
          node={node}
          edge={edge}
          section={section}
          sectionEditing={sectionsEditable}
          onFitSection={
            section
              ? () =>
                  fit([
                    scene.sections.collapsedBoxes[section.id] ?? scene.sections.frames[section.id],
                  ])
              : undefined
          }
          id={id}
          scope={scope}
          type={type}
          attributes={attributes}
          stamp={stamp}
          definitionTarget={definitionTarget}
          onCloseDefinition={() => setDefinitionTarget(undefined)}
          apply={apply}
          problems={problems}
          drafts={drafts.current}
          inputs={inputs}
          setError={setError}
          error={error}
          shapeEditing={shapeEditing}
          label={label}
          choose={choose}
          connection={connection}
          connectionStale={connectionStale}
          editConnection={editConnection}
          resetConnection={resetConnection}
          onSubmitConnection={() =>
            submitGraphConnection({
              prepare: prepareConnection,
              apply,
              connection,
              setConnection,
              setError,
            })
          }
        />
      </div>
      {!showInspector && error && <p role="alert">{error}</p>}
      {deletion && (
        <GraphDeletionDialog
          graph={graph}
          deletion={deletion}
          onConfirm={() => confirmDeletion(deletion)}
          onCancel={() => {
            setDeletion(undefined);
            focusGraphCanvas(root);
          }}
        />
      )}
    </div>
  );
}
/** Convenience native Surface; Host executor remains the authority and history owner. */
export function NativeGraphSurface({
  content,
  profile,
  execute,
  sourceRevision,
  ...props
}: Omit<GraphSurfaceProps, 'stamp' | 'onEdit'> & {
  execute: (command: EditorCommand<GraphDocument>) => void | boolean;
  sourceRevision: string;
}) {
  const stamp = canonicalJson({ sourceRevision, content, profile });
  return (
    <GraphSurface
      {...props}
      content={content}
      profile={profile}
      stamp={stamp}
      onEdit={(intents) => execute(graphCommand(profile, intents, canonicalJson(content)))}
    />
  );
}
