import {
  cornerTangents,
  editInput,
  encodeRgbPng,
  meshEdges,
  unwrapMesh,
} from '@editor-platform/geometry-mesh';
import { describe, expect, it } from 'vitest';
import {
  applyCharacterOperation,
  blockyFigure,
  characterMeshEdit,
  characterNormalBake,
  characterSharedMaterials,
  exportGlb,
  importGltf,
  validateCharacter,
} from './index';

const json = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + view.getUint32(12, true))));
};

describe('a baked normal map in the document and the GLB (C7d, TS-1281)', () => {
  it('puts the map on the part materials, copying the ones other parts share when asked', async () => {
    const f = blockyFigure();
    // A second part that shares the figure's body material.
    f.doc.parts.push({
      ...structuredClone(f.doc.parts[0]),
      id: 'part-twin',
      name: 'Twin',
      parentId: null,
      materials: ['mat-body'],
    });
    expect(validateCharacter(f.doc)).toEqual([]);
    const part = f.doc.parts[0];
    const at = 0;
    const png = await encodeRgbPng(new Uint8Array(3 * 4).fill(128), 2, 2);
    const shared = characterSharedMaterials(f.doc, part.id);
    expect(shared.length).toBeGreaterThan(0);
    expect(() => characterNormalBake(f.doc, part.id, png, false)).toThrow(
      'character-material-shared',
    );
    expect(() => characterNormalBake(f.doc, part.id, new Uint8Array([1, 2, 3]), true)).toThrow(
      'character-image-format',
    );
    const e = characterNormalBake(f.doc, part.id, png, true);
    expect(e.op.copies.map((c) => c.from)).toEqual(shared);
    const doc = applyCharacterOperation(f.doc, e.op);
    expect(validateCharacter(doc)).toEqual([]);
    const mine = doc.parts[at].materials;
    expect(mine.some((id) => shared.includes(id))).toBe(false);
    for (const id of mine)
      expect(doc.materials.find((m) => m.id === id)!.maps.normal).toBe(e.ref.id);
    // The other parts keep their materials, without the map.
    for (const p of doc.parts.filter((x) => x.id !== part.id))
      for (const id of p.materials)
        expect(doc.materials.find((m) => m.id === id)!.maps.normal).toBeUndefined();
    expect(doc.assets.find((a) => a.id === e.ref.id)?.kind).toBe('texture-png');
    // Cleared: the ref leaves the content.
    const cleared = applyCharacterOperation(doc, {
      type: 'setPartNormalMap',
      id: part.id,
      asset: null,
      copies: [],
    });
    expect(cleared.assets.some((a) => a.id === e.ref.id)).toBe(false);
    // A copy of a material the part does not use is refused.
    expect(() =>
      applyCharacterOperation(f.doc, {
        ...e.op,
        copies: [{ from: 'nope', id: 'x', name: 'x' }],
      }),
    ).toThrow();
    // A part whose materials nobody else uses needs no copies.
    expect(characterNormalBake(doc, part.id, png, false).op.copies).toEqual([]);
  });

  it('writes TANGENT (the bake tangents, in glTF axes) only for parts with a normal map', async () => {
    const f = blockyFigure();
    const part = f.doc.parts[0];
    const cage = f.meshes.get(part.mesh)!;
    const input = editInput(cage);
    const unwrapped = unwrapMesh(input, meshEdges(input.mesh, input.topology));
    const edit = characterMeshEdit(f.doc, part.id, unwrapped);
    let doc = applyCharacterOperation(f.doc, edit.op);
    const meshes = new Map([...f.meshes, [edit.ref.id, unwrapped]]);
    const plain = json(exportGlb(doc, meshes, new Map()).bytes);
    expect(
      plain.meshes.some((m: { primitives: { attributes: object }[] }) =>
        m.primitives.some((p) => 'TANGENT' in p.attributes),
      ),
    ).toBe(false);
    const png = await encodeRgbPng(new Uint8Array(3 * 4).fill(128), 2, 2);
    const bake = characterNormalBake(doc, part.id, png, true);
    doc = applyCharacterOperation(doc, bake.op);
    const out = exportGlb(doc, meshes, new Map([[bake.ref.id, png]]));
    const g = json(out.bytes);
    const withTangent = g.meshes
      .map((m: { primitives: { attributes: Record<string, number> }[] }, i: number) =>
        m.primitives.some((p) => 'TANGENT' in p.attributes) ? i : -1,
      )
      .filter((i: number) => i >= 0);
    expect(withTangent).toEqual([g.nodes.find((n: { name: string }) => n.name === part.name).mesh]);
    const prim = g.meshes[withTangent[0]].primitives[0];
    const acc = g.accessors[prim.attributes.TANGENT];
    expect(acc.type).toBe('VEC4');
    expect(acc.count).toBe(g.accessors[prim.attributes.POSITION].count);
    // Read the tangents back: unit, at right angles to NORMAL, w ±1.
    const bin = out.bytes.subarray(
      20 + new DataView(out.bytes.buffer, out.bytes.byteOffset).getUint32(12, true) + 8,
    );
    const read = (a: number, n: number) => {
      const accessor = g.accessors[a];
      const view = g.bufferViews[accessor.bufferView];
      const off = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
      return new Float32Array(bin.slice(off, off + 4 * n * accessor.count).buffer);
    };
    const tan = read(prim.attributes.TANGENT, 4),
      nor = read(prim.attributes.NORMAL, 3);
    for (let i = 0; i < acc.count; i++) {
      const t = tan.subarray(4 * i, 4 * i + 3);
      expect(Math.hypot(...t)).toBeCloseTo(1, 4);
      expect(
        Math.abs(t[0] * nor[3 * i] + t[1] * nor[3 * i + 1] + t[2] * nor[3 * i + 2]),
      ).toBeLessThan(1e-4);
      expect(Math.abs(tan[4 * i + 3])).toBe(1);
    }
    // The formula is the bake's: the first corner's tangent, turned into glTF's axes.
    const t0 = cornerTangents(unwrapped)!;
    expect([tan[0], tan[1], tan[2], tan[3]].map((x) => Math.round(x * 1e4))).toEqual(
      [t0[0], t0[2], -t0[1], t0[3]].map((x) => Math.round(x * 1e4)),
    );
    // The GLB imports again.
    expect(importGltf(out.bytes).doc.parts.length).toBe(doc.parts.length);
  });
});
