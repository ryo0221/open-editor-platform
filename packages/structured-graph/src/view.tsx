import {
  useContext,
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type PointerEvent,
} from 'react';
import { canonicalJson, newId } from '@editor-platform/artifact-core';
import { type EditorCommand } from '@editor-platform/editor-core';
import {
  EditorHistoryContext,
  EditorInputsContext,
  Menu,
  useEditorInput,
} from '@editor-platform/editor-ui';
import { prepareGraphAttributeDraft, type GraphAttributeDraft } from './attribute-draft';
import { routeGraphEdge } from './routing';
import {
  fitGraphView,
  graphNodeSize,
  placeMeasuredGraphEdgeLabels,
  type GraphCamera,
  type GraphNodeSize,
} from './display';
import { formatGraphDiagnostic, graphElementLabel, type GraphLocale } from './diagnostics';
import { GraphDefinitionEditor } from './definition-editor';
import { type GraphSourceActions } from './definition';
import { type GraphDocument, type GraphNode, type GraphDiagnostic, type Position } from './model';
import { GraphValidationError, validateGraph, type GraphProfile } from './profile';
import { createGraphNode, graphCommand, type GraphIntent } from './commands';
import { GraphAttributes } from './attributes';
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
  const [definitionTarget, setDefinitionTarget] = useState<{
    scope: 'graph' | 'node' | 'edge';
    type?: string;
  }>();
  const readOnly = hostReadOnly || !!profile.graph.readOnly;
  const [localSelection, setLocalSelection] = useState(graph.id),
    [error, setError] = useState(''),
    [zoom, setZoom] = useState(1),
    [pan, setPan] = useState({ x: 0, y: 0 });
  const [nodeType, setNodeType] = useState(Object.keys(profile.nodes)[0] ?? '');
  const [deletion, setDeletion] = useState<{ id: string; base: string }>();
  const [drag, setDrag] = useState<{
    id: string;
    pointer: number;
    start: Position;
    initial: Position;
    position: Position;
    base: string;
  }>();
  const [endpoint, setEndpoint] = useState<{
    id: string;
    side: 'from' | 'to';
    pointer: number;
    base: string;
    point: Position;
    target?: string;
    reason?: string;
  }>();
  const latest = useRef({ graph, profile, stamp, readOnly, onEdit });
  latest.current = { graph, profile, stamp, readOnly, onEdit };
  const root = useRef<HTMLDivElement>(null),
    marker = useId().replaceAll(':', '');
  const canvas = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [labelSizes, setLabelSizes] = useState(new Map<string, GraphNodeSize & { text: string }>());
  const [nodeHeights, setNodeHeights] = useState(
    new Map<string, { key: string; height: number }>(),
  );
  useLayoutEffect(() => {
    const contents = canvas.current?.querySelectorAll<HTMLElement>('.ep-graph-node-content') ?? [];
    const measure = () => {
      const measured = new Map<string, { key: string; height: number }>();
      for (const content of contents) {
        const node = content.closest<HTMLElement>('[data-auto-size-key]');
        if (!node || !content.offsetWidth) continue;
        const button = content.parentElement!;
        const buttonStyle = getComputedStyle(button),
          nodeStyle = getComputedStyle(node);
        const height = Math.max(
          70,
          Math.ceil(
            content.offsetHeight +
              parseFloat(buttonStyle.paddingTop) +
              parseFloat(buttonStyle.paddingBottom) +
              parseFloat(buttonStyle.borderTopWidth) +
              parseFloat(buttonStyle.borderBottomWidth) +
              parseFloat(nodeStyle.borderTopWidth) +
              parseFloat(nodeStyle.borderBottomWidth),
          ),
        );
        measured.set(node.dataset.nodeId!, { key: node.dataset.autoSizeKey!, height });
      }
      setNodeHeights((previous) =>
        previous.size === measured.size &&
        [...measured].every(([id, next]) => {
          const old = previous.get(id);
          return old?.key === next.key && old.height === next.height;
        })
          ? previous
          : measured,
      );
    };
    measure();
    // Natural content size changes on font load and on Host typography changes.
    const observer = new ResizeObserver(measure);
    for (const content of contents) observer.observe(content);
    return () => observer.disconnect();
  });
  const [, refreshFonts] = useState(0);
  useEffect(() => {
    let active = true;
    const changed = () => {
      if (active) refreshFonts((n) => n + 1);
    };
    void document.fonts.ready.then(changed);
    document.fonts.addEventListener('loadingdone', changed);
    return () => {
      active = false;
      document.fonts.removeEventListener('loadingdone', changed);
    };
  }, []);
  useLayoutEffect(() => {
    const measured = new Map<string, GraphNodeSize & { text: string }>();
    for (const text of canvas.current?.querySelectorAll<SVGTextElement>(
      '.ep-graph-edge-label text',
    ) ?? []) {
      const id = text.closest('[data-edge-id]')?.getAttribute('data-edge-id');
      if (!id) continue;
      const box = text.getBBox();
      if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) continue;
      const x = Number(text.getAttribute('x')),
        y = Number(text.getAttribute('y')) - 4;
      measured.set(id, {
        text: text.textContent ?? '',
        // A mounted whitespace/zero-glyph label is measured even with zero ink.
        // Its zero box may be at the SVG origin rather than at the text anchor.
        width:
          box.width === 0
            ? 50
            : Math.max(
                50,
                Math.ceil(2 * Math.max(Math.abs(box.x - x), Math.abs(box.x + box.width - x)) + 16),
              ),
        height:
          box.height === 0
            ? 22
            : Math.max(
                22,
                Math.ceil(2 * Math.max(Math.abs(box.y - y), Math.abs(box.y + box.height - y)) + 8),
              ),
      });
    }
    setLabelSizes((previous) =>
      previous.size === measured.size &&
      [...measured].every(([id, next]) => {
        const old = previous.get(id);
        return old?.text === next.text && old.width === next.width && old.height === next.height;
      })
        ? previous
        : measured,
    );
  });
  const cameraSetup = useRef({ graphId: '', initialized: false, filter: '' });
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const measure = () => setViewport({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const drafts = useRef(new Map<string, GraphAttributeDraft>());
  const invalidInput = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (readOnly) {
      setDrag(undefined);
      setEndpoint(undefined);
      setDeletion(undefined);
    }
  }, [readOnly]);
  const selected = selectedId ?? localSelection,
    node = graph.nodes.find((n) => n.id === selected),
    edge = graph.edges.find((e) => e.id === selected);
  const type = node ? profile.nodes[node.type] : edge ? profile.edges[edge.type] : profile.graph;
  const scope = node ? 'node' : edge ? 'edge' : 'graph',
    attributes = node?.attributes ?? edge?.attributes ?? graph.attributes;
  const id = node?.id ?? edge?.id ?? graph.id;
  const currentConnection = () => ({
    base: stamp,
    target: id,
    dirty: false,
    type: edge?.type ?? Object.keys(profile.edges)[0] ?? '',
    from: edge?.from ?? '',
    to: edge?.to ?? '',
  });
  const [connection, setConnection] = useState(currentConnection);
  const { from, to, type: edgeType } = connection;
  const connectionStale = connection.base !== stamp || connection.target !== id;
  useEffect(() => {
    if (
      !connection.dirty &&
      (connectionStale ||
        (connection.type !== '' && !Object.hasOwn(profile.edges, connection.type)))
    )
      setConnection(currentConnection());
  }, [stamp, id, profile, edge, connection, connectionStale]);
  const editConnection = (patch: Partial<Pick<typeof connection, 'from' | 'to' | 'type'>>) =>
    setConnection((old) => ({ ...(old.dirty ? old : currentConnection()), ...patch, dirty: true }));
  const problems = [...validateGraph(graph, profile), ...diagnostics];
  const choose = (id: string) => {
    if (id !== selected && [...drafts.current.values()].some((draft) => draft.composing)) {
      setError('入力変換を確定してから別のノードを選択してください。');
      return false;
    }
    setLocalSelection(id);
    select(id);
    return true;
  };
  useEffect(() => {
    if (
      selected !== graph.id &&
      !graph.nodes.some((n) => n.id === selected) &&
      !graph.edges.some((e) => e.id === selected)
    ) {
      setLocalSelection(graph.id);
      select(graph.id);
    }
  }, [graph.id, graph.nodes, graph.edges, selected, select]);
  useEffect(() => {
    if (!Object.hasOwn(profile.nodes, nodeType)) setNodeType(Object.keys(profile.nodes)[0] ?? '');
  }, [profile, nodeType]);
  function apply(intents: GraphIntent[], base = stamp): boolean {
    try {
      const current = latest.current;
      if (current.readOnly) throw new Error('Graph is read only');
      if (base !== current.stamp) throw new Error('Stale Graph projection; reload current values');
      graphCommand(current.profile, intents).apply(current.graph);
      if (current.onEdit(intents, base) === false) return false;
      setError('');
      return true;
    } catch (e) {
      const message =
        e instanceof GraphValidationError
          ? formatGraphDiagnostic(e.diagnostic, e.graph, profile, locale)
          : (e as Error).message;
      setError(message);
      onError?.(message);
      return false;
    }
  }
  function prepareConnection(): GraphIntent {
    if (readOnly) throw new Error('このHostではGraphを編集できません。');
    if (connection.base !== stamp || connection.target !== id)
      throw new Error('Stale connection input; reload current values before editing.');
    if (!from || !to || !edgeType)
      throw new Error('接続の種類と両端を選択するか、接続入力をキャンセルしてください。');
    const existing = graph.edges.find((edge) => edge.id === connection.target);
    if ((existing ? profile.edges[existing.type] : profile.edges[edgeType])?.readOnly)
      throw new Error('この接続の定義は編集できません。');
    const intent: GraphIntent = existing
      ? { type: 'reconnect-edge', id: existing.id, from, to }
      : {
          type: 'add-edge',
          edge: {
            id: edgeId?.(from, edgeType) ?? newId('edge'),
            type: edgeType,
            from,
            to,
            attributes: {},
          },
        };
    return intent;
  }
  useEditorInput({
    label: 'Graph',
    read: () => ({
      dirty: drafts.current.size > 0 || connection.dirty,
      composing: [...drafts.current.values()].some((draft) => draft.composing),
    }),
    prepare: () => {
      if (readOnly) throw new Error('このHostではGraphを編集できません。');
      const intents: GraphIntent[] = [];
      for (const [id, draft] of drafts.current) {
        invalidInput.current = id;
        const node = graph.nodes.find((node) => node.id === id);
        const edge = graph.edges.find((edge) => edge.id === id);
        const type =
          draft.scope === 'node'
            ? node && profile.nodes[node.type]
            : draft.scope === 'edge'
              ? edge && profile.edges[edge.type]
              : id === graph.id && profile.graph;
        if (!type || type.readOnly) throw new Error('対象が削除済み、または編集できない定義です。');
        intents.push(
          ...prepareGraphAttributeDraft(
            draft,
            node?.attributes ?? edge?.attributes ?? graph.attributes,
            type.schema,
          ),
        );
      }
      if (connection.dirty) {
        invalidInput.current = connection.target;
        intents.push(prepareConnection());
      }
      graphCommand(profile, intents).apply(graph);
      return () => {
        if (intents.length && !apply(intents, stamp)) return false;
        drafts.current.clear();
        setConnection((connection) => ({ ...connection, dirty: false }));
      };
    },
    focus: () => {
      choose(invalidInput.current ?? drafts.current.keys().next().value ?? graph.id);
      setTimeout(
        () =>
          root.current
            ?.querySelector<HTMLElement>(
              '.ep-graph-inspector input, .ep-graph-inspector select, .ep-graph-inspector textarea',
            )
            ?.focus(),
        0,
      );
    },
  });
  function remove() {
    if (readOnly) return;
    if (node) setDeletion({ id: node.id, base: stamp });
    else if (edge) apply([{ type: 'delete-edge', id: edge.id }]);
  }
  const positions = Object.fromEntries(
    graph.nodes.map((n, i) => [
      n.id,
      drag?.id === n.id
        ? drag.position
        : (graph.layout[n.id] ?? { x: 40 + (i % 3) * 260, y: 40 + Math.floor(i / 3) * 160 }),
    ]),
  );
  const visible = graph.nodes.filter((n) => !visibleNodeIds || visibleNodeIds.includes(n.id));
  const label = (id: string) => graphElementLabel(graph, profile, id);
  const nodeSizeKey = (node: GraphNode) =>
    canonicalJson([
      graph.id,
      label(node.id),
      profile.nodes[node.type].ui?.label ?? node.type,
      overlay?.[node.id] ?? null,
      readOnly,
    ]);
  const sizeOf = (node: GraphNode): GraphNodeSize => {
    if (nodeSize !== undefined)
      return graphNodeSize(typeof nodeSize === 'function' ? nodeSize(node) : nodeSize);
    const measured = nodeHeights.get(node.id);
    return { width: 200, height: measured?.key === nodeSizeKey(node) ? measured.height : 70 };
  };
  const boxes = Object.fromEntries(
    visible.map((node) => [
      node.id,
      {
        ...positions[node.id],
        ...sizeOf(node),
      },
    ]),
  );
  const visibleEdges = graph.edges.filter(
    (edge) =>
      boxes[edge.from] &&
      boxes[edge.to] &&
      (!visibleEdgeTypes || visibleEdgeTypes.includes(edge.type)),
  );
  const routes = new Map(
    visibleEdges.map((edge) => [
      edge.id,
      routeGraphEdge(boxes[edge.from], boxes[edge.to], Object.values(boxes), edge.from === edge.to),
    ]),
  );
  const edgeText = (edge: GraphDocument['edges'][number]) => {
    const ui = profile.edges[edge.type]?.ui;
    const text = ui?.label ?? edge.type;
    const value = ui?.labelField ? edge.attributes[ui.labelField] : undefined;
    return (typeof value === 'string' && value.trim()) ||
      typeof value === 'number' ||
      typeof value === 'boolean'
      ? `${text} · ${value}`
      : text;
  };
  const edgeLabels = placeMeasuredGraphEdgeLabels(
    visibleEdges.map((edge) => ({
      id: edge.id,
      route: routes.get(edge.id)!,
      text: edgeText(edge),
      size: labelSizes.get(edge.id)?.text === edgeText(edge) ? labelSizes.get(edge.id) : undefined,
    })),
    Object.values(boxes),
  );
  const drawingBounds = [
    ...Object.values(boxes),
    ...[...routes.values()].flatMap((route) =>
      route.points.map((point) => ({ ...point, width: 1, height: 1 })),
    ),
    ...[...edgeLabels.values()].filter((label) => !label.deferred).map((label) => label.bounds),
  ];
  function fit() {
    const view = fitGraphView(drawingBounds, viewport);
    setZoom(view.zoom);
    setPan({ x: view.x, y: view.y });
    if (canvas.current) {
      canvas.current.scrollLeft = 0;
      canvas.current.scrollTop = 0;
    }
  }
  const filterKey = canonicalJson(visibleNodeIds ? [...new Set(visibleNodeIds)].sort() : null);
  const labelsMeasured = visibleEdges.every(
    // Refused routes retain their diagnostic, but mount no edge label to measure.
    (edge) =>
      !routes.get(edge.id)!.path ||
      !edgeText(edge) ||
      labelSizes.get(edge.id)?.text === edgeText(edge),
  );
  const nodesMeasured =
    nodeSize !== undefined ||
    visible.every((node) => nodeHeights.get(node.id)?.key === nodeSizeKey(node));
  useEffect(() => {
    if (!viewport.width || !viewport.height) return;
    const setup = cameraSetup.current;
    if (setup.graphId !== graph.id) {
      setup.graphId = graph.id;
      setup.initialized = false;
    }
    // A retained Surface already has a viewport when new labels first render.
    // Defer only a pending automatic Fit until their actual glyph bounds arrive.
    if (
      (!labelsMeasured || !nodesMeasured) &&
      ((!setup.initialized && initialView === 'fit') ||
        (setup.initialized && setup.filter !== filterKey && fitOnFilterChange))
    )
      return;
    if (!setup.initialized) {
      if (initialView === 'fit' && !visible.length) return;
      setup.initialized = true;
      if (initialView === 'fit') fit();
      else {
        const view =
          typeof initialView === 'object' &&
          [initialView.x, initialView.y, initialView.zoom].every(Number.isFinite) &&
          initialView.zoom > 0
            ? initialView
            : { x: 0, y: 0, zoom: 1 };
        setZoom(Math.max(0.001, Math.min(2, view.zoom)));
        setPan({ x: view.x, y: view.y });
        if (canvas.current) {
          canvas.current.scrollLeft = 0;
          canvas.current.scrollTop = 0;
        }
      }
    } else if (setup.filter !== filterKey && fitOnFilterChange) fit();
    setup.filter = filterKey;
  }, [
    graph.id,
    filterKey,
    fitOnFilterChange,
    initialView,
    viewport.width,
    viewport.height,
    visible.length,
    labelsMeasured,
    nodesMeasured,
  ]);
  const neighbors = new Set(node ? [node.id] : []);
  if (node && highlightAdjacent)
    for (const edge of graph.edges) {
      if (edge.from === node.id) neighbors.add(edge.to);
      if (edge.to === node.id) neighbors.add(edge.from);
    }
  function startNodeDrag(event: PointerEvent<HTMLElement>, node: GraphNode) {
    if (event.button !== 0 || readOnly || profile.nodes[node.type]?.readOnly || endpoint) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    if (!choose(node.id)) return;
    const position = positions[node.id];
    setDrag({
      id: node.id,
      pointer: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      initial: position,
      position,
      base: stamp,
    });
  }
  function moveNode(event: PointerEvent<HTMLElement>, commit = false) {
    if (!drag || drag.pointer !== event.pointerId) return;
    const position = {
      x: drag.initial.x + (event.clientX - drag.start.x) / zoom,
      y: drag.initial.y + (event.clientY - drag.start.y) / zoom,
    };
    if (commit) {
      if (canonicalJson(position) !== canonicalJson(drag.initial))
        apply([{ type: 'move-node', id: drag.id, position }], drag.base);
      setDrag(undefined);
    } else setDrag({ ...drag, position });
  }
  function endpointCandidate(event: PointerEvent<SVGCircleElement>) {
    if (!endpoint || endpoint.pointer !== event.pointerId) return;
    const rect = root.current?.querySelector('.ep-graph-plane')?.getBoundingClientRect();
    if (!rect) return;
    const point = { x: (event.clientX - rect.left) / zoom, y: (event.clientY - rect.top) / zoom };
    const target = [...visible].reverse().find((node) => {
      const box = boxes[node.id];
      return (
        point.x >= box.x - 14 &&
        point.x <= box.x + box.width + 14 &&
        point.y >= box.y - 14 &&
        point.y <= box.y + box.height + 14
      );
    })?.id;
    let reason = target ? '' : '接続先のノードへ端点を移動してください。';
    if (target) {
      const edge = graph.edges.find((edge) => edge.id === endpoint.id);
      if (!edge)
        return {
          ...endpoint,
          point,
          target,
          reason: '接続が変更されました。現在の線を選び直してください。',
        };
      const intent: GraphIntent = {
        type: 'reconnect-edge',
        id: edge.id,
        from: endpoint.side === 'from' ? target : edge.from,
        to: endpoint.side === 'to' ? target : edge.to,
      };
      try {
        if (latest.current.readOnly || latest.current.stamp !== endpoint.base)
          throw new Error('編集中にGraphが変更されました。もう一度操作してください。');
        const next = {
          ...graph,
          edges: graph.edges.map((edge) =>
            edge.id === intent.id ? { ...edge, from: intent.from, to: intent.to } : edge,
          ),
        };
        const invalid = validateGraph(next, profile).find((diagnostic) => diagnostic.blocking);
        if (invalid) throw new Error(formatGraphDiagnostic(invalid, next, profile, locale));
        graphCommand(profile, [intent]).apply(graph);
        previewEdit?.([intent], endpoint.base);
      } catch (error) {
        reason = `${label(target)}: ${String(error instanceof Error ? error.message : error)}`;
      }
    }
    return { ...endpoint, point, target, reason };
  }
  const worldWidth = Math.max(900, ...drawingBounds.map((box) => box.x + box.width + 60)),
    worldHeight = Math.max(500, ...drawingBounds.map((box) => box.y + box.height + 70));
  return (
    <div
      className="ep-graph"
      ref={root}
      aria-label="Structured Graph Editor"
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        const target = e.target as HTMLElement;
        if (deletion) {
          if (e.key === 'Escape') {
            e.preventDefault();
            setDeletion(undefined);
            root.current?.querySelector<HTMLElement>('[aria-label="Graph canvas"]')?.focus();
          }
          if (e.key === 'Tab') {
            const buttons =
              root.current?.querySelectorAll<HTMLButtonElement>('[role="dialog"] button');
            if (buttons?.length) {
              const first = buttons[0],
                last = buttons[buttons.length - 1];
              if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
              } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
              }
            }
          }
          return;
        }

        if (target.closest('input,textarea,select,form')) return;
        if (
          history &&
          !readOnly &&
          (e.ctrlKey || e.metaKey) &&
          ['z', 'y'].includes(e.key.toLowerCase())
        ) {
          e.preventDefault();
          e.stopPropagation();
          if (e.shiftKey || e.key.toLowerCase() === 'y') history.redo();
          else history.undo();
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setDrag(undefined);
          setEndpoint(undefined);
          setDeletion(undefined);
          root.current?.querySelector<HTMLElement>('[aria-label="Graph canvas"]')?.focus();
          return;
        }
        if ((e.key === 'Delete' || e.key === 'Backspace') && !readOnly) {
          e.preventDefault();
          remove();
        }
        if (
          node &&
          !readOnly &&
          !profile.nodes[node.type]?.readOnly &&
          !e.ctrlKey &&
          !e.metaKey &&
          ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)
        ) {
          e.preventDefault();
          const p = positions[node.id];
          apply([
            {
              type: 'move-node',
              id: node.id,
              position: {
                x: p.x + (e.key === 'ArrowRight' ? 10 : e.key === 'ArrowLeft' ? -10 : 0),
                y: p.y + (e.key === 'ArrowDown' ? 10 : e.key === 'ArrowUp' ? -10 : 0),
              },
            },
          ]);
        }
      }}
    >
      <div className="ep-graph-toolbar" role="toolbar" aria-label="Graph tools">
        {!readOnly && (
          <>
            <Menu label="Graph source and definitions">
              <p>
                所有元: {sourceActions?.owner ?? `Host Profile ${profile.id}`} ·{' '}
                {node?.type ?? edge?.type ?? profile.id}
              </p>
              <button
                onClick={() => {
                  if (sourceActions?.onOpenSource) sourceActions.onOpenSource(id);
                  else {
                    try {
                      inputs?.flush();
                      setDefinitionTarget(undefined);
                    } catch (error) {
                      setError(String(error instanceof Error ? error.message : error));
                    }
                  }
                }}
              >
                元データを開く
              </button>
              <button
                onClick={() => {
                  if (sourceActions?.onOpenDefinition) sourceActions.onOpenDefinition(id);
                  else {
                    try {
                      inputs?.flush();
                      if (!inputs && (drafts.current.size || connection.dirty))
                        throw new Error(
                          '属性・接続を適用するか、キャンセルしてから定義を開いてください。',
                        );
                      setDefinitionTarget({
                        scope,
                        ...(node || edge ? { type: node?.type ?? edge?.type } : {}),
                      });
                    } catch (error) {
                      setError(String(error instanceof Error ? error.message : error));
                    }
                  }
                }}
              >
                データ定義
              </button>
            </Menu>
            <label>
              Node type
              <select
                aria-label="Node type"
                value={nodeType}
                onChange={(e) => setNodeType(e.target.value)}
                disabled={readOnly}
              >
                {Object.entries(profile.nodes).map(([key, t]) => (
                  <option key={key} value={key}>
                    {t.ui?.label ?? key}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={readOnly || !nodeType || !!profile.nodes[nodeType]?.readOnly}
              onClick={() => {
                const id = nodeId?.() ?? newId('node');
                if (
                  apply([
                    {
                      type: 'add-node',
                      node: nodeFactory?.(id, nodeType) ?? createGraphNode(profile, nodeType, id),
                      position: {
                        x: 40 + (graph.nodes.length % 3) * 260,
                        y: 40 + Math.floor(graph.nodes.length / 3) * 160,
                      },
                    },
                  ])
                )
                  choose(id);
              }}
            >
              Add node
            </button>
            <button onClick={() => choose(graph.id)}>Graph properties</button>
            <button disabled={readOnly || (!node && !edge) || !!type.readOnly} onClick={remove}>
              Delete selection
            </button>
          </>
        )}
        <button
          aria-label="Zoom out"
          onClick={() =>
            setZoom((z) => Math.max(0.001, z > 0.25 ? Math.max(0.25, z - 0.25) : z / 2))
          }
        >
          −
        </button>
        <output aria-label="Graph zoom">{Math.round(zoom * 100)}%</output>
        <button aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(2, z + 0.25))}>
          +
        </button>
        <button
          onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
        >
          Reset view
        </button>
        <button aria-label="Pan left" onClick={() => setPan((p) => ({ ...p, x: p.x - 50 }))}>
          ←
        </button>
        <button aria-label="Pan right" onClick={() => setPan((p) => ({ ...p, x: p.x + 50 }))}>
          →
        </button>
      </div>
      <div className="ep-graph-view-controls">
        <button aria-label="Pan up" onClick={() => setPan((p) => ({ ...p, y: p.y - 50 }))}>
          ↑
        </button>
        <button aria-label="Pan down" onClick={() => setPan((p) => ({ ...p, y: p.y + 50 }))}>
          ↓
        </button>
        <button onClick={fit}>Fit graph</button>
      </div>
      <div className="ep-graph-body">
        <div
          className="ep-graph-canvas"
          ref={canvas}
          aria-label="Graph canvas"
          role="group"
          tabIndex={0}
        >
          <div
            className="ep-graph-world"
            style={{ width: worldWidth * zoom, height: worldHeight * zoom }}
          >
            <div
              className="ep-graph-plane"
              style={{
                width: worldWidth,
                height: worldHeight,
                transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})`,
              }}
            >
              <svg width={worldWidth} height={worldHeight} aria-label="Graph connections">
                <defs>
                  <marker
                    id={marker}
                    markerWidth="10"
                    markerHeight="10"
                    refX="9"
                    refY="3"
                    orient="auto"
                    markerUnits="strokeWidth"
                  >
                    <path d="M0,0 L0,6 L9,3 z" fill="context-stroke" />
                  </marker>
                </defs>
                {[...visibleEdges]
                  // Keep selected handles above other connections' hit strokes.
                  .sort((a, b) => Number(a.id === selected) - Number(b.id === selected))
                  .map((edge) => {
                    const route = routes.get(edge.id)!;
                    const selectedEdge = selected === edge.id;
                    const text = profile.edges[edge.type]?.ui?.label ?? edge.type;
                    const displayText = edgeText(edge);
                    const placement = edgeLabels.get(edge.id)!;
                    const style = profile.edges[edge.type]?.ui?.edgeStyle;
                    return (
                      <g
                        key={edge.id}
                        data-edge-id={edge.id}
                        className={`ep-graph-edge ${selectedEdge ? 'selected' : ''} ${highlightAdjacent && node && edge.from !== node.id && edge.to !== node.id ? 'dimmed' : ''}`}
                      >
                        <path
                          d={route.path}
                          fill="none"
                          stroke={style?.color ?? (selectedEdge ? '#2563eb' : '#64748b')}
                          strokeWidth={selectedEdge ? 3 : 2}
                          strokeDasharray={style?.dash?.join(' ')}
                          markerEnd={`url(#${marker})`}
                        />
                        <path
                          d={route.path}
                          className="ep-graph-edge-hit"
                          fill="none"
                          stroke="transparent"
                          strokeWidth="18"
                          tabIndex={0}
                          role="button"
                          aria-label={`Select connection ${text}: ${label(edge.from)} to ${label(edge.to)}`}
                          aria-description={displayText}
                          onClick={() => choose(edge.id)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              choose(edge.id);
                            }
                          }}
                        >
                          <title>
                            {displayText}: {label(edge.from)} → {label(edge.to)}
                          </title>
                        </path>
                        {route.path && (
                          <g
                            className={`ep-graph-edge-label ${placement.deferred ? 'deferred' : ''}`}
                            pointerEvents="none"
                          >
                            <rect
                              x={placement.bounds.x}
                              y={placement.bounds.y}
                              width={placement.bounds.width}
                              height={placement.bounds.height}
                              rx="5"
                            />
                            <text
                              x={placement.point.x}
                              y={placement.point.y + 4}
                              textAnchor="middle"
                            >
                              {displayText}
                            </text>
                          </g>
                        )}
                        {!route.path && (
                          <text x={route.label.x} y={route.label.y - 18}>
                            ノードの重なりを解消してください
                          </text>
                        )}
                        {selectedEdge &&
                          !readOnly &&
                          !profile.edges[edge.type]?.readOnly &&
                          (['from', 'to'] as const).map((side) => {
                            const point = side === 'from' ? route.source : route.target;
                            return (
                              <circle
                                key={side}
                                cx={point.x}
                                cy={point.y}
                                r="9"
                                className="ep-graph-endpoint"
                                role="button"
                                tabIndex={0}
                                aria-label={`Drag connection ${side}: ${text}`}
                                onPointerDown={(event) => {
                                  if (event.button !== 0) return;
                                  event.preventDefault();
                                  event.stopPropagation();
                                  event.currentTarget.focus();
                                  event.currentTarget.setPointerCapture(event.pointerId);
                                  setEndpoint({
                                    id: edge.id,
                                    side,
                                    pointer: event.pointerId,
                                    base: stamp,
                                    point,
                                  });
                                }}
                                onPointerMove={(event) => {
                                  const next = endpointCandidate(event);
                                  if (next) setEndpoint(next);
                                }}
                                onPointerUp={(event) => {
                                  const next = endpointCandidate(event);
                                  if (next?.target && !next.reason && next.target !== edge[side])
                                    apply(
                                      [
                                        {
                                          type: 'reconnect-edge',
                                          id: edge.id,
                                          from: side === 'from' ? next.target : edge.from,
                                          to: side === 'to' ? next.target : edge.to,
                                        },
                                      ],
                                      next.base,
                                    );
                                  else if (next?.reason) setError(next.reason);
                                  setEndpoint(undefined);
                                }}
                                onPointerCancel={() => setEndpoint(undefined)}
                                onLostPointerCapture={() => setEndpoint(undefined)}
                              />
                            );
                          })}
                      </g>
                    );
                  })}
                {endpoint &&
                  routes.has(endpoint.id) &&
                  (() => {
                    const route = routes.get(endpoint.id)!;
                    const fixed = endpoint.side === 'from' ? route.target : route.source;
                    return (
                      <path
                        className="ep-graph-endpoint-preview"
                        d={`M${fixed.x},${fixed.y} L${endpoint.point.x},${endpoint.point.y}`}
                        fill="none"
                        stroke={endpoint.target && !endpoint.reason ? '#16a34a' : '#d97706'}
                        strokeWidth="3"
                        strokeDasharray="6 4"
                        pointerEvents="none"
                      />
                    );
                  })()}
              </svg>
              {visible.map((n) => (
                <div
                  className={`ep-graph-node ${selected === n.id ? 'selected' : ''} ${highlightAdjacent && node && !neighbors.has(n.id) ? 'dimmed' : ''} ${edge && (edge.from === n.id || edge.to === n.id) ? 'connected' : ''} ${endpoint?.target === n.id ? (endpoint.reason ? 'invalid-target' : 'valid-target') : ''}`}
                  key={n.id}
                  style={{
                    left: boxes[n.id].x,
                    top: boxes[n.id].y,
                    width: boxes[n.id].width,
                    height: boxes[n.id].height,
                  }}
                  data-node-id={n.id}
                  data-auto-size-key={nodeSize === undefined ? nodeSizeKey(n) : undefined}
                >
                  <button
                    className="ep-graph-node-select"
                    aria-label={`Select node ${label(n.id)}`}
                    title={label(n.id)}
                    onClick={() => choose(n.id)}
                    onPointerDown={(event) => startNodeDrag(event, n)}
                    onPointerMove={(event) => moveNode(event)}
                    onPointerUp={(event) => moveNode(event, true)}
                    onPointerCancel={() => setDrag(undefined)}
                    onLostPointerCapture={() => setDrag(undefined)}
                  >
                    <span className="ep-graph-node-content">
                      {label(n.id)}
                      <small>{profile.nodes[n.type].ui?.label ?? n.type}</small>
                      {overlay?.[n.id] && <span>{overlay[n.id]}</span>}
                    </span>
                  </button>
                  {!readOnly && (
                    <button
                      className="ep-graph-drag"
                      aria-label={`Move node ${label(n.id)}`}
                      disabled={readOnly || !!profile.nodes[n.type].readOnly}
                      onPointerDown={(event) => startNodeDrag(event, n)}
                      onPointerMove={(event) => moveNode(event)}
                      onPointerUp={(event) => moveNode(event, true)}
                      onPointerCancel={() => setDrag(undefined)}
                      onLostPointerCapture={() => setDrag(undefined)}
                    >
                      ↔
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
          {endpoint && (
            <p className="ep-graph-gesture-status" role="status">
              {endpoint.target && !endpoint.reason
                ? `${label(endpoint.target)}へ接続します`
                : (endpoint.reason ?? '接続先のノードへ端点を移動してください。')}
            </p>
          )}
          {!visible.length && (
            <p className="ep-graph-empty">No visible nodes. Add a node or clear the view filter.</p>
          )}
        </div>
        <aside className="ep-graph-inspector" aria-label="Graph Inspector" hidden={!showInspector}>
          <h2>
            {node
              ? label(node.id)
              : edge
                ? (profile.edges[edge.type].ui?.label ?? edge.type)
                : 'Graph properties'}
          </h2>
          <p className="ep-graph-source-owner">
            所有元: {sourceActions?.owner ?? `Host Profile ${profile.id}`} · 種類:{' '}
            {node?.type ?? edge?.type ?? 'graph'}
          </p>
          {definitionTarget && (
            <div hidden={readOnly}>
              <GraphDefinitionEditor
                key={`${definitionTarget.scope}:${definitionTarget.type ?? ''}`}
                graph={graph}
                profile={profile}
                {...definitionTarget}
                host={sourceActions}
                readOnly={readOnly}
                onClose={() => setDefinitionTarget(undefined)}
              />
            </div>
          )}
          {(!definitionTarget || readOnly) && (
            <>
              <GraphAttributes
                key={id}
                attributes={attributes}
                schema={type.schema}
                ui={type.ui}
                scope={scope}
                id={id}
                stamp={stamp}
                readOnly={readOnly || !!type.readOnly}
                viewOnly={readOnly}
                onEdit={apply}
                diagnostics={problems
                  .filter((d) => d.elementId === id)
                  .map((diagnostic) => ({
                    ...diagnostic,
                    message: formatGraphDiagnostic(diagnostic, graph, profile, locale),
                  }))}
                drafts={drafts.current}
              />
              {!readOnly && (
                <form
                  aria-label="Connection editor"
                  className="ep-graph-connection"
                  onSubmit={(e) => {
                    e.preventDefault();
                    try {
                      const intent = prepareConnection();
                      if (apply([intent], connection.base))
                        setConnection({ ...connection, dirty: false });
                    } catch (error) {
                      setError(String(error instanceof Error ? error.message : error));
                    }
                  }}
                >
                  <h3>{edge ? 'Retarget connection' : 'Connect nodes'}</h3>
                  <label>
                    Relation type
                    <select
                      aria-label="Relation type"
                      disabled={readOnly || !!edge}
                      value={edge?.type ?? edgeType}
                      onChange={(e) => editConnection({ type: e.target.value })}
                    >
                      <option value="">Choose relation</option>
                      {Object.entries(profile.edges).map(([key, t]) => (
                        <option key={key} value={key}>
                          {t.ui?.label ?? key}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    From
                    <select
                      aria-label="Connection from"
                      value={from}
                      disabled={readOnly}
                      onChange={(e) => editConnection({ from: e.target.value })}
                    >
                      <option value="">Choose node</option>
                      {graph.nodes.map((n) => (
                        <option key={n.id} value={n.id}>
                          {label(n.id)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    To
                    <select
                      aria-label="Connection to"
                      value={to}
                      disabled={readOnly}
                      onChange={(e) => editConnection({ to: e.target.value })}
                    >
                      <option value="">Choose node</option>
                      {graph.nodes.map((n) => (
                        <option key={n.id} value={n.id}>
                          {label(n.id)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {edge && (
                    <button
                      type="button"
                      onClick={() => {
                        setConnection(currentConnection());
                      }}
                    >
                      Use selected connection
                    </button>
                  )}
                  <button type="button" onClick={() => setConnection(currentConnection())}>
                    Cancel connection input
                  </button>
                  {connectionStale && (
                    <p role="status">Connection input is stale. Reload current values.</p>
                  )}
                  <button type="button" onClick={() => setConnection(currentConnection())}>
                    Reload connection
                  </button>
                  <button
                    disabled={
                      readOnly ||
                      !Object.keys(profile.edges).length ||
                      !!(edge
                        ? profile.edges[edge.type].readOnly
                        : profile.edges[edgeType]?.readOnly)
                    }
                    type="submit"
                  >
                    {edge ? 'Retarget connection' : 'Add connection'}
                  </button>
                </form>
              )}
              {!readOnly &&
                [...drafts.current]
                  .filter(([id, draft]) =>
                    draft.scope === 'node'
                      ? !graph.nodes.some((node) => node.id === id)
                      : draft.scope === 'edge'
                        ? !graph.edges.some((edge) => edge.id === id)
                        : id !== graph.id,
                  )
                  .map(([id, draft]) => (
                    <details key={id}>
                      <summary>削除された対象の未確定入力があります</summary>
                      <textarea
                        aria-label="Retained deleted Graph input"
                        readOnly
                        value={JSON.stringify(draft.values, null, 2)}
                      />
                      <button
                        onClick={() => {
                          drafts.current.delete(id);
                          inputs?.changed();
                          setError('');
                        }}
                      >
                        Discard deleted Graph input
                      </button>
                    </details>
                  ))}
              <section aria-label="Graph diagnostics">
                <h3>Diagnostics ({problems.length})</h3>
                {problems.map((d, i) => (
                  <button
                    key={`${d.elementId}:${d.code}:${i}`}
                    className="ep-graph-diagnostic"
                    onClick={() => choose(d.elementId)}
                  >
                    {formatGraphDiagnostic(d, graph, profile, locale)}
                  </button>
                ))}
              </section>
              <details>
                <summary>Nodes and connections</summary>
                {readOnly && <button onClick={() => choose(graph.id)}>Graph summary</button>}
                {graph.nodes.map((n) => (
                  <button key={n.id} onClick={() => choose(n.id)}>
                    {label(n.id)}
                  </button>
                ))}
                {graph.edges.map((e) => (
                  <button key={e.id} onClick={() => choose(e.id)}>
                    {profile.edges[e.type]?.ui?.label ?? e.type}: {label(e.from)} → {label(e.to)}
                  </button>
                ))}
              </details>
            </>
          )}
          {error && <p role="alert">{error}</p>}
        </aside>
      </div>
      {!showInspector && error && <p role="alert">{error}</p>}
      {deletion && (
        <div className="ep-graph-dialog-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Confirm graph deletion"
            className="ep-graph-dialog"
          >
            <h2>Delete node and related connections?</h2>
            <p>
              This atomically removes{' '}
              {graph.edges.filter((e) => e.from === deletion.id || e.to === deletion.id).length}{' '}
              connections. External sources may refuse protected references.
            </p>
            <button
              autoFocus
              onClick={() => {
                if (
                  apply([{ type: 'delete-node', id: deletion.id, cascade: true }], deletion.base)
                ) {
                  setDeletion(undefined);
                  choose(graph.id);
                  root.current?.querySelector<HTMLElement>('[aria-label="Graph canvas"]')?.focus();
                }
              }}
            >
              Confirm deletion
            </button>
            <button
              onClick={() => {
                setDeletion(undefined);
                root.current?.querySelector<HTMLElement>('[aria-label="Graph canvas"]')?.focus();
              }}
            >
              Cancel deletion
            </button>
          </section>
        </div>
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
