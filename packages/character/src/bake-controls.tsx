import { bakeSizes } from '@editor-platform/geometry-mesh';
import { useState } from 'react';

/** What a finished bake reports (C7d). */
export interface BakeReport {
  size: number;
  covered: number;
  missed: number;
  /** The part is shown subdivided while the GLB carries the cage. */
  subdivided: boolean;
}

/**
 * C7d: bakes the part's multires into a normal map on its materials, from the cage. Asks first
 * when a material is shared with other parts (copy it for this part, or stop).
 */
export function NormalBakeControls({
  shared,
  busy,
  disabled,
  running,
  report,
  onBake,
  onCancel,
}: {
  /** Names of the part's materials that other parts use too. */
  shared: string[];
  busy: boolean;
  disabled: boolean;
  /** Rows done of the bake running now. */
  running: { rows: number; size: number } | undefined;
  report: BakeReport | undefined;
  onBake(size: number, copyShared: boolean): void;
  onCancel(): void;
}) {
  const [size, setSize] = useState(1024);
  const [asking, setAsking] = useState(false);
  if (running)
    return (
      <div className="character-mesh-row" role="group" aria-label="Normal map bake">
        <span className="character-hint" role="status">
          Baking normal map… {Math.floor((100 * running.rows) / running.size)}%
        </span>
        <button type="button" onClick={onCancel}>
          Cancel bake
        </button>
      </div>
    );
  return (
    <>
      <div className="character-mesh-row" role="group" aria-label="Normal map bake">
        <select
          aria-label="Bake size"
          value={size}
          disabled={busy || disabled}
          onChange={(e) => setSize(Number(e.target.value))}
        >
          {bakeSizes.map((n) => (
            <option key={n} value={n}>
              {n} × {n}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={busy || disabled}
          onClick={() => {
            if (shared.length) setAsking(true);
            else onBake(size, false);
          }}
        >
          Bake normal map
        </button>
      </div>
      {asking && (
        <div className="character-mesh-row" role="group" aria-label="Shared materials">
          <p className="character-hint">
            {shared.join(', ')} {shared.length === 1 ? 'is' : 'are'} used by other parts too. The
            map goes on a copy made for this part.
          </p>
          <button
            type="button"
            onClick={() => {
              setAsking(false);
              onBake(size, true);
            }}
          >
            Copy materials and bake
          </button>
          <button type="button" onClick={() => setAsking(false)}>
            Don't bake
          </button>
        </div>
      )}
      {report && (
        <p className="character-hint" role="status" data-testid="bake-report">
          Baked {report.size} × {report.size}
          {report.missed
            ? ` · ${report.missed.toLocaleString('en')} of ${report.covered.toLocaleString('en')} texels found no sculpt and keep the cage's normal`
            : ''}
          .
          {report.subdivided &&
            ' The part is shown subdivided, but the GLB carries the cage: the map falls a little differently there.'}
        </p>
      )}
    </>
  );
}
