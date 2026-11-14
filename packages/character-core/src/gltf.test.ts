import { decodeEpm, epmLimits, meshDisplay } from '@editor-platform/geometry-mesh';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { glb, onePixelPng, testGltf } from './gltf-fixtures';
import {
  checkCharacterMeshes,
  composeMat4,
  diffCharacterIds,
  transformPoint,
  GltfImportError,
  importGltf,
  poseAt,
  skinMatrices,
  skinnedPositions,
  validateCharacter,
  worldMatrices,
  type GltfImport,
} from './index';

const problem = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof GltfImportError) return `${e.problem}: ${e.detail}`;
    throw e;
  }
  return 'accepted';
};
/** Skinned positions (mm) of the first skinned part, morphs applied first, at a tick. */
function posed(r: GltfImport, tick: number) {
  const doc = r.doc;
  const part = doc.parts[0];
  const mesh = r.meshes.get(part.mesh)!;
  const pose = poseAt(doc, doc.actions[0], tick);
  const morphed = { ...mesh, positions: mesh.positions.slice() };
  for (const m of mesh.morphs) {
    const w = pose.morphs.get(m.id) ?? 0;
    for (let i = 0; i < m.deltas.length; i++) morphed.positions[i] += w * m.deltas[i];
  }
  const { bones } = worldMatrices(doc, pose);
  return skinnedPositions(morphed, skinMatrices(doc.skins[0], mesh, bones));
}
const near = (a: ArrayLike<number>, b: number[], digits = 2) =>
  b.forEach((x, i) => expect(a[i]).toBeCloseTo(x, digits));

