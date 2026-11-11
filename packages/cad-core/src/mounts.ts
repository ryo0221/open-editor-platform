/**
 * MR7 (docs/cad/mecha-design.md, MR7（持ち替え）): a component with two to four candidate joints
 * (a rifle in the hand or on the back), only one of them in effect. The joints stay a tree for
 * every choice; a joint that is not in effect keeps its values and limits but places nothing.
 */
import type { CadJoint } from './joints';
import type { CadDocument } from './model';

export interface CadMount {
  id: string;
  name: string;
  /** The top-level component every candidate joint places. */
  component: string;
  /** Two to four joints whose child is `component`, in the order they are listed. */
  joints: string[];
  /** The joint in effect. */
  active: string;
}

export const cadMountLimits = Object.freeze({ mounts: 64, joints: 4 });
/** A switch between two candidates moves the part no more than this ("ずれなし"). */
export const cadMountTolerance = Object.freeze({ mm: 0.5, rad: (0.5 * Math.PI) / 180 });

/** Which joint is in effect for each mount (its ID to a joint ID). */
export type CadMountChoice = ReadonlyMap<string, string>;

export type CadMountOperation =
  /** One edit, one Undo: another candidate placed the component. */
  | { type: 'setMount'; mountId: string; jointId: string }
  /**
   * A new joint for a component another joint already places, as a candidate: a new mount (the
   * existing joint stays in effect) or one more candidate of the component's mount.
   */
  | {
      type: 'insertMountJoint';
      joint: CadJoint;
      mount: { id: string; name: string } | { id: string };
    }
  /** The mount removed with its candidates that are not in effect; the joint in effect stays. */
  | { type: 'removeMount'; mountId: string };

const fail = (code: string): never => {
  throw new Error(code);
};

/** The joints not in effect: every candidate but the chosen one (`choice` over `active`). */
export function inactiveJointIds(
  doc: Pick<CadDocument, 'mounts'>,
  choice?: CadMountChoice,
): Set<string> {
  const out = new Set<string>();
  for (const m of doc.mounts ?? []) {
    const chosen = choice?.get(m.id);
    const on = chosen !== undefined && m.joints.includes(chosen) ? chosen : m.active;
    for (const j of m.joints) if (j !== on) out.add(j);
  }
  return out;
}
/** The joints that place their children for a choice of mounts (the document's own by default). */
export function activeJoints<J extends Pick<CadJoint, 'id'>>(
  doc: { joints: J[]; mounts?: CadMount[] },
  choice?: CadMountChoice,
): J[] {
  const off = inactiveJointIds(doc, choice);
  return off.size ? doc.joints.filter((j) => !off.has(j.id)) : doc.joints;
}
/** Each mount's joint in effect, as a form stores it; undefined without mounts. */
export function currentMounts(doc: Pick<CadDocument, 'mounts'>) {
  return doc.mounts?.length
    ? Object.fromEntries(doc.mounts.map((m) => [m.id, m.active]))
    : undefined;
}
/** Whether stored choices no longer fit the mounts: one missing, unknown, or not a candidate. */
export function mountsStale(
  doc: Pick<CadDocument, 'mounts'>,
  mounts: Record<string, string> | undefined,
) {
  const list = doc.mounts ?? [];
  const given = mounts ?? {};
  if (Object.keys(given).length !== list.length) return true;
  return list.some((m) => !Object.hasOwn(given, m.id) || !m.joints.includes(given[m.id]!));
}
export const mountChoice = (mounts: Record<string, string> | undefined): CadMountChoice =>
  new Map(Object.entries(mounts ?? {}));

/**
 * After joints were removed: each mount keeps its remaining candidates; one left is no mount
 * (it simply places the component), and a removed joint in effect hands over to the first one
 * left.
 */
export function pruneMounts(doc: CadDocument) {
  if (!doc.mounts) return;
  const ids = new Set(doc.joints.map((j) => j.id));
  const kept: CadMount[] = [];
  for (const m of doc.mounts) {
    const joints = m.joints.filter((j) => ids.has(j));
    if (joints.length < 2) continue;
    kept.push({ ...m, joints, active: joints.includes(m.active) ? m.active : joints[0]! });
  }
  if (kept.length) doc.mounts = kept;
  else delete doc.mounts;
}

