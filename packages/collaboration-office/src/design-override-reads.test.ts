import { expect, it } from 'vitest';
import { command } from '@editor-platform/editor-core';
import { Authority, initial, type Principal } from '@editor-platform/collaboration-core';
import {
  overrideInstance,
  updateElement,
  deleteElements,
  makeDesignElement,
  type DesignContent,
  type DesignPrototypeAction,
} from '@editor-platform/design/model';
import { nestedTextFixture } from '../../../tests/fixtures/design-nested-text/content';
import { designEditorCodec, prepareEditorCommand } from './editor-transactions';

const A: Principal = { actorId: 'A', clientId: 'A', sessionId: 'A', writable: true, scopes: ['*'] };
const B: Principal = { ...A, actorId: 'B', clientId: 'B', sessionId: 'B' };
const authorityFor = (d = nestedTextFixture()) =>
  new Authority(designEditorCodec, initial('reads', designEditorCodec, d));
const prepare = (
  authority: ReturnType<typeof authorityFor>,
  actor: Principal,
  edit: ReturnType<typeof overrideInstance>,
) => prepareEditorCommand(designEditorCodec, authority.snapshot(), actor, edit)!;

it.each(['navigate', 'switch', 'open-overlay'] as const)(
  'rejects an override after its new %s frame was deleted',
  (type) => {
    const d = nestedTextFixture();
    d.elements.push({ ...makeDesignElement('frame'), id: 'destination' });
    const authority = authorityFor(d);
    const edit = overrideInstance('card', ['section', 'title'], {
      interactions: [{ trigger: 'click', action: { type, frameId: 'destination' } }],
    });
    const a = prepare(authority, A, edit);
    expect(authority.commit(B, prepare(authority, B, deleteElements(['destination']))).status).toBe(
      'accepted',
    );
    const before = authority.snapshot();
    expect(() => edit.apply(before.content)).toThrow(/frame/);
    expect(authority.commit(A, JSON.parse(JSON.stringify(a))).status).toBe('rejected');
    expect(authority.snapshot()).toEqual(before);
  },
);

it('preconditions interactions inside a nested override map without command metadata', () => {
  const d = nestedTextFixture();
  d.elements.push({ ...makeDesignElement('frame'), id: 'destination' });
  const authority = authorityFor(d);
  const action: DesignPrototypeAction = { type: 'navigate', frameId: 'destination' };
  const edit = {
    ...overrideInstance('card', ['section'], {
      overrides: { title: { interactions: [{ trigger: 'click', action }] } },
    }),
    reads: undefined,
  };
  const a = prepare(authority, A, edit);
  expect(authority.commit(B, prepare(authority, B, deleteElements(['destination']))).status).toBe(
    'accepted',
  );
  expect(authority.commit(A, JSON.parse(JSON.stringify(a))).status).toBe('rejected');
});

it('accepts the override after an unrelated frame was deleted', () => {
  const d = nestedTextFixture();
  for (const id of ['destination', 'unrelated-frame'])
    d.elements.push({ ...makeDesignElement('frame'), id });
  const authority = authorityFor(d);
  const a = prepare(
    authority,
    A,
    overrideInstance('card', ['section', 'title'], {
      interactions: [{ trigger: 'click', action: { type: 'navigate', frameId: 'destination' } }],
    }),
  );
  expect(
    authority.commit(B, prepare(authority, B, deleteElements(['unrelated-frame']))).status,
  ).toBe('accepted');
  expect(authority.commit(A, a).status).toBe('accepted');
});

it('derives override definition preconditions at authority even without command read metadata', () => {
  const authority = authorityFor();
  const a = prepare(authority, A, {
    ...overrideInstance('card', ['section', 'title'], { text: 'A' }),
    reads: undefined,
  });
  const peer = command('host.definition', 'Change definition', (d: DesignContent) => ({
    ...d,
    components: d.components.map((c) => (c.id === 'inner' ? { ...c, width: c.width + 1 } : c)),
  }));
  expect(authority.commit(B, prepare(authority, B, peer)).status).toBe('accepted');
  expect(authority.commit(A, JSON.parse(JSON.stringify(a))).status).toBe('rejected');
});

