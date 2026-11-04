import { describe, expect, it } from 'vitest';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Mesh, MeshStandardMaterial } from 'three';
import { DoubleSide, FrontSide } from 'three';
import { EditorSession } from '@editor-platform/editor-core';
import {
  f02Plate,
  fixtureKernel,
  type CadEvaluateRequest,
  type CadEvaluation,
  type CadKernelPort,
} from '@editor-platform/cad-core';
import { CadController } from './controller';
import {
  CadExportError,
  checkClosedMesh,
  dropCollapsed,
  glbTextureCoordinates,
  writeGlb,
  writeStl,
  type CadExportBody,
  type CadMesh,
} from '@editor-platform/cad-kernel-occt';

/**
 * An axis-aligned box with each face carrying its own four vertices, as the OCCT triangulation
 * does, and outward winding. `origin` is the box centre; positions are relative to it.
 */
function box(size: [number, number, number], origin: [number, number, number]): CadMesh {
  const [x, y, z] = size.map((s) => s / 2);
  const corners = (axis: number, sign: number) => {
    // Four corners of the face whose normal is ±axis, counter-clockwise seen from outside.
    const [u, v] = [(axis + 1) % 3, (axis + 2) % 3];
    const half = [x, y, z];
    const pts = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([a, b]) => {
      const p = [0, 0, 0];
      p[axis] = sign * half[axis];
      p[u] = a * half[u];
      p[v] = b * half[v];
      return p;
    });
    return sign > 0 ? pts : pts.reverse();
  };
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const faceIds: number[] = [];
  for (let axis = 0; axis < 3; axis++)
    for (const sign of [1, -1]) {
      const base = positions.length / 3;
      for (const p of corners(axis, sign)) {
        positions.push(...p);
        const n = [0, 0, 0];
        n[axis] = sign;
        normals.push(...n);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      faceIds.push(axis * 2 + (sign > 0 ? 1 : 2), axis * 2 + (sign > 0 ? 1 : 2));
    }
  return {
    bodyId: 'b',
    origin,
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    faceIds: new Uint32Array(faceIds),
    vertices: new Float64Array(0),
    faceBase: 0,
    edgeBase: 0,
    edges: new Float32Array(0),
    edgeIds: new Uint32Array(0),
    topology: { faces: [], edges: [], vertices: [] },
  };
}
const body = (mesh: CadMesh, color = '#ff8000', opacity = 1): CadExportBody => ({
  name: 'Plate',
  kind: 'solid',
  appearance: { color, opacity },
  mesh,
});
const meta = { sourceContentHash: 'sha256:abc', buildHash: 'sha256:def', deflectionMm: 0.05 };
const buffer = (bytes: Uint8Array) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
/** Signed volume of a closed, outward-wound triangle soup. */
function volume(p: ArrayLike<number>) {
  let v = 0;
  for (let i = 0; i < p.length; i += 9)
    v +=
      (p[i] * (p[i + 4] * p[i + 8] - p[i + 5] * p[i + 7]) -
        p[i + 1] * (p[i + 3] * p[i + 8] - p[i + 5] * p[i + 6]) +
        p[i + 2] * (p[i + 3] * p[i + 7] - p[i + 4] * p[i + 6])) /
      6;
  return v;
}