describe('glTF import', () => {
  it('reads mesh, skin, morph, material, texture and animation into a valid document', () => {
    const r = importGltf(testGltf());
    expect(validateCharacter(r.doc)).toEqual([]);
    expect(checkCharacterMeshes(r.doc, r.meshes)).toEqual([]);
    expect(r.losses).toEqual([]);
    expect(r.doc.name).toBe('Bar');
    expect(r.doc.parts.map((p) => p.id)).toEqual(['part:Bar']);
    expect(r.doc.skeletons[0].bones.map((b) => [b.id, b.parentId])).toEqual([
      ['bone:root', null],
      ['bone:arm', 'bone:root'],
    ]);
    // Metres Y-up → mm Z-up.
    near(r.doc.skeletons[0].bones[1].rest.translation, [0, 0, 500]);
    const mesh = r.meshes.get('mesh:part:Bar')!;
    near(mesh.positions.subarray(15, 18), [50, 0, 1000]);
    expect(mesh.morphs.map((m) => m.id)).toEqual(['morph:part:Bar/Bend tip']);
    near(mesh.morphs[0].deltas.subarray(15, 18), [100, 0, 0]);
    // The asset is the bytes the content names.
    expect(decodeEpm(r.assets.get('mesh:part:Bar')!)).toEqual(mesh);
    // Linear factor 0.214 is sRGB 0x7f, 0.5 is 0xbc.
    expect(r.doc.materials[0]).toMatchObject({
      id: 'material:Paint',
      color: '#7fbcff',
      roughness: 0.4,
      metalness: 0,
      doubleSided: true,
    });
    const image = r.doc.assets.find((a) => a.kind === 'texture-png')!;
    expect(r.doc.materials[0].maps.color).toBe(image.id);
    expect(r.assets.get(image.id)).toEqual(onePixelPng);
    expect(
      r.doc.actions[0].tracks.map((t) => [
        t.target.kind,
        (t.target as { id?: string }).id,
        t.target.property,
      ]),
    ).toEqual([
      ['bone', 'bone:arm', 'rotation'],
      ['bone', 'bone:root', 'translation'],
      ['morph', 'morph:part:Bar/Bend tip', 'weight'],
    ]);
    expect(r.doc.actions[0].tracks[1].keys[0].easing).toEqual({ type: 'hold' });
    expect(r.doc.actions[0].duration).toBe(240000);
  });
  it('poses the imported skin as glTF does: bind at rest, the arm bent and stepped at 1 s', () => {
    const r = importGltf(testGltf());
    const mesh = r.meshes.get(r.doc.parts[0].mesh)!;
    const rest = posed(
      { ...r, doc: { ...r.doc, actions: [{ ...r.doc.actions[0], tracks: [] }] } },
      0,
    );
    rest.forEach((x, i) => expect(x).toBeCloseTo(mesh.positions[i], 2));
    // glTF: tip (0.05, 1, 0) + morph 0.1 x, turned 90° about +Z at the arm (y 0.5), root at z 0.25
    // → (−0.5, 0.65, 0.25) m → (−500, −250, 650) mm.
    near(posed(r, 240000).subarray(15, 18), [-500, -250, 650], 1);
    // The STEP translation holds its first value until the last key.
    near(posed(r, 239999).subarray(0, 3), [-50, 0, 0], 1);
  });
  it('walks a scene that is one chain of every permitted node without exhausting the stack', () => {
    // The sample's scene placed under 4,095 empty nodes, one inside the next.
    const bytes = testGltf();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const jsonLength = view.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
    const binLength = view.getUint32(20 + jsonLength, true);
    const bin = bytes.subarray(28 + jsonLength, 28 + jsonLength + binLength);
    const first = json.nodes.length;
    const extra = 4096 - first;
    for (let k = 0; k < extra; k++)
      json.nodes.push({ children: [k + 1 < extra ? first + k + 1 : json.scenes[0].nodes[0]] });
    // Keep only the original first root under the chain (any others stay roots).
    json.scenes[0].nodes = [first, ...json.scenes[0].nodes.slice(1)];
    const result = problem(() => importGltf(glb(json, bin)));
    expect(result).toBe('accepted');
  });
  it('takes IDs from extras.ep_id and keeps them across a re-import', () => {
    const a = importGltf(testGltf({ epIds: true }));
    expect(a.doc.parts[0].id).toBe('part-bar');
    expect(a.doc.skeletons[0].bones.map((b) => b.id)).toEqual(['bone-root', 'bone-arm']);
    expect(a.doc.materials[0].id).toBe('mat-paint');
    expect(a.doc.actions[0].id).toBe('action-bend');
    const renamed = importGltf(testGltf({ epIds: true, armName: 'upper arm', tipZ: 0.02 }));
    const d = diffCharacterIds(a.doc, renamed.doc);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    // The morph's deltas are in the changed mesh, so it is listed as changed too.
    expect(d.changed.map((e) => `${e.kind}:${e.id}`)).toEqual([
      'part:part-bar',
      'bone:bone-arm',
      'morph:morph:part-bar/Bend tip',
    ]);
    // Without ep_id, the renamed joint is a different bone.
    const plain = diffCharacterIds(
      importGltf(testGltf()).doc,
      importGltf(testGltf({ armName: 'upper arm' })).doc,
    );
    expect(plain.removed.map((e) => e.id)).toEqual(['bone:arm']);
    expect(plain.added.map((e) => e.id)).toEqual(['bone:upper arm']);
    expect(diffCharacterIds(a.doc, a.doc).kept.length).toBe(6);
    // Only the inverse bind changes: the skinned part deforms differently, so it is changed.
    const rebound = structuredClone(a.doc);
    rebound.skins[0].inverseBind[0].matrix[14] += 10;
    expect(diffCharacterIds(a.doc, rebound).changed.map((e) => e.id)).toEqual(['part-bar']);
    // New image bytes under the same asset ID change the material that maps them.
    const retextured = structuredClone(a.doc);
    const image = retextured.assets.find((x) => x.kind !== 'mesh-epm')!;
    image.sha256 = '0'.repeat(64);
    expect(diffCharacterIds(a.doc, retextured).changed.map((e) => e.id)).toEqual(['mat-paint']);
    // Attaching the skeleton to a part moves every bone, so each bone is changed.
    const attached = structuredClone(a.doc);
    attached.skeletons[0].parentPartId = 'part-bar';
    expect(diffCharacterIds(a.doc, attached).changed.map((e) => e.id)).toEqual([
      'bone-root',
      'bone-arm',
    ]);
  });
  it('reads sparse accessors as the dense data they stand for', () => {
    const dense = importGltf(testGltf());
    const sparse = importGltf(testGltf({ sparseMorph: true }));
    expect(sparse.meshes.get('mesh:part:Bar')!.morphs).toEqual(
      dense.meshes.get('mesh:part:Bar')!.morphs,
    );
  });
  it('makes skins that share joints one skeleton, parents first', () => {
    const r = importGltf(testGltf({ secondSkin: true }));
    expect(validateCharacter(r.doc)).toEqual([]);
    expect(r.doc.skeletons).toHaveLength(1);
    expect(r.doc.skeletons[0].bones.map((b) => [b.id, b.parentId])).toEqual([
      ['bone:root', null],
      ['bone:arm', 'bone:root'],
    ]);
    expect(r.doc.skins.map((s) => [s.partId, s.skeletonId])).toEqual([
      ['part:Bar', r.doc.skeletons[0].id],
      ['part:Cap', r.doc.skeletons[0].id],
    ]);
    // The second skin's joint order is its own: its vertices bind at rest too.
    const cap = r.doc.parts[1];
    const mesh = r.meshes.get(cap.mesh)!;
    const { bones } = worldMatrices(r.doc, poseAt(r.doc, null, 0));
    const bind = skinnedPositions(mesh, skinMatrices(r.doc.skins[1], mesh, bones));
    bind.forEach((x, i) => expect(x).toBeCloseTo(mesh.positions[i], 2));
  });
  it('animates a bone under a static node with that node folded into its keys', () => {
    const r = importGltf(testGltf({ spacer: true }));
    expect(r.losses).toEqual(['bone-between-nodes']);
    // Same geometry and motion as without the spacer: the tip ends where glTF puts it.
    near(posed(r, 240000).subarray(15, 18), [-500, -250, 650], 1);
    near(posed(r, 0).subarray(15, 18), [50, 0, 1000], 1);
  });
  it('keeps part parents, so a child part follows its animated parent', () => {
    const base = JSON.parse(new TextDecoder().decode(chunk(testGltf({ noTexture: true }))));
    // Accessors of the test bar: 0 positions, 4 indices, 5 morph target, 7 times, 9 root moves.
    const json = {
      ...base,
      scenes: [{ nodes: [0] }],
      nodes: [
        { name: 'Parent', mesh: 0, translation: [1, 0, 0], children: [1] },
        { name: 'Spacer', translation: [0, 0, 1], children: [2] },
        { name: 'Child', mesh: 0, translation: [0, 1, 0], weights: [0.7] },
      ],
      meshes: [
        {
          name: 'Plain',
          weights: [0],
          primitives: [{ attributes: { POSITION: 0 }, indices: 4, targets: [{ POSITION: 5 }] }],
        },
      ],
      skins: undefined,
      materials: undefined,
      animations: [
        {
          name: 'lift',
          samplers: [{ input: 7, output: 9, interpolation: 'LINEAR' }],
          channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }],
        },
      ],
    };
    const r = importGltf(glb(json, bin(testGltf({ noTexture: true }))));
    expect(validateCharacter(r.doc)).toEqual([]);
    expect(r.doc.parts.map((p) => [p.id, p.parentId])).toEqual([
      ['part:Parent', null],
      ['part:Child', 'part:Parent'],
    ]);
    // A node's own morph weights win over its mesh's.
    expect(r.doc.morphs.map((m) => [m.partId, m.weight])).toEqual([
      ['part:Parent', 0],
      ['part:Child', 0.7],
    ]);
    const at = (tick: number) =>
      [12, 13, 14].map((k) =>
        Math.round(
          worldMatrices(r.doc, poseAt(r.doc, r.doc.actions[0], tick)).parts.get('part:Child')![k],
        ),
      );
    // glTF: the parent's key (0, 0, 0 → 0.25) replaces its rest (1, 0, 0); the child adds
    // (0, 0, 1) + (0, 1, 0) m. Metres Y-up to millimetres Z-up: (x, −z, y).
    expect(at(0)).toEqual([0, -1000, 1000]);
    expect(at(240000)).toEqual([0, -1250, 1000]);
    const rest = worldMatrices(r.doc, poseAt(r.doc, null, 0)).parts.get('part:Child')!;
    expect([12, 13, 14].map((k) => Math.round(rest[k]))).toEqual([1000, -1000, 1000]);
  });
  it('lets a skeleton under a mesh node follow that part, animation included', () => {
    const base = JSON.parse(new TextDecoder().decode(chunk(testGltf({ noTexture: true }))));
    const json = {
      ...base,
      scenes: [{ nodes: [2] }],
      nodes: [
        base.nodes[0],
        base.nodes[1],
        { ...base.nodes[2], translation: [1, 0, 0], children: [0] },
      ],
      animations: [
        {
          ...base.animations[0],
          // The bar steps from (0, 0, 0) to (0, 0, 0.25) m, as the root does.
          channels: [
            ...base.animations[0].channels,
            { sampler: 1, target: { node: 2, path: 'translation' } },
          ],
        },
      ],
    };
    const r = importGltf(glb(json, bin(testGltf({ noTexture: true }))));
    expect(validateCharacter(r.doc)).toEqual([]);
    expect(r.doc.skeletons[0].parentPartId).toBe('part:Bar');
    near(r.doc.skeletons[0].bones[0].rest.translation, [0, 0, 0]);
    const root = (action: (typeof r.doc.actions)[number] | null, tick: number) =>
      [12, 13, 14].map((k) =>
        Math.round(worldMatrices(r.doc, poseAt(r.doc, action, tick)).bones.get('bone:root')![k]),
      );
    expect(root(null, 0)).toEqual([1000, 0, 0]);
    // Bar (0, 0, 0.25) + root (0, 0, 0.25) m → (0, −500, 0) mm.
    expect(root(r.doc.actions[0], 240000)).toEqual([0, -500, 0]);
  });

  it('keeps the sign of a mirroring scale key on its own axis', () => {
    const r = importGltf(testGltf({ mirrorKey: true }));
    expect(r.losses).toEqual([]);
    const track = r.doc.actions[0].tracks.find(
      (t) => (t.target as { id?: string }).id === 'bone:arm' && t.target.property === 'scale',
    )!;
    // glTF scale (1, −1, 1) is (1, 1, −1) in Z-up.
    near(track.keys[1].value as number[], [1, 1, -1]);
    const arm = worldMatrices(r.doc, poseAt(r.doc, r.doc.actions[0], 240000)).bones.get(
      'bone:arm',
    )!;
    // glTF: R(90° about Z)·S(1, −1, 1) sends x → y, y → x; in Z-up columns x → z, y → y, z → x.
    near(
      [0, 1, 2, 4, 5, 6, 8, 9, 10].map((k) => arm[k]),
      [0, 0, 1, 0, 1, 0, 1, 0, 0],
      5,
    );
  });

  it('reports what TRS or the mesh cannot keep: shear, authored normals', () => {
    const base = JSON.parse(new TextDecoder().decode(chunk(testGltf({ noTexture: true }))));
    const s = Math.sin(Math.PI / 8),
      c = Math.cos(Math.PI / 8);
    const sheared = {
      ...base,
      scenes: [{ nodes: [0, 3] }],
      nodes: [
        ...base.nodes.slice(0, 2),
        { ...base.nodes[2], rotation: [0, 0, s, c] },
        { name: 'Stretch', scale: [2, 1, 1], children: [2] },
      ],
    };
    expect(importGltf(glb(sheared, bin(testGltf({ noTexture: true })))).losses).toContain('shear');
    // Normals along the faces are kept as they are rebuilt; others are reported per vertex.
    expect(importGltf(testGltf({ normals: [0, 0, 1] })).losses).toEqual([]);
    expect(importGltf(testGltf({ normals: [1, 0, 0] })).losses).toEqual(['authored-normals ×6']);
  });

  it('uses the glTF default material for a primitive without one', () => {
    const base = JSON.parse(new TextDecoder().decode(chunk(testGltf({ noTexture: true }))));
    const { material: _, ...prim } = base.meshes[0].primitives[0];
    const json = { ...base, meshes: [{ ...base.meshes[0], primitives: [prim] }] };
    const r = importGltf(glb(json, bin(testGltf({ noTexture: true }))));
    expect(r.doc.materials).toEqual([
      expect.objectContaining({ color: '#ffffff', metalness: 1, roughness: 1, doubleSided: false }),
    ]);
  });

  it('joins skins of one hierarchy into one skeleton even when their joints are disjoint', () => {
    const base = JSON.parse(new TextDecoder().decode(chunk(testGltf({ noTexture: true }))));
    const json = {
      ...base,
      scenes: [{ nodes: [0, 2, 5] }],
      nodes: [
        base.nodes[0],
        { ...base.nodes[1], children: [3] },
        base.nodes[2],
        { name: 'hand', translation: [0, 0.25, 0], children: [4] },
        { name: 'finger', translation: [0, 0.1, 0] },
        { name: 'Glove', mesh: 0, skin: 1 },
      ],
      skins: [base.skins[0], { name: 'Hand rig', joints: [3, 4] }],
    };
    const r = importGltf(glb(json, bin(testGltf({ noTexture: true }))));
    expect(validateCharacter(r.doc)).toEqual([]);
    expect(r.doc.skeletons).toHaveLength(1);
    expect(r.doc.skeletons[0].bones.map((b) => [b.id, b.parentId])).toEqual([
      ['bone:root', null],
      ['bone:arm', 'bone:root'],
      ['bone:hand', 'bone:arm'],
      ['bone:finger', 'bone:hand'],
    ]);
  });

  it('animates a mesh node that is also a joint as both its part and its bone', () => {
    const base = JSON.parse(new TextDecoder().decode(chunk(testGltf({ noTexture: true }))));
    const json = {
      ...base,
      nodes: [base.nodes[0], { ...base.nodes[1], mesh: 0 }, base.nodes[2]],
    };
    const r = importGltf(glb(json, bin(testGltf({ noTexture: true }))));
    expect(validateCharacter(r.doc)).toEqual([]);
    const targets = r.doc.actions[0].tracks
      .filter((t) => t.target.property === 'rotation')
      .map((t) => `${t.target.kind}:${(t.target as { id?: string }).id}`);
    expect(targets).toEqual(['bone:bone:arm', 'part:part:arm']);
  });

  it('lists texture sampling it does not keep (clamped or mirrored wrap, nearest filter)', () => {
    const base = JSON.parse(new TextDecoder().decode(chunk(testGltf())));
    const withSampler = (sampler: Record<string, number>) =>
      importGltf(
        glb(
          { ...base, samplers: [sampler], textures: [{ source: 0, sampler: 0 }] },
          bin(testGltf()),
        ),
      ).losses;
    expect(withSampler({ wrapS: 10497, wrapT: 10497, magFilter: 9729 })).toEqual([]);
    expect(withSampler({ wrapS: 33071 })).toEqual(['texture-sampler']);
    expect(withSampler({ magFilter: 9728 })).toEqual(['texture-sampler']);
  });

  it('lists texture strengths and morph normals it does not keep', () => {
    const base = JSON.parse(new TextDecoder().decode(chunk(testGltf())));
    const again = (json: unknown) => importGltf(glb(json, bin(testGltf()))).losses;
    const material = (extra: Record<string, unknown>) => ({
      ...base,
      materials: [{ ...base.materials[0], ...extra }],
    });
    expect(again(material({ normalTexture: { index: 0, scale: 1 } }))).toEqual([]);
    expect(again(material({ normalTexture: { index: 0, scale: 0 } }))).toEqual([
      'texture-strength',
    ]);
    // The bar's material has a colour texture: blending by its alpha cannot be kept.
    expect(again(material({ alphaMode: 'BLEND' }))).toEqual(['alpha-texture']);
    expect(again(material({ occlusionTexture: { index: 0, strength: 0.5 } }))).toEqual([
      'texture-strength',
    ]);
    // Accessor 5 is the morph's position deltas (nonzero): used as normal deltas too.
    const prim = base.meshes[0].primitives[0];
    const morphNormals = {
      ...base,
      meshes: [
        { ...base.meshes[0], primitives: [{ ...prim, targets: [{ POSITION: 5, NORMAL: 5 }] }] },
      ],
    };
    expect(again(morphNormals)).toEqual(['morph-normals']);
  });

  it('refuses negative or fractional triangle indices as a broken primitive', () => {
    // The key times are float scalars, some fractional: not valid indices.
    const base = JSON.parse(new TextDecoder().decode(chunk(testGltf())));
    const prim = base.meshes[0].primitives[0];
    const times = base.animations[0].samplers[0].input;
    const json = {
      ...base,
      meshes: [{ ...base.meshes[0], primitives: [{ ...prim, indices: times }] }],
    };
    expect(problem(() => importGltf(glb(json, bin(testGltf()))))).toMatch(/^primitive: .*index/);
  });

  it('refuses an attribute or key accessor of the wrong shape as a typed import error', () => {
    const base = JSON.parse(new TextDecoder().decode(chunk(testGltf())));
    const prim = base.meshes[0].primitives[0];
    const shaped = (accessor: number, type: string) => {
      const json = structuredClone(base);
      json.accessors[accessor].type = type;
      return problem(() => importGltf(glb(json, bin(testGltf()))));
    };
    expect(shaped(prim.attributes.POSITION, 'SCALAR')).toMatch(/^accessor: .*POSITION type SCALAR/);
    expect(shaped(prim.attributes.TEXCOORD_0, 'SCALAR')).toMatch(/^accessor: .*TEXCOORD_0 type/);
    const rotation = base.animations[0].channels.find(
      (c: { target: { path: string } }) => c.target.path === 'rotation',
    );
    expect(shaped(base.animations[0].samplers[rotation.sampler].output, 'VEC3')).toMatch(
      /^accessor: sampler output type VEC3 \(needs VEC4\)/,
    );
  });

  it('refuses a cubic-spline sampler without three outputs per key', () => {
    const base = JSON.parse(new TextDecoder().decode(chunk(testGltf())));
    for (const sampler of base.animations[0].samplers) sampler.interpolation = 'CUBICSPLINE';
    expect(problem(() => importGltf(glb(base, bin(testGltf()))))).toBe('animation: output count');
  });

  it('lists material extensions it reads past but does not keep', () => {
    const r = importGltf(testGltf({ root: { extensionsUsed: ['KHR_materials_unlit'] } }));
    expect(r.losses).toEqual(['extension:KHR_materials_unlit']);
  });

  it('keeps hard edges flat when the file has no normals, as glTF draws them', () => {
    // Two triangles sharing the edge 0–1 at a right angle: one in z = 0, one in y = 0 (glTF).
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const indices = new Uint16Array([0, 1, 2, 0, 3, 1]);
    const binBytes = new Uint8Array(60);
    binBytes.set(new Uint8Array(positions.buffer), 0);
    binBytes.set(new Uint8Array(indices.buffer), 48);
    const json = {
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'Fold', mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      buffers: [{ byteLength: 60 }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 48 },
        { buffer: 0, byteOffset: 48, byteLength: 12 },
      ],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 4,
          type: 'VEC3',
          min: [0, 0, 0],
          max: [1, 1, 1],
        },
        { bufferView: 1, componentType: 5123, count: 6, type: 'SCALAR' },
      ],
    };
    const r = importGltf(glb(json, binBytes));
    expect(r.losses).toEqual([]);
    const mesh = r.meshes.get(r.doc.parts[0].mesh)!;
    // The shared edge's two vertices are split per face: 6 vertices, not 4.
    expect(mesh.positions.length / 3).toBe(6);
    // Every corner shades with its own face's normal (Z-up: glTF +z is −y, glTF +y is +z).
    const normals = meshDisplay(mesh).normals;
    for (let c = 0; c < 3; c++) near(normals.subarray(3 * c, 3 * c + 3), [0, -1, 0], 5);
    for (let c = 3; c < 6; c++) near(normals.subarray(3 * c, 3 * c + 3), [0, 0, 1], 5);
  });

  it('refuses a mesh past the asset limits as a typed import refusal', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]);
    const bytes = new Uint8Array(80);
    bytes.set(new Uint8Array(positions.buffer), 0);
    bytes.set(new Uint8Array(new Uint16Array([0, 1, 2]).buffer), 72);
    const json = {
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'Tri', mesh: 0 }],
      meshes: [
        {
          primitives: [
            {
              attributes: { POSITION: 0 },
              indices: 2,
              // One more morph target than a mesh asset holds, each with no motion.
              targets: Array.from({ length: epmLimits.morphs + 1 }, () => ({ POSITION: 1 })),
            },
          ],
        },
      ],
      buffers: [{ byteLength: 80 }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 36 },
        { buffer: 0, byteOffset: 72, byteLength: 6 },
      ],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          type: 'VEC3',
          min: [0, 0, 0],
          max: [1, 1, 0],
        },
        { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 2, componentType: 5123, count: 3, type: 'SCALAR' },
      ],
    };
    let error: unknown;
    try {
      importGltf(glb(json, bytes));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GltfImportError);
    expect(error).toMatchObject({ problem: 'limit' });
  });

  it('keeps faces flat without normals even when a morph bends coplanar faces apart', () => {
    // A unit square in z = 0 as two triangles; the morph lifts the corner (1, 1) out of plane.
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    const lift = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]);
    const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
    const bytes = new Uint8Array(108);
    bytes.set(new Uint8Array(positions.buffer), 0);
    bytes.set(new Uint8Array(lift.buffer), 48);
    bytes.set(new Uint8Array(indices.buffer), 96);
    const json = {
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'Sheet', mesh: 0 }],
      meshes: [
        {
          primitives: [{ attributes: { POSITION: 0 }, indices: 2, targets: [{ POSITION: 1 }] }],
        },
      ],
      buffers: [{ byteLength: 108 }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 48 },
        { buffer: 0, byteOffset: 48, byteLength: 48 },
        { buffer: 0, byteOffset: 96, byteLength: 12 },
      ],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 4,
          type: 'VEC3',
          min: [0, 0, 0],
          max: [1, 1, 0],
        },
        { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
        { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' },
      ],
    };
    const r = importGltf(glb(json, bytes));
    const mesh = r.meshes.get(r.doc.parts[0].mesh)!;
    // No corner is shared between the two faces: 6 vertices.
    expect(mesh.positions.length / 3).toBe(6);
    const shared = [...mesh.faceIndices.subarray(0, 3)].filter((v) =>
      mesh.faceIndices.subarray(3, 6).includes(v),
    );
    expect(shared).toEqual([]);
  });

  it('refuses accessors that would decode past the budget before allocating them', () => {
    const json = {
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ componentType: 5126, count: 30_000_000, type: 'VEC3' }],
    };
    expect(problem(() => importGltf(new TextEncoder().encode(JSON.stringify(json))))).toMatch(
      /^too-large: .*decoded values$/,
    );
  });
  it('reads VRM metadata and lists what it drops', () => {
    const r = importGltf(
      testGltf({
        noTexture: true,
        root: {
          extensionsUsed: ['VRMC_vrm', 'VRMC_springBone', 'EXT_unknown'],
          extensions: {
            VRMC_vrm: {
              specVersion: '1.0',
              meta: {
                name: 'Bar',
                authors: ['A', 'B'],
                licenseUrl: 'https://example.com/l',
                commercialUsage: 'personalNonProfit',
              },
              expressions: {},
            },
            VRMC_springBone: {},
          },
        },
      }),
    );
    expect(r.vrm).toEqual({
      version: '1',
      meta: {
        name: 'Bar',
        authors: 'A, B',
        licenseUrl: 'https://example.com/l',
        commercialUsage: 'personalNonProfit',
      },
    });
    expect(r.losses).toEqual([
      'extension:EXT_unknown',
      'vrm-expressions',
      'vrm-humanoid',
      'vrm-spring-bones',
    ]);
  });
  it('refuses what it cannot read faithfully, without a partial document', () => {
    expect(problem(() => importGltf(new Uint8Array([1, 2, 3])))).toBe('json: parse');
    expect(
      problem(() =>
        importGltf(testGltf({ root: { extensionsRequired: ['KHR_draco_mesh_compression'] } })),
      ),
    ).toBe('required-extension: KHR_draco_mesh_compression');
    const json = (o: Record<string, unknown>) => new TextEncoder().encode(JSON.stringify(o));
    expect(
      problem(() =>
        importGltf(
          json({
            asset: { version: '2.0' },
            buffers: [{ byteLength: 4, uri: 'https://example.com/a.bin' }],
          }),
        ),
      ),
    ).toBe('external-uri: buffers[0]');
    expect(problem(() => importGltf(json({ asset: { version: '1.0' } })))).toBe(
      'version: asset.version',
    );
    const bytes = testGltf();
    const cut = bytes.slice(0, bytes.length - 4);
    expect(problem(() => importGltf(cut))).toBe('container: length');
    // A JPEG header on PNG bytes is still not an image the reader accepts.
    const badImage = testGltf({ root: {} });
    const at = findBytes(badImage, onePixelPng);
    badImage.set([0, 0, 0, 0], at);
    expect(problem(() => importGltf(badImage))).toBe('image: images[0] is not a PNG or JPEG');
    // Two nodes with the same name path give the same ID.
    const dup = JSON.parse(new TextDecoder().decode(chunk(testGltf())));
    dup.nodes.push({ name: 'Bar', mesh: 0 });
    dup.scenes[0].nodes.push(3);
    expect(problem(() => importGltf(glb(dup, bin(testGltf()))))).toBe('id: duplicate part:Bar');
  });
});

