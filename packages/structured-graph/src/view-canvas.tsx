import { type RefObject } from 'react';
import { type GraphEdgeLabel } from './display';
import { type GraphEdge, type GraphNode, type Position } from './model';
import { type GraphProfile } from './profile';
import { type GraphRoute } from './routing';
import { type EndpointHandlers, type NodeDragHandlers } from './view-gestures';
import {
  graphNodeClassName,
  isGraphEdgeDimmed,
  type GraphBox,
  type GraphEndpointGesture,
  type GraphScene,
} from './view-model';

interface GraphEdgeViewProps {
  edge: GraphEdge;
  route: GraphRoute;
  placement: GraphEdgeLabel;
  text: string;
  displayText: string;
  selected: boolean;
  dimmed: boolean;
  editable: boolean;
  marker: string;
  label: (id: string) => string;
  choose: (id: string) => boolean;
  endpointHandlers: EndpointHandlers;
  style?: { color?: string; dash?: number[] };
}

function GraphEdgeEndpoints({
  edge,
  route,
  text,
  endpointHandlers,
}: Pick<GraphEdgeViewProps, 'edge' | 'route' | 'text' | 'endpointHandlers'>) {
  return (['from', 'to'] as const).map((side) => {
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
        onPointerDown={(event) => endpointHandlers.start(event, edge.id, side, point)}
        onPointerMove={(event) => endpointHandlers.move(event)}
        onPointerUp={(event) => endpointHandlers.end(event, edge, side)}
        onPointerCancel={() => endpointHandlers.cancel()}
        onLostPointerCapture={() => endpointHandlers.cancel()}
      />
    );
  });
}

function GraphEdgeView(props: GraphEdgeViewProps) {
  const { edge, route, placement, text, displayText, selected, marker, label, choose, style } =
    props;
  return (
    <g
      data-edge-id={edge.id}
      className={`ep-graph-edge ${selected ? 'selected' : ''} ${props.dimmed ? 'dimmed' : ''}`}
    >
      <path
        d={route.path}
        fill="none"
        stroke={style?.color ?? (selected ? '#2563eb' : '#64748b')}
        strokeWidth={selected ? 3 : 2}
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
          <text x={placement.point.x} y={placement.point.y + 4} textAnchor="middle">
            {displayText}
          </text>
        </g>
      )}
      {!route.path && (
        <text x={route.label.x} y={route.label.y - 18}>
          ノードの重なりを解消してください
        </text>
      )}
      {selected && props.editable && <GraphEdgeEndpoints {...props} />}
    </g>
  );
}

function GraphEndpointPreview({
  endpoint,
  route,
}: {
  endpoint: GraphEndpointGesture;
  route: GraphRoute;
}) {
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
}

interface GraphNodeViewProps {
  node: GraphNode;
  box: GraphBox;
  className: string;
  text: string;
  typeLabel: string;
  overlayText?: string;
  autoSizeKey?: string;
  readOnly: boolean;
  nodeReadOnly: boolean;
  choose: (id: string) => boolean;
  nodeDrag: NodeDragHandlers;
}

function GraphNodeView({
  node: n,
  box,
  className,
  text,
  typeLabel,
  overlayText,
  autoSizeKey,
  readOnly,
  nodeReadOnly,
  choose,
  nodeDrag,
}: GraphNodeViewProps) {
  return (
    <div
      className={className}
      style={{
        left: box.x,
        top: box.y,
        width: box.width,
        height: box.height,
      }}
      data-node-id={n.id}
      data-auto-size-key={autoSizeKey}
    >
      <button
        className="ep-graph-node-select"
        aria-label={`Select node ${text}`}
        title={text}
        onClick={() => choose(n.id)}
        onPointerDown={(event) => nodeDrag.start(event, n)}
        onPointerMove={(event) => nodeDrag.move(event)}
        onPointerUp={(event) => nodeDrag.move(event, true)}
        onPointerCancel={() => nodeDrag.cancel()}
        onLostPointerCapture={() => nodeDrag.cancel()}
      >
        <span className="ep-graph-node-content">
          {text}
          <small>{typeLabel}</small>
          {overlayText && <span>{overlayText}</span>}
        </span>
      </button>
      {!readOnly && (
        <button
          className="ep-graph-drag"
          aria-label={`Move node ${text}`}
          disabled={readOnly || nodeReadOnly}
          onPointerDown={(event) => nodeDrag.start(event, n)}
          onPointerMove={(event) => nodeDrag.move(event)}
          onPointerUp={(event) => nodeDrag.move(event, true)}
          onPointerCancel={() => nodeDrag.cancel()}
          onLostPointerCapture={() => nodeDrag.cancel()}
        >
          ↔
        </button>
      )}
    </div>
  );
}

