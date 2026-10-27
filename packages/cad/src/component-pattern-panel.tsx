/**
 * R2b-3 Surface entries for component patterns (docs/cad/r2b-assembly.md, Component pattern):
 * Pattern… on a selected component makes copies of it in a row or a circle, and a selected
 * pattern's Inspector edits its count and spacing or step angle, or removes it.
 */
import { useState } from 'react';
import { Dialog } from '@editor-platform/editor-ui';
import {
  mm,
  parameterValues,
  patternCount,
  position,
  type CadComponent,
  type CadComponentPattern,
  type CadDocument,
  type CadPatternLayout,
  type Vec3,
} from '@editor-platform/cad-core';
import type { CadAssembly } from './assembly';
import type { CadSnapshot } from './controller';
import { AngleField, CountField, fmt, LengthField } from './dimension-fields';

const axes: Record<string, Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const axisName = (v: Vec3) =>
  Object.entries(axes)
    .find(([, a]) => a.every((c, i) => c === v[i]))?.[0]
    .toUpperCase() ?? `(${v.map((c) => fmt(c)).join(', ')})`;

/** How many components a pattern lays out now (its seed included). */
export const patternSize = (doc: CadDocument, pattern: CadComponentPattern) =>
  patternCount(pattern, parameterValues(doc));

/** Pattern…: copies of `seed` in a row along an axis or round an axis through a point. */
export function PatternDialog({
  assembly,
  seed,
  onClose,
}: {
  assembly: CadAssembly;
  seed: CadComponent;
  onClose: () => void;
}) {
  const [layout, setLayout] = useState('x');
  const [count, setCount] = useState('4');
  const [step, setStep] = useState('20');
  const [origin, setOrigin] = useState(['0', '0', '0']);
  const circular = layout.startsWith('circle');
  const n = Number(count);
  const by = Number(step);
  const at = origin.map(Number) as Vec3;
  const valid =
    Number.isInteger(n) &&
    n >= 2 &&
    n <= 1000 &&
    Number.isFinite(by) &&
    by !== 0 &&
    (!circular || at.every(Number.isFinite));
  const make = () => {
    const l: CadPatternLayout = circular
      ? {
          type: 'circular',
          axisOrigin: position(...at),
          axisDirection: axes[layout.slice(-1)]!,
          count: { literal: n },
          angle: { literalRad: (by * Math.PI) / 180 },
        }
      : { type: 'linear', direction: axes[layout]!, count: { literal: n }, spacing: mm(by) };
    void assembly.insertPattern(seed.id, l).then((ok) => ok && onClose());
  };
  return (
    <Dialog title="Pattern component" onClose={onClose}>
      <form
        className="cad-export"
        data-testid="cad-pattern-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) make();
        }}
      >
        <p>
          「{seed.name}
          」の写しを並べます。countは元の部品を含む数です。写しは元の部品の配置に従い、BOMでは元の部品と同じ部品として数えます。
        </p>
        <label className="ep-field">
          Layout
          <select value={layout} onChange={(e) => setLayout(e.target.value)}>
            <option value="x">Row along X</option>
            <option value="y">Row along Y</option>
            <option value="z">Row along Z</option>
            <option value="circle-x">Circle about X</option>
            <option value="circle-y">Circle about Y</option>
            <option value="circle-z">Circle about Z</option>
          </select>
        </label>
        <label className="ep-field">
          Count
          <input
            type="number"
            min={2}
            max={1000}
            step={1}
            value={count}
            onChange={(e) => setCount(e.target.value)}
          />
        </label>
        <label className="ep-field">
          {circular ? 'Step angle (°)' : 'Spacing (mm)'}
          <input type="number" value={step} onChange={(e) => setStep(e.target.value)} />
        </label>
        {circular && (
          <fieldset className="cad-row">
            <legend>Axis through (mm)</legend>
            {['X', 'Y', 'Z'].map((label, i) => (
              <label key={label} className="ep-field">
                {label}
                <input
                  inputMode="decimal"
                  value={origin[i]}
                  onChange={(e) => setOrigin(origin.map((v, j) => (j === i ? e.target.value : v)))}
                />
              </label>
            ))}
          </fieldset>
        )}
        <div className="cad-row">
          <button type="submit" disabled={!valid}>
            Create pattern
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** A selected pattern: its seed, layout, count and spacing or step angle (each one edit). */
export function PatternInspector({
  assembly,
  snapshot,
  pattern,
}: {
  assembly: CadAssembly;
  snapshot: CadSnapshot;
  pattern: CadComponentPattern;
}) {
  const doc = snapshot.content;
  const seed = doc.components.find((c) => c.id === pattern.seedComponentId);
  const l = pattern.layout;
  const set = (layout: CadPatternLayout) => void assembly.updatePattern({ ...pattern, layout });
  const disabled = snapshot.readOnly || snapshot.busy;
  return (
    <div className="cad-component" data-testid="cad-pattern">
      <p>
        <strong>{pattern.name}</strong>
        <br />
        <small>
          {patternSize(doc, pattern)} × {seed?.name ?? pattern.seedComponentId} ·{' '}
          {l.type === 'linear'
            ? `row along ${axisName(l.direction)}`
            : `circle about ${axisName(l.axisDirection)}`}
        </small>
      </p>
      <fieldset className="cad-part-properties" disabled={disabled} key={snapshot.rejections}>
        <CountField count={l.count} doc={doc} onCommit={(count) => set({ ...l, count })} />
        {l.type === 'linear' ? (
          <LengthField
            label="Spacing"
            length={l.spacing}
            doc={doc}
            onCommit={(spacing) => set({ ...l, spacing })}
          />
        ) : (
          <AngleField
            label="Step angle"
            angle={l.angle}
            doc={doc}
            onCommit={(angle) => set({ ...l, angle })}
          />
        )}
      </fieldset>
      <div className="cad-row">
        {seed && (
          <button type="button" onClick={() => assembly.select(seed.id)}>
            Show seed
          </button>
        )}
        {!snapshot.readOnly && (
          <button
            type="button"
            disabled={snapshot.busy}
            onClick={() => void assembly.removePattern(pattern.id)}
          >
            Remove pattern
          </button>
        )}
      </div>
    </div>
  );
}
