import {
  cadLimits,
  cadSketchLimits,
  CadSketchError,
  mm,
  resolveLength,
  sketchElement,
  solveSketch,
  splineSelfIntersects,
  type CadSketch,
  type CadSketchConstraint,
  type CadSketchEntity,
  type Length,
  type ParameterValues,
} from '@editor-platform/cad-core';

/**
 * Sketch mode's drawing (docs/cad/r1-modeling.md, Surface): pure changes to a sketch that is not
 * an edit yet. Every change is solved at once from the current coordinates; one the solver
 * refuses throws its `CadSketchError` and leaves the drawing as it was.
 */
export interface SketchDraft {
  sketch: CadSketch;
  /** Degrees of freedom left (0: fully constrained). */
  dof: number;
}
/** A point of the drawing: an existing point by ID, or a new one at sketch coordinates. */
export type SketchPointInput = { id: string } | { at: [number, number] };
export type SketchConstraintInput = Omit<CadSketchConstraint, 'id'>;

/**
 * A sketch-local ID (`p3`, `l1`, …) that no element or constraint of `s` uses, nor any of
 * `retired`: the IDs the drawing session has removed. A removed ID is never given to a new
 * element, so a region or face name that named it reports it missing instead of following a
 * stranger (AGENTS.md, stable element IDs).
 */
