/**
 * MR7 (docs/cad/mecha-design.md, MR7（持ち替え）): how far a mounted part would move if another
 * candidate joint placed it, at the given joint values. A switch within `cadMountTolerance` does
 * not move the part ("ずれなし"); the hand-off pose is made by posing the joints so that it is.
 */
import { parameterValues } from './graph';
import { posesForJointValues, type CadJointSolution, type CadResolvedJointValues } from './joints';
import type { CadSolvedPose } from './assembly';
import type { CadDocument } from './model';
import { cadMountTolerance, type CadMountChoice } from './mounts';

export interface CadMountGap {
  mount: string;
  /** A candidate, with the part's move from where the candidate in effect puts it. */
  joint: string;
  /** False when the candidate's joint did not solve (no frames to switch to). */
  solved: boolean;
  mm: number;
  rad: number;
  within: boolean;
}

export function mountGaps(
  doc: CadDocument,
  joints: Record<string, CadJointSolution>,
  values: ReadonlyMap<string, CadResolvedJointValues> = new Map(),
  choice?: CadMountChoice,
  only?: string,
): CadMountGap[] {
  const params = parameterValues(doc);
  const solved = { poses: doc.solvedPoses, joints };
  const base = posesForJointValues(doc, solved, values, params, choice);
  const out: CadMountGap[] = [];
  for (const m of doc.mounts ?? []) {
    if (only !== undefined && m.id !== only) continue;
    const here = base[m.component];
    for (const j of m.joints) {
      if (joints[j]?.status !== 'solved' || !here) {
        out.push({
          mount: m.id,
          joint: j,
          solved: false,
          mm: Infinity,
          rad: Infinity,
          within: false,
        });
        continue;
      }
      const other = posesForJointValues(
        doc,
        solved,
        values,
        params,
        new Map([...(choice ?? []), [m.id, j]]),
      )[m.component]!;
      out.push({ mount: m.id, joint: j, solved: true, ...poseGap(here, other) });
    }
  }
  return out;
}

/** How far a part moves between two poses (mm, and the turn in radians), and whether within the tolerance. */
export function poseGap(a: CadSolvedPose, b: CadSolvedPose) {
  const mm = Math.hypot(...b.translationMm.map((v, i) => v - a.translationMm[i]!));
  const dot = Math.abs(b.rotation.reduce((s, v, i) => s + v * a.rotation[i]!, 0));
  const rad = 2 * Math.acos(Math.min(1, dot));
  return { mm, rad, within: mm <= cadMountTolerance.mm && rad <= cadMountTolerance.rad };
}
