import { expect, it } from 'vitest';
import { deepFreeze } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import { designDrawings, overrideInstance } from './model';
import { nestedTextFixture } from '../../../tests/fixtures/design-nested-text/content';

for (const flag of ['locked', 'hidden'] as const) {
  it.each(['composite', 'primitive', 'top-primitive', 'component-instance'])(
    `clears only the addressed ${flag} leaf in a %s path`,
    (kind) => {
      const d = nestedTextFixture();
      let path = ['section', 'title'];
      if (kind === 'component-instance') {
        d.components[1].elements![0][flag] = true;
        path = ['section'];
      } else if (kind === 'composite') d.components[0].elements![0][flag] = true;
      else {
        delete d.components[0].elements;
        d.components[0].template = {
          type: 'text',
          text: 'Primitive',
          fill: '#000000',
          [flag]: true,
        };
        d.components[1].elements![0].overrides = {};
        path = kind === 'primitive' ? ['section', 'root'] : ['root'];
        if (kind === 'top-primitive') d.elements[0].componentId = 'inner';
      }
      const source = deepFreeze(d);
      const session = new EditorSession(source);
      expect(() =>
        overrideInstance('card', path, { [flag]: false, text: 'Lost' }).apply(source),
      ).toThrow(/Unlock/);
      session.execute(overrideInstance('card', path, { [flag]: false }));
      const after = session.content;
      expect(after.components).toEqual(source.components);
      expect(after.elements[1]).toEqual(source.elements[1]);
      expect(designDrawings(after, after.elements[0]).some((e) => e.instanceText)).toBe(true);
      expect(() =>
        overrideInstance('card', kind === 'component-instance' ? ['section', 'title'] : path, {
          text: 'Editable',
        }).apply(after),
      ).not.toThrow();
      session.undo();
      expect(session.content).toEqual(source);
      session.redo();
      expect(session.content).toEqual(after);
    },
  );

  it.each([false, true])(
    `clears a replaced primitive root ${flag} (styled wrapper: %s)`,
    (styled) => {
      const d = nestedTextFixture();
      delete d.components[0].elements;
      d.components[0].template = { type: 'text', text: 'Primitive', fill: '#000000', [flag]: true };
      d.components.push({ ...d.components[0], id: 'replacement' });
      d.components[1].elements![0].overrides = {};
      d.elements[0].overrides = { section: { componentId: 'replacement' } };
      if (styled) {
        d.styles = [{ id: 'blocked', name: 'Blocked', appearance: { [flag]: true } }];
        d.components[1].elements![0].styleId = 'blocked';
        d.elements[0].overrides.section[flag] = false;
      }
      const source = deepFreeze(d);
      const after = overrideInstance('card', ['section', 'root'], { [flag]: false }).apply(source);
      expect(designDrawings(after, after.elements[0]).some((e) => e.instanceText)).toBe(true);
      expect(after.components).toEqual(source.components);
    },
  );

  it.each(['root', 'part'])(`keeps the native primitive %s wrapper ${flag} guard`, (owner) => {
    const d = nestedTextFixture();
    delete d.components[0].elements;
    d.components[0].template = { type: 'text', text: 'Primitive', fill: '#000000', [flag]: true };
    d.components[1].elements![0].overrides = {};
    if (owner === 'root') {
      d.elements[0].componentId = 'inner';
      d.elements[0][flag] = true;
    } else d.components[1].elements![0][flag] = true;
    expect(() =>
      overrideInstance('card', owner === 'root' ? ['root'] : ['section', 'root'], {
        [flag]: false,
      }).apply(deepFreeze(d)),
    ).toThrow(/Unlock/);
  });

  it.each(['root', 'part-ancestor', 'styled-ancestor'])(
    `keeps a ${flag} ancestor guard while clearing a leaf (%s)`,
    (owner) => {
      const d = nestedTextFixture();
      d.components[0].elements![0][flag] = true;
      if (owner === 'root') d.elements[0][flag] = true;
      else if (owner === 'part-ancestor') d.components[1].elements![0][flag] = true;
      else {
        d.styles = [{ id: 'blocked', name: 'Blocked', appearance: { [flag]: true } }];
        d.components[1].elements![0].styleId = 'blocked';
      }
      const source = deepFreeze(d);
      expect(() =>
        overrideInstance('card', ['section', 'title'], { [flag]: false }).apply(source),
      ).toThrow(/Unlock/);
      expect(() =>
        overrideInstance('card', ['section', 'title'], { [flag]: false, text: 'Lost' }).apply(
          source,
        ),
      ).toThrow(/Unlock/);
    },
  );
}