describe('closed mesh check', () => {
  it('accepts a box whose faces carry their own vertices', () => {
    expect(() => checkClosedMesh([body(box([80, 50, 5], [40, 25, 2.5]))])).not.toThrow();
  });
  it('rejects a missing face, a flipped face, a zero-area triangle and an empty export', () => {
    const open = box([2, 2, 2], [0, 0, 0]);
    open.indices = open.indices.slice(0, -6);
    expect(() => checkClosedMesh([body(open)])).toThrow(CadExportError);
    const flipped = box([2, 2, 2], [0, 0, 0]);
    flipped.indices.set([flipped.indices[2], flipped.indices[1], flipped.indices[0]], 0);
    expect(() => checkClosedMesh([body(flipped)])).toThrow(/mesh-open/);
    const flat = box([2, 2, 2], [0, 0, 0]);
    flat.indices.set([0, 0, 1], 0);
    expect(() => checkClosedMesh([body(flat)])).toThrow(/mesh-degenerate/);
    expect(() => checkClosedMesh([])).toThrow(/mesh-empty/);
  });
  it('drops triangles with two corners at one point, keeps slivers refused (ST-88)', () => {
    // A tip the triangulator closed with a collapsed triangle: [0, 0, 1] has no area or edge.
    const tipped = box([2, 2, 2], [0, 0, 0]);
    tipped.indices = Uint32Array.from([...tipped.indices, 0, 0, 1]);
    const { bodies, dropped } = dropCollapsed([body(tipped)]);
    expect(dropped).toBe(1);
    expect(() => checkClosedMesh(bodies)).not.toThrow();
    const glb = writeGlb([body(tipped)], meta);
    expect(glb.report.triangles).toBe(12);
    expect(glb.report.transforms).toContain(
      'Dropped 1 triangle without area (two corners at one point)',
    );
    expect(writeStl([body(tipped)], meta).report.transforms).toHaveLength(1);
    expect(writeStl([body(box([2, 2, 2], [0, 0, 0]))], meta).report.transforms).toEqual([]);
    // Three distinct corners on one line: dropping it would open the mesh, so it is refused.
    const sliver = box([2, 2, 2], [0, 0, 0]);
    const p = Array.from(sliver.positions);
    const [a, b] = [sliver.indices[0]!, sliver.indices[1]!];
    p.push(...[0, 1, 2].map((k) => (p[a * 3 + k]! + p[b * 3 + k]!) / 2));
    sliver.positions = Float32Array.from(p);
    sliver.normals = Float32Array.from([...sliver.normals, 0, 0, 1]);
    sliver.indices = Uint32Array.from([...sliver.indices, a, b, p.length / 3 - 1]);
    expect(() => writeGlb([body(sliver)], meta)).toThrow(/mesh-degenerate/);
    // A body whose every triangle collapses is refused, not written empty beside another.
    const point = box([2, 2, 2], [0, 0, 0]);
    point.indices = Uint32Array.from([0, 0, 1, 2, 2, 3]);
    const both = [body(box([2, 2, 2], [0, 0, 0])), { ...body(point), name: 'Tip' }];
    expect(() => writeStl(both, meta)).toThrow(/mesh-empty@Tip/);
    expect(() => writeGlb(both, meta)).toThrow(/mesh-empty@Tip/);
  });
  it('lets a sheet be open but still needs consistent orientation (R2a-1)', () => {
    // A box without its bottom face: an open, consistently wound sheet.
    const cup = box([2, 2, 2], [0, 0, 0]);
    cup.indices = cup.indices.slice(0, -6);
    const sheet = (mesh: CadMesh): CadExportBody => ({ ...body(mesh), kind: 'sheet' });
    expect(() => checkClosedMesh([sheet(cup)])).not.toThrow();
    expect(() => checkClosedMesh([body(cup)])).toThrow(/mesh-open@Plate/);
    const flipped = box([2, 2, 2], [0, 0, 0]);
    flipped.indices = flipped.indices.slice(0, -6);
    flipped.indices.set([flipped.indices[2], flipped.indices[1], flipped.indices[0]], 0);
    expect(() => checkClosedMesh([sheet(flipped)])).toThrow(/mesh-open@Plate/);
    expect(() => writeStl([sheet(cup)], meta)).toThrow(/sheet-not-solid@Plate/);
  });
});

