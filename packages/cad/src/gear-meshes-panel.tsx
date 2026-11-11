/**
 * WM2 (docs/cad/watch-design.md, かみ合い): the assembly's gear meshes. Mesh two gears (each a
 * `spurGear` of the part a revolute joint turns) as one edit, see each mesh's problems where the
 * joints solve, mesh it again after its teeth changed, or remove it (the driven joint keeps its
 * angle). The gear train lists how many turns each joint makes for one turn of another, and the
 * time of one turn from that joint's.
 */
import { useState } from 'react';
import {
  cadLimits,
  gearTrainRatios,
  meshCoupling,
  type CadDocument,
  type CadGearMeshProblem,
} from '@editor-platform/cad-core';
import type { CadAssembly } from './assembly';
import { describeGearMeshProblem } from './assembly-messages';
import type { CadSnapshot } from './controller';

const fmt = (n: number, digits = 3) =>
  n !== 0 && Math.abs(n) < 0.5 * 10 ** -digits
    ? n.toPrecision(digits)
    : String(Math.round(n * 10 ** digits) / 10 ** digits);
/** Cuts a generated name to the native name limit, by code points. */
const boundedName = (s: string) => [...s].slice(0, cadLimits.nameCodePoints).join('');

/** The `spurGear` features of the part version a joint turns, with their teeth. */
function gearsOf(doc: CadDocument, assembly: CadAssembly, jointId: string) {
  const joint = doc.joints.find((j) => j.id === jointId);
  const component = joint && doc.components.find((c) => c.id === joint.child.componentId);
  const part = component && doc.parts.find((p) => p.id === component.partId);
  const content = part && assembly.lookup(part.source.contentHash);
  return (content?.features ?? []).flatMap((f) =>
    f.type === 'spurGear' ? [{ id: f.id, label: f.name }] : [],
  );
}

function AddGearMesh({
  assembly,
  doc,
  disabled,
}: {
  assembly: CadAssembly;
  doc: CadDocument;
  disabled: boolean;
}) {
  const revolute = doc.joints.filter((j) => j.type === 'revolute');
  const [driverPick, setDriver] = useState(revolute[0]?.id ?? '');
  const [drivenPick, setDriven] = useState(revolute[1]?.id ?? '');
  const [driverGear, setDriverGear] = useState('');
  const [drivenGear, setDrivenGear] = useState('');
  if (revolute.length < 2) return null;
  // A picked joint that was removed gives way to a remaining one, other than the other side's.
  const kept = (id: string) => revolute.some((j) => j.id === id);
  const driver = kept(driverPick)
    ? driverPick
    : (revolute.find((j) => j.id !== drivenPick)?.id ?? revolute[0]!.id);
  const driven = kept(drivenPick)
    ? drivenPick
    : (revolute.find((j) => j.id !== driver)?.id ?? revolute[1]!.id);
  const a = gearsOf(doc, assembly, driver);
  const b = gearsOf(doc, assembly, driven);
  const ga = a.some((g) => g.id === driverGear) ? driverGear : (a[0]?.id ?? '');
  const gb = b.some((g) => g.id === drivenGear) ? drivenGear : (b[0]?.id ?? '');
  const name = (id: string) => doc.joints.find((j) => j.id === id)?.name ?? id;
  const valid = !!ga && !!gb && driver !== driven;
  const jointSelect = (label: string, value: string, set: (v: string) => void) => (
    <label>
      <span>{label}</span>
      <select value={value} disabled={disabled} onChange={(e) => set(e.target.value)}>
        {revolute.map((j) => (
          <option key={j.id} value={j.id}>
            {j.name}
          </option>
        ))}
      </select>
    </label>
  );
  const gearSelect = (
    label: string,
    gears: { id: string; label: string }[],
    value: string,
    set: (v: string) => void,
  ) => (
    <label>
      <span>{label}</span>
      <select
        value={value}
        disabled={disabled || !gears.length}
        onChange={(e) => set(e.target.value)}
      >
        {gears.map((g) => (
          <option key={g.id} value={g.id}>
            {g.label}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <form
      className="cad-placement cad-joint-values"
      aria-label="Add gear mesh"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid)
          void assembly.insertGearMesh({
            name: boundedName(`${name(driver)} → ${name(driven)}`),
            driver: { joint: driver, feature: ga },
            driven: { joint: driven, feature: gb },
          });
      }}
    >
      {jointSelect('Driver joint', driver, setDriver)}
      {gearSelect('Driver gear', a, ga, setDriverGear)}
      {jointSelect('Driven joint', driven, setDriven)}
      {gearSelect('Driven gear', b, gb, setDrivenGear)}
      {(!a.length || !b.length) && (
        <p className="cad-muted">jointの子の部品に歯車（spurGear）がありません。</p>
      )}
      <button type="submit" disabled={disabled || !valid}>
        Mesh gears
      </button>
    </form>
  );
}

