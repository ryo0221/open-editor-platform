import { describe, expect, it } from 'vitest';
import { epmSha256, type EpmMesh } from '@editor-platform/geometry-mesh';
import { blockyFigure } from './fixtures';
import { onePixelPng } from './gltf-fixtures';
import { exportGlb, GltfExportError, type GltfExportProblem } from './gltf-export';
import { importGltf } from './gltf';
import { poseAt, skinMatrices, skinnedPositions, worldMatrices } from './evaluate';
import { characterAssetMediaTypes, type CharacterDocument, type CharacterKey } from './model';

/** Character-space positions of a part's referenced vertices at `tick` (morphs, then skin). */
function shape(doc: CharacterDocument, meshes: Map<string, EpmMesh>, partId: string, tick: number) {
  const action = doc.actions[0] ?? null;
  const pose = poseAt(doc, action, tick);
  const part = doc.parts.find((p) => p.id === partId)!;
  const mesh = meshes.get(part.mesh)!;
  const positions = mesh.positions.slice();
  for (const m of mesh.morphs) {
    const wt = pose.morphs.get(m.id) ?? 0;
    for (let i = 0; i < positions.length; i++) positions[i] += wt * m.deltas[i];
  }
  const world = worldMatrices(doc, pose);
  const skin = doc.skins.find((s) => s.partId === partId)!;
  const out = skinnedPositions({ ...mesh, positions }, skinMatrices(skin, mesh, world.bones));
  const used = [...new Set(mesh.faceIndices)];
  return used.map((v) => [out[3 * v], out[3 * v + 1], out[3 * v + 2]]);
}
/** The farthest any point of one set is from the nearest point of the other (mm). */
function distance(a: number[][], b: number[][]) {
  const one = (x: number[][], y: number[][]) =>
    Math.max(
      ...x.map((p) => Math.min(...y.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])))),
    );
  return Math.max(one(a, b), one(b, a));
}
const problem = (f: () => unknown): GltfExportProblem | undefined => {
  try {
    f();
  } catch (e) {
    if (e instanceof GltfExportError) return e.problem;
    throw e;
  }
  return undefined;
};

