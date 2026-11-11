/**
 * R2b-2 Surface entries (docs/cad/r2b-assembly.md, Surface): the joint list with how each solved,
 * a joint's values (Inspector, and while its drag is under way), making a joint (R2b-2c), and
 * adopting solved poses after stored ones did not match.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  cadJointValueKeys,
  isJointAngleKey,
  ownJointValueKeys,
  type CadDocument,
  type CadJointValueKey,
  type CadJoint,
  type CadJointSolution,
} from '@editor-platform/cad-core';
import { entryDraftKey, entryStored, type CadAssembly } from './assembly';
import { stepName } from './joint-authoring';
import { describeCode, type CadSnapshot } from './controller';
import { FormsSection } from './forms-panel';
import { MountsSection } from './mounts-panel';
import { GearMeshesSection } from './gear-meshes-panel';
import { JointCreator, jointTypeLabel } from './joint-create-panel';
import {
  jointFieldValue,
  jointFields,
  jointValueBound,
  jointValueLabels,
  limitText,
  validJointFields,
} from './joint-values';

const solutionLabel = (s: CadJointSolution | undefined) =>
  !s
    ? '計算中'
    : s.status === 'broken'
      ? '接続点が壊れています'
      : s.status === 'unavailable'
        ? '参照できません'
        : '';

function JointFields({
  assembly,
  snapshot,
  joint,
  readOnly,
}: {
  assembly: CadAssembly;
  snapshot: CadSnapshot;
  joint: CadJoint;
  readOnly: boolean;
}) {
  const keys = ownJointValueKeys(joint);
  const stored = JSON.stringify(jointFields(joint, snapshot.content));
  const initial = useMemo(() => JSON.parse(stored) as string[], [stored]);
  const { jointDrafts, dragging } = useSyncExternalStore(assembly.subscribe, assembly.getSnapshot);
  const draft = jointDrafts.get(joint.id);
  // The fields last applied, shown until the stored values catch up with them.
  const [applying, setApplying] = useState<string[]>();
  useEffect(() => setApplying(undefined), [initial]);
  // While the joint is dragged in the viewport, its fields follow the pointer.
  const dragged =
    dragging?.jointId === joint.id
      ? keys.map((k, i) => {
          const v = dragging.values[k];
          if (v === undefined) return initial[i]!;
          return String(Math.round((isJointAngleKey(k) ? (v * 180) / Math.PI : v) * 1000) / 1000);
        })
      : undefined;
  const fields = dragged ?? draft?.fields ?? applying ?? initial;
  const valid = validJointFields(joint, fields);
  // MR1: a value that follows another joint is shown, not typed.
  const followed = (joint.couplings ?? []).map((c) => {
    const unit = isJointAngleKey(c.of) ? 180 / Math.PI : 1;
    const offset = Math.round(c.offset * unit * 1000) / 1000;
    const from = snapshot.content.joints.find((j) => j.id === c.from.joint)?.name ?? c.from.joint;
    return (
      <p key={c.of} className="cad-muted">
        {jointValueLabels[c.of]} = {c.ratio} × {from} {jointValueLabels[c.from.of]}
        {offset ? ` ${offset > 0 ? '+' : '−'} ${Math.abs(offset)}` : ''}（連動）
      </p>
    );
  });
  if (!keys.length)
    return followed.length ? (
      <>{followed}</>
    ) : (
      <p className="cad-muted">固定のjointには値がありません。</p>
    );
  const apply = () => {
    const attempt = fields;
    setApplying(attempt);
    void assembly.applyJointDraft(joint.id).then((ok) => {
      if (!ok) setApplying((current) => (current === attempt ? undefined : current));
    });
  };
  return (
    <form
      className="cad-placement cad-joint-values"
      aria-label="Joint values"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) apply();
      }}
    >
      {keys.map((key, i) => {
        const bound = jointValueBound(joint, key);
        const limit = limitText(joint, key);
        return (
          <label key={key}>
            <span>{jointValueLabels[key]}</span>
            <input
              inputMode="decimal"
              value={fields[i] ?? ''}
              disabled={readOnly || bound}
              title={
                bound ? 'parameterまたは式で決まる値です。parameterで変更してください。' : undefined
              }
              onChange={(e) =>
                assembly.setJointDraft(joint.id, {
                  fields: fields.map((v, j) => (j === i ? e.target.value : v)),
                  shown: draft?.shown ?? initial,
                })
              }
            />
            {limit && <small className="cad-muted">範囲 {limit}</small>}
          </label>
        );
      })}
      {followed}
      {!readOnly && (
        <button type="submit" disabled={!valid || !draft}>
          Apply values
        </button>
      )}
    </form>
  );
}

/**
 * WM2: a revolute joint that turns any number of times (a watch wheel), as one edit. A joint with
 * a range keeps one turn until the range is cleared.
 */
