/**
 * Test-only glTF writer: builds small GLB files with exactly the features a test needs, so no
 * outside model is committed. Not a general exporter (C6 writes the real one).
 */
export interface TestGltfOptions {
  /** Put `extras.ep_id` on the nodes, mesh material and animation. */
  epIds?: boolean;
  /** Extra JSON merged into the root (extensions, extensionsRequired …). */
  root?: Record<string, unknown>;
  /** Rename the arm joint (to test re-import diffs). */
  armName?: string;
  /** Move the tip vertex (m, glTF space), to change the mesh. */
  tipZ?: number;
  /** Leave the PNG texture out. */
  noTexture?: boolean;
  /** Store the morph target as a sparse accessor (only the two tip vertices). */
  sparseMorph?: boolean;
  /**
   * Add a second node `Cap` drawing the same mesh with a second skin that lists the same joints
   * child first (`[arm, root]`), as VRM files split face and body.
   */
  secondSkin?: boolean;
  /** Put a static node (`Spacer`, y 0.5 m) between `root` and `arm`; the arm then rests at 0. */
  spacer?: boolean;
  /**
   * Every vertex's NORMAL (glTF space). Defaults to +Z, the bar's face normal, so its smooth
   * vertices weld; `null` leaves NORMAL out (glTF then draws each face flat, unwelded).
   */
  normals?: number[] | null;
  /** Add a STEP scale track on `arm`: [1, 1, 1] → [1, −1, 1] (a mirroring key). */
  mirrorKey?: boolean;
}

/** A 1×1 opaque PNG. */
export const onePixelPng = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);

/**
 * A 1 m tall bar along glTF +Y (two quads stacked, 6 vertices), skinned to two joints `root`
 * (at 0) and `arm` (at 0.5 m, child of root). The top vertices follow `arm`, the middle ones are
 * shared half and half. One morph target pushes the top along +X by 0.1 m. One animation `bend`
 * turns `arm` 90° about glTF +Z over 1 s (LINEAR), steps the root's translation (STEP) and drives
 * the morph weight 0 → 1.
 */
