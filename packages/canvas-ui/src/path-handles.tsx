import { useEffect, useRef, type KeyboardEvent } from 'react';
/** Domain-free world-space handle. Hit distances and radii are CSS pixels via zoom. */
export interface PathHandle {
  id: string;
  x: number;
  y: number;
  label: string;
  kind: 'anchor' | 'control';
}
export interface PathHandleLine {
  from: { x: number; y: number };
  to: { x: number; y: number };
}
export function hitPathHandle(
  points: readonly PathHandle[],
  screen: { x: number; y: number },
  toScreen: (point: PathHandle) => { x: number; y: number },
  tolerance = 8,
): PathHandle | undefined {
  let best: PathHandle | undefined,
    distance = tolerance;
  for (const point of points) {
    const p = toScreen(point),
      d = Math.hypot(screen.x - p.x, screen.y - p.y);
    if (d <= distance) {
      best = point;
      distance = d;
    }
  }
  return best;
}
export interface PathHandlesProps {
  points: readonly PathHandle[];
  lines?: readonly PathHandleLine[];
  zoom: number;
  selected?: string;
  disabled?: boolean;
  /** Changing the domain revision cancels an in-flight gesture. */
  revision: unknown;
  select(id: string): void | boolean;
  begin(id: string): void | boolean;
  preview(id: string, point: { x: number; y: number }): void;
  commit(id: string, point: { x: number; y: number }): void;
  cancel(): void;
  keyDown?(event: KeyboardEvent<SVGGElement>): void;
}
/** Independent public subpath: React only; no CanvasStage, text engine or domain/controller. */
export function PathHandles(props: PathHandlesProps) {
  const latest = useRef(props);
  latest.current = props;
  const drag = useRef<
    | {
        id: string;
        pointerId: number;
        target: SVGCircleElement;
        origin: { x: number; y: number };
        start: { x: number; y: number };
        revision: unknown;
      }
    | undefined
  >(undefined);
  const cancel = () => {
    const current = drag.current;
    if (!current) return;
    drag.current = undefined;
    if (current.target.hasPointerCapture(current.pointerId))
      current.target.releasePointerCapture(current.pointerId);
    latest.current.cancel();
  };
  useEffect(() => {
    if (drag.current && (props.disabled || drag.current.revision !== props.revision)) cancel();
  }, [props.disabled, props.revision]);
  useEffect(
    () => () => {
      if (drag.current) {
        drag.current = undefined;
        latest.current.cancel();
      }
    },
    [],
  );
  function point(e: { clientX: number; clientY: number }, target: SVGCircleElement) {
    const matrix =
      target.parentElement instanceof SVGGraphicsElement
        ? target.parentElement.getScreenCTM()
        : null;
    if (!matrix || matrix.a * matrix.d - matrix.b * matrix.c === 0) return undefined;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return undefined;
    return { x: p.x, y: p.y };
  }
  const zoom = props.zoom;
  if (!(zoom > 0) || !Number.isFinite(zoom) || !Number.isFinite(5 / zoom)) return null;
  return (
    <g
      data-path-handles="true"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.nativeEvent.isComposing) cancel();
        props.keyDown?.(e);
      }}
    >
      {props.lines?.map((line, i) => (
        <path
          key={i}
          d={`M${line.from.x} ${line.from.y} L${line.to.x} ${line.to.y}`}
          fill="none"
          stroke="#537caf"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
        />
      ))}
      {props.points.map((p) => (
        <circle
          key={p.id}
          data-path-point={p.id}
          aria-label={p.label}
          role="button"
          tabIndex={props.disabled ? -1 : 0}
          aria-disabled={props.disabled}
          aria-pressed={props.selected === p.id}
          // Keep SVG length attributes small even for huge world coordinates;
          // browser length clamping must not shrink the screen-space hit target.
          transform={`matrix(${1 / zoom} 0 0 ${1 / zoom} ${p.x} ${p.y})`}
          cx={0}
          cy={0}
          r={p.kind === 'anchor' ? 5 : 4}
          fill={props.selected === p.id ? '#3267c8' : 'white'}
          stroke="#3267c8"
          strokeWidth={1.5}
          onFocus={() => {
            if (latest.current.selected !== p.id) latest.current.select(p.id);
          }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            if (props.disabled) return;
            e.preventDefault();
            cancel();
            const start = point(e, e.currentTarget);
            if (!start) return;
            if (props.select(p.id) === false) return;
            // Selection may synchronously settle a domain input and replace
            // coordinates/revision. Begin against that updated snapshot.
            const current = latest.current,
              origin = current.points.find((point) => point.id === p.id);
            if (!origin || current.disabled || current.begin(p.id) === false) return;
            e.currentTarget.focus({ preventScroll: true });
            drag.current = {
              id: p.id,
              pointerId: e.pointerId,
              target: e.currentTarget,
              origin: { x: origin.x, y: origin.y },
              start,
              revision: current.revision,
            };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d || d.pointerId !== e.pointerId) return;
            e.stopPropagation();
            if (latest.current.disabled || latest.current.revision !== d.revision) {
              cancel();
              return;
            }
            const next = point(e, d.target);
            if (!next) {
              cancel();
              return;
            }
            props.preview(d.id, {
              x: d.origin.x + (next.x - d.start.x),
              y: d.origin.y + (next.y - d.start.y),
            });
          }}
          onPointerUp={(e) => {
            const d = drag.current;
            if (!d || d.pointerId !== e.pointerId) return;
            e.stopPropagation();
            if (latest.current.disabled || latest.current.revision !== d.revision) {
              cancel();
              return;
            }
            const next = point(e, d.target);
            if (!next) {
              cancel();
              return;
            }
            if (next.x === d.start.x && next.y === d.start.y) {
              cancel();
              return;
            }
            drag.current = undefined;
            if (d.target.hasPointerCapture(e.pointerId))
              d.target.releasePointerCapture(e.pointerId);
            props.commit(d.id, {
              x: d.origin.x + (next.x - d.start.x),
              y: d.origin.y + (next.y - d.start.y),
            });
          }}
          onPointerCancel={(e) => {
            e.stopPropagation();
            cancel();
          }}
          onLostPointerCapture={cancel}
        />
      ))}
    </g>
  );
}
