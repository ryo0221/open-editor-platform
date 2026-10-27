import {
  cadExpressionLimits,
  CadExpressionError,
  evaluateExpression,
  expressionReads,
  type CadExpression,
  type CadExprType,
  type CadParameterType,
  type CadParameterValues,
} from './expression';
import {
  cadLimits,
  type Angle,
  type CadBodyKind,
  type CadDocument,
  type CadFeature,
  type CadParameter,
  type CadSweepSource,
  type CadRatio,
  type Count,
  type Length,
  type Position3,
  type Vec3,
} from './model';
import type { CadSketch } from './sketch';

export type ParameterValues = CadParameterValues;

/** Parameter IDs a parameter's own value reads (none for a literal). */
export const parameterReads = (p: CadParameter): string[] =>
  p.expression ? expressionReads(p.expression) : [];

/** Whether a parameter value fits its type: finite mm within coordinates, an integer count. */
export function parameterValueCode(type: CadParameterType, value: number): string | undefined {
  if (!Number.isFinite(value)) return 'parameter-value';
  if (type === 'length' && Math.abs(value) > cadLimits.coordinateMm) return 'coordinate-range';
  if (
    type === 'count' &&
    !(
      Number.isInteger(value) &&
      value >= cadExpressionLimits.countMin &&
      value <= cadExpressionLimits.countMax
    )
  )
    return 'count-range';
  return undefined;
}
const exprTypeOf = (t: CadParameterType): CadExprType => (t === 'count' ? 'scalar' : t);

export interface ParameterError {
  index: number;
  code: string;
  /** Postfix index of an expression error. */
  node?: number;
}
/**
 * Evaluates every parameter in dependency order (literals first, then expressions over them).
 * A cycle, a chain longer than `cadExpressionLimits.parameterDepth`, an expression error or an
 * out-of-range value is reported per parameter; such a parameter gets no value, and parameters
 * reading it report `parameter-dependency`.
 */
export function evaluateParameters(parameters: readonly CadParameter[]): {
  values: Map<string, { type: CadParameterType; value: number }>;
  errors: ParameterError[];
} {
  const values = new Map<string, { type: CadParameterType; value: number }>();
  const errors: ParameterError[] = [];
  const index = new Map<string, number>();
  parameters.forEach((p, i) => index.has(p.id) || index.set(p.id, i));
  // Iterative DFS: 0 unseen, 1 on the stack, 2 done. Depth counts parameters on the longest chain.
  const state = new Map<string, number>();
  const depth = new Map<string, number>();
  const order: number[] = [];
  const failed = new Set<number>();
  for (const [root] of index) {
    if (state.get(root)) continue;
    const stack: { id: string; next: number }[] = [{ id: root, next: 0 }];
    state.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const reads = parameterReads(parameters[index.get(top.id)!]).filter((r) => index.has(r));
      if (top.next < reads.length) {
        const dep = reads[top.next++];
        const s = state.get(dep) ?? 0;
        if (s === 1) {
          // Every parameter on the cycle is reported.
          for (let k = stack.findIndex((e) => e.id === dep); k < stack.length; k++)
            failed.add(index.get(stack[k].id)!);
        } else if (s === 0) {
          state.set(dep, 1);
          stack.push({ id: dep, next: 0 });
        }
        continue;
      }
      stack.pop();
      state.set(top.id, 2);
      depth.set(top.id, 1 + Math.max(0, ...reads.map((r) => depth.get(r) ?? 0)));
      order.push(index.get(top.id)!);
    }
  }
  for (const i of failed) errors.push({ index: i, code: 'parameter-cycle' });
  for (const i of order) {
    if (failed.has(i)) continue;
    const p = parameters[i];
    if (depth.get(p.id)! > cadExpressionLimits.parameterDepth) {
      errors.push({ index: i, code: 'limit-parameter-depth' });
      continue;
    }
    if (parameterReads(p).some((r) => index.has(r) && !values.has(r))) {
      errors.push({ index: i, code: 'parameter-dependency' });
      continue;
    }
    let value: number;
    if (p.expression) {
      try {
        const r = evaluateExpression(p.expression, values);
        if (r.type !== exprTypeOf(p.type)) throw new CadExpressionError('expression-type');
        value = r.value;
      } catch (e) {
        const x = e instanceof CadExpressionError ? e : new CadExpressionError('expression');
        errors.push({ index: i, code: x.code, ...(x.node === undefined ? {} : { node: x.node }) });
        continue;
      }
    } else value = p.value!;
    const code = parameterValueCode(p.type, value);
    if (code) errors.push({ index: i, code });
    else values.set(p.id, { type: p.type, value });
  }
  errors.sort((a, b) => a.index - b.index);
  return { values, errors };
}
/** Values of a validated document's parameters. */
export const parameterValues = (doc: Pick<CadDocument, 'parameters'>): ParameterValues =>
  evaluateParameters(doc.parameters).values;

