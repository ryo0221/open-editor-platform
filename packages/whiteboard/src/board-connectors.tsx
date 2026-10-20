import { useEffect, useRef, useState, type RefObject } from 'react';
import type { EditorCommand, Point } from '@editor-platform/editor-core';
import type { CanvasTarget } from '@editor-platform/canvas-ui';
import {
  connectorProjector,
  connectorPath,
  updateConnector,
  type WhiteboardConnector,
  type WhiteboardContent,
  type WhiteboardNode,
} from './model';
import { sectionAt } from './sections';

export type ConnectorEndpointDrag = { side: 'from' | 'to'; point: Point };
export interface BoardConnectorLayerProps {
  /** Canvas targets with live preview geometry. */
  projected: CanvasTarget[];
  /** Overlay pass: endpoint handles and the attach candidate only. */
  handlesOnly?: boolean;
  content: WhiteboardContent;
  paintOrder: WhiteboardNode[];
  zoom: number;
  connectorId: string;
  readOnly: boolean;
  endpoint?: ConnectorEndpointDrag;
  setEndpoint: (endpoint?: ConnectorEndpointDrag) => void;
  endpointPointer: RefObject<number | undefined>;
  chooseConnector: (id: string) => void;
  apply: (cmd: EditorCommand<WhiteboardContent>) => boolean;
}
/** Endpoint drag state; Escape cancels a drag in progress. */
export function useEndpointDrag() {
  const [endpoint, setEndpoint] = useState<ConnectorEndpointDrag>();
  const endpointPointer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        endpointPointer.current = undefined;
        setEndpoint(undefined);
      }
    };
    window.addEventListener('keydown', cancel, true);
    return () => window.removeEventListener('keydown', cancel, true);
  }, []);
  return { endpoint, setEndpoint, endpointPointer };
}
type Projected = { x1: number; y1: number; x2: number; y2: number };

/** Section regions plus connectors drawn against the dragged (previewed) geometry. */
export function BoardConnectorLayer(props: BoardConnectorLayerProps) {
  const { projected, handlesOnly = false, content, endpoint, connectorId } = props;
  const candidate = endpoint && connectorTargetAt(props.paintOrder, endpoint.point);
  const byId = new Map(projected.map((target) => [target.id, target]));
  const draft = {
    ...content,
    nodes: content.nodes.map((n) => ({
      ...n,
      bounds: byId.get(n.id)?.bounds ?? n.bounds,
    })),
  };
  const projectConnector = connectorProjector(draft);
  return (
    <>
      {!handlesOnly && <SectionRegions {...props} byId={byId} />}
      {handlesOnly && candidate && (
        <rect
          {...candidate.bounds}
          fill="none"
          stroke="#3267c8"
          strokeWidth={3 / props.zoom}
          pointerEvents="none"
          data-testid="connector-candidate"
          data-target-id={candidate.id}
        />
      )}
      <defs>
        <marker
          id="board-end"
          markerWidth="8"
          markerHeight="8"
          refX="8"
          refY="4"
          orient="auto-start-reverse"
        >
          <path d="M0 0L8 4L0 8Z" fill="#637187" />
        </marker>
      </defs>
      {draft.connectors.map((c) => {
        const temp =
            endpoint && c.id === connectorId
              ? { ...c, [endpoint.side]: '', [`${endpoint.side}Point`]: endpoint.point }
              : c,
          p = projectConnector(temp);
        if (!p) return null;
        if (handlesOnly && connectorId !== c.id) return null;
        return (
          <g
            key={c.id}
            data-testid="board-connector"
            onPointerDown={(e) => {
              e.stopPropagation();
              props.chooseConnector(c.id);
            }}
          >
            {!handlesOnly && <ConnectorStroke connector={c} p={p} zoom={props.zoom} />}
            {handlesOnly &&
              connectorId === c.id &&
              !props.readOnly &&
              (['from', 'to'] as const).map((side) => (
                <EndpointHandle key={side} {...props} connector={c} side={side} p={p} />
              ))}
          </g>
        );
      })}
    </>
  );
}

