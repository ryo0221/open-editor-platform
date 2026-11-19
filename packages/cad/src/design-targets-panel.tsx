/**
 * PD1 (docs/cad/product-design.md, PD1 設計の目標値): the document's design targets. Each one
 * names a measured value, its band and the requirement it comes from; the panel measures them on
 * the current evaluation and display meshes (never stored), marks each pass, fail or unknown with
 * its reason, and exports the targets with their results as JSON for a project's verification.
 */
import { useMemo, useState, useSyncExternalStore } from 'react';
import { Section } from '@editor-platform/editor-ui';
import {
  cadDesignStackValues,
  cadMass,
  cadProportionMetricIds,
  cadProportionMetrics,
  cadSpringQuantities,
  designTargetReport,
  measureDesignTargets,
  type CadDesignAxis,
  type CadDesignMeasure,
  type CadDesignMeasureKind,
  type CadDesignStackValue,
  type CadStackResult,
  type CadDesignTarget,
  type CadDesignTargetResult,
  type CadDesignUnit,
  type CadDesignUnknown,
  type CadProportionMetric,
  type CadSpringQuantity,
} from '@editor-platform/cad-core';
import type { CadAssembly } from './assembly';
import type { CadController, CadSnapshot } from './controller';
import { fmtGrouped } from './dimension-fields';

const kindLabel: Record<CadDesignMeasureKind, string> = {
  parameter: 'Parameter',
  extent: 'Size along an axis',
  distance: 'Distance between bodies',
  mass: 'Mass',
  volume: 'Volume',
  area: 'Area',
  proportion: 'Proportion',
  spring: 'Spring estimate',
  'tolerance-stack': 'Tolerance stack',
};
/** PD3: the stack numbers a target may measure. */
export const stackValueLabel: Record<CadDesignStackValue, string> = {
  nominal: 'Nominal',
  'worst-min': 'Worst case min',
  'worst-max': 'Worst case max',
  'rss-min': 'RSS min',
  'rss-max': 'RSS max',
  'mc-min': 'Monte Carlo min',
  'mc-max': 'Monte Carlo max',
  'mc-outside': 'Monte Carlo outside fraction',
};
/** PD5: what a spring target reads from the spring's estimate. */
export const springQuantityLabel: Record<CadSpringQuantity, string> = {
  rate: 'Spring rate',
  workingForce: 'Force at the working deflection',
  workingTorque: 'Torque at the working angle',
  workingStress: 'Stress at the working point',
  solidLength: 'Solid length',
  solidStress: 'Stress at solid',
  freeLength: 'Free length',
  stripLength: 'Strip length',
  usableTurns: 'Usable barrel turns',
  fullTorque: 'Torque fully wound',
  fullStress: 'Stress fully wound',
  runHours: 'Running time',
};
const unitText: Record<CadDesignUnit, string> = {
  mm: ' mm',
  rad: ' rad',
  count: '',
  kg: ' kg',
  mm3: ' mm³',
  mm2: ' mm²',
  ratio: '',
  deg: '°',
  'N/mm': ' N/mm',
  'N·mm/rad': ' N·mm/rad',
  N: ' N',
  'N·mm': ' N·mm',
  MPa: ' MPa',
  turns: ' turns',
  h: ' h',
};
const digits: Record<CadDesignUnit, number> = {
  mm: 2,
  rad: 4,
  count: 0,
  kg: 4,
  mm3: 0,
  mm2: 0,
  ratio: 3,
  deg: 1,
  'N/mm': 3,
  'N·mm/rad': 5,
  N: 3,
  'N·mm': 4,
  MPa: 0,
  turns: 2,
  h: 1,
};
const reasonText: Record<CadDesignUnknown, string> = {
  'design-not-evaluated': 'not calculated with this document’s own build yet',
  'design-body-missing': 'a body is not drawn',
  'design-mass-left-out': 'a body has no mass (density or thickness)',
  'design-volume-sheet': 'a sheet has no volume',
  'design-proportion-missing': 'no proportion set up for it',
  'design-distance-limit': 'the meshes are too large to measure',
  'design-spring-invalid': 'the spring’s values give no spring now',
  'design-spring-quantity': 'this spring has no such value',
  'design-stack-stale': 'the tolerance stack is stale',
};
export const showDesignValue = (unit: CadDesignUnit, v: number) =>
  `${fmtGrouped(v, digits[unit])}${unitText[unit]}`;
