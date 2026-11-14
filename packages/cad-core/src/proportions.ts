import type { CadDocument } from './model';

/**
 * CLF3 (docs/cad/car-look-process.md, 比率の指標 and CLF1〜CLF3の分け方, CLF-U2): a car's
 * proportion setup. Which bodies are the wheels, the body and the windows, where the ground is,
 * and the band each indicator should fall in (the CL1 rules). Stored in the document; the
 * indicators themselves are measured from the display meshes and never stored.
 */
export interface CadProportions {
  /** Active body IDs: the front wheels (tyres), the rear wheels, the outer body, the glass. */
  frontWheels: string[];
  rearWheels: string[];
  body: string[];
  windows: string[];
  /** The ground's height (mm). */
  groundMm: number;
  /** One band at most per indicator, in the order of `cadProportionMetrics`. */
  targets: CadProportionTarget[];
}
export interface CadProportionTarget {
  metric: CadProportionMetric;
  /** The band (either end may be open); a ratio, mm or degrees as the indicator is. */
  min?: number;
  max?: number;
}
export type CadProportionMetric =
  | 'wheelToHeight'
  | 'wheelbaseToLength'
  | 'frontOverhangToWheelbase'
  | 'glassToBody'
  | 'widthToHeight'
  | 'wheelToFender'
  | 'tumblehome';
/** The indicators, in the order the plan's table lists them, with its first bands. */
export const cadProportionMetrics: Readonly<
  Record<
    CadProportionMetric,
    { label: string; unit: 'ratio' | 'mm' | 'deg'; band?: { min?: number; max?: number } }
  >
> = Object.freeze({
  wheelToHeight: { label: 'Wheel diameter / height', unit: 'ratio', band: { min: 0.5 } },
  wheelbaseToLength: {
    label: 'Wheelbase / length',
    unit: 'ratio',
    band: { min: 0.58, max: 0.62 },
  },
  frontOverhangToWheelbase: { label: 'Front overhang / wheelbase', unit: 'ratio' },
  glassToBody: { label: 'Glass / body side', unit: 'ratio', band: { min: 0.35, max: 0.45 } },
  widthToHeight: { label: 'Width / height', unit: 'ratio', band: { min: 1.6 } },
  wheelToFender: { label: 'Fender past the tyre', unit: 'mm', band: { min: 0, max: 20 } },
  tumblehome: { label: 'Tumblehome', unit: 'deg' },
});
export const cadProportionMetricIds = Object.keys(cadProportionMetrics) as CadProportionMetric[];

/** A new setup with the plan's first bands (CL1 sets each car's own). */
export function defaultProportions(
  roles: Partial<Pick<CadProportions, 'frontWheels' | 'rearWheels' | 'body' | 'windows'>> = {},
): CadProportions {
  return {
    frontWheels: [],
    rearWheels: [],
    body: [],
    windows: [],
    ...roles,
    groundMm: 0,
    targets: cadProportionMetricIds.flatMap((metric) => {
      const band = cadProportionMetrics[metric].band;
      return band ? [{ metric, ...band }] : [];
    }),
  };
}

export type CadProportionsOperation = {
  type: 'setProportions';
  /** The whole setup; null removes it. */
  proportions: CadProportions | null;
};
export function applyProportionsOperation(next: CadDocument, op: CadProportionsOperation) {
  const same = JSON.stringify(next.proportions ?? null) === JSON.stringify(op.proportions ?? null);
  if (same) throw new Error('proportions-unchanged');
  if (op.proportions) next.proportions = structuredClone(op.proportions);
  else delete next.proportions;
  return next;
}
/** A removed body leaves its role (the setup and its bands stay). */
export function pruneProportions(doc: CadDocument, removed: ReadonlySet<string>) {
  const p = doc.proportions;
  if (!p) return;
  for (const role of roles) p[role] = p[role].filter((id) => !removed.has(id));
}
const roles = ['frontWheels', 'rearWheels', 'body', 'windows'] as const;

type Rec = Record<string, unknown>;
const record = (v: unknown): v is Rec =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export interface ProportionsCheck {
  error(code: string, path: string): boolean;
  keys(v: Rec, required: string[], path: string, optional?: string[]): boolean;
}
/** The largest ground height (mm), as a coordinate. */
/** How far the ground may be from the origin (the panel refuses more at the field). */
export const cadProportionGroundLimitMm = 10_000_000;
const groundLimitMm = cadProportionGroundLimitMm;
/**
 * The shape of `proportions`: each role a list of distinct active bodies, no body in two roles,
 * a finite ground, and at most one band per indicator with min ≤ max.
 */
