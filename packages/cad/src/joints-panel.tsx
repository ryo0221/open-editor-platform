/**
 * R2b-2 Surface entries (docs/cad/r2b-assembly.md, Surface): the joint list with how each solved,
 * a joint's values (Inspector, and while its drag is under way), making a joint (R2b-2c), and
 * adopting solved poses after stored ones did not match.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { cadJointValueKeys, type CadJoint, type CadJointSolution } from '@editor-platform/cad-core';
import type { CadAssembly } from './assembly';
import { stepName } from './joint-authoring';
import { describeCode, type CadSnapshot } from './controller';
import { JointCreator, jointTypeLabel } from './joint-create-panel';
import {
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
  const keys = cadJointValueKeys[joint.type];
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
          return String(Math.round((k === 'angle' ? (v * 180) / Math.PI : v) * 1000) / 1000);
        })
      : undefined;
  const fields = dragged ?? draft?.fields ?? applying ?? initial;
  const valid = validJointFields(joint, fields);
  if (!keys.length) return <p className="cad-muted">固定のjointには値がありません。</p>;
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
      {!readOnly && (
        <button type="submit" disabled={!valid || !draft}>
          Apply values
        </button>
      )}
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