export interface GraphCanvasProps {
  canvasRef: RefObject<HTMLDivElement | null>;
  scene: GraphScene;
  zoom: number;
  pan: Position;
  marker: string;
  profile: GraphProfile;
  selected: string;
  node?: GraphNode;
  edge?: GraphEdge;
  neighbors: Set<string>;
  highlightAdjacent: boolean;
  readOnly: boolean;
  autoSize: boolean;
  overlay?: Record<string, string>;
  endpoint?: GraphEndpointGesture;
  choose: (id: string) => boolean;
  nodeDrag: NodeDragHandlers;
  endpointHandlers: EndpointHandlers;
}

function GraphEdges(props: GraphCanvasProps) {
  const { scene, profile, selected, node, highlightAdjacent, readOnly } = props;
  return (
    [...scene.visibleEdges]
      // Keep selected handles above other connections' hit strokes.
      .sort((a, b) => Number(a.id === selected) - Number(b.id === selected))
      .map((edge) => {
        const edgeType = profile.edges[edge.type];
        return (
          <GraphEdgeView
            key={edge.id}
            edge={edge}
            route={scene.routes.get(edge.id)!}
            placement={scene.edgeLabels.get(edge.id)!}
            text={edgeType?.ui?.label ?? edge.type}
            displayText={scene.edgeText(edge)}
            selected={selected === edge.id}
            dimmed={isGraphEdgeDimmed(edge, node, highlightAdjacent)}
            editable={!readOnly && !edgeType?.readOnly}
            marker={props.marker}
            label={scene.label}
            choose={props.choose}
            endpointHandlers={props.endpointHandlers}
            style={edgeType?.ui?.edgeStyle}
          />
        );
      })
  );
}

function GraphNodes(props: GraphCanvasProps) {
  const { scene, profile, overlay, readOnly } = props;
  return scene.visible.map((n) => (
    <GraphNodeView
      key={n.id}
      node={n}
      box={scene.boxes[n.id]}
      className={graphNodeClassName(n.id, props)}
      text={scene.label(n.id)}
      typeLabel={profile.nodes[n.type].ui?.label ?? n.type}
      overlayText={overlay?.[n.id]}
      autoSizeKey={props.autoSize ? scene.nodeSizeKey(n) : undefined}
      readOnly={readOnly}
      nodeReadOnly={!!profile.nodes[n.type].readOnly}
      choose={props.choose}
      nodeDrag={props.nodeDrag}
    />
  ));
}

export function GraphCanvas(props: GraphCanvasProps) {
  const { canvasRef, scene, zoom, pan, marker, endpoint } = props;
  const { worldWidth, worldHeight, routes, label } = scene;
  return (
    <div
      className="ep-graph-canvas"
      ref={canvasRef}
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
            <GraphEdges {...props} />
            {endpoint && routes.has(endpoint.id) && (
              <GraphEndpointPreview endpoint={endpoint} route={routes.get(endpoint.id)!} />
            )}
          </svg>
          <GraphNodes {...props} />
        </div>
      </div>
      {endpoint && (
        <p className="ep-graph-gesture-status" role="status">
          {endpoint.target && !endpoint.reason
            ? `${label(endpoint.target)}へ接続します`
            : (endpoint.reason ?? '接続先のノードへ端点を移動してください。')}
        </p>
      )}
      {!scene.visible.length && (
        <p className="ep-graph-empty">No visible nodes. Add a node or clear the view filter.</p>
      )}
    </div>
  );
}