it.each([false, true])(
  'accepts simultaneous disjoint instance overrides (legacy: %s)',
  (legacy) => {
    const authority = authorityFor();
    const part = legacy ? 'section' : ['section', 'title'];
    const a = prepare(authority, A, overrideInstance('card', part, { text: 'A' }));
    const b = prepare(authority, B, overrideInstance('other', part, { text: 'B' }));
    expect(authority.commit(A, JSON.parse(JSON.stringify(a))).status).toBe('accepted');
    expect(authority.commit(B, JSON.parse(JSON.stringify(b))).status).toBe('accepted');
    const other = authority.snapshot().content.elements[1];
    const undo = authority.undo(A, a.operationId);
    expect(undo.status).toBe('accepted');
    expect(authority.snapshot().content.elements[1]).toEqual(other);
    expect(authority.undo(A, undo.operationId, true).status).toBe('accepted');
    expect(authority.snapshot().content.elements[1]).toEqual(other);
  },
);

it.each(['element', 'component', 'style', 'prototype'])(
  'accepts an unrelated %s edit before a prepared override',
  (kind) => {
    const d = nestedTextFixture();
    d.components.push({ ...d.components[0], id: 'unused' });
    d.styles = [{ id: 'unused-style', name: 'Unused', appearance: {} }];
    const authority = authorityFor(d);
    const a = prepare(authority, A, overrideInstance('card', ['section', 'title'], { text: 'A' }));
    const peer =
      kind === 'element'
        ? updateElement('other', { name: 'Peer' })
        : command('host.unrelated', 'Unrelated edit', (d: DesignContent) =>
            kind === 'style'
              ? { ...d, styles: d.styles!.map((s) => ({ ...s, name: 'Peer' })) }
              : kind === 'prototype'
                ? { ...d, prototyping: { schemaVersion: 1 as const, flows: [] } }
                : {
                    ...d,
                    components: d.components.map((c) =>
                      c.id === 'unused' ? { ...c, name: 'Peer' } : c,
                    ),
                  },
          );
    expect(authority.commit(B, prepare(authority, B, peer)).status).toBe('accepted');
    expect(authority.commit(A, a).status).toBe('accepted');
  },
);

it.each(['root-style', 'part-style', 'missing-style', 'ancestor'])(
  'rejects a changed effective %s dependency',
  (kind) => {
    const d = nestedTextFixture();
    d.styles = kind === 'missing-style' ? [] : [{ id: 'guard', name: 'Guard', appearance: {} }];
    if (kind === 'root-style') d.elements[0].styleId = 'guard';
    else if (kind === 'ancestor') {
      d.elements.push({
        ...d.elements[1],
        id: 'parent',
        type: 'group',
        componentId: undefined,
        styleId: 'guard',
      });
      d.elements[0].parentId = 'parent';
    } else d.components[0].elements![0].styleId = 'guard';
    const authority = authorityFor(d);
    const a = prepare(authority, A, overrideInstance('card', ['section', 'title'], { text: 'A' }));
    const peer = command('host.style', 'Change style', (d: DesignContent) => ({
      ...d,
      styles: [{ id: 'guard', name: 'Guard', appearance: { locked: true } }],
    }));
    expect(authority.commit(B, prepare(authority, B, peer)).status).toBe('accepted');
    const before = authority.snapshot();
    expect(authority.commit(A, a).status).toBe('rejected');
    expect(authority.snapshot()).toEqual(before);
  },
);

it('preconditions newly referenced definitions in an override too', () => {
  const d = nestedTextFixture();
  d.components.push({ ...d.components[0], id: 'replacement' });
  const authority = authorityFor(d);
  const a = prepare(
    authority,
    A,
    overrideInstance('card', 'section', { componentId: 'replacement' }),
  );
  const peer = command('host.definition', 'Change replacement', (d: DesignContent) => ({
    ...d,
    components: d.components.map((c) =>
      c.id === 'replacement' ? { ...c, width: c.width + 1 } : c,
    ),
  }));
  expect(authority.commit(B, prepare(authority, B, peer)).status).toBe('accepted');
  expect(authority.commit(A, a).status).toBe('rejected');
});
