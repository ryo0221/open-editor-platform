/**
 * PD7 (docs/cad/product-design.md, PD7 見え方の検査): the document's sight checks. Each one looks
 * from eye points (or a lamp's point) and measures an angle hidden by bodies, a share of a target
 * seen through clear bodies, or how far a ray turns before a body stops it. The panel measures
 * them on the current display meshes (never stored), marks each pass, fail or unknown with its
 * reason and the step and triangles it used, and exports them with their results as JSON.
 * The checks are geometric only: they are not tests against any rule (PD-U6).
 */
import { useMemo, useState } from 'react';
import { Section } from '@editor-platform/editor-ui';
import {
  measureSightChecks,
  sightCheckReport,
  type CadSightCheck,
  type CadSightMeasure,
  type CadSightMeasureKind,
  type CadSightResult,
  type CadSightToward,
  type CadSightUnknown,
  type Vec3,
} from '@editor-platform/cad-core';
import type { CadController, CadSnapshot } from './controller';
import { showDesignValue } from './design-targets-panel';

const kindLabel: Record<CadSightMeasureKind, string> = {
  obstruction: 'Angle hidden by bodies',
  visibleFraction: 'Share of a target seen',
  visibleAngle: 'Angle a light reaches',
};
const reasonText: Record<CadSightUnknown, string> = {
  'sight-not-evaluated': 'not calculated with this document’s own build yet',
  'sight-body-missing': 'a body is not drawn',
  'sight-limit': 'too many triangles to check',
  'sight-target-hidden': 'no part of the target faces an eye',
};
const show = (r: Pick<CadSightResult, 'unit'>, v: number) =>
  r.unit === 'ratio' ? `${(v * 100).toFixed(1)} %` : showDesignValue('deg', v);
const parse = (text: string) => (text.trim() === '' ? undefined : Number(text));
/** "x, y, z" (mm) to a point, or undefined. */
const point = (text: string): Vec3 | undefined => {
  const v = text
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  return v.length === 3 && v.every(Number.isFinite) ? (v as Vec3) : undefined;
};
/** One or two points separated by ";". */
const points = (text: string): Vec3[] | undefined => {
  const parts = text.split(';').filter((s) => s.trim());
  const v = parts.map(point);
  return v.length >= 1 && v.length <= 2 && v.every(Boolean) ? (v as Vec3[]) : undefined;
};
const freshId = (taken: readonly CadSightCheck[]) => {
  for (let n = taken.length + 1; ; n++) {
    const id = `sight-${n}`;
    if (!taken.some((t) => t.id === id)) return id;
  }
};

