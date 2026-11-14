/**
 * Validation of R2b-2 joints (docs/cad/r2b-assembly.md, Connectorとjoint), run by
 * `validateAssembly`: the tree rules, connector shapes, values and limits. Whether a connector
 * resolves, and whether a child's stored pose matches its joint, needs part evaluations and is
 * checked after them (CadAssemblyPort).
 */
import { parseCopyStep } from './assembly';
import {
  cadJointLimits,
  cadJointValueKeys,
  isJointAngleKey,
  jointSafetyBound,
  type CadJointType,
  type CadJointValueKey,
} from './joints';
import type { CadTopologyKind } from './topology';
import { cadId } from './validation';

type Rec = Record<string, unknown>;
/** The part of validation's `Check` the joint rules use. */
export interface JointCheck {
  error(code: string, path: string): boolean;
  keys(v: Rec, required: string[], path: string, optional?: string[]): boolean;
  id(v: unknown, path: string): v is string;
  name(v: unknown, path: string): boolean;
  length(v: unknown, path: string, use: 'coordinate' | 'dimension'): number | undefined;
  angle(v: unknown, path: string, use: 'dimension' | 'joint' | 'continuous'): number | undefined;
  position(v: unknown, path: string): unknown;
  quaternion(v: unknown, path: string): boolean;
  ref(v: unknown, path: string, kind: CadTopologyKind, inputs: unknown): boolean;
}
const record = (v: unknown): v is Rec =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;

export interface JointContext {
  componentIds: ReadonlySet<string>;
  /** Each pattern copy a parent may name (`copy:<pattern ID>:<i>`), with its seed's ID. */
  copies: ReadonlyMap<string, string>;
  /** Components whose `placement` is null, with their index in `components`. */
  unplaced: ReadonlyMap<string, number>;
  /** The result features of this document's active bodies: what a parent `[]` connector reads. */
  ownResults: readonly string[];
  /** MR7: each mounted component's candidate joints (it may have several joints, all listed). */
  mounted?: ReadonlyMap<string, ReadonlySet<string>>;
}

/** A path step: an ID, or a pattern copy whose pattern ID is one (the step itself may be longer). */
const pathStep = (v: unknown) => typeof v === 'string' && cadId(parseCopyStep(v)?.patternId ?? v);

function connector(
  c: JointCheck,
  v: unknown,
  path: string,
  side: 'parent' | 'child',
  ctx: JointContext,
) {
  if (!record(v)) return c.error('connector', path);
  if (!c.keys(v, ['componentPath', 'ref', 'flip', 'offset'], path)) return false;
  const p = v.componentPath;
  const pp = `${path}.componentPath`;
  // A child's path starts inside the component it moves, so it has one step less of room.
  const room = side === 'parent' ? cadJointLimits.path : cadJointLimits.path - 1;
  if (!Array.isArray(p) || p.length > room || !p.every(pathStep)) c.error('connector-path', pp);
  else if (
    side === 'parent' &&
    p.length &&
    !ctx.componentIds.has(p[0] as string) &&
    !ctx.copies.has(p[0] as string)
  )
    // A copy past its pattern's count is missing: the edit that lowers the count is refused.
    c.error(
      (p[0] as string).startsWith('copy:') ? 'connector-copy-missing' : 'connector-path',
      `${pp}[0]`,
    );
  const ref = v.ref;
  const rp = `${path}.ref`;
  if (record(ref) && Object.hasOwn(ref, 'origin')) {
    if (!c.keys(ref, ['origin'], rp) || ref.origin !== true) c.error('connector-ref', rp);
  } else if (!record(ref) || !['face', 'edge', 'vertex'].includes(ref.kind as string))
    c.error('connector-ref', rp);
  else {
    // A reference on this document's bodies names an active body's result; one inside a part
    // is resolved on that part's evaluation.
    const own = side === 'parent' && Array.isArray(p) && !p.length;
    c.ref(ref, rp, ref.kind as CadTopologyKind, own ? ctx.ownResults : [ref.featureId]);
  }
  if (typeof v.flip !== 'boolean') c.error('connector-flip', `${path}.flip`);
  const o = v.offset;
  const op = `${path}.offset`;
  if (!record(o) || !c.keys(o, ['translation', 'rotation'], op))
    return c.error('connector-offset', op);
  c.position(o.translation, `${op}.translation`);
  c.quaternion(o.rotation, `${op}.rotation`);
  return true;
}

