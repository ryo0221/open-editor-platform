import type { Quat, Transform3, Vec3 } from './model';

/** A column-major 4×4 matrix. */
export type Mat4 = number[];

export const identityMat4 = (): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** M = T · R · S of a transform. */
export function composeMat4(t: Transform3): Mat4 {
  const [x, y, z, w] = normalizeQuat(t.rotation);
  const [sx, sy, sz] = t.scale;
  const xx = x * x,
    yy = y * y,
    zz = z * z,
    xy = x * y,
    xz = x * z,
    yz = y * z,
    wx = w * x,
    wy = w * y,
    wz = w * z;
  return [
    (1 - 2 * (yy + zz)) * sx,
    2 * (xy + wz) * sx,
    2 * (xz - wy) * sx,
    0,
    2 * (xy - wz) * sy,
    (1 - 2 * (xx + zz)) * sy,
    2 * (yz + wx) * sy,
    0,
    2 * (xz + wy) * sz,
    2 * (yz - wx) * sz,
    (1 - 2 * (xx + yy)) * sz,
    0,
    t.translation[0],
    t.translation[1],
    t.translation[2],
    1,
  ];
}
export function multiplyMat4(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  return out;
}
/** The inverse of a 4×4 matrix, or null when it is singular. */
export function invertMat4(m: Mat4): Mat4 | null {
  const inv = new Array<number>(16);
  inv[0] =
    m[5] * m[10] * m[15] -
    m[5] * m[11] * m[14] -
    m[9] * m[6] * m[15] +
    m[9] * m[7] * m[14] +
    m[13] * m[6] * m[11] -
    m[13] * m[7] * m[10];
  inv[4] =
    -m[4] * m[10] * m[15] +
    m[4] * m[11] * m[14] +
    m[8] * m[6] * m[15] -
    m[8] * m[7] * m[14] -
    m[12] * m[6] * m[11] +
    m[12] * m[7] * m[10];
  inv[8] =
    m[4] * m[9] * m[15] -
    m[4] * m[11] * m[13] -
    m[8] * m[5] * m[15] +
    m[8] * m[7] * m[13] +
    m[12] * m[5] * m[11] -
    m[12] * m[7] * m[9];
  inv[12] =
    -m[4] * m[9] * m[14] +
    m[4] * m[10] * m[13] +
    m[8] * m[5] * m[14] -
    m[8] * m[6] * m[13] -
    m[12] * m[5] * m[10] +
    m[12] * m[6] * m[9];
  inv[1] =
    -m[1] * m[10] * m[15] +
    m[1] * m[11] * m[14] +
    m[9] * m[2] * m[15] -
    m[9] * m[3] * m[14] -
    m[13] * m[2] * m[11] +
    m[13] * m[3] * m[10];
  inv[5] =
    m[0] * m[10] * m[15] -
    m[0] * m[11] * m[14] -
    m[8] * m[2] * m[15] +
    m[8] * m[3] * m[14] +
    m[12] * m[2] * m[11] -
    m[12] * m[3] * m[10];
  inv[9] =
    -m[0] * m[9] * m[15] +
    m[0] * m[11] * m[13] +
    m[8] * m[1] * m[15] -
    m[8] * m[3] * m[13] -
    m[12] * m[1] * m[11] +
    m[12] * m[3] * m[9];
  inv[13] =
    m[0] * m[9] * m[14] -
    m[0] * m[10] * m[13] -
    m[8] * m[1] * m[14] +
    m[8] * m[2] * m[13] +
    m[12] * m[1] * m[10] -
    m[12] * m[2] * m[9];
  inv[2] =
    m[1] * m[6] * m[15] -
    m[1] * m[7] * m[14] -
    m[5] * m[2] * m[15] +
    m[5] * m[3] * m[14] +
    m[13] * m[2] * m[7] -
    m[13] * m[3] * m[6];
  inv[6] =
    -m[0] * m[6] * m[15] +
    m[0] * m[7] * m[14] +
    m[4] * m[2] * m[15] -
    m[4] * m[3] * m[14] -
    m[12] * m[2] * m[7] +
    m[12] * m[3] * m[6];
  inv[10] =
    m[0] * m[5] * m[15] -
    m[0] * m[7] * m[13] -
    m[4] * m[1] * m[15] +
    m[4] * m[3] * m[13] +
    m[12] * m[1] * m[7] -
    m[12] * m[3] * m[5];
  inv[14] =
    -m[0] * m[5] * m[14] +
    m[0] * m[6] * m[13] +
    m[4] * m[1] * m[14] -
    m[4] * m[2] * m[13] -
    m[12] * m[1] * m[6] +
    m[12] * m[2] * m[5];
  inv[3] =
    -m[1] * m[6] * m[11] +
    m[1] * m[7] * m[10] +
    m[5] * m[2] * m[11] -
    m[5] * m[3] * m[10] -
    m[9] * m[2] * m[7] +
    m[9] * m[3] * m[6];
  inv[7] =
    m[0] * m[6] * m[11] -
    m[0] * m[7] * m[10] -
    m[4] * m[2] * m[11] +
    m[4] * m[3] * m[10] +
    m[8] * m[2] * m[7] -
    m[8] * m[3] * m[6];
  inv[11] =
    -m[0] * m[5] * m[11] +
    m[0] * m[7] * m[9] +
    m[4] * m[1] * m[11] -
    m[4] * m[3] * m[9] -
    m[8] * m[1] * m[7] +
    m[8] * m[3] * m[5];
  inv[15] =
    m[0] * m[5] * m[10] -
    m[0] * m[6] * m[9] -
    m[4] * m[1] * m[10] +
    m[4] * m[2] * m[9] +
    m[8] * m[1] * m[6] -
    m[8] * m[2] * m[5];
  const det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return inv.map((v) => v / det);
}
export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}
export function normalizeQuat(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return n > 0 ? [q[0] / n, q[1] / n, q[2] / n, q[3] / n] : [0, 0, 0, 1];
}
/** Spherical interpolation along the shorter arc. */
export function slerpQuat(a: Quat, b: Quat, t: number): Quat {
  let [bx, by, bz, bw] = b;
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  if (cos > 0.9995)
    return normalizeQuat([
      a[0] + (bx - a[0]) * t,
      a[1] + (by - a[1]) * t,
      a[2] + (bz - a[2]) * t,
      a[3] + (bw - a[3]) * t,
    ]);
  const theta = Math.acos(cos);
  const s = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / s,
    wb = Math.sin(t * theta) / s;
  return [a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb];
}
/** A rotation of `angle` radians about a unit axis. */
export function axisAngleQuat(axis: Vec3, angle: number): Quat {
  const s = Math.sin(angle / 2);
  return normalizeQuat([axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)]);
}

