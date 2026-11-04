import { decodeEpm } from '@editor-platform/geometry-mesh';
import { describe, expect, it } from 'vitest';
import {
  applyCharacterOperation,
  characterCubePart,
  characterMorphAdd,
  characterMorphRemove,
  characterMorphShape,
  characterMorphedMesh,
  checkCharacterMeshes,
  emptyCharacter,
  poseAt,
  CharacterValidationError,
  type CharacterDocument,
} from './index';

const RATE = { numerator: 30, denominator: 1 };
const codes = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof CharacterValidationError) return e.diagnostics.map((d) => d.code);
    throw e;
  }
  return [];
};

/** A cube part, with its decoded mesh by asset ID. */
function cube() {
  const empty = emptyCharacter();
  const c = characterCubePart(empty, 200);
  const doc = applyCharacterOperation(empty, c.op);
  const meshes = new Map([[c.ref.id, decodeEpm(c.bytes)]]);
  return { doc, meshes, partId: c.op.part.id };
}

describe('morphs in the document (C6a, TS-1261)', () => {
  it('adds a zero morph in one edit: the mesh and the document agree, and IDs are fresh', () => {
    const { doc, meshes, partId } = cube();
    const mesh = meshes.get(doc.parts[0]!.mesh)!;
    const add = characterMorphAdd(doc, partId, mesh, 'Smile');
    const next = applyCharacterOperation(doc, add.op);
    meshes.set(add.ref.id, decodeEpm(add.bytes));
    expect(next.morphs).toEqual([{ id: add.op.morph.id, partId, name: 'Smile', weight: 0 }]);
    const shown = meshes.get(next.parts[0]!.mesh)!;
    expect(shown.morphs.map((m) => m.id)).toEqual([add.op.morph.id]);
    expect([...shown.morphs[0]!.deltas].every((d) => d === 0)).toBe(true);
    expect(shown.positions).toEqual(mesh.positions);
    expect(checkCharacterMeshes(next, meshes)).toEqual([]);
    // A second one comes last, with its own ID.
    const again = characterMorphAdd(next, partId, shown, 'Blink');
    const two = applyCharacterOperation(next, again.op);
    meshes.set(again.ref.id, decodeEpm(again.bytes));
    expect(two.morphs.map((m) => m.name)).toEqual(['Smile', 'Blink']);
    expect(new Set(two.morphs.map((m) => m.id)).size).toBe(2);
    expect(checkCharacterMeshes(two, meshes)).toEqual([]);
    // The input never changes.
    expect(doc.morphs).toEqual([]);
  });

  it('sets the default weight, refusing a weight past ±10 or not finite', () => {
    const { doc, meshes, partId } = cube();
    const add = characterMorphAdd(doc, partId, meshes.get(doc.parts[0]!.mesh)!, 'Smile');
    const d = applyCharacterOperation(doc, add.op);
    const id = add.op.morph.id;
    const set = applyCharacterOperation(d, { type: 'setMorphWeight', id, weight: 0.4 });
    expect(set.morphs[0]!.weight).toBe(0.4);
    expect(poseAt(set, null, 0).morphs.get(id)).toBe(0.4);
    expect(
      codes(() => applyCharacterOperation(d, { type: 'setMorphWeight', id, weight: 11 })),
    ).toContain('weight');
    expect(
      codes(() => applyCharacterOperation(d, { type: 'setMorphWeight', id, weight: Number.NaN })),
    ).toContain('number');
    expect(
      codes(() => applyCharacterOperation(d, { type: 'setMorphWeight', id: 'nope', weight: 0 })),
    ).toContain('missing-target');
  });

  it('removes a morph with the tracks that drive it; its ID is never given out again', () => {
    const { doc, meshes, partId } = cube();
    const add = characterMorphAdd(doc, partId, meshes.get(doc.parts[0]!.mesh)!, 'Smile');
    let d: CharacterDocument = applyCharacterOperation(doc, add.op);
    meshes.set(add.ref.id, decodeEpm(add.bytes));
    const id = add.op.morph.id;
    d = {
      ...d,
      actions: [{ id: 'walk', name: 'Walk', duration: 240000, frameRate: RATE, tracks: [] }],
    };
    d = applyCharacterOperation(d, {
      type: 'setKey',
      actionId: 'walk',
      target: { kind: 'morph', id, property: 'weight' },
      tick: 0,
      value: 1,
      trackId: 'walk/smile',
      keyId: 'walk/smile#0',
    });
    expect(d.actions[0]!.tracks).toHaveLength(1);
    const rm = characterMorphRemove(d, id, meshes.get(d.parts[0]!.mesh)!);
    const gone = applyCharacterOperation(d, rm.op);
    meshes.set(rm.ref.id, decodeEpm(rm.bytes));
    // A keyed weight has the same bound as the one without an action.
    expect(
      codes(() =>
        applyCharacterOperation(d, {
          type: 'setKey',
          actionId: 'walk',
          target: { kind: 'morph', id, property: 'weight' },
          tick: 120000,
          value: 10.5,
          trackId: 'walk/smile',
          keyId: 'walk/smile#120000',
        }),
      ),
    ).toContain('weight');
    expect(gone.morphs).toEqual([]);
    expect(gone.actions[0]!.tracks).toEqual([]);
    expect(gone.retiredIds).toContain(id);
    expect(checkCharacterMeshes(gone, meshes)).toEqual([]);
    const fresh = characterMorphAdd(gone, partId, meshes.get(gone.parts[0]!.mesh)!, 'Smile');
    expect(fresh.op.morph.id).not.toBe(id);
  });

  it('refuses a morph for a missing part, and a mesh whose morphs disagree with the document', () => {
    const { doc, meshes, partId } = cube();
    const mesh = meshes.get(doc.parts[0]!.mesh)!;
    expect(() => characterMorphAdd(doc, 'nope', mesh, 'Smile')).toThrow('missing-target');
    const add = characterMorphAdd(doc, partId, mesh, 'Smile');
    expect(
      codes(() =>
        applyCharacterOperation(doc, { ...add.op, morph: { ...add.op.morph, partId: 'nope' } }),
      ),
    ).toContain('missing-target');
    // The document names the morph, but the part still points at the mesh without it.
    const wrong = applyCharacterOperation(doc, { ...add.op, asset: { ...add.ref } });
    meshes.set(add.ref.id, mesh);
    expect(checkCharacterMeshes(wrong, meshes).map((d) => d.code)).toContain('morph-mismatch');
    expect(() => characterMorphRemove(doc, 'nope', mesh)).toThrow('missing-target');
  });
});