export function applyMountOperation(next: CadDocument, op: CadMountOperation) {
  const list = next.mounts ?? [];
  switch (op.type) {
    case 'setMount': {
      const m = list.find((x) => x.id === op.mountId) ?? fail('target-missing');
      if (!m.joints.includes(op.jointId)) fail('mount-joint');
      m.active = op.jointId;
      return next;
    }
    case 'insertMountJoint': {
      const component = op.joint.child.componentId;
      const placing = next.joints.filter((j) => j.child.componentId === component);
      if (!placing.length) fail('mount-component-unplaced');
      const existing = list.find((x) => x.component === component);
      if ('name' in op.mount) {
        if (existing) fail('mount-exists');
        if (list.length >= cadMountLimits.mounts) fail('limit-mounts');
        next.mounts = [
          ...list,
          {
            id: op.mount.id,
            name: op.mount.name,
            component,
            joints: [placing[0]!.id, op.joint.id],
            active: placing[0]!.id,
          },
        ];
      } else {
        const m = existing?.id === op.mount.id ? existing : fail('target-missing');
        if (m.joints.length >= cadMountLimits.joints) fail('limit-mount-joints');
        m.joints.push(op.joint.id);
      }
      next.joints.push(op.joint);
      return next;
    }
    case 'removeMount': {
      const m = list.find((x) => x.id === op.mountId) ?? fail('target-missing');
      const off = new Set(m.joints.filter((j) => j !== m.active));
      next.joints = next.joints.filter((j) => !off.has(j.id));
      // A coupling or an allowance on a removed candidate would be left dangling: refused.
      for (const j of next.joints)
        if ((j.couplings ?? []).some((c) => off.has(c.from.joint))) fail('mount-joint-in-use');
      for (const a of next.interferenceAllowances ?? [])
        if (a.region.kind === 'joint-sphere' && off.has(a.region.joint)) fail('mount-joint-in-use');
      const rest = list.filter((x) => x.id !== m.id);
      if (rest.length) next.mounts = rest;
      else delete next.mounts;
      return next;
    }
  }
}

type Rec = Record<string, unknown>;
const record = (v: unknown): v is Rec =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
/** The part of validation's `Check` the mount rules use. */
export interface MountCheck {
  error(code: string, path: string): boolean;
  keys(v: Rec, required: string[], path: string, optional?: string[]): boolean;
  id(v: unknown, path: string): v is string;
  name(v: unknown, path: string): boolean;
}

/**
 * The candidates of each mounted component, read loosely from a document being validated (for
 * the joint rules: a component may have several joints only when its mount lists them all).
 */
export function mountedJoints(value: unknown): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (!Array.isArray(value)) return out;
  for (const m of value)
    if (record(m) && typeof m.component === 'string' && Array.isArray(m.joints))
      out.set(m.component, new Set(m.joints.filter((j): j is string => typeof j === 'string')));
  return out;
}

/**
 * The shape of `mounts` (1–64 when present): IDs, a name, a placed top-level component, two to
 * four distinct joints that place it, the joint in effect among them, one mount per component,
 * and no joint in two mounts. Every joint placing the component must be listed.
 */
export function validateMounts(
  c: MountCheck,
  list: unknown,
  joints: readonly unknown[],
  componentIds: ReadonlySet<string>,
) {
  const path = '$.mounts';
  if (!Array.isArray(list) || list.length === 0) return c.error('mounts', path);
  if (list.length > cadMountLimits.mounts) c.error('limit-mounts', path);
  const childOf = new Map<string, string>();
  for (const j of joints)
    if (record(j) && typeof j.id === 'string' && record(j.child))
      childOf.set(j.id, j.child.componentId as string);
  const components = new Set<string>();
  const used = new Set<string>();
  list.forEach((m, i) => {
    const at = `${path}[${i}]`;
    if (!record(m) || !c.keys(m, ['id', 'name', 'component', 'joints', 'active'], at))
      return c.error('mount', at);
    c.id(m.id, `${at}.id`);
    if (c.name(m.name, `${at}.name`) && (m.name as string).trim() === '')
      c.error('mount-name', `${at}.name`);
    const component = m.component;
    if (typeof component !== 'string' || !componentIds.has(component))
      c.error('mount-component', `${at}.component`);
    else if (components.has(component)) c.error('mount-component-twice', `${at}.component`);
    else components.add(component);
    const js = m.joints;
    if (
      !Array.isArray(js) ||
      js.length < 2 ||
      js.length > cadMountLimits.joints ||
      new Set(js).size !== js.length
    )
      return c.error('mount-joints', `${at}.joints`);
    js.forEach((j, k) => {
      const jp = `${at}.joints[${k}]`;
      if (typeof j !== 'string' || !childOf.has(j)) return c.error('mount-joint', jp);
      if (childOf.get(j) !== component) c.error('mount-joint-child', jp);
      if (used.has(j)) c.error('mount-joint-twice', jp);
      used.add(j);
    });
    if (typeof m.active !== 'string' || !js.includes(m.active))
      c.error('mount-active', `${at}.active`);
    if (typeof component === 'string')
      for (const [j, child] of childOf)
        if (child === component && !js.includes(j)) c.error('mount-joint-missing', `${at}.joints`);
  });
}
