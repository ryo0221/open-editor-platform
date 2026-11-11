/**
 * MR3 interference (docs/cad/mecha-design.md, MR3（干渉の検査）): check the assembly in its
 * current pose or a form's, list the pairs that overlap with a rough depth, show a pair in the
 * view, and allow an intended overlap explicitly (the whole pair, or only near a joint). Parts
 * whose meshes are not at hand are listed unchecked, never reported clear. The check reads the
 * display meshes, so it is as precise as their tessellation, not an exact Boolean.
 */
import { fmtQuantity } from './dimension-fields';
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  cadInterferenceLimits,
  configurationStale,
  expandAssembly,
  interferenceKey,
  type CadDocument,
  type CadInterferenceFinding,
  type CadInterferenceReport,
} from '@editor-platform/cad-core';
import type { CadAssembly } from './assembly';
import { describeCode, type CadSnapshot } from './controller';

/** The check's result for one content and target ('' is the current pose). */
interface Checked {
  content: CadDocument;
  target: string;
  report: CadInterferenceReport;
}
const kindLabel: Record<CadInterferenceFinding['kind'], string> = {
  intersect: '交差',
  contain: '内包',
  unknown: '判定できない',
};
/** Default radius of a joint-sphere allowance (mm). */
const defaultRadiusMm = 20;

function FindingRow({
  assembly,
  doc,
  finding,
  name,
  shown,
  disabled,
  onAllowed,
}: {
  assembly: CadAssembly;
  doc: CadDocument;
  finding: CadInterferenceFinding;
  name: (path: readonly string[]) => string;
  shown: boolean;
  disabled: boolean;
  onAllowed: () => void;
}) {
  const [a, b] = [interferenceKey(finding.a), interferenceKey(finding.b)];
  // Joints that join this pair directly: an allowance can be kept to a sphere around one.
  const joints = doc.joints.filter((j) => {
    const p = interferenceKey(j.parent.componentPath);
    const c = interferenceKey([j.child.componentId]);
    return (p === a && c === b) || (p === b && c === a);
  });
  const [joint, setJoint] = useState(joints[0]?.id ?? '');
  const [radius, setRadius] = useState(String(defaultRadiusMm));
  const r = Number(radius);
  const radiusOk = Number.isFinite(r) && r > 0 && r <= 1e6;
  const label = `${name(finding.a)} と ${name(finding.b)}`;
  const allow = (region: Parameters<CadAssembly['allowInterference']>[2]) =>
    void assembly.allowInterference(finding.a, finding.b, region).then((ok) => {
      if (ok) onAllowed();
    });
  return (
    <li className="cad-form" data-testid="cad-interference-finding" data-kind={finding.kind}>
      <div className="cad-row">
        <strong>{label}</strong>
        <small className="cad-part-state" data-state={finding.kind}>
          {kindLabel[finding.kind]}
        </small>
      </div>
      <small className="cad-muted">
        {finding.kind === 'unknown'
          ? `${name(finding.unknown ?? finding.a)}のmeshに穴があり、中かどうか判定できません。`
          : `深さの目安 ${fmtQuantity(finding.depthMm, 'mm')}`}
      </small>
      <div className="cad-row" role="group" aria-label={`Interference ${label}`}>
        <button
          type="button"
          aria-pressed={shown}
          onClick={() => assembly.highlightInterference(shown ? undefined : [finding.a, finding.b])}
        >
          Show
        </button>
        <button type="button" disabled={disabled} onClick={() => allow({ kind: 'pair' })}>
          Allow pair
        </button>
      </div>
      {joints.length > 0 && (
        <form
          className="cad-row"
          aria-label={`Allow near joint ${label}`}
          onSubmit={(e) => {
            e.preventDefault();
            if (radiusOk && joint) allow({ kind: 'joint-sphere', joint, radiusMm: r });
          }}
        >
          <select aria-label="Joint" value={joint} onChange={(e) => setJoint(e.target.value)}>
            {joints.map((j) => (
              <option key={j.id} value={j.id}>
                {j.name}
              </option>
            ))}
          </select>
          <input
            aria-label="Radius (mm)"
            inputMode="decimal"
            value={radius}
            onChange={(e) => setRadius(e.target.value)}
          />
          <button type="submit" disabled={disabled || !radiusOk}>
            Allow near joint
          </button>
        </form>
      )}
    </li>
  );
}