export function validateJoints(c: JointCheck, list: unknown[], ctx: JointContext) {
  if (list.length > cadJointLimits.joints) c.error('limit-joints', '$.joints');
  /**
   * Each child with the parent component of each joint placing it (undefined: this document's
   * bodies); several only for a mounted component (MR7).
   */
  const parentOf = new Map<string, (string | undefined)[]>();
  /** The index of each child's joint. */
  const jointAt = new Map<string, number>();
  /** Each joint's type and resolved own values, for checking couplings after the loop. */
  const typed = new Map<
    string,
    { type: CadJointType; values: Record<string, number | undefined> }
  >();
  const ids = new Set(list.flatMap((j) => (record(j) && typeof j.id === 'string' ? [j.id] : [])));
  /** Each well-formed coupling with where it is, checked once every joint is read. */
  const limitsOf = new Map<string, { of: string; min: number; max: number }[]>();
  const couplings: {
    joint: string;
    at: string;
    index: number;
    of: CadJointValueKey;
    from: { joint: string; of: CadJointValueKey };
    ratio: number;
    offset: number;
    continuous: boolean;
  }[] = [];
  list.forEach((j, i) => {
    const path = `$.joints[${i}]`;
    if (!record(j)) return c.error('joint', path);
    c.keys(j, ['id', 'name', 'type', 'parent', 'child', 'values', 'limits'], path, [
      'couplings',
      'continuous',
    ]);
    c.id(j.id, `${path}.id`);
    c.name(j.name, `${path}.name`);
    const type =
      typeof j.type === 'string' && Object.hasOwn(cadJointValueKeys, j.type)
        ? (j.type as CadJointType)
        : undefined;
    if (!type) c.error('joint-type', `${path}.type`);
    // WM2: only a revolute joint turns on and on; present means `true`.
    const continuous = Object.hasOwn(j, 'continuous');
    if (continuous && (j.continuous !== true || (type && type !== 'revolute')))
      c.error('joint-continuous', `${path}.continuous`);
    const angleUse = continuous ? 'continuous' : 'joint';
    connector(c, j.parent, `${path}.parent`, 'parent', ctx);
    const child = j.child;
    const cp = `${path}.child`;
    if (!record(child) || !c.keys(child, ['componentId', 'connector'], cp))
      c.error('joint-child', cp);
    else {
      connector(c, child.connector, `${cp}.connector`, 'child', ctx);
      const id = child.componentId;
      if (typeof id !== 'string' || !ctx.componentIds.has(id))
        c.error('joint-child', `${cp}.componentId`);
      else if (parentOf.has(id) && !(typeof j.id === 'string' && ctx.mounted?.get(id)?.has(j.id)))
        c.error('joint-multiple-parents', `${cp}.componentId`);
      else if (!ctx.unplaced.has(id)) c.error('joint-child-placed', `${cp}.componentId`);
      else {
        const parent = record(j.parent) ? j.parent.componentPath : undefined;
        const on = Array.isArray(parent) ? (parent[0] as string | undefined) : undefined;
        // A copy hangs from its seed: a joint from a copy to its own seed is a cycle.
        const list = parentOf.get(id) ?? [];
        list.push(on === undefined ? on : (ctx.copies.get(on) ?? on));
        parentOf.set(id, list);
        if (!jointAt.has(id)) jointAt.set(id, i);
      }
    }
    // MR1 couplings: which values follow another joint (they are not stored in `values`).
    const coupled = new Set<string>();
    const cl = j.couplings;
    const clp = `${path}.couplings`;
    if (cl !== undefined) {
      if (!Array.isArray(cl) || !cl.length || cl.length > 3) c.error('joint-couplings', clp);
      else
        cl.forEach((x, k) => {
          const at = `${clp}[${k}]`;
          if (!record(x) || !c.keys(x, ['of', 'from', 'ratio', 'offset'], at))
            return c.error('joint-couplings', at);
          if (
            !type ||
            !cadJointValueKeys[type].includes(x.of as never) ||
            coupled.has(x.of as string)
          )
            return c.error('coupling-of', `${at}.of`);
          coupled.add(x.of as string);
          const from = x.from;
          if (!record(from) || !c.keys(from, ['joint', 'of'], `${at}.from`))
            return c.error('coupling-from', `${at}.from`);
          if (typeof from.joint !== 'string' || !ids.has(from.joint) || from.joint === j.id)
            return c.error('coupling-from', `${at}.from.joint`);
          const bound = jointSafetyBound(
            { continuous: continuous || undefined },
            x.of as CadJointValueKey,
          );
          const { ratio, offset } = x;
          if (
            typeof ratio !== 'number' ||
            !Number.isFinite(ratio) ||
            Math.abs(ratio) > cadJointLimits.couplingRatio
          )
            return c.error('coupling-ratio', `${at}.ratio`);
          if (typeof offset !== 'number' || !(Math.abs(offset) <= bound))
            return c.error('coupling-offset', `${at}.offset`);
          couplings.push({
            joint: j.id as string,
            at,
            index: i,
            of: x.of as CadJointValueKey,
            from: { joint: from.joint, of: from.of as CadJointValueKey },
            ratio,
            offset,
            continuous,
          });
        });
    }
    const values = j.values;
    const vp = `${path}.values`;
    const resolved: Record<string, number | undefined> = {};
    const own = type ? cadJointValueKeys[type].filter((k) => !coupled.has(k)) : [];
    if (!record(values)) c.error('joint-values', vp);
    else if (type && c.keys(values, own, vp))
      for (const key of own)
        resolved[key] = isJointAngleKey(key)
          ? c.angle(values[key], `${vp}.${key}`, angleUse)
          : c.length(values[key], `${vp}.${key}`, 'coordinate');
    if (type && typeof j.id === 'string' && !typed.has(j.id))
      typed.set(j.id, { type, values: resolved });
    const limits = j.limits;
    const lp = `${path}.limits`;
    if (!Array.isArray(limits) || limits.length > 4) return c.error('joint-limits', lp);
    // WM2: a continuous joint has no range (it would stop the turns).
    if (continuous && limits.length) return c.error('joint-continuous-limits', lp);
    const limitList: { of: string; min: number; max: number }[] = [];
    const seen = new Set<string>();
    limits.forEach((l, k) => {
      const at = `${lp}[${k}]`;
      if (!record(l) || !c.keys(l, ['of', 'min', 'max'], at)) return c.error('joint-limits', at);
      if (!type || !cadJointValueKeys[type].includes(l.of as never) || seen.has(l.of as string))
        return c.error('joint-limit-of', `${at}.of`);
      seen.add(l.of as string);
      const bound = isJointAngleKey(l.of as CadJointValueKey)
        ? cadJointLimits.angleRad
        : cadJointLimits.lengthMm;
      const { min, max } = l;
      if (
        typeof min !== 'number' ||
        typeof max !== 'number' ||
        !(Math.abs(min) <= bound && Math.abs(max) <= bound && min <= max)
      )
        return c.error('joint-limits', at);
      limitList.push({ of: l.of as string, min, max });
      const value = resolved[l.of as string];
      if (value !== undefined && !(value >= min && value <= max))
        c.error('joint-limit', `${vp}.${l.of as string}`);
    });
    if (typeof j.id === 'string' && typed.get(j.id)?.values === resolved)
      limitsOf.set(j.id, limitList);
  });
  checkCouplings(c, couplings, typed, limitsOf);
  for (const [id, i] of ctx.unplaced)
    if (!parentOf.has(id)) c.error('component-unplaced', `$.components[${i}].placement`);
  // The tree: from each child up to a fixed component or this document's bodies, through every
  // candidate of a mount (MR7), so that each choice of candidates is a tree too.
  const depthOf = new Map<string, number>();
  const visiting = new Set<string>();
  const cyclic = new Set<string>();
  const depth = (id: string): number => {
    const known = depthOf.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) {
      cyclic.add(id);
      return Infinity;
    }
    visiting.add(id);
    let d = 0;
    for (const p of parentOf.get(id) ?? [])
      d = Math.max(d, 1 + (p !== undefined && parentOf.has(p) ? depth(p) : 0));
    visiting.delete(id);
    depthOf.set(id, d);
    return d;
  };
  for (const start of parentOf.keys()) {
    const d = depth(start);
    if (d === Infinity || cyclic.has(start))
      c.error('joint-cycle', `$.joints[${jointAt.get(start)!}]`);
    else if (d > cadJointLimits.depth)
      c.error('limit-joint-depth', `$.joints[${jointAt.get(start)!}]`);
  }
}

