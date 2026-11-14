/**
 * CLF3 (docs/cad/car-look-process.md, 比率の指標 and CLF1〜CLF3の分け方): the car's proportion
 * indicators. The setup (which bodies are the wheels, the body and the glass, the ground and each
 * indicator's band) is stored in the document (CLF-U2); the values are measured from the current
 * display meshes and never stored.
 */
import { useMemo } from 'react';
import { CommitInput, Section } from '@editor-platform/editor-ui';
import {
  cadProportionGroundLimitMm,
  cadProportionMetrics,
  defaultProportions,
  measureProportions,
  type CadProportionMetric,
  type CadProportions,
} from '@editor-platform/cad-core';
import type { CadController, CadSnapshot } from './controller';
import { fmtGrouped } from './dimension-fields';

const roles = [
  ['frontWheels', 'Front wheels'],
  ['rearWheels', 'Rear wheels'],
  ['body', 'Body'],
  ['windows', 'Windows'],
] as const;
const digits = { ratio: 2, mm: 1, deg: 1 } as const;
const suffix = { ratio: '', mm: ' mm', deg: '°' } as const;
const show = (metric: CadProportionMetric, v: number) => {
  const { unit } = cadProportionMetrics[metric];
  return `${fmtGrouped(v, digits[unit])}${suffix[unit]}`;
};
/** A typed band end: empty leaves that end open; anything else must be a number. */
const parse = (text: string) => (text.trim() === '' ? null : Number(text));

export function ProportionsSection({
  controller,
  snapshot,
  editable,
}: {
  controller: CadController;
  snapshot: CadSnapshot;
  editable: boolean;
}) {
  const doc = snapshot.content;
  const p = doc.proportions;
  const canEdit = editable;
  // Held (disabled, still mounted so a buffered field keeps its text) while another edit
  // evaluates, since each edit starts from the setup it read, and while a sketch is open, which
  // refuses document edits (#1114 review).
  const held = snapshot.busy || !!snapshot.sketch;
  const active = doc.bodies.filter((b) => b.state === 'active');
  const meshes = snapshot.meshes;
  const values = useMemo(() => {
    // Only the committed document's own meshes: not an earlier content's while it re-evaluates,
    // nor a preview (#1114 review).
    // Nor a substitute kernel's evaluation: measurements need the document's own build.
    if (!p || !meshes?.current || snapshot.reference) return undefined;
    // The standard display meshes in world mm (a coarse LOD or a shape before a failure is not
    // the body's own shape).
    const own = meshes.meshes
      .filter((m) => !m.lod && !m.beforeFailure)
      .map((m) => {
        const points = new Float64Array(m.positions.length);
        for (let i = 0; i < points.length; i++) points[i] = m.positions[i]! + m.origin[i % 3]!;
        return { bodyId: m.bodyId, points, indices: m.indices };
      });
    return measureProportions(p, own);
  }, [p, meshes, snapshot.reference]);
  if (!active.length) return null;
  const set = (change: Partial<CadProportions>) =>
    controller.setProportions({ ...(p ?? defaultProportions()), ...change });
  if (!p)
    return (
      <Section title="Proportions" open={false}>
        <p className="cad-muted">
          Wheels, body and glass give the car’s proportions (wheel to height, wheelbase, glass).
        </p>
        {canEdit && (
          <button
            type="button"
            disabled={held}
            onClick={() => void controller.setProportions(defaultProportions())}
          >
            Set up proportions
          </button>
        )}
      </Section>
    );
  const band = (metric: CadProportionMetric) => p.targets.find((t) => t.metric === metric);
  const setBand = (metric: CadProportionMetric, end: 'min' | 'max', text: string) => {
    const v = parse(text);
    if (v !== null && !Number.isFinite(v)) return false;
    const old = band(metric) ?? { metric };
    const next = { ...old };
    if (v === null) delete next[end];
    else next[end] = v;
    // A band upside down is refused here, so the field keeps the stored value (#1114 review).
    if (next.min !== undefined && next.max !== undefined && next.min > next.max) return false;
    const keep = next.min !== undefined || next.max !== undefined;
    // In the indicators' order, so the stored list reads as the table does.
    const targets = (Object.keys(cadProportionMetrics) as CadProportionMetric[]).flatMap((m) =>
      m === metric ? (keep ? [next] : []) : p.targets.filter((t) => t.metric === m),
    );
    void set({ targets });
    return true;
  };
  return (
    <Section title="Proportions">
      {/* Remounted when the controller rejects an edit (evaluation failure): the fields show the
          stored setup again, as the part properties do (#1114 review). */}
      <fieldset
        className="cad-proportions"
        data-testid="cad-proportions"
        disabled={held}
        key={snapshot.rejections}
      >
        {roles.map(([role, label]) => (
          <label key={role} className="cad-proportions-role">
            <span>{label}</span>
            <select
              multiple
              aria-label={label}
              disabled={!canEdit}
              value={p[role]}
              size={Math.min(4, active.length)}
              onChange={(e) =>
                void set({ [role]: [...e.target.selectedOptions].map((o) => o.value) })
              }
            >
              {active.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        ))}
        {/* Read-only as text, like the bands: a refused edit must never show as stored. */}
        {canEdit ? (
          <CommitInput
            label="Ground (mm)"
            type="number"
            value={p.groundMm}
            onCommit={(v) => {
              const n = Number(v);
              // The model's bound too, so a refused height never shows as stored (#1114 review).
              if (v.trim() === '' || !(Math.abs(n) <= cadProportionGroundLimitMm)) return false;
              void set({ groundMm: n });
              return true;
            }}
          />
        ) : (
          <p className="cad-proportions-ground">Ground {fmtGrouped(p.groundMm, 1)} mm</p>
        )}
        {/* A list, not a table: the side panel is narrow. */}
        <ul aria-label="Proportion indicators" className="cad-proportions-list">
          {(values ?? []).map(({ metric, value, status }) => {
            const b = band(metric);
            const { label } = cadProportionMetrics[metric];
            return (
              <li key={metric} data-metric={metric} data-status={status} className={status}>
                <div className="cad-proportions-head">
                  <span>{label}</span>
                  <strong data-testid={`cad-proportion-${metric}`}>
                    {value === undefined ? '—' : show(metric, value)}
                    {status === 'outside' && <span className="cad-proportions-flag"> outside</span>}
                  </strong>
                </div>
                <div className="cad-proportions-band">
                  {(['min', 'max'] as const).map((end) =>
                    canEdit ? (
                      <CommitInput
                        key={end}
                        label={`${label} ${end}`}
                        value={b?.[end] ?? ''}
                        placeholder={end}
                        onCommit={(text) => setBand(metric, end, text)}
                      />
                    ) : (
                      <span key={end}>
                        {end} {b?.[end] ?? '—'}
                      </span>
                    ),
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {!values && <p className="cad-muted">Indicators are measured when the shape is shown.</p>}
        {canEdit && (
          <button type="button" onClick={() => void controller.setProportions(null)}>
            Remove proportions
          </button>
        )}
      </fieldset>
    </Section>
  );
}
