import { useEffect, useState } from 'react';

/**
 * The knife's first point and the cut it would make to the pointer (C3h), over the view. The
 * point is projected again after each drawn frame (`subscribe`), so it stays on the cage while
 * the camera moves.
 */
export function KnifeLine({
  start,
  pointer,
  subscribe,
}: {
  /** The first point where the view is now, in canvas pixels; undefined when off screen. */
  start(): [number, number] | undefined;
  pointer: [number, number] | undefined;
  subscribe(f: () => void): () => void;
}) {
  const [, setTick] = useState(0);
  useEffect(() => subscribe(() => setTick((t) => t + 1)), [subscribe]);
  const at = start();
  if (!at) return null;
  return (
    <svg className="character-gizmo" aria-hidden="true">
      {pointer && (
        <line
          x1={at[0]}
          y1={at[1]}
          x2={pointer[0]}
          y2={pointer[1]}
          stroke="#f97316"
          strokeWidth={2}
          strokeDasharray="6 4"
        />
      )}
      <circle
        data-testid="knife-start"
        cx={at[0]}
        cy={at[1]}
        r={5}
        fill="#f97316"
        stroke="#ffffff"
        strokeWidth={2}
      />
    </svg>
  );
}
