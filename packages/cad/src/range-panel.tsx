/**
 * CR7c (docs/cad/car-design.md, CR7c, A2): the interference through one joint value's range
 * (2–64 steps between its limits, the first value that overlaps and its pairs) and the clearance
 * between two components (the shortest distance between their display meshes and the two points
 * it runs between, now or at one joint value). Both read the display meshes, so they are as
 * precise as their tessellation. Neither changes the document.
 */
import { useState, useSyncExternalStore } from 'react';
import {
  cadCoverageLimits,
  cadRangeLimits,
  expandAssembly,
  inactiveJointIds,
  interferenceKey,
  ownJointValueKeys,
  type CadClearanceReport,
  type CadCoverageReport,
  type CadDocument,
  type CadJointValueKey,
  type CadSweepReport,
} from '@editor-platform/cad-core';
import type { CadAssembly } from './assembly';
import { describeCode, type CadSnapshot } from './controller';
import { fmtGrouped } from './dimension-fields';
import { stepName } from './joint-authoring';

/** Select values are whole paths in JSON, so this document's own bodies (`[]`) never collide with a component id. */
const ownValue = JSON.stringify([]);
const valueOf = (id: string) => JSON.stringify([id]);
const pathOf = (v: string) => JSON.parse(v) as string[];
const isAngle = (of: CadJointValueKey) => of.startsWith('angle');
const valueText = (of: CadJointValueKey, v: number) =>
  isAngle(of) ? `${fmtGrouped((v * 180) / Math.PI, 1)}°` : `${fmtGrouped(v, 1)} mm`;
const point = (p: readonly number[]) => `(${p.map((v) => fmtGrouped(v, 1)).join(', ')}) mm`;
/** The joint values that can be stepped: own (not coupled), with limits. */
const rangeKeys = (doc: CadDocument, jointId: string) => {
  const joint = doc.joints.find((j) => j.id === jointId);
  // An inactive mount candidate (MR7) does not move anything.
  if (!joint || inactiveJointIds(doc).has(jointId)) return [];
  return ownJointValueKeys(joint).filter((k) =>
    joint.limits.some((l) => l.of === k && l.max > l.min),
  );
};

interface RangeRun {
  content: CadDocument;
  joint: string;
  of: CadJointValueKey;
  values: number[];
  report: CadSweepReport;
}
interface CoverageRun {
  content: CadDocument;
  joint: string;
  of: CadJointValueKey;
  report: CadCoverageReport;
}
interface ClearanceRun {
  content: CadDocument;
  a: string;
  b: string;
  at?: string;
  report: CadClearanceReport;
}

