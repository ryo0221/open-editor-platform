/**
 * MR7 (docs/cad/mecha-design.md, MR7（持ち替え）): the assembly's mounts, each a part with
 * candidate joints (a rifle in the hand or on the back). Choose the candidate in effect (one
 * edit, one Undo), see how far the part would move under each candidate now, or remove the mount
 * (the candidate in effect stays). A candidate is added by making a joint for a part another
 * joint already places.
 */
import { mountGaps, type CadDocument, type CadJointSolution } from '@editor-platform/cad-core';
import type { CadAssembly } from './assembly';
import type { CadSnapshot } from './controller';

const gapText = (g: { solved: boolean; mm: number; rad: number; within: boolean }) =>
  !g.solved
    ? '計算できません'
    : g.within
      ? 'ずれなし'
      : `${g.mm.toFixed(1)} mm・${((g.rad * 180) / Math.PI).toFixed(1)}° ずれる`;

export function MountsSection({
  assembly,
  snapshot,
  joints,
  paused = false,
}: {
  assembly: CadAssembly;
  snapshot: CadSnapshot;
  /** The current joint solutions, when evaluated: for the gap under each candidate. */
  joints: Record<string, CadJointSolution> | undefined;
  paused?: boolean;
}) {
  const doc: CadDocument = snapshot.content;
  const mounts = doc.mounts ?? [];
  if (!mounts.length) return null;
  const gaps = joints ? mountGaps(doc, joints) : [];
  const disabled = snapshot.readOnly || snapshot.busy || paused;
  const jointName = (id: string) => doc.joints.find((j) => j.id === id)?.name ?? id;
  const part = (id: string) => doc.components.find((c) => c.id === id)?.name ?? id;
  return (
    <div className="cad-forms" data-testid="cad-mounts">
      <h3>Mounts ({mounts.length})</h3>
      <ul aria-label="Mounts">
        {mounts.map((m) => (
          <li key={m.id} className="cad-form" data-testid="cad-mount" data-mount={m.id}>
            <div className="cad-row">
              <strong>{m.name}</strong>
              <small className="cad-muted"> {part(m.component)}</small>
            </div>
            <label className="cad-row">
              <span>Mounted by</span>
              <select
                aria-label={`Mount of ${m.name}`}
                value={m.active}
                disabled={disabled}
                onChange={(e) => void assembly.setMount(m.id, e.target.value)}
              >
                {m.joints.map((j) => {
                  const g = gaps.find((x) => x.mount === m.id && x.joint === j);
                  return (
                    <option key={j} value={j}>
                      {jointName(j)}
                      {g && j !== m.active ? `（${gapText(g)}）` : ''}
                    </option>
                  );
                })}
              </select>
            </label>
            <ul aria-label={`Candidates of ${m.name}`} className="cad-muted">
              {m.joints.map((j) => {
                const g = gaps.find((x) => x.mount === m.id && x.joint === j);
                return (
                  <li key={j} data-testid="cad-mount-candidate">
                    {jointName(j)}：{j === m.active ? '今の取り付け先' : g ? gapText(g) : '計算中'}
                  </li>
                );
              })}
            </ul>
            {!snapshot.readOnly && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => void assembly.removeMount(m.id)}
              >
                Remove mount
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