describe('STL', () => {
  it('writes millimetre facets that an independent reader parses back', () => {
    const { bytes, report } = writeStl([body(box([80, 50, 5], [40, 25, 2.5]))], meta);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).not.toBe('solid');
    expect(bytes.byteLength).toBe(84 + 12 * 50);
    const geometry = new STLLoader().parse(buffer(bytes));
    const p = geometry.getAttribute('position').array;
    expect(p.length).toBe(12 * 9);
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.min.toArray()).toEqual([0, 0, 0]);
    expect(geometry.boundingBox!.max.toArray()).toEqual([80, 50, 5]);
    expect(volume(p)).toBeCloseTo(80 * 50 * 5, 6);
    expect(report).toMatchObject({ format: 'stl', units: 'mm', bodies: 1, triangles: 12 });
    expect(report.losses.join(' ')).toMatch(/no unit field/);
  });

  it('refuses a small body far from the origin that float32 world coordinates would collapse', () => {
    // 0.01 mm box at 999,990 mm: origin-relative it is closed, in float32 world space it is not.
    const far = box([0.01, 0.01, 0.01], [999_990, 999_990, 999_990]);
    expect(() => checkClosedMesh([body(far)])).not.toThrow();
    expect(() => writeStl([body(far)], meta)).toThrow(/mesh-precision@Plate/);
    // GLB keeps origin-relative positions and places them with a double-precision translation.
    expect(() => writeGlb([body(far)], meta)).not.toThrow();
  });
});

describe('GLB', () => {
  it('converts to metres and Y-up once, keeps colours, and parses in an independent loader', async () => {
    const { bytes, report } = writeGlb(
      [body(box([80, 50, 5], [40, 25, 2.5]), '#ff8000', 0.5)],
      meta,
    );
    expect(bytes.byteLength % 4).toBe(0);
    const gltf = await new GLTFLoader().parseAsync(buffer(bytes), '');
    const mesh = gltf.scene.children[0] as Mesh;
    expect(mesh.name).toBe('Plate');
    mesh.updateMatrixWorld(true);
    mesh.geometry.computeBoundingBox();
    const bounds = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld);
    // CAD (x 0..80, y 0..50, z 0..5) mm → glTF (x 0..0.08, y 0..0.005, z −0.05..0) m.
    const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));
    close(bounds.min.toArray(), [0, 0, -0.05]);
    close(bounds.max.toArray(), [0.08, 0.005, 0]);
    const material = mesh.material as MeshStandardMaterial;
    expect(material.color.r).toBeCloseTo(1, 6);
    expect(material.opacity).toBe(0.5);
    expect(material.transparent).toBe(true);
    expect(report).toMatchObject({ format: 'glb', units: 'm', triangles: 12 });
    expect(report.transforms).toHaveLength(2);
  });
  it('writes a sheet double-sided (R2a-1)', async () => {
    const cup = box([2, 2, 2], [0, 0, 0]);
    cup.indices = cup.indices.slice(0, -6);
    const { bytes } = writeGlb([{ ...body(cup), kind: 'sheet' }], meta);
    const gltf = await new GLTFLoader().parseAsync(buffer(bytes), '');
    expect(((gltf.scene.children[0] as Mesh).material as MeshStandardMaterial).side).toBe(
      DoubleSide,
    );
    const solid = writeGlb([body(box([2, 2, 2], [0, 0, 0]))], meta);
    const parsed = await new GLTFLoader().parseAsync(buffer(solid.bytes), '');
    expect(((parsed.scene.children[0] as Mesh).material as MeshStandardMaterial).side).toBe(
      FrontSide,
    );
  });
});

/** The JSON chunk of a GLB. */
function glbJson(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + view.getUint32(12, true))));
}
/** An accessor's floats, read from the GLB's binary chunk. */
function glbFloats(bytes: Uint8Array, json: ReturnType<typeof glbJson>, accessor: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bin = 20 + view.getUint32(12, true) + 8;
  const a = json.accessors[accessor];
  const bv = json.bufferViews[a.bufferView];
  const size = a.type === 'VEC2' ? 2 : a.type === 'VEC3' ? 3 : 1;
  return Array.from(
    new Float32Array(
      bytes.slice(bin + bv.byteOffset, bin + bv.byteOffset + a.count * size * 4).buffer,
    ),
  );
}

