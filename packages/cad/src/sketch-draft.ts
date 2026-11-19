import {
  cadLimits,
  cadSketchLimits,
  CadSketchError,
  mm,
  resolveLength,
  sketchElement,
  sketchWithOffset,
  solveSketch,
  splineSelfIntersects,
  splineThrough,
  type CadSketch,
  type CadSketchConstraint,
  type CadSketchEntity,
  type CadSketchNote,
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
  s: Pick<CadSketch, 'entities' | 'constraints' | 'notes'>,
  prefix: string,
  retired: ReadonlySet<string> = new Set(),
) {
  const used = new Set([
    ...retired,
    ...s.entities.map((e) => e.id),
    ...s.constraints.map((k) => k.id),
    ...(s.notes ?? []).map((n) => n.id),
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

/**
 * A spline on control points `poles` (existing points or new ones), open or closed. With
 * `through`, the inputs are points the curve passes through instead (SC-5): new control points are
 * computed for them, and an open spline keeps its first and last input as its end poles.
 */
export function addSpline(
  s: CadSketch,
  poles: SketchPointInput[],
  degree: 2 | 3 | 5,
  closed: boolean,
  retired?: Retired,
  through = false,
): SketchAdded {
  if (through) {
    const at = (p: SketchPointInput) => ('id' in p ? (s.solved[p.id] ?? [0, 0]) : p.at);
    const computed = splineThrough(poles.map(at), degree, closed);
    const end = (i: number) => !closed && (i === 0 || i === poles.length - 1);
    poles = computed.map((q, i) => (end(i) ? poles[i]! : { at: q }));
  }
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
  // CLF10: a note goes alone; the drawing's elements stay as they are.
  if (s.notes?.some((n) => n.id === id))
    return withNotes(
      s,
      s.notes.filter((n) => n.id !== id),
    );
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

/** `s` with `notes`, the field left out when there are none. */
function withNotes(s: CadSketch, notes: CadSketchNote[] | undefined): CadSketch {
  const { notes: _old, ...rest } = s;
  return notes?.length ? { ...rest, notes } : rest;
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

/**
 * CR3a: adds the chain `ids` moved `distance` mm sideways (`sketchWithOffset`: left of an open
 * chain as its first selected element runs, out of a closed one) as new elements without
 * constraints, with IDs the drawing session has never used. Throws the offset's refusal. Returns
 * the drawing and the new elements' IDs.
 */
export function addOffset(
  s: CadSketch,
  ids: readonly string[],
  distance: number,
  retired?: Retired,
): { sketch: CadSketch; ids: string[] } {
  const r = sketchWithOffset(s, ids, distance, (x, prefix) => localId(x, prefix, retired));
  return { sketch: r.sketch, ids: r.ids };
}

/**
 * CLF9: sets the line colour of the curves (and CLF10's notes) among `ids` (points and
 * constraints are skipped);
 * `undefined` takes it off, so they are drawn in the default colour again.
 */
export function setColor(s: CadSketch, ids: string[], color: string | undefined): CadSketch {
  const pick = new Set(ids);
  const notes = s.notes?.map((n) => {
    if (!pick.has(n.id)) return n;
    const { color: _old, ...rest } = n;
    return color ? { ...rest, color } : rest;
  });
  return {
    ...withNotes(s, notes),
    entities: s.entities.map((e) => {
      if (e.type === 'point' || !pick.has(e.id)) return e;
      const { color: _old, ...rest } = e;
      return (color ? { ...rest, color } : rest) as CadSketchEntity;
    }),
  };
}

/**
 * CLF10: adds a note reading `text` with its lower-left corner at `at`, `size` mm high. The text
 * is trimmed; empty, too long or with control characters it is refused as validation would.
 */
export function addNote(
  s: CadSketch,
  at: [number, number],
  text: string,
  size: number,
  retired?: Retired,
): SketchAdded {
  if ((s.notes?.length ?? 0) >= cadSketchLimits.notes)
    throw new CadSketchError('limit-sketch-notes', s.id, 'notes');
  const id = localId(s, 'n', retired);
  const note = checkedNote(s, { id, at, text, size });
  return { sketch: withNotes(s, [...(s.notes ?? []), note]), id };
}

/** CLF10: changes a note's text, height or place. */
export function editNote(
  s: CadSketch,
  id: string,
  patch: Partial<Pick<CadSketchNote, 'at' | 'text' | 'size'>>,
): CadSketch {
  return withNotes(
    s,
    s.notes?.map((n) => (n.id === id ? checkedNote(s, { ...n, ...patch }) : n)),
  );
}

function checkedNote(s: CadSketch, n: CadSketchNote): CadSketchNote {
  const text = n.text.trim();
  const at = `notes.${n.id}`;
  if (
    !text ||
    [...text].length > cadSketchLimits.noteText ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(text)
  )
    throw new CadSketchError('sketch-note-text', s.id, at);
  const [lo, hi] = cadSketchLimits.noteSize;
  if (!(n.size >= lo && n.size <= hi)) throw new CadSketchError('sketch-note-size', s.id, at);
  if (!n.at.every((x) => Number.isFinite(x) && Math.abs(x) <= cadLimits.coordinateMm))
    throw new CadSketchError('coordinate-range', s.id, at);
  return { ...n, text };
}