function JointContinuous({
  assembly,
  joint,
  readOnly,
}: {
  assembly: CadAssembly;
  joint: CadJoint;
  readOnly: boolean;
}) {
  if (joint.type !== 'revolute') return null;
  const ranged = joint.limits.length > 0;
  return (
    <div className="cad-placement cad-joint-values">
      <label>
        <input
          type="checkbox"
          checked={!!joint.continuous}
          disabled={readOnly || (ranged && !joint.continuous)}
          onChange={(e) => void assembly.setJointContinuous(joint.id, e.target.checked)}
        />
        <span>Turns continuously</span>
      </label>
      {ranged && !joint.continuous && !readOnly && (
        <small className="cad-muted">範囲を外すと、何回転も回せるjointにできます。</small>
      )}
    </div>
  );
}

/**
 * CR3e-2: a value's range (degrees for an angle, mm otherwise): a door opens 0–70°. Applied and
 * cleared as one edit each; a range the current value lies outside is refused. MR1: every value
 * of the type, a value that follows another joint too.
 */
function JointLimits({
  assembly,
  joint,
  readOnly,
}: {
  assembly: CadAssembly;
  joint: CadJoint;
  readOnly: boolean;
}) {
  const keys = cadJointValueKeys[joint.type];
  const [key, setKey] = useState(keys[0]);
  const scale = key && isJointAngleKey(key) ? 180 / Math.PI : 1;
  const stored = joint.limits.find((l) => l.of === key);
  const shown = stored
    ? [
        String(Math.round(stored.min * scale * 1000) / 1000),
        String(Math.round(stored.max * scale * 1000) / 1000),
      ]
    : ['', ''];
  // What was typed is kept by the assembly, per joint and value, until it is applied, reset or
  // what it was typed over changes: a refused edit, another value or joint keeps it.
  const { entryDrafts } = useSyncExternalStore(assembly.subscribe, assembly.getSnapshot);
  const draftKey = key && entryDraftKey('range', joint.id, key);
  const fields = draftKey ? entryDrafts.get(draftKey)?.fields : undefined;
  const setFields = (next: string[] | undefined) => {
    if (draftKey)
      assembly.setEntryDraft(
        draftKey,
        next && { fields: next, shown, stored: entryStored(joint, draftKey) },
      );
  };
  const edited = !!fields;
  const pending = (k: CadJointValueKey) => entryDrafts.has(entryDraftKey('range', joint.id, k));
  // WM2: a continuous joint has no range.
  if (!key || readOnly || joint.continuous) return null;
  const [min, max] = fields ?? shown;
  const a = Number(min);
  const b = Number(max);
  // An endpoint whose text is unchanged keeps its stored value, not the rounded text: the order
  // is checked on the values that are sent.
  const lo = stored && min === shown[0] ? stored.min : jointFieldValue(key, a);
  const hi = stored && max === shown[1] ? stored.max : jointFieldValue(key, b);
  const valid =
    min!.trim() !== '' &&
    max!.trim() !== '' &&
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    lo <= hi;
  const unit = isJointAngleKey(key) ? '°' : 'mm';
  return (
    <form
      className="cad-placement cad-joint-values"
      aria-label="Joint range"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void assembly.setJointLimit(joint.id, key, [lo, hi]);
      }}
    >
      {keys.length > 1 && (
        <label>
          <span>Range of</span>
          <select value={key} onChange={(e) => setKey(e.target.value as typeof key)}>
            {keys.map((k) => (
              <option key={k} value={k}>
                {jointValueLabels[k]}
                {pending(k) ? '（未適用）' : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        <span>Min ({unit})</span>
        <input
          inputMode="decimal"
          value={min}
          onChange={(e) => setFields([e.target.value, max!])}
        />
      </label>
      <label>
        <span>Max ({unit})</span>
        <input
          inputMode="decimal"
          value={max}
          onChange={(e) => setFields([min!, e.target.value])}
        />
      </label>
      <div className="cad-row">
        <button type="submit" disabled={!valid || !fields}>
          Apply range
        </button>
        {edited && (
          <button type="button" onClick={() => setFields(undefined)}>
            Reset
          </button>
        )}
        {stored && (
          <button
            type="button"
            onClick={() => void assembly.setJointLimit(joint.id, key, undefined)}
          >
            Clear range
          </button>
        )}
      </div>
    </form>
  );
}

/**
 * MR1: one value follows another joint's value of the same kind, `ratio × from + offset` (the
 * offset in degrees for an angle, mm otherwise): the right wing at −1 × the left. Applied and
 * removed as one edit each; removing stores the value it had.
 */
function JointCouplings({
  assembly,
  doc,
  joint,
  readOnly,
}: {
  assembly: CadAssembly;
  doc: CadDocument;
  joint: CadJoint;
  readOnly: boolean;
}) {
  const keys = cadJointValueKeys[joint.type];
  const [key, setKey] = useState(keys[0]);
  const stored = joint.couplings?.find((c) => c.of === key);
  const sources = (k: CadJointValueKey | undefined) =>
    doc.joints.flatMap((j) =>
      j.id === joint.id || !k
        ? []
        : cadJointValueKeys[j.type]
            .filter((v) => isJointAngleKey(v) === isJointAngleKey(k))
            .map((v) => ({ joint: j.id, of: v, label: `${j.name} ${jointValueLabels[v]}` })),
    );
  const options = sources(key);
  const unit = key && isJointAngleKey(key) ? 180 / Math.PI : 1;
  const shown = stored
    ? {
        from: `${stored.from.joint} ${stored.from.of}`,
        ratio: String(stored.ratio),
        offset: String(Math.round(stored.offset * unit * 1000) / 1000),
      }
    : { from: options[0] ? `${options[0].joint} ${options[0].of}` : '', ratio: '1', offset: '0' };
  // Kept by the assembly per joint and value, like the range (see JointLimits).
  const { entryDrafts } = useSyncExternalStore(assembly.subscribe, assembly.getSnapshot);
  const draftKey = key && entryDraftKey('coupling', joint.id, key);
  const typed = draftKey ? entryDrafts.get(draftKey)?.fields : undefined;
  const draft = typed && { from: typed[0]!, ratio: typed[1]!, offset: typed[2]! };
  const setDraft = (next: typeof shown | undefined) => {
    if (draftKey)
      assembly.setEntryDraft(
        draftKey,
        next && {
          fields: [next.from, next.ratio, next.offset],
          shown: [shown.from, shown.ratio, shown.offset],
          stored: entryStored(joint, draftKey),
        },
      );
  };
  const edited = !!draft;
  const pending = (k: CadJointValueKey) => entryDrafts.has(entryDraftKey('coupling', joint.id, k));
  if (!key || readOnly) return null;
  // WM2: a gear mesh owns this angle's coupling; it is changed and removed with the mesh.
  const mesh = doc.gearMeshes?.find((m) => m.driven.joint === joint.id);
  if (mesh && key === 'angle')
    return (
      <p className="cad-muted" data-testid="cad-joint-mesh-coupling">
        角度は歯車のかみ合い「{mesh.name}」で決まります（比 {stored?.ratio}
        ）。外す時はGear meshesから外してください。
      </p>
    );
  const f = draft ?? shown;
  const source = options.find((o) => `${o.joint} ${o.of}` === f.from);
  const ratio = Number(f.ratio);
  const offset = Number(f.offset);
  const valid =
    !!source &&
    f.ratio.trim() !== '' &&
    f.offset.trim() !== '' &&
    Number.isFinite(ratio) &&
    Number.isFinite(offset);
  const set = (change: Partial<typeof shown>) => setDraft({ ...f, ...change });
  return (
    <form
      className="cad-placement cad-joint-values"
      aria-label="Joint coupling"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid)
          void assembly.setJointCoupling(joint.id, key, {
            from: { joint: source.joint, of: source.of },
            ratio: stored && f.ratio === shown.ratio ? stored.ratio : ratio,
            offset:
              stored && f.offset === shown.offset ? stored.offset : jointFieldValue(key, offset),
          });
      }}
    >
      {keys.length > 1 && (
        <label>
          <span>Coupled value</span>
          <select value={key} onChange={(e) => setKey(e.target.value as typeof key)}>
            {keys.map((k) => (
              <option key={k} value={k}>
                {jointValueLabels[k]}
                {pending(k) ? '（未適用）' : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        <span>Follows</span>
        <select value={f.from} onChange={(e) => set({ from: e.target.value })}>
          {options.map((o) => (
            <option key={`${o.joint} ${o.of}`} value={`${o.joint} ${o.of}`}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Ratio</span>
        <input
          inputMode="decimal"
          value={f.ratio}
          onChange={(e) => set({ ratio: e.target.value })}
        />
      </label>
      <label>
        <span>Offset ({isJointAngleKey(key) ? '°' : 'mm'})</span>
        <input
          inputMode="decimal"
          value={f.offset}
          onChange={(e) => set({ offset: e.target.value })}
        />
      </label>
      <div className="cad-row">
        <button type="submit" disabled={!valid || (!draft && !!stored)}>
          {stored ? 'Apply coupling' : 'Couple'}
        </button>
        {edited && (
          <button type="button" onClick={() => setDraft(undefined)}>
            Reset
          </button>
        )}
        {stored && (
          <button
            type="button"
            onClick={() => void assembly.setJointCoupling(joint.id, key, undefined)}
          >
            Remove coupling
          </button>
        )}
      </div>
      {!options.length && <p className="cad-muted">連動できる値を持つjointがありません。</p>}
    </form>
  );
}

/** The joints of the Assembly section: list, Inspector, and solving poses again. */
export function JointsSection({
  assembly,
  snapshot,
  narrow,
}: {
  assembly: CadAssembly;
  snapshot: CadSnapshot;
  narrow: boolean;
}) {
  const parts = useSyncExternalStore(assembly.subscribe, assembly.getSnapshot);
  const doc = snapshot.content;
  const evaluated = snapshot.evaluation?.status === 'ok' ? snapshot.evaluation.assembly : undefined;
  const mismatch = evaluated?.poseMismatch ?? [];
  const selected = doc.joints.find((j) => j.id === parts.selectedJoint);
  const solution = selected && evaluated?.joints?.[selected.id];
  const name = (id: string | undefined) =>
    id === undefined ? 'This document' : (stepName(doc, id) ?? id);
  // Making a joint is desktop work, like inserting parts (docs/cad/r2b-assembly.md, Surface).
  const addReason = narrow ? 'Making joints needs a wider window (over 800 px).' : undefined;
  if (!doc.joints.length && (snapshot.readOnly || doc.components.length < 1)) return null;
  return (
    <div className="cad-joints">
      <h3>Joints ({doc.joints.length})</h3>
      {!snapshot.readOnly && !parts.creating && (
        <div className="cad-row" role="group" aria-label="Joint actions">
          <button
            type="button"
            title={addReason}
            disabled={!!addReason || snapshot.busy || !!parts.update}
            onClick={() => void assembly.startJoint()}
          >
            Add joint…
          </button>
        </div>
      )}
      {addReason && !snapshot.readOnly && <p className="cad-muted">{addReason}</p>}
      {parts.creating && (
        <JointCreator
          assembly={assembly}
          creating={parts.creating}
          doc={doc}
          busy={snapshot.busy}
        />
      )}
      {mismatch.length > 0 && (
        <div className="cad-diagnostic" role="alert" data-testid="cad-pose-mismatch">
          <p>
            {describeCode('assembly-pose-mismatch')}（
            {mismatch.map((id) => doc.joints.find((j) => j.id === id)?.name ?? id).join('・')}）
          </p>
          {!snapshot.readOnly && (
            <button
              type="button"
              disabled={snapshot.busy}
              onClick={() => void assembly.solvePoses()}
            >
              Solve poses again
            </button>
          )}
        </div>
      )}
      <ul aria-label="Joints">
        {doc.joints.map((j) => {
          const label = evaluated ? solutionLabel(evaluated.joints?.[j.id]) : '計算中';
          return (
            <li key={j.id}>
              <button
                type="button"
                className="cad-item"
                aria-pressed={parts.selectedJoint === j.id}
                onClick={() =>
                  assembly.selectJoint(parts.selectedJoint === j.id ? undefined : j.id)
                }
              >
                {j.name}
                <small className="cad-muted"> {jointTypeLabel[j.type]}</small>
                {label && (
                  <small
                    className="cad-part-state"
                    data-state={evaluated?.joints?.[j.id]?.status ?? 'pending'}
                  >
                    {label}
                  </small>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {/* Kept while a joint is made, so a form name being typed stays (its buttons wait). */}
      <MountsSection
        assembly={assembly}
        snapshot={snapshot}
        joints={evaluated?.joints}
        paused={!!parts.creating}
      />
      <FormsSection assembly={assembly} snapshot={snapshot} paused={!!parts.creating} />
      <GearMeshesSection
        assembly={assembly}
        snapshot={snapshot}
        problems={evaluated?.gearMeshes}
        paused={!!parts.creating}
      />
      {selected && !parts.creating && (
        <div className="cad-component" data-testid="cad-joint">
          <p>
            <strong>{selected.name}</strong>
            <br />
            <small>
              {jointTypeLabel[selected.type]} · {name(selected.parent.componentPath[0])} →{' '}
              {name(selected.child.componentId)}
            </small>
          </p>
          {solution?.status === 'broken' &&
            solution.problems.map((p) => (
              <p key={p.side} className="cad-diagnostic" role="note">
                {p.side === 'parent' ? '親' : '子'}の側：{describeCode(p.code)}
              </p>
            ))}
          {solution?.status === 'unavailable' && (
            <p className="cad-diagnostic" role="note">
              部品を参照できないため、このjointは保存された配置のまま表示しています。値は変更できません。
            </p>
          )}
          <JointFields
            key={selected.id}
            assembly={assembly}
            snapshot={snapshot}
            joint={selected}
            readOnly={snapshot.readOnly || snapshot.busy || solution?.status === 'unavailable'}
          />
          <JointContinuous
            assembly={assembly}
            joint={selected}
            readOnly={snapshot.readOnly || snapshot.busy}
          />
          <JointLimits
            key={`${selected.id}-limits`}
            assembly={assembly}
            joint={selected}
            readOnly={snapshot.readOnly || snapshot.busy}
          />
          <JointCouplings
            key={`${selected.id}-couplings`}
            assembly={assembly}
            doc={doc}
            joint={selected}
            readOnly={snapshot.readOnly || snapshot.busy}
          />
          {!snapshot.readOnly && (
            <div className="cad-row">
              <button
                type="button"
                disabled={snapshot.busy}
                onClick={() => void assembly.removeJoint(selected.id)}
              >
                Delete joint
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
