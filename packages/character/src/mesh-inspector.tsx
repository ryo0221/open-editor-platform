import { useState } from 'react';
import { Section } from '@editor-platform/editor-ui';
import type { CharacterSubdivision } from '@editor-platform/character-core';
import {
  operationReason,
  type uvLayout,
  type MeshOperation,
  type MeshSelectMode,
  type MeshSelection,
} from './mesh-edit';

const modes: [MeshSelectMode, string][] = [
  ['vertex', 'Vertex'],
  ['edge', 'Edge'],
  ['face', 'Face'],
];

/** A number typed for an operation (not a document value: it is used when the button runs). */
function useNumber(initial: number) {
  const [text, setText] = useState(String(initial));
  const n = Number(text);
  return { text, setText, value: text.trim() !== '' && Number.isFinite(n) ? n : undefined };
}
function NumberField({
  label,
  field,
  step,
}: {
  label: string;
  field: ReturnType<typeof useNumber>;
  step?: number;
}) {
  return (
    <label className="character-field">
      <span>{label}</span>
      <input
        type="number"
        inputMode="decimal"
        aria-label={label}
        step={step ?? 'any'}
        value={field.text}
        aria-invalid={field.value === undefined}
        onChange={(e) => field.setText(e.target.value)}
      />
    </label>
  );
}

/**
 * Mesh edit mode (C3e): how clicks select, what is selected, and the operations that make a new
 * mesh of the part (each one undoable edit). Subdivision levels are part settings.
 */
