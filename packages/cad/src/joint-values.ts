/**
 * The value fields of a joint (R2b-2): one text per value its type reads, an angle in degrees
 * and a length in mm, and the values they describe.
 */
import {
  cadJointValueKeys,
  jointValues,
  mm,
  parameterValues,
  type CadDocument,
  type CadJoint,
  type CadJointValueKey,
  type CadJointValues,
} from '@editor-platform/cad-core';

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
export const jointValueLabels: Record<CadJointValueKey, string> = {
  angle: 'Angle (°)',
  distance: 'Distance (mm)',
  u: 'U (mm)',
  v: 'V (mm)',
};

/** The joint's value fields as shown (degrees, mm), rounded for display, in its type's order. */
export function jointFields(joint: CadJoint, doc: Pick<CadDocument, 'parameters'>) {
  const values = jointValues(joint, parameterValues(doc));
  return cadJointValueKeys[joint.type].map((k) =>
    fmt(k === 'angle' ? ((values[k] ?? 0) * 180) / Math.PI : (values[k] ?? 0)),
  );
}
/** Values whose stored form is a literal: a parameter or an expression is changed there. */
export const jointValueBound = (joint: CadJoint, key: CadJointValueKey) => {
  const v = joint.values[key];
  return !!v && !('literalMm' in v) && !('literalRad' in v);
};
/**
 * The values the fields describe. A field left as shown keeps its stored value (a parameter, an
 * expression or the exact literal), never the rounded text.
 */
export function editedJointValues(
  joint: CadJoint,
  shown: string[],
  fields: string[],
): CadJointValues {
  const out: CadJointValues = {};
  cadJointValueKeys[joint.type].forEach((k, i) => {
    if (fields[i] === shown[i] && joint.values[k]) {
      (out as Record<string, unknown>)[k] = joint.values[k];
      return;
    }
    const n = Number(fields[i]);
    if (k === 'angle') out.angle = { literalRad: (n * Math.PI) / 180 };
    else out[k] = mm(n);
  });
  return out;
}
export const validJointFields = (joint: CadJoint, fields: string[]) =>
  fields.length === cadJointValueKeys[joint.type].length &&
  fields.every((f) => f.trim() !== '' && Number.isFinite(Number(f)));
/** A limit as shown beside its field, in the field's unit. */
export function limitText(joint: CadJoint, key: CadJointValueKey) {
  const l = joint.limits.find((x) => x.of === key);
  if (!l) return undefined;
  const k = key === 'angle' ? 180 / Math.PI : 1;
  return `${fmt(l.min * k)} – ${fmt(l.max * k)}`;
}