const noSubscribe = () => () => {};
const noSnapshot = () => undefined;
const parse = (text: string) => (text.trim() === '' ? undefined : Number(text));
const freshId = (taken: readonly CadDesignTarget[]) => {
  for (let n = taken.length + 1; ; n++) {
    const id = `target-${n}`;
    if (!taken.some((t) => t.id === id)) return id;
  }
};

export function DesignTargetsSection({
  controller,
  snapshot,
  assembly,
  editable,
  name,
  stacks,
}: {
  controller: CadController;
  snapshot: CadSnapshot;
  assembly?: CadAssembly;
  /** PD3: the document's stack results (with its PMI), for targets that measure a stack. */
  stacks?: readonly CadStackResult[];
  editable: boolean;
  /** The document's name, for the exported file. */
  name: string;
}) {
  const doc = snapshot.content;
  const targets = doc.designTargets ?? [];
  const held = snapshot.busy || !!snapshot.sketch;
  const active = doc.bodies.filter((b) => b.state === 'active');
  const { meshes, evaluation, reference } = snapshot;
  // Placed versions evaluated in the background arrive through the assembly, not the snapshot:
  // its revision re-measures a whole document's mass when they land.
  const placed = useSyncExternalStore(
    assembly?.subscribe ?? noSubscribe,
    assembly?.getSnapshot ?? noSnapshot,
  );
  const results = useMemo(() => {
    if (!targets.length) return [];
    // Only the committed document's own build: not a reference evaluation, an earlier content's
    // meshes while it re-evaluates, a coarse LOD or a shape before a failure.
    const own = evaluation?.status === 'ok' && !reference ? evaluation : undefined;
    const world =
      own && meshes?.current
        ? meshes.meshes
            .filter((m) => !m.lod && !m.beforeFailure)
            .map((m) => {
              const points = new Float64Array(m.positions.length);
              for (let i = 0; i < points.length; i++)
                points[i] = m.positions[i]! + m.origin[i % 3]!;
              return { bodyId: m.bodyId, points, indices: m.indices };
            })
        : undefined;
    const mass =
      own && !own.assembly?.poseMismatch?.length
        ? cadMass(
            doc,
            own.bodies,
            assembly?.lookup ?? (() => undefined),
            assembly?.versions(own),
            assembly?.access,
          )
        : undefined;
    return measureDesignTargets(doc, {
      ...(own ? { bodies: own.bodies } : {}),
      ...(world ? { meshes: world } : {}),
      ...(mass ? { mass } : {}),
      ...(stacks ? { stacks } : {}),
    });
  }, [doc, targets.length, evaluation, reference, meshes, assembly, placed, stacks]);
  const byId = new Map(results.map((r) => [r.id, r]));
  const count = (s: CadDesignTargetResult['status']) =>
    results.filter((r) => r.status === s).length;
  // An assembly of components alone still has its whole mass to target.
  if (!active.length && !doc.parameters.length && !doc.components.length && !targets.length)
    return null;
  const exportJson = () => {
    const report = designTargetReport(doc, results, name);
    const blob = new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), {
      href: url,
      download: `${name}-design-targets.json`,
    }).click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return (
    <Section title={`Design targets (${targets.length})`} open={targets.length > 0}>
      <fieldset
        className="cad-targets"
        data-testid="cad-design-targets"
        disabled={held}
        key={snapshot.rejections}
      >
        {targets.length > 0 && (
          <p className="cad-targets-summary" data-testid="cad-design-targets-summary">
            {count('pass')} pass · {count('fail')} fail · {count('unknown')} unknown
          </p>
        )}
        <ul aria-label="Design targets" className="cad-targets-list">
          {targets.map((t) => {
            const r = byId.get(t.id);
            const status = r?.status ?? 'unknown';
            const unit = r?.unit ?? 'mm';
            const band = [
              t.min !== undefined ? `≥ ${showDesignValue(unit, t.min)}` : '',
              t.max !== undefined ? `≤ ${showDesignValue(unit, t.max)}` : '',
            ]
              .filter(Boolean)
              .join(', ');
            return (
              <li key={t.id} data-target={t.id} data-status={status} className={status}>
                <div className="cad-targets-head">
                  <span>
                    {t.name}
                    {t.requirement && <span className="cad-muted"> ({t.requirement})</span>}
                  </span>
                  <strong data-testid={`cad-design-target-${t.id}`}>
                    {r?.value === undefined ? '—' : showDesignValue(unit, r.value)}{' '}
                    <span className="cad-targets-flag">{status}</span>
                  </strong>
                </div>
                <div className="cad-muted">
                  {describe(doc, t.measure)} · {band}
                  {r?.reason && <> · {reasonText[r.reason]}</>}
                </div>
                {editable && (
                  <button
                    type="button"
                    aria-label={`Remove ${t.name}`}
                    onClick={() =>
                      void controller.setDesignTargets(targets.filter((x) => x.id !== t.id))
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
          <AddTarget
            doc={doc}
            onAdd={(t) => controller.setDesignTargets([...targets, { ...t, id: freshId(targets) }])}
          />
        )}
        {targets.length > 0 && (
          <button type="button" onClick={exportJson}>
            Export targets (JSON)
          </button>
        )}
      </fieldset>
    </Section>
  );
}

const bodyNames = (doc: CadSnapshot['content'], ids: readonly string[]) =>
  ids.map((id) => doc.bodies.find((b) => b.id === id)?.name ?? id).join(', ');
function describe(doc: CadSnapshot['content'], m: CadDesignMeasure) {
  switch (m.kind) {
    case 'parameter':
      return `Parameter ${doc.parameters.find((p) => p.id === m.parameterId)?.name ?? m.parameterId}`;
    case 'extent':
      return `${m.axis.toUpperCase()} size of ${bodyNames(doc, m.bodyIds)}`;
    case 'distance':
      return `Distance ${bodyNames(doc, m.a)} ↔ ${bodyNames(doc, m.b)}`;
    case 'mass':
      return m.bodyIds ? `Mass of ${bodyNames(doc, m.bodyIds)}` : 'Mass of the whole document';
    case 'volume':
      return `Volume of ${bodyNames(doc, m.bodyIds)}`;
    case 'area':
      return `Area of ${bodyNames(doc, m.bodyIds)}`;
    case 'proportion':
      return cadProportionMetrics[m.metric].label;
    case 'spring':
      return `${springQuantityLabel[m.quantity]} of ${doc.features.find((f) => f.id === m.featureId)?.name ?? m.featureId}`;
    case 'tolerance-stack':
      return `${stackValueLabel[m.value]} of ${doc.toleranceStacks?.find((s) => s.id === m.stackId)?.name ?? m.stackId}`;
  }
}

function AddTarget({
  doc,
  onAdd,
}: {
  doc: CadSnapshot['content'];
  onAdd: (t: Omit<CadDesignTarget, 'id'>) => Promise<boolean> | boolean;
}) {
  const active = doc.bodies.filter((b) => b.state === 'active');
  const [kind, setKind] = useState<CadDesignMeasureKind>('distance');
  const [label, setLabel] = useState('');
  const [requirement, setRequirement] = useState('');
  const [a, setA] = useState<string[]>([]);
  const [b, setB] = useState<string[]>([]);
  const [axis, setAxis] = useState<CadDesignAxis>('x');
  const [chosenParameter, setParameterId] = useState(doc.parameters[0]?.id ?? '');
  // The choice follows the list: a parameter added after the form opened, or the chosen one deleted.
  const parameterId = doc.parameters.some((p) => p.id === chosenParameter)
    ? chosenParameter
    : (doc.parameters[0]?.id ?? '');
  const [metric, setMetric] = useState<CadProportionMetric>(cadProportionMetricIds[0]!);
  const springs = doc.features.filter((f) => f.type === 'spring');
  const [chosenSpring, setSpring] = useState(springs[0]?.id ?? '');
  const springId = springs.some((f) => f.id === chosenSpring)
    ? chosenSpring
    : (springs[0]?.id ?? '');
  const [quantity, setQuantity] = useState<CadSpringQuantity>('rate');
  const [stackId, setStackId] = useState(doc.toleranceStacks?.[0]?.id ?? '');
  const [stackValue, setStackValue] = useState<CadDesignStackValue>('worst-min');
  const stack = doc.toleranceStacks?.find((s) => s.id === stackId) ?? doc.toleranceStacks?.[0];
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const lo = parse(min);
  const hi = parse(max);
  const measure: CadDesignMeasure | undefined =
    kind === 'parameter'
      ? parameterId
        ? { kind, parameterId }
        : undefined
      : kind === 'proportion'
        ? { kind, metric }
        : kind === 'spring'
          ? springId
            ? { kind, featureId: springId, quantity }
            : undefined
          : kind === 'tolerance-stack'
            ? stack
              ? { kind, stackId: stack.id, value: stackValue }
              : undefined
            : kind === 'distance'
              ? a.length && b.length && !a.some((id) => b.includes(id))
                ? { kind, a, b }
                : undefined
              : kind === 'extent'
                ? a.length
                  ? { kind, bodyIds: a, axis }
                  : undefined
                : kind === 'mass'
                  ? a.length
                    ? { kind, bodyIds: a }
                    : { kind }
                  : a.length && (kind === 'volume' || kind === 'area')
                    ? { kind, bodyIds: a }
                    : undefined;
  const bandOk =
    (lo !== undefined || hi !== undefined) &&
    (lo === undefined || Number.isFinite(lo)) &&
    (hi === undefined || Number.isFinite(hi)) &&
    (lo === undefined || hi === undefined || lo <= hi);
  const ready = !!label.trim() && !!measure && bandOk;
  const bodies = (title: string, value: string[], set: (v: string[]) => void) => (
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
    <div className="cad-forms" role="group" aria-label="Add design target">
      <label className="ep-field">
        Target name
        <input value={label} onChange={(e) => setLabel(e.target.value)} />
      </label>
      <label className="ep-field">
        Requirement ID
        <input
          value={requirement}
          placeholder="optional, e.g. RQ-04"
          onChange={(e) => setRequirement(e.target.value)}
        />
      </label>
      <label className="ep-field">
        Measure
        <select value={kind} onChange={(e) => setKind(e.target.value as CadDesignMeasureKind)}>
          {(Object.keys(kindLabel) as CadDesignMeasureKind[])
            .filter((k) => k !== 'tolerance-stack' || !!doc.toleranceStacks?.length)
            .map((k) => (
              <option key={k} value={k}>
                {kindLabel[k]}
              </option>
            ))}
        </select>
      </label>
      {kind === 'parameter' && (
        <label className="ep-field">
          Parameter
          <select value={parameterId} onChange={(e) => setParameterId(e.target.value)}>
            {doc.parameters.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {kind === 'proportion' && (
        <label className="ep-field">
          Indicator
          <select value={metric} onChange={(e) => setMetric(e.target.value as CadProportionMetric)}>
            {cadProportionMetricIds.map((m) => (
              <option key={m} value={m}>
                {cadProportionMetrics[m].label}
              </option>
            ))}
          </select>
        </label>
      )}
      {kind === 'tolerance-stack' && (
        <>
          <label className="ep-field">
            Stack
            <select value={stack?.id ?? ''} onChange={(e) => setStackId(e.target.value)}>
              {(doc.toleranceStacks ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="ep-field">
            Stack value
            <select
              value={stackValue}
              onChange={(e) => setStackValue(e.target.value as CadDesignStackValue)}
            >
              {cadDesignStackValues.map((v) => (
                <option key={v} value={v}>
                  {stackValueLabel[v]}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {kind === 'spring' && (
        <>
          <label className="ep-field">
            Spring
            <select value={springId} onChange={(e) => setSpring(e.target.value)}>
              {springs.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          <label className="ep-field">
            Value
            <select
              value={quantity}
              onChange={(e) => setQuantity(e.target.value as CadSpringQuantity)}
            >
              {cadSpringQuantities.map((q) => (
                <option key={q} value={q}>
                  {springQuantityLabel[q]}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {kind === 'distance' && (
        <>
          {bodies('From bodies', a, setA)}
          {bodies('To bodies', b, setB)}
        </>
      )}
      {(kind === 'extent' || kind === 'volume' || kind === 'area') && bodies('Bodies', a, setA)}
      {kind === 'mass' && bodies('Bodies (none: the whole document)', a, setA)}
      {kind === 'extent' && (
        <label className="ep-field">
          Axis
          <select value={axis} onChange={(e) => setAxis(e.target.value as CadDesignAxis)}>
            {(['x', 'y', 'z'] as const).map((x) => (
              <option key={x} value={x}>
                {x.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="cad-row">
        <label className="ep-field">
          Min
          <input value={min} inputMode="decimal" onChange={(e) => setMin(e.target.value)} />
        </label>
        <label className="ep-field">
          Max
          <input value={max} inputMode="decimal" onChange={(e) => setMax(e.target.value)} />
        </label>
      </div>
      <button type="button" disabled={!ready} onClick={() => void add()}>
        Add target
      </button>
    </div>
  );
}