/**
 * Translation, rotation and scale of an affine matrix without shear (as glTF nodes are). A
 * negative determinant flips the x scale. Returns null for a singular or projective matrix.
 */
/**
 * Splits an affine matrix into translation, rotation and scale. A mirroring matrix gets one
 * negative scale: on the axes where `signs` is negative when their count agrees with the
 * determinant (so a source `scale: [1, -1, 1]` comes back as itself), else on x.
 */
export function decomposeMat4(m: Mat4, signs?: readonly number[]): Transform3 | null {
  if (
    Math.abs(m[3]) > 1e-9 ||
    Math.abs(m[7]) > 1e-9 ||
    Math.abs(m[11]) > 1e-9 ||
    Math.abs(m[15] - 1) > 1e-9
  )
    return null;
  let sx = Math.hypot(m[0], m[1], m[2]),
    sy = Math.hypot(m[4], m[5], m[6]),
    sz = Math.hypot(m[8], m[9], m[10]);
  if (sx < 1e-12 || sy < 1e-12 || sz < 1e-12) return null;
  const det =
    m[0] * (m[5] * m[10] - m[9] * m[6]) -
    m[4] * (m[1] * m[10] - m[9] * m[2]) +
    m[8] * (m[1] * m[6] - m[5] * m[2]);
  const neg = [0, 1, 2].filter((k) => (signs?.[k] ?? 1) < 0);
  if (neg.length % 2 === (det < 0 ? 1 : 0)) {
    if (neg.includes(0)) sx = -sx;
    if (neg.includes(1)) sy = -sy;
    if (neg.includes(2)) sz = -sz;
  } else if (det < 0) sx = -sx;
  const r = [
    m[0] / sx,
    m[1] / sx,
    m[2] / sx,
    m[4] / sy,
    m[5] / sy,
    m[6] / sy,
    m[8] / sz,
    m[9] / sz,
    m[10] / sz,
  ];
  // Rotation matrix (column-major r00=r[0], r10=r[1], r20=r[2], r01=r[3] …) to quaternion.
  const [m00, m10, m20, m01, m11, m21, m02, m12, m22] = r;
  const trace = m00 + m11 + m22;
  let q: Quat;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  q = normalizeQuat(q);
  if (q[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]];
  return { translation: [m[12], m[13], m[14]], rotation: q, scale: [sx, sy, sz] };
}
export function multiplyQuat(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/**
 * Euler angles in degrees, applied X then Y then Z about the fixed axes (q = qz · qy · qx), as
 * a pose inspector shows them. `quatToEulerXyz` gives angles of the same orientation (X = 0 at Y = ±90°).
 */
export function eulerXyzToQuat(deg: Vec3): Quat {
  const r = Math.PI / 180;
  const qx = axisAngleQuat([1, 0, 0], deg[0] * r);
  const qy = axisAngleQuat([0, 1, 0], deg[1] * r);
  const qz = axisAngleQuat([0, 0, 1], deg[2] * r);
  return normalizeQuat(multiplyQuat(qz, multiplyQuat(qy, qx)));
}
export function quatToEulerXyz(q: Quat): Vec3 {
  const [x, y, z, w] = normalizeQuat(q);
  const d = 180 / Math.PI;
  const sy = Math.max(-1, Math.min(1, 2 * (w * y - z * x)));
  // At Y = ±90° X and Z turn about the same axis: put all of it in Z, so the angles still
  // describe this orientation (and editing one field does not turn the bone about another).
  if (Math.abs(sy) > 1 - 1e-9)
    return [0, Math.sign(sy) * 90, Math.atan2(-2 * (x * y - w * z), 1 - 2 * (x * x + z * z)) * d];
  return [
    Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)) * d,
    Math.asin(sy) * d,
    Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * d,
  ];
}