describe('GLB export (C6c, TS-1267)', () => {
  it('writes a GLB the importer reads back with the same IDs, keys and shape', () => {
    const f = blockyFigure();
    const out = exportGlb(f.doc, f.meshes, new Map());
    const view = new DataView(out.bytes.buffer);
    expect(view.getUint32(0, true)).toBe(0x46546c67);
    expect(view.getUint32(8, true)).toBe(out.bytes.length);
    expect(out.bytes.length % 4).toBe(0);
    // The figure's boxes are quads: triangulating them is the only loss.
    expect(out.losses).toEqual(['polygons-triangulated ×66']);
    const r = importGltf(out.bytes);
    const d = r.doc;
    expect(d.name).toBe('Blocky figure');
    expect(d.parts.map((p) => p.id)).toEqual(['body']);
    expect(d.materials.map((m) => [m.id, m.name, m.color, m.roughness, m.metalness])).toEqual(
      f.doc.materials.map((m) => [m.id, m.name, m.color, m.roughness, m.metalness]),
    );
    expect(d.skeletons.map((s) => [s.id, s.name, s.parentPartId])).toEqual([['rig', 'Rig', null]]);
    expect(new Set(d.skeletons[0].bones.map((b) => b.id))).toEqual(
      new Set(f.doc.skeletons[0].bones.map((b) => b.id)),
    );
    for (const b of d.skeletons[0].bones) {
      const o = f.doc.skeletons[0].bones.find((x) => x.id === b.id)!;
      expect(b.parentId).toBe(o.parentId);
      b.rest.translation.forEach((x, k) => expect(x).toBeCloseTo(o.rest.translation[k], 3));
    }
    expect(d.actions.map((a) => [a.id, a.name, a.duration])).toEqual(
      f.doc.actions.map((a) => [a.id, a.name, a.duration]),
    );
    expect(d.morphs.map((m) => [m.name, m.weight])).toEqual([['Chest wide', 0]]);
    // Linear keys are copied: the same ticks and values.
    const keys = (doc: CharacterDocument, bone: string): CharacterKey[] =>
      doc.actions[0].tracks.find((t) => t.target.kind === 'bone' && t.target.id === bone)!.keys;
    const a = keys(f.doc, 'arm.R'),
      b = keys(d, 'arm.R');
    expect(b.map((k) => k.tick)).toEqual(a.map((k) => k.tick));
    b.forEach((k, i) =>
      (k.value as number[]).forEach((x, c) =>
        expect(x).toBeCloseTo((a[i].value as number[])[c], 5),
      ),
    );
    // The morph keeps its ID (C6d reads ep_morph_ids), and so do its weight keys' target.
    const chest = d.actions[0].tracks.find((t) => t.target.kind === 'morph')!;
    expect((chest.target as { id?: string }).id).toBe('chest-wide');
    expect(chest.keys.map((k) => [k.tick, k.value])).toEqual([
      [0, 0],
      [120000, 1],
      [240000, 0],
    ]);
    expect(d.morphs.map((m) => m.id)).toEqual(['chest-wide']);
    const json = JSON.parse(
      new TextDecoder().decode(out.bytes.subarray(20, 20 + view.getUint32(12, true))),
    );
    expect(json.meshes[0].extras).toEqual({
      targetNames: ['Chest wide'],
      ep_morph_ids: ['chest-wide'],
    });
    // The same deformed shape at rest and between keys (morph and skin together).
    for (const tick of [0, 60000, 120000, 200000]) {
      const before = shape(f.doc, f.meshes, 'body', tick);
      const after = shape(d, r.meshes, 'body', tick);
      expect(distance(before, after)).toBeLessThan(0.01);
    }
  });

  it('bakes IK into per-frame rotations and reports the chain', () => {
    const f = blockyFigure();
    const doc = structuredClone(f.doc);
    doc.skeletons[0].ik = [
      {
        id: 'ik-arm',
        name: 'Arm IK',
        tipBoneId: 'forearm.R',
        length: 1,
        target: [-300, 0, 1150],
        pole: null,
        enabled: true,
      },
    ];
    doc.skeletons[0].bones.find((b) => b.id === 'spine')!.limits = {
      min: [-30, -30, -30],
      max: [30, 30, 30],
    };
    const out = exportGlb(doc, f.meshes, new Map());
    expect(out.losses).toEqual(['bone-limits', 'ik-baked', 'polygons-triangulated ×66']);
    const r = importGltf(out.bytes);
    const arm = r.doc.actions[0].tracks.find(
      (t) => t.target.kind === 'bone' && t.target.id === 'arm.R',
    )!;
    // One key per frame of the 1 s action at 30 fps, and its end.
    expect(arm.keys.length).toBe(31);
    for (const tick of [0, 40000, 120000, 240000]) {
      const before = shape(doc, f.meshes, 'body', tick);
      const after = shape(r.doc, r.meshes, 'body', tick);
      expect(distance(before, after)).toBeLessThan(0.01);
    }
  });

  it('writes materials with their textures, opacity and sides', () => {
    const f = blockyFigure();
    const doc = structuredClone(f.doc);
    const sha = epmSha256(onePixelPng);
    doc.assets.push({
      id: 'img',
      kind: 'texture-png',
      sha256: sha,
      byteLength: onePixelPng.length,
      mediaType: characterAssetMediaTypes['texture-png'],
    });
    Object.assign(doc.materials[0], {
      opacity: 0.5,
      doubleSided: true,
      maps: { color: 'img', normal: 'img', roughness: 'img' },
    });
    const out = exportGlb(doc, f.meshes, new Map([['img', onePixelPng]]));
    expect(out.losses).toContain('roughness-map');
    const r = importGltf(out.bytes);
    const m = r.doc.materials.find((x) => x.id === 'mat-body')!;
    expect([m.color, m.opacity, m.doubleSided]).toEqual(['#4a7bd0', 0.5, true]);
    expect(m.maps.color).toBe(m.maps.normal);
    expect(r.doc.assets.find((a) => a.id === m.maps.color)!.sha256).toBe(sha);
  });

  it('reports what glTF cannot hold and bakes eased keys', () => {
    const f = blockyFigure();
    const doc = structuredClone(f.doc);
    doc.parts[0].visible = false;
    doc.parts[0].subdivision = { levels: 1, renderLevels: 2 };
    doc.props.push({
      id: 'prop',
      name: 'Prop',
      source: {
        kind: 'cad',
        artifactId: 'a',
        versionId: 'v',
        contentHash: '0'.repeat(64),
      },
      placement: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
      visible: true,
    });
    const action = doc.actions[1];
    action.frameRate = { numerator: 24, denominator: 1 };
    action.tracks[0].keys[0].easing = { type: 'bezier', x1: 0.4, y1: 0, x2: 0.6, y2: 1 };
    action.tracks.push({
      id: 'walk-prop',
      target: { kind: 'prop-joint', id: 'prop', joint: 'j', property: 'angle' },
      keys: [{ id: 'walk-prop-0', tick: 0, value: 0, easing: { type: 'linear' } }],
    });
    const out = exportGlb(doc, f.meshes, new Map());
    expect(out.losses).toEqual([
      'eased-keys-baked',
      'frame-rate',
      'hidden-part',
      'polygons-triangulated ×66',
      'prop',
      'prop-joint-track',
      'subdivision',
    ]);
    const r = importGltf(out.bytes);
    const walk = r.doc.actions.find((a) => a.id === 'walk')!;
    const thigh = walk.tracks.find((t) => t.target.kind === 'bone' && t.target.id === 'thigh.L')!;
    // 24 frames and the end: sampled with the eased curve.
    expect(thigh.keys.length).toBe(25);
    const baked = poseAt(r.doc, walk, 50000).bones.get('thigh.L')!.rotation;
    const want = poseAt(doc, action, 50000).bones.get('thigh.L')!.rotation;
    const dot = Math.abs(baked.reduce((s, x, k) => s + x * want[k], 0));
    expect(dot).toBeGreaterThan(0.9999);
  });

  it('refuses a document it cannot write', () => {
    const f = blockyFigure();
    expect(problem(() => exportGlb(f.doc, new Map(), new Map()))).toBe('missing-asset');
    const bad = structuredClone(f.doc);
    bad.morphs[0].weight = Number.NaN;
    expect(problem(() => exportGlb(bad, f.meshes, new Map()))).toBe('document');
    const empty = structuredClone(f.doc);
    empty.parts = [];
    empty.skins = [];
    empty.morphs = [];
    empty.actions = [];
    expect(problem(() => exportGlb(empty, f.meshes, new Map()))).toBe('document');
    const textured = structuredClone(f.doc);
    textured.assets.push({
      id: 'img',
      kind: 'texture-png',
      sha256: epmSha256(onePixelPng),
      byteLength: onePixelPng.length,
      mediaType: 'image/png',
    });
    textured.materials[0].maps = { color: 'img' };
    expect(problem(() => exportGlb(textured, f.meshes, new Map()))).toBe('missing-asset');
  });
});

