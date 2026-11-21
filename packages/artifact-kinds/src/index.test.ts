import { describe, expect, it } from 'vitest';
import { createKindRegistry, defineKind, registerKind, type KindDefinition } from './index';

interface Note {
  text: string;
}
interface Sheet {
  cells: string[][];
}
const isNote = (value: unknown): value is Note =>
  !!value && typeof value === 'object' && typeof (value as Note).text === 'string';
const note = defineKind<Note>({
  kind: 'note',
  area: 'office',
  label: 'Note',
  icon: '✎',
  description: 'A line of text',
  creatable: true,
  create: (count) => ({ name: `Note ${count}`, content: { text: '' } }),
  validate: isNote,
});
const part = defineKind<Sheet>({
  kind: 'part',
  area: 'engineering',
  label: 'Part',
  icon: '⬢',
  description: 'Needs a kernel',
  creatable: false,
  create: (count) => ({
    name: `Part ${count}`,
    content: { cells: [] },
    extras: { cadResources: [{ id: 'asset' }] },
  }),
  validate: (value): value is Sheet => !!value && Array.isArray((value as Sheet).cells),
});

describe('kind registry', () => {
  it('creates, validates and lists kinds in order', () => {
    const registry = createKindRegistry([registerKind(note), registerKind(part)]);
    expect(registry.all().map((k) => k.kind)).toEqual(['note', 'part']);
    expect(registry.creatable().map((k) => k.kind)).toEqual(['note']);
    expect(registry.get('part')?.create(2)).toEqual({
      name: 'Part 2',
      content: { cells: [] },
      extras: { cadResources: [{ id: 'asset' }] },
    });
    expect(registry.validate('note', { text: 'a' })).toBe(true);
    expect(registry.validate('note', { cells: [] })).toBe(false);
    expect(registry.validate('unknown', { text: 'a' })).toBe(false);
    expect(registry.get('unknown')).toBeUndefined();
  });

  it('refuses a kind registered twice', () => {
    expect(() => createKindRegistry([registerKind(note), registerKind(note)])).toThrow(
      'Kind registered twice: note',
    );
  });

  it('keeps the content type until the definition is registered (compile checks)', () => {
    const created = note.create(1);
    const text: string = created.content.text;
    expect(text).toBe('');
    const stored: unknown = { text: 'x' };
    // @ts-expect-error content is unknown until validate narrows it
    void stored.text;
    if (note.validate(stored)) expect(stored.text).toBe('x');
    defineKind<Note>({
      ...note,
      // @ts-expect-error create must return the definition's content type
      create: (count: number) => ({ name: `Note ${count}`, content: { cells: [] } }),
    });
    // A Host pairs a typed definition with a Surface for the same content type.
    const pair = <C>(definition: KindDefinition<C>, surface: (content: C) => string) => ({
      definition,
      surface,
    });
    pair(note, (content) => content.text);
    // @ts-expect-error a Sheet surface does not fit a Note definition
    pair(note, (content: Sheet) => String(content.cells.length));
    const erased = registerKind(note);
    // @ts-expect-error an erased definition no longer carries its content type
    pair(erased, (content: Note) => content.text);
  });
});