function resolveExpression(e: CadExpression, type: CadExprType, params: ParameterValues) {
  const r = evaluateExpression(e, params);
  if (r.type !== type) throw new CadExpressionError('expression-type');
  return r.value;
}
/** Throws `parameter-missing` / `parameter-type` / expression errors for unvalidated references. */
export function resolveLength(length: Length, params: ParameterValues): number {
  if ('literalMm' in length) return length.literalMm;
  if ('expression' in length) return resolveExpression(length.expression, 'length', params);
  const ref = 'parameterId' in length ? length : length.affine;
  const p = params.get(ref.parameterId);
  if (!p) throw new Error('parameter-missing');
  if (p.type !== 'length') throw new Error('parameter-type');
  return 'affine' in length ? length.affine.scale * p.value + length.affine.offsetMm : p.value;
}
export function resolveAngle(angle: Angle, params: ParameterValues): number {
  if ('literalRad' in angle) return angle.literalRad;
  if ('expression' in angle) return resolveExpression(angle.expression, 'angle', params);
  const p = params.get(angle.parameterId);
  if (!p) throw new Error('parameter-missing');
  if (p.type !== 'angle') throw new Error('parameter-type');
  return p.value;
}
/** A count: a whole number 1–1,000 (`count-range` otherwise). */
export function resolveCount(count: Count, params: ParameterValues): number {
  let value: number;
  if ('literal' in count) value = count.literal;
  else if ('expression' in count) value = resolveExpression(count.expression, 'scalar', params);
  else {
    const p = params.get(count.parameterId);
    if (!p) throw new Error('parameter-missing');
    if (p.type !== 'count') throw new Error('parameter-type');
    value = p.value;
  }
  const code = parameterValueCode('count', value);
  if (code) throw new Error(code);
  return value;
}
/** K6: a dimensionless factor (a derived section's scale). */
export function resolveRatio(ratio: CadRatio, params: ParameterValues): number {
  return 'literal' in ratio ? ratio.literal : resolveExpression(ratio.expression, 'scalar', params);
}
export const resolvePosition = (p: Position3, params: ParameterValues): Vec3 => [
  resolveLength(p[0], params),
  resolveLength(p[1], params),
  resolveLength(p[2], params),
];
export const isLiteralPosition = (p: Position3) => p.every((l) => 'literalMm' in l);

/** The one parameter a Length/Angle is bound to directly; `undefined` for literals and expressions. */
export const lengthParameter = (l: Length | Angle | Count): string | undefined =>
  'parameterId' in l ? l.parameterId : 'affine' in l ? l.affine.parameterId : undefined;
/** Every parameter ID a Length/Angle reads. */
export const lengthParameters = (l: Length | Angle | Count): string[] =>
  'expression' in l
    ? expressionReads(l.expression)
    : [lengthParameter(l)].filter((x) => x !== undefined);
/** `ids` and every parameter whose value reads one of them, transitively. */
export function dependentParameters(parameters: readonly CadParameter[], ids: Iterable<string>) {
  const hit = new Set(ids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of parameters)
      if (!hit.has(p.id) && parameterReads(p).some((r) => hit.has(r))) {
        hit.add(p.id);
        grew = true;
      }
  }
  return hit;
}
/** `ids` and every parameter they read, transitively. */
export function parameterClosure(parameters: readonly CadParameter[], ids: Iterable<string>) {
  const byId = new Map(parameters.map((p) => [p.id, p]));
  const result = new Set<string>();
  const stack = [...ids];
  while (stack.length) {
    const id = stack.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    const p = byId.get(id);
    if (p) stack.push(...parameterReads(p));
  }
  return result;
}