export function RangeSection({
  assembly,
  snapshot,
}: {
  assembly: CadAssembly;
  snapshot: CadSnapshot;
}) {
  const parts = useSyncExternalStore(assembly.subscribe, assembly.getSnapshot);
  const doc = snapshot.content;
  const rangeJoints = doc.joints.filter((j) => rangeKeys(doc, j.id).length > 0);
  const [joint, setJoint] = useState('');
  const [of, setOf] = useState<CadJointValueKey | ''>('');
  const [steps, setSteps] = useState('16');
  const [range, setRange] = useState<RangeRun>();
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [atJoint, setAtJoint] = useState('');
  const [atOf, setAtOf] = useState<CadJointValueKey | ''>('');
  const [atValue, setAtValue] = useState('0');
  const [clearance, setClearance] = useState<ClearanceRun>();
  const [motionJoint, setMotionJoint] = useState('');
  const [motionOf, setMotionOf] = useState<CadJointValueKey | ''>('');
  const [motionFrom, setMotionFrom] = useState('');
  const [motionTo, setMotionTo] = useState('');
  const [stepMm, setStepMm] = useState(String(cadCoverageLimits.defaultStepMm));
  const [stepDeg, setStepDeg] = useState(
    String((cadCoverageLimits.defaultStepRad * 180) / Math.PI),
  );
  const [coverage, setCoverage] = useState<CoverageRun>();
  const [running, setRunning] = useState<'range' | 'coverage' | 'clearance'>();
  const [error, setError] = useState<{ of: 'range' | 'coverage' | 'clearance'; code: string }>();
  if (!doc.components.length) return null;
  // Each direct component and pattern copy (first path steps), and each occurrence's name.
  const occurrences = expandAssembly(doc, assembly.lookup).occurrences;
  const steps0 = [...new Set(occurrences.map((o) => o.path[0]!))].map((id) => ({
    id,
    name: stepName(doc, id) ?? id,
  }));
  const names = new Map<string, string>();
  const contents = new Map<string, CadDocument | undefined>([[interferenceKey([]), doc]]);
  for (const o of occurrences) {
    const step = o.path.at(-1)!;
    const up = interferenceKey(o.path.slice(0, -1));
    const label =
      o.path.length === 1
        ? (stepName(doc, step) ?? step)
        : (contents.get(up)?.components.find((c) => c.id === step)?.name ?? step);
    const parent = names.get(up);
    names.set(interferenceKey(o.path), parent ? `${parent} / ${label}` : label);
    contents.set(interferenceKey(o.path), o.content);
  }
  const name = (path: readonly string[]) =>
    path.length === 0
      ? 'このassemblyの形状'
      : (names.get(interferenceKey(path)) ?? path.join(' / '));
  const busy = snapshot.busy || !!parts.creating || running !== undefined;
  const jointId =
    joint && rangeJoints.some((j) => j.id === joint) ? joint : (rangeJoints[0]?.id ?? '');
  const keys = jointId ? rangeKeys(doc, jointId) : [];
  const key = of && keys.includes(of) ? of : keys[0];
  const jointName = (id: string) => doc.joints.find((j) => j.id === id)?.name ?? id;

  const checkRange = () => {
    if (!jointId || !key) return;
    setRunning('range');
    setError(undefined);
    void assembly.checkJointRange(jointId, key, Number(steps)).then((r) => {
      setRunning(undefined);
      if ('error' in r) setError({ of: 'range', code: r.error });
      else setRange({ ...r, joint: jointId, of: key });
    });
  };
  // Only a joint's own values (a coupled one follows its driver).
  const off = inactiveJointIds(doc);
  const atJoints = doc.joints.filter((j) => !off.has(j.id) && ownJointValueKeys(j).length > 0);
  // PD6: any own value of a joint in effect, from and to typed (a limit's ends by default).
  const motionJointOf = atJoints.find((j) => j.id === motionJoint) ?? atJoints[0];
  const motionKeys = motionJointOf ? ownJointValueKeys(motionJointOf) : [];
  const motionKey = motionOf && motionKeys.includes(motionOf) ? motionOf : motionKeys[0];
  const motionLimit = motionJointOf?.limits.find((l) => l.of === motionKey);
  const shown = (v: number) =>
    String(Math.round((motionKey && isAngle(motionKey) ? (v * 180) / Math.PI : v) * 1e6) / 1e6);
  const fromText = motionFrom || (motionLimit ? shown(motionLimit.min) : '0');
  const toText =
    motionTo ||
    (motionLimit ? shown(motionLimit.max) : motionKey && isAngle(motionKey) ? '360' : '100');
  const checkCoverage = () => {
    if (!motionJointOf || !motionKey) return;
    const unit = isAngle(motionKey) ? Math.PI / 180 : 1;
    const driver = {
      joint: motionJointOf.id,
      of: motionKey,
      from: Number(fromText) * unit,
      to: Number(toText) * unit,
    };
    const bounds = { stepMm: Number(stepMm), stepRad: (Number(stepDeg) * Math.PI) / 180 };
    setRunning('coverage');
    setError(undefined);
    void assembly.checkMotionCoverage(driver, bounds).then((r) => {
      setRunning(undefined);
      if ('error' in r) setError({ of: 'coverage', code: r.error });
      else setCoverage({ ...r, joint: driver.joint, of: motionKey });
    });
  };
  const coverageNow = coverage && coverage.content === doc ? coverage : undefined;
  const cv = coverageNow?.report;
  const cvFirst = cv?.status === 'ok' ? cv.hits[0] : undefined;
  const deg = (rad: number) => `${fmtGrouped((rad * 180) / Math.PI, 2)}°`;
  const coverageText = (run: CoverageRun, r: Extract<CadCoverageReport, { status: 'ok' }>) => {
    const span = `${jointName(run.joint)}（${valueText(run.of, r.driver.from)}〜${valueText(run.of, r.driver.to)}）`;
    const moves = r.parts
      .map(
        (p) =>
          `${name(p.path)} ${p.stepMm === undefined ? '—' : `${fmtGrouped(p.stepMm, 2)} mm`}・${deg(p.stepRad)}`,
      )
      .join('、');
    const at = (tick: number) => valueText(run.of, r.values[tick]!);
    return `${span}：${fmtGrouped(r.steps, 0)}刻み（${fmtGrouped(r.values.length, 0)}姿勢）。1刻みで動く最大：${moves || '動く部品はありません'}。${
      cvFirst
        ? `${at(cvFirst.tick)}で初めて干渉します。干渉する姿勢 ${fmtGrouped(r.hits.length, 0)}/${fmtGrouped(r.values.length, 0)}。`
        : r.unchecked.length
          ? '調べた部品の間に干渉はありません。'
          : '干渉はありません。'
    }${
      r.unmeasured.length
        ? `${r.unmeasured.map(name).join('・')}は形状が無いため、jointの刻みだけで見ています。`
        : ''
    }${r.unchecked.length ? `${r.unchecked.map(name).join('・')}は形状が無いため調べていません。` : ''}`;
  };
  const atJointOf = atJoints.find((j) => j.id === atJoint);
  const atKeys = atJointOf ? ownJointValueKeys(atJointOf) : [];
  const atKey = atOf && atKeys.includes(atOf) ? atOf : atKeys[0];
  const measure = () => {
    if (!a || !b) return setError({ of: 'clearance', code: 'clearance-target' });
    setRunning('clearance');
    setError(undefined);
    const raw = Number(atValue);
    const values =
      atJointOf && atKey && Number.isFinite(raw)
        ? { [atJoint]: { [atKey]: isAngle(atKey) ? (raw * Math.PI) / 180 : raw } }
        : undefined;
    void assembly.measureClearance(pathOf(a), pathOf(b), values).then((r) => {
      setRunning(undefined);
      if ('error' in r) return setError({ of: 'clearance', code: r.error });
      setClearance({
        content: r.content,
        a,
        b,
        ...(values
          ? { at: `${jointName(atJoint)} ${valueText(atKey!, values[atJoint]![atKey!]!)}` }
          : {}),
        report: r.report,
      });
      if (r.report.status === 'ok') assembly.highlightInterference([pathOf(a), pathOf(b)]);
    });
  };
  const rangeNow = range && range.content === doc ? range : undefined;
  const clearanceNow = clearance && clearance.content === doc ? clearance : undefined;
  const r = rangeNow?.report;
  const first = r?.status === 'ok' ? r.hits[0] : undefined;
  const c = clearanceNow?.report;
  return (
    <div className="cad-forms" data-testid="cad-range">
      <h3>Through a joint’s range</h3>
      {rangeJoints.length === 0 ? (
        <p className="cad-muted">範囲（最小・最大）のあるjointがありません。</p>
      ) : (
        <>
          <div className="cad-row">
            <label className="ep-field">
              Joint
              <select value={jointId} onChange={(e) => setJoint(e.target.value)}>
                {rangeJoints.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.name}
                  </option>
                ))}
              </select>
            </label>
            {keys.length > 1 && (
              <label className="ep-field">
                Value
                <select value={key} onChange={(e) => setOf(e.target.value as CadJointValueKey)}>
                  {keys.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="ep-field">
              Steps
              <input
                type="number"
                min={cadRangeLimits.minSteps}
                max={cadRangeLimits.maxSteps}
                value={steps}
                onChange={(e) => setSteps(e.target.value)}
              />
            </label>
            <button type="button" disabled={busy} onClick={checkRange}>
              Check through the range
            </button>
          </div>
          <p className="cad-muted" role="status" data-testid="cad-range-status">
            {running === 'range'
              ? '範囲を動かして干渉を調べています…'
              : error?.of === 'range'
                ? describeCode(error.code)
                : !range
                  ? 'jointの値を範囲の端から端まで刻んで、各刻みで干渉を調べます（刻みの間の干渉は見落とすことがあります）。'
                  : !rangeNow
                    ? '内容が変わりました。もう一度調べてください。'
                    : r!.status === 'refused'
                      ? describeCode(r!.code)
                      : `${jointName(rangeNow.joint)}（${valueText(rangeNow.of, rangeNow.values[0]!)}〜${valueText(
                          rangeNow.of,
                          rangeNow.values.at(-1)!,
                        )}、${rangeNow.values.length}刻み）：${
                          first
                            ? `${valueText(rangeNow.of, rangeNow.values[first.tick]!)}で初めて干渉します。干渉する刻み ${r!.hits.length}/${rangeNow.values.length}。`
                            : '干渉はありません。'
                        }${
                          r!.unchecked.length
                            ? `${r!.unchecked.map(name).join('・')}は形状が無いため調べていません。`
                            : ''
                        }`}
          </p>
          {first && (
            <ul aria-label="First overlap in the range">
              {first.findings.map((f) => (
                <li key={`${interferenceKey(f.a)} ${interferenceKey(f.b)}`}>
                  {name(f.a)} と {name(f.b)}
                  <small className="cad-muted"> 深さ約{fmtGrouped(f.depthMm, 1)} mm</small>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {atJoints.length > 0 && (
        <>
          <h3>Through a motion with step bounds</h3>
          <div className="cad-row">
            <label className="ep-field">
              Motion joint
              <select
                value={motionJointOf?.id ?? ''}
                onChange={(e) => {
                  setMotionJoint(e.target.value);
                  setMotionFrom('');
                  setMotionTo('');
                }}
              >
                {atJoints.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.name}
                  </option>
                ))}
              </select>
            </label>
            {motionKeys.length > 1 && (
              <label className="ep-field">
                Motion value
                <select
                  value={motionKey}
                  onChange={(e) => {
                    setMotionOf(e.target.value as CadJointValueKey);
                    setMotionFrom('');
                    setMotionTo('');
                  }}
                >
                  {motionKeys.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {motionKey && (
              <>
                <label className="ep-field">
                  {isAngle(motionKey) ? 'From (°)' : 'From (mm)'}
                  <input
                    type="number"
                    value={fromText}
                    onChange={(e) => setMotionFrom(e.target.value)}
                  />
                </label>
                <label className="ep-field">
                  {isAngle(motionKey) ? 'To (°)' : 'To (mm)'}
                  <input
                    type="number"
                    value={toText}
                    onChange={(e) => setMotionTo(e.target.value)}
                  />
                </label>
              </>
            )}
            <label className="ep-field">
              Max step (mm)
              <input
                type="number"
                min={cadCoverageLimits.minStepMm}
                value={stepMm}
                onChange={(e) => setStepMm(e.target.value)}
              />
            </label>
            <label className="ep-field">
              Max turn (°)
              <input type="number" value={stepDeg} onChange={(e) => setStepDeg(e.target.value)} />
            </label>
            <button type="button" disabled={busy} onClick={checkCoverage}>
              Check through the motion
            </button>
          </div>
          <p className="cad-muted" role="status" data-testid="cad-coverage-status">
            {running === 'coverage'
              ? '刻みの上限を守って動かし、干渉を調べています…'
              : error?.of === 'coverage'
                ? describeCode(error.code)
                : !coverage
                  ? `jointの値を動かし、どの部品も1刻みで最大の移動（mm）と回転（°）を超えないように刻みを決めて干渉を調べます。連動する部品の速さも含めます（姿勢は${fmtGrouped(cadCoverageLimits.samples, 0)}まで）。`
                  : !coverageNow
                    ? '内容が変わりました。もう一度調べてください。'
                    : cv!.status === 'refused'
                      ? `${describeCode(cv!.code)}${
                          cv!.needed ? `（必要な姿勢 ${fmtGrouped(cv!.needed, 0)}）` : ''
                        }`
                      : coverageText(coverageNow, cv!)}
          </p>
          {cvFirst && (
            <ul aria-label="First overlap in the motion">
              {cvFirst.findings.map((f) => (
                <li key={`${interferenceKey(f.a)} ${interferenceKey(f.b)}`}>
                  {name(f.a)} と {name(f.b)}
                  <small className="cad-muted"> 深さ約{fmtGrouped(f.depthMm, 1)} mm</small>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <h3>Clearance</h3>
      <div className="cad-row">
        {(
          [
            ['Clearance from', a, setA],
            ['Clearance to', b, setB],
          ] as const
        ).map(([label, value, set]) => (
          <label key={label} className="ep-field">
            {label}
            <select value={value} onChange={(e) => set(e.target.value)}>
              <option value="">—</option>
              {doc.bodies.some((x) => x.state === 'active') && (
                <option value={ownValue}>このassemblyの形状</option>
              )}
              {steps0.map((s) => (
                <option key={s.id} value={valueOf(s.id)}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <div className="cad-row">
        <label className="ep-field">
          At joint
          <select value={atJoint} onChange={(e) => setAtJoint(e.target.value)}>
            <option value="">今の姿勢</option>
            {atJoints.map((j) => (
              <option key={j.id} value={j.id}>
                {j.name}
              </option>
            ))}
          </select>
        </label>
        {atKeys.length > 1 && (
          <label className="ep-field">
            At value
            <select value={atKey} onChange={(e) => setAtOf(e.target.value as CadJointValueKey)}>
              {atKeys.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
        )}
        {atKey && (
          <label className="ep-field">
            {isAngle(atKey) ? 'At angle (°)' : 'At distance (mm)'}
            <input type="number" value={atValue} onChange={(e) => setAtValue(e.target.value)} />
          </label>
        )}
        <button type="button" disabled={busy} onClick={measure}>
          Measure clearance
        </button>
      </div>
      <p className="cad-muted" role="status" data-testid="cad-clearance-status">
        {running === 'clearance'
          ? 'すき間を測っています…'
          : error?.of === 'clearance'
            ? describeCode(error.code)
            : !clearance
              ? '2つの部品の表示用のmeshの間の最短距離を測ります（meshの粗さまでの値です）。'
              : !clearanceNow
                ? '内容が変わりました。もう一度測ってください。'
                : c!.status === 'refused'
                  ? `${describeCode(c!.code)}${
                      c!.missing?.length ? `（${c!.missing.map(name).join('・')}）` : ''
                    }`
                  : `${clearanceNow.at ? `${clearanceNow.at}で、` : ''}${name(pathOf(clearanceNow.a))}と${name(pathOf(clearanceNow.b))}の最短距離 ${fmtGrouped(c!.distanceMm, 1)} mm${
                      c!.distanceMm === 0 ? '（接しているか干渉しています）' : ''
                    }。${name(pathOf(clearanceNow.a))}側 ${point(c!.a)}、${name(pathOf(clearanceNow.b))}側 ${point(c!.b)}。`}
      </p>
    </div>
  );
}