export function SightChecksSection({
  controller,
  snapshot,
  editable,
  name,
}: {
  controller: CadController;
  snapshot: CadSnapshot;
  editable: boolean;
  /** The document's name, for the exported file. */
  name: string;
}) {
  const doc = snapshot.content;
  const checks = doc.sightChecks ?? [];
  const held = snapshot.busy || !!snapshot.sketch;
  const active = doc.bodies.filter((b) => b.state === 'active');
  const { meshes, evaluation, reference } = snapshot;
  const results = useMemo(() => {
    if (!checks.length) return [];
    // Only the committed document's own build, as the design targets read it (PD1).
    const own = evaluation?.status === 'ok' && !reference;
    const world =
      own && meshes?.current
        ? meshes.meshes
            .filter((m) => !m.lod && !m.beforeFailure)
            .map((m) => {
              const p = new Float64Array(m.positions.length);
              for (let i = 0; i < p.length; i++) p[i] = m.positions[i]! + m.origin[i % 3]!;
              return { bodyId: m.bodyId, points: p, indices: m.indices };
            })
        : undefined;
    return measureSightChecks(doc, world ? { meshes: world } : {});
  }, [doc, checks.length, evaluation, reference, meshes]);
  const byId = new Map(results.map((r) => [r.id, r]));
  const count = (s: CadSightResult['status']) => results.filter((r) => r.status === s).length;
  if (!active.length && !checks.length) return null;
  const exportJson = () => {
    const report = sightCheckReport(doc, results, name);
    const blob = new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), {
      href: url,
      download: `${name}-sight-checks.json`,
    }).click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return (
    <Section title={`Sight checks (${checks.length})`} open={checks.length > 0}>
      <fieldset
        className="cad-targets"
        data-testid="cad-sight-checks"
        disabled={held}
        key={snapshot.rejections}
      >
        {checks.length > 0 && (
          <p className="cad-targets-summary" data-testid="cad-sight-checks-summary">
            {count('pass')} pass · {count('fail')} fail · {count('unknown')} unknown
          </p>
        )}
        <ul aria-label="Sight checks" className="cad-targets-list">
          {checks.map((c) => {
            const r = byId.get(c.id);
            const status = r?.status ?? 'unknown';
            const unit = {
              unit: r?.unit ?? (c.measure.kind === 'visibleFraction' ? 'ratio' : 'deg'),
            } as const;
            const band = [
              c.min !== undefined ? `≥ ${show(unit, c.min)}` : '',
              c.max !== undefined ? `≤ ${show(unit, c.max)}` : '',
            ]
              .filter(Boolean)
              .join(', ');
            return (
              <li key={c.id} data-check={c.id} data-status={status} className={status}>
                <div className="cad-targets-head">
                  <span>
                    {c.name}
                    {c.requirement && <span className="cad-muted"> ({c.requirement})</span>}
                  </span>
                  <strong data-testid={`cad-sight-check-${c.id}`}>
                    {r?.value === undefined ? '—' : show(unit, r.value)}{' '}
                    <span className="cad-targets-flag">{status}</span>
                  </strong>
                </div>
                <div className="cad-muted">
                  {describe(doc, c.measure)} · {band}
                  {r?.reason && <> · {reasonText[r.reason]}</>}
                </div>
                {r && r.value !== undefined && (
                  <div className="cad-muted" data-testid={`cad-sight-detail-${c.id}`}>
                    {detail(r)}
                  </div>
                )}
                {editable && (
                  <button
                    type="button"
                    aria-label={`Remove ${c.name}`}
                    onClick={() =>
                      void controller.setSightChecks(checks.filter((x) => x.id !== c.id))
                    }
                  >
                    Remove
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {editable && (
          <AddCheck
            doc={doc}
            onAdd={(c) => controller.setSightChecks([...checks, { ...c, id: freshId(checks) }])}
          />
        )}
        {checks.length > 0 && (
          <button type="button" onClick={exportJson}>
            Export sight checks (JSON)
          </button>
        )}
      </fieldset>
    </Section>
  );
}

/** Each eye's value, and the step and triangles the value rests on. */
function detail(r: CadSightResult) {
  const parts: string[] = [];
  if (r.perEye && r.perEye.length > 1)
    parts.push(`each eye ${r.perEye.map((v) => show(r, v)).join(', ')}`);
  if (r.stepDeg !== undefined) parts.push(`step ${showDesignValue('deg', r.stepDeg)}`);
  if (r.samples !== undefined) parts.push(`${r.samples} target triangles`);
  if (r.triangles !== undefined) parts.push(`${r.triangles} triangles checked`);
  return parts.join(' · ');
}

const bodyNames = (doc: CadSnapshot['content'], ids: readonly string[]) =>
  ids.map((id) => doc.bodies.find((b) => b.id === id)?.name ?? id).join(', ');
function describe(doc: CadSnapshot['content'], m: CadSightMeasure) {
  const eyes = (e: readonly Vec3[]) => (e.length === 2 ? 'both eyes' : 'one eye');
  switch (m.kind) {
    case 'obstruction':
      return `${bodyNames(doc, m.bodyIds)} from ${eyes(m.eyes)}, ${m.fromDeg}° to ${m.toDeg}°`;
    case 'visibleFraction':
      return `${bodyNames(doc, m.targetIds)} from ${eyes(m.eyes)}${
        m.clearIds?.length ? ` through ${bodyNames(doc, m.clearIds)}` : ''
      }`;
    case 'visibleAngle':
      return `Turning ${m.toward}, up to ${m.limitDeg ?? 90}°${
        m.clearIds?.length ? `, through ${bodyNames(doc, m.clearIds)}` : ''
      }`;
  }
}

function AddCheck({
  doc,
  onAdd,
}: {
  doc: CadSnapshot['content'];
  onAdd: (c: Omit<CadSightCheck, 'id'>) => Promise<boolean> | boolean;
}) {
  const active = doc.bodies.filter((b) => b.state === 'active');
  const live = (ids: string[]) => ids.filter((id) => active.some((b) => b.id === id));
  const [kind, setKind] = useState<CadSightMeasureKind>('obstruction');
  const [label, setLabel] = useState('');
  const [requirement, setRequirement] = useState('');
  const [eyeText, setEyes] = useState('');
  const [forwardText, setForward] = useState('1, 0, 0');
  const [upText, setUp] = useState('0, 0, 1');
  const [from, setFrom] = useState('0');
  const [to, setTo] = useState('90');
  const [toward, setToward] = useState<CadSightToward>('left');
  const [limit, setLimit] = useState('');
  const [step, setStep] = useState('');
  const [chosen, setBodies] = useState<string[]>([]);
  const [chosenClear, setClear] = useState<string[]>([]);
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const bodies = live(chosen);
  const clear = live(chosenClear);
  const lo = parse(min);
  const hi = parse(max);
  const stepDeg = parse(step);
  const limitDeg = parse(limit);
  const eyes = points(eyeText);
  const forward = point(forwardText);
  const up = point(upText);
  const optional = {
    ...(stepDeg !== undefined ? { stepDeg } : {}),
  };
  const measure: CadSightMeasure | undefined =
    kind === 'obstruction'
      ? eyes && forward && up && bodies.length
        ? {
            kind,
            eyes,
            forward,
            up,
            fromDeg: Number(from),
            toDeg: Number(to),
            bodyIds: bodies,
            ...optional,
          }
        : undefined
      : kind === 'visibleFraction'
        ? eyes && bodies.length
          ? { kind, eyes, targetIds: bodies, ...(clear.length ? { clearIds: clear } : {}) }
          : undefined
        : eyes?.length === 1 && forward && up
          ? {
              kind,
              from: eyes[0]!,
              forward,
              up,
              toward,
              ...(limitDeg !== undefined ? { limitDeg } : {}),
              ...(clear.length ? { clearIds: clear } : {}),
              ...optional,
            }
          : undefined;
  const bandOk =
    (lo !== undefined || hi !== undefined) &&
    (lo === undefined || Number.isFinite(lo)) &&
    (hi === undefined || Number.isFinite(hi)) &&
    (lo === undefined || hi === undefined || lo <= hi);
  const ready = !!label.trim() && !!measure && bandOk;
  const pick = (title: string, value: string[], set: (v: string[]) => void) => (
    <label className="ep-field">
      {title}
      <select
        multiple
        aria-label={title}
        value={value}
        size={Math.min(5, Math.max(2, active.length))}
        onChange={(e) => set([...e.target.selectedOptions].map((o) => o.value))}
      >
        {active.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
      </select>
    </label>
  );
  const text = (title: string, value: string, set: (v: string) => void, placeholder?: string) => (
    <label className="ep-field">
      {title}
      <input value={value} placeholder={placeholder} onChange={(e) => set(e.target.value)} />
    </label>
  );
  const add = async () => {
    if (!ready) return;
    const ok = await onAdd({
      name: label.trim(),
      ...(requirement.trim() ? { requirement: requirement.trim() } : {}),
      measure: measure!,
      ...(lo !== undefined ? { min: lo } : {}),
      ...(hi !== undefined ? { max: hi } : {}),
    });
    if (ok) {
      setLabel('');
      setRequirement('');
      setMin('');
      setMax('');
    }
  };
  return (
    <div className="cad-forms" role="group" aria-label="Add sight check">
      {text('Check name', label, setLabel)}
      {text('Requirement ID', requirement, setRequirement, 'optional, e.g. RQ-21')}
      <label className="ep-field">
        Measure
        <select value={kind} onChange={(e) => setKind(e.target.value as CadSightMeasureKind)}>
          {(Object.keys(kindLabel) as CadSightMeasureKind[]).map((k) => (
            <option key={k} value={k}>
              {kindLabel[k]}
            </option>
          ))}
        </select>
      </label>
      {kind === 'visibleAngle'
        ? text('Light point (mm)', eyeText, setEyes, 'x, y, z')
        : text('Eyes (mm)', eyeText, setEyes, 'x, y, z; x, y, z')}
      {kind !== 'visibleFraction' && (
        <div className="cad-row">
          {text('Forward', forwardText, setForward)}
          {text('Up', upText, setUp)}
        </div>
      )}
      {kind === 'obstruction' && (
        <>
          <div className="cad-row">
            {text('From (°)', from, setFrom)}
            {text('To (°)', to, setTo)}
          </div>
          {pick('Hiding bodies', chosen, setBodies)}
        </>
      )}
      {kind === 'visibleFraction' && (
        <>
          {pick('Target bodies', chosen, setBodies)}
          {pick('Clear bodies', chosenClear, setClear)}
        </>
      )}
      {kind === 'visibleAngle' && (
        <>
          <label className="ep-field">
            Toward
            <select value={toward} onChange={(e) => setToward(e.target.value as CadSightToward)}>
              {(['left', 'right', 'up', 'down'] as const).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          {text('Turn at most (°)', limit, setLimit, '90')}
          {pick('Clear bodies', chosenClear, setClear)}
        </>
      )}
      {kind !== 'visibleFraction' && text('Step (°)', step, setStep, '0.1')}
      <div className="cad-row">
        {text(kind === 'visibleFraction' ? 'Min (0–1)' : 'Min (°)', min, setMin)}
        {text(kind === 'visibleFraction' ? 'Max (0–1)' : 'Max (°)', max, setMax)}
      </div>
      <button type="button" disabled={!ready} onClick={() => void add()}>
        Add check
      </button>
    </div>
  );
}
