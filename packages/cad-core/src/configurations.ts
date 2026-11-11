/**
 * MR2 forms (docs/cad/mecha-design.md, MR2（形態）): named sets of joint values in the assembly
 * document. Validation checks a form's shape only; whether it still fits the joints (stale) and
 * their limits is checked when it is recalled or overwritten.
 */
import { parameterValues } from './graph';
import {
  cadJointLimits,
  cadJointValueKeys,
  coupledJointValues,
  isJointAngleKey,
  jointLimitViolations,
  jointValues,
  ownJointValueKeys,
  type CadJoint,
  type CadJointValues,
} from './joints';
import type { CadDocument } from './model';
import { mountsStale } from './mounts';

export interface CadConfiguration {
  id: string;
  name: string;
  /** Each moving joint's own values when the form was saved (coupled values are not stored). */
  values: Record<string, CadJointValues>;
  /** MR7: each mount's joint in effect in this form (present exactly when the document has mounts). */
  mounts?: Record<string, string>;
}
/** What a form holds, as an edit gives it. */
export type CadConfigurationState = Pick<CadConfiguration, 'values' | 'mounts'>;

export const cadConfigurationLimits = Object.freeze({ configurations: 32 });
/** "This is the current form" within these (MR2: 0.01° and 0.001 mm). */
export const cadConfigurationTolerance = Object.freeze({
  angleRad: (0.01 * Math.PI) / 180,
  lengthMm: 0.001,
});

export type CadConfigurationOperation =
  /** The current values saved as a new form. */
  | { type: 'insertConfiguration'; configuration: CadConfiguration }
  /** A form's values (and mounts) replaced by the current ones (the same ID and name). */
  | {
      type: 'overwriteConfiguration';
      id: string;
      values: Record<string, CadJointValues>;
      mounts?: Record<string, string>;
    }
  | { type: 'renameConfiguration'; id: string; name: string }
  | { type: 'removeConfiguration'; id: string }
  /** Every moving joint set to the form's values, each mount to its joint: one edit, one Undo. */
  | { type: 'recallConfiguration'; id: string };

const fail = (code: string): never => {
  throw new Error(code);
};

/** Joints with a value of their own: the ones a form holds. */
export const movingJoints = (doc: Pick<CadDocument, 'joints'>) =>
  doc.joints.filter((j) => ownJointValueKeys(j).length > 0);
/**
 * Whether a document has anything a form records: a joint with values of its own, or a mount
 * (MR7: switching one moves its part, so an assembly whose joints are all fastened has forms too).
 */
export const configurationsApply = (doc: Pick<CadDocument, 'joints' | 'mounts'>) =>
  movingJoints(doc).length > 0 || (doc.mounts ?? []).length > 0;

/**
 * The current own values of every moving joint, as a form stores them: resolved to literals, so
 * a form never reads a parameter (deleting one never touches the forms; recalling a form sets
 * literal values, as a drag does).
 */
export function currentConfigurationValues(doc: CadDocument) {
  const params = parameterValues(doc);
  return Object.fromEntries(
    movingJoints(doc).map((j) => {
      const resolved = jointValues(j, params);
      const values: CadJointValues = {};
      for (const k of ownJointValueKeys(j)) {
        const v = resolved[k] ?? 0;
        if (isJointAngleKey(k)) (values as Record<string, unknown>)[k] = { literalRad: v };
        else (values as Record<string, unknown>)[k] = { literalMm: v };
      }
      return [j.id, values];
    }),
  ) as Record<string, CadJointValues>;
}

/**
 * Whether a form no longer fits the joints: a moving joint it does not name, a joint it names
 * that is gone or does not move, values that are not the joint's own keys, or mounts that do not
 * match the document's (MR7).
 */
export function configurationStale(
  doc: Pick<CadDocument, 'joints' | 'mounts'>,
  form: CadConfigurationState,
) {
  const { values } = form;
  if (mountsStale(doc, form.mounts)) return true;
  const moving = movingJoints(doc);
  if (Object.keys(values).length !== moving.length) return true;
  return moving.some((j) => {
    const v = Object.hasOwn(values, j.id) ? values[j.id] : undefined;
    if (!v) return true;
    const own = ownJointValueKeys(j);
    const keys = Object.keys(v);
    return keys.length !== own.length || !own.every((k) => Object.hasOwn(v, k));
  });
}

/** The joints with a form's values in place of their own (the form must not be stale). */
const withValues = (joints: readonly CadJoint[], values: Record<string, CadJointValues>) =>
  joints.map((j) =>
    Object.hasOwn(values, j.id) ? { ...j, values: structuredClone(values[j.id]!) } : j,
  );

/** Each joint value a form would put outside its limits (couplings applied). */
export function configurationLimitViolations(
  doc: CadDocument,
  values: Record<string, CadJointValues>,
) {
  const joints = withValues(doc.joints, values);
  return jointLimitViolations({ joints }, coupledJointValues({ joints }, parameterValues(doc)));
}

