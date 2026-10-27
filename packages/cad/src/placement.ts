/**
 * The placement fields of a fixed component (R2b-1): six texts (mm, then XYZ degrees) and the
 * placement they describe. A position may read parameters: its field shows the parameter or
 * expression, and an edited field takes a number or a length expression (ST-86).
 */
import { Euler, Quaternion as ThreeQuaternion } from 'three';
import {
  formatExpression,
  mm,
  multiplyQuaternions,
  type CadComponentPlacement,
  type CadDocument,
  type CadSolvedPose,
  type Length,
  type Position3,
  type Quaternion,
  type Vec3,
} from '@editor-platform/cad-core';
import { readCadInput } from './expression-input';

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
const toDegrees = (q: Quaternion): Vec3 => {
  const e = new Euler().setFromQuaternion(new ThreeQuaternion(...q), 'XYZ');
  return [e.x, e.y, e.z].map((r) => (r * 180) / Math.PI) as Vec3;
};
const fromDegrees = (d: Vec3): Quaternion => {
  const q = new ThreeQuaternion().setFromEuler(
    new Euler(...(d.map((v) => (v * Math.PI) / 180) as Vec3), 'XYZ'),
  );
  return [q.x, q.y, q.z, q.w];
};

/**
 * A position that reads a parameter, as its field shows it (never edited unless changed). Names
 * are written as expressions write them, so a name that needs braces keeps them.
 */
function boundText(length: Length, doc: CadDocument): string | undefined {
  const name = (id: string) => doc.parameters.find((p) => p.id === id)?.name ?? id;
  if ('literalMm' in length) return undefined;
  if ('expression' in length) return formatExpression(length.expression, name);
  if ('parameterId' in length)
    return formatExpression({ postfix: [{ parameterId: length.parameterId }] }, name);
  const { parameterId, scale, offsetMm } = length.affine;
  return formatExpression(
    {
      postfix: [
        { parameterId },
        { number: scale },
        { operator: 'mul' },
        { number: Math.abs(offsetMm), unit: 'mm' },
        { operator: offsetMm < 0 ? 'sub' : 'add' },
      ],
    },
    name,
  );
}

/**
 * The six placement fields as shown (mm, then XYZ degrees), rounded for display. With the
 * component's placement, a position that reads a parameter shows what it reads.
 */
export const placementFields = (
  pose: CadSolvedPose,
  placement?: CadComponentPlacement | null,
  doc?: CadDocument,
) => [
  ...pose.translationMm.map((v, i) => {
    const l = placement?.translation[i];
    return (l && doc && boundText(l, doc)) ?? fmt(v);
  }),
  ...toDegrees(pose.rotation).map(fmt),
];
/**
 * The placement the fields describe. A field left as shown keeps its stored value (a literal
 * never becomes the rounded text, a bound position keeps what it reads); untouched rotation
 * fields keep the stored rotation exactly. A changed position is a number or a length
 * expression over the document's parameters; a bad one throws the field's message.
 */
export function editedPlacement(
  pose: CadSolvedPose,
  shown: string[],
  fields: string[],
  doc: CadDocument,
  placement?: CadComponentPlacement | null,
): [Position3, Quaternion] {
  const kept = (i: number) => fields[i] === shown[i];
  const degrees = toDegrees(pose.rotation);
  const translation = pose.translationMm.map((v, i): Length => {
    if (kept(i)) return placement?.translation[i] ?? mm(v);
    const read = readCadInput(fields[i]!, doc, 'length');
    return 'literal' in read ? mm(read.literal) : read;
  }) as Position3;
  return [
    translation,
    [3, 4, 5].every(kept)
      ? pose.rotation
      : fromDegrees(degrees.map((v, k) => (kept(k + 3) ? v : Number(fields[k + 3]))) as Vec3),
  ];
}
/** Each changed position reads as a length; each rotation field holds a finite number. */
export function validPlacement(fields: string[], shown: string[], doc: CadDocument) {
  if (fields.length !== 6) return false;
  return fields.every((f, i) => {
    if (f === shown[i]) return true;
    if (i >= 3) return f.trim() !== '' && Number.isFinite(Number(f));
    try {
      readCadInput(f, doc, 'length');
      return true;
    } catch {
      return false;
    }
  });
}

/** Planes through the origin that a copy is mirrored across (`yz` flips X, and so on). */
export type CadMirrorPlane = 'yz' | 'xz' | 'xy';
const flipped = { yz: 0, xz: 1, xy: 2 } as const;
const negate = (l: Length): Length => {
  if ('literalMm' in l) return mm(-l.literalMm);
  if ('affine' in l)
    return { affine: { ...l.affine, scale: -l.affine.scale, offsetMm: -l.affine.offsetMm } };
  const postfix = 'expression' in l ? l.expression.postfix : [{ parameterId: l.parameterId }];
  return { expression: { postfix: [...postfix, { operator: 'neg' }] } };
};
/**
 * The placement of a copy on the other side of a plane through the origin. A placement cannot
 * reflect a part, so the copy is the part turned half a turn: about Z for a plane that holds Z
 * (a wheel's hub then faces out on both sides), about X for the XY plane. The position across
 * the plane is the negated length, so a position that reads a parameter keeps reading it.
 */
export function mirroredPlacement(
  placement: CadComponentPlacement,
  plane: CadMirrorPlane,
): CadComponentPlacement {
  const k = flipped[plane];
  const half: Quaternion = plane === 'xy' ? [1, 0, 0, 0] : [0, 0, 1, 0];
  return {
    translation: placement.translation.map((l, i) => (i === k ? negate(l) : l)) as Position3,
    rotation: multiplyQuaternions(half, placement.rotation),
  };
}