export function validateProportions(c: ProportionsCheck, p: unknown, active: ReadonlySet<string>) {
  const path = '$.proportions';
  if (!record(p)) return void c.error('proportions', path);
  c.keys(p, [...roles, 'groundMm', 'targets'], path);
  const seen = new Set<string>();
  for (const role of roles) {
    const list = p[role];
    if (!Array.isArray(list)) {
      if (Object.hasOwn(p, role)) c.error('proportions-role', `${path}.${role}`);
      continue;
    }
    list.forEach((id, i) => {
      const at = `${path}.${role}[${i}]`;
      if (typeof id !== 'string' || !active.has(id)) return c.error('proportions-body', at);
      if (seen.has(id)) return c.error('proportions-body-twice', at);
      seen.add(id);
    });
  }
  if (
    Object.hasOwn(p, 'groundMm') &&
    !(finite(p.groundMm) && Math.abs(p.groundMm) <= groundLimitMm)
  )
    c.error('proportions-ground', `${path}.groundMm`);
  if (!Array.isArray(p.targets)) {
    if (Object.hasOwn(p, 'targets')) c.error('proportions-targets', `${path}.targets`);
    return;
  }
  const metrics = new Set<string>();
  p.targets.forEach((t, i) => {
    const at = `${path}.targets[${i}]`;
    if (!record(t) || !c.keys(t, ['metric'], at, ['min', 'max']))
      return c.error('proportions-target', at);
    if (typeof t.metric !== 'string' || !Object.hasOwn(cadProportionMetrics, t.metric))
      return c.error('proportions-metric', `${at}.metric`);
    if (metrics.has(t.metric)) return c.error('proportions-metric-twice', `${at}.metric`);
    metrics.add(t.metric);
    for (const k of ['min', 'max'] as const)
      if (Object.hasOwn(t, k) && !finite(t[k])) c.error('proportions-band', `${at}.${k}`);
    if (finite(t.min) && finite(t.max) && t.min > t.max) c.error('proportions-band', `${at}.max`);
    if (!Object.hasOwn(t, 'min') && !Object.hasOwn(t, 'max')) c.error('proportions-band', `${at}`);
  });
}

/** A body's display mesh in world mm: its nodes, three numbers each, and its triangles. */
export interface CadProportionMesh {
  bodyId: string;
  points: ArrayLike<number>;
  /** Node indices, three a triangle (without them, the nodes alone are read). */
  indices?: ArrayLike<number>;
}
type Box = { min: [number, number, number]; max: [number, number, number] };
export interface CadProportionValue {
  metric: CadProportionMetric;
  /** Undefined when the roles it needs are empty (or a wheelbase is zero). */
  value?: number;
  /** Inside its band, outside it, or no band. */
  status: 'ok' | 'outside' | 'none';
}
/**
 * The largest `side`·y of `m` between x = `lo` and x = `hi`: over its triangles cut to that slab
 * (a linear value is largest at a corner of the cut triangle: a node inside, or where an edge
 * crosses either plane), so a coarse panel across the slab counts too. −∞ when none reaches it.
 */
function widestInSlab(m: CadProportionMesh, lo: number, hi: number, side: number) {
  const p = m.points;
  let best = -Infinity;
  const node = (n: number) => [p[3 * n]!, p[3 * n + 1]!] as const;
  const edge = (a: readonly [number, number], b: readonly [number, number]) => {
    if (a[0] >= lo && a[0] <= hi) best = Math.max(best, side * a[1]);
    for (const x of [lo, hi])
      if ((a[0] - x) * (b[0] - x) < 0)
        best = Math.max(best, side * (a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0])));
  };
  const ix = m.indices;
  if (!ix) for (let n = 0; 3 * n + 2 < p.length; n++) edge(node(n), node(n));
  else
    for (let t = 0; t + 2 < ix.length; t += 3) {
      const [a, b, c] = [node(ix[t]!), node(ix[t + 1]!), node(ix[t + 2]!)];
      edge(a, b);
      edge(b, c);
      edge(c, a);
    }
  return best;
}

/**
 * CLF3: the indicators of `p` from the display meshes (the plan's table, 比率の指標). The car's
 * extent is every role's bodies; the height counts from `groundMm`. The axles are the centres of
 * the front and the rear wheels' boxes, and the front is the side the front wheels are on. The
 * glass reads the windows from their lowest point (the belt line) up. The fender past the tyre is,
 * for the wheel that sits deepest, the body's widest point over the wheel's length on its side
 * less the tyre's outer face (positive: the tyre is inboard). The tumblehome is the windows'
 * side leaning in, from their width at the belt to their width at the top, in degrees.
 */
