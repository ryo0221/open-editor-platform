import {
  characterMultiresDisplacements,
  type CharacterMultires,
} from '@editor-platform/character-core';
import { Section } from '@editor-platform/editor-ui';
import {
  multiresBase,
  multiresFrames,
  multiresLimits,
  multiresPositions,
  sculptTriangles,
  SculptSurface,
  type EpmMesh,
  type MultiresBase,
  type MultiresChunk,
  type MultiresFrames,
  type SculptBrushKind,
} from '@editor-platform/geometry-mesh';
import { useState } from 'react';

/** A brush, or C7c's Grab and Mask (Mask paints the mask; it is not an edit). */
export type SculptToolKind = SculptBrushKind | 'grab' | 'mask';

/**
 * The sculpt brush (view state, never an edit): radius in canvas pixels, strength 0–1, and how
 * the surface is shown (C7c: matcap or the lit material).
 */
export interface SculptTool {
  kind: SculptToolKind;
  radius: number;
  strength: number;
  symmetry: boolean;
  matcap: boolean;
}
export const defaultSculptTool: SculptTool = {
  kind: 'draw',
  radius: 40,
  strength: 0.5,
  symmetry: true,
  matcap: true,
};

/** A part's multires, ready to sculpt: its base surface, frames, displacements and vertices. */
export interface SculptSession {
  partId: string;
  /** What it was built from: the cage's SHA-256 and the multires' chunk IDs. */
  key: string;
  base: MultiresBase;
  frames: MultiresFrames;
  displacements: Float32Array;
  surface: SculptSurface;
  triangles: Uint32Array;
  /** C7c: 0–1 per vertex, 1 holds a vertex still. A view state: never saved, not an edit. */
  mask: Float32Array;
}
export const sculptKey = (cageSha: string, multires: CharacterMultires) =>
  `${cageSha} ${multires.level} ${multires.chunks.join(',')}`;

/** Builds the sculpt session of a part's multires (the cage in the space it is drawn in). */
export function buildSculpt(
  partId: string,
  key: string,
  cage: EpmMesh,
  multires: CharacterMultires,
  chunks: ReadonlyMap<string, MultiresChunk>,
): SculptSession {
  const displacements = characterMultiresDisplacements(multires, cage, chunks);
  const base = multiresBase(cage, multires.level);
  const frames = multiresFrames(base);
  const surface = new SculptSurface(multiresPositions(base, frames, displacements), base.quads);
  return {
    partId,
    key,
    base,
    frames,
    displacements,
    surface,
    triangles: sculptTriangles(base.quads),
    mask: new Float32Array(surface.vertexCount),
  };
}

const kinds: { kind: SculptToolKind; label: string }[] = [
  { kind: 'draw', label: 'Draw' },
  { kind: 'inflate', label: 'Inflate' },
  { kind: 'smooth', label: 'Smooth' },
  { kind: 'pinch', label: 'Pinch' },
  { kind: 'flatten', label: 'Flatten' },
  { kind: 'grab', label: 'Grab' },
  { kind: 'mask', label: 'Mask' },
];