describe('GLB textures (#663)', () => {
  const png = { bytes: new Uint8Array([137, 80, 78, 71, 1]), mediaType: 'image/png' as const };
  const jpeg = {
    bytes: new Uint8Array([255, 216, 255, 1, 2, 3]),
    mediaType: 'image/jpeg' as const,
  };
  const uvBox = () => {
    const mesh = box([2, 2, 2], [0, 0, 0]);
    mesh.uvs = new Float32Array((mesh.positions.length / 3) * 2).map((_, i) => i * 10);
    return mesh;
  };
  it('writes the finish, the maps with their images once each, and turned coordinates', () => {
    const textures = {
      color: jpeg,
      normal: png,
      metallicRoughness: png,
      occlusion: jpeg,
      sizeMm: [500, 250] as [number, number],
      rotationDeg: 90,
    };
    const look = { color: '#ffffff', opacity: 1, roughness: 0.3, metalness: 1 };
    const { bytes, report } = writeGlb(
      [
        { ...body(uvBox()), appearance: look, textures },
        { ...body(uvBox()), name: 'Plain' },
      ],
      meta,
    );
    expect(bytes.byteLength % 4).toBe(0);
    const json = glbJson(bytes);
    const [textured, plain] = json.materials;
    expect(textured).toMatchObject({
      pbrMetallicRoughness: {
        metallicFactor: 1,
        roughnessFactor: 0.3,
        baseColorTexture: { index: 0 },
        metallicRoughnessTexture: { index: 1 },
      },
      normalTexture: { index: 1 },
      occlusionTexture: { index: 0 },
    });
    // A look without a finish is written with the default one, as the view draws it.
    expect(plain.pbrMetallicRoughness).toEqual({
      baseColorFactor: [...[1, 0.5, 0].map((c) => (c === 0.5 ? expect.any(Number) : c)), 1],
      metallicFactor: 0.05,
      roughnessFactor: 0.55,
    });
    expect(json.images).toEqual([
      { bufferView: expect.any(Number), mimeType: 'image/jpeg' },
      { bufferView: expect.any(Number), mimeType: 'image/png' },
    ]);
    expect(json.samplers).toEqual([
      { magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 },
    ]);
    // The image bytes are in the binary chunk as given.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const bin = 20 + view.getUint32(12, true) + 8;
    const imageView = json.bufferViews[json.images[1].bufferView];
    expect(
      Array.from(
        bytes.subarray(
          bin + imageView.byteOffset,
          bin + imageView.byteOffset + imageView.byteLength,
        ),
      ),
    ).toEqual(Array.from(png.bytes));
    expect(json.bufferViews.every((v: { byteOffset: number }) => v.byteOffset % 4 === 0)).toBe(
      true,
    );
    // A quarter turn: u' = v / 500, v' = −(−u) / 250, as the view's repeat and rotation.
    const uv = glbFloats(bytes, json, json.meshes[0].primitives[0].attributes.TEXCOORD_0);
    expect(uv[0]).toBeCloseTo(10 / 500, 6);
    expect(uv[1]).toBeCloseTo(0 / 250, 6);
    expect(uv[2]).toBeCloseTo(30 / 500, 6);
    expect(uv[3]).toBeCloseTo(20 / 250, 6);
    expect(json.meshes[1].primitives[0].attributes.TEXCOORD_0).toBeUndefined();
    expect(report.losses).toHaveLength(1);
  });
  it('flips v without a turn, and names a body whose mesh has no texture coordinates', () => {
    const uv = glbTextureCoordinates(new Float32Array([100, 50]), {
      sizeMm: [100, 100],
      rotationDeg: 0,
    });
    expect(Array.from(uv)).toEqual([1, -0.5]);
    const { bytes, report } = writeGlb(
      [
        {
          ...body(box([2, 2, 2], [0, 0, 0])),
          textures: { color: png, sizeMm: [1, 1], rotationDeg: 0 },
        },
      ],
      meta,
    );
    const json = glbJson(bytes);
    expect(json.images).toBeUndefined();
    expect(json.materials[0].pbrMetallicRoughness.baseColorTexture).toBeUndefined();
    expect(report.losses[1]).toMatch(/^Plate: the texture maps are not written/);
  });
});