describe('a morph shape (C6b, TS-1264)', () => {
  it('stores the moved cage as the morph deltas, and nothing else of the mesh changes', () => {
    const { doc, meshes, partId } = cube();
    const mesh = meshes.get(doc.parts[0]!.mesh)!;
    const add = characterMorphAdd(doc, partId, mesh, 'Smile');
    const d = applyCharacterOperation(doc, add.op);
    const withMorph = decodeEpm(add.bytes);
    meshes.set(add.ref.id, withMorph);
    const id = add.op.morph.id;
    // Moved as the morph shows it: vertex 0 up by 30 mm.
    const shaped = characterMorphedMesh(withMorph, id).positions.slice();
    shaped[2]! += 30;
    const e = characterMorphShape(d, partId, withMorph, id, shaped);
    const next = applyCharacterOperation(d, e.op);
    const out = decodeEpm(e.bytes);
    meshes.set(e.ref.id, out);
    expect(checkCharacterMeshes(next, meshes)).toEqual([]);
    expect(out.positions).toEqual(withMorph.positions);
    expect(out.faceSizes).toEqual(withMorph.faceSizes);
    expect([...out.morphs[0]!.deltas].filter((x) => x !== 0)).toEqual([30]);
    expect(out.morphs[0]!.deltas[2]).toBe(30);
    // Edited again from the shown shape, the deltas add up.
    const again = characterMorphedMesh(out, id).positions.slice();
    again[2]! += 5;
    expect(
      decodeEpm(characterMorphShape(next, partId, out, id, again).bytes).morphs[0]!.deltas[2],
    ).toBe(35);
    expect(next.morphs).toEqual(d.morphs);
  });

  it('refuses another vertex count, a value that is not finite, and a morph not of the part', () => {
    const { doc, meshes, partId } = cube();
    const mesh = meshes.get(doc.parts[0]!.mesh)!;
    const add = characterMorphAdd(doc, partId, mesh, 'Smile');
    const d = applyCharacterOperation(doc, add.op);
    const withMorph = decodeEpm(add.bytes);
    const id = add.op.morph.id;
    const shown = characterMorphedMesh(withMorph, id).positions;
    expect(() => characterMorphShape(d, partId, withMorph, id, shown.slice(3))).toThrow(
      'character-morph-shape',
    );
    const bad = shown.slice();
    bad[0] = Number.NaN;
    expect(() => characterMorphShape(d, partId, withMorph, id, bad)).toThrow(
      'character-morph-shape',
    );
    expect(() => characterMorphShape(d, 'nope', withMorph, id, shown)).toThrow('missing-target');
    expect(() => characterMorphShape(d, partId, mesh, id, shown)).toThrow('missing-target');
    expect(() => characterMorphedMesh(mesh, id)).toThrow('missing-target');
  });
});
