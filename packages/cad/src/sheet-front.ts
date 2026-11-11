import type { CadMesh } from '@editor-platform/cad-kernel-occt';

/**
 * CR4b (docs/cad/car-design.md, 86M6): which way a sheet's front (its normal, the side
 * `thicken`, `offsetSurface` and `pressLine` call `front`) mostly faces, from its display mesh:
 * the area-weighted mean of its triangles' normals, named by its largest axis. Undefined for a
 * mesh whose normals cancel (a closed or folded sheet) or that has no triangles.
 */
export function sheetFront(
  mesh: Pick<CadMesh, 'positions' | 'normals' | 'indices'>,
): { axis: '+X' | '−X' | '+Y' | '−Y' | '+Z' | '−Z'; share: number } | undefined {
  const sum = [0, 0, 0];
  let area = 0;
  const p = mesh.positions;
  const n = mesh.normals;
  for (let t = 0; t < mesh.indices.length / 3; t++) {
    const [a, b, c] = [0, 1, 2].map((k) => mesh.indices[3 * t + k]!) as [number, number, number];
    const u = [0, 1, 2].map((i) => p[3 * b + i]! - p[3 * a + i]!);
    const v = [0, 1, 2].map((i) => p[3 * c + i]! - p[3 * a + i]!);
    const cross = [
      u[1]! * v[2]! - u[2]! * v[1]!,
      u[2]! * v[0]! - u[0]! * v[2]!,
      u[0]! * v[1]! - u[1]! * v[0]!,
    ];
    const twice = Math.hypot(cross[0]!, cross[1]!, cross[2]!);
    if (!(twice > 0)) continue;
    // The triangle's own normal, turned to agree with the mesh normals (the face's side).
    const along = [0, 1, 2].reduce(
      (s, i) => s + cross[i]! * (n[3 * a + i]! + n[3 * b + i]! + n[3 * c + i]!),
      0,
    );
    const sign = along < 0 ? -1 : 1;
    for (let i = 0; i < 3; i++) sum[i]! += (sign * cross[i]!) / 2;
    area += twice / 2;
  }
  const length = Math.hypot(sum[0]!, sum[1]!, sum[2]!);
  if (!(area > 0) || length < 1e-6 * area) return undefined;
  const k = [0, 1, 2].reduce((best, i) => (Math.abs(sum[i]!) > Math.abs(sum[best]!) ? i : best), 0);
  const axis = `${sum[k]! < 0 ? '−' : '+'}${'XYZ'[k]}` as '+X';
  return { axis, share: Math.abs(sum[k]!) / area };
}
