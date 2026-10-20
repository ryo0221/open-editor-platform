import { useContext, useId, useRef, useState } from 'react';
import { canonicalJson, newId } from '@editor-platform/artifact-core';
import { type EditorCommand } from '@editor-platform/editor-core';
import { EditorHistoryContext, EditorInputsContext } from '@editor-platform/editor-ui';
import { type GraphAttributeDraft } from './attribute-draft';
import { type GraphCamera, type GraphNodeSize } from './display';
import { type GraphLocale } from './diagnostics';
import { type GraphSourceActions } from './definition';
import { type GraphDocument, type GraphNode, type GraphDiagnostic } from './model';
import { validateGraph, type GraphProfile } from './profile';
import { createGraphNode, graphCommand, type GraphIntent } from './commands';
import {
  computeGraphScene,
  defaultGraphPosition,
  graphNeighbors,
  hasComposingDraft,
  resolveGraphSelection,
  type GraphDefinitionTarget,
  type GraphDeletion,
  type GraphDrag,
  type GraphEndpointGesture,
} from './view-model';
import { useGraphMeasurements } from './view-measure';
import {
  useClearGesturesWhenReadOnly,
  useGraphApply,
  useGraphCamera,
  useGraphNodeType,
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
}: GraphSurfaceProps) {
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
    setEndpoint(undefined);
    setDeletion(undefined);
  };
  useClearGesturesWhenReadOnly(readOnly, cancelGestures);
  const selected = selectedId ?? localSelection;
  const { node, edge, type, scope, attributes, id } = resolveGraphSelection(
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
    visibleCount: scene.visible.length,
    labelsMeasured: scene.labelsMeasured,
    nodesMeasured: scene.nodesMeasured,
  });
  const neighbors = graphNeighbors(graph, node, highlightAdjacent);
  const { positions, label } = scene;
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
  const addNode = () => {
    const id = nodeId?.() ?? newId('node');
    if (
      apply([
        {
          type: 'add-node',
          node: nodeFactory?.(id, nodeType) ?? createGraphNode(profile, nodeType, id),
          position: defaultGraphPosition(graph.nodes.length),
        },
      ])
    )
      choose(id);
  };
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
        id={id}
        scope={scope}
        inputs={inputs}
        hasPendingInput={() => !!drafts.current.size || connection.dirty}
        setDefinitionTarget={setDefinitionTarget}
        setError={setError}
        selectionReadOnly={!!type.readOnly}
        nodeType={nodeType}
        setNodeType={setNodeType}
        onAddNode={addNode}
        onGraphProperties={() => choose(graph.id)}
        onDelete={remove}
        zoom={zoom}
        setZoom={setZoom}
        setPan={setPan}
      />
      <GraphViewControls setPan={setPan} onFit={fit} />
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
