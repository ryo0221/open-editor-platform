/**
 * Validation of R2b-2 joints (docs/cad/r2b-assembly.md, Connectorとjoint), run by
 * `validateAssembly`: the tree rules, connector shapes, values and limits. Whether a connector
 * resolves, and whether a child's stored pose matches its joint, needs part evaluations and is
 * checked after them (CadAssemblyPort).
 */
import { parseCopyStep } from './assembly';
import { cadJointLimits, cadJointValueKeys, type CadJointType } from './joints';
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
  angle(v: unknown, path: string, use: 'dimension' | 'joint'): number | undefined;
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
  /** Each child with the parent component of its joint (undefined: this document's bodies). */
  const parentOf = new Map<string, string | undefined>();
  /** The index of each child's joint. */
  const jointAt = new Map<string, number>();
  list.forEach((j, i) => {
    const path = `$.joints[${i}]`;
    if (!record(j)) return c.error('joint', path);
    c.keys(j, ['id', 'name', 'type', 'parent', 'child', 'values', 'limits'], path);
    c.id(j.id, `${path}.id`);
    c.name(j.name, `${path}.name`);
    const type =
      typeof j.type === 'string' && Object.hasOwn(cadJointValueKeys, j.type)
        ? (j.type as CadJointType)
        : undefined;
    if (!type) c.error('joint-type', `${path}.type`);
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
      else if (parentOf.has(id)) c.error('joint-multiple-parents', `${cp}.componentId`);
      else if (!ctx.unplaced.has(id)) c.error('joint-child-placed', `${cp}.componentId`);
      else {
        const parent = record(j.parent) ? j.parent.componentPath : undefined;
        const on = Array.isArray(parent) ? (parent[0] as string | undefined) : undefined;
        // A copy hangs from its seed: a joint from a copy to its own seed is a cycle.
        parentOf.set(id, on === undefined ? on : (ctx.copies.get(on) ?? on));
        jointAt.set(id, i);
      }
    }
    const values = j.values;
    const vp = `${path}.values`;
    const resolved: Record<string, number | undefined> = {};
    if (!record(values)) c.error('joint-values', vp);
    else if (type && c.keys(values, [...cadJointValueKeys[type]], vp))
      for (const key of cadJointValueKeys[type])
        resolved[key] =
          key === 'angle'
            ? c.angle(values[key], `${vp}.${key}`, 'joint')
            : c.length(values[key], `${vp}.${key}`, 'coordinate');
    const limits = j.limits;
    const lp = `${path}.limits`;
    if (!Array.isArray(limits) || limits.length > 4) return c.error('joint-limits', lp);
    const seen = new Set<string>();
    limits.forEach((l, k) => {
      const at = `${lp}[${k}]`;
      if (!record(l) || !c.keys(l, ['of', 'min', 'max'], at)) return c.error('joint-limits', at);
      if (!type || !cadJointValueKeys[type].includes(l.of as never) || seen.has(l.of as string))
        return c.error('joint-limit-of', `${at}.of`);
      seen.add(l.of as string);
      const bound = l.of === 'angle' ? cadJointLimits.angleRad : 1_000_000;
      const { min, max } = l;
      if (
        typeof min !== 'number' ||
        typeof max !== 'number' ||
        !(Math.abs(min) <= bound && Math.abs(max) <= bound && min <= max)
      )
        return c.error('joint-limits', at);
      const value = resolved[l.of as string];
      if (value !== undefined && !(value >= min && value <= max))
        c.error('joint-limit', `${vp}.${l.of as string}`);
    });
  });
  for (const [id, i] of ctx.unplaced)
    if (!parentOf.has(id)) c.error('component-unplaced', `$.components[${i}].placement`);
  // The tree: from each child up to a fixed component or this document's bodies.
  for (const start of parentOf.keys()) {
    const seen = new Set([start]);
    let at: string | undefined = start;
    let depth = 0;
    while (at !== undefined && parentOf.has(at)) {
      at = parentOf.get(at);
      depth++;
      if (at !== undefined && seen.has(at)) {
        c.error('joint-cycle', `$.joints[${jointAt.get(start)!}]`);
        break;
      }
      if (at !== undefined) seen.add(at);
      if (depth > cadJointLimits.depth) {
        c.error('limit-joint-depth', `$.joints[${jointAt.get(start)!}]`);
        break;
      }
    }
  }
}
