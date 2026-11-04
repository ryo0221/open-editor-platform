import { useEffect, useState } from 'react';

/** A bone where the view shows it: its head in canvas pixels and its parent's head, if any. */
export interface ShownBone {
  id: string;
  name: string;
  head: [number, number];
  parent?: [number, number];
}

/**
 * The bones over the view (C5a): a line from each bone's parent to its head and a dot at the
 * head. A click on a dot chooses that bone. Drawn in canvas pixels, so it follows the camera:
 * `subscribe` says when the view was drawn again.
 */
export function BoneOverlay({
  bones,
  selected,
  subscribe,
  onPick,
}: {
  /** The bones where the view is now (read again after each drawn frame). */
  bones(): ShownBone[];
  selected: string | undefined;
  subscribe(f: () => void): () => void;
  onPick(id: string): void;
}) {
  const [, setTick] = useState(0);
  useEffect(() => subscribe(() => setTick((t) => t + 1)), [subscribe]);
  const shown = bones().filter((b) => b.head.every(Number.isFinite));
  return (
    <svg className="character-gizmo character-bone-overlay" aria-label="Bones in the view">
      {shown.map(
        (b) =>
          b.parent?.every(Number.isFinite) && (
            <line
              key={`${b.id}-line`}
              x1={b.parent[0]}
              y1={b.parent[1]}
              x2={b.head[0]}
              y2={b.head[1]}
              className={b.id === selected ? 'selected' : undefined}
            />
          ),
      )}
      {shown.map((b) => (
        <circle
          key={b.id}
          role="button"
          aria-label={`Bone ${b.name}`}
          aria-pressed={b.id === selected}
          data-testid={`bone-joint-${b.id}`}
          className={b.id === selected ? 'selected' : undefined}
          cx={b.head[0]}
          cy={b.head[1]}
          r={6}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            onPick(b.id);
          }}
        />
      ))}
    </svg>
  );
}