/** The Inspector while sculpting (C7b): brush, radius, strength, mirror, done. */
export function SculptInspector({
  partName,
  level,
  vertices,
  display,
  tool,
  busy,
  onTool,
  onDisplay,
  onMask,
  onDone,
}: {
  partName: string;
  level: number;
  vertices: number;
  /** The level shown (C7c); below `level` the surface is a view and brushes are off. */
  display: number;
  tool: SculptTool;
  busy: boolean;
  onTool(tool: SculptTool): void;
  onDisplay(level: number): void;
  onMask(action: 'invert' | 'clear'): void;
  onDone(): void;
}) {
  const viewOnly = display < level;
  return (
    <Section title={`Sculpt · ${partName}`}>
      <p className="character-hint">
        Level {level} · {vertices.toLocaleString('en')} vertices. Drag on the part to sculpt; Shift
        reverses Draw, Inflate and Pinch and erases with Mask. Each stroke is one edit; the mask is
        not saved. Right-drag turns the view.
      </p>
      <label className="character-field character-name-field">
        <span>Display level</span>
        <select
          aria-label="Display level"
          value={display}
          onChange={(e) => onDisplay(Number(e.target.value))}
        >
          {Array.from({ length: level }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n === level ? `${n} (sculpt)` : n}
            </option>
          ))}
        </select>
      </label>
      {viewOnly && (
        <p className="character-hint" role="status">
          Showing level {display}. Sculpting works on level {level}: choose it to sculpt.
        </p>
      )}
      <div className="character-mesh-row" role="group" aria-label="Sculpt brush">
        {kinds.map((k) => (
          <button
            key={k.kind}
            type="button"
            aria-pressed={tool.kind === k.kind}
            disabled={viewOnly}
            onClick={() => onTool({ ...tool, kind: k.kind })}
          >
            {k.label}
          </button>
        ))}
      </div>
      <label className="character-field character-name-field">
        <span>Radius {tool.radius} px</span>
        <input
          type="range"
          aria-label="Sculpt radius"
          min={5}
          max={200}
          value={tool.radius}
          onChange={(e) => onTool({ ...tool, radius: Number(e.target.value) })}
        />
      </label>
      <label className="character-field character-name-field">
        <span>Strength {Math.round(tool.strength * 100)}%</span>
        <input
          type="range"
          aria-label="Sculpt strength"
          min={1}
          max={100}
          value={Math.round(tool.strength * 100)}
          onChange={(e) => onTool({ ...tool, strength: Number(e.target.value) / 100 })}
        />
      </label>
      <label className="character-check">
        <input
          type="checkbox"
          checked={tool.symmetry}
          onChange={(e) => onTool({ ...tool, symmetry: e.target.checked })}
        />
        Mirror across X
      </label>
      <label className="character-check">
        <input
          type="checkbox"
          checked={tool.matcap}
          onChange={(e) => onTool({ ...tool, matcap: e.target.checked })}
        />
        Matcap shading
      </label>
      <div className="character-mesh-row" role="group" aria-label="Sculpt mask">
        <button type="button" disabled={viewOnly} onClick={() => onMask('invert')}>
          Invert mask
        </button>
        <button type="button" disabled={viewOnly} onClick={() => onMask('clear')}>
          Clear mask
        </button>
      </div>
      <div className="character-mesh-row">
        <button type="button" disabled={busy} onClick={onDone}>
          Done sculpting
        </button>
      </div>
    </Section>
  );
}

/** The part's multires controls (C7b): add with a level, or sculpt, raise and remove. */
export function MultiresControls({
  multires,
  busy,
  disabled,
  onAdd,
  onSculpt,
  onRaise,
  onRemove,
}: {
  multires: CharacterMultires | undefined;
  busy: boolean;
  disabled: boolean;
  onAdd(level: number): void;
  onSculpt(): void;
  onRaise(): void;
  onRemove(): void;
}) {
  const [level, setLevel] = useState(4);
  if (!multires)
    return (
      <div className="character-mesh-row" role="group" aria-label="Multires">
        <select
          aria-label="Multires levels"
          value={level}
          disabled={busy || disabled}
          onChange={(e) => setLevel(Number(e.target.value))}
        >
          {Array.from({ length: multiresLimits.levels }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n} {n === 1 ? 'level' : 'levels'}
            </option>
          ))}
        </select>
        <button type="button" disabled={busy || disabled} onClick={() => onAdd(level)}>
          Add multires
        </button>
      </div>
    );
  return (
    <div className="character-mesh-row" role="group" aria-label="Multires">
      <span className="character-hint">Multires level {multires.level}</span>
      <button type="button" disabled={busy || disabled} onClick={onSculpt}>
        Sculpt
      </button>
      <button
        type="button"
        disabled={busy || disabled || multires.level >= multiresLimits.levels}
        onClick={onRaise}
      >
        Raise level
      </button>
      <button type="button" disabled={busy || disabled} onClick={onRemove}>
        Remove multires
      </button>
    </div>
  );
}