/** Section fills, outlined while a dragged root object would land in them. */
function SectionRegions({
  content,
  zoom,
  byId,
}: BoardConnectorLayerProps & { byId: Map<string, CanvasTarget> }) {
  return content.sections?.map((s) => {
    const b = byId.get(s.id)?.bounds ?? s.bounds;
    const candidate = content.nodes.some((n) => {
      const target = byId.get(n.id);
      return (
        target &&
        !n.groupId &&
        (target.bounds.x !== n.bounds.x || target.bounds.y !== n.bounds.y) &&
        sectionAt(content, target.bounds)?.id === s.id
      );
    });
    return (
      <rect
        key={s.id}
        {...b}
        fill={s.background}
        rx={8}
        pointerEvents="none"
        stroke={candidate ? '#5269c8' : 'none'}
        strokeWidth={3 / zoom}
      />
    );
  });
}

function ConnectorStroke({
  connector: c,
  p,
  zoom,
}: {
  connector: WhiteboardConnector;
  p: Projected;
  zoom: number;
}) {
  const arrow = c.arrowhead ?? 'end';
  return (
    <>
      <path d={connectorPath(c, p)} fill="none" stroke="transparent" strokeWidth={14 / zoom} />
      <path
        d={connectorPath(c, p)}
        fill="none"
        stroke={c.stroke ?? '#637187'}
        strokeWidth={c.strokeWidth ?? 2}
        markerEnd={arrow !== 'none' ? 'url(#board-end)' : undefined}
        markerStart={arrow === 'both' ? 'url(#board-end)' : undefined}
      />
      <text
        x={(p.x1 + p.x2) / 2}
        y={(p.y1 + p.y2) / 2 - 8}
        textAnchor="middle"
        fontSize={14}
        fill="#253044"
        stroke="white"
        strokeWidth={4}
        paintOrder="stroke"
      >
        {c.label}
      </text>
    </>
  );
}

function EndpointHandle({
  connector: c,
  side,
  p,
  zoom,
  paintOrder,
  endpoint,
  setEndpoint,
  endpointPointer,
  apply,
}: BoardConnectorLayerProps & {
  connector: WhiteboardConnector;
  side: 'from' | 'to';
  p: Projected;
}) {
  return (
    <circle
      role="button"
      aria-label={`Move connector ${side}`}
      cx={side === 'from' ? p.x1 : p.x2}
      cy={side === 'from' ? p.y1 : p.y2}
      r={10 / zoom}
      fill="white"
      stroke="#3267c8"
      strokeWidth={2 / zoom}
      onPointerDown={(e) => {
        e.stopPropagation();
        endpointPointer.current = e.pointerId;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (
          endpointPointer.current !== e.pointerId ||
          !e.currentTarget.hasPointerCapture(e.pointerId)
        )
          return;
        const matrix = e.currentTarget.getScreenCTM();
        if (matrix) {
          const point = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
          setEndpoint({ side, point: { x: point.x, y: point.y } });
        }
      }}
      onPointerCancel={() => {
        endpointPointer.current = undefined;
        setEndpoint(undefined);
      }}
      onPointerUp={(e) => {
        e.stopPropagation();
        if (!endpoint || endpointPointer.current !== e.pointerId) return;
        endpointPointer.current = undefined;
        const point = endpoint.point,
          target = connectorTargetAt(paintOrder, point);
        apply(
          updateConnector(c.id, {
            [side]: target?.id ?? '',
            [`${side}Point`]: point,
            [`${side}Port`]: nearestPort(point, target),
          }),
        );
        setEndpoint(undefined);
      }}
    />
  );
}

/** Topmost node whose bounds, grown by the snap margin, contain the point. */
function connectorTargetAt(paintOrder: WhiteboardNode[], point: Point) {
  return [...paintOrder]
    .reverse()
    .find(
      (n) =>
        !n.hidden &&
        n.kind !== 'group' &&
        n.kind !== 'freehand' &&
        point.x >= n.bounds.x - 12 &&
        point.x <= n.bounds.x + n.bounds.width + 12 &&
        point.y >= n.bounds.y - 12 &&
        point.y <= n.bounds.y + n.bounds.height + 12,
    );
}
/** Built-in port for the node edge nearest to the point. */
function nearestPort(point: Point, target: WhiteboardNode | undefined) {
  if (!target) return 'auto';
  const b = target.bounds,
    distances = [
      ['left', Math.abs(point.x - b.x)],
      ['right', Math.abs(point.x - b.x - b.width)],
      ['top', Math.abs(point.y - b.y)],
      ['bottom', Math.abs(point.y - b.y - b.height)],
    ] as [string, number][];
  return distances.sort((a, b) => a[1] - b[1])[0][0];
}
