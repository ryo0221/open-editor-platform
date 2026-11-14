import type { BimLook } from '@editor-platform/bim';
import {
  compareFrames,
  type ElementState,
  frameMemberResults,
  type ConstructionFrame,
  type FrameComparison,
  type FrameMemberResult,
} from '@editor-platform/construction-core';
import type { FrameModel } from '@editor-platform/geometry-fem';

/**
 * CS4b: where the frame of a construction stage is solved (CS-U5: beam elements on the Host
 * only). The Playground gives the Reference Host (CalculiX); without one the analysis says so.
 */
export interface FrameSolver {
  /** "Reference Host (CalculiX)". */
  label: string;
  /** Where the numbers go, shown before sending. */
  destination: string;
  solve(
    frame: FrameModel,
    signal: AbortSignal,
  ): Promise<{ displacement: ArrayLike<number>; stress: ArrayLike<number> }>;
}

type Solved = Awaited<ReturnType<FrameSolver['solve']>>;

/**
 * The day's frame and the completed one solved at once. When either fails, `controller` is
 * aborted (its reason the failure) so the other stops on the Host instead of running on for
 * nothing.
 */
export async function solveBoth(
  solver: FrameSolver,
  stage: FrameModel,
  completed: FrameModel | undefined,
  controller: AbortController,
): Promise<[Solved, Solved | undefined]> {
  try {
    return await Promise.all([
      solver.solve(stage, controller.signal),
      completed ? solver.solve(completed, controller.signal) : undefined,
    ]);
  } catch (e) {
    // The failure is the reason: a caller tells it from a Stop pressed by the user.
    if (!controller.signal.aborted) controller.abort(e);
    throw e;
  }
}

/** One analysed frame: the members and their results. */
export interface SolvedFrame {
  frame: ConstructionFrame;
  results: FrameMemberResult[];
}

/** The day's frame against the completed building. */
export interface FrameAnalysis {
  day: string;
  stage: SolvedFrame;
  /** Undefined when the completed building has no frame on a support. */
  completed: SolvedFrame | undefined;
  comparison: FrameComparison[];
  /** Wall time of the Host runs (s). */
  seconds: number;
}

/** Each frame's results, then the comparison. */
export function frameAnalysis(
  day: string,
  stage: ConstructionFrame,
  stageResult: { displacement: ArrayLike<number>; stress: ArrayLike<number> },
  completed: ConstructionFrame | undefined,
  completedResult: { displacement: ArrayLike<number>; stress: ArrayLike<number> } | undefined,
  seconds: number,
): FrameAnalysis {
  const s = { frame: stage, results: frameMemberResults(stage, stageResult) };
  const c =
    completed && completedResult
      ? { frame: completed, results: frameMemberResults(completed, completedResult) }
      : undefined;
  return {
    day,
    stage: s,
    completed: c,
    comparison: c ? compareFrames(s.results, c.results) : [],
    seconds,
  };
}

/** How a member is drawn by its stress on the day against the completed building's. */
export const ratioLooks = {
  /** At most 1.1 × the completed stress. */
  usual: { color: '#16a34a', opacity: 1 },
  /** Over 1.1 ×. */
  higher: { color: '#f59e0b', opacity: 1 },
  /** Over 1.5 ×: the stage works the member much harder than the finished building does. */
  high: { color: '#dc2626', opacity: 1 },
} as const satisfies Record<string, BimLook>;

export function ratioLook(ratio: number): BimLook {
  return ratio > 1.5 ? ratioLooks.high : ratio > 1.1 ? ratioLooks.higher : ratioLooks.usual;
}

/**
 * The look of an element in the view while the analysis colours the members: its ratio's look
 * only while it stands on the day shown; an unbuilt one keeps its own (hidden, or a ghost).
 */
export function analysedLook(
  state: ElementState | undefined,
  own: BimLook | null | undefined,
  ratio: BimLook | undefined,
): BimLook | null | undefined {
  return ratio && state !== undefined && state !== 'absent' ? ratio : own;
}

/** Each compared member's look. */
export function analysisLooks(a: FrameAnalysis): Map<string, BimLook> {
  return new Map(a.comparison.map((c) => [c.elementId, ratioLook(c.ratio)]));
}

export const formatMPa = (v: number) => `${v.toFixed(1)} MPa`;
export const formatKN = (n: number) =>
  `${Math.round(n).toLocaleString('en-US', { maximumFractionDigits: 0 })} kN`;
export const formatRatio = (r: number) => (Number.isFinite(r) ? `${r.toFixed(2)}×` : 'only now');

/** The largest displacement of a solved frame (mm). */
export const maxDisplacement = (s: SolvedFrame) =>
  Math.max(0, ...s.results.map((r) => r.displacementMm));

/** "312 members · 4,520 kN · up to 3.1 mm" for a solved frame. */
export function solvedSummary(s: SolvedFrame): string {
  return `${s.results.length} members · ${formatKN(s.frame.totalLoadN / 1000)} · up to ${maxDisplacement(s).toFixed(1)} mm`;
}

/** The comparison rows shown: the `limit` worst, each with its cells. */
export function comparisonRows(a: FrameAnalysis, limit = 20) {
  return a.comparison.slice(0, limit).map((c) => ({
    id: c.elementId,
    cells: [c.elementId, formatMPa(c.dayMPa), formatMPa(c.completedMPa), formatRatio(c.ratio)],
  }));
}

/** How much a frame sends to the Host: its nodes and 2-node elements. */
export function frameSize(model: FrameModel) {
  return {
    nodes: model.nodes.length / 3,
    elements: model.groups.reduce((t, g) => t + g.elements.length / 2, 0),
  };
}

/** An ID for a new site load not in `taken`: `load-1`, `load-2` … */
export function nextSiteLoadId(taken: ReadonlySet<string>): string {
  let n = 1;
  while (taken.has(`load-${n}`)) n++;
  return `load-${n}`;
}