describe('CadController.exportMesh', () => {
  /** A kernel that evaluates F02 as an 80×50×5 box and records export requests. */
  function setup(
    document = f02Plate(),
    extra: Partial<ConstructorParameters<typeof CadController>[0]> = {},
  ) {
    const exportRequests: number[] = [];
    let exportBodies: Record<string, unknown> | undefined;
    /** When set, the STL triangulation job ends with this code. */
    let exportFailure: string | undefined;
    const evaluation = (request: CadEvaluateRequest): CadEvaluation => ({
      status: 'ok',
      contentHash: request.candidateHash,
      buildHash: fixtureKernel.buildHash,
      geometryDigest: 'digest',
      bodies: Object.fromEntries(
        request.document.bodies.map((b) => [
          b.id,
          {
            kind: 'solid' as const,
            volumeMm3: 20_000,
            areaMm2: 1,
            bounds: [
              [0, 0, 0],
              [80, 50, 5],
            ],
          },
        ]),
      ),
    });
    const plate = () => {
      const mesh = box([80, 50, 5], [40, 25, 2.5]);
      // Real-size coordinates (mm): x and y of each node, as a plane's projection.
      const uvs = new Float32Array((mesh.positions.length / 3) * 2);
      for (let v = 0; v < uvs.length / 2; v++)
        uvs.set([mesh.positions[v * 3] + 40, mesh.positions[v * 3 + 1] + 25], v * 2);
      return { ...mesh, uvs, bodyId: 'plate' };
    };
    /** While set, an edit's evaluation waits for `release()`. */
    let held: Promise<void> | undefined;
    let release = () => {};
    const kernel: CadKernelPort = {
      evaluate: async (request) => {
        await held;
        controller.receiveMeshes(
          request.candidateHash,
          request.document.bodies.map((b) => ({ ...plate(), bodyId: b.id })),
        );
        return evaluation(request);
      },
      cancel: () => {},
    };
    const controller = new CadController({
      session: new EditorSession(document),
      kernel,
      canEdit: () => true,
      permissionGeneration: () => 1,
      ...extra,
      exportStep: async (request) => {
        const result = evaluation(request);
        if (exportBodies && result.status === 'ok') result.bodies = exportBodies as never;
        return { evaluation: result, step: new TextEncoder().encode('ISO-10303-21;\nHEADER;') };
      },
      exportMeshes: async (request, deflectionMm) => {
        exportRequests.push(deflectionMm);
        if (exportFailure)
          return {
            evaluation: {
              status: 'error',
              contentHash: request.candidateHash,
              code: exportFailure,
              retryable: true,
            },
            meshes: [],
          };
        const result = evaluation(request);
        if (exportBodies && result.status === 'ok') result.bodies = exportBodies as never;
        return {
          evaluation: result,
          meshes: request.document.bodies.map((b) => ({ ...plate(), bodyId: b.id })),
        };
      },
    });
    return {
      controller,
      exportRequests,
      changeExportBodies: (b: Record<string, unknown>) => (exportBodies = b),
      failExport: (code: string) => (exportFailure = code),
      hold: () => {
        held = new Promise((resolve) => (release = resolve));
        return () => {
          held = undefined;
          release();
        };
      },
    };
  }

  it('writes a body’s texture set to GLB: packed, converted, or named as lost (#663)', async () => {
    const image = (n: number) => new Uint8Array([n, n, n, n]);
    const kept = new Map<string, Uint8Array>([
      ['sha256:c', image(1)],
      ['sha256:n', image(2)],
      ['sha256:r', image(3)],
      ['sha256:m', image(4)],
    ]);
    const document = f02Plate();
    const ref = (id: string, sha: string, mediaType = 'image/png') => ({
      id,
      kind: (mediaType === 'image/png' ? 'texture-png' : 'texture-jpeg') as 'texture-png',
      sha256: sha,
      byteLength: 4,
      mediaType,
    });
    document.assets = [
      ref('asset-c', 'sha256:c', 'image/jpeg'),
      ref('asset-n', 'sha256:n'),
      ref('asset-r', 'sha256:r'),
      ref('asset-m', 'sha256:m'),
      ref('asset-o', 'sha256:missing'),
    ];
    document.bodies[0]!.appearance = {
      color: '#ffffff',
      opacity: 1,
      textures: {
        maps: {
          color: 'asset-c',
          normal: 'asset-n',
          roughness: 'asset-r',
          metalness: 'asset-m',
          occlusion: 'asset-o',
        },
        sizeMm: [1000, 1000],
        rotationDeg: 0,
        normal: 'dx',
        name: 'Bricks',
      },
    };
    // A second body with the same set: each image is converted and embedded once (Codex).
    document.bodies.push({ ...document.bodies[0]!, id: 'copy', name: 'Copy' });
    const calls: string[] = [];
    const { controller } = setup(document, {
      assets: { get: (sha) => kept.get(sha), stage: async () => {} },
      textureImages: {
        packMetallicRoughness: async (r, m) => {
          calls.push(`pack ${r?.bytes[0]} ${m?.bytes[0]}`);
          return image(9);
        },
        flipNormalGreen: async (n) => {
          calls.push(`flip ${n.bytes[0]}`);
          return image(8);
        },
      },
    });
    await controller.refresh();
    const glb = await controller.exportMesh('glb');
    expect(calls).toEqual(['flip 2', 'pack 3 4']);
    const json = glbJson(glb!.bytes);
    expect(json.images.map((i: { mimeType: string }) => i.mimeType)).toEqual([
      'image/jpeg',
      'image/png',
      'image/png',
    ]);
    expect(json.materials[0].occlusionTexture).toBeUndefined();
    expect(json.materials[1].normalTexture).toEqual(json.materials[0].normalTexture);
    expect(json.materials[1].pbrMetallicRoughness.metallicRoughnessTexture).toEqual(
      json.materials[0].pbrMetallicRoughness.metallicRoughnessTexture,
    );
    expect(glb!.report.losses).toContain(
      'plate: the occlusion map is not written, as its image is missing.',
    );

    // Without the Host's image tools, the maps that need converting are left out and named.
    const bare = setup(document, {
      assets: { get: (sha) => kept.get(sha), stage: async () => {} },
    });
    await bare.controller.refresh();
    const plain = await bare.controller.exportMesh('glb');
    const parsed = glbJson(plain!.bytes);
    expect(parsed.materials[0].normalTexture).toBeUndefined();
    expect(parsed.materials[0].pbrMetallicRoughness.baseColorTexture).toEqual({ index: 0 });
    expect(plain!.report.losses).toEqual(
      expect.arrayContaining([
        'plate: the normal map is not written, as the image could not be converted.',
        'plate: the roughness and metalness maps are not written, as the image could not be converted.',
      ]),
    );
  });
  it('refuses before the shape is evaluated', async () => {
    const { controller } = setup();
    expect(await controller.exportMesh('glb')).toBeUndefined();
    expect(controller.getSnapshot().diagnostic?.code).toBe('export-busy');
  });
  it('writes GLB from the display mesh and STL from an export triangulation of the same shape', async () => {
    const { controller, exportRequests } = setup();
    await controller.refresh();
    const glb = await controller.exportMesh('glb');
    // The display deflection follows the body: 0.1% of the 80×50×5 mm plate's diagonal.
    expect(glb?.report).toMatchObject({ format: 'glb', bodies: 1 });
    expect(glb?.report.deflectionMm).toBeCloseTo(Math.hypot(80, 50, 5) * 0.001, 9);
    expect(exportRequests).toEqual([]);
    // Both STL triangulations are absolute and computed for the export, not taken from the display.
    expect((await controller.exportMesh('stl'))?.report.deflectionMm).toBe(0.05);
    const stl = await controller.exportMesh('stl', { deflectionMm: 0.01 });
    expect(stl?.report).toMatchObject({
      format: 'stl',
      deflectionMm: 0.01,
      sourceContentHash: controller.getSnapshot().contentHash,
    });
    expect(exportRequests).toEqual([0.05, 0.01]);
  });
  it('writes STEP from the exact build with a report, and refuses a different shape', async () => {
    const { controller, changeExportBodies } = setup();
    expect(await controller.exportStep()).toBeUndefined();
    await controller.refresh();
    const step = await controller.exportStep();
    expect(step?.report).toMatchObject({ format: 'step', units: 'mm', bodies: 1 });
    expect(step?.report.losses.join(' ')).toMatch(/Feature history/);
    // OCCT's last-digit noise between builds of the same content is the same shape (R1 housing)…
    const shown = controller.getSnapshot().evaluation;
    if (shown?.status !== 'ok') throw new Error('evaluation');
    const scaled = (k: number) =>
      Object.fromEntries(
        Object.entries(shown.bodies).map(([id, b]) => [
          id,
          b.kind === 'solid' ? { ...b, volumeMm3: b.volumeMm3 * k, areaMm2: b.areaMm2 * k } : b,
        ]),
      );
    changeExportBodies(scaled(1 + 1e-15));
    expect(await controller.exportStep()).toBeDefined();
    // …a real difference, a missing body or an extra one is not.
    for (const bodies of [
      scaled(1 + 1e-6),
      {},
      { ...shown.bodies, extra: Object.values(shown.bodies)[0] },
    ]) {
      changeExportBodies(bodies);
      expect(await controller.exportStep()).toBeUndefined();
      expect(controller.getSnapshot().diagnostic?.code).toBe('export-mismatch');
    }
  });
  it('exports the confirmed content while an edit evaluates, pinned to its hash (CAD21)', async () => {
    const { controller, hold } = setup();
    await controller.refresh();
    const confirmed = controller.getSnapshot().contentHash;
    const finish = hold();
    const edit = controller.run({ type: 'setParameter', parameterId: 'W', value: 100 });
    expect(controller.getSnapshot().busy).toBe(true);
    const glb = await controller.exportMesh('glb');
    const stl = await controller.exportMesh('stl');
    const step = await controller.exportStep();
    for (const file of [glb, stl, step]) expect(file?.report.sourceContentHash).toBe(confirmed);
    // The edit applies afterwards; a file prepared before it keeps the hash it names.
    finish();
    expect(await edit).toBe(true);
    expect(controller.getSnapshot().contentHash).not.toBe(confirmed);
    expect(stl?.report.sourceContentHash).toBe(confirmed);
  });
  it('asks for a coarser triangulation when the STL one runs out of time (ST-88)', async () => {
    const { controller, failExport } = setup();
    await controller.refresh();
    failExport('timeout');
    expect(await controller.exportMesh('stl', { deflectionMm: 0.01 })).toBeUndefined();
    expect(controller.getSnapshot().diagnostic).toMatchObject({ code: 'export-timeout' });
    expect(controller.getSnapshot().diagnostic?.message).toMatch(/Triangulationを粗く/);
  });
  it('writes every active body to one STEP file, without an assembly (ST-88)', async () => {
    const document = f02Plate();
    document.bodies.push({ ...document.bodies[0], id: 'copy', name: 'Copy' });
    const { controller } = setup(document);
    await controller.refresh();
    const step = await controller.exportStep();
    expect(step?.report).toMatchObject({ format: 'step', bodies: 2 });
    expect(step?.report.losses.join(' ')).toMatch(/each of the 2 bodies.*without an assembly/);
  });
  it('refuses an export evaluation whose shape differs from the one shown', async () => {
    const { controller, changeExportBodies } = setup();
    await controller.refresh();
    changeExportBodies({
      plate: {
        kind: 'solid' as const,
        volumeMm3: 1,
        areaMm2: 1,
        bounds: [
          [0, 0, 0],
          [1, 1, 1],
        ],
      },
    });
    expect(await controller.exportMesh('stl', { deflectionMm: 0.01 })).toBeUndefined();
    expect(controller.getSnapshot().diagnostic?.code).toBe('export-mismatch');
  });
});
