import type { Angle, CadDocument, CadFeature, Length, Position3, Vec3 } from './model';

export type ParameterValues = ReadonlyMap<string, { type: 'length' | 'angle'; value: number }>;
export const parameterValues = (doc: Pick<CadDocument, 'parameters'>): ParameterValues =>
  new Map(doc.parameters.map((p) => [p.id, { type: p.type, value: p.value }]));

/** Throws `parameter-missing` / `parameter-type` for references validation has not checked. */
export function resolveLength(length: Length, params: ParameterValues): number {
  if ('literalMm' in length) return length.literalMm;
  const ref = 'parameterId' in length ? length : length.affine;
  const p = params.get(ref.parameterId);
  if (!p) throw new Error('parameter-missing');
  if (p.type !== 'length') throw new Error('parameter-type');
  return 'affine' in length ? length.affine.scale * p.value + length.affine.offsetMm : p.value;
}
export function resolveAngle(angle: Angle, params: ParameterValues): number {
  if ('literalRad' in angle) return angle.literalRad;
  const p = params.get(angle.parameterId);
  if (!p) throw new Error('parameter-missing');
  if (p.type !== 'angle') throw new Error('parameter-type');
  return p.value;
}
export const resolvePosition = (p: Position3, params: ParameterValues): Vec3 => [
  resolveLength(p[0], params),
  resolveLength(p[1], params),
  resolveLength(p[2], params),
];
export const isLiteralPosition = (p: Position3) => p.every((l) => 'literalMm' in l);

/** Parameter IDs read by a Length/Angle. */
export const lengthParameter = (l: Length | Angle): string | undefined =>
  'parameterId' in l ? l.parameterId : 'affine' in l ? l.affine.parameterId : undefined;

/** Direct parameter/profile references of one feature (inputs are `inputFeatureIds`). */
export function featureReads(f: CadFeature): { parameters: string[]; profiles: string[] } {
  const lengths: (Length | Angle)[] = [];
  const profiles: string[] = [];
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
      profiles.push(f.args.profileId);
      break;
    case 'revolve':
      lengths.push(...f.args.axisOrigin, f.args.angle);
      profiles.push(f.args.profileId);
      break;
    case 'transform':
      lengths.push(...f.args.translation);
      break;
    case 'boolean':
      break;
  }
  return { parameters: lengths.map(lengthParameter).filter((x) => x !== undefined), profiles };
}
export function profileParameters(p: CadDocument['profiles'][number]): string[] {
  const lengths: Length[] = [...p.plane.origin];
  if (p.shape.type === 'rectangle') lengths.push(p.shape.width, p.shape.height);
  else if (p.shape.type === 'circle') lengths.push(p.shape.radius);
  else for (const v of p.shape.vertices) lengths.push(v.u, v.v);
  return lengths.map(lengthParameter).filter((x) => x !== undefined);
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