export function InterferenceSection({
  assembly,
  snapshot,
}: {
  assembly: CadAssembly;
  snapshot: CadSnapshot;
}) {
  const parts = useSyncExternalStore(assembly.subscribe, assembly.getSnapshot);
  const doc = snapshot.content;
  const forms = doc.configurations ?? [];
  const [target, setTarget] = useState('');
  const [running, setRunning] = useState(false);
  const [checked, setChecked] = useState<Checked>();
  const [error, setError] = useState<string>();
  const allowances = doc.interferenceAllowances ?? [];
  // A form that is gone or stale cannot be checked: back to the current pose.
  const form = forms.find((f) => f.id === target);
  const formOk = !target || (!!form && !configurationStale(doc, form));
  useEffect(() => {
    if (target && !forms.some((f) => f.id === target)) setTarget('');
  }, [target, forms]);
  // A shown finding is cleared when its result is no longer the content's or is replaced.
  const current = checked && checked.content === doc ? checked : undefined;
  useEffect(() => {
    assembly.highlightInterference(undefined);
  }, [assembly, current]);
  useEffect(() => () => assembly.highlightInterference(undefined), [assembly]);
  if (!doc.components.length) return null;
  // Each occurrence by the names of the components on its path, read from their owners.
  const names = new Map<string, string>();
  const contents = new Map<string, CadDocument | undefined>([[interferenceKey([]), doc]]);
  for (const o of expandAssembly(doc, assembly.lookup).occurrences) {
    const step = o.path.at(-1)!;
    const up = interferenceKey(o.path.slice(0, -1));
    const label = contents.get(up)?.components.find((c) => c.id === step)?.name ?? step;
    const parent = names.get(up);
    names.set(interferenceKey(o.path), parent ? `${parent} / ${label}` : label);
    contents.set(interferenceKey(o.path), o.content);
  }
  const name = (path: readonly string[]) =>
    path.length === 0
      ? 'このassemblyの形状'
      : (names.get(interferenceKey(path)) ?? path.join(' / '));
  const disabled = snapshot.readOnly || snapshot.busy || !!parts.creating;
  const check = (t = target) => {
    setRunning(true);
    setError(undefined);
    void assembly.checkInterference(t || undefined).then((r) => {
      setRunning(false);
      if ('error' in r) setError(r.error);
      else setChecked({ content: r.content, target: t, report: r.report });
    });
  };
  const report = current?.report;
  const shownKey = parts.highlighted
    ? parts.highlighted.map((p) => interferenceKey(p)).join(' ')
    : undefined;
  const staleIds = new Set(report?.status === 'ok' ? report.stale : []);
  const targetName = (t: string) =>
    t ? `形態「${forms.find((f) => f.id === t)?.name ?? t}」の姿勢` : '今の姿勢';
  return (
    <div className="cad-forms" data-testid="cad-interference">
      <h3>Interference</h3>
      <div className="cad-row">
        <select aria-label="Check in" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">今の姿勢</option>
          {forms.map((f) => (
            <option key={f.id} value={f.id} disabled={configurationStale(doc, f)}>
              形態：{f.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={snapshot.busy || !!parts.creating || running || !formOk}
          onClick={() => check()}
        >
          Check interference
        </button>
      </div>
      <p className="cad-muted" role="status" data-testid="cad-interference-status">
        {running
          ? '干渉を調べています…'
          : error
            ? describeCode(error)
            : !checked
              ? '部品の表示用のmeshで調べます（meshの粗さまでの検査です）。'
              : !current
                ? '内容が変わりました。もう一度調べてください。'
                : report!.status === 'refused'
                  ? describeCode(report!.code)
                  : `${targetName(current.target)}：${
                      report!.findings.length
                        ? `${report!.findings.length}組が干渉しています。`
                        : report!.unchecked.length
                          ? '調べた部品の間に干渉はありません。'
                          : '干渉はありません。'
                    }${
                      report!.unchecked.length
                        ? `${report!.unchecked.map(name).join('・')}は形状が無いため調べていません（干渉なしとは言えません）。`
                        : ''
                    }`}
      </p>
      {report?.status === 'ok' && report.findings.length > 0 && (
        <ul aria-label="Interference findings">
          {report.findings.map((f) => {
            const key = `${interferenceKey(f.a)} ${interferenceKey(f.b)}`;
            return (
              <FindingRow
                key={key}
                assembly={assembly}
                doc={doc}
                finding={f}
                name={name}
                shown={shownKey === key}
                disabled={disabled}
                onAllowed={() => check(current!.target)}
              />
            );
          })}
        </ul>
      )}
      {allowances.length > 0 && (
        <>
          <h4>
            Allowed overlaps ({allowances.length}/{cadInterferenceLimits.allowances})
          </h4>
          <ul aria-label="Allowed overlaps">
            {allowances.map((x) => {
              const joint =
                x.region.kind === 'joint-sphere'
                  ? doc.joints.find((j) => j.id === (x.region as { joint: string }).joint)
                  : undefined;
              const stale =
                staleIds.has(x.id) ||
                (x.a.length > 0 && !names.has(interferenceKey(x.a))) ||
                (x.b.length > 0 && !names.has(interferenceKey(x.b))) ||
                (x.region.kind === 'joint-sphere' && !joint);
              return (
                <li key={x.id} className="cad-form" data-testid="cad-interference-allowance">
                  <div className="cad-row">
                    <span>
                      {name(x.a)} と {name(x.b)}
                      <small className="cad-muted">
                        {' '}
                        {x.region.kind === 'pair'
                          ? '組全体'
                          : `${joint?.name ?? x.region.joint}の周り 半径${x.region.radiusMm} mm`}
                      </small>
                    </span>
                    {stale && (
                      <small
                        className="cad-part-state"
                        data-state="stale"
                        title="もう無い部品かjointを指しているため、使っていません。"
                      >
                        古い許容
                      </small>
                    )}
                    {!snapshot.readOnly && (
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => void assembly.removeInterferenceAllowance(x.id)}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