/** Each of `deg` (XYZ Euler degrees) held between `min` and `max`. */
export function clampEulerXyz(deg: Vec3, min: Vec3, max: Vec3): Vec3 {
  return [0, 1, 2].map((k) => Math.min(Math.max(deg[k]!, min[k]!), max[k]!)) as Vec3;
}

/**
 * `q` held inside XYZ Euler limits (degrees). An orientation has two Euler triples, (x, y, z) and
 * (x + 180, 180 − y, z + 180), each angle also ± 360: the one the limits clamp least is clamped,
 * so a Y beyond ± 90° that the limits allow is not taken for X and Z turns they forbid. At
 * Y = ± 90° the X and Z turns that make the orientation are a whole line of triples.
 */
export function clampRotation(q: Quat, min: Vec3, max: Vec3): Quat {
  const e = quatToEulerXyz(q);
  let best: Vec3 = e,
    bestCost = Infinity;
  const bases: Vec3[] = [e, [e[0] + 180, 180 - e[1], e[2] + 180]];
  if (Math.abs(Math.abs(e[1]) - 90) < 1e-6) {
    // Gimbal lock: Rz(z) Ry(±90°) Rx(x) depends on z ∓ x only, so (x, ±90, e_z ± x) are all this
    // orientation. Where the X and Z limits overlap on that line, one of their ends is in it.
    const s = Math.sign(e[1]);
    const xs = [min[0], max[0]];
    for (const turn of [-360, 0, 360])
      xs.push(s * (min[2] + turn - e[2]), s * (max[2] + turn - e[2]));
    for (const x of xs) {
      const at = Math.min(Math.max(x, min[0]), max[0]);
      bases.push([at, e[1], e[2] + s * at]);
    }
  }
  for (const base of bases) {
    const pick = [0, 1, 2].map((k) => {
      let at = base[k]!,
        cost = Infinity;
      for (const turn of [-720, -360, 0, 360, 720]) {
        const a = base[k]! + turn;
        const c = Math.max(min[k]! - a, a - max[k]!, 0);
        if (c < cost) [at, cost] = [a, c];
      }
      return [at, cost] as const;
    });
    const cost = pick.reduce((s, [, c]) => s + c * c, 0);
    if (cost < bestCost) [best, bestCost] = [pick.map(([a]) => a) as Vec3, cost];
  }
  return bestCost <= 1e-12 ? q : eulerXyzToQuat(clampEulerXyz(best, min, max));
}
