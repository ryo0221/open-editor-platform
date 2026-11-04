import { useEffect, useRef, useState } from 'react';
import { dragDistance, type GizmoAxis, type GizmoHandle } from './gizmo';

const names = ['X', 'Y', 'Z'] as const;
const colors = ['#d92d20', '#079455', '#1570ef'] as const;

/**
 * The move gizmo over the view (C3g): one arrow per cage axis from the selection's centre. A
 * drag along an arrow previews the move (`onDrag`) and makes it one edit on release
 * (`onDrop`); Escape or a cancelled pointer drops it (`onCancel`). A click on an arrow that does
 * not move the pointer is a click on the view (`onClick`): it selects what is under it. The arrows are drawn in
 * canvas pixels, so they follow the camera: `subscribe` says when the view was drawn again.
 */
export function MeshGizmo({
  handles,
  subscribe,
  disabled,
  onDrag,
  onDrop,
  onCancel,
  onClick,
}: {
  /** The handles where the view is now (read again after each drawn frame). */
  handles(): GizmoHandle[];
  subscribe(f: () => void): () => void;
  disabled: boolean;
  onDrag(axis: GizmoAxis, distance: number): void;
  onDrop(axis: GizmoAxis, distance: number): void;
  onCancel(): void;
  onClick(x: number, y: number, additive: boolean): void;
}) {
  const [, setTick] = useState(0);
  useEffect(() => subscribe(() => setTick((t) => t + 1)), [subscribe]);
  // The handle and pointer the drag started from: the axis keeps its on-screen scale then.
  const drag = useRef<{ handle: GizmoHandle; start: [number, number]; pointer: number }>(undefined);
  const [readout, setReadout] = useState<{ axis: GizmoAxis; distance: number; at: number[] }>();
  const svg = useRef<SVGSVGElement>(null);
  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = svg.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const cancel = () => {
    if (!drag.current) return;
    drag.current = undefined;
    setReadout(undefined);
    onCancel();
  };
  // Taken away mid-drag (edit mode left, the selection or the view gone): the preview goes too.
  const cancelled = useRef(onCancel);
  cancelled.current = onCancel;
  useEffect(
    () => () => {
      if (drag.current) cancelled.current();
    },
    [],
  );
  useEffect(() => {
    // Captured first, so Escape drops the drag and does not also close a panel.
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !drag.current) return;
      e.stopPropagation();
      cancel();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });
  const shown = handles();
  return (
    <svg ref={svg} className="character-gizmo" aria-label="Move gizmo">
      {shown.map((h) => {
        const active = drag.current?.handle.axis === h.axis;
        return (
          <g key={h.axis} className={active ? 'active' : undefined}>
            <line
              x1={h.from[0]}
              y1={h.from[1]}
              x2={h.to[0]}
              y2={h.to[1]}
              stroke={colors[h.axis]}
              strokeWidth={active ? 4 : 3}
            />
            <circle cx={h.to[0]} cy={h.to[1]} r={6} fill={colors[h.axis]} />
            {/* The wide, invisible line takes the pointer. */}
            <line
              role="button"
              aria-label={`Move along ${names[h.axis]}`}
              aria-disabled={disabled}
              data-axis={names[h.axis]}
              className="character-gizmo-hit"
              x1={h.from[0]}
              y1={h.from[1]}
              x2={h.to[0]}
              y2={h.to[1]}
              strokeWidth={16}
              onPointerDown={(e) => {
                if (disabled || e.button !== 0 || drag.current) return;
                e.preventDefault();
                e.stopPropagation();
                e.currentTarget.setPointerCapture(e.pointerId);
                drag.current = { handle: h, start: local(e), pointer: e.pointerId };
                setReadout({ axis: h.axis, distance: 0, at: local(e) });
                onDrag(h.axis, 0);
              }}
              onPointerMove={(e) => {
                const d = drag.current;
                if (!d || d.pointer !== e.pointerId) return;
                const at = local(e);
                const distance = dragDistance(d.handle, d.start, at);
                setReadout({ axis: d.handle.axis, distance, at });
                onDrag(d.handle.axis, distance);
              }}
              onPointerUp={(e) => {
                const d = drag.current;
                if (!d || d.pointer !== e.pointerId) return;
                drag.current = undefined;
                setReadout(undefined);
                const at = local(e);
                if (Math.hypot(at[0] - d.start[0], at[1] - d.start[1]) <= 4) {
                  onCancel();
                  onClick(at[0], at[1], e.shiftKey);
                  return;
                }
                onDrop(d.handle.axis, dragDistance(d.handle, d.start, at));
              }}
              onPointerCancel={cancel}
              onLostPointerCapture={() => drag.current && cancel()}
            />
          </g>
        );
      })}
      {readout && (
        <text
          className="character-gizmo-readout"
          data-testid="gizmo-readout"
          x={readout.at[0]! + 14}
          y={readout.at[1]! - 14}
        >
          {`${names[readout.axis]} ${readout.distance >= 0 ? '+' : ''}${readout.distance.toFixed(1)} mm`}
        </text>
      )}
    </svg>
  );
}