function GearTrain({ doc }: { doc: CadDocument }) {
  const drivers = [...new Set((doc.gearMeshes ?? []).map((m) => m.driver.joint))];
  const [from, setFrom] = useState(drivers[0] ?? '');
  const [period, setPeriod] = useState('3600');
  const joints = doc.joints.filter((j) => j.type === 'revolute');
  const start = joints.some((j) => j.id === from) ? from : (drivers[0] ?? '');
  if (!start) return null;
  const rows = gearTrainRatios(doc, start);
  const seconds = Number(period);
  const name = (id: string) => doc.joints.find((j) => j.id === id)?.name ?? id;
  return (
    <div className="cad-placement cad-joint-values" data-testid="cad-gear-train">
      <h4>Gear train</h4>
      <label>
        <span>From</span>
        <select value={start} onChange={(e) => setFrom(e.target.value)}>
          {joints.map((j) => (
            <option key={j.id} value={j.id}>
              {j.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Seconds per turn</span>
        <input inputMode="decimal" value={period} onChange={(e) => setPeriod(e.target.value)} />
      </label>
      <ul aria-label="Gear train">
        {rows.map((r) => (
          <li
            key={`${r.joint}:${r.of}`}
            data-testid="cad-gear-train-row"
            data-joint={r.joint}
            data-of={r.of}
          >
            {name(r.joint)}
            {r.of === 'angle' ? '' : `（${r.of}）`}：×{fmt(r.ratio)}
            {Number.isFinite(seconds) && seconds > 0
              ? `（1回転 ${fmt(seconds / Math.abs(r.ratio))} 秒、${r.ratio < 0 ? '逆回り' : '同じ向き'}）`
              : ''}
          </li>
        ))}
        {!rows.length && <li className="cad-muted">このjointに従うjointはありません。</li>}
      </ul>
    </div>
  );
}

export function GearMeshesSection({
  assembly,
  snapshot,
  problems,
  paused = false,
}: {
  assembly: CadAssembly;
  snapshot: CadSnapshot;
  /** Each mesh's problems where the joints solve, when evaluated. */
  problems: Record<string, CadGearMeshProblem[]> | undefined;
  paused?: boolean;
}) {
  const doc: CadDocument = snapshot.content;
  const meshes = doc.gearMeshes ?? [];
  const disabled = snapshot.readOnly || snapshot.busy || paused;
  if (doc.joints.filter((j) => j.type === 'revolute').length < 2) return null;
  const jointName = (id: string) => doc.joints.find((j) => j.id === id)?.name ?? id;
  return (
    <div className="cad-forms" data-testid="cad-gear-meshes">
      <h3>Gear meshes ({meshes.length})</h3>
      <ul aria-label="Gear meshes">
        {meshes.map((m) => {
          const listed = problems?.[m.id] ?? [];
          const coupling = meshCoupling(doc, m);
          return (
            <li key={m.id} className="cad-form" data-testid="cad-gear-mesh" data-mesh={m.id}>
              <div className="cad-row">
                <strong>{m.name}</strong>
                <small className="cad-muted">
                  {' '}
                  {jointName(m.driver.joint)} → {jointName(m.driven.joint)}
                  {coupling ? `・比 ${fmt(coupling.ratio, 4)}` : ''}
                </small>
              </div>
              {listed.map((p, i) => (
                <p key={i} className="cad-diagnostic" role="note">
                  {describeGearMeshProblem(p)}
                </p>
              ))}
              {!snapshot.readOnly && (
                <div className="cad-row">
                  {listed.some(
                    (p) => p.code === 'gear-mesh-ratio' || p.code === 'gear-mesh-phase',
                  ) && (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => void assembly.updateGearMesh(m.id)}
                    >
                      Mesh again
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => void assembly.removeGearMesh(m.id)}
                  >
                    Remove mesh
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {!snapshot.readOnly && <AddGearMesh assembly={assembly} doc={doc} disabled={disabled} />}
      {meshes.length > 0 && <GearTrain doc={doc} />}
    </div>
  );
}