export function measureProportions(
  p: CadProportions,
  meshes: readonly CadProportionMesh[],
): CadProportionValue[] {
  const byBody = new Map<string, ArrayLike<number>[]>();
  for (const m of meshes) byBody.set(m.bodyId, [...(byBody.get(m.bodyId) ?? []), m.points]);
  const meshesOf = (ids: readonly string[]) => meshes.filter((m) => ids.includes(m.bodyId));
  const boxOf = (ids: readonly string[]): Box | undefined => {
    let box: Box | undefined;
    for (const id of ids)
      for (const pts of byBody.get(id) ?? [])
        for (let i = 0; i + 2 < pts.length; i += 3) {
          const q = [pts[i]!, pts[i + 1]!, pts[i + 2]!] as const;
          if (!box) box = { min: [...q], max: [...q] };
          else
            for (let k = 0; k < 3; k++) {
              box.min[k] = Math.min(box.min[k]!, q[k]!);
              box.max[k] = Math.max(box.max[k]!, q[k]!);
            }
        }
    return box;
  };
  const points = function* (ids: readonly string[]) {
    for (const id of ids)
      for (const pts of byBody.get(id) ?? [])
        for (let i = 0; i + 2 < pts.length; i += 3)
          yield [pts[i]!, pts[i + 1]!, pts[i + 2]!] as const;
  };
  // A role whose bodies are not all drawn (one failed, or not evaluated yet) measures nothing:
  // the rest would stand in for the whole car (#1114 review).
  const whole = (ids: readonly string[]) => ids.every((id) => byBody.has(id));
  const complete = whole([...p.frontWheels, ...p.rearWheels, ...p.body, ...p.windows]);
  const all = complete
    ? boxOf([...p.frontWheels, ...p.rearWheels, ...p.body, ...p.windows])
    : undefined;
  const front = whole(p.frontWheels) ? boxOf(p.frontWheels) : undefined;
  const rear = whole(p.rearWheels) ? boxOf(p.rearWheels) : undefined;
  const glass = whole(p.windows) ? boxOf(p.windows) : undefined;
  const height = all && all.max[2] - p.groundMm > 0 ? all.max[2] - p.groundMm : undefined;
  const centre = (b: Box, k: number) => (b.min[k]! + b.max[k]!) / 2;
  const wheelbase = front && rear ? Math.abs(centre(front, 0) - centre(rear, 0)) : undefined;
  const wheels = whole([...p.frontWheels, ...p.rearWheels])
    ? [...p.frontWheels, ...p.rearWheels].map((id) => boxOf([id])).filter((b): b is Box => !!b)
    : [];
  // The car's centre line: the middle of all its wheels (its sides are either side of it).
  const track = boxOf([...p.frontWheels, ...p.rearWheels]);
  const midY = track ? centre(track, 1) : 0;
  const value: Partial<Record<CadProportionMetric, number>> = {};
  if (height && wheels.length)
    value.wheelToHeight = Math.max(...wheels.map((w) => w.max[2] - w.min[2])) / height;
  if (all && wheelbase) value.wheelbaseToLength = wheelbase / (all.max[0] - all.min[0]);
  if (all && front && rear && wheelbase) {
    const ahead = centre(front, 0) > centre(rear, 0);
    value.frontOverhangToWheelbase =
      (ahead ? all.max[0] - centre(front, 0) : centre(front, 0) - all.min[0]) / wheelbase;
  }
  if (glass && glass.min[2] - p.groundMm > 0)
    value.glassToBody = (glass.max[2] - glass.min[2]) / (glass.min[2] - p.groundMm);
  if (all && height) value.widthToHeight = (all.max[1] - all.min[1]) / height;
  if (p.body.length && whole(p.body)) {
    const gaps = wheels.flatMap((w) => {
      const side = Math.sign(centre(w, 1) - midY);
      if (!side) return [];
      const outer = side > 0 ? w.max[1] : -w.min[1];
      let fender = -Infinity;
      for (const m of meshesOf(p.body))
        fender = Math.max(fender, widestInSlab(m, w.min[0], w.max[0], side));
      return Number.isFinite(fender) ? [fender - outer] : [];
    });
    if (gaps.length) value.wheelToFender = Math.max(...gaps);
  }
  if (glass && glass.max[2] > glass.min[2]) {
    const [bottom, top] = [glass.min[2], glass.max[2]];
    const band = (top - bottom) / 10;
    const angles = [1, -1].flatMap((side) => {
      let low = -Infinity;
      let high = -Infinity;
      for (const [, y, z] of points(p.windows)) {
        if (side * (y - midY) <= 0) continue;
        if (z <= bottom + band) low = Math.max(low, side * y);
        if (z >= top - band) high = Math.max(high, side * y);
      }
      return Number.isFinite(low) && Number.isFinite(high)
        ? [(Math.atan2(low - high, top - bottom) * 180) / Math.PI]
        : [];
    });
    if (angles.length) value.tumblehome = angles.reduce((a, b) => a + b) / angles.length;
  }
  return cadProportionMetricIds.map((metric) => {
    const v = value[metric];
    const band = p.targets.find((t) => t.metric === metric);
    const status =
      v === undefined || !band
        ? 'none'
        : (band.min === undefined || v >= band.min) && (band.max === undefined || v <= band.max)
          ? 'ok'
          : 'outside';
    return v === undefined ? { metric, status } : { metric, value: v, status };
  });
}