/** Direct parameter/profile/sketch references of one feature (inputs are `inputFeatureIds`). */
export function featureReads(f: CadFeature): {
  parameters: string[];
  profiles: string[];
  sketches: string[];
} {
  const lengths: (Length | Angle | Count)[] = [];
  const profiles: string[] = [];
  const sketches: string[] = [];
  const source = (a: CadSweepSource) =>
    'sketchId' in a ? sketches.push(a.sketchId) : profiles.push(a.profileId);
  switch (f.type) {
    case 'box':
      lengths.push(...f.args.size, ...f.args.origin);
      break;
    case 'cylinder':
      lengths.push(f.args.radius, f.args.height, ...f.args.origin);
      break;
    case 'sphere':
      lengths.push(f.args.radius, ...f.args.origin);
      break;
    case 'extrude':
      lengths.push(f.args.distance);
      source(f.args);
      break;
    case 'revolve':
      lengths.push(...f.args.axisOrigin, f.args.angle);
      source(f.args);
      break;
    case 'loft':
      // K6: a derived section reads parameters through its offset, scale and angle.
      for (const x of f.args.sections)
        if ('derivedFrom' in x) lengths.push(...x.offset, x.angle, x.scale as Count);
      sketches.push(...featureSketches(f));
      break;
    case 'sweep':
    case 'surfaceLoft':
    case 'surfaceSweep':
    case 'boundarySurface':
    case 'fill':
      sketches.push(...featureSketches(f));
      break;
    case 'extrudeSurface':
      lengths.push(f.args.distance);
      sketches.push(...featureSketches(f));
      break;
    case 'revolveSurface':
      lengths.push(...f.args.axisOrigin, f.args.angle);
      sketches.push(...featureSketches(f));
      break;
    case 'transform':
      lengths.push(...f.args.translation);
      break;
    case 'trim':
      if ('plane' in f.args.tool) lengths.push(...f.args.tool.plane.origin);
      sketches.push(...featureSketches(f));
      break;
    case 'thicken':
      lengths.push(f.args.thickness);
      break;
    case 'fillet':
      lengths.push(f.args.radius);
      break;
    case 'chamfer':
      lengths.push(f.args.distance, ...('distance2' in f.args ? [f.args.distance2] : []));
      break;
    case 'shell':
      lengths.push(f.args.thickness);
      break;
    case 'pattern': {
      const l = f.args.layout;
      lengths.push(
        l.count,
        ...(l.type === 'linear'
          ? [l.spacing]
          : l.type === 'circular'
            ? [...l.axisOrigin, l.angle]
            : []),
      );
      // K5a: the copies follow the path a sketch draws.
      sketches.push(...featureSketches(f));
      break;
    }
    case 'mirror':
      if ('origin' in f.args.plane) lengths.push(...f.args.plane.origin);
      break;
    case 'draft':
      lengths.push(f.args.angle);
      break;
    case 'boolean':
    case 'sew':
    case 'imported':
      break;
  }
  return { parameters: [...new Set(lengths.flatMap(lengthParameters))], profiles, sketches };
}
/** Parameters a sketch reads: its plane, fixed positions and dimensions. */
export function sketchParameters(s: CadSketch): string[] {
  const lengths: (Length | Angle)[] = 'face' in s.plane ? [s.plane.offset] : [...s.plane.origin];
  for (const k of s.constraints)
    if (k.type === 'fix') lengths.push(...k.at);
    else if ('value' in k) lengths.push(k.value);
  return [...new Set(lengths.flatMap(lengthParameters))];
}
/** The feature whose face a sketch is attached to. Safe on unvalidated input. */
export function sketchAttachment(s: Pick<CadSketch, 'plane'>): string | undefined {
  const face = (s.plane as { face?: { featureId?: unknown } } | undefined)?.face;
  return typeof face?.featureId === 'string' ? face.featureId : undefined;
}
/**
 * The kind of body feature `id` gives (docs/cad/r2a-freeform.md, Surface body): a sheet from the
 * surface features, an imported sheet and what moves or reflects one alone; a solid otherwise.
 * Features that need a solid input refuse a sheet in validation. Safe on unvalidated input;
 * undefined for a missing feature or a cycle.
 */
