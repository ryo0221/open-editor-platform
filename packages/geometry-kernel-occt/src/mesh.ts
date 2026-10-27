/**
 * Per-node normals of a triangle mesh: the sum of the unnormalised normals of the triangles that
 * use the node, normalised (a node no triangle uses gets 0). `positions` are x, y, z per node.
 */
export function vertexNormals(positions: Float32Array, indices: ArrayLike<number>): Float32Array {
  const pos = positions;
  const normals = new Float32Array(pos.length);
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [indices[i] * 3, indices[i + 1] * 3, indices[i + 2] * 3];
    const u = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]];
    const v = [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    for (const k of [a, b, c]) for (let j = 0; j < 3; j++) normals[k + j] += n[j];
  }
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    for (let j = 0; j < 3; j++) normals[i + j] /= l;
  }
  return normals;
}