/**
 * MR1: each coupling follows a value its source joint has, of the same kind; the couplings
 * have no cycle; and each followed value, from the stored values, stays within one turn (an
 * angle; WM2: `continuousRad` on a continuous joint) and within its joint's limits.
 */
function checkCouplings(
  c: JointCheck,
  couplings: {
    joint: string;
    at: string;
    of: CadJointValueKey;
    from: { joint: string; of: CadJointValueKey };
    ratio: number;
    offset: number;
    continuous: boolean;
  }[],
  typed: ReadonlyMap<string, { type: CadJointType; values: Record<string, number | undefined> }>,
  limitsOf: ReadonlyMap<string, { of: string; min: number; max: number }[]>,
) {
  const good = couplings.filter((x) => {
    const from = typed.get(x.from.joint);
    if (!from) return false;
    if (!cadJointValueKeys[from.type].includes(x.from.of))
      return (c.error('coupling-from', `${x.at}.from.of`), false);
    if (isJointAngleKey(x.of) !== isJointAngleKey(x.from.of))
      return (c.error('coupling-kind', `${x.at}.from.of`), false);
    return true;
  });
  const next = new Map<string, string[]>();
  for (const x of good) next.set(x.joint, [...(next.get(x.joint) ?? []), x.from.joint]);
  // A cycle: following sources from a joint comes back to it.
  const cyclic = new Set<string>();
  for (const start of next.keys()) {
    const seen = new Set<string>();
    const stack = [...(next.get(start) ?? [])];
    while (stack.length) {
      const at = stack.pop()!;
      if (at === start) {
        cyclic.add(start);
        break;
      }
      if (seen.has(at)) continue;
      seen.add(at);
      stack.push(...(next.get(at) ?? []));
    }
  }
  let reported = false;
  for (const x of good)
    if (cyclic.has(x.joint) && !reported) {
      c.error('coupling-cycle', x.at);
      reported = true;
    }
  if (cyclic.size) return;
  const memo = new Map<string, number | undefined>();
  const byTarget = new Map(good.map((x) => [`${x.joint} ${x.of}`, x]));
  const value = (joint: string, of: string): number | undefined => {
    const key = `${joint} ${of}`;
    if (memo.has(key)) return memo.get(key);
    const x = byTarget.get(key);
    let v: number | undefined;
    if (!x) v = typed.get(joint)?.values[of];
    else {
      const from = value(x.from.joint, x.from.of);
      v = from === undefined ? undefined : x.ratio * from + x.offset;
    }
    memo.set(key, v);
    return v;
  };
  for (const x of good) {
    const v = value(x.joint, x.of);
    if (v === undefined) continue;
    const bound = jointSafetyBound({ continuous: x.continuous || undefined }, x.of);
    if (!(Math.abs(v) <= bound)) {
      c.error('coupling-range', x.at);
      continue;
    }
    const l = limitsOf.get(x.joint)?.find((y) => y.of === x.of);
    if (l && !(v >= l.min && v <= l.max)) c.error('joint-limit', x.at);
  }
}