export function featureKind(
  doc: Pick<CadDocument, 'features'>,
  id: string,
  seen = new Set<string>(),
): CadBodyKind | undefined {
  const f = doc.features.find((x) => x.id === id);
  if (!f || seen.has(id)) return undefined;
  seen.add(id);
  const first = () => {
    const input = (f.inputFeatureIds as unknown[] | undefined)?.[0];
    return typeof input === 'string' ? featureKind(doc, input, seen) : undefined;
  };
  switch (f.type) {
    case 'extrudeSurface':
    case 'revolveSurface':
    case 'surfaceLoft':
    case 'surfaceSweep':
    case 'boundarySurface':
    case 'fill':
    case 'trim':
      return 'sheet';
    case 'sew':
      return (f.args as { solid?: unknown } | undefined)?.solid === true ? 'solid' : 'sheet';
    case 'imported':
      return (f.args as { kind?: unknown } | undefined)?.kind === 'sheet' ? 'sheet' : 'solid';
    case 'transform':
      return first();
    case 'mirror':
      return (f.args as { union?: unknown } | undefined)?.union === false ? first() : 'solid';
    default:
      return 'solid';
  }
}
/**
 * The sketches a feature reads: the one an extrude or revolve sweeps, a loft's sections, a
 * sweep's profile and path. Safe on unvalidated input.
 */
export function featureSketches(f: Pick<CadFeature, 'type' | 'args'>): string[] {
  const a = f.args as Record<string, unknown> | undefined;
  const of = (x: unknown) => {
    const id = (x as { sketchId?: unknown } | undefined)?.sketchId;
    return typeof id === 'string' ? [id] : [];
  };
  switch (f.type) {
    case 'extrude':
    case 'revolve':
      return of(a);
    case 'loft':
    case 'surfaceLoft':
      return Array.isArray(a?.sections) ? [...new Set(a.sections.flatMap(of))] : [];
    case 'sweep':
    case 'surfaceSweep':
      return [...new Set([...of(a?.profile), ...of(a?.path)])];
    case 'extrudeSurface':
    case 'revolveSurface':
      return of(a?.path);
    case 'boundarySurface':
      return Array.isArray(a?.curves) ? [...new Set(a.curves.flatMap(of))] : [];
    case 'fill':
      return Array.isArray(a?.boundary)
        ? [...new Set(a.boundary.flatMap((b) => of((b as { curve?: unknown } | null)?.curve)))]
        : [];
    case 'trim':
      return of(a?.tool);
    case 'pattern':
      return of((a?.layout as { path?: unknown } | undefined)?.path);
    default:
      return [];
  }
}
/**
 * The features a surface feature reads through stored edge references that are not its inputs
 * (R2a-2c: a loft section of edges, a boundary curve that is an edge) and the sheet a trim cuts
 * with (R2a-3): read like a sketch's attachment, never consumed. Safe on unvalidated input.
 */
export function featureReferenceSources(f: Pick<CadFeature, 'type' | 'args'>): string[] {
  if (f.type === 'trim') {
    const id = (f.args as { tool?: { featureId?: unknown } } | undefined)?.tool?.featureId;
    return typeof id === 'string' ? [id] : [];
  }
  if (f.type !== 'surfaceLoft' && f.type !== 'boundarySurface' && f.type !== 'fill') return [];
  const out = new Set<string>();
  const ref = (x: unknown) => {
    const id = (x as { featureId?: unknown } | null | undefined)?.featureId;
    if (typeof id === 'string') out.add(id);
  };
  const a = f.args as Record<string, unknown> | undefined;
  const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
  for (const section of list(a?.sections))
    for (const e of list((section as { edges?: unknown } | null)?.edges)) ref(e);
  for (const c of list(a?.curves)) ref((c as { edge?: unknown } | null)?.edge);
  for (const b of list(a?.boundary)) ref((b as { curve?: { edge?: unknown } } | null)?.curve?.edge);
  return [...out];
}

/**
 * The one dependency graph of features and sketches (docs/cad/r1-modeling.md, 依存関係と評価順):
 * each node with the nodes it reads. Edges to IDs that are not nodes are left out.
 */
export function dependencyEdges(doc: Pick<CadDocument, 'features' | 'sketches'>) {
  const edges = new Map<string, string[]>();
  for (const s of doc.sketches) edges.set(s.id, []);
  for (const f of doc.features) edges.set(f.id, []);
  for (const s of doc.sketches) {
    const a = sketchAttachment(s);
    if (a !== undefined && edges.has(a)) edges.get(s.id)!.push(a);
  }
  for (const f of doc.features)
    edges.set(f.id, [
      ...new Set(
        [...f.inputFeatureIds, ...featureSketches(f), ...featureReferenceSources(f)].filter((i) =>
          edges.has(i),
        ),
      ),
    ]);
  return edges;
}
/**
 * Stable topological order of features and sketches with ID tie-break, or the nodes of one cycle
 * in dependency order (`cad-dependency-cycle`).
 */
