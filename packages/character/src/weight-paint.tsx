import type { CharacterBone } from '@editor-platform/character-core';
import { Section } from '@editor-platform/editor-ui';
import type { EpmMesh, WeightBrushMode } from '@editor-platform/geometry-mesh';
import { useEffect, useState } from 'react';

/** The brush (view state, never an edit): its mode, radius in canvas pixels and strength 0–1. */
export interface WeightBrush {
  mode: WeightBrushMode;
  radius: number;
  strength: number;
}
export const defaultBrush: WeightBrush = { mode: 'add', radius: 40, strength: 0.5 };

/** 1 for each vertex a face facing `eye` uses (the vertices the brush may reach). */
export function facingVertices(mesh: EpmMesh, eye: readonly number[]): Uint8Array {
  const p = mesh.positions;
  const out = new Uint8Array(p.length / 3);
  let at = 0;
  for (const n of mesh.faceSizes) {
    // Newell's normal and the face's middle.
    let nx = 0,
      ny = 0,
      nz = 0,
      cx = 0,
      cy = 0,
      cz = 0;
    for (let k = 0; k < n; k++) {
      const a = mesh.faceIndices[at + k]! * 3,
        b = mesh.faceIndices[at + ((k + 1) % n)]! * 3;
      nx += (p[a + 1]! - p[b + 1]!) * (p[a + 2]! + p[b + 2]!);
      ny += (p[a + 2]! - p[b + 2]!) * (p[a]! + p[b]!);
      nz += (p[a]! - p[b]!) * (p[a + 1]! + p[b + 1]!);
      cx += p[a]!;
      cy += p[a + 1]!;
      cz += p[a + 2]!;
    }
    const toEye = nx * (eye[0]! - cx / n) + ny * (eye[1]! - cy / n) + nz * (eye[2]! - cz / n);
    if (toEye > 0) for (let k = 0; k < n; k++) out[mesh.faceIndices[at + k]!] = 1;
    at += n;
  }
  return out;
}

/**
 * Adds one brush dab at `x, y` (canvas pixels) to a stroke: each facing vertex within the radius
 * is reached by strength × (1 − (d / r)²)², and a stroke keeps the most each vertex was reached.
 */
export function brushDab(
  screen: readonly (readonly number[])[],
  facing: Uint8Array,
  x: number,
  y: number,
  brush: WeightBrush,
  touched: Map<number, number>,
) {
  const r2 = brush.radius * brush.radius;
  for (let v = 0; v < screen.length; v++) {
    const q = screen[v]!;
    if (!facing[v] || !(Math.abs(q[2]!) <= 1)) continue;
    const d2 = (q[0]! - x) ** 2 + (q[1]! - y) ** 2;
    if (d2 > r2) continue;
    const t = 1 - d2 / r2;
    const amount = brush.strength * t * t;
    if (amount > (touched.get(v) ?? 0)) touched.set(v, amount);
  }
}

/**
 * Dabs along a pointer move from `from` to `to`, at most half a radius apart, so a fast drag
 * paints the whole way and not only where the pointer was sampled.
 */
export function brushSegment(
  screen: readonly (readonly number[])[],
  facing: Uint8Array,
  from: readonly [number, number],
  to: readonly [number, number],
  brush: WeightBrush,
  touched: Map<number, number>,
) {
  const steps = Math.max(
    1,
    Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / Math.max(brush.radius / 2, 1)),
  );
  for (let k = 1; k <= steps; k++)
    brushDab(
      screen,
      facing,
      from[0] + ((to[0] - from[0]) * k) / steps,
      from[1] + ((to[1] - from[1]) * k) / steps,
      brush,
      touched,
    );
}

/** What a stroke picks with: the vertices on screen, those facing the camera, the last sample. */
export interface StrokeView {
  screen: [number, number, number][];
  facing: Uint8Array;
  last?: [number, number];
}

/**
 * Keeps a stroke picking where the vertices are now: when the view moved (a zoom, a resize)
 * since its last dab, it takes the new projection and facing, and the next dab starts afresh
 * instead of filling the way from a point of the old view. True when the view had moved.
 */
