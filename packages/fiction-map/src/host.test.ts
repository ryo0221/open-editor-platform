import { describe, it, expect } from 'vitest';
import { createArtifact, MemoryStorage } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import { ArtifactEditor } from '@editor-platform/editor-host';
import {
  createFictionMap,
  prepareFictionMapChange,
  commitFictionMapChange,
  undoFictionMap,
  redoFictionMap,
  validateFictionMap,
  type FictionMapContent,
} from './model';
import { adoptFictionMapBase } from './host';
const change = {
  layers: [{ id: 'l', name: 'Places', purpose: 'settlement', visibleByDefault: true }],
};
describe('D3 single Session public bridge', () => {
  it('admits a clone and pins its revision instead of asserting ownership', () => {
    const s = new EditorSession(createFictionMap()),
      base = adoptFictionMapBase(s);
    expect(base.revision).toEqual(s.revision);
    const p = prepareFictionMapChange(base, change);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(commitFictionMapChange(s, p.value, () => true).ok).toBe(true);
    expect(s.revision.sequence).toBe(1);
    expect(undoFictionMap(s, () => true).ok).toBe(true);
    expect(s.content.layers).toEqual([]);
    expect(redoFictionMap(s, () => true).ok).toBe(true);
  });
  it('uses ArtifactEditor own command/history rather than making another Session', () => {
    let permission = true;
    const a = createArtifact('fiction-map', 'Map', createFictionMap()),
      h = new ArtifactEditor(
        a,
        {
          kind: 'fiction-map',
          validate: (v): v is FictionMapContent => validateFictionMap(v).ok,
          capabilities: {
            undo: true,
            nativeJson: true,
            formats: [],
            preview: 'none',
            shared: false,
          },
        },
        new MemoryStorage(),
        () => permission,
      );
    const b = adoptFictionMapBase(h),
      p = prepareFictionMapChange(b, change);
    if (!p.ok) throw Error(p.diagnostic.code);
    permission = false;
    expect(commitFictionMapChange(h, p.value, () => permission).ok).toBe(false);
    expect(h.revision.sequence).toBe(0);
    permission = true;
    expect(commitFictionMapChange(h, p.value, () => permission).ok).toBe(true);
    expect(h.revision.sequence).toBe(1);
    expect(undoFictionMap(h, () => permission).ok).toBe(true);
    expect(h.content.layers).toEqual([]);
    expect(redoFictionMap(h, () => permission).ok).toBe(true);
    expect(h.content.layers).toHaveLength(1);
    const r = h.revision;
    expect(() =>
      h.undo(() => {
        throw Error('domain rejected');
      }),
    ).toThrow('domain rejected');
    expect(h.revision).toEqual(r);
  });
});