export function dependencyOrder(
  doc: Pick<CadDocument, 'features' | 'sketches'>,
): { order: string[]; depth: number } | { cycle: string[] } {
  const edges = dependencyEdges(doc);
  const pending = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const [id, reads] of edges) {
    pending.set(id, reads.length);
    for (const r of reads) dependents.set(r, [...(dependents.get(r) ?? []), id]);
  }
  const ready = [...pending].filter(([, n]) => n === 0).map(([id]) => id);
  const order: string[] = [];
  const depth = new Map<string, number>();
  while (ready.length) {
    ready.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    const id = ready.pop()!;
    order.push(id);
    depth.set(id, 1 + Math.max(0, ...edges.get(id)!.map((r) => depth.get(r)!)));
    for (const d of dependents.get(id) ?? []) {
      const n = pending.get(d)! - 1;
      pending.set(d, n);
      if (n === 0) ready.push(d);
    }
  }
  if (order.length === edges.size) return { order, depth: Math.max(0, ...depth.values()) };
  // Every left node reads another left node: follow reads from the smallest ID until one repeats.
  let id = [...edges.keys()].filter((k) => !depth.has(k)).sort()[0]!;
  const path: string[] = [];
  while (!path.includes(id)) {
    path.push(id);
    id = edges
      .get(id)!
      .filter((r) => !depth.has(r))
      .sort()[0]!;
  }
  return { cycle: path.slice(path.indexOf(id)).reverse() };
}
export function profileParameters(p: CadDocument['profiles'][number]): string[] {
  const lengths: Length[] = [...p.plane.origin];
  if (p.shape.type === 'rectangle') lengths.push(p.shape.width, p.shape.height);
  else if (p.shape.type === 'circle') lengths.push(p.shape.radius);
  else for (const v of p.shape.vertices) lengths.push(v.u, v.v);
  return [...new Set(lengths.flatMap(lengthParameters))];
}

/** Stable topological order with ID tie-break; `undefined` when the graph has a cycle or dangling input. */
export function evaluationOrder(features: readonly CadFeature[]): string[] | undefined {
  const ids = new Set(features.map((f) => f.id));
  const pending = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const f of features) {
    if (f.inputFeatureIds.some((i) => !ids.has(i))) return undefined;
    pending.set(f.id, new Set(f.inputFeatureIds).size);
    for (const i of new Set(f.inputFeatureIds))
      dependents.set(i, [...(dependents.get(i) ?? []), f.id]);
  }
  const ready = [...pending].filter(([, n]) => n === 0).map(([id]) => id);
  const order: string[] = [];
  while (ready.length) {
    ready.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    const id = ready.pop()!;
    order.push(id);
    for (const d of dependents.get(id) ?? []) {
      const n = pending.get(d)! - 1;
      pending.set(d, n);
      if (n === 0) ready.push(d);
    }
  }
  return order.length === features.length ? order : undefined;
}
/** Number of features on the longest input chain (a single feature is 1). Requires an acyclic order. */
export function longestPath(features: readonly CadFeature[], order: readonly string[]): number {
  const byId = new Map(features.map((f) => [f.id, f]));
  const depth = new Map<string, number>();
  let max = 0;
  for (const id of order) {
    const d = 1 + byId.get(id)!.inputFeatureIds.reduce((m, i) => Math.max(m, depth.get(i)!), 0);
    depth.set(id, d);
    max = Math.max(max, d);
  }
  return max;
}
/** Features that transitively consume any of `roots` (excluding the roots themselves). */
export function downstreamFeatures(features: readonly CadFeature[], roots: Iterable<string>) {
  const hit = new Set(roots);
  const result = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of features)
      if (!hit.has(f.id) && f.inputFeatureIds.some((i) => hit.has(i))) {
        hit.add(f.id);
        result.add(f.id);
        grew = true;
      }
  }
  return result;
}
/** Features that `roots` transitively read, including the roots. */
export function upstreamFeatures(features: readonly CadFeature[], roots: Iterable<string>) {
  const byId = new Map(features.map((f) => [f.id, f]));
  const result = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const id = stack.pop()!;
    if (result.has(id) || !byId.has(id)) continue;
    result.add(id);
    stack.push(...byId.get(id)!.inputFeatureIds);
  }
  return result;
}
