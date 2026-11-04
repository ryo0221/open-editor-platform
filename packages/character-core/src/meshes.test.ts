import { EditorSession } from '@editor-platform/editor-core';
import { decodeEpm, editInput, extrudeFaces } from '@editor-platform/geometry-mesh';
import { describe, expect, it } from 'vitest';
import {
  applyCharacterOperation,
  blockyFigure,
  characterContentHash,
  characterCubePart,
  characterEditorCommand,
  characterHistoryOverflow,
  characterMeshEdit,
  checkCharacterMeshes,
  emptyCharacter,
  validateCharacter,
  CharacterValidationError,
  type CharacterDocument,
} from './index';

const codes = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof CharacterValidationError) return e.diagnostics.map((d) => d.code);
    throw e;
  }
  return [];
};
/** Applies an op through a session, as the Surface does. */
const run = (
  s: EditorSession<CharacterDocument>,
  op: Parameters<typeof applyCharacterOperation>[1],
) =>
  s.execute(
    characterEditorCommand(op, {
      expectedHash: characterContentHash(s.content),
      canEdit: () => true,
    }),
  );

describe('mesh parts in the document (TS-1222)', () => {
  it('adds a cube part to an empty character with a new material, and to the figure reusing one', () => {
    const empty = emptyCharacter();
    const cube = characterCubePart(empty, 200);
    const doc = applyCharacterOperation(empty, cube.op);
    expect(doc.parts.map((p) => p.id)).toEqual(['cube']);
    expect(doc.materials).toHaveLength(1);
    expect(doc.parts[0].materials).toEqual([doc.materials[0].id]);
    const meshes = new Map([[cube.ref.id, decodeEpm(cube.bytes)]]);
    expect(checkCharacterMeshes(doc, meshes)).toEqual([]);
    const f = blockyFigure();
    const second = characterCubePart(f.doc);
    const fig = applyCharacterOperation(f.doc, second.op);
    expect(fig.materials).toHaveLength(f.doc.materials.length);
    expect(fig.parts.at(-1)!.materials).toEqual([f.doc.materials[0].id]);
    // IDs are fresh in the one namespace.
    expect(new Set([second.op.part.id, second.ref.id]).size).toBe(2);
  });
  it('swaps the mesh in one undoable edit; the part keeps its ID and Undo the old asset', () => {
    const empty = emptyCharacter();
    const cube = characterCubePart(empty, 200);
    const s = new EditorSession(applyCharacterOperation(empty, cube.op));
    const bytes = new Map([[cube.ref.id, cube.bytes]]);
    const meshOf = (d: CharacterDocument) => decodeEpm(bytes.get(d.parts[0].mesh)!);
    const edited = extrudeFaces(editInput(meshOf(s.content)), [1], 100);
    const e = characterMeshEdit(s.content, 'cube', edited);
    bytes.set(e.ref.id, e.bytes);
    run(s, e.op);
    expect(s.content.parts[0].id).toBe('cube');
    expect(s.content.parts[0].mesh).toBe(e.ref.id);
    // The old ref left the content; its bytes stay with the Host.
    expect(s.content.assets.map((a) => a.id)).toEqual([e.ref.id]);
    expect(meshOf(s.content).positions.length / 3).toBe(12);
    s.undo();
    expect(s.content.parts[0].mesh).toBe(cube.ref.id);
    expect(meshOf(s.content).positions.length / 3).toBe(8);
    s.redo();
    expect(s.content.parts[0].mesh).toBe(e.ref.id);
    // Saved and reloaded as JSON, the document is the same and valid.
    const reloaded = JSON.parse(JSON.stringify(s.content)) as CharacterDocument;
    expect(validateCharacter(reloaded)).toEqual([]);
    expect(characterContentHash(reloaded)).toBe(characterContentHash(s.content));
  });
  it('never reuses an asset ID for other bytes across retained history (two edits, then Undo)', () => {
    const empty = emptyCharacter();
    const cube = characterCubePart(empty, 200);
    const s = new EditorSession(applyCharacterOperation(empty, cube.op));
    const store = new Map([[cube.ref.id, cube.bytes]]);
    const shaOf = new Map([[cube.ref.id, cube.ref.sha256]]);
    for (const d of [50, 80]) {
      const mesh = extrudeFaces(editInput(decodeEpm(store.get(s.content.parts[0].mesh)!)), [1], d);
      const e = characterMeshEdit(s.content, 'cube', mesh);
      // A Host keyed by ID must never be asked to replace bytes it keeps.
      if (store.has(e.ref.id)) expect(shaOf.get(e.ref.id)).toBe(e.ref.sha256);
      store.set(e.ref.id, e.bytes);
      shaOf.set(e.ref.id, e.ref.sha256);
      run(s, e.op);
    }
    s.undo();
    s.undo();
    expect(s.content.parts[0].mesh).toBe(cube.ref.id);
    expect(decodeEpm(store.get(cube.ref.id)!).positions.length / 3).toBe(8);
  });
  it('reuses an asset with the same bytes, so editing back names the old ref', () => {
    const empty = emptyCharacter();
    const cube = characterCubePart(empty, 200);
    const doc = applyCharacterOperation(empty, cube.op);
    const same = characterMeshEdit(doc, 'cube', decodeEpm(cube.bytes));
    const next = applyCharacterOperation(doc, same.op);
    expect(next.parts[0].mesh).toBe(cube.ref.id);
    expect(next.assets).toHaveLength(1);
  });
  it('sets and clears subdivision levels, refusing levels past 4', () => {
    const empty = emptyCharacter();
    const doc = applyCharacterOperation(empty, characterCubePart(empty).op);
    const on = applyCharacterOperation(doc, {
      type: 'setPartSubdivision',
      id: 'cube',
      subdivision: { levels: 2, renderLevels: 3 },
    });
    expect(on.parts[0].subdivision).toEqual({ levels: 2, renderLevels: 3 });
    const off = applyCharacterOperation(on, {
      type: 'setPartSubdivision',
      id: 'cube',
      subdivision: null,
    });
    expect('subdivision' in off.parts[0]).toBe(false);
    expect(
      codes(() =>
        applyCharacterOperation(doc, {
          type: 'setPartSubdivision',
          id: 'cube',
          subdivision: { levels: 5, renderLevels: 0 },
        }),
      ),
    ).toContain('subdivision');
    const bad = structuredClone(on) as unknown as { parts: { subdivision: unknown }[] };
    bad.parts[0].subdivision = { levels: 1, renderLevels: 1, extra: 1 };
    expect(validateCharacter(bad).map((d) => d.code)).toContain('unknown-key');
    expect(
      codes(() =>
        applyCharacterOperation(doc, { type: 'setPartSubdivision', id: 'nope', subdivision: null }),
      ),
    ).toContain('missing-target');
  });
  it('removes a part with its morphs, skin and tracks; refuses one others hang from', () => {
    const f = blockyFigure();
    const doc = structuredClone(f.doc);
    const next = applyCharacterOperation(doc, { type: 'removePart', id: 'body' });
    expect(next.parts).toEqual([]);
    expect(next.morphs).toEqual([]);
    expect(next.skins).toEqual([]);
    expect(next.assets.filter((a) => a.kind === 'mesh-epm')).toEqual([]);
    for (const a of next.actions)
      for (const t of a.tracks) expect(['part', 'morph']).not.toContain(t.target.kind);
    const child = applyCharacterOperation(doc, {
      ...characterCubePart(doc).op,
      part: { ...characterCubePart(doc).op.part, parentId: 'body' },
    });
    expect(
      codes(() => applyCharacterOperation(child, { type: 'removePart', id: 'body' })),
    ).toContain('part-in-use');
  });
  it('never gives a removed element ID to a new one (A2, TS-1243)', () => {
    const empty = emptyCharacter();
    const first = characterCubePart(empty);
    const added = applyCharacterOperation(empty, first.op);
    expect(first.op.part.id).toBe('cube');
    const removed = applyCharacterOperation(added, { type: 'removePart', id: 'cube' });
    expect(removed.retiredIds).toEqual(['cube']);
    // A second cube after the first was removed is a new part with a new ID.
    const second = characterCubePart(removed);
    expect(second.op.part.id).toBe('cube-2');
    const again = applyCharacterOperation(removed, second.op);
    expect(again.retiredIds).toEqual(['cube']);
    // The figure's body: its morphs, skin and the tracks that drove them are retired too.
    const f = structuredClone(blockyFigure().doc);
    const gone = applyCharacterOperation(f, { type: 'removePart', id: 'body' });
    for (const id of ['body', ...f.morphs.map((m) => m.id), ...f.skins.map((k) => k.id)])
      expect(gone.retiredIds).toContain(id);
    // Asset refs (named after their bytes) and edits that remove nothing are not retired.
    expect(gone.retiredIds).not.toContain(f.parts[0]!.mesh);
    expect(
      applyCharacterOperation(f, { type: 'setPartVisible', id: 'body', visible: false }).retiredIds,
    ).toBeUndefined();
    // A live element may not use a retired ID, and retired IDs are unique.
    expect(validateCharacter({ ...again, retiredIds: ['cube-2'] }).map((d) => d.code)).toContain(
      'retired-id',
    );
    expect(
      validateCharacter({ ...again, retiredIds: ['cube', 'cube'] }).map((d) => d.code),
    ).toContain('duplicate-id');
  });
  it('counts distinct history asset bytes and says how many old entries to forget', () => {
    const empty = emptyCharacter();
    const mk = (sha: string, byteLength: number): CharacterDocument => ({
      ...empty,
      assets: [
        {
          id: `a${sha}`,
          kind: 'mesh-epm',
          sha256: `sha256:${sha.repeat(64)}`,
          byteLength,
          mediaType: 'model/x-editor-platform-mesh',
        },
      ],
    });
    const current = mk('1', 100);
    const undo = [mk('2', 100), mk('3', 100), mk('1', 100), mk('4', 100)];
    // Kept: 100. Newest first: 4 → 200, 1 (again) → 200, 3 → 300, 2 → 400.
    expect(characterHistoryOverflow(undo, [current], 400)).toBe(0);
    expect(characterHistoryOverflow(undo, [current], 300)).toBe(1);
    expect(characterHistoryOverflow(undo, [current], 250)).toBe(2);
    expect(characterHistoryOverflow(undo, [current], 100)).toBe(4);
  });
  it('exposes history frozen, and a forgotten merge group does not absorb the next edit', () => {
    const s = new EditorSession(emptyCharacter());
    run(s, { type: 'replaceDocument', document: { ...emptyCharacter(), name: 'a' } });
    const first = s.historyEntries('undo')[0]!;
    expect(Object.isFrozen(first)).toBe(true);
    const typing = (name: string) =>
      s.execute(
        characterEditorCommand(
          { type: 'replaceDocument', document: { ...emptyCharacter(), name } },
          {
            expectedHash: characterContentHash(s.content),
            canEdit: () => true,
            context: { origin: 'local', transactionId: `t-${name}`, mergeKey: 'typing' },
          },
        ),
      );
    typing('b');
    s.forgetOldestUndo(10);
    expect(s.canUndo).toBe(false);
    typing('bc');
    expect(s.canUndo).toBe(true);
  });
  it('forgets the oldest Undo entries of a session, keeping Redo', () => {
    const s = new EditorSession(emptyCharacter());
    for (const name of ['a', 'b', 'c'])
      run(s, { type: 'replaceDocument', document: { ...emptyCharacter(), name } });
    expect(s.historyEntries('undo').map((d) => d.name)).toEqual([emptyCharacter().name, 'a', 'b']);
    s.undo();
    expect(s.historyEntries('redo').map((d) => d.name)).toEqual(['c']);
    s.forgetOldestUndo(1);
    expect(s.historyEntries('undo').map((d) => d.name)).toEqual(['a']);
    s.undo();
    expect(s.canUndo).toBe(false);
    expect(s.historyEntries('redo').map((d) => d.name)).toEqual(['b', 'c']);
  });
});
