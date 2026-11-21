import { describe, expect, it } from 'vitest';
import { isValidElement, type ReactElement } from 'react';
import { defineKind, type KindDefinition } from '@editor-platform/artifact-kinds';
import { hostKind, pairSurfaces, type HostSurfaceProps } from './host-kind';
import type { SurfaceHost } from './surface-host';

interface Note {
  note: string;
}
interface Part {
  part: number;
}
const noteKind = defineKind<Note>({
  kind: 'note',
  area: 'office',
  label: 'Note',
  icon: 'N',
  description: '',
  creatable: true,
  create: () => ({ name: 'Note', content: { note: '' } }),
  validate: (content): content is Note => !!content && typeof (content as Note).note === 'string',
});
const partKind = defineKind<Part>({
  kind: 'part',
  area: 'engineering',
  label: 'Part',
  icon: 'P',
  description: '',
  creatable: true,
  create: () => ({ name: 'Part', content: { part: 1 } }),
  validate: (content): content is Part => !!content && typeof (content as Part).part === 'number',
});
const NoteSurface = (props: HostSurfaceProps<Note>) => props.content.note;
const PartSurface = (props: HostSurfaceProps<Part>) => String(props.content.part);
const host = (session: 'local' | 'shared' | 'none') =>
  ({
    active: { id: 'a1' },
    session: session === 'none' ? undefined : {},
    sharedSession: session === 'shared' ? {} : undefined,
  }) as unknown as SurfaceHost;

describe('hostKind', () => {
  it('pairs a Surface only with the content type of its definition', () => {
    hostKind(noteKind, { Surface: NoteSurface });
    // @ts-expect-error a Part Surface cannot render Note content
    hostKind(noteKind, { Surface: PartSurface });
    // @ts-expect-error the extra check reads the definition's content type
    hostKind(noteKind, { Surface: NoteSurface, accepts: (content: Part) => content.part > 0 });
  });

  it('accepts content that passes validate and the Surface check', () => {
    const entry = hostKind(noteKind, {
      Surface: NoteSurface,
      accepts: (content) => content.note !== 'old',
    });
    expect(entry.accepts({ note: 'x' })).toBe(true);
    expect(entry.accepts({ note: 'old' })).toBe(false);
    expect(entry.accepts({ part: 1 })).toBe(false);
  });

  it('renders only with the session the Surface needs, keyed by the active Artifact', () => {
    const local = hostKind(noteKind, { Surface: NoteSurface, session: 'local' });
    const any = hostKind(noteKind, { Surface: NoteSurface, session: 'any' });
    const always = hostKind(noteKind, {
      Surface: NoteSurface,
      surfaceKey: (h) => `key:${h.active.id}`,
    });
    const content = { note: 'x' };
    const element = local.render(host('local'), content) as ReactElement;
    expect(isValidElement(element) && element.key).toBe('a1');
    expect(local.render(host('shared'), content)).toBeNull();
    expect(local.render(host('none'), content)).toBeNull();
    expect(any.render(host('shared'), content)).not.toBeNull();
    expect(any.render(host('none'), content)).toBeNull();
    expect((always.render(host('none'), content) as ReactElement).key).toBe('key:a1');
  });
});

describe('pairSurfaces', () => {
  const definitions: KindDefinition<unknown>[] = [noteKind, partKind];
  const note = hostKind(noteKind, { Surface: NoteSurface });
  const part = hostKind(partKind, { Surface: PartSurface });

  it('pairs each registered kind with exactly one Surface', () => {
    expect([...pairSurfaces(definitions, [part, note]).keys()]).toEqual(['part', 'note']);
  });

  it('refuses a missing, repeated, unregistered or differently defined Surface', () => {
    expect(() => pairSurfaces(definitions, [note])).toThrow('No Surface for kind: part');
    expect(() => pairSurfaces(definitions, [note, part, note])).toThrow(
      'Surface registered twice: note',
    );
    expect(() => pairSurfaces([noteKind], [note, part])).toThrow(
      'Surface without a registered kind: part',
    );
    const copy = hostKind({ ...partKind }, { Surface: PartSurface });
    expect(() => pairSurfaces(definitions, [note, copy])).toThrow(
      'Surface for part uses another definition',
    );
  });
});