function findBytes(hay: Uint8Array, needle: Uint8Array) {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer;
    return i;
  }
  throw new Error('not found');
}
function chunk(bytes: Uint8Array) {
  const dv = new DataView(bytes.buffer);
  return bytes.subarray(20, 20 + dv.getUint32(12, true));
}
function bin(bytes: Uint8Array) {
  const dv = new DataView(bytes.buffer);
  const b = 20 + dv.getUint32(12, true);
  return bytes.subarray(b + 8, b + 8 + dv.getUint32(b, true));
}

/**
 * Optional corpus: `CHARACTER_GLTF_CORPUS=<dir>` imports every .glb/.vrm there (downloaded sample
 * models are never committed) and checks the document, the bind pose and the bounds.
 */
const corpus = process.env.CHARACTER_GLTF_CORPUS;
describe.skipIf(!corpus)('glTF corpus', () => {
  const files = corpus
    ? readdirSync(corpus)
        .filter((f) => /\.(glb|vrm)$/i.test(f))
        .sort()
    : [];
  it.each(files)('%s', (file) => {
    const bytes = new Uint8Array(readFileSync(join(corpus!, file)));
    const refused = problem(() => importGltf(bytes));
    // Files past a documented limit (e.g. 84 skins × 10 joints > 512 bones) are refused whole.
    if (refused.startsWith('document: limit')) {
      console.log(`${file}: refused (${refused})`);
      return;
    }
    const r = importGltf(bytes);
    expect(validateCharacter(r.doc)).toEqual([]);
    expect(checkCharacterMeshes(r.doc, r.meshes)).toEqual([]);
    for (const skin of r.doc.skins) {
      const part = r.doc.parts.find((p) => p.id === skin.partId)!;
      const mesh = r.meshes.get(part.mesh)!;
      const { bones } = worldMatrices(r.doc, poseAt(r.doc, null, 0));
      const bind = skinnedPositions(mesh, skinMatrices(skin, mesh, bones));
      // Bind pose: joint world × inverse bind; it equals the part's rest placement in most files.
      let worst = 0;
      const m = composeMat4(part.transform);
      for (let i = 0; i < bind.length; i += 3) {
        const p = transformPoint(m, [
          mesh.positions[i],
          mesh.positions[i + 1],
          mesh.positions[i + 2],
        ]);
        for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(bind[i + k] - p[k]));
      }
      expect(bind.every(Number.isFinite)).toBe(true);
      console.log(`${file} ${part.id}: bind vs rest placement ${worst.toFixed(2)} mm`);
    }
    console.log(
      `${file}: ${r.doc.parts.length} parts, ${r.doc.skeletons.reduce((n, s) => n + s.bones.length, 0)} bones, ` +
        `${r.doc.morphs.length} morphs, ${r.doc.actions.length} actions; losses: ${r.losses.join(', ') || 'none'}` +
        (r.vrm ? `; VRM ${r.vrm.version} ${JSON.stringify(r.vrm.meta)}` : ''),
    );
  });
});
