import { identityQuaternion, position, type CadSketch } from '@editor-platform/cad-core';
import { describe, expect, it } from 'vitest';
import {
  addCircle,
  addLine,
  addNote,
  editNote,
  localId,
  removeItem,
  setColor,
} from './sketch-draft';

const empty = (): CadSketch => ({
  id: 'sk',
  name: 'Sketch 1',
  plane: { origin: position(0, 0, 0), orientation: identityQuaternion() },
  entities: [],
  constraints: [],
  solved: {},
});

describe('CLF9: sketch line colour (TS-2017)', () => {
  it('colours the selected curves only, and takes the colour off again', () => {
    const a = addLine(empty(), { at: [0, 0] }, { at: [10, 0] });
    const b = addCircle(a.sketch, { at: [20, 0] }, 5);
    const line = a.sketch.entities.find((e) => e.id === a.id) as { start: string };
    const red = setColor(b.sketch, [a.id, line.start], '#d1495b');
    const colorOf = (s: CadSketch, id: string) =>
      (s.entities.find((e) => e.id === id) as { color?: string }).color;
    expect(colorOf(red, a.id)).toBe('#d1495b');
    // Points and unselected curves keep no colour.
    expect(colorOf(red, line.start)).toBeUndefined();
    expect(colorOf(red, b.id)).toBeUndefined();
    const plain = setColor(red, [a.id], undefined);
    expect(plain.entities.find((e) => e.id === a.id)).not.toHaveProperty('color');
    expect(plain.solved).toEqual(b.sketch.solved);
  });
});

describe('CLF10: sketch notes (TS-2019)', () => {
  it('adds, edits, colours and removes a note; IDs never clash with elements', () => {
    const a = addLine(empty(), { at: [0, 0] }, { at: [10, 0] });
    const n = addNote(a.sketch, [5, 5], '  Roof  ', 12);
    expect(n.id).toBe('n1');
    expect(n.sketch.notes).toEqual([{ id: 'n1', at: [5, 5], text: 'Roof', size: 12 }]);
    const moved = editNote(n.sketch, 'n1', { at: [7, 8], text: '屋根', size: 20 });
    expect(moved.notes![0]).toMatchObject({ at: [7, 8], text: '屋根', size: 20 });
    expect(setColor(moved, ['n1'], '#3e7cb1').notes![0]!.color).toBe('#3e7cb1');
    expect(() => editNote(moved, 'n1', { text: ' ' })).toThrow('sketch-note-text');
    expect(() => editNote(moved, 'n1', { size: 3000 })).toThrow('sketch-note-size');
    // The next element takes no note's ID, a removed note leaves no empty list.
    expect(localId(moved, 'n')).toBe('n2');
    expect(removeItem(moved, 'n1')).not.toHaveProperty('notes');
    expect(removeItem(moved, a.id).notes).toHaveLength(1);
    // Removing a note leaves the drawing alone, a free point included.
    const free = { ...moved, entities: [...moved.entities, { type: 'point' as const, id: 'p9' }] };
    free.solved = { ...free.solved, p9: [50, 50] };
    const left = removeItem(free, 'n1');
    expect(left.entities).toEqual(free.entities);
    expect(left.solved).toEqual(free.solved);
  });
});
