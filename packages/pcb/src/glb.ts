/**
 * The board in 3D as glTF 2.0 binary (PB7b): one node per coloured piece (the board, each
 * part's body, pins, shell…) and the two faces' pictures as textured sheets just off the board.
 * Converted once at this boundary from millimetres and Z-up to glTF's metres and Y-up:
 * (x, y, z) → (x, z, −y) / 1000. The same input gives the same bytes.
 */
export interface PcbGlbMesh {
  name: string;
  /** Model space, mm, z up. */
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  color: string;
  metalness: number;
  roughness: number;
  /**
   * Texture coordinates with v up (as Three.js reads a canvas) and a PNG drawn on them (the
   * board's faces). glTF puts (0, 0) at the image's top left, so v is written as 1 − v.
   */
  texture?: { uvs: Float32Array; png: Uint8Array };
}

const rgb = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  // glTF colour factors are linear.
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
};

export function writePcbGlb(meshes: readonly PcbGlbMesh[], name: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const bufferViews: object[] = [];
  const accessors: object[] = [];
  const add = (data: ArrayBufferView, target?: number) => {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    bufferViews.push({
      buffer: 0,
      byteOffset: length,
      byteLength: bytes.byteLength,
      ...(target ? { target } : {}),
    });
    chunks.push(bytes);
    length += bytes.byteLength;
    const gap = (4 - (length % 4)) % 4;
    if (gap) {
      chunks.push(new Uint8Array(gap));
      length += gap;
    }
    return bufferViews.length - 1;
  };
  const accessor = (a: object) => accessors.push(a) - 1;
  const nodes: object[] = [];
  const gltfMeshes: object[] = [];
  const materials: object[] = [];
  const images: object[] = [];
  const textures: object[] = [];
  for (const [i, m] of meshes.entries()) {
    const count = m.positions.length / 3;
    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < count; v++) {
      const [x, y, z] = [0, 1, 2].map((k) => m.positions[v * 3 + k]!);
      positions.set([x / 1000, z / 1000, -y / 1000], v * 3);
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k]!, positions[v * 3 + k]!);
        max[k] = Math.max(max[k]!, positions[v * 3 + k]!);
      }
      const [nx, ny, nz] = [0, 1, 2].map((k) => m.normals[v * 3 + k]!);
      normals.set([nx, nz, -ny], v * 3);
    }
    const attributes: Record<string, number> = {
      POSITION: accessor({
        bufferView: add(positions, 34962),
        componentType: 5126,
        count,
        type: 'VEC3',
        min,
        max,
      }),
      NORMAL: accessor({
        bufferView: add(normals, 34962),
        componentType: 5126,
        count,
        type: 'VEC3',
      }),
    };
    let baseColorTexture: { index: number } | undefined;
    if (m.texture) {
      attributes.TEXCOORD_0 = accessor({
        bufferView: add(
          m.texture.uvs.map((t, k) => (k % 2 ? 1 - t : t)),
          34962,
        ),
        componentType: 5126,
        count,
        type: 'VEC2',
      });
      images.push({ bufferView: add(m.texture.png), mimeType: 'image/png' });
      baseColorTexture = { index: textures.push({ sampler: 0, source: images.length - 1 }) - 1 };
    }
    const indices = accessor({
      bufferView: add(new Uint32Array(m.indices), 34963),
      componentType: 5125,
      count: m.indices.length,
      type: 'SCALAR',
    });
    materials.push({
      name: m.name,
      pbrMetallicRoughness: {
        baseColorFactor: m.texture ? [1, 1, 1, 1] : [...rgb(m.color), 1],
        metallicFactor: m.metalness,
        roughnessFactor: m.roughness,
        ...(baseColorTexture ? { baseColorTexture } : {}),
      },
      // A face picture is clear outside the board and in its holes.
      ...(m.texture ? { alphaMode: 'MASK', alphaCutoff: 0.5 } : {}),
    });
    gltfMeshes.push({ name: m.name, primitives: [{ attributes, indices, material: i }] });
    nodes.push({ name: m.name, mesh: i });
  }
  const json = {
    asset: { version: '2.0', generator: 'EditorPlatform PCB' },
    scene: 0,
    scenes: [{ name, nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes: gltfMeshes,
    materials,
    ...(images.length
      ? {
          samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
          images,
          textures,
        }
      : {}),
    accessors,
    bufferViews,
    buffers: [{ byteLength: length }],
  };
  const pad = (n: number) => (4 - (n % 4)) % 4;
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = jsonBytes.byteLength + pad(jsonBytes.byteLength);
  const binLength = length + pad(length);
  const bytes = new Uint8Array(12 + 8 + jsonLength + 8 + binLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true); // "glTF"
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.byteLength, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true); // "JSON"
  bytes.set(jsonBytes, 20);
  bytes.fill(0x20, 20 + jsonBytes.byteLength, 20 + jsonLength);
  const bin = 20 + jsonLength;
  view.setUint32(bin, binLength, true);
  view.setUint32(bin + 4, 0x004e4942, true); // "BIN\0"
  let at = bin + 8;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** Reads a GLB's JSON chunk (for tests and checks). */
export function readPcbGlbJson(bytes: Uint8Array): Record<string, unknown> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error('glb:magic');
  const length = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)));
}