describe('GLB export: readable output only (C6c review, TS-1268)', () => {
  const json = (bytes: Uint8Array) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + view.getUint32(12, true))));
  };
  it('refuses keys that meet in float32 seconds', () => {
    const f = blockyFigure();
    const doc = structuredClone(f.doc);
    const a = doc.actions[1];
    a.duration = 24000002;
    a.tracks[0].keys = [
      { ...a.tracks[0].keys[0], tick: 0 },
      { ...a.tracks[0].keys[1], tick: 24000001 },
      { ...a.tracks[0].keys[2], tick: 24000002 },
    ];
    expect(problem(() => exportGlb(doc, f.meshes, new Map()))).toBe('limit');
  });
  it('bounds the frames it bakes, and makes none for copied keys', () => {
    const f = blockyFigure();
    const doc = structuredClone(f.doc);
    doc.actions[1].frameRate = { numerator: Number.MAX_SAFE_INTEGER, denominator: 1 };
    // Linear keys only: nothing is baked, so the rate does not matter (only reported).
    expect(exportGlb(doc, f.meshes, new Map()).losses).toContain('frame-rate');
    doc.actions[1].tracks[0].keys[0].easing = { type: 'bezier', x1: 0.4, y1: 0, x2: 0.6, y2: 1 };
    expect(problem(() => exportGlb(doc, f.meshes, new Map()))).toBe('limit');
  });
  it('gives several root bones at the origin one common ancestor', () => {
    const f = blockyFigure();
    const doc = structuredClone(f.doc);
    doc.skeletons[0].bones.push({
      id: 'extra',
      name: 'extra',
      parentId: null,
      rest: { translation: [0, 300, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    });
    const out = exportGlb(doc, f.meshes, new Map());
    const j = json(out.bytes);
    const parent = new Map<number, number>();
    j.nodes.forEach((n: { children?: number[] }, i: number) =>
      (n.children ?? []).forEach((c) => parent.set(c, i)),
    );
    const roots = new Set(
      j.skins[0].joints.map((k: number) => {
        let at = k;
        while (parent.has(at)) at = parent.get(at)!;
        return at;
      }),
    );
    expect(roots.size).toBe(1);
    const group = j.nodes[[...roots][0] as number];
    expect(group).toEqual({ name: 'Rig', children: expect.any(Array) });
    const r = importGltf(out.bytes);
    expect(r.doc.skeletons[0].bones.find((b) => b.id === 'extra')!.parentId).toBeNull();
    expect(
      distance(shape(doc, f.meshes, 'body', 60000), shape(r.doc, r.meshes, 'body', 60000)),
    ).toBeLessThan(0.01);
  });
  it('writes the solved IK pose as the static pose', () => {
    const f = blockyFigure();
    const doc = structuredClone(f.doc);
    doc.actions = [];
    doc.skeletons[0].ik = [
      {
        id: 'ik-arm',
        name: 'Arm IK',
        tipBoneId: 'forearm.R',
        length: 1,
        target: [-300, 0, 1150],
        pole: null,
        enabled: true,
      },
    ];
    const r = importGltf(exportGlb(doc, f.meshes, new Map()).bytes);
    expect(
      distance(shape(doc, f.meshes, 'body', 0), shape(r.doc, r.meshes, 'body', 0)),
    ).toBeLessThan(0.01);
  });
  it('refuses a part whose mesh has no faces', () => {
    const f = blockyFigure();
    const mesh = f.meshes.get('mesh-body')!;
    const empty = {
      ...mesh,
      faceSizes: new Uint32Array(0),
      faceIndices: new Uint32Array(0),
      faceMaterials: new Uint16Array(0),
      uvs: undefined,
    };
    expect(problem(() => exportGlb(f.doc, new Map([['mesh-body', empty]]), new Map()))).toBe(
      'document',
    );
  });
});
