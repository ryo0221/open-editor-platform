import {
  decodeMultiresChunk,
  editInput,
  extrudeFaces,
  MeshEditError,
  multiresChunkCount,
  multiresGridSize,
  type MultiresChunk,
} from '@editor-platform/geometry-mesh';
import { describe, expect, it } from 'vitest';
import {
  applyCharacterOperation,
  blockyFigure,
  characterMeshEdit,
  characterMultiresAdd,
  characterMultiresDisplacements,
  characterMultiresRaise,
  characterMultiresRemove,
  characterMultiresSet,
  checkCharacterMeshes,
  CharacterValidationError,
  exportGlb,
  validateCharacter,
  type CharacterDocument,
} from './index';
import type { CharacterMultiresEdit } from './multires';

const codes = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof CharacterValidationError) return e.diagnostics.map((d) => d.code);
    throw e;
  }
  return [];
};
/** Applies a multires edit and keeps its chunks, as the Host would. */
function apply(
  doc: CharacterDocument,
  edit: CharacterMultiresEdit,
  store: Map<string, MultiresChunk>,
): CharacterDocument {
  for (const a of edit.assets) store.set(a.ref.id, decodeMultiresChunk(a.bytes));
  return applyCharacterOperation(doc, edit.op);
}

describe('multires in the document (C7a, TS-1275)', () => {
  it('adds a multires in one edit: one zero chunk asset per chunk, checked against the cage', () => {
    const f = blockyFigure();
    const part = f.doc.parts[0];
    const mesh = f.meshes.get(part.mesh)!;
    const store = new Map<string, MultiresChunk>();
    const doc = apply(f.doc, characterMultiresAdd(f.doc, part.id, mesh, 3), store);
    const mr = doc.parts[0].multires!;
    expect(mr.level).toBe(3);
    expect(mr.chunks.length).toBe(multiresChunkCount(mesh.faceIndices.length, 3));
    expect(doc.assets.filter((a) => a.kind === 'mesh-mres').length).toBe(mr.chunks.length);
    expect(validateCharacter(doc)).toEqual([]);
    expect(checkCharacterMeshes(doc, f.meshes, store)).toEqual([]);
    const d = characterMultiresDisplacements(mr, mesh, store);
    expect(d.length).toBe(3 * mesh.faceIndices.length * multiresGridSize(3) ** 2);
    expect(d.every((x) => x === 0)).toBe(true);
    // A part has one multires.
    expect(() => characterMultiresAdd(doc, part.id, mesh, 2)).toThrow('character-multires-exists');
    // The cage asset is still the part's mesh: skin, morphs and export keep reading it.
    expect(doc.parts[0].mesh).toBe(part.mesh);
    expect(exportGlb(doc, f.meshes, new Map()).losses).toContain('multires');
  });

  it('rewrites only the chunks a change touches; the rest keep their assets (C7f, TS-1289)', () => {
    const f = blockyFigure();
    const part = f.doc.parts[0];
    const mesh = f.meshes.get(part.mesh)!;
    const store = new Map<string, MultiresChunk>();
    const doc = apply(f.doc, characterMultiresAdd(f.doc, part.id, mesh, 4), store);
    const before = doc.parts[0].multires!.chunks;
    expect(before.length).toBeGreaterThan(2);
    const d = characterMultiresDisplacements(doc.parts[0].multires!, mesh, store);
    d[5] = 12.5; // a point of the first corner grid
    const edit = characterMultiresSet(doc, part.id, mesh, 4, d);
    const after = apply(doc, edit, store).parts[0].multires!.chunks;
    expect(after[0]).not.toBe(before[0]);
    expect(after.slice(1)).toEqual(before.slice(1));
    const next = apply(doc, edit, store);
    expect(characterMultiresDisplacements(next.parts[0].multires!, mesh, store)[5]).toBe(12.5);
    // The replaced chunk's ref leaves the content (its bytes stay with the Host for Undo).
    expect(next.assets.some((a) => a.id === before[0])).toBe(false);
    expect(next.assets.filter((a) => a.kind === 'mesh-mres').length).toBe(before.length);
    // C7f: told which corner grids changed, only their chunks are encoded; the edit is the same.
    const quick = characterMultiresSet(doc, part.id, mesh, 4, d, new Set([0]));
    expect(quick.assets.length).toBe(1);
    expect(quick.op).toEqual(edit.op);
    expect(apply(doc, quick, store).parts[0].multires!.chunks).toEqual(after);
    // A last corner's change rewrites the last chunk only.
    const last = d.slice();
    last[last.length - 1] = 3;
    const tail = characterMultiresSet(
      doc,
      part.id,
      mesh,
      4,
      last,
      new Set([mesh.faceIndices.length - 1]),
    );
    expect(tail.assets.length).toBe(1);
    expect(tail.op.assets.slice(0, -1)).toEqual(
      before.slice(0, -1).map((id) => doc.assets.find((a) => a.id === id)),
    );
    // Corners given for another level (no such chunks yet): every chunk is written.
    expect(
      characterMultiresSet(
        doc,
        part.id,
        mesh,
        3,
        new Float32Array(3 * mesh.faceIndices.length * 25),
        new Set([0]),
      ).assets.length,
    ).toBe(
      before.length === 0
        ? 0
        : characterMultiresSet(
            doc,
            part.id,
            mesh,
            3,
            new Float32Array(3 * mesh.faceIndices.length * 25),
          ).assets.length,
    );
  });

  it('raises a level and removes the multires', () => {
    const f = blockyFigure();
    const part = f.doc.parts[0];
    const mesh = f.meshes.get(part.mesh)!;
    const store = new Map<string, MultiresChunk>();
    let doc = apply(f.doc, characterMultiresAdd(f.doc, part.id, mesh, 2), store);
    const d = characterMultiresDisplacements(doc.parts[0].multires!, mesh, store).map((_, i) =>
      i % 3 === 2 ? 4 : 0,
    );
    doc = apply(doc, characterMultiresSet(doc, part.id, mesh, 2, d), store);
    doc = apply(doc, characterMultiresRaise(doc, part.id, mesh, store), store);
    expect(doc.parts[0].multires!.level).toBe(3);
    const up = characterMultiresDisplacements(doc.parts[0].multires!, mesh, store);
    expect(up.every((x, i) => x === (i % 3 === 2 ? 4 : 0))).toBe(true);
    expect(checkCharacterMeshes(doc, f.meshes, store)).toEqual([]);
    const removed = applyCharacterOperation(doc, characterMultiresRemove(doc, part.id));
    expect(removed.parts[0].multires).toBeUndefined();
    expect(removed.assets.some((a) => a.kind === 'mesh-mres')).toBe(false);
    expect(() => characterMultiresRemove(removed, part.id)).toThrow('character-multires-missing');
  });

  it('refuses a level past the vertex limit before allocating its displacements', () => {
    // A 100 × 100 quad sheet at level 7 would be 163,865,601 vertices (about 2 GB of grids).
    const n = 100;
    const positions = new Float32Array(3 * (n + 1) * (n + 1));
    for (let j = 0; j <= n; j++)
      for (let i = 0; i <= n; i++) positions.set([10 * i, 10 * j, 0], 3 * (j * (n + 1) + i));
    const faceIndices = new Uint32Array(4 * n * n);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const v = j * (n + 1) + i;
        faceIndices.set([v, v + 1, v + n + 2, v + n + 1], 4 * (j * n + i));
      }
    const sheet = {
      positions,
      faceSizes: new Uint32Array(n * n).fill(4),
      faceIndices,
      faceMaterials: new Uint16Array(n * n),
      boneIds: [],
      morphs: [],
    };
    const f = blockyFigure();
    const partId = f.doc.parts[0].id;
    expect(() => characterMultiresAdd(f.doc, partId, sheet, 7)).toThrow(MeshEditError);
    // Raising checks the level it goes to: level 2 of the sheet fits, level 7 would not.
    const store = new Map<string, MultiresChunk>();
    const doc = apply(f.doc, characterMultiresAdd(f.doc, partId, sheet, 6 - 4), store);
    expect(doc.parts[0].multires!.level).toBe(2);
    const at6 = structuredClone(doc);
    at6.parts[0].multires!.level = 6;
    expect(() => characterMultiresRaise(at6, partId, sheet, store)).toThrow(MeshEditError);
  });

  it('reaches level 6 on the figure (about 270,000 vertices)', () => {
    const f = blockyFigure();
    const part = f.doc.parts[0];
    const mesh = f.meshes.get(part.mesh)!;
    const store = new Map<string, MultiresChunk>();
    const doc = apply(f.doc, characterMultiresAdd(f.doc, part.id, mesh, 6), store);
    expect(checkCharacterMeshes(doc, f.meshes, store)).toEqual([]);
  });

  it('refuses a cage whose faces changed, missing or foreign chunks, and malformed fields', () => {
    const f = blockyFigure();
    const part = f.doc.parts[0];
    const mesh = f.meshes.get(part.mesh)!;
    const store = new Map<string, MultiresChunk>();
    const doc = apply(f.doc, characterMultiresAdd(f.doc, part.id, mesh, 3), store);
    // A topology edit of the cage: the grids no longer fit it.
    const extruded = extrudeFaces(editInput(mesh), [0], 50);
    expect(() => characterMeshEdit(doc, part.id, extruded)).toThrow('character-multires-topology');
    // Moving the cage's vertices is allowed: the faces stay.
    const shifted = { ...mesh, positions: mesh.positions.map((x) => x + 1) };
    expect(characterMeshEdit(doc, part.id, shifted).op.type).toBe('setPartMesh');
    // A document that got there anyway is refused when its meshes are checked.
    const edit = characterMeshEdit(f.doc, part.id, extruded);
    const moved = applyCharacterOperation(doc, edit.op);
    const meshes = new Map([...f.meshes, [edit.ref.id, extruded]]);
    expect(checkCharacterMeshes(moved, meshes, store).map((d) => d.code)).toContain(
      'multires-topology',
    );
    expect(() => characterMultiresDisplacements(moved.parts[0].multires!, extruded, store)).toThrow(
      'character-multires-topology',
    );
    // A chunk the Host does not have, or one of another place in the grid order.
    const first = doc.parts[0].multires!.chunks[0];
    const without = new Map(store);
    without.delete(first);
    expect(checkCharacterMeshes(doc, f.meshes, without).map((d) => d.code)).toEqual([
      'multires-missing',
    ]);
    const swapped = structuredClone(doc);
    swapped.parts[0].multires!.chunks.reverse();
    expect(checkCharacterMeshes(swapped, f.meshes, store).map((d) => d.code)).toContain(
      'multires-chunk',
    );
    const short = structuredClone(doc);
    short.parts[0].multires!.chunks.pop();
    expect(checkCharacterMeshes(short, f.meshes, store).map((d) => d.code)).toEqual([
      'multires-chunks',
    ]);
    // Fields: level, topology hash, chunk kinds.
    const bad = (change: (d: CharacterDocument) => void) => {
      const d = structuredClone(doc);
      change(d);
      return validateCharacter(d).map((x) => x.code);
    };
    expect(bad((d) => (d.parts[0].multires!.level = 8))).toContain('multires-level');
    expect(bad((d) => (d.parts[0].multires!.level = 0))).toContain('multires-level');
    expect(bad((d) => (d.parts[0].multires!.topology = 'x'))).toContain('sha256');
    expect(bad((d) => (d.parts[0].multires!.chunks = []))).toContain('multires-chunks');
    expect(bad((d) => (d.parts[0].multires!.chunks[0] = d.parts[0].mesh))).toContain(
      'multires-asset',
    );
    expect(
      bad((d) => ((d.parts[0].multires as unknown as Record<string, unknown>).extra = 1)),
    ).toContain('unknown-key');
    // The operation itself refuses chunks that are not multires assets.
    const op = characterMultiresAdd(f.doc, part.id, mesh, 3).op;
    expect(
      codes(() =>
        applyCharacterOperation(f.doc, {
          ...op,
          assets: op.assets.map((a) => ({ ...a, kind: 'mesh-epm' as const })),
        }),
      ),
    ).toEqual(['multires-asset']);
    expect(codes(() => applyCharacterOperation(f.doc, { ...op, assets: [] }))).toEqual([
      'multires-chunks',
    ]);
  });
});
