import type { EpmMesh } from './epm';

/** An axis-aligned box of quads centred on `center` (mm), outward faces, one material slot. */
export function boxMesh(
  size: [number, number, number],
  center: [number, number, number] = [0, 0, 0],
): EpmMesh {
  const [hx, hy, hz] = size.map((s) => s / 2);
  const [cx, cy, cz] = center;
  const positions = new Float32Array(24);
  for (let i = 0; i < 8; i++) {
    positions[3 * i] = cx + (i & 1 ? hx : -hx);
    positions[3 * i + 1] = cy + (i & 2 ? hy : -hy);
    positions[3 * i + 2] = cz + (i & 4 ? hz : -hz);
  }
  // Counter-clockwise seen from outside.
  const faces = [
    [0, 2, 3, 1], // -z
    [4, 5, 7, 6], // +z
    [0, 1, 5, 4], // -y
    [2, 6, 7, 3], // +y
    [0, 4, 6, 2], // -x
    [1, 3, 7, 5], // +x
  ];
  return {
    positions,
    faceSizes: new Uint32Array(6).fill(4),
    faceIndices: new Uint32Array(faces.flat()),
    faceMaterials: new Uint16Array(6),
    boneIds: [],
    morphs: [],
  };
}