export function followView(
  stroke: StrokeView,
  screen: [number, number, number][],
  facing: () => Uint8Array,
): boolean {
  const same =
    screen.length === stroke.screen.length &&
    screen.every((q, i) => {
      const was = stroke.screen[i]!;
      return Math.abs(q[0] - was[0]) < 1e-6 && Math.abs(q[1] - was[1]) < 1e-6 && q[2] === was[2];
    });
  if (same) return false;
  stroke.screen = screen;
  stroke.facing = facing();
  stroke.last = undefined;
  return true;
}

export interface ShownWeight {
  vertex: number;
  x: number;
  y: number;
  weight: number;
}

/** Weight 0 (blue) through 0.5 (green) to 1 (red). */
const weightColor = (w: number) =>
  `hsl(${Math.round(240 * (1 - Math.min(Math.max(w, 0), 1)))} 85% 50%)`;

/**
 * The painted bone's weight on each facing vertex, as dots over the view (C5c), and the brush
 * circle where the pointer is. Drawn in canvas pixels; `subscribe` says when the view moved.
 */
export function WeightOverlay({
  points,
  brush,
  pointer,
  subscribe,
}: {
  points(): ShownWeight[];
  brush: WeightBrush;
  pointer: [number, number] | undefined;
  subscribe(f: () => void): () => void;
}) {
  const [, setTick] = useState(0);
  useEffect(() => subscribe(() => setTick((t) => t + 1)), [subscribe]);
  return (
    <svg className="character-gizmo character-weight-overlay" aria-label="Weights in the view">
      {points().map((p) => (
        <circle
          key={p.vertex}
          data-testid={`weight-dot-${p.vertex}`}
          data-weight={p.weight.toFixed(3)}
          cx={p.x}
          cy={p.y}
          r={4}
          fill={weightColor(p.weight)}
        />
      ))}
      {pointer && (
        <circle
          className="character-brush"
          cx={pointer[0]}
          cy={pointer[1]}
          r={brush.radius}
          fill="none"
        />
      )}
    </svg>
  );
}

const modes: { mode: WeightBrushMode; label: string }[] = [
  { mode: 'add', label: 'Add' },
  { mode: 'subtract', label: 'Subtract' },
  { mode: 'smooth', label: 'Smooth' },
];

/** The weight paint panel (C5c): the bone painted, the brush, and leaving paint mode. */
export function WeightPaintInspector({
  partName,
  bones,
  bone,
  brush,
  busy,
  onBone,
  onBrush,
  onDone,
}: {
  partName: string;
  bones: CharacterBone[];
  bone: string;
  brush: WeightBrush;
  busy: boolean;
  onBone(id: string): void;
  onBrush(brush: WeightBrush): void;
  onDone(): void;
}) {
  return (
    <Section title={`Weight paint · ${partName}`}>
      <p className="character-hint">
        Drag on the part to paint; each stroke is one edit. Right-drag turns the view.
      </p>
      <label className="character-field character-name-field">
        <span>Bone</span>
        <select aria-label="Paint bone" value={bone} onChange={(e) => onBone(e.target.value)}>
          {bones.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </label>
      <div className="character-mesh-row" role="group" aria-label="Brush mode">
        {modes.map((m) => (
          <button
            key={m.mode}
            type="button"
            aria-pressed={brush.mode === m.mode}
            onClick={() => onBrush({ ...brush, mode: m.mode })}
          >
            {m.label}
          </button>
        ))}
      </div>
      <label className="character-field character-name-field">
        <span>Radius {brush.radius} px</span>
        <input
          type="range"
          aria-label="Brush radius"
          min={5}
          max={200}
          value={brush.radius}
          onChange={(e) => onBrush({ ...brush, radius: Number(e.target.value) })}
        />
      </label>
      <label className="character-field character-name-field">
        <span>Strength {Math.round(brush.strength * 100)}%</span>
        <input
          type="range"
          aria-label="Brush strength"
          min={1}
          max={100}
          value={Math.round(brush.strength * 100)}
          onChange={(e) => onBrush({ ...brush, strength: Number(e.target.value) / 100 })}
        />
      </label>
      <div className="character-mesh-row">
        <button type="button" disabled={busy} onClick={onDone}>
          Done painting
        </button>
      </div>
    </Section>
  );
}