export function MeshInspector({
  partName,
  selection,
  vertexCount,
  faceCount,
  problem,
  busy,
  symmetry,
  subdivision,
  onMode,
  onSelectAll,
  onSelectNone,
  onSelectLoop,
  onSymmetry,
  knife,
  onKnife,
  uv,
  onRun,
  onSubdivision,
  onDone,
  shape,
}: {
  partName: string;
  /**
   * C6b: the name of the morph whose shape is edited. Only moving vertices changes a shape (the
   * cage's topology, UVs and subdivision stay), so the other tools are not offered.
   */
  shape?: string;
  selection: MeshSelection;
  vertexCount: number;
  faceCount: number;
  /** Why the cage cannot be edited, when it cannot. */
  problem?: string;
  busy: boolean;
  symmetry: boolean;
  subdivision: CharacterSubdivision | undefined;
  onMode(mode: MeshSelectMode): void;
  onSelectAll(): void;
  onSelectNone(): void;
  onSelectLoop(): void;
  onSymmetry(on: boolean): void;
  /** C4: the cage's UV layout, when it has UVs. */
  uv: ReturnType<typeof uvLayout>;
  /** The knife (C3h): off, or which of its two points the next click picks. */
  knife: 'first' | 'second' | undefined;
  onKnife(on: boolean): void;
  onRun(op: MeshOperation): void;
  onSubdivision(s: CharacterSubdivision | null): void;
  onDone(): void;
}) {
  const dx = useNumber(0),
    dy = useNumber(0),
    dz = useNumber(0);
  const distance = useNumber(100);
  const inset = useNumber(0.3);
  const cuts = useNumber(1);
  const width = useNumber(10);
  const crease = useNumber(1);
  const disabled = !!problem || busy;
  const button = (
    label: string,
    kind: MeshOperation['kind'],
    make: () => MeshOperation | undefined,
  ) => {
    const why = operationReason(selection, kind);
    const op = make();
    const reason = problem ?? why ?? (op ? undefined : 'Enter a number.');
    return (
      <button
        type="button"
        disabled={disabled || !!reason}
        title={reason}
        onClick={() => op && onRun(op)}
      >
        {label}
      </button>
    );
  };
  const levels = subdivision?.levels ?? 0;
  const renderLevels = subdivision?.renderLevels ?? 0;
  const setLevels = (l: number, r: number) =>
    onSubdivision(l === 0 && r === 0 ? null : { levels: l, renderLevels: r });
  return (
    <Section title={shape ? `Edit shape · ${shape} · ${partName}` : `Edit mesh · ${partName}`}>
      <div className="character-mesh" aria-label="Mesh editing">
        {problem && (
          <p role="alert" className="character-error">
            {problem}
          </p>
        )}
        <div className="character-mesh-modes" role="group" aria-label="Select">
          {modes.map(([m, label]) => (
            <button
              key={m}
              type="button"
              aria-pressed={selection.mode === m}
              onClick={() => onMode(m)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="character-mesh-count" data-testid="mesh-selection">
          {selection.items.length}{' '}
          {selection.mode === 'vertex' ? 'vertices' : selection.mode === 'edge' ? 'edges' : 'faces'}{' '}
          selected · {vertexCount} vertices · {faceCount} faces
        </p>
        <p className="character-hint">
          {knife
            ? 'Knife: click two points on the outline of one face to cut it. Esc drops the first point.'
            : 'Click to select, Shift-click to add. Drag an arrow to move, elsewhere to orbit.'}
        </p>
        {shape && (
          <p className="character-hint">
            Moving vertices changes this morph&apos;s shape; the mesh itself stays as it is.
          </p>
        )}
        {!shape && (
          <div className="character-mesh-row">
            <button
              type="button"
              aria-pressed={!!knife}
              disabled={disabled}
              onClick={() => onKnife(!knife)}
            >
              Knife
            </button>
            {knife && (
              <span role="status" data-testid="knife-state">
                {knife === 'first' ? 'Pick the first point' : 'Pick the second point'}
              </span>
            )}
          </div>
        )}
        <div className="character-mesh-row">
          <button type="button" disabled={disabled} onClick={onSelectAll}>
            Select all
          </button>
          <button type="button" disabled={disabled} onClick={onSelectNone}>
            Select none
          </button>
          <button
            type="button"
            disabled={disabled || selection.mode !== 'edge' || !selection.items.length}
            title={selection.mode !== 'edge' ? 'Select an edge.' : undefined}
            onClick={onSelectLoop}
          >
            Select loop
          </button>
        </div>
        <label className="character-pick">
          <input
            type="checkbox"
            checked={symmetry}
            onChange={(e) => onSymmetry(e.target.checked)}
          />
          Mirror across X
        </label>
        <fieldset className="character-mesh-op">
          <legend>Move (mm)</legend>
          <NumberField label="Move X" field={dx} />
          <NumberField label="Move Y" field={dy} />
          <NumberField label="Move Z" field={dz} />
          {button('Move', 'move', () =>
            dx.value !== undefined && dy.value !== undefined && dz.value !== undefined
              ? { kind: 'move', delta: [dx.value, dy.value, dz.value] }
              : undefined,
          )}
        </fieldset>
        {!shape && (
          <>
            <fieldset className="character-mesh-op">
              <legend>Faces</legend>
              <NumberField label="Extrude distance" field={distance} />
              {button('Extrude', 'extrude', () =>
                distance.value !== undefined
                  ? { kind: 'extrude', distance: distance.value }
                  : undefined,
              )}
              <NumberField label="Inset amount" field={inset} step={0.05} />
              {button('Inset', 'inset', () =>
                inset.value !== undefined ? { kind: 'inset', amount: inset.value } : undefined,
              )}
              {button('Delete faces', 'delete', () => ({ kind: 'delete' }))}
            </fieldset>
            <fieldset className="character-mesh-op">
              <legend>Edges</legend>
              <NumberField label="Loop cuts" field={cuts} step={1} />
              {button('Loop cut', 'loopCut', () =>
                cuts.value !== undefined ? { kind: 'loopCut', cuts: cuts.value } : undefined,
              )}
              <NumberField label="Bevel width" field={width} />
              {button('Bevel', 'bevel', () =>
                width.value !== undefined ? { kind: 'bevel', width: width.value } : undefined,
              )}
              <NumberField label="Crease" field={crease} step={0.1} />
              {button('Set crease', 'crease', () =>
                crease.value !== undefined ? { kind: 'crease', value: crease.value } : undefined,
              )}
            </fieldset>
            <fieldset className="character-mesh-op">
              <legend>Vertices</legend>
              {button('Merge', 'merge', () => ({ kind: 'merge' }))}
            </fieldset>
            <fieldset className="character-mesh-op">
              <legend>UV</legend>
              {button('Mark seam', 'markSeam', () => ({ kind: 'markSeam' }))}
              {button('Clear seam', 'clearSeam', () => ({ kind: 'clearSeam' }))}
              {button('Unwrap', 'unwrap', () => ({ kind: 'unwrap' }))}
              <UvView layout={uv} />
            </fieldset>
            <fieldset className="character-mesh-op">
              <legend>Subdivision</legend>
              <label className="character-field">
                <span>Levels</span>
                <select
                  aria-label="Subdivision levels"
                  value={levels}
                  disabled={busy}
                  onChange={(e) =>
                    setLevels(
                      Number(e.target.value),
                      Math.max(renderLevels, Number(e.target.value)),
                    )
                  }
                >
                  {[0, 1, 2, 3, 4].map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label className="character-field">
                <span>Render</span>
                <select
                  aria-label="Render levels"
                  value={renderLevels}
                  disabled={busy}
                  onChange={(e) => setLevels(levels, Number(e.target.value))}
                >
                  {[0, 1, 2, 3, 4].map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
            </fieldset>
          </>
        )}
        <button type="button" onClick={onDone}>
          Done
        </button>
      </div>
    </Section>
  );
}

/** Faces drawn in the UV view at most; past it only the summary is shown. */
const uvViewFaces = 20_000;
/** The UV layout (C4): every face's outline in the unit square, v up. */
function UvView({ layout }: { layout: ReturnType<typeof uvLayout> }) {
  if (!layout)
    return (
      <p className="character-hint" data-testid="uv-summary">
        No UVs yet: mark seams, then unwrap.
      </p>
    );
  const size = 200;
  const d =
    layout.outlines.length > uvViewFaces
      ? ''
      : layout.outlines
          .map((o) => {
            let path = '';
            for (let i = 0; i < o.length; i += 2)
              path += `${i ? 'L' : 'M'}${(o[i]! * size).toFixed(1)} ${((1 - o[i + 1]!) * size).toFixed(1)}`;
            return path + 'Z';
          })
          .join('');
  return (
    <>
      <svg
        className="character-uv-view"
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label="UV layout"
      >
        <rect x={0} y={0} width={size} height={size} />
        {d && <path d={d} />}
      </svg>
      <p className="character-hint" data-testid="uv-summary">
        {layout.islands} {layout.islands === 1 ? 'island' : 'islands'} · angle distortion{' '}
        {Number.isFinite(layout.conformal) ? layout.conformal.toFixed(2) : '—'}
        {layout.outlines.length > uvViewFaces ? ' · too many faces to draw' : ''}
      </p>
    </>
  );
}