export function localId(
  s: Pick<CadSketch, 'entities' | 'constraints'>,
  prefix: string,
  retired: ReadonlySet<string> = new Set(),
) {
  const used = new Set([
    ...retired,
    ...s.entities.map((e) => e.id),
    ...s.constraints.map((k) => k.id),
  ]);
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/**
 * Solves `next` and returns it as the drawing, or throws the solver's refusal. A dimension out
 * of range, a degenerate element (a line or arc without length, a circle without radius, a spline
 * with control points on top of each other) and a spline that crosses itself are refused here
 * rather than at Finish, naming `constraints[i]` or `entities[i]`.
 */
export function solveDraft(next: CadSketch, params: ParameterValues): SketchDraft {
  // The range Finish checks (validation), so no accepted dimension blocks it there.
  next.constraints.forEach((k, i) => {
    if (!('value' in k) || k.type === 'angle') return;
    let v: number;
    try {
      v = resolveLength(k.value as Length, params);
    } catch {
      return; // the solver names a reference it cannot read
    }
    if (!(v >= cadLimits.minDimensionMm && v <= cadLimits.maxDimensionMm))
      throw new CadSketchError('sketch-dimension-range', next.id, `constraints[${i}]`);
  });
  // A spline's control points and degree within what Finish accepts (validation's codes).
  next.entities.forEach((e, i) => {
    if (e.type !== 'spline') return;
    const [min, max] = cadSketchLimits.splinePoles;
    if (!(cadSketchLimits.splineDegrees as readonly number[]).includes(e.degree))
      throw new CadSketchError('sketch-spline-degree', next.id, `entities[${i}]`);
    if (e.poles.length < Math.max(min, e.degree + 1) || e.poles.length > max)
      throw new CadSketchError('sketch-spline-poles', next.id, `entities[${i}]`);
  });
  const { solved, dof } = solveSketch(next, params);
  const gap = (a: string, b: string) =>
    Math.hypot(solved[a]![0] - solved[b]![0], solved[a]![1] - solved[b]![1]);
  next.entities.forEach((e, i) => {
    const min = cadLimits.minDimensionMm;
    if (
      (e.type === 'line' && (e.start === e.end || gap(e.start, e.end) < min)) ||
      (e.type === 'arc' &&
        (new Set([e.center, e.start, e.end]).size < 3 ||
          gap(e.center, e.start) < min ||
          gap(e.start, e.end) < min)) ||
      (e.type === 'circle' && !(solved[e.id]![0] >= min)) ||
      (e.type === 'spline' &&
        (new Set(e.poles).size < e.poles.length ||
          e.poles.some(
            (q, j) => (j > 0 || e.closed) && gap(q, e.poles[(j || e.poles.length) - 1]!) < min,
          ) ||
          (!e.closed && gap(e.poles[0]!, e.poles.at(-1)!) < min)))
    )
      throw new CadSketchError('sketch-degenerate', next.id, `entities[${i}]`);
    if (e.type === 'spline' && splineSelfIntersects(sketchElement({ ...next, solved }, e.id)!))
      throw new CadSketchError('sketch-self-intersection', next.id, `entities[${i}]`);
  });
  return { sketch: { ...next, solved }, dof };
}

function withPoint(s: CadSketch, p: SketchPointInput, retired: Retired): [CadSketch, string] {
  if ('id' in p) return [s, p.id];
  const id = localId(s, 'p', retired);
  return [
    {
      ...s,
      entities: [...s.entities, { type: 'point', id }],
      solved: { ...s.solved, [id]: [p.at[0], p.at[1]] },
    },
    id,
  ];
}

type Retired = ReadonlySet<string> | undefined;

/** A change that adds one element or constraint: the drawing and the new ID. */
export interface SketchAdded {
  sketch: CadSketch;
  id: string;
}

export function addLine(
  s: CadSketch,
  a: SketchPointInput,
  b: SketchPointInput,
  retired?: Retired,
): SketchAdded {
  let start: string, end: string;
  [s, start] = withPoint(s, a, retired);
  [s, end] = withPoint(s, b, retired);
  const id = localId(s, 'l', retired);
  return { sketch: { ...s, entities: [...s.entities, { type: 'line', id, start, end }] }, id };
}

export function addCircle(
  s: CadSketch,
  c: SketchPointInput,
  radius: number,
  retired?: Retired,
): SketchAdded {
  let center: string;
  [s, center] = withPoint(s, c, retired);
  const id = localId(s, 'c', retired);
  return {
    sketch: {
      ...s,
      entities: [...s.entities, { type: 'circle', id, center }],
      solved: { ...s.solved, [id]: [radius, 0] },
    },
    id,
  };
}

/**
 * An arc about `c` from `a` to `b`: an existing point, or a new end in the direction of `b` on
 * the circle through `a`.
 */
export function addArc(
  s: CadSketch,
  c: SketchPointInput,
  a: SketchPointInput,
  b: SketchPointInput,
  clockwise: boolean,
  retired?: Retired,
): SketchAdded {
  let center: string, start: string;
  [s, center] = withPoint(s, c, retired);
  [s, start] = withPoint(s, a, retired);
  const [cu, cv] = s.solved[center]!;
  const [su, sv] = s.solved[start]!;
  const r = Math.hypot(su - cu, sv - cv);
  let end: string;
  if ('id' in b) end = b.id;
  else {
    const t = Math.atan2(b.at[1] - cv, b.at[0] - cu);
    [s, end] = withPoint(s, { at: [cu + r * Math.cos(t), cv + r * Math.sin(t)] }, retired);
  }
  const id = localId(s, 'a', retired);
  return {
    sketch: {
      ...s,
      entities: [...s.entities, { type: 'arc', id, center, start, end, clockwise }],
    },
    id,
  };
}

/** A spline through control points `poles` (existing points or new ones), open or closed. */
export function addSpline(
  s: CadSketch,
  poles: SketchPointInput[],
  degree: 2 | 3 | 5,
  closed: boolean,
  retired?: Retired,
): SketchAdded {
  const ids: string[] = [];
  for (const p of poles) {
    let id: string;
    [s, id] = withPoint(s, p, retired);
    ids.push(id);
  }
  const id = localId(s, 'sp', retired);
  const spline = { type: 'spline' as const, id, poles: ids, degree, ...(closed && { closed }) };
  return { sketch: { ...s, entities: [...s.entities, spline] }, id };
}

export function addConstraint(
  s: CadSketch,
  k: SketchConstraintInput,
  retired?: Retired,
): SketchAdded {
  const id = localId(s, 'k', retired);
  return {
    sketch: { ...s, constraints: [...s.constraints, { ...k, id } as CadSketchConstraint] },
    id,
  };
}

/** The element and constraint IDs a constraint names. */
export function constraintTargets(k: CadSketchConstraint): string[] {
  const { id: _id, type: _type, ...rest } = k;
  return Object.entries(rest)
    .filter(([key, v]) => key !== 'value' && key !== 'at' && typeof v === 'string')
    .map(([, v]) => v as string);
}
const entityPoints = (e: CadSketchEntity): string[] =>
  e.type === 'point'
    ? []
    : e.type === 'line'
      ? [e.start, e.end]
      : e.type === 'arc'
        ? [e.center, e.start, e.end]
        : e.type === 'spline'
          ? e.poles
          : [e.center];

/**
 * Removes an element or constraint. An element takes the constraints that name it, the elements
 * built on a removed point, and points nothing uses any more.
 */
export function removeItem(s: CadSketch, id: string): CadSketch {
  const gone = new Set([id]);
  let entities = s.entities.filter((e) => e.id !== id);
  for (;;) {
    const keep = entities.filter((e) => !entityPoints(e).some((p) => gone.has(p)));
    if (keep.length === entities.length) break;
    for (const e of entities) if (!keep.includes(e)) gone.add(e.id);
    entities = keep;
  }
  const constraints = s.constraints.filter(
    (k) => k.id !== id && !constraintTargets(k).some((t) => gone.has(t)),
  );
  const used = new Set([
    ...entities.flatMap(entityPoints),
    ...constraints.flatMap(constraintTargets),
  ]);
  entities = entities.filter((e) => e.type !== 'point' || used.has(e.id));
  const ids = new Set(entities.map((e) => e.id));
  const solved = Object.fromEntries(Object.entries(s.solved).filter(([k]) => ids.has(k)));
  return { ...s, entities, constraints, solved };
}

/** Sets a dimension's value (a literal or an expression over the document's parameters). */
export function setDimension(s: CadSketch, id: string, value: Length): CadSketch {
  return {
    ...s,
    constraints: s.constraints.map((k) =>
      k.id === id && 'value' in k ? ({ ...k, value } as CadSketchConstraint) : k,
    ),
  };
}

/** Moves a point (or a circle's radius) to where it is dragged, before solving again. */
export function movePoint(s: CadSketch, id: string, at: [number, number]): CadSketch {
  return { ...s, solved: { ...s.solved, [id]: at } };
}

/** A length dimension at its current value, rounded to a hundredth of a millimetre. */
export const currentLength = (v: number) => mm(Math.round(v * 100) / 100);