/** The forms that are not stale and whose values equal the current ones within the tolerance. */
export function matchingConfigurations(doc: CadDocument): string[] {
  const params = parameterValues(doc);
  return (doc.configurations ?? [])
    .filter((f) => {
      if (configurationStale(doc, f)) return false;
      if ((doc.mounts ?? []).some((m) => f.mounts?.[m.id] !== m.active)) return false;
      return movingJoints(doc).every((j) => {
        const now = jointValues(j, params);
        const then = jointValues({ type: j.type, values: f.values[j.id]! }, params);
        return ownJointValueKeys(j).every((k) => {
          const a = now[k];
          const b = then[k];
          if (a === undefined || b === undefined) return false;
          const tol = isJointAngleKey(k)
            ? cadConfigurationTolerance.angleRad
            : cadConfigurationTolerance.lengthMm;
          return Math.abs(a - b) <= tol;
        });
      });
    })
    .map((f) => f.id);
}

export function applyConfigurationOperation(next: CadDocument, op: CadConfigurationOperation) {
  const list = next.configurations ?? [];
  const find = (id: string) => list.find((f) => f.id === id) ?? fail('target-missing');
  switch (op.type) {
    case 'insertConfiguration': {
      if (list.length >= cadConfigurationLimits.configurations) fail('limit-configurations');
      if (configurationStale(next, op.configuration)) fail('configuration-stale');
      next.configurations = [...list, structuredClone(op.configuration)];
      return next;
    }
    case 'overwriteConfiguration': {
      const f = find(op.id);
      if (configurationStale(next, op)) fail('configuration-stale');
      f.values = structuredClone(op.values);
      if (op.mounts) f.mounts = { ...op.mounts };
      else delete f.mounts;
      return next;
    }
    case 'renameConfiguration':
      find(op.id).name = op.name;
      return next;
    case 'removeConfiguration': {
      find(op.id);
      const rest = list.filter((f) => f.id !== op.id);
      if (rest.length) next.configurations = rest;
      else delete next.configurations;
      return next;
    }
    case 'recallConfiguration': {
      const f = find(op.id);
      if (configurationStale(next, f)) fail('configuration-stale');
      if (configurationLimitViolations(next, f.values).length) fail('configuration-limit');
      for (const j of next.joints)
        if (Object.hasOwn(f.values, j.id)) j.values = structuredClone(f.values[j.id]!);
      for (const m of next.mounts ?? []) m.active = f.mounts![m.id]!;
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
/** The part of validation's `Check` the form rules use. */
export interface ConfigurationCheck {
  error(code: string, path: string): boolean;
  keys(v: Rec, required: string[], path: string, optional?: string[]): boolean;
  id(v: unknown, path: string): v is string;
  name(v: unknown, path: string): boolean;
  length(v: unknown, path: string, use: 'coordinate' | 'dimension'): number | undefined;
  angle(v: unknown, path: string, use: 'dimension' | 'joint' | 'continuous'): number | undefined;
}
const valueKeys = new Set(Object.values(cadJointValueKeys).flat());

/**
 * The shape of `configurations` (validated in every document): 1–32 forms with unique IDs, each
 * value typed by its key. Whether the joints still match is not checked here.
 */
export function validateConfigurations(
  c: ConfigurationCheck,
  list: unknown,
  isId: (v: unknown) => boolean,
) {
  const path = '$.configurations';
  if (!Array.isArray(list) || list.length === 0) return c.error('configurations', path);
  if (list.length > cadConfigurationLimits.configurations) c.error('limit-configurations', path);
  list.forEach((f, i) => {
    const at = `${path}[${i}]`;
    if (!record(f) || !c.keys(f, ['id', 'name', 'values'], at, ['mounts']))
      return c.error('configuration', at);
    if (Object.hasOwn(f, 'mounts')) {
      const m = f.mounts;
      const mp = `${at}.mounts`;
      if (!record(m) || Object.keys(m).length === 0) c.error('configuration-mounts', mp);
      else
        for (const [id, joint] of Object.entries(m))
          if (!isId(id) || !isId(joint)) c.error('configuration-mounts', `${mp}.${id}`);
    }
    c.id(f.id, `${at}.id`);
    // A form is chosen by its name in a list: it has one.
    if (c.name(f.name, `${at}.name`) && (f.name as string).trim() === '')
      c.error('configuration-name', `${at}.name`);
    const values = f.values;
    const vp = `${at}.values`;
    if (!record(values) || Object.keys(values).length > cadJointLimits.joints)
      return c.error('configuration-values', vp);
    for (const [joint, v] of Object.entries(values)) {
      const jp = `${vp}.${joint}`;
      if (!isId(joint)) c.error('configuration-joint', jp);
      if (!record(v) || Object.keys(v).length === 0) {
        c.error('configuration-values', jp);
        continue;
      }
      for (const [key, x] of Object.entries(v)) {
        if (!valueKeys.has(key as never)) c.error('unknown-field', `${jp}.${key}`);
        // A form holds literals only: it never reads a parameter (`currentConfigurationValues`).
        else if (
          record(x) &&
          !Object.hasOwn(x, isJointAngleKey(key as never) ? 'literalRad' : 'literalMm')
        )
          c.error('configuration-literal', `${jp}.${key}`);
        // The widest bound (a continuous joint's, WM2): each joint's own bound is checked with
        // its limits (`configurationLimitViolations`).
        else if (isJointAngleKey(key as never)) c.angle(x, `${jp}.${key}`, 'continuous');
        else c.length(x, `${jp}.${key}`, 'coordinate');
      }
    }
  });
}
