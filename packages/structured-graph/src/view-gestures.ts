import { type ContextType, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { canonicalJson } from '@editor-platform/artifact-core';
import { EditorHistoryContext } from '@editor-platform/editor-ui';
import { formatGraphDiagnostic, type GraphLocale } from './diagnostics';
import { type GraphDocument, type GraphEdge, type GraphNode, type Position } from './model';
import { validateGraph, type GraphProfile } from './profile';
import { graphCommand, type GraphIntent } from './commands';
import { type GraphLatest } from './view-hooks';
import {
  errorMessage,
  findEndpointTarget,
  graphArrowKeys,
  nudgedGraphPosition,
  type GraphApply,
  type GraphBox,
  type GraphDeletion,
  type GraphDrag,
  type GraphEndpointGesture,
} from './view-model';

export const focusGraphCanvas = (root: RefObject<HTMLDivElement | null>) =>
  root.current?.querySelector<HTMLElement>('[aria-label="Graph canvas"]')?.focus();

export interface NodeDragHandlers {
  start(event: PointerEvent<HTMLElement>, node: GraphNode): void;
  move(event: PointerEvent<HTMLElement>, commit?: boolean): void;
  cancel(): void;
}

export function createNodeDragHandlers(context: {
  drag?: GraphDrag;
  setDrag: (drag: GraphDrag | undefined) => void;
  readOnly: boolean;
  profile: GraphProfile;
  endpoint?: GraphEndpointGesture;
  choose: (id: string) => boolean;
  positions: Record<string, Position>;
  stamp: string;
  zoom: number;
  apply: GraphApply;
}): NodeDragHandlers {
  const { drag, setDrag, readOnly, profile, endpoint, choose, positions, stamp, zoom, apply } =
    context;
  return {
    start(event, node) {
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
    },
    move(event, commit = false) {
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
    },
    cancel: () => setDrag(undefined),
  };
}

export interface EndpointContext {
  endpoint?: GraphEndpointGesture;
  setEndpoint: (endpoint: GraphEndpointGesture | undefined) => void;
  root: RefObject<HTMLDivElement | null>;
  zoom: number;
  visible: GraphNode[];
  boxes: Record<string, GraphBox>;
  graph: GraphDocument;
  profile: GraphProfile;
  locale: GraphLocale;
  latest: RefObject<GraphLatest>;
  previewEdit?: (intents: GraphIntent[], base: string) => void;
  label: (id: string) => string;
  stamp: string;
  apply: GraphApply;
  setError: (message: string) => void;
}

function endpointReason(
  context: EndpointContext,
  endpoint: GraphEndpointGesture,
  target: string,
): string {
  const { graph, profile, locale, latest, previewEdit, label } = context;
  const edge = graph.edges.find((edge) => edge.id === endpoint.id);
  if (!edge) return '接続が変更されました。現在の線を選び直してください。';
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
    return '';
  } catch (error) {
    return `${label(target)}: ${errorMessage(error)}`;
  }
}

function endpointCandidate(
  context: EndpointContext,
  event: PointerEvent<SVGCircleElement>,
): GraphEndpointGesture | undefined {
  const { endpoint, root, zoom } = context;
  if (!endpoint || endpoint.pointer !== event.pointerId) return;
  const rect = root.current?.querySelector('.ep-graph-plane')?.getBoundingClientRect();
  if (!rect) return;
  const point = { x: (event.clientX - rect.left) / zoom, y: (event.clientY - rect.top) / zoom };
  const target = findEndpointTarget(point, context.visible, context.boxes);
  const reason = target
    ? endpointReason(context, endpoint, target)
    : '接続先のノードへ端点を移動してください。';
  return { ...endpoint, point, target, reason };
}

export interface EndpointHandlers {
  start(
    event: PointerEvent<SVGCircleElement>,
    id: string,
    side: 'from' | 'to',
    point: Position,
  ): void;
  move(event: PointerEvent<SVGCircleElement>): void;
  end(event: PointerEvent<SVGCircleElement>, edge: GraphEdge, side: 'from' | 'to'): void;
  cancel(): void;
}

export function createEndpointHandlers(context: EndpointContext): EndpointHandlers {
  const { setEndpoint, stamp, apply, setError } = context;
  return {
    start(event, id, side, point) {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      setEndpoint({ id, side, pointer: event.pointerId, base: stamp, point });
    },
    move(event) {
      const next = endpointCandidate(context, event);
      if (next) setEndpoint(next);
    },
    end(event, edge, side) {
      const next = endpointCandidate(context, event);
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
    },
    cancel: () => setEndpoint(undefined),
  };
}

export interface GraphKeyContext {
  root: RefObject<HTMLDivElement | null>;
  deletion?: GraphDeletion;
  setDeletion: (deletion: GraphDeletion | undefined) => void;
  history: ContextType<typeof EditorHistoryContext>;
  readOnly: boolean;
  cancelGestures: () => void;
  remove: () => void;
  node?: GraphNode;
  profile: GraphProfile;
  positions: Record<string, Position>;
  apply: GraphApply;
}

function handleDeletionDialogKey(e: KeyboardEvent<HTMLDivElement>, context: GraphKeyContext) {
  const { root } = context;
  if (e.key === 'Escape') {
    e.preventDefault();
    context.setDeletion(undefined);
    focusGraphCanvas(root);
  }
  if (e.key === 'Tab') {
    const buttons = root.current?.querySelectorAll<HTMLButtonElement>('[role="dialog"] button');
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
}

function handleHistoryKey(
  e: KeyboardEvent<HTMLDivElement>,
  { history, readOnly }: GraphKeyContext,
) {
  if (
    !history ||
    readOnly ||
    !(e.ctrlKey || e.metaKey) ||
    !['z', 'y'].includes(e.key.toLowerCase())
  )
    return false;
  e.preventDefault();
  e.stopPropagation();
  if (e.shiftKey || e.key.toLowerCase() === 'y') history.redo();
  else history.undo();
  return true;
}

function nudgeSelectedNode(e: KeyboardEvent<HTMLDivElement>, context: GraphKeyContext) {
  const { node, readOnly, profile } = context;
  if (
    node &&
    !readOnly &&
    !profile.nodes[node.type]?.readOnly &&
    !e.ctrlKey &&
    !e.metaKey &&
    graphArrowKeys.includes(e.key)
  ) {
    e.preventDefault();
    const p = context.positions[node.id];
    context.apply([{ type: 'move-node', id: node.id, position: nudgedGraphPosition(e.key, p) }]);
  }
}

export function handleGraphKeyDown(e: KeyboardEvent<HTMLDivElement>, context: GraphKeyContext) {
  if (e.nativeEvent.isComposing) return;
  const target = e.target as HTMLElement;
  if (context.deletion) {
    handleDeletionDialogKey(e, context);
    return;
  }

  if (target.closest('input,textarea,select,form')) return;
  if (handleHistoryKey(e, context)) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    context.cancelGestures();
    focusGraphCanvas(context.root);
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && !context.readOnly) {
    e.preventDefault();
    context.remove();
  }
  nudgeSelectedNode(e, context);
}