export function testGltf(o: TestGltfOptions = {}): Uint8Array {
  const tip = o.tipZ ?? 0;
  const positions = [
    [-0.05, 0, 0],
    [0.05, 0, 0],
    [-0.05, 0.5, 0],
    [0.05, 0.5, 0],
    [-0.05, 1, tip],
    [0.05, 1, tip],
  ];
  const uvs = [
    [0, 1],
    [1, 1],
    [0, 0.5],
    [1, 0.5],
    [0, 0],
    [1, 0],
  ];
  const joints = positions.map(() => [0, 1, 0, 0]);
  const weights = [
    [1, 0, 0, 0],
    [1, 0, 0, 0],
    [0.5, 0.5, 0, 0],
    [0.5, 0.5, 0, 0],
    [0, 1, 0, 0],
    [0, 1, 0, 0],
  ];
  const indices = [0, 1, 3, 0, 3, 2, 2, 3, 5, 2, 5, 4];
  const morph = positions.map((_, i) => (i >= 4 ? [0.1, 0, 0] : [0, 0, 0]));
  // Inverse bind: root at origin, arm at y = 0.5.
  const ibmRoot = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const ibmArm = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -0.5, 0, 1];
  const times = [0, 1];
  const s = Math.SQRT1_2;
  const rotations = [
    [0, 0, 0, 1],
    [0, 0, s, s],
  ];
  const rootMoves = [
    [0, 0, 0],
    [0, 0, 0.25],
  ];
  const morphWeights = [[0], [1]];

  const bin: number[] = [];
  const views: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];
  const push = (
    rows: number[][],
    type: string,
    componentType: 5126 | 5121 | 5123,
    extra: Record<string, unknown> = {},
  ) => {
    while (bin.length % 4) bin.push(0);
    const at = bin.length;
    const dv = new DataView(
      new ArrayBuffer(
        rows.flat().length * (componentType === 5126 ? 4 : componentType === 5123 ? 2 : 1),
      ),
    );
    rows
      .flat()
      .forEach((x, i) =>
        componentType === 5126
          ? dv.setFloat32(i * 4, x, true)
          : componentType === 5123
            ? dv.setUint16(i * 2, x, true)
            : dv.setUint8(i, x),
      );
    bin.push(...new Uint8Array(dv.buffer));
    views.push({ buffer: 0, byteOffset: at, byteLength: dv.byteLength });
    accessors.push({
      bufferView: views.length - 1,
      componentType,
      count: rows.length,
      type,
      ...extra,
    });
    return accessors.length - 1;
  };
  const pos = push(positions, 'VEC3', 5126, {
    min: [-0.05, 0, Math.min(0, tip)],
    max: [0.05, 1, Math.max(0, tip)],
  });
  const uv = push(uvs, 'VEC2', 5126);
  const jnt = push(joints, 'VEC4', 5121);
  const wgt = push(weights, 'VEC4', 5126);
  const idx = push(
    indices.map((i) => [i]),
    'SCALAR',
    5123,
  );
  let tgt = push(morph, 'VEC3', 5126);
  if (o.sparseMorph) {
    const sparseIdx = push([[4], [5]], 'SCALAR', 5123);
    const sparseVal = push(
      [
        [0.1, 0, 0],
        [0.1, 0, 0],
      ],
      'VEC3',
      5126,
    );
    accessors.push({
      componentType: 5126,
      count: positions.length,
      type: 'VEC3',
      sparse: {
        count: 2,
        indices: {
          bufferView: accessors[sparseIdx].bufferView,
          componentType: 5123,
        },
        values: { bufferView: accessors[sparseVal].bufferView },
      },
    });
    tgt = accessors.length - 1;
  }
  const ibm2 = o.secondSkin ? push([ibmArm, ibmRoot], 'MAT4', 5126) : undefined;
  const ibm = push([ibmRoot, ibmArm], 'MAT4', 5126);
  const time = push(
    times.map((t) => [t]),
    'SCALAR',
    5126,
    { min: [0], max: [1] },
  );
  const rot = push(rotations, 'VEC4', 5126);
  const mov = push(rootMoves, 'VEC3', 5126);
  const mw = push(morphWeights, 'SCALAR', 5126);
  const normal = o.normals === undefined ? [0, 0, 1] : o.normals;
  const nrm = normal
    ? push(
        positions.map(() => normal),
        'VEC3',
        5126,
      )
    : undefined;
  const flip = o.mirrorKey
    ? push(
        [
          [1, 1, 1],
          [1, -1, 1],
        ],
        'VEC3',
        5126,
      )
    : undefined;
  let image: number | undefined;
  if (!o.noTexture) {
    while (bin.length % 4) bin.push(0);
    views.push({ buffer: 0, byteOffset: bin.length, byteLength: onePixelPng.length });
    bin.push(...onePixelPng);
    image = views.length - 1;
  }
  while (bin.length % 4) bin.push(0);
  const ep = (id: string) => (o.epIds ? { extras: { ep_id: id } } : {});
  const json: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'editor-platform test' },
    scene: 0,
    scenes: [{ name: 'Bar', nodes: o.secondSkin ? [0, 2, 3] : [0, 2] }],
    nodes: [
      { name: 'root', children: [o.spacer ? (o.secondSkin ? 4 : 3) : 1], ...ep('bone-root') },
      {
        name: o.armName ?? 'arm',
        ...(o.spacer ? {} : { translation: [0, 0.5, 0] }),
        ...ep('bone-arm'),
      },
      { name: 'Bar', mesh: 0, skin: 0, ...ep('part-bar') },
      ...(o.secondSkin ? [{ name: 'Cap', mesh: 0, skin: 1 }] : []),
      ...(o.spacer ? [{ name: 'Spacer', translation: [0, 0.5, 0], children: [1] }] : []),
    ],
    meshes: [
      {
        name: 'Bar',
        extras: { targetNames: ['Bend tip'] },
        weights: [0],
        primitives: [
          {
            attributes: {
              POSITION: pos,
              TEXCOORD_0: uv,
              JOINTS_0: jnt,
              WEIGHTS_0: wgt,
              ...(nrm === undefined ? {} : { NORMAL: nrm }),
            },
            indices: idx,
            material: 0,
            targets: [{ POSITION: tgt }],
          },
        ],
      },
    ],
    skins: [
      { name: 'Rig', joints: [0, 1], inverseBindMatrices: ibm },
      ...(ibm2 === undefined
        ? []
        : [{ name: 'Cap rig', joints: [1, 0], inverseBindMatrices: ibm2 }]),
    ],
    materials: [
      {
        name: 'Paint',
        ...ep('mat-paint'),
        pbrMetallicRoughness: {
          baseColorFactor: [0.214, 0.5, 1, 1],
          roughnessFactor: 0.4,
          metallicFactor: 0,
          ...(image === undefined ? {} : { baseColorTexture: { index: 0 } }),
        },
        doubleSided: true,
      },
    ],
    ...(image === undefined
      ? {}
      : { images: [{ bufferView: image, mimeType: 'image/png' }], textures: [{ source: 0 }] }),
    animations: [
      {
        name: 'bend',
        ...ep('action-bend'),
        samplers: [
          { input: time, output: rot, interpolation: 'LINEAR' },
          { input: time, output: mov, interpolation: 'STEP' },
          { input: time, output: mw, interpolation: 'LINEAR' },
          ...(flip === undefined ? [] : [{ input: time, output: flip, interpolation: 'STEP' }]),
        ],
        channels: [
          { sampler: 0, target: { node: 1, path: 'rotation' } },
          { sampler: 1, target: { node: 0, path: 'translation' } },
          { sampler: 2, target: { node: 2, path: 'weights' } },
          ...(flip === undefined ? [] : [{ sampler: 3, target: { node: 1, path: 'scale' } }]),
        ],
      },
    ],
    buffers: [{ byteLength: bin.length }],
    bufferViews: views,
    accessors,
    ...o.root,
  };
  return glb(json, Uint8Array.from(bin));
}

/** A GLB container around JSON and one BIN chunk. */
export function glb(json: unknown, bin: Uint8Array): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = (text.length + 3) & ~3;
  const binLength = (bin.length + 3) & ~3;
  const out = new Uint8Array(12 + 8 + jsonLength + 8 + binLength);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, jsonLength, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + jsonLength);
  const b = 20 + jsonLength;
  dv.setUint32(b, binLength, true);
  dv.setUint32(b + 4, 0x004e4942, true);
  out.set(bin, b + 8);
  return out;
}
